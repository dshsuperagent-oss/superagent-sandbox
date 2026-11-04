'use strict';

/**
 * Validação e normalização do schema v1 do Blender Director.
 *
 * A ideia é falhar cedo (no POST /jobs) com uma mensagem útil em português,
 * em vez de deixar o Blender estourar no meio do render. O spec normalizado é
 * o que fica salvo em runs/<job>/spec.json e o que build.py consome.
 */

class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details.length > 0 ? details : [message];
    this.statusCode = 400;
  }
}

const LIMITS = Object.freeze({
  maxObjects: 200,
  maxMaterials: 64,
  maxLights: 32,
  maxVertices: 200000,
  maxFaces: 200000,
  maxBodyBytes: 1024 * 1024,
  maxResolution: 8192,
  maxPixels: 50_000_000,
  maxLogs: 200,
  maxPreviewSize: 4096,
});

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'name',
  'engine',
  'samples',
  'resolution',
  'preview',
  'colorManagement',
  'render',
  'camera',
  'world',
  'objects',
  'materials',
  'lights',
  'output',
];

const OBJECT_KEYS = ['name', 'primitive', 'mesh', 'transform', 'material', 'modifiers', 'geometryNodes', 'smooth'];
const TRANSFORM_KEYS = ['loc', 'rot', 'scale'];
const MESH_KEYS = ['verts', 'faces'];
const MATERIAL_KEYS = [
  'baseColor',
  'metallic',
  'roughness',
  'ior',
  'transmission',
  'subsurface',
  'coat',
  'sheen',
  'anisotropy',
  'emission',
  'normal',
  'textures',
];
const EMISSION_KEYS = ['color', 'strength'];
const TEXTURE_KEYS = ['type', 'scale', 'detail', 'roughness', 'distortion', 'color1', 'color2', 'path', 'projection'];
const NORMAL_KEYS = ['type', 'strength', 'scale', 'path'];
const LIGHT_KEYS = ['name', 'type', 'position', 'energy', 'size', 'color', 'target', 'spotSize', 'spotBlend', 'angle', 'rotation'];
const CAMERA_KEYS = ['location', 'target', 'rotation', 'lens', 'sensorWidth', 'fstop', 'focus', 'focusDistance', 'motionBlur'];
const WORLD_KEYS = ['color', 'strength', 'hdri'];
const PREVIEW_KEYS = ['maxSize', 'samples'];
const COLOR_MANAGEMENT_KEYS = ['viewTransform', 'look', 'exposure'];
const RENDER_KEYS = ['device', 'adaptive', 'denoise', 'maxBounces'];
const OUTPUT_KEYS = ['format', 'transparent', 'colorDepth'];
const GEOMETRY_NODES_KEYS = ['preset', 'count', 'radius', 'seed', 'material'];
const MODIFIER_KEYS = {
  bevel: ['type', 'width', 'segments'],
  subsurf: ['type', 'levels', 'renderLevels'],
  boolean: ['type', 'target', 'operation'],
  solidify: ['type', 'thickness', 'offset'],
  array: ['type', 'count', 'offset'],
};
const PRIMITIVES = ['cube', 'sphere', 'cylinder', 'plane', 'cone', 'torus'];
const LIGHT_TYPES = ['POINT', 'SUN', 'AREA', 'SPOT'];
const LIGHT_TYPE_ALIASES = { POINT: 'POINT', SUN: 'SUN', AREA: 'AREA', SPOT: 'SPOT' };
const OUTPUT_FORMATS = ['PNG', 'JPEG', 'EXR'];
const TEXTURE_TYPES = ['noise', 'voronoi', 'wave', 'checker', 'image'];
const BOOLEAN_OPERATIONS = ['DIFFERENCE', 'UNION', 'INTERSECT'];

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

function normalizeString(value, context, fallback, { max = 200, pattern = null } = {}) {
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

function normalizeNumber(value, context, fallback, min = -Infinity, max = Infinity) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(context, 'é obrigatório');
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(context, 'deve ser um número finito');
  if (value < min || value > max) fail(context, `deve estar entre ${min} e ${max}`);
  return value;
}

function normalizeInteger(value, context, fallback, min, max) {
  const number = normalizeNumber(value, context, fallback, min, max);
  if (!Number.isInteger(number)) fail(context, 'deve ser um inteiro');
  return number;
}

