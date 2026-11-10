// scene.js — cena Three.js do Torre de Ferro (render puro, sem HUD/áudio).
// API pública FIXA (CONTRACT.md): createScene({canvas,onPick,onHover}) ->
// { renderer, scene, camera, setMap, update, pickSlot, pickTroopPoint, project,
//   highlightSlot, highlightPoint, shake, resize, render, perf, dispose }.
//
// Regras: só consome `src/sim/data.js` e `src/sim/maps.js` (dados); não lê save,
// não conhece DOM de HUD, não faz request externo (Three.js vendorizado).
// Tudo procedural; sombras "baratas" = manchas (blobs) instanciadas, sem shadow map.

import * as THREE from '../vendor/three/three.module.js';
import { MAPS } from '../sim/maps.js';
import { ENEMIES } from '../sim/data.js';
import {
  MAX_SLOTS,
  MAX_TROOP_POINTS,
  MAX_PROJECTILES,
  makeRng,
  resolveTheme,
  buildSky,
  buildTerrain,
  buildPath,
  buildSpawn,
  buildBase,
  buildWeather,
  createSlotMarkers,
  createTroopPointMarkers,
  createHighlightRing,
  createBlobShadows,
  createEffects,
  createModelFactory,
  disposeObject3D,
} from './meshes.js';

const MAX_ENEMIES_VISIBLE = 40; // limite da especificação
const COLOR_SLOW = new THREE.Color(0.55, 0.8, 1.3);
const COLOR_WHITE = new THREE.Color(1, 1, 1);
const TOWER_FLASH_COLORS = {
  metralhadora: 0xffd27f,
  antiaereo: 0xbfe6ff,
  morteiro: 0xff9d5a,
  tesla: 0x9fdcff,
  criogenica: 0x8fe8ff,
  missil: 0xffb36b,
};
const ENEMY_FLASH_COLORS = {
  'chefe-deserto': 0xff5a22,
  'chefe-neve': 0x66c8ff,
  'chefe-cidade': 0xff3fd0,
};

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function hashId(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function normalizeMapDef(mapDef) {
  const input = mapDef && typeof mapDef === 'object' ? mapDef : {};
  const id = input.id || input.mapId || 'deserto';
  const fromMaps = MAPS[id] || MAPS.deserto;
  const wps = input.waypoints && input.waypoints.length >= 2
    ? input.waypoints
    : fromMaps.waypoints;
  const slots = input.slots && input.slots.length
    ? input.slots
    : fromMaps.slots;
  const points = input.troopPoints && input.troopPoints.length
    ? input.troopPoints
    : (fromMaps.troopPoints || []);
  return {
    id,
    name: input.name || fromMaps.name || id,
    fog: input.fog || fromMaps.fog || id,
    length: input.length || fromMaps.length || 0,
    waypoints: wps.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.z])),
    slots: slots.map((s, idx) => ({
      i: s.i !== undefined ? s.i : (s.index !== undefined ? s.index : idx),
      x: s.x,
      z: s.z,
    })),
    troopPoints: points.map((p, idx) => ({
      j: p.j !== undefined ? p.j : (p.index !== undefined ? p.index : idx),
      x: p.x,
      z: p.z,
    })),
  };
}

