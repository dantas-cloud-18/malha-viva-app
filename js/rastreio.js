/**
 * BAS-3: o rastreamento sem tela. Filtros do GPS, registro da viagem, salvar e retomar.
 * Não usa `document` nem `navigator`: roda no Node (tests/rastreio.test.ts) com relógio e guarda falsos.
 */
import { DetectorParada, FiltroKm, pareceSalto,                          Ramal } from "./ramal.js";
import * as R from "./regras.js";

/** Uma leitura do GPS, já validada (null = o aparelho não sabe). */
                                                                                                                                         

                                                                                                
                                                                                                                        

                        
                                                                                                                       
                                                                                                                              
                                       
           
                                                                                                       
                                                                                          
                                                                 
  

                                                                                                   

                                                                                                                      

const CHAVE = "mv_viagem";

function novoRegistro(agora        , versao        )           {
  return { inicio: agora, fim: null, fixes: 0, aceitos: 0, ruins: 0, saltos: 0, religados: 0, silencios: [], maiorSilencioS: 0,
    envios: 0, errosEnvio: 0, precisoes: [], paradas: [], retomadas: 0,
    recarregamentos: [], versao, ocultacoes: 0, ocultoS: 0, travaPerdida: 0, religadosEm: [], ocultasEm: [], travasEm: [] };
}

// shortcut: só os 50 primeiros eventos de cada tipo, para o registro salvo ficar pequeno; aumentar se precisar
function anotar(xs          , t        )       { if (xs.length < 50) xs.push(t); }

/**
 * Velocidade do GPS em que dá para confiar, ou null (usar a do filtro). Com precisão ruim o Android manda
 * posições pela rede com velocidade 0; e "parado" com o km andando mais de 40 m em 12 s também é erro.
 * `hist` = km medidos recentes (do mais velho ao mais novo).
 */
export function velConfiavel(vel               , prec        , km        , t        , hist                             )                {
  if (vel == null || prec > R.VEL_GPS_PREC_MAX_M) return null;
  // abaixo de 2 m/s o detector já conta como "não andando": é aí que o 0 errado do GPS faz parada falsa
  if (vel < 2) {
    const velho = hist.find((h) => t - h.t <= R.VEL_GPS_JANELA_MS);
    if (velho && Math.abs(km - velho.km) * 1000 > R.VEL_GPS_AVANCO_M) return null;
  }
  return vel;
}

