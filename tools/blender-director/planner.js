'use strict';

/**
 * Planner determinístico do Blender Director v2 (fase 1).
 *
 * Transforma um pedido em linguagem natural em:
 *   1. um plano de cena (lista de etapas com o que fazer e o que verificar);
 *   2. um scene-spec v1 válido, pronto para `POST /jobs`.
 *
 * Regras, sem rede e sem dependência externa. Nenhuma API paga é chamada: o
 * gancho `opts.model` permite que a integração da v2 injete um plano vindo de
 * um modelo (ou de um cache), e o planner só o normaliza/valida.
 *
 * Contrato:
 *   plan(request, opts?) -> Plan
 *   planWithModel(request, opts?) -> Promise<Plan>   (hook assíncrono)
 *
 * `opts.model`:
 *   - função `({request, rules}) => planObject` (ou Promise, em planWithModel);
 *   - objeto `{ plan: (request, {rules}) => planObject }`.
 *   O plano devolvido pelo modelo pode sobrescrever `summary`, `subject`,
 *   `assumptions`, `ambiguities`, `steps` e `sceneSpec`. Campos ausentes herdam
 *   o plano determinístico; o sceneSpec final é sempre validado pelo schema v1.
 */

const { validateAndNormalize } = require('./lib/spec');

const PLAN_VERSION = 1;
const RULES_VERSION = '2026-11-04';

const DEFAULT_RESOLUTION = [1200, 800];
const METRIC_NAMES = ['ssim', 'deltaE', 'psnr'];

// ---------------------------------------------------------------------------
// Texto e sinais
// ---------------------------------------------------------------------------

