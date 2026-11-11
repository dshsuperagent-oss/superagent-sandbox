#!/usr/bin/env node
// browser-check.mjs — teste de navegador real do Torre de Ferro (expansão 20 fases).
//
// Uso:
//   node tests/browser-check.mjs          # joga o jogo em Chromium headless, valida e
//                                         # captura docs/screenshots/{menu,missoes,
//                                         # missoes-20-fases,kit-construir,batalha-aereos,
//                                         # chefe-painel,vitoria,derrota,fase-progressao,
//                                         # campanha-concluida}.png
//
// Cobre a issue #20 / CONTRATO-EXPANSAO.md:
//   - __TD__ v2 (version 2.0.0, ready, phases=20, scenarios, enemyTypes/towerTypes/troopTypes);
//   - seleção de missão com as 20 fases agrupadas por cenário, cadeados, estrelas e
//     desbloqueio sequencial (fase 1 aberta; 2..20 bloqueadas; após vencer a 1, a 2 abre);
//   - HUD "Fase n/20 · Onda m/2", caixa/progressão por fase, save v2;
//   - desbloqueios visíveis ("Desbloqueia na fase N") em torres, tropas e upgrade;
//   - jogar de verdade: construir/upgrade/vender/tropas, ondas, aéreos e chefe;
//   - telas de vitória, derrota e campanha concluída;
//   - migração de save v1 -> v2 no localStorage;
//   - 0 request externo, 0 erro de console, WebGL renderizando.
//
// Playwright é opcional: procura 'playwright'/'playwright-core' (import dinâmico, require com
// NODE_PATH, PLAYWRIGHT_PATH e o caminho padrão /tmp/pw/node_modules). Sem ele:
//   "SKIP: playwright indisponível" e exit 0.
// Chromium: CHROMIUM_PATH ou /root/.cache/ms-playwright/chromium-1134/chrome-linux/chrome.
//
// Regra de ouro: NUNCA marcar PASS sem executar. Falhou => exit 1 com a mensagem exata.

import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import net from 'node:net';

const GAME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

/** Espera o texto exato de #hud-onda (a HUD é atualizada no frame seguinte ao estado). */
async function waitHudOnda(page, texto, timeout = 10000) {
  await page.waitForFunction((esperado) => {
    const el = document.getElementById('hud-onda');
    return Boolean(el && el.textContent.trim() === esperado);
  }, texto, { timeout });
}

/** Espera o texto exato de #hud-mapa. */
async function waitHudMapa(page, texto, timeout = 10000) {
  await page.waitForFunction((esperado) => {
    const el = document.getElementById('hud-mapa');
    return Boolean(el && el.textContent.trim() === esperado);
  }, texto, { timeout });
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
 * antes disso fazia o próximo clique da varredura fechar o painel recém-aberto.
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

/** Fecha o tutorial por cliques reais (6 passos na 1ª partida da fase 1). */
async function dismissTutorial(page) {
  let passos = 0;
  for (let i = 0; i < 12; i += 1) {
    if (!(await visible(page, '#tutorial'))) break;
    await page.click('#btn-tutorial-ok');
    passos += 1;
    await delay(70);
  }
  if (await visible(page, '#tutorial')) throw new Error('#tutorial não fechou após 12 cliques em #btn-tutorial-ok');
  return passos;
}

/** Lê e valida o save v2 do localStorage (lança erro descritivo se inválido). */
async function readSaveV2(page) {
  const raw = await page.evaluate(() => localStorage.getItem('td3d:save:v2'));
  if (!raw) throw new Error('localStorage "td3d:save:v2" ausente');
  let save;
  try {
    save = JSON.parse(raw);
  } catch (err) {
    throw new Error(`save v2 não é JSON válido: ${err.message}`);
  }
  if (save.version !== 2) throw new Error(`save.version=${save.version}, esperado 2`);
  if (!Array.isArray(save.phases) || save.phases.length !== 20) {
    throw new Error(`save.phases inválido (${save.phases ? save.phases.length : 'ausente'}), esperado 20`);
  }
  for (let i = 0; i < 20; i += 1) {
    const f = save.phases[i];
    if (!f || typeof f !== 'object' || typeof f.completed !== 'boolean'
      || !Number.isFinite(Number(f.stars)) || !Number.isFinite(Number(f.bestLives))) {
      throw new Error(`save.phases[${i}] inválido: ${JSON.stringify(f)}`);
    }
  }
  if (!save.settings || !Number.isFinite(Number(save.settings.volume)) || typeof save.settings.muted !== 'boolean') {
    throw new Error(`save.settings inválido: ${JSON.stringify(save.settings)}`);
  }
  if (!save.totals || !Number.isFinite(Number(save.totals.kills)) || !Number.isFinite(Number(save.totals.waves))) {
    throw new Error(`save.totals inválido: ${JSON.stringify(save.totals)}`);
  }
  if (!Number.isFinite(Number(save.bonusPermanent))) throw new Error('save.bonusPermanent inválido');
  return save;
}

/** Lê o estado da seleção de missão (cartões, grupos, progresso, dica). */
async function readMissionList(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('#map-list .fase-card')];
    return {
      total: cards.length,
      dica: (document.querySelector('#screen-maps .painel-dica') || {}).textContent || '',
      progresso: (document.getElementById('map-progresso') || {}).textContent || '',
      grupos: [...document.querySelectorAll('#map-list .fase-grupo')].map((g) => ({
        cenario: g.getAttribute('data-cenario'),
        titulo: (g.querySelector('.fase-grupo-titulo') || {}).textContent || '',
        cards: g.querySelectorAll('.fase-card').length,
      })),
      cards: cards.map((c) => ({
        fase: Number(c.getAttribute('data-fase')),
        numero: (c.querySelector('.fase-numero') || {}).textContent || '',
        cenario: (c.querySelector('.fase-cenario') || {}).textContent || '',
        estrelas: (c.querySelector('.fase-estrelas') || {}).textContent || '',
        estado: (c.querySelector('.fase-estado') || {}).textContent || '',
        disable: c.disabled === true,
        bloqueada: c.classList.contains('fase-card--bloqueada'),
        concluida: c.classList.contains('fase-card--concluida'),
        disponivel: c.classList.contains('fase-card--disponivel'),
        cadeadoVisivel: (() => {
          const cd = c.querySelector('.fase-cadeado');
          if (!cd || cd.hidden) return false;
          const cs = getComputedStyle(cd);
          return cs.display !== 'none' && cs.visibility !== 'hidden';
        })(),
      })),
    };
  });
}

// ------------------------------------------------------------------ checagens do jogo

