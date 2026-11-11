#!/usr/bin/env node
/**
 * mobile-check.mjs — valida a versão de toque (celular/tablet) e o PWA.
 *
 * O que prova (execução real, não relatório):
 *   - carrega em viewport de iPhone (390×844, toque, DPR 3), iPad (1024×768, toque)
 *     e iPhone em paisagem (667×375, toque);
 *   - seleção de missão com as 20 fases agrupadas por cenário, por TOQUE: abre
 *     #btn-missoes, conta 20 .fase-card em 3 grupos, confere cadeados/estrelas e
 *     entra em uma fase tocando no card;
 *   - menu/tutorial/HUD funcionam por TOQUE (touchscreen.tap), sem mouse/teclado;
 *   - construção de torre por toque no canvas (projeção do slot pelo próprio jogo);
 *   - botões +/− de zoom e PINÇA de dois dedos mudam a distância da câmera;
 *   - layout sem rolagem horizontal e alvos de toque ≥ 40 px;
 *   - BUG-MOB-04: na ONDA DE CHEFE (fase 5, onda 2) a `.chefe-barra` não cobre a
 *     HUD — o retângulo fica abaixo dos botões, o hit-test dos centros dos botões
 *     da HUD acerta o próprio botão (pointer-events: none) e tocar Pausar/Ajuda
 *     continua funcionando no iPhone retrato e no iPad;
 *   - manifest e service worker válidos; recarregar OFFLINE ainda abre o jogo.
 *
 * Playwright é opcional: sem ele o teste imprime SKIP e sai 0 (como o browser-check).
 * Uso: node tests/mobile-check.mjs
 *      NODE_PATH=/root/qa-work/node_modules CHROMIUM_PATH=... node tests/mobile-check.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
    return true;
  } catch (err) {
    return false; // o check seguinte registra o FAIL
  }
}

async function esperarPronto(page) {
  await page.waitForFunction(
    () => window.__TD__ && window.__TD__.ready === true && typeof window.__TD__.state === 'function',
    null,
    { timeout: 25000 },
  );
}

async function semRolagemHorizontal(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function fecharTutorial(page) {
  let passos = 0;
  for (let i = 0; i < 12; i += 1) {
    const visivel = await page.evaluate(() => {
      const t = document.querySelector('#tutorial');
      if (!t || t.hidden) return false;
      const cs = getComputedStyle(t);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    if (!visivel) break;
    await tap(page, '#btn-tutorial-ok');
    passos += 1;
  }
  return passos;
}

/** Estado serializado da HUD: posições dos botões, barra do chefe e hit-test dos centros. */
async function layoutHudChefe(page) {
  return page.evaluate(() => {
    const barra = document.getElementById('chefe-barra');
    const csBarra = barra ? getComputedStyle(barra) : null;
    const rb = barra && !barra.hidden ? barra.getBoundingClientRect() : null;
    const botoes = [...document.querySelectorAll('.hud-botoes .botao')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      })
      .map((b) => {
        const r = b.getBoundingClientRect();
        const centro = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const alvo = document.elementFromPoint(centro.x, centro.y);
        return {
          id: b.id || b.textContent.trim().slice(0, 16),
          rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          centro,
          acertou: !!(alvo && (alvo === b || b.contains(alvo))),
          alvo: alvo ? (alvo.id || alvo.tagName) : null,
        };
      });
    const intersecta = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const colisoes = rb ? botoes.filter((b) => intersecta(rb, b.rect)).map((b) => b.id) : [];
    const hudBottom = botoes.length ? Math.max(...botoes.map((b) => b.rect.bottom)) : 0;
    return {
      barra: rb
        ? {
          top: rb.top, bottom: rb.bottom, left: rb.left, right: rb.right, width: rb.width, height: rb.height,
          pointerEvents: csBarra.pointerEvents,
          visivel: true,
          titulo: barra.textContent.replace(/\s+/g, ' ').trim().slice(0, 80),
          vidaLargura: (() => {
            const v = document.getElementById('chefe-vida');
            return v ? v.getBoundingClientRect().width : 0;
          })(),
        }
        : { visivel: false, pointerEvents: csBarra ? csBarra.pointerEvents : 'ausente' },
      botoes,
      colisoes,
      hudBottom,
      gapAbaixoDaHud: rb ? rb.top - hudBottom : -999,
      dentroViewport: rb ? rb.top >= -1 && rb.bottom <= window.innerHeight + 1 : false,
      semCobrirHud: !rb || colisoes.length === 0,
    };
  });
}

