#!/usr/bin/env node
'use strict';

/**
 * Blender Director — servidor local.
 *
 * Recebe um scene-spec JSON, enfileira o job, chama o renderer (Blender real
 * ou fake-blender), publica o progresso por SSE e espera aprovação humana
 * antes do render final. Sem nenhuma dependência externa: apenas stdlib do
 * Node 22.
 *
 * Rotas:
 *   GET  /                         viewer/index.html
 *   GET  /state                    fila, job corrente, etapas, logs, previews
 *   GET  /events                   SSE com o estado completo a cada mudança
 *   GET  /preview/:job/:file       PNG do preview
 *   GET  /final/:job/:file         imagem do render final
 *   GET  /examples/:file           specs de exemplo
 *   GET  /requests/:file           pedidos de exemplo do planner (texto)
 *   POST /plan                     pedido em texto -> plano + scene-spec v1
 *   GET  /jobs/:id/manifest        manifest.json do job
 *   POST /jobs                     cria um job a partir de um scene-spec
 *   POST /jobs/:id/commands        aplica comando incremental e gera preview
 *   POST /jobs/:id/approve         libera o render final
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { LIMITS, ValidationError, validateAndNormalize, applyCommand } = require('./lib/spec');
const { createRenderer } = require('./renderer');
const { plan } = require('./planner');
const { readPNGDimensions } = require('./lib/png');

const VERSION = '1.1.0';
const HOST = '127.0.0.1';
const SSE_HEARTBEAT_MS = 15000;
const PREVIEW_FILE_PATTERN = /^preview-\d{3,4}\.png$/;
const FINAL_FILE_PATTERN = /^final-\d{3,4}\.(?:png|jpg|jpeg|exr)$/i;
const JOB_ID_PATTERN = /^[a-f0-9]{16}$/;

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.exr': 'image/x-exr',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Estado em memória
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const jobs = new Map();
/** @type {string[]} jobs aguardando o primeiro preview */
const pending = [];
/** @type {object|null} */
let activeJob = null;
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

let server = null;
let renderer = null;
let options = null;
let workRoot = null;
let broadcastTimer = null;
let heartbeatTimer = null;
let stopping = false;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function addLog(job, level, message) {
  const entry = {
    at: nowIso(),
    level,
    message: String(message).slice(0, 4000),
  };
  job.logs.push(entry);
  if (job.logs.length > LIMITS.maxLogs) {
    job.logs.splice(0, job.logs.length - LIMITS.maxLogs);
  }
}

function summarize(spec) {
  return {
    engine: spec.engine,
    samples: spec.samples,
    resolution: spec.resolution,
    preview: spec.preview,
    materials: Object.keys(spec.materials),
    objects: spec.objects.length,
    lights: spec.lights.length,
    camera: spec.camera,
    world: { strength: spec.world.strength, hdri: Boolean(spec.world.hdri) },
    output: spec.output,
  };
}

