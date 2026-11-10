// meshes.js — modelos e cenário 100% PROCEDURAIS (sem texturas/arquivos externos).
// Usado por scene.js. Tudo é construído com geometrias primitivas do Three.js
// vendorizado, mescladas em poucos draw calls com cores por vértice.
//
// Convenções do mundo (iguais à simulação): x∈[-50,50], z∈[-25,25], y para cima.
// Frente dos modelos = +z local (scene.js gira os grupos com atan2(dx,dz)).
// Origem dos modelos terrestres no chão (y=0); aéreos centrados na origem e
// posicionados na altitude pelo scene.js.

import * as THREE from '../vendor/three/three.module.js';

const PI2 = Math.PI * 2;

export const MAX_SLOTS = 16;
export const MAX_TROOP_POINTS = 6;
export const MAX_ENEMIES = 48;
export const MAX_PROJECTILES = 24;

// ---------------------------------------------------------------- utilitários

// PRNG determinístico só para o render (a simulação tem o seu próprio).
export function makeRng(seed = 20261109) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _col = new THREE.Color();

function transformGeo(geo, part) {
  const pos = part.pos || [0, 0, 0];
  const rot = part.rot || [0, 0, 0];
  const sc = part.scale === undefined ? 1 : part.scale;
  _e.set(rot[0], rot[1], rot[2]);
  _q.setFromEuler(_e);
  _v.set(pos[0], pos[1], pos[2]);
  if (typeof sc === 'number') _s.set(sc, sc, sc);
  else _s.set(sc[0], sc[1], sc[2]);
  _m4.compose(_v, _q, _s);
  geo.applyMatrix4(_m4);
  return geo;
}

// Mescla partes (geometria + cor) num único BufferGeometry com cor por vértice.
// parts: [{ geo, color, pos?, rot?, scale? }]
export function mergeParts(parts) {
  const chunks = [];
  const colors = [];
  let total = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || !part.geo) continue;
    let g = part.geo.index ? part.geo.toNonIndexed() : part.geo.clone();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    transformGeo(g, part);
    const count = g.getAttribute('position').count;
    chunks.push(g);
    total += count;
    _col.set(part.color === undefined ? 0xffffff : part.color);
    colors.push([_col.r, _col.g, _col.b]);
  }
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colorArr = new Float32Array(total * 3);
  let off = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const g = chunks[i];
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    positions.set(p.array, off * 3);
    normals.set(n.array, off * 3);
    const c = colors[i];
    for (let v = 0; v < p.count; v += 1) {
      colorArr[(off + v) * 3] = c[0];
      colorArr[(off + v) * 3 + 1] = c[1];
      colorArr[(off + v) * 3 + 2] = c[2];
    }
    off += p.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));
  geo.computeBoundingSphere();
  return geo;
}

// ------------------------------------------------- geometrias primitivas curtas
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const sph = (r, seg = 10) => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2));
const cone = (r, h, seg = 8) => new THREE.ConeGeometry(r, h, seg);
const torus = (r, t, rs = 6, ts = 14) => new THREE.TorusGeometry(r, t, rs, ts);
const ico = (r, detail = 0) => new THREE.IcosahedronGeometry(r, detail);
const hemi = (r, seg = 8) => new THREE.SphereGeometry(r, seg, 4, 0, PI2, 0, Math.PI * 0.55);

function flatCircle(radius, seg = 16) {
  const geo = new THREE.CircleGeometry(radius, seg);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function flatRing(r0, r1, seg = 28) {
  const geo = new THREE.RingGeometry(r0, r1, seg);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

// Quad plano (2 triângulos) entre dois pontos do plano x/z, com largura.
function quadGeom(ax, az, bx, bz, width, y) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-5) return null;
  const ux = dx / len;
  const uz = dz / len;
  const nx = -uz;
  const nz = ux;
  const hw = width / 2;
  const p1 = [ax + nx * hw, y, az + nz * hw];
  const p2 = [ax - nx * hw, y, az - nz * hw];
  const p3 = [bx - nx * hw, y, bz - nz * hw];
  const p4 = [bx + nx * hw, y, bz + nz * hw];
  // ordem anti-horária vista de cima (+Y) para o material FrontSide não sumir
  const positions = new Float32Array([
    ...p1, ...p3, ...p2,
    ...p1, ...p4, ...p3,
  ]);
  const normals = new Float32Array(18);
  for (let i = 0; i < 6; i += 1) {
    normals[i * 3 + 1] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}

function vertexMaterial(opts = {}) {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    ...opts,
  });
}

function basicVertexMaterial(opts = {}) {
  return new THREE.MeshBasicMaterial({ vertexColors: true, ...opts });
}

// Libera geometrias/materiais (e texturas, se um dia houver) de uma subárvore.
export function disposeObject3D(root) {
  if (!root) return;
  const geos = new Set();
  const mats = new Set();
  root.traverse((child) => {
    if (child.geometry) geos.add(child.geometry);
    const m = child.material;
    if (Array.isArray(m)) m.forEach((x) => x && mats.add(x));
    else if (m) mats.add(m);
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => {
    Object.keys(m).forEach((k) => {
      const v = m[k];
      if (v && v.isTexture) v.dispose();
    });
    m.dispose();
  });
  if (root.parent) root.parent.remove(root);
}

// ---------------------------------------------------------------- temas visuais

export const THEMES = {
  deserto: {
    id: 'deserto',
    fog: 'areia',
    skyHorizon: 0xf6dfae,
    skyZenith: 0x6f9fc9,
    fogColor: 0xe9d3a1,
    fogNear: 70,
    fogFar: 210,
    hemiSky: 0xffe8bb,
    hemiGround: 0x7a5a34,
    hemiIntensity: 0.85,
    sunColor: 0xffe4b0,
    sunIntensity: 1.25,
    sunPos: [46, 70, 22],
    fillColor: 0x9fb8d8,
    fillIntensity: 0.28,
    fillPos: [-40, 32, -30],
    terrainBase: 0xc9a05f,
    terrainAlt: 0xe3c17f,
    terrainEdge: 0xa87b45,
    pathBase: 0x8c6c3e,
    pathLine: 0xf5dda6,
    pathEdge: 0x6b5030,
    accent: 0xffc75a,
    accent2: 0xff8a3d,
    metal: 0x6e6a5c,
    rock: 0xb08a55,
    tree: 0x7d6a3f,
    weather: 'areia',
    stars: false,
  },
  neve: {
    id: 'neve',
    fog: 'neve',
    skyHorizon: 0xdae8f2,
    skyZenith: 0x4b6f96,
    fogColor: 0xd2e1ec,
    fogNear: 60,
    fogFar: 195,
    hemiSky: 0xdcecff,
    hemiGround: 0x8a9db3,
    hemiIntensity: 0.9,
    sunColor: 0xe4efff,
    sunIntensity: 1.1,
    sunPos: [-38, 62, 28],
    fillColor: 0xcfe4ff,
    fillIntensity: 0.34,
    fillPos: [40, 26, -30],
    terrainBase: 0xdde9f1,
    terrainAlt: 0xffffff,
    terrainEdge: 0xb3c6d6,
    pathBase: 0x8ea6ba,
    pathLine: 0xf2f9ff,
    pathEdge: 0x6f889e,
    accent: 0x8fd8ff,
    accent2: 0x63b6e8,
    metal: 0x7f8f9d,
    rock: 0x9fb0c0,
    tree: 0x2f5a4a,
    weather: 'neve',
    stars: false,
  },
  cidade: {
    id: 'cidade',
    fog: 'noturno',
    skyHorizon: 0x223049,
    skyZenith: 0x070a14,
    fogColor: 0x16223a,
    fogNear: 55,
    fogFar: 190,
    hemiSky: 0x5a6f9e,
    hemiGround: 0x121824,
    hemiIntensity: 0.95,
    sunColor: 0xc2d3ff,
    sunIntensity: 0.95,
    sunPos: [-42, 58, -24],
    fillColor: 0x6f8dff,
    fillIntensity: 0.55,
    fillPos: [34, 26, -38],
    terrainBase: 0x2b3444,
    terrainAlt: 0x3b465c,
    terrainEdge: 0x161c27,
    pathBase: 0x39465e,
    pathLine: 0x8ff2e4,
    pathEdge: 0x232d40,
    accent: 0xff5f9e,
    accent2: 0x7fe6ff,
    metal: 0x4a5364,
    rock: 0x2a303c,
    tree: 0x24323f,
    weather: 'brasas',
    stars: true,
  },
};

export function resolveTheme(mapDef) {
  const id = (mapDef && (mapDef.id || mapDef.mapId)) || 'deserto';
  const fog = (mapDef && mapDef.fog) || id;
  if (fog === 'areia' || fog === 'deserto') return THEMES.deserto;
  if (fog === 'neve') return THEMES.neve;
  if (fog === 'noturno' || fog === 'cidade') return THEMES.cidade;
  return THEMES[id] || THEMES.deserto;
}

// ---------------------------------------------------------------- céu / clima

export function buildSky(theme) {
  const geo = new THREE.SphereGeometry(250, 20, 12);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const horizon = new THREE.Color(theme.skyHorizon);
  const zenith = new THREE.Color(theme.skyZenith);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    let t = Math.max(0, Math.min(1, (y / 250 + 0.12) / 0.9));
    t = t * t * (3 - 2 * t);
    tmp.copy(horizon).lerp(zenith, t);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  mesh.renderOrder = -20;
  mesh.frustumCulled = false;
  return mesh;
}

function terrainHeight(x, z) {
  const bx = Math.max(0, (Math.abs(x) - 52) / 12);
  const bz = Math.max(0, (Math.abs(z) - 27) / 8);
  const border = Math.max(bx, bz);
  if (border <= 0) return 0;
  const n = Math.sin(x * 0.17) * Math.cos(z * 0.23) + 0.55 * Math.sin(x * 0.07 + z * 0.11) + 0.3 * Math.cos(x * 0.31 - z * 0.19);
  return border * (2.2 + 2.6 * (n * 0.5 + 0.5)) * Math.min(1, border * 1.8);
}

export function buildTerrain(theme, rng) {
  const group = new THREE.Group();
  group.name = 'terrain';

  const geo = new THREE.PlaneGeometry(140, 88, 56, 34);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(theme.terrainBase);
  const alt = new THREE.Color(theme.terrainAlt);
  const edge = new THREE.Color(theme.terrainEdge);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    const n = Math.sin(x * 0.21 + z * 0.17) * 0.5 + 0.5;
    const speck = 0.92 + 0.16 * Math.sin(x * 0.93 + z * 1.27);
    tmp.copy(base).lerp(alt, n * 0.75);
    tmp.multiplyScalar(speck);
    const border = Math.max(0, Math.min(1, (Math.max(Math.abs(x) - 52, Math.abs(z) - 27)) / 8));
    if (border > 0) tmp.lerp(edge, border * 0.75);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const terrain = new THREE.Mesh(geo, mat);
  terrain.name = 'ground';
  group.add(terrain);

  // Decoração de fundo (fora da área jogável, |x|>54 ou |z|>28).
  const parts = [];
  const glowParts = [];
  const outside = () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const x = -66 + rng() * 132;
      const z = -41 + rng() * 82;
      if (Math.abs(x) > 54 || Math.abs(z) > 28) return { x, z };
    }
    return { x: 60, z: 34 };
  };

  if (theme.id === 'deserto') {
    for (let i = 0; i < 34; i += 1) {
      const { x, z } = outside();
      const s = 0.8 + rng() * 2.2;
      parts.push({
        geo: ico(s, 0),
        color: i % 3 === 0 ? theme.rock : 0x8f6f45,
        pos: [x, terrainHeight(x, z) + s * 0.35, z],
        rot: [rng() * 0.4, rng() * PI2, rng() * 0.4],
        scale: [1, 0.6 + rng() * 0.5, 1],
      });
    }
    for (let i = 0; i < 18; i += 1) {
      const { x, z } = outside();
      const h = 2.2 + rng() * 2.6;
      const y = terrainHeight(x, z);
      parts.push({ geo: cyl(0.32, 0.4, h, 7), color: theme.tree, pos: [x, y + h / 2, z] });
      parts.push({ geo: cyl(0.2, 0.2, 0.9, 6), color: theme.tree, pos: [x + 0.5, y + h * 0.62, z], rot: [0, 0, 0.9] });
      parts.push({ geo: cyl(0.2, 0.2, 0.8, 6), color: theme.tree, pos: [x - 0.45, y + h * 0.48, z], rot: [0, 0, -0.9] });
    }
  } else if (theme.id === 'neve') {
    for (let i = 0; i < 44; i += 1) {
      const { x, z } = outside();
      const h = 3 + rng() * 3.4;
      const y = terrainHeight(x, z);
      parts.push({ geo: cyl(0.22, 0.3, h * 0.42, 6), color: 0x5a4633, pos: [x, y + h * 0.21, z] });
      parts.push({ geo: cone(1.5, h * 0.72, 7), color: theme.tree, pos: [x, y + h * 0.55, z] });
      parts.push({ geo: cone(1.15, h * 0.6, 7), color: 0x3c6f5b, pos: [x, y + h * 0.8, z] });
      parts.push({ geo: cone(0.85, h * 0.5, 7), color: 0xe8f3fa, pos: [x, y + h * 0.98, z], scale: [1, 0.7, 1] });
    }
    for (let i = 0; i < 20; i += 1) {
      const { x, z } = outside();
      const s = 0.7 + rng() * 1.6;
      parts.push({ geo: ico(s, 0), color: theme.rock, pos: [x, terrainHeight(x, z) + s * 0.3, z], scale: [1, 0.7, 1] });
    }
  } else {
    // cidade: quarteirões ao fundo com janelas acesas (material basic separado).
    for (let i = 0; i < 46; i += 1) {
      const { x, z } = outside();
      const w = 3.5 + rng() * 5;
      const d = 3.5 + rng() * 5;
      const h = 4 + rng() * 15;
      const y = terrainHeight(x, z);
      const tone = 0x1b2232 + Math.floor(rng() * 4) * 0x05070b;
      parts.push({ geo: box(w, h, d), color: tone, pos: [x, y + h / 2, z] });
      parts.push({ geo: box(w * 1.04, 0.35, d * 1.04), color: 0x2e3a50, pos: [x, y + h + 0.17, z] });
      // antena
      if (rng() > 0.5) {
        parts.push({ geo: cyl(0.05, 0.05, 2.2, 5), color: 0x3a4356, pos: [x + 0.6, y + h + 1.2, z - 0.5] });
      }
      // janelas na face voltada para o centro
      const windows = 3 + Math.floor(rng() * 6);
      for (let wI = 0; wI < windows; wI += 1) {
        const wy = y + 1.4 + rng() * Math.max(1, h - 2.4);
        const wx = x + (rng() - 0.5) * (w * 0.7);
        const faceZ = z + (z > 0 ? -d / 2 - 0.06 : d / 2 + 0.06);
        const warm = rng() > 0.35;
        glowParts.push({
          geo: box(0.42, 0.55, 0.06),
          color: warm ? 0xffc777 : theme.accent2,
          pos: [wx, wy, faceZ],
        });
      }
    }
    for (let i = 0; i < 16; i += 1) {
      const { x, z } = outside();
      const s = 0.5 + rng() * 1.2;
      parts.push({
        geo: ico(s, 0),
        color: theme.rock,
        pos: [x, terrainHeight(x, z) + s * 0.3, z],
        scale: [1.4, 0.4, 1.4],
      });
    }
  }

  if (parts.length) {
    const decor = new THREE.Mesh(mergeParts(parts), vertexMaterial());
    decor.name = 'decor';
    group.add(decor);
  }
  if (glowParts.length) {
    const glow = new THREE.Mesh(mergeParts(glowParts), basicVertexMaterial());
    glow.name = 'windows';
    group.add(glow);
  }
  return group;
}

