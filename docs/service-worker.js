const CACHE_NAME = "vremya-idei-shell-v2";
const BASE_PATH = new URL(self.registration.scope).pathname;
const localPath = (path) => `${BASE_PATH}${path}`;
const APP_SHELL = [
  BASE_PATH,
  localPath("index.html"),
  localPath("manifest.webmanifest"),
  localPath("icons/icon-192.png"),
  localPath("icons/icon-512.png"),
];
const CACHEABLE_DESTINATIONS = new Set(["document", "script", "style", "image", "font"]);

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await fetch(localPath("index.html"), { cache: "no-cache" });
  if (!indexResponse.ok) throw new Error("Не удалось получить оболочку приложения");
  const indexText = await indexResponse.clone().text();
  const builtAssets = [...indexText.matchAll(/(?:src|href)="([^"?#]*assets\/[^"?#]+)"/g)]
    .map((match) => new URL(match[1], self.registration.scope).pathname);
  await cache.addAll([...APP_SHELL, ...builtAssets]);
  await cache.put(localPath("index.html"), indexResponse);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheApplicationShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !CACHEABLE_DESTINATIONS.has(request.destination)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) await caches.open(CACHE_NAME).then((cache) => cache.put(localPath("index.html"), response.clone()));
          return response;
        })
        .catch(() => caches.match(localPath("index.html")).then((response) => response || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then(async (response) => {
      if (response.ok) await caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    })),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
