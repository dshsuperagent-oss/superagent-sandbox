#!/usr/bin/env node
// static-check.mjs — checagens estáticas do Torre de Ferro (exit 0/1, PASS por item).
// Roda em games/torre-de-ferro/: `node tests/static-check.mjs`
// Só Node stdlib. NÃO executa o navegador (isso é browser-check.mjs); sobe o
// serve.mjs real numa porta livre para validar HTTP 200/404, MIME e no-store.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const GAME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(GAME_DIR, '..', '..');
const GAME_PREFIX = 'games/torre-de-ferro/';

const results = [];
let currentAsync = null;

function pass(name, detail = '') {
  results.push({ ok: true, name });
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`PASS ${name}${suffix}`);
}

function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Executa uma checagem síncrona; `fn` retorna detalhe opcional ou lança Error. */
function check(name, fn) {
  try {
    const detail = fn();
    pass(name, typeof detail === 'string' ? detail : '');
    return true;
  } catch (err) {
    fail(name, err && err.message ? err.message : String(err));
    return false;
  }
}

/** Executa uma checagem assíncrona. */
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : '');
    return true;
  } catch (err) {
    fail(name, err && err.message ? err.message : String(err));
    return false;
  }
}

function must(cond, message) {
  if (!cond) throw new Error(message);
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function walkFiles(dir, { skipDirs = ['.git', 'node_modules', 'docs'] } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function relToGame(path) {
  return relative(GAME_DIR, path).split(sep).join('/');
}

function findNodeModules(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') {
        found.push(join(cur, entry.name));
        continue;
      }
      if (entry.name === '.git') continue;
      stack.push(join(cur, entry.name));
    }
  }
  return found;
}

// ---------------------------------------------------------------- checagens

const REQUIRED_FILES = [
  'index.html',
  'package.json',
  'serve.mjs',
  'README.md',
  'styles.css',
  'src/main.js',
  'src/sim/rng.js',
  'src/sim/data.js',
  'src/sim/maps.js',
  'src/sim/waves.js',
  'src/sim/combat.js',
  'src/sim/troops.js',
  'src/sim/engine.js',
  'src/render/scene.js',
  'src/render/meshes.js',
  'src/render/fx.js',
  'src/render/hud.js',
  'src/render/audio.js',
  'src/vendor/three/three.module.js',
  'src/vendor/three/LICENSE',
  'tests/simulate.mjs',
  'tests/static-check.mjs',
  'tests/browser-check.mjs',
];

const TD_API = [
  'start', 'state', 'eventLog', 'spawnWave', 'spawnEnemy', 'giveMoney', 'setLives',
  'setSpeed', 'pause', 'resume', 'fastForward', 'buildTower', 'upgradeTower',
  'sellTower', 'deployTroop', 'audioLog', 'fxLog', 'perf', 'win', 'lose',
];

function checkRequiredFiles() {
  const missing = REQUIRED_FILES.filter((rel) => !existsSync(join(GAME_DIR, rel)));
  must(missing.length === 0, `faltando: ${missing.join(', ')}`);
  must(existsSync(join(GAME_DIR, 'docs/screenshots')) && statSync(join(GAME_DIR, 'docs/screenshots')).isDirectory(),
    'faltando diretório docs/screenshots/');
  return `${REQUIRED_FILES.length} arquivos + docs/screenshots/`;
}

function checkPackageJson() {
  const pkg = JSON.parse(readText(join(GAME_DIR, 'package.json')));
  must(pkg.name === 'torre-de-ferro', `name inesperado: ${pkg.name}`);
  must(pkg.private === true, 'private deve ser true');
  must(pkg.type === 'module', 'type deve ser "module"');
  must(!pkg.dependencies && !pkg.devDependencies && !pkg.optionalDependencies && !pkg.peerDependencies,
    'package.json não pode declarar dependências');
  for (const key of ['start', 'test', 'test:completo', 'test:browser']) {
    must(typeof pkg.scripts?.[key] === 'string' && pkg.scripts[key].length > 0, `script "${key}" ausente`);
  }
  must(pkg.scripts.start.includes('serve.mjs'), 'script start deve rodar serve.mjs');
  must(pkg.scripts.test.includes('static-check.mjs'), 'script test deve rodar static-check.mjs');
  return 'type module, 4 scripts, zero deps';
}

