'use strict';

/**
 * Validação, normalização e resolução do **room plan v1** do Blender
 * Director v3.
 *
 * O room plan é o contrato de entrada do `build_room.py`: uma sala medida em
 * metros, com paredes, piso, teto, aberturas (boolean), mobiliário em blocos,
 * assets importados, um light rig com presets e uma câmera. A avaliação
 * (`evaluate.py`) também lê o bloco `evaluation` daqui.
 *
 * Este módulo reaproveita `normalizeMaterial`, `normalizeLight` e
 * `normalizeCamera` do schema v1 (`lib/spec.js`) para que materiais, luzes e
 * câmera tenham exatamente as mesmas regras nos dois pipelines.
 *
 * O `build_room.py` reimplementa a mesma validação/geometria em Python porque
 * roda dentro do Blender. O teste `test/room-e2e.js` compara os dois
 * resolvedores campo a campo para impedir que as implementações divirjam.
 */

const spec = require('./spec');

const { ValidationError, normalizeMaterial, normalizeLight, normalizeCamera } = spec;

const ROOM_SCHEMA_VERSION = 1;
const PRESETS_VERSION = 1;

const SIDES = ['north', 'south', 'east', 'west'];
const PRESET_ALIASES = {
  day: 'day',
  dia: 'day',
  dusk: 'dusk',
  'fim-de-tarde': 'dusk',
  'fim de tarde': 'dusk',
  sunset: 'dusk',
  night: 'night',
  noite: 'night',
};
const PRESET_NAMES = ['day', 'dusk', 'night'];

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'name',
  'description',
  'room',
  'exterior',
  'materials',
  'furniture',
  'assets',
  'lighting',
  'camera',
  'render',
  'evaluation',
  'reference',
];
const ROOM_KEYS = ['interior', 'wallThickness', 'floor', 'ceiling', 'walls', 'openings'];
const INTERIOR_KEYS = ['width', 'depth', 'height'];
const SURFACE_KEYS = ['material', 'thickness'];
const WALL_KEYS = ['side', 'material', 'openings'];
const OPENING_KEYS = ['id', 'type', 'u', 'bottom', 'width', 'height', 'frame', 'glass', 'leaf'];
const FRAME_KEYS = ['profile', 'depth', 'mullions', 'transom', 'material'];
const OPENINGS_STYLE_KEYS = ['frame', 'glass', 'frameMaterial', 'glassMaterial'];
const FURNITURE_KEYS = ['id', 'name', 'shape', 'size', 'position', 'rotation', 'material', 'bevel', 'smooth', 'support', 'collisionGroup', 'detail'];
const FURNITURE_SHAPES = ['box', 'roundbox', 'cylinder'];
const ASSET_PLACEMENT_KEYS = [
  'id',
  'assetId',
  'position',
  'rotation',
  'scale',
  'fitHeight',
  'anchor',
  'snapToFloor',
  'materialOverride',
  'visible',
  'support',
];
const LIGHTING_KEYS = ['preset', 'hdri', 'environmentRotation', 'overrides', 'overridesByPreset', 'interiorFixtures'];
const LIGHTING_OVERRIDE_KEYS = ['sun', 'world', 'windowFill', 'exposure'];
const SUN_KEYS = ['enabled', 'strength', 'color', 'angle', 'azimuth', 'elevation'];
const WORLD_KEYS = ['kind', 'color', 'strength'];
const WINDOW_FILL_KEYS = ['enabled', 'energy', 'size', 'color'];
const FIXTURE_KEYS = ['id', 'type', 'position', 'size', 'watts', 'color', 'target', 'enabled', 'spotSize', 'spotBlend'];
const EXTERIOR_KEYS = ['balcony', 'backdrop'];
const BACKDROP_KEYS = ['enabled', 'facade', 'hedge'];
const FACADE_KEYS = ['material', 'distance', 'width', 'height'];
const HEDGE_KEYS = ['material', 'width', 'height', 'depth', 'offset'];
const BALCONY_KEYS = ['enabled', 'depth', 'railingHeight', 'bars', 'material'];
const RENDER_KEYS = ['engine', 'samples', 'resolution', 'preview', 'render', 'colorManagement', 'output'];
const REFERENCE_KEYS = ['image', 'measurements', 'inventory', 'fullyVisible'];
const MEASUREMENT_KEYS = ['windowRect', 'horizonY', 'cameraHeight', 'sofaRect', 'tableRect', 'notes'];
const EVALUATION_KEYS = [
  'reference',
  'referenceMask',
  'requireMasks',
  'regions',
  'thresholds',
  'histogramBins',
  'maxEvalSize',
  'notes',
];
const REGION_KEYS = ['id', 'label', 'rect'];
const THRESHOLD_KEYS = ['ssimMin', 'deltaE00Max', 'deltaE00RegionMax', 'histogramMax', 'iouMin'];

const LIMITS = Object.freeze({
  maxWalls: 4,
  maxOpeningsPerWall: 8,
  maxOpenings: 16,
  maxFurniture: 240,
  maxAssets: 64,
  maxFixtures: 24,
  maxMaterials: 64,
  maxRegions: 16,
  minWidth: 1.5,
  maxWidth: 15,
  minDepth: 1.5,
  maxDepth: 15,
  minHeight: 2,
  maxHeight: 6,
});

const DEFAULTS = Object.freeze({
  wallThickness: 0.12,
  floorThickness: 0.1,
  ceilingThickness: 0.1,
  frameProfile: 0.05,
  frameDepth: 0.07,
  glass: true,
  nearPlane: 0.01,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(context, message) {
  throw new ValidationError(`${context}: ${message}`);
}

function checkKeys(raw, allowed, context) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      fail(context, `campo desconhecido "${key}" (aceitos: ${allowed.join(', ')})`);
    }
  }
}

function string(value, context, fallback, { max = 200, pattern = null } = {}) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(context, 'é obrigatório');
    return fallback;
  }
  if (typeof value !== 'string') fail(context, 'deve ser texto');
  const text = value.trim();
  if (text.length === 0) fail(context, 'não pode ser vazio');
  if (text.length > max) fail(context, `deve ter no máximo ${max} caracteres`);
  if (pattern && !pattern.test(text)) fail(context, `formato inválido: "${text}"`);
  return text;
}

function id(value, context, fallback) {
  return string(value, context, fallback, { max: 64, pattern: /^[A-Za-z0-9_.-]+$/ });
}

function number(value, context, fallback, min = -Infinity, max = Infinity) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(context, 'é obrigatório');
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(context, 'deve ser um número finito');
  if (value < min || value > max) fail(context, `deve estar entre ${min} e ${max}`);
  return value;
}

function integer(value, context, fallback, min, max) {
  const result = number(value, context, fallback, min, max);
  if (!Number.isInteger(result)) fail(context, 'deve ser um inteiro');
  return result;
}

