/** Malha Viva · PWA: radar do ramal, aviso rápido, SOS. Grava no Supabase (Fase 4, desenho A). */
import { TURNSTILE_SITE, VERSAO_TERMO } from "./config.js";
import { ArmazemMemoria, Fila,                                   } from "./fila.js";
import { ArmazemIDB } from "./idb.js";
import { Ramal,                         } from "./ramal.js";
import { Rastreio,                                } from "./rastreio.js";
import * as R from "./regras.js";
import { Supabase } from "./supabase.js";

                                                                                                                           
// sentido 0 = parado; null = ainda sem direção; estimado = buraco de sinal (visão 0005+);
// aproximado = trem com 1 pessoa, só o trecho (0011, privacidade)
                                                                                                            
                                                                     
                                                                 
                                        
                                                           

const $ =                        (id        ) => document.getElementById(id)     ;
const TRENS_MS = 10_000; // leitura do radar; 100 pessoas olhando ≈ 36 mil leituras/h, dentro do egress grátis (~1 KB cada)
const ATRASO_MAX_MS = 6 * 3600_000 - 5 * 60_000; // A8: o banco ignora acima de 6 h; aqui descarta um pouco antes
const NUM                          = { central: 1, santa_cruz: -1 };
const NOME                          = { central: "Central", santa_cruz: "Santa Cruz" };
const ABAS = ["radar", "avisar", "sos"];
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

// ---------------------------------------------------------------- estado
let ramal               = null;
let sentido          = (lerLocal("mv_sentido")           ) || "central";
let meuKm                = null;
let alertas           = [];
let trens         = [];
let trensLidosEm = 0;
let vigia                = null;
let trava                          = null;
let versaoApp = "sem-cache";
let ultimoEnvio = 0;                  // RAS-10
let ultimoReligar = 0;
let sentidoErradoDesde = 0;           // A11
let sentidoManualNaViagem = false;    // RAS-35: a pessoa trocou o sentido nesta viagem
let recarregarDepois = false;         // A2: versão nova espera o "Parar"
let rolouParaMim = false;             // crítica: rolar até "você" só uma vez por viagem
let avisoManual = false;              // crítica: a pessoa escolheu a estação do aviso; não trocar sozinho
let alarmeDe = "";                    // FRO-54: destino para o qual o alarme já tocou nesta viagem

function lerLocal(k        )                {
  try { return localStorage.getItem(k); } catch { return null; }
}
function gravarLocal(k        , v        )       {
  try { localStorage.setItem(k, v); } catch { /* modo privado: segue sem guardar */ }
}
function apagarLocal(k        )       {
  try { localStorage.removeItem(k); } catch { /* modo privado */ }
}

const rastreio = new Rastreio(null, { ler: lerLocal, gravar: gravarLocal, apagar: apagarLocal });

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
  // B2: hora do aparelho no envio; o gatilho da 0009 compara com a do servidor e corrige `t` de relógio errado.
  // As colunas `relogio` (0009), `km_app` e `versao` (0010) precisam estar no banco ANTES de publicar.
  // Todas as linhas com as mesmas chaves: o PostgREST recusa lote com chaves diferentes (itens de versões antigas na fila).
  const relogio = new Date().toISOString();
  return frescas.length
    ? sb.inserir("posicoes", frescas.map((p) => ({ ...p, km_app: p.km_app ?? null, versao: p.versao ?? versaoApp.slice(0, 20), relogio })))
    : "rejeitado";
}, { aoRejeitar: () => void registrarErro(`posição recusada: ${sb.ultimaRecusa}`) });

const filaRel = new Fila        (armazem("relatos"), (lote) => sb.inserir("relatos", lote),
  { aoRejeitar: () => void registrarErro(`aviso recusado: ${sb.ultimaRecusa}`) });

