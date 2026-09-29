/*
 * App-shell cache.
 *
 * iOS drops a backgrounded PWA and relaunches it cold, so every app switch
 * pays for a full document + bundle fetch through the relay. Serving
 * the shell from the cache turns that into a local read; the network still
 * decides what is current, it just no longer blocks the first paint.
 *
 * Only static assets are cached. Nothing here touches /ws, /pair or any other
 * daemon route: those are authenticated and must never be replayed.
 */
const CACHE = "pios-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/", "/manifest.webmanifest"])).then(
      () => self.skipWaiting(),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isShellAsset = (url) =>
  url.pathname.startsWith("/assets/") ||
  url.pathname === "/manifest.webmanifest" ||
  url.pathname === "/icon.svg";

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: cache first so a relaunch paints immediately, with a
  // background refresh so a new build is picked up on the next launch.
  if (request.mode === "navigate") {
    event.respondWith(
      caches.match("/").then((cached) => {
        const fresh = fetch(request)
          .then((response) => {
            if (response.ok) caches.open(CACHE).then((c) => c.put("/", response.clone()));
            return response;
          })
          .catch(() => cached);
        return cached ?? fresh;
      }),
    );
    return;
  }

  // Build assets are content-hashed, so a hit is always the right bytes.
  if (isShellAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) caches.open(CACHE).then((c) => c.put(request, response.clone()));
            return response;
          }),
      ),
    );
  }
});

/*
 * Settle notifications.
 *
 * The daemon pushes when a session settles. Safari requires a visible
 * notification for every push, so a malformed or empty payload still shows
 * something rather than costing the app its push permission.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "PiOS";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "Agent settled.",
      tag: data.tag || "pios",
      // A later settle for the same session replaces the earlier one silently.
      renotify: false,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Reusing the open window keeps the socket, the outbox, and the
      // transcript; a second window would resync everything from scratch.
      for (const client of clients) {
        if (new URL(client.url).origin !== target.origin) continue;
        return client.focus().then((focused) => focused.navigate(target.href));
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
