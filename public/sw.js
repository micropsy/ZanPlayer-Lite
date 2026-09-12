// ZanPlayer Lite service worker: app-shell offline startup.
//
// Strategy:
//   - Install/activate  : pre-cache the app shell (index + icons + manifest).
//   - Navigation        : network-first, falling back to the cached app shell so
//                         the installed PWA opens without a connection. The
//                         HMR/dev server is never registered (see main.tsx).
//   - Static assets     : stale-while-revalidate. Vite emits content-hashed
//                         files, so cache-first is safe and the background
//                         refresh keeps new deploys current.
//   - Everything else   : passthrough. Blob object URLs (user-selected media)
//                         are out of scope for a service worker by design, and
//                         media range requests are deliberately never
//                         intercepted so streaming is untouched.

const SHELL = "/zanplayer-shell-v1";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.ico",
  "/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html").then((hit) => hit || caches.match("/")))
    );
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const refresh = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});