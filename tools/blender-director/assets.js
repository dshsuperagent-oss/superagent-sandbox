#!/usr/bin/env node
'use strict';

/**
 * assets.js — biblioteca, download e plano de importação dos assets livres do
 * Blender Director v3.
 *
 * O repositório **não versiona binários**. `assets-library.json` registra
 * procedência, formato e licença de cada asset; `fetch` baixa os arquivos do
 * Poly Haven para `tools/blender-director/assets/` (ignorado pelo git) e grava
 * um `index.json` local com o caminho do arquivo principal.
 *
 * O `build_room.py` lê o mesmo `assets-library.json` + `index.json` para
 * importar os objetos no Blender e registrar a licença no manifesto do job.
 *
 * Uso:
 *   node tools/blender-director/assets.js list
 *   node tools/blender-director/assets.js validate --require-files
 *   node tools/blender-director/assets.js plan --room examples/room-living.json
 *   node tools/blender-director/assets.js fetch --only potted_plant_01
 *   node tools/blender-director/assets.js fetch --dry-run
 *
 * Node 22 stdlib apenas: `fetch`, `node:crypto`, `node:fs`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { validateRoomPlan, ValidationError } = require('./lib/room');

const TOOL_DIR = __dirname;
const DEFAULT_LIBRARY = path.join(TOOL_DIR, 'assets-library.json');
const DEFAULT_ROOM = path.join(TOOL_DIR, 'examples', 'room-living.json');
const API_BASE = 'https://api.polyhaven.com/files/';

const LICENSES = new Set([
  'CC0-1.0',
  'CC-BY-2.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-SA-3.0',
  'CC-BY-SA-4.0',
  'Public-Domain',
]);

const MODEL_FORMATS = new Set(['gltf', 'glb', 'blend']);
const HDRI_FORMATS = new Set(['hdr', 'exr']);

class AssetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssetError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new AssetError(message);
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`${label} não encontrado: ${file} (${error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} não é JSON válido: ${file} (${error.message})`);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function requireString(value, context, { max = 300, pattern = null } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${context}: deve ser texto não vazio`);
  const text = value.trim();
  if (text.length > max) fail(`${context}: máximo de ${max} caracteres`);
  if (pattern && !pattern.test(text)) fail(`${context}: formato inválido "${text}"`);
  return text;
}

function requireHttpUrl(value, context) {
  const text = requireString(value, context, { max: 500 });
  if (!/^https?:\/\//.test(text)) fail(`${context}: deve ser uma URL http(s)`);
  return text;
}

/** Garante que `child` fica dentro de `root` (bloqueia path traversal). */
function safeJoin(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`caminho fora do diretório de assets: ${relative}`);
  }
  return resolved;
}

