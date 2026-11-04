'use strict';

/*
 * Teste de fumaca do editor de mapas mentais v2.
 *
 * Requer Playwright (dependencia apenas de desenvolvimento; o editor continua
 * sem dependencias). Exemplos:
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *   node tests/smoke.cjs
 *
 * Tambem aceita CHROMIUM_PATH para usar um Chromium ja instalado:
 *   CHROMIUM_PATH=/caminho/para/chrome node tests/smoke.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
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
const APP = 'file://' + path.resolve(__dirname, '..', 'index.html');

function createDialogs(page) {
  const queue = [];
  const log = [];
  page.on('dialog', async function (dialog) {
    const value = queue.length ? queue.shift() : undefined;
    log.push({ type: dialog.type(), message: dialog.message(), value: value });
    if (value === undefined) { await dialog.accept(); }
    else { await dialog.accept(value); }
  });
  return { queue: queue, log: log };
}

function watchErrors(page) {
  const errors = [];
  page.on('console', function (message) {
    if (message.type() === 'error') { errors.push('console: ' + message.text()); }
  });
  page.on('pageerror', function (error) {
    errors.push('pageerror: ' + error.message);
  });
  return errors;
}

async function openPage(browser, options) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  if (options && options.blockStorage) {
    await context.addInitScript(function () {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: function () { throw new DOMException('localStorage bloqueado', 'SecurityError'); }
      });
    });
  }
  const page = await context.newPage();
  const errors = watchErrors(page);
  const dialogs = createDialogs(page);
  await page.goto(APP);
  await page.waitForTimeout(350);
  return { context: context, page: page, errors: errors, dialogs: dialogs };
}

async function nodeTransforms(page) {
  return page.evaluate(function () {
    const out = {};
    const nodes = document.querySelectorAll('[data-node-id]');
    for (let i = 0; i < nodes.length; i += 1) {
      out[nodes[i].getAttribute('data-node-id')] = nodes[i].getAttribute('transform');
    }
    return out;
  });
}

async function testAutolayout(page, dialogs) {
  const before = await nodeTransforms(page);
  await page.click('#btnOrganizar');
  await page.waitForTimeout(450);
  assert.ok(dialogs.log.some(function (item) { return item.type === 'confirm' && /Organizar o mapa/.test(item.message); }),
    'Organizar deve pedir confirmacao antes de substituir posicoes');
  const after = await nodeTransforms(page);
  assert.notDeepStrictEqual(after, before, 'Organizar deve mover os nos');

  const overlaps = await page.evaluate(function () {
    const nodes = Array.prototype.slice.call(document.querySelectorAll('[data-node-id]'));
    const rects = nodes.map(function (node) { return node.getBoundingClientRect(); });
    let count = 0;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) { count += 1; }
      }
    }
    return count;
  });
  assert.strictEqual(overlaps, 0, 'Autolayout nao deve sobrepor nos');

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(250);
  assert.deepStrictEqual(await nodeTransforms(page), before, 'Ctrl+Z deve restaurar as posicoes anteriores ao autolayout');
}

async function testOutline(page) {
  const rows = await page.locator('#outlineTree [data-outline-id]').count();
  assert.strictEqual(rows, 5, 'Painel de estrutura deve listar os cinco nos do mapa de exemplo');

  await page.click('#outlineTree [data-outline-id="n-projetos"] [data-action="label"]');
  await page.waitForTimeout(150);
  assert.strictEqual(await page.evaluate(function () {
    const selected = document.querySelector('.node.selected');
    return selected ? selected.getAttribute('data-node-id') : null;
  }), 'n-projetos', 'Clicar no painel deve selecionar o no');

  const offset = await page.evaluate(function () {
    const node = document.querySelector('[data-node-id="n-projetos"] rect').getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    return {
      dx: (node.left + node.width / 2) - (stage.left + stage.width / 2),
      dy: (node.top + node.height / 2) - (stage.top + stage.height / 2)
    };
  });
  assert.ok(Math.abs(offset.dx) < 2 && Math.abs(offset.dy) < 2, 'Clicar no painel deve centralizar o no no palco');

  await page.click('#outlineTree [data-outline-id="n-projetos"] [data-action="rename"]');
  await page.fill('.outline-input', 'Projetos 2026');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  assert.strictEqual(await page.textContent('#outlineTree [data-outline-id="n-projetos"] .outline-label'), 'Projetos 2026');
  assert.strictEqual(await page.evaluate(function () {
    const node = document.querySelector('[data-node-id="n-projetos"] text');
    return node ? node.textContent : null;
  }), 'Projetos 2026', 'Renomear no painel deve atualizar o no');

  const beforeCollapse = await page.locator('#outlineTree [data-outline-id]').count();
  await page.click('#outlineTree [data-outline-id="n-raiz"] [data-action="toggle"]');
  await page.waitForTimeout(120);
  const afterCollapse = await page.locator('#outlineTree [data-outline-id]').count();
  assert.ok(afterCollapse < beforeCollapse, 'Recolher um ramo deve esconder os filhos');
  await page.click('#outlineTree [data-outline-id="n-raiz"] [data-action="toggle"]');
  await page.waitForTimeout(120);
  assert.strictEqual(await page.locator('#outlineTree [data-outline-id]').count(), beforeCollapse, 'Expandir deve mostrar os filhos de novo');
}

async function testMaps(page, dialogs) {
  await page.click('#btnMapNew');
  await page.waitForTimeout(250);
  assert.strictEqual(await page.locator('#mapSelect option').count(), 2, 'Novo mapa deve aparecer no seletor');
  assert.strictEqual(await page.evaluate(function () { return window.__mindmap.state().nodes; }), 0, 'Novo mapa deve comecar vazio');

  dialogs.queue.push('Mapa de testes');
  await page.click('#btnMapRename');
  await page.waitForTimeout(150);
  const names = await page.$$eval('#mapSelect option', function (options) {
    return options.map(function (option) { return option.textContent; });
  });
  assert.ok(names.indexOf('Mapa de testes') !== -1, 'Renomear deve atualizar o seletor');

  await page.click('#btnMapDup');
  await page.waitForTimeout(250);
  assert.strictEqual(await page.locator('#mapSelect option').count(), 3, 'Duplicar deve criar um terceiro mapa');

  const firstId = await page.$eval('#mapSelect option', function (option) { return option.value; });
  await page.selectOption('#mapSelect', firstId);
  await page.waitForTimeout(250);
  assert.strictEqual(await page.evaluate(function () { return window.__mindmap.state().map; }), 'Mapa mental');
  assert.strictEqual(await page.evaluate(function () { return window.__mindmap.state().nodes; }), 5, 'O mapa original deve manter os nos');
  assert.strictEqual(await page.evaluate(function () {
    const node = document.querySelector('[data-node-id="n-projetos"] text');
    return node ? node.textContent : null;
  }), 'Projetos 2026', 'Alteracoes do mapa original devem persistir ao trocar de mapa');

  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForTimeout(450);
  assert.strictEqual(await page.evaluate(function () { return window.__mindmap.state().maps; }), 3, 'Os tres mapas devem persistir no localStorage');
  assert.strictEqual(await page.evaluate(function () { return window.__mindmap.state().map; }), 'Mapa mental', 'O mapa ativo deve persistir');

  const optionIds = await page.$$eval('#mapSelect option', function (options) {
    return options.map(function (option) { return option.value; });
  });
  await page.selectOption('#mapSelect', optionIds[optionIds.length - 1]);
  await page.waitForTimeout(250);
  await page.click('#btnMapDelete');
  await page.waitForTimeout(300);
  assert.strictEqual(await page.locator('#mapSelect option').count(), 2, 'Excluir deve remover o mapa do seletor');
  await page.selectOption('#mapSelect', firstId);
  await page.waitForTimeout(250);
  assert.strictEqual(await page.evaluate(function () { return window.__mindmap.state().map; }), 'Mapa mental');
}

async function testBasics(page) {
  const before = await page.evaluate(function () { return window.__mindmap.state().nodes; });
  await page.mouse.dblclick(420, 760);
  await page.waitForTimeout(200);
  await page.keyboard.type('No criado no teste');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  assert.strictEqual(await page.evaluate(function () { return window.__mindmap.state().nodes; }), before + 1, 'Duplo clique deve criar um no');
  assert.ok(await page.evaluate(function () {
    return Array.prototype.some.call(document.querySelectorAll('[data-node-id] text'), function (text) {
      return text.textContent === 'No criado no teste';
    });
  }), 'O texto digitado deve ser salvo no no');

  const created = await page.evaluate(function () {
    const texts = document.querySelectorAll('[data-node-id] text');
    for (let i = 0; i < texts.length; i += 1) {
      if (texts[i].textContent === 'No criado no teste') { return texts[i].closest('[data-node-id]').getAttribute('data-node-id'); }
    }
    return null;
  });
  const createdBox = await page.locator('[data-node-id="' + created + '"]').boundingBox();
  const rootBox = await page.locator('[data-node-id="n-raiz"]').boundingBox();
  const edgesBefore = await page.evaluate(function () { return window.__mindmap.state().edges; });
  await page.evaluate(function (args) {
    const source = document.querySelector('[data-node-id="' + args.from + '"]');
    source.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: args.ax, clientY: args.ay, button: 0, buttons: 1,
      pointerId: 1, pointerType: 'mouse', shiftKey: true
    }));
    for (let i = 1; i <= 8; i += 1) {
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: args.ax + (args.bx - args.ax) * i / 8,
        clientY: args.ay + (args.by - args.ay) * i / 8,
        buttons: 1, pointerId: 1, pointerType: 'mouse', bubbles: true
      }));
    }
    window.dispatchEvent(new PointerEvent('pointerup', {
      clientX: args.bx, clientY: args.by, button: 0, buttons: 0,
      pointerId: 1, pointerType: 'mouse', bubbles: true
    }));
  }, {
    from: created,
    ax: createdBox.x + createdBox.width / 2,
    ay: createdBox.y + createdBox.height / 2,
    bx: rootBox.x + rootBox.width / 2,
    by: rootBox.y + rootBox.height / 2
  });
  await page.waitForTimeout(250);
  assert.strictEqual(await page.evaluate(function () { return window.__mindmap.state().edges; }), edgesBefore + 1, 'Shift + arrastar deve criar conexao');

  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForTimeout(450);
  assert.ok(await page.evaluate(function () {
    return Array.prototype.some.call(document.querySelectorAll('[data-node-id] text'), function (text) {
      return text.textContent === 'No criado no teste';
    });
  }), 'O mapa deve ser restaurado ao recarregar');
}

async function testExportImport(page, dialogs) {
  const before = await page.evaluate(function () { return window.__mindmap.state(); });
  const downloadPromise = page.waitForEvent('download');
  await page.click('#btnExport');
  const download = await downloadPromise;
  const file = path.join(os.tmpdir(), 'mapa-mental-smoke-' + process.pid + '.json');
  await download.saveAs(file);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(parsed.nodes) && parsed.nodes.length > 0, 'Exportar deve baixar um JSON com nos');
  assert.strictEqual(parsed.formatVersion, 1, 'O JSON exportado deve manter o formato versionado');
  dialogs.queue.push(undefined);
  await page.setInputFiles('#importFile', file);
  await page.waitForTimeout(400);
  const after = await page.evaluate(function () { return window.__mindmap.state(); });
  assert.ok(Math.abs(after.scale - before.scale) < 0.0001, 'Importar deve respeitar a camera (escala) do arquivo');
  assert.ok(Math.abs(after.pan.x - before.pan.x) < 0.5 && Math.abs(after.pan.y - before.pan.y) < 0.5,
    'Importar deve respeitar a camera (posicao) do arquivo');
  fs.unlinkSync(file);
}

async function testBlockedStorage(browser) {
  const opened = await openPage(browser, { blockStorage: true });
  const page = opened.page;
  try {
    assert.ok((await page.textContent('#statusSave')).indexOf('sem armazenamento local') !== -1,
      'Sem localStorage o status deve avisar');
    await page.click('#btnSave');
    await page.waitForTimeout(150);
    assert.ok((await page.textContent('#toast')).indexOf('N\u00e3o foi poss\u00edvel salvar') !== -1,
      'Sem localStorage, Salvar deve orientar a exportar o JSON');
    assert.deepStrictEqual(opened.errors, [], 'Sem localStorage nao deve haver erro de console');
  } finally {
    await opened.context.close();
  }
}

(async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined
  });
  try {
    const opened = await openPage(browser);
    const page = opened.page;
    try {
      await testAutolayout(page, opened.dialogs);
      await testOutline(page);
      await testMaps(page, opened.dialogs);
      await testBasics(page);
      await testExportImport(page, opened.dialogs);
      assert.deepStrictEqual(opened.errors, [], 'Nenhum erro de console esperado');
    } finally {
      await opened.context.close();
    }
    await testBlockedStorage(browser);
    console.log('OK: fumaca v2 (autolayout, estrutura, multiplos mapas, basico, exportar/importar, sem localStorage)');
  } finally {
    await browser.close();
  }
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
