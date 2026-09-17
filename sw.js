/**
 * sw.js — Service Worker de Bitácora de Barra
 * =========================================================================
 * Responsabilidad ÚNICA: dejar que la app (el "shell": HTML/CSS/JS/iconos)
 * abra y funcione sin conexión. Los DATOS operativos (productos, stock,
 * movimientos, etc.) NUNCA pasan por aquí — viven en IndexedDB, gestionado
 * por js/app.js y js/sync.js. Este Service Worker no sabe nada de negocio.
 *
 * Estrategia:
 *  - App shell (HTML/CSS/JS propios + iconos + manifest): cache-first con
 *    actualización en segundo plano (stale-while-revalidate), para que la
 *    app abra al instante incluso offline y se autoactualice cuando haya red.
 *  - Peticiones a Supabase (*.supabase.co) y a cualquier otra API: NUNCA se
 *    cachean aquí — pasan directas a la red y, si falla, que sea sync.js
 *    (con su cola) quien decida qué hacer, no el Service Worker.
 *  - Navegación (F5, abrir la URL): si falla la red, se sirve el index.html
 *    cacheado (offline fallback) para que la SPA arranque igual.
 * =========================================================================
 */

const CACHE_VERSION = 'bitacora-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/sync.js',
  './js/supabaseClient.js',
  './config.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isAppShellRequest(url) {
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Nunca intervenir en llamadas a Supabase u otras APIs externas: van
  // directas a la red y su resultado lo gestiona la propia app.
  if (!isAppShellRequest(url)) return;
  if (req.method !== 'GET') return;

  // Navegación de página (abrir/recargar la app): red primero, con
  // fallback al index.html cacheado si no hay conexión.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Resto del shell (css/js/iconos/manifest): cache-first + revalidación
  // en segundo plano.
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.status === 200) {
          caches.open(CACHE_VERSION).then(cache => cache.put(req, res.clone()));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