function readManifest(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function pngDimensions(filePath) {
  try {
    return readPNGDimensions(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    name: job.spec.name,
    state: job.state,
    stage: job.stage,
    substep: job.substep,
    error: job.error,
    approved: job.approved,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    previews: job.previews.map((preview) => ({
      n: preview.n,
      url: `/preview/${job.id}/${preview.file}`,
      width: preview.width,
      height: preview.height,
      samples: preview.samples,
      seconds: preview.seconds,
      at: preview.at,
    })),
    final: job.final
      ? {
          url: `/final/${job.id}/${job.final.file}`,
          file: job.final.file,
          width: job.final.width,
          height: job.final.height,
          samples: job.final.samples,
          seconds: job.final.seconds,
          at: job.final.at,
        }
      : null,
    metrics: job.metrics,
    logs: job.logs.slice(-120),
    commands: job.commands,
    summary: job.summary,
    lastEvent: job.lastEvent,
    manifestUrl: `/jobs/${job.id}/manifest`,
  };
}

function publicState() {
  const orderedJobs = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    version: VERSION,
    now: nowIso(),
    uptimeSeconds: Math.round(process.uptime()),
    fakeBlender: Boolean(options && options.fakeBlender),
    renderer: renderer ? renderer.describe() : null,
    currentJobId: activeJob ? activeJob.id : null,
    queue: pending
      .map((id) => jobs.get(id))
      .filter(Boolean)
      .map((job) => ({ id: job.id, name: job.spec.name })),
    jobs: orderedJobs.map(publicJob),
  };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function broadcast() {
  if (stopping || sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function scheduleBroadcast() {
  if (broadcastTimer || stopping) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast();
  }, 40);
  if (typeof broadcastTimer.unref === 'function') broadcastTimer.unref();
}

function openEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': conectado\n\n');
  res.write(`data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
}

// ---------------------------------------------------------------------------
// Pipeline do job
// ---------------------------------------------------------------------------

async function createJob(rawSpec) {
  const spec = validateAndNormalize(rawSpec);
  const id = crypto.randomBytes(8).toString('hex');
  const directory = path.join(workRoot, 'runs', id);
  await fsp.mkdir(directory, { recursive: true });
  const timestamp = nowIso();
  const job = {
    id,
    spec,
    directory,
    state: 'queued',
    stage: 'plan',
    substep: null,
    error: null,
    approved: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    previewIndex: 0,
    previews: [],
    final: null,
    metrics: { preview: null, final: null },
    logs: [],
    commands: [],
    summary: summarize(spec),
    lastEvent: null,
    manifest: null,
  };
  jobs.set(id, job);
  addLog(job, 'info', `job criado: "${spec.name}" (${spec.objects.length} objetos, ${spec.lights.length} luzes, ${spec.engine})`);
  pending.push(id);
  scheduleBroadcast();
  pump();
  return job;
}

function pump() {
  if (activeJob || pending.length === 0 || stopping) return;
  const id = pending.shift();
  const job = jobs.get(id);
  if (!job) {
    pump();
    return;
  }
  activeJob = job;
  runPreview(job)
    .then(() => {
      if (job.state === 'error') {
        activeJob = null;
        pump();
      }
    })
    .catch((error) => {
      failJob(job, error);
      activeJob = null;
      pump();
    });
}

async function writeJobSpec(job) {
  const specPath = path.join(job.directory, 'spec.json');
  await fsp.writeFile(specPath, `${JSON.stringify(job.spec, null, 2)}\n`, 'utf8');
  return specPath;
}

function failJob(job, error) {
  job.state = 'error';
  job.stage = 'error';
  job.substep = null;
  job.error = error && error.message ? error.message : String(error);
  job.updatedAt = nowIso();
  addLog(job, 'error', job.error);
  scheduleBroadcast();
}

function handleRendererEvent(job, event) {
  job.lastEvent = event;
  job.updatedAt = nowIso();
  if (!event || typeof event !== 'object') return;

  switch (event.event) {
    case 'step': {
      job.substep = typeof event.name === 'string' ? event.name : null;
      if (job.substep === 'render') job.stage = 'preview';
      addLog(job, 'step', `etapa: ${job.substep || '(sem nome)'}`);
      break;
    }
    case 'preview': {
      job.stage = 'preview';
      const file = path.basename(String(event.file || ''));
      if (!PREVIEW_FILE_PATTERN.test(file)) {
        addLog(job, 'warning', `evento preview com arquivo inválido: ${file || '(vazio)'}`);
        break;
      }
      const dimensions = pngDimensions(path.join(job.directory, file));
      const n = Number(file.match(/\d+/)[0]);
      const existing = job.previews.find((preview) => preview.n === n);
      if (!existing) {
        job.previews.push({
          n,
          file,
          width: dimensions ? dimensions.width : null,
          height: dimensions ? dimensions.height : null,
          samples: null,
          seconds: null,
          at: nowIso(),
        });
      }
      addLog(job, 'info', `preview #${n} disponível (${file})`);
      break;
    }
    case 'metric': {
      const stage = event.stage === 'final' ? 'final' : 'preview';
      const metric = {
        samples: event.samples,
        seconds: event.seconds,
        engine: event.engine,
        device: event.device,
        resolution: event.resolution,
        at: nowIso(),
      };
      job.metrics[stage] = metric;
      if (stage === 'preview') {
        const lastPreview = job.previews[job.previews.length - 1];
        if (lastPreview) Object.assign(lastPreview, metric);
      } else if (job.final) {
        Object.assign(job.final, metric);
      }
      addLog(job, 'info', `${stage}: ${event.samples} spp em ${event.seconds}s (${event.engine}, ${event.device})`);
      break;
    }
    case 'final': {
      const file = path.basename(String(event.file || ''));
      if (!FINAL_FILE_PATTERN.test(file)) {
        addLog(job, 'warning', `evento final com arquivo inválido: ${file || '(vazio)'}`);
        break;
      }
      const dimensions = pngDimensions(path.join(job.directory, file));
      job.stage = 'final';
      job.final = {
        file,
        width: dimensions ? dimensions.width : null,
        height: dimensions ? dimensions.height : null,
        samples: null,
        seconds: null,
        at: nowIso(),
      };
      addLog(job, 'info', `render final disponível (${file})`);
      break;
    }
    case 'warning': {
      addLog(job, 'warning', event.message || 'warning sem mensagem');
      break;
    }
    case 'error': {
      addLog(job, 'error', event.message || 'erro sem mensagem');
      break;
    }
    case 'manifest':
    case 'done': {
      break;
    }
    default: {
      addLog(job, 'info', `evento do renderer: ${event.event || JSON.stringify(event)}`);
    }
  }
  scheduleBroadcast();
}

