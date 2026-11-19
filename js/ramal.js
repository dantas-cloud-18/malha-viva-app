/** Map-matching e ETA no aparelho (porte de malha/geo.py e malha/eta.py, Fase 3.1). Funciona sem rede. */

// raio_m e min_parado_s (RAS-33) vêm da calibração; sem eles valem 300 m e 15 s
                                                                                                                
                                           
                                                               
                                                                                                                

/** Distância em metros entre dois pontos (equirretangular; erro desprezível em poucos km). */
export function distanciaM(lat1        , lon1        , lat2        , lon2        )         {
  const r = Math.PI / 180;
  const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  return Math.hypot(x, (lat2 - lat1) * r) * 6_371_000;
}

                                                                          

/**
 * RAS-30: filtro de Kalman 1D ao longo da linha (estado: km e velocidade em km/s, + = sentido Central).
 * Substitui o Suavizador (A9) e o pareceSalto no caminho com base: um só modelo pesa a precisão do GPS,
 * segue pela velocidade nos buracos e recusa salto pelo resíduo (> 4 desvios). 3 recusas seguidas = o errado
 * era o estado guardado: recomeça na medida nova.
 */
export class FiltroKm {
  km                = null;
  v = 0;            // km/s, com sinal
  t = 0;            // ms da última medida aceita
          p                                   = [0, 0, 0, 0]; // covariância [kk, kv, vk, vv]
          recusas = 0;
                   q        ;
  constructor(acelMs2 = 0.6) { this.q = (acelMs2 / 1000) ** 2; }

          recomecar(km        , precM        , t        )       {
    this.km = km; this.t = t; this.v = 0; this.recusas = 0;
    this.p = [(Math.max(precM, 5) / 1000) ** 2, 0, 0, 0.03 ** 2];
  }

  /** true = aceita; false = recusada como salto. */
  atualizar(z        , precM        , t        , velMs               )          {
    if (this.km == null || t - this.t > 120_000 || t < this.t) { this.recomecar(z, precM, t); return true; }
    const dt = Math.max(0.001, (t - this.t) / 1000);
    let km = this.km + this.v * dt, v = this.v;
    let [a, b, c, d] = this.p;
    const q = this.q;
    a += dt * (b + c) + dt * dt * d + q * dt ** 4 / 4;
    b += dt * d + q * dt ** 3 / 2;
    c += dt * d + q * dt ** 3 / 2;
    d += q * dt * dt;
    const r = (Math.max(precM, 5) / 1000) ** 2;
    const y = z - km, s = a + r;
    if ((y * y) / s > 16) {
      if (++this.recusas < 3) return false;
      this.recomecar(z, precM, t);
      return true;
    }
    this.recusas = 0;
    const k0 = a / s, k1 = c / s;
    km += k0 * y; v += k1 * y;
    [a, b, c, d] = [a - k0 * a, b - k0 * b, c - k1 * a, d - k1 * b];
    // velocidade do GPS: dá o módulo (sem sinal); o sinal vem do estado, e só quando ele já é confiável
    // (|v| > 2 desvios): senão um 1º ponto ruim travava o sentido errado. Abaixo de 0,5 m/s = parado.
    if (velMs != null && (velMs < 0.5 || Math.abs(v) > 2 * Math.sqrt(d))) {
      const zv = velMs < 0.5 ? 0 : Math.sign(v) * velMs / 1000;
      const sv = d + (1 / 1000) ** 2, yv = zv - v, g0 = b / sv, g1 = d / sv;
      km += g0 * yv; v += g1 * yv;
      [a, b, c, d] = [a - g0 * c, b - g0 * d, c - g1 * c, d - g1 * d];
    }
    this.km = km; this.v = v; this.t = t; this.p = [a, b, c, d];
    return true;
  }

  /** km previsto em `t`, andando pela velocidade por até `maxS` segundos. */
  prever(t        , maxS = 120)                {
    if (this.km == null) return null;
    return this.km + this.v * Math.min(maxS, Math.max(0, (t - this.t) / 1000));
  }

  /** +1 indo para a Central, -1 para Santa Cruz, 0 parado ou sem dado (abaixo de ~7 km/h). */
  sentido()             {
    return Math.abs(this.v) < 0.002 ? 0 : (this.v > 0 ? 1 : -1);
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
      const e = this.estacoes.reduce((a, b) => (Math.abs(b.km - km) < Math.abs(a.km - km) ? b : a), this.estacoes[0]);
      // RAS-33: raio e tempo mínimo por estação, quando a calibração der
      if (!this.atual && e && t - this.lentoDesde >= (e.min_parado_s ?? 15) * 1000) {
        if (Math.abs(e.km - km) <= (e.raio_m ?? 300) / 1000) {
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
  projetar(lat        , lon        , kmPerto         , janelaKm = 2, distMax = 300, sentido             = 0)                                {
    if (kmPerto != null) {
      // RAS-31: andando num sentido, a janela quase não olha para trás (300 m): o km não volta numa volta da linha
      const tras = 0.3;
      const p = this.projetarEntre(lat, lon, kmPerto - (sentido === 1 ? tras : janelaKm), kmPerto + (sentido === -1 ? tras : janelaKm));
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
      const k0 = this.base.linha[i][2], k1 = this.base.linha[i + 1][2], dk = k1 - k0 || 1e-9;
      // segmento que cruza a borda da janela: só a parte dentro dela conta (RAS-31)
      const tMin = Math.max(0, (kmMin - k0) / dk), tMax = Math.min(1, (kmMax - k0) / dk);
      const t = Math.max(tMin, Math.min(tMax, ((px - ax) * dx + (py - ay) * dy) / l2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < melhor.distM) melhor = { km: k0 + t * (k1 - k0), distM: d };
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

  /** Próxima estação à frente de `km` no `sentido` (undefined depois do terminal). */
  proximaEstacao(km        , sentido        )                      {
    return this.base.estacoes.filter((e) => (e.km - km) * sentido > 0.05).sort((a, b) => (a.km - b.km) * sentido)[0];
  }

  /** RAS-12 / RAS-34: km andando pela velocidade, sem passar da próxima estação depois de `km0`. */
  limitarNaEstacao(km0        , kmPrevisto        , sentido            )         {
    if (!sentido) return kmPrevisto;
    const prox = this.proximaEstacao(km0, sentido);
    if (!prox) return km0; // depois do terminal: não estima
    return sentido > 0 ? Math.min(kmPrevisto, prox.km) : Math.max(kmPrevisto, prox.km);
  }

  /** Perto de alguma estação (RAS-32)? */
  pertoDeEstacao(km        , raioKm        )          {
    return this.base.estacoes.some((e) => Math.abs(e.km - km) <= raioKm);
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