function normalizeBoolean(value, context, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail(context, 'deve ser true ou false');
  return value;
}

function srgbChannelToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * Cores: string "#rrggbb" é interpretada como sRGB e convertida para linear
 * (que é o que o Principled BSDF espera). Arrays [r,g,b] já são lineares.
 */
function normalizeColor(value, context, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(context, 'é obrigatório');
    return fallback.slice();
  }
  if (typeof value === 'string') {
    const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
    if (!match) fail(context, 'cor hex deve ter o formato #rrggbb');
    const integer = parseInt(match[1], 16);
    return [
      srgbChannelToLinear(((integer >> 16) & 0xff) / 255),
      srgbChannelToLinear(((integer >> 8) & 0xff) / 255),
      srgbChannelToLinear((integer & 0xff) / 255),
    ];
  }
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && item >= 0 && item <= 1)) {
    return value.slice();
  }
  fail(context, 'cor deve ser "#rrggbb" (sRGB) ou [r,g,b] linear entre 0 e 1');
}

function normalizeVector3(value, context, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(context, 'é obrigatório');
    return fallback.slice();
  }
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    fail(context, 'deve ser [x, y, z] com números finitos');
  }
  return value.slice();
}

function normalizeTransform(raw, context) {
  if (raw === undefined || raw === null) {
    return { loc: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
  }
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, TRANSFORM_KEYS, context);
  const loc = normalizeVector3(raw.loc, `${context}.loc`, [0, 0, 0]);
  const rot = normalizeVector3(raw.rot, `${context}.rot`, [0, 0, 0]);
  const scale = normalizeVector3(raw.scale, `${context}.scale`, [1, 1, 1]);
  if (scale.some((value) => value === 0)) fail(`${context}.scale`, 'não pode ter componente zero');
  return { loc, rot, scale };
}

function normalizeMesh(raw, context) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto com verts e faces');
  checkKeys(raw, MESH_KEYS, context);
  if (!Array.isArray(raw.verts) || raw.verts.length < 3) fail(`${context}.verts`, 'precisa de pelo menos 3 vértices');
  if (raw.verts.length > LIMITS.maxVertices) fail(`${context}.verts`, `limite de ${LIMITS.maxVertices} vértices`);
  const verts = raw.verts.map((vertex, index) => {
    if (!Array.isArray(vertex) || vertex.length !== 3 || !vertex.every((item) => typeof item === 'number' && Number.isFinite(item))) {
      fail(`${context}.verts[${index}]`, 'deve ser [x, y, z]');
    }
    return vertex.slice();
  });
  if (!Array.isArray(raw.faces) || raw.faces.length < 1) fail(`${context}.faces`, 'precisa de pelo menos 1 face');
  if (raw.faces.length > LIMITS.maxFaces) fail(`${context}.faces`, `limite de ${LIMITS.maxFaces} faces`);
  const faces = raw.faces.map((face, index) => {
    if (!Array.isArray(face) || face.length < 3) fail(`${context}.faces[${index}]`, 'cada face precisa de pelo menos 3 índices');
    return face.map((item, vertexIndex) => {
      if (!Number.isInteger(item) || item < 0 || item >= verts.length) {
        fail(`${context}.faces[${index}][${vertexIndex}]`, `índice de vértice inválido: ${item}`);
      }
      return item;
    });
  });
  return { verts, faces };
}

function normalizeTexture(raw, context) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, TEXTURE_KEYS, context);
  const type = normalizeString(raw.type, `${context}.type`, undefined, { max: 20 }).toLowerCase();
  if (!TEXTURE_TYPES.includes(type)) fail(`${context}.type`, `use um de: ${TEXTURE_TYPES.join(', ')}`);
  const texture = {
    type,
    scale: normalizeNumber(raw.scale, `${context}.scale`, type === 'noise' ? 6 : 4, 0.001, 10000),
    detail: normalizeNumber(raw.detail, `${context}.detail`, 3, 0, 32),
    roughness: normalizeNumber(raw.roughness, `${context}.roughness`, 0.5, 0, 1),
    distortion: normalizeNumber(raw.distortion, `${context}.distortion`, 0, 0, 100),
    color1: normalizeColor(raw.color1, `${context}.color1`, [0.02, 0.02, 0.02]),
    color2: normalizeColor(raw.color2, `${context}.color2`, [0.8, 0.8, 0.8]),
    projection: normalizeString(raw.projection, `${context}.projection`, 'flat', { max: 10 }).toLowerCase(),
  };
  if (texture.projection !== 'flat' && texture.projection !== 'box') {
    fail(`${context}.projection`, 'use "flat" ou "box"');
  }
  if (type === 'image') {
    texture.path = normalizeString(raw.path, `${context}.path`, undefined, { max: 500 });
  } else if (raw.path !== undefined) {
    fail(`${context}.path`, 'só é aceito em texturas do tipo "image"');
  }
  return texture;
}