function loadLibrary(file = DEFAULT_LIBRARY) {
  const raw = readJson(path.resolve(file), 'assets-library.json');
  if (!isObject(raw)) fail('assets-library.json: deve ser um objeto');
  if (raw.schemaVersion !== 1) fail(`assets-library.json: schemaVersion deve ser 1 (recebi ${raw.schemaVersion})`);
  const assetsDir = requireString(raw.assetsDir, 'assets-library.assetsDir', { max: 120 });
  if (assetsDir.includes('..')) fail('assets-library.assetsDir: não pode conter ".."');
  if (!isObject(raw.assets) || Object.keys(raw.assets).length === 0) fail('assets-library.assets: deve ser um objeto com pelo menos um asset');

  const assets = {};
  for (const [id, entry] of Object.entries(raw.assets)) {
    const context = `assets-library.assets.${id}`;
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) fail(`${context}: id deve usar letras, números, "_", "." ou "-"`);
    if (!isObject(entry)) fail(`${context}: deve ser um objeto`);
    const kind = requireString(entry.kind, `${context}.kind`, { max: 10 });
    if (kind !== 'model' && kind !== 'hdri') fail(`${context}.kind: use "model" ou "hdri"`);
    const format = requireString(entry.format, `${context}.format`, { max: 10 }).toLowerCase();
    const allowed = kind === 'model' ? MODEL_FORMATS : HDRI_FORMATS;
    if (!allowed.has(format)) fail(`${context}.format: para ${kind} use um de ${[...allowed].join(', ')}`);
    const provider = requireString(entry.provider, `${context}.provider`, { max: 30 });
    if (provider !== 'polyhaven') fail(`${context}.provider: apenas "polyhaven" nesta versão`);
    const resolution = requireString(entry.resolution, `${context}.resolution`, { max: 10 });
    const source = entry.source;
    if (!isObject(source)) fail(`${context}.source: deve ser um objeto {url, author, license, licenseUrl}`);
    const license = requireString(source.license, `${context}.source.license`, { max: 40 });
    if (!LICENSES.has(license)) {
      fail(`${context}.source.license: licença "${license}" não reconhecida (aceitas: ${[...LICENSES].join(', ')})`);
    }
    let bbox = null;
    if (entry.bbox !== undefined && entry.bbox !== null) {
      if (!isObject(entry.bbox) || !Array.isArray(entry.bbox.min) || !Array.isArray(entry.bbox.max)
        || entry.bbox.min.length !== 3 || entry.bbox.max.length !== 3
        || ![...entry.bbox.min, ...entry.bbox.max].every((value) => typeof value === 'number' && Number.isFinite(value))) {
        fail(`${context}.bbox: use {min:[x,y,z], max:[x,y,z]} com números finitos`);
      }
      bbox = { min: entry.bbox.min.slice(), max: entry.bbox.max.slice() };
    }
    assets[id] = {
      id,
      name: requireString(entry.name, `${context}.name`, { max: 120 }),
      kind,
      format,
      bbox,
      provider,
      providerId: entry.providerId === undefined || entry.providerId === null
        ? null
        : requireString(entry.providerId, `${context}.providerId`, { max: 80 }),
      resolution,
      object: entry.object === undefined || entry.object === null ? null : requireString(entry.object, `${context}.object`, { max: 120 }),
      source: {
        url: requireHttpUrl(source.url, `${context}.source.url`),
        author: requireString(source.author, `${context}.source.author`, { max: 200 }),
        license,
        licenseUrl: requireHttpUrl(source.licenseUrl, `${context}.source.licenseUrl`),
      },
      notes: typeof entry.notes === 'string' ? entry.notes : null,
    };
  }
  return {
    file: path.resolve(file),
    dir: path.dirname(path.resolve(file)),
    assetsDir,
    assetsDirPath: path.resolve(path.dirname(path.resolve(file)), assetsDir),
    assets,
  };
}

function indexPath(library) {
  return path.join(library.assetsDirPath, 'index.json');
}

function loadIndex(library) {
  const file = indexPath(library);
  if (!fs.existsSync(file)) return { schemaVersion: 1, assets: {} };
  const raw = readJson(file, 'assets/index.json');
  if (!isObject(raw) || !isObject(raw.assets)) fail('assets/index.json: estrutura inválida; rode `node assets.js fetch` novamente');
  return raw;
}

/**
 * Caminho local do arquivo principal de um asset.
 * Devolve null quando o asset ainda não foi baixado.
 */
function localMain(library, index, assetId) {
  const entry = library.assets[assetId];
  if (!entry) fail(`asset "${assetId}" não existe em assets-library.json`);
  const local = index.assets && index.assets[assetId];
  if (!local || typeof local.main !== 'string') return null;
  return safeJoin(library.assetsDirPath, local.main);
}

function loadRoom(roomPath) {
  const absolute = path.resolve(roomPath);
  const raw = readJson(absolute, 'room plan');
  try {
    return { file: absolute, plan: validateRoomPlan(raw) };
  } catch (error) {
    if (error instanceof ValidationError) {
      fail(`room plan inválido: ${error.message}${error.details && error.details.length > 1 ? `\n  - ${error.details.join('\n  - ')}` : ''}`);
    }
    throw error;
  }
}

function referencedAssetIds(plan) {
  const ids = new Set(plan.assets.map((placement) => placement.assetId));
  const hdri = plan.lighting.hdri;
  if (typeof hdri === 'string') ids.add(hdri);
  else if (isObject(hdri)) Object.values(hdri).forEach((value) => ids.add(value));
  return [...ids];
}

function resolvedTransform(placement) {
  return {
    position: placement.position,
    rotation: placement.rotation,
    scale: placement.scale,
    fitHeight: placement.fitHeight,
    anchor: placement.anchor,
    snapToFloor: placement.snapToFloor,
    materialOverride: placement.materialOverride,
    visible: placement.visible,
  };
}

