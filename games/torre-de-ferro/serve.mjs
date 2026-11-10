#!/usr/bin/env node
// Torre de Ferro — servidor HTTP estático mínimo, só Node stdlib, sem deps.
//
// Uso:  node serve.mjs            (127.0.0.1:8099)
//       node serve.mjs 9000       (porta alternativa)
//
// Serve o conteúdo de games/torre-de-ferro/ em http://127.0.0.1:8099/.
// - MIME correto para html/js/mjs/css/json/png/...;
// - Cache-Control: no-store em todas as respostas;
// - 404 para arquivo inexistente; 400 para caminho inválido/traversal;
// - bloqueia qualquer tentativa de sair da raiz do jogo (.. e %2e%2e);
// - "/" serve index.html.
//
// Também exporta createStaticServer() para os testes reusarem o mesmo handler.

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve as resolvePath, sep, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8099;
export const GAME_ROOT = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export function mimeFor(filePath) {
  return MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function send(res, status, contentType, body, method) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

function plain(res, status, text, method) {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(`${text}\n`, 'utf8'), method);
}

// Página 404 mínima e escura (inline, sem asset externo) — também é o "antes" do PR
// quando o servidor olha para a árvore do main: /games/torre-de-ferro/ não existe.
function notFound(res, method) {
  const body = Buffer.from(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" /><title>404 — arquivo não encontrado</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1017;color:#e8ecf3;font-family:system-ui,sans-serif}main{text-align:center}h1{margin:0 0 8px;font-size:42px;letter-spacing:2px}p{margin:0;color:#9aa7b8}</style>
</head><body><main><h1>404</h1><p>Arquivo não encontrado — <strong>Torre de Ferro</strong></p></main></body></html>
`, 'utf8');
  send(res, 404, 'text/html; charset=utf-8', body, method);
}

// Resolve o caminho requisitado para um arquivo físico dentro de `root`.
// Retorna {file} ou {error: 400|404}.
function resolveRequestPath(root, rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return { error: 400 };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { error: 400 };
  }
  if (decoded.includes('\0')) return { error: 400 };
  // Backslash nunca é separador válido em URL; tratar como tentativa de fuga.
  if (decoded.includes('\\')) return { error: 400 };

  const rel = decoded.replace(/^\/+/, '');
  const segments = rel === '' ? [] : rel.split('/');
  if (segments.some((seg) => seg === '..')) return { error: 400 };
  if (segments.length === 0) return { file: resolvePath(root, 'index.html'), rel: 'index.html' };

  const file = resolvePath(root, ...segments);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (file !== root && !file.startsWith(rootWithSep)) return { error: 400 };
  return { file, rel };
}

/**
 * Cria (sem escutar) um http.Server estático servindo `root`.
 * @param {string} root diretório raiz (padrão: pasta do jogo)
 * @returns {import('node:http').Server}
 */
// O Chromium pede /favicon.ico sozinho e um 404 vira console.error — os critérios
// de aceite exigem zero erro de console, então respondemos 204 (sem asset externo).
function isFaviconRequest(rawUrl) {
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname === '/favicon.ico';
  } catch {
    return false;
  }
}

export function createStaticServer(root = GAME_ROOT) {
  const absRoot = resolvePath(root);
  return createServer((req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      plain(res, 405, '405 — método não permitido', method);
      return;
    }
    if (isFaviconRequest(req.url || '/')) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const target = resolveRequestPath(absRoot, req.url || '/');
    if (target.error === 400) {
      plain(res, 400, '400 — caminho inválido', method);
      return;
    }
    if (target.error === 404) {
      notFound(res, method);
      return;
    }
    let stat;
    try {
      stat = statSync(target.file);
    } catch {
      notFound(res, method);
      return;
    }
    if (stat.isDirectory()) {
      // Só a raiz serve index.html; diretórios internos não têm índice público.
      notFound(res, method);
      return;
    }
    if (!stat.isFile()) {
      notFound(res, method);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(target.file),
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(target.file);
    stream.on('error', () => {
      if (!res.headersSent) plain(res, 500, '500 — erro ao ler arquivo', method);
      else res.destroy();
    });
    stream.pipe(res);
  });
}

/** Escuta o servidor e resolve com a porta efetiva. */
export function listen(server, port = DEFAULT_PORT, host = HOST) {
  return new Promise((resolvePort, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolvePort(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  const rawPort = process.argv[2];
  let port = DEFAULT_PORT;
  if (rawPort !== undefined) {
    port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`Porta inválida: ${rawPort}. Use um inteiro entre 0 e 65535.`);
      process.exit(1);
    }
  }
  const server = createStaticServer(GAME_ROOT);
  const shutdown = () => {
    server.close(() => process.exit(0));
    // Se algum stream travar, encerra mesmo assim.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  listen(server, port)
    .then((effectivePort) => {
      // Linha exata cobrada pela especificação/QA.
      console.log(`http://${HOST}:${effectivePort}/`);
      console.error('Torre de Ferro — servidor estático. Ctrl+C para encerrar.');
    })
    .catch((err) => {
      console.error(`Falha ao abrir o servidor: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}