function checkThree() {
  const threePath = join(GAME_DIR, 'src/vendor/three/three.module.js');
  const size = statSync(threePath).size;
  must(size > 500 * 1024, `three.module.js tem ${size} bytes (esperado > 500 KB)`);
  const licensePath = join(GAME_DIR, 'src/vendor/three/LICENSE');
  const license = readText(licensePath);
  must(license.trim().length > 0, 'LICENSE do Three.js vazio');
  must(/MIT/i.test(license), 'LICENSE do Three.js sem menção a MIT');
  const code = readText(threePath);
  const rev = code.match(/REVISION\s*=\s*['"](\d+)['"]/);
  must(rev, 'não encontrei REVISION no three.module.js');
  must(rev[1] === '160', `REVISION ${rev[1]} (esperado 160 = three 0.160.0)`);
  return `${(size / 1024 / 1024).toFixed(2)} MB, REVISION=${rev[1]}, LICENSE MIT`;
}

function checkNoExternalUrls() {
  const offenders = [];
  const urlRe = /(?:https?:)?\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi;
  const files = [
    join(GAME_DIR, 'index.html'),
    ...walkFiles(join(GAME_DIR, 'src'), { skipDirs: ['vendor', 'node_modules'] }).filter((f) => /\.(?:js|mjs|css)$/i.test(f)),
  ].filter((f) => existsSync(f));
  for (const file of files) {
    const lines = readText(file).split('\n');
    lines.forEach((line, i) => {
      const matches = line.match(urlRe);
      if (matches) offenders.push(`${relToGame(file)}:${i + 1} (${matches[0]})`);
    });
  }
  must(offenders.length === 0, `URL externa encontrada: ${offenders.slice(0, 6).join('; ')}`);
  return `${files.length} arquivos sem URL externa`;
}

function checkNoMediaAssets() {
  const offenders = [];
  const mediaRe = /\.(?:mp3|wav|ogg|png|jpe?g|gif|webp|gltf|glb)\b/gi;
  const files = [
    join(GAME_DIR, 'index.html'),
    ...walkFiles(join(GAME_DIR, 'src'), { skipDirs: ['vendor', 'node_modules'] }).filter((f) => /\.(?:js|mjs|css)$/i.test(f)),
  ].filter((f) => existsSync(f));
  for (const file of files) {
    const lines = readText(file).split('\n');
    lines.forEach((line, i) => {
      const matches = line.match(mediaRe);
      if (matches) offenders.push(`${relToGame(file)}:${i + 1} (${matches[0]})`);
    });
  }
  must(offenders.length === 0, `mídia externa/arquivo de mídia referenciado: ${offenders.slice(0, 6).join('; ')}`);
  return `${files.length} arquivos sem mídia externa (docs/screenshots/ é a exceção documentada)`;
}

function listJsFiles({ includeTests = true } = {}) {
  const roots = [join(GAME_DIR, 'src'), join(GAME_DIR, 'tests')];
  const files = [];
  for (const root of roots) {
    if (root.endsWith('tests') && !includeTests) continue;
    for (const f of walkFiles(root, { skipDirs: ['.git', 'node_modules'] })) {
      if (/\.(?:js|mjs)$/i.test(f)) files.push(f);
    }
  }
  files.push(join(GAME_DIR, 'serve.mjs'));
  return files.filter((f) => existsSync(f));
}

function checkRelativeImports() {
  const files = listJsFiles();
  const unresolved = [];
  const specs = [];
  const importFrom = /(?:^|[^\w$.])(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImport = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const file of files) {
    const code = readText(file);
    for (const re of [importFrom, dynamicImport]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) specs.push({ file, spec: m[1] });
    }
  }
  // <script type="module" src="..."> no index.html
  const html = readText(join(GAME_DIR, 'index.html'));
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let sm;
  while ((sm = scriptRe.exec(html))) {
    if (!/^[a-z]+:/i.test(sm[1]) && !sm[1].startsWith('//')) {
      specs.push({ file: join(GAME_DIR, 'index.html'), spec: sm[1] });
    }
  }
  for (const { file, spec } of specs) {
    const clean = spec.split('?')[0].split('#')[0];
    if (!clean.startsWith('.')) continue; // bare specifier (não deve existir, mas o runtime resolve)
    const target = resolve(dirname(file), clean);
    const base = existsSync(target) && statSync(target).isDirectory() ? join(target, 'index.js') : target;
    if (!existsSync(base) || !statSync(base).isFile()) {
      unresolved.push(`${relToGame(file)} -> ${spec}`);
    }
  }
  must(unresolved.length === 0, `imports relativos sem arquivo: ${unresolved.slice(0, 8).join('; ')}`);
  return `${specs.filter((s) => s.spec.startsWith('.')).length} imports relativos resolvidos`;
}

function checkNodeSyntax() {
  const files = listJsFiles();
  const failures = [];
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { cwd: GAME_DIR, encoding: 'utf8' });
    if (r.status !== 0) {
      const err = `${r.stderr || r.stdout || ''}`.trim().split('\n').slice(0, 2).join(' | ');
      failures.push(`${relToGame(file)}: ${err}`);
    }
  }
  must(failures.length === 0, failures.slice(0, 5).join('; '));
  return `${files.length} arquivos .js/.mjs passaram no node --check`;
}

