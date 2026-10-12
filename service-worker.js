/* ============================================================
   КабинетЪ кладоискателя — Service Worker
   Оффлайн-режим: оболочка приложения, данные и скриншоты РККА.
   Тайлы карт (Яндекс/ESRI/OSM) и тяжёлые геоданные НЕ кэшируются.
   ============================================================ */

const CACHE_VERSION = 'v2026-10-12';
const CACHE_NAME    = 'kabinet-' + CACHE_VERSION;          // 'kabinet-v2026-10-12'
const CACHE_STATIC  = CACHE_NAME + '-static';              // HTML/JSON/CSS/JS, иконки
const CACHE_DATA    = CACHE_NAME + '-data';                // data/urochisha.json
const CACHE_IMAGES  = CACHE_NAME + '-images';              // screenshots/*.jpg

// Ядро приложения — кэшируем при установке.
// Скриншоты (1912 шт., ~130 МБ) НЕ прекэшируем: они попадают в кэш
// лениво, при первом открытии карточки (cache-first).
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/data/urochisha.json'
];

// ---------- Установка ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => {
      return Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[SW] Не удалось закэшировать:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ---------- Активация: чистим старые кэши ----------
self.addEventListener('activate', (event) => {
  const keep = [CACHE_STATIC, CACHE_DATA, CACHE_IMAGES];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => (keep.includes(key) ? null : caches.delete(key)))
      )
    ).then(() => self.clients.claim())
  );
});

// ---------- Стратегии ----------

// cache-first: скриншоты и прочие свои ресурсы. После первого запроса — навсегда.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    return cached || Response.error();
  }
}

// stale-while-revalidate: HTML/JSON/CSS/JS. Отдаём из кэша сразу,
// в фоне обновляем. Оффлайн — работает то, что уже закэшировано.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

// network-first: внешние CDN (Leaflet, шрифты). Онлайн — свежий ответ,
// оффлайн — из кэша. Кэшируем и opaque-ответы (no-cors: CDN/шрифты).
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return Response.error();
  }
}

// ---------- Внешние домены, которые SW НЕ перехватывает ----------
// Тайлы карт — Network Only: они огромные и меняются, кэшировать нельзя.
const TILE_BYPASS = [
  'yandex',
  'esri',
  'arcgisonline',
  'openstreetmap',
  'tile.openstreetmap.org'
];

// ---------- Перехват запросов ----------
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 0) Тайлы карт — Network Only (не перехватываем).
  if (TILE_BYPASS.some((domain) => url.hostname.includes(domain))) {
    return;
  }

  // 1) Тяжёлый geojson границ ЦФО (~21 МБ) — НЕ кэшируем.
  if (url.pathname.endsWith('cfo_boundaries.geojson')) {
    return;
  }

  // 2) Данные урочищ (JSON) — stale-while-revalidate (оффлайн из кэша).
  if (url.origin === self.location.origin && url.pathname.startsWith('/data/')) {
    event.respondWith(staleWhileRevalidate(request, CACHE_DATA));
    return;
  }

  // 3) Скриншоты РККА — Cache First (после первого запроса хранится навсегда).
  if (url.origin === self.location.origin && url.pathname.startsWith('/screenshots/')) {
    event.respondWith(cacheFirst(request, CACHE_IMAGES));
    return;
  }

  // 4) HTML (навигация), CSS, JS своего origin — stale-while-revalidate.
  if (
    url.origin === self.location.origin &&
    (request.mode === 'navigate' ||
     url.pathname === '/' ||
     url.pathname.endsWith('.html') ||
     url.pathname.endsWith('.css') ||
     url.pathname.endsWith('.js') ||
     url.pathname.endsWith('.json'))
  ) {
    event.respondWith(staleWhileRevalidate(request, CACHE_STATIC));
    return;
  }

  // 5) Внешние CDN (Leaflet, шрифты) — Network First с фолбэком на кэш.
  if (
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(networkFirst(request, CACHE_STATIC));
    return;
  }

  // 6) Прочие запросы своего origin (иконки и т.п.) — cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }
});

// Сообщение от страницы — принудительное обновление.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