function normalizeNormal(raw, context) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    return { type: 'image', path: normalizeString(raw, context, undefined, { max: 500 }), strength: 0.5, scale: 20 };
  }
  if (!isObject(raw)) fail(context, 'deve ser um caminho de textura ou um objeto {type, ...}');
  checkKeys(raw, NORMAL_KEYS, context);
  const type = normalizeString(raw.type, `${context}.type`, 'bump', { max: 10 }).toLowerCase();
  if (type !== 'bump' && type !== 'image') fail(`${context}.type`, 'use "bump" ou "image"');
  const normal = {
    type,
    strength: normalizeNumber(raw.strength, `${context}.strength`, 0.5, 0, 4),
    scale: normalizeNumber(raw.scale, `${context}.scale`, 20, 0.001, 10000),
  };
  if (type === 'image') normal.path = normalizeString(raw.path, `${context}.path`, undefined, { max: 500 });
  return normal;
}

function normalizeEmission(raw, context) {
  if (raw === undefined || raw === null) return { color: [0, 0, 0], strength: 0 };
  if (!isObject(raw)) fail(context, 'deve ser {color, strength}');
  checkKeys(raw, EMISSION_KEYS, context);
  return {
    color: normalizeColor(raw.color, `${context}.color`, [0, 0, 0]),
    strength: normalizeNumber(raw.strength, `${context}.strength`, 0, 0, 100000),
  };
}

function normalizeMaterial(raw, context) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, MATERIAL_KEYS, context);
  const textures = raw.textures === undefined ? [] : raw.textures;
  if (!Array.isArray(textures)) fail(`${context}.textures`, 'deve ser uma lista');
  if (textures.length > 8) fail(`${context}.textures`, 'limite de 8 texturas por material');
  return {
    baseColor: normalizeColor(raw.baseColor, `${context}.baseColor`, [0.8, 0.8, 0.8]),
    metallic: normalizeNumber(raw.metallic, `${context}.metallic`, 0, 0, 1),
    roughness: normalizeNumber(raw.roughness, `${context}.roughness`, 0.5, 0, 1),
    ior: normalizeNumber(raw.ior, `${context}.ior`, 1.45, 1, 3),
    transmission: normalizeNumber(raw.transmission, `${context}.transmission`, 0, 0, 1),
    subsurface: normalizeNumber(raw.subsurface, `${context}.subsurface`, 0, 0, 1),
    coat: normalizeNumber(raw.coat, `${context}.coat`, 0, 0, 1),
    sheen: normalizeNumber(raw.sheen, `${context}.sheen`, 0, 0, 1),
    anisotropy: normalizeNumber(raw.anisotropy, `${context}.anisotropy`, 0, -1, 1),
    emission: normalizeEmission(raw.emission, `${context}.emission`),
    normal: normalizeNormal(raw.normal, `${context}.normal`),
    textures: textures.map((texture, index) => normalizeTexture(texture, `${context}.textures[${index}]`)),
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

function normalizeModifier(raw, context) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  const type = normalizeString(raw.type, `${context}.type`, undefined, { max: 20 }).toLowerCase();
  const allowed = MODIFIER_KEYS[type];
  if (!allowed) fail(`${context}.type`, `use um de: ${Object.keys(MODIFIER_KEYS).join(', ')}`);
  checkKeys(raw, allowed, context);
  if (type === 'bevel') {
    return {
      type,
      width: normalizeNumber(raw.width, `${context}.width`, 0.02, 0.0001, 10),
      segments: normalizeInteger(raw.segments, `${context}.segments`, 3, 1, 12),
    };
  }
  if (type === 'subsurf') {
    return {
      type,
      levels: normalizeInteger(raw.levels, `${context}.levels`, 2, 0, 6),
      renderLevels: normalizeInteger(raw.renderLevels, `${context}.renderLevels`, 2, 0, 6),
    };
  }
  if (type === 'boolean') {
    return {
      type,
      target: normalizeString(raw.target, `${context}.target`, undefined, { max: 120 }),
      operation: normalizeString(raw.operation, `${context}.operation`, 'DIFFERENCE', { max: 20 }).toUpperCase(),
    };
  }
  if (type === 'solidify') {
    return {
      type,
      thickness: normalizeNumber(raw.thickness, `${context}.thickness`, 0.02, 0.0001, 10),
      offset: normalizeNumber(raw.offset, `${context}.offset`, -1, -1, 1),
    };
  }
  return {
    type: 'array',
    count: normalizeInteger(raw.count, `${context}.count`, 3, 2, 1000),
    offset: normalizeVector3(raw.offset, `${context}.offset`, [1, 0, 0]),
  };
}