function boolean(value, context, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail(context, 'deve ser true ou false');
  return value;
}

function vector3(value, context, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(context, 'é obrigatório');
    return fallback.slice();
  }
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    fail(context, 'deve ser [x, y, z] com números finitos');
  }
  return value.slice();
}

function srgbChannelToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Cor "#rrggbb" (sRGB) ou [r,g,b] linear, igual ao schema v1. */
function color(value, context, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(context, 'é obrigatório');
    return fallback.slice();
  }
  if (typeof value === 'string') {
    const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
    if (!match) fail(context, 'cor hex deve ter o formato #rrggbb');
    const integerValue = parseInt(match[1], 16);
    return [
      srgbChannelToLinear(((integerValue >> 16) & 0xff) / 255),
      srgbChannelToLinear(((integerValue >> 8) & 0xff) / 255),
      srgbChannelToLinear((integerValue & 0xff) / 255),
    ];
  }
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && item >= 0 && item <= 1)) {
    return value.slice();
  }
  fail(context, 'cor deve ser "#rrggbb" (sRGB) ou [r,g,b] linear entre 0 e 1');
}

function normalizeSupport(value, context, fallback) {
  const support = string(value, context, fallback, { max: 12 }).toLowerCase();
  if (!['floor', 'furniture', 'wall', 'ceiling'].includes(support)) {
    fail(context, 'use "floor", "furniture", "wall" ou "ceiling"');
  }
  return support;
}

function normalizeRect(value, context) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    fail(context, 'deve ser [x, y, largura, altura] normalizado');
  }
  const [x, y, w, h] = value;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) {
    fail(context, 'retângulo precisa caber em 0..1');
  }
  return value.slice();
}

function normalizeReference(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('reference', 'deve ser um objeto');
  checkKeys(raw, REFERENCE_KEYS, 'reference');
  const measurementsRaw = raw.measurements;
  if (!isObject(measurementsRaw)) fail('reference.measurements', 'deve ser um objeto');
  checkKeys(measurementsRaw, MEASUREMENT_KEYS, 'reference.measurements');
  const stringList = (value, context) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) fail(context, 'deve ser uma lista de ids');
    return value.slice();
  };
  return {
    image: raw.image === undefined || raw.image === null ? null : string(raw.image, 'reference.image', undefined, { max: 500 }),
    measurements: {
      windowRect: normalizeRect(measurementsRaw.windowRect, 'reference.measurements.windowRect'),
      horizonY: number(measurementsRaw.horizonY, 'reference.measurements.horizonY', 0.5, 0, 1),
      cameraHeight: number(measurementsRaw.cameraHeight, 'reference.measurements.cameraHeight', 1.2, 0.3, 3),
      sofaRect: measurementsRaw.sofaRect === undefined || measurementsRaw.sofaRect === null ? null : normalizeRect(measurementsRaw.sofaRect, 'reference.measurements.sofaRect'),
      tableRect: measurementsRaw.tableRect === undefined || measurementsRaw.tableRect === null ? null : normalizeRect(measurementsRaw.tableRect, 'reference.measurements.tableRect'),
      notes: measurementsRaw.notes === undefined || measurementsRaw.notes === null ? null : string(measurementsRaw.notes, 'reference.measurements.notes', undefined, { max: 1000 }),
    },
    inventory: stringList(raw.inventory, 'reference.inventory'),
    fullyVisible: stringList(raw.fullyVisible, 'reference.fullyVisible'),
  };
}

function normalizeMaterials(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) fail('materials', 'deve ser um objeto {nome: material}');
  const names = Object.keys(raw);
  if (names.length > LIMITS.maxMaterials) fail('materials', `limite de ${LIMITS.maxMaterials} materiais`);
  const materials = {};
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      fail(`materials.${name}`, 'nome de material deve usar letras, números, "_", "." ou "-" (até 64)');
    }
    materials[name] = normalizeMaterial(raw[name], `materials.${name}`);
  }
  return materials;
}

function normalizeInterior(raw) {
  if (!isObject(raw)) fail('room.interior', 'deve ser um objeto {width, depth, height}');
  checkKeys(raw, INTERIOR_KEYS, 'room.interior');
  return {
    width: number(raw.width, 'room.interior.width', undefined, LIMITS.minWidth, LIMITS.maxWidth),
    depth: number(raw.depth, 'room.interior.depth', undefined, LIMITS.minDepth, LIMITS.maxDepth),
    height: number(raw.height, 'room.interior.height', undefined, LIMITS.minHeight, LIMITS.maxHeight),
  };
}

function normalizeSurface(raw, context, fallbackMaterial) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto {material, thickness}');
  checkKeys(raw, SURFACE_KEYS, context);
  return {
    material: string(raw.material, `${context}.material`, fallbackMaterial, { max: 64 }),
    thickness: number(raw.thickness, `${context}.thickness`, DEFAULTS.floorThickness, 0.01, 0.5),
  };
}

function normalizeFrame(raw, context, style) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, FRAME_KEYS, context);
  return {
    profile: number(raw.profile, `${context}.profile`, style.profile, 0.005, 0.3),
    depth: number(raw.depth, `${context}.depth`, style.depth, 0.005, 0.6),
    mullions: integer(raw.mullions, `${context}.mullions`, style.mullions, 0, 6),
    transom: number(raw.transom, `${context}.transom`, style.transom, 0, 3),
    material: raw.material === undefined || raw.material === null
      ? null
      : string(raw.material, `${context}.material`, undefined, { max: 64 }),
  };
}

function normalizeOpeningsStyle(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('room.openings', 'deve ser um objeto');
  checkKeys(raw, OPENINGS_STYLE_KEYS, 'room.openings');
  const frame = raw.frame === undefined || raw.frame === null ? {} : raw.frame;
  if (!isObject(frame)) fail('room.openings.frame', 'deve ser um objeto');
  checkKeys(frame, FRAME_KEYS, 'room.openings.frame');
  return {
    frame: {
      profile: number(frame.profile, 'room.openings.frame.profile', DEFAULTS.frameProfile, 0.005, 0.3),
      depth: number(frame.depth, 'room.openings.frame.depth', DEFAULTS.frameDepth, 0.005, 0.6),
      mullions: integer(frame.mullions, 'room.openings.frame.mullions', 0, 0, 6),
      transom: number(frame.transom, 'room.openings.frame.transom', 0, 0, 3),
      material: frame.material === undefined || frame.material === null
        ? null
        : string(frame.material, 'room.openings.frame.material', undefined, { max: 64 }),
    },
    glass: boolean(raw.glass, 'room.openings.glass', DEFAULTS.glass),
    frameMaterial: raw.frameMaterial === undefined || raw.frameMaterial === null
      ? null
      : string(raw.frameMaterial, 'room.openings.frameMaterial', undefined, { max: 64 }),
    glassMaterial: raw.glassMaterial === undefined || raw.glassMaterial === null
      ? null
      : string(raw.glassMaterial, 'room.openings.glassMaterial', undefined, { max: 64 }),
  };
}

