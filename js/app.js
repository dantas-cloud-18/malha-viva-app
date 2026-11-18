/** Malha Viva · PWA: radar do ramal, aviso rápido, SOS. Grava no Supabase (Fase 4, desenho A). */
import { TURNSTILE_SITE, VERSAO_TERMO } from "./config.js";
import { ArmazemMemoria, Fila,                                   } from "./fila.js";
import { ArmazemIDB } from "./idb.js";
import { distanciaM, Ramal,                         } from "./ramal.js";
import { Supabase } from "./supabase.js";

                                                                                                                           
                                                                                           
                                                               // sentido 0 = parado ou ainda sem direção
                                                                 
                                        

const $ =                        (id        ) => document.getElementById(id)     ;
const INTERVALO_MS = 10_000;
const PRECISAO_MAX_M = 100; // pior que isso não move o "Você está aqui" nem vai para o servidor
const VEL_MAX_MS = 33;      // ~120 km/h: acima disso é salto do GPS, não o trem
const SILENCIO_S = 30;      // linha de diagnóstico fica vermelha e conta um silêncio
const RELIGAR_S = 20;       // GPS calado por 20 s: o vigia religa o watchPosition
const TRENS_MS = 10_000; // leitura do radar; 100 pessoas olhando ≈ 36 mil leituras/h, dentro do egress grátis (~1 KB cada)
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
let trens         = [];
let trensLidosEm = 0;
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
  const [rp] = await Promise.all([filaPos.esvaziar(), filaRel.esvaziar()]);
  if (reg && (rp.enviados || rp.rejeitados || rp.erro)) { reg.envios += 1; if (rp.erro) reg.errosEnvio += 1; }
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
  // marcas entre estações: os trens do sentido escolhido (e os parados) e a posição do próprio aparelho
  const marcas                                                  = trens
    .filter((t) => t.sentido === 0 || t.sentido === NUM[sentido])
    .map((t) => ({ km: t.km, classe: "trem", texto: `${t.sentido ? "Trem" : "Trem parado"} · visto há ${idade(t.visto_em)}` }));
  if (meuKm != null) marcas.push({ km: meuKm, classe: "eu", texto: "Você está aqui" });
  const porTrecho = new Map                       ();
  for (const m of marcas) {
    const i = Ramal.trechoDe(es, m.km);
    if (i >= 0) porTrecho.set(i, [...(porTrecho.get(i) ?? []), m]);
  }
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
    for (const m of (porTrecho.get(i) ?? []).sort((a, b) => Math.abs(a.km - e.km) - Math.abs(b.km - e.km))) {
      const marca = document.createElement("li");
      marca.className = m.classe;
      marca.textContent = m.texto;
      ol.append(marca);
    }
  });
}

