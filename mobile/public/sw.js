/*
 * 离线缓存（Service Worker）：添加到主屏幕后可以在没有网络时游玩。
 * - 页面导航：网络优先（有新版本时立即生效），离线时用缓存；
 * - 带哈希的脚本 / 样式、地球贴图、图标：缓存优先。
 * 更换贴图等非哈希资源时请修改 CACHE 的版本号。
 */
const CACHE = 'rocket-mobile-v1';
const CORE = [
  './',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './textures/earth/day.jpg',
  './textures/earth/night.jpg',
  './textures/earth/water.png',
  './textures/earth/topo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE);
      // index.html 中引用的带哈希的入口脚本与样式
      try {
        const html = await (await fetch('./', { cache: 'no-cache' })).text();
        const urls = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => m[1]);
        await cache.addAll(urls);
      } catch {
        /* 离线安装时忽略 */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// 页面把首次加载时已经下载的资源（例如 Worker 脚本）告诉我们，一并缓存
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'precache' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const u of data.urls) {
        try {
          const url = new URL(u, self.location.href);
          if (url.origin !== self.location.origin || url.pathname.endsWith('sw.js')) continue;
          if (!(await cache.match(url))) await cache.add(url);
        } catch {
          /* 忽略单个失败 */
        }
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const cache = await caches.open(CACHE);
            await cache.put('./', res.clone());
          }
          return res;
        } catch {
          return (await caches.match(req)) || (await caches.match('./')) || Response.error();
        }
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});
