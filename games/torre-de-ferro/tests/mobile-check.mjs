#!/usr/bin/env node
/**
 * mobile-check.mjs — valida a versão de toque (celular/tablet) e o PWA.
 *
 * O que prova (execução real, não relatório):
 *   - carrega em viewport de iPhone (390×844, toque, DPR 3) e iPad (1024×768, toque);
 *   - menu/tutorial/HUD funcionam por TOQUE (touchscreen.tap), sem mouse/teclado;
 *   - construção de torre por toque no canvas (projeção do slot pelo próprio jogo);
 *   - botões +/− de zoom e PINÇA de dois dedos mudam a distância da câmera;
 *   - layout sem rolagem horizontal e alvos de toque ≥ 40 px;
 *   - manifest e service worker válidos; recarregar OFFLINE ainda abre o jogo.
 *
 * Playwright é opcional: sem ele o teste imprime SKIP e sai 0 (como o browser-check).
 * Uso: node tests/mobile-check.mjs
 *      NODE_PATH=/root/qa-work/node_modules CHROMIUM_PATH=... node tests/mobile-check.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(__dirname, '..');
const SHOTS = path.join(GAME, 'docs', 'screenshots');
const CHROMIUM = process.env.CHROMIUM_PATH || '';
mkdirSync(SHOTS, { recursive: true });

const resultados = [];
function check(nome, ok, detalhe = '') {
  resultados.push({ nome, ok: !!ok, detalhe });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(process.execPath, [path.join(GAME, 'serve.mjs'), '0'], {
    cwd: GAME,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`servidor não subiu em 8 s (${buf.slice(-160)})`)), 8000);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => reject(new Error(`servidor saiu antes de responder (${buf.slice(-160)})`)));
  });
  return { child, url };
}

async function tap(page, selector) {
  // locator.tap() usa evento de toque real e verifica se o alvo está clicável.
  await page.locator(selector).first().tap({ timeout: 8000 });
  await sleep(180);
}

// Espera um estado (sem falhar o teste se demorar; o check logo depois decide).
async function esperar(page, fn, timeout = 5000) {
  try {
    await page.waitForFunction(fn, null, { timeout });
  } catch (err) {
    /* o check seguinte registra o FAIL */
  }
}

async function esperarPronto(page) {
  await page.waitForFunction(() => window.__TD__ && window.__TD__.ready === true, null, { timeout: 25000 });
}

