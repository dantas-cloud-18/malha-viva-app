/** Cliente mínimo do Supabase (REST + login anônimo), sem dependência. */
import { SUPABASE_CHAVE, SUPABASE_URL } from "./config.js";

                                                                                 

                         
                       
                          
 

/** Erro que vale tentar de novo (rede, 5xx, token vencido). Os outros são rejeição definitiva. */
export class ErroTemporario extends Error {}

export class Supabase {
                   url        ;
                   chave        ;
                   guarda        ;
                   http              ;
          sessao                = null;

  constructor(guarda        , op                                                        = {}) {
    this.url = op.url ?? SUPABASE_URL;
    this.chave = op.chave ?? SUPABASE_CHAVE;
    this.guarda = guarda;
    this.http = op.http ?? fetch.bind(globalThis);
    try { this.sessao = JSON.parse(guarda.ler() || "null"); } catch { this.sessao = null; }
  }

          salvar(j                                                                     )       {
    this.sessao = { access_token: j.access_token, refresh_token: j.refresh_token, expira_em: Date.now() + j.expires_in * 1000 };
    this.guarda.gravar(JSON.stringify(this.sessao));
  }

          async auth(caminho        , corpo         )                {
    let r          ;
    try {
      r = await this.http(this.url + caminho, { method: "POST", headers: { apikey: this.chave, "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
    } catch (e) { throw new ErroTemporario(String(e)); }
    if (!r.ok) {
      if (caminho.includes("refresh_token")) { this.sessao = null; this.guarda.gravar("null"); } // refresh inválido: novo login anônimo na próxima
      throw new ErroTemporario("auth " + r.status);
    }
    this.salvar(await r.json());
  }

  /** Token válido: renova 60 s antes de vencer; sem sessão, faz login anônimo. */
  async token()                  {
    if (!this.sessao) await this.auth("/auth/v1/signup", {});
    else if (Date.now() > this.sessao.expira_em - 60_000) await this.auth("/auth/v1/token?grant_type=refresh_token", { refresh_token: this.sessao.refresh_token });
    return this.sessao .access_token;
  }

  /** Insere linhas. "ok" (2xx), "rejeitado" (4xx: o banco recusou). Lança ErroTemporario para tentar de novo. */
  async inserir(tabela        , linhas           )                              {
    const t = await this.token();
    let r          ;
    try {
      r = await this.http(`${this.url}/rest/v1/${tabela}`, {
        method: "POST",
        headers: { apikey: this.chave, Authorization: "Bearer " + t, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(linhas),
      });
    } catch (e) { throw new ErroTemporario(String(e)); }
    if (r.status === 401) { if (this.sessao) this.sessao.expira_em = 0; throw new ErroTemporario("token vencido"); }
    if (r.status >= 500) throw new ErroTemporario("servidor " + r.status);
    return r.ok ? "ok" : "rejeitado";
  }

  /** Lê uma visão ou tabela pública (sem login). */
  async ler   (consulta        )             {
    const r = await this.http(`${this.url}/rest/v1/${consulta}`, { headers: { apikey: this.chave } });
    if (!r.ok) throw new Error("leitura " + r.status);
    return r.json();
  }
}