async function runGameChecks(page, origin, browser) {
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

  // ================================================================ 1) boot
  await step('página inicial: menu ativo, título e API __TD__ pronta', async () => {
    await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 30000 });
    await waitVisible(page, '#screen-menu.active', 20000);
    const title = await page.title();
    if (!/Torre de Ferro/i.test(title)) throw new Error(`title inesperado: "${title}"`);
    await waitFor(page, () => Boolean(window.__TD__
      && typeof window.__TD__.state === 'function'
      && window.__TD__.ready === true), 25000);
    const api = await page.evaluate(() => Object.keys(window.__TD__).sort());
    const falta = ['start', 'startPhase', 'save', 'state', 'eventLog', 'spawnWave', 'spawnEnemy',
      'giveMoney', 'setLives', 'setSpeed', 'pause', 'resume', 'fastForward', 'buildTower',
      'upgradeTower', 'sellTower', 'deployTroop', 'audioLog', 'fxLog', 'perf', 'zoomBy', 'view',
      'projectSlot', 'win', 'lose'].filter((k) => !api.includes(k));
    if (falta.length) throw new Error(`__TD__ sem: ${falta.join(', ')}`);
    return `${api.length} chaves de QA, title "${title}"`;
  });
  await step('__TD__ v2: version 2.0.0, phases=20, scenarios e tipos do contrato', async () => {
    const meta = await page.evaluate(() => {
      const t = window.__TD__ || {};
      const arr = (v) => (Array.isArray(v) ? v.slice() : null);
      return {
        version: t.version,
        ready: t.ready,
        phases: t.phases,
        scenarios: arr(t.scenarios),
        enemyTypes: arr(t.enemyTypes),
        towerTypes: arr(t.towerTypes),
        troopTypes: arr(t.troopTypes),
      };
    });
    const problemas = [];
    if (typeof meta.version !== 'string' || !/^2\./.test(meta.version)) problemas.push(`version="${meta.version}" (esperado 2.x)`);
    if (meta.ready !== true) problemas.push('ready !== true');
    if (meta.phases !== 20) problemas.push(`phases=${meta.phases} (esperado 20)`);
    if (!meta.scenarios || meta.scenarios.join(',') !== 'deserto,neve,cidade') problemas.push(`scenarios=${JSON.stringify(meta.scenarios)}`);
    const esperado = {
      enemyTypes: ['soldado', 'blindado', 'tanque', 'drone', 'helicoptero', 'bombardeiro',
        'zepelim', 'chefe-deserto', 'chefe-neve', 'chefe-cidade'],
      towerTypes: ['metralhadora', 'antiaereo', 'morteiro', 'tesla', 'criogenica', 'missil'],
      troopTypes: ['fuzileiros', 'antiaerea', 'sniper'],
    };
    for (const [campo, lista] of Object.entries(esperado)) {
      if (!meta[campo]) { problemas.push(`${campo} ausente/vazio (array esperado)`); continue; }
      const faltando = lista.filter((v) => !meta[campo].includes(v));
      if (faltando.length) problemas.push(`${campo} sem: ${faltando.join(', ')}`);
    }
    if (problemas.length) throw new Error(problemas.join('; '));
    return `version="${meta.version}", phases=20, scenarios=${meta.scenarios.join('/')}, enemyTypes=${meta.enemyTypes.length}, towerTypes=${meta.towerTypes.length}, troopTypes=${meta.troopTypes.length}`;
  });
  await step('menu anuncia a expansão: 20 fases · 3 cenários · 40 ondas', async () => {
    const texto = await page.$eval('#screen-menu', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    const faltando = [/20\s*fases/i, /3\s*cen[áa]rios/i, /40\s*ondas/i].filter((re) => !re.test(texto));
    if (faltando.length) throw new Error(`menu não menciona ${faltando.map(String).join(', ')}: "${texto.slice(0, 200)}"`);
    return 'textos da campanha de 20 fases presentes';
  });
  await step('screenshot menu.png real 1280x800', async () => {
    const s = await capture(page, 'menu.png');
    return `${(s.size / 1024).toFixed(0)} KB, std=${s.stddev.toFixed(1)}`;
  });

  // ================================================================ 2) seleção das 20 fases
  await step('seleção de missão: 20 fases em 3 grupos por cenário, cadeados e estrelas', async () => {
    await page.click('#btn-missoes');
    await waitVisible(page, '#screen-maps.active');
    const m = await readMissionList(page);
    const fases = m.cards.map((c) => c.fase).sort((a, b) => a - b);
    const esperadoFases = Array.from({ length: 20 }, (_, i) => i + 1).join(',');
    if (m.total !== 20) throw new Error(`esperava 20 .fase-card, achei ${m.total}`);
    if (fases.join(',') !== esperadoFases) throw new Error(`fases com buraco: ${fases.join(',')}`);
    if (m.grupos.length !== 3 || m.grupos.map((g) => g.cenario).join(',') !== 'deserto,neve,cidade') {
      throw new Error(`grupos por cenário errados: ${m.grupos.map((g) => `${g.cenario}:${g.cards}`).join(', ')}`);
    }
    if (m.grupos.map((g) => g.cards).join(',') !== '7,7,6') {
      throw new Error(`distribuição de cards por cenário: ${m.grupos.map((g) => g.cards).join(',')} (esperado 7,7,6)`);
    }
    for (const g of m.grupos) if (!new RegExp(g.cenario, 'i').test(g.titulo)) throw new Error(`título do grupo ${g.cenario}: "${g.titulo}"`);
    const c1 = m.cards.find((c) => c.fase === 1);
    if (!c1) throw new Error('card da fase 1 ausente');
    if (c1.disable || c1.bloqueada || !/Dispon[íi]vel/i.test(c1.estado)) throw new Error(`fase 1 deveria estar disponível: ${JSON.stringify(c1)}`);
    if (!c1.disponivel) throw new Error('fase 1 sem a classe .fase-card--disponivel');
    if (c1.cadeadoVisivel) throw new Error('fase 1 disponível não deveria mostrar cadeado');
    for (const c of m.cards) {
      if (c.fase === 1) continue;
      if (!c.disable) throw new Error(`fase ${c.fase} deveria estar bloqueada (disabled)`);
      if (!c.bloqueada) throw new Error(`fase ${c.fase} sem a classe .fase-card--bloqueada`);
      if (!/Bloqueada/i.test(c.estado)) throw new Error(`fase ${c.fase} estado="${c.estado}" (esperado "Bloqueada")`);
      if (!c.cadeadoVisivel) throw new Error(`fase ${c.fase} bloqueada sem cadeado visível`);
    }
    for (const c of m.cards) {
      if (c.numero.trim() !== `Fase ${c.fase}`) throw new Error(`fase ${c.fase} .fase-numero="${c.numero}"`);
      if (!c.cenario.trim()) throw new Error(`fase ${c.fase} sem .fase-cenario`);
      if (!c.estrelas.includes('☆')) throw new Error(`fase ${c.fase} estrelas="${c.estrelas}"`);
    }
    if (!/Complete uma fase para liberar a pr[óo]xima/i.test(m.dica)) throw new Error(`dica da seleção: "${m.dica}"`);
    if (!/0\/20 fases concluídas/.test(m.progresso)) throw new Error(`#map-progresso inicial: "${m.progresso}"`);
    return `${m.total} fases em ${m.grupos.map((g) => `${g.cenario} ${g.cards}`).join(' / ')}, fase 1 disponível, 19 bloqueadas`;
  });
  await step('screenshot missoes.png real 1280x800', async () => {
    const s = await capture(page, 'missoes.png');
    return `${(s.size / 1024).toFixed(0)} KB`;
  });
  // ================================================================ 3) fase 1 + HUD + save v2
  await step('fase 1 abre pelo card e HUD mostra "Fase 1/20 · Onda 1/2" + save v2', async () => {
    await page.evaluate(() => {
      const painel = document.querySelector('.painel--missao');
      if (painel) painel.scrollTop = 0;
    });
    await page.click('.fase-card[data-fase="1"]');
    await waitVisible(page, '#screen-game.active', 15000);
    const passos = await dismissTutorial(page);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phaseNumber === 1 && s.phase === 'prep';
    }, 15000);
    const st = await td(page, 'state');
    const probs = [];
    if (st.phaseNumber !== 1) probs.push(`phaseNumber=${st.phaseNumber}`);
    if (st.totalPhases !== 20) probs.push(`totalPhases=${st.totalPhases}`);
    if (st.wavesPerPhase !== 2) probs.push(`wavesPerPhase=${st.wavesPerPhase}`);
    if (st.globalWave !== 1) probs.push(`globalWave=${st.globalWave}`);
    if (st.wave !== 1) probs.push(`wave=${st.wave}`);
    if (st.scenario !== 'deserto' || st.mapId !== 'deserto') probs.push(`cenário=${st.scenario}/${st.mapId}`);
    if (st.lives !== 20) probs.push(`lives=${st.lives}`);
    if (st.money !== 300) probs.push(`money=${st.money} (esperado 300)`);
    if (st.bonusPermanent !== 0) probs.push(`bonusPermanent=${st.bonusPermanent}`);
    if (st.startingMoney !== 300) probs.push(`startingMoney=${st.startingMoney}`);
    if (probs.length) throw new Error(`estado inicial: ${probs.join('; ')}`);
    const h = await page.evaluate(() => ({
      onda: (document.getElementById('hud-onda') || {}).textContent || '',
      mapa: (document.getElementById('hud-mapa') || {}).textContent || '',
      dinheiro: (document.getElementById('hud-dinheiro') || {}).textContent || '',
      vidas: (document.getElementById('hud-vidas') || {}).textContent || '',
    }));
    if (h.onda.trim() !== 'Fase 1/20 · Onda 1/2') throw new Error(`#hud-onda="${h.onda}"`);
    if (h.mapa.trim() !== 'Deserto') throw new Error(`#hud-mapa="${h.mapa}"`);
    if (h.dinheiro.trim() !== '300') throw new Error(`#hud-dinheiro="${h.dinheiro}"`);
    if (h.vidas.trim() !== '20') throw new Error(`#hud-vidas="${h.vidas}"`);
    await waitFor(page, () => !!localStorage.getItem('td3d:save:v2'), 10000);
    const save = await readSaveV2(page);
    const snap = await td(page, 'save');
    if (!snap || snap.version !== 2 || !Array.isArray(snap.phases) || snap.phases.length !== 20) {
      throw new Error(`__TD__.save() inválido: ${JSON.stringify(snap && { version: snap.version })}`);
    }
    if (save.tutorialDone !== true) throw new Error('save.tutorialDone != true após o tutorial');
    if (save.phases.some((f) => f.completed)) throw new Error('save inicial já tem fase concluída');
    if (save.bonusPermanent !== 0) throw new Error(`save.bonusPermanent=${save.bonusPermanent}`);
    return `fase 1 prep, caixa 300, vidas 20, ${passos} passos de tutorial, save v2 com 20 fases`;
  });
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

  // ================================================================ 4) desbloqueios na fase 1
  let clickedSlot = null;
  await step('desbloqueios visíveis na fase 1: torres com "Desbloqueia na fase N"', async () => {
    clickedSlot = await clickSlotToOpenBuildPanel(page);
    const cards = await page.$$eval('#painel-construir .torre-card', (els) => els.map((el) => ({
      tipo: el.getAttribute('data-torre'),
      disabled: el.disabled === true,
      bloqueada: el.classList.contains('torre-card--bloqueada'),
      bloqueio: (el.querySelector('.torre-bloqueio') || {}).textContent || '',
    })));
    if (cards.length !== 6) throw new Error(`esperava 6 torres no painel, achei ${cards.length}`);
    const regras = {
      metralhadora: { bloq: false },
      morteiro: { bloq: false },
      antiaereo: { bloq: true, fase: 2 },
      tesla: { bloq: true, fase: 4 },
      criogenica: { bloq: true, fase: 6 },
      missil: { bloq: true, fase: 8 },
    };
    for (const [tipo, regra] of Object.entries(regras)) {
      const card = cards.find((c) => c.tipo === tipo);
      if (!card) throw new Error(`torre ${tipo} ausente do painel`);
      if (regra.bloq) {
        if (!card.disabled) throw new Error(`${tipo} deveria estar disabled na fase 1`);
        if (!card.bloqueada) throw new Error(`${tipo} sem a classe .torre-card--bloqueada`);
        if (card.bloqueio.trim() !== `Desbloqueia na fase ${regra.fase}`) {
          throw new Error(`${tipo} .torre-bloqueio="${card.bloqueio}" (esperado "Desbloqueia na fase ${regra.fase}")`);
        }
      } else {
        if (card.disabled) throw new Error(`${tipo} deveria estar liberada na fase 1`);
        if (card.bloqueada) throw new Error(`${tipo} não deveria ter classe de bloqueada na fase 1`);
        if (card.bloqueio.trim()) throw new Error(`${tipo} liberada não deveria mostrar bloqueio ("${card.bloqueio}")`);
      }
    }
    const titulo = await page.$eval('#painel-construir h3', (el) => el.textContent.trim());
    if (!/Construir torre/i.test(titulo)) throw new Error(`título do painel: "${titulo}"`);
    return `6 torres; liberadas: metralhadora/morteiro; bloqueios 2/4/6/8; ${clickedSlot.clicks} cliques até o slot`;
  });
  await step('screenshot kit-construir.png com as 6 torres e os bloqueios', async () => {
    if (!clickedSlot) throw new Error('nenhum slot foi clicado antes da captura');
    if (!(await waitPanelVisible(page, '#painel-construir'))) await reopenBuildPanel(page, clickedSlot.point);
    const s = await capture(page, 'kit-construir.png');
    if (!(await waitPanelVisible(page, '#painel-construir'))) throw new Error('painel Construir não está visível na captura');
    return `${(s.size / 1024).toFixed(0)} KB, bloqueios visíveis`;
  });
  await step('construir/tropas/upgrade na fase 1: UI bloqueia o que ainda não desbloqueou', async () => {
    if (!(await waitPanelVisible(page, '#painel-construir'))) await reopenBuildPanel(page, clickedSlot.point);
    await page.click('#painel-construir .torre-card[data-torre="metralhadora"]');
    await waitFor(page, () => window.__TD__.state().towers.length === 1, 10000);
    let st = await td(page, 'state');
    // Caixa inicial exata da fase 1 = 300; metralhadora custa 100.
    if (st.money !== 200) throw new Error(`após construir caixa ${st.money}, esperado 200`);
    // clicar de novo no mesmo ponto agora abre o painel da torre
    await page.mouse.click(clickedSlot.point.x, clickedSlot.point.y);
    await waitVisible(page, '#painel-torre', 10000);
    const painelTxt = await page.$eval('#painel-torre', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    if (!/Metralhadora/i.test(painelTxt)) throw new Error(`painel da torre sem "Metralhadora": ${painelTxt.slice(0, 120)}`);
    const btnMelhorar = await page.$eval('#btn-melhorar', (el) => ({
      disabled: el.disabled === true,
      texto: el.textContent.replace(/\s+/g, ' ').trim(),
    }));
    if (!btnMelhorar.disabled) throw new Error('#btn-melhorar deveria estar disabled na fase 1 (nível 2 desbloqueia na 2)');
    if (!/Desbloqueia na fase 2/i.test(btnMelhorar.texto)) throw new Error(`#btn-melhorar="${btnMelhorar.texto}"`);
    await page.click('#btn-fechar-torre');
    await page.waitForFunction(() => {
      const el = document.querySelector('#painel-torre');
      return !el || el.hidden || getComputedStyle(el).display === 'none';
    }, null, { timeout: 10000 });
    // painel de tropas: só fuzileiros liberados na fase 1
    await page.click('#btn-tropas');
    await waitVisible(page, '#painel-tropas', 10000);
    const tropas = await page.$$eval('#painel-tropas .tropa-card', (els) => els.map((el) => ({
      tipo: el.getAttribute('data-tropa'),
      disabled: el.disabled === true,
      bloqueio: (el.querySelector('.tropa-bloqueio') || {}).textContent || '',
      estado: (el.querySelector('.tropa-estado') || {}).textContent || '',
    })));
    const fuz = tropas.find((t) => t.tipo === 'fuzileiros') || {};
    const ant = tropas.find((t) => t.tipo === 'antiaerea') || {};
    const sni = tropas.find((t) => t.tipo === 'sniper') || {};
    if (fuz.disabled) throw new Error('fuzileiros deveria estar liberado na fase 1');
    if (!ant.disabled || !/Desbloqueia na fase 3/i.test(`${ant.bloqueio} ${ant.estado}`)) {
      throw new Error(`antiaérea bloqueada errada: ${JSON.stringify(ant)}`);
    }
    if (!sni.disabled || !/Desbloqueia na fase 5/i.test(`${sni.bloqueio} ${sni.estado}`)) {
      throw new Error(`sniper bloqueado errado: ${JSON.stringify(sni)}`);
    }
    await page.click('#btn-fechar-tropas');
    st = await td(page, 'state');
    return `metralhadora construída (caixa 200), upgrade bloqueado na 2, tropas bloqueadas 3/5`;
  });
  await step('API de QA bloqueia torre/tropa/upgrade fora da fase (erro "bloqueado")', async () => {
    const st = await td(page, 'state');
    const livre = st.slots.find((s) => !s.towerId);
    if (!livre) throw new Error('nenhum slot livre para testar bloqueio de torre');
    const problemas = [];
    const torre = await page.evaluate(([slot]) => window.__TD__.buildTower(slot, 'tesla'), [livre.i]);
    if (!torre || torre.ok || torre.error !== 'bloqueado' || torre.unlockPhase !== 4) {
      problemas.push(`buildTower(tesla)=${JSON.stringify(torre)}`);
    }
    const id = st.towers[0] && st.towers[0].id;
    const up = await td(page, 'upgradeTower', id);
    if (!up || up.ok || up.error !== 'bloqueado' || up.unlockPhase !== 2) {
      problemas.push(`upgradeTower(nível 2)=${JSON.stringify(up)}`);
    }
    const pontoLivre = st.troopPoints.find((p) => !p.troopId);
    const anti = await page.evaluate(([p]) => window.__TD__.deployTroop('antiaerea', p), [pontoLivre.j]);
    if (!anti || anti.ok || anti.error !== 'bloqueado' || anti.unlockPhase !== 3) {
      problemas.push(`deployTroop(antiaerea)=${JSON.stringify(anti)}`);
    }
    const sni = await page.evaluate(([p]) => window.__TD__.deployTroop('sniper', p), [pontoLivre.j]);
    if (!sni || sni.ok || sni.error !== 'bloqueado' || sni.unlockPhase !== 5) {
      problemas.push(`deployTroop(sniper)=${JSON.stringify(sni)}`);
    }
    if (problemas.length) throw new Error(problemas.join('; '));
    const depois = await td(page, 'state');
    if (depois.money !== 200) throw new Error(`caixa mudou com ações bloqueadas: ${depois.money}`);
    const unlocks = depois.unlocks;
    if (!unlocks || !unlocks.towers || unlocks.towers.tesla !== false || unlocks.towers.metralhadora !== true) {
      throw new Error(`state.unlocks.towers inválido: ${JSON.stringify(unlocks && unlocks.towers)}`);
    }
    if (!unlocks.upgrades || unlocks.upgrades[2] !== false) throw new Error(`state.unlocks.upgrades inválido: ${JSON.stringify(unlocks && unlocks.upgrades)}`);
    return 'tesla→fase 4, upgrade→fase 2, antiaérea→fase 3, sniper→fase 5 (sem debitar caixa)';
  });

  // ================================================================ 5) vitória / derrota / save
  await step('vitória da fase 1: tela de vitória, estrelas e save v2 atualizado', async () => {
    await td(page, 'win');
    await waitVisible(page, '#screen-victory.active', 10000);
    const tela = await page.evaluate(() => ({
      mapa: (document.getElementById('vitoria-mapa') || {}).textContent || '',
      vidas: (document.getElementById('vitoria-vidas') || {}).textContent || '',
      estrelas: (document.getElementById('vitoria-estrelas') || {}).textContent || '',
      btn: (() => {
        const b = document.getElementById('btn-proxima-missao');
        return b ? { disabled: b.disabled === true, texto: b.textContent || '' } : null;
      })(),
    }));
    if (!/Fase 1\/20/.test(tela.mapa) || !/Deserto/i.test(tela.mapa)) throw new Error(`#vitoria-mapa="${tela.mapa}"`);
    if (tela.vidas.trim() !== '20') throw new Error(`#vitoria-vidas="${tela.vidas}"`);
    if (!tela.estrelas.includes('★★★')) throw new Error(`#vitoria-estrelas="${tela.estrelas}"`);
    if (!tela.btn || tela.btn.disabled) throw new Error('#btn-proxima-missao deveria estar habilitado após a fase 1');
    if (!/Pr[óo]xima miss[ãa]o/i.test(tela.btn.texto)) throw new Error(`#btn-proxima-missao="${tela.btn.texto}"`);
    const save = await readSaveV2(page);
    const f1 = save.phases[0];
    if (!f1.completed || f1.stars !== 3 || f1.bestLives !== 20) throw new Error(`save.phases[0]=${JSON.stringify(f1)}`);
    if (save.phases[1].completed) throw new Error('save.phases[1] não deveria estar concluída');
    if (save.bonusPermanent !== 25) throw new Error(`save.bonusPermanent=${save.bonusPermanent} (esperado 25)`);
    if (!(save.totals.waves >= 2)) throw new Error(`save.totals.waves=${save.totals.waves}`);
    return `vitória 3★, save fase 1 concluída, bônus permanente 25, ondas ${save.totals.waves}`;
  });
  await step('screenshot vitoria.png real 1280x800', async () => {
    const s = await capture(page, 'vitoria.png');
    return `${(s.size / 1024).toFixed(0)} KB`;
  });
  await step('próxima missão: seleção marca a fase 1 concluída e libera a fase 2', async () => {
    await page.click('#btn-vitoria-missoes');
    await waitVisible(page, '#screen-maps.active', 10000);
    const m = await readMissionList(page);
    const c1 = m.cards.find((c) => c.fase === 1) || {};
    const c2 = m.cards.find((c) => c.fase === 2) || {};
    const c3 = m.cards.find((c) => c.fase === 3) || {};
    if (!c1.concluida || !/Conclu[íi]da/i.test(c1.estado) || !/melhor:\s*20 vidas/i.test(c1.estado)) {
      throw new Error(`card da fase 1 após vitória: ${JSON.stringify(c1)}`);
    }
    if (!c1.estrelas.includes('★★★')) throw new Error(`estrelas da fase 1: "${c1.estrelas}"`);
    if (c2.disable || !c2.disponivel || !/Dispon[íi]vel/i.test(c2.estado)) throw new Error(`fase 2 deveria estar liberada: ${JSON.stringify(c2)}`);
    if (!c3.disable || !c3.bloqueada) throw new Error(`fase 3 deveria continuar bloqueada: ${JSON.stringify(c3)}`);
    if (!/1\/20 fases concluídas/.test(m.progresso) || !/3\/60 estrelas/.test(m.progresso)) {
      throw new Error(`#map-progresso após vitória: "${m.progresso}"`);
    }
    // Jogar a fase 2 com a progressão de caixa (bônus permanente 25)
    await page.click('.fase-card[data-fase="2"]');
    await waitVisible(page, '#screen-game.active', 10000);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phaseNumber === 2 && s.phase === 'prep';
    }, 15000);
    const st = await td(page, 'state');
    if (st.bonusPermanent !== 25) throw new Error(`state.bonusPermanent=${st.bonusPermanent}`);
    if (st.startingMoney !== 350) throw new Error(`state.startingMoney=${st.startingMoney} (300 + 25 + 25)`);
    if (st.money !== 350) throw new Error(`state.money=${st.money} (esperado 350)`);
    await waitHudOnda(page, 'Fase 2/20 · Onda 1/2');
    const hud = (await page.locator('#hud-onda').textContent()).trim();
    if (hud !== 'Fase 2/20 · Onda 1/2') throw new Error(`#hud-onda="${hud}"`);
    if ((await page.locator('#hud-mapa').textContent()).trim() !== 'Deserto') throw new Error('#hud-mapa da fase 2 != Deserto');
    return `fase 1 concluída (★★★ · melhor 20), fase 2 liberada, caixa inicial 350 (= 300+25+25)`;
  });
  await step('derrota da fase 2: tela de derrota e save não marca a fase', async () => {
    await td(page, 'lose');
    await waitVisible(page, '#screen-defeat.active', 10000);
    const tela = await page.evaluate(() => ({
      texto: (document.querySelector('#screen-defeat') || {}).textContent || '',
      mapa: (document.getElementById('derrota-mapa') || {}).textContent || '',
    }));
    if (!/A base caiu/i.test(tela.texto)) throw new Error(`#screen-defeat sem "A base caiu": ${tela.texto.slice(0, 120)}`);
    if (!/Fase 2\/20/.test(tela.mapa)) throw new Error(`#derrota-mapa="${tela.mapa}"`);
    const save = await readSaveV2(page);
    if (save.phases[1].completed) throw new Error('derrota não pode concluir a fase 2');
    return `derrota na fase 2 (${tela.mapa.trim()}), save intacto`;
  });
  await step('screenshot derrota.png real 1280x800', async () => {
    const s = await capture(page, 'derrota.png');
    return `${(s.size / 1024).toFixed(0)} KB`;
  });

  // ================================================================ 6) API __TD__: progressão/desbloqueios
  await step('fase 8 pela API: caixa progressiva e todos os desbloqueios liberados', async () => {
    await td(page, 'start', { phase: 8, bonusPermanent: 175, completedPhases: 7, money: 5000, lives: 20, seed: 20261110 });
    await waitVisible(page, '#screen-game.active', 10000);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phaseNumber === 8 && s.phase === 'prep';
    }, 15000);
    const st = await td(page, 'state');
    const probs = [];
    if (st.scenario !== 'neve') probs.push(`scenario=${st.scenario}`);
    if (st.bonusPermanent !== 175) probs.push(`bonusPermanent=${st.bonusPermanent}`);
    if (st.startingMoney !== 650) probs.push(`startingMoney=${st.startingMoney} (300+25*7+175=650)`);
    if (st.money !== 5000) probs.push(`money=${st.money} (override 5000)`);
    if (st.globalWave !== 15) probs.push(`globalWave=${st.globalWave} (fase 8 onda 1 = 15)`);
    for (const tipo of ['metralhadora', 'morteiro', 'antiaereo', 'tesla', 'criogenica', 'missil']) {
      if (st.unlocks.towers[tipo] !== true) probs.push(`unlock torre ${tipo}=${st.unlocks.towers[tipo]}`);
    }
    for (const tipo of ['fuzileiros', 'antiaerea', 'sniper']) {
      if (st.unlocks.troops[tipo] !== true) probs.push(`unlock tropa ${tipo}=${st.unlocks.troops[tipo]}`);
    }
    if (st.unlocks.upgrades[2] !== true || st.unlocks.upgrades[3] !== true) probs.push(`unlocks.upgrades=${JSON.stringify(st.unlocks.upgrades)}`);
    if (probs.length) throw new Error(`fase 8: ${probs.join('; ')}`);

    const livres = st.slots.filter((s) => !s.towerId).slice(0, 6).map((s) => s.i);
    if (livres.length < 6) throw new Error('slots livres insuficientes na fase 8');
    const tipos = ['metralhadora', 'morteiro', 'antiaereo', 'tesla', 'criogenica', 'missil'];
    const ids = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await page.evaluate(([slot, tipo]) => window.__TD__.buildTower(slot, tipo), [livres[i], tipos[i]]);
      if (!res || !res.ok) throw new Error(`buildTower(${tipos[i]}) falhou na fase 8: ${JSON.stringify(res)}`);
      ids.push(res.id);
    }
    if ((await td(page, 'state')).towers.length !== 6) throw new Error('esperava 6 torres na fase 8');
    // upgrades liberados: nível 2 e nível 3
    const up2 = await td(page, 'upgradeTower', ids[0]);
    if (!up2 || !up2.ok) throw new Error(`upgradeTower nível 2 falhou: ${JSON.stringify(up2)}`);
    const up3 = await td(page, 'upgradeTower', ids[0]);
    if (!up3 || !up3.ok) throw new Error(`upgradeTower nível 3 falhou: ${JSON.stringify(up3)}`);
    const torre = (await td(page, 'state')).towers.find((t) => t.id === ids[0]);
    if (!torre || torre.level !== 3) throw new Error(`torre não chegou ao nível 3: ${torre && torre.level}`);
    const venda = await td(page, 'sellTower', ids[1]);
    if (!venda || !venda.ok) throw new Error(`sellTower falhou: ${JSON.stringify(venda)}`);
    const pos = (await td(page, 'state')).troopPoints.filter((p) => !p.troopId).slice(0, 3).map((p) => p.j);
    const tiposTropa = ['fuzileiros', 'antiaerea', 'sniper'];
    for (let i = 0; i < 3; i += 1) {
      const res = await page.evaluate(([tipo, ponto]) => window.__TD__.deployTroop(tipo, ponto), [tiposTropa[i], pos[i]]);
      if (!res || !res.ok) throw new Error(`deployTroop(${tiposTropa[i]}) falhou na fase 8: ${JSON.stringify(res)}`);
    }
    const fim = await td(page, 'state');
    if (fim.towers.length !== 5) throw new Error(`após venda esperava 5 torres, há ${fim.towers.length}`);
    if (fim.troops.length !== 3) throw new Error(`esperava 3 tropas, há ${fim.troops.length}`);
    if (fim.money < 0) throw new Error('caixa negativa');
    return `6 torres + upgrade nível 3 + venda + 3 tropas; caixa ${fim.money}`;
  });

  // ================================================================ 7) aéreos (fase 1 onda 2)
  await step('fase 1 onda 2: inimigos aéreos reais + screenshot batalha-aereos.png', async () => {
    await td(page, 'start', { phase: 1, seed: 20261109, money: 900, lives: 20 });
    await waitVisible(page, '#screen-game.active', 10000);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phaseNumber === 1 && s.phase === 'prep';
    }, 15000);
    const st0 = await td(page, 'state');
    if (st0.wavesPerPhase !== 2) throw new Error(`wavesPerPhase=${st0.wavesPerPhase}`);
    const slots = st0.slots.filter((s) => !s.towerId).slice(0, 4).map((s) => s.i);
    const tipos = ['metralhadora', 'morteiro', 'metralhadora', 'morteiro'];
    for (let i = 0; i < slots.length; i += 1) {
      const res = await page.evaluate(([slot, tipo]) => window.__TD__.buildTower(slot, tipo), [slots[i], tipos[i]]);
      if (!res || !res.ok) throw new Error(`buildTower(${tipos[i]}) falhou: ${JSON.stringify(res)}`);
    }
    const okOnda = await td(page, 'spawnWave', 2);
    if (!okOnda) throw new Error('spawnWave(2) falhou');
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phase === 'wave' && s.wave === 2;
    }, 10000);
    await td(page, 'spawnEnemy', 'drone', 4);
    await td(page, 'fastForward', 12);
    await td(page, 'spawnEnemy', 'helicoptero', 3);
    await td(page, 'fastForward', 4);
    await td(page, 'spawnEnemy', 'drone', 4);
    await delay(600);
    let st = await td(page, 'state');
    let aereos = st.enemies.filter((e) => e.cls === 'air');
    if (!aereos.some((e) => Number(e.progress) > 35)) {
      await td(page, 'fastForward', 6);
      await delay(300);
      st = await td(page, 'state');
      aereos = st.enemies.filter((e) => e.cls === 'air');
    }
    if (!aereos.length) throw new Error('nenhum aéreo vivo no momento da captura');
    if (!aereos.some((e) => Number(e.progress) > 35)) {
      throw new Error(`aéreos não chegaram ao meio do caminho (progress: ${aereos.map((e) => Math.round(e.progress)).join(',')})`);
    }
    await waitHudOnda(page, 'Fase 1/20 · Onda 2/2');
    const hud = (await page.locator('#hud-onda').textContent()).trim();
    if (hud !== 'Fase 1/20 · Onda 2/2') throw new Error(`#hud-onda="${hud}"`);
    const s = await capture(page, 'batalha-aereos.png');
    const finais = (await td(page, 'state')).enemies.filter((e) => e.cls === 'air');
    if (!finais.length) throw new Error('nenhum aéreo vivo na captura');
    return `${(s.size / 1024).toFixed(0)} KB, ${finais.length} aéreos (progress ${finais.map((e) => Math.round(e.progress)).join(',')})`;
  });

  // ================================================================ 8) fase 12: progressão/HUD
  await step('fase 12 (Neve): HUD "Fase 12/20 · Onda 2/2" e caixa progressiva', async () => {
    await td(page, 'start', { phase: 12, bonusPermanent: 250, completedPhases: 11, money: 1200, lives: 20, seed: 20261110 });
    await waitVisible(page, '#screen-game.active', 10000);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phaseNumber === 12;
    }, 15000);
    const st0 = await td(page, 'state');
    if (st0.scenario !== 'neve') throw new Error(`scenario=${st0.scenario}`);
    if (st0.bonusPermanent !== 250) throw new Error(`bonusPermanent=${st0.bonusPermanent}`);
    if (st0.startingMoney !== 825) throw new Error(`startingMoney=${st0.startingMoney} (300+25*11+250=825)`);
    if (st0.globalWave !== 23 && st0.globalWave !== 24) throw new Error(`globalWave=${st0.globalWave}`);
    const slots = st0.slots.filter((s) => !s.towerId).slice(0, 4).map((s) => s.i);
    const tipos = ['missil', 'tesla', 'morteiro', 'criogenica'];
    for (let i = 0; i < slots.length; i += 1) {
      const res = await page.evaluate(([slot, tipo]) => window.__TD__.buildTower(slot, tipo), [slots[i], tipos[i]]);
      if (!res || !res.ok) throw new Error(`buildTower(${tipos[i]}) falhou na fase 12: ${JSON.stringify(res)}`);
    }
    await td(page, 'spawnWave', 2);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phase === 'wave' && s.wave === 2;
    }, 10000);
    await td(page, 'spawnEnemy', 'helicoptero', 3);
    await td(page, 'spawnEnemy', 'drone', 6);
    await td(page, 'fastForward', 4);
    await delay(400);
    const st = await td(page, 'state');
    if (!st.enemies.length) throw new Error('sem inimigos para a captura da fase 12');
    await waitHudOnda(page, 'Fase 12/20 · Onda 2/2');
    await waitHudMapa(page, 'Neve');
    const hud = (await page.locator('#hud-onda').textContent()).trim();
    const mapa = (await page.locator('#hud-mapa').textContent()).trim();
    const dinheiro = (await page.locator('#hud-dinheiro').textContent()).trim();
    if (hud !== 'Fase 12/20 · Onda 2/2') throw new Error(`#hud-onda="${hud}"`);
    if (mapa !== 'Neve') throw new Error(`#hud-mapa="${mapa}"`);
    if (dinheiro !== String(st.money)) throw new Error(`#hud-dinheiro="${dinheiro}" != state.money=${st.money}`);
    const s = await capture(page, 'fase-progressao.png');
    const depois = await td(page, 'state');
    if (depois.enemies.length === 0) throw new Error('batalha da fase 12 terminou durante a captura');
    return `${(s.size / 1024).toFixed(0)} KB, caixa inicial 825, bônus 250, ${depois.enemies.length} inimigos, HUD "${hud}"`;
  });

  // ================================================================ 9) chefe (fase 5, onda 2)
  await step('fase 5 onda 2: chefe com barra de vida e evento bossSpawn', async () => {
    await td(page, 'start', { phase: 5, bonusPermanent: 100, completedPhases: 4, money: 1500, lives: 20, seed: 20261110 });
    await waitVisible(page, '#screen-game.active', 10000);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phaseNumber === 5 && s.phase === 'prep';
    }, 15000);
    await td(page, 'spawnWave', 2);
    let chefe = null;
    for (let i = 0; i < 10 && !chefe; i += 1) {
      await td(page, 'fastForward', 2);
      await delay(120);
      const s = await td(page, 'state');
      if (s && s.boss) chefe = s.boss;
    }
    if (!chefe) throw new Error('chefe não apareceu na onda 2 da fase 5');
    await waitVisible(page, '#chefe-barra', 10000);
    const st = await td(page, 'state');
    if (st.wave !== 2) throw new Error(`wave=${st.wave} (esperado 2)`);
    if (st.globalWave !== 10) throw new Error(`globalWave=${st.globalWave} (esperado 10)`);
    if (chefe.type !== 'chefe-deserto') throw new Error(`chefe.type=${chefe.type}`);
    const log = await td(page, 'eventLog', 800);
    if (!log.some((e) => e && e.type === 'bossSpawn')) throw new Error('eventLog sem bossSpawn');
    await waitHudOnda(page, 'Fase 5/20 · Onda 2/2');
    const hud = (await page.locator('#hud-onda').textContent()).trim();
    if (hud !== 'Fase 5/20 · Onda 2/2') throw new Error(`#hud-onda="${hud}"`);
    const barra = await page.evaluate(() => {
      const b = document.getElementById('chefe-barra');
      if (!b || b.hidden) return null;
      const cs = getComputedStyle(b);
      return {
        texto: b.textContent.replace(/\s+/g, ' ').trim(),
        nome: (document.getElementById('chefe-nome') || {}).textContent || '',
        vida: (document.getElementById('chefe-vida-texto') || {}).textContent || '',
        pointerEvents: cs.pointerEvents,
      };
    });
    if (!barra) throw new Error('#chefe-barra não está visível');
    if (!/General de Ferro/i.test(barra.nome)) throw new Error(`#chefe-nome="${barra.nome}"`);
    if (!/\d+\s*\/\s*\d+/.test(barra.vida)) throw new Error(`#chefe-vida-texto="${barra.vida}"`);
    if (barra.pointerEvents !== 'none') throw new Error(`.chefe-barra pointer-events=${barra.pointerEvents} (esperado none)`);
    return `chefe "${barra.nome}" (${barra.vida}), onda 2/2, bossSpawn no eventLog, barra pointer-events:none`;
  });
  await step('screenshot chefe-painel.png real 1280x800', async () => {
    const s = await capture(page, 'chefe-painel.png');
    const vis = await page.$eval('#chefe-barra', (el) => !el.hidden && el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
    if (!vis) throw new Error('#chefe-barra não visível na captura do chefe');
    return `${(s.size / 1024).toFixed(0)} KB, barra: "${vis}"`;
  });

  // ================================================================ 10) campanha concluída
  await step('save 18/20: seleção mostra a fase 19 disponível e a 20 bloqueada', async () => {
    const progresso = {
      version: 2,
      tutorialDone: true,
      settings: { volume: 0.7, muted: false, speed: 1 },
      bonusPermanent: 250,
      phases: Array.from({ length: 20 }, (_, i) => (i < 18
        ? { completed: true, stars: 3, bestLives: 20 }
        : { completed: false, stars: 0, bestLives: 0 })),
      totals: { kills: 240, waves: 36, timePlayed: 600 },
    };
    await page.evaluate((save) => {
      localStorage.setItem('td3d:save:v2', JSON.stringify(save));
      localStorage.removeItem('td3d:save:v1');
    }, progresso);
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    await waitVisible(page, '#screen-menu.active', 20000);
    await waitFor(page, () => window.__TD__ && window.__TD__.ready === true, 25000);
    await page.click('#btn-missoes');
    await waitVisible(page, '#screen-maps.active', 10000);
    const m = await readMissionList(page);
    if (m.cards.filter((c) => c.concluida).length !== 18) {
      throw new Error(`esperava 18 fases concluídas, achei ${m.cards.filter((c) => c.concluida).length}`);
    }
    if (!/18\/20 fases concluídas/.test(m.progresso) || !/54\/60 estrelas/.test(m.progresso)) {
      throw new Error(`#map-progresso="${m.progresso}"`);
    }
    const c19 = m.cards.find((c) => c.fase === 19) || {};
    const c20 = m.cards.find((c) => c.fase === 20) || {};
    if (c19.disable || !c19.disponivel || !/Dispon[íi]vel/i.test(c19.estado)) throw new Error(`fase 19 deveria estar disponível: ${JSON.stringify(c19)}`);
    if (!c20.disable || !c20.bloqueada) throw new Error(`fase 20 deveria estar bloqueada: ${JSON.stringify(c20)}`);
    await page.click('.fase-card[data-fase="19"]');
    await waitVisible(page, '#screen-game.active', 10000);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phaseNumber === 19 && s.phase === 'prep';
    }, 15000);
    const st = await td(page, 'state');
    if (st.scenario !== 'cidade') throw new Error(`fase 19 scenario=${st.scenario}`);
    if (st.bonusPermanent !== 250) throw new Error(`bonusPermanent=${st.bonusPermanent}`);
    if (st.startingMoney !== 1000) throw new Error(`startingMoney=${st.startingMoney} (300+25*18+250=1000)`);
    if (st.money !== 1000) throw new Error(`money=${st.money}`);
    await waitHudOnda(page, 'Fase 19/20 · Onda 1/2');
    await waitHudMapa(page, 'Cidade');
    const hud = (await page.locator('#hud-onda').textContent()).trim();
    if (hud !== 'Fase 19/20 · Onda 1/2') throw new Error(`#hud-onda="${hud}"`);
    if ((await page.locator('#hud-mapa').textContent()).trim() !== 'Cidade') throw new Error('#hud-mapa da fase 19 != Cidade');
    return `18/20 no save, fase 19 disponível (caixa 1000, HUD "${hud}"), fase 20 bloqueada`;
  });
  await step('vencer 19 → "Próxima missão" → fase 20 → tela de campanha concluída', async () => {
    await td(page, 'win');
    await waitVisible(page, '#screen-victory.active', 10000);
    const tela = await page.evaluate(() => ({
      mapa: (document.getElementById('vitoria-mapa') || {}).textContent || '',
      btn: (() => {
        const b = document.getElementById('btn-proxima-missao');
        return b ? { disabled: b.disabled === true, texto: b.textContent || '' } : null;
      })(),
    }));
    if (!/Fase 19\/20/.test(tela.mapa) || !/Cidade/i.test(tela.mapa)) throw new Error(`#vitoria-mapa="${tela.mapa}"`);
    if (!tela.btn || tela.btn.disabled || !/Pr[óo]xima miss[ãa]o/i.test(tela.btn.texto)) {
      throw new Error(`#btn-proxima-missao após a fase 19: disabled=${tela.btn && tela.btn.disabled} text="${tela.btn && tela.btn.texto}"`);
    }
    const save19 = await readSaveV2(page);
    if (!save19.phases[18].completed) throw new Error('save da fase 19 não foi gravado');
    await page.click('#btn-proxima-missao');
    await waitVisible(page, '#screen-game.active', 10000);
    await waitFor(page, () => {
      const s = window.__TD__.state();
      return s && s.phaseNumber === 20 && s.phase === 'prep';
    }, 15000);
    const st20 = await td(page, 'state');
    if (st20.startingMoney !== 1025) throw new Error(`startingMoney fase 20=${st20.startingMoney} (esperado 1025)`);
    await waitHudOnda(page, 'Fase 20/20 · Onda 1/2');
    const hud20 = (await page.locator('#hud-onda').textContent()).trim();
    if (hud20 !== 'Fase 20/20 · Onda 1/2') throw new Error(`#hud-onda fase 20="${hud20}"`);
    await td(page, 'win');
    await waitVisible(page, '#screen-campanha.active', 10000);
    const camp = await page.evaluate(() => ({
      texto: (document.getElementById('screen-campanha') || {}).textContent.replace(/\s+/g, ' ').trim(),
      fases: (document.getElementById('campanha-fases') || {}).textContent || '',
      estrelas: (document.getElementById('campanha-estrelas') || {}).textContent || '',
      btnMissoes: (() => {
        const b = document.getElementById('btn-campanha-missoes');
        return b ? { texto: b.textContent || '', disabled: b.disabled === true } : null;
      })(),
      btnMenu: (() => {
        const b = document.getElementById('btn-campanha-menu');
        return b ? { texto: b.textContent || '', disabled: b.disabled === true } : null;
      })(),
    }));
    if (!/Campanha conclu[íi]da!/i.test(camp.texto)) throw new Error(`#screen-campanha sem "Campanha concluída!": ${camp.texto.slice(0, 160)}`);
    if (!/20\/20 fases conclu[íi]das/i.test(camp.fases)) throw new Error(`#campanha-fases="${camp.fases}"`);
    if (!/60\/60/.test(camp.estrelas)) throw new Error(`#campanha-estrelas="${camp.estrelas}"`);
    if (!camp.btnMissoes || !/Selecionar miss[ãa]o/i.test(camp.btnMissoes.texto)) throw new Error('botão "Selecionar missão" ausente na campanha');
    if (!camp.btnMenu || !/^Menu$/i.test(camp.btnMenu.texto.trim())) throw new Error('botão "Menu" ausente na campanha');
    const saveFim = await readSaveV2(page);
    if (!saveFim.phases[19].completed) throw new Error('save da fase 20 não foi gravado');
    if (saveFim.phases.filter((f) => f.completed).length !== 20) throw new Error('save final não tem 20/20 fases concluídas');
    return `fase 20 vencida, campanha "${camp.fases.trim()}", ${camp.estrelas.trim()} estrelas, botões Selecionar missão/Menu`;
  });
  await step('screenshot campanha-concluida.png real 1280x800', async () => {
    const visivel = await visible(page, '#screen-campanha.active');
    if (!visivel) throw new Error('#screen-campanha não está ativa para a captura');
    const s = await capture(page, 'campanha-concluida.png');
    return `${(s.size / 1024).toFixed(0)} KB`;
  });
  await step('campanha → seleção de missão com 20/20 concluídas', async () => {
    await page.click('#btn-campanha-missoes');
    await waitVisible(page, '#screen-maps.active', 10000);
    const m = await readMissionList(page);
    if (m.cards.filter((c) => c.concluida).length !== 20) throw new Error(`esperava 20 fases concluídas, achei ${m.cards.filter((c) => c.concluida).length}`);
    if (m.cards.filter((c) => c.bloqueada).length !== 0) throw new Error('nenhuma fase deveria estar bloqueada com 20/20');
    if (!/20\/20 fases concluídas/.test(m.progresso) || !/60\/60 estrelas/.test(m.progresso)) throw new Error(`#map-progresso final="${m.progresso}"`);
    const c20 = m.cards.find((c) => c.fase === 20) || {};
    if (!c20.concluida || !/Conclu[íi]da/i.test(c20.estado)) throw new Error(`card da fase 20 final: ${JSON.stringify(c20)}`);
    // Evidência final da expansão: seleção com as 20 fases concluídas.
    const shot = await capture(page, 'missoes-20-fases.png');
    const naTela = await page.evaluate(() => [...document.querySelectorAll('.fase-card')]
      .filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }).length);
    if (naTela < 20) throw new Error(`só ${naTela} fase-card visíveis no desktop (esperado 20)`);
    await page.click('#btn-voltar-menu');
    await waitVisible(page, '#screen-menu.active', 10000);
    return `20/20 concluídas (${(shot.size / 1024).toFixed(0)} KB em missoes-20-fases.png), ${(m.progresso || '').trim()}`;
  });

  // ================================================================ 11) migração v1 -> v2
  await step('migração v1 → v2 no localStorage (contexto limpo)', async () => {
    const ctx2 = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page2 = await ctx2.newPage();
    const erros2 = [];
    page2.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      consoleErrors.push(`[migração] ${msg.text()}`);
      erros2.push(msg.text());
    });
    page2.on('pageerror', (err) => {
      pageErrors.push(`[migração] ${err && err.message ? err.message : String(err)}`);
      erros2.push(String(err));
    });
    page2.on('request', (req) => requests.push(req.url()));
    page2.on('response', (res) => {
      const url = res.url();
      if (!url.startsWith(origin) || /\/favicon\.ico$/.test(url)) return;
      if (res.status() >= 400) badResponses.push(`${res.status()} ${url.replace(origin, '')}`);
    });
    try {
      await page2.goto(`${origin}/`, { waitUntil: 'load', timeout: 30000 });
      await waitFor(page2, () => window.__TD__ && window.__TD__.ready === true, 25000);
      const legacy = {
        version: 1,
        tutorialDone: true,
        settings: { volume: 0.7, muted: false, speed: 1 },
        maps: {
          deserto: { unlocked: true, stars: 2, wavesWon: 8, bestLives: 18 },
          neve: { unlocked: true, stars: 1, wavesWon: 3, bestLives: 10 },
          cidade: { unlocked: false, stars: 0, wavesWon: 0, bestLives: 0 },
        },
        totals: { kills: 100, waves: 20, timePlayed: 600 },
      };
      await page2.evaluate((save) => {
        localStorage.clear();
        localStorage.setItem('td3d:save:v1', JSON.stringify(save));
      }, legacy);
      await page2.reload({ waitUntil: 'load', timeout: 30000 });
      await waitVisible(page2, '#screen-menu.active', 20000);
      await waitFor(page2, () => window.__TD__ && window.__TD__.ready === true, 25000);
      const brutoV2 = await page2.evaluate(() => localStorage.getItem('td3d:save:v2'));
      if (!brutoV2) throw new Error('migração não gravou td3d:save:v2 no boot');
      const save = await readSaveV2(page2);
      const probs = [];
      if (save.tutorialDone !== true) probs.push('tutorialDone');
      if (save.settings.volume !== 0.7) probs.push(`volume=${save.settings.volume}`);
      if (save.totals.kills !== 100) probs.push(`totals.kills=${save.totals.kills}`);
      if (save.bonusPermanent !== 225) probs.push(`bonusPermanent=${save.bonusPermanent} (9 concluídas × 25)`);
      for (let i = 0; i < 7; i += 1) {
        const f = save.phases[i];
        if (!f.completed || f.stars !== 2) probs.push(`deserto fase ${i + 1}=${JSON.stringify(f)}`);
        if (f.bestLives < 14 || f.bestLives > 19) probs.push(`melhor vidas fase ${i + 1}=${f.bestLives}`);
      }
      for (let i = 7; i < 9; i += 1) {
        const f = save.phases[i];
        if (!f.completed || f.stars !== 1) probs.push(`neve fase ${i + 1}=${JSON.stringify(f)}`);
      }
      if (save.phases[9].completed) probs.push('fase 10 não deveria estar concluída');
      if (save.phases.filter((f) => f.completed).length !== 9) probs.push(`${save.phases.filter((f) => f.completed).length} concluídas (esperado 9)`);
      if (probs.length) throw new Error(probs.join('; '));
      // A UI reflete o save migrado: 9 concluídas e fase 10 liberada.
      await page2.click('#btn-missoes');
      await waitVisible(page2, '#screen-maps.active', 10000);
      const m = await readMissionList(page2);
      const liberadas = m.cards.filter((c) => !c.disable).length;
      if (liberadas !== 10) throw new Error(`${liberadas} fases liberadas após migração (esperado 10)`);
      const c1 = m.cards.find((c) => c.fase === 1) || {};
      const c10 = m.cards.find((c) => c.fase === 10) || {};
      const c11 = m.cards.find((c) => c.fase === 11) || {};
      if (!c1.concluida || !c1.estrelas.includes('★★☆')) throw new Error(`fase 1 migrada: ${JSON.stringify(c1)}`);
      if (c10.disable || !c10.disponivel) throw new Error(`fase 10 deveria estar liberada: ${JSON.stringify(c10)}`);
      if (!c11.disable) throw new Error('fase 11 deveria estar bloqueada');
      if (!/9\/20 fases concluídas/.test(m.progresso) || !/16\/60 estrelas/.test(m.progresso)) {
        throw new Error(`#map-progresso migrado="${m.progresso}"`);
      }
      if (erros2.length) throw new Error(`erros de console na página da migração: ${erros2.slice(0, 3).join(' | ')}`);
      return `v1 {deserto 8 ondas, neve 3} → v2: 9 fases concluídas (deserto 2★, neve 1★), bônus 225, 10 liberadas, progresso "${m.progresso.trim()}"`;
    } finally {
      await ctx2.close().catch(() => {});
    }
  });

  // ================================================================ 12) rede/console
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
    return 'console e pageerror limpos durante toda a sessão (incluindo migração)';
  });
}