function licenseRecord(entry) {
  return {
    assetId: entry.id,
    name: entry.name,
    provider: entry.provider,
    sourceUrl: entry.source.url,
    author: entry.source.author,
    license: entry.source.license,
    licenseUrl: entry.source.licenseUrl,
  };
}

/**
 * Plano de importação consumido pelo `build_room.py` (e pelos testes).
 * Não toca no Blender: apenas resolve arquivos, formatos e licenças.
 */
function buildImportPlan(roomFile, plan, library, index) {
  const placements = plan.assets.map((placement) => {
    const entry = library.assets[placement.assetId];
    if (!entry) fail(`assets[${placement.id}]: asset "${placement.assetId}" não existe em assets-library.json`);
    if (entry.kind !== 'model') fail(`assets[${placement.id}]: "${placement.assetId}" é ${entry.kind}, não é modelo`);
    const main = localMain(library, index, placement.assetId);
    const exists = Boolean(main && fs.existsSync(main));
    return {
      id: placement.id,
      assetId: placement.assetId,
      name: entry.name,
      format: entry.format,
      object: entry.object,
      main: main || null,
      exists,
      license: licenseRecord(entry),
      transform: resolvedTransform(placement),
    };
  });

  const hdri = plan.lighting.hdri;
  const hdriId = typeof hdri === 'string' ? hdri : (hdri ? hdri[plan.lighting.preset] || null : null);
  let environment = null;
  if (hdriId) {
    const entry = library.assets[hdriId];
    if (!entry) fail(`lighting.hdri: asset "${hdriId}" não existe em assets-library.json`);
    if (entry.kind !== 'hdri') fail(`lighting.hdri: "${hdriId}" é ${entry.kind}, não é HDRI`);
    const main = localMain(library, index, hdriId);
    environment = {
      assetId: hdriId,
      name: entry.name,
      format: entry.format,
      main: main || null,
      exists: Boolean(main && fs.existsSync(main)),
      license: licenseRecord(entry),
    };
  }

  return {
    schemaVersion: 1,
    room: roomFile,
    assetsDir: library.assetsDirPath,
    placements,
    environment,
    missing: [
      ...placements.filter((item) => !item.exists).map((item) => item.assetId),
      ...(environment && !environment.exists ? [environment.assetId] : []),
    ],
  };
}

function planForRoom(roomPath, libraryPath) {
  const library = loadLibrary(libraryPath || DEFAULT_LIBRARY);
  const index = loadIndex(library);
  const { file, plan } = loadRoom(roomPath || DEFAULT_ROOM);
  return { library, index, room: file, plan, importPlan: buildImportPlan(file, plan, library, index) };
}

function validateAssets(roomPath, libraryPath, { requireFiles = false } = {}) {
  const library = loadLibrary(libraryPath || DEFAULT_LIBRARY);
  const index = loadIndex(library);
  const { plan, room } = loadRoom(roomPath || DEFAULT_ROOM);
  const importPlan = buildImportPlan(room, plan, library, index);
  if (requireFiles) {
    if (importPlan.missing.length > 0) {
      fail(`assets ausentes: ${importPlan.missing.join(', ')}. Rode:\n  node tools/blender-director/assets.js fetch --room ${path.relative(process.cwd(), room)}`);
    }
    const main = importPlan.environment && importPlan.environment.main;
    if (main && !fs.existsSync(main)) fail(`HDRI ausente: ${main}`);
  }
  const licenses = new Map();
  for (const record of [...importPlan.placements.map((item) => item.license), ...(importPlan.environment ? [importPlan.environment.license] : [])]) {
    licenses.set(record.assetId, record);
  }
  return { library, index, room, plan, importPlan, licenses: [...licenses.values()] };
}

// ---------------------------------------------------------------------------
// Poly Haven
// ---------------------------------------------------------------------------

