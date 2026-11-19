/** Service Worker: abre sem rede (casca do app em cache) e guarda o último traçado do ramal. */
const VERSAO = "mv-6034f87fe8"; // trocado pelo build.mjs pelo hash da casca
const sw = self                                       ;
// Caminhos relativos à pasta do sw.js: o app funciona na raiz ou numa subpasta (ex.: GitHub Pages).
const rel = (p        ) => new URL(p, location.href).pathname;
const CASCA = ["./", "index.html", "estilo.css", "manifest.webmanifest", "icone.svg",
  "js/app.js", "js/fila.js", "js/idb.js", "js/config.js", "js/ramal.js", "js/supabase.js"].map(rel);
const DADOS = ["base.json"].map(rel); // rede primeiro, cache se offline (o Supabase não passa pelo cache)

sw.addEventListener("install", (ev) => {
  // "reload": busca no servidor, não no cache HTTP do navegador. O GitHub Pages manda max-age=600, e sem isso
  // a versão nova do SW guardava os arquivos velhos (visto em 18/11: cache mv-baa483db69 com o index.html antigo).
  ev.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
    .then(() => sw.clients.claim()));
});

async function redePrimeiro(req         )                    {
  const cache = await caches.open(VERSAO);
  try {
    // prazo de 3 s: com sinal ruim no trem, o fetch ficava pendurado e o app não abria; cai para o cache
    const r = await fetch(req, { signal: AbortSignal.timeout(3000) });
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
  // Nota 2: fontes (Space Grotesk e Atkinson Hyperlegible) ficam guardadas para abrir sem rede
  else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") ev.respondWith(cachePrimeiro(req));
});