// ------------------------------------------------------------------ execução principal

const SCREENSHOTS_OBRIGATORIOS = [
  'menu.png',
  'missoes.png',
  'missoes-20-fases.png',
  'kit-construir.png',
  'batalha-aereos.png',
  'chefe-painel.png',
  'vitoria.png',
  'derrota.png',
  'fase-progressao.png',
  'campanha-concluida.png',
];

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
    await runGameChecks(page, server.origin, browser);

    // valida os arquivos finais obrigatórios de screenshot da expansão
    await step('screenshots obrigatórios presentes e válidos (1280x800, não uniformes)', async () => {
      const missing = SCREENSHOTS_OBRIGATORIOS.filter((name) => !existsSync(join(SHOTS_DIR, name)));
      if (missing.length) throw new Error(`faltando: ${missing.join(', ')}`);
      for (const name of SCREENSHOTS_OBRIGATORIOS) {
        const path = join(SHOTS_DIR, name);
        const buf = readFileSync(path);
        const info = decodePng(buf);
        if (info.width !== VIEWPORT.width || info.height !== VIEWPORT.height) {
          throw new Error(`${name}: ${info.width}x${info.height}`);
        }
        if (info.stddev < 2 || info.colors < 16) throw new Error(`${name}: imagem uniforme`);
        if (buf.length < 5 * 1024) throw new Error(`${name}: ${buf.length} bytes, muito pequeno`);
      }
      return SCREENSHOTS_OBRIGATORIOS.join(', ');
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
  await runGameHarness();
}

main().catch((err) => {
  console.error(`browser-check: erro fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