function describeRendererFailure(result) {
  if (result.timedOut) return 'o render excedeu o timeout do renderer';
  if (result.code === null) {
    return `não foi possível executar o renderer${result.signal ? ` (sinal ${result.signal})` : ''}`;
  }
  return `build.py terminou com código ${result.code}${result.signal ? ` (${result.signal})` : ''}`;
}

async function runPreview(job) {
  job.state = 'running';
  job.stage = 'build';
  job.substep = null;
  job.error = null;
  job.approved = false;
  job.previewIndex += 1;
  const previewIndex = job.previewIndex;
  job.updatedAt = nowIso();
  const specPath = await writeJobSpec(job);
  addLog(job, 'info', `preview #${previewIndex}: enviando cena para o renderer`);
  scheduleBroadcast();

  const result = await renderer.render({
    specPath,
    outDir: job.directory,
    stage: 'preview',
    previewIndex,
    onEvent: (event) => handleRendererEvent(job, event),
    onLog: (level, line) => {
      addLog(job, level, line);
      scheduleBroadcast();
    },
  });

  if (result.timedOut || result.code !== 0) {
    const lastError = [...job.logs].reverse().find((entry) => entry.level === 'error' || entry.level === 'stderr');
    failJob(job, new Error(`${describeRendererFailure(result)}${lastError ? `: ${lastError.message}` : ''}`));
    return;
  }
  if (!job.previews.some((preview) => preview.n === previewIndex)) {
    failJob(job, new Error('o renderer terminou sem emitir o evento "preview"'));
    return;
  }
  job.manifest = readManifest(job.directory);
  if (!job.manifest) {
    failJob(job, new Error('manifest.json não foi gerado pelo renderer'));
    return;
  }
  job.stage = 'approval';
  job.state = 'waiting';
  job.substep = null;
  job.updatedAt = nowIso();
  addLog(job, 'info', `preview #${previewIndex} pronto; aguardando aprovação humana`);
  scheduleBroadcast();
}