async function semRolagemHorizontal(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function testarDispositivo(browser, url, rotulo, opcoesContexto, fazerBatalha, minAlvo = 40) {
  const ctx = await browser.newContext({ locale: 'pt-BR', ...opcoesContexto });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));

  const r = { erros, page, ctx, sufixo: rotulo, falhas: [] };
  await page.goto(url, { waitUntil: 'load' });
  await esperarPronto(page);

  check(`[${rotulo}] carrega menu (toque)`, await page.locator('#screen-menu').isVisible());
  if (rotulo === 'iphone') await page.screenshot({ path: path.join(SHOTS, 'mobile-iphone-menu.png') });
  check(`[${rotulo}] sem rolagem horizontal`, await semRolagemHorizontal(page), `scroll=${await page.evaluate(() => document.documentElement.scrollWidth)} largura=${await page.evaluate(() => innerWidth)}`);

  // Menu → campanha → tutorial por toque
  await tap(page, '#btn-iniciar');
  await page.waitForSelector('#tutorial:not([hidden])', { timeout: 8000 });
  for (let i = 0; i < 6; i += 1) await tap(page, '#btn-tutorial-ok');
  await page.waitForSelector('#screen-game:not([hidden])', { timeout: 8000 });
  check(`[${rotulo}] tutorial e HUD abrem por toque`, await page.locator('#hud-top').isVisible());

  // Todos os botões da barra superior precisam caber na tela (pega HUD estourando em paisagem)
  const hudDentro = await page.evaluate(() => {
    const botoes = [...document.querySelectorAll('.hud-botoes .botao')];
    const fora = botoes.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width < 1 || r.right > window.innerWidth + 1 || r.left < -1;
    }).map((b) => b.id || b.textContent);
    return { total: botoes.length, fora };
  });
  check(`[${rotulo}] todos os botões da HUD dentro da tela`, hudDentro.fora.length === 0,
    `${hudDentro.total - hudDentro.fora.length}/${hudDentro.total} dentro${hudDentro.fora.length ? `; fora: ${hudDentro.fora.join(',')}` : ''}`);

  // Alvos de toque e dica específica de toque
  const alvos = await page.evaluate(() => [...document.querySelectorAll('.hud-botoes .botao')].map((b) => b.getBoundingClientRect().height));
  check(`[${rotulo}] alvos de toque ≥ ${minAlvo} px`, alvos.length > 0 && alvos.every((h) => h >= minAlvo), `alturas=${alvos.map((h) => Math.round(h)).join(',')}`);
  const ajudaMovel = await page.evaluate(() => {
    const a = document.querySelector('.ajuda-movel');
    return a ? getComputedStyle(a).display : 'ausente';
  });
  check(`[${rotulo}] conteúdo de ajuda móvel visível`, ajudaMovel !== 'none' && ajudaMovel !== 'ausente', `display=${ajudaMovel}`);

  // Painel de tropas e velocidade/mudo por toque
  await tap(page, '#btn-tropas');
  await esperar(page, () => {
    const p = document.querySelector('#painel-tropas');
    return p && !p.hidden;
  });
  check(`[${rotulo}] painel de tropas abre por toque`, await page.locator('#painel-tropas').isVisible());
  await tap(page, '#btn-fechar-tropas');
  await tap(page, '#btn-velocidade');
  await esperar(page, () => document.querySelector('#btn-velocidade')?.textContent.trim() === '2x');
  check(`[${rotulo}] velocidade 1x→2x por toque`, (await page.locator('#btn-velocidade').textContent()).trim() === '2x');
  await tap(page, '#btn-velocidade');
  await tap(page, '#btn-mudo');
  await esperar(page, () => document.querySelector('#btn-mudo')?.textContent.trim() === 'Mudo');
  check(`[${rotulo}] botão de som alterna para Mudo`, (await page.locator('#btn-mudo').textContent()).trim() === 'Mudo');
  await tap(page, '#btn-mudo');

  // Zoom por botões
  const antes = await page.evaluate(() => window.__TD__.view().distance);
  await tap(page, '#btn-zoom-mais');
  await tap(page, '#btn-zoom-mais');
  const depois = await page.evaluate(() => window.__TD__.view().distance);
  check(`[${rotulo}] botão + aproxima (#1 ${rotulo})`, depois < antes, `${antes.toFixed(1)} → ${depois.toFixed(1)}`);
  await tap(page, '#btn-zoom-menos');
  const voltou = await page.evaluate(() => window.__TD__.view().distance);
  check(`[${rotulo}] botão − afasta`, voltou > depois, `${depois.toFixed(1)} → ${voltou.toFixed(1)}`);

  // Pinça com dois dedos via CDP (coordenadas relativas ao viewport atual)
  const cdp = await ctx.newCDPSession(page);
  const v0 = await page.evaluate(() => window.__TD__.view().distance);
  const vp = page.viewportSize();
  const cy = Math.round(vp.height * 0.6);
  const cx = Math.round(vp.width / 2);
  const gap0 = Math.round(Math.min(80, vp.width * 0.15));
  const gap1 = Math.round(Math.min(130, vp.width * 0.28));
  const tocar = async (type, pontos) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pontos.map(([x, y], i) => ({ x, y, id: i, radiusX: 2, radiusY: 2, force: 1 })),
    });
  };
  await tocar('touchStart', [[cx - gap0, cy], [cx + gap0, cy]]);
  await tocar('touchMove', [[cx - gap1, cy], [cx + gap1, cy]]);
  await tocar('touchMove', [[cx - Math.round(gap1 * 1.1), cy], [cx + Math.round(gap1 * 1.1), cy]]);
  await tocar('touchEnd', []);
  await sleep(150);
  const v1 = await page.evaluate(() => window.__TD__.view().distance);
  check(`[${rotulo}] pinça de dois dedos dá zoom`, v1 < v0, `${v0.toFixed(1)} → ${v1.toFixed(1)} (y=${cy} de ${vp.height})`);

  // Construir torre tocando no canvas (slot projetado pelo próprio jogo)
  const slot = await page.evaluate(() => {
    const h = window.innerHeight;
    for (let i = 0; i < 16; i += 1) {
      const p = window.__TD__.projectSlot(i);
      if (p && p.visible && p.y > 150 && p.y < h - 120) return p;
    }
    return null;
  });
  check(`[${rotulo}] slot projetado na tela`, !!slot, slot ? `slot ${slot.slot} em (${Math.round(slot.x)},${Math.round(slot.y)})` : 'nenhum');
  if (slot) {
    await page.touchscreen.tap(slot.x, slot.y);
    await esperar(page, () => {
      const p = document.querySelector('#painel-construir');
      return p && !p.hidden;
    });
    const painel = await page.locator('#painel-construir').isVisible();
    check(`[${rotulo}] toque no slot abre painel Construir`, painel);
    if (painel) {
      await tap(page, '#painel-construir [data-torre="metralhadora"]');
      await esperar(page, () => window.__TD__.state().towers.length >= 1);
      const torres = await page.evaluate(() => window.__TD__.state().towers.length);
      check(`[${rotulo}] torre construída por toque`, torres >= 1, `torres=${torres}`);
    }
  }

  // Iniciar onda por toque e ver inimigos
  await tap(page, '#btn-onda');
  await esperar(page, () => window.__TD__.state().phase === 'wave');
  await page.evaluate(() => window.__TD__.fastForward(4));
  await esperar(page, () => window.__TD__.state().enemies.length > 0);
  const emOnda = await page.evaluate(() => window.__TD__.state().phase === 'wave');
  const inimigos = await page.evaluate(() => window.__TD__.state().enemies.length);
  check(`[${rotulo}] onda inicia e inimigos surgem`, emOnda && inimigos > 0, `faseOnda=${emOnda} inimigos=${inimigos}`);

  // PWA: manifest + service worker
  const manifestOk = await page.evaluate(async () => {
    try {
      const resp = await fetch('./manifest.webmanifest');
      const j = await resp.json();
      return resp.ok && j.name && Array.isArray(j.icons) && j.icons.length >= 2 && j.display === 'standalone';
    } catch (err) {
      return false;
    }
  });
  check(`[${rotulo}] manifest PWA válido`, !!manifestOk);
  const swOk = await page.evaluate(() => new Promise((resolve) => {
    if (!('serviceWorker' in navigator)) return resolve(false);
    const t = setTimeout(() => resolve(false), 8000);
    navigator.serviceWorker.ready.then(() => { clearTimeout(t); resolve(true); }).catch(() => { clearTimeout(t); resolve(false); });
  }));
  check(`[${rotulo}] service worker ativo`, !!swOk);

  // Screenshot de batalha
  await page.screenshot({ path: path.join(SHOTS, `mobile-${rotulo}-batalha.png`) });

  // Offline: recarregar deve abrir o menu pelo cache do service worker
  await ctx.setOffline(true);
  let offlineOk = false;
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#screen-menu', { timeout: 15000 });
    offlineOk = true;
  } catch (err) {
    offlineOk = false;
  }
  await ctx.setOffline(false);
  check(`[${rotulo}] recarrega offline com o cache`, offlineOk);

  check(`[${rotulo}] zero erro de console/pageerror`, erros.length === 0, erros.slice(0, 3).join(' | '));
  r.page = page;
  r.ctx = ctx;
  return r;
}

