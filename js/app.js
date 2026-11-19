/** Malha Viva · PWA: radar do ramal, aviso rápido, SOS. Grava no Supabase (Fase 4, desenho A). */
import { TURNSTILE_SITE, VERSAO_TERMO } from "./config.js";
import { ArmazemMemoria, Fila,                                   } from "./fila.js";
import { ArmazemIDB } from "./idb.js";
import { DetectorParada, pareceSalto, Ramal, Suavizador,                                     } from "./ramal.js";
import { Supabase } from "./supabase.js";

                                                                                                                           
                                                                                         
                                                                                 
// sentido 0 = parado ou ainda sem direção; estimado = buraco de sinal, km avançado pela velocidade (visão 0005)
                                                                                                     
                                               
                                                                 
                                        

const $ =                        (id        ) => document.getElementById(id)     ;
const INTERVALO_MS = 2_000; // A5: 1 posição a cada 2 s (era 10 s) para medir paradas e trechos; o banco aceita 1 por segundo
// 200, não 100: no iPhone a precisão passa de 100 m em estação coberta e em corte; descartar tudo isso deixava buracos.
const PRECISAO_MAX_M = 200; // pior que isso não move o "Você está aqui" nem vai para o servidor
const VEL_MAX_MS = 33;      // ~120 km/h: acima disso é salto do GPS, não o trem
const SILENCIO_S = 30;      // linha de diagnóstico fica vermelha e conta um silêncio
const RELIGAR_S = 20;       // GPS calado por 20 s: o vigia religa o watchPosition
const TRENS_MS = 10_000; // leitura do radar; 100 pessoas olhando ≈ 36 mil leituras/h, dentro do egress grátis (~1 KB cada)
const ATRASO_MAX_MS = 6 * 3600_000 - 5 * 60_000; // A8: o banco ignora acima de 6 h; aqui descarta um pouco antes
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

// Nota 3 · M4: erros do app vão para `erros_app` (versão do cache, aparelho resumido, mensagem). No máximo 5 por abertura.
let errosEnviados = 0;
async function registrarErro(msg        )                {
  if (errosEnviados >= 5) return;
  errosEnviados += 1;
  try {
    const versao = (await caches.keys()).find((k) => k.startsWith("mv-")) ?? "sem-cache";
    await sb.inserir("erros_app", [{ versao, aparelho: navigator.userAgent.slice(0, 120), mensagem: msg.slice(0, 300) }]);
  } catch { /* sem rede: o erro não é guardado (não vale encher a fila) */ }
}
addEventListener("error", (e) => void registrarErro(`${e.message} em ${String(e.filename).split("/").pop()}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => void registrarErro(`promessa: ${(e.reason         )?.message ?? String(e.reason)}`));

async function esvaziarTudo()                {
  const [rp] = await Promise.all([filaPos.esvaziar(), filaRel.esvaziar()]);
  if (reg && (rp.enviados || rp.rejeitados || rp.erro)) { reg.envios += 1; if (rp.erro) reg.errosEnvio += 1; }
  const n = (await filaPos.tamanho()) + (await filaRel.tamanho());
  $("rede").querySelector(".txt") .textContent = navigator.onLine ? (n ? `${n} na fila` : "Ao vivo") : (n ? `Sem rede, ${n} na fila` : "Sem rede");
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
    .map((t) => ({ km: kmTremAgora(t), classe: "trem" + (t.estimado ? " estimado" : ""), texto: rotuloTrem(t) }));
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
  resumirFaixa(ol);
  // Nota 2: o trilho se preenche da origem (embaixo) até o nó aceso
  const eu = ol.querySelector             (".eu");
  if (eu) ol.style.setProperty("--feito-topo", `${eu.offsetTop + eu.offsetHeight / 2}px`);
  else ol.style.removeProperty("--feito-topo");
}

/** Só troca o texto se mudou: leitor de tela não repete a mesma frase a cada segundo (revisão). */
function texto(el             , t        )       {
  if (el.textContent !== t) el.textContent = t;
}

/**
 * Crítica P2: com "você" na faixa, mostra só as estações perto (5 de cada lado), as pontas e as que têm aviso ou trem.
 * O resto vira uma linha "N estações" que abre a faixa inteira.
 */
let faixaCompleta = false;
function resumirFaixa(ol             )       {
  const itens = [...ol.children]                 ;
  const euIdx = itens.findIndex((li) => li.classList.contains("eu"));
  if (euIdx < 0 || faixaCompleta) return;
  const estacoes = itens.map((li, i) => ({ li, i })).filter(({ li }) => li.classList.contains("estacao"));
  const posEu = estacoes.filter(({ i }) => i < euIdx).length; // estações antes do "você"
  const manter = (k        , li             , i        ) => k === 0 || k === estacoes.length - 1 || Math.abs(k - posEu) <= 5
    || li.querySelector(".aviso") != null || itens[i + 1]?.classList.contains("trem");
  let escondidas                = [];
  const fechar = () => {
    if (!escondidas.length) return;
    const r = document.createElement("li");
    r.className = "resumo";
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${escondidas.length} ${escondidas.length > 1 ? "estações" : "estação"}: mostrar`;
    b.addEventListener("click", () => { faixaCompleta = true; desenharFaixa(); });
    r.append(b);
    escondidas[0].before(r);
    for (const e of escondidas) e.hidden = true;
    escondidas = [];
  };
  estacoes.forEach(({ li, i }, k) => { if (manter(k, li, i)) fechar(); else escondidas.push(li); });
  fechar();
}