async function runFinal(job) {
  try {
    const specPath = await writeJobSpec(job);
    addLog(job, 'info', 'render final aprovado; renderizando');
    scheduleBroadcast();
    const result = await renderer.render({
      specPath,
      outDir: job.directory,
      stage: 'final',
      previewIndex: job.previewIndex,
      onEvent: (event) => handleRendererEvent(job, event),
      onLog: (level, line) => {
        addLog(job, level, line);
        scheduleBroadcast();
      },
    });
    if (result.timedOut || result.code !== 0) {
      const lastError = [...job.logs].reverse().find((entry) => entry.level === 'error' || entry.level === 'stderr');
      throw new Error(`${describeRendererFailure(result)}${lastError ? `: ${lastError.message}` : ''}`);
    }
    if (!job.final) throw new Error('o renderer terminou sem emitir o evento "final"');
    job.manifest = readManifest(job.directory);
    if (!job.manifest) throw new Error('manifest.json não foi gerado após o render final');
    job.stage = 'done';
    job.state = 'done';
    job.substep = null;
    job.updatedAt = nowIso();
    addLog(job, 'info', `render final concluído: ${job.final.file}`);
    scheduleBroadcast();
  } catch (error) {
    failJob(job, error);
  } finally {
    activeJob = null;
    pump();
  }
}