function normalizeWall(raw, context, room, style, side) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto {side, material, openings}');
  checkKeys(raw, WALL_KEYS, context);
  const wallSide = string(raw.side, `${context}.side`, undefined, { max: 10 }).toLowerCase();
  if (!SIDES.includes(wallSide)) fail(`${context}.side`, `use um de: ${SIDES.join(', ')}`);
  if (side && wallSide !== side) fail(`${context}.side`, `esperava "${side}"`);
  const length = wallSide === 'north' || wallSide === 'south' ? room.width : room.depth;
  const openingsRaw = raw.openings === undefined || raw.openings === null ? [] : raw.openings;
  if (!Array.isArray(openingsRaw)) fail(`${context}.openings`, 'deve ser uma lista');
  if (openingsRaw.length > LIMITS.maxOpeningsPerWall) {
    fail(`${context}.openings`, `limite de ${LIMITS.maxOpeningsPerWall} aberturas por parede`);
  }
  const openings = openingsRaw.map((opening, index) => normalizeOpening(opening, `${context}.openings[${index}]`, length, room.height, style));
  return {
    side: wallSide,
    material: string(raw.material, `${context}.material`, undefined, { max: 64 }),
    length,
    openings,
  };
}

function normalizeOpening(raw, context, wallLength, roomHeight, style) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, OPENING_KEYS, context);
  const type = string(raw.type, `${context}.type`, 'window', { max: 10 }).toLowerCase();
  if (type !== 'window' && type !== 'door') fail(`${context}.type`, 'use "window" ou "door"');
  const width = number(raw.width, `${context}.width`, undefined, 0.3, Math.min(6, wallLength));
  const height = number(raw.height, `${context}.height`, undefined, 0.3, roomHeight - 0.02);
  const bottom = number(raw.bottom, `${context}.bottom`, type === 'door' ? 0 : 0.9, 0, roomHeight - 0.3);
  const u = number(raw.u, `${context}.u`, undefined, 0, Math.max(0, wallLength - width));
  if (u + width > wallLength + 1e-9) {
    fail(`${context}.u`, `abertura passa da parede (u=${u} + width=${width} > ${wallLength})`);
  }
  if (bottom + height > roomHeight - 0.01 + 1e-9) {
    fail(`${context}.bottom`, `abertura passa do teto (bottom=${bottom} + height=${height} > ${roomHeight})`);
  }
  if (type === 'door' && bottom > 0.01) fail(`${context}.bottom`, 'porta precisa começar no piso (bottom = 0)');
  const frame = normalizeFrame(raw.frame, `${context}.frame`, style.frame);
  const frameMaterial = frame.material || style.frameMaterial;
  const glass = boolean(raw.glass, `${context}.glass`, type === 'window' ? style.glass : false);
  if (glass && !style.glassMaterial) fail(`${context}.glass`, 'vidro ligado mas room.openings.glassMaterial não foi definido');
  if (!frameMaterial) fail(`${context}.frame.material`, 'nenhum material de esquadria definido (room.openings.frameMaterial)');
  return {
    id: id(raw.id, `${context}.id`, `${type || 'abertura'}-${context.replace(/[^0-9]/g, '') || '1'}`),
    type,
    u,
    bottom,
    width,
    height,
    frame,
    frameMaterial,
    glass,
    leaf: boolean(raw.leaf, `${context}.leaf`, false),
    glassMaterial: style.glassMaterial,
  };
}

function normalizeRoom(raw, materials) {
  if (!isObject(raw)) fail('room', 'deve ser um objeto');
  checkKeys(raw, ROOM_KEYS, 'room');
  const interior = normalizeInterior(raw.interior);
  const wallThickness = number(raw.wallThickness, 'room.wallThickness', DEFAULTS.wallThickness, 0.05, 0.5);
  const style = normalizeOpeningsStyle(raw.openings);
  const floor = normalizeSurface(raw.floor, 'room.floor', null);
  const ceiling = normalizeSurface(raw.ceiling, 'room.ceiling', null);
  if (floor.material && !materials[floor.material]) fail('room.floor.material', `material "${floor.material}" não existe em materials`);
  if (ceiling.material && !materials[ceiling.material]) fail('room.ceiling.material', `material "${ceiling.material}" não existe em materials`);

  const wallsRaw = raw.walls;
  if (!Array.isArray(wallsRaw) || wallsRaw.length !== 4) fail('room.walls', 'precisa das 4 paredes (north, south, east, west)');
  const seen = new Set();
  const walls = wallsRaw.map((wall, index) => {
    const normalized = normalizeWall(wall, `room.walls[${index}]`, interior, style, null);
    if (seen.has(normalized.side)) fail(`room.walls[${index}].side`, `parede "${normalized.side}" duplicada`);
    seen.add(normalized.side);
    if (!materials[normalized.material]) fail(`room.walls[${index}].material`, `material "${normalized.material}" não existe em materials`);
    return normalized;
  });
  for (const side of SIDES) {
    if (!seen.has(side)) fail('room.walls', `falta a parede "${side}"`);
  }
  const openings = walls.flatMap((wall) => wall.openings.map((opening) => ({ ...opening, side: wall.side })));
  if (openings.length > LIMITS.maxOpenings) fail('room.walls', `limite de ${LIMITS.maxOpenings} aberturas`);

  const assetMaterialNames = new Set(Object.keys(materials));
  for (const opening of openings) {
    if (opening.type === 'window' && !opening.glass) fail(`room.walls.${opening.side}`, `janela "${opening.id}" precisa de vidro (glass) nesta versão`);
    if (opening.frameMaterial && !assetMaterialNames.has(opening.frameMaterial)) {
      fail('room.openings.frameMaterial', `material "${opening.frameMaterial}" não existe em materials`);
    }
    if (opening.glass && !assetMaterialNames.has(opening.glassMaterial)) {
      fail('room.openings.glassMaterial', `material "${opening.glassMaterial}" não existe em materials`);
    }
    if (opening.frame.material && !assetMaterialNames.has(opening.frame.material)) {
      fail('room.openings.frame.material', `material "${opening.frame.material}" não existe em materials`);
    }
  }

  return { interior, wallThickness, floor, ceiling, walls, openings, style };
}