function checkNoNodeModules() {
  const found = [...findNodeModules(REPO_ROOT), ...findNodeModules(GAME_DIR)];
  const uniq = [...new Set(found)];
  must(uniq.length === 0, `node_modules encontrado: ${uniq.join(', ')}`);
  return 'nenhum node_modules no repo nem no jogo';
}

function checkNoMathRandomInSim() {
  const files = walkFiles(join(GAME_DIR, 'src/sim'), { skipDirs: [] }).filter((f) => /\.js$/.test(f));
  const offenders = [];
  for (const file of files) {
    const lines = readText(file).split('\n');
    lines.forEach((line, i) => {
      if (/Math\.random\s*\(/.test(line) && !/^\s*\/\//.test(line)) offenders.push(`${relToGame(file)}:${i + 1}`);
    });
  }
  must(offenders.length === 0, `Math.random() proibido em src/sim: ${offenders.join(', ')}`);
  return `${files.length} arquivos de src/sim sem Math.random()`;
}

function checkHtmlPtBr() {
  const html = readText(join(GAME_DIR, 'index.html'));
  must(/<html\b[^>]*\blang\s*=\s*["']pt-BR["']/i.test(html), 'faltou <html lang="pt-BR">');
  return 'lang="pt-BR"';
}

function visibleText(html) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function checkUiPortuguese() {
  const html = readText(join(GAME_DIR, 'index.html'));
  const text = visibleText(html);
  // "menu" é palavra portuguesa válida ("Voltar ao menu") e fica de fora.
  const forbidden = /\b(build|upgrade|start|pause|play|victory|defeat|waves?|money|lives|help|settings|resume|restart|next|select|sound|mute|tower|enemy|enemies|score|loading|game\s+over|towers|level|sell|cancel|back|close|continue|map|maps|mission|campaign)\b/i;
  const found = text.match(forbidden);
  must(!found, `texto em inglês visível no index.html: "${found ? found[0] : ''}"`);
  return `texto visível em pt-BR (${text.length} chars analisados)`;
}

function checkWindowTd() {
  const mainPath = join(GAME_DIR, 'src/main.js');
  must(existsSync(mainPath), 'src/main.js ausente');
  const code = readText(mainPath);
  must(/window\.__TD__\s*=/.test(code), 'window.__TD__ não é atribuído em src/main.js');
  const missing = TD_API.filter((fn) => !new RegExp(`\\b${fn}\\b`).test(code));
  must(missing.length === 0, `__TD__ sem métodos: ${missing.join(', ')}`);
  return `window.__TD__ com ${TD_API.length} métodos`;
}

// ------------------------------------------------------------- serve.mjs

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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs = 10000) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      await res.arrayBuffer();
      return res;
    } catch (err) {
      lastErr = err;
      await delay(100);
    }
  }
  throw new Error(`servidor não respondeu em ${timeoutMs} ms: ${lastErr ? lastErr.message : 'timeout'}`);
}