function stripAccents(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(value) {
  return stripAccents(String(value)).toLowerCase();
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const COLOR_WORDS = [
  ['vermelho', '#b83a2f'],
  ['azul', '#2f6fb3'],
  ['verde', '#3f8f5a'],
  ['amarelo', '#e2b93b'],
  ['roxo', '#7143a8'],
  ['rosa', '#d9739b'],
  ['laranja', '#d97a2b'],
  ['dourado', '#d4af37'],
  ['ouro', '#d4af37'],
  ['prata', '#d8dde3'],
  ['cobre', '#b87333'],
  ['branco', '#f2f0ea'],
  ['preto', '#14161a'],
  ['cinza', '#8a8f98'],
  ['bege', '#d9cbb3'],
  ['marrom', '#7a5230'],
];

const MATERIAL_WORDS = [
  ['vidro', 'vidro'],
  ['transparente', 'vidro'],
  ['cristal', 'vidro'],
  ['metal', 'metal'],
  ['metalico', 'metal'],
  ['metalizado', 'metal'],
  ['ouro', 'ouro'],
  ['dourado', 'ouro'],
  ['prata', 'prata'],
  ['cobre', 'cobre'],
  ['madeira', 'madeira'],
  ['ceramica', 'ceramica'],
  ['porcelana', 'ceramica'],
  ['tecido', 'tecido'],
  ['veludo', 'tecido'],
  ['plastico', 'plastico'],
  ['emborrachado', 'borracha'],
];

const SUBJECTS = [
  {
    kind: 'logo',
    words: ['logo', 'logotipo', 'tipografia', 'texto', 'letreiro', 'marca', 'wordmark'],
    label: 'composição tipográfica',
    recipe: 'logo',
    confidence: 0.8,
  },
  {
    kind: 'character',
    words: ['personagem', 'robo', 'boneco', 'mascote', 'androide', 'criatura'],
    label: 'personagem simples',
    recipe: 'character',
    confidence: 0.8,
  },
  {
    kind: 'interior',
    words: ['interior', 'sala', 'quarto', 'cozinha', 'escritorio', 'loja', 'ambiente', 'apartamento'],
    label: 'interior',
    recipe: 'interior',
    confidence: 0.8,
  },
  {
    kind: 'landscape',
    words: ['paisagem', 'jardim', 'exterior', 'floresta', 'montanha', 'praia', 'campo'],
    label: 'paisagem',
    recipe: 'landscape',
    confidence: 0.75,
  },
  {
    kind: 'still-life',
    words: ['natureza morta', 'frutas', 'vaso', 'mesa posta', 'still life'],
    label: 'natureza morta',
    recipe: 'still-life',
    confidence: 0.78,
  },
  {
    kind: 'abstract',
    words: ['abstrato', 'escultura', 'organico', 'surreal', 'conceitual'],
    label: 'composição abstrata',
    recipe: 'abstract',
    confidence: 0.7,
  },
];

const PRODUCTS = [
  { words: ['perfume', 'frasco'], label: 'frasco de perfume', recipe: 'bottle' },
  { words: ['garrafa', 'vinho', 'cerveja'], label: 'garrafa', recipe: 'bottle' },
  { words: ['caneca', 'xicara', 'copo'], label: 'caneca', recipe: 'mug' },
  { words: ['relogio'], label: 'relógio de pulso', recipe: 'watch' },
  { words: ['tenis', 'sapato', 'chuteira'], label: 'tênis', recipe: 'shoe' },
  { words: ['fone', 'headphone', 'auricular'], label: 'fone de ouvido', recipe: 'headphone' },
  { words: ['jarra', 'bule', 'chaleira'], label: 'jarra', recipe: 'jar' },
  { words: ['lampada', 'luminaria'], label: 'luminária', recipe: 'lamp' },
];

const PRODUCT_WORDS = ['produto', 'embalagem', 'cosmetico', 'cosmeticos', 'skincare', 'ecommerce', 'e-commerce', 'catalogo'];

function detectSubject(text) {
  for (const subject of SUBJECTS) {
    if (hasAny(text, subject.words)) return { ...subject };
  }
  for (const product of PRODUCTS) {
    if (hasAny(text, product.words)) {
      return {
        kind: 'product',
        label: product.label,
        recipe: product.recipe,
        confidence: 0.82,
        explicitProduct: true,
      };
    }
  }
  if (hasAny(text, PRODUCT_WORDS)) {
    return { kind: 'product', label: 'produto de estúdio', recipe: 'generic', confidence: 0.6, explicitProduct: false };
  }
  return { kind: 'generic', label: 'objeto de estúdio', recipe: 'generic', confidence: 0.4, explicitProduct: false };
}

function detectOptions(text) {
  const options = {
    mood: 'clean',
    framing: 'three-quarter',
    background: 'dark',
    color: null,
    material: null,
    resolution: DEFAULT_RESOLUTION,
    realReference: false,
    wantsRealism: false,
    wantsStylized: false,
  };

  if (hasAny(text, ['fotorrealista', 'realista', 'foto real', 'hiper-realista', 'hiperrealista'])) {
    options.wantsRealism = true;
    options.mood = 'realistic';
  }
  if (hasAny(text, ['minimalista', 'clean', 'limpo', 'simples', 'suave', 'soft'])) options.mood = 'clean';
  if (hasAny(text, ['escur', 'dark', 'noturn', 'low key'])) options.mood = 'dark';
  if (hasAny(text, ['claro', 'luminoso', 'high key', 'alegre'])) options.mood = 'bright';
  if (hasAny(text, ['low poly', 'lowpoly', 'estilizado', 'cartoon', 'stylized'])) options.wantsStylized = true;
  if (hasAny(text, ['cinematograf', 'cinematic', 'dramatic', 'contrastad'])) options.mood = 'cinematic';
  if (hasAny(text, ['neon', 'cyberpunk', 'colorido'])) options.mood = 'neon';

  if (hasAny(text, ['macro', 'close-up', 'close up', 'detalhe', 'aproximad'])) options.framing = 'close';
  if (hasAny(text, ['amplo', 'ampla', 'wide', 'ambiente inteiro', 'panoram'])) options.framing = 'wide';
  if (hasAny(text, ['de cima', 'vista de cima', 'top-down', 'top down', 'aereo'])) options.framing = 'top';
  if (hasAny(text, ['contra-plongee', 'plongee', 'de baixo', 'heroico'])) options.framing = 'low';

  if (hasAny(text, ['fundo branco', 'fundo claro', 'fundo bege'])) options.background = 'white';
  else if (hasAny(text, ['fundo preto', 'fundo escuro'])) options.background = 'black';
  else if (hasAny(text, ['fundo cinza', 'fundo neutro'])) options.background = 'gray';
  else if (hasAny(text, ['estudio', 'studio', 'ciclorama'])) options.background = 'studio';
  else if (options.mood === 'dark') options.background = 'black';
  else if (options.mood === 'bright') options.background = 'white';

  // "fundo branco" e "luz branca" descrevem o ambiente, não a cor do objeto.
  const colorText = text
    .replace(/\bfundo\s+(branco|preto|cinza|bege|claro|escuro)\b/g, ' ')
    .replace(/\bluz\s+(branca|quente|fria|natural)\b/g, ' ');
  for (const [word, hex] of COLOR_WORDS) {
    if (colorText.includes(word)) {
      options.color = hex;
      break;
    }
  }
  for (const [word, material] of MATERIAL_WORDS) {
    if (text.includes(word)) {
      options.material = material;
      break;
    }
  }

  if (hasAny(text, ['quadrado', '1:1', 'formato quadrado'])) options.resolution = [1080, 1080];
  else if (hasAny(text, ['retrato', 'vertical', '9:16', 'stories'])) options.resolution = [1080, 1350];
  else if (hasAny(text, ['16:9', 'widescreen', 'horizontal'])) options.resolution = [1920, 1080];
  else if (hasAny(text, ['4k', 'ultra hd'])) options.resolution = [3840, 2160];

  options.realReference = hasAny(text, ['referencia', 'referência', 'foto anexa', 'imagem anexa', 'como esta foto', 'igual a foto']);

  return options;
}

// ---------------------------------------------------------------------------
// Cena
// ---------------------------------------------------------------------------

const MATERIAL_LIBRARY = {
  vidro: { baseColor: '#eaf2f5', metallic: 0, roughness: 0.06, transmission: 0.92, ior: 1.5 },
  metal: { baseColor: '#b9c0c7', metallic: 1, roughness: 0.22 },
  ouro: { baseColor: '#d4af37', metallic: 1, roughness: 0.18 },
  prata: { baseColor: '#d8dde3', metallic: 1, roughness: 0.14 },
  cobre: { baseColor: '#b87333', metallic: 1, roughness: 0.25 },
  madeira: { baseColor: '#7a5230', metallic: 0, roughness: 0.55, textures: [{ type: 'noise', scale: 8, color1: '#4f321a', color2: '#9a6a3f' }] },
  ceramica: { baseColor: '#e8e2d6', metallic: 0, roughness: 0.28 },
  tecido: { baseColor: '#7c7f86', metallic: 0, roughness: 0.88 },
  borracha: { baseColor: '#26282c', metallic: 0, roughness: 0.92 },
  plastico: { baseColor: '#d9d9d9', metallic: 0.05, roughness: 0.32 },
  pedra: { baseColor: '#8d8b85', metallic: 0, roughness: 0.62, textures: [{ type: 'noise', scale: 14, color1: '#6f6d67', color2: '#a5a29a' }] },
};

function material(name, hex, extra = {}) {
  return { baseColor: hex, metallic: 0, roughness: 0.4, ...extra };
}

function primaryMaterial(options) {
  const name = options.material || 'ceramica';
  const base = MATERIAL_LIBRARY[name] || MATERIAL_LIBRARY.ceramica;
  const hex = options.color || base.baseColor;
  return { name, spec: { ...base, baseColor: hex } };
}

function floorMaterial(options) {
  if (options.background === 'white') return material('piso', '#e9e6df', { roughness: 0.5 });
  if (options.background === 'black') return material('piso', '#14151a', { roughness: 0.35 });
  if (options.background === 'gray') return material('piso', '#5b5e66', { roughness: 0.5 });
  if (options.background === 'studio') return material('piso', '#2a2a2e', { roughness: 0.45 });
  return material('piso', '#2a2a2e', { roughness: 0.45 });
}

const OBJECT = (name, primitive, loc, scale, mat, extra = {}) => {
  const { rot, ...rest } = extra;
  return {
    name,
    primitive,
    transform: rot ? { loc, scale, rot } : { loc, scale },
    material: mat,
    ...rest,
  };
};

function recipeBottle(primary, accent) {
  return [
    OBJECT('corpo', 'cylinder', [0, 0, 0.17], [0.09, 0.09, 0.17], primary),
    OBJECT('gargalo', 'cylinder', [0, 0, 0.36], [0.035, 0.035, 0.04], primary),
    OBJECT('tampa', 'cylinder', [0, 0, 0.43], [0.045, 0.045, 0.035], accent, { smooth: true }),
    OBJECT('rotulo', 'cylinder', [0, 0, 0.16], [0.0915, 0.0915, 0.06], 'rotulo'),
  ];
}

function recipeMug(primary, accent) {
  return [
    OBJECT('corpo', 'cylinder', [0, 0, 0.11], [0.11, 0.11, 0.11], primary),
    OBJECT('alca', 'torus', [0.13, 0, 0.12], [0.06, 0.06, 0.06], primary, { rot: [90, 0, 0] }),
    OBJECT('pires', 'cylinder', [0, 0, 0.008], [0.16, 0.16, 0.008], accent),
  ];
}

function recipeWatch(primary, accent) {
  return [
    OBJECT('caixa', 'cylinder', [0, 0, 0.06], [0.09, 0.09, 0.02], primary, { rot: [90, 0, 0] }),
    OBJECT('mostrador', 'cylinder', [-0.022, 0, 0.06], [0.085, 0.085, 0.021], 'mostrador', { rot: [90, 0, 0] }),
    OBJECT('pulseira', 'torus', [0, 0, 0.06], [0.12, 0.12, 0.03], accent, { rot: [90, 0, 0] }),
  ];
}

function recipeShoe(primary, accent) {
  return [
    OBJECT('solado', 'cube', [0, 0, 0.02], [0.28, 0.1, 0.02], accent),
    OBJECT('cabedal', 'sphere', [0, 0, 0.1], [0.24, 0.09, 0.09], primary, { smooth: true }),
    OBJECT('calcanhar', 'cube', [-0.19, 0, 0.1], [0.05, 0.09, 0.08], primary),
  ];
}

function recipeHeadphone(primary, accent) {
  return [
    OBJECT('aro', 'torus', [0, 0, 0.23], [0.13, 0.13, 0.02], accent, { rot: [90, 0, 0] }),
    OBJECT('concha_esq', 'sphere', [-0.13, 0, 0.11], [0.06, 0.045, 0.06], primary, { smooth: true }),
    OBJECT('concha_dir', 'sphere', [0.13, 0, 0.11], [0.06, 0.045, 0.06], primary, { smooth: true }),
  ];
}

function recipeJar(primary, accent) {
  return [
    OBJECT('corpo', 'sphere', [0, 0, 0.16], [0.14, 0.14, 0.16], primary, { smooth: true }),
    OBJECT('bico', 'cone', [0, -0.15, 0.22], [0.04, 0.04, 0.05], primary, { rot: [70, 0, 0] }),
    OBJECT('tampa', 'cylinder', [0, 0, 0.32], [0.06, 0.06, 0.025], accent),
  ];
}

function recipeLamp(primary, accent) {
  return [
    OBJECT('base', 'cylinder', [0, 0, 0.02], [0.12, 0.12, 0.02], accent),
    OBJECT('haste', 'cylinder', [0, 0, 0.2], [0.012, 0.012, 0.18], accent),
    OBJECT('cúpula', 'cone', [0, 0, 0.4], [0.14, 0.14, 0.1], primary),
  ];
}

function recipeGeneric(primary, accent) {
  return [
    OBJECT('pedestal', 'cylinder', [0, 0, 0.05], [0.22, 0.22, 0.05], accent),
    OBJECT('objeto', 'sphere', [0, 0, 0.2], [0.11, 0.11, 0.11], primary, { smooth: true }),
  ];
}

const RECIPES = {
  bottle: recipeBottle,
  mug: recipeMug,
  watch: recipeWatch,
  shoe: recipeShoe,
  headphone: recipeHeadphone,
  jar: recipeJar,
  lamp: recipeLamp,
  generic: recipeGeneric,
};

function recipeCharacter(primary, accent) {
  return [
    OBJECT('torso', 'cube', [0, 0, 0.3], [0.14, 0.09, 0.16], primary),
    OBJECT('cabeca', 'sphere', [0, 0, 0.55], [0.11, 0.11, 0.11], 'pele', { smooth: true }),
    OBJECT('braco_esq', 'cylinder', [-0.2, 0, 0.33], [0.035, 0.035, 0.14], primary, { rot: [0, 12, 0] }),
    OBJECT('braco_dir', 'cylinder', [0.2, 0, 0.33], [0.035, 0.035, 0.14], primary, { rot: [0, -12, 0] }),
    OBJECT('perna_esq', 'cylinder', [-0.07, 0, 0.1], [0.045, 0.045, 0.1], accent),
    OBJECT('perna_dir', 'cylinder', [0.07, 0, 0.1], [0.045, 0.045, 0.1], accent),
  ];
}

function recipeInterior(primary, accent) {
  return [
    OBJECT('piso', 'plane', [0, 0, 0], [4, 4, 1], 'piso'),
    OBJECT('parede', 'cube', [0, 1.1, 1.2], [2.2, 0.06, 1.2], 'parede'),
    OBJECT('sofa_base', 'cube', [-0.7, 0.5, 0.28], [0.8, 0.42, 0.16], primary),
    OBJECT('sofa_encosto', 'cube', [-0.7, 0.88, 0.5], [0.8, 0.12, 0.22], primary),
    OBJECT('mesa', 'cube', [0.55, 0.35, 0.24], [0.4, 0.3, 0.02], accent),
    OBJECT('mesa_pe', 'cylinder', [0.55, 0.35, 0.11], [0.03, 0.03, 0.11], accent),
    OBJECT('luminaria', 'cylinder', [-1.35, 0.55, 0.35], [0.025, 0.025, 0.35], 'metal'),
    OBJECT('cúpula', 'cone', [-1.35, 0.55, 0.72], [0.16, 0.16, 0.1], 'luz'),
  ];
}

function recipeStillLife(primary, accent) {
  return [
    OBJECT('mesa', 'cube', [0, 0, 0.36], [0.7, 0.45, 0.03], 'madeira'),
    OBJECT('mesa_pe', 'cylinder', [0, 0, 0.18], [0.05, 0.05, 0.18], 'madeira'),
    OBJECT('vaso', 'cylinder', [0, 0, 0.5], [0.09, 0.09, 0.11], primary),
    OBJECT('fruta_1', 'sphere', [0.26, 0.08, 0.44], [0.06, 0.06, 0.06], accent, { smooth: true }),
    OBJECT('fruta_2', 'sphere', [0.36, -0.06, 0.44], [0.055, 0.055, 0.055], accent, { smooth: true }),
    OBJECT('fruta_3', 'sphere', [0.18, -0.16, 0.44], [0.05, 0.05, 0.05], accent, { smooth: true }),
  ];
}

function recipeLandscape(primary, accent) {
  return [
    OBJECT('chao', 'plane', [0, 0, 0], [6, 6, 1], 'piso'),
    OBJECT('arvore_1', 'cone', [-1.2, 0.6, 0.7], [0.35, 0.35, 0.7], 'vegetacao'),
    OBJECT('arvore_2', 'cone', [0.4, 1.4, 0.5], [0.25, 0.25, 0.5], 'vegetacao'),
    OBJECT('arvore_3', 'cone', [1.5, -0.2, 0.9], [0.42, 0.42, 0.9], 'vegetacao'),
    OBJECT('pedra', 'sphere', [0.2, -0.9, 0.18], [0.3, 0.2, 0.18], accent, { smooth: true }),
  ];
}

function recipeLogo(primary, accent) {
  return [
    OBJECT('placa', 'cube', [0, 0.12, 0.5], [0.7, 0.02, 0.3], accent),
    OBJECT('letra_1', 'cube', [-0.24, 0.08, 0.5], [0.06, 0.05, 0.1], primary),
    OBJECT('letra_2', 'cylinder', [-0.08, 0.08, 0.5], [0.05, 0.05, 0.08], primary, { rot: [90, 0, 0] }),
    OBJECT('letra_3', 'cube', [0.08, 0.08, 0.5], [0.05, 0.05, 0.1], primary),
    OBJECT('letra_4', 'torus', [0.24, 0.08, 0.5], [0.05, 0.05, 0.05], primary, { rot: [90, 0, 0] }),
  ];
}

function recipeAbstract(primary, accent) {
  return [
    OBJECT('base', 'cylinder', [0, 0, 0.04], [0.3, 0.3, 0.04], accent),
    OBJECT('aro', 'torus', [0, 0, 0.32], [0.2, 0.2, 0.06], primary, { rot: [24, 18, 0] }),
    OBJECT('esfera', 'sphere', [0, 0, 0.3], [0.07, 0.07, 0.07], 'metal', { smooth: true }),
  ];
}

const RECIPE_BY_KIND = {
  character: recipeCharacter,
  interior: recipeInterior,
  'still-life': recipeStillLife,
  landscape: recipeLandscape,
  logo: recipeLogo,
  abstract: recipeAbstract,
};

function buildScene(request, subject, options) {
  const primary = primaryMaterial(options);
  const accentName = primary.name === 'metal' ? 'prata' : 'metal';
  const accent = MATERIAL_LIBRARY[accentName];

  const recipe = RECIPE_BY_KIND[subject.kind] || RECIPES[subject.recipe] || recipeGeneric;
  let objects = recipe(primary.name, accentName);
  const materials = {};

  materials[primary.name] = primary.spec;
  materials[accentName] = { ...accent };
  if (options.color) materials[primary.name] = { ...primary.spec, baseColor: options.color };

  // Materiais auxiliares usados pelas receitas (só entram quando referenciados).
  const used = new Set(objects.map((object) => object.material).filter(Boolean));
  if (used.has('rotulo')) materials.rotulo = material('rotulo', '#f4f1e8', { roughness: 0.6 });
  if (used.has('mostrador')) materials.mostrador = material('mostrador', '#101318', { roughness: 0.2, metallic: 0.4 });
  if (used.has('pele')) materials.pele = material('pele', '#c9926b', { roughness: 0.55 });
  if (used.has('parede')) materials.parede = material('parede', options.background === 'white' ? '#e6e2da' : '#3a3d44', { roughness: 0.8 });
  if (used.has('vegetacao')) materials.vegetacao = material('vegetacao', '#2f5d3a', { roughness: 0.85 });
  if (used.has('luz')) {
    materials.luz = { baseColor: '#fff2d8', emission: { color: '#fff2d8', strength: 6 }, roughness: 0.4 };
  }
  // Materiais literais das receitas (ex.: madeira na mesa) entram pelo nome.
  for (const name of used) {
    if (!materials[name] && MATERIAL_LIBRARY[name]) materials[name] = { ...MATERIAL_LIBRARY[name] };
  }

  if (!used.has('piso')) {
    objects = [OBJECT('piso', 'plane', [0, 0, 0], [6, 6, 1], 'piso'), ...objects];
  }
  materials.piso = floorMaterial(options);

  // O fundo do estúdio é uma parede alta atrás do objeto, não um cilindro mágico.
  if (options.background === 'studio' && !objects.some((object) => object.name === 'fundo')) {
    objects.push(OBJECT('fundo', 'plane', [0, 1.6, 1.6], [3, 3, 1], 'fundo', { rot: [90, 0, 0] }));
    materials.fundo = material('fundo', '#24262c', { roughness: 0.85 });
  }

  return {
    sceneSpec: {
      schemaVersion: 1,
      name: clampString(request, 120) || `Plano ${subject.label}`,
      engine: 'CYCLES',
      samples: options.wantsStylized ? 96 : options.wantsRealism ? 192 : 128,
      resolution: options.resolution,
      preview: { maxSize: 640, samples: 32 },
      colorManagement: { viewTransform: 'AgX', look: 'None', exposure: 0 },
      render: { device: 'GPU', adaptive: true, denoise: true, maxBounces: options.wantsRealism ? 8 : 6 },
      camera: buildCamera(options),
      world: buildWorld(options),
      materials,
      objects,
      lights: buildLights(options, subject),
      output: { format: 'PNG', transparent: false },
    },
    primaryMaterial: primary.name,
  };
}

function clampString(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildWorld(options) {
  if (options.background === 'white') return { color: '#e9e6df', strength: 1.1 };
  if (options.background === 'black') return { color: '#050507', strength: 0.25 };
  if (options.background === 'gray') return { color: '#55585f', strength: 0.7 };
  if (options.background === 'studio') return { color: '#0b0b10', strength: 0.6 };
  if (options.mood === 'neon') return { color: '#0a0714', strength: 0.4 };
  return { color: '#0b0b10', strength: 0.6 };
}

function buildLights(options, subject) {
  const target = subject.kind === 'interior' ? [0, 0.4, 0.9] : [0, 0, 0.35];
  const temperature = options.mood === 'neon' ? '#7a5cff' : '#fff0dd';

  if (options.mood === 'neon') {
    return [
      { name: 'neon_esq', type: 'AREA', position: [-1.6, -1.2, 1.2], energy: 220, size: 1.2, color: '#7a5cff', target },
      { name: 'neon_dir', type: 'AREA', position: [1.7, -0.8, 1.0], energy: 180, size: 1.0, color: '#22d3ee', target },
      { name: 'preenchimento', type: 'AREA', position: [0, 2.2, 2.4], energy: 90, size: 2.0, color: '#ffffff', target },
    ];
  }

  const key = options.mood === 'cinematic' || options.mood === 'dark' ? 620 : options.mood === 'bright' ? 380 : 450;
  const fill = options.mood === 'dark' ? 45 : options.mood === 'bright' ? 180 : 120;
  const rim = options.mood === 'cinematic' || options.mood === 'dark' ? 420 : 300;

  const lights = [
    { name: 'key', type: 'AREA', position: [3.2, -2.8, 3.6], energy: key, size: 2.2, color: temperature, target },
    { name: 'fill', type: 'AREA', position: [-3.6, -1.2, 2.2], energy: fill, size: 3.0, color: '#cfe0ff', target },
    { name: 'rim', type: 'AREA', position: [0.5, 3.6, 3.0], energy: rim, size: 1.5, color: '#ffd2a8', target },
  ];

  if (options.mood === 'realistic') {
    lights[0].energy = 520;
    lights[0].size = 2.6;
    lights[1].energy = 95;
    lights[2].energy = 260;
  }

  if (subject.kind === 'landscape') {
    return [
      { name: 'sol', type: 'SUN', position: [2, 2, 6], energy: 3.2, angle: 2.0, color: '#fff3dc', target: [0, 0, 0.4] },
      { name: 'ceu', type: 'AREA', position: [0, 0, 5], energy: 180, size: 5.0, color: '#bcd6ff', target: [0, 0, 0] },
    ];
  }

  return lights;
}

function buildCamera(options) {
  const close = options.framing === 'close';
  const wide = options.framing === 'wide';
  const top = options.framing === 'top';
  const low = options.framing === 'low';

  if (top) {
    return { location: [0, -0.02, 5.2], target: [0, 0, 0.25], lens: 50, sensorWidth: 36, fstop: 5.6, focus: 'target' };
  }
  if (low) {
    return { location: [3.2, -3.4, 0.35], target: [0, 0, 0.75], lens: 35, sensorWidth: 36, fstop: 2.8, focus: 'target' };
  }
  if (close) {
    return { location: [2.2, -2.4, 1.15], target: [0, 0, 0.38], lens: 85, sensorWidth: 36, fstop: 2.8, focus: 'target' };
  }
  if (wide) {
    return { location: [6.4, -6.8, 3.4], target: [0, 0, 0.55], lens: 24, sensorWidth: 36, fstop: 5.6, focus: 'target' };
  }
  return { location: [4.2, -4.6, 2.4], target: [0, 0, 0.45], lens: 50, sensorWidth: 36, fstop: 4, focus: 'target' };
}

// ---------------------------------------------------------------------------
// Plano
// ---------------------------------------------------------------------------

function buildAmbiguities(request, subject, options) {
  const ambiguities = [];
  const text = normalizeText(request);

  if (subject.kind === 'generic') {
    ambiguities.push({
      field: 'subject',
      blocking: true,
      question: 'Qual é o objeto principal da cena (produto, personagem, interior, logo)?',
      options: ['produto de estúdio', 'personagem', 'interior', 'logo/tipografia'],
    });
  }
  if (subject.kind === 'logo') {
    ambiguities.push({
      field: 'text',
      blocking: true,
      question: 'Qual é o texto exato e a fonte desejada para o logo?',
      options: ['enviar SVG/fonte', 'aproximar com blocos', 'usar somente o símbolo'],
    });
  }
  if (subject.kind === 'product' && !/\b\d+(?:[.,]\d+)?\s*(?:cm|mm|m)\b/.test(text)) {
    ambiguities.push({
      field: 'scale',
      blocking: false,
      question: 'Qual é o tamanho real do produto em centímetros?',
      options: ['10 cm', '20 cm', '30 cm'],
    });
  }
  if (options.wantsRealism && options.wantsStylized) {
    ambiguities.push({
      field: 'direction',
      blocking: true,
      question: 'O pedido mistura fotorrealismo e estilo low poly. Qual direção deve prevalecer?',
      options: ['fotorrealista', 'low poly'],
    });
  }
  if (options.realReference) {
    ambiguities.push({
      field: 'reference',
      blocking: true,
      question: 'Onde está a imagem de referência e qual região/ângulo deve ser comparada?',
      options: ['enviar arquivo local', 'usar preview atual como referência'],
    });
  }
  if (hasAny(text, ['mais de um', 'varios', 'vários', 'três', 'tres']) && subject.kind === 'product') {
    ambiguities.push({
      field: 'quantity',
      blocking: false,
      question: 'Quantas unidades do produto devem aparecer?',
      options: ['1', '3', '5'],
    });
  }
  return ambiguities.slice(0, 3);
}

function buildAssumptions(subject, options) {
  const assumptions = [
    'Escala em metros; o objeto principal é assumido com cerca de 20 cm, salvo dimensão explícita.',
    'Sem HDRI ou download de asset: a luz vem de luzes de área, mundo e materiais procedurais.',
    'O preview é um still 640 px/32 spp; a crítica visual usa esse preview, não a viewport ao vivo.',
  ];
  if (subject.kind === 'product') assumptions.push('Fundo de estúdio infinito aproximado por piso e parede; sem ciclorama real.');
  if (subject.kind === 'logo') assumptions.push('Texto 3D real (curvas/fontes) não é suportado pelo schema v1; o plano aproxima com primitivas.');
  if (options.wantsStylized) assumptions.push('Estilo low poly: menos samples e geometria primitiva, sem prometer fotorrealismo.');
  if (options.realReference) assumptions.push('A referência ainda não foi lida por este protótipo; o crítico recebe métricas prontas.');
  return assumptions;
}

function buildSteps(subject, options) {
  const primary = subject.kind === 'product' ? 'objeto principal' : subject.label;
  return [
    {
      id: 'interpretar',
      title: 'Interpretar o pedido',
      description: `Fixar ${primary}, estilo "${options.mood}", enquadramento "${options.framing}" e responder às ambiguidades bloqueantes antes de gastar render.`,
      ops: ['plan.subject', 'plan.options', 'plan.ambiguities'],
      checks: ['pedido sem ambiguidade bloqueante', 'suposições registradas'],
    },
    {
      id: 'montar-cena',
      title: 'Montar a base da cena',
      description: 'Definir unidade, piso, fundo e world a partir do estilo escolhido; nada de asset externo.',
      ops: ['world.color', 'world.strength', 'objects[piso]', 'materials[piso]'],
      checks: ['piso cobre o enquadramento', 'world não estoura o fundo'],
    },
    {
      id: 'modelar',
      title: `Modelar ${primary}`,
      description: 'Aplicar a receita determinística de primitivas do planner e registrar cada objeto com nome estável.',
      ops: ['objects[]', 'transform.loc', 'transform.scale', 'modifiers'],
      checks: ['objeto dentro do quadro', 'sem faces invertidas', 'escala coerente'],
    },
    {
      id: 'materiais',
      title: 'Aplicar materiais PBR',
      description: 'Traduzir cor e material detectados para o Principled BSDF; textura procedural quando fizer sentido.',
      ops: ['materials.*', 'baseColor', 'metallic', 'roughness', 'transmission'],
      checks: ['cor de marca preservada', 'vidro/metal consistentes'],
    },
    {
      id: 'iluminar',
      title: 'Iluminar',
      description: `Montar rígido de três pontos para o clima "${options.mood}", com key, fill e rim proporcionais à escala.`,
      ops: ['lights[key]', 'lights[fill]', 'lights[rim]'],
      checks: ['sem clipping', 'sombra com direção legível', 'separação do fundo'],
    },
    {
      id: 'enquadrar',
      title: 'Enquadrar a câmera',
      description: `Posicionar câmera em "${options.framing}" e escolher lente/DOF; o preview usa a mesma câmera do final.`,
      ops: ['camera.location', 'camera.target', 'camera.lens', 'camera.fstop'],
      checks: ['objeto centralizado', 'sem cortes involuntários', 'horizonte estável'],
    },
    {
      id: 'preview',
      title: 'Renderizar preview',
      description: 'Renderizar still 640 px/32 spp e publicar por SSE antes de qualquer render caro.',
      ops: ['preview.maxSize', 'preview.samples'],
      checks: ['PNG válido', 'tempo dentro do orçamento'],
    },
    {
      id: 'criticar',
      title: 'Crítica visual',
      description: 'Comparar preview com objetivo/referência por SSIM, ΔE00 e PSNR, mais checklist; gerar correções priorizadas.',
      ops: ['critic.metrics', 'critic.corrections'],
      checks: ['SSIM ≥ 0.75 (com referência)', 'ΔE00 ≤ 5', 'PSNR ≥ 24 dB', 'checklist sem falha bloqueante'],
    },
    {
      id: 'aprovar',
      title: 'Aprovação humana',
      description: 'Mostrar preview + crítica + correções; aplicar correções escolhidas e só então liberar o render final.',
      ops: ['POST /jobs/:id/approve', 'POST /jobs/:id/commands'],
      checks: ['aprovação explícita', 'preview corresponde ao spec aprovado'],
    },
  ];
}

function planWithRules(request) {
  const raw = String(request === undefined || request === null ? '' : request).trim();
  if (raw.length === 0) {
    throw new TypeError('request deve ser um texto não vazio');
  }
  const text = normalizeText(raw);
  const subject = detectSubject(text);
  const options = detectOptions(text);
  const ambiguities = buildAmbiguities(raw, subject, options);
  const blocking = ambiguities.filter((item) => item.blocking);
  const { sceneSpec, primaryMaterial: primary } = buildScene(raw, subject, options);

  let confidence = subject.confidence;
  if (options.material) confidence += 0.04;
  if (options.color) confidence += 0.03;
  if (ambiguities.some((item) => item.field === 'scale')) confidence += 0.02;
  if (blocking.length > 0) confidence = Math.min(confidence, 0.45);
  confidence = Number(clamp(confidence, 0.2, 0.93).toFixed(2));

  return {
    planVersion: PLAN_VERSION,
    rulesVersion: RULES_VERSION,
    source: 'rules',
    request: raw,
    subject: {
      kind: subject.kind,
      label: subject.label,
      recipe: subject.recipe || subject.kind,
      confidence: subject.confidence,
    },
    summary: summarize(raw, subject, options, primary),
    options: {
      mood: options.mood,
      framing: options.framing,
      background: options.background,
      resolution: options.resolution,
      wantsRealism: options.wantsRealism,
      wantsStylized: options.wantsStylized,
    },
    confidence,
    primaryMaterial: primary,
    assumptions: buildAssumptions(subject, options),
    ambiguities,
    steps: buildSteps(subject, options),
    critic: {
      metrics: METRIC_NAMES,
      thresholds: { ssim: 0.75, deltaE: 5, psnr: 24 },
      checklist: [
        'enquadramento: objeto principal legível, sem corte',
        'exposição: sem clipping especular acima de 1%',
        'materiais: cor/rugosidade coerentes com o pedido',
        'composição: proporção e escala críveis',
        'ruído: denoise sem plástico',
      ],
    },
    sceneSpec,
  };
}

function summarize(raw, subject, options, primary) {
  const parts = [
    `${titleCase(subject.label)} em ${options.mood === 'realistic' ? 'estilo fotorrealista' : `estilo ${options.mood}`}`,
    `enquadramento ${options.framing}`,
    `fundo ${options.background}`,
    `material ${primary}`,
  ];
  return `${parts.join(', ')}. Pedido: “${clampString(raw, 90)}”.`;
}

function normalizeModelPlan(modelPlan, base) {
  if (modelPlan === null || modelPlan === undefined) return base;
  if (typeof modelPlan !== 'object' || Array.isArray(modelPlan)) {
    throw new TypeError('opts.model deve devolver um objeto de plano ou null');
  }
  const merged = {
    ...base,
    ...modelPlan,
    planVersion: PLAN_VERSION,
    rulesVersion: RULES_VERSION,
    source: 'model',
    request: base.request,
    options: base.options,
    critic: modelPlan.critic || base.critic,
    steps: Array.isArray(modelPlan.steps) && modelPlan.steps.length > 0 ? modelPlan.steps : base.steps,
    ambiguities: Array.isArray(modelPlan.ambiguities) ? modelPlan.ambiguities : base.ambiguities,
    assumptions: Array.isArray(modelPlan.assumptions) ? modelPlan.assumptions : base.assumptions,
    sceneSpec: modelPlan.sceneSpec || base.sceneSpec,
  };
  try {
    validateAndNormalize(merged.sceneSpec);
  } catch (error) {
    throw new TypeError(`plano do modelo tem sceneSpec inválido: ${error.message}`);
  }
  return merged;
}

function resolveHook(opts) {
  if (!opts || opts.model === undefined || opts.model === null) return null;
  const hook = opts.model;
  if (typeof hook === 'function') return (payload) => hook(payload);
  if (typeof hook.plan === 'function') return (payload) => hook.plan(payload.request, { rules: payload.rules });
  throw new TypeError('opts.model deve ser uma função ou um objeto com .plan()');
}

function plan(request, opts = {}) {
  const base = planWithRules(request);
  const hook = resolveHook(opts);
  if (!hook) return base;
  const result = hook({ request: base.request, rules: base });
  if (result && typeof result.then === 'function') {
    throw new TypeError('opts.model devolveu uma Promise; use planWithModel()');
  }
  return normalizeModelPlan(result, base);
}

async function planWithModel(request, opts = {}) {
  const base = planWithRules(request);
  const hook = resolveHook(opts);
  if (!hook) return base;
  const result = await hook({ request: base.request, rules: base });
  return normalizeModelPlan(result, base);
}

module.exports = {
  PLAN_VERSION,
  RULES_VERSION,
  plan,
  planWithModel,
  planWithRules,
  // exportados para teste/inspeção sem duplicar regras
  detectSubject,
  detectOptions,
};
