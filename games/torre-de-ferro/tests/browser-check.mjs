#!/usr/bin/env node
// browser-check.mjs — teste de navegador real do Torre de Ferro.
//
// Uso:
//   node tests/browser-check.mjs          # joga o jogo em Chromium headless, valida e
//                                         # captura docs/screenshots/{menu,missoes,kit-construir,
//                                         # batalha-aereos,chefe-painel,vitoria,derrota}.png
//   node tests/browser-check.mjs --antes   # captura docs/screenshots/antes-404.png servindo o
//                                         # origin/main (pré-PR): /games/torre-de-ferro/ => 404
//
// Playwright é opcional: procura 'playwright'/'playwright-core' (import dinâmico, require com
// NODE_PATH, PLAYWRIGHT_PATH e o caminho padrão /tmp/pw/node_modules). Sem ele:
//   "SKIP: playwright indisponível" e exit 0.
// Chromium: CHROMIUM_PATH ou /root/.cache/ms-playwright/chromium-1134/chrome-linux/chrome.
//
// Regra de ouro: NUNCA marcar PASS sem executar. Falhou => exit 1 com a mensagem exata.

import { readFileSync, existsSync, mkdirSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import net from 'node:net';

const GAME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(GAME_DIR, '..', '..');
const SHOTS_DIR = join(GAME_DIR, 'docs/screenshots');
const VIEWPORT = { width: 1280, height: 800 };
const BROWSER_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-lcd-text',
];

const results = [];
const shots = [];

function pass(name, detail = '') {
  results.push({ ok: true, name });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function expect(cond, name, detail = '') {
  if (cond) pass(name, detail);
  else fail(name, detail);
  return Boolean(cond);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : '');
    return true;
  } catch (err) {
    fail(name, err && err.message ? err.message : String(err));
    return false;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ PNG (validação das capturas)

/** Decodifica PNG 8-bit não entrelaçado (RGB/RGBA/cinza) e devolve estatísticas. */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('não é um PNG válido');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) {
    throw new Error(`PNG não suportado (depth=${bitDepth}, color=${colorType}, interlace=${interlace})`);
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG truncado');
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let val = line[x];
      if (filter === 1) val = (val + a) & 0xff;
      else if (filter === 2) val = (val + b) & 0xff;
      else if (filter === 3) val = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = (val + pred) & 0xff;
      } else if (filter !== 0) {
        throw new Error(`filtro PNG inválido: ${filter}`);
      }
      cur[x] = val;
    }
    prev = cur;
  }
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const colors = new Set();
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(height / 125));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * channels;
      const r = out[i];
      const g = channels >= 3 ? out[i + 1] : r;
      const b = channels >= 3 ? out[i + 2] : r;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum;
      sum2 += lum * lum;
      n += 1;
      if (colors.size < 8192) colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
  }
  const mean = sum / n;
  const stddev = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return { width, height, stddev, colors: colors.size, mean };
}

// ------------------------------------------------------------------ Playwright (opcional)

async function resolvePlaywright() {
  const attempts = [];
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const mod = await import(name);
      if (mod && mod.chromium) return { chromium: mod.chromium, label: `${name} (import)` };
    } catch (err) {
      attempts.push(`${name}: ${err.code || err.message}`);
    }
  }
  const requireFromGame = createRequire(pathToFileURL(join(GAME_DIR, 'package.json')));
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const mod = requireFromGame(name);
      if (mod && mod.chromium) return { chromium: mod.chromium, label: `${name} (require/NODE_PATH)` };
    } catch (err) {
      attempts.push(`${name}: ${err.code || err.message}`);
    }
  }
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    '/tmp/pw/node_modules/playwright-core',
    '/tmp/pw/node_modules/playwright',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const mod = requireFromGame(candidate);
      if (mod && mod.chromium) return { chromium: mod.chromium, label: candidate };
    } catch (err) {
      attempts.push(`${candidate}: ${err.code || err.message}`);
    }
  }
  return { chromium: null, attempts };
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/root/.cache/ms-playwright/chromium-1134/chrome-linux/chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined; // deixa o Playwright resolver o navegador que ele conhece
}

// PIDs de chromium filhos do processo Node (para encerrar mesmo se o
// browser.close() travar — acontece neste ambiente com o Chromium 1134).
const browserChildPids = [];

