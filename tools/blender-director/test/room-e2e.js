#!/usr/bin/env node
'use strict';

/**
 * Teste da v3 (sala de estar): portão determinístico, assets, room plan e
 * avaliação por referência — sem Blender e sem rede.
 *
 * Cobre:
 *  - node --check em todos os .js e py_compile em build_room/evaluate/validate;
 *  - schema do room plan e exemplos;
 *  - light rig (dia/fim de tarde/noite);
 *  - paridade entre o resolvedor JS e o `build_room.py --dry-run`;
 *  - `validate.py`: plano válido, asset ausente, e os 5 defeitos de regressão
 *    (planta dentro do rack, prateleira dentro da TV, peça de teto sem lastro,
 *    câmera dentro de sólido, sofá fora da moldura);
 *  - biblioteca de assets (licença, bbox, download simulado, path traversal);
 *  - `evaluate.py` com imagens sintéticas: métricas, máscaras/IoU, relatório,
 *    comparison.png e reprovação por limiar.
 *
 * Uso:
 *   node tools/blender-director/test/room-e2e.js
 *
 * Requer Node 22 e Python 3 (o mesmo do Blender ou do sistema).
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateRoomPlan, resolveRoomPlan, validatePresets } = require('../lib/room');
const { encodePNG, readPNGDimensions } = require('../lib/png');
const assets = require('../assets');

const TOOL_DIR = path.resolve(__dirname, '..');
const ROOM = path.join(TOOL_DIR, 'examples', 'room-living.json');
const LIBRARY = path.join(TOOL_DIR, 'assets-library.json');
const PRESETS = path.join(TOOL_DIR, 'light-rig-presets.json');
const BUILD_ROOM = path.join(TOOL_DIR, 'build_room.py');
const VALIDATE = path.join(TOOL_DIR, 'validate.py');
const EVALUATE = path.join(TOOL_DIR, 'evaluate.py');
const PYTHON = process.env.PYTHON || 'python3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-director-v3-'));

let passed = 0;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function ok(message) {
  passed += 1;
  log(`[ok] ${message}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd || TOOL_DIR, env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function walkJavaScript(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkJavaScript(fullPath, result);
    else if (entry.isFile() && entry.name.endsWith('.js')) result.push(fullPath);
  }
  return result;
}

function checkSyntax() {
  const files = walkJavaScript(TOOL_DIR);
  assert.ok(files.length >= 10, `esperava >= 10 arquivos .js, encontrei ${files.length}`);
  for (const file of files) {
    const result = run(process.execPath, ['--check', file]);
    assert.equal(result.status, 0, `node --check falhou em ${path.relative(TOOL_DIR, file)}:\n${result.stderr}`);
  }
  const compile = run(PYTHON, ['-m', 'py_compile', BUILD_ROOM, EVALUATE, VALIDATE]);
  assert.equal(compile.status, 0, `py_compile falhou:\n${compile.stderr}`);
  ok(`node --check em ${files.length} arquivos .js e py_compile nos 3 scripts Python`);
}

function dryRun(roomPath, extra = []) {
  const resolvedPath = path.join(TMP, `resolved-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const result = run(PYTHON, [BUILD_ROOM, '--room', roomPath, '--dry-run', '--resolved', resolvedPath, '--library', LIBRARY, '--presets', PRESETS, ...extra]);
  assert.equal(result.status, 0, `dry-run falhou:\n${result.stdout}\n${result.stderr}`);
  return { resolved: readJson(resolvedPath), resolvedPath, result };
}

function validate(resolvedPath, extra = []) {
  return run(PYTHON, [VALIDATE, '--resolved', resolvedPath, '--json', '--quiet', ...extra]);
}

function expectRule(resolvedPath, rule, ids = []) {
  const result = validate(resolvedPath, ['--allow-missing-assets']);
  assert.equal(result.status, 2, `validador deveria reprovar (rule ${rule}), mas passou:\n${result.stdout}${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const found = report.errors.filter((error) => error.rule === rule);
  assert.ok(found.length > 0, `esperava erro da regra ${rule}; recebi: ${JSON.stringify(report.errors.map((item) => item.rule))}`);
  for (const id of ids) {
    assert.ok(
      found.some((error) => error.ids.includes(id)),
      `esperava ${id} no erro de ${rule}; recebi ${JSON.stringify(found.map((item) => item.ids))}`,
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// 1. Room plan
// ---------------------------------------------------------------------------

function checkRoomPlan() {
  const raw = readJson(ROOM);
  const plan = validateRoomPlan(raw);
  const presets = validatePresets(readJson(PRESETS));
  const resolved = resolveRoomPlan(raw, { presets });
  assert.equal(resolved.summary.walls, 4);
  assert.equal(resolved.summary.openings, 1);
  assert.equal(resolved.summary.assets, 2);
  assert.equal(resolved.summary.furniture, plan.furniture.length);
  assert.equal(resolved.summary.lights, 3);
  assert.equal(plan.room.interior.width, 3.6);
  assert.equal(plan.room.interior.depth, 4.8);
  const opening = resolved.walls.find((wall) => wall.side === 'north').openings[0];
  assert.equal(opening.id, 'janela-sala');
  assert.equal(opening.width, 1.3);
  assert.ok(opening.center.every((value, index) => Math.abs(value - [0, -2.4, 1.15][index]) < 1e-9), `centro da janela: ${opening.center}`);
  assert.ok(plan.reference && plan.reference.measurements.windowRect.length === 4);
  assert.ok(plan.reference.fullyVisible.includes('janela-sala'));
  assert.ok(plan.reference.inventory.includes('sanca-janela'));
  assert.ok(!plan.furniture.some((piece) => piece.id === 'spot-teto'), 'spot-teto não deve existir (não está na referência)');
  assert.ok(plan.furniture.every((piece) => piece.support && piece.collisionGroup));
  ok('room plan: 4 paredes, janela 1,3 m no centro, 2 assets, 60 peças e referência medida');
}

function checkRejections() {
  const base = readJson(ROOM);
  const cases = [
    {
      name: 'parede faltando',
      mutate: (plan) => { plan.room.walls.pop(); },
    },
    {
      name: 'abertura fora da parede',
      mutate: (plan) => { plan.room.walls[0].openings[0].u = 3.0; },
    },
    {
      name: 'campo desconhecido',
      mutate: (plan) => { plan.campoInventado = true; },
    },
    {
      name: 'material inexistente',
      mutate: (plan) => { plan.furniture[0].material = 'nao-existe'; },
    },
    {
      name: 'preset inválido',
      mutate: (plan) => { plan.lighting.preset = 'meio-dia'; },
    },
    {
      name: 'limiar fora de faixa',
      mutate: (plan) => { plan.evaluation.thresholds.ssimMin = 2; },
    },
  ];
  for (const testCase of cases) {
    const plan = structuredClone(base);
    testCase.mutate(plan);
    assert.throws(() => validateRoomPlan(plan), undefined, `deveria rejeitar: ${testCase.name}`);
  }
  ok(`schema rejeita ${cases.length} planos inválidos (paredes, abertura, campo, material, preset, limiar)`);
}

function checkPresets() {
  const presets = validatePresets(readJson(PRESETS));
  assert.deepEqual(Object.keys(presets.presets).sort(), ['day', 'dusk', 'night']);
  const base = readJson(ROOM);
  const expectations = {
    day: { exposure: 0, sunEnergy: 4.5, interiorEnergy: 18 * 0.15, sun: true },
    dusk: { exposure: 0.4, sunEnergy: 1.1, interiorEnergy: 18 * 0.85, sun: true },
    night: { exposure: 0.6, sunEnergy: null, interiorEnergy: 18, sun: false },
  };
  for (const [name, expected] of Object.entries(expectations)) {
    const plan = structuredClone(base);
    plan.lighting.preset = name;
    plan.lighting.overrides = {};
    const resolved = resolveRoomPlan(plan, { presets });
    assert.equal(resolved.lighting.preset, name);
    assert.equal(resolved.lighting.exposure, expected.exposure, `${name}: exposição`);
    const sun = resolved.lighting.lights.find((light) => light.type === 'SUN');
    if (expected.sun) {
      assert.ok(sun, `${name}: sol deveria existir`);
      assert.equal(sun.energy, expected.sunEnergy, `${name}: energia do sol`);
    } else {
      assert.equal(sun, undefined, `${name}: noite não tem sol`);
    }
    const interior = resolved.lighting.lights.find((light) => light.name.startsWith('luminaria-'));
    assert.ok(interior, `${name}: luminária interna`);
    assert.ok(Math.abs(interior.energy - expected.interiorEnergy) < 1e-9, `${name}: watts da luminária (${interior.energy} != ${expected.interiorEnergy})`);
  }
  ok('light rig: exposição e watts coerentes em dia/fim de tarde/noite');
}

// ---------------------------------------------------------------------------
// 2. Resolvedor Python × JS + portão
// ---------------------------------------------------------------------------

function checkParity() {
  const presets = validatePresets(readJson(PRESETS));
  const js = resolveRoomPlan(readJson(ROOM), { presets });
  const { resolved } = dryRun(ROOM);
  assert.deepEqual(resolved.summary, js.summary, 'summary JS × Python');
  const jsOpening = js.walls.find((wall) => wall.side === 'north').openings[0];
  const pyOpening = resolved.walls.find((wall) => wall.side === 'north').openings[0];
  assert.deepEqual(pyOpening.center.map((value) => Math.round(value * 1e6) / 1e6), jsOpening.center.map((value) => Math.round(value * 1e6) / 1e6), 'centro da janela JS × Python');
  assert.equal(pyOpening.width, jsOpening.width);
  assert.deepEqual(resolved.camera, js.camera, 'câmera JS × Python');
  assert.deepEqual(resolved.render.resolution, js.render.resolution);
  const pyLights = resolved.lighting.lights.map((light) => `${light.name}:${light.energy}`);
  const jsLights = js.lighting.lights.map((light) => `${light.name}:${light.energy}`);
  assert.deepEqual(pyLights, jsLights, 'luzes JS × Python');
  assert.deepEqual(resolved.assets.map((item) => item.id), js.assets.map((item) => item.id));
  assert.deepEqual(resolved.reference.measurements.windowRect, js.reference.measurements.windowRect);
  ok('resolvedor JS e build_room.py --dry-run batem em summary, janela, câmera, luzes e assets');
}

function checkValidator() {
  const { resolved, resolvedPath } = dryRun(ROOM);
  const report = validate(resolvedPath, ['--allow-missing-assets']);
  assert.equal(report.status, 0, `plano deveria passar no validador:\n${report.stdout}${report.stderr}`);
  const parsed = JSON.parse(report.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.rules && parsed.summary.objects >= 60);

  const missing = structuredClone(resolved);
  missing.assets[0].exists = false;
  const missingPath = writeJson(path.join(TMP, 'missing-asset.json'), missing);
  const missingReport = validate(missingPath);
  assert.equal(missingReport.status, 2, 'asset ausente deveria reprovar por padrão');
  assert.ok(JSON.parse(missingReport.stdout).errors.some((error) => error.rule === 'assets'));
  assert.equal(validate(missingPath, ['--allow-missing-assets']).status, 0);
  ok('validate.py: plano válido passa; asset não baixado reprova (e --allow-missing-assets libera só testes)');
}

// ---------------------------------------------------------------------------
// 3. Regressões dos 5 defeitos
// ---------------------------------------------------------------------------

function regressionPlan(mutate) {
  const plan = readJson(ROOM);
  mutate(plan);
  const file = path.join(TMP, `regression-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeJson(file, plan);
  return dryRun(file).resolvedPath;
}

function checkRegressions() {
  // 1. planta dentro do rack-base (o defeito pego olhando a imagem)
  {
    const resolvedPath = regressionPlan((plan) => {
      const plant = plan.assets.find((item) => item.id === 'planta-janela');
      plant.position = [-1.57, -0.1, 0];
    });
    const report = expectRule(resolvedPath, 'assets', ['planta-janela', 'rack-base']);
    assert.ok(report.errors.some((error) => error.rule === 'intersection'), 'também deve acusar interseção de volume');
  }
  // 1b. mutação do resolved-room.json só no eixo (bbox antiga): a regra de eixo pega.
  {
    const { resolved } = dryRun(ROOM);
    const mutated = structuredClone(resolved);
    mutated.assets.find((item) => item.id === 'planta-janela').transform.position = [-1.57, -0.1, 0];
    const file = writeJson(path.join(TMP, 'asset-axis.json'), mutated);
    const report = expectRule(file, 'assets', ['planta-janela']);
    assert.ok(report.errors.some((error) => error.ids.includes('rack-base')), 'eixo dentro do rack-base');
  }
  // 2. prateleira dentro da TV
  {
    const resolvedPath = regressionPlan((plan) => {
      const shelf = plan.furniture.find((item) => item.id === 'prateleira-1');
      shelf.position[2] = 1.55;
    });
    expectRule(resolvedPath, 'intersection', ['tv', 'prateleira-1']);
  }
  // 3. peça de teto fora do inventário
  {
    const resolvedPath = regressionPlan((plan) => {
      plan.furniture.push({
        id: 'spot-teto',
        shape: 'box',
        size: [0.16, 0.16, 0.06],
        position: [0, -2.0, 2.69],
        material: 'esquadria',
        support: 'ceiling',
      });
    });
    expectRule(resolvedPath, 'inventory', ['spot-teto']);
  }
  // 4. câmera dentro do sofá
  {
    const resolvedPath = regressionPlan((plan) => {
      plan.camera.location = [1.2, 0.6, 1.15];
    });
    expectRule(resolvedPath, 'camera-distance', ['sofa-base']);
  }
  // 5. sofá fora da moldura (objeto-chave em fullyVisible)
  {
    const resolvedPath = regressionPlan((plan) => {
      plan.reference.fullyVisible.push('sofa-base');
    });
    expectRule(resolvedPath, 'framing', ['sofa-base']);
  }
  ok('regressões: planta×rack, TV×prateleira, peça de teto, câmera dentro do sofá e sofá fora da moldura reprovam');
}

// ---------------------------------------------------------------------------
// 4. Assets
// ---------------------------------------------------------------------------

function checkAssets() {
  const library = assets.loadLibrary(LIBRARY);
  assert.ok(Object.keys(library.assets).length >= 5);
  for (const entry of Object.values(library.assets)) {
    assert.ok(entry.source.license.startsWith('CC0') || entry.source.license.startsWith('CC-BY'), `${entry.id}: licença`);
    if (entry.kind === 'model') assert.ok(entry.bbox && entry.bbox.min.length === 3, `${entry.id}: bbox`);
  }
  const index = assets.loadIndex(library);
  assert.ok(index.assets && typeof index.assets === 'object');

  // biblioteca temporária com um .gltf falso e índice própria
  const tempDir = fs.mkdtempSync(path.join(TMP, 'library-'));
  const tempLibraryRaw = readJson(LIBRARY);
  tempLibraryRaw.assetsDir = 'assets-test';
  const tempLibraryPath = writeJson(path.join(tempDir, 'assets-library.json'), tempLibraryRaw);
  const assetDir = path.join(tempDir, 'assets-test');
  fs.mkdirSync(path.join(assetDir, 'potted_plant_01'), { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'potted_plant_01', 'potted_plant_01_1k.gltf'), '{"asset":{"version":"2.0"}}');
  writeJson(path.join(assetDir, 'index.json'), {
    schemaVersion: 1,
    assets: {
      potted_plant_01: { format: 'gltf', kind: 'model', main: 'potted_plant_01/potted_plant_01_1k.gltf', files: [] },
    },
  });
  const plan = assets.planForRoom(ROOM, tempLibraryPath);
  const plant = plan.importPlan.placements.find((item) => item.assetId === 'potted_plant_01');
  assert.equal(plant.exists, true);
  assert.equal(plant.license.license, 'CC0-1.0');
  assert.ok(plan.importPlan.missing.includes('fancy_picture_frame_01'));
  assert.equal(plan.importPlan.environment.exists, false);

  // path traversal no índice
  const evil = structuredClone(index);
  evil.assets = { potted_plant_01: { main: '../../evil.gltf' } };
  writeJson(path.join(assetDir, 'index.json'), evil);
  const evilLibrary = assets.loadLibrary(tempLibraryPath);
  assert.throws(() => assets.localMain(evilLibrary, assets.loadIndex(evilLibrary), 'potted_plant_01'));
  ok('assets: biblioteca/licenças/bbox, download simulado, asset ausente e bloqueio de path traversal');
}

// ---------------------------------------------------------------------------
// 5. evaluate.py
// ---------------------------------------------------------------------------

function makeImage(width, height, pixel) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixel(x, y);
      const index = (y * width + x) * 4;
      rgba[index] = r;
      rgba[index + 1] = g;
      rgba[index + 2] = b;
      rgba[index + 3] = a;
    }
  }
  return encodePNG(width, height, rgba);
}

function scenePixel(x, y, { shift = 0, tint = 0 } = {}) {
  const width = 240;
  const height = 160;
  const base = 70 + Math.round(90 * (y / height));
  let r = base + tint;
  let g = base;
  let b = base - 10;
  const windowX0 = 80 + shift;
  const windowX1 = 160 + shift;
  if (x >= windowX0 && x <= windowX1 && y >= 20 && y <= 120) {
    r = 235;
    g = 238;
    b = 240;
  }
  if (x < 70 && y > 70) {
    r = 150 + tint;
    g = 105;
    b = 70;
  }
  return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)), 255];
}

function makeMask(width, height, x0, y0, x1, y1) {
  return makeImage(width, height, (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
}

function latestEvalDir() {
  const dirs = fs.readdirSync(TMP).filter((name) => name.startsWith('eval-')).map((name) => path.join(TMP, name));
  assert.ok(dirs.length > 0, 'nenhum diretório de avaliação');
  return dirs.sort().pop();
}

function runEvaluate(renderPath, configPath, extra = []) {
  const out = path.join(TMP, `eval-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const result = run(PYTHON, [EVALUATE, '--render', renderPath, '--config', configPath, '--out', out, '--quiet', ...extra]);
  return { ...result, out };
}

function checkEvaluate() {
  const width = 240;
  const height = 160;
  const referencePath = path.join(TMP, 'reference.png');
  const identicalPath = path.join(TMP, 'render-identical.png');
  const shiftedPath = path.join(TMP, 'render-shifted.png');
  fs.writeFileSync(referencePath, makeImage(width, height, (x, y) => scenePixel(x, y)));
  fs.writeFileSync(identicalPath, makeImage(width, height, (x, y) => scenePixel(x, y)));
  fs.writeFileSync(shiftedPath, makeImage(width, height, (x, y) => scenePixel(x + 6, y, { tint: 35, shift: 0 })));

  const regions = [
    { id: 'janela', label: 'Janela', rect: [0.3, 0.1, 0.4, 0.7] },
    { id: 'sofa', label: 'Sofá', rect: [0.0, 0.4, 0.3, 0.6] },
  ];
  const strict = writeJson(path.join(TMP, 'eval-strict.json'), {
    reference: referencePath,
    regions,
    thresholds: { ssimMin: 0.999, deltaE00Max: 0.5, deltaE00RegionMax: 0.5, histogramMax: 0.001, iouMin: 0.9 },
    histogramBins: 8,
    maxEvalSize: 128,
    requireMasks: false,
  });
  const identical = runEvaluate(identicalPath, strict);
  assert.equal(identical.status, 0, `imagens idênticas deveriam passar:\n${identical.stdout}${identical.stderr}`);
  const identicalReport = readJson(path.join(identical.out, 'report.json'));
  assert.ok(identicalReport.metrics.ssim > 0.999, `SSIM idêntico = ${identicalReport.metrics.ssim}`);
  assert.ok(identicalReport.metrics.deltaE00 < 0.5);
  assert.equal(identicalReport.verdict, 'pass');
  assert.ok(fs.existsSync(path.join(identical.out, 'comparison.png')));

  const shifted = runEvaluate(shiftedPath, strict);
  assert.equal(shifted.status, 2, 'imagem deslocada deveria reprovar nos limiares estritos');
  const shiftedReport = readJson(path.join(shifted.out, 'report.json'));
  assert.equal(shiftedReport.verdict, 'fail');
  assert.ok(shiftedReport.checks.some((check) => !check.pass));

  // IoU com máscaras
  const renderMask = path.join(TMP, 'mask-render.png');
  const referenceMask = path.join(TMP, 'mask-reference.png');
  fs.writeFileSync(renderMask, makeMask(width, height, 70, 60, 150, 130));
  fs.writeFileSync(referenceMask, makeMask(width, height, 70, 60, 150, 130));
  const iouConfig = writeJson(path.join(TMP, 'eval-iou.json'), {
    reference: referencePath,
    regions: [],
    thresholds: { ssimMin: -1, deltaE00Max: 100, deltaE00RegionMax: 100, histogramMax: 1, iouMin: 0.9 },
    histogramBins: 8,
    maxEvalSize: 128,
    requireMasks: true,
  });
  const iouPass = runEvaluate(identicalPath, iouConfig, ['--render-mask', renderMask, '--reference-mask', referenceMask]);
  assert.equal(iouPass.status, 0, `IoU 1,0 deveria passar:\n${iouPass.stdout}${iouPass.stderr}`);
  const iouReport = readJson(path.join(iouPass.out, 'report.json'));
  assert.equal(iouReport.metrics.iou.available, true);
  assert.ok(iouReport.metrics.iou.value > 0.99);

  fs.writeFileSync(referenceMask, makeMask(width, height, 40, 40, 70, 70));
  const iouFail = runEvaluate(identicalPath, iouConfig, ['--render-mask', renderMask, '--reference-mask', referenceMask]);
  assert.equal(iouFail.status, 2, 'IoU baixo deveria reprovar');

  const noMasks = runEvaluate(identicalPath, iouConfig);
  assert.equal(noMasks.status, 2, 'requireMasks sem máscaras deveria reprovar');
  const noMasksReport = readJson(path.join(noMasks.out, 'report.json'));
  assert.equal(noMasksReport.metrics.iou.available, false);
  assert.ok(noMasksReport.checks.some((check) => check.metric === 'iou' && check.pass === false));

  const comparison = readPNGDimensions(fs.readFileSync(path.join(iouPass.out, 'comparison.png')));
  assert.ok(comparison.width > 0 && comparison.height > 0);
  ok('evaluate.py: SSIM/ΔE00/histograma, máscaras/IoU, comparison.png, report.json e reprovação por limiar');
}

// ---------------------------------------------------------------------------
// 6. Portão no fluxo do build
// ---------------------------------------------------------------------------

function checkBuildGate() {
  const result = run(PYTHON, [BUILD_ROOM, '--room', ROOM, '--dry-run', '--validate', '--library', LIBRARY, '--presets', PRESETS]);
  assert.equal(result.status, 0, `build_room --dry-run --validate falhou:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /valida/i);
  ok('build_room.py roda o portão antes de renderizar (--dry-run --validate)');
}

// ---------------------------------------------------------------------------

function main() {
  log(`[v3] temporário: ${TMP}`);
  checkSyntax();
  checkRoomPlan();
  checkRejections();
  checkPresets();
  checkParity();
  checkValidator();
  checkRegressions();
  checkAssets();
  checkEvaluate();
  checkBuildGate();
  log(`\nTodos os ${passed} grupos de teste da v3 passaram.`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`\nFALHOU: ${error.stack || error.message}\n`);
  process.exit(1);
}