async function runCommandPreview(job) {
  try {
    await runPreview(job);
    if (job.state === 'error') {
      activeJob = null;
      pump();
    }
  } catch (error) {
    failJob(job, error);
    activeJob = null;
    pump();
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function commonHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...commonHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  return fsp
    .stat(filePath)
    .then((stat) => {
      if (!stat.isFile()) throw new HttpError(404, 'arquivo não encontrado');
      res.writeHead(200, {
        ...commonHeaders(),
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) sendJson(res, 500, { error: 'falha ao ler arquivo' });
        else res.destroy();
      });
      stream.pipe(res);
    })
    .catch((error) => {
      if (error instanceof HttpError) throw error;
      if (error && error.code === 'ENOENT') throw new HttpError(404, 'arquivo não encontrado');
      throw error;
    });
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(new HttpError(413, `corpo maior que o limite de ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) {
        finish(null, {});
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(new HttpError(400, 'JSON inválido no corpo da requisição'));
      }
    });
    req.on('error', (error) => finish(new HttpError(400, error.message)));
  });
}

function assertAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // curl, testes e clientes não-browser
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, 'origem inválida');
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new HttpError(403, 'origem não permitida (servidor escuta apenas em 127.0.0.1)');
  }
  const address = server && server.address();
  if (address && address.port && parsed.port && Number(parsed.port) !== address.port) {
    throw new HttpError(403, 'origem não permitida para esta porta');
  }
}

function jobById(id) {
  if (!JOB_ID_PATTERN.test(id)) throw new HttpError(404, 'job não encontrado');
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, 'job não encontrado');
  return job;
}

function matchJobRoute(pathname) {
  const approve = /^\/jobs\/([a-f0-9]{16})\/approve$/.exec(pathname);
  if (approve) return { action: 'approve', id: approve[1] };
  const commands = /^\/jobs\/([a-f0-9]{16})\/commands$/.exec(pathname);
  if (commands) return { action: 'commands', id: commands[1] };
  const manifest = /^\/jobs\/([a-f0-9]{16})\/manifest$/.exec(pathname);
  if (manifest) return { action: 'manifest', id: manifest[1] };
  return null;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/') {
    return sendFile(res, path.join(__dirname, 'viewer', 'index.html'), MIME_BY_EXTENSION['.html']);
  }
  if (method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, uptimeSeconds: Math.round(process.uptime()) });
  }
  if (method === 'GET' && pathname === '/state') {
    return sendJson(res, 200, publicState());
  }
  if (method === 'GET' && pathname === '/events') {
    return openEventStream(req, res);
  }
  if (method === 'GET' && pathname.startsWith('/examples/')) {
    const name = pathname.slice('/examples/'.length);
    if (!/^[a-z0-9-]+\.json$/.test(name)) throw new HttpError(404, 'exemplo não encontrado');
    return sendFile(res, path.join(__dirname, 'examples', name), MIME_BY_EXTENSION['.json']);
  }
  if (method === 'GET' && pathname.startsWith('/requests/')) {
    const name = pathname.slice('/requests/'.length);
    if (!/^request-[a-z0-9-]+\.txt$/.test(name)) throw new HttpError(404, 'pedido de exemplo não encontrado');
    return sendFile(res, path.join(__dirname, 'examples', name), 'text/plain; charset=utf-8');
  }
  const previewMatch = /^\/preview\/([a-f0-9]{16})\/(preview-\d{3,4}\.png)$/.exec(pathname);
  if (method === 'GET' && previewMatch) {
    const job = jobById(previewMatch[1]);
    if (!PREVIEW_FILE_PATTERN.test(previewMatch[2])) throw new HttpError(404, 'preview não encontrado');
    return sendFile(res, path.join(job.directory, previewMatch[2]), MIME_BY_EXTENSION['.png']);
  }
  const finalMatch = /^\/final\/([a-f0-9]{16})\/(final-\d{3,4}\.(?:png|jpg|jpeg|exr))$/i.exec(pathname);
  if (method === 'GET' && finalMatch) {
    const job = jobById(finalMatch[1]);
    const file = path.basename(finalMatch[2]);
    if (!FINAL_FILE_PATTERN.test(file)) throw new HttpError(404, 'render final não encontrado');
    return sendFile(res, path.join(job.directory, file), MIME_BY_EXTENSION[path.extname(file).toLowerCase()] || 'application/octet-stream');
  }
  const jobRoute = matchJobRoute(pathname);
  if (jobRoute && method === 'GET' && jobRoute.action === 'manifest') {
    const job = jobById(jobRoute.id);
    const manifest = job.manifest || readManifest(job.directory);
    if (!manifest) throw new HttpError(404, 'manifesto ainda não disponível');
    return sendJson(res, 200, manifest);
  }
  if (method === 'POST' && pathname === '/plan') {
    assertAllowedOrigin(req);
    const body = await readJsonBody(req, LIMITS.maxBodyBytes);
    if (!body || typeof body.request !== 'string' || body.request.trim().length === 0) {
      throw new HttpError(400, 'corpo deve ser {"request": "pedido em texto"}');
    }
    let result;
    try {
      result = plan(body.request);
    } catch (error) {
      if (error instanceof TypeError) throw new HttpError(400, error.message);
      throw error;
    }
    return sendJson(res, 200, result);
  }
  if (method === 'POST' && pathname === '/jobs') {
    assertAllowedOrigin(req);
    const body = await readJsonBody(req, LIMITS.maxBodyBytes);
    const job = await createJob(body);
    return sendJson(res, 202, { id: job.id, state: job.state, stage: job.stage });
  }
  if (jobRoute && jobRoute.action === 'approve' && method === 'POST') {
    assertAllowedOrigin(req);
    const job = jobById(jobRoute.id);
    if (job.state !== 'waiting' || job.stage !== 'approval') {
      throw new HttpError(409, `job está em "${job.stage}/${job.state}"; só é possível aprovar em "approval/waiting"`);
    }
    job.approved = true;
    job.state = 'running';
    job.stage = 'final';
    job.substep = null;
    job.updatedAt = nowIso();
    addLog(job, 'info', 'aprovação recebida; render final na fila do renderer');
    scheduleBroadcast();
    sendJson(res, 202, { id: job.id, state: job.state, stage: job.stage });
    runFinal(job);
    return undefined;
  }
  if (jobRoute && jobRoute.action === 'commands' && method === 'POST') {
    assertAllowedOrigin(req);
    const job = jobById(jobRoute.id);
    if (job.state !== 'waiting' || job.stage !== 'approval') {
      throw new HttpError(409, `job está em "${job.stage}/${job.state}"; comandos só são aceitos em "approval/waiting"`);
    }
    const body = await readJsonBody(req, LIMITS.maxBodyBytes);
    const nextSpec = applyCommand(job.spec, body);
    job.spec = nextSpec;
    job.summary = summarize(nextSpec);
    job.commands.push({ op: body.op, at: nowIso() });
    job.approved = false;
    job.state = 'running';
    job.stage = 'build';
    job.updatedAt = nowIso();
    addLog(job, 'info', `comando "${body.op}" aplicado; gerando novo preview`);
    scheduleBroadcast();
    sendJson(res, 202, { id: job.id, op: body.op, state: job.state, stage: job.stage });
    runCommandPreview(job);
    return undefined;
  }

  throw new HttpError(404, 'rota não encontrada');
}

function handleError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof ValidationError) {
    const details = Array.isArray(error.details) && error.details.length > 0 ? error.details : [error.message];
    sendJson(res, 400, { error: 'spec inválida', details });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.statusCode, { error: error.message });
    return;
  }
  console.error('[blender-director] erro não tratado:', error);
  sendJson(res, 500, { error: 'erro interno do servidor' });
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const parsed = {
    port: Number(process.env.PORT || 8137),
    fakeBlender: false,
    blender: process.env.BLENDER_BIN || 'blender',
    workDir: null,
    timeoutMs: 30 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') parsed.port = Number(argv[++index]);
    else if (arg === '--fake-blender') parsed.fakeBlender = true;
    else if (arg === '--blender') parsed.blender = argv[++index];
    else if (arg === '--work-dir') parsed.workDir = argv[++index];
    else if (arg === '--timeout-ms') parsed.timeoutMs = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Uso: node tools/blender-director/server.js [opções]',
          '',
          '  --port <n>          porta em 127.0.0.1 (padrão 8137; 0 = aleatória)',
          '  --fake-blender      usa o fixture fake-blender.js em vez do Blender',
          '  --blender <caminho> executável do Blender (padrão: BLENDER_BIN ou "blender")',
          '  --work-dir <dir>    diretório de jobs (padrão: <tmp>/blender-director)',
          '  --timeout-ms <n>    timeout por render (padrão 1800000)',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      process.stderr.write(`[blender-director] argumento desconhecido: ${arg}\n`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 0 || parsed.port > 65535) {
    process.stderr.write('[blender-director] porta inválida\n');
    process.exit(2);
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
    process.stderr.write('[blender-director] timeout inválido\n');
    process.exit(2);
  }
  return parsed;
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[blender-director] encerrando (${signal})`);
  if (broadcastTimer) clearTimeout(broadcastTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (renderer) renderer.killAll();
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // já fechado
    }
  }
  sseClients.clear();
  if (server) {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  } else {
    process.exit(0);
  }
}

