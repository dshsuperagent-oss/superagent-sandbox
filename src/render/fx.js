// Efeitos visuais do Torre de Ferro — partículas, rastros, flashes, cadeia tesla,
// lentidão, dano flutuante e screen shake. Usa apenas THREE + sceneApi.project/shake.
// API fixa: createFx({ sceneApi }) -> { handle, update, log, count, dispose }.
//
// Espaço de partículas: 420 aditivas + 160 de fumaça = 580 (limite da issue: 600).
// Luzes: pool fixo de 8 PointLights (nunca mais que 8 na cena).

import * as THREE from '../vendor/three/three.module.js';

const ADD_MAX = 420;
const SMOKE_MAX = 160;
const MAX_LIGHTS = 8;
const MAX_DAMAGE_NUMBERS = 32;
const MAX_BOLTS = 6;
const MAX_TRAILS = 8;
const MAX_LOG = 400;

const VERTEX_SHADER = `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (280.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.12, r) * vAlpha;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

const PALETA = {
  fogo: [1.0, 0.62, 0.18],
  fogoQuente: [1.0, 0.86, 0.4],
  faisca: [1.0, 0.94, 0.62],
  fumaca: [0.32, 0.31, 0.3],
  gelo: [0.55, 0.86, 1.0],
  geloForte: [0.8, 0.96, 1.0],
  branco: [1.0, 1.0, 1.0],
  base: [1.0, 0.42, 0.22],
  chefe: [1.0, 0.35, 0.2],
  poeira: [0.55, 0.5, 0.42],
};

function nullFx() {
  return {
    handle() {},
    update() {},
    log() {
      return [];
    },
    count() {
      return 0;
    },
    dispose() {},
  };
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function createFx({ sceneApi } = {}) {
  if (typeof THREE === 'undefined' || !THREE || typeof THREE.Scene !== 'function') return nullFx();

  const root = new THREE.Group();
  root.name = 'efeitos-torre-de-ferro';
  const cena = sceneApi && sceneApi.scene ? sceneApi.scene : null;
  if (cena && typeof cena.add === 'function') {
    try {
      cena.add(root);
    } catch (err) {
      /* segue sem estar na cena */
    }
  }

  let disposed = false;
  let timeline = 0;
  let lastState = null;
  const logEvents = [];

  const pools = [];
  const lights = [];
  const trailPool = [];
  const bolts = [];
  let damageLayer = null;
  const damageNumbers = [];
  const activeTrails = new Map();

  // ------------------------------------------------------------------ pool
  function makePool(max, blending) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(max * 3);
    const colors = new Float32Array(max * 3);
    const sizes = new Float32Array(max);
    const alphas = new Float32Array(max);
    const attrPos = new THREE.BufferAttribute(positions, 3);
    const attrColor = new THREE.BufferAttribute(colors, 3);
    const attrSize = new THREE.BufferAttribute(sizes, 1);
    const attrAlpha = new THREE.BufferAttribute(alphas, 1);
    attrPos.setUsage(THREE.DynamicDrawUsage);
    attrColor.setUsage(THREE.DynamicDrawUsage);
    attrSize.setUsage(THREE.DynamicDrawUsage);
    attrAlpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attrPos);
    geometry.setAttribute('aColor', attrColor);
    geometry.setAttribute('aSize', attrSize);
    geometry.setAttribute('aAlpha', attrAlpha);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 6;
    try {
      root.add(points);
    } catch (err) {
      /* ignora */
    }
    const pool = {
      max,
      points,
      geometry,
      material,
      attrPos,
      attrColor,
      attrSize,
      attrAlpha,
      positions,
      colors,
      sizes,
      alphas,
      vel: new Float32Array(max * 3),
      life: new Float32Array(max),
      maxLife: new Float32Array(max),
      gravity: new Float32Array(max),
      drag: new Float32Array(max),
      size0: new Float32Array(max),
      size1: new Float32Array(max),
      alpha0: new Float32Array(max),
      cursor: 0,
      active: 0,
    };
    pools.push(pool);
    return pool;
  }

  const addPool = makePool(ADD_MAX, THREE.AdditiveBlending);
  const smokePool = makePool(SMOKE_MAX, THREE.NormalBlending);

  function spawn(pool, x, y, z, vx, vy, vz, life, size0, size1, cor, alpha0, gravity, drag) {
    try {
      if (!pool || pool.active >= pool.max) return false;
      const i = pool.cursor;
      pool.cursor = (pool.cursor + 1) % pool.max;
      if (pool.life[i] > 0) return false;
      pool.life[i] = life;
      pool.maxLife[i] = life;
      pool.positions[i * 3] = x;
      pool.positions[i * 3 + 1] = y;
      pool.positions[i * 3 + 2] = z;
      pool.vel[i * 3] = vx;
      pool.vel[i * 3 + 1] = vy;
      pool.vel[i * 3 + 2] = vz;
      pool.colors[i * 3] = cor[0];
      pool.colors[i * 3 + 1] = cor[1];
      pool.colors[i * 3 + 2] = cor[2];
      pool.size0[i] = size0;
      pool.size1[i] = size1;
      pool.sizes[i] = size0;
      pool.alpha0[i] = alpha0;
      pool.alphas[i] = 0;
      pool.gravity[i] = gravity;
      pool.drag[i] = drag;
      pool.active += 1;
      return true;
    } catch (err) {
      return false;
    }
  }

  function updatePool(pool, dt) {
    if (!pool) return;
    const { life, maxLife, positions, vel, sizes, alphas, colors } = pool;
    let ativos = 0;
    for (let i = 0; i < pool.max; i += 1) {
      if (life[i] <= 0) {
        sizes[i] = 0;
        alphas[i] = 0;
        continue;
      }
      life[i] -= dt;
      if (life[i] <= 0) {
        life[i] = 0;
        sizes[i] = 0;
        alphas[i] = 0;
        pool.active = Math.max(0, pool.active - 1);
        continue;
      }
      ativos += 1;
      const i3 = i * 3;
      vel[i3 + 1] -= pool.gravity[i] * dt;
      const amort = Math.max(0, 1 - pool.drag[i] * dt);
      vel[i3] *= amort;
      vel[i3 + 1] *= amort;
      vel[i3 + 2] *= amort;
      positions[i3] += vel[i3] * dt;
      positions[i3 + 1] += vel[i3 + 1] * dt;
      positions[i3 + 2] += vel[i3 + 2] * dt;
      if (positions[i3 + 1] < 0.05) {
        positions[i3 + 1] = 0.05;
        vel[i3 + 1] = Math.abs(vel[i3 + 1]) * 0.25;
      }
      const p = 1 - life[i] / maxLife[i];
      const fadeIn = Math.min(1, p * 12);
      const fadeOut = Math.min(1, (life[i] / maxLife[i]) * 2.2);
      alphas[i] = pool.alpha0[i] * fadeIn * fadeOut;
      sizes[i] = pool.size0[i] + (pool.size1[i] - pool.size0[i]) * p;
    }
    pool.active = ativos;
    try {
      pool.attrPos.needsUpdate = true;
      pool.attrColor.needsUpdate = true;
      pool.attrSize.needsUpdate = true;
      pool.attrAlpha.needsUpdate = true;
    } catch (err) {
      /* ignora */
    }
  }

  // ------------------------------------------------------------------ clamp de cor
  function cor(base, jitter) {
    const j = Number(jitter) || 0;
    return [
      clamp(base[0] + (Math.random() - 0.5) * j, 0, 1),
      clamp(base[1] + (Math.random() - 0.5) * j, 0, 1),
      clamp(base[2] + (Math.random() - 0.5) * j, 0, 1),
    ];
  }

  // ------------------------------------------------------------------ luzes
  function initLights() {
    for (let i = 0; i < MAX_LIGHTS; i += 1) {
      try {
        const light = new THREE.PointLight(0xffc46a, 0, 9, 2);
        light.position.set(0, 2.5, 0);
        root.add(light);
        lights.push({ light, life: 0, maxLife: 0.025 });
      } catch (err) {
        /* ignora */
      }
    }
  }
  initLights();

  function flashLight(x, y, z) {
    try {
      let alvo = null;
      for (const slot of lights) {
        if (slot.life <= 0) {
          alvo = slot;
          break;
        }
      }
      if (!alvo) return;
      alvo.life = 0.025;
      alvo.light.position.set(x, Math.max(1.2, y), z);
      alvo.light.intensity = 2.4;
    } catch (err) {
      /* ignora */
    }
  }

  function updateLights(dt) {
    for (const slot of lights) {
      if (slot.life <= 0) {
        if (slot.light.intensity !== 0) slot.light.intensity = 0;
        continue;
      }
      slot.life -= dt;
      if (slot.life <= 0) {
        slot.life = 0;
        slot.light.intensity = 0;
      } else {
        slot.light.intensity = 2.4 * (slot.life / slot.maxLife);
      }
    }
  }

  // ------------------------------------------------------------------ shake
  function shake(level) {
    try {
      if (sceneApi && typeof sceneApi.shake === 'function') sceneApi.shake(level);
    } catch (err) {
      /* ignora */
    }
  }

  function project(x, y, z) {
    try {
      if (sceneApi && typeof sceneApi.project === 'function') return sceneApi.project(x, y, z);
    } catch (err) {
      /* ignora */
    }
    return null;
  }

  // ------------------------------------------------------------------ explosão
  function explosao(x, z, size, kind) {
    const escala = size === 'base' ? 2.1 : size === 'large' ? 1.55 : 1;
    const corFogo = size === 'base' ? PALETA.base : kind === 'morte' ? PALETA.fogo : PALETA.fogo;
    const yBase = size === 'base' ? 1.2 : 0.8;
    const nFlames = 24;
    const nSmoke = 8;
    const nSparks = 12;
    for (let i = 0; i < nFlames; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const vel = (2.2 + Math.random() * 5.2) * escala;
      spawn(
        addPool,
        x + Math.cos(ang) * 0.35,
        yBase + Math.random() * 0.6,
        z + Math.sin(ang) * 0.35,
        Math.cos(ang) * vel,
        2.2 + Math.random() * 4.6 * escala,
        Math.sin(ang) * vel,
        0.34 + Math.random() * 0.26,
        (0.35 + Math.random() * 0.55) * escala,
        (0.6 + Math.random() * 0.9) * escala,
        cor(corFogo, 0.16),
        0.9,
        5.5,
        2.2,
      );
    }
    for (let i = 0; i < nSmoke; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const vel = 0.5 + Math.random() * 1.6;
      spawn(
        smokePool,
        x + (Math.random() - 0.5) * 1.1,
        yBase + Math.random() * 0.9,
        z + (Math.random() - 0.5) * 1.1,
        Math.cos(ang) * vel,
        1.1 + Math.random() * 2.2 * escala,
        Math.sin(ang) * vel,
        0.45 + Math.random() * 0.15,
        0.8 * escala,
        2.0 * escala,
        cor(PALETA.fumaca, 0.12),
        0.42,
        -0.6,
        1.1,
      );
    }
    for (let i = 0; i < nSparks; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const vel = (7 + Math.random() * 11) * escala;
      spawn(
        addPool,
        x,
        yBase + 0.3,
        z,
        Math.cos(ang) * vel,
        3 + Math.random() * 7.5,
        Math.sin(ang) * vel,
        0.26 + Math.random() * 0.22,
        0.14 * escala,
        0.05,
        cor(PALETA.faisca, 0.1),
        1,
        13,
        0.3,
      );
    }
    if (size === 'base') shake('large');
    else if (size === 'large') shake('medium');
    else shake('small');
  }

  // ------------------------------------------------------------------ tiro: flash, luz, hit
  function tiroFlash(ev) {
    const x = Number(ev.fromX) || 0;
    const z = Number(ev.fromZ) || 0;
    let y = 2.2;
    try {
      if (lastState && Array.isArray(lastState.towers)) {
        const torre = lastState.towers.find((t) => t && t.id === ev.towerId);
        if (torre && Number.isFinite(Number(torre.y))) y = Number(torre.y) + 1.2;
      }
    } catch (err) {
      /* ignora */
    }
    flashLight(x, y, z);
    // flash de tiro: 60 ms
    spawn(addPool, x, y, z, 0, 0.4, 0, 0.06, 1.25, 0.5, cor(PALETA.fogoQuente, 0.08), 0.95, 0, 0);
    // hit flash no alvo: 100 ms
    const tx = Number(ev.toX);
    const tz = Number(ev.toZ);
    if (Number.isFinite(tx) && Number.isFinite(tz)) {
      let ty = 1.2;
      try {
        if (lastState && Array.isArray(lastState.enemies)) {
          const alvo = lastState.enemies.find((e) => e && e.id === ev.targetId);
          if (alvo) ty = (Number(alvo.y) || 0) + (Number(alvo.altitude) || 0) + 0.6;
        }
      } catch (err) {
        /* ignora */
      }
      spawn(addPool, tx, ty, tz, 0, 0.6, 0, 0.1, 0.85, 0.35, cor(PALETA.branco, 0.05), 0.85, 0, 0);
    }
  }

  // ------------------------------------------------------------------ dano flutuante
  function ensureDamageLayer() {
    try {
      if (damageLayer && damageLayer.parentNode) return damageLayer;
      if (typeof document === 'undefined' || !document || !document.body) return null;
      const layer = document.createElement('div');
      layer.id = 'fx-dano-flutuante';
      layer.style.position = 'fixed';
      layer.style.inset = '0';
      layer.style.pointerEvents = 'none';
      layer.style.zIndex = '40';
      layer.style.overflow = 'hidden';
      document.body.appendChild(layer);
      damageLayer = layer;
      return layer;
    } catch (err) {
      return null;
    }
  }

  function danoFlutuante(texto, x, y, z, corTexto) {
    try {
      const layer = ensureDamageLayer();
      if (!layer || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
      const node = document.createElement('div');
      node.textContent = String(texto);
      node.style.position = 'absolute';
      node.style.left = '0px';
      node.style.top = '0px';
      node.style.transform = 'translate(-50%, -50%)';
      node.style.font = '700 15px "Segoe UI", system-ui, sans-serif';
      node.style.color = corTexto || '#ffd45e';
      node.style.textShadow = '0 2px 4px rgba(0,0,0,0.9)';
      node.style.whiteSpace = 'nowrap';
      node.style.opacity = '1';
      node.style.willChange = 'transform, opacity';
      layer.appendChild(node);
      if (damageNumbers.length >= MAX_DAMAGE_NUMBERS) {
        const antigo = damageNumbers.shift();
        if (antigo && antigo.node && antigo.node.parentNode) antigo.node.parentNode.removeChild(antigo.node);
      }
      damageNumbers.push({ node, x, y, z, life: 0.8, maxLife: 0.8, subida: 0.0 });
    } catch (err) {
      /* ignora */
    }
  }

  function updateDamageNumbers(dt) {
    for (let i = damageNumbers.length - 1; i >= 0; i -= 1) {
      const d = damageNumbers[i];
      d.life -= dt;
      d.subida += dt;
      if (d.life <= 0) {
        try {
          if (d.node && d.node.parentNode) d.node.parentNode.removeChild(d.node);
        } catch (err) {
          /* ignora */
        }
        damageNumbers.splice(i, 1);
        continue;
      }
      const proj = project(d.x, d.y + d.subida * 1.6, d.z);
      try {
        if (!proj || !proj.visible) {
          d.node.style.opacity = '0';
        } else {
          d.node.style.left = `${Math.round(proj.x)}px`;
          d.node.style.top = `${Math.round(proj.y)}px`;
          d.node.style.opacity = String(clamp(d.life / d.maxLife + 0.15, 0, 1));
        }
      } catch (err) {
        /* ignora */
      }
    }
  }

  // ------------------------------------------------------------------ rastros de míssil
  function acquireTrail(missileId, x, z) {
    try {
      let trail = activeTrails.get(missileId);
      if (trail) return trail;
      let slot = trailPool.find((t) => !t.emUso);
      if (!slot) {
        if (trailPool.length >= MAX_TRAILS) {
          slot = trailPool[0];
          removerTrail(slot);
        } else {
          const geometry = new THREE.BufferGeometry();
          const pos = new Float32Array(21 * 3);
          const attr = new THREE.BufferAttribute(pos, 3);
          attr.setUsage(THREE.DynamicDrawUsage);
          geometry.setAttribute('position', attr);
          geometry.setDrawRange(0, 2);
          const material = new THREE.LineBasicMaterial({
            color: 0xffb020,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          });
          const line = new THREE.Line(geometry, material);
          line.frustumCulled = false;
          root.add(line);
          slot = { line, geometry, material, attr, pos, emUso: false, count: 0, id: null, gone: 0 };
          trailPool.push(slot);
        }
      }
      if (!slot) return null;
      slot.emUso = true;
      slot.id = missileId;
      slot.gone = 0;
      slot.count = 1;
      for (let i = 0; i < 21; i += 1) {
        slot.pos[i * 3] = x;
        slot.pos[i * 3 + 1] = 1.3;
        slot.pos[i * 3 + 2] = z;
      }
      slot.attr.needsUpdate = true;
      slot.geometry.setDrawRange(0, 1);
      slot.material.opacity = 0.85;
      slot.line.visible = true;
      activeTrails.set(missileId, slot);
      return slot;
    } catch (err) {
      return null;
    }
  }

  function removerTrail(slot) {
    if (!slot) return;
    slot.emUso = false;
    slot.gone = 0;
    if (slot.id != null) activeTrails.delete(slot.id);
    slot.id = null;
    try {
      slot.line.visible = false;
      slot.material.opacity = 0;
    } catch (err) {
      /* ignora */
    }
  }

  function pushTrailPoint(slot, x, z) {
    try {
      const lastIdx = (slot.count - 1) * 3;
      const dx = slot.pos[lastIdx] - x;
      const dz = slot.pos[lastIdx + 2] - z;
      if (dx * dx + dz * dz < 0.1 && slot.count > 1) return;
      if (slot.count >= 21) {
        // rola a janela: descarta o segmento mais antigo
        slot.pos.copyWithin(0, 3, 21 * 3);
        slot.count = 20;
      }
      const i = slot.count * 3;
      slot.pos[i] = x;
      slot.pos[i + 1] = 1.3;
      slot.pos[i + 2] = z;
      slot.count += 1;
      slot.attr.needsUpdate = true;
      slot.geometry.setDrawRange(0, slot.count);
    } catch (err) {
      /* ignora */
    }
  }

  function updateTrails(dt) {
    try {
      const projeteis = lastState && Array.isArray(lastState.projectiles) ? lastState.projectiles : null;
      const vivos = new Map();
      if (projeteis) {
        for (const p of projeteis) {
          if (p && p.id != null) vivos.set(p.id, p);
        }
      }
      for (const [id, slot] of Array.from(activeTrails.entries())) {
        const proj = vivos.get(id);
        if (proj) {
          slot.gone = 0;
          pushTrailPoint(slot, Number(proj.x) || 0, Number(proj.z) || 0);
        } else {
          slot.gone += dt;
          const fator = clamp(1 - slot.gone / 0.4, 0, 1);
          slot.material.opacity = 0.85 * fator;
          slot.geometry.setDrawRange(0, Math.max(0, Math.floor(slot.count * fator)));
          if (slot.gone >= 0.4) removerTrail(slot);
        }
      }
    } catch (err) {
      /* ignora */
    }
  }

  // ------------------------------------------------------------------ cadeia tesla
  function ensureBoltPool() {
    while (bolts.length < MAX_BOLTS) {
      try {
        const geometry = new THREE.BufferGeometry();
        const pos = new Float32Array(13 * 3);
        const attr = new THREE.BufferAttribute(pos, 3);
        attr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('position', attr);
        geometry.setDrawRange(0, 13);
        const material = new THREE.LineBasicMaterial({
          color: 0xa8ecff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        line.visible = false;
        root.add(line);
        bolts.push({ line, geometry, material, attr, pos, life: 0, maxLife: 0.12, from: null, to: null });
      } catch (err) {
        break;
      }
    }
  }
  ensureBoltPool();

  function raioTesla(fromX, fromZ, toX, toZ, atraso) {
    try {
      ensureBoltPool();
      if (bolts.length === 0) return;
      let slot = bolts.find((b) => b.life <= 0);
      if (!slot) {
        slot = bolts.reduce((a, b) => (a.life < b.life ? a : b), bolts[0]);
      }
      slot.life = 0.12;
      slot.maxLife = 0.12;
      slot.atraso = atraso || 0;
      slot.from = [fromX, 2.4, fromZ];
      slot.to = [toX, 1.2, toZ];
      slot.line.visible = true;
      slot.material.opacity = 1;
    } catch (err) {
      /* ignora */
    }
  }

  function updateBolts(dt) {
    for (const slot of bolts) {
      if (slot.life <= 0) {
        if (slot.line.visible) slot.line.visible = false;
        continue;
      }
      slot.life -= dt;
      if (slot.life <= 0) {
        slot.line.visible = false;
        slot.material.opacity = 0;
        continue;
      }
      try {
        const [x0, y0, z0] = slot.from;
        const [x1, y1, z1] = slot.to;
        const n = 13;
        for (let i = 0; i < n; i += 1) {
          const t = i / (n - 1);
          const jitter = i === 0 || i === n - 1 ? 0 : (Math.random() - 0.5) * 0.9;
          const jitterY = i === 0 || i === n - 1 ? 0 : (Math.random() - 0.5) * 0.5;
          slot.pos[i * 3] = x0 + (x1 - x0) * t + jitter;
          slot.pos[i * 3 + 1] = y0 + (y1 - y0) * t + jitterY;
          slot.pos[i * 3 + 2] = z0 + (z1 - z0) * t + jitter;
        }
        slot.attr.needsUpdate = true;
        slot.geometry.setDrawRange(0, n);
        slot.material.opacity = 0.55 + Math.random() * 0.45;
      } catch (err) {
        /* ignora */
      }
    }
  }

  // ------------------------------------------------------------------ lentidão
  function lentidao(x, y, z, duration) {
    const vida = clamp(Number(duration) || 1.5, 0.8, 2.5);
    for (let i = 0; i < 12; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const raio = Math.random() * 1.4;
      spawn(
        addPool,
        x + Math.cos(ang) * raio,
        y + Math.random() * 1.5,
        z + Math.sin(ang) * raio,
        Math.cos(ang) * 0.4,
        0.3 + Math.random() * 0.6,
        Math.sin(ang) * 0.4,
        Math.min(vida, 0.8 + Math.random() * 0.8),
        0.16,
        0.05,
        cor(i % 2 === 0 ? PALETA.gelo : PALETA.geloForte, 0.1),
        0.9,
        1.2,
        0.2,
      );
    }
    // "tinta azul": duas manchas aditivas grandes e curtas no inimigo.
    for (let i = 0; i < 2; i += 1) {
      spawn(addPool, x, y + 0.5, z, 0, 0.5, 0, 0.35, 0.9, 1.7, PALETA.gelo, 0.35, 0, 0);
    }
  }

  // ------------------------------------------------------------------ eventos
  function tratarEvento(ev, temExplosaoNoPonto) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'shot': {
        tiroFlash(ev);
        // dano flutuante: usa o dano da torre no state (evento não traz dano).
        let dano = Number(ev.damage);
        if (!Number.isFinite(dano) && lastState && Array.isArray(lastState.towers)) {
          const torre = lastState.towers.find((t) => t && t.id === ev.towerId);
          if (torre) dano = Number(torre.damage);
        }
        if (Number.isFinite(dano) && dano > 0 && Number.isFinite(Number(ev.toX))) {
          danoFlutuante(Math.round(dano), Number(ev.toX), 2.4, Number(ev.toZ), '#ffd45e');
        }
        if (Array.isArray(ev.chain) && ev.chain.length > 0) {
          let px = Number(ev.fromX) || 0;
          let pz = Number(ev.fromZ) || 0;
          ev.chain.forEach((no, idx) => {
            if (!no) return;
            const nx = Number(no.x);
            const nz = Number(no.z);
            if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;
            raioTesla(px, pz, nx, nz, idx * 0.02);
            px = nx;
            pz = nz;
          });
        } else if (ev.kind === 'chain' && Number.isFinite(Number(ev.toX))) {
          raioTesla(Number(ev.fromX) || 0, Number(ev.fromZ) || 0, Number(ev.toX), Number(ev.toZ), 0);
        }
        if ((ev.towerType === 'missil' || ev.kind === 'missile') && ev.missileId != null) {
          acquireTrail(ev.missileId, Number(ev.fromX) || 0, Number(ev.fromZ) || 0);
        }
        break;
      }
      case 'troopShot': {
        const tx = Number(ev.toX);
        const tz = Number(ev.toZ);
        if (Number.isFinite(tx) && Number.isFinite(tz)) {
          spawn(addPool, tx, 1.4, tz, 0, 0.6, 0, 0.1, 0.8, 0.3, cor(PALETA.branco, 0.05), 0.85, 0, 0);
          const dano = Number(ev.damage);
          if (Number.isFinite(dano) && dano > 0) danoFlutuante(Math.round(dano), tx, 2.4, tz, '#ffb0a0');
        }
        break;
      }
      case 'explosion':
        explosao(Number(ev.x) || 0, Number(ev.z) || 0, ev.size || 'small', ev.kind);
        break;
      case 'missileHit':
        if (!temExplosaoNoPonto) {
          explosao(Number(ev.x) || 0, Number(ev.z) || 0, 'small', 'missil');
        }
        break;
      case 'kill': {
        const x = Number(ev.x) || 0;
        const z = Number(ev.z) || 0;
        if (!temExplosaoNoPonto) {
          explosao(x, z, ev.boss ? 'large' : 'small', 'morte');
        }
        if (ev.boss) shake('large');
        break;
      }
      case 'leak': {
        const x = Number(ev.x) || 0;
        const z = Number(ev.z) || 0;
        explosao(x, z, 'base', 'morte');
        break;
      }
      case 'slow': {
        let x = 0;
        let y = 1;
        let z = 0;
        try {
          if (lastState && Array.isArray(lastState.enemies)) {
            const alvo = lastState.enemies.find((e) => e && e.id === ev.enemyId);
            if (alvo) {
              x = Number(alvo.x) || 0;
              z = Number(alvo.z) || 0;
              y = (Number(alvo.y) || 0) + (Number(alvo.altitude) || 0) * 0.4;
            }
          }
        } catch (err) {
          /* ignora */
        }
        lentidao(x, y, z, ev.duration);
        break;
      }
      case 'build': {
        try {
          const slot = lastState && Array.isArray(lastState.slots) ? lastState.slots.find((s) => s && s.i === ev.slot) : null;
          const x = slot ? Number(slot.x) : 0;
          const z = slot ? Number(slot.z) : 0;
          for (let i = 0; i < 12; i += 1) {
            const ang = Math.random() * Math.PI * 2;
            spawn(smokePool, x, 0.3, z, Math.cos(ang) * 1.6, 0.5 + Math.random(), Math.sin(ang) * 1.6, 0.4, 0.5, 1.3, cor(PALETA.poeira, 0.1), 0.4, 0.4, 1.2);
          }
        } catch (err) {
          /* ignora */
        }
        break;
      }
      case 'upgrade': {
        try {
          const torre = lastState && Array.isArray(lastState.towers) ? lastState.towers.find((t) => t && t.id === ev.towerId) : null;
          if (torre) {
            const x = Number(torre.x) || 0;
            const z = Number(torre.z) || 0;
            for (let i = 0; i < 10; i += 1) {
              const ang = Math.random() * Math.PI * 2;
              spawn(addPool, x, 1.6, z, Math.cos(ang) * 2, 2 + Math.random() * 3, Math.sin(ang) * 2, 0.35, 0.16, 0.06, cor(PALETA.fogoQuente, 0.1), 0.9, 8, 0.4);
            }
          }
        } catch (err) {
          /* ignora */
        }
        break;
      }
      case 'sell': {
        try {
          const torre = lastState && Array.isArray(lastState.towers) ? lastState.towers.find((t) => t && t.id === ev.towerId) : null;
          if (torre) {
            const x = Number(torre.x) || 0;
            const z = Number(torre.z) || 0;
            for (let i = 0; i < 10; i += 1) {
              const ang = Math.random() * Math.PI * 2;
              spawn(smokePool, x, 0.4, z, Math.cos(ang) * 1.2, 0.4 + Math.random() * 0.8, Math.sin(ang) * 1.2, 0.45, 0.6, 1.5, cor(PALETA.fumaca, 0.1), 0.4, 0.3, 1.2);
            }
          }
        } catch (err) {
          /* ignora */
        }
        break;
      }
      case 'bossSpawn': {
        let x = 0;
        let y = 2;
        let z = 0;
        try {
          const alvo = lastState && Array.isArray(lastState.enemies) ? lastState.enemies.find((e) => e && e.id === ev.enemyId) : null;
          if (alvo) {
            x = Number(alvo.x) || 0;
            z = Number(alvo.z) || 0;
            y = (Number(alvo.y) || 0) + (Number(alvo.altitude) || 0) * 0.5;
          }
        } catch (err) {
          /* ignora */
        }
        for (let i = 0; i < 18; i += 1) {
          const ang = (i / 18) * Math.PI * 2;
          spawn(addPool, x, y, z, Math.cos(ang) * 4.5, 1.6 + Math.random() * 2, Math.sin(ang) * 4.5, 0.55, 0.5, 0.12, cor(PALETA.chefe, 0.12), 0.9, 3, 1.1);
        }
        shake('medium');
        break;
      }
      default:
        break;
    }
  }

  function handle(events, state) {
    if (disposed) return;
    try {
      if (state && typeof state === 'object') lastState = state;
      if (!Array.isArray(events) || events.length === 0) return;
      const explosoes = [];
      for (const ev of events) if (ev && ev.type === 'explosion') explosoes.push(ev);
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        let mesmaPosicao = false;
        if (ev.type === 'missileHit' || ev.type === 'kill') {
          const ex = Number(ev.x);
          const ez = Number(ev.z);
          mesmaPosicao = explosoes.some(
            (ex2) => Math.abs((Number(ex2.x) || 0) - (Number(ex) || 0)) < 1.2 && Math.abs((Number(ex2.z) || 0) - (Number(ez) || 0)) < 1.2,
          );
        }
        try {
          tratarEvento(ev, mesmaPosicao);
          logEvents.push({ t: Math.round(timeline * 100) / 100, type: ev.type });
          if (logEvents.length > MAX_LOG) logEvents.splice(0, logEvents.length - MAX_LOG);
        } catch (err) {
          /* evento isolado nunca quebra o jogo */
        }
      }
    } catch (err) {
      /* nunca propaga */
    }
  }

  function update(dt) {
    if (disposed) return;
    try {
      const passo = clamp(Number(dt) || 0, 0, 0.1);
      timeline += passo;
      updatePool(addPool, passo);
      updatePool(smokePool, passo);
      updateLights(passo);
      updateTrails(passo);
      updateBolts(passo);
      updateDamageNumbers(passo);
    } catch (err) {
      /* ignora */
    }
  }

  function log() {
    try {
      return logEvents.slice();
    } catch (err) {
      return [];
    }
  }

  function count() {
    try {
      return addPool.active + smokePool.active;
    } catch (err) {
      return 0;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      for (const d of damageNumbers) {
        if (d && d.node && d.node.parentNode) d.node.parentNode.removeChild(d.node);
      }
      damageNumbers.length = 0;
      if (damageLayer && damageLayer.parentNode) damageLayer.parentNode.removeChild(damageLayer);
      damageLayer = null;
      activeTrails.clear();
      try {
        if (cena && typeof cena.remove === 'function') cena.remove(root);
      } catch (err) {
        /* ignora */
      }
      const descartar = (obj) => {
        try {
          if (!obj) return;
          if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
          if (obj.material && typeof obj.material.dispose === 'function') obj.material.dispose();
        } catch (err) {
          /* ignora */
        }
      };
      for (const p of pools) {
        descartar(p.points);
      }
      for (const t of trailPool) descartar(t.line);
      for (const b of bolts) descartar(b.line);
      for (const slot of lights) {
        try {
          if (slot.light && typeof slot.light.dispose === 'function') slot.light.dispose();
        } catch (err) {
          /* ignora */
        }
      }
      pools.length = 0;
      trailPool.length = 0;
      bolts.length = 0;
      lights.length = 0;
      lastState = null;
    } catch (err) {
      /* ignora */
    }
  }

  return { handle, update, log, count, dispose };
}

export default createFx;