async function checkServe() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['serve.mjs', String(port)], {
    cwd: GAME_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  const failures = [];
  try {
    await waitForHttp(`${base}/`);
    await delay(150);
    if (!new RegExp(`http://127\\.0\\.0\\.1:${port}/`).test(stdout)) {
      failures.push(`serve.mjs não imprimiu http://127.0.0.1:${port}/ (stdout: ${JSON.stringify(stdout.slice(0, 120))})`);
    }
    const request = async (label, path, expectedStatus, ctypePart) => {
      try {
        const res = await fetch(base + path, { redirect: 'manual' });
        const buf = Buffer.from(await res.arrayBuffer());
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        const cache = (res.headers.get('cache-control') || '').toLowerCase();
        if (res.status !== expectedStatus) failures.push(`${label}: HTTP ${res.status}, esperado ${expectedStatus}`);
        if (expectedStatus === 200 && ctypePart && !ctype.includes(ctypePart)) {
          failures.push(`${label}: content-type "${ctype}", esperado conter "${ctypePart}"`);
        }
        if (!cache.includes('no-store')) failures.push(`${label}: Cache-Control sem no-store ("${cache}")`);
        return { status: res.status, buf, ctype };
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
        return null;
      }
    };
    const root = await request('/', '/', 200, 'text/html');
    if (root && !root.buf.toString('utf8').includes('Torre de Ferro')) {
      failures.push('/ não contém "Torre de Ferro" (index.html não servido?)');
    }
    await request('GET /index.html', '/index.html', 200, 'text/html');
    await request('GET /styles.css', '/styles.css', 200, 'text/css');
    await request('GET /src/main.js', '/src/main.js', 200, 'javascript');
    const three = await request('GET three.module.js', '/src/vendor/three/three.module.js', 200, 'javascript');
    if (three && three.buf.length <= 500 * 1024) failures.push(`three.module.js servido com ${three.buf.length} bytes`);
    await request('GET /nao-existe', '/nao-existe', 404, null);
    const trav = await request('GET traversal %2e%2e', '/..%2f..%2f..%2fetc%2fpasswd', 400, null);
    if (trav && /root:/.test(trav.buf.toString('utf8'))) failures.push('traversal: serviu /etc/passwd!');
    // HEAD deve responder 200 sem corpo.
    try {
      const head = await fetch(`${base}/`, { method: 'HEAD' });
      if (head.status !== 200) failures.push(`HEAD /: HTTP ${head.status}`);
    } catch (err) {
      failures.push(`HEAD /: ${err.message}`);
    }
    must(failures.length === 0, failures.join('; '));
    return `127.0.0.1:${port} — /, /index.html, /styles.css, /src/main.js, three (200 + MIME + no-store), /nao-existe 404, traversal bloqueado`;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), delay(1500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

function checkGitScope() {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  must(r.status === 0, `git status falhou: ${(r.stderr || r.stdout || '').trim()}`);
  const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
  const offenders = [];
  const allowed = [];
  for (const line of lines) {
    let rest = line.slice(3);
    if (rest.includes(' -> ')) rest = rest.split(' -> ').pop();
    const path = rest.replace(/^"(.*)"$/, '$1');
    if (path === 'README.md' || path.startsWith(GAME_PREFIX)) allowed.push(path);
    else offenders.push(`${path} (${line.slice(0, 2).trim()})`);
  }
  must(offenders.length === 0, `arquivos alterados fora do escopo: ${offenders.slice(0, 8).join(', ')}`);
  return `${allowed.length} alterações, todas em ${GAME_PREFIX} ou README.md`;
}

// ---------------------------------------------------------------- execução

async function main() {
  console.log(`static-check — Torre de Ferro (${GAME_DIR})`);
  check('arquivos obrigatórios existem', checkRequiredFiles);
  check('package.json válido (type module, scripts, sem deps)', checkPackageJson);
  check('Three.js vendorizado > 500 KB + LICENSE', checkThree);
  check('zero URL externa em index.html/src (exceto vendor)', checkNoExternalUrls);
  check('zero mídia externa em index.html/src (docs/screenshots exceto)', checkNoMediaAssets);
  check('imports relativos resolvem para arquivos existentes', checkRelativeImports);
  check('node --check em todos os .js/.mjs do jogo', checkNodeSyntax);
  check('sem node_modules no repo/jogo', checkNoNodeModules);
  check('sem Math.random() em src/sim', checkNoMathRandomInSim);
  check('index.html lang="pt-BR"', checkHtmlPtBr);
  check('UI pt-BR (texto visível do index.html)', checkUiPortuguese);
  check('window.__TD__ completo em src/main.js', checkWindowTd);
  await checkAsync('serve.mjs: HTTP 200/404, MIME, no-store, traversal', checkServe);
  check('nenhum arquivo alterado fora do escopo (git status --porcelain)', checkGitScope);

  const fails = results.filter((r) => !r.ok);
  console.log('');
  console.log(`RESUMO static-check: ${results.length - fails.length} PASS, ${fails.length} FAIL (exit ${fails.length ? 1 : 0})`);
  if (fails.length) {
    console.log('FALHAS:');
    for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error(`static-check: erro fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