function normalizeGeometryNodes(raw, context) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, GEOMETRY_NODES_KEYS, context);
  const preset = normalizeString(raw.preset, `${context}.preset`, 'scatter', { max: 30 }).toLowerCase();
  if (preset !== 'scatter') fail(`${context}.preset`, 'nesta versão só o preset "scatter" é suportado');
  return {
    preset,
    count: normalizeInteger(raw.count, `${context}.count`, 100, 1, 50000),
    radius: normalizeNumber(raw.radius, `${context}.radius`, 0.05, 0.001, 10),
    seed: normalizeInteger(raw.seed, `${context}.seed`, 1, 0, 1000000),
    material: raw.material === undefined || raw.material === null ? null : normalizeString(raw.material, `${context}.material`, undefined, { max: 64 }),
  };
}

function normalizeObject(raw, context) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, OBJECT_KEYS, context);
  const hasPrimitive = raw.primitive !== undefined && raw.primitive !== null;
  const hasMesh = raw.mesh !== undefined && raw.mesh !== null;
  if (hasPrimitive === hasMesh) fail(context, 'informe exatamente um entre "primitive" e "mesh"');
  let primitive = null;
  let mesh = null;
  if (hasPrimitive) {
    primitive = normalizeString(raw.primitive, `${context}.primitive`, undefined, { max: 20 }).toLowerCase();
    if (!PRIMITIVES.includes(primitive)) fail(`${context}.primitive`, `use um de: ${PRIMITIVES.join(', ')}`);
  } else {
    mesh = normalizeMesh(raw.mesh, `${context}.mesh`);
  }
  const modifiers = raw.modifiers === undefined ? [] : raw.modifiers;
  if (!Array.isArray(modifiers)) fail(`${context}.modifiers`, 'deve ser uma lista');
  if (modifiers.length > 16) fail(`${context}.modifiers`, 'limite de 16 modificadores');
  return {
    name: normalizeString(raw.name, `${context}.name`, `objeto_${(context.match(/\d+/) || ['0'])[0]}`, { max: 120 }),
    primitive,
    mesh,
    transform: normalizeTransform(raw.transform, `${context}.transform`),
    material: raw.material === undefined || raw.material === null ? null : normalizeString(raw.material, `${context}.material`, undefined, { max: 64 }),
    modifiers: modifiers.map((modifier, index) => normalizeModifier(modifier, `${context}.modifiers[${index}]`)),
    geometryNodes: raw.geometryNodes === undefined || raw.geometryNodes === null ? null : normalizeGeometryNodes(raw.geometryNodes, `${context}.geometryNodes`),
    smooth: normalizeBoolean(raw.smooth, `${context}.smooth`, false),
  };
}

