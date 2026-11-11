'use strict';

/*
 * Capturas reais do site "Taichi na Cadeira" (ferramenta de desenvolvimento).
 *
 * Uso (a partir da raiz do repositorio):
 *
 *   NODE_PATH=/tmp/pw/node_modules node taichi-na-cadeira/tests/capture.cjs
 *
 * Caminhos alternativos:
 *   CHROMIUM_PATH=/caminho/para/chrome \
 *   PLAYWRIGHT_MODULE=/caminho/para/playwright-core \
 *   node taichi-na-cadeira/tests/capture.cjs
 *
 * Fallbacks embutidos:
 *   playwright-core  -> /tmp/pw/node_modules/playwright-core
 *   chromium         -> /root/.cache/ms-playwright/chromium-1134/chrome-linux/chrome
 *
 * Gera 3 PNGs (1280x900, desktop) em taichi-na-cadeira/prints/, todos de
 * viewport (nunca screenshot de elemento) com scroll posicionado abaixo do
 * header sticky:
 *   01-topo-hero.png          -> topo/hero (scrollY=0)
 *   02-diagrama-postura.png   -> diagrama de postura (9o SVG, com marcacoes)
 *   03-cartoes-movimentos.png -> grade de cartoes com ilustracoes SVG
 *
 * Os 3 PNGs sao screenshots de viewport 1280x900 com scroll posicionado logo
 * abaixo do header sticky (nunca screenshot de elemento, sem scrollIntoView).
 * O programa/mentoria e conferido pelo browser-check.cjs (tabelas, 24 sessoes,
 * guia do mentor); prints/ fica limitado a 3 imagens, como pede a issue #21.
 *
 * Determinismo: viewport fixo, dpr=1, reducedMotion=reduce, animacoes e
 * transicoes desligadas via CSS injetado, espera document.fonts.ready, 2 rAF
 * + pausa curta antes de cada screenshot, prints/ limpo antes de capturar.
 * Exit code != 0 se a captura falhar ou houver erro de console na pagina.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PLAYWRIGHT = '/tmp/pw/node_modules/playwright-core';
const DEFAULT_CHROMIUM = '/root/.cache/ms-playwright/chromium-1134/chrome-linux/chrome';

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) { candidates.push(process.env.PLAYWRIGHT_MODULE); }
  candidates.push('playwright-core', 'playwright', DEFAULT_PLAYWRIGHT);
  for (const candidate of candidates) {
    try { return require(candidate); } catch (err) { /* tenta o proximo */ }
  }
  console.error('ERRO: playwright-core nao encontrado.');
  console.error('Rode com NODE_PATH=/tmp/pw/node_modules ou PLAYWRIGHT_MODULE=/caminho/playwright-core.');
  process.exit(2);
}

const { chromium } = loadPlaywright();

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || DEFAULT_CHROMIUM;
if (!fs.existsSync(CHROMIUM_PATH)) {
  console.error('ERRO: Chromium nao encontrado em ' + CHROMIUM_PATH);
  console.error('Defina CHROMIUM_PATH para um executavel valido.');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'prints');
const APP = 'file://' + INDEX;
const VIEWPORT = { width: 1280, height: 900 };

function readPngInfo(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') { return null; }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

function raw(value) { return String(value == null ? '' : value); }

async function settle(page) {
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(null); }); });
    });
  }).catch(function () {});
  await page.waitForTimeout(120);
}

async function scrollTo(page, y) {
  await page.evaluate(function (top) {
    window.scrollTo(0, top);
  }, Math.max(0, Math.round(y)));
  await settle(page);
}

