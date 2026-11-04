'use strict';

/*
 * Medicao antes/depois das otimizacoes de interacao.
 *
 * Uso:
 *   node tests/measure.cjs [--baseline caminho/para/index-v1.html]
 *
 * O baseline e o index.html da v1. Gere-o a partir do historico, por exemplo:
 *   git show 68c3560:index.html > /tmp/index-v1.html
 *
 * Requer Playwright (dependencia apenas de desenvolvimento). O editor
 * continua sem dependencias e sem build step.
 */

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

function buildData() {
  const nodes = [{ id: 'n-0', text: 'Raiz do mapa de medi\u00e7\u00e3o', x: 0, y: 0 }];
  const edges = [];
  let next = 1;
  const branches = 5;
  const siblingGap = 90;

  function branch(parent, depth, x, y0, count) {
    let y = y0;
    const kids = depth === 0 ? count : 3;
    for (let i = 0; i < kids; i += 1) {
      if (next > 150) { return; }
      const id = 'n-' + next;
      next += 1;
      nodes.push({ id: id, text: 'N\u00f3 ' + id + ' do mapa de medi\u00e7\u00e3o', x: x, y: y });
      edges.push({ id: 'e-' + edges.length, from: parent, to: id });
      if (depth < 3) { branch(id, depth + 1, x + 260, y - (kids - 1) * siblingGap / 2, kids); }
      y += siblingGap;
    }
  }

  let y = -(branches - 1) * siblingGap / 2;
  for (let i = 0; i < branches && next <= 150; i += 1) {
    const id = 'n-' + next;
    next += 1;
    nodes.push({ id: id, text: 'Ramo ' + i + ' com t\u00edtulo leg\u00edvel', x: 260, y: y });
    edges.push({ id: 'e-' + edges.length, from: 'n-0', to: id });
    branch(id, 1, 520, y - siblingGap, 3);
    y += siblingGap;
  }

  const nodeIds = new Set(nodes.map(function (node) { return node.id; }));
  return {
    nodes: nodes.slice(0, 150),
    edges: edges.filter(function (edge) { return nodeIds.has(edge.from) && nodeIds.has(edge.to); })
  };
}

function snapshotSizes(data) {
  const v1 = JSON.stringify({
    nodes: data.nodes.map(function (node) { return { id: node.id, text: node.text, x: node.x, y: node.y }; }),
    edges: data.edges.map(function (edge) { return { id: edge.id, from: edge.from, to: edge.to }; })
  });
  const v2 = JSON.stringify({
    n: data.nodes.map(function (node) { return [node.id, node.text, node.x, node.y]; }),
    e: data.edges.map(function (edge) { return [edge.id, edge.from, edge.to]; })
  });
  return {
    v1EntryBytes: Buffer.byteLength(v1),
    v2EntryBytes: Buffer.byteLength(v2),
    v1MaxBytes: Buffer.byteLength(v1) * 100,
    v2MaxBytes: Buffer.byteLength(v2) * 50
  };
}

const data = buildData();
const v1Store = JSON.stringify({
  formatVersion: 1,
  app: 'editor-de-mapas-mentais',
  viewport: { x: 720, y: 450, scale: 1 },
  nodes: data.nodes,
  edges: data.edges
});
const v2Store = JSON.stringify({
  formatVersion: 2,
  app: 'editor-de-mapas-mentais',
  activeId: 'm-measure',
  maps: [{
    id: 'm-measure',
    name: 'Mapa de medi\u00e7\u00e3o',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    viewport: { x: 720, y: 450, scale: 1 },
    nodes: data.nodes,
    edges: data.edges
  }]
});