export function mediana(xs          )                {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class Rastreio {
  reg                  = null;
  id = "";
  ligado = false;
  ultimoFix = 0;            // última leitura do GPS, boa ou ruim (vigia)
  ultimoBom = 0;            // última leitura aceita
  ultimaPrec                = null;
  naLinha = false;
  distLinha                = null;
  filtro = new FiltroKm();
  detector                        = null;
  kmInicio                = null; // RAS-35: quanto andou na linha desde o início
          ultimoAceito               = null;
          saltosSemBase = 0;
          ultimaEnfileirada = 0;
          ultimaGravacao = 0;
          antesRecarregar = 0;
          kmBruto                = null;
          ocultaDesde = 0;
          kmHist                              = [];
  ramal              ;
                   guarda        ;
                   agora              ;
  versao        ;

  constructor(ramal              , guarda        , agora               = Date.now, versao = "sem-cache") {
    this.ramal = ramal; this.guarda = guarda; this.agora = agora; this.versao = versao;
  }

  usarRamal(r       )       {
    this.ramal = r;
    if (this.ligado && !this.detector) this.detector = new DetectorParada(r.base.estacoes);
  }

  /** Começa uma viagem nova ou retoma a salva (A3). */
  iniciar(retomar              , idNovo = () => "v-" + Math.random().toString(16).slice(2, 10))       {
    const agora = this.agora();
    this.id = retomar?.id ?? idNovo();
    let reg = novoRegistro(agora, this.versao);
    if (retomar) {
      reg = { ...reg, ...retomar.reg, inicio: retomar.inicio, fim: null, versao: this.versao,
        retomadas: (retomar.reg?.retomadas ?? 0) + 1, recarregamentos: [...(retomar.reg?.recarregamentos ?? []), agora] };
      // RAS-14: parada aberta antes do recarregamento fecha na hora da última gravação
      for (const p of reg.paradas) if (p.saida == null) p.saida = retomar.ultimo ?? agora;
    }
    this.reg = reg;
    this.ligado = true;
    this.ultimoBom = 0;
    this.antesRecarregar = retomar?.ultimo ?? 0; // o recarregamento conta como silêncio
    this.ultimoFix = agora;                       // conta a espera pela 1ª posição (vigia)
    this.ultimaPrec = null;
    this.ultimoAceito = null;
    this.saltosSemBase = 0;
    this.ultimaEnfileirada = 0;                   // A13: a 1ª posição sai na hora
    this.kmBruto = null;
    this.kmHist = [];
    this.kmInicio = null;
    this.naLinha = false;
    this.distLinha = null;
    this.filtro = new FiltroKm();
    this.detector = this.ramal ? new DetectorParada(this.ramal.base.estacoes) : null;
    this.salvar(agora);
  }

  /** "Parar": guarda o fim (B9) e apaga a viagem salva. O registro continua para copiar. */
  parar()       {
    if (this.reg && this.reg.fim == null) this.reg.fim = this.agora();
    this.ligado = false;
    this.naLinha = false;
    this.guarda.apagar(CHAVE);
  }

  salvar(agora = this.agora())       {
    if (!this.reg || !this.ligado) return;
    this.ultimaGravacao = agora;
    this.guarda.gravar(CHAVE, JSON.stringify({ id: this.id, inicio: this.reg.inicio, ultimo: agora, reg: this.reg }                      ));
  }

  /** A3 / RAS-15: "retomar" sozinho (até 10 min), "perguntar" (até 4 h desde o início) ou nada. */
  viagemSalva()                                                           {
    try {
      const v = JSON.parse(this.guarda.ler(CHAVE) || "null")                      ;
      if (!v || typeof v.id !== "string" || typeof v.inicio !== "number") return null;
      const agora = this.agora(), ultimo = v.ultimo ?? v.inicio;
      if (agora - v.inicio > R.VIAGEM_MAX_MS) return null;
      return { v, acao: agora - ultimo < R.RETOMAR_MAX_MS ? "retomar" : "perguntar" };
    } catch { return null; }
  }

  descartarSalva()       { this.guarda.apagar(CHAVE); }

  /** Uma leitura do GPS. Devolve a posição a enfileirar, ou null. */
  receber(l         )                 {
    const reg = this.reg;
    if (!reg || !this.ligado) return null;
    const agora = this.agora();
    reg.fixes += 1;
    this.ultimoFix = agora;
    this.ultimaPrec = Math.round(l.prec);
    if (l.prec > R.PRECISAO_MAX_M) { reg.ruins += 1; return null; }
    const ponto        = { t: l.t, lat: l.lat, lon: l.lon, prec: l.prec };
    let kmApp                = null;
    let velGps = l.vel;
    if (this.ramal) {
      // A7 + RAS-31: perto do km anterior e sem voltar contra o sentido
      const dica = this.kmBruto != null && agora - this.ultimoBom < 120_000 ? this.kmBruto : undefined;
      const raio = Math.max(R.RAIO_LINHA_M, l.prec);
      const proj = this.ramal.projetar(l.lat, l.lon, dica, 2, raio * 2, this.filtro.sentido());
      this.distLinha = proj.distM;
      this.naLinha = proj.distM <= raio;
      if (this.naLinha) {
        velGps = velConfiavel(l.vel, l.prec, proj.km, l.t, this.kmHist);
        if (!this.filtro.atualizar(proj.km, l.prec, l.t, velGps)) { reg.saltos += 1; return null; } // RAS-30
        this.kmBruto = proj.km;
        this.kmHist.push({ t: l.t, km: proj.km });
        while (this.kmHist.length && l.t - this.kmHist[0].t > R.VEL_GPS_JANELA_MS) this.kmHist.shift();
        kmApp = this.filtro.km;
        this.kmInicio ??= kmApp;
        const vel = velGps ?? Math.abs(this.filtro.v) * 1000;
        const mudou = this.detector?.atualizar(kmApp , vel, l.t);
        if (mudou && !reg.paradas.includes(mudou)) reg.paradas.push(mudou);
      }
    } else {
      // sem base: só o filtro de salto por lat/lon (3 saltos seguidos = o errado era o guardado)
      if (this.ultimoAceito && pareceSalto(this.ultimoAceito, ponto, R.VEL_MAX_MS) && this.saltosSemBase < 3) {
        this.saltosSemBase += 1; reg.saltos += 1; return null;
      }
      this.saltosSemBase = 0;
    }
    this.ultimoAceito = ponto;
    const antes = this.ultimoBom || this.antesRecarregar;
    const gap = antes ? (agora - antes) / 1000 : 0;
    // B4: `antes`, não `ultimoBom` (0 depois de retomar: new Date(0) dava "21:00:00")
    if (gap > R.SILENCIO_S) reg.silencios.push({ inicio: new Date(antes).toLocaleTimeString("pt-BR"), s: Math.round(gap) });
    reg.maiorSilencioS = Math.max(reg.maiorSilencioS, Math.round(gap));
    reg.aceitos += 1;
    reg.precisoes.push(Math.round(l.prec));
    // shortcut: mediana só das últimas 600 posições, para o registro salvo a cada 10 s ficar pequeno
    if (reg.precisoes.length > 600) reg.precisoes.shift();
    this.ultimoBom = agora;
    if (agora - this.ultimaGravacao >= 10_000) this.salvar(agora);
    // B1 (privacidade): longe da linha não vai para o servidor. Sem base não dá para saber: o banco filtra (0009).
    if (this.distLinha != null && this.distLinha > R.LONGE_LINHA_M) return null;
    if (l.t - this.ultimaEnfileirada < this.intervaloMs(kmApp, velGps) - 500) return null;
    this.ultimaEnfileirada = l.t;
    return { viagem: this.id, t: new Date(l.t).toISOString(), lat: l.lat, lon: l.lon, precisao_m: Math.round(l.prec),
      velocidade_ms: l.vel, rumo: l.rumo, altitude_m: l.alt,
      km_app: kmApp == null ? null : Math.round(kmApp * 1000) / 1000, versao: this.versao.slice(0, 20) };
  }

  /** RAS-32: 2 s perto de estação ou devagar (mede paradas); 5 s andando no meio do trecho. */
  intervaloMs(km               , velMs               )         {
    const vel = velMs ?? Math.abs(this.filtro.v) * 1000;
    if (km == null || !this.ramal || vel < R.LENTO_MS || this.ramal.pertoDeEstacao(km, R.PERTO_ESTACAO_KM)) return R.INTERVALO_PERTO_MS;
    return R.INTERVALO_TRECHO_MS;
  }

  /** "Você está aqui" agora: anda pela velocidade, sem passar da próxima estação (RAS-34). */
  kmAgora(t = this.agora())                {
    if (!this.ligado || !this.naLinha || this.filtro.km == null) return null;
    const previsto = this.filtro.prever(t, 120) ;
    return this.ramal ? this.ramal.limitarNaEstacao(this.filtro.km, previsto, this.filtro.sentido()) : previsto;
  }

  /** Sem posição medida há mais de 5 s: a tela marca o "Você está aqui" como estimado. */
  estimado(t = this.agora())          {
    return this.filtro.km != null && t - this.filtro.t > 5_000;
  }

  /** RAS-35: o sentido real, depois de andar pelo menos `km` na linha (0 = ainda não sabe). */
  sentidoPeloTrajeto(km = 1)             {
    if (this.kmInicio == null || this.filtro.km == null) return 0;
    const d = this.filtro.km - this.kmInicio;
    return Math.abs(d) < km ? 0 : d > 0 ? 1 : -1;
  }

  /** RAS-13: a página ficou oculta ou voltou. */
  visibilidade(visivel         )       {
    if (!this.reg || !this.ligado) return;
    const agora = this.agora();
    if (!visivel && !this.ocultaDesde) { this.ocultaDesde = agora; this.reg.ocultacoes += 1; anotar(this.reg.ocultasEm, agora); }
    else if (visivel && this.ocultaDesde) { this.reg.ocultoS += Math.round((agora - this.ocultaDesde) / 1000); this.ocultaDesde = 0; }
  }

  travaPerdida()       { if (this.reg && this.ligado) { this.reg.travaPerdida += 1; anotar(this.reg.travasEm, this.agora()); } }
  religado()       { if (this.reg) { this.reg.religados += 1; anotar(this.reg.religadosEm, this.agora()); } }
  rodadaEnvio(erro         )       { if (this.reg) { this.reg.envios += 1; if (erro) this.reg.errosEnvio += 1; } }

  /** Texto do "Copiar registro da viagem". */
  texto(sentido        , aparelho        )         {
    const reg = this.reg;
    if (!reg) return "Sem viagem registrada.";
    const hora = (ms        ) => new Date(ms).toLocaleTimeString("pt-BR");
    const fim = reg.fim ?? this.agora();
    const quando = (xs          ) => (xs.length ? ` (${xs.map(hora).join(", ")})` : "");
    const paradas = reg.paradas.map((p) => p.estimada
      ? `${p.estacao} estimada, sem GPS entre ${hora(p.chegada)} e ${hora(p.saida ?? p.chegada)}`
      : p.saida
      ? `${p.estacao} ${hora(p.chegada)}–${hora(p.saida)} (${Math.round((p.saida - p.chegada) / 1000)} s)`
      : `${p.estacao} desde ${hora(p.chegada)}`).join("; ");
    return [
      `Malha Viva · registro da viagem ${this.id} · versão ${reg.versao}`,
      `Início: ${new Date(reg.inicio).toLocaleString("pt-BR")} · ${reg.fim ? `fim: ${hora(reg.fim)}` : "em andamento"} · duração: ${Math.round((fim - reg.inicio) / 60000)} min · sentido marcado: ${sentido}`,
      `Aparelho: ${aparelho}`,
      `Posições do GPS: ${reg.fixes} · aceitas: ${reg.aceitos} · ruins (> ${R.PRECISAO_MAX_M} m): ${reg.ruins} · saltos: ${reg.saltos}`,
      `Precisão mediana: ${mediana(reg.precisoes) ?? "–"} m`,
      `Maior silêncio: ${reg.maiorSilencioS} s · silêncios > ${R.SILENCIO_S} s: ${reg.silencios.map((s) => `${s.inicio} (${s.s} s)`).join(", ") || "nenhum"}`,
      `GPS religado pelo vigia: ${reg.religados} vez(es)${quando(reg.religadosEm)} · retomado após recarregar: ${reg.retomadas} vez(es)${reg.recarregamentos.length ? ` (${reg.recarregamentos.map(hora).join(", ")})` : ""}`,
      `Tela oculta: ${reg.ocultacoes} vez(es)${quando(reg.ocultasEm)}, ${reg.ocultoS} s · trava de tela perdida: ${reg.travaPerdida} vez(es)${quando(reg.travasEm)}`,
      `Rodadas de envio: ${reg.envios} · com erro: ${reg.errosEnvio}`,
      `Paradas nas estações: ${paradas || "nenhuma detectada"}`,
    ].join("\n");
  }
}