async function testarDispositivo(browser, url, rotulo, opcoesContexto, minAlvo = 40) {
  const ctx = await browser.newContext({ locale: 'pt-BR', ...opcoesContexto });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));

  const r = { erros, page, ctx, sufixo: rotulo };
  await page.goto(url, { waitUntil: 'load' });
  await esperarPronto(page);

  check(`[${rotulo}] carrega menu (toque)`, await page.locator('#screen-menu').isVisible());
  if (rotulo === 'iphone') await page.screenshot({ path: path.join(SHOTS, 'mobile-iphone-menu.png') });
  check(`[${rotulo}] sem rolagem horizontal`, await semRolagemHorizontal(page),
    `scroll=${await page.evaluate(() => document.documentElement.scrollWidth)} largura=${await page.evaluate(() => innerWidth)}`);

  // ------------------------------------------------ seleção das 20 fases por toque
  await tap(page, '#btn-missoes');
  await page.waitForSelector('#screen-maps.active', { timeout: 8000 });
  check(`[${rotulo}] missões abre por toque`, await page.locator('#screen-maps').isVisible());

  const mapa = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#map-list .fase-card')];
    const grupos = [...document.querySelectorAll('#map-list .fase-grupo')].map((g) => ({
      cenario: g.getAttribute('data-cenario'),
      titulo: (g.querySelector('.fase-grupo-titulo') || {}).textContent || '',
      cards: g.querySelectorAll('.fase-card').length,
    }));
    const detalhe = cards.map((c) => ({
      fase: Number(c.getAttribute('data-fase')),
      disabled: c.disabled === true,
      bloqueada: c.classList.contains('fase-card--bloqueada'),
      numero: (c.querySelector('.fase-numero') || {}).textContent || '',
      cenario: (c.querySelector('.fase-cenario') || {}).textContent || '',
      estado: (c.querySelector('.fase-estado') || {}).textContent || '',
      estrelas: (c.querySelector('.fase-estrelas') || {}).textContent || '',
    }));
    return {
      cards: detalhe.length,
      fases: detalhe.map((d) => d.fase),
      grupos,
      dica: (document.querySelector('#screen-maps .painel-dica') || {}).textContent || '',
      detalhe,
    };
  });
  const fases = mapa.fases.slice().sort((a, b) => a - b);
  check(`[${rotulo}] seleção tem exatamente 20 .fase-card`, mapa.cards === 20, `cards=${mapa.cards}`);
  check(`[${rotulo}] cards numerados 1..20 sem buracos`, fases.join(',') === Array.from({ length: 20 }, (_, i) => i + 1).join(','),
    `fases=${fases.join(',')}`);
  check(`[${rotulo}] 20 fases em 3 grupos por cenário (deserto/neve/cidade)`,
    mapa.grupos.length === 3
      && mapa.grupos.map((g) => g.cenario).join(',') === 'deserto,neve,cidade'
      && mapa.grupos.reduce((s, g) => s + g.cards, 0) === 20,
    mapa.grupos.map((g) => `${g.cenario}:${g.cards}(${g.titulo.trim()})`).join(' | '));
  const fase1 = mapa.detalhe.find((d) => d.fase === 1) || {};
  const fase2 = mapa.detalhe.find((d) => d.fase === 2) || {};
  const fase20 = mapa.detalhe.find((d) => d.fase === 20) || {};
  check(`[${rotulo}] fase 1 disponível e fase 2/20 bloqueadas com cadeado`,
    fase1.disabled === false && /Dispon[íi]vel/i.test(fase1.estado)
      && fase2.disabled === true && fase2.bloqueada === true && /Bloqueada/i.test(fase2.estado)
      && fase20.disabled === true && fase20.bloqueada === true,
    `fase1="${fase1.estado}", fase2="${fase2.estado}", fase20="${fase20.estado}"`);
  check(`[${rotulo}] dica de progressão na seleção`, /Complete uma fase para liberar a pr[óo]xima/i.test(mapa.dica),
    `dica="${mapa.dica.trim().slice(0, 70)}"`);
  check(`[${rotulo}] cards mostram cenário e estrelas (☆☆☆)`,
    mapa.detalhe.every((d) => d.cenario.trim().length > 0 && d.estrelas.includes('☆')),
    `fase1=${fase1.cenario} ${fase1.estrelas}`);

  // tocar num card bloqueado não entra na partida
  const boxBloqueado = await page.locator('.fase-card[data-fase="2"]').boundingBox();
  if (boxBloqueado) {
    await page.touchscreen.tap(boxBloqueado.x + boxBloqueado.width / 2, boxBloqueado.y + boxBloqueado.height / 2);
    await sleep(250);
  }
  const aindaMissoes = await page.evaluate(() => {
    const maps = document.querySelector('#screen-maps');
    const game = document.querySelector('#screen-game');
    return maps && maps.classList.contains('active') && (!game || game.hidden);
  });
  check(`[${rotulo}] tocar fase bloqueada não inicia partida`, !!aindaMissoes);

  // abre a fase 1 por toque
  await tap(page, '.fase-card[data-fase="1"]');
  await page.waitForSelector('#screen-game.active', { timeout: 10000 });
  const passosTutorial = await fecharTutorial(page);
  check(`[${rotulo}] fase 1 abre por toque e tutorial fecha por toque`, await page.locator('#hud-top').isVisible(),
    `${passosTutorial} passos de tutorial`);
  const hudOnda = (await page.locator('#hud-onda').textContent()).trim();
  check(`[${rotulo}] HUD "Fase 1/20 · Onda 1/2"`, hudOnda === 'Fase 1/20 · Onda 1/2', `texto="${hudOnda}"`);

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
  check(`[${rotulo}] alvos de toque ≥ ${minAlvo} px`, alvos.length > 0 && alvos.every((h) => h >= minAlvo),
    `alturas=${alvos.map((h) => Math.round(h)).join(',')}`);
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
  const tropasBloqueadas = await page.evaluate(() => [...document.querySelectorAll('#painel-tropas .tropa-card')].map((c) => ({
    tipo: c.getAttribute('data-tropa'),
    disabled: c.disabled === true,
    texto: c.textContent.replace(/\s+/g, ' ').trim(),
    bloqueio: (c.querySelector('.tropa-bloqueio') || {}).textContent || '',
  })));
  const fuzileiros = tropasBloqueadas.find((t) => t.tipo === 'fuzileiros') || {};
  const antiaerea = tropasBloqueadas.find((t) => t.tipo === 'antiaerea') || {};
  const sniper = tropasBloqueadas.find((t) => t.tipo === 'sniper') || {};
  check(`[${rotulo}] tropas bloqueadas mostram "Desbloqueia na fase N"`,
    fuzileiros.disabled === false && antiaerea.disabled === true && /Desbloqueia na fase 3/.test(antiaerea.texto)
      && sniper.disabled === true && /Desbloqueia na fase 5/.test(sniper.texto),
    `antiaerea="${antiaerea.bloqueio || antiaerea.texto.slice(0, 40)}", sniper="${sniper.bloqueio || sniper.texto.slice(0, 40)}"`);
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

  // Screenshot de batalha (antes do caso de chefe)
  await page.screenshot({ path: path.join(SHOTS, `mobile-${rotulo}-batalha.png`) });

  // ------------------------------------------------ BUG-MOB-04: onda de chefe
  // Fase 5, onda 2 é a primeira onda de chefe (chefe-deserto). Inicia pela API
  // de QA e avança até o chefe; a HUD e a barra ficam na tela real.
  const iniciouFase5 = await page.evaluate(() => {
    try {
      return window.__TD__.start({ phase: 5, completedPhases: 4, money: 2500, seed: 20261110 }) !== false;
    } catch (err) {
      return false;
    }
  });
  check(`[${rotulo}] fase 5 inicia por __TD__.start({phase:5})`, iniciouFase5);
  await esperar(page, () => {
    const s = window.__TD__.state();
    return s && s.phaseNumber === 5 && s.wave === 1;
  }, 8000);
  await page.waitForSelector('#screen-game.active', { timeout: 8000 });
  await fecharTutorial(page);
  // onda 2 = onda principal da fase, com o chefe
  const spawnouOnda2 = await page.evaluate(() => window.__TD__.spawnWave(2) !== false);
  let chefeOk = false;
  for (let i = 0; i < 8 && !chefeOk; i += 1) {
    await page.evaluate(() => window.__TD__.fastForward(2));
    await sleep(120);
    chefeOk = await page.evaluate(() => {
      const s = window.__TD__.state();
      return !!(s && s.boss);
    });
  }
  if (!chefeOk) {
    // plano B: o chefe é um grupo da onda 2; se o spawn atrasou, força o tipo da fase.
    await page.evaluate(() => window.__TD__.spawnEnemy('chefe-deserto', 1));
    await page.evaluate(() => window.__TD__.fastForward(1));
    await sleep(120);
    chefeOk = await page.evaluate(() => !!(window.__TD__.state() && window.__TD__.state().boss));
  }
  await esperar(page, () => {
    const b = document.querySelector('#chefe-barra');
    return b && !b.hidden;
  }, 8000);
  const hudChefe = (await page.locator('#hud-onda').textContent()).trim();
  check(`[${rotulo}] onda de chefe ativa com a barra visível`, spawnouOnda2 && chefeOk && (await page.locator('#chefe-barra').isVisible()),
    `HUD "${hudChefe}", boss=${chefeOk ? 'sim' : 'não'}`);
  check(`[${rotulo}] HUD "Fase 5/20 · Onda 2/2" na onda de chefe`, hudChefe === 'Fase 5/20 · Onda 2/2', `texto="${hudChefe}"`);

  const layout = await layoutHudChefe(page);
  check(`[${rotulo}] BUG-MOB-04: .chefe-barra pointer-events: none`, layout.barra.visivel && layout.barra.pointerEvents === 'none',
    `pointer-events=${layout.barra.pointerEvents}`);
  check(`[${rotulo}] BUG-MOB-04: barra do chefe não cobre nenhum botão da HUD`, layout.semCobrirHud,
    layout.colisoes.length ? `colisões: ${layout.colisoes.join(',')}` : 'sem interseção com os botões');
  if (rotulo !== 'iphone-paisagem') {
    // iPhone retrato e iPad: a barra fica abaixo de TODOS os botões da HUD.
    check(`[${rotulo}] BUG-MOB-04: barra do chefe abaixo da HUD`, layout.gapAbaixoDaHud >= -1,
      `barra.top=${layout.barra.visivel ? layout.barra.top.toFixed(1) : 'n/a'} hudBottom=${layout.hudBottom.toFixed(1)} gap=${layout.gapAbaixoDaHud.toFixed(1)}px`);
  }
  check(`[${rotulo}] BUG-MOB-04: barra do chefe visível dentro do viewport`, layout.barra.visivel && layout.dentroViewport && layout.barra.width > 100,
    layout.barra.visivel ? `${layout.barra.width.toFixed(0)}x${layout.barra.height.toFixed(0)} em (${layout.barra.left.toFixed(0)},${layout.barra.top.toFixed(0)})` : 'barra ausente');
  const foraHitTest = layout.botoes.filter((b) => !b.acertou);
  check(`[${rotulo}] BUG-MOB-04: centros de TODOS os botões da HUD passam no hit-test`,
    layout.botoes.length >= 4 && foraHitTest.length === 0,
    `${layout.botoes.length - foraHitTest.length}/${layout.botoes.length} clicáveis${foraHitTest.length ? `; falharam: ${foraHitTest.map((b) => `${b.id}->${b.alvo}`).join(',')}` : ''}`);

  await tap(page, '#btn-pausa');
  const pausou = await esperar(page, () => {
    const p = document.querySelector('#screen-pause');
    return p && !p.hidden && p.classList.contains('active');
  }, 5000);
  check(`[${rotulo}] BUG-MOB-04: tocar Pausar funciona na onda de chefe`, pausou);
  if (pausou) {
    await tap(page, '#btn-continuar');
    await esperar(page, () => {
      const g = document.querySelector('#screen-game');
      return g && g.classList.contains('active') && !g.hidden;
    }, 5000);
  }
  await tap(page, '#btn-ajuda');
  const ajudou = await esperar(page, () => {
    const a = document.querySelector('#screen-help');
    return a && !a.hidden && a.classList.contains('active');
  }, 5000);
  check(`[${rotulo}] BUG-MOB-04: tocar Ajuda funciona na onda de chefe`, ajudou);
  if (ajudou) await tap(page, '#btn-fechar-ajuda');
  const barraDepois = await page.evaluate(() => {
    const b = document.querySelector('#chefe-barra');
    return !!b && !b.hidden;
  });
  check(`[${rotulo}] barra do chefe continua visível após pausar/ajudar`, barraDepois);

  if (rotulo === 'iphone' || rotulo === 'ipad') {
    const arquivoChefe = path.join(SHOTS, `mobile-${rotulo}-chefe.png`);
    await page.screenshot({ path: arquivoChefe });
    const tamanho = existsSync(arquivoChefe) ? readFileSync(arquivoChefe).length : 0;
    check(`[${rotulo}] screenshot mobile-${rotulo}-chefe.png real`, tamanho > 8 * 1024, `${(tamanho / 1024).toFixed(0)} KB`);
  }

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
    const rodada1 = await testarDispositivo(browser, serverUrl, 'iphone', iPhone);
    await rodada1.ctx.close();
    const rodada2 = await testarDispositivo(browser, serverUrl, 'ipad', iPad);
    await rodada2.ctx.close();
    const rodada3 = await testarDispositivo(browser, serverUrl, 'iphone-paisagem', iPhonePaisagem);
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
