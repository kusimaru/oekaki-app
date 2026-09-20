/*
 * サービスワーカー(PC でも「アプリとしてインストール」できるようにするために必要)。
 * 方針は「ネットワーク優先」: オンラインなら常に最新を取りに行き、オフラインのときだけ前回の内容を使う。
 * これにより、iPad のホーム画面アプリが古い版を持ち続ける問題も起きにくくなる。
 */
const CACHE = 'oekaki-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // GitHub API などは触らない
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && !url.pathname.endsWith('version.json')) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./', { ignoreSearch: true });
        if (shell) return shell;
      }
      throw new Error('offline');
    }
  })());
});