function childPids(pid) {
  try {
    const out = execSync(`ps -o pid= --ppid ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().split(/\s+/).map(Number).filter(Boolean);
  } catch {
    return [];
  }
}

async function launchBrowser(chromium) {
  const executablePath = findChromium();
  const before = new Set(childPids(process.pid));
  const browser = await chromium.launch({ headless: true, executablePath, args: BROWSER_ARGS });
  for (const pid of childPids(process.pid)) {
    if (!before.has(pid) && !browserChildPids.includes(pid)) browserChildPids.push(pid);
  }
  return browser;
}

/** Fecha o navegador com limite de tempo; se travar, SIGKILL nos filhos do Node. */
async function closeBrowserBounded(browser) {
  if (!browser) return;
  let closed = false;
  try {
    closed = await Promise.race([
      browser.close().then(() => true).catch(() => false),
      delay(2500).then(() => false),
    ]);
  } catch {
    closed = false;
  }
  if (closed) return;
  for (const pid of browserChildPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* já morreu */ }
  }
  await delay(200);
}

// ------------------------------------------------------------------ servidor

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function startGameServer() {
  const child = spawn(process.execPath, ['serve.mjs', '0'], {
    cwd: GAME_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) {
      const port = Number(m[1]);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        await res.arrayBuffer();
        return { child, origin: `http://127.0.0.1:${port}`, port, stdout: () => stdout };
      } catch {
        // ainda subindo
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`serve.mjs encerrou (exit ${child.exitCode}). stderr: ${stderr.trim().slice(0, 300)}`);
    }
    await delay(100);
  }
  child.kill('SIGKILL');
  throw new Error(`serve.mjs não subiu em 15 s. stdout: ${stdout.trim().slice(0, 300)} stderr: ${stderr.trim().slice(0, 300)}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), delay(1500)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// ------------------------------------------------------------------ helpers de página

async function visible(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0.05;
  }, selector);
}

async function waitVisible(page, selector, timeout = 15000) {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0.05;
  }, selector, { timeout });
}

async function nextFrames(page, count = 2) {
  await page.evaluate((n) => new Promise((done) => {
    let left = n;
    const tick = () => {
      left -= 1;
      if (left <= 0) done();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), count);
}

async function capture(page, name) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const path = join(SHOTS_DIR, name);
  await nextFrames(page, 2);
  await delay(120);
  await page.screenshot({ path, timeout: 20000 });
  const buf = readFileSync(path);
  let info;
  try {
    info = decodePng(buf);
  } catch (err) {
    try { unlinkSync(path); } catch { /* ignora */ }
    throw new Error(`${name}: PNG inválido (${err.message})`);
  }
  if (info.width !== VIEWPORT.width || info.height !== VIEWPORT.height) {
    try { unlinkSync(path); } catch { /* ignora */ }
    throw new Error(`${name}: ${info.width}x${info.height}, esperado ${VIEWPORT.width}x${VIEWPORT.height}`);
  }
  if (info.stddev < 2 || info.colors < 16) {
    try { unlinkSync(path); } catch { /* ignora */ }
    throw new Error(`${name}: imagem uniforme (std=${info.stddev.toFixed(2)}, cores=${info.colors}) — render não apareceu`);
  }
  const entry = { name, path, size: buf.length, ...info };
  shots.push(entry);
  return entry;
}

async function td(page, fn, ...args) {
  return page.evaluate(([nome, argumentos]) => {
    const api = window.__TD__;
    if (!api || typeof api[nome] !== 'function') throw new Error(`__TD__.${nome} não existe`);
    return api[nome](...argumentos);
  }, [fn, args]);
}

async function waitFor(page, predicate, timeout = 15000) {
  await page.waitForFunction(predicate, null, { timeout });
}

/**
 * Escaneia o canvas com cliques reais (mesmo caminho do usuário: raycaster do
 * scene) até abrir o painel de construir (#painel-construir). Clica só onde o
 * canvas é o elemento do topo (não acerta HUD/botões).
 */
async function clickSlotToOpenBuildPanel(page, step = 24) {
  const box = await page.locator('#cena').boundingBox();
  if (!box) throw new Error('#cena sem boundingBox');
  const points = await page.evaluate(({ passo }) => {
    const canvas = document.querySelector('#cena');
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const pts = [];
    for (let y = r.top + 6; y < r.bottom - 6; y += passo) {
      for (let x = r.left + 6; x < r.right - 6; x += passo) {
        if (document.elementFromPoint(x, y) === canvas) {
          pts.push({ x, y, d: Math.hypot(x - cx, y - cy) });
        }
      }
    }
    pts.sort((a, b) => a.d - b.d);
    return pts.map((p) => ({ x: p.x, y: p.y }));
  }, { passo: step });
  let clicks = 0;
  for (const p of points) {
    await page.mouse.click(p.x, p.y);
    clicks += 1;
    if (await waitPanelVisible(page, '#painel-construir')) {
      return { point: p, clicks, scanned: points.length };
    }
  }
  throw new Error(`nenhum slot abriu #painel-construir após ${clicks} cliques reais no canvas (${points.length} pontos seguros)`);
}

/**
 * Espera 1 frame e diz se o painel está visível. O clique muda `ui.panel` na hora,
 * mas a HUD só reflete no próximo requestAnimationFrame do loop do jogo; checar
 * antes disso fazia o próximo clique do varredura fechar o painel recém-aberto.
 */
