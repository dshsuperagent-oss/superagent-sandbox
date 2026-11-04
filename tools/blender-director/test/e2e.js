#!/usr/bin/env node
'use strict';

/**
 * Teste ponta a ponta do Blender Director, sem Blender instalado.
 *
 * Sobe o servidor com --fake-blender, cria jobs, acompanha o SSE, aplica um
 * comando incremental, aprova o render final e valida previews, PNGs e
 * manifest.json. Também roda `node --check` em todos os .js do diretório.
 *
 * Uso:
 *   node tools/blender-director/test/e2e.js
 *
 * Requer apenas Node 22 (fetch e AbortController nativos).
 */

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { readPNGDimensions } = require('../lib/png');

const TOOL_DIR = path.resolve(__dirname, '..');
const SERVER = path.join(TOOL_DIR, 'server.js');
const EXAMPLES = path.join(TOOL_DIR, 'examples');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  process.stdout.write(`${message}\n`);
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
  assert.ok(files.length >= 5, `esperava pelo menos 5 arquivos .js, encontrei ${files.length}`);
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `node --check falhou em ${path.relative(TOOL_DIR, file)}:\n${result.stderr}`);
  }
  log(`[ok] node --check em ${files.length} arquivos .js`);
}

/** Cliente SSE minimalista. */
function openEventStream(baseUrl) {
  const events = [];
  const stateSnapshots = [];
  const waiters = new Set();
  let buffer = '';
  let closed = false;

  const ready = new Promise((resolve, reject) => {
    const request = http.get(`${baseUrl}/events`, { headers: { Accept: 'text/event-stream' } }, (response) => {
      assert.equal(response.statusCode, 200, `SSE status ${response.statusCode}`);
      assert.match(response.headers['content-type'] || '', /text\/event-stream/);
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const payload = JSON.parse(line.slice(6));
              events.push(payload);
              if (payload.type === 'state' && payload.state) {
                stateSnapshots.push(payload.state);
                for (const waiter of [...waiters]) {
                  try {
                    if (waiter.predicate(payload.state)) {
                      waiters.delete(waiter);
                      waiter.resolve(payload.state);
                    }
                  } catch (error) {
                    waiters.delete(waiter);
                    waiter.reject(error);
                  }
                }
              }
            } catch {
              // heartbeat ou linha não-JSON
            }
          }
          index = buffer.indexOf('\n\n');
        }
      });
      response.on('end', () => {
        closed = true;
      });
      resolve();
    });
    request.on('error', reject);
  });

  function waitForState(predicate, timeoutMs = 15000) {
    const found = [...stateSnapshots].reverse().find((state) => {
      try {
        return predicate(state);
      } catch {
        return false;
      }
    });
    if (found) return Promise.resolve(found);
    if (closed) return Promise.reject(new Error('SSE fechou antes da condição esperada'));
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (state) => {
          clearTimeout(timer);
          resolve(state);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error('timeout esperando estado via SSE'));
      }, timeoutMs);
      waiters.add(waiter);
    });
  }

  function close() {
    closed = true;
    for (const waiter of waiters) waiter.reject(new Error('SSE fechado'));
    waiters.clear();
    // A conexão http.get não é referenciada diretamente; encerramos o processo
    // filho no final, o que fecha o socket.
  }

  return { ready, events, stateSnapshots, waitForState, close };
}

