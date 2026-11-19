/** Map-matching e ETA no aparelho (porte de malha/geo.py e malha/eta.py, Fase 3.1). Funciona sem rede. */

                                                                                                                  
                                                               
                                                                                                                

/** Distância em metros entre dois pontos (equirretangular; erro desprezível em poucos km). */
export function distanciaM(lat1        , lon1        , lat2        , lon2        )         {
  const r = Math.PI / 180;
  const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  return Math.hypot(x, (lat2 - lat1) * r) * 6_371_000;
}

                                                                          

/**
 * A9: km suavizado e "andando" entre uma posição e outra.
 * Cada posição puxa o km previsto com peso pela precisão (10 m pesa ~0,75; 150 m pesa ~0,17).
 * Entre posições, o km avança pela velocidade por até `maxAvancoS` segundos.
 */
export class Suavizador {
  km                = null;
  kmS = 0;          // velocidade em km/s, com sinal (+ = sentido Central)
          t = 0;    // ms da última posição
                   maxAvancoS        ;
  constructor(maxAvancoS = 30) { this.maxAvancoS = maxAvancoS; }

  atualizar(km        , precM        , t        , velMs               )       {
    if (this.km == null || t - this.t > 120_000) { this.km = km; this.t = t; this.kmS = 0; return; }
    const dt = Math.max(0.001, (t - this.t) / 1000);
    const previsto = this.km + this.kmS * dt;
    const peso = 1 / (1 + precM / 30);
    const novo = previsto + peso * (km - previsto);
    const kmSMedida = (novo - this.km) / dt;
    // velocidade do GPS (sem sinal) dá o módulo; o km dá o sinal
    const kmS = velMs != null && Math.abs(kmSMedida) > 1e-6 ? Math.sign(kmSMedida) * velMs / 1000 : kmSMedida;
    this.kmS = 0.6 * this.kmS + 0.4 * kmS;
    this.km = novo;
    this.t = t;
  }

  /** km para mostrar agora (avança pela velocidade, no máximo `maxAvancoS` s depois da última posição). */
  agora(t        )                {
    if (this.km == null) return null;
    const dt = Math.min(this.maxAvancoS, Math.max(0, (t - this.t) / 1000));
    return this.km + this.kmS * dt;
  }

  /** +1 indo para a Central, -1 para Santa Cruz, 0 parado ou sem dado (abaixo de ~7 km/h). */
  sentido()             {
    return Math.abs(this.kmS) < 0.002 ? 0 : (this.kmS > 0 ? 1 : -1);
  }
}

                                                                                

/**
 * A10: chegada e saída de cada estação. Parado = abaixo de 1 m/s; chegada depois de 15 s parado a até 300 m
 * de uma estação; saída depois de 5 s acima de 2 m/s.
 */
export class DetectorParada {
           paradas           = [];
          lentoDesde                = null;
          rapidoDesde                = null;
          atual                = null;
                   estacoes           ;

  constructor(estacoes           ) { this.estacoes = estacoes; }

  atualizar(km        , velMs        , t        )                {
    if (velMs < 1) {
      this.rapidoDesde = null;
      this.lentoDesde ??= t;
      if (!this.atual && t - this.lentoDesde >= 15_000) {
        const e = this.estacoes.reduce((a, b) => (Math.abs(b.km - km) < Math.abs(a.km - km) ? b : a), this.estacoes[0]);
        if (e && Math.abs(e.km - km) <= 0.3) {
          this.atual = { estacao: e.nome, chegada: this.lentoDesde, saida: null };
          this.paradas.push(this.atual);
          return this.atual;
        }
      }
    } else if (velMs > 2) {
      this.lentoDesde = null;
      this.rapidoDesde ??= t;
      if (this.atual && t - this.rapidoDesde >= 5_000) {
        this.atual.saida = this.rapidoDesde;
        const fim = this.atual;
        this.atual = null;
        return fim;
      }
    }
    return null;
  }
}

/** Salto do GPS: velocidade acima de `vMaxMs` mesmo descontando o erro informado dos dois pontos. */
export function pareceSalto(a       , b       , vMaxMs        )          {
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return false;
  return Math.max(0, distanciaM(a.lat, a.lon, b.lat, b.lon) - a.prec - b.prec) / dt > vMaxMs;
}

export class Ramal {
           base      ;
                   cx        ;
                   cy = 110_540;
                   xy                    ;

