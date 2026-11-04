'use strict';

/*
 * Gera as capturas reais usadas no tutorial e na comparacao antes/depois.
 *
 * Uso:
 *   node tests/capture.cjs [--baseline caminho/para/index-v1.html]
 *
 * Sem --baseline, apenas as capturas da v2 sao geradas.
 * Requer Playwright (dependencia apenas de desenvolvimento).
 */

const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    try {
      return require('playwright-core');
    } catch (err2) {
      console.error('Playwright nao encontrado. Instale com: npm install --no-save playwright && npx playwright install chromium');
      process.exit(2);
    }
  }
}

const { chromium } = loadPlaywright();
const ROOT = path.resolve(__dirname, '..');
const APP = 'file://' + path.join(ROOT, 'index.html');
const IMG = path.join(ROOT, 'docs', 'img');

function urlFor(file) {
  return file.indexOf('file://') === 0 ? file : 'file://' + path.resolve(file);
}

async function newPage(browser, options) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce'
  });
  if (options && options.blockStorage) {
    await context.addInitScript(function () {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: function () { throw new DOMException('localStorage bloqueado', 'SecurityError'); }
      });
    });
  }
  const page = await context.newPage();
  return { context: context, page: page };
}

async function hideToast(page) {
  await page.evaluate(function () {
    const toast = document.getElementById('toast');
    if (toast) { toast.classList.remove('show'); }
  });
  await page.waitForTimeout(220);
}

async function shot(page, name) {
  await hideToast(page);
  await page.screenshot({ path: path.join(IMG, name) });
  console.log('captura:', path.join('docs/img', name));
}

(async function main() {
  fs.mkdirSync(IMG, { recursive: true });
  const baselineIndex = process.argv.indexOf('--baseline');
  const baseline = baselineIndex !== -1 ? process.argv[baselineIndex + 1] : null;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined
  });

  try {
    if (baseline) {
      const opened = await newPage(browser);
      await opened.page.goto(urlFor(baseline));
      await opened.page.waitForTimeout(500);
      await opened.page.screenshot({ path: path.join(IMG, 'v2-antes-editor.png') });
      console.log('captura:', path.join('docs/img', 'v2-antes-editor.png'));
      await opened.context.close();
    }

    const opened = await newPage(browser);
    const page = opened.page;
    const dialogValues = [];
    page.on('dialog', async function (dialog) {
      const value = dialogValues.length ? dialogValues.shift() : undefined;
      await dialog.accept(value);
    });
    await page.goto(APP);
    await page.waitForTimeout(500);
    await shot(page, 'v2-depois-editor.png');
    await shot(page, 'tutorial-01-tela-inicial.png');

    // Editar um no novo, com o editor de texto aberto.
    await page.mouse.dblclick(1050, 700);
    await page.waitForTimeout(200);
    await page.keyboard.type('Nova ideia');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(IMG, 'tutorial-02-editar-no.png') });
    console.log('captura:', path.join('docs/img', 'tutorial-02-editar-no.png'));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);

    // Conectar o no novo ao no "Projetos" com Shift + arrastar.
    const created = await page.evaluate(function () {
      const selected = document.querySelector('.node.selected');
      return selected ? selected.getAttribute('data-node-id') : null;
    });
    const createdBox = await page.locator('[data-node-id="' + created + '"]').boundingBox();
    const targetBox = await page.locator('[data-node-id="n-projetos"]').boundingBox();
    await page.evaluate(function (args) {
      const source = document.querySelector('[data-node-id="n-projetos"]');
      source.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, clientX: args.ax, clientY: args.ay, button: 0, buttons: 1,
        pointerId: 1, pointerType: 'mouse', shiftKey: true
      }));
      for (let i = 1; i <= 12; i += 1) {
        window.dispatchEvent(new PointerEvent('pointermove', {
          clientX: args.ax + (args.bx - args.ax) * i / 12,
          clientY: args.ay + (args.by - args.ay) * i / 12,
          buttons: 1, pointerId: 1, pointerType: 'mouse', bubbles: true
        }));
      }
      window.dispatchEvent(new PointerEvent('pointerup', {
        clientX: args.bx, clientY: args.by, button: 0, buttons: 0,
        pointerId: 1, pointerType: 'mouse', bubbles: true
      }));
    }, {
      ax: targetBox.x + targetBox.width / 2,
      ay: targetBox.y + targetBox.height / 2,
      bx: createdBox.x + createdBox.width / 2,
      by: createdBox.y + createdBox.height / 2
    });
    await page.waitForTimeout(300);
    await page.click('[data-node-id="' + created + '"]');
    await shot(page, 'tutorial-03-conectar.png');

    // Renomear um no pelo painel de estrutura.
    await page.hover('#outlineTree [data-outline-id="n-projetos"]');
    await page.click('#outlineTree [data-outline-id="n-projetos"] [data-action="rename"]');
    await page.fill('.outline-input', 'Projetos 2026');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(IMG, 'tutorial-04-renomear-painel.png') });
    console.log('captura:', path.join('docs/img', 'tutorial-04-renomear-painel.png'));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);

    // Organizar em arvore.
    await page.click('#btnOrganizar');
    await page.waitForTimeout(500);
    await shot(page, 'tutorial-05-organizar.png');

    // Multiplos mapas: criar e renomear um segundo mapa.
    await page.click('#btnMapNew');
    await page.waitForTimeout(250);
    dialogValues.push('Planejamento 2026');
    await page.click('#btnMapRename');
    await page.waitForTimeout(250);
    await shot(page, 'tutorial-06-multiplos-mapas.png');

    // Ajuda e atalhos.
    await page.click('#btnHelp');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(IMG, 'tutorial-07-atalhos.png') });
    console.log('captura:', path.join('docs/img', 'tutorial-07-atalhos.png'));

    await opened.context.close();

    // localStorage bloqueado.
    const blocked = await newPage(browser, { blockStorage: true });
    await blocked.page.goto(APP);
    await blocked.page.waitForTimeout(400);
    await blocked.page.click('#btnSave');
    await blocked.page.waitForTimeout(150);
    await blocked.page.screenshot({ path: path.join(IMG, 'tutorial-08-sem-localstorage.png') });
    console.log('captura:', path.join('docs/img', 'tutorial-08-sem-localstorage.png'));
    await blocked.context.close();
  } finally {
    await browser.close();
  }
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