async function main() {
  let playwright;
  try {
    // createRequire respeita NODE_PATH (o import() de ESM não respeita).
    const require = createRequire(import.meta.url);
    playwright = require('playwright');
  } catch (err) {
    console.log('SKIP: playwright indisponível (instale playwright para rodar o teste de toque).');
    process.exit(0);
  }

  const { child, url } = await startServer();
  const serverUrl = await url;
  const launch = {
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
    ],
  };
  if (CHROMIUM && existsSync(CHROMIUM)) launch.executablePath = CHROMIUM;
  const browser = await playwright.chromium.launch(launch);
  let falhas = 0;
  try {
    const iPhone = {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    };
    const iPad = {
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    };
    // Celular na horizontal (o caso que a HUD já estourou): iPhone SE 667×375.
    const iPhonePaisagem = {
      viewport: { width: 667, height: 375 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    };
    const rodada1 = await testarDispositivo(browser, serverUrl, 'iphone', iPhone, true);
    await rodada1.ctx.close();
    const rodada2 = await testarDispositivo(browser, serverUrl, 'ipad', iPad, false);
    await rodada2.ctx.close();
    const rodada3 = await testarDispositivo(browser, serverUrl, 'iphone-paisagem', iPhonePaisagem, false);
    await rodada3.ctx.close();
  } finally {
    await browser.close();
    try { child.kill(); } catch (err) { /* opcional */ }
  }

  falhas = resultados.filter((r) => !r.ok).length;
  console.log('\n=================================================');
  console.log(`${resultados.length} checagens, ${resultados.length - falhas} PASS, ${falhas} FAIL`);
  if (falhas > 0) {
    console.log('FALHAS:');
    for (const r of resultados.filter((x) => !x.ok)) console.log(`  - ${r.nome}: ${r.detalhe}`);
  }
  console.log('=================================================');
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('ERRO fatal no mobile-check:', err && err.stack ? err.stack : err);
  process.exit(1);
});