export function buildPath(map, theme) {
  const group = new THREE.Group();
  group.name = 'path';
  const wps = (map && map.waypoints) || [];
  if (wps.length < 2) return group;
  const width = 4.6;
  const parts = [];
  const glowParts = []; // cidade: faixas de neon (MeshBasic, 1 draw call extra)
  const neon = theme.id === 'cidade';
  for (let i = 0; i < wps.length - 1; i += 1) {
    const ax = wps[i][0];
    const az = wps[i][1];
    const bx = wps[i + 1][0];
    const bz = wps[i + 1][1];
    // base/asfalto mais escuro por baixo
    const under = quadGeom(ax, az, bx, bz, width + 1.1, 0.045);
    if (under) parts.push({ geo: under, color: theme.pathEdge });
    const base = quadGeom(ax, az, bx, bz, width, 0.06);
    if (base) parts.push({ geo: base, color: theme.pathBase });
    // faixas laterais
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len > 0.01) {
      const nx = -dz / len;
      const nz = dx / len;
      const off = width / 2 - 0.18;
      const e1 = quadGeom(ax + nx * off, az + nz * off, bx + nx * off, bz + nz * off, 0.24, 0.075);
      if (e1) parts.push({ geo: e1, color: theme.pathLine });
      const e2 = quadGeom(ax - nx * off, az - nz * off, bx - nx * off, bz - nz * off, 0.24, 0.075);
      if (e2) parts.push({ geo: e2, color: theme.pathLine });
      if (neon) {
        const g1 = quadGeom(ax + nx * off, az + nz * off, bx + nx * off, bz + nz * off, 0.3, 0.09);
        if (g1) glowParts.push({ geo: g1, color: theme.accent2 });
        const g2 = quadGeom(ax - nx * off, az - nz * off, bx - nx * off, bz - nz * off, 0.3, 0.09);
        if (g2) glowParts.push({ geo: g2, color: theme.accent2 });
      }
      // tracejado central
      for (let d = 2.5; d < len - 1.5; d += 5) {
        const t0 = d / len;
        const t1 = (d + 1.3) / len;
        const dash = quadGeom(
          ax + dx * t0, az + dz * t0,
          ax + dx * t1, az + dz * t1,
          0.22, 0.085,
        );
        if (dash) parts.push({ geo: dash, color: theme.pathLine });
        if (neon && dash) {
          const gd = quadGeom(
            ax + dx * t0, az + dz * t0,
            ax + dx * t1, az + dz * t1,
            0.3, 0.095,
          );
          if (gd) glowParts.push({ geo: gd, color: theme.pathLine });
        }
      }
    }
  }
  // setas de sentido spawn → base (chevrons) para o jogador ler a rota
  for (let i = 0; i < wps.length - 1; i += 1) {
    const ax = wps[i][0];
    const az = wps[i][1];
    const bx = wps[i + 1][0];
    const bz = wps[i + 1][1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 2) continue;
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    for (let d = 7; d < len - 2; d += 14) {
      const cx = ax + ux * d;
      const cz = az + uz * d;
      const tipX = cx + ux * 1.15;
      const tipZ = cz + uz * 1.15;
      const backX = cx - ux * 0.6;
      const backZ = cz - uz * 0.6;
      const arm1 = quadGeom(backX + px * 0.85, backZ + pz * 0.85, tipX, tipZ, 0.3, 0.11);
      const arm2 = quadGeom(backX - px * 0.85, backZ - pz * 0.85, tipX, tipZ, 0.3, 0.11);
      if (arm1) parts.push({ geo: arm1, color: theme.pathLine });
      if (arm2) parts.push({ geo: arm2, color: theme.pathLine });
      if (neon) {
        const gl1 = quadGeom(backX + px * 0.85, backZ + pz * 0.85, tipX, tipZ, 0.36, 0.12);
        const gl2 = quadGeom(backX - px * 0.85, backZ - pz * 0.85, tipX, tipZ, 0.36, 0.12);
        if (gl1) glowParts.push({ geo: gl1, color: theme.accent2 });
        if (gl2) glowParts.push({ geo: gl2, color: theme.accent2 });
      }
    }
  }

  // "juntas" arredondadas nos waypoints internos
  for (let i = 1; i < wps.length - 1; i += 1) {
    parts.push({ geo: flatCircle(width / 2 + 0.4, 16), color: theme.pathEdge, pos: [wps[i][0], 0.05, wps[i][1]] });
    parts.push({ geo: flatCircle(width / 2 - 0.2, 16), color: theme.pathBase, pos: [wps[i][0], 0.065, wps[i][1]] });
  }
  const mesh = new THREE.Mesh(mergeParts(parts), vertexMaterial());
  mesh.name = 'pathMesh';
  group.add(mesh);
  if (glowParts.length) {
    const glow = new THREE.Mesh(mergeParts(glowParts), basicVertexMaterial());
    glow.name = 'pathNeon';
    group.add(glow);
  }
  return group;
}