function minutos(s        )         {
  return `${Math.max(1, Math.round(s / 60))} min`;
}

/** Nota 2: barra do trecho atual e tabela das próximas estações. */
function atualizarChegadas()       {
  const trecho = $("trecho"), bloco = $("blocoChegadas");
  if (meuKm == null || !ramal) { trecho.hidden = true; bloco.hidden = true; texto($("avisoOnde"), ""); return; }
  const s = NUM[sentido], km = meuKm;
  const es = ramal.base.estacoes;
  const frente = es.filter((e) => (e.km - km) * s > 0.05).sort((a, b) => (a.km - b.km) * s);
  const tras = es.filter((e) => (e.km - km) * s <= 0.05).sort((a, b) => (b.km - a.km) * s);
  const de = tras[0], para = frente[0];
  // crítica P1: o aviso vai, por padrão, para a próxima estação do trecho, não para o destino
  if (para && !avisoManual) $                   ("avisoEstacao").value = para.nome;
  texto($("avisoOnde"), de && para ? `Você está entre ${de.nome} e ${para.nome}. O aviso vai para ${$                   ("avisoEstacao").value}.` : "");
  if (de && para) {
    const p = Math.min(1, Math.max(0, Math.abs(km - de.km) / (Math.abs(para.km - de.km) || 1)));
    $("trechoDe").textContent = de.nome;
    $("trechoPara").textContent = para.nome;
    $("trechoBarra").style.setProperty("--p", String(p));
    trecho.querySelector(".barra") .setAttribute("aria-valuenow", String(Math.round(p * 100)));
    trecho.hidden = false;
  } else trecho.hidden = true;
  const destino = $                   ("destino").value;
  const linhas = frente.slice(0, 5).map((e) => ({ e, seg: ramal .eta(km, s, e.nome) ?? 0 }));
  const max = Math.max(1, ...linhas.map((l) => l.seg));
  $("tabChegadas").replaceChildren(...linhas.map((l, i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.className = "proxima";
    if (l.e.nome === destino) tr.classList.add("destino");
    const quando = new Date(Date.now() + l.seg * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const td = (t        ) => { const c = document.createElement("td"); c.textContent = t; return c; };
    const barra = document.createElement("td");
    barra.innerHTML = `<div class="barra" aria-hidden="true"><span style="--p:${(l.seg / max).toFixed(3)}"></span></div>`;
    tr.append(td(l.e.nome), td(`${minutos(l.seg)} (${quando})`), barra);
    return tr;
  }));
  bloco.hidden = !linhas.length;
}

/** A9: o trem anda na tela entre uma leitura e outra (até 60 s), pela velocidade que a visão calculou. */
function kmTremAgora(t      )         {
  const dt = Math.min(60, Math.max(0, (Date.now() - trensLidosEm) / 1000));
  return t.km + t.sentido * (t.velocidade_kmh || 0) / 3600 * dt;
}

function rotuloTrem(t      )         {
  const quem = t.pessoas > 1 ? `, ${t.pessoas} pessoas` : "";
  if (!t.sentido) {
    const min = t.parado_s != null ? Math.round(t.parado_s / 60) : 0;
    return `Trem parado${min >= 1 ? ` há ${min} min` : ""}${quem}`;
  }
  return `${t.estimado ? "Trem (posição estimada)" : "Trem"}, visto há ${idade(t.visto_em)}${quem}`;
}

function idade(iso        )         {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

function resumoTrens()       {
  const n = trens.filter((t) => t.sentido === 0 || t.sentido === NUM[sentido]).length;
  const lido = trensLidosEm ? ` Atualizado há ${idade(new Date(trensLidosEm).toISOString())}.` : "";
  $("trens").textContent = (n ? `${n} ${n > 1 ? "trens" : "trem"} no radar neste sentido.`
    : "Nenhum trem no radar neste sentido ainda.") + lido;
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
    else if (id === "avisoEstacao" && lerLocal("mv_ultima_estacao")) sel.value = lerLocal("mv_ultima_estacao") ; // sem GPS: a última avisada
  }
}

function atualizarEta()       {
  const destino = $                   ("destino").value;
  const saida = $("eta");
  atualizarChegadas();
  saida.classList.toggle("vazio", meuKm == null || !destino || !ramal);
  if (meuKm == null || !destino || !ramal) {
    texto(saida, vigia != null && ultimoBom && !naLinhaAgora ? "Você parece estar fora da linha do trem. A chegada aparece quando a posição cair na linha."
      : vigia != null ? "Esperando a posição do GPS." : "Quando você estiver no trem, a chegada aparece aqui.");
    return;
  }
  const s = ramal.eta(meuKm, NUM[sentido], destino);
  texto(saida, s == null ? `${destino} já ficou para trás. Escolha outra estação.` : `Chega em ${destino} em cerca de ${minutos(s)}.`);
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
let ultimoFix = 0;        // hora (ms) da última posição recebida do GPS, boa ou ruim (vigia)
let ultimoBom = 0;        // hora (ms) da última posição aceita (diagnóstico e silêncios: A6)
let ultimaPrec                = null; // precisão da última posição recebida, mesmo descartada (A6)
let ultimoAceito               = null;
let saltosSeguidos = 0;
let ultimoReligar = 0;
let kmBruto                = null;    // km da última posição aceita, para o mapa com memória (A7)
let naLinhaAgora = false;
let suave = new Suavizador();
let detector                        = null;
let sentidoErradoDesde = 0;           // A11
let recarregarDepois = false;         // A2: versão nova espera o "Parar"
let rolouParaMim = false;             // crítica: rolar até "você" só uma vez por viagem
let avisoManual = false;              // crítica: a pessoa escolheu a estação do aviso; não trocar sozinho

function novoRegistro()           {
  return { inicio: Date.now(), fixes: 0, aceitos: 0, ruins: 0, saltos: 0, religados: 0, silencios: [], maiorSilencioS: 0,
    envios: 0, errosEnvio: 0, precisoes: [], paradas: [], retomadas: 0 };
}

/** Número válido do GPS ou null (o iOS manda NaN ou -1 quando não sabe). */
function valido(x                           , min        , max        )                {
  return x == null || Number.isNaN(x) || x < min || x > max ? null : x;
}

function aoReceber(p                     )       {
  const agora = Date.now();
  if (reg) reg.fixes += 1;
  ultimoFix = agora;
  const { latitude: lat, longitude: lon, accuracy } = p.coords;
  ultimaPrec = Math.round(accuracy);
  if (accuracy > PRECISAO_MAX_M) { if (reg) reg.ruins += 1; return; } // posição ruim não move nem vai para o servidor
  const atual        = { t: p.timestamp, lat, lon, prec: accuracy };
  // 3 saltos seguidos = o errado era o ponto guardado, não os novos: aceita e recomeça daqui
  if (ultimoAceito && pareceSalto(ultimoAceito, atual, VEL_MAX_MS) && saltosSeguidos < 3) {
    saltosSeguidos += 1;
    if (reg) reg.saltos += 1;
    return;
  }
  saltosSeguidos = 0;
  ultimoAceito = atual;
  if (reg) {
    const antes = ultimoBom || ultimoAntesDeRecarregar;
    const gap = antes ? (agora - antes) / 1000 : 0;
    if (gap > SILENCIO_S) reg.silencios.push({ inicio: new Date(ultimoBom).toLocaleTimeString("pt-BR"), s: Math.round(gap) });
    reg.maiorSilencioS = Math.max(reg.maiorSilencioS, Math.round(gap));
    reg.aceitos += 1;
    reg.precisoes.push(Math.round(accuracy));
    // shortcut: mediana só das últimas 600 posições (~10 min), para o registro salvo a cada 10 s ficar pequeno
    if (reg.precisoes.length > 600) reg.precisoes.shift();
  }
  const velMs = valido(p.coords.speed, 0, 100);
  if (ramal) {
    // A7: com posição boa recente, procura o km perto do anterior
    const dica = kmBruto != null && agora - ultimoBom < 120_000 ? kmBruto : undefined;
    const proj = ramal.projetar(lat, lon, dica, 2, Math.max(RAIO_LINHA_M, accuracy) * 2);
    naLinhaAgora = proj.distM <= Math.max(RAIO_LINHA_M, accuracy); // GPS impreciso: o raio cresce com o erro informado
    if (naLinhaAgora) {
      kmBruto = proj.km;
      suave.atualizar(proj.km, accuracy, p.timestamp, velMs);
      const vel = velMs ?? Math.abs(suave.kmS) * 1000;
      const mudou = detector?.atualizar(suave.km , vel, p.timestamp);
      if (mudou && reg && !reg.paradas.includes(mudou)) reg.paradas.push(mudou);
      conferirSentido();
    }
    $("posStatus").textContent = naLinhaAgora ? "Posição na linha do trem." : "Você parece estar fora da linha do trem.";
    desenharPosicao();
  }
  if (reg && agora - ultimaGravacao >= 10_000) salvarViagem(agora); // 19/11: antes só gravava depois de silêncio > 10 s
  ultimoBom = agora;
  if (p.timestamp - ultimaEnfileirada < INTERVALO_MS - 500) return;
  ultimaEnfileirada = p.timestamp;
  void filaPos.adicionar({ viagem: idViagem, t: new Date(p.timestamp).toISOString(), lat, lon, precisao_m: Math.round(accuracy),
    velocidade_ms: velMs, rumo: valido(p.coords.heading, 0, 360), altitude_m: valido(p.coords.altitude, -500, 9000) })
    .then(esvaziarTudo)
    .catch((e) => void registrarErro(`fila de posições: ${(e         )?.message ?? e}`));
}

/** A9: o "Você está aqui" anda a cada segundo pela velocidade, entre uma posição e outra. */
function desenharPosicao()       {
  meuKm = vigia != null && naLinhaAgora ? suave.agora(Date.now()) : null;
  desenharFaixa();
  atualizarEta();
  // crítica P2: na primeira posição na linha, a tela vai até "você" (uma vez por viagem)
  const eu = document.querySelector             ("#faixa .eu");
  if (eu && !rolouParaMim && !document.querySelector             ("[data-aba=radar]") .hidden) {
    rolouParaMim = true;
    eu.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

/** A11: o km dizendo um sentido por 60 s e o usuário marcado no outro → oferece a troca. */
function conferirSentido()       {
  const real = suave.sentido();
  const btn = $("btnTrocarSentido");
  if (real === 0 || real === NUM[sentido]) { sentidoErradoDesde = 0; btn.hidden = true; return; }
  sentidoErradoDesde ||= Date.now();
  if (Date.now() - sentidoErradoDesde < 60_000) return;
  btn.textContent = `Parece que você está indo para ${real === 1 ? "a Central" : "Santa Cruz"}. Trocar o sentido`;
  btn.dataset.para = real === 1 ? "central" : "santa_cruz";
  btn.hidden = false;
}

function trocarSentido()       {
  const para = $("btnTrocarSentido").dataset.para;
  const r = document.querySelector                  (`input[name=sentido][value=${para}]`);
  if (!r) return;
  r.checked = true;
  r.dispatchEvent(new Event("change"));
  sentidoErradoDesde = 0;
  $("btnTrocarSentido").hidden = true;
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

/** Roda a cada segundo: diagnóstico, vigia do GPS e posições andando na tela. */
async function tique()                {
  if (document.visibilityState !== "visible") return;
  if (vigia != null || trens.length) desenharPosicao();
  atualizarMapa();
  const d = $("diag");
  estadoBotao();
  if (!reg) { d.hidden = true; vigiarGps(); return; }
  d.hidden = false;
  const bomS = ultimoBom ? Math.round((Date.now() - ultimoBom) / 1000) : null;
  vigiarGps();
  const fila = await filaPos.tamanho().catch(() => 0);
  // Nota 2: cada medida com valor, barra e cor (verde / âmbar / vermelho)
  linhaDiag("bom", bomS == null ? "esperando" : `há ${bomS} s`, bomS == null ? 1 : Math.min(1, bomS / SILENCIO_S),
    bomS == null || bomS > SILENCIO_S ? "ruim" : bomS > 10 ? "atencao" : "ok");
  linhaDiag("prec", ultimaPrec == null ? "–" : `${ultimaPrec} m`, ultimaPrec == null ? 0 : Math.min(1, ultimaPrec / PRECISAO_MAX_M),
    ultimaPrec == null ? "ok" : ultimaPrec > PRECISAO_MAX_M ? "ruim" : ultimaPrec > 50 ? "atencao" : "ok");
  linhaDiag("fila", `${fila}`, Math.min(1, fila / 30), fila > 30 ? "ruim" : fila > 5 ? "atencao" : "ok");
  linhaDiag("silencios", `${reg.silencios.length}`, Math.min(1, reg.silencios.length / 5), reg.silencios.length ? "atencao" : "ok");
  d.dataset.estado = vigia != null && (bomS == null || bomS > SILENCIO_S) ? "alerta" : "ok";
  if (d.dataset.estado === "alerta" && vigia != null && bomS != null) ($("diagDet")                      ).open = true;
}

/** Vigia: GPS calado por 20 s → religa. Roda antes de qualquer espera do tique (revisão). */
function vigiarGps()       {
  const caladoS = (Date.now() - ultimoFix) / 1000;
  if (vigia != null && caladoS > RELIGAR_S && Date.now() - ultimoReligar > RELIGAR_S * 1000) {
    ultimoReligar = Date.now();
    religarGps();
  }
}

function linhaDiag(item        , valor        , p        , nivel                           )       {
  const tr = document.querySelector             (`#diag tr[data-item="${item}"]`);
  if (!tr) return;
  tr.dataset.nivel = nivel;
  tr.querySelector(".valor") .textContent = valor;
  tr.querySelector             (".medidor span") .style.setProperty("--p", p.toFixed(3));
}

/** Nota 2: o anel do "Estou no trem" se fecha enquanto o GPS procura (até o vigia religar); o nó acende na linha. */
function estadoBotao()       {
  const b = $("btnTrem");
  const anel = b.querySelector            (".feito") ;
  const est = b.querySelector(".estado") ;
  if (vigia == null) { b.dataset.gps = "off"; anel.style.setProperty("--p", "0"); texto(b.querySelector(".rotulo") , "Estou no trem"); est.textContent = ""; return; }
  const bomS = ultimoBom ? (Date.now() - ultimoBom) / 1000 : null;
  if (bomS != null && bomS <= SILENCIO_S && naLinhaAgora) { b.dataset.gps = "ok"; anel.style.setProperty("--p", "1"); }
  else if (bomS != null && bomS > SILENCIO_S) { b.dataset.gps = "calado"; anel.style.setProperty("--p", "1"); }
  else if (bomS != null && !naLinhaAgora) { b.dataset.gps = "fora"; anel.style.setProperty("--p", "1"); }
  else { b.dataset.gps = "procurando"; anel.style.setProperty("--p", String(Math.min(1, (Date.now() - ultimoFix) / 1000 / RELIGAR_S))); }
  texto(b.querySelector(".rotulo") , "Segure para parar");
  texto(est               , b.dataset.gps === "ok" ? "Na linha, enviando" : b.dataset.gps === "calado" ? `GPS sem sinal há ${Math.round(bomS ?? 0)} s`
    : b.dataset.gps === "fora" ? "GPS ok, fora da linha do trem" : "Procurando o GPS");
}

/** Nota 2: segurar 1 s para confirmar; soltar antes cancela. Funciona com toque, mouse e teclado (Enter/Espaço). */
function segurar(btn             , acao            , ms = 1000, ativo                = () => true)       {
  let timer                = null;
  let inicio = 0;
  const comecar = (ev       ) => {
    if (timer != null || !ativo()) return;
    ev.preventDefault();
    inicio = Date.now();
    btn.classList.add("segurando");
    timer = window.setTimeout(() => {
      timer = null;
      btn.classList.remove("segurando");
      btn.classList.add("feito");
      navigator.vibrate?.(40);
      btn.dataset.segurou = "1"; // o "click" que vem ao soltar não deve repetir a ação
      acao();
      setTimeout(() => btn.classList.remove("feito"), 1200);
    }, ms);
  };
  const cancelar = () => {
    if (timer != null) {
      clearTimeout(timer); timer = null;
      // crítica: soltou no meio (dedo escorregou com o trem balançando) → avisa em vez de cancelar calado
      if (Date.now() - inicio > 200) btn.dispatchEvent(new CustomEvent("segurar-cancelado", { bubbles: true }));
    }
    btn.classList.remove("segurando");
  };
  btn.addEventListener("pointerdown", comecar);
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, cancelar);
  btn.addEventListener("keydown", (ev) => { if ((ev.key === "Enter" || ev.key === " ") && !ev.repeat) comecar(ev); });
  btn.addEventListener("keyup", (ev) => { if (ev.key === "Enter" || ev.key === " ") cancelar(); });
  btn.addEventListener("contextmenu", (ev) => ev.preventDefault()); // toque longo no celular não abre menu
}

function hora(ms        )         {
  return new Date(ms).toLocaleTimeString("pt-BR");
}

function textoRegistro()         {
  if (!reg) return "Sem viagem registrada.";
  const min = Math.round((Date.now() - reg.inicio) / 60000);
  const paradas = reg.paradas.map((p) => p.saida
    ? `${p.estacao} ${hora(p.chegada)}–${hora(p.saida)} (${Math.round((p.saida - p.chegada) / 1000)} s)`
    : `${p.estacao} desde ${hora(p.chegada)}`).join("; ");
  return [
    `Malha Viva · registro da viagem ${idViagem}`,
    `Início: ${new Date(reg.inicio).toLocaleString("pt-BR")} · duração: ${min} min · sentido marcado: ${sentido === "central" ? "Central" : "Santa Cruz"}`,
    `Aparelho: ${navigator.userAgent}`,
    `Posições do GPS: ${reg.fixes} · aceitas: ${reg.aceitos} · ruins (> ${PRECISAO_MAX_M} m): ${reg.ruins} · saltos: ${reg.saltos}`,
    `Precisão mediana: ${mediana(reg.precisoes) ?? "–"} m`,
    `Maior silêncio: ${reg.maiorSilencioS} s · silêncios > ${SILENCIO_S} s: ${reg.silencios.map((s) => `${s.inicio} (${s.s} s)`).join(", ") || "nenhum"}`,
    `GPS religado pelo vigia: ${reg.religados} vez(es) · rastreamento retomado após recarregar: ${reg.retomadas} vez(es)`,
    `Rodadas de envio: ${reg.envios} · com erro: ${reg.errosEnvio}`,
    `Paradas nas estações: ${paradas || "nenhuma detectada"}`,
  ].join("\n");
}

async function copiarRegistro()                {
  const t = textoRegistro();
  const b = $("btnRegistro");
  try {
    await navigator.clipboard.writeText(t);
    $("posStatus").textContent = "Registro copiado. Cole no WhatsApp ou numa nota.";
    b.classList.add("feito"); b.textContent = "Copiado";
    setTimeout(() => { b.classList.remove("feito"); b.textContent = "Copiar registro da viagem"; }, 2000);
  } catch { $("posStatus").textContent = t; }
}

/** A3: a viagem em andamento fica guardada no aparelho; recarregar a página retoma a mesma viagem. */
                                                                                   
let ultimaGravacao = 0;
let ultimoAntesDeRecarregar = 0; // `ultimo` da viagem retomada: só para medir o silêncio do recarregamento

/** Guarda a viagem e o registro a cada ~10 s: recarregar a página retoma os dois (19/11: o registro zerava). */
function salvarViagem(agora        )       {
  if (!reg) return;
  ultimaGravacao = agora;
  gravarLocal("mv_viagem", JSON.stringify({ id: idViagem, inicio: reg.inicio, ultimo: agora, reg }                      ));
}
const RETOMAR_MAX_MS = 10 * 60_000; // revisão: sem posição boa há mais de 10 min, a pessoa pode já ter saído do trem
const VIAGEM_MAX_MS = 4 * 3600_000;

function iniciar(retomar              )       {
  if (!("geolocation" in navigator)) { $("posStatus").textContent = "Este navegador não dá acesso à localização."; return; }
  idViagem = retomar?.id ?? "v-" + crypto.randomUUID().slice(0, 8); // código novo a cada viagem
  reg = novoRegistro();
  if (retomar) reg = { ...reg, ...retomar.reg, inicio: retomar.inicio, retomadas: (retomar.reg?.retomadas ?? 0) + 1 };
  ultimoBom = 0;
  // o recarregamento conta como silêncio; `ultimo` pode ser até 10 s antes da última posição boa
  ultimoAntesDeRecarregar = retomar?.ultimo ?? 0;
  salvarViagem(Date.now()); // com `ultimo`: recarregar de novo logo depois também retoma
  ultimoFix = Date.now(); // conta a espera pela primeira posição; se passar de 20 s, o vigia religa
  ultimaPrec = null;
  ultimoReligar = 0;
  ultimoAceito = null;
  saltosSeguidos = 0;
  ultimaEnfileirada = 0; // A13: a primeira posição sai na hora
  kmBruto = null;
  naLinhaAgora = false;
  suave = new Suavizador();
  detector = ramal ? new DetectorParada(ramal.base.estacoes) : null;
  sentidoErradoDesde = 0;
  ligarGps();
  void prenderTela();
  estadoBotao();
  rolouParaMim = false;
  $("btnTrem").setAttribute("aria-pressed", "true");
  $("btnRegistro").hidden = false;
  if (retomar) $("posStatus").textContent = "Rastreamento retomado depois de recarregar a página.";
}

function parar()       {
  if (vigia != null) navigator.geolocation.clearWatch(vigia);
  vigia = null;
  try { localStorage.removeItem("mv_viagem"); } catch { /* modo privado */ }
  void trava?.release();
  trava = null;
  naLinhaAgora = false;
  estadoBotao();
  $("btnTrem").setAttribute("aria-pressed", "false");
  $("btnTrocarSentido").hidden = true;
  desenharPosicao();
  void tique();
  void esvaziarTudo().finally(() => { if (recarregarDepois) location.reload(); }); // A2: versão nova entra agora
}

function viagemSalva()                     {
  try {
    const v = JSON.parse(lerLocal("mv_viagem") || "null")                      ;
    const ultimo = v?.ultimo ?? v?.inicio ?? 0;
    return v && typeof v.id === "string" && Date.now() - v.inicio < VIAGEM_MAX_MS && Date.now() - ultimo < RETOMAR_MAX_MS ? v : null;
  } catch { return null; }
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
  const estacao = $                   ("avisoEstacao").value;
  if (!estacao) { $("avisoStatus").textContent = "Escolha a estação antes de avisar. Sem rede, a lista de estações pode não ter carregado."; return; }
  if (!(await garantirTermo())) return;
  const aviso         = { estacao, sentido: NUM[sentido], tipo };
  let res                ;
  try { res = await sb.inserir("relatos", [aviso]); }
  catch {  // sem rede: guarda e envia depois
    await filaRel.adicionar(aviso);
    $("avisoStatus").textContent = "Aviso guardado. Será enviado quando a rede voltar.";
    return;
  }
  if (res === "rejeitado") {
    // limite de 10 por hora, ou sessão nova sem o aceite do termo: pede o termo de novo no próximo aviso
    gravarLocal("mv_termo", "");
    $("avisoStatus").textContent = "Aviso não aceito. O limite é de 10 avisos por hora; se ainda não chegou nele, tente de novo e aceite as regras.";
    return;
  }
  $("avisoStatus").textContent = `Aviso enviado: ${tipo} em ${estacao}.`;
  gravarLocal("mv_ultima_estacao", estacao);
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
  $("sosStatus").textContent = "Pegando sua localização…"; // crítica P2: retorno logo depois do gesto
  const texto = await textoSos();
  const quando = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const link = texto.match(/https:\/\/maps\.google\.com\/\?q=[-\d.,]+/)?.[0];
  const sl = $("sosLink");
  sl.hidden = !link;
  if (link) { sl.querySelector("a") .href = link; sl.querySelector("a") .textContent = `Sua localização às ${quando}`; }
  $("sosStatus").textContent = link ? `Localização das ${quando} pronta. Escolha para quem mandar.` : "Sem GPS agora. A mensagem vai sem a localização.";
  try {
    if (navigator.share) {
      await navigator.share({ text: texto });
      $("sosStatus").textContent = `Localização das ${quando} compartilhada. Segure de novo para mandar outra atualizada.`;
      return;
    }
  } catch { /* o iOS pode negar o compartilhar depois da espera do GPS: tenta copiar */ }
  try {
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
  const linha = L.polyline(ramal.base.linha.map(([lat, lon]) => [lat, lon]), { color: "#1E9E4A", weight: 7, opacity: 0.9 }).addTo(m);
  for (const e of ramal.base.estacoes) L.circleMarker([e.lat, e.lon], { radius: e.terminal ? 7 : 5, color: "#14532D", weight: 3, fillColor: "#F6F4EC", fillOpacity: 1 }).bindTooltip(e.nome).addTo(m);
  m.fitBounds(linha.getBounds(), { padding: [16, 16] });
  mapaL = { L, m, eu: null, trens: L.layerGroup().addTo(m) };
  mapaPronto = true;
  atualizarMapa();
}

/** Ponto (lat, lon) no km da linha: interpola o traçado. */
function pontoNoKm(km        )                          {
  const l = ramal?.base.linha;
  if (!l) return null;
  for (let i = 0; i < l.length - 1; i++) {
    const [a0, o0, k0] = l[i], [a1, o1, k1] = l[i + 1];
    if (km >= k0 && km <= k1) { const t = (km - k0) / (k1 - k0 || 1); return [a0 + t * (a1 - a0), o0 + t * (o1 - o0)]; }
  }
  return null;
}

                                                        
let mapaL                  = null;

/** Nota 2 · Fase 3: no mapa, você (nó aceso) e os trens (verde-escuro; tracejado quando estimado), a cada segundo. */
function atualizarMapa()       {
  if (!mapaL || $("mapa").hidden) return;
  const { L, m } = mapaL;
  const eu = meuKm != null ? pontoNoKm(meuKm) : null;
  if (eu && !mapaL.eu) {
    mapaL.eu = L.circleMarker(eu, { radius: 10, color: "#14532D", weight: 4, fillColor: "#4ADE80", fillOpacity: 1 }).bindTooltip("Você").addTo(m);
    m.setView(eu, 14); // a primeira vez que você aparece, o mapa vai até você
  }
  else if (eu) mapaL.eu.setLatLng(eu);
  else if (mapaL.eu) { mapaL.eu.remove(); mapaL.eu = null; }
  mapaL.trens.clearLayers();
  for (const t of trens) {
    const p = pontoNoKm(kmTremAgora(t));
    if (p) L.circleMarker(p, { radius: 8, color: "#4ADE80", weight: 3, dashArray: t.estimado ? "4 4" : undefined,
      fillColor: "#14532D", fillOpacity: t.estimado ? 0.4 : 1 }).bindTooltip(rotuloTrem(t)).addTo(mapaL.trens);
  }
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
  // crítica P1: tocar liga; para parar, segurar 1 s (um toque sem querer no trem não encerra a viagem)
  $("btnTrem").addEventListener("click", () => {
    const b = $("btnTrem");
    if (b.dataset.segurou) { delete b.dataset.segurou; return; }
    if (vigia == null) iniciar(); else $("posStatus").textContent = "Para parar, segure o botão por 1 segundo.";
  });
  segurar($("btnTrem"), () => parar(), 1000, () => vigia != null);
  document.addEventListener("segurar-cancelado", (ev) => {
    const alvo = ev.target               ;
    const msg = "Soltou antes de encher. Segure até o fim para confirmar.";
    if (alvo.id === "btnTrem") $("posStatus").textContent = msg;
    else if (alvo.id === "btnSos") $("sosStatus").textContent = msg;
    else $("avisoStatus").textContent = msg;
  });
  $("avisoEstacao").addEventListener("change", () => { avisoManual = true; });
  $("destino").addEventListener("change", () => atualizarEta());
  $("btnMapa").addEventListener("click", () => void abrirMapa());
  for (const b of document.querySelectorAll             ("[data-tipo]")) segurar(b, () => void enviarAviso(b.dataset.tipo ));
  segurar($("btnSos"), () => void compartilharSos());
  $("btnSos").addEventListener("pointerdown", () => void minhaPosicao()); // GPS começa já no toque: o compartilhar sai logo após 1 s
  $("btnSol").addEventListener("click", () => modoSol(!document.documentElement.hasAttribute("data-sol")));
  $("btnGuiaOk").addEventListener("click", () => { $("guiaIphone").hidden = true; gravarLocal("mv_guia", "1"); });
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
  $("btnTrocarSentido").addEventListener("click", () => trocarSentido());
}

/** Nota 2: alto contraste para a tela perto da janela do trem. */
function modoSol(ligado         )       {
  if (ligado) document.documentElement.setAttribute("data-sol", ""); else document.documentElement.removeAttribute("data-sol");
  $("btnSol").setAttribute("aria-pressed", String(ligado));
  gravarLocal("mv_sol", ligado ? "1" : "");
}

/** Nota 2: guia de instalação só no iPhone, no Safari (fora do app instalado), até a pessoa tocar em "Entendi". */
function mostrarGuia()       {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const instalado = (navigator                                       ).standalone || matchMedia("(display-mode: standalone)").matches;
  $("guiaIphone").hidden = !(ios && !instalado && !lerLocal("mv_guia"));
}

async function comecar()                {
  ligar();
  modoSol(lerLocal("mv_sol") === "1");
  mostrarGuia();
  mostrar(lerLocal("mv_aba") || "radar");
  desenharContatos();
  setInterval(() => void tique(), 1000);
  try {
    ramal = new Ramal(await (await fetch("base.json", { signal: AbortSignal.timeout?.(5000) })).json()        );
    $("ramal").textContent = `Ramal ${ramal.base.ramal}`;
  } catch {
    $("ramal").textContent = "Sem rede e sem dados guardados do ramal.";
  }
  preencherSelects();
  desenharFaixa();
  atualizarEta();
  const salva = viagemSalva();
  if (salva) iniciar(salva); // A3: a página recarregou no meio da viagem
  await Promise.all([carregarAlertas(), carregarTrens(), esvaziarTudo()]);
  setInterval(() => { if (document.visibilityState === "visible") void carregarAlertas(); }, 30_000);
  setInterval(() => { if (document.visibilityState === "visible") void carregarTrens(); }, TRENS_MS);
  if ("serviceWorker" in navigator) {
    // Versão nova do app: quando o SW novo assume, recarrega uma vez para não rodar o JS velho do cache.
    // Na primeira instalação não há SW anterior, então não recarrega.
    const tinhaAnterior = !!navigator.serviceWorker.controller;
    // A2: com "Estou no trem" ligado, não recarrega; a versão nova entra quando a pessoa tocar em "Parar".
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!tinhaAnterior) return;
      if (vigia != null) recarregarDepois = true; else location.reload();
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  }
}

void comecar();
