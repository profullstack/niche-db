/* Service worker. Notifications plus an offline shell for the pages a reader
   has already seen. Nothing here caches API or feed responses. */
const VERSION = 'v1';
const SHELL = `nichedb-shell-${VERSION}`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

// Network first, falling back to the last copy of a page when offline. Only
// same-origin GET navigations and static assets; never /api, /mcp or feeds.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/^\/(api|mcp|auth|f\/[^/]+\.(rss|json))/.test(url.pathname)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === 'navigate' || /\.(css|js|png|svg|ico)$/.test(url.pathname))) {
          const copy = res.clone();
          caches
            .open(SHELL)
            .then((c) => c.put(req, copy))
            .catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit ?? Response.error())),
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-48x48.png',
      tag: payload.tag,
      renotify: true,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/following';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) if (c.url.includes(url) && 'focus' in c) return c.focus();
      return self.clients.openWindow(url);
    }),
  );
});