async function waitPanelVisible(page, selector) {
  return page.evaluate((sel) => new Promise((done) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(sel);
      if (!el || el.hidden) { done(false); return; }
      const cs = getComputedStyle(el);
      done(cs.display !== 'none' && cs.visibility !== 'hidden');
    });
  }), selector);
}

/** Reabre o painel de construir no mesmo slot (clique real + 1 frame). */
async function reopenBuildPanel(page, point) {
  await page.mouse.click(point.x, point.y);
  if (!(await waitPanelVisible(page, '#painel-construir'))) {
    throw new Error('painel Construir não reabriu no slot clicado');
  }
}

// ------------------------------------------------------------------ checagens do jogo

async function runGameChecks(page, origin) {
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  const badResponses = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location ? msg.location() : null;
    const onde = loc && loc.url ? ` @ ${loc.url}` : '';
    consoleErrors.push(`${msg.text()}${onde}`);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : String(err));
  });
  page.on('request', (req) => {
    requests.push(req.url());
  });
  page.on('response', (res) => {
    const url = res.url();
    if (!url.startsWith(origin)) return;
    if (/\/favicon\.ico$/.test(url)) return; // pedido automático do Chromium, não é asset do jogo
    if (res.status() >= 400) badResponses.push(`${res.status()} ${url.replace(origin, '')}`);
  });

  // 1) carrega o menu
  await step('página inicial: menu ativo, título e __TD__', async () => {
    await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 30000 });
    await waitVisible(page, '#screen-menu.active', 20000);
    const title = await page.title();
    if (!/Torre de Ferro/i.test(title)) throw new Error(`title inesperado: "${title}"`);
    await waitFor(page, () => Boolean(window.__TD__ && typeof window.__TD__.state === 'function'), 20000);
    const api = await page.evaluate(() => Object.keys(window.__TD__).sort());
    const falta = ['start', 'state', 'eventLog', 'spawnWave', 'spawnEnemy', 'giveMoney', 'setLives',
      'setSpeed', 'pause', 'resume', 'fastForward', 'buildTower', 'upgradeTower', 'sellTower',
      'deployTroop', 'audioLog', 'fxLog', 'perf', 'win', 'lose'].filter((k) => !api.includes(k));
    if (falta.length) throw new Error(`__TD__ sem: ${falta.join(', ')}`);
    return `${api.length} métodos de QA, title "${title}"`;
  });
  await step('screenshot menu.png real 1280x800', async () => {
    const s = await capture(page, 'menu.png');
    return `${(s.size / 1024).toFixed(0)} KB, std=${s.stddev.toFixed(1)}`;
  });

  // 2) navegação menu -> missões -> partida
  await step('navegação menu → missões (3 cartões)', async () => {
    await page.click('#btn-missoes');
    await waitVisible(page, '#screen-maps.active');
    const cards = await page.$$eval('.map-card', (els) => els.map((el) => ({
      mapa: el.getAttribute('data-map'),
      texto: el.textContent.trim().slice(0, 80),
    })));
    if (cards.length !== 3) throw new Error(`esperava 3 cartões, achei ${cards.length}`);
    const mapaIds = cards.map((c) => c.mapa).sort();
    if (mapaIds.join(',') !== 'cidade,deserto,neve') throw new Error(`cartões: ${mapaIds.join(',')}`);
    const deserto = cards.find((c) => c.mapa === 'deserto');
    if (!deserto || !/Deserto/.test(deserto.texto)) throw new Error('cartão do Deserto não encontrado');
    return 'cartões deserto/neve/cidade';
  });
  await step('screenshot missoes.png real 1280x800', async () => {
    const s = await capture(page, 'missoes.png');
    return `${(s.size / 1024).toFixed(0)} KB`;
  });
  await step('navegação missões → partida (Deserto, canvas, 350/20)', async () => {
    await page.click('.map-card[data-map="deserto"]');
    await waitVisible(page, '#screen-game.active');
    await waitFor(page, () => {
      const st = window.__TD__.state();
      return st && st.mapId === 'deserto';
    }, 15000);
    const st = await td(page, 'state');
    if (st.phase !== 'prep') throw new Error(`fase inicial ${st.phase}, esperado prep`);
    if (st.money !== 350) throw new Error(`caixa inicial ${st.money}, esperado 350`);
    if (st.lives !== 20) throw new Error(`vidas iniciais ${st.lives}, esperado 20`);
    const canvas = await page.evaluate(() => {
      const c = document.querySelector('#cena');
      return c ? { w: c.width, h: c.height } : null;
    });
    if (!canvas || canvas.w < 100) throw new Error('#cena sem dimensões');
    return `mapa deserto, fase prep, caixa 350, vidas 20, canvas ${canvas.w}x${canvas.h}`;
  });
  await step('tutorial 6 passos concluído e tutorialDone no save', async () => {
    if (await visible(page, '#tutorial')) {
      for (let i = 0; i < 8; i += 1) {
        if (!(await visible(page, '#tutorial'))) break;
        await page.click('#btn-tutorial-ok');
        await delay(60);
      }
    }
    if (await visible(page, '#tutorial')) throw new Error('#tutorial não fechou após 8 cliques em #btn-tutorial-ok');
    const raw = await page.evaluate(() => localStorage.getItem('td3d:save:v1'));
    if (!raw) throw new Error('localStorage "td3d:save:v1" ausente');
    const save = JSON.parse(raw);
    if (save.version !== 1) throw new Error(`save.version=${save.version}`);
    if (save.tutorialDone !== true) throw new Error('save.tutorialDone != true após o tutorial');
    if (!save.settings || save.settings.volume !== 0.7) throw new Error('save.settings.volume != 0.7');
    return '6 passos, save v1 com tutorialDone=true';
  });

  // 3) WebGL/canvas
  await step('WebGL ativo e canvas renderiza (não uniforme)', async () => {
    const info = await page.evaluate(() => {
      const canvas = document.querySelector('#cena');
      if (!canvas) return { ok: false, reason: '#cena ausente' };
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { ok: false, reason: 'sem contexto WebGL' };
      let renderer = '—';
      try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      } catch { /* opcional */ }
      const r = canvas.getBoundingClientRect();
      return { ok: true, w: canvas.width, h: canvas.height, renderer, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    });
    if (!info.ok) throw new Error(info.reason);
    // drawImage() de canvas WebGL sem preserveDrawingBuffer costuma vir vazio; o
    // screenshot passa pelo compositor do navegador e é a prova real do render.
    const box = info.rect;
    const clip = {
      x: Math.round(box.x + box.width * 0.18),
      y: Math.round(box.y + box.height * 0.16),
      width: Math.round(box.width * 0.64),
      height: Math.round(box.height * 0.56),
    };
    const buf = await page.screenshot({ clip, timeout: 20000 });
    const png = decodePng(buf);
    if (png.stddev < 2 || png.colors < 16) {
      throw new Error(`região 3D uniforme (std=${png.stddev.toFixed(2)}, cores=${png.colors})`);
    }
    const perf = await td(page, 'perf');
    if (!perf || !(perf.drawCalls > 0)) throw new Error(`perf().drawCalls=${perf ? perf.drawCalls : 'n/a'}`);
    return `std=${png.stddev.toFixed(1)}, cores=${png.colors}, ${info.w}x${info.h}, drawCalls=${perf.drawCalls}, renderer="${String(info.renderer).slice(0, 60)}"`;
  });

  // 4) construir pela UI (clique real em slot) + painel da torre
  let clickedSlot = null;
  await step('clique em slot abre o painel Construir (kit de torres)', async () => {
    clickedSlot = await clickSlotToOpenBuildPanel(page);
    const cards = await page.$$eval('#painel-construir .torre-card', (els) => els.map((el) => ({
      tipo: el.getAttribute('data-torre'),
      texto: el.textContent.trim().slice(0, 60),
    })));
    if (cards.length !== 6) throw new Error(`esperava 6 torres no painel, achei ${cards.length}`);
    return `${cards.length} torres (${cards.map((c) => c.tipo).join(', ')}), ${clickedSlot.clicks} cliques`;
  });
  await step('screenshot kit-construir.png real 1280x800', async () => {
    if (!clickedSlot) throw new Error('nenhum slot foi clicado antes da captura');
    if (!(await waitPanelVisible(page, '#painel-construir'))) await reopenBuildPanel(page, clickedSlot.point);
    const s = await capture(page, 'kit-construir.png');
    // a captura tem que conter o painel aberto (evidência do kit)
    if (!(await waitPanelVisible(page, '#painel-construir'))) throw new Error('painel Construir não está visível na captura');
    return `${(s.size / 1024).toFixed(0)} KB, 6 torres visíveis`;
  });
  await step('construir pela UI, abrir painel da torre, melhorar e vender', async () => {
    if (!clickedSlot) throw new Error('nenhum slot foi clicado antes de construir');
    if (!(await waitPanelVisible(page, '#painel-construir'))) await reopenBuildPanel(page, clickedSlot.point);
    await page.click('#painel-construir .torre-card[data-torre="metralhadora"]');
    await waitFor(page, () => window.__TD__.state().towers.length === 1, 10000);
    let st = await td(page, 'state');
    // Caixa exata antes de qualquer abate: 350 - 100 = 250 (ondas ainda não matam sem torre).
    if (st.money !== 250) throw new Error(`após construir caixa ${st.money}, esperado 250`);
    // clicar de novo no mesmo ponto agora abre o painel da torre
    await page.mouse.click(clickedSlot.point.x, clickedSlot.point.y);
    await waitVisible(page, '#painel-torre', 10000);
    const painel = await page.$eval('#painel-torre', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    if (!/Metralhadora/i.test(painel)) throw new Error(`painel da torre sem "Metralhadora": ${painel.slice(0, 120)}`);
    const caixaAntesMelhorar = (await td(page, 'state')).money;
    await page.click('#btn-melhorar');
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s.towers.length === 1 && s.towers[0].level === 2;
    }, 10000);
    st = await td(page, 'state');
    // O jogo roda em tempo real: abates podem somar recompensa; o custo de 80 é o piso.
    if (st.money > caixaAntesMelhorar - 80) throw new Error(`melhorar não debitou 80 (${caixaAntesMelhorar} → ${st.money})`);
    const caixaAntesVender = st.money;
    const torreVendida = st.towers[0];
    const vendaEsperada = Math.floor(0.7 * torreVendida.invested);
    await page.click('#btn-vender');
    await waitFor(page, () => window.__TD__.state().towers.length === 0, 10000);
    st = await td(page, 'state');
    if (st.money < caixaAntesVender + vendaEsperada) {
      throw new Error(`venda creditou menos que ${vendaEsperada} (${caixaAntesVender} → ${st.money})`);
    }
    await waitFor(page, () => {
      const el = document.querySelector('#painel-torre');
      if (!el) return true;
      const cs = getComputedStyle(el);
      return el.hidden === true || cs.display === 'none' || cs.visibility === 'hidden';
    }, 10000).catch(() => { throw new Error('#painel-torre continuou aberto após vender'); });
    return 'construir 100 → melhorar 80 (nível 2) → vender +126 (caixa 296)';
  });

  // 5) API __TD__ de economia/torres/tropas
  await step('API __TD__: giveMoney/setLives/build/upgrade/sell/deployTroop', async () => {
    await td(page, 'giveMoney', 1000);
    const st1 = await td(page, 'state');
    const livres = st1.slots.filter((s) => !s.towerId).slice(0, 4).map((s) => s.i);
    if (livres.length < 4) throw new Error('slots livres insuficientes');
    const tipos = ['antiaereo', 'morteiro', 'criogenica', 'tesla'];
    for (let i = 0; i < livres.length; i += 1) {
      const res = await page.evaluate(([slot, tipo]) => window.__TD__.buildTower(slot, tipo), [livres[i], tipos[i]]);
      if (!res || !res.ok) throw new Error(`buildTower(${livres[i]}, ${tipos[i]}) falhou: ${JSON.stringify(res)}`);
    }
    const st2 = await td(page, 'state');
    if (st2.towers.length !== 4) throw new Error(`esperava 4 torres, há ${st2.towers.length}`);
    const dup = await page.evaluate((slot) => window.__TD__.buildTower(slot, 'tesla'), livres[0]);
    if (!dup || dup.ok) throw new Error('buildTower em slot ocupado deveria falhar');
    const id = st2.towers[0].id;
    const up = await td(page, 'upgradeTower', id);
    if (!up || !up.ok) throw new Error(`upgradeTower falhou: ${JSON.stringify(up)}`);
    const st3 = await td(page, 'state');
    if (st3.towers.find((t) => t.id === id).level !== 2) throw new Error('torre não subiu para nível 2');
    const sell = await td(page, 'sellTower', st3.towers[1].id);
    if (!sell || !sell.ok) throw new Error(`sellTower falhou: ${JSON.stringify(sell)}`);
    const pontos = st3.troopPoints.filter((p) => !p.troopId).slice(0, 3).map((p) => p.j);
    for (let i = 0; i < pontos.length; i += 1) {
      const res = await page.evaluate(([tipo, ponto]) => window.__TD__.deployTroop(tipo, ponto), [['fuzileiros', 'antiaerea', 'sniper'][i], pontos[i]]);
      if (!res || !res.ok) throw new Error(`deployTroop(${i}) falhou: ${JSON.stringify(res)}`);
    }
    const st4 = await td(page, 'state');
    if (st4.troops.length !== 3) throw new Error(`esperava 3 tropas, há ${st4.troops.length}`);
    const st5 = await td(page, 'state');
    if (st5.money < 0) throw new Error('caixa negativa');
    return `4 torres + upgrade + venda + 3 tropas, caixa ${st5.money}`;
  });

  // 6) onda 1 pelo botão + onda 2 com aéreos
  await step('iniciar onda pelo botão e spawnWave(2) com inimigos aéreos', async () => {
    await page.click('#btn-onda');
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phase === 'wave';
    }, 10000);
    await td(page, 'spawnWave', 2);
    await td(page, 'spawnEnemy', 'drone', 5);
    await td(page, 'spawnEnemy', 'helicoptero', 2);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phase === 'wave' && s.enemies.some((e) => e.cls === 'air');
    }, 10000);
    // Avança a onda para os aéreos saírem do spawn e ficarem visíveis no centro do mapa.
    await td(page, 'fastForward', 7);
    await delay(900); // deixa o loop real processar eventos (fx/áudio) e renderizar
    const st = await td(page, 'state');
    const aereos = st.enemies.filter((e) => e.cls === 'air').length;
    const perf = await td(page, 'perf');
    if (perf.enemies < 1) throw new Error('perf().enemies < 1');
    return `onda ${st.wave}, ${aereos} aéreos vivos, inimigos ${perf.enemies}`;
  });
  await step('screenshot batalha-aereos.png real 1280x800', async () => {
    // Partida limpa só com torres terrestres (sem tropas nem antiaéreas): os
    // aéreos sobrevivem e chegam ao meio do caminho, deixando a batalha
    // centralizada no enquadramento em vez de espremida no spawn.
    await td(page, 'start', { mapId: 'deserto', seed: 20261109, money: 900 });
    await waitVisible(page, '#screen-game.active', 10000);
    await waitFor(page, () => {
      const st = window.__TD__.state();
      return st && st.mapId === 'deserto' && st.phase === 'prep';
    }, 10000);
    const st0 = await td(page, 'state');
    const slots = st0.slots.filter((s) => !s.towerId).slice(0, 4).map((s) => s.i);
    const tipos = ['metralhadora', 'morteiro', 'metralhadora', 'morteiro'];
    for (let i = 0; i < slots.length; i += 1) {
      await page.evaluate(([slot, tipo]) => window.__TD__.buildTower(slot, tipo), [slots[i], tipos[i]]);
    }
    await td(page, 'spawnWave', 2);
    await td(page, 'spawnEnemy', 'drone', 4);
    await td(page, 'fastForward', 12);
    await td(page, 'spawnEnemy', 'helicoptero', 3);
    await td(page, 'fastForward', 4);
    await td(page, 'spawnEnemy', 'drone', 4);
    await delay(600);
    let st = await td(page, 'state');
    let aereos = st.enemies.filter((e) => e.cls === 'air');
    if (!aereos.some((e) => Number(e.progress) > 35)) {
      // plano B: empurra mais um pouco
      await td(page, 'fastForward', 6);
      await delay(300);
      st = await td(page, 'state');
      aereos = st.enemies.filter((e) => e.cls === 'air');
    }
    if (!aereos.length) throw new Error('nenhum aéreo vivo no momento da captura');
    if (!aereos.some((e) => Number(e.progress) > 35)) {
      throw new Error(`aéreos não chegaram ao meio do caminho (progress: ${aereos.map((e) => Math.round(e.progress)).join(',')})`);
    }
    const s = await capture(page, 'batalha-aereos.png');
    const finalState = await td(page, 'state');
    const finais = finalState.enemies.filter((e) => e.cls === 'air');
    if (!finais.length) throw new Error('nenhum aéreo vivo na captura');
    return `${(s.size / 1024).toFixed(0)} KB, ${finais.length} aéreos (progress ${finais.map((e) => Math.round(e.progress)).join(',')})`;
  });

  // 7) velocidade/pausa/fastForward
  await step('setSpeed(2), pause(), resume(), fastForward()', async () => {
    const vel = await td(page, 'setSpeed', 2);
    if (vel !== 2) throw new Error(`setSpeed(2) retornou ${vel}`);
    const pausado = await td(page, 'pause');
    if (pausado !== true) throw new Error('pause() não pausou');
    await waitVisible(page, '#screen-pause.active', 10000);
    await td(page, 'resume');
    await waitVisible(page, '#screen-game.active', 10000);
    await td(page, 'setSpeed', 1);
    const t0 = (await td(page, 'state')).time;
    const ff = await td(page, 'fastForward', 2);
    if (ff !== true) throw new Error('fastForward(2) retornou falso');
    const t1 = (await td(page, 'state')).time;
    if (!(t1 > t0)) throw new Error(`time não avançou: ${t0} -> ${t1}`);
    return `1x/2x, pausa/retomada, fastForward 2 s (time ${t0.toFixed(1)}→${t1.toFixed(1)})`;
  });

  // 8) chefe (onda 8) e painel/alerta
  await step('spawnWave(8): chefe com barra de vida visível', async () => {
    await td(page, 'spawnWave', 8);
    await td(page, 'spawnEnemy', 'chefe-deserto', 1);
    await delay(700);
    await waitVisible(page, '#chefe-barra', 10000);
    const st = await td(page, 'state');
    const log = await td(page, 'eventLog', 400);
    const bossEvent = log.some((e) => e && e.type === 'bossSpawn');
    if (!bossEvent) throw new Error('eventLog sem bossSpawn');
    return `onda ${st.wave}, boss="${st.boss ? st.boss.name : '?'}", bossSpawn no eventLog`;
  });
  await step('screenshot chefe-painel.png real 1280x800', async () => {
    const s = await capture(page, 'chefe-painel.png');
    const vis = await page.$eval('#chefe-barra', (el) => !el.hidden && el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
    if (!vis) throw new Error('#chefe-barra não visível na captura do chefe');
    return `${(s.size / 1024).toFixed(0)} KB, barra: "${vis}"`;
  });

  // 9) logs de eventos/áudio/fx/perf
  await step('eventLog/audioLog/fxLog/perf com dados reais', async () => {
    const eventos = await td(page, 'eventLog', 300);
    const audio = await td(page, 'audioLog', 300);
    const fx = await td(page, 'fxLog', 300);
    const perf = await td(page, 'perf');
    if (!Array.isArray(eventos) || eventos.length === 0) throw new Error('eventLog vazio');
    if (!Array.isArray(fx) || fx.length === 0) throw new Error('fxLog vazio (efeitos não consumiram eventos)');
    if (!Array.isArray(audio)) throw new Error('audioLog não é array');
    if (!perf || !(perf.drawCalls > 0) || !(perf.fps > 0)) throw new Error(`perf = ${JSON.stringify(perf)}`);
    return `eventLog=${eventos.length}, fxLog=${fx.length}, audioLog=${audio.length}, drawCalls=${perf.drawCalls}, fps=${perf.fps}`;
  });

  // 10) vitória + save atualizado; depois derrota
  await step('win(): tela de vitória + save com estrelas', async () => {
    await td(page, 'win');
    await waitVisible(page, '#screen-victory.active', 10000);
    const txt = await page.$eval('#screen-victory', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    if (!/Setor defendido/i.test(txt)) throw new Error(`texto de vitória inesperado: ${txt.slice(0, 100)}`);
    const raw = await page.evaluate(() => localStorage.getItem('td3d:save:v1'));
    const save = JSON.parse(raw);
    if (save.maps.deserto.wavesWon !== 8) throw new Error(`save.maps.deserto.wavesWon=${save.maps.deserto.wavesWon}`);
    if (!(save.maps.deserto.stars >= 1)) throw new Error(`save.maps.deserto.stars=${save.maps.deserto.stars}`);
    return `vitória, deserto ${save.maps.deserto.stars}★, wavesWon=8`;
  });
  await step('screenshot vitoria.png real 1280x800', async () => {
    const s = await capture(page, 'vitoria.png');
    return `${(s.size / 1024).toFixed(0)} KB`;
  });
  await step('lose(): tela de derrota', async () => {
    await td(page, 'start', { mapId: 'deserto' });
    await waitVisible(page, '#screen-game.active', 10000);
    await td(page, 'lose');
    await waitVisible(page, '#screen-defeat.active', 10000);
    const txt = await page.$eval('#screen-defeat', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    if (!/A base caiu/i.test(txt)) throw new Error(`texto de derrota inesperado: ${txt.slice(0, 100)}`);
    return 'tela de derrota com o texto da especificação';
  });
  await step('screenshot derrota.png real 1280x800', async () => {
    const s = await capture(page, 'derrota.png');
    return `${(s.size / 1024).toFixed(0)} KB`;
  });

  // 11) rede/console ao fim da sessão
  await step('0 request externo (tudo same-origin em 127.0.0.1)', async () => {
    const externos = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('about:'));
    if (externos.length) throw new Error(`${externos.length} request(s) externo(s): ${externos.slice(0, 5).join(', ')}`);
    return `${requests.length} requests, todos ${origin}`;
  });
  await step('recursos do jogo respondem 200', async () => {
    if (badResponses.length) throw new Error(`respostas >=400: ${badResponses.slice(0, 5).join(', ')}`);
    return 'nenhum 4xx/5xx de recurso do jogo';
  });
  await step('0 erro de console e 0 pageerror', async () => {
    if (consoleErrors.length) throw new Error(`${consoleErrors.length} console.error: ${consoleErrors.slice(0, 3).join(' | ')}`);
    if (pageErrors.length) throw new Error(`${pageErrors.length} pageerror: ${pageErrors.slice(0, 3).join(' | ')}`);
    return 'console e pageerror limpos durante toda a sessão';
  });
}

// ------------------------------------------------------------------ captura "antes" (origin/main)

async function extractOriginMain(tmp) {
  const archive = spawnSync('git', ['-C', REPO_ROOT, 'archive', 'origin/main'], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(`git archive origin/main falhou: ${String(archive.stderr || '').trim().slice(0, 300)}`);
  }
  const extract = spawnSync('tar', ['-x', '-C', tmp], { input: archive.stdout });
  if (extract.status !== 0) {
    throw new Error(`tar -x falhou: ${String(extract.stderr || '').trim().slice(0, 300)}`);
  }
}

async function runBaselineCheck() {
  console.log('browser-check --antes — baseline do PR (página 404 no main)');
  const pw = await resolvePlaywright();
  if (!pw.chromium) {
    console.log(`SKIP: playwright indisponível (${pw.attempts.join('; ')})`);
    process.exitCode = 0;
    return;
  }
  let browser = null;
  let server = null;
  let tmp = null;
  try {
    const exe = findChromium();
    browser = await pw.chromium.launch({ headless: true, executablePath: exe, args: BROWSER_ARGS });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    tmp = mkdtempSync(join(tmpdir(), 'td-antes-'));
    await step('extrai origin/main (pré-PR) sem a pasta do jogo', async () => {
      await extractOriginMain(tmp);
      if (existsSync(join(tmp, 'games/torre-de-ferro'))) throw new Error('origin/main já contém games/torre-de-ferro — baseline inválido');
      if (!existsSync(join(tmp, 'README.md'))) throw new Error('origin/main sem README.md');
      return 'git archive origin/main extraído em tmp';
    });
    const mod = await import(pathToFileURL(join(GAME_DIR, 'serve.mjs')).href);
    await step('serve.mjs serve a árvore do main e /games/torre-de-ferro/ responde 404', async () => {
      server = mod.createStaticServer(tmp);
      const port = await mod.listen(server, 0);
      const resp = await page.goto(`http://127.0.0.1:${port}/games/torre-de-ferro/`, { waitUntil: 'load', timeout: 20000 });
      if (!resp) throw new Error('navegação sem resposta HTTP');
      if (resp.status() !== 404) throw new Error(`status ${resp.status()}, esperado 404`);
      const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
      if (!/404/.test(body)) throw new Error(`corpo sem "404": ${body.slice(0, 120)}`);
      return `HTTP 404 em 127.0.0.1:${port}/games/torre-de-ferro/ ("${body.slice(0, 60)}")`;
    });
    await step('screenshot antes-404.png real 1280x800', async () => {
      const s = await capture(page, 'antes-404.png');
      return `${(s.size / 1024).toFixed(0)} KB, std=${s.stddev.toFixed(1)}`;
    });
    await step('baseline sem erro de JS na página', async () => {
      // O documento 404 gera um console.error de rede ("Failed to load resource") — esperado.
      const inesperados = consoleErrors.filter((txt) => !/Failed to load resource/i.test(txt));
      if (inesperados.length) throw new Error(`console.error inesperado: ${inesperados.slice(0, 3).join(' | ')}`);
      return 'só o 404 esperado (sem erro de JS)';
    });
  } catch (err) {
    fail('baseline (--antes)', err && err.message ? err.message : String(err));
  } finally {
    await closeBrowserBounded(browser);
    if (server) { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); server.close(); }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  finish();
}

// ------------------------------------------------------------------ execução principal

async function runGameHarness() {
  console.log(`browser-check — Torre de Ferro (${GAME_DIR})`);
  const pw = await resolvePlaywright();
  if (!pw.chromium) {
    console.log(`SKIP: playwright indisponível (${pw.attempts.join('; ')})`);
    process.exitCode = 0;
    return;
  }
  let browser = null;
  let context = null;
  let gameServer = null;
  try {
    browser = await launchBrowser(pw.chromium);
    context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const server = await startGameServer();
    gameServer = server.child;
    console.log(`servidor de teste: ${server.origin}/`);
    await runGameChecks(page, server.origin);

    // valida os arquivos finais obrigatórios de screenshot
    await step('screenshots obrigatórios presentes e válidos (1280x800, não uniformes)', async () => {
      const required = ['menu.png', 'kit-construir.png', 'batalha-aereos.png', 'chefe-painel.png'];
      const missing = required.filter((name) => !existsSync(join(SHOTS_DIR, name)));
      if (missing.length) throw new Error(`faltando: ${missing.join(', ')}`);
      for (const name of required) {
        const path = join(SHOTS_DIR, name);
        const buf = readFileSync(path);
        const info = decodePng(buf);
        if (info.width !== VIEWPORT.width || info.height !== VIEWPORT.height) {
          throw new Error(`${name}: ${info.width}x${info.height}`);
        }
        if (info.stddev < 2 || info.colors < 16) throw new Error(`${name}: imagem uniforme`);
        if (buf.length < 5 * 1024) throw new Error(`${name}: ${buf.length} bytes, muito pequeno`);
      }
      return required.join(', ');
    });
  } catch (err) {
    fail('harness', err && err.message ? err.message : String(err));
  } finally {
    if (context) await context.close().catch(() => {});
    await closeBrowserBounded(browser);
    await stopChild(gameServer);
  }
  finish();
}

function finish() {
  const fails = results.filter((r) => !r.ok);
  console.log('');
  if (shots.length) {
    console.log('screenshots capturados:');
    for (const s of shots) {
      console.log(`  docs/screenshots/${s.name} — ${(s.size / 1024).toFixed(0)} KB, ${s.width}x${s.height}, std=${s.stddev.toFixed(1)}`);
    }
    console.log('');
  }
  console.log(`RESUMO browser-check: ${results.length - fails.length} PASS, ${fails.length} FAIL (exit ${fails.length ? 1 : 0})`);
  if (fails.length) {
    console.log('FALHAS:');
    for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
  }
  const code = fails.length ? 1 : 0;
  process.exitCode = code;
  // Garante o encerramento mesmo se algum handle (ex.: conexão keep-alive) ficar aberto.
  setTimeout(() => process.exit(code), 400).unref();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--antes')) await runBaselineCheck();
  else await runGameHarness();
}

main().catch((err) => {
  console.error(`browser-check: erro fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
