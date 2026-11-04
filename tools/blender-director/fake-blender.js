#!/usr/bin/env node
'use strict';

/**
 * fake-blender.js — executável de fixture que imita a interface do Blender
 * usada pelo Blender Director.
 *
 * Ele aceita a mesma linha de comando do Blender:
 *
 *   node fake-blender.js -b -P build.py -- --spec spec.json --out runs/<id> \
 *        --stage preview --preview-index 1 --progress-json
 *
 * e emite os mesmos eventos JSON Lines do build.py, gerando PNGs
 * placeholder determinísticos. Serve para rodar o e2e e desenvolver o viewer
 * em máquinas sem Blender (inclusive no CI deste repositório).
 *
 * Variável de ambiente:
 *   BLENDER_DIRECTOR_FAKE_DELAY_MS — atraso entre etapas (padrão 20 ms)
 */

const fs = require('node:fs');
const path = require('node:path');
const { renderPlaceholder } = require('./lib/png');

const DELAY_MS = (() => {
  const raw = Number(process.env.BLENDER_DIRECTOR_FAKE_DELAY_MS);
  if (!Number.isFinite(raw)) return 20;
  return Math.max(0, Math.min(1000, Math.round(raw)));
})();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const tail = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];
  const options = {
    spec: null,
    out: null,
    stage: 'preview',
    previewIndex: 1,
    progressJson: false,
  };
  for (let index = 0; index < tail.length; index += 1) {
    const arg = tail[index];
    if (arg === '--spec') options.spec = tail[++index];
    else if (arg === '--out') options.out = tail[++index];
    else if (arg === '--stage') options.stage = tail[++index];
    else if (arg === '--preview-index') options.previewIndex = Number(tail[++index]);
    else if (arg === '--progress-json') options.progressJson = true;
  }
  return options;
}

function emit(options, payload) {
  payload.ts = Math.round(Date.now() / 100) / 10;
  if (options.progressJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`[fake-blender] ${payload.event}: ${payload.name || payload.message || payload.file || ''}\n`);
  }
}

function fitPreviewDimensions(width, height, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  let nextWidth = Math.max(64, Math.round(width * scale));
  let nextHeight = Math.max(64, Math.round(height * scale));
  nextWidth -= nextWidth % 2;
  nextHeight -= nextHeight % 2;
  return [nextWidth, nextHeight];
}

function readManifest(outDir) {
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeManifest(outDir, spec, stage, record) {
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = readManifest(outDir);
  const now = new Date().toISOString();
  Object.assign(manifest, {
    schemaVersion: 1,
    generator: 'blender-director/fake-blender.js',
    blenderVersion: 'fake-5.2.3',
    specName: spec.name,
    engine: spec.engine,
    device: 'CPU (fixture)',
    devices: ['fixture'],
    samples: spec.samples,
    resolution: spec.resolution,
    colorManagement: spec.colorManagement,
    blendFile: 'scene.blend',
    updatedAt: now,
  });
  if (!manifest.createdAt) manifest.createdAt = now;
  if (stage === 'preview') {
    const previews = (manifest.previews || []).filter((item) => item.n !== record.n);
    previews.push(record);
    previews.sort((a, b) => a.n - b.n);
    manifest.previews = previews;
    manifest.lastPreview = record;
  } else {
    manifest.final = record;
  }
  const temporary = `${manifestPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, manifestPath);
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.spec || !options.out) {
    emit(options, { event: 'error', message: 'fake-blender: --spec e --out são obrigatórios' });
    return 1;
  }
  if (options.stage !== 'preview' && options.stage !== 'final') {
    emit(options, { event: 'error', message: `fake-blender: stage inválido: ${options.stage}` });
    return 1;
  }

  const specPath = path.resolve(options.spec);
  const outDir = path.resolve(options.out);
  if (!fs.existsSync(specPath)) {
    emit(options, { event: 'error', message: `fake-blender: spec não encontrado: ${specPath}` });
    return 1;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const previewIndex = Number.isInteger(options.previewIndex) ? options.previewIndex : 1;
  const started = Date.now();

  const steps = options.stage === 'preview'
    ? ['reset', 'materials', 'objects', 'lights', 'camera', 'world']
    : ['open_blend'];
  for (const step of steps) {
    emit(options, { event: 'step', name: step });
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  if (options.stage === 'preview') {
    fs.writeFileSync(
      path.join(outDir, 'scene.blend'),
      `# fake-blender fixture\n# spec: ${spec.name}\n# preview: ${previewIndex}\n`,
      'utf8',
    );
    const [width, height] = fitPreviewDimensions(spec.resolution[0], spec.resolution[1], spec.preview.maxSize);
    const file = `preview-${String(previewIndex).padStart(3, '0')}.png`;
    emit(options, { event: 'step', name: 'render' });
    if (DELAY_MS > 0) await sleep(DELAY_MS + 40);
    fs.writeFileSync(path.join(outDir, file), renderPlaceholder(spec, { stage: 'preview', width, height }));
    const seconds = Math.round((1.1 + previewIndex * 0.2) * 1000) / 1000;
    emit(options, { event: 'preview', file });
    emit(options, {
      event: 'metric',
      stage: 'preview',
      samples: spec.preview.samples,
      seconds,
      engine: spec.engine,
      device: 'CPU (fixture)',
      resolution: [width, height],
    });
    writeManifest(outDir, spec, 'preview', {
      stage: 'preview',
      n: previewIndex,
      file,
      width,
      height,
      samples: spec.preview.samples,
      seconds,
      engine: spec.engine,
      device: 'CPU (fixture)',
      renderedAt: new Date().toISOString(),
    });
  } else {
    if (!fs.existsSync(path.join(outDir, 'scene.blend'))) {
      emit(options, { event: 'error', message: 'fake-blender: scene.blend não encontrado; rode o preview antes do final' });
      return 1;
    }
    const [width, height] = spec.resolution;
    const file = 'final-001.png';
    emit(options, { event: 'step', name: 'render' });
    if (DELAY_MS > 0) await sleep(DELAY_MS + 80);
    fs.writeFileSync(path.join(outDir, file), renderPlaceholder(spec, { stage: 'final', width, height }));
    const seconds = 7.5;
    emit(options, { event: 'final', file });
    emit(options, {
      event: 'metric',
      stage: 'final',
      samples: spec.samples,
      seconds,
      engine: spec.engine,
      device: 'CPU (fixture)',
      resolution: [width, height],
    });
    writeManifest(outDir, spec, 'final', {
      stage: 'final',
      file,
      width,
      height,
      samples: spec.samples,
      seconds,
      engine: spec.engine,
      device: 'CPU (fixture)',
      renderedAt: new Date().toISOString(),
    });
  }

  emit(options, { event: 'done', stage: options.stage, seconds: Math.round((Date.now() - started) / 1000) });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