(async function main() {
  if (!fs.existsSync(INDEX)) {
    console.error('ERRO: index.html nao existe em ' + INDEX);
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  // Limpa capturas antigas para manter exatamente as 3 imagens deterministicas.
  for (const name of fs.readdirSync(OUT)) {
    if (/\.png$/i.test(name)) { fs.unlinkSync(path.join(OUT, name)); }
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const shots = [];
  const consoleErrors = [];
  const pageErrors = [];

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'light'
    });
    const page = await context.newPage();
    page.on('console', function (message) {
      if (message.type() === 'error') { consoleErrors.push(message.text()); }
    });
    page.on('pageerror', function (error) {
      pageErrors.push(error && error.message ? error.message : String(error));
    });

    await page.goto(APP, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(function () {
      return document.fonts && document.fonts.ready ? document.fonts.ready.catch(function () {}) : null;
    }).catch(function () {});
    await page.addStyleTag({
      content: [
        '*, *::before, *::after {',
        '  animation: none !important;',
        '  animation-duration: 0s !important;',
        '  animation-delay: 0s !important;',
        '  transition: none !important;',
        '  transition-duration: 0s !important;',
        '  scroll-behavior: auto !important;',
        '}',
        'html { scroll-behavior: auto !important; }',
        '*, *::selection { caret-color: transparent !important; }'
      ].join('\n')
    });
    await page.evaluate(function () {
      window.scrollTo(0, 0);
      if (document.activeElement && document.activeElement.blur) { document.activeElement.blur(); }
    });
    await settle(page);

    // ---------------------------------------------------------------
    // Mede o layout para escolher enquadramentos reprodutiveis.
    // ---------------------------------------------------------------
    const layout = await page.evaluate(function (viewport) {
      function norm(value) {
        return String(value == null ? '' : value)
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase().replace(/\s+/g, ' ').trim();
      }
      function rectOf(el) {
        if (!el) { return null; }
        const rect = el.getBoundingClientRect();
        return {
          top: Math.round(rect.top + window.scrollY),
          bottom: Math.round(rect.bottom + window.scrollY),
          left: Math.round(rect.left + window.scrollX),
          right: Math.round(rect.right + window.scrollX),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      }
      function headingFor(regex) {
        const headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
        const found = headings.filter(function (h) { return regex.test(norm(h.textContent)); })[0];
        return found || null;
      }
      function sectionFor(heading) {
        if (!heading) { return null; }
        return heading.closest('section,article') || heading.parentElement;
      }
      function sectionInfo(selector, regex) {
        let el = selector ? document.querySelector(selector) : null;
        if (!el && regex) { el = sectionFor(headingFor(regex)); }
        return rectOf(el);
      }
      const cards = Array.prototype.slice.call(document.querySelectorAll('[data-movement]'));
      let cardsSection = null;
      if (cards.length) {
        cardsSection = cards[0].closest('section') || cards[0].parentElement;
      }
      if (!cardsSection) {
        const heading = headingFor(/movimento/);
        cardsSection = sectionFor(heading);
      }
      const hero = document.querySelector('main > section.hero, section.hero, #hero, .hero') ||
        document.querySelector('main > section:first-of-type') ||
        document.querySelector('body > section:first-of-type') ||
        document.querySelector('header');
      const header = document.querySelector('header');
      let headerHeight = 0;
      if (header) {
        const style = window.getComputedStyle(header);
        if (style.position === 'sticky' || style.position === 'fixed') {
          headerHeight = Math.round(header.getBoundingClientRect().height);
        }
      }
      return {
        docHeight: document.documentElement.scrollHeight,
        viewport: viewport,
        headerHeight: headerHeight,
        hero: rectOf(hero),
        posture: sectionInfo('#postura,#diagrama-postura', /postura/),
        cards: rectOf(cardsSection),
        firstCard: rectOf(cards[0] || null),
        cardCount: cards.length,
        program: sectionInfo('#programa', /programa|8 semanas/),
        mentor: sectionInfo('#mentor', /mentor/),
        print: sectionInfo('#imprimir', /imprim/),
        svgCount: document.querySelectorAll('svg').length
      };
    }, VIEWPORT);

    console.log('layout: docHeight=' + layout.docHeight + 'px, svg=' + layout.svgCount + ', cards=' + layout.cardCount);
    console.log('layout: hero=' + JSON.stringify(layout.hero) + ' posture=' + JSON.stringify(layout.posture) + ' cards=' + JSON.stringify(layout.cards));

    const maxScroll = Math.max(0, layout.docHeight - VIEWPORT.height);

    async function capture(name, scrollY, note) {
      await scrollTo(page, Math.max(0, Math.min(maxScroll, scrollY)));
      const actualY = await page.evaluate(function () { return Math.round(window.scrollY); });
      await page.screenshot({ path: path.join(OUT, name) });
      const info = readPngInfo(path.join(OUT, name));
      if (!info) { throw new Error('PNG invalido gerado: ' + name); }
      if (info.width !== VIEWPORT.width || info.height !== VIEWPORT.height) {
        throw new Error('dimensoes inesperadas em ' + name + ': ' + info.width + 'x' + info.height);
      }
      shots.push({ name: name, y: actualY, note: note });
      console.log('captura: prints/' + name + ' (' + info.width + 'x' + info.height + ', scrollY=' + actualY + ', ' + info.bytes + ' bytes)');
    }

    async function scrollBelowHeader(top, gap) {
      return Math.max(0, top - layout.headerHeight - (gap === undefined ? 12 : gap));
    }

    // 01) topo/hero (scrollY=0). O header sticky aparece no topo, que e o
    // comportamento real da pagina.
    await capture('01-topo-hero.png', 0, 'topo/hero');

    // 02) diagrama de postura (9o SVG, com marcacoes). Posiciona o titulo da
    // secao logo abaixo do header sticky; nada de screenshot de elemento.
    if (layout.posture) {
      await capture('02-diagrama-postura.png', await scrollBelowHeader(layout.posture.top), 'diagrama de postura');
    } else {
      await capture('02-secao.png', Math.min(maxScroll, VIEWPORT.height), 'fallback: segunda dobra (sem #postura)');
    }

    // 03) grade de cartoes de movimento com as ilustracoes SVG. Alinha o topo
    // do primeiro cartao logo abaixo do header sticky (viewport 1280x900).
    if (layout.firstCard) {
      await capture('03-cartoes-movimentos.png', await scrollBelowHeader(layout.firstCard.top, 12), 'grade de cartoes');
    } else if (layout.cards) {
      await capture('03-cartoes-movimentos.png', await scrollBelowHeader(layout.cards.top, 24), 'grade de cartoes (fallback: secao)');
    } else if (layout.program) {
      await capture('03-programa.png', await scrollBelowHeader(layout.program.top), 'programa (fallback: sem cartoes)');
    } else {
      await capture('03-secao.png', maxScroll, 'fallback: fim da pagina');
    }

    // Não deixa erro de console passar em silencio na captura.
    if (consoleErrors.length || pageErrors.length) {
      console.error('ERRO: pagina gerou erros durante a captura: console=' + consoleErrors.length + ', pageerror=' + pageErrors.length);
      consoleErrors.slice(0, 5).forEach(function (msg) { console.error(' console: ' + msg); });
      pageErrors.slice(0, 5).forEach(function (msg) { console.error(' pageerror: ' + msg); });
      process.exitCode = 1;
    }

    await context.close();

    console.log('');
    console.log('== CAPTURAS: ' + shots.length + ' PNG(s) em ' + OUT + ' ==');
    for (const shot of shots) {
      const info = readPngInfo(path.join(OUT, shot.name));
      console.log(' - ' + shot.name + ': ' + info.width + 'x' + info.height + ', ' + info.bytes + ' bytes, ' + shot.note + ', scrollY=' + shot.y);
    }
    if (shots.length < 2 || shots.length > 3) {
      console.error('ERRO: esperado 2-3 PNGs, gerados ' + shots.length);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
})().catch(function (error) {
  console.error('ERRO FATAL na captura:');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
