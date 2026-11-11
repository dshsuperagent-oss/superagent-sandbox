'use strict';

/*
 * Verificacao independente do programa "Taichi na Cadeira".
 *
 * FERRAMENTA DE DESENVOLVIMENTO: o site entregue continua com zero dependencias
 * (HTML/CSS/JS inline). Este script usa playwright-core apenas para o aceite.
 *
 * Uso (a partir da raiz do repositorio):
 *
 *   NODE_PATH=/tmp/pw/node_modules node taichi-na-cadeira/tests/browser-check.cjs
 *
 * Tambem aceita caminhos explicitos:
 *
 *   CHROMIUM_PATH=/caminho/para/chrome \
 *   PLAYWRIGHT_MODULE=/caminho/para/playwright-core \
 *   node taichi-na-cadeira/tests/browser-check.cjs
 *
 * Fallbacks embutidos:
 *   playwright-core  -> /tmp/pw/node_modules/playwright-core
 *   chromium         -> /root/.cache/ms-playwright/chromium-1134/chrome-linux/chrome
 *
 * Saida: [PASS]/[FAIL] por checagem, resumo no final. Exit code != 0 se
 * qualquer checagem falhar. Nenhuma checagem e marcada como PASS sem executar
 * de fato o que ela promete.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
const REPO_ROOT = path.resolve(ROOT, '..');
const INDEX = path.join(ROOT, 'index.html');
const PESQUISA = path.join(ROOT, 'pesquisa.md');
const README = path.join(ROOT, 'README.md');
const PRINTS = path.join(ROOT, 'prints');
const APP = 'file://' + INDEX;
const VIEWPORT = { width: 1280, height: 900 };

// ---------------------------------------------------------------------------
// Contrato de conteudo da issue #21.
// ptAny: variantes aceitas para o nome em pt-BR; zh: caracteres chineses;
// pinyinAny: formas aceitas (sao normalizadas sem acento/caixa) para pinyin
// ou nome em ingles do movimento.
// ---------------------------------------------------------------------------
const MOVEMENTS = [
  {
    n: 1, label: 'Abertura (Preparacao)',
    ptAny: ['abertura', 'preparacao'],
    zh: ['\u8d77\u52bf'],
    pinyinAny: ['qi shi', 'commencement']
  },
  {
    n: 2, label: 'Maos em Nuvem',
    ptAny: ['maos em nuvem'],
    zh: ['\u4e91\u624b'],
    pinyinAny: ['yun shou', 'cloud hands']
  },
  {
    n: 3, label: 'Separar a Crina do Cavalo Selvagem',
    ptAny: ['separar a crina do cavalo selvagem', 'crina do cavalo selvagem'],
    zh: ['\u91ce\u9a6c\u5206\u9b03'],
    pinyinAny: ['yema fenzong', 'parting wild horse']
  },
  {
    n: 4, label: 'Ondear as Maos como Nuvens',
    ptAny: ['ondear as maos como nuvens', 'ondear maos como nuvens'],
    zh: ['\u4e91\u624b\u53d8\u5f0f'],
    pinyinAny: ['yun shou bian', 'wave hands like clouds', 'wave hands']
  },
  {
    n: 5, label: 'Afastar e Puxar (Aparar e Recuar)',
    ptAny: ['afastar e puxar', 'aparar e recuar'],
    zh: ['\u63a4\u634b'],
    pinyinAny: ['peng', 'lu', 'ward off', 'rollback']
  },
  {
    n: 6, label: 'Escovar o Joelho (adaptado)',
    ptAny: ['escovar o joelho'],
    zh: ['\u6402\u819d\u62d7\u6b65'],
    pinyinAny: ['lou xi ao bu', 'brush knee']
  },
  {
    n: 7, label: 'Calcanhar e Ponta do Pe',
    ptAny: ['calcanhar e ponta do pe'],
    zh: ['\u63d0\u8e35'],
    pinyinAny: ['ti zhong', 'heel and toe']
  },
  {
    n: 8, label: 'Fechamento',
    ptAny: ['fechamento'],
    zh: ['\u6536\u52bf'],
    pinyinAny: ['shou shi', 'closing']
  }
];

const MENTOR_DIMENSIONS = ['equilibrio', 'conforto', 'respiracao', 'energia', 'sono'];

// ---------------------------------------------------------------------------
// Framework de checagens.
// ---------------------------------------------------------------------------
const results = [];
const observations = [];

function record(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail || '' });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log('[' + tag + '] ' + name + (detail ? ' :: ' + detail : ''));
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    let message = err && err.message ? err.message : String(err);
    if (message.length > 600) { message = message.slice(0, 600) + '...'; }
    record(name, false, message);
  }
}

function checkpoint(condition, message) {
  if (!condition) { throw new Error(message); }
}

function obs(message) {
  observations.push(message);
  console.log('[OBS ] ' + message);
}

function norm(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function raw(value) {
  return String(value == null ? '' : value);
}

function parseFontPx(value) {
  const match = /^([\d.]+)px$/.exec(String(value || '').trim());
  return match ? parseFloat(match[1]) : NaN;
}

function readPngInfo(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (err) { return null; }
  if (bytes.length < 33) { return null; }
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) { return null; }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') { return null; }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

function extractInlineScripts(html) {
  const scripts = [];
  const regex = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = typeMatch ? typeMatch[1].toLowerCase() : 'text/javascript';
    const hasSrc = /\bsrc\s*=/i.test(attrs);
    if (hasSrc) { continue; }
    // O contrato pede node --check no JS extraido; modulos tem semantica propria
    // e tipos nao-JS (json, template) nao sao JavaScript executavel.
    const isJs = type === 'text/javascript' || type === 'application/javascript' || type === 'application/ecmascript';
    if (!isJs) { continue; }
    if (!body.trim()) { continue; }
    scripts.push({ attrs: attrs.trim(), body: body });
  }
  return scripts;
}

async function settle(page) {
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(null); }); });
    });
  }).catch(function () {});
  await page.waitForTimeout(80);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
(async function main() {
  console.log('== Verificacao independente: Taichi na Cadeira ==');
  console.log('index.html: ' + INDEX);
  console.log('chromium:   ' + CHROMIUM_PATH);

  let html = null;

  // ----------------------- checagens estaticas ----------------------------
  await check('arquivo unico taichi-na-cadeira/index.html existe', async function () {
    checkpoint(fs.existsSync(INDEX), 'nao existe: ' + INDEX);
    html = fs.readFileSync(INDEX, 'utf8');
    checkpoint(html.length > 5000, 'arquivo suspeito: apenas ' + html.length + ' bytes');
    return 'bytes=' + html.length;
  });

  await check('apenas um arquivo .html na pasta do programa', async function () {
    const htmlFiles = fs.readdirSync(ROOT).filter(function (name) { return /\.html?$/i.test(name); });
    checkpoint(htmlFiles.length === 1, 'esperado exatamente 1 .html, encontrados: ' + JSON.stringify(htmlFiles));
    return htmlFiles[0];
  });

  await check('HTML sem recursos externos (script/link/img/url()/@import)', async function () {
    checkpoint(html !== null, 'index.html indisponivel (falhou antes)');
    const problems = [];
    const rules = [
      { re: /<script\b[^>]*\bsrc\s*=/gi, why: '<script src=...>' },
      { re: /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi, why: '<link href="http(s)://...">' },
      { re: /<link\b[^>]*\brel\s*=\s*["']?stylesheet/gi, why: '<link rel="stylesheet"> (CSS deve ser inline)' },
      { re: /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//gi, why: '<img src="http(s)://...">' },
      { re: /<iframe\b/gi, why: '<iframe>' },
      { re: /<object\b|<embed\b|<video\b|<audio\b/gi, why: '<object>/<embed>/<video>/<audio>' },
      { re: /<source\b[^>]*\bsrc\s*=/gi, why: '<source src=...>' },
      { re: /url\(\s*["']?\s*(?:https?:)?\/\//gi, why: 'CSS url(http(s)://...)' },
      { re: /@import\b/gi, why: '@import no CSS' },
      { re: /<image\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi, why: 'SVG <image href="http(s)://...">' },
      { re: /<use\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi, why: 'SVG <use href="http(s)://...">' }
    ];
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      if (rule.re.test(html)) { problems.push(rule.why); }
    }
    checkpoint(problems.length === 0, 'recursos externos encontrados: ' + problems.join('; '));
    const httpLinks = (html.match(/<a\b[^>]*\bhref\s*=\s*["']https?:\/\//gi) || []).length;
    return 'ok; <a href="http(s)"> permitidos=' + httpLinks + ' (nao carregam recursos)';
  });

  await check('JS inline extraido passa em node --check', async function () {
    checkpoint(html !== null, 'index.html indisponivel');
    const scripts = extractInlineScripts(html);
    if (scripts.length === 0) {
      return 'nenhum bloco <script> JavaScript inline encontrado (nada a validar)';
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taichi-jscheck-'));
    try {
      for (let i = 0; i < scripts.length; i += 1) {
        const file = path.join(tempDir, 'inline-' + (i + 1) + '.js');
        fs.writeFileSync(file, scripts[i].body);
        try {
          execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        } catch (err) {
          const stderr = err && err.stderr ? err.stderr.toString() : (err.message || '');
          throw new Error('node --check falhou no bloco #' + (i + 1) + ': ' + stderr.trim().split('\n').slice(0, 6).join(' | '));
        }
      }
      return scripts.length + ' bloco(s) JavaScript inline validado(s) por node --check';
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    }
  });

  await check('pesquisa.md existe com >=10 URLs http(s) unicas', async function () {
    checkpoint(fs.existsSync(PESQUISA), 'nao existe: ' + PESQUISA);
    const text = fs.readFileSync(PESQUISA, 'utf8');
    const urls = new Set();
    const regex = /https?:\/\/[^\s<>"'`)\]]+/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const url = match[0].replace(/[.,;:!?*]+$/g, '');
      urls.add(url);
    }
    checkpoint(urls.size >= 10, 'apenas ' + urls.size + ' URL(s) http(s) unica(s); minimo 10');
    return urls.size + ' URLs http(s) unicas';
  });

  await check('README.md presente na pasta do programa', async function () {
    checkpoint(fs.existsSync(README), 'nao existe: ' + README);
    const text = fs.readFileSync(README, 'utf8');
    checkpoint(text.trim().length > 200, 'README.md muito curto (' + text.trim().length + ' chars)');
    return 'bytes=' + Buffer.byteLength(text, 'utf8');
  });

  await check('prints/ com 2-3 PNGs reais (dimensoes lidas do IHDR)', async function () {
    checkpoint(fs.existsSync(PRINTS), 'pasta prints/ nao existe');
    const pngs = fs.readdirSync(PRINTS).filter(function (name) { return /\.png$/i.test(name); }).sort();
    checkpoint(pngs.length >= 2 && pngs.length <= 3, 'esperado 2-3 PNGs, encontrados ' + pngs.length + ': ' + JSON.stringify(pngs));
    const details = [];
    for (const name of pngs) {
      const info = readPngInfo(path.join(PRINTS, name));
      checkpoint(info, 'arquivo nao e um PNG valido: ' + name);
      checkpoint(info.width >= 800 && info.height >= 500, 'PNG pequeno demais: ' + name + ' ' + info.width + 'x' + info.height);
      checkpoint(info.bytes > 15000, 'PNG suspeito (poucos bytes): ' + name + ' ' + info.bytes + ' bytes');
      details.push(name + ' ' + info.width + 'x' + info.height);
    }
    return details.join('; ');
  });

  // ----------------------- checagens no navegador -------------------------
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'light'
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const nonFileRequests = [];

    page.on('console', function (message) {
      if (message.type() === 'error') { consoleErrors.push(message.text()); }
    });
    page.on('pageerror', function (error) {
      pageErrors.push(error && error.message ? error.message : String(error));
    });
    page.on('requestfailed', function (request) {
      failedRequests.push(request.url() + ' :: ' + (request.failure() ? request.failure().errorText : 'sem detalhe'));
    });
    page.on('request', function (request) {
      const url = request.url();
      if (/^(https?|ws|wss):/i.test(url)) { nonFileRequests.push(url); }
    });

    let pageOpened = false;
    let openError = null;
    try {
      await page.goto(APP, { waitUntil: 'load', timeout: 30000 });
      pageOpened = true;
    } catch (err) {
      openError = err && err.message ? err.message : String(err);
    }

    await check('pagina abre por file:// em Chromium headless', async function () {
      checkpoint(pageOpened, 'goto falhou: ' + openError);
      await page.waitForTimeout(400);
      const url = page.url();
      checkpoint(url.indexOf('file://') === 0, 'URL inesperada: ' + url);
      return url.replace(REPO_ROOT, '<repo>');
    });

    // Se a pagina nao abriu, as checagens de DOM falharao com mensagem clara.
    await check('zero erros de console', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      checkpoint(consoleErrors.length === 0, consoleErrors.length + ' erro(s): ' + consoleErrors.slice(0, 5).join(' | '));
      return '0 erros';
    });

    await check('zero pageerrors (excecoes JS nao tratadas)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      checkpoint(pageErrors.length === 0, pageErrors.length + ' pageerror(s): ' + pageErrors.slice(0, 5).join(' | '));
      return '0 pageerrors';
    });

    await check('zero requestfailed', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      checkpoint(failedRequests.length === 0, failedRequests.length + ' falha(s): ' + failedRequests.slice(0, 5).join(' | '));
      return '0 falhas';
    });

    await check('nenhuma requisicao http(s)/ws (site offline)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      checkpoint(nonFileRequests.length === 0, 'requisicoes externas: ' + nonFileRequests.slice(0, 5).join(' | '));
      const resources = await page.evaluate(function () {
        return performance.getEntriesByType('resource').map(function (entry) { return entry.name; });
      }).catch(function () { return []; });
      const external = resources.filter(function (url) { return /^(https?|ws|wss):/i.test(url); });
      checkpoint(external.length === 0, 'recursos externos em performance: ' + external.slice(0, 5).join(' | '));
      return 'requisicoes externas=0, recursos=' + resources.length;
    });

    await check('html lang="pt-BR"', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const lang = await page.evaluate(function () { return document.documentElement.getAttribute('lang'); });
      checkpoint(/^pt-BR$/i.test(String(lang || '')), 'lang encontrado: ' + JSON.stringify(lang));
      return 'lang="' + lang + '"';
    });

    await check('titulo da pagina presente e em pt-BR (taichi/cadeira)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const title = await page.evaluate(function () { return document.title; });
      checkpoint(title && title.trim().length >= 8, 'titulo vazio/curto: ' + JSON.stringify(title));
      checkpoint(/taichi|tai chi|cadeira/i.test(title), 'titulo nao menciona taichi/cadeira: ' + JSON.stringify(title));
      return JSON.stringify(title);
    });

    await check('exatamente 9 elementos <svg> no DOM', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const count = await page.evaluate(function () { return document.querySelectorAll('svg').length; });
      checkpoint(count === 9, 'encontrados ' + count + ' <svg>; esperado exatamente 9');
      return '9 svg';
    });

    await check('9 SVGs visiveis (bounding box real na pagina)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const boxes = await page.evaluate(function () {
        return Array.prototype.map.call(document.querySelectorAll('svg'), function (svg, index) {
          const rect = svg.getBoundingClientRect();
          const style = window.getComputedStyle(svg);
          return {
            index: index + 1,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity
          };
        });
      });
      const bad = boxes.filter(function (box) {
        return box.width < 40 || box.height < 30 || box.display === 'none' || box.visibility === 'hidden' || parseFloat(box.opacity) === 0;
      });
      checkpoint(bad.length === 0, 'SVG(s) invisiveis/pequenos demais: ' + JSON.stringify(bad));
      const minW = Math.min.apply(null, boxes.map(function (b) { return b.width; }));
      const minH = Math.min.apply(null, boxes.map(function (b) { return b.height; }));
      return boxes.length + ' visiveis; menor bbox=' + minW + 'x' + minH + 'px';
    });

    await check('9 SVGs com role="img" e nome acessivel (aria-label/<title>)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const report = await page.evaluate(function () {
        return Array.prototype.map.call(document.querySelectorAll('svg'), function (svg, index) {
          const role = svg.getAttribute('role');
          let name = svg.getAttribute('aria-label') || '';
          if (!name) {
            const labelledBy = svg.getAttribute('aria-labelledby');
            if (labelledBy) {
              name = labelledBy.split(/\s+/).map(function (id) {
                const el = document.getElementById(id);
                return el ? (el.textContent || '').trim() : '';
              }).join(' ').trim();
            }
          }
          if (!name) {
            const title = svg.querySelector('title');
            name = title ? (title.textContent || '').trim() : '';
          }
          return { index: index + 1, role: role, name: name };
        });
      });
      const bad = report.filter(function (item) {
        return String(item.role || '').toLowerCase() !== 'img' || !item.name || item.name.length < 3;
      });
      checkpoint(bad.length === 0, 'SVG(s) sem role="img"/nome acessivel: ' + JSON.stringify(bad.slice(0, 4)));
      return report.map(function (item) { return item.index + ':' + item.name.slice(0, 40); }).join(' | ');
    });

    // ------------------- cartoes de movimento ----------------------------
    let cardData = { strategy: 'none', cards: [] };
    try {
      cardData = await page.evaluate(function (expected) {
      function norm(value) {
        return String(value == null ? '' : value)
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase().replace(/[\u2018\u2019\u201c\u201d]/g, '"')
          .replace(/\s+/g, ' ').trim();
      }
      function text(el) { return norm(el.innerText || el.textContent || ''); }
      function rawText(el) { return String(el.innerText || el.textContent || ''); }
      function cardInfo(el, i, strategy) {
        const headings = Array.prototype.slice.call(el.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(function (h) {
          return text(h);
        }).filter(Boolean);
        const lists = Array.prototype.slice.call(el.querySelectorAll('ol,ul')).map(function (list) {
          return list.children.length;
        });
        return {
          index: i,
          dataMovement: el.getAttribute('data-movement'),
          head: headings.length ? headings[0] : text(el).slice(0, 120),
          text: text(el),
          raw: rawText(el),
          maxList: lists.length ? Math.max.apply(null, lists) : 0,
          liCount: el.querySelectorAll('ol li, ul li').length,
          stepsSection: (function () {
            // Conta passos na regiao rotulada "como fazer", se existir.
            const nodes = Array.prototype.slice.call(el.querySelectorAll('h1,h2,h3,h4,h5,h6,p,strong,dt,summary,span,div'));
            for (const node of nodes) {
              const t = text(node);
              if (t === 'como fazer' || /^como fazer\b/.test(t)) {
                const region = node.closest('div,li,section,article') || node.parentElement;
                if (region && region !== el) {
                  const count = region.querySelectorAll('ol li, ul li').length;
                  if (count >= 3) { return count; }
                }
              }
            }
            return 0;
          })()
        };
      }

      // 1) contrato combinado: [data-movement], 8 cartoes.
      let cards = Array.prototype.slice.call(document.querySelectorAll('[data-movement]'));
      let strategy = 'data-movement';
      if (cards.length !== 8) { cards = null; }

      // 2) fallback textual: achar o titulo de cada movimento e subir para o
      // container que tenha lista de passos.
      if (!cards) {
        strategy = 'heading-climb';
        const headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6,summary,dt,strong,b'));
        const found = [];
        for (const exp of expected) {
          let chosen = null;
          for (const heading of headings) {
            const t = text(heading);
            const r = rawText(heading);
            const nameHit = exp.ptAny.some(function (phrase) { return t.indexOf(phrase) !== -1; });
            const zhHit = exp.zh.some(function (han) { return r.indexOf(han) !== -1; });
            if (!nameHit && !zhHit) { continue; }
            let cur = heading;
            for (let depth = 0; depth < 9 && cur; depth += 1) {
              const ct = text(cur);
              const lis = cur.querySelectorAll('ol li, ul li').length;
              if ((ct.indexOf('como fazer') !== -1 && lis >= 2) || (lis >= 3 && ct.length <= 2600)) {
                chosen = cur;
                break;
              }
              cur = cur.parentElement;
            }
            if (chosen) { break; }
          }
          found.push(chosen);
        }
        if (found.every(Boolean) && new Set(found).size === 8) { cards = found; } else { cards = null; }
      }

      if (!cards) { return { strategy: 'none', cards: [] }; }
      return { strategy: strategy, cards: cards.map(function (el, i) { return cardInfo(el, i, strategy); }) };
    }, MOVEMENTS.map(function (m) { return { n: m.n, ptAny: m.ptAny, zh: m.zh }; }));
    } catch (err) {
      obs('falha ao extrair cartoes do DOM: ' + (err && err.message ? err.message : String(err)));
      cardData = { strategy: 'none', cards: [] };
    }

    if (cardData.strategy === 'heading-climb') {
      obs('seletor [data-movement] ausente/incorreto; cartoes localizados por titulo+container (fallback textual).');
    } else if (cardData.strategy === 'none') {
      obs('nao foi possivel localizar os 8 cartoes de movimento por [data-movement] nem por fallback textual.');
    }

    await check('8 cartoes de movimento reconhecidos', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      checkpoint(cardData.strategy !== 'none', 'nenhum conjunto de 8 cartoes localizado (estrategia: ' + cardData.strategy + ')');
      checkpoint(cardData.cards.length === 8, 'encontrados ' + cardData.cards.length + ' cartoes; esperado 8');
      return 'estrategia=' + cardData.strategy + '; 8 cartoes';
    });

    // Associa cada movimento esperado a um cartao distinto (pelo titulo; se
    // nao houver titulo reconhecivel, cai para o texto completo).
    const assigned = new Map();
    const assignmentProblems = [];
    for (const exp of MOVEMENTS) {
      let index = -1;
      for (let i = 0; i < cardData.cards.length; i += 1) {
        if (assigned.has(i)) { continue; }
        const card = cardData.cards[i];
        const headHit = exp.ptAny.some(function (phrase) { return card.head.indexOf(phrase) !== -1; });
        const fullHit = exp.ptAny.some(function (phrase) { return card.text.indexOf(phrase) !== -1; });
        if (headHit || fullHit) { index = i; break; }
      }
      if (index === -1) { assignmentProblems.push(exp.label); }
      else { assigned.set(index, exp); }
    }

    for (const exp of MOVEMENTS) {
      const cardIndex = Array.from(assigned.entries()).filter(function (entry) { return entry[1] === exp; }).map(function (entry) { return entry[0]; })[0];
      await check('cartao ' + exp.n + '/8 "' + exp.label + '": conteudo completo', async function () {
        checkpoint(pageOpened, 'pagina nao abriu');
        checkpoint(cardData.cards.length === 8, 'cartoes nao localizados (' + cardData.cards.length + ')');
        checkpoint(cardIndex !== undefined, 'cartao nao associado ao nome esperado ' + JSON.stringify(exp.ptAny));
        const card = cardData.cards[cardIndex];
        const missing = [];
        const nameHit = exp.ptAny.some(function (phrase) { return card.text.indexOf(phrase) !== -1; });
        if (!nameHit) { missing.push('nome pt-BR (' + exp.ptAny.join(' ou ') + ')'); }
        const zhHit = exp.zh.every(function (han) { return card.raw.indexOf(han) !== -1; });
        if (!zhHit) { missing.push('nome chines ' + exp.zh.join('')); }
        const pinyinHit = exp.pinyinAny.some(function (phrase) { return card.text.indexOf(norm(phrase)) !== -1; });
        if (!pinyinHit) { missing.push('pinyin/ingles (' + exp.pinyinAny.join(' | ') + ')'); }
        if (card.text.indexOf('como fazer') === -1) { missing.push('rotulo "como fazer"'); }
        const steps = Math.max(card.stepsSection || 0, card.maxList || 0);
        if (steps < 3) { missing.push('>=3 passos (encontrados ' + steps + ')'); }
        if (card.text.indexOf('respira') === -1) { missing.push('respiracao'); }
        const repsHit = card.text.indexOf('repeti') !== -1 && /[0-9]/.test(card.text);
        if (!repsHit) { missing.push('repeticoes com numero'); }
        const safetyHit = card.text.indexOf('seguranc') !== -1 && /dica|atencao|cuidado|importante/.test(card.text);
        if (!safetyHit) { missing.push('dica de seguranca'); }
        checkpoint(missing.length === 0, 'faltando: ' + missing.join('; '));
        return 'passos=' + steps + ', chinês+pinyin ok, respiracao/reps/seguranca ok';
      });
    }

    // ------------------------- programa ----------------------------------
    let programData = { tables: [], tableText: '', bodyText: '', sessionEls: [], anchors: { programa: false, mentor: false, seguranca: false, escritorio: false, imprimir: false }, mentorText: '', safetyText: '', officeText: '', printText: '', styleText: '', headings: [] };
    try {
      programData = await page.evaluate(function () {
      function norm(value) {
        return String(value == null ? '' : value)
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase().replace(/\s+/g, ' ').trim();
      }
      const tables = Array.prototype.slice.call(document.querySelectorAll('table')).map(function (table) {
        return table.innerText || table.textContent || '';
      });
      const tableText = norm(tables.join('\n'));
      const bodyText = norm(document.body.innerText || document.body.textContent || '');
      const sessionEls = Array.prototype.slice.call(document.querySelectorAll('[data-session]')).map(function (el) {
        return { raw: el.getAttribute('data-session'), text: (el.innerText || el.textContent || '').trim() };
      });
      const anchors = {
        programa: !!document.querySelector('#programa'),
        mentor: !!document.querySelector('#mentor'),
        seguranca: !!document.querySelector('#seguranca'),
        escritorio: !!document.querySelector('#escritorio'),
        imprimir: !!document.querySelector('#imprimir')
      };
      function sectionText(selector, headingRegex) {
        let el = selector ? document.querySelector(selector) : null;
        if (!el) {
          const headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
          const heading = headings.filter(function (h) { return headingRegex.test(norm(h.textContent)); })[0];
          el = heading ? (heading.closest('section,article') || heading.parentElement) : null;
        }
        return el ? (el.innerText || el.textContent || '') : '';
      }
      return {
        tables: tables,
        tableText: tableText,
        bodyText: bodyText,
        sessionEls: sessionEls,
        anchors: anchors,
        mentorText: sectionText('#mentor', /mentor/),
        safetyText: sectionText('#seguranca', /seguranc/),
        officeText: sectionText('#escritorio', /escritorio/),
        printText: sectionText('#imprimir', /imprim/),
        styleText: Array.prototype.map.call(document.querySelectorAll('style'), function (s) { return s.textContent || ''; }).join('\n'),
        headings: Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(function (h) { return (h.textContent || '').trim(); })
      };
    });
    } catch (err) {
      obs('falha ao extrair programa/secoes do DOM: ' + (err && err.message ? err.message : String(err)));
    }

    for (const key of Object.keys(programData.anchors)) {
      if (!programData.anchors[key]) {
        obs('seletor #' + key + ' ausente; validacao feita por texto/conteudo (nao e falha por si so).');
      }
    }

    await check('programa: tabela com 8 semanas (Semana 1..8)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      checkpoint(programData.tables.length >= 1, 'nenhuma <table> encontrada no programa');
      const tableText = programData.tableText;
      const missing = [];
      for (let week = 1; week <= 8; week += 1) {
        const re = new RegExp('semana[s]?\\s*' + week + '\\b');
        if (!re.test(tableText)) { missing.push('semana ' + week); }
      }
      checkpoint(missing.length === 0, 'semanas ausentes nas tabelas: ' + missing.join(', '));
      return 'tabelas=' + programData.tables.length + '; semanas 1..8 presentes';
    });

    await check('programa: 24 sessoes reconheciveis (1..24)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const found = new Set();
      const providers = [];
      for (const item of programData.sessionEls) {
        const number = parseInt(String(item.raw || '').replace(/\D+/g, ''), 10);
        if (!isNaN(number) && number >= 1 && number <= 24) { found.add(number); }
        else {
          const match = /(?:sessao|sessão)\s*#?(\d{1,2})/i.exec(norm(item.text));
          if (match) { found.add(parseInt(match[1], 10)); }
        }
      }
      if (programData.sessionEls.length) { providers.push('[data-session]=' + programData.sessionEls.length); }
      if (found.size < 24) {
        const scan = programData.tableText + '\n' + programData.bodyText;
        const regex = /sessao\s*(?:n[.oº°]?\s*)?(\d{1,2})\b/g;
        let match;
        while ((match = regex.exec(scan)) !== null) {
          const number = parseInt(match[1], 10);
          if (number >= 1 && number <= 24) { found.add(number); }
        }
        providers.push('fallback textual');
      }
      const missing = [];
      for (let session = 1; session <= 24; session += 1) {
        if (!found.has(session)) { missing.push(String(session)); }
      }
      checkpoint(missing.length === 0, 'sessoes nao reconhecidas: ' + missing.join(', ') + ' (fonte: ' + providers.join('+') + ')');
      return '24 sessoes identificadas (' + providers.join('+') + ')';
    });

    // -------------------------- mentor ------------------------------------
    await check('mentor: guia presente com escala 1-5 e 5 dimensoes', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const mentorText = norm(programData.mentorText);
      checkpoint(mentorText.length > 200, 'secao do mentor ausente ou curta (' + mentorText.length + ' chars)');
      const scaleHit = /escala\s*(?:de\s*)?1\s*(?:a|–|-|—)\s*5|1\s*(?:a|–|-|—)\s*5/.test(mentorText);
      checkpoint(scaleHit, 'escala 1-5 nao encontrada na secao do mentor');
      const missing = MENTOR_DIMENSIONS.filter(function (dimension) { return mentorText.indexOf(dimension) === -1; });
      checkpoint(missing.length === 0, 'dimensoes ausentes: ' + missing.join(', '));
      return 'escala 1-5 + ' + MENTOR_DIMENSIONS.join(', ');
    });

    await check('mentor: check-in 2x por semana', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const mentorText = norm(programData.mentorText);
      checkpoint(mentorText.length > 200, 'secao do mentor ausente');
      const hit = /2\s*(?:x|vezes)\s*(?:por|na|\/)\s*semana|duas vezes por semana/.test(mentorText);
      checkpoint(hit, 'cadencia de check-in 2x/semana nao encontrada');
      return '2x/semana';
    });

    await check('mentor: criterios de progressao', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const mentorText = norm(programData.mentorText);
      const hit = /criterios? de progressao|progride|progredir|progressao/.test(mentorText);
      checkpoint(hit, 'criterios de progressao nao encontrados na secao do mentor');
      return 'criterios de progressao presentes';
    });

    await check('mentor: criterios de regressao', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const mentorText = norm(programData.mentorText);
      const hit = /criterios? de regressao|regride|regredir|regressao/.test(mentorText);
      checkpoint(hit, 'criterios de regressao nao encontrados na secao do mentor');
      return 'criterios de regressao presentes';
    });

    // ------------------------- seguranca ----------------------------------
    await check('seguranca: aviso de que nao substitui avaliacao medica/fisioterapeutica', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const safetyText = norm(programData.safetyText);
      checkpoint(safetyText.length > 100, 'secao de seguranca ausente ou curta (' + safetyText.length + ' chars)');
      const hit = /nao substitui/.test(safetyText) && /medic/.test(safetyText) && /fisioterap/.test(safetyText);
      checkpoint(hit, 'aviso "nao substitui avaliacao medica/fisioterapeutica" nao encontrado (texto=' + JSON.stringify(safetyText.slice(0, 200)) + ')');
      return 'aviso medico presente';
    });

    await check('seguranca: parar se tontura, dor no peito ou falta de ar', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const safetyText = norm(programData.safetyText);
      const missing = ['tontura', 'dor no peito', 'falta de ar'].filter(function (term) { return safetyText.indexOf(term) === -1; });
      checkpoint(missing.length === 0, 'sinais de parada ausentes: ' + missing.join(', '));
      return 'tontura + dor no peito + falta de ar';
    });

    await check('seguranca: cadeira firme, sem rodas e pes no chao', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const safetyText = norm(programData.safetyText);
      const missing = [];
      if (safetyText.indexOf('sem rodas') === -1) { missing.push('sem rodas'); }
      if (safetyText.indexOf('pes no chao') === -1) { missing.push('pes no chao'); }
      checkpoint(missing.length === 0, 'cuidados de cadeira ausentes: ' + missing.join(', '));
      return 'sem rodas + pes no chao';
    });

    // -------------------------- escritorio --------------------------------
    await check('secao de adaptacao para escritorio com conteudo', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const officeText = norm(programData.officeText);
      checkpoint(officeText.length > 150, 'secao de escritorio ausente ou curta (' + officeText.length + ' chars)');
      const hit = /escritorio/.test(officeText) && /pausa|cadeira|trabalho/.test(officeText);
      checkpoint(hit, 'conteudo de escritorio/pausas nao reconhecido');
      return 'secao escritorio (' + officeText.length + ' chars)';
    });

    // --------------------------- impressao --------------------------------
    await check('modo imprimir/PDF: texto+controle e @media print', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const bodyText = programData.bodyText;
      const printText = norm(programData.printText);
      const hasText = /imprimir|impressao|pdf/.test(bodyText) || /imprimir|impressao|pdf/.test(printText);
      const hasMediaPrint = /@media\s+(?:print|all\s+and\s+\(print\))/i.test(programData.styleText) || /@media\s+print/i.test(programData.styleText);
      const problems = [];
      if (!hasText) { problems.push('nenhum texto/controle de "imprimir/PDF"'); }
      if (!hasMediaPrint) { problems.push('nenhum @media print no CSS inline'); }
      checkpoint(problems.length === 0, problems.join('; '));
      return 'texto de impressao + @media print';
    });

    // -------------------------- acessibilidade ----------------------------
    await check('corpo com font-size computado >= 16px', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const sizes = await page.evaluate(function () {
        return {
          body: window.getComputedStyle(document.body).fontSize,
          html: window.getComputedStyle(document.documentElement).fontSize
        };
      });
      const bodyPx = parseFontPx(sizes.body);
      const htmlPx = parseFontPx(sizes.html);
      checkpoint(!isNaN(bodyPx) && bodyPx >= 16, 'body font-size=' + JSON.stringify(sizes.body) + ' (<16px)');
      checkpoint(!isNaN(htmlPx) && htmlPx >= 16, 'html font-size=' + JSON.stringify(sizes.html) + ' (<16px)');
      return 'body=' + sizes.body + ', html=' + sizes.html;
    });

    await check('links com nome acessivel (aria-label/texto)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const report = await page.evaluate(function () {
        return Array.prototype.map.call(document.querySelectorAll('a'), function (a, index) {
          const name = (a.getAttribute('aria-label') || a.textContent || a.getAttribute('title') || '').trim();
          return { index: index + 1, name: name, href: a.getAttribute('href') || '' };
        });
      });
      const bad = report.filter(function (item) { return item.name.length === 0; });
      checkpoint(bad.length === 0, 'link(s) sem nome acessivel: ' + JSON.stringify(bad.slice(0, 5)));
      const javascriptLinks = report.filter(function (item) { return /^javascript:/i.test(item.href); });
      checkpoint(javascriptLinks.length === 0, 'link(s) javascript: ' + JSON.stringify(javascriptLinks.slice(0, 5)));
      return report.length + ' link(s), todos com nome acessivel';
    });

    await check('layout 1280px sem overflow horizontal', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const overflow = await page.evaluate(function () {
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          innerWidth: window.innerWidth,
          bodyScrollWidth: document.body.scrollWidth
        };
      });
      const limit = Math.max(overflow.clientWidth, overflow.innerWidth) + 2;
      checkpoint(overflow.scrollWidth <= limit, 'overflow horizontal: scrollWidth=' + overflow.scrollWidth + ' > ' + limit + ' (body=' + overflow.bodyScrollWidth + ')');
      return 'scrollWidth=' + overflow.scrollWidth + ' cliente=' + overflow.clientWidth;
    });

    // --------------------------- secoes/titulos ---------------------------
    await check('secoes principais presentes como titulos (movimentos, programa, mentor, seguranca)', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const headings = programData.headings.map(norm);
      const missing = [];
      if (!headings.some(function (h) { return h.indexOf('movimento') !== -1; })) { missing.push('movimentos'); }
      if (!headings.some(function (h) { return h.indexOf('programa') !== -1 || h.indexOf('semana') !== -1; })) { missing.push('programa'); }
      if (!headings.some(function (h) { return h.indexOf('mentor') !== -1; })) { missing.push('mentor'); }
      if (!headings.some(function (h) { return h.indexOf('seguranc') !== -1; })) { missing.push('seguranca'); }
      checkpoint(missing.length === 0, 'titulos ausentes: ' + missing.join(', '));
      return '4 titulos principais presentes';
    });

    // Relatorio de navegacao: 0 erros apos scroll pela pagina (serializa tudo
    // que a pagina renderiza, inclusive conteudo lazy/animado).
    await check('pagina percorrida de ponta a ponta sem novos erros JS', async function () {
      checkpoint(pageOpened, 'pagina nao abriu');
      const errorsBefore = consoleErrors.length + pageErrors.length;
      const height = await page.evaluate(function () { return document.documentElement.scrollHeight; });
      const steps = Math.min(12, Math.max(2, Math.ceil(height / VIEWPORT.height)));
      for (let step = 0; step <= steps; step += 1) {
        await page.evaluate(function (y) { window.scrollTo(0, y); }, Math.round((height - VIEWPORT.height) * step / steps));
        await page.waitForTimeout(40);
      }
      await page.evaluate(function () { window.scrollTo(0, 0); });
      const errorsAfter = consoleErrors.length + pageErrors.length;
      checkpoint(errorsAfter === errorsBefore, 'novos erros durante o scroll: console=' + consoleErrors.length + ', pageerror=' + pageErrors.length);
      return 'scrollHeight=' + height + 'px, passos=' + (steps + 1) + ', 0 novos erros';
    });

    await context.close();
  } finally {
    await browser.close();
  }

  // ------------------------------ resumo ----------------------------------
  const passed = results.filter(function (item) { return item.ok; }).length;
  const failed = results.filter(function (item) { return !item.ok; });
  console.log('');
  console.log('== RESUMO: ' + passed + ' PASS / ' + failed.length + ' FAIL (de ' + results.length + ' checagens) ==');
  if (observations.length) {
    console.log('Observacoes (' + observations.length + '):');
    observations.forEach(function (item) { console.log(' - ' + item); });
  }
  if (failed.length) {
    console.log('Falhas:');
    failed.forEach(function (item) { console.log(' - ' + item.name + ' :: ' + item.detail); });
    process.exit(1);
  }
  process.exit(0);
})().catch(function (error) {
  console.error('ERRO FATAL no harness:');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