function idade(iso        )         {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

function resumoTrens()       {
  const n = trens.filter((t) => t.sentido === 0 || t.sentido === NUM[sentido]).length;
  const lido = trensLidosEm ? ` Atualizado há ${idade(new Date(trensLidosEm).toISOString())}.` : "";
  $("trens").textContent = (n ? `${n} ${n > 1 ? "trens" : "trem"} no radar neste sentido.` : "Nenhum trem no radar neste sentido agora.") + lido;
}

async function carregarTrens()                {
  try {
    trens = await sb.ler        ("trens_ao_vivo?select=*");
    trensLidosEm = Date.now();
    desenharFaixa();
  } catch { /* offline: mantém os últimos; o "atualizado há" mostra a idade */ }
  resumoTrens();
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
// Fase 5 (iPhone): o iOS solta a trava de tela e às vezes para o watchPosition sem erro.
// Por isso: trava pedida de novo, vigia que religa o GPS calado e registro da viagem na tela.
async function prenderTela()                {
  if (trava && !trava.released) return;
  try {
    trava = await navigator.wakeLock?.request("screen") ?? null;
    trava?.addEventListener("release", () => {
      if (vigia != null && document.visibilityState === "visible") void prenderTela();
    });
  } catch { trava = null; }
}

                                                                                                                   
                                                                                                                                
let reg                  = null;
let ultimoFix = 0;        // hora (ms) da última posição recebida do GPS, boa ou ruim
let ultimoAceito                                                 = null;
let relogio                = null;
let ultimoReligar = 0;

function novoRegistro()           {
  return { inicio: Date.now(), fixes: 0, aceitos: 0, ruins: 0, saltos: 0, religados: 0, silencios: [], maiorSilencioS: 0,
    envios: 0, errosEnvio: 0, precisoes: [] };
}

function aoReceber(p                     )       {
  const agora = Date.now();
  if (reg) {
    reg.fixes += 1;
    const gap = ultimoFix ? (agora - ultimoFix) / 1000 : 0;
    if (gap > SILENCIO_S) reg.silencios.push({ inicio: new Date(ultimoFix).toLocaleTimeString("pt-BR"), s: Math.round(gap) });
    reg.maiorSilencioS = Math.max(reg.maiorSilencioS, Math.round(gap));
  }
  ultimoFix = agora;
  const { latitude: lat, longitude: lon, accuracy } = p.coords;
  if (accuracy > PRECISAO_MAX_M) { if (reg) reg.ruins += 1; return; } // posição ruim não move nem vai para o servidor
  if (ultimoAceito) {
    const dt = (p.timestamp - ultimoAceito.t) / 1000;
    if (dt > 0 && distanciaM(ultimoAceito.lat, ultimoAceito.lon, lat, lon) / dt > VEL_MAX_MS) { if (reg) reg.saltos += 1; return; }
  }
  ultimoAceito = { t: p.timestamp, lat, lon };
  if (reg) { reg.aceitos += 1; reg.precisoes.push(Math.round(accuracy)); }
  if (ramal) {
    const proj = ramal.projetar(lat, lon);
    const naLinha = proj.distM <= RAIO_LINHA_M;
    meuKm = naLinha ? proj.km : null;
    $("posStatus").textContent = naLinha ? "Posição na linha do trem." : "Você parece estar fora da linha do trem.";
    desenharFaixa();
    atualizarEta();
  }
  if (p.timestamp - ultimaEnfileirada < INTERVALO_MS - 1500) return;
  ultimaEnfileirada = p.timestamp;
  void filaPos.adicionar({ viagem: idViagem, t: new Date(p.timestamp).toISOString(), lat, lon, precisao_m: Math.round(accuracy) })
    .then(esvaziarTudo);
}

function ligarGps()       {
  if (vigia != null) navigator.geolocation.clearWatch(vigia);
  vigia = navigator.geolocation.watchPosition(aoReceber,
    (e) => { $("posStatus").textContent = e.code === 1 ? "Permita a localização para ajudar o radar." : "GPS sem sinal agora."; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }); // maximumAge 0: no trem, posição de 5 s atrás erra ~80 m
}

function religarGps()       {
  if (vigia == null) return;
  if (reg) reg.religados += 1;
  ligarGps();
}

function mediana(xs          )                {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function desenharDiag()                {
  const d = $("diag");
  if (!reg) { d.hidden = true; return; }
  d.hidden = false;
  const idadeS = ultimoFix ? Math.round((Date.now() - ultimoFix) / 1000) : null;
  const prec = reg.precisoes.at(-1);
  const fila = await filaPos.tamanho();
  d.textContent = `Último GPS há ${idadeS ?? "–"} s · precisão ${prec ?? "–"} m · fila ${fila} · silêncios > ${SILENCIO_S} s: ${reg.silencios.length}`;
  d.dataset.estado = vigia != null && (idadeS == null || idadeS > SILENCIO_S) ? "alerta" : "ok";
  if (vigia != null && idadeS != null && idadeS > RELIGAR_S && Date.now() - ultimoReligar > RELIGAR_S * 1000) {
    ultimoReligar = Date.now();
    religarGps();
  }
}

function textoRegistro()         {
  if (!reg) return "Sem viagem registrada.";
  const min = Math.round((Date.now() - reg.inicio) / 60000);
  return [
    `Malha Viva · registro da viagem ${idViagem}`,
    `Início: ${new Date(reg.inicio).toLocaleString("pt-BR")} · duração: ${min} min`,
    `Aparelho: ${navigator.userAgent}`,
    `Posições do GPS: ${reg.fixes} · aceitas: ${reg.aceitos} · ruins (> ${PRECISAO_MAX_M} m): ${reg.ruins} · saltos: ${reg.saltos}`,
    `Precisão mediana: ${mediana(reg.precisoes) ?? "–"} m`,
    `Maior silêncio: ${reg.maiorSilencioS} s · silêncios > ${SILENCIO_S} s: ${reg.silencios.map((s) => `${s.inicio} (${s.s} s)`).join(", ") || "nenhum"}`,
    `GPS religado pelo vigia: ${reg.religados} vez(es)`,
    `Rodadas de envio: ${reg.envios} · com erro: ${reg.errosEnvio}`,
  ].join("\n");
}

async function copiarRegistro()                {
  const t = textoRegistro();
  try { await navigator.clipboard.writeText(t); $("posStatus").textContent = "Registro copiado. Cole no WhatsApp ou numa nota."; }
  catch { $("posStatus").textContent = t; }
}

function iniciar()       {
  if (!("geolocation" in navigator)) { $("posStatus").textContent = "Este navegador não dá acesso à localização."; return; }
  idViagem = "v-" + crypto.randomUUID().slice(0, 8); // código novo a cada viagem
  reg = novoRegistro();
  ultimoFix = Date.now(); // conta a espera pela primeira posição; se passar de 20 s, o vigia religa
  ultimoReligar = 0;
  ultimoAceito = null;
  ligarGps();
  void prenderTela();
  relogio ??= window.setInterval(() => void desenharDiag(), 1000);
  $("btnTrem").textContent = "Parar";
  $("btnTrem").setAttribute("aria-pressed", "true");
  $("btnRegistro").hidden = false;
}

function parar()       {
  if (vigia != null) navigator.geolocation.clearWatch(vigia);
  vigia = null;
  void trava?.release();
  trava = null;
  $("btnTrem").textContent = "Estou no trem";
  $("btnTrem").setAttribute("aria-pressed", "false");
  void desenharDiag();
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
    b.addEventListener("change", () => { sentido = b.value           ; gravarLocal("mv_sentido", sentido); preencherSelects(); desenharFaixa(); resumoTrens(); atualizarEta(); });
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
    if (document.visibilityState === "visible") {
      if (vigia != null) { void prenderTela(); religarGps(); } // depois de trocar de app, o watch antigo pode não voltar
      void carregarAlertas(); void carregarTrens(); void esvaziarTudo();
    } else void esvaziarTudo(); // saindo da tela: última tentativa de envio (fetch com keepalive)
  });
  $("btnRegistro").addEventListener("click", () => void copiarRegistro());
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
  await Promise.all([carregarAlertas(), carregarTrens(), esvaziarTudo()]);
  setInterval(() => { if (document.visibilityState === "visible") void carregarAlertas(); }, 30_000);
  setInterval(() => { if (document.visibilityState === "visible") void carregarTrens(); }, TRENS_MS);
  if ("serviceWorker" in navigator) {
    // Versão nova do app: quando o SW novo assume, recarrega uma vez para não rodar o JS velho do cache.
    // Na primeira instalação não há SW anterior, então não recarrega.
    const tinhaAnterior = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (tinhaAnterior) location.reload(); });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  }
}

void comecar();
