/** Service Worker: abre sem rede (casca do app em cache) e guarda o último traçado do ramal. */
const VERSAO = "mv-09b2eebcde"; // trocado pelo build.mjs pelo hash da casca
const sw = self                                       ;
// Caminhos relativos à pasta do sw.js: o app funciona na raiz ou numa subpasta (ex.: GitHub Pages).
const rel = (p        ) => new URL(p, location.href).pathname;
const CASCA = ["./", "index.html", "estilo.css", "manifest.webmanifest", "icone.svg",
  "js/app.js", "js/fila.js", "js/idb.js", "js/config.js", "js/ramal.js", "js/supabase.js"].map(rel);
const DADOS = ["base.json"].map(rel); // rede primeiro, cache se offline (o Supabase não passa pelo cache)

sw.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA)).then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
    .then(() => sw.clients.claim()));
});

async function redePrimeiro(req         )                    {
  const cache = await caches.open(VERSAO);
  try {
    const r = await fetch(req);
    if (r.ok) await cache.put(req, r.clone());
    return r;
  } catch {
    return (await cache.match(req)) ?? new Response("offline", { status: 503 });
  }
}

async function cachePrimeiro(req         )                    {
  const salvo = await caches.match(req, { ignoreSearch: true });
  return salvo ?? redePrimeiro(req);
}

sw.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return; // POST (posições, avisos) vai direto; a fila do app cuida das falhas
  const url = new URL(req.url);
  if (url.origin === location.origin && CASCA.includes(url.pathname)) ev.respondWith(cachePrimeiro(req));
  else if (url.origin === location.origin && DADOS.includes(url.pathname)) ev.respondWith(redePrimeiro(req));
  else if (url.hostname === "unpkg.com") ev.respondWith(cachePrimeiro(req)); // Leaflet
});