export function buildSpawn(theme) {
  const group = new THREE.Group();
  group.name = 'spawn';
  const parts = [
    { geo: cyl(3.1, 3.7, 0.5, 18), color: 0x2b2f35, pos: [0, 0.25, 0] },
    { geo: cyl(2.4, 2.8, 0.22, 18), color: theme.accent, pos: [0, 0.6, 0] },
    { geo: box(0.9, 3.4, 0.9), color: 0x3d4450, pos: [-3.2, 1.7, 0] },
    { geo: box(0.9, 3.4, 0.9), color: 0x3d4450, pos: [3.2, 1.7, 0] },
    { geo: box(1.2, 0.3, 1.2), color: theme.accent, pos: [-3.2, 3.5, 0] },
    { geo: box(1.2, 0.3, 1.2), color: theme.accent, pos: [3.2, 3.5, 0] },
  ];
  const staticMesh = new THREE.Mesh(mergeParts(parts), vertexMaterial());
  staticMesh.name = 'spawnBase';
  group.add(staticMesh);

  // portal animado (torus vertical + disco de brilho)
  const ringMat = new THREE.MeshBasicMaterial({
    color: theme.accent,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.16, 8, 32), ringMat);
  ring.name = 'portalRing';
  ring.position.set(0, 3.2, 0);
  group.add(ring);
  const glowMat = new THREE.MeshBasicMaterial({
    color: theme.accent2,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(new THREE.CircleGeometry(2.45, 28), glowMat);
  glow.name = 'portalGlow';
  glow.position.set(0, 3.2, 0);
  group.add(glow);
  return group;
}

export function buildBase(theme) {
  const group = new THREE.Group();
  group.name = 'base';
  const parts = [];
  // plataforma
  parts.push({ geo: cyl(5.4, 6.2, 0.8, 18), color: 0x2e333b, pos: [0, 0.4, 0] });
  parts.push({ geo: cyl(4.4, 4.8, 0.5, 18), color: 0x444b56, pos: [0, 1.0, 0] });
  // muralha / bunker
  parts.push({ geo: box(5.6, 1.6, 5.6), color: 0x3a414b, pos: [0, 1.9, 0] });
  parts.push({ geo: box(4.6, 1.2, 4.6), color: 0x4d5560, pos: [0, 2.9, 0] });
  parts.push({ geo: box(6.2, 0.35, 6.2), color: theme.metal, pos: [0, 3.6, 0] });
  // torre central / antena
  parts.push({ geo: cyl(1.5, 1.9, 2.0, 12), color: 0x515a66, pos: [0, 4.7, 0] });
  parts.push({ geo: cyl(0.16, 0.16, 3.2, 6), color: 0x8d97a4, pos: [0, 7.2, 0] });
  // canhões das quinas
  const corners = [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]];
  for (const [cx, cz] of corners) {
    parts.push({ geo: cyl(0.7, 0.9, 0.9, 10), color: 0x39414c, pos: [cx, 4.2, cz] });
    parts.push({ geo: cyl(0.13, 0.16, 1.8, 8), color: 0x22262b, pos: [cx, 4.6, cz + 0.7], rot: [0.5, 0, 0] });
  }
  // sacos de areia
  for (let i = 0; i < 8; i += 1) {
    const ang = (i / 8) * PI2;
    parts.push({
      geo: box(1.3, 0.5, 0.7),
      color: theme.id === 'neve' ? 0xdde9f1 : 0x8a7a58,
      pos: [Math.cos(ang) * 4.4, 1.25, Math.sin(ang) * 4.4],
      rot: [0, -ang + Math.PI / 2, 0],
    });
  }
  // bandeira / mastro
  parts.push({ geo: cyl(0.07, 0.07, 2.4, 5), color: 0x8d97a4, pos: [3.4, 5.4, 3.4] });
  parts.push({ geo: box(1.4, 0.7, 0.04), color: theme.accent, pos: [4.1, 6.1, 3.4] });
  const staticMesh = new THREE.Mesh(mergeParts(parts), vertexMaterial());
  staticMesh.name = 'baseStatic';
  group.add(staticMesh);

  // farol animado (também pisca vermelho em vazamento)
  const beaconMat = new THREE.MeshBasicMaterial({
    color: theme.accent,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), beaconMat);
  beacon.name = 'beacon';
  beacon.position.set(0, 8.9, 0);
  group.add(beacon);
  const domeMat = new THREE.MeshBasicMaterial({
    color: theme.accent2,
    transparent: true,
    opacity: 0.08,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(7.4, 20, 10, 0, PI2, 0, Math.PI / 2), domeMat);
  dome.name = 'shield';
  dome.position.set(0, 1.1, 0);
  group.add(dome);
  return group;
}

// ------------------------------------------------------------- clima (Points)

export function buildWeather(theme) {
  const group = new THREE.Group();
  group.name = 'weather';
  const kind = theme.weather;
  const count = kind === 'neve' ? 400 : kind === 'areia' ? 300 : 400;
  const positions = new Float32Array(count * 3);
  const data = new Float32Array(count * 3); // velocidade, fase, escala
  const rng = makeRng(theme.id === 'neve' ? 777 : theme.id === 'areia' ? 778 : 779);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = -62 + rng() * 124;
    positions[i * 3 + 2] = -32 + rng() * 64;
    if (kind === 'neve') {
      positions[i * 3 + 1] = rng() * 42;
      data[i * 3] = 2.5 + rng() * 3.5; // queda
      data[i * 3 + 1] = rng() * PI2; // fase
      data[i * 3 + 2] = 0.6 + rng() * 0.9; // escala
    } else if (kind === 'areia') {
      positions[i * 3 + 1] = 0.3 + rng() * 7;
      data[i * 3] = 3 + rng() * 5; // deriva x
      data[i * 3 + 1] = rng() * PI2;
      data[i * 3 + 2] = 0.5 + rng() * 0.8;
    } else {
      positions[i * 3 + 1] = 0.2 + rng() * 16;
      data[i * 3] = 0.5 + rng() * 1.6; // subida
      data[i * 3 + 1] = rng() * PI2;
      data[i * 3 + 2] = 0.6 + rng() * 1.1;
    }
  }
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(positions, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  const mat = new THREE.PointsMaterial({
    color: kind === 'neve' ? 0xffffff : kind === 'areia' ? 0xe8d3a2 : 0xff9a3c,
    size: kind === 'neve' ? 0.42 : kind === 'areia' ? 0.3 : 0.34,
    sizeAttenuation: true,
    transparent: true,
    opacity: kind === 'neve' ? 0.92 : kind === 'areia' ? 0.5 : 0.9,
    depthWrite: false,
    blending: kind === 'brasas' ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'weatherPoints';
  points.frustumCulled = false;
  group.add(points);

  let stars = null;
  if (theme.stars) {
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(160 * 3);
    for (let i = 0; i < 160; i += 1) {
      const a = rng() * PI2;
      const r = 150 + rng() * 70;
      const y = 55 + rng() * 90;
      starPos[i * 3] = Math.cos(a) * r;
      starPos[i * 3 + 1] = y;
      starPos[i * 3 + 2] = Math.sin(a) * r;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xdce8ff,
      size: 0.9,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      fog: false,
    });
    stars = new THREE.Points(starGeo, starMat);
    stars.name = 'stars';
    stars.frustumCulled = false;
    group.add(stars);
  }

  let time = 0;
  function update(dt) {
    time += dt;
    const arr = positions;
    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      if (kind === 'neve') {
        arr[i3 + 1] -= data[i3] * dt;
        arr[i3] += Math.sin(time * 0.8 + data[i3 + 1]) * dt * 1.4;
        if (arr[i3 + 1] < 0.2) {
          arr[i3 + 1] = 40 + (i % 7) * 0.4;
          arr[i3] = -62 + ((i * 37) % 124);
        }
      } else if (kind === 'areia') {
        arr[i3] += data[i3] * dt;
        arr[i3 + 1] += Math.sin(time * 1.4 + data[i3 + 1]) * dt * 0.7;
        if (arr[i3] > 64) arr[i3] = -64;
        if (arr[i3 + 1] < 0.2) arr[i3 + 1] = 0.3;
      } else {
        arr[i3 + 1] += data[i3] * dt;
        arr[i3] += Math.sin(time * 1.6 + data[i3 + 1]) * dt * 0.9;
        if (arr[i3 + 1] > 17) {
          arr[i3 + 1] = 0.2;
          arr[i3] = -62 + ((i * 53) % 124);
        }
      }
    }
    attr.needsUpdate = true;
    if (stars) stars.rotation.y += dt * 0.004;
  }

  return { object: group, update };
}

// ------------------------------------------------------- marcadores / sombras

export function createSlotMarkers(capacity = MAX_SLOTS) {
  const geo = flatRing(1.45, 2.05, 30);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.name = 'slotMarkers';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  const c = new THREE.Color(0xffffff);
  for (let i = 0; i < capacity; i += 1) mesh.setColorAt(i, c);
  mesh.count = 0;
  return mesh;
}

export function createTroopPointMarkers(capacity = MAX_TROOP_POINTS) {
  const geo = flatRing(0.9, 1.32, 24);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.name = 'troopMarkers';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  const c = new THREE.Color(0xffffff);
  for (let i = 0; i < capacity; i += 1) mesh.setColorAt(i, c);
  mesh.count = 0;
  return mesh;
}

export function createHighlightRing(radius, color, opacity = 0.9) {
  const geo = flatRing(radius * 0.8, radius, 40);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}

export function createBlobShadows(capacity = MAX_ENEMIES + MAX_SLOTS + 8) {
  const geo = flatCircle(1, 14);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.name = 'blobShadows';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

// --------------------------------------------------------- efeitos simples

export function createEffects() {
  const group = new THREE.Group();
  group.name = 'effects';

  const ringGeo = flatRing(0.6, 0.78, 30);
  const ringMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, 26);
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rings.frustumCulled = false;
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < 26; i += 1) rings.setColorAt(i, color.setRGB(0, 0, 0));
  rings.count = 0;
  group.add(rings);

  const sparkGeo = new THREE.OctahedronGeometry(0.22, 0);
  const sparkMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sparks = new THREE.InstancedMesh(sparkGeo, sparkMat, 40);
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparks.frustumCulled = false;
  for (let i = 0; i < 40; i += 1) sparks.setColorAt(i, color.setRGB(0, 0, 0));
  sparks.count = 0;
  group.add(sparks);

  const ringEntries = [];
  const sparkEntries = [];
  const ringPool = [];
  const sparkPool = [];

  function addRing(x, z, hex, size = 2, life = 0.5, y = 0.14) {
    const e = ringPool.pop() || { x: 0, z: 0, y, life: 0, maxLife: 1, size: 1, r: 1, g: 1, b: 1 };
    color.set(hex);
    e.x = x;
    e.z = z;
    e.y = y;
    e.life = life;
    e.maxLife = life;
    e.size = size;
    e.r = color.r;
    e.g = color.g;
    e.b = color.b;
    ringEntries.push(e);
    return e;
  }

  function addSpark(x, y, z, hex, size = 0.6, life = 0.12) {
    const e = sparkPool.pop() || { x: 0, y: 0, z: 0, life: 0, maxLife: 1, size: 1, r: 1, g: 1, b: 1 };
    color.set(hex);
    e.x = x;
    e.y = y;
    e.z = z;
    e.life = life;
    e.maxLife = life;
    e.size = size;
    e.r = color.r;
    e.g = color.g;
    e.b = color.b;
    sparkEntries.push(e);
    return e;
  }

  function update(dt) {
    let n = 0;
    for (let i = ringEntries.length - 1; i >= 0; i -= 1) {
      const e = ringEntries[i];
      e.life -= dt;
      if (e.life <= 0) {
        ringEntries.splice(i, 1);
        ringPool.push(e);
        continue;
      }
      const k = 1 - e.life / e.maxLife;
      const scale = e.size * (0.35 + k * 1.9);
      const fade = 1 - k;
      dummy.position.set(e.x, e.y, e.z);
      dummy.scale.set(scale, 1, scale);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      rings.setMatrixAt(n, dummy.matrix);
      color.setRGB(e.r * fade, e.g * fade, e.b * fade);
      rings.setColorAt(n, color);
      n += 1;
    }
    rings.count = n;
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;

    n = 0;
    for (let i = sparkEntries.length - 1; i >= 0; i -= 1) {
      const e = sparkEntries[i];
      e.life -= dt;
      if (e.life <= 0) {
        sparkEntries.splice(i, 1);
        sparkPool.push(e);
        continue;
      }
      const k = 1 - e.life / e.maxLife;
      const scale = e.size * (1 - k * 0.8);
      dummy.position.set(e.x, e.y + k * 0.6, e.z);
      dummy.scale.setScalar(Math.max(0.01, scale));
      dummy.rotation.set(k * 2, k * 3, 0);
      dummy.updateMatrix();
      sparks.setMatrixAt(n, dummy.matrix);
      color.setRGB(e.r, e.g, e.b);
      sparks.setColorAt(n, color);
      n += 1;
    }
    sparks.count = n;
    sparks.instanceMatrix.needsUpdate = true;
    if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;
  }

  return { group, addRing, addSpark, update, ringCount: () => ringEntries.length, sparkCount: () => sparkEntries.length };
}

// ------------------------------------------------------------ fábrica de modelos

export function createModelFactory() {
  const owned = [];
  const bodyMats = [];
  const templates = new Map();

  function trackTemplate(group) {
    const geos = new Set();
    const mats = new Set();
    group.traverse((child) => {
      if (child.geometry) geos.add(child.geometry);
      const m = child.material;
      if (Array.isArray(m)) m.forEach((x) => x && mats.add(x));
      else if (m) mats.add(m);
    });
    geos.forEach((g) => owned.push({ dispose: () => g.dispose() }));
    mats.forEach((m) => owned.push({ dispose: () => m.dispose() }));
  }

  // ---------------------------------------------------------------- inimigos
  function buildEnemyTemplate(type) {
    const group = new THREE.Group();
    group.name = 'enemy:' + type;
    const parts = [];
    const rotors = []; // { parts, pos, axis, speed }
    let navParts = null; // luzes de navegação (aéreos legíveis no céu)
    let auraColor = 0;
    let auraRadius = 2.4;
    let scale = 1;
    let radius = 0.6;

    switch (type) {
      case 'soldado': {
        radius = 0.55;
        parts.push(
          { geo: box(0.17, 0.58, 0.22), color: 0x3b3f31, pos: [-0.17, 0.3, 0] },
          { geo: box(0.17, 0.58, 0.22), color: 0x3b3f31, pos: [0.17, 0.3, 0] },
          { geo: box(0.26, 0.16, 0.36), color: 0x24241e, pos: [-0.17, 0.08, 0.03] },
          { geo: box(0.26, 0.16, 0.36), color: 0x24241e, pos: [0.17, 0.08, 0.03] },
          { geo: box(0.52, 0.6, 0.32), color: 0x6d6a4a, pos: [0, 0.9, 0] },
          { geo: box(0.56, 0.3, 0.36), color: 0x4c5639, pos: [0, 0.98, 0] },
          { geo: box(0.14, 0.5, 0.16), color: 0x5d5a3e, pos: [-0.35, 0.95, 0.02] },
          { geo: box(0.14, 0.5, 0.16), color: 0x5d5a3e, pos: [0.35, 0.95, 0.05] },
          { geo: sph(0.17, 8), color: 0xc79b74, pos: [0, 1.36, 0] },
          { geo: hemi(0.2, 8), color: 0x4c4f3a, pos: [0, 1.4, 0] },
          { geo: box(0.34, 0.42, 0.2), color: 0x474733, pos: [0, 0.96, -0.27] },
          { geo: box(0.07, 0.09, 0.62), color: 0x22221d, pos: [0.3, 0.98, 0.24] },
        );
        break;
      }
      case 'blindado': {
        radius = 0.8;
        scale = 1.05;
        parts.push(
          { geo: box(0.28, 0.7, 0.32), color: 0x3b3f45, pos: [-0.23, 0.35, 0] },
          { geo: box(0.28, 0.7, 0.32), color: 0x3b3f45, pos: [0.23, 0.35, 0] },
          { geo: box(0.36, 0.18, 0.44), color: 0x26292d, pos: [-0.23, 0.09, 0.04] },
          { geo: box(0.36, 0.18, 0.44), color: 0x26292d, pos: [0.23, 0.09, 0.04] },
          { geo: box(0.8, 0.8, 0.5), color: 0x596069, pos: [0, 1.05, 0] },
          { geo: box(0.86, 0.62, 0.1), color: 0x33383f, pos: [0, 1.1, 0.3] },
          { geo: box(0.5, 0.5, 0.25), color: 0x444a52, pos: [0, 1.1, -0.36] },
          { geo: box(0.32, 0.34, 0.5), color: 0x6a727c, pos: [-0.55, 1.4, 0] },
          { geo: box(0.32, 0.34, 0.5), color: 0x6a727c, pos: [0.55, 1.4, 0] },
          { geo: sph(0.21, 8), color: 0x596069, pos: [0, 1.62, 0] },
          { geo: box(0.34, 0.1, 0.08), color: 0xff4a3a, pos: [0, 1.63, 0.2] },
          { geo: box(0.14, 0.14, 0.9), color: 0x2b2f34, pos: [0.45, 1.0, 0.35] },
          { geo: box(0.75, 0.95, 0.1), color: 0x4b525c, pos: [0, 0.95, 0.46], rot: [0.08, 0, 0] },
        );
        break;
      }
      case 'tanque': {
        radius = 1.15;
        scale = 1.1;
        parts.push(
          { geo: box(0.55, 0.5, 3.0), color: 0x24282b, pos: [-1.05, 0.32, 0] },
          { geo: box(0.55, 0.5, 3.0), color: 0x24282b, pos: [1.05, 0.32, 0] },
          { geo: box(2.1, 0.7, 2.7), color: 0x535e42, pos: [0, 0.85, 0] },
          { geo: box(2.0, 0.45, 0.35), color: 0x424b33, pos: [0, 1.0, 1.32], rot: [-0.5, 0, 0] },
          { geo: cyl(0.72, 0.86, 0.5, 10), color: 0x5a6644, pos: [0, 1.45, 0] },
          { geo: cyl(0.1, 0.12, 2.0, 8), color: 0x2b2e28, pos: [0, 1.5, 1.5], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.16, 0.16, 0.3, 8), color: 0x1f221e, pos: [0, 1.5, 2.4], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.28, 0.28, 0.12, 8), color: 0x39412e, pos: [0, 1.78, 0] },
          { geo: box(0.04, 0.9, 0.04), color: 0x2c2c28, pos: [-0.62, 1.85, 0.35] },
          { geo: box(0.5, 0.35, 0.6), color: 0x3a4033, pos: [0.8, 1.35, -0.7] },
        );
        break;
      }
      case 'drone': {
        radius = 0.45;
        scale = 1.3;
        parts.push(
          { geo: box(0.6, 0.22, 0.75), color: 0x3b424c, pos: [0, 0, 0] },
          { geo: box(0.34, 0.18, 0.3), color: 0x2c323b, pos: [0, -0.02, 0.48] },
          { geo: sph(0.09, 8), color: 0xff3b30, pos: [0, 0, 0.62] },
          { geo: box(1.1, 0.06, 0.12), color: 0x2c323b, pos: [0, 0.06, 0] },
          { geo: box(0.12, 0.06, 1.1), color: 0x2c323b, pos: [0, 0.06, 0] },
          { geo: cyl(0.09, 0.09, 0.09, 8), color: 0x1f242b, pos: [-0.5, 0.1, 0] },
          { geo: cyl(0.09, 0.09, 0.09, 8), color: 0x1f242b, pos: [0.5, 0.1, 0] },
          { geo: box(0.06, 0.05, 0.65), color: 0x232a31, pos: [-0.26, -0.2, 0] },
          { geo: box(0.06, 0.05, 0.65), color: 0x232a31, pos: [0.26, -0.2, 0] },
        );
        navParts = [
          { geo: sph(0.08, 6), color: 0xff4433, pos: [-0.5, 0.18, 0] },
          { geo: sph(0.08, 6), color: 0xff4433, pos: [0.5, 0.18, 0] },
          { geo: sph(0.1, 6), color: 0xff3b30, pos: [0, 0.02, 0.64] },
          { geo: sph(0.07, 6), color: 0xffffff, pos: [0, 0.28, -0.1] },
        ];
        rotors.push({
          pos: [-0.5, 0.16, 0],
          axis: 'y',
          speed: 26,
          parts: [
            { geo: cyl(0.12, 0.12, 0.06, 8), color: 0x1f242b },
            { geo: box(0.85, 0.03, 0.09), color: 0x9aa4b0 },
            { geo: box(0.09, 0.03, 0.85), color: 0x9aa4b0 },
          ],
        });
        rotors.push({
          pos: [0.5, 0.16, 0],
          axis: 'y',
          speed: -26,
          parts: [
            { geo: cyl(0.12, 0.12, 0.06, 8), color: 0x1f242b },
            { geo: box(0.85, 0.03, 0.09), color: 0x9aa4b0 },
            { geo: box(0.09, 0.03, 0.85), color: 0x9aa4b0 },
          ],
        });
        break;
      }
      case 'helicoptero': {
        radius = 0.9;
        scale = 1.22;
        parts.push(
          { geo: cyl(0.34, 0.4, 1.5, 10), color: 0x4b5441, pos: [0, 0.05, 0], rot: [Math.PI / 2, 0, 0] },
          { geo: sph(0.36, 10), color: 0x4b5441, pos: [0, 0.02, 0.85], scale: [0.9, 0.8, 0.9] },
          { geo: sph(0.28, 8), color: 0x22303d, pos: [0, 0.18, 0.62], scale: [0.9, 0.7, 0.9] },
          { geo: box(0.16, 0.16, 1.7), color: 0x3f4738, pos: [0, 0.08, -1.55] },
          { geo: box(0.06, 0.55, 0.4), color: 0x3f4738, pos: [0, 0.38, -2.25] },
          { geo: box(0.9, 0.05, 0.28), color: 0x3f4738, pos: [0, 0.1, -2.05] },
          { geo: box(0.06, 0.06, 1.2), color: 0x2b2f2a, pos: [-0.34, -0.42, 0.05] },
          { geo: box(0.06, 0.06, 1.2), color: 0x2b2f2a, pos: [0.34, -0.42, 0.05] },
          { geo: box(0.05, 0.3, 0.05), color: 0x2b2f2a, pos: [-0.34, -0.28, 0.3] },
          { geo: box(0.05, 0.3, 0.05), color: 0x2b2f2a, pos: [0.34, -0.28, 0.3] },
          { geo: box(0.16, 0.12, 0.5), color: 0x2f352c, pos: [-0.55, -0.08, 0.1] },
          { geo: box(0.16, 0.12, 0.5), color: 0x2f352c, pos: [0.55, -0.08, 0.1] },
        );
        navParts = [
          { geo: sph(0.08, 6), color: 0xff4433, pos: [0, 0.62, -2.15] },
          { geo: sph(0.07, 6), color: 0xff4433, pos: [-0.62, 0.05, 0.1] },
          { geo: sph(0.07, 6), color: 0x7fe6ff, pos: [0.62, 0.05, 0.1] },
          { geo: sph(0.07, 6), color: 0xffffff, pos: [0, -0.32, 0.15] },
        ];
        rotors.push({
          pos: [0, 0.62, 0],
          axis: 'y',
          speed: 20,
          parts: [
            { geo: cyl(0.13, 0.13, 0.1, 10), color: 0x23271f },
            { geo: box(2.8, 0.04, 0.2), color: 0x9aa4b0 },
            { geo: box(0.2, 0.04, 2.8), color: 0x9aa4b0 },
          ],
        });
        rotors.push({
          pos: [0.14, 0.42, -2.28],
          axis: 'x',
          speed: 30,
          parts: [
            { geo: cyl(0.06, 0.06, 0.1, 8), color: 0x23271f, rot: [0, 0, Math.PI / 2] },
            { geo: box(0.05, 0.72, 0.1), color: 0x9aa4b0 },
            { geo: box(0.05, 0.1, 0.72), color: 0x9aa4b0 },
          ],
        });
        break;
      }
      case 'bombardeiro': {
        radius = 1.3;
        scale = 1.35;
        parts.push(
          { geo: cyl(0.34, 0.3, 3.4, 10), color: 0x59616c, pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0] },
          { geo: cone(0.35, 0.9, 10), color: 0x59616c, pos: [0, 0, 2.0], rot: [Math.PI / 2, 0, 0] },
          { geo: cone(0.3, 0.9, 10), color: 0x59616c, pos: [0, 0, -2.0], rot: [-Math.PI / 2, 0, 0] },
          { geo: box(5.2, 0.14, 1.3), color: 0x4c545e, pos: [0, 0.02, -0.15] },
          { geo: box(1.2, 0.12, 1.0), color: 0x4c545e, pos: [-2.35, 0.02, -0.4], rot: [0, 0.3, 0] },
          { geo: box(1.2, 0.12, 1.0), color: 0x4c545e, pos: [2.35, 0.02, -0.4], rot: [0, -0.3, 0] },
          { geo: box(2.2, 0.08, 0.8), color: 0x4c545e, pos: [0, 0.1, -1.75] },
          { geo: box(0.08, 0.9, 0.7), color: 0x4c545e, pos: [0, 0.45, -1.8] },
          { geo: sph(0.3, 8), color: 0x22303d, pos: [0, 0.2, 1.6], scale: [0.8, 0.6, 1] },
          { geo: cyl(0.16, 0.16, 0.7, 8), color: 0x3a414a, pos: [-1.3, 0.05, 0.3], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.16, 0.16, 0.7, 8), color: 0x3a414a, pos: [1.3, 0.05, 0.3], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.14, 0.14, 0.6, 8), color: 0x3a414a, pos: [-2.45, 0.05, 0.3], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.14, 0.14, 0.6, 8), color: 0x3a414a, pos: [2.45, 0.05, 0.3], rot: [Math.PI / 2, 0, 0] },
        );
        navParts = [
          { geo: sph(0.1, 6), color: 0xff4433, pos: [-2.75, 0.08, -0.5] },
          { geo: sph(0.1, 6), color: 0x7fe6ff, pos: [2.75, 0.08, -0.5] },
          { geo: sph(0.08, 6), color: 0xffffff, pos: [0, 0.14, 2.35] },
          { geo: sph(0.08, 6), color: 0xff4433, pos: [0, 0.5, -1.85] },
        ];
        const prop = [
          { geo: cyl(0.1, 0.1, 0.08, 8), color: 0x23281f, rot: [Math.PI / 2, 0, 0] },
          { geo: box(0.9, 0.06, 0.04), color: 0x9aa4b0 },
          { geo: box(0.06, 0.9, 0.04), color: 0x9aa4b0 },
        ];
        rotors.push({ pos: [-1.3, 0.05, 0.78], axis: 'z', speed: 34, parts: prop });
        rotors.push({ pos: [1.3, 0.05, 0.78], axis: 'z', speed: -34, parts: prop.map((p) => ({ ...p, geo: p.geo.clone() })) });
        break;
      }
      case 'zepelim': {
        radius = 1.9;
        scale = 1.45;
        parts.push(
          { geo: sph(1, 12), color: 0xb9c3cd, pos: [0, 0, 0], scale: [1.05, 0.85, 2.5] },
          { geo: box(0.8, 0.4, 1.5), color: 0x4c5763, pos: [0, -0.68, 0.1] },
          { geo: box(0.5, 0.16, 1.1), color: 0x2a3846, pos: [0, -0.6, 0.6] },
          { geo: box(0.08, 1.2, 1.0), color: 0x8a96a3, pos: [0, 0.25, -2.0] },
          { geo: box(1.8, 0.08, 1.0), color: 0x8a96a3, pos: [0, 0.25, -2.0] },
          { geo: box(0.25, 0.25, 0.5), color: 0x39414b, pos: [-0.85, -0.1, -0.3] },
          { geo: box(0.25, 0.25, 0.5), color: 0x39414b, pos: [0.85, -0.1, -0.3] },
          { geo: box(1.4, 0.06, 0.6), color: 0x8f2f2f, pos: [0, 0.55, 0.8] },
        );
        navParts = [
          { geo: sph(0.13, 6), color: 0xff4433, pos: [-1.12, 0.02, 0.2] },
          { geo: sph(0.13, 6), color: 0xff4433, pos: [1.12, 0.02, 0.2] },
          { geo: sph(0.1, 6), color: 0xffffff, pos: [0, 0.9, 0] },
          { geo: sph(0.11, 6), color: 0x7fe6ff, pos: [0, -0.66, 0.92] },
        ];
        rotors.push({
          pos: [0, -0.05, -1.0],
          axis: 'z',
          speed: 24,
          parts: [
            { geo: cyl(0.08, 0.08, 0.08, 8), color: 0x23281f, rot: [Math.PI / 2, 0, 0] },
            { geo: box(0.7, 0.05, 0.04), color: 0x9aa4b0 },
            { geo: box(0.05, 0.7, 0.04), color: 0x9aa4b0 },
          ],
        });
        break;
      }
      case 'chefe-deserto': {
        radius = 1.7;
        scale = 1.5;
        auraColor = 0xff5a22;
        auraRadius = 2.7;
        parts.push(
          { geo: box(0.62, 1.25, 0.66), color: 0x3a332b, pos: [-0.5, 0.62, 0] },
          { geo: box(0.62, 1.25, 0.66), color: 0x3a332b, pos: [0.5, 0.62, 0] },
          { geo: box(0.72, 0.25, 0.92), color: 0x2b2620, pos: [-0.5, 0.12, 0.1] },
          { geo: box(0.72, 0.25, 0.92), color: 0x2b2620, pos: [0.5, 0.12, 0.1] },
          { geo: box(0.56, 0.3, 0.56), color: 0x4a4238, pos: [-0.5, 1.12, 0.14] },
          { geo: box(0.56, 0.3, 0.56), color: 0x4a4238, pos: [0.5, 1.12, 0.14] },
          { geo: box(1.5, 1.2, 0.95), color: 0x55463a, pos: [0, 1.85, 0] },
          { geo: box(1.2, 0.9, 0.16), color: 0x3d3128, pos: [0, 1.9, 0.5] },
          { geo: sph(0.28, 10), color: 0xff5522, pos: [0, 1.95, 0.58] },
          { geo: box(0.7, 0.45, 0.85), color: 0x453b31, pos: [-0.98, 2.35, 0] },
          { geo: box(0.7, 0.45, 0.85), color: 0x453b31, pos: [0.98, 2.35, 0] },
          { geo: cone(0.16, 0.55, 6), color: 0xc9a227, pos: [-1.2, 2.78, 0], rot: [0, 0, 0.35] },
          { geo: cone(0.16, 0.55, 6), color: 0xc9a227, pos: [1.2, 2.78, 0], rot: [0, 0, -0.35] },
          { geo: box(0.5, 0.45, 0.5), color: 0x4a4036, pos: [0, 2.75, 0] },
          { geo: box(0.62, 0.18, 0.62), color: 0x2b2620, pos: [0, 2.99, 0] },
          { geo: box(0.28, 0.07, 0.06), color: 0xff3322, pos: [0, 2.78, 0.27] },
          { geo: box(0.4, 1.1, 0.45), color: 0x453b31, pos: [-1.3, 2.0, 0] },
          { geo: box(0.4, 1.1, 0.45), color: 0x453b31, pos: [1.3, 2.0, 0] },
          { geo: cyl(0.18, 0.2, 1.2, 8), color: 0x2a2620, pos: [-1.3, 2.0, 0.55], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.04, 0.04, 1.5, 6), color: 0x8a8a8a, pos: [0.62, 3.15, -0.4] },
          { geo: box(0.55, 0.4, 0.04), color: 0x8f2f2f, pos: [0.9, 3.6, -0.4] },
        );
        break;
      }
      case 'chefe-neve': {
        radius = 2.0;
        scale = 1.32;
        auraColor = 0x66c8ff;
        auraRadius = 3.3;
        parts.push(
          { geo: box(3.6, 1.0, 5.0), color: 0x8b98a6, pos: [0, 0, 0] },
          { geo: box(3.0, 0.5, 4.0), color: 0x6d7a88, pos: [0, -0.6, 0] },
          { geo: box(2.6, 0.5, 3.2), color: 0x9aa7b5, pos: [0, 0.6, 0] },
          { geo: cone(1.0, 1.6, 10), color: 0x8b98a6, pos: [0, 0, 3.0], rot: [Math.PI / 2, 0, 0] },
          { geo: box(1.3, 0.9, 1.4), color: 0x7a8795, pos: [0, 1.2, 0.8] },
          { geo: box(1.1, 0.4, 1.2), color: 0x2a3846, pos: [0, 1.45, 0.8] },
          { geo: cyl(0.35, 0.4, 0.3, 10), color: 0x5b6672, pos: [-1.4, -0.1, 1.2] },
          { geo: cyl(0.35, 0.4, 0.3, 10), color: 0x5b6672, pos: [1.4, -0.1, 1.2] },
          { geo: cyl(0.35, 0.4, 0.3, 10), color: 0x5b6672, pos: [-1.4, -0.1, -1.2] },
          { geo: cyl(0.35, 0.4, 0.3, 10), color: 0x5b6672, pos: [1.4, -0.1, -1.2] },
          { geo: box(0.1, 1.0, 1.2), color: 0x6d7a88, pos: [-1.9, 0.3, -1.6] },
          { geo: box(0.1, 1.0, 1.2), color: 0x6d7a88, pos: [1.9, 0.3, -1.6] },
          { geo: cyl(0.03, 0.03, 1.2, 5), color: 0x8d97a4, pos: [0, 1.9, -0.6] },
          { geo: box(0.8, 0.3, 0.8), color: 0x5b6672, pos: [-2.0, 0.7, 0.3] },
          { geo: box(0.8, 0.3, 0.8), color: 0x5b6672, pos: [2.0, 0.7, 0.3] },
        );
        navParts = [
          { geo: sph(0.16, 6), color: 0x7fe6ff, pos: [-1.95, 0.35, 2.0] },
          { geo: sph(0.16, 6), color: 0x7fe6ff, pos: [1.95, 0.35, 2.0] },
          { geo: sph(0.14, 6), color: 0xff4433, pos: [-1.95, 0.35, -2.0] },
          { geo: sph(0.14, 6), color: 0xff4433, pos: [1.95, 0.35, -2.0] },
          { geo: sph(0.12, 6), color: 0xffffff, pos: [0, 1.95, -0.6] },
        ];
        rotors.push({
          pos: [-2.0, 0.95, 0.3],
          axis: 'y',
          speed: 16,
          parts: [
            { geo: cyl(0.14, 0.14, 0.08, 10), color: 0x23282f },
            { geo: box(2.2, 0.04, 0.16), color: 0xbcc8d6 },
            { geo: box(0.16, 0.04, 2.2), color: 0xbcc8d6 },
          ],
        });
        rotors.push({
          pos: [2.0, 0.95, 0.3],
          axis: 'y',
          speed: -16,
          parts: [
            { geo: cyl(0.14, 0.14, 0.08, 10), color: 0x23282f },
            { geo: box(2.2, 0.04, 0.16), color: 0xbcc8d6 },
            { geo: box(0.16, 0.04, 2.2), color: 0xbcc8d6 },
          ],
        });
        break;
      }
      case 'chefe-cidade': {
        radius = 2.2;
        scale = 1.5;
        auraColor = 0xff3fd0;
        auraRadius = 3.0;
        parts.push(
          { geo: box(0.85, 1.7, 0.95), color: 0x2a2f3a, pos: [-0.8, 0.85, 0] },
          { geo: box(0.85, 1.7, 0.95), color: 0x2a2f3a, pos: [0.8, 0.85, 0] },
          { geo: box(1.0, 0.3, 1.3), color: 0x1d222b, pos: [-0.8, 0.15, 0.1] },
          { geo: box(1.0, 0.3, 1.3), color: 0x1d222b, pos: [0.8, 0.15, 0.1] },
          { geo: box(0.95, 0.5, 1.0), color: 0x39404d, pos: [-0.8, 1.7, 0.1] },
          { geo: box(2.1, 1.5, 1.2), color: 0x3a4150, pos: [0, 2.55, 0] },
          { geo: box(1.6, 1.1, 0.2), color: 0x4a5364, pos: [0, 2.6, 0.62] },
          { geo: sph(0.45, 10), color: 0xff3fd0, pos: [0, 2.7, 0.78] },
          { geo: box(1.0, 0.8, 1.1), color: 0x2f3644, pos: [-1.5, 3.15, 0] },
          { geo: box(1.0, 0.8, 1.1), color: 0x2f3644, pos: [1.5, 3.15, 0] },
          { geo: cyl(0.22, 0.26, 1.5, 8), color: 0x1f242e, pos: [-1.5, 3.6, 0.6], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.22, 0.26, 1.5, 8), color: 0x1f242e, pos: [1.5, 3.6, 0.6], rot: [Math.PI / 2, 0, 0] },
          { geo: box(0.7, 0.6, 0.7), color: 0x3a4150, pos: [0, 3.62, 0] },
          { geo: box(0.42, 0.11, 0.06), color: 0xff3fd0, pos: [0, 3.64, 0.38] },
          { geo: box(0.45, 1.4, 0.5), color: 0x2f3644, pos: [-1.8, 2.3, 0] },
          { geo: box(0.45, 1.4, 0.5), color: 0x2f3644, pos: [1.8, 2.3, 0] },
          { geo: cone(0.2, 0.5, 6), color: 0xc23aa8, pos: [-1.8, 1.5, 0], rot: [Math.PI, 0, 0] },
          { geo: cone(0.2, 0.5, 6), color: 0xc23aa8, pos: [1.8, 1.5, 0], rot: [Math.PI, 0, 0] },
          { geo: box(0.8, 0.6, 0.7), color: 0x2a2f3a, pos: [0, 2.5, -0.8] },
          { geo: box(1.2, 0.3, 0.8), color: 0x1d222b, pos: [0, 3.15, -0.7] },
        );
        break;
      }
      default: {
        // fallback: robô genérico (tipo desconhecido)
        radius = 0.7;
        parts.push(
          { geo: box(0.6, 1.0, 0.5), color: 0x4a5058, pos: [0, 0.7, 0] },
          { geo: sph(0.25, 8), color: 0x8a939c, pos: [0, 1.4, 0] },
          { geo: box(0.15, 0.6, 0.15), color: 0x2b2f34, pos: [-0.2, 0.15, 0] },
          { geo: box(0.15, 0.6, 0.15), color: 0x2b2f34, pos: [0.2, 0.15, 0] },
        );
        break;
      }
    }

    const bodyMat = vertexMaterial();
    const body = new THREE.Mesh(mergeParts(parts), bodyMat);
    body.name = 'body';
    group.add(body);

    if (navParts && navParts.length) {
      const navMat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const nav = new THREE.Mesh(mergeParts(navParts), navMat);
      nav.name = 'navlights';
      nav.renderOrder = 2;
      group.add(nav);
    }

    let rotorMat = null;
    if (rotors.length) {
      rotorMat = vertexMaterial();
      for (const r of rotors) {
        const mesh = new THREE.Mesh(mergeParts(r.parts), rotorMat);
        mesh.position.set(r.pos[0], r.pos[1], r.pos[2]);
        mesh.userData.rotor = { axis: r.axis, speed: r.speed };
        mesh.name = 'rotor';
        group.add(mesh);
      }
    }

    if (auraColor) {
      const aura = new THREE.Group();
      aura.name = 'aura';
      const ringMat = new THREE.MeshBasicMaterial({
        color: auraColor,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const ring = new THREE.Mesh(flatRing(auraRadius * 0.82, auraRadius, 36), ringMat);
      ring.position.y = 0.14;
      aura.add(ring);
      const glowMat = new THREE.MeshBasicMaterial({
        color: auraColor,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const glow = new THREE.Mesh(new THREE.SphereGeometry(auraRadius * 0.9, 16, 10), glowMat);
      glow.scale.set(1, 0.55, 1);
      aura.add(glow);
      group.add(aura);
    }

    group.scale.setScalar(scale);
    group.userData.radius = radius;
    return { group, radius, scale };
  }

  function enemy(type) {
    const key = 'e:' + type;
    let tpl = templates.get(key);
    if (!tpl) {
      tpl = buildEnemyTemplate(type);
      trackTemplate(tpl.group);
      templates.set(key, tpl);
    }
    const group = tpl.group.clone(true);
    const body = group.getObjectByName('body');
    const bodyMat = body.material.clone();
    body.material = bodyMat;
    bodyMats.push(bodyMat);
    const rotors = [];
    group.traverse((child) => {
      if (child.userData && child.userData.rotor) rotors.push(child);
    });
    const aura = group.getObjectByName('aura');
    return {
      group,
      bodyMat,
      rotors,
      aura,
      radius: tpl.radius,
      baseScale: tpl.scale,
    };
  }

  // ------------------------------------------------------------------ torres
  function buildTowerTemplate(type, level) {
    const group = new THREE.Group();
    group.name = 'tower:' + type;
    const parts = [];
    const aimParts = [];
    let muzzle = [0, 1, 1.2];
    const metal = 0x4a5058;
    const dark = 0x2b3036;
    const light = 0x6b737c;

    if (type === 'metralhadora') {
      parts.push(
        { geo: cyl(0.95, 1.25, 0.5, 10), color: dark, pos: [0, 0.25, 0] },
        { geo: cyl(0.55, 0.7, 1.0, 10), color: metal, pos: [0, 1.0, 0] },
        { geo: box(1.1, 0.22, 1.1), color: light, pos: [0, 1.55, 0] },
      );
      for (let i = 0; i < 4; i += 1) {
        const a = (i / 4) * PI2 + Math.PI / 4;
        parts.push({ geo: box(0.16, 0.7, 0.16), color: dark, pos: [Math.cos(a) * 0.9, 0.55, Math.sin(a) * 0.9] });
      }
      aimParts.push(
        { geo: box(0.62, 0.34, 0.62), color: dark },
        { geo: box(0.52, 0.42, 0.8), color: metal, pos: [0, 0.34, 0.05] },
        { geo: cyl(0.06, 0.07, 1.0, 8), color: 0x22262b, pos: [-0.13, 0.34, 0.55], rot: [Math.PI / 2, 0, 0] },
        { geo: cyl(0.06, 0.07, 1.0, 8), color: 0x22262b, pos: [0.13, 0.34, 0.55], rot: [Math.PI / 2, 0, 0] },
        { geo: box(0.3, 0.24, 0.3), color: 0x3a4048, pos: [0, 0.44, -0.28] },
      );
      muzzle = [0, 0.34, 1.2];
      if (level >= 2) {
        parts.push({ geo: box(0.3, 0.5, 0.9), color: light, pos: [-0.62, 1.35, 0] });
        parts.push({ geo: box(0.3, 0.5, 0.9), color: light, pos: [0.62, 1.35, 0] });
        aimParts.push(
          { geo: cyl(0.05, 0.06, 0.9, 8), color: 0x2f353b, pos: [-0.24, 0.3, 0.55], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.05, 0.06, 0.9, 8), color: 0x2f353b, pos: [0.24, 0.3, 0.55], rot: [Math.PI / 2, 0, 0] },
        );
      }
      if (level >= 3) {
        parts.push(
          { geo: box(1.3, 0.16, 1.3), color: 0x596069, pos: [0, 1.72, 0] },
          { geo: cyl(0.04, 0.04, 0.9, 5), color: 0x8d97a4, pos: [-0.5, 2.2, -0.4] },
        );
        aimParts.push(
          { geo: box(0.8, 0.12, 0.3), color: 0x2f353b, pos: [0, 0.56, 0.1] },
          { geo: box(0.24, 0.3, 0.5), color: 0x5a636d, pos: [0, 0.58, -0.35] },
        );
      }
    } else if (type === 'antiaereo') {
      parts.push(
        { geo: cyl(1.05, 1.35, 0.45, 10), color: dark, pos: [0, 0.22, 0] },
        { geo: box(1.7, 0.28, 1.7), color: metal, pos: [0, 0.55, 0] },
      );
      for (let i = 0; i < 4; i += 1) {
        const a = (i / 4) * PI2;
        parts.push({ geo: box(0.2, 0.9, 0.2), color: dark, pos: [Math.cos(a) * 1.1, 0.5, Math.sin(a) * 1.1], rot: [0, 0, -Math.cos(a) * 0.5] });
      }
      parts.push({ geo: box(1.0, 0.4, 1.0), color: metal, pos: [0, 0.8, 0] });
      const barrelParts = [
        { geo: box(0.9, 0.5, 0.7), color: dark, pos: [0, 0.3, 0] },
        { geo: cyl(0.09, 0.1, 1.8, 8), color: 0x22262b, pos: [-0.2, 0.62, 0.72], rot: [Math.PI / 2 - 0.55, 0, 0] },
        { geo: cyl(0.09, 0.1, 1.8, 8), color: 0x22262b, pos: [0.2, 0.62, 0.72], rot: [Math.PI / 2 - 0.55, 0, 0] },
        { geo: box(0.5, 0.3, 0.5), color: metal, pos: [0, 0.28, -0.3] },
        { geo: box(0.7, 0.12, 0.7), color: light, pos: [0, 0.64, -0.25] },
      ];
      aimParts.push(...barrelParts);
      muzzle = [0, 1.25, 1.5];
      if (level >= 2) {
        aimParts.push(
          { geo: cyl(0.07, 0.08, 1.5, 8), color: 0x2f353b, pos: [-0.38, 0.55, 0.6], rot: [Math.PI / 2 - 0.55, 0, 0] },
          { geo: cyl(0.07, 0.08, 1.5, 8), color: 0x2f353b, pos: [0.38, 0.55, 0.6], rot: [Math.PI / 2 - 0.55, 0, 0] },
        );
        parts.push({ geo: box(0.28, 0.6, 0.9), color: light, pos: [-0.85, 0.9, 0] });
      }
      if (level >= 3) {
        parts.push(
          { geo: cyl(0.5, 0.6, 0.18, 12), color: 0x596069, pos: [0.75, 1.35, -0.4] },
          { geo: cyl(0.05, 0.05, 0.9, 5), color: 0x8d97a4, pos: [0.75, 1.8, -0.4] },
        );
        aimParts.push({ geo: box(0.85, 0.2, 0.35), color: 0x2f353b, pos: [0, 0.4, 0.35] });
      }
    } else if (type === 'morteiro') {
      parts.push(
        { geo: box(1.8, 0.5, 1.8), color: dark, pos: [0, 0.25, 0] },
        { geo: box(2.0, 0.16, 2.0), color: metal, pos: [0, 0.5, 0] },
      );
      for (let i = 0; i < 6; i += 1) {
        parts.push({
          geo: box(0.9, 0.4, 0.55),
          color: 0x7c6b4c,
          pos: [Math.cos((i / 6) * PI2) * 1.1, 0.72, Math.sin((i / 6) * PI2) * 1.1],
          rot: [0, -(i / 6) * PI2, 0],
        });
      }
      aimParts.push(
        { geo: cyl(0.75, 0.9, 0.34, 10), color: metal },
        { geo: box(0.5, 0.5, 0.5), color: dark, pos: [0, 0.3, -0.3] },
        { geo: cyl(0.22, 0.28, 1.7, 10), color: 0x2b3036, pos: [0, 0.62, 0.55], rot: [0.6, 0, 0] },
        { geo: cyl(0.3, 0.3, 0.3, 10), color: 0x22262b, pos: [0, 1.02, 0.95], rot: [0.6, 0, 0] },
        { geo: box(0.12, 0.9, 0.12), color: 0x3a4048, pos: [-0.5, 0.55, 0.2], rot: [-0.5, 0, 0] },
      );
      muzzle = [0, 1.2, 1.1];
      if (level >= 2) {
        aimParts.push(
          { geo: cyl(0.1, 0.12, 1.0, 8), color: 0x2f353b, pos: [-0.32, 0.55, 0.45], rot: [0.6, 0, 0] },
          { geo: box(0.7, 0.16, 0.7), color: light, pos: [0, 0.34, 0.25] },
        );
      }
      if (level >= 3) {
        parts.push({ geo: box(2.3, 0.3, 2.3), color: 0x3a4048, pos: [0, 0.62, 0] });
        aimParts.push(
          { geo: cyl(0.05, 0.06, 0.8, 8), color: 0x2f353b, pos: [0.3, 0.7, 0.55], rot: [0.6, 0, 0] },
          { geo: box(0.4, 0.24, 0.5), color: 0x596069, pos: [0, 0.34, -0.42] },
        );
      }
    } else if (type === 'tesla') {
      parts.push(
        { geo: cyl(1.0, 1.3, 0.5, 10), color: dark, pos: [0, 0.25, 0] },
        { geo: cyl(0.5, 0.65, 0.8, 8), color: metal, pos: [0, 0.9, 0] },
        { geo: cyl(0.4, 0.4, 0.25, 10), color: light, pos: [0, 1.35, 0] },
      );
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * PI2;
        parts.push({ geo: box(0.14, 0.8, 0.14), color: dark, pos: [Math.cos(a) * 0.8, 0.6, Math.sin(a) * 0.8] });
      }
      aimParts.push(
        { geo: cyl(0.22, 0.3, 1.1, 8), color: 0x3a4048, pos: [0, 0.55, 0] },
        { geo: torus(0.34, 0.055, 6, 16), color: 0xc98a3a, pos: [0, 0.45, 0], rot: [Math.PI / 2, 0, 0] },
        { geo: torus(0.34, 0.055, 6, 16), color: 0xc98a3a, pos: [0, 0.8, 0], rot: [Math.PI / 2, 0, 0] },
        { geo: torus(0.3, 0.05, 6, 16), color: 0xc98a3a, pos: [0, 1.12, 0], rot: [Math.PI / 2, 0, 0] },
        { geo: sph(0.36, 12), color: 0x9fdcff, pos: [0, 1.4, 0] },
        { geo: cone(0.1, 0.45, 6), color: 0xd8f4ff, pos: [0, 1.72, 0] },
      );
      muzzle = [0, 1.5, 0];
      if (level >= 2) {
        aimParts.push(
          { geo: torus(0.4, 0.05, 6, 16), color: 0xc98a3a, pos: [0, 0.28, 0], rot: [Math.PI / 2, 0, 0] },
          { geo: sph(0.12, 8), color: 0x9fdcff, pos: [0, 1.15, 0] },
        );
      }
      if (level >= 3) {
        aimParts.push(
          { geo: sph(0.46, 12), color: 0x7fd4ff, pos: [0, 1.4, 0], scale: [1.1, 1.1, 1.1] },
          { geo: cone(0.08, 0.5, 6), color: 0xd8f4ff, pos: [0, 1.9, 0] },
          { geo: torus(0.48, 0.04, 6, 16), color: 0xc98a3a, pos: [0, 1.32, 0], rot: [Math.PI / 2, 0, 0] },
        );
      }
    } else if (type === 'criogenica') {
      parts.push(
        { geo: cyl(1.0, 1.25, 0.5, 10), color: dark, pos: [0, 0.25, 0] },
        { geo: cyl(0.7, 0.8, 1.3, 10), color: 0x6f8fa0, pos: [0, 1.2, 0] },
        { geo: torus(0.72, 0.09, 6, 18), color: 0x9fc8d8, pos: [0, 1.85, 0], rot: [Math.PI / 2, 0, 0] },
        { geo: cyl(0.12, 0.12, 1.5, 8), color: 0x4a5a66, pos: [-0.95, 1.0, 0.2], rot: [0, 0, 0.15] },
        { geo: cyl(0.12, 0.12, 1.5, 8), color: 0x4a5a66, pos: [0.95, 1.0, 0.2], rot: [0, 0, -0.15] },
      );
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * PI2 + 0.4;
        parts.push({ geo: box(0.18, 1.0, 0.18), color: 0x3a4750, pos: [Math.cos(a) * 0.95, 0.75, Math.sin(a) * 0.95] });
      }
      aimParts.push(
        { geo: cyl(0.55, 0.6, 0.3, 10), color: 0x4a5a66, pos: [0, 0.15, 0] },
        { geo: cone(0.42, 1.1, 6), color: 0x9fe8ff, pos: [0, 0.75, 0] },
        { geo: cone(0.3, 0.8, 6), color: 0xd8f6ff, pos: [0, 1.3, 0] },
        { geo: torus(0.34, 0.05, 6, 14), color: 0x7fd4e8, pos: [0, 0.45, 0], rot: [Math.PI / 2, 0, 0] },
      );
      muzzle = [0, 1.5, 0];
      if (level >= 2) {
        aimParts.push(
          { geo: cone(0.22, 0.6, 6), color: 0xbff0ff, pos: [-0.35, 0.6, 0.1], rot: [0, 0, 0.3] },
          { geo: cone(0.22, 0.6, 6), color: 0xbff0ff, pos: [0.35, 0.6, 0.1], rot: [0, 0, -0.3] },
        );
      }
      if (level >= 3) {
        parts.push({ geo: cyl(1.1, 1.3, 0.3, 10), color: 0x3a4750, pos: [0, 0.62, 0] });
        aimParts.push(
          { geo: cone(0.5, 1.3, 6), color: 0x8fdcff, pos: [0, 0.9, 0] },
          { geo: torus(0.46, 0.05, 6, 16), color: 0x9fe8ff, pos: [0, 0.9, 0], rot: [Math.PI / 2, 0, 0] },
        );
      }
    } else if (type === 'missil') {
      parts.push(
        { geo: box(1.9, 0.6, 1.9), color: dark, pos: [0, 0.3, 0] },
        { geo: box(1.6, 0.3, 1.6), color: metal, pos: [0, 0.72, 0] },
      );
      for (let i = 0; i < 4; i += 1) {
        const a = (i / 4) * PI2;
        parts.push({ geo: box(0.2, 0.6, 0.2), color: dark, pos: [Math.cos(a) * 0.9, 0.35, Math.sin(a) * 0.9] });
      }
      aimParts.push(
        { geo: box(1.3, 0.9, 1.5), color: metal, pos: [0, 0.55, 0] },
        { geo: box(1.1, 0.6, 0.12), color: 0x3a4048, pos: [0, 0.55, 0.78] },
        { geo: cyl(0.14, 0.14, 1.3, 8), color: 0x22262b, pos: [-0.3, 0.85, 0.2], rot: [Math.PI / 2, 0, 0] },
        { geo: cyl(0.14, 0.14, 1.3, 8), color: 0x22262b, pos: [0.3, 0.85, 0.2], rot: [Math.PI / 2, 0, 0] },
        { geo: cyl(0.14, 0.14, 1.3, 8), color: 0x22262b, pos: [-0.3, 0.4, 0.2], rot: [Math.PI / 2, 0, 0] },
        { geo: cyl(0.14, 0.14, 1.3, 8), color: 0x22262b, pos: [0.3, 0.4, 0.2], rot: [Math.PI / 2, 0, 0] },
        { geo: cyl(0.32, 0.38, 0.12, 10), color: 0x596069, pos: [0.55, 0.95, -0.1], rot: [0.4, 0, 0] },
      );
      muzzle = [0, 0.7, 1.0];
      if (level >= 2) {
        aimParts.push(
          { geo: box(1.4, 0.1, 0.4), color: 0x3a4048, pos: [0, 1.05, 0.1] },
          { geo: cyl(0.12, 0.12, 1.2, 8), color: 0x2f353b, pos: [-0.15, 1.15, 0.2], rot: [Math.PI / 2, 0, 0] },
          { geo: cyl(0.12, 0.12, 1.2, 8), color: 0x2f353b, pos: [0.15, 1.15, 0.2], rot: [Math.PI / 2, 0, 0] },
        );
      }
      if (level >= 3) {
        parts.push({ geo: box(2.2, 0.24, 2.2), color: 0x3a4048, pos: [0, 0.55, 0] });
        aimParts.push(
          { geo: box(1.0, 0.2, 0.5), color: light, pos: [0, 1.3, -0.2] },
          { geo: cyl(0.3, 0.34, 0.1, 10), color: 0x596069, pos: [-0.6, 1.2, 0.1], rot: [0.4, 0, 0] },
        );
      }
    } else {
      // torre genérica
      parts.push({ geo: box(1.4, 1.6, 1.4), color: dark, pos: [0, 0.8, 0] });
      aimParts.push({ geo: box(0.8, 0.5, 1.4), color: metal, pos: [0, 0.3, 0.2] });
      muzzle = [0, 0.4, 1.0];
    }

    const bodyMat = vertexMaterial();
    const body = new THREE.Mesh(mergeParts(parts), bodyMat);
    body.name = 'towerBody';
    group.add(body);

    const aim = new THREE.Group();
    aim.name = 'aim';
    aim.position.set(0, type === 'metralhadora' ? 1.7 : type === 'antiaereo' ? 1.0 : type === 'morteiro' ? 1.1 : type === 'tesla' ? 1.3 : type === 'criogenica' ? 1.9 : 1.05, 0);
    const aimMat = vertexMaterial();
    const aimMesh = new THREE.Mesh(mergeParts(aimParts), aimMat);
    aimMesh.name = 'aimMesh';
    aim.add(aimMesh);
    const muzzleObj = new THREE.Object3D();
    muzzleObj.name = 'muzzle';
    muzzleObj.position.set(muzzle[0], muzzle[1], muzzle[2]);
    aim.add(muzzleObj);
    group.add(aim);

    const s = 1 + (level - 1) * 0.13;
    group.scale.setScalar(s);
    return { group, level };
  }

  function tower(type, level) {
    const key = 't:' + type + ':' + level;
    let tpl = templates.get(key);
    if (!tpl) {
      tpl = buildTowerTemplate(type, level);
      trackTemplate(tpl.group);
      templates.set(key, tpl);
    }
    const group = tpl.group.clone(true);
    const aim = group.getObjectByName('aim');
    const muzzle = group.getObjectByName('muzzle');
    return { group, aim, muzzle, level };
  }

  // ------------------------------------------------------------------ tropas
  function buildTroopTemplate(type) {
    const group = new THREE.Group();
    group.name = 'troop:' + type;
    const parts = [];
    if (type === 'fuzileiros') {
      for (let i = 0; i < 5; i += 1) {
        parts.push({
          geo: box(0.85, 0.36, 0.42),
          color: 0x8a7a58,
          pos: [-1.1 + i * 0.55, 0.2 + (i % 2) * 0.18, 0.55 - (i % 3) * 0.12],
          rot: [0, 0.12 * (i - 2), 0],
        });
      }
      for (let i = 0; i < 2; i += 1) {
        const x = i === 0 ? -0.4 : 0.45;
        parts.push(
          { geo: box(0.32, 0.5, 0.26), color: 0x5d5a3e, pos: [x, 0.75, -0.1] },
          { geo: sph(0.14, 8), color: 0xc79b74, pos: [x, 1.12, -0.1] },
          { geo: hemi(0.17, 8), color: 0x4c4f3a, pos: [x, 1.16, -0.1] },
          { geo: box(0.06, 0.07, 0.55), color: 0x22221d, pos: [x + 0.18, 0.82, 0.18] },
        );
      }
      parts.push({ geo: cyl(0.03, 0.03, 1.2, 5), color: 0x8d97a4, pos: [1.2, 0.8, -0.4] });
      parts.push({ geo: box(0.4, 0.26, 0.02), color: 0x2f6f4f, pos: [1.38, 1.25, -0.4] });
    } else if (type === 'antiaerea') {
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * PI2;
        parts.push({
          geo: box(0.12, 0.85, 0.12),
          color: 0x3a4048,
          pos: [Math.cos(a) * 0.4, 0.42, Math.sin(a) * 0.4],
          rot: [Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35],
        });
      }
      parts.push(
        { geo: cyl(0.5, 0.6, 0.16, 10), color: 0x4a5058, pos: [0, 0.82, 0] },
        { geo: cyl(0.18, 0.22, 1.7, 8), color: 0x2b3036, pos: [0, 1.35, 0.42], rot: [0.5, 0, 0] },
        { geo: cone(0.14, 0.35, 8), color: 0xff6633, pos: [0, 1.75, 0.82], rot: [0.5, 0, 0] },
        { geo: box(0.3, 0.5, 0.26), color: 0x4c5639, pos: [-0.55, 1.0, -0.25] },
        { geo: sph(0.13, 8), color: 0xc79b74, pos: [-0.55, 1.35, -0.25] },
        { geo: hemi(0.16, 8), color: 0x4c4f3a, pos: [-0.55, 1.38, -0.25] },
      );
    } else if (type === 'sniper') {
      parts.push(
        { geo: box(0.42, 0.26, 1.5), color: 0x4c5639, pos: [0, 0.28, -0.1] },
        { geo: sph(0.16, 8), color: 0xc79b74, pos: [0, 0.42, 0.7] },
        { geo: hemi(0.19, 8), color: 0x3d4433, pos: [0, 0.46, 0.7] },
        { geo: box(0.16, 0.18, 0.6), color: 0x3d4433, pos: [-0.18, 0.25, -0.75], rot: [0, 0.15, 0] },
        { geo: box(0.16, 0.18, 0.6), color: 0x3d4433, pos: [0.18, 0.25, -0.75], rot: [0, -0.15, 0] },
        { geo: cyl(0.045, 0.05, 1.9, 6), color: 0x22221d, pos: [0.08, 0.38, 0.55], rot: [Math.PI / 2, 0, 0] },
        { geo: box(0.12, 0.12, 0.42), color: 0x2b3036, pos: [0.08, 0.5, 0.42] },
        { geo: box(0.04, 0.06, 0.6), color: 0x22221d, pos: [0.08, 0.62, 0.35] },
        { geo: box(0.06, 0.3, 0.06), color: 0x2b3036, pos: [-0.12, 0.18, 1.05], rot: [0.4, 0, 0] },
        { geo: box(0.06, 0.3, 0.06), color: 0x2b3036, pos: [0.12, 0.18, 1.05], rot: [0.4, 0, 0] },
      );
    } else {
      parts.push(
        { geo: box(0.5, 0.9, 0.4), color: 0x4c5639, pos: [0, 0.45, 0] },
        { geo: sph(0.16, 8), color: 0xc79b74, pos: [0, 1.05, 0] },
      );
    }
    const mat = vertexMaterial();
    const mesh = new THREE.Mesh(mergeParts(parts), mat);
    mesh.name = 'troopBody';
    group.add(mesh);
    return { group };
  }

  function troop(type) {
    const key = 'p:' + type;
    let tpl = templates.get(key);
    if (!tpl) {
      tpl = buildTroopTemplate(type);
      trackTemplate(tpl.group);
      templates.set(key, tpl);
    }
    return { group: tpl.group.clone(true) };
  }

  // -------------------------------------------------------------- projéteis
  function buildProjectileTemplate() {
    const group = new THREE.Group();
    group.name = 'missile';
    const parts = [
      { geo: cyl(0.09, 0.09, 0.7, 8), color: 0xb9c2cc, pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0] },
      { geo: cone(0.1, 0.28, 8), color: 0xff6633, pos: [0, 0, 0.45], rot: [Math.PI / 2, 0, 0] },
      { geo: box(0.02, 0.28, 0.2), color: 0x8a939c, pos: [0, 0, -0.3] },
      { geo: box(0.28, 0.02, 0.2), color: 0x8a939c, pos: [0, 0, -0.3] },
      { geo: sph(0.08, 8), color: 0xffcc66, pos: [0, 0, -0.38] },
    ];
    const mat = vertexMaterial();
    const mesh = new THREE.Mesh(mergeParts(parts), mat);
    mesh.name = 'missileBody';
    group.add(mesh);
    return { group };
  }

  function projectile() {
    let tpl = templates.get('proj');
    if (!tpl) {
      tpl = buildProjectileTemplate();
      trackTemplate(tpl.group);
      templates.set('proj', tpl);
    }
    return { group: tpl.group.clone(true) };
  }

  function dispose() {
    owned.forEach((x) => x.dispose());
    owned.length = 0;
    bodyMats.forEach((m) => m.dispose());
    bodyMats.length = 0;
    templates.clear();
  }

  return { enemy, tower, troop, projectile, dispose };
}
