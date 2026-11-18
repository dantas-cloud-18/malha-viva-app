/**
 * Fila de envio com backoff curto. Lição do app Expo (análise de 18/11): o backoff de 5 min,
 * que só zerava com o app na tela, causava pausas de 5 a 7 min. Aqui o teto é 30 s e
 * cada item novo zera a espera. A trava expira sozinha: não depende de timer de JavaScript.
 */

                          
                
           
 

                             
                                     
                                           
                                           
                             
 

/** "ok" e "rejeitado" tiram o lote da fila; uma exceção (rede, 5xx) mantém e espera. */
                                                

                             
                
                        
                        
                      
                       
 

                         
                   
                     
                
                     
 

export class Fila    {
                   armazem            ;
                   enviar                                        ;
                   lote        ;
                   backoffMinMs        ;
                   backoffMaxMs        ;
                   travaMaxMs        ;
                   agora              ;
          falhas = 0;
          esperaAte = 0;
          travadaEm = 0;

  constructor(armazem            , enviar                                        , op             = {}) {
    this.armazem = armazem;
    this.enviar = enviar;
    this.lote = op.lote ?? 100;
    this.backoffMinMs = op.backoffMinMs ?? 2_000;
    this.backoffMaxMs = op.backoffMaxMs ?? 30_000;
    this.travaMaxMs = op.travaMaxMs ?? 30_000;
    this.agora = op.agora ?? Date.now;
  }

  /** Guarda o item e zera a espera: dado novo chegando é sinal de que vale tentar de novo. */
  async adicionar(valor   )                {
    await this.armazem.adicionar(valor);
    this.esperaAte = 0;
  }

  tamanho()                  {
    return this.armazem.tamanho();
  }

  /** Libera a espera (ex.: evento "online" do navegador). */
  liberar()       {
    this.esperaAte = 0;
  }

  async esvaziar()                  {
    const r         = { enviados: 0, rejeitados: 0 };
    const t0 = this.agora();
    if (this.travadaEm && t0 - this.travadaEm < this.travaMaxMs) return r; // outra rodada em curso
    if (t0 < this.esperaAte) return { ...r, esperaAte: this.esperaAte };
    this.travadaEm = t0;
    try {
      for (;;) {
        const itens = await this.armazem.primeiros(this.lote);
        if (!itens.length) break;
        let res                ;
        try {
          res = await this.enviar(itens.map((i) => i.valor));
        } catch (e) {
          this.falhas += 1;
          const espera = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** (this.falhas - 1));
          this.esperaAte = this.agora() + espera;
          return { ...r, erro: String(e), esperaAte: this.esperaAte };
        }
        await this.armazem.remover(itens.map((i) => i.chave));
        this.falhas = 0;
        if (res === "ok") r.enviados += itens.length;
        else r.rejeitados += itens.length;
      }
      return r;
    } finally {
      this.travadaEm = 0;
    }
  }
}

/** Armazém em memória: usado nos testes e como reserva se o IndexedDB falhar (modo privado). */
export class ArmazemMemoria                          {
          seq = 0;
          itens            = [];
  async adicionar(valor   )                {
    this.itens.push({ chave: ++this.seq, valor });
  }
  async primeiros(n        )                     {
    return this.itens.slice(0, n);
  }
  async remover(chaves          )                {
    const s = new Set(chaves);
    this.itens = this.itens.filter((i) => !s.has(i.chave));
  }
  async tamanho()                  {
    return this.itens.length;
  }
}