function normalizeLight(raw, context) {
  if (!isObject(raw)) fail(context, 'deve ser um objeto');
  checkKeys(raw, LIGHT_KEYS, context);
  const type = normalizeString(raw.type, `${context}.type`, undefined, { max: 20 }).toUpperCase();
  if (!LIGHT_TYPES.includes(type)) fail(`${context}.type`, `use um de: ${LIGHT_TYPES.join(', ')}`);
  const light = {
    name: normalizeString(raw.name, `${context}.name`, `luz_${(context.match(/\d+/) || ['0'])[0]}`, { max: 120 }),
    type: LIGHT_TYPE_ALIASES[type],
    position: normalizeVector3(raw.position, `${context}.position`, [0, 0, 3]),
    energy: normalizeNumber(raw.energy, `${context}.energy`, type === 'SUN' ? 3 : 100, 0, 1_000_000),
    size: normalizeNumber(raw.size, `${context}.size`, 1, 0.001, 1000),
    color: normalizeColor(raw.color, `${context}.color`, [1, 1, 1]),
    target: raw.target === undefined || raw.target === null ? null : normalizeVector3(raw.target, `${context}.target`),
    rotation: raw.rotation === undefined || raw.rotation === null ? null : normalizeVector3(raw.rotation, `${context}.rotation`),
    spotSize: normalizeNumber(raw.spotSize, `${context}.spotSize`, 45, 1, 180),
    spotBlend: normalizeNumber(raw.spotBlend, `${context}.spotBlend`, 0.15, 0, 1),
    angle: normalizeNumber(raw.angle, `${context}.angle`, 0.526, 0, 180),
  };
  if (light.target && light.rotation) fail(context, 'use "target" ou "rotation", não os dois');
  return light;
}

function normalizeCamera(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('camera', 'deve ser um objeto');
  checkKeys(raw, CAMERA_KEYS, 'camera');
  const rotation = raw.rotation === undefined || raw.rotation === null ? null : normalizeVector3(raw.rotation, 'camera.rotation');
  let target = raw.target === undefined || raw.target === null ? null : normalizeVector3(raw.target, 'camera.target');
  if (!rotation && !target) target = [0, 0, 0.9];
  if (rotation && target) fail('camera', 'use "target" ou "rotation", não os dois');
  const focus = normalizeString(raw.focus, 'camera.focus', 'target', { max: 10 }).toLowerCase();
  if (focus !== 'target' && focus !== 'none') fail('camera.focus', 'use "target" ou "none"');
  return {
    location: normalizeVector3(raw.location, 'camera.location', [4.5, -4.5, 2.8]),
    target,
    rotation,
    lens: normalizeNumber(raw.lens, 'camera.lens', 50, 8, 300),
    sensorWidth: normalizeNumber(raw.sensorWidth, 'camera.sensorWidth', 36, 1, 100),
    fstop: normalizeNumber(raw.fstop, 'camera.fstop', 4, 0.7, 64),
    focus,
    focusDistance: raw.focusDistance === undefined || raw.focusDistance === null ? null : normalizeNumber(raw.focusDistance, 'camera.focusDistance', undefined, 0.001, 1000),
    motionBlur: normalizeBoolean(raw.motionBlur, 'camera.motionBlur', false),
  };
}

function normalizeWorld(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('world', 'deve ser um objeto');
  checkKeys(raw, WORLD_KEYS, 'world');
  const hdri = raw.hdri === undefined || raw.hdri === null ? null : normalizeString(raw.hdri, 'world.hdri', undefined, { max: 500 });
  return {
    color: normalizeColor(raw.color, 'world.color', [0.02, 0.02, 0.025]),
    strength: normalizeNumber(raw.strength, 'world.strength', 1, 0, 1000),
    hdri,
  };
}

function normalizePreview(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('preview', 'deve ser um objeto');
  checkKeys(raw, PREVIEW_KEYS, 'preview');
  return {
    maxSize: normalizeInteger(raw.maxSize, 'preview.maxSize', 640, 64, LIMITS.maxPreviewSize),
    samples: normalizeInteger(raw.samples, 'preview.samples', 32, 1, 100000),
  };
}

function normalizeColorManagement(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('colorManagement', 'deve ser um objeto');
  checkKeys(raw, COLOR_MANAGEMENT_KEYS, 'colorManagement');
  return {
    viewTransform: normalizeString(raw.viewTransform, 'colorManagement.viewTransform', 'AgX', { max: 40 }),
    look: normalizeString(raw.look, 'colorManagement.look', 'None', { max: 60 }),
    exposure: normalizeNumber(raw.exposure, 'colorManagement.exposure', 0, -16, 16),
  };
}

function normalizeRender(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('render', 'deve ser um objeto');
  checkKeys(raw, RENDER_KEYS, 'render');
  return {
    device: normalizeString(raw.device, 'render.device', 'GPU', { max: 10 }).toUpperCase(),
    adaptive: normalizeBoolean(raw.adaptive, 'render.adaptive', true),
    denoise: normalizeBoolean(raw.denoise, 'render.denoise', true),
    maxBounces: normalizeInteger(raw.maxBounces, 'render.maxBounces', 8, 0, 64),
  };
}

