/** Malha Viva · PWA: radar do ramal, aviso rápido, SOS. Grava no Supabase (Fase 4, desenho A). */
import { TURNSTILE_SITE, VERSAO_TERMO } from "./config.js";
import { ArmazemMemoria, Fila,                                   } from "./fila.js";
import { ArmazemIDB } from "./idb.js";
import { Ramal,                         } from "./ramal.js";
import { Supabase } from "./supabase.js";

                                                                                                                           
                                                                                           
                                                                 
                                        

const $ =                        (id        ) => document.getElementById(id)     ;
const INTERVALO_MS = 10_000;
const ATRASO_MAX_MS = 14 * 60_000; // o banco recusa acima de 15 min; aqui descarta antes para não perder o lote inteiro
const RAIO_LINHA_M = 150;
const NUM                          = { central: 1, santa_cruz: -1 };
const TERMO = "Avise só o que você está vendo. Avisos falsos levam à suspensão da conta.\n" +
  "Emergência: ligue 190, 192 ou 193 primeiro.\n\nAceita estas regras?";

// ---------------------------------------------------------------- estado
let ramal               = null;
let sentido          = (lerLocal("mv_sentido")           ) || "central";
let meuKm                = null;
let alertas           = [];
let vigia                = null;
let trava                          = null;
let ultimaEnfileirada = 0;
let idViagem = "";

function lerLocal(k        )                {
  try { return localStorage.getItem(k); } catch { return null; }
}
function gravarLocal(k        , v        )       {
  try { localStorage.setItem(k, v); } catch { /* modo privado: segue sem guardar */ }
}

function armazem   (loja        )             {
  return "indexedDB" in self ? new ArmazemIDB   (loja) : new ArmazemMemoria   ();
}

/** Token do Cloudflare Turnstile para o primeiro login. O script só carrega se houver chave de site. */
function captcha()                         {
  if (!TURNSTILE_SITE) return Promise.resolve(null);
  return new Promise((ok) => {
    const desenhar = () => {
      const T = (window                                  ).turnstile;
      if (!T) return ok(null);
      const caixa = document.createElement("div");
      // fixa no meio da tela: se a Cloudflare pedir o clique, a caixa não pode ficar escondida no fim da página
      caixa.style.cssText = "position:fixed;left:50%;top:40%;transform:translateX(-50%);z-index:1000";
      document.body.append(caixa);
      const fim = (t               ) => { clearTimeout(prazo); ok(t); caixa.remove(); };
      const prazo = setTimeout(() => fim(null), 120_000); // ninguém clicou: segue sem token e tenta de novo depois
      T.render(caixa, { sitekey: TURNSTILE_SITE, appearance: "interaction-only", language: "pt-br",
        callback: (t        ) => fim(t), "error-callback": () => fim(null) });
    };
    if ((window                                      ).turnstile) return desenhar();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.onload = desenhar;
    s.onerror = () => ok(null); // sem rede: o login fica para a próxima tentativa
    document.head.append(s);
  });
}

const sb = new Supabase({ ler: () => lerLocal("mv_sessao"), gravar: (v) => gravarLocal("mv_sessao", v) }, { captcha });

const filaPos = new Fila         (armazem("posicoes"), async (lote)                          => {
  const frescas = lote.filter((p) => Date.now() - Date.parse(p.t) < ATRASO_MAX_MS);
  return frescas.length ? sb.inserir("posicoes", frescas) : "rejeitado";
});

const filaRel = new Fila        (armazem("relatos"), (lote) => sb.inserir("relatos", lote));

async function esvaziarTudo()                {
  await Promise.all([filaPos.esvaziar(), filaRel.esvaziar()]);
  const n = (await filaPos.tamanho()) + (await filaRel.tamanho());
  $("rede").textContent = navigator.onLine ? (n ? `${n} na fila` : "Conectado") : (n ? `Sem rede, ${n} na fila` : "Sem rede");
  $("rede").dataset.estado = navigator.onLine ? (n ? "fila" : "ok") : "off";
}

// ---------------------------------------------------------------- radar (faixa da linha)
function estacoesNoSentido()            {
  const es = [...(ramal?.base.estacoes ?? [])];
  return sentido === "central" ? es.reverse() : es; // destino no topo
}

function desenharFaixa()       {
  const ol = $("faixa");
  ol.replaceChildren();
  const es = estacoesNoSentido();
  const porEstacao = new Map                  ();
  for (const a of alertas) if (a.sentido === NUM[sentido]) porEstacao.set(a.estacao, [...(porEstacao.get(a.estacao) ?? []), a]);
  es.forEach((e, i) => {
    const li = document.createElement("li");
    li.className = "estacao" + (e.terminal ? " terminal" : "");
    const nome = document.createElement("span");
    nome.className = "nome";
    nome.textContent = e.nome;
    li.append(nome);
    for (const a of porEstacao.get(e.nome) ?? []) {
      const b = document.createElement("span");
      b.className = "aviso" + (a.confirmado ? " confirmado" : "");
      b.textContent = `${a.tipo} (${a.pessoas})`;
      li.append(b);
    }
    ol.append(li);
    const prox = es[i + 1];
    if (meuKm != null && prox && meuKm <= Math.max(e.km, prox.km) && meuKm >= Math.min(e.km, prox.km)) {
      const eu = document.createElement("li");
      eu.className = "eu";
      eu.textContent = "Você está aqui";
      ol.append(eu);
    }
  });
}