async function main() {
  checkSyntax();

  const plannerRun = spawnSync(process.execPath, [path.join(__dirname, 'planner-e2e.js')], { encoding: 'utf8' });
  if (plannerRun.status !== 0) {
    process.stderr.write(plannerRun.stdout || '');
    process.stderr.write(plannerRun.stderr || '');
    throw new Error('teste de fixture do planner/crítico falhou');
  }
  log('[ok] planner e crítico passaram no teste de fixture');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-director-e2e-'));
  const serverStarted = new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SERVER, '--fake-blender', '--port', '0', '--work-dir', workDir],
      { env: { ...process.env, BLENDER_DIRECTOR_FAKE_DELAY_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`servidor não iniciou em 10s:\n${stdout}\n${stderr}`));
    }, 10000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), getStderr: () => stderr, getStdout: () => stdout });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`servidor saiu com código ${code}:\n${stdout}\n${stderr}`));
      }
    });
  });

  let child;
  let baseUrl;
  let sse;
  let started;
  try {
    started = await serverStarted;
    child = started.child;
    baseUrl = `http://127.0.0.1:${started.port}`;
    log(`[ok] servidor fixture em ${baseUrl}`);

    async function request(method, route, body, extraHeaders = {}) {
      const headers = { ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, headers: response.headers, json, text };
    }

    async function fetchState() {
      const response = await request('GET', '/state');
      assert.equal(response.status, 200);
      return response.json;
    }

    async function waitForState(predicate, timeoutMs = 20000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const state = await fetchState();
        if (predicate(state)) return state;
        await sleep(60);
      }
      const state = await fetchState();
      throw new Error(`timeout esperando condição; estado atual: ${JSON.stringify(state.jobs?.map((job) => ({ id: job.id, stage: job.stage, state: job.state, previews: job.previews.length, error: job.error })), null, 2)}`);
    }

    // 1. Viewer é servido em /
    const viewer = await request('GET', '/');
    assert.equal(viewer.status, 200);
    assert.match(viewer.headers.get('content-type') || '', /text\/html/);
    assert.match(viewer.text, /Aprovar render final/);
    assert.match(viewer.text, /Blender Director/);
    log('[ok] viewer servido em /');

    // 2. Estado inicial
    const initialState = await fetchState();
    assert.equal(initialState.fakeBlender, true);
    assert.deepEqual(initialState.jobs, []);
    assert.deepEqual(initialState.queue, []);
    log('[ok] /state inicial vazio e fakeBlender=true');

    // 3. Spec inválida
    const invalid = await request('POST', '/jobs', { name: 'sem objetos' });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json.error, /spec inválida/);
    assert.ok(invalid.json.details.some((detail) => /objects/.test(detail)), invalid.text);
    log('[ok] spec inválida rejeitada com 400 e detalhes');

    // 4. Origem remota não pode criar job
    const evilOrigin = await request('POST', '/jobs', { name: 'csrf', objects: [{ primitive: 'cube' }] }, { Origin: 'https://evil.example' });
    assert.equal(evilOrigin.status, 403);
    log('[ok] origem externa rejeitada (403)');

    // 5. SSE conecta
    sse = openEventStream(baseUrl);
    await sse.ready;
    await sse.waitForState((state) => Array.isArray(state.jobs));
    log('[ok] SSE conectado e recebeu snapshot');

    // 6. Cria job 1
    const baseSpec = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'scene-simple.json'), 'utf8'));
    const specOne = {
      ...baseSpec,
      name: 'E2E cena simples',
      samples: 64,
      resolution: [960, 600],
      preview: { maxSize: 640, samples: 16 },
    };
    const created = await request('POST', '/jobs', specOne);
    assert.equal(created.status, 202, created.text);
    const jobOneId = created.json.id;
    assert.match(jobOneId, /^[a-f0-9]{16}$/);
    log(`[ok] job 1 criado: ${jobOneId}`);

    const waitingOne = await waitForState(
      (state) => state.jobs.some((job) => job.id === jobOneId && job.state === 'waiting' && job.stage === 'approval'),
    );
    const jobOne = waitingOne.jobs.find((job) => job.id === jobOneId);
    assert.equal(jobOne.previews.length, 1);
    assert.equal(jobOne.error, null);
    log('[ok] job 1 chegou em approval/waiting com 1 preview');

    // 7. SSE refletiu o estado
    const sseState = await sse.waitForState(
      (state) => state.jobs.some((job) => job.id === jobOneId && job.state === 'waiting'),
    );
    assert.ok(sse.events.length >= 2);
    assert.ok(sseState.jobs.some((job) => job.id === jobOneId));
    log(`[ok] SSE entregou ${sse.events.length} mensagens de estado`);

    // 8. Preview PNG válido
    const preview = await fetch(`${baseUrl}${jobOne.previews[0].url}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    const dimensions = readPNGDimensions(previewBytes);
    assert.ok(dimensions, 'preview não é um PNG válido');
    assert.equal(dimensions.width, 640);
    assert.equal(dimensions.height, 400);
    log(`[ok] preview PNG ${dimensions.width}x${dimensions.height}`);

    // 9. Comando incremental gera novo preview
    const command = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'command-add-light.json'), 'utf8'));
    const commandResponse = await request('POST', `/jobs/${jobOneId}/commands`, command);
    assert.equal(commandResponse.status, 202, commandResponse.text);
    const afterCommand = await waitForState(
      (state) => {
        const job = state.jobs.find((item) => item.id === jobOneId);
        return job && job.state === 'waiting' && job.previews.length === 2;
      },
    );
    const jobAfterCommand = afterCommand.jobs.find((job) => job.id === jobOneId);
    assert.equal(jobAfterCommand.summary.lights, baseSpec.lights.length + 1);
    assert.equal(jobAfterCommand.commands.length, 1);
    assert.equal(jobAfterCommand.commands[0].op, 'add_light');
    assert.equal(jobAfterCommand.metrics.preview.samples, 16);
    log('[ok] comando add_light gerou preview #2 e atualizou o resumo');

    // 10. set_material gera preview #3 e a câmera se move no preview #4
    const materialResponse = await request('POST', `/jobs/${jobOneId}/commands`, {
      op: 'set_material',
      name: 'piso',
      metallic: 0.9,
      roughness: 0.2,
    });
    assert.equal(materialResponse.status, 202, materialResponse.text);
    const afterMaterial = await waitForState((state) => {
      const job = state.jobs.find((item) => item.id === jobOneId);
      return job && job.state === 'waiting' && job.previews.length === 3;
    });
    const jobAfterMaterial = afterMaterial.jobs.find((job) => job.id === jobOneId);
    assert.equal(jobAfterMaterial.commands.length, 2);
    assert.equal(jobAfterMaterial.commands[1].op, 'set_material');

    const cameraBefore = jobAfterMaterial.summary.camera.location;
    const cameraResponse = await request('POST', `/jobs/${jobOneId}/commands`, {
      op: 'move_camera',
      location: [2, 2, 2],
    });
    assert.equal(cameraResponse.status, 202, cameraResponse.text);
    const afterCamera = await waitForState((state) => {
      const job = state.jobs.find((item) => item.id === jobOneId);
      return job && job.state === 'waiting' && job.previews.length === 4;
    });
    const jobAfterCamera = afterCamera.jobs.find((job) => job.id === jobOneId);
    assert.deepEqual(jobAfterCamera.summary.camera.location, [2, 2, 2]);
    assert.deepEqual(jobAfterCamera.summary.camera.location !== cameraBefore, true);
    assert.equal(jobAfterCamera.commands.length, 3);
    assert.equal(jobAfterCamera.commands[2].op, 'move_camera');
    log('[ok] comandos set_material e move_camera geraram previews #3 e #4');

    // 11. Comandos inválidos
    const badCommand = await request('POST', `/jobs/${jobOneId}/commands`, { op: 'explode' });
    assert.equal(badCommand.status, 400);
    const missingMaterial = await request('POST', `/jobs/${jobOneId}/commands`, { op: 'set_material', name: 'nao_existe', roughness: 0.1 });
    assert.equal(missingMaterial.status, 400);
    log('[ok] comandos inválidos rejeitados (400)');

    // 12. Job 2 entra na fila enquanto job 1 aguarda aprovação
    const specTwo = { ...specOne, name: 'E2E fila' };
    const createdTwo = await request('POST', '/jobs', specTwo);
    assert.equal(createdTwo.status, 202);
    const jobTwoId = createdTwo.json.id;
    const queuedState = await fetchState();
    const queuedJob = queuedState.jobs.find((job) => job.id === jobTwoId);
    assert.equal(queuedJob.state, 'queued');
    assert.ok(queuedState.queue.some((item) => item.id === jobTwoId));
    log('[ok] job 2 enfileirado sem interromper a aprovação do job 1');

    // 13. Aprovação do job 1
    const approved = await request('POST', `/jobs/${jobOneId}/approve`, {});
    assert.equal(approved.status, 202, approved.text);
    const doneOneState = await waitForState(
      (state) => state.jobs.some((job) => job.id === jobOneId && job.state === 'done' && job.stage === 'done'),
    );
    const doneOne = doneOneState.jobs.find((job) => job.id === jobOneId);
    assert.ok(doneOne.final, 'job aprovado não tem render final');
    assert.equal(doneOne.final.samples, 64);
    assert.equal(doneOne.final.width, 960);
    assert.equal(doneOne.final.height, 600);
    const finalResponse = await fetch(`${baseUrl}${doneOne.final.url}`);
    assert.equal(finalResponse.status, 200);
    const finalBytes = Buffer.from(await finalResponse.arrayBuffer());
    const finalDimensions = readPNGDimensions(finalBytes);
    assert.ok(finalDimensions, 'render final não é um PNG válido');
    assert.equal(finalDimensions.width, 960);
    assert.equal(finalDimensions.height, 600);
    log('[ok] render final aprovado e PNG 960x600 válido');

    // 14. Manifesto agregado
    const manifest = await request('GET', `/jobs/${jobOneId}/manifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.json.engine, 'CYCLES');
    assert.equal(manifest.json.samples, 64);
    assert.equal(manifest.json.resolution[0], 960);
    assert.equal(manifest.json.previews.length, 4);
    assert.equal(manifest.json.previews[0].samples, 16);
    assert.equal(manifest.json.final.samples, 64);
    assert.ok(manifest.json.final.seconds > 0);
    assert.match(manifest.json.generator, /fake-blender/);
    log('[ok] manifest.json com previews, final, samples e tempos');

    // 15. Aprovar de novo dá 409
    const approveAgain = await request('POST', `/jobs/${jobOneId}/approve`, {});
    assert.equal(approveAgain.status, 409);
    const commandAfterDone = await request('POST', `/jobs/${jobOneId}/commands`, { op: 'move_camera', location: [1, 1, 1] });
    assert.equal(commandAfterDone.status, 409);
    log('[ok] segunda aprovação e comando após done rejeitados (409)');

    // 16. Fila avançou para o job 2
    const waitingTwoState = await waitForState(
      (state) => state.jobs.some((job) => job.id === jobTwoId && job.state === 'waiting' && job.stage === 'approval'),
    );
    const waitingTwo = waitingTwoState.jobs.find((job) => job.id === jobTwoId);
    assert.ok(waitingTwo.previews.length >= 1);
    assert.equal(waitingTwoState.queue.length, 0);
    const approvedTwo = await request('POST', `/jobs/${jobTwoId}/approve`, {});
    assert.equal(approvedTwo.status, 202);
    await waitForState((state) => state.jobs.some((job) => job.id === jobTwoId && job.state === 'done'));
    log('[ok] fila processou o job 2 após o job 1');

    // 17. Arquivos inexistentes e exemplo
    const missingPreview = await request('GET', `/preview/${jobOneId}/preview-999.png`);
    assert.equal(missingPreview.status, 404);
    const example = await request('GET', '/examples/scene-studio.json');
    assert.equal(example.status, 200);
    assert.equal(example.json.name.includes('Estúdio'), true);
    const missingExample = await request('GET', '/examples/nao-existe.json');
    assert.equal(missingExample.status, 404);
    log('[ok] 404 para preview inexistente e exemplos servidos');

    // 17b. Planner v2 (aditivo): pedido em texto -> plano + scene-spec
    const requestExample = await request('GET', '/requests/request-produto.txt');
    assert.equal(requestExample.status, 200);
    assert.match(requestExample.text, /perfume/i);
    const planResponse = await request('POST', '/plan', { request: requestExample.text.trim() });
    assert.equal(planResponse.status, 200, planResponse.text);
    assert.equal(planResponse.json.planVersion, 1);
    assert.equal(planResponse.json.source, 'rules');
    assert.ok(Array.isArray(planResponse.json.steps) && planResponse.json.steps.length >= 8);
    assert.ok(planResponse.json.sceneSpec && planResponse.json.sceneSpec.objects.length >= 1);
    assert.ok(planResponse.json.critic.metrics.includes('ssim'));
    const emptyPlan = await request('POST', '/plan', { request: '   ' });
    assert.equal(emptyPlan.status, 400);
    const invalidPlan = await request('POST', '/plan', {});
    assert.equal(invalidPlan.status, 400);
    const planJob = await request('POST', '/jobs', planResponse.json.sceneSpec);
    assert.equal(planJob.status, 202, planJob.text);
    assert.match(planJob.json.id, /^[a-f0-9]{16}$/);
    const planJobId = planJob.json.id;
    await waitForState((state) => state.jobs.some((job) => job.id === planJobId && job.state === 'waiting'));
    const planApproved = await request('POST', `/jobs/${planJobId}/approve`, {});
    assert.equal(planApproved.status, 202);
    await waitForState((state) => state.jobs.some((job) => job.id === planJobId && job.state === 'done'));
    const missingRequest = await request('GET', '/requests/request-nao-existe.txt');
    assert.equal(missingRequest.status, 404);
    log('[ok] /plan e /requests: pedido -> plano -> scene-spec aceita por POST /jobs');

    // 18. Nenhum job terminou em erro
    const finalState = await fetchState();
    const errors = finalState.jobs.filter((job) => job.state === 'error');
    assert.deepEqual(errors, [], `jobs em erro: ${JSON.stringify(errors, null, 2)}`);

    log('\nTodos os testes e2e passaram.');
    return 0;
  } catch (error) {
    console.error('\nFALHA NO E2E:', error && error.stack ? error.stack : error);
    if (started) {
      console.error('--- stdout do servidor ---\n' + started.getStdout());
      console.error('--- stderr do servidor ---\n' + started.getStderr());
    }
    return 1;
  } finally {
    if (sse) sse.close();
    if (child) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(2000),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}


main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('FALHA NÃO TRATADA:', error);
    process.exit(1);
  });