function normalizeOutput(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) fail('output', 'deve ser um objeto');
  checkKeys(raw, OUTPUT_KEYS, 'output');
  const format = normalizeString(raw.format, 'output.format', 'PNG', { max: 10 }).toUpperCase();
  if (!OUTPUT_FORMATS.includes(format)) fail('output.format', `use um de: ${OUTPUT_FORMATS.join(', ')}`);
  const colorDepth = normalizeString(raw.colorDepth, 'output.colorDepth', format === 'PNG' ? '16' : '8', { max: 2 });
  if (colorDepth !== '8' && colorDepth !== '16') fail('output.colorDepth', 'use "8" ou "16"');
  return {
    format,
    transparent: normalizeBoolean(raw.transparent, 'output.transparent', false),
    colorDepth,
  };
}

function validateReferences(spec) {
  const names = new Set();
  for (let index = 0; index < spec.objects.length; index += 1) {
    const object = spec.objects[index];
    if (names.has(object.name)) fail(`objects[${index}].name`, `nome de objeto duplicado: "${object.name}"`);
    names.add(object.name);
  }
  for (let index = 0; index < spec.objects.length; index += 1) {
    const object = spec.objects[index];
    if (object.material && !spec.materials[object.material]) {
      fail(`objects[${index}].material`, `material "${object.material}" não existe em materials`);
    }
    if (object.geometryNodes && object.geometryNodes.material && !spec.materials[object.geometryNodes.material]) {
      fail(`objects[${index}].geometryNodes.material`, `material "${object.geometryNodes.material}" não existe em materials`);
    }
    for (let modifierIndex = 0; modifierIndex < object.modifiers.length; modifierIndex += 1) {
      const modifier = object.modifiers[modifierIndex];
      if (modifier.type === 'boolean') {
        if (!names.has(modifier.target)) {
          fail(`objects[${index}].modifiers[${modifierIndex}].target`, `objeto "${modifier.target}" não existe`);
        }
        if (modifier.target === object.name) {
          fail(`objects[${index}].modifiers[${modifierIndex}].target`, 'um objeto não pode aplicar boolean sobre si mesmo');
        }
        if (!BOOLEAN_OPERATIONS.includes(modifier.operation)) {
          fail(`objects[${index}].modifiers[${modifierIndex}].operation`, `use um de: ${BOOLEAN_OPERATIONS.join(', ')}`);
        }
      }
    }
  }
  return names;
}

function validateAndNormalize(input) {
  if (!isObject(input)) fail('spec', 'o corpo deve ser um objeto JSON');
  checkKeys(input, TOP_LEVEL_KEYS, 'spec');

  const schemaVersion = input.schemaVersion === undefined ? 1 : input.schemaVersion;
  if (schemaVersion !== 1) fail('schemaVersion', 'apenas a versão 1 do schema é suportada');

  const engineRaw = normalizeString(input.engine, 'engine', 'CYCLES', { max: 30 }).toUpperCase();
  let engine;
  if (engineRaw === 'CYCLES') engine = 'CYCLES';
  else if (engineRaw === 'EEVEE' || engineRaw === 'BLENDER_EEVEE_NEXT' || engineRaw === 'BLENDER_EEVEE') engine = 'BLENDER_EEVEE_NEXT';
  else fail('engine', 'use "CYCLES" ou "BLENDER_EEVEE_NEXT"');

  let resolution = [1200, 800];
  if (input.resolution !== undefined) {
    if (!Array.isArray(input.resolution) || input.resolution.length !== 2) fail('resolution', 'deve ser [largura, altura]');
    resolution = [
      normalizeInteger(input.resolution[0], 'resolution[0]', undefined, 64, LIMITS.maxResolution),
      normalizeInteger(input.resolution[1], 'resolution[1]', undefined, 64, LIMITS.maxResolution),
    ];
    if (resolution[0] * resolution[1] > LIMITS.maxPixels) {
      fail('resolution', `limite de ${LIMITS.maxPixels} pixels (${resolution[0]}x${resolution[1]})`);
    }
  }

  const objectsRaw = input.objects === undefined ? [] : input.objects;
  if (!Array.isArray(objectsRaw)) fail('objects', 'deve ser uma lista');
  if (objectsRaw.length === 0) fail('objects', 'a cena precisa de pelo menos 1 objeto');
  if (objectsRaw.length > LIMITS.maxObjects) fail('objects', `limite de ${LIMITS.maxObjects} objetos`);

  const lightsRaw = input.lights === undefined ? [] : input.lights;
  if (!Array.isArray(lightsRaw)) fail('lights', 'deve ser uma lista');
  if (lightsRaw.length > LIMITS.maxLights) fail('lights', `limite de ${LIMITS.maxLights} luzes`);

  const spec = {
    schemaVersion: 1,
    name: normalizeString(input.name, 'name', 'Cena sem nome', { max: 120 }),
    engine,
    samples: normalizeInteger(input.samples, 'samples', 128, 1, 100000),
    resolution,
    preview: normalizePreview(input.preview),
    colorManagement: normalizeColorManagement(input.colorManagement),
    render: normalizeRender(input.render),
    camera: normalizeCamera(input.camera),
    world: normalizeWorld(input.world),
    objects: objectsRaw.map((object, index) => normalizeObject(object, `objects[${index}]`)),
    materials: normalizeMaterials(input.materials),
    lights: lightsRaw.map((light, index) => normalizeLight(light, `lights[${index}]`)),
    output: normalizeOutput(input.output),
  };

  if (spec.render.device !== 'GPU' && spec.render.device !== 'CPU') {
    fail('render.device', 'use "GPU" ou "CPU"');
  }

  validateReferences(spec);

  const totalVertices = spec.objects.reduce((sum, object) => sum + (object.mesh ? object.mesh.verts.length : 0), 0);
  if (totalVertices > LIMITS.maxVertices) fail('objects', `limite total de ${LIMITS.maxVertices} vértices em meshes customizadas`);

  return spec;
}