// Nota 3 · M4: erros do app vão para `erros_app` (versão do cache, aparelho resumido, mensagem). No máximo 5 por abertura.
let errosEnviados = 0;
async function registrarErro(msg        )                {
  if (errosEnviados >= 5) return;
  errosEnviados += 1;
  try {
    await sb.inserir("erros_app", [{ versao: versaoApp.slice(0, 20), aparelho: navigator.userAgent.slice(0, 120), mensagem: msg.slice(0, 300) }]);
  } catch { /* sem rede: o erro não é guardado (não vale encher a fila) */ }
}
addEventListener("error", (e) => void registrarErro(`${e.message} em ${String(e.filename).split("/").pop()}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => void registrarErro(`promessa: ${(e.reason         )?.message ?? String(e.reason)}`));

async function esvaziarTudo()                {
  ultimoEnvio = Date.now();
  const [rp] = await Promise.all([filaPos.esvaziar(), filaRel.esvaziar()]);
  if (rp.enviados || rp.rejeitados || rp.erro) rastreio.rodadaEnvio(!!rp.erro);
  const n = (await filaPos.tamanho()) + (await filaRel.tamanho());
  $("rede").querySelector(".txt") .textContent = navigator.onLine ? (n ? `${n} na fila` : "Ao vivo") : (n ? `Sem rede, ${n} na fila` : "Sem rede");
  $("rede").dataset.estado = navigator.onLine ? (n ? "fila" : "ok") : "off";
}

/** RAS-10: envia em lote (5 posições ou 10 s), não a cada posição. O tique cobre o "10 s" sem posição nova. */
async function agendarEnvio()                {
  if ((await filaPos.tamanho()) >= R.LOTE_MIN || Date.now() - ultimoEnvio >= R.ENVIO_MAX_MS) await esvaziarTudo();
}

// ---------------------------------------------------------------- radar (faixa da linha)
function estacoesNoSentido()            {
  const es = [...(ramal?.base.estacoes ?? [])];
  return sentido === "central" ? es.reverse() : es; // destino no topo
}

function idadeS(iso        )         {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
}

function idade(iso        )         {
  const s = idadeS(iso);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** A9 + RAS-12: o trem anda na tela entre uma leitura e outra (até 60 s), sem passar da próxima estação. */
function kmTremAgora(t      )         {
  if (!t.sentido || t.aproximado) return t.km;
  const dt = Math.min(60, Math.max(0, (Date.now() - trensLidosEm) / 1000));
  const km = t.km + t.sentido * (t.velocidade_kmh || 0) / 3600 * dt;
  return ramal ? ramal.limitarNaEstacao(t.km, km, t.sentido          ) : km;
}

/** FRO-52: o trem envelhece na tela (normal, velho, antigo) e o estimado fica tracejado. */
function classeTrem(t      )         {
  const s = idadeS(t.visto_em);
  return "trem" + (t.estimado ? " estimado" : "") + (t.aproximado ? " aproximado" : "") + (s > 90 ? " antigo" : s > 30 ? " velho" : "");
}

function rotuloTrem(t      )         {
  const quem = t.pessoas > 1 ? `, ${t.pessoas} pessoas` : "";
  const s = idadeS(t.visto_em);
  if (t.aproximado && ramal) {
    const es = ramal.base.estacoes, i = Ramal.trechoDe(es, t.km);
    return i >= 0 ? `Trem entre ${es[i].nome} e ${es[i + 1].nome}` : "Trem neste trecho";
  }
  if (t.sentido === 0) {
    const min = t.parado_s != null ? Math.round(t.parado_s / 60) : 0;
    return `Trem parado${min >= 1 ? ` há ${min} min` : ""}${quem}`;
  }
  if (s > 90) return `Trem, último sinal há ${idade(t.visto_em)}${quem}`;
  return `${t.estimado ? "Trem (posição estimada)" : "Trem"}, visto há ${idade(t.visto_em)}${quem}`;
}

function marcasDoRadar()          {
  const ms          = trens
    .filter((t) => t.sentido === 0 || t.sentido === NUM[sentido])
    .map((t) => ({ km: kmTremAgora(t), classe: classeTrem(t), texto: rotuloTrem(t) }));
  if (meuKm != null) ms.push({ km: meuKm, classe: "eu" + (rastreio.estimado() ? " estimado" : ""),
    texto: rastreio.estimado() ? "Você está aqui (estimado)" : "Você está aqui" });
  return ms;
}

/**
 * FRO-50: a faixa só é refeita quando muda a estrutura (sentido, avisos, em que trecho cada marca está, classes).
 * A cada segundo, só o texto das marcas muda: o foco do teclado e o leitor de tela não perdem o lugar.
 */
let faixaCompleta = false;
let estruturaFaixa = "";
function desenharFaixa(forcar = false)       {
  const ol = $("faixa");
  const es = estacoesNoSentido();
  const porTrecho = new Map                 ();
  for (const m of marcasDoRadar()) {
    const i = Ramal.trechoDe(es, m.km);
    if (i >= 0) porTrecho.set(i, [...(porTrecho.get(i) ?? []), m]);
  }
  for (const [i, ms] of porTrecho) ms.sort((a, b) => Math.abs(a.km - es[i].km) - Math.abs(b.km - es[i].km));
  const ordem = es.flatMap((_, i) => porTrecho.get(i) ?? []);
  const avisosSentido = alertas.filter((a) => a.sentido === NUM[sentido]);
  const estrutura = JSON.stringify([sentido, faixaCompleta, es.length, avisosSentido.map((a) => [a.estacao, a.tipo, a.pessoas, a.confirmado]),
    [...porTrecho].map(([i, ms]) => [i, ms.map((m) => m.classe)])]);
  if (!forcar && estrutura === estruturaFaixa) {
    ol.querySelectorAll             (".trem, .eu").forEach((el, k) => { if (ordem[k]) texto(el, ordem[k].texto); });
    marcarFeito(ol);
    return;
  }
  estruturaFaixa = estrutura;
  ol.replaceChildren();
  const porEstacao = new Map                  ();
  for (const a of avisosSentido) porEstacao.set(a.estacao, [...(porEstacao.get(a.estacao) ?? []), a]);
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
    for (const m of porTrecho.get(i) ?? []) {
      const marca = document.createElement("li");
      marca.className = m.classe;
      marca.textContent = m.texto;
      ol.append(marca);
    }
  });
  resumirFaixa(ol);
  marcarFeito(ol);
}

/** Nota 2: o trilho se preenche da origem (embaixo) até o nó aceso. */
function marcarFeito(ol             )       {
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
    b.addEventListener("click", () => { faixaCompleta = true; desenharFaixa(true); });
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

function horaDaqui(seg        )         {
  return new Date(Date.now() + seg * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Nota 2: barra do trecho atual e tabela das próximas estações. FRO-54: alarme uma estação antes do destino. */
function atualizarChegadas()       {
  const trecho = $("trecho"), bloco = $("blocoChegadas");
  if (meuKm == null || !ramal) { trecho.hidden = true; bloco.hidden = true; texto($("avisoOnde"), ""); return; }
  const s = NUM[sentido], km = meuKm;
  const es = ramal.base.estacoes;
  const frente = es.filter((e) => (e.km - km) * s > R.ESTACAO_FRENTE_KM).sort((a, b) => (a.km - b.km) * s);
  const tras = es.filter((e) => (e.km - km) * s <= R.ESTACAO_FRENTE_KM).sort((a, b) => (b.km - a.km) * s);
  const de = tras[0], para = frente[0];
  // crítica P1: o aviso vai, por padrão, para a próxima estação do trecho, não para o destino
  if (para && !avisoManual) $                   ("avisoEstacao").value = para.nome;
  texto($("avisoOnde"), de && para ? `Você está entre ${de.nome} e ${para.nome}. O aviso vai para ${$                   ("avisoEstacao").value}.` : "");
  if (de && para) {
    const p = Math.min(1, Math.max(0, Math.abs(km - de.km) / (Math.abs(para.km - de.km) || 1)));
    texto($("trechoDe"), de.nome);
    texto($("trechoPara"), para.nome);
    $("trechoBarra").style.setProperty("--p", String(p));
    trecho.querySelector(".barra") .setAttribute("aria-valuenow", String(Math.round(p * 100)));
    trecho.hidden = false;
  } else trecho.hidden = true;
  const destino = $                   ("destino").value;
  // FRO-54: próxima estação = destino → vibra e avisa uma vez por viagem
  const alarme = $("alarme");
  if (para && destino && para.nome === destino && alarmeDe !== destino) {
    alarmeDe = destino;
    navigator.vibrate?.([300, 150, 300]);
    alarme.textContent = `Próxima: ${destino}. Prepare-se para descer.`;
    alarme.hidden = false;
  } else if (alarme.hidden === false && (!para || para.nome !== destino)) alarme.hidden = true;
  const linhas = frente.slice(0, 5).map((e) => ({ e, seg: ramal .eta(km, s, e.nome) ?? 0 }));
  const assinatura = linhas.map((l) => `${l.e.nome}:${Math.round(l.seg / 30)}`).join("|") + destino;
  if (bloco.dataset.assinatura !== assinatura) { // FRO-50: a tabela também só é refeita quando muda
    bloco.dataset.assinatura = assinatura;
    const max = Math.max(1, ...linhas.map((l) => l.seg));
    $("tabChegadas").replaceChildren(...linhas.map((l, i) => {
      const tr = document.createElement("tr");
      if (i === 0) tr.className = "proxima";
      if (l.e.nome === destino) tr.classList.add("destino");
      const td = (t        ) => { const c = document.createElement("td"); c.textContent = t; return c; };
      const barra = document.createElement("td");
      barra.innerHTML = `<div class="barra" aria-hidden="true"><span style="--p:${(l.seg / max).toFixed(3)}"></span></div>`;
      tr.append(td(l.e.nome), td(`${minutos(l.seg)} (${horaDaqui(l.seg)})`), barra);
      return tr;
    }));
  }
  bloco.hidden = !linhas.length;
}

function resumoTrens()       {
  const n = trens.filter((t) => t.sentido === 0 || t.sentido === NUM[sentido]).length;
  const lido = trensLidosEm ? ` Atualizado há ${idade(new Date(trensLidosEm).toISOString())}.` : "";
  texto($("trens"), (n ? `${n} ${n > 1 ? "trens" : "trem"} no radar neste sentido.`
    : "Nenhum trem no radar neste sentido ainda.") + lido);
}

async function carregarTrens()                {
  try {
    trens = await sb.ler        ("trens_ao_vivo?select=*");
    trensLidosEm = Date.now();
    desenharFaixa();
  } catch { /* offline: mantém os últimos; o "atualizado há" mostra a idade */ }
  resumoTrens();
}

/**
 * FRO-53: "Estou na estação". Quem espera na plataforma vê quando chega o próximo trem do radar,
 * pelos trens que vêm na direção da estação e pelos tempos dos trechos.
 */
function atualizarEspera()       {
  const bloco = $("blocoEspera");
  bloco.hidden = vigia != null || !ramal;
  if (bloco.hidden || !ramal) return;
  const est = $                   ("minhaEstacao").value;
  const s = NUM[sentido];
  if (!est) return;
  let melhor                                  = null;
  for (const t of trens) {
    if (t.sentido !== s) continue;
    const seg = ramal.eta(kmTremAgora(t), s, est);
    if (seg != null && (!melhor || seg < melhor.seg)) melhor = { seg, t };
  }
  texto($("proximoTrem"), melhor
    ? `Próximo trem no radar: chega em ${est} em cerca de ${minutos(melhor.seg)} (${horaDaqui(melhor.seg)}).`
      + `${melhor.t.aproximado ? " Posição aproximada." : ` Visto há ${idade(melhor.t.visto_em)}.`}`
    : `Nenhum trem no radar vindo para ${est} agora. O radar só vê trens com alguém usando o Malha Viva.`);
}

function preencherSelects()       {
  for (const id of ["destino", "avisoEstacao", "minhaEstacao"]) {
    const sel = $                   (id);
    const atual = sel.value;
    sel.replaceChildren(...estacoesNoSentido().map((e) => new Option(e.nome, e.nome)));
    if (atual) sel.value = atual;
    else if (id === "avisoEstacao" && lerLocal("mv_ultima_estacao")) sel.value = lerLocal("mv_ultima_estacao") ; // sem GPS: a última avisada
    else if (id === "minhaEstacao" && lerLocal("mv_minha_estacao")) sel.value = lerLocal("mv_minha_estacao") ;
  }
}

function atualizarEta()       {
  const destino = $                   ("destino").value;
  const saida = $("eta");
  atualizarChegadas();
  saida.classList.toggle("vazio", meuKm == null || !destino || !ramal);
  if (meuKm == null || !destino || !ramal) {
    texto(saida, vigia != null && rastreio.ultimoBom && !rastreio.naLinha ? "Você parece estar fora da linha do trem. A chegada aparece quando a posição cair na linha."
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
      if (vigia == null) return;
      rastreio.travaPerdida(); // RAS-13
      if (document.visibilityState === "visible") void prenderTela();
    });
  } catch { trava = null; }
}

/** Número válido do GPS ou null (o iOS manda NaN ou -1 quando não sabe). */
function valido(x                           , min        , max        )                {
  return x == null || Number.isNaN(x) || x < min || x > max ? null : x;
}

function aoReceber(p                     )       {
  const c = p.coords;
  const pos = rastreio.receber({ t: p.timestamp, lat: c.latitude, lon: c.longitude, prec: c.accuracy,
    vel: valido(c.speed, 0, 100), rumo: valido(c.heading, 0, 360), alt: valido(c.altitude, -500, 9000) });
  if (ramal && c.accuracy <= R.PRECISAO_MAX_M) {
    texto($("posStatus"), rastreio.naLinha ? "Posição na linha do trem." : "Você parece estar fora da linha do trem.");
    if (rastreio.naLinha) { sentidoAutomatico(); conferirSentido(); pulso(); }
  }
  desenharPosicao();
  if (pos) void filaPos.adicionar(pos).then(agendarEnvio)
    .catch((e) => void registrarErro(`fila de posições: ${(e         )?.message ?? e}`));
}

/** FRO-61: o nó do botão pisca uma vez a cada posição boa, em vez de piscar sem parar. */
function pulso()       {
  const no = $("btnTrem").querySelector(".anel .no");
  no?.classList.remove("pulso");
  void (no                     )?.getBoundingClientRect();
  no?.classList.add("pulso");
}

/** A9: o "Você está aqui" anda a cada segundo pela velocidade, entre uma posição e outra. */
function desenharPosicao()       {
  meuKm = vigia != null ? rastreio.kmAgora() : null;
  desenharFaixa();
  atualizarEta();
  // crítica P2: na primeira posição na linha, a tela vai até "você" (uma vez por viagem)
  const eu = document.querySelector             ("#faixa .eu");
  if (eu && !rolouParaMim && !document.querySelector             ("[data-aba=radar]") .hidden) {
    rolouParaMim = true;
    eu.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

/** Troca o sentido (radio, listas e radar). `pessoa` = a pessoa tocou: o GPS não troca mais sozinho nesta viagem. */
function mudarSentido(novo         , pessoa         )       {
  sentido = novo;
  const r = document.querySelector                  (`input[name=sentido][value=${novo}]`);
  if (r) r.checked = true;
  if (pessoa && vigia != null) sentidoManualNaViagem = true;
  gravarLocal("mv_sentido", sentido);
  preencherSelects(); desenharFaixa(true); resumoTrens(); atualizarEta();
}

/** RAS-35: depois de 1 km na linha, o sentido é escolhido pelo GPS (se a pessoa não escolheu nesta viagem). */
function sentidoAutomatico()       {
  if (sentidoManualNaViagem) return;
  const real = rastreio.sentidoPeloTrajeto(1);
  if (!real || real === NUM[sentido]) return;
  mudarSentido(real === 1 ? "central" : "santa_cruz", false);
  sentidoManualNaViagem = true; // uma vez só: daqui em diante, só o botão de sugestão
  texto($("posStatus"), `Sentido ajustado pelo GPS: indo para ${real === 1 ? "a Central" : "Santa Cruz"}.`);
}

/** A11: o km dizendo um sentido por 60 s e o usuário marcado no outro → oferece a troca. */
function conferirSentido()       {
  const real = rastreio.filtro.sentido();
  const btn = $("btnTrocarSentido");
  if (real === 0 || real === NUM[sentido]) { sentidoErradoDesde = 0; btn.hidden = true; return; }
  sentidoErradoDesde ||= Date.now();
  if (Date.now() - sentidoErradoDesde < 60_000) return;
  btn.textContent = `Parece que você está indo para ${real === 1 ? "a Central" : "Santa Cruz"}. Trocar o sentido`;
  btn.dataset.para = real === 1 ? "central" : "santa_cruz";
  btn.hidden = false;
}

function trocarSentido()       {
  const para = $("btnTrocarSentido").dataset.para                       ;
  if (!para) return;
  mudarSentido(para, true);
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
  rastreio.religado();
  ligarGps();
}

/** Roda a cada segundo: diagnóstico, vigia do GPS, posições andando na tela e envio em lote. */
async function tique()                {
  if (document.visibilityState !== "visible") return;
  if (vigia != null || trens.length) desenharPosicao();
  atualizarMapa();
  atualizarEspera();
  estadoBotao();
  vigiarGps();
  const d = $("diag");
  const reg = rastreio.reg;
  if (!reg) { d.hidden = true; return; }
  d.hidden = false;
  const bomS = rastreio.ultimoBom ? Math.round((Date.now() - rastreio.ultimoBom) / 1000) : null;
  const fila = await filaPos.tamanho().catch(() => 0);
  if (fila && Date.now() - ultimoEnvio >= R.ENVIO_MAX_MS) void esvaziarTudo(); // RAS-10
  const prec = rastreio.ultimaPrec;
  // Nota 2: cada medida com valor, barra e cor (verde / âmbar / vermelho)
  linhaDiag("bom", bomS == null ? "esperando" : `há ${bomS} s`, bomS == null ? 1 : Math.min(1, bomS / R.SILENCIO_S),
    bomS == null || bomS > R.SILENCIO_S ? "ruim" : bomS > 10 ? "atencao" : "ok");
  linhaDiag("prec", prec == null ? "–" : `${prec} m`, prec == null ? 0 : Math.min(1, prec / R.PRECISAO_MAX_M),
    prec == null ? "ok" : prec > R.PRECISAO_MAX_M ? "ruim" : prec > 50 ? "atencao" : "ok");
  linhaDiag("fila", `${fila}`, Math.min(1, fila / 30), fila > 30 ? "ruim" : fila > 5 ? "atencao" : "ok");
  linhaDiag("silencios", `${reg.silencios.length}`, Math.min(1, reg.silencios.length / 5), reg.silencios.length ? "atencao" : "ok");
  d.dataset.estado = vigia != null && (bomS == null || bomS > R.SILENCIO_S) ? "alerta" : "ok";
  if (d.dataset.estado === "alerta" && vigia != null && bomS != null) ($("diagDet")                      ).open = true;
}

/** Vigia: GPS calado por 20 s → religa. */
function vigiarGps()       {
  const caladoS = (Date.now() - rastreio.ultimoFix) / 1000;
  if (vigia != null && caladoS > R.RELIGAR_S && Date.now() - ultimoReligar > R.RELIGAR_S * 1000) {
    ultimoReligar = Date.now();
    religarGps();
  }
}

function linhaDiag(item        , valor        , p        , nivel                           )       {
  const tr = document.querySelector             (`#diag tr[data-item="${item}"]`);
  if (!tr) return;
  tr.dataset.nivel = nivel;
  texto(tr.querySelector             (".valor") , valor);
  tr.querySelector             (".medidor span") .style.setProperty("--p", p.toFixed(3));
}

/** Nota 2: o anel do "Estou no trem" se fecha enquanto o GPS procura (até o vigia religar); o nó acende na linha. */
function estadoBotao()       {
  const b = $("btnTrem");
  const anel = b.querySelector            (".feito") ;
  const est = b.querySelector             (".estado") ;
  if (vigia == null) { b.dataset.gps = "off"; anel.style.setProperty("--p", "0"); texto(b.querySelector             (".rotulo") , "Estou no trem"); texto(est, ""); return; }
  const bomS = rastreio.ultimoBom ? (Date.now() - rastreio.ultimoBom) / 1000 : null;
  if (bomS != null && bomS <= R.SILENCIO_S && rastreio.naLinha) { b.dataset.gps = "ok"; anel.style.setProperty("--p", "1"); }
  else if (bomS != null && bomS > R.SILENCIO_S) { b.dataset.gps = "calado"; anel.style.setProperty("--p", "1"); }
  else if (bomS != null && !rastreio.naLinha) { b.dataset.gps = "fora"; anel.style.setProperty("--p", "1"); }
  else { b.dataset.gps = "procurando"; anel.style.setProperty("--p", String(Math.min(1, (Date.now() - rastreio.ultimoFix) / 1000 / R.RELIGAR_S))); }
  texto(b.querySelector             (".rotulo") , "Segure para parar");
  texto(est, b.dataset.gps === "ok" ? "Na linha, enviando" : b.dataset.gps === "calado" ? `GPS sem sinal há ${Math.round(bomS ?? 0)} s`
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

async function copiarRegistro()                {
  const t = rastreio.texto(NOME[sentido], navigator.userAgent);
  const b = $("btnRegistro");
  try {
    await navigator.clipboard.writeText(t);
    $("posStatus").textContent = "Registro copiado. Cole no WhatsApp ou numa nota.";
    b.classList.add("feito"); b.textContent = "Copiado";
    setTimeout(() => { b.classList.remove("feito"); b.textContent = "Copiar registro da viagem"; }, 2000);
  } catch { $("posStatus").textContent = t; }
}

function iniciar(retomar              )       {
  if (!("geolocation" in navigator)) { $("posStatus").textContent = "Este navegador não dá acesso à localização."; return; }
  $("retomar").hidden = true;
  rastreio.versao = versaoApp;
  rastreio.iniciar(retomar, () => "v-" + crypto.randomUUID().slice(0, 8)); // código novo a cada viagem
  ultimoReligar = 0;
  ultimoEnvio = 0;          // A13: a primeira posição sai na hora
  sentidoErradoDesde = 0;
  sentidoManualNaViagem = !!retomar; // na retomada, o sentido já foi decidido
  avisoManual = false;      // FRO-12: a estação do aviso volta a seguir o trem
  alarmeDe = "";
  rolouParaMim = false;
  ligarGps();
  void prenderTela();
  estadoBotao();
  $("btnTrem").setAttribute("aria-pressed", "true");
  $("btnRegistro").hidden = false;
  if (retomar) $("posStatus").textContent = "Rastreamento retomado depois de recarregar a página.";
}

function parar()       {
  if (vigia != null) navigator.geolocation.clearWatch(vigia);
  vigia = null;
  rastreio.parar();
  void trava?.release();
  trava = null;
  estadoBotao();
  $("btnTrem").setAttribute("aria-pressed", "false");
  $("btnTrocarSentido").hidden = true;
  $("alarme").hidden = true;
  desenharPosicao();
  void tique();
  void esvaziarTudo().finally(() => { if (recarregarDepois) location.reload(); }); // A2: versão nova entra agora
}

/** RAS-15: a viagem salva está velha demais para retomar sozinha: pergunta. */
function oferecerRetomada(v             )       {
  const box = $("retomar");
  const ultimo = v.ultimo ?? v.inicio;
  texto($("retomarTexto"), `Você tem uma viagem começada às ${new Date(v.inicio).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}, `
    + `sem posição há ${Math.round((Date.now() - ultimo) / 60000)} min. Continuar essa viagem?`);
  box.hidden = false;
  $("btnRetomar").onclick = () => iniciar(v);
  $("btnOutra").onclick = () => { rastreio.descartarSalva(); box.hidden = true; };
}

// ---------------------------------------------------------------- aviso rápido (termo no primeiro aviso)
/** FRO-56: o termo abre numa caixa com o texto e o link para a página de privacidade (era um confirm()). */
function perguntarTermo()                   {
  const dlg = $                   ("dlgTermo");
  if (typeof dlg.showModal !== "function") return Promise.resolve(confirm($("dlgTermoTexto").innerText + "\n\nAceita?"));
  return new Promise((ok) => {
    dlg.returnValue = "";
    dlg.addEventListener("close", () => ok(dlg.returnValue === "aceito"), { once: true });
    dlg.showModal();
  });
}

async function garantirTermo()                   {
  if (lerLocal("mv_termo") === VERSAO_TERMO) return true;
  if (!(await perguntarTermo())) return false;
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

/** FRO-11: no iPhone o corpo do SMS vai com "&body="; nos outros, "?body=". */
function linkSms(tel        , corpo        )         {
  return `sms:${tel}${IOS ? "&" : "?"}body=${encodeURIComponent(corpo)}`;
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
      location.href = linkSms(tel, await textoSos());
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
  return `Preciso de ajuda. Estou no trem do ramal Santa Cruz, sentido ${NOME[sentido]}. ${onde}`;
}

async function compartilharSos()                {
  $("sosStatus").textContent = "Pegando sua localização…"; // crítica P2: retorno logo depois do gesto
  const msg = await textoSos();
  const quando = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const link = msg.match(/https:\/\/maps\.google\.com\/\?q=[-\d.,]+/)?.[0];
  const sl = $("sosLink");
  sl.hidden = !link;
  if (link) { sl.querySelector("a") .href = link; sl.querySelector("a") .textContent = `Sua localização às ${quando}`; }
  $("sosStatus").textContent = link ? `Localização das ${quando} pronta. Escolha para quem mandar.` : "Sem GPS agora. A mensagem vai sem a localização.";
  try {
    if (navigator.share) {
      await navigator.share({ text: msg });
      $("sosStatus").textContent = `Localização das ${quando} compartilhada. Segure de novo para mandar outra atualizada.`;
      return;
    }
  } catch { /* o iOS pode negar o compartilhar depois da espera do GPS: tenta copiar */ }
  try {
    await navigator.clipboard.writeText(msg);
    $("sosStatus").textContent = "Mensagem copiada. Cole no WhatsApp ou SMS.";
  } catch {
    $("sosStatus").textContent = msg;
  }
}

// ---------------------------------------------------------------- mapa (sob demanda, poupa dados)
                                                          
let mapaL                  = null;
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
  mapaL = { L, m, eu: null, trens: [] };
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

/** Nota 2 · Fase 3 + FRO-51: no mapa, você e os trens. Os marcadores são movidos, não recriados a cada segundo. */
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
  const pontos = trens.map((t) => ({ t, p: pontoNoKm(kmTremAgora(t)) })).filter((x) => x.p);
  while (mapaL.trens.length > pontos.length) mapaL.trens.pop().remove();
  pontos.forEach(({ t, p }, i) => {
    const estilo = { radius: 8, color: "#4ADE80", weight: 3, dashArray: t.estimado || t.aproximado ? "4 4" : undefined,
      fillColor: "#14532D", fillOpacity: t.estimado || t.aproximado || idadeS(t.visto_em) > 30 ? 0.4 : 1 };
    let mk = mapaL .trens[i];
    if (!mk) { mk = L.circleMarker(p, estilo).bindTooltip("").addTo(m); mapaL .trens.push(mk); }
    else { mk.setLatLng(p); mk.setStyle(estilo); }
    mk.setTooltipContent(rotuloTrem(t));
  });
}

// ---------------------------------------------------------------- navegação e início
function abaDaUrl()                {
  const h = location.hash.slice(1);
  return ABAS.includes(h) ? h : null;
}

/** FRO-55: cada aba entra no histórico; o "voltar" do Android troca de aba em vez de fechar o app. */
function mostrar(aba        , empurrar = false)       {
  for (const s of document.querySelectorAll             ("[data-aba]")) s.hidden = s.dataset.aba !== aba;
  for (const b of document.querySelectorAll             ("[data-ir]")) b.setAttribute("aria-current", String(b.dataset.ir === aba));
  gravarLocal("mv_aba", aba);
  if (empurrar && location.hash !== `#${aba}`) history.pushState(null, "", `#${aba}`);
}

function ligar()       {
  for (const b of document.querySelectorAll             ("[data-ir]")) b.addEventListener("click", () => mostrar(b.dataset.ir , true));
  addEventListener("popstate", () => mostrar(abaDaUrl() ?? "radar"));
  for (const b of document.querySelectorAll                  ("input[name=sentido]")) {
    b.checked = b.value === sentido;
    b.addEventListener("change", () => mudarSentido(b.value           , true));
  }
  // crítica P1: tocar liga; para parar, segurar 1 s (um toque sem querer no trem não encerra a viagem)
  $("btnTrem").addEventListener("click", () => {
    const b = $("btnTrem");
    if (b.dataset.segurou) { delete b.dataset.segurou; return; }
    if (vigia == null) { rastreio.descartarSalva(); iniciar(); } else $("posStatus").textContent = "Para parar, segure o botão por 1 segundo.";
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
  $("destino").addEventListener("change", () => { alarmeDe = ""; atualizarEta(); });
  $("minhaEstacao").addEventListener("change", () => { gravarLocal("mv_minha_estacao", $                   ("minhaEstacao").value); atualizarEspera(); });
  $("btnMapa").addEventListener("click", () => void abrirMapa());
  for (const b of document.querySelectorAll             ("[data-tipo]")) segurar(b, () => void enviarAviso(b.dataset.tipo ));
  segurar($("btnSos"), () => void compartilharSos());
  $("btnSos").addEventListener("pointerdown", () => void minhaPosicao()); // GPS começa já no toque: o compartilhar sai logo após 1 s
  $("btnSol").addEventListener("click", () => modoSol(!document.documentElement.hasAttribute("data-sol")));
  $("btnGuiaOk").addEventListener("click", fecharGuia);
  $("guiaIphone").addEventListener("keydown", (ev) => { if (ev.key === "Escape") fecharGuia(); });
  $("btnBase").addEventListener("click", () => void carregarBase());
  $                 ("formContato").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const campo = $                  ("novoContato");
    const tel = campo.value.replace(/[^\d+]/g, "");
    if (tel.length < 8) { $("sosStatus").textContent = "Digite um telefone com DDD."; return; }
    gravarLocal("mv_contatos", JSON.stringify([...new Set([...contatos(), tel])]));
    campo.value = "";
    desenharContatos();
  });
  addEventListener("online", () => { filaPos.liberar(); filaRel.liberar(); void esvaziarTudo(); if (!ramal) void carregarBase(); });
  addEventListener("offline", () => void esvaziarTudo());
  document.addEventListener("visibilitychange", () => {
    const visivel = document.visibilityState === "visible";
    rastreio.visibilidade(visivel); // RAS-13
    if (visivel) {
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

/** Nota 2 + FRO-57: guia só no iPhone, no Safari (fora do app instalado); recebe o foco e fecha com Esc. */
function mostrarGuia()       {
  const instalado = (navigator                                       ).standalone || matchMedia("(display-mode: standalone)").matches;
  const g = $("guiaIphone");
  g.hidden = !(IOS && !instalado && !lerLocal("mv_guia"));
  if (!g.hidden) $("t-guia").focus();
}

function fecharGuia()       {
  $("guiaIphone").hidden = true;
  gravarLocal("mv_guia", "1");
  $("btnTrem").focus();
}

/** FRO-13: a base do ramal pode falhar sem rede; o botão e a volta da rede tentam de novo, sem recarregar. */
async function carregarBase()                {
  try {
    const sinal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(5000) : undefined;
    ramal = new Ramal(await (await fetch("base.json", { signal: sinal })).json()        );
    rastreio.usarRamal(ramal);
    $("ramal").textContent = `Ramal ${ramal.base.ramal}`;
    $("btnBase").hidden = true;
    preencherSelects();
    desenharFaixa(true);
    atualizarEta();
  } catch {
    $("ramal").textContent = "Sem rede e sem dados guardados do ramal.";
    $("btnBase").hidden = false;
  }
}

async function comecar()                {
  ligar();
  modoSol(lerLocal("mv_sol") === "1");
  mostrarGuia();
  mostrar(abaDaUrl() ?? lerLocal("mv_aba") ?? "radar");
  desenharContatos();
  try { versaoApp = (await caches.keys()).find((k) => k.startsWith("mv-")) ?? "sem-cache"; } catch { /* sem cache */ }
  rastreio.versao = versaoApp;
  setInterval(() => void tique(), 1000);
  await carregarBase();
  const salva = rastreio.viagemSalva();
  if (salva?.acao === "retomar") iniciar(salva.v);   // A3: a página recarregou no meio da viagem
  else if (salva?.acao === "perguntar") oferecerRetomada(salva.v); // RAS-15
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
