/** Armazém da fila em IndexedDB: sobrevive a fechar a aba, recarregar e ficar sem rede. */
                                               

const BANCO = "malha-viva";
const LOJAS = ["posicoes", "relatos"];

let abrindo                              = null;

function banco()                       {
  abrindo ??= new Promise((ok, falha) => {
    const req = indexedDB.open(BANCO, 1);
    req.onupgradeneeded = () => {
      for (const loja of LOJAS) {
        if (!req.result.objectStoreNames.contains(loja)) req.result.createObjectStore(loja, { autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      // o iOS pode fechar a conexão em segundo plano: esquece a conexão e abre outra na próxima chamada
      req.result.onclose = req.result.onversionchange = () => { req.result.close(); abrindo = null; };
      ok(req.result);
    };
    req.onerror = () => { abrindo = null; falha(req.error); };
  });
  return abrindo;
}

function concluir(tx                )                {
  return new Promise((ok, falha) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => falha(tx.error);
    tx.onabort = () => falha(tx.error);
  });
}

export class ArmazemIDB                          {
                   loja        ;
  constructor(loja        ) {
    this.loja = loja;
  }

  async adicionar(valor   )                {
    const tx = (await banco()).transaction(this.loja, "readwrite");
    tx.objectStore(this.loja).add(valor);
    await concluir(tx);
  }

  async primeiros(n        )                     {
    const tx = (await banco()).transaction(this.loja, "readonly");
    const itens            = [];
    await new Promise      ((ok, falha) => {
      const req = tx.objectStore(this.loja).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c || itens.length >= n) return ok();
        itens.push({ chave: c.key          , valor: c.value      });
        c.continue();
      };
      req.onerror = () => falha(req.error);
    });
    return itens;
  }

  async remover(chaves          )                {
    const tx = (await banco()).transaction(this.loja, "readwrite");
    const st = tx.objectStore(this.loja);
    for (const k of chaves) st.delete(k);
    await concluir(tx);
  }

  async tamanho()                  {
    const tx = (await banco()).transaction(this.loja, "readonly");
    return new Promise((ok, falha) => {
      const req = tx.objectStore(this.loja).count();
      req.onsuccess = () => ok(req.result);
      req.onerror = () => falha(req.error);
    });
  }
}
