// Mapas, caminhos, slots de torre e pontos de tropa — Torre de Ferro.
// Mundo x∈[-50,50], z∈[-25,25], y para cima. Caminho = segmentos retos entre
// waypoints; primeiro waypoint = spawn, último = base.

const DESERTO = {
  id: 'deserto',
  name: 'Deserto',
  fog: 'areia',
  waypoints: [
    [-42, -18], [-24, -18], [-24, 6], [-2, 6], [-2, -10],
    [18, -10], [18, 14], [40, 14],
  ],
};

const NEVE = {
  id: 'neve',
  name: 'Neve',
  fog: 'neve',
  waypoints: [
    [-36, -18], [-36, 14], [-10, 14], [-10, -14],
    [10, -14], [10, 14], [34, 14], [34, 0],
  ],
};

const CIDADE = {
  id: 'cidade',
  name: 'Cidade',
  fog: 'noturno',
  waypoints: [
    [-40, 0], [-20, 0], [-20, -16], [0, -16], [0, 16],
    [20, 16], [20, -16], [40, -16], [40, 0],
  ],
};

function buildSegments(waypoints) {
  const segments = [];
  let total = 0;
  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const [x1, z1] = waypoints[i];
    const [x2, z2] = waypoints[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len <= 0) continue;
    segments.push({ ax: x1, az: z1, bx: x2, bz: z2, dx: dx / len, dz: dz / len, len, start: total });
    total += len;
  }
  return { segments, total };
}

// Ponto a `d` unidades do início do caminho. Normal perpendicular (lado +1)
// = rotação +90° da direção do segmento no plano x/z: (dx,dz) -> (-dz,dx).
export function pathPointAt(map, d) {
  const segs = map.segments;
  const dist = Math.max(0, Math.min(map.length, d));
  let seg = segs[segs.length - 1];
  for (let i = 0; i < segs.length; i += 1) {
    if (dist <= segs[i].start + segs[i].len || i === segs.length - 1) { seg = segs[i]; break; }
  }
  const local = Math.max(0, Math.min(seg.len, dist - seg.start));
  const x = seg.ax + seg.dx * local;
  const z = seg.az + seg.dz * local;
  return { x, z, dirX: seg.dx, dirZ: seg.dz, nx: -seg.dz, nz: seg.dx, segIndex: segs.indexOf(seg) };
}

function buildSlots(map) {
  const slots = [];
  const limit = map.length - 6;
  for (let i = 0; i < 16; i += 1) {
    const d = 10 + 9 * i;
    if (d > limit) break;
    const p = pathPointAt(map, d);
    const side = i % 2 === 0 ? 1 : -1;
    slots.push({ i, d, x: round2(p.x + p.nx * 6 * side), z: round2(p.z + p.nz * 6 * side) });
  }
  return slots;
}

function buildTroopPoints(map) {
  const points = [];
  const limit = map.length - 6;
  for (let j = 0; j < 6; j += 1) {
    const d = Math.min(20 + 25 * j, limit);
    const p = pathPointAt(map, d);
    const side = j % 2 === 0 ? 1 : -1;
    points.push({ j, d, x: round2(p.x + p.nx * 2.5 * side), z: round2(p.z + p.nz * 2.5 * side) });
  }
  return points;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function finalize(def) {
  const { segments, total } = buildSegments(def.waypoints);
  const map = {
    id: def.id,
    name: def.name,
    fog: def.fog,
    waypoints: def.waypoints.map((p) => [p[0], p[1]]),
    segments,
    length: Math.round(total * 100) / 100,
  };
  map.slots = buildSlots(map);
  map.troopPoints = buildTroopPoints(map);
  return map;
}

export const MAPS = {
  deserto: finalize(DESERTO),
  neve: finalize(NEVE),
  cidade: finalize(CIDADE),
};

export function getMap(mapId) {
  return MAPS[mapId] || null;
}

export function mapIndex(mapId) {
  return ['deserto', 'neve', 'cidade'].indexOf(mapId);
}