/**
 * Aplica um comando incremental (schema v1) e devolve um novo spec normalizado.
 * Comandos só mexem no spec; o servidor decide quando re-renderizar o preview.
 */
function applyCommand(spec, command) {
  if (!isObject(command)) fail('comando', 'deve ser um objeto com "op"');
  const op = command.op;
  if (typeof op !== 'string' || op.length === 0) fail('comando.op', 'é obrigatório');

  if (op === 'add_light') {
    checkKeys(command, ['op', ...LIGHT_KEYS], 'comando add_light');
    if (spec.lights.length >= LIMITS.maxLights) fail('add_light', `limite de ${LIMITS.maxLights} luzes`);
    const { op: _ignored, ...rest } = command;
    const light = normalizeLight(rest, `lights[${spec.lights.length}]`);
    return { ...structuredClone(spec), lights: [...spec.lights, light] };
  }

  if (op === 'set_material') {
    checkKeys(command, ['op', 'name', 'material', ...MATERIAL_KEYS], 'comando set_material');
    const name = command.name === undefined ? command.material : command.name;
    if (typeof name !== 'string' || name.length === 0) fail('set_material.name', 'é obrigatório');
    if (!spec.materials[name]) {
      const available = Object.keys(spec.materials);
      fail('set_material.name', `material "${name}" não existe${available.length ? ` (disponíveis: ${available.join(', ')})` : ''}`);
    }
    const patch = { ...command };
    delete patch.op;
    delete patch.name;
    delete patch.material;
    if (patch.emission && typeof patch.emission === 'object' && !Array.isArray(patch.emission)) {
      patch.emission = { ...spec.materials[name].emission, ...patch.emission };
    }
    const merged = { ...structuredClone(spec.materials[name]), ...patch };
    const materials = { ...spec.materials, [name]: normalizeMaterial(merged, `materials.${name}`) };
    return { ...structuredClone(spec), materials };
  }

  if (op === 'move_camera') {
    checkKeys(command, ['op', ...CAMERA_KEYS], 'comando move_camera');
    const { op: _ignored, ...patch } = command;
    const camera = normalizeCamera({ ...structuredClone(spec.camera), ...patch });
    return { ...structuredClone(spec), camera };
  }

  fail('comando.op', `op desconhecido "${op}" (use add_light, set_material ou move_camera)`);
}

module.exports = {
  LIMITS,
  ValidationError,
  validateAndNormalize,
  applyCommand,
  // exportados para testes e para o servidor montar resumos
  normalizeLight,
  normalizeMaterial,
  normalizeCamera,
};
