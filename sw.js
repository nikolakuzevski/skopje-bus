/* sw.js — offline shell.
 *
 * Only the app's own files are cached. Live transit data is never cached: a
 * bus position from ten minutes ago is worse than no position at all, and the
 * app already has an explicit stale state for that case.
 *
 * ASSETS must mirror the script list in index.html. Bump CACHE_VERSION whenever
 * any cached file changes, or an installed PWA keeps serving the old one. */
const CACHE_VERSION = 'sb-v9';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/dom.js',
  'js/api.js',
  'js/cache.js',
  'js/store.js',
  'js/history.js',
  'js/eta.js',
  'js/debug.js',
  'js/timetable.js',
  'js/ui-stop.js',
  'js/ui-detail.js',
  'js/ui-pick.js',
  'js/ui-info.js',
  'js/app.js',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  // Leaflet is vendored rather than loaded from a CDN precisely so it can be
  // precached here: the fetch handler below ignores cross-origin GETs, so a CDN
  // copy could never be cached and the map would be dead offline.
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) {
        // One fetch at a time, not cache.addAll() or Promise.all(): firing all
        // ~25 requests from inside the service worker at once was observed,
        // repeatedly and reproducibly, to leave a consistent tail of the list
        // (always the same later entries) never cached, while the identical
        // fetches all succeed instantly when issued from a page instead -
        // some concurrency limit specific to SW-initiated fetch() in at least
        // one real environment. Going one at a time sidesteps the whole class
        // of problem; 25 small files cost nothing serially. {cache:'reload'}
        // still forces each fetch past the HTTP cache, so a CACHE_VERSION
        // bump within a static asset's max-age window cannot precache the OLD
        // bytes under the NEW cache name.
        return ASSETS.reduce(function (chain, u) {
          return chain.then(function () {
            return fetch(new Request(u, { cache: 'reload' })).then(function (res) {
              if (res && res.ok) return cache.put(u, res);
            });
          });
        }, Promise.resolve());
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE_VERSION ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch the transit API

  // Stale-while-revalidate: open instantly, pick up new files next load.
  event.respondWith(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.match(req).then(function (cached) {
        const network = fetch(req).then(function (res) {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        }).catch(function () { return cached || cache.match('./'); });
        // Keep the revalidation alive past this handler returning: without
        // waitUntil, the worker can be torn down before cache.put lands, so
        // "new files next load" silently sometimes needs one load more than
        // that. Also covers the cache.put promise, not just the response.
        event.waitUntil(network);
        return cached || network;
      });
    })
  );
});