function normalizeFurniture(raw, materials) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('furniture', 'deve ser uma lista');
  if (raw.length > LIMITS.maxFurniture) fail('furniture', `limite de ${LIMITS.maxFurniture} peças`);
  const seen = new Set();
  return raw.map((item, index) => {
    const context = `furniture[${index}]`;
    if (!isObject(item)) fail(context, 'deve ser um objeto');
    checkKeys(item, FURNITURE_KEYS, context);
    const pieceId = id(item.id, `${context}.id`, `peca-${index + 1}`);
    if (seen.has(pieceId)) fail(`${context}.id`, `id duplicado "${pieceId}"`);
    seen.add(pieceId);
    const shape = string(item.shape, `${context}.shape`, 'box', { max: 10 }).toLowerCase();
    if (!FURNITURE_SHAPES.includes(shape)) fail(`${context}.shape`, `use um de: ${FURNITURE_SHAPES.join(', ')}`);
    const material = string(item.material, `${context}.material`, undefined, { max: 64 });
    if (!materials[material]) fail(`${context}.material`, `material "${material}" não existe em materials`);
    const size = vector3(item.size, `${context}.size`, undefined);
    if (size.some((value) => value < 0.01 || value > 12)) fail(`${context}.size`, 'cada eixo deve estar entre 0.01 e 12 m');
    return {
      id: pieceId,
      name: string(item.name, `${context}.name`, pieceId, { max: 120 }),
      shape,
      size,
      position: vector3(item.position, `${context}.position`, undefined),
      rotation: vector3(item.rotation, `${context}.rotation`, [0, 0, 0]),
      material,
      bevel: number(item.bevel, `${context}.bevel`, shape === 'roundbox' ? 0.03 : 0, 0, 0.25),
      smooth: boolean(item.smooth, `${context}.smooth`, shape !== 'box'),
      support: normalizeSupport(item.support, `${context}.support`, 'floor'),
      collisionGroup: item.collisionGroup === undefined || item.collisionGroup === null
        ? pieceId.split('-')[0]
        : string(item.collisionGroup, `${context}.collisionGroup`, undefined, { max: 64 }),
      detail: boolean(item.detail, `${context}.detail`, false),
    };
  });
}

function normalizeAssets(raw, materials) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('assets', 'deve ser uma lista');
  if (raw.length > LIMITS.maxAssets) fail('assets', `limite de ${LIMITS.maxAssets} assets`);
  const seen = new Set();
  return raw.map((item, index) => {
    const context = `assets[${index}]`;
    if (!isObject(item)) fail(context, 'deve ser um objeto');
    checkKeys(item, ASSET_PLACEMENT_KEYS, context);
    const placementId = id(item.id, `${context}.id`, `asset-${index + 1}`);
    if (seen.has(placementId)) fail(`${context}.id`, `id duplicado "${placementId}"`);
    seen.add(placementId);
    const assetId = string(item.assetId, `${context}.assetId`, undefined, { max: 80 });
    const anchor = string(item.anchor, `${context}.anchor`, 'bottom', { max: 10 }).toLowerCase();
    if (anchor !== 'bottom' && anchor !== 'origin') fail(`${context}.anchor`, 'use "bottom" ou "origin"');
    const materialOverride = item.materialOverride === undefined || item.materialOverride === null
      ? null
      : string(item.materialOverride, `${context}.materialOverride`, undefined, { max: 64 });
    if (materialOverride && !materials[materialOverride]) {
      fail(`${context}.materialOverride`, `material "${materialOverride}" não existe em materials`);
    }
    const scale = number(item.scale, `${context}.scale`, 1, 0.002, 50);
    const fitHeight = item.fitHeight === undefined || item.fitHeight === null
      ? null
      : number(item.fitHeight, `${context}.fitHeight`, undefined, 0.01, 12);
    return {
      id: placementId,
      assetId,
      position: vector3(item.position, `${context}.position`, undefined),
      rotation: vector3(item.rotation, `${context}.rotation`, [0, 0, 0]),
      scale,
      fitHeight,
      anchor,
      snapToFloor: boolean(item.snapToFloor, `${context}.snapToFloor`, true),
      materialOverride,
      visible: boolean(item.visible, `${context}.visible`, true),
      support: normalizeSupport(item.support, `${context}.support`, 'floor'),
    };
  });
}

function normalizeSun(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('lighting.overrides.sun', 'deve ser um objeto');
  checkKeys(raw, SUN_KEYS, 'lighting.overrides.sun');
  const partial = {};
  if (raw.enabled !== undefined) partial.enabled = boolean(raw.enabled, 'lighting.overrides.sun.enabled', true);
  if (raw.strength !== undefined) partial.strength = number(raw.strength, 'lighting.overrides.sun.strength', 4, 0, 1000);
  if (raw.color !== undefined) partial.color = color(raw.color, 'lighting.overrides.sun.color', [1, 0.9, 0.8]);
  if (raw.angle !== undefined) partial.angle = number(raw.angle, 'lighting.overrides.sun.angle', 0.8, 0, 180);
  if (raw.azimuth !== undefined) partial.azimuth = number(raw.azimuth, 'lighting.overrides.sun.azimuth', 150, 0, 360);
  if (raw.elevation !== undefined) partial.elevation = number(raw.elevation, 'lighting.overrides.sun.elevation', 30, -10, 90);
  return partial;
}

function normalizeWorldOverride(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('lighting.overrides.world', 'deve ser um objeto');
  checkKeys(raw, WORLD_KEYS, 'lighting.overrides.world');
  const partial = {};
  if (raw.kind !== undefined) {
    const kind = string(raw.kind, 'lighting.overrides.world.kind', 'hdri', { max: 10 }).toLowerCase();
    if (kind !== 'hdri' && kind !== 'color') fail('lighting.overrides.world.kind', 'use "hdri" ou "color"');
    partial.kind = kind;
  }
  if (raw.color !== undefined) partial.color = color(raw.color, 'lighting.overrides.world.color', [0.03, 0.03, 0.04]);
  if (raw.strength !== undefined) partial.strength = number(raw.strength, 'lighting.overrides.world.strength', 1, 0, 1000);
  return partial;
}

function normalizeWindowFill(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('lighting.overrides.windowFill', 'deve ser um objeto');
  checkKeys(raw, WINDOW_FILL_KEYS, 'lighting.overrides.windowFill');
  const partial = {};
  if (raw.enabled !== undefined) partial.enabled = boolean(raw.enabled, 'lighting.overrides.windowFill.enabled', true);
  if (raw.energy !== undefined) partial.energy = number(raw.energy, 'lighting.overrides.windowFill.energy', 900, 0, 100000);
  if (raw.size !== undefined) partial.size = number(raw.size, 'lighting.overrides.windowFill.size', 2.8, 0.05, 20);
  if (raw.color !== undefined) partial.color = color(raw.color, 'lighting.overrides.windowFill.color', [0.85, 0.92, 1]);
  return partial;
}

