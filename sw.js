// B57-002: new version so returning web users get the upgrade-required handling (sync-service.js, app.js) instead of the cached code.
const CACHE_VERSION = 'a2-workout-v67-b57-upgrade-required-2026-11-18';
const APP_SHELL = [
  './',
  './index.html',
  './recovery.html',
  './styles.css',
  './app.js?v=b57-upgrade-required-v1',
  './storage.js',
  './exercise-service.js',
  './program-service.js',
  './import-service.js',
  './document-extractor.js',
  './local-import-parser.js',
  './import-provider.js',
  './openai-import-parser.js',
  './auth-service.js',
  './sync-service.js',
  './youtube-service.js?v=english-youtube-search-v1',
  './data/public-programs.js',
  './data/exercises.v1.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).pathname.startsWith('/api/') || new URL(event.request.url).pathname === '/runtime-config.js') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && new URL(event.request.url).origin === location.origin) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification?.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
      return null;
    })
  );
});