  constructor(base      ) {
    this.base = { ...base, estacoes: [...base.estacoes].sort((a, b) => a.km - b.km) };
    const [lat0] = base.linha[0];
    this.cx = Math.cos((lat0 * Math.PI) / 180) * 111_320;
    this.xy = base.linha.map(([lat, lon]) => this.paraXY(lat, lon));
  }

          paraXY(lat        , lon        )                   {
    const [lat0, lon0] = this.base.linha[0];
    return [(lon - lon0) * this.cx, (lat - lat0) * this.cy];
  }

  /**
   * km na linha e distância até ela (m). O(n) nos segmentos.
   * Com `kmPerto` (A7, mapa com memória): procura só a ±`janelaKm` do km anterior, para o km não pular
   * para o outro lado de uma volta da linha (ex.: perto de Deodoro). Se ali ficar longe demais, busca na linha toda.
   */
  projetar(lat        , lon        , kmPerto         , janelaKm = 2, distMax = 300)                                {
    if (kmPerto != null) {
      const p = this.projetarEntre(lat, lon, kmPerto - janelaKm, kmPerto + janelaKm);
      if (p.distM <= distMax) return p;
    }
    return this.projetarEntre(lat, lon, -Infinity, Infinity);
  }

          projetarEntre(lat        , lon        , kmMin        , kmMax        )                                {
    const [px, py] = this.paraXY(lat, lon);
    let melhor = { km: 0, distM: Infinity };
    for (let i = 0; i < this.xy.length - 1; i++) {
      if (this.base.linha[i + 1][2] < kmMin || this.base.linha[i][2] > kmMax) continue;
      const [ax, ay] = this.xy[i], [bx, by] = this.xy[i + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < melhor.distM) {
        const k0 = this.base.linha[i][2], k1 = this.base.linha[i + 1][2];
        melhor = { km: k0 + t * (k1 - k0), distM: d };
      }
    }
    return melhor;
  }

  /** Índice i do trecho es[i]–es[i+1] que contém `km` (o primeiro, se cair bem na estação). -1 fora da linha. */
  static trechoDe(es           , km        )         {
    for (let i = 0; i < es.length - 1; i++) {
      if (km >= Math.min(es[i].km, es[i + 1].km) && km <= Math.max(es[i].km, es[i + 1].km)) return i;
    }
    return -1;
  }

  estacao(nome        )                      {
    return this.base.estacoes.find((e) => e.nome === nome);
  }

  /** Segundos até chegar a `destino` saindo de `km` no `sentido` (+1 Central, -1 Santa Cruz). null se já passou. */
  eta(km        , sentido        , destino        )                {
    const dest = this.estacao(destino);
    if (!dest) throw new Error("estação desconhecida: " + destino);
    if ((dest.km - km) * sentido < -0.05) return null;
    const seg = new Map(this.base.trechos.flatMap((t) => [[`${t.de}>${t.para}`, t.seg], [`${t.para}>${t.de}`, t.seg]]                      ));
    const frente = this.base.estacoes.filter((e) => (e.km - km) * sentido > 0.05).sort((a, b) => (a.km - b.km) * sentido);
    const tras = this.base.estacoes.filter((e) => (e.km - km) * sentido <= 0.05).sort((a, b) => (b.km - a.km) * sentido);
    if (!frente.length) return Math.abs(dest.km - km) <= 0.05 ? 0 : null;
    const prox = frente[0], ant = tras[0];
    const trechoAtual = ant ? seg.get(`${ant.nome}>${prox.nome}`) : undefined;
    let total = trechoAtual !== undefined && ant
      ? trechoAtual * Math.abs(prox.km - km) / (Math.abs(prox.km - ant.km) || 1e-9)
      : Math.abs(prox.km - km) * 1000 / this.vMedia();
    for (let i = 0; frente[i].nome !== dest.nome; i++) {
      if (!frente[i + 1]) return null;
      const s = seg.get(`${frente[i].nome}>${frente[i + 1].nome}`);
      if (s === undefined) return null;
      total += frente[i].parada_s + s;
    }
    return total;
  }

  /** Velocidade média em movimento (m/s), para quando não se sabe o trecho atual. */
          vMedia()         {
    let m = 0, s = 0;
    for (const t of this.base.trechos) {
      const a = this.estacao(t.de), b = this.estacao(t.para);
      if (a && b) { m += Math.abs(b.km - a.km) * 1000; s += t.seg; }
    }
    return s ? m / s : 12;
  }
}
