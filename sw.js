// El "service worker": guarda la app en el celular, así abre al toque (y aunque no haya internet se ve, con lo último
// que tenía). Lo que se le pide a JARVIS siempre va por internet. Cambiá VERSION cuando publiques cambios: así los
// celulares bajan la app nueva.
const VERSION = "jarvis-2026.10.24.2";
const ARCHIVOS = ["./", "index.html", "estilo.css", "fuentes.css", "app.js", "reactor.js", "manifest.webmanifest",
                  "iconos/icono-192.png", "iconos/icono-512.png", "iconos/icono-maskable-512.png", "iconos/apple-touch-icon.png",
                  "fuentes/Orbitron-700-latin.woff2", "fuentes/Orbitron-900-latin.woff2", "fuentes/Rajdhani-500-latin.woff2",
                  "fuentes/Rajdhani-600-latin.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((claves) => Promise.all(claves.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;   // lo de JARVIS (Google) no se guarda
  // primero internet (así siempre está lo último), y si no hay, lo guardado
  e.respondWith(fetch(e.request).then((r) => {
    const copia = r.clone();
    caches.open(VERSION).then((c) => c.put(e.request, copia));
    return r;
  }).catch(() => caches.match(e.request, {ignoreSearch: true})));
});