function normalizeFixture(raw, context, materials) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, FIXTURE_KEYS, context);
  const type = string(raw.type, `${context}.type`, undefined, { max: 10 }).toUpperCase();
  if (!['AREA', 'POINT', 'SPOT'].includes(type)) fail(`${context}.type`, 'use AREA, POINT ou SPOT (sol e céu vêm do preset)');
  return {
    id: id(raw.id, `${context}.id`, `luz-${context.replace(/[^0-9]/g, '') || '1'}`),
    type,
    position: vector3(raw.position, `${context}.position`, undefined),
    size: number(raw.size, `${context}.size`, 0.4, 0.001, 25),
    watts: number(raw.watts, `${context}.watts`, undefined, 0, 10000),
    color: color(raw.color, `${context}.color`, [1.0, 0.86, 0.72]),
    target: raw.target === undefined || raw.target === null ? null : vector3(raw.target, `${context}.target`),
    enabled: boolean(raw.enabled, `${context}.enabled`, true),
    spotSize: number(raw.spotSize, `${context}.spotSize`, 60, 1, 180),
    spotBlend: number(raw.spotBlend, `${context}.spotBlend`, 0.4, 0, 1),
  };
}

function normalizeLighting(raw, materials) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('lighting', 'deve ser um objeto');
  checkKeys(raw, LIGHTING_KEYS, 'lighting');
  const presetRaw = string(raw.preset, 'lighting.preset', 'day', { max: 20 }).toLowerCase();
  const preset = PRESET_ALIASES[presetRaw];
  if (!preset) fail('lighting.preset', `use um de: ${PRESET_NAMES.join(', ')} (ou dia/fim-de-tarde/noite)`);
  let hdri = null;
  if (raw.hdri !== undefined && raw.hdri !== null) {
    if (isObject(raw.hdri)) {
      const byPreset = {};
      for (const key of Object.keys(raw.hdri)) {
        if (!PRESET_NAMES.includes(key)) fail('lighting.hdri', `preset desconhecido em hdri: "${key}"`);
        byPreset[key] = string(raw.hdri[key], `lighting.hdri.${key}`, undefined, { max: 80 });
      }
      hdri = byPreset;
    } else {
      hdri = string(raw.hdri, 'lighting.hdri', undefined, { max: 80 });
    }
  }
  const overrides = raw.overrides === undefined || raw.overrides === null ? {} : raw.overrides;
  if (!isObject(overrides)) fail('lighting.overrides', 'deve ser um objeto');
  checkKeys(overrides, LIGHTING_OVERRIDE_KEYS, 'lighting.overrides');
  const normalizeOverrides = (source, context) => {
    if (!isObject(source)) fail(context, 'deve ser um objeto');
    checkKeys(source, LIGHTING_OVERRIDE_KEYS, context);
    return {
      sun: normalizeSun(source.sun),
      world: normalizeWorldOverride(source.world),
      windowFill: normalizeWindowFill(source.windowFill),
      exposure: source.exposure === undefined || source.exposure === null
        ? null
        : number(source.exposure, `${context}.exposure`, undefined, -8, 8),
    };
  };
  const byPreset = {};
  if (raw.overridesByPreset !== undefined && raw.overridesByPreset !== null) {
    if (!isObject(raw.overridesByPreset)) fail('lighting.overridesByPreset', 'deve ser um objeto {preset: overrides}');
    for (const key of Object.keys(raw.overridesByPreset)) {
      if (!PRESET_NAMES.includes(key)) fail('lighting.overridesByPreset', `preset desconhecido "${key}"`);
      byPreset[key] = normalizeOverrides(raw.overridesByPreset[key], `lighting.overridesByPreset.${key}`);
    }
  }
  const fixturesRaw = raw.interiorFixtures === undefined || raw.interiorFixtures === null ? [] : raw.interiorFixtures;
  if (!Array.isArray(fixturesRaw)) fail('lighting.interiorFixtures', 'deve ser uma lista');
  if (fixturesRaw.length > LIMITS.maxFixtures) fail('lighting.interiorFixtures', `limite de ${LIMITS.maxFixtures} luminárias`);
  const seen = new Set();
  const fixtures = fixturesRaw.map((fixture, index) => {
    const normalized = normalizeFixture(fixture, `lighting.interiorFixtures[${index}]`, materials);
    if (seen.has(normalized.id)) fail(`lighting.interiorFixtures[${index}].id`, `id duplicado "${normalized.id}"`);
    seen.add(normalized.id);
    return normalized;
  });
  return {
    preset,
    hdri,
    environmentRotation: number(raw.environmentRotation, 'lighting.environmentRotation', 0, -360, 360),
    overrides: normalizeOverrides(overrides, 'lighting.overrides'),
    overridesByPreset: byPreset,
    interiorFixtures: fixtures,
  };
}

function normalizeBackdrop(raw, materials) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('exterior.backdrop', 'deve ser um objeto');
  checkKeys(raw, BACKDROP_KEYS, 'exterior.backdrop');
  const facade = raw.facade;
  const hedge = raw.hedge;
  if (!isObject(facade)) fail('exterior.backdrop.facade', 'deve ser um objeto {material, distance, width, height}');
  checkKeys(facade, FACADE_KEYS, 'exterior.backdrop.facade');
  if (!isObject(hedge)) fail('exterior.backdrop.hedge', 'deve ser um objeto {material, width, height, depth, offset}');
  checkKeys(hedge, HEDGE_KEYS, 'exterior.backdrop.hedge');
  const facadeMaterial = string(facade.material, 'exterior.backdrop.facade.material', undefined, { max: 64 });
  const hedgeMaterial = string(hedge.material, 'exterior.backdrop.hedge.material', undefined, { max: 64 });
  if (!materials[facadeMaterial]) fail('exterior.backdrop.facade.material', `material "${facadeMaterial}" não existe em materials`);
  if (!materials[hedgeMaterial]) fail('exterior.backdrop.hedge.material', `material "${hedgeMaterial}" não existe em materials`);
  return {
    enabled: boolean(raw.enabled, 'exterior.backdrop.enabled', true),
    facade: {
      material: facadeMaterial,
      distance: number(facade.distance, 'exterior.backdrop.facade.distance', 6.5, 1, 40),
      width: number(facade.width, 'exterior.backdrop.facade.width', 18, 2, 80),
      height: number(facade.height, 'exterior.backdrop.facade.height', 9, 1, 40),
    },
    hedge: {
      material: hedgeMaterial,
      width: number(hedge.width, 'exterior.backdrop.hedge.width', 3.6, 0.2, 20),
      height: number(hedge.height, 'exterior.backdrop.hedge.height', 1.0, 0.1, 4),
      depth: number(hedge.depth, 'exterior.backdrop.hedge.depth', 0.7, 0.1, 5),
      offset: number(hedge.offset, 'exterior.backdrop.hedge.offset', 0.45, 0, 5),
    },
  };
}