async function main() {
  options = parseArgs(process.argv.slice(2));
  workRoot = options.workDir
    ? path.resolve(options.workDir)
    : path.join(os.tmpdir(), 'blender-director');
  await fsp.mkdir(path.join(workRoot, 'runs'), { recursive: true });

  renderer = createRenderer({
    fake: options.fakeBlender,
    blenderPath: options.blender,
    buildScript: path.join(__dirname, 'build.py'),
    fakeScript: path.join(__dirname, 'fake-blender.js'),
    timeoutMs: options.timeoutMs,
  });

  server = http.createServer((req, res) => {
    const started = Date.now();
    handleRequest(req, res)
      .catch((error) => handleError(res, error))
      .finally(() => {
        if (process.env.BLENDER_DIRECTOR_HTTP_LOG === '1') {
          console.log(`[http] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
        }
      });
  });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.requestTimeout = 0; // renders longos não devem derrubar POSTs de status
  server.headersTimeout = 60000;

  server.listen(options.port, HOST, () => {
    const address = server.address();
    console.log(`[blender-director] v${VERSION} em http://${HOST}:${address.port}`);
    console.log(`[blender-director] renderer: ${renderer.describe()}`);
    console.log(`[blender-director] work dir: ${workRoot}`);
    console.log(`[blender-director] fake-blender: ${options.fakeBlender ? 'sim' : 'não'}`);
  });

  heartbeatTimer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, SSE_HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => {
    console.error('[blender-director] promise rejeitada sem tratamento:', error);
  });
}

main().catch((error) => {
  console.error('[blender-director] falha ao iniciar:', error);
  process.exit(1);
});