export function createScene({ canvas, onPick, onHover } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('createScene: canvas WebGL é obrigatório');
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x0b0e14, 1);
  renderer.shadowMap.enabled = false; // sombras reais desligadas: blobs instanciados abaixo
  renderer.info.autoReset = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 520);
  camera.position.set(0, 60, 80);
  camera.lookAt(0, 0, 0);

  const world = new THREE.Group();
  world.name = 'world';
  scene.add(world);

  const entities = new THREE.Group();
  entities.name = 'entities';
  scene.add(entities);

  // ------------------------------------------------------------ luzes
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  hemi.position.set(0, 80, 0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(40, 70, 20);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);
  // luz de preenchimento (fria, do lado oposto): dá volume sem shadow map
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(-40, 30, -30);
  fill.target.position.set(0, 0, 0);
  scene.add(fill);
  scene.add(fill.target);
  const bossLight = new THREE.PointLight(0xff5522, 0, 34, 2);
  bossLight.position.set(0, 6, 0);
  bossLight.visible = false;
  scene.add(bossLight);

  // ------------------------------------------------------------ estado interno
  const view = {
    target: new THREE.Vector3(0, 0, 0),
    yaw: -0.6,
    polar: 0.92,
    distance: 80,
    minDistance: 18,
    maxDistance: 145,
    minPolar: 0.22,
    maxPolar: 1.32,
  };
  let time = 0;
  let shakeAmp = 0;
  let baseFlash = 0;
  let currentMapId = null;
  let currentMap = null;
  let theme = resolveTheme(null);
  let mapGroup = null;
  let spawnGroup = null;
  let baseGroup = null;
  let weather = null;

  const slotPickList = [];
  const pointPickList = [];
  let slotColorSignature = '';
  let pointColorSignature = '';
  let selectedSlot = null;
  let selectedPoint = null;
  let hoverPick = { slot: null, point: null };

  const enemyState = new Map();
  const towerState = new Map();
  const troopState = new Map();
  const projectileState = new Map();
  const enemyPool = new Map();
  const towerPool = new Map();
  const troopPool = new Map();
  const projectilePool = [];
  const variants = new Map();
  const particlePhase = new Map();

  const modelFactory = createModelFactory();
  const effects = createEffects();
  scene.add(effects.group);

  const slotMarkers = createSlotMarkers(MAX_SLOTS);
  scene.add(slotMarkers);
  const pointMarkers = createTroopPointMarkers(MAX_TROOP_POINTS);
  scene.add(pointMarkers);
  const slotHighlight = createHighlightRing(2.7, 0xffc75a, 0.95);
  scene.add(slotHighlight);
  const pointHighlight = createHighlightRing(2.1, 0x7fe6ff, 0.95);
  scene.add(pointHighlight);
  const hoverRing = createHighlightRing(2.35, 0xffffff, 0.55);
  scene.add(hoverRing);
  const blobShadows = createBlobShadows(MAX_ENEMIES_VISIBLE + 8);
  scene.add(blobShadows);

  // ------------------------------------------------------------ câmera/controles
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _v3b = new THREE.Vector3();
  const _dummy = new THREE.Object3D();
  const _color = new THREE.Color();

  const controls = {
    pointerId: null,
    button: 0,
    dragging: false,
    downX: 0,
    downY: 0,
    lastX: 0,
    lastY: 0,
    moved: 0,
  };
  let lastPickAt = 0;
  let disposed = false;

  function canvasSize() {
    let w = canvas.clientWidth || 0;
    let h = canvas.clientHeight || 0;
    if (w < 2 || h < 2) {
      const parent = canvas.parentElement;
      if (parent) {
        w = parent.clientWidth;
        h = parent.clientHeight;
      }
    }
    if (w < 2 || h < 2) {
      w = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      h = (typeof window !== 'undefined' && window.innerHeight) || 800;
    }
    return { w: Math.max(2, Math.floor(w)), h: Math.max(2, Math.floor(h)) };
  }

  function resize() {
    const { w, h } = canvasSize();
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function clampTarget() {
    view.target.x = clamp(view.target.x, -70, 70);
    view.target.z = clamp(view.target.z, -46, 46);
    view.target.y = 0;
  }

  function applyCamera() {
    const sinP = Math.sin(view.polar);
    camera.position.set(
      view.target.x + sinP * Math.sin(view.yaw) * view.distance,
      view.target.y + Math.cos(view.polar) * view.distance,
      view.target.z + sinP * Math.cos(view.yaw) * view.distance,
    );
    let lx = view.target.x;
    let ly = view.target.y;
    let lz = view.target.z;
    if (shakeAmp > 0.0001) {
      const t = time * 61;
      const ox = Math.sin(t * 1.7 + 1.3) * shakeAmp;
      const oy = Math.cos(t * 2.3 + 0.4) * shakeAmp * 0.5;
      const oz = Math.sin(t * 1.1 + 2.1) * shakeAmp;
      camera.position.x += ox;
      camera.position.y += oy;
      camera.position.z += oz;
      lx += ox * 0.35;
      ly += oy * 0.35;
      lz += oz * 0.35;
    }
    camera.lookAt(lx, ly, lz);
  }

  function frameMap(def) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of def.waypoints) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
    if (!Number.isFinite(minX)) {
      minX = -40; maxX = 40; minZ = -20; maxZ = 20;
    }
    view.target.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    view.yaw = -0.6;
    view.polar = 0.92;
    // folga extra para enquadrar spawn e base inteiros (e aéreos no centro)
    const halfW = (maxX - minX) / 2 + 11;
    const halfD = (maxZ - minZ) / 2 + 11;
    const vHalf = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const hHalf = Math.atan(Math.tan(vHalf) * Math.max(0.4, camera.aspect));
    const distW = halfW / Math.tan(hHalf);
    const distD = halfD / Math.tan(vHalf) * 1.35;
    view.distance = clamp(Math.max(distW, distD) * 1.12, 48, 140);
    clampTarget();
    applyCamera();
  }

  function panByPixels(dx, dy) {
    camera.getWorldDirection(_v3);
    _v3.y = 0;
    if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, -1);
    _v3.normalize();
    // direita da câmera no plano do chão = forward × up
    const rx = -_v3.z;
    const rz = _v3.x;
    const scale = view.distance * 0.00165;
    view.target.x += (-dx * rx - dy * _v3.x) * scale;
    view.target.z += (-dx * rz - dy * _v3.z) * scale;
    clampTarget();
    applyCamera();
  }

  function onPointerDown(ev) {
    if (ev.button !== 0 && ev.button !== 2) return;
    controls.pointerId = ev.pointerId;
    controls.button = ev.button;
    controls.dragging = true;
    controls.moved = 0;
    controls.downX = ev.clientX;
    controls.downY = ev.clientY;
    controls.lastX = ev.clientX;
    controls.lastY = ev.clientY;
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch (err) {
      /* captura opcional */
    }
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!controls.dragging || ev.pointerId !== controls.pointerId) {
      if (!controls.dragging) updateHover(ev.clientX, ev.clientY);
      return;
    }
    const dx = ev.clientX - controls.lastX;
    const dy = ev.clientY - controls.lastY;
    controls.lastX = ev.clientX;
    controls.lastY = ev.clientY;
    const dist = Math.hypot(ev.clientX - controls.downX, ev.clientY - controls.downY);
    if (dist > controls.moved) controls.moved = dist;
    if (controls.button === 0) {
      view.yaw -= dx * 0.006;
      view.polar = clamp(view.polar - dy * 0.005, view.minPolar, view.maxPolar);
    } else {
      panByPixels(dx, dy);
    }
    applyCamera();
    if (dist >= 5) {
      hoverPick = { slot: null, point: null };
      hoverRing.visible = false;
      canvas.style.cursor = '';
    }
  }

  function finishPointer(ev, cancelled) {
    if (controls.pointerId === null || ev.pointerId !== controls.pointerId) return;
    const wasClick = !cancelled && controls.button === 0 && controls.moved < 5;
    controls.dragging = false;
    controls.pointerId = null;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch (err) {
      /* opcional */
    }
    if (wasClick) {
      const slot = pickSlot(ev.clientX, ev.clientY);
      const point = pickTroopPoint(ev.clientX, ev.clientY);
      lastPickAt = now();
      if (typeof onPick === 'function') onPick({ slot, point });
    } else {
      updateHover(ev.clientX, ev.clientY);
    }
  }

  function onPointerUp(ev) {
    finishPointer(ev, false);
  }

  function onPointerCancel(ev) {
    finishPointer(ev, true);
  }

  function onPointerLeave(ev) {
    if (controls.dragging) return;
    if (hoverPick.slot !== null || hoverPick.point !== null) {
      hoverPick = { slot: null, point: null };
      hoverRing.visible = false;
      canvas.style.cursor = '';
      if (typeof onHover === 'function') onHover({ slot: null, point: null });
    }
  }

  function onClick(ev) {
    if (now() - lastPickAt < 320) return; // clique já tratado por pointerup
    const slot = pickSlot(ev.clientX, ev.clientY);
    const point = pickTroopPoint(ev.clientX, ev.clientY);
    lastPickAt = now();
    if (typeof onPick === 'function') onPick({ slot, point });
  }

  function onWheel(ev) {
    ev.preventDefault();
    view.distance = clamp(view.distance * Math.exp((ev.deltaY || 0) * 0.0012), view.minDistance, view.maxDistance);
    applyCamera();
  }

  function onContextMenu(ev) {
    ev.preventDefault();
  }

  function onKeyNothing() {}

  // ------------------------------------------------------------ picking
  function rayToGround(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    hitPoint.set(0, 0, 0);
    if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return null;
    return hitPoint;
  }

  function pickSlot(clientX, clientY) {
    const hit = rayToGround(clientX, clientY);
    if (!hit) return null;
    let best = null;
    let bestDist = 3.1;
    for (let i = 0; i < slotPickList.length; i += 1) {
      const s = slotPickList[i];
      const d = Math.hypot(hit.x - s.x, hit.z - s.z);
      if (d < bestDist) {
        bestDist = d;
        best = s.i;
      }
    }
    return best;
  }

  function pickTroopPoint(clientX, clientY) {
    const hit = rayToGround(clientX, clientY);
    if (!hit) return null;
    let best = null;
    let bestDist = 2.3;
    for (let i = 0; i < pointPickList.length; i += 1) {
      const p = pointPickList[i];
      const d = Math.hypot(hit.x - p.x, hit.z - p.z);
      if (d < bestDist) {
        bestDist = d;
        best = p.j;
      }
    }
    return best;
  }

  function project(x, y, z) {
    _v3.set(x, y, z).project(camera);
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.clientWidth || 1;
    const height = rect.height || canvas.clientHeight || 1;
    const visible = _v3.z > -1 && _v3.z < 1
      && _v3.x >= -1.02 && _v3.x <= 1.02
      && _v3.y >= -1.02 && _v3.y <= 1.02;
    return {
      x: (_v3.x * 0.5 + 0.5) * width,
      y: (-_v3.y * 0.5 + 0.5) * height,
      visible,
    };
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function updateHover(clientX, clientY) {
    const slot = pickSlot(clientX, clientY);
    const point = slot === null ? pickTroopPoint(clientX, clientY) : null;
    if (slot === hoverPick.slot && point === hoverPick.point) return;
    hoverPick = { slot, point };
    if (slot !== null) {
      let found = null;
      for (const s of slotPickList) if (s.i === slot) { found = s; break; }
      if (found) {
        hoverRing.visible = true;
        hoverRing.position.set(found.x, 0.16, found.z);
        hoverRing.material.color.set(theme.accent);
        hoverRing.scale.setScalar(1);
      }
      canvas.style.cursor = 'pointer';
    } else if (point !== null) {
      let found = null;
      for (const p of pointPickList) if (p.j === point) { found = p; break; }
      if (found) {
        hoverRing.visible = true;
        hoverRing.position.set(found.x, 0.16, found.z);
        hoverRing.material.color.set(theme.accent2);
        hoverRing.scale.setScalar(0.8);
      }
      canvas.style.cursor = 'pointer';
    } else {
      hoverRing.visible = false;
      canvas.style.cursor = '';
    }
    if (typeof onHover === 'function') onHover({ slot, point });
  }

  // ------------------------------------------------------------ API: highlights
  function highlightSlot(index) {
    if (index === null || index === undefined) {
      selectedSlot = null;
      slotHighlight.visible = false;
      return;
    }
    const idx = Number(index);
    let found = null;
    for (const s of slotPickList) if (s.i === idx) { found = s; break; }
    if (!found) {
      selectedSlot = null;
      slotHighlight.visible = false;
      return;
    }
    selectedSlot = idx;
    slotHighlight.visible = true;
    slotHighlight.position.set(found.x, 0.17, found.z);
    slotHighlight.material.color.set(theme.accent);
  }

  function highlightPoint(index) {
    if (index === null || index === undefined) {
      selectedPoint = null;
      pointHighlight.visible = false;
      return;
    }
    const idx = Number(index);
    let found = null;
    for (const p of pointPickList) if (p.j === idx) { found = p; break; }
    if (!found) {
      selectedPoint = null;
      pointHighlight.visible = false;
      return;
    }
    selectedPoint = idx;
    pointHighlight.visible = true;
    pointHighlight.position.set(found.x, 0.17, found.z);
    pointHighlight.material.color.set(theme.accent2);
  }

  function shake(level) {
    const amp = level === 'large' ? 0.6 : level === 'medium' ? 0.35 : 0.15;
    shakeAmp = Math.max(shakeAmp, amp);
  }

  // ------------------------------------------------------------ setMap
  function writeInstanceMatrix(mesh, index, x, y, z, scaleX, scaleZ) {
    _dummy.position.set(x, y, z);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.set(scaleX === undefined ? 1 : scaleX, 1, scaleZ === undefined ? 1 : scaleZ);
    _dummy.updateMatrix();
    mesh.setMatrixAt(index, _dummy.matrix);
  }

  function clearEntities() {
    for (const [id, rec] of enemyState) {
      rec.group.visible = false;
      enemyState.delete(id);
      pushPool(enemyPool, rec.type, rec);
    }
    for (const [id, rec] of towerState) {
      rec.group.visible = false;
      towerState.delete(id);
      pushPool(towerPool, rec.type + ':' + rec.level, rec);
    }
    for (const [id, rec] of troopState) {
      rec.group.visible = false;
      troopState.delete(id);
      pushPool(troopPool, rec.type, rec);
    }
    for (const [id, rec] of projectileState) {
      rec.group.visible = false;
      projectileState.delete(id);
      projectilePool.push(rec);
    }
    variants.clear();
    effects.update(0.016);
    blobShadows.count = 0;
  }

  function pushPool(pool, key, rec) {
    let arr = pool.get(key);
    if (!arr) {
      arr = [];
      pool.set(key, arr);
    }
    if (arr.length < 16) arr.push(rec);
  }

  function setMap(mapDef) {
    const def = normalizeMapDef(mapDef);
    if (mapGroup) {
      disposeObject3D(mapGroup);
      mapGroup = null;
    }
    weather = null;
    spawnGroup = null;
    baseGroup = null;
    clearEntities();

    currentMap = def;
    currentMapId = def.id;
    theme = resolveTheme(def);

    scene.background = new THREE.Color(theme.skyHorizon);
    scene.fog = new THREE.Fog(theme.fogColor, theme.fogNear, theme.fogFar);
    hemi.color.set(theme.hemiSky);
    hemi.groundColor.set(theme.hemiGround);
    hemi.intensity = theme.hemiIntensity;
    sun.color.set(theme.sunColor);
    sun.intensity = theme.sunIntensity;
    sun.position.set(theme.sunPos[0], theme.sunPos[1], theme.sunPos[2]);
    fill.color.set(theme.fillColor || 0xffffff);
    fill.intensity = theme.fillIntensity === undefined ? 0.3 : theme.fillIntensity;
    const fp = theme.fillPos || [-40, 30, -30];
    fill.position.set(fp[0], fp[1], fp[2]);

    resize();

    const rng = makeRng(1337 + def.id.length * 7919 + def.waypoints.length * 101);
    mapGroup = new THREE.Group();
    mapGroup.name = 'map:' + def.id;
    world.add(mapGroup);

    mapGroup.add(buildSky(theme));
    mapGroup.add(buildTerrain(theme, rng));
    mapGroup.add(buildPath(def, theme));

    const wps = def.waypoints;
    const first = wps[0];
    const last = wps[wps.length - 1];
    spawnGroup = buildSpawn(theme);
    spawnGroup.position.set(first[0], 0.02, first[1]);
    const firstDirX = wps.length > 1 ? wps[1][0] - first[0] : 1;
    const firstDirZ = wps.length > 1 ? wps[1][1] - first[1] : 0;
    spawnGroup.rotation.y = Math.atan2(firstDirX, firstDirZ);
    mapGroup.add(spawnGroup);

    baseGroup = buildBase(theme);
    baseGroup.position.set(last[0], 0.02, last[1]);
    mapGroup.add(baseGroup);

    weather = buildWeather(theme);
    mapGroup.add(weather.object);

    // slots e pontos de tropa (posições vêm de maps.js/estado)
    slotPickList.length = 0;
    for (const s of def.slots) slotPickList.push({ i: s.i, x: s.x, z: s.z });
    slotPickList.sort((a, b) => a.i - b.i);
    slotMarkers.count = slotPickList.length;
    slotMarkers.instanceColor.needsUpdate = true;
    for (let i = 0; i < slotPickList.length; i += 1) {
      const s = slotPickList[i];
      writeInstanceMatrix(slotMarkers, i, s.x, 0.13, s.z, 1, 1);
    }
    slotMarkers.instanceMatrix.needsUpdate = true;

    pointPickList.length = 0;
    for (const p of def.troopPoints) pointPickList.push({ j: p.j, x: p.x, z: p.z });
    pointPickList.sort((a, b) => a.j - b.j);
    pointMarkers.count = pointPickList.length;
    pointMarkers.instanceColor.needsUpdate = true;
    for (let i = 0; i < pointPickList.length; i += 1) {
      const p = pointPickList[i];
      writeInstanceMatrix(pointMarkers, i, p.x, 0.13, p.z, 1, 1);
    }
    pointMarkers.instanceMatrix.needsUpdate = true;

    slotColorSignature = '';
    pointColorSignature = '';
    syncSlotColors(null);
    syncPointColors(null);

    selectedSlot = null;
    selectedPoint = null;
    slotHighlight.visible = false;
    pointHighlight.visible = false;
    hoverPick = { slot: null, point: null };
    hoverRing.visible = false;
    canvas.style.cursor = '';

    frameMap(def);
  }

  // ------------------------------------------------------------ cores de marcadores
  function occupiedSlots(state) {
    const set = new Set();
    if (state && Array.isArray(state.towers)) {
      for (const t of state.towers) if (t && Number.isFinite(t.slot)) set.add(t.slot);
    }
    if (state && Array.isArray(state.slots)) {
      for (const s of state.slots) if (s && s.towerId !== null && s.towerId !== undefined) set.add(s.i);
    }
    return set;
  }

  function occupiedPoints(state) {
    const set = new Set();
    if (state && Array.isArray(state.troops)) {
      for (const t of state.troops) if (t && Number.isFinite(t.point)) set.add(t.point);
    }
    if (state && Array.isArray(state.troopPoints)) {
      for (const p of state.troopPoints) if (p && p.troopId !== null && p.troopId !== undefined) set.add(p.j);
    }
    return set;
  }

  function syncSlotColors(state) {
    const occupied = occupiedSlots(state);
    let signature = '';
    for (const s of slotPickList) signature += occupied.has(s.i) ? '1' : '0';
    if (signature === slotColorSignature) return;
    slotColorSignature = signature;
    const free = _color.set(theme.accent);
    const busy = new THREE.Color(0x4b5262);
    for (let i = 0; i < slotPickList.length; i += 1) {
      slotMarkers.setColorAt(i, occupied.has(slotPickList[i].i) ? busy : free);
    }
    if (slotMarkers.instanceColor) slotMarkers.instanceColor.needsUpdate = true;
  }

  function syncPointColors(state) {
    const occupied = occupiedPoints(state);
    let signature = '';
    for (const p of pointPickList) signature += occupied.has(p.j) ? '1' : '0';
    if (signature === pointColorSignature) return;
    pointColorSignature = signature;
    const free = _color.set(theme.accent2);
    const busy = new THREE.Color(0x3f5560);
    for (let i = 0; i < pointPickList.length; i += 1) {
      pointMarkers.setColorAt(i, occupied.has(pointPickList[i].j) ? busy : free);
    }
    if (pointMarkers.instanceColor) pointMarkers.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------ inimigos
  function enemyPhase(id) {
    let p = particlePhase.get(id);
    if (p === undefined) {
      p = hashId(id) * Math.PI * 2;
      particlePhase.set(id, p);
    }
    return p;
  }

  function createEnemyRec(type) {
    const model = modelFactory.enemy(type);
    model.group.visible = false;
    entities.add(model.group);
    return {
      id: null,
      type,
      group: model.group,
      bodyMat: model.bodyMat,
      rotors: model.rotors,
      aura: model.aura,
      radius: model.radius,
      modelScale: model.group.scale.x || 1,
      x: 0,
      z: 0,
      y: 0,
      targetX: 0,
      targetZ: 0,
      targetY: 0,
      rot: 0,
      targetRot: 0,
      spawnT: 0,
      flash: 0,
      slow: 0,
      slowTarget: 0,
      hp: undefined,
      isAir: false,
      tint: new THREE.Color(1, 1, 1),
      auraPulse: 0,
      lean: 0,
      active: false,
    };
  }

  function spawnEnemy(ev) {
    const type = ev.type || 'soldado';
    let rec = null;
    const pool = enemyPool.get(type);
    if (pool && pool.length) rec = pool.pop();
    if (!rec) rec = createEnemyRec(type);
    rec.id = ev.id;
    rec.active = true;
    rec.group.visible = true;
    rec.x = Number.isFinite(ev.x) ? ev.x : 0;
    rec.z = Number.isFinite(ev.z) ? ev.z : 0;
    const def = ENEMIES[type] || {};
    rec.isAir = (ev.cls || def.cls) === 'air';
    rec.y = Number.isFinite(ev.y) ? ev.y : (def.altitude || 0);
    rec.targetX = rec.x;
    rec.targetZ = rec.z;
    rec.targetY = rec.isAir ? rec.y : 0.02;
    rec.rot = 0;
    rec.targetRot = 0;
    rec.spawnT = 0;
    rec.flash = 0;
    rec.slow = 0;
    rec.slowTarget = 0;
    rec.hp = ev.hp;
    rec.auraPulse = 0;
    rec.lean = 0;
    rec.bodyMat.emissive.setRGB(0, 0, 0);
    rec.bodyMat.color.copy(COLOR_WHITE);
    const variant = variants.get(ev.id);
    const tint = 0.9 + (Math.abs(Math.round((Number.isFinite(variant) ? variant : hashId(ev.id)) * 997)) % 19) / 100;
    rec.tint.setRGB(tint, tint * 0.985, tint * 0.955);
    rec.bodyMat.color.copy(rec.tint);
    rec.group.position.set(rec.x, rec.y, rec.z);
    rec.group.rotation.set(0, 0, 0);
    rec.group.scale.setScalar(rec.modelScale);
    enemyState.set(rec.id, rec);
    return rec;
  }

  function deactivateEnemy(rec) {
    rec.active = false;
    rec.group.visible = false;
    enemyState.delete(rec.id);
    variants.delete(rec.id);
    particlePhase.delete('aura' + rec.id);
    particlePhase.delete(rec.id);
    pushPool(enemyPool, rec.type, rec);
  }

  function syncEnemies(state, dt) {
    const list = Array.isArray(state.enemies) ? state.enemies : [];
    const seen = new Set();
    let renderList = list;
    if (list.length > MAX_ENEMIES_VISIBLE) {
      renderList = list.slice().sort((a, b) => (b.progress || 0) - (a.progress || 0)).slice(0, MAX_ENEMIES_VISIBLE);
    }
    for (let i = 0; i < renderList.length; i += 1) {
      const e = renderList[i];
      if (!e || e.id === undefined || e.id === null) continue;
      seen.add(e.id);
      let rec = enemyState.get(e.id);
      if (!rec) rec = spawnEnemy(e);
      const def = ENEMIES[e.type] || {};
      rec.isAir = (e.cls || def.cls || (rec.isAir ? 'air' : 'ground')) === 'air';
      if (Number.isFinite(e.x)) rec.targetX = e.x;
      if (Number.isFinite(e.z)) rec.targetZ = e.z;
      const alt = Number.isFinite(e.y) ? e.y : (def.altitude || 0);
      rec.targetY = rec.isAir ? alt + Math.sin(time * 1.6 + enemyPhase(e.id)) * 0.16 : 0.02;
      const mdx = rec.targetX - rec.x;
      const mdz = rec.targetZ - rec.z;
      if (mdx * mdx + mdz * mdz > 0.002) rec.targetRot = Math.atan2(mdx, mdz);
      const hp = Number.isFinite(e.hp) ? e.hp : rec.hp;
      if (rec.hp !== undefined && hp < rec.hp - 0.5) rec.flash = 0.1;
      rec.hp = hp;
      rec.slowTarget = Number.isFinite(e.slow) && e.slow > 0 ? 1 : 0;
    }
    for (const [id, rec] of Array.from(enemyState.entries())) {
      if (!seen.has(id)) deactivateEnemy(rec);
    }

    const k = 1 - Math.exp(-dt * 11);
    const ky = 1 - Math.exp(-dt * 8);
    const kr = 1 - Math.exp(-dt * 10);
    for (const rec of enemyState.values()) {
      rec.x += (rec.targetX - rec.x) * k;
      rec.z += (rec.targetZ - rec.z) * k;
      rec.y += (rec.targetY - rec.y) * ky;
      rec.rot += wrapAngle(rec.targetRot - rec.rot) * kr;
      if (rec.spawnT < 1) rec.spawnT = Math.min(1, rec.spawnT + dt * 4.2);
      const pop = rec.spawnT < 1 ? 0.35 + 0.65 * (1 - Math.pow(1 - rec.spawnT, 2)) : 1;
      rec.group.position.set(rec.x, rec.y, rec.z);
      rec.group.rotation.y = rec.rot;
      if (rec.isAir) {
        rec.lean += (clamp(wrapAngle(rec.targetRot - rec.rot) * 2, -0.28, 0.28) - rec.lean) * kr;
        rec.group.rotation.z = rec.lean;
      }
      rec.group.scale.setScalar(rec.modelScale * pop);

      rec.flash = Math.max(0, rec.flash - dt);
      const flash = rec.flash > 0 ? rec.flash / 0.1 : 0;
      rec.bodyMat.emissive.setRGB(flash * 0.85, flash * 0.8, flash * 0.7);
      rec.slow += (rec.slowTarget - rec.slow) * (1 - Math.exp(-dt * 6));
      rec.bodyMat.color.copy(rec.tint).lerp(COLOR_SLOW, rec.slow * 0.8);

      for (let r = 0; r < rec.rotors.length; r += 1) {
        const rotor = rec.rotors[r];
        const info = rotor.userData && rotor.userData.rotor;
        if (info) rotor.rotation[info.axis] += info.speed * dt;
      }
      if (rec.aura) {
        rec.auraPulse = Math.max(0, rec.auraPulse - dt);
        const pulse = 1 + 0.12 * Math.sin(time * 3.1 + enemyPhase('aura' + rec.id)) + rec.auraPulse * 0.5;
        rec.aura.scale.setScalar(pulse);
        rec.aura.rotation.y += dt * 1.4;
      }
    }
  }

  // ------------------------------------------------------------ torres
  function spawnTower(t, level) {
    const type = t.type || 'metralhadora';
    const key = type + ':' + level;
    let rec = null;
    const pool = towerPool.get(key);
    if (pool && pool.length) rec = pool.pop();
    if (!rec) {
      const model = modelFactory.tower(type, level);
      entities.add(model.group);
      rec = {
        id: null,
        type,
        level,
        group: model.group,
        aim: model.aim,
        muzzle: model.muzzle,
        aimBaseZ: model.aim ? model.aim.position.z : 0,
        aimYaw: 0,
        restYaw: 0,
        recoil: 0,
        prevCooldown: undefined,
        slot: t.slot,
        x: 0,
        z: 0,
      };
    }
    rec.id = t.id;
    rec.slot = t.slot;
    rec.group.visible = true;
    rec.prevCooldown = undefined;
    towerState.set(t.id, rec);
    return rec;
  }

  function replaceTowerModel(rec, t, level) {
    entities.remove(rec.group);
    rec.group.visible = false;
    const model = modelFactory.tower(t.type || rec.type, level);
    entities.add(model.group);
    rec.level = level;
    rec.group = model.group;
    rec.aim = model.aim;
    rec.muzzle = model.muzzle;
    rec.aimBaseZ = model.aim ? model.aim.position.z : 0;
    rec.recoil = 0;
  }

  function syncTowers(state, dt) {
    const list = Array.isArray(state.towers) ? state.towers : [];
    const seen = new Set();
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      if (!t || t.id === undefined) continue;
      seen.add(t.id);
      let rec = towerState.get(t.id);
      const level = clamp(Math.round(t.level || 1), 1, 3);
      if (!rec) rec = spawnTower(t, level);
      else if (rec.level !== level) replaceTowerModel(rec, t, level);

      let x = t.x;
      let z = t.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        const slot = slotPickList.find((s) => s.i === t.slot);
        x = slot ? slot.x : 0;
        z = slot ? slot.z : 0;
      }
      rec.x = x;
      rec.z = z;
      rec.group.position.set(x, 0.05, z);

      const cooldown = Number.isFinite(t.cooldown) ? t.cooldown : 0;
      if (rec.prevCooldown !== undefined && cooldown > rec.prevCooldown + 1e-4) rec.recoil = 1;
      rec.prevCooldown = cooldown;

      const target = (t.targetId !== null && t.targetId !== undefined) ? enemyState.get(t.targetId) : null;
      const desired = target ? Math.atan2(target.x - x, target.z - z) : rec.restYaw;
      rec.aimYaw += wrapAngle(desired - rec.aimYaw) * (1 - Math.exp(-dt * 9));
      if (rec.aim) rec.aim.rotation.y = rec.aimYaw;
      rec.recoil = Math.max(0, rec.recoil - dt * 7);
      if (rec.aim) rec.aim.position.z = rec.aimBaseZ - rec.recoil * 0.14;
    }
    for (const [id, rec] of Array.from(towerState.entries())) {
      if (!seen.has(id)) {
        rec.group.visible = false;
        towerState.delete(id);
        pushPool(towerPool, rec.type + ':' + rec.level, rec);
      }
    }
  }

  // ------------------------------------------------------------ tropas / projéteis
  function spawnTroop(t) {
    const type = t.type || 'fuzileiros';
    let rec = null;
    const pool = troopPool.get(type);
    if (pool && pool.length) rec = pool.pop();
    if (!rec) {
      const model = modelFactory.troop(type);
      entities.add(model.group);
      rec = { id: null, type, group: model.group, x: 0, z: 0 };
    }
    rec.id = t.id;
    rec.group.visible = true;
    troopState.set(t.id, rec);
    return rec;
  }

  function syncTroops(state, dt) {
    const list = Array.isArray(state.troops) ? state.troops : [];
    const seen = new Set();
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      if (!t || t.id === undefined) continue;
      seen.add(t.id);
      let rec = troopState.get(t.id);
      if (!rec) rec = spawnTroop(t);
      let x = t.x;
      let z = t.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        const point = pointPickList.find((p) => p.j === t.point);
        x = point ? point.x : 0;
        z = point ? point.z : 0;
      }
      rec.x = x;
      rec.z = z;
      rec.group.position.set(x, 0.03, z);
      // pisca levemente perto do fim da vida útil
      const life = Number.isFinite(t.lifeLeft) ? t.lifeLeft : 99;
      const s = life < 4 ? 1 + 0.04 * Math.sin(time * 12) : 1;
      rec.group.scale.setScalar(s);
    }
    for (const [id, rec] of Array.from(troopState.entries())) {
      if (!seen.has(id)) {
        rec.group.visible = false;
        troopState.delete(id);
        pushPool(troopPool, rec.type, rec);
      }
    }
  }

  function spawnProjectile(p) {
    let rec = projectilePool.pop();
    if (!rec) {
      const model = modelFactory.projectile();
      entities.add(model.group);
      rec = { id: null, group: model.group, x: 0, z: 0, y: 1.2, prevX: 0, prevZ: 0, rot: 0 };
    }
    rec.id = p.id;
    rec.group.visible = true;
    rec.x = Number.isFinite(p.x) ? p.x : 0;
    rec.z = Number.isFinite(p.z) ? p.z : 0;
    rec.prevX = rec.x;
    rec.prevZ = rec.z;
    rec.y = 1.2;
    projectileState.set(p.id, rec);
    return rec;
  }

  function syncProjectiles(state, dt) {
    const list = Array.isArray(state.projectiles) ? state.projectiles : [];
    const seen = new Set();
    for (let i = 0; i < list.length; i += 1) {
      const p = list[i];
      if (!p || p.id === undefined) continue;
      seen.add(p.id);
      let rec = projectileState.get(p.id);
      if (!rec) rec = spawnProjectile(p);
      const nx = Number.isFinite(p.x) ? p.x : rec.x;
      const nz = Number.isFinite(p.z) ? p.z : rec.z;
      rec.prevX = rec.x;
      rec.prevZ = rec.z;
      rec.x = rec.x + (nx - rec.x) * (1 - Math.exp(-dt * 28));
      rec.z = rec.z + (nz - rec.z) * (1 - Math.exp(-dt * 28));
      const target = (p.targetId !== null && p.targetId !== undefined) ? enemyState.get(p.targetId) : null;
      const ty = target ? Math.max(0.8, target.y) : 1.2;
      rec.y += (ty - rec.y) * (1 - Math.exp(-dt * 6));
      const dx = rec.x - rec.prevX;
      const dz = rec.z - rec.prevZ;
      if (dx * dx + dz * dz > 1e-4) {
        rec.rot = Math.atan2(dx, dz);
        rec.group.rotation.y = rec.rot;
        rec.group.rotation.x = clamp(-Math.atan2(rec.y - (target ? target.y : rec.y), Math.hypot(dx, dz) + 0.001), -0.6, 0.6);
      }
      rec.group.position.set(rec.x, rec.y, rec.z);
    }
    for (const [id, rec] of Array.from(projectileState.entries())) {
      if (!seen.has(id)) {
        rec.group.visible = false;
        projectileState.delete(id);
        if (projectilePool.length < 24) projectilePool.push(rec);
      }
    }
  }

  // ------------------------------------------------------------ sombras falsas
  function updateBlobShadows() {
    let n = 0;
    const capacity = blobShadows.instanceMatrix.count;
    for (const rec of enemyState.values()) {
      if (n >= capacity) break;
      const scale = rec.radius * (rec.isAir ? 1.15 : 1.6);
      _dummy.position.set(rec.x, 0.105, rec.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(scale, 1, scale);
      _dummy.updateMatrix();
      blobShadows.setMatrixAt(n, _dummy.matrix);
      n += 1;
    }
    blobShadows.count = n;
    blobShadows.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ eventos
  function handleEvents(events, state) {
    if (!Array.isArray(events)) return;
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      if (!ev || !ev.type) continue;
      switch (ev.type) {
        case 'spawn': {
          if (ev.enemyId !== undefined && ev.variant !== undefined) variants.set(ev.enemyId, ev.variant);
          if (Number.isFinite(ev.x) && Number.isFinite(ev.z)) {
            effects.addRing(ev.x, ev.z, theme.accent, 2.2, 0.45, 0.14);
          }
          break;
        }
        case 'shot': {
          const rec = towerState.get(ev.towerId);
          if (rec && rec.muzzle) {
            rec.muzzle.getWorldPosition(_v3b);
            const color = TOWER_FLASH_COLORS[ev.towerType] || 0xffd27f;
            effects.addSpark(_v3b.x, _v3b.y, _v3b.z, color, 0.5, 0.08);
          }
          if (rec) rec.recoil = Math.max(rec.recoil || 0, 0.9);
          break;
        }
        case 'explosion': {
          const big = ev.size === 'large' || ev.size === 'base';
          effects.addRing(ev.x || 0, ev.z || 0, big ? 0xffa04a : 0xffc97a, big ? 5.2 : 3.2, big ? 0.7 : 0.5);
          break;
        }
        case 'kill': {
          effects.addRing(ev.x || 0, ev.z || 0, 0xffb060, 1.7, 0.32);
          break;
        }
        case 'leak': {
          effects.addRing(ev.x || 0, ev.z || 0, 0xff3030, 5.4, 0.8);
          baseFlash = 0.7;
          break;
        }
        case 'bossSpawn': {
          const rec = enemyState.get(ev.enemyId);
          if (rec) {
            rec.auraPulse = 1;
            effects.addRing(rec.x, rec.z, ENEMY_FLASH_COLORS[rec.type] || 0xff5522, 5.5, 1.1, 0.16);
          }
          break;
        }
        case 'troopDeploy': {
          const point = pointPickList.find((p) => p.j === ev.point);
          if (point) effects.addRing(point.x, point.z, theme.accent2, 2.0, 0.45, 0.15);
          break;
        }
        case 'troopDeath': {
          if (Number.isFinite(ev.x) && Number.isFinite(ev.z)) {
            effects.addRing(ev.x, ev.z, 0x8fd8ff, 2.2, 0.5);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // ------------------------------------------------------------ animação estática
  function updateStatic(dt) {
    baseFlash = Math.max(0, baseFlash - dt * 1.5);
    if (spawnGroup) {
      const ring = spawnGroup.getObjectByName('portalRing');
      const glow = spawnGroup.getObjectByName('portalGlow');
      if (ring) {
        ring.rotation.z += dt * 0.8;
        ring.scale.setScalar(1 + 0.035 * Math.sin(time * 2.2));
        ring.material.opacity = 0.62 + 0.22 * Math.sin(time * 2.6);
      }
      if (glow) {
        glow.rotation.z -= dt * 0.35;
        glow.material.opacity = 0.16 + 0.09 * Math.sin(time * 1.7);
      }
    }
    if (baseGroup) {
      const beacon = baseGroup.getObjectByName('beacon');
      const shield = baseGroup.getObjectByName('shield');
      if (beacon) {
        const pulse = 1 + 0.16 * Math.sin(time * 2.5) + baseFlash * 0.9;
        beacon.scale.setScalar(pulse);
        beacon.material.color.set(theme.accent).lerp(_color.set(0xff2a2a), baseFlash);
        beacon.material.opacity = clamp(0.7 + 0.25 * Math.sin(time * 3.2) + baseFlash * 0.3, 0, 1);
      }
      if (shield) {
        shield.material.opacity = 0.035 + 0.02 * Math.sin(time * 1.1) + baseFlash * 0.16;
      }
    }
    if (slotHighlight && slotHighlight.visible) {
      slotHighlight.material.opacity = 0.7 + 0.3 * Math.sin(time * 4);
    }
    if (pointHighlight && pointHighlight.visible) {
      pointHighlight.material.opacity = 0.7 + 0.3 * Math.sin(time * 4.4);
    }
    if (hoverRing && hoverRing.visible) {
      hoverRing.material.opacity = 0.4 + 0.25 * Math.sin(time * 5);
    }
    if (bossLight.visible) {
      bossLight.intensity = 1.6 + 1.1 * Math.sin(time * 4);
    }
  }

  function updateBossLight(state) {
    const boss = state && state.boss ? state.boss : null;
    if (!boss) {
      bossLight.visible = false;
      bossLight.intensity = 0;
      return;
    }
    const rec = enemyState.get(boss.id);
    if (!rec) {
      bossLight.visible = false;
      bossLight.intensity = 0;
      return;
    }
    bossLight.visible = true;
    bossLight.color.set(ENEMY_FLASH_COLORS[rec.type] || 0xff5522);
    bossLight.position.set(rec.x, Math.max(2.5, rec.y + 2.4), rec.z);
  }

  function updateShake(dt) {
    if (shakeAmp > 0) {
      shakeAmp *= Math.exp(-dt * 5.5);
      if (shakeAmp < 0.004) shakeAmp = 0;
    }
  }

  // ------------------------------------------------------------ API: update/render
  function update(state, dt, events) {
    if (disposed) return;
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    time += d;

    if (state && state.map) {
      const mapId = state.map.id || state.map.mapId;
      if (mapId && mapId !== currentMapId) {
        const def = {
          id: mapId,
          name: state.map.name,
          waypoints: state.map.waypoints,
          slots: Array.isArray(state.slots)
            ? state.slots.map((s) => ({ i: s.i, x: s.x, z: s.z }))
            : undefined,
          troopPoints: Array.isArray(state.troopPoints)
            ? state.troopPoints.map((p) => ({ j: p.j, x: p.x, z: p.z }))
            : undefined,
          length: state.map.length,
        };
        setMap(def);
      }
    }

    if (state) {
      handleEvents(events, state);
      syncEnemies(state, d);
      syncTowers(state, d);
      syncTroops(state, d);
      syncProjectiles(state, d);
      syncSlotColors(state);
      syncPointColors(state);
      updateBossLight(state);
    } else {
      updateBossLight(null);
      if (currentMap) {
        syncSlotColors(null);
        syncPointColors(null);
      }
      // giro lento do cenário nos menus (não atrapalha o jogo)
      if (!controls.dragging) view.yaw += d * 0.045;
    }
    updateBlobShadows();
    updateStatic(d);
    if (weather) weather.update(d);
    effects.update(d);
    updateShake(d);
    applyCamera();
  }

  function render() {
    if (disposed) return;
    applyCamera();
    renderer.render(scene, camera);
  }

  function perf() {
    let pointLights = 0;
    scene.traverse((obj) => {
      if (obj.isPointLight && obj.visible && obj.intensity > 0) pointLights += 1;
    });
    return {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      pointLights,
    };
  }

  // ------------------------------------------------------------ listeners
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  if (typeof window !== 'undefined') window.addEventListener('resize', resize);
  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    try {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
      if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);
    } catch (err) {
      resizeObserver = null;
    }
  }

  // ------------------------------------------------------------ init
  resize();
  setMap(MAPS.deserto);

  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    if (typeof window !== 'undefined') window.removeEventListener('resize', resize);
    if (resizeObserver) resizeObserver.disconnect();
    if (mapGroup) disposeObject3D(mapGroup);
    mapGroup = null;
    enemyState.clear();
    towerState.clear();
    troopState.clear();
    projectileState.clear();
    enemyPool.clear();
    towerPool.clear();
    troopPool.clear();
    projectilePool.length = 0;
    disposeObject3D(effects.group);
    disposeObject3D(slotMarkers);
    disposeObject3D(pointMarkers);
    disposeObject3D(slotHighlight);
    disposeObject3D(pointHighlight);
    disposeObject3D(hoverRing);
    disposeObject3D(blobShadows);
    modelFactory.dispose();
    bossLight.dispose && bossLight.dispose();
    renderer.dispose();
  }

  return {
    renderer,
    scene,
    camera,
    setMap,
    update,
    pickSlot,
    pickTroopPoint,
    project,
    highlightSlot,
    highlightPoint,
    shake,
    resize,
    render,
    perf,
    dispose,
  };
}