function normalizeExterior(raw, materials) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('exterior', 'deve ser um objeto');
  checkKeys(raw, EXTERIOR_KEYS, 'exterior');
  const backdrop = normalizeBackdrop(raw.backdrop, materials);
  if (raw.balcony === undefined || raw.balcony === null) {
    return backdrop ? { balcony: null, backdrop } : null;
  }
  const balcony = raw.balcony;
  if (!isObject(balcony)) fail('exterior.balcony', 'deve ser um objeto');
  checkKeys(balcony, BALCONY_KEYS, 'exterior.balcony');
  const material = string(balcony.material, 'exterior.balcony.material', undefined, { max: 64 });
  if (!materials[material]) fail('exterior.balcony.material', `material "${material}" não existe em materials`);
  return {
    balcony: {
      enabled: boolean(balcony.enabled, 'exterior.balcony.enabled', true),
      depth: number(balcony.depth, 'exterior.balcony.depth', 1.1, 0.2, 5),
      railingHeight: number(balcony.railingHeight, 'exterior.balcony.railingHeight', 1.05, 0.2, 2),
      bars: integer(balcony.bars, 'exterior.balcony.bars', 11, 0, 60),
      material,
    },
    backdrop,
  };
}

function normalizeRender(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('render', 'deve ser um objeto');
  checkKeys(raw, RENDER_KEYS, 'render');
  const resolution = raw.resolution === undefined || raw.resolution === null ? [1280, 854] : raw.resolution;
  if (!Array.isArray(resolution) || resolution.length !== 2) fail('render.resolution', 'deve ser [largura, altura]');
  const width = integer(resolution[0], 'render.resolution[0]', undefined, 64, 8192);
  const height = integer(resolution[1], 'render.resolution[1]', undefined, 64, 8192);
  if (width * height > 50_000_000) fail('render.resolution', 'máximo de 50 megapixels');
  const preview = raw.preview === undefined || raw.preview === null ? {} : raw.preview;
  if (!isObject(preview)) fail('render.preview', 'deve ser um objeto');
  const render = raw.render === undefined || raw.render === null ? {} : raw.render;
  if (!isObject(render)) fail('render.render', 'deve ser um objeto');
  const colorManagement = raw.colorManagement === undefined || raw.colorManagement === null ? {} : raw.colorManagement;
  if (!isObject(colorManagement)) fail('render.colorManagement', 'deve ser um objeto');
  const output = raw.output === undefined || raw.output === null ? {} : raw.output;
  if (!isObject(output)) fail('render.output', 'deve ser um objeto');
  const format = string(output.format, 'render.output.format', 'PNG', { max: 6 }).toUpperCase();
  if (!['PNG', 'JPEG', 'EXR'].includes(format)) fail('render.output.format', 'use PNG, JPEG ou EXR');
  return {
    engine: string(raw.engine, 'render.engine', 'CYCLES', { max: 30 }).toUpperCase(),
    samples: integer(raw.samples, 'render.samples', 256, 1, 100000),
    resolution: [width, height],
    preview: {
      maxSize: integer(preview.maxSize, 'render.preview.maxSize', 640, 64, 4096),
      samples: integer(preview.samples, 'render.preview.samples', 64, 1, 100000),
    },
    render: {
      device: string(render.device, 'render.render.device', 'GPU', { max: 10 }).toUpperCase(),
      adaptive: boolean(render.adaptive, 'render.render.adaptive', true),
      denoise: boolean(render.denoise, 'render.render.denoise', true),
      maxBounces: integer(render.maxBounces, 'render.render.maxBounces', 10, 1, 64),
    },
    colorManagement: {
      viewTransform: string(colorManagement.viewTransform, 'render.colorManagement.viewTransform', 'AgX', { max: 30 }),
      look: string(colorManagement.look, 'render.colorManagement.look', 'AgX - Medium High Contrast', { max: 60 }),
      exposure: number(colorManagement.exposure, 'render.colorManagement.exposure', 0, -16, 16),
    },
    output: {
      format,
      transparent: boolean(output.transparent, 'render.output.transparent', false),
      colorDepth: string(output.colorDepth, 'render.output.colorDepth', format === 'EXR' ? '32' : '16', { max: 4 }),
    },
  };
}

function normalizeRegions(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('evaluation.regions', 'deve ser uma lista');
  if (raw.length > LIMITS.maxRegions) fail('evaluation.regions', `limite de ${LIMITS.maxRegions} regiões`);
  const seen = new Set();
  return raw.map((region, index) => {
    const context = `evaluation.regions[${index}]`;
    if (!isObject(region)) fail(context, 'deve ser um objeto');
    checkKeys(region, REGION_KEYS, context);
    const regionId = id(region.id, `${context}.id`, `regiao-${index + 1}`);
    if (seen.has(regionId)) fail(`${context}.id`, `id duplicado "${regionId}"`);
    seen.add(regionId);
    const rect = region.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((item) => typeof item === 'number' && Number.isFinite(item))) {
      fail(`${context}.rect`, 'deve ser [x, y, largura, altura] normalizado (0..1, origem no canto superior esquerdo)');
    }
    const [x, y, w, h] = rect;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) {
      fail(`${context}.rect`, 'retângulo precisa caber em 0..1');
    }
    return {
      id: regionId,
      label: string(region.label, `${context}.label`, regionId, { max: 80 }),
      rect: rect.slice(),
    };
  });
}

function normalizeThresholds(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('evaluation.thresholds', 'deve ser um objeto');
  checkKeys(raw, THRESHOLD_KEYS, 'evaluation.thresholds');
  return {
    ssimMin: number(raw.ssimMin, 'evaluation.thresholds.ssimMin', 0.5, -1, 1),
    deltaE00Max: number(raw.deltaE00Max, 'evaluation.thresholds.deltaE00Max', 20, 0, 100),
    deltaE00RegionMax: number(raw.deltaE00RegionMax, 'evaluation.thresholds.deltaE00RegionMax', 28, 0, 100),
    histogramMax: number(raw.histogramMax, 'evaluation.thresholds.histogramMax', 0.35, 0, 1),
    iouMin: number(raw.iouMin, 'evaluation.thresholds.iouMin', 0.6, 0, 1),
  };
}

function normalizeEvaluation(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('evaluation', 'deve ser um objeto');
  checkKeys(raw, EVALUATION_KEYS, 'evaluation');
  return {
    reference: string(raw.reference, 'evaluation.reference', undefined, { max: 500 }),
    referenceMask: raw.referenceMask === undefined || raw.referenceMask === null
      ? null
      : string(raw.referenceMask, 'evaluation.referenceMask', undefined, { max: 500 }),
    requireMasks: boolean(raw.requireMasks, 'evaluation.requireMasks', false),
    regions: normalizeRegions(raw.regions),
    thresholds: normalizeThresholds(raw.thresholds),
    histogramBins: integer(raw.histogramBins, 'evaluation.histogramBins', 16, 4, 256),
    maxEvalSize: integer(raw.maxEvalSize, 'evaluation.maxEvalSize', 512, 64, 4096),
    notes: raw.notes === undefined || raw.notes === null ? null : string(raw.notes, 'evaluation.notes', undefined, { max: 2000 }),
  };
}