async function measure(file, version) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', function (error) { errors.push(error.message); });
  page.on('console', function (message) {
    if (message.type() === 'error') { errors.push(message.text()); }
  });
  const key = version === 'v1' ? 'mindmap-editor:v1' : 'mindmap-editor:v2';
  const value = version === 'v1' ? v1Store : v2Store;
  await page.addInitScript(function (payload) {
    try { localStorage.setItem(payload.key, payload.value); } catch (err) { /* file:// pode negar */ }
  }, { key: key, value: value });
  await page.goto(file.indexOf('file://') === 0 ? file : 'file://' + path.resolve(file));
  await page.waitForTimeout(450);

  const box = await page.locator('[data-node-id="n-0"]').boundingBox();
  const result = await page.evaluate(async function (args) {
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function (storageKey, storageValue) {
      writes += 1;
      return originalSetItem.call(this, storageKey, storageValue);
    };

    const originalRect = Element.prototype.getBoundingClientRect;
    let layoutReads = 0;
    Element.prototype.getBoundingClientRect = function () {
      layoutReads += 1;
      return originalRect.call(this);
    };

    let mutations = 0;
    const observer = new MutationObserver(function (records) { mutations += records.length; });
    observer.observe(document.getElementById('nodeLayer'), {
      childList: true, subtree: true, attributes: true, characterData: true
    });
    observer.observe(document.getElementById('edgeLayer'), {
      childList: true, subtree: true, attributes: true, characterData: true
    });

    if (window.__mindmap) { window.__mindmap.resetMetrics(); }
    const target = document.querySelector('[data-node-id="n-0"]');
    const start = performance.now();
    target.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: args.x, clientY: args.y, button: 0, buttons: 1,
      pointerId: 1, pointerType: 'mouse'
    }));
    const dispatchStart = performance.now();
    for (let i = 1; i <= 60; i += 1) {
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: args.x + i, clientY: args.y + i * 0.5, button: 0, buttons: 1,
        pointerId: 1, pointerType: 'mouse', bubbles: true
      }));
    }
    const dispatchMs = performance.now() - dispatchStart;
    await new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
    const totalMs = performance.now() - start;
    const during = { mutations: mutations, layoutReads: layoutReads, writes: writes };
    const metrics = window.__mindmap ? JSON.parse(JSON.stringify(window.__mindmap.metrics)) : null;

    window.dispatchEvent(new PointerEvent('pointerup', {
      clientX: args.x + 60, clientY: args.y + 30, button: 0, buttons: 0,
      pointerId: 1, pointerType: 'mouse', bubbles: true
    }));
    await new Promise(function (resolve) { setTimeout(resolve, 900); });
    const writesAfterGesture = writes;

    document.getElementById('btnSave').click();
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    const writesAfterFirstSave = writes;
    document.getElementById('btnSave').click();
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    const writesAfterSecondSave = writes;

    let history = null;
    if (window.__mindmap) {
      for (let i = 0; i < 70; i += 1) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      }
      await new Promise(function (resolve) { setTimeout(resolve, 700); });
      history = window.__mindmap.history();
    }

    return {
      nodes: document.querySelectorAll('[data-node-id]').length,
      edges: document.querySelectorAll('[data-edge-id]').length,
      during: during,
      dispatchMs: dispatchMs,
      totalMs: totalMs,
      metrics: metrics,
      writesAfterGesture: writesAfterGesture,
      writesAfterFirstSave: writesAfterFirstSave,
      writesAfterSecondSave: writesAfterSecondSave,
      explicitWrites: writesAfterSecondSave - writesAfterGesture,
      history: history,
      errors: []
    };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

  result.errors = errors;
  result.version = version;
  await browser.close();
  return result;
}

function table(rows, sizes) {
  const v1 = rows.v1;
  const v2 = rows.v2;
  const lines = [];
  lines.push('| Metrica | v1 (baseline) | v2 |');
  lines.push('| --- | ---: | ---: |');
  if (v1 && v2) {
    lines.push('| Nos / conexoes no mapa de teste | ' + v1.nodes + ' / ' + v1.edges + ' | ' + v2.nodes + ' / ' + v2.edges + ' |');
    lines.push('| Mutacoes DOM durante 60 pointermove | ' + v1.during.mutations + ' | ' + v2.during.mutations + ' |');
    lines.push('| Leituras de layout (getBoundingClientRect) | ' + v1.during.layoutReads + ' | ' + v2.during.layoutReads + ' |');
    lines.push('| Tempo do gesto (60 eventos + frame) | ' + v1.totalMs.toFixed(1) + ' ms | ' + v2.totalMs.toFixed(1) + ' ms |');
    lines.push('| Escritas em localStorage durante o gesto | ' + v1.during.writes + ' | ' + v2.during.writes + ' |');
    lines.push('| Escritas apos 2 cliques em Salvar sem mudancas | ' + v1.explicitWrites + ' | ' + v2.explicitWrites + ' |');
    lines.push('| Reconstrucao das arestas no arraste | todas as arestas a cada pointermove | apenas as incidentes (' + (v2.metrics ? v2.metrics.edgeUpdates : '?') + ' atualizacoes) |');
    lines.push('| renderAll durante o arraste | n/a (nao exposto) | ' + (v2.metrics ? v2.metrics.fullRenders : '?') + ' |');
  } else {
    lines.push('| (rode com --baseline para comparar v1 e v2) | - | - |');
  }
  lines.push('');
  lines.push('Snapshot de historico (mesmo mapa de 150 nos): v1 ' + sizes.v1EntryBytes + ' B/entrada, limite 100 = ' + sizes.v1MaxBytes + ' B; v2 ' + sizes.v2EntryBytes + ' B/entrada, limite 50 = ' + sizes.v2MaxBytes + ' B.');
  return lines.join('\n');
}

(async function main() {
  const baselineIndex = process.argv.indexOf('--baseline');
  const baseline = baselineIndex !== -1 ? process.argv[baselineIndex + 1] : null;
  const rows = {};
  if (baseline) { rows.v1 = await measure(baseline, 'v1'); }
  rows.v2 = await measure(APP, 'v2');
  const sizes = snapshotSizes(data);
  console.log(JSON.stringify({ rows: rows, snapshotSizes: sizes }, null, 2));
  console.log('');
  console.log(table(rows, sizes));
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
