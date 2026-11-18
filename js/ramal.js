/** Map-matching e ETA no aparelho (porte de malha/geo.py e malha/eta.py, Fase 3.1). Funciona sem rede. */

                                                                                                                  
                                                               
                                                                                                                

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

  /** km na linha e distância até ela (m). O(n) nos segmentos. */
  projetar(lat        , lon        )                                {
    const [px, py] = this.paraXY(lat, lon);
    let melhor = { km: 0, distM: Infinity };
    for (let i = 0; i < this.xy.length - 1; i++) {
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