function validateRoomPlan(raw) {
  if (!isObject(raw)) fail('room plan', 'deve ser um objeto JSON');
  checkKeys(raw, TOP_LEVEL_KEYS, 'room plan');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== null && raw.schemaVersion !== ROOM_SCHEMA_VERSION) {
    fail('schemaVersion', `apenas ${ROOM_SCHEMA_VERSION} é aceito; recebi ${raw.schemaVersion}`);
  }
  const materials = normalizeMaterials(raw.materials);
  const room = normalizeRoom(raw.room, materials);
  const furniture = normalizeFurniture(raw.furniture, materials);
  const assets = normalizeAssets(raw.assets, materials);
  const lighting = normalizeLighting(raw.lighting, materials);
  const exterior = normalizeExterior(raw.exterior, materials);
  const camera = normalizeCamera(raw.camera);
  const render = normalizeRender(raw.render);
  const evaluation = normalizeEvaluation(raw.evaluation);

  return {
    schemaVersion: ROOM_SCHEMA_VERSION,
    name: string(raw.name, 'name', 'Sala sem nome', { max: 120 }),
    description: raw.description === undefined || raw.description === null
      ? null
      : string(raw.description, 'description', undefined, { max: 2000 }),
    room,
    exterior,
    materials,
    furniture,
    assets,
    lighting,
    camera,
    render,
    evaluation,
    reference: normalizeReference(raw.reference),
  };
}

/** Converte um preset (JSON em light-rig-presets.json) para um resolvedor. */
function normalizePreset(name, raw) {
  if (!isObject(raw)) fail(`light-rig-presets.${name}`, 'deve ser um objeto');
  const sun = raw.sun === undefined || raw.sun === null ? null : raw.sun;
  if (!sun || !isObject(sun)) fail(`light-rig-presets.${name}.sun`, 'deve ser um objeto');
  const world = raw.world === undefined || raw.world === null ? {} : raw.world;
  if (!isObject(world)) fail(`light-rig-presets.${name}.world`, 'deve ser um objeto');
  const windowFill = raw.windowFill === undefined || raw.windowFill === null ? {} : raw.windowFill;
  if (!isObject(windowFill)) fail(`light-rig-presets.${name}.windowFill`, 'deve ser um objeto');
  return {
    label: string(raw.label, `light-rig-presets.${name}.label`, name, { max: 80 }),
    exposure: number(raw.exposure, `light-rig-presets.${name}.exposure`, 0, -8, 8),
    sun: {
      enabled: boolean(sun.enabled, `light-rig-presets.${name}.sun.enabled`, true),
      strength: number(sun.strength, `light-rig-presets.${name}.sun.strength`, 4, 0, 1000),
      color: color(sun.color, `light-rig-presets.${name}.sun.color`, '#fff2e0'),
      angle: number(sun.angle, `light-rig-presets.${name}.sun.angle`, 0.8, 0, 180),
      azimuth: number(sun.azimuth, `light-rig-presets.${name}.sun.azimuth`, 150, 0, 360),
      elevation: number(sun.elevation, `light-rig-presets.${name}.sun.elevation`, 30, -10, 90),
    },
    world: {
      kind: string(world.kind, `light-rig-presets.${name}.world.kind`, 'hdri', { max: 10 }).toLowerCase(),
      color: color(world.color, `light-rig-presets.${name}.world.color`, '#101014'),
      strength: number(world.strength, `light-rig-presets.${name}.world.strength`, 1, 0, 1000),
    },
    windowFill: {
      enabled: boolean(windowFill.enabled, `light-rig-presets.${name}.windowFill.enabled`, true),
      energy: number(windowFill.energy, `light-rig-presets.${name}.windowFill.energy`, 900, 0, 100000),
      size: number(windowFill.size, `light-rig-presets.${name}.windowFill.size`, 2.8, 0.05, 20),
      color: color(windowFill.color, `light-rig-presets.${name}.windowFill.color`, '#eaf3ff'),
    },
    interiorMultiplier: number(raw.interiorMultiplier, `light-rig-presets.${name}.interiorMultiplier`, 0, 0, 2),
  };
}

function validatePresets(raw) {
  if (!isObject(raw)) fail('light-rig-presets', 'deve ser um objeto');
  if (raw.schemaVersion !== PRESETS_VERSION) fail('light-rig-presets.schemaVersion', `esperava ${PRESETS_VERSION}`);
  if (!isObject(raw.presets)) fail('light-rig-presets.presets', 'deve ser um objeto {nome: preset}');
  const presets = {};
  for (const name of PRESET_NAMES) {
    if (!isObject(raw.presets[name])) fail('light-rig-presets.presets', `falta o preset "${name}"`);
    presets[name] = normalizePreset(name, raw.presets[name]);
  }
  for (const name of Object.keys(raw.presets)) {
    if (!PRESET_NAMES.includes(name)) fail('light-rig-presets.presets', `preset desconhecido "${name}"`);
  }
  return { schemaVersion: PRESETS_VERSION, presets };
}

/** Direção do sol (do centro da sala para o sol) no referencial do Blender. */
function sunVector(azimuthDegrees, elevationDegrees) {
  const azimuth = (azimuthDegrees * Math.PI) / 180;
  const elevation = (elevationDegrees * Math.PI) / 180;
  // azimute 0 = norte (-Y), 90 = leste (+X)
  return [Math.sin(azimuth) * Math.cos(elevation), -Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation)];
}

function firstWindow(room) {
  const order = ['north', 'south', 'east', 'west'];
  for (const side of order) {
    const wall = room.walls.find((item) => item.side === side);
    const opening = wall.openings.find((item) => item.type === 'window');
    if (opening) return { wall, opening };
  }
  return null;
}

/** Centro da abertura em coordenadas de mundo (z = centro vertical). */
function openingCenter(room, side, opening) {
  const { width, depth, height } = room.interior;
  if (side === 'north' || side === 'south') {
    const x = -width / 2 + opening.u + opening.width / 2;
    const y = side === 'north' ? -depth / 2 : depth / 2;
    return [x, y, opening.bottom + opening.height / 2];
  }
  const y = -depth / 2 + opening.u + opening.width / 2;
  const x = side === 'east' ? width / 2 : -width / 2;
  return [x, y, opening.bottom + opening.height / 2];
}

/**
 * Resolve o light rig: preset + overrides do room plan + luminárias internas.
 * Devolve também o sol em coordenadas de cena e um "windowFill" posicionado
 * fora da primeira janela, apontando para dentro.
 */