function preencherSelects()       {
  for (const id of ["destino", "avisoEstacao"]) {
    const sel = $                   (id);
    const atual = sel.value;
    sel.replaceChildren(...estacoesNoSentido().map((e) => new Option(e.nome, e.nome)));
    if (atual) sel.value = atual;
  }
}

function atualizarEta()       {
  const destino = $                   ("destino").value;
  const saida = $("eta");
  if (meuKm == null || !destino || !ramal) { saida.textContent = "Toque em Estou no trem para ver a chegada."; return; }
  const s = ramal.eta(meuKm, NUM[sentido], destino);
  saida.textContent = s == null ? `${destino} já ficou para trás.`
    : `Chegada em ${destino} em cerca de ${Math.max(1, Math.round(s / 60))} min.`;
}

async function carregarAlertas()                {
  try { alertas = await sb.ler          ("alertas_ativos?select=*"); desenharFaixa(); } catch { /* offline: mantém os últimos */ }
}

// ---------------------------------------------------------------- "Estou no trem" (tela ligada)
async function prenderTela()                {
  try { trava = await navigator.wakeLock?.request("screen") ?? null; } catch { trava = null; }
}

function iniciar()       {
  if (!("geolocation" in navigator)) { $("posStatus").textContent = "Este navegador não dá acesso à localização."; return; }
  idViagem = "v-" + crypto.randomUUID().slice(0, 8); // código novo a cada viagem
  vigia = navigator.geolocation.watchPosition(async (p) => {
    if (ramal) {
      const proj = ramal.projetar(p.coords.latitude, p.coords.longitude);
      const naLinha = proj.distM <= RAIO_LINHA_M;
      meuKm = naLinha ? proj.km : null;
      $("posStatus").textContent = naLinha ? "Posição na linha do trem." : "Você parece estar fora da linha do trem.";
      desenharFaixa();
      atualizarEta();
    }
    if (p.timestamp - ultimaEnfileirada < INTERVALO_MS - 1500) return;
    ultimaEnfileirada = p.timestamp;
    await filaPos.adicionar({ viagem: idViagem, t: new Date(p.timestamp).toISOString(), lat: p.coords.latitude,
      lon: p.coords.longitude, precisao_m: Math.round(p.coords.accuracy) });
    await esvaziarTudo();
  }, (e) => { $("posStatus").textContent = e.code === 1 ? "Permita a localização para ajudar o radar." : "GPS sem sinal agora."; },
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  void prenderTela();
  $("btnTrem").textContent = "Parar";
  $("btnTrem").setAttribute("aria-pressed", "true");
}

function parar()       {
  if (vigia != null) navigator.geolocation.clearWatch(vigia);
  vigia = null;
  void trava?.release();
  trava = null;
  $("btnTrem").textContent = "Estou no trem";
  $("btnTrem").setAttribute("aria-pressed", "false");
  void esvaziarTudo();
}

// ---------------------------------------------------------------- aviso rápido (termo no primeiro aviso)
async function garantirTermo()                   {
  if (lerLocal("mv_termo") === VERSAO_TERMO) return true;
  if (!confirm(TERMO)) return false;
  try {
    await sb.inserir("aceites_termo", [{ versao: VERSAO_TERMO }]); // "rejeitado" aqui = aceite já gravado antes
  } catch {
    $("avisoStatus").textContent = "Sem rede para registrar o aceite. Tente de novo com internet.";
    return false;
  }
  gravarLocal("mv_termo", VERSAO_TERMO);
  return true;
}

async function enviarAviso(tipo        )                {
  if (!(await garantirTermo())) return;
  const estacao = $                   ("avisoEstacao").value;
  await filaRel.adicionar({ estacao, sentido: NUM[sentido], tipo });
  await esvaziarTudo();
  const pendente = (await filaRel.tamanho()) > 0;
  $("avisoStatus").textContent = pendente ? "Aviso guardado. Será enviado quando a rede voltar." : `Aviso enviado: ${tipo} em ${estacao}.`;
  void carregarAlertas();
}

// ---------------------------------------------------------------- SOS (tudo fica no aparelho)
function contatos()           {
  try { return JSON.parse(lerLocal("mv_contatos") || "[]"); } catch { return []; }
}

function desenharContatos()       {
  const ul = $("contatos");
  ul.replaceChildren();
  for (const tel of contatos()) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.className = "contato";
    a.textContent = `Enviar SMS para ${tel}`;
    a.href = `sms:${tel}`;
    a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      location.href = `sms:${tel}?body=${encodeURIComponent(await textoSos())}`;
    });
    const x = document.createElement("button");
    x.type = "button";
    x.className = "tirar";
    x.textContent = "Remover";
    x.addEventListener("click", () => { gravarLocal("mv_contatos", JSON.stringify(contatos().filter((c) => c !== tel))); desenharContatos(); });
    li.append(a, x);
    ul.append(li);
  }
}

