/** Cliente mínimo do Supabase (REST + login anônimo), sem dependência. */
import { SUPABASE_CHAVE, SUPABASE_URL } from "./config.js";

                                                                                 

                         
                       
                          
 

const PRAZO_MS = 15_000;
/** Sinal que aborta o fetch em 15 s (undefined em navegador antigo sem AbortSignal.timeout). */
function prazo()                          {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(PRAZO_MS) : undefined;
}

/** Erro que vale tentar de novo (rede, 5xx, token vencido). Os outros são rejeição definitiva. */
export class ErroTemporario extends Error {}

export class Supabase {
                   url        ;
                   chave        ;
                   guarda        ;
                   http              ;
          sessao                = null;
  ultimaRecusa = "";

                   captcha                              ;

  constructor(guarda        , op                                                                                                = {}) {
    this.url = op.url ?? SUPABASE_URL;
    this.chave = op.chave ?? SUPABASE_CHAVE;
    this.guarda = guarda;
    this.http = op.http ?? fetch.bind(globalThis);
    this.captcha = op.captcha ?? (async () => null);
    try { this.sessao = JSON.parse(guarda.ler() || "null"); } catch { this.sessao = null; }
  }

          salvar(j                                                                     )       {
    this.sessao = { access_token: j.access_token, refresh_token: j.refresh_token, expira_em: Date.now() + j.expires_in * 1000 };
    this.guarda.gravar(JSON.stringify(this.sessao));
  }

          async auth(caminho        , corpo         )                {
    let r          ;
    try {
      r = await this.http(this.url + caminho, { method: "POST", headers: { apikey: this.chave, "Content-Type": "application/json" },
        body: JSON.stringify(corpo), signal: prazo() });
    } catch (e) { throw new ErroTemporario(String(e)); }
    if (!r.ok) {
      if (caminho.includes("refresh_token")) { this.sessao = null; this.guarda.gravar("null"); } // refresh inválido: novo login anônimo na próxima
      throw new ErroTemporario("auth " + r.status);
    }
    this.salvar(await r.json());
  }

          emVoo                         = null;

  /** Token válido. Uma chamada por vez (A4): duas filas pedindo juntas no primeiro uso não fazem dois logins. */
  token()                  {
    this.emVoo ??= this.obterToken().finally(() => { this.emVoo = null; });
    return this.emVoo;
  }

  /** Renova 60 s antes de vencer; sem sessão, faz login anônimo. */
          async obterToken()                  {
    if (!this.sessao) {
      const token = await this.captcha(); // só no primeiro login do aparelho; depois a sessão é renovada sem CAPTCHA
      await this.auth("/auth/v1/signup", token ? { gotrue_meta_security: { captcha_token: token } } : {});
    }
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
        keepalive: true, // o envio continua se a página sair da tela no meio (lote de 100 posições ≈ 15 KB, abaixo do limite de 64 KB)
        signal: prazo(), // A4: sem prazo, um envio pendurado deixava a fila mandar o mesmo lote de novo
      });
    } catch (e) { throw new ErroTemporario(String(e)); }
    if (r.status === 401) { if (this.sessao) this.sessao.expira_em = 0; throw new ErroTemporario("token vencido"); }
    // 408 (prazo) e 429 (limite de requisições) passam: tentar de novo, não descartar o lote
    if (r.status >= 500 || r.status === 408 || r.status === 429) throw new ErroTemporario("servidor " + r.status);
    if (r.ok) return "ok";
    // RAS-11: guarda a causa da recusa para o registro de erros (o corpo do PostgREST diz a coluna ou a regra)
    this.ultimaRecusa = `${tabela} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`;
    return "rejeitado";
  }

  /** Lê uma visão ou tabela pública (sem login). */
  async ler   (consulta        )             {
    const r = await this.http(`${this.url}/rest/v1/${consulta}`, { headers: { apikey: this.chave }, signal: prazo() });
    if (!r.ok) throw new Error("leitura " + r.status);
    return r.json();
  }
}