function resolveLighting(lighting, room, presets) {
  const preset = presets.presets[lighting.preset];
  if (!preset) fail('lighting.preset', `preset "${lighting.preset}" não existe`);
  const overrides = lighting.overrides || {};
  const sun = { ...preset.sun };
  if (overrides.sun) Object.assign(sun, overrides.sun);
  const world = { ...preset.world };
  if (overrides.world) Object.assign(world, overrides.world);
  const specific = (lighting.overridesByPreset && lighting.overridesByPreset[lighting.preset]) || {};
  if (specific.sun) Object.assign(sun, specific.sun);
  if (specific.world) Object.assign(world, specific.world);
  const windowFill = { ...preset.windowFill };
  if (overrides.windowFill) Object.assign(windowFill, overrides.windowFill);
  if (specific.windowFill) Object.assign(windowFill, specific.windowFill);
  const exposure = specific.exposure !== undefined && specific.exposure !== null
    ? specific.exposure
    : overrides.exposure !== undefined && overrides.exposure !== null
      ? overrides.exposure
      : preset.exposure;
  const interiorMultiplier = preset.interiorMultiplier;

  const roomCenter = [0, 0, room.interior.height * 0.45];
  const sunDirection = sunVector(sun.azimuth, sun.elevation);
  const sunDistance = 30;
  const sunPosition = [
    roomCenter[0] + sunDirection[0] * sunDistance,
    roomCenter[1] + sunDirection[1] * sunDistance,
    roomCenter[2] + sunDirection[2] * sunDistance,
  ];

  const window = firstWindow(room);
  let fillLight = null;
  if (windowFill.enabled && window) {
    const [cx, cy] = openingCenter(room, window.wall.side, window.opening);
    const inward = window.wall.side === 'north'
      ? [0, 1]
      : window.wall.side === 'south'
        ? [0, -1]
        : window.wall.side === 'east'
          ? [-1, 0]
          : [1, 0];
    fillLight = {
      name: 'ceu-janela',
      type: 'AREA',
      position: [cx + inward[0] * 0.35, cy + inward[1] * 0.35, window.opening.bottom + window.opening.height * 0.55],
      energy: windowFill.energy,
      size: Math.max(0.5, Math.min(windowFill.size, Math.max(window.opening.width, window.opening.height))),
      color: windowFill.color,
      target: [0, 0, room.interior.height * 0.35],
    };
  }

  const fixtures = lighting.interiorFixtures
    .filter((fixture) => fixture.enabled && fixture.watts > 0 && interiorMultiplier > 0)
    .map((fixture) => ({
      name: `luminaria-${fixture.id}`,
      type: fixture.type,
      position: fixture.position,
      energy: fixture.watts * interiorMultiplier,
      size: fixture.size,
      color: fixture.color,
      target: fixture.target || [0, 0, room.interior.height * 0.35],
      spotSize: fixture.spotSize,
      spotBlend: fixture.spotBlend,
    }));

  const lights = [];
  if (sun.enabled) {
    lights.push({
      name: 'sol',
      type: 'SUN',
      position: sunPosition,
      energy: sun.strength,
      size: 0.5,
      angle: sun.angle,
      color: sun.color,
      target: roomCenter,
    });
  }
  if (fillLight) lights.push({ ...fillLight, angle: 0.526 });
  for (const fixture of fixtures) lights.push({ ...fixture, angle: 0.526 });

  return {
    preset: lighting.preset,
    label: preset.label,
    exposure,
    interiorMultiplier,
    sun: { ...sun, position: sunPosition, direction: sunDirection, target: roomCenter },
    world: {
      ...world,
      hdri: typeof lighting.hdri === 'string'
        ? lighting.hdri
        : (lighting.hdri ? lighting.hdri[lighting.preset] ?? null : null),
      rotation: lighting.environmentRotation,
    },
    windowFill: fillLight ? { ...windowFill, light: fillLight } : { ...windowFill, light: null },
    fixtures,
    lights,
  };
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundVector(vector, digits = 6) {
  return vector.map((value) => round(value, digits));
}

/** Resolvedor compacto usado por testes, CLI e (futuro) servidor. */
function resolveRoomPlan(raw, { presets } = {}) {
  const plan = validateRoomPlan(raw);
  const computed = resolveLighting(plan.lighting, plan.room, presets);
  const walls = plan.room.walls.map((wall) => ({
    side: wall.side,
    material: wall.material,
    length: round(wall.length, 6),
    openings: wall.openings.map((opening) => ({
      id: opening.id,
      type: opening.type,
      u: round(opening.u, 6),
      bottom: round(opening.bottom, 6),
      width: round(opening.width, 6),
      height: round(opening.height, 6),
      center: roundVector(openingCenter(plan.room, wall.side, opening)),
      frameMaterial: opening.frameMaterial,
      glass: opening.glass,
      glassMaterial: opening.glassMaterial,
    })),
  }));
  return {
    schemaVersion: ROOM_SCHEMA_VERSION,
    name: plan.name,
    room: {
      interior: { ...plan.room.interior },
      wallThickness: plan.room.wallThickness,
      floor: { ...plan.room.floor },
      ceiling: { ...plan.room.ceiling },
    },
    walls,
    furniture: plan.furniture.map((item) => ({
      id: item.id,
      shape: item.shape,
      size: roundVector(item.size),
      position: roundVector(item.position),
      rotation: roundVector(item.rotation),
      material: item.material,
      bevel: round(item.bevel, 6),
      support: item.support,
      collisionGroup: item.collisionGroup,
      detail: item.detail,
    })),
    assets: plan.assets.map((item) => ({
      id: item.id,
      assetId: item.assetId,
      position: roundVector(item.position),
      rotation: roundVector(item.rotation),
      scale: round(item.scale, 6),
      fitHeight: item.fitHeight,
      anchor: item.anchor,
      snapToFloor: item.snapToFloor,
      materialOverride: item.materialOverride,
      support: item.support,
    })),
    lighting: {
      preset: computed.preset,
      label: computed.label,
      exposure: computed.exposure,
      interiorMultiplier: computed.interiorMultiplier,
      world: {
        kind: computed.world.kind,
        hdri: computed.world.hdri,
        strength: round(computed.world.strength, 6),
        rotation: round(computed.world.rotation, 6),
      },
      lights: computed.lights.map((light) => ({
        name: light.name,
        type: light.type,
        position: roundVector(light.position),
        energy: round(light.energy, 6),
        size: round(light.size, 6),
        color: roundVector(light.color),
        target: light.target ? roundVector(light.target) : null,
      })),
    },
    camera: plan.camera,
    render: plan.render,
    evaluation: plan.evaluation,
    reference: plan.reference,
    exterior: plan.exterior,
    summary: {
      walls: walls.length,
      openings: walls.reduce((total, wall) => total + wall.openings.length, 0),
      furniture: plan.furniture.length,
      assets: plan.assets.length,
      lights: computed.lights.length,
      preset: computed.preset,
      exposure: computed.exposure,
    },
  };
}

module.exports = {
  ROOM_SCHEMA_VERSION,
  PRESETS_VERSION,
  SIDES,
  PRESET_NAMES,
  LIMITS,
  DEFAULTS,
  ValidationError,
  validateRoomPlan,
  validatePresets,
  resolveRoomPlan,
  resolveLighting,
  sunVector,
  openingCenter,
};