function pickFileDescriptor(filesJson, assetId, entry) {
  const group = entry.kind === 'model' ? entry.format : 'hdri';
  const resolutions = filesJson[group];
  if (!isObject(resolutions)) fail(`${assetId}: Poly Haven não oferece ${group}`);
  const resolution = resolutions[entry.resolution] ? entry.resolution : Object.keys(resolutions).sort()[0];
  const resolutionData = resolutions[resolution];
  if (!isObject(resolutionData)) fail(`${assetId}: resolução ${resolution} inválida`);
  const formatKey = entry.kind === 'model' ? entry.format : entry.format;
  const descriptor = resolutionData[formatKey];
  if (!isObject(descriptor) || typeof descriptor.url !== 'string') {
    fail(`${assetId}: formato ${entry.format} indisponível em ${resolution}`);
  }
  return { resolution, descriptor };
}

async function downloadFile(url, destination, expectedMd5) {
  const response = await fetch(url, { headers: { 'User-Agent': 'blender-director-assets/1.0' } });
  if (!response.ok) throw new AssetError(`GET ${url} falhou: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (expectedMd5) {
    const actual = crypto.createHash('md5').update(buffer).digest('hex');
    if (actual !== expectedMd5) throw new AssetError(`md5 não confere para ${url} (esperado ${expectedMd5}, recebi ${actual})`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
  return buffer.length;
}

async function fetchAsset(library, index, assetId, { force = false, dryRun = false } = {}) {
  const entry = library.assets[assetId];
  if (!entry) fail(`asset "${assetId}" não existe em assets-library.json`);
  const providerId = entry.providerId || assetId;
  const existing = index.assets[assetId];
  if (existing && existing.main && fs.existsSync(safeJoin(library.assetsDirPath, existing.main)) && !force) {
    return { assetId, skipped: true, ...existing };
  }
  const response = await fetch(`${API_BASE}${encodeURIComponent(providerId)}`, {
    headers: { 'User-Agent': 'blender-director-assets/1.0' },
  });
  if (!response.ok) throw new AssetError(`${assetId}: HTTP ${response.status} em ${API_BASE}${providerId}`);
  const filesJson = await response.json();
  const { resolution, descriptor } = pickFileDescriptor(filesJson, providerId, entry);
  const mainUrl = descriptor.url;
  const mainName = path.basename(new URL(mainUrl).pathname);
  const directory = assetId;
  const mainRelative = path.posix.join(directory, mainName);
  const include = isObject(descriptor.include) ? descriptor.include : {};
  const files = [];
  if (dryRun) {
    const downloads = [
      { url: mainUrl, path: mainRelative, size: descriptor.size, md5: descriptor.md5 },
      ...Object.entries(include).map(([relative, info]) => ({ url: info.url, path: path.posix.join(directory, relative), size: info.size, md5: info.md5 })),
    ];
    return { assetId, dryRun: true, resolution, main: mainRelative, downloads };
  }
  const mainPath = safeJoin(library.assetsDirPath, mainRelative);
  const mainBytes = await downloadFile(mainUrl, mainPath, descriptor.md5);
  files.push({ path: mainRelative, bytes: mainBytes, md5: descriptor.md5 });
  for (const [relative, info] of Object.entries(include)) {
    if (!isObject(info) || typeof info.url !== 'string') fail(`${assetId}: include inválido para "${relative}"`);
    if (relative.includes('..') || path.isAbsolute(relative)) fail(`${assetId}: include com caminho inválido "${relative}"`);
    const target = safeJoin(library.assetsDirPath, path.posix.join(directory, relative));
    const bytes = await downloadFile(info.url, target, info.md5);
    files.push({ path: path.posix.join(directory, relative), bytes, md5: info.md5 });
  }
  const record = {
    format: entry.format,
    kind: entry.kind,
    resolution,
    main: mainRelative,
    files,
    license: licenseRecord(entry),
    fetchedAt: new Date().toISOString(),
  };
  index.assets[assetId] = record;
  writeJsonAtomic(indexPath(library), index);
  return { assetId, ...record };
}

async function fetchAll(roomPath, libraryPath, options) {
  const library = loadLibrary(libraryPath || DEFAULT_LIBRARY);
  const index = loadIndex(library);
  const { plan, file: room } = loadRoom(roomPath || DEFAULT_ROOM);
  const referenced = referencedAssetIds(plan);
  const wanted = options.only && options.only.length > 0 ? options.only : referenced;
  for (const assetId of wanted) {
    if (!library.assets[assetId]) fail(`--only: asset "${assetId}" não existe na biblioteca`);
  }
  const results = [];
  for (const assetId of wanted) {
    const result = await fetchAsset(library, index, assetId, { force: options.force, dryRun: options.dryRun });
    results.push(result);
    if (!options.dryRun) {
      const status = result.skipped ? 'já presente' : `${result.files.length} arquivo(s)`;
      process.stdout.write(`[assets] ${assetId}: ${status}\n`);
    }
  }
  return { room, library, referenced, wanted, results };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    command: argv[0] || 'help',
    library: DEFAULT_LIBRARY,
    room: DEFAULT_ROOM,
    requireFiles: false,
    force: false,
    dryRun: false,
    only: [],
    out: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--library') options.library = path.resolve(argv[++index]);
    else if (arg === '--room') options.room = path.resolve(argv[++index]);
    else if (arg === '--require-files') options.requireFiles = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--only') options.only = argv[++index].split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg === '--out') options.out = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else fail(`argumento desconhecido: ${arg}`);
  }
  return options;
}

const HELP = `Uso: node tools/blender-director/assets.js <comando> [opções]

Comandos:
  list                      lista os assets da biblioteca
  validate                  valida biblioteca + room plan (e arquivos com --require-files)
  plan                      imprime o plano de importação resolvido (JSON)
  fetch                     baixa os assets referenciados pelo room plan
  help                      esta ajuda

Opções:
  --library <arquivo>       biblioteca (padrão: assets-library.json)
  --room <arquivo>          room plan (padrão: examples/room-living.json)
  --require-files           falha se um asset referenciado não estiver baixado
  --only <a,b>              limita o fetch a estes assets
  --force                   rebaixa mesmo se o arquivo existir
  --dry-run                 mostra URLs e caminhos sem baixar
  --out <arquivo>           grava o plano de importação em JSON (comando plan)
`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.command === 'list') {
    const library = loadLibrary(options.library);
    const index = loadIndex(library);
    for (const entry of Object.values(library.assets)) {
      const main = localMain(library, index, entry.id);
      const status = main && fs.existsSync(main) ? 'baixado' : 'ausente';
      process.stdout.write(`${entry.id}\t${entry.kind}\t${entry.format}\t${entry.resolution}\t${entry.source.license}\t${status}\n`);
    }
    return 0;
  }
  if (options.command === 'validate') {
    const result = validateAssets(options.room, options.library, { requireFiles: options.requireFiles });
    process.stdout.write(`[ok] ${Object.keys(result.library.assets).length} assets na biblioteca, ${result.importPlan.placements.length} colocação(ões), ${result.importPlan.environment ? 1 : 0} HDRI\n`);
    process.stdout.write(`[ok] licenças: ${result.licenses.map((item) => `${item.assetId}=${item.license}`).join(', ')}\n`);
    if (result.importPlan.missing.length > 0) {
      process.stdout.write(`[aviso] assets ainda não baixados: ${result.importPlan.missing.join(', ')}\n`);
    }
    return 0;
  }
  if (options.command === 'plan') {
    const result = planForRoom(options.room, options.library);
    const output = result.importPlan;
    if (options.out) {
      writeJsonAtomic(options.out, output);
      process.stdout.write(`[ok] plano de importação em ${options.out}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
    return 0;
  }
  if (options.command === 'fetch') {
    const result = await fetchAll(options.room, options.library, options);
    if (options.dryRun) {
      for (const item of result.results) {
        process.stdout.write(`[dry-run] ${item.assetId} (${item.resolution}): ${item.main}\n`);
        for (const download of item.downloads) {
          process.stdout.write(`  ${String(download.size || '?').padStart(9)} bytes  ${download.path}  <- ${download.url}\n`);
        }
      }
    } else {
      process.stdout.write(`[ok] fetch: ${result.results.length} asset(s) referenciados por ${path.relative(process.cwd(), result.room)}\n`);
    }
    return 0;
  }
  fail(`comando desconhecido: ${options.command} (use help)`);
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[erro] ${error.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  AssetError,
  LICENSES,
  loadLibrary,
  loadIndex,
  indexPath,
  localMain,
  loadRoom,
  buildImportPlan,
  planForRoom,
  validateAssets,
  referencedAssetIds,
  fetchAll,
  fetchAsset,
  pickFileDescriptor,
};