function minhaPosicao()                                      {
  return new Promise((ok) => navigator.geolocation
    ? navigator.geolocation.getCurrentPosition(ok, () => ok(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 })
    : ok(null));
}

async function textoSos()                  {
  const p = await minhaPosicao();
  const onde = p ? `https://maps.google.com/?q=${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}` : "localização indisponível";
  return `Preciso de ajuda. Estou no trem do ramal Santa Cruz, sentido ${sentido === "central" ? "Central" : "Santa Cruz"}. ${onde}`;
}

async function compartilharSos()                {
  const texto = await textoSos();
  try {
    if (navigator.share) { await navigator.share({ text: texto }); return; }
    await navigator.clipboard.writeText(texto);
    $("sosStatus").textContent = "Mensagem copiada. Cole no WhatsApp ou SMS.";
  } catch {
    $("sosStatus").textContent = texto;
  }
}

// ---------------------------------------------------------------- mapa (sob demanda, poupa dados)
let mapaPronto = false;
async function abrirMapa()                {
  const caixa = $("mapa");
  caixa.hidden = !caixa.hidden;
  if (caixa.hidden || mapaPronto || !ramal) return;
  await new Promise      ((ok, falha) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"; s.onload = () => ok(); s.onerror = () => falha();
    document.head.append(css, s);
  }).catch(() => { caixa.textContent = "Mapa indisponível sem rede."; });
  const L = (window                          ).L;
  if (!L) return;
  const m = L.map(caixa, { zoomControl: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(m);
  const linha = L.polyline(ramal.base.linha.map(([lat, lon]) => [lat, lon]), { color: "#1E9E4A", weight: 6 }).addTo(m);
  for (const e of ramal.base.estacoes) L.circleMarker([e.lat, e.lon], { radius: 6, color: "#14532D", fillColor: "#F6F4EC", fillOpacity: 1 }).bindTooltip(e.nome).addTo(m);
  m.fitBounds(linha.getBounds(), { padding: [16, 16] });
  mapaPronto = true;
}

// ---------------------------------------------------------------- navegação e início
function mostrar(aba        )       {
  for (const s of document.querySelectorAll             ("[data-aba]")) s.hidden = s.dataset.aba !== aba;
  for (const b of document.querySelectorAll             ("[data-ir]")) b.setAttribute("aria-current", String(b.dataset.ir === aba));
  gravarLocal("mv_aba", aba);
}

function ligar()       {
  for (const b of document.querySelectorAll             ("[data-ir]")) b.addEventListener("click", () => mostrar(b.dataset.ir ));
  for (const b of document.querySelectorAll                  ("input[name=sentido]")) {
    b.checked = b.value === sentido;
    b.addEventListener("change", () => { sentido = b.value           ; gravarLocal("mv_sentido", sentido); preencherSelects(); desenharFaixa(); atualizarEta(); });
  }
  $("btnTrem").addEventListener("click", () => (vigia == null ? iniciar() : parar()));
  $("destino").addEventListener("change", () => atualizarEta());
  $("btnMapa").addEventListener("click", () => void abrirMapa());
  for (const b of document.querySelectorAll             ("[data-tipo]")) b.addEventListener("click", () => void enviarAviso(b.dataset.tipo ));
  $("btnSos").addEventListener("click", () => void compartilharSos());
  $                 ("formContato").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const campo = $                  ("novoContato");
    const tel = campo.value.replace(/[^\d+]/g, "");
    if (tel.length < 8) { $("sosStatus").textContent = "Digite um telefone com DDD."; return; }
    gravarLocal("mv_contatos", JSON.stringify([...new Set([...contatos(), tel])]));
    campo.value = "";
    desenharContatos();
  });
  addEventListener("online", () => { filaPos.liberar(); filaRel.liberar(); void esvaziarTudo(); });
  addEventListener("offline", () => void esvaziarTudo());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { if (vigia != null) void prenderTela(); void carregarAlertas(); void esvaziarTudo(); }
  });
}

async function comecar()                {
  ligar();
  mostrar(lerLocal("mv_aba") || "radar");
  desenharContatos();
  try {
    ramal = new Ramal(await (await fetch("base.json")).json()        );
    $("ramal").textContent = `Ramal ${ramal.base.ramal}`;
  } catch {
    $("ramal").textContent = "Sem rede e sem dados guardados do ramal.";
  }
  preencherSelects();
  desenharFaixa();
  atualizarEta();
  await Promise.all([carregarAlertas(), esvaziarTudo()]);
  setInterval(() => { if (document.visibilityState === "visible") void carregarAlertas(); }, 30_000);
  if ("serviceWorker" in navigator) {
    // Versão nova do app: quando o SW novo assume, recarrega uma vez para não rodar o JS velho do cache.
    // Na primeira instalação não há SW anterior, então não recarrega.
    const tinhaAnterior = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (tinhaAnterior) location.reload(); });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  }
}

void comecar();
