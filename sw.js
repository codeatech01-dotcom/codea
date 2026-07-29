/* =========================================================
   Codea PWA service worker — network-first for fresh data
   IMPORTANT: Firebase database/storage calls are NEVER cached.
   ========================================================= */
const CACHE = 'codea-v8-live-firebase';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/logo.png',
  './icons/logo-wide.png',
  './icons/invoice-logo.png',
  './icons/favicon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // CRITICAL: Never cache Firebase database or Firebase Storage.
  // Caching these requests causes devices to show old/empty customer lists.
  if (
    url.hostname.endsWith('firebaseio.com') ||
    url.hostname.endsWith('firebasedatabase.app') ||
    url.hostname === 'firebasestorage.googleapis.com'
  ) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // For all app-shell pages/assets, prefer the newest network version.
  // Fall back to cache only when the device is truly offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // External resources: network first, cache only as offline fallback.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
