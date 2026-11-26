/* Service worker: la app arranca sin conexión; las llamadas a la hoja nunca se cachean. */
const CACHE = 'tracker-beta-v4';
const ASSETS = ['./', './index.html', './datos-supabase.js?r=2', './manifest.webmanifest',
                './icon-192.png', './icon-512.png', './icon-maskable-512.png',
                './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Nunca interceptar Apps Script ni Google: los datos siempre en vivo
  if (e.request.method !== 'GET' || /google|googleusercontent/i.test(url.hostname)) return;
  if (url.origin !== location.origin) return;
  // Comprobación de versión y recarga tras actualizar («?v=…»): directo a la red, sin guardar copia
  if (url.searchParams.has('v')) return;
  // La app: red primero, caché si no hay cobertura
  e.respondWith(
    fetch(e.request)
      .then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
