/* Torre de Ferro — service worker (instalável e offline após a 1ª visita).
   Sem dependências; mesma origem apenas. Versão: subir VERSAO ao mudar os arquivos. */
const VERSAO = 'td3d-2026-11-10-campanha20';
const CACHE = `torre-de-ferro-${VERSAO}`;

const ESSENCIAIS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/sim/rng.js',
  './src/sim/data.js',
  './src/sim/maps.js',
  './src/sim/waves.js',
  './src/sim/combat.js',
  './src/sim/troops.js',
  './src/sim/engine.js',
  './src/render/scene.js',
  './src/render/meshes.js',
  './src/render/fx.js',
  './src/render/hud.js',
  './src/render/audio.js',
  './src/vendor/three/three.module.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ESSENCIAIS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navegação: rede primeiro; se falhar, entrega o index em cache (offline).
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const resp = await fetch(req);
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copia));
        }
        return resp;
      } catch (err) {
        const hit = await caches.match('./index.html') || await caches.match('./');
        if (hit) return hit;
        return new Response('Torre de Ferro — sem conexão e sem cache.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // Demais arquivos: cache primeiro, rede como reserva (atualiza o cache).
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const resp = await fetch(req);
      if (resp && resp.ok) {
        const copia = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copia));
      }
      return resp;
    } catch (err) {
      return new Response('Offline', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
