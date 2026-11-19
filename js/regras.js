/**
 * RAS-37: limites do rastreamento num lugar só, no cliente. O banco usa os mesmos números nas migrações;
 * `tests/regras.test.ts` falha se uma migração nova divergir destes valores.
 */
export const PRECISAO_MAX_M = 200;     // pior que isso não move o "Você está aqui" nem vai para o servidor
export const RAIO_LINHA_M = 150;       // na linha: até max(150 m, precisão)
export const LONGE_LINHA_M = 500;      // B1: mais longe que isso não é enviado nem gravado (privacidade)
export const ESTACAO_FRENTE_KM = 0.05; // estação "à frente" do km atual
export const MESMO_TREM_KM = 0.3;      // passageiros do mesmo sentido a até 300 m = 1 trem
export const VEL_MAX_MS = 33;          // ~120 km/h: só para o filtro sem base (lat/lon)
export const SILENCIO_S = 30;          // diagnóstico vermelho e silêncio no registro
export const RELIGAR_S = 20;           // GPS calado por 20 s: o vigia religa o watchPosition
// RAS-32: intervalo de envio que se adapta
export const INTERVALO_PERTO_MS = 2_000;  // a até 500 m de estação ou devagar: medir paradas
export const INTERVALO_TRECHO_MS = 5_000; // no meio do trecho, andando
export const PERTO_ESTACAO_KM = 0.5;
export const LENTO_MS = 4.2;              // ~15 km/h
// RAS-10: envio em lote
export const LOTE_MIN = 5;
export const ENVIO_MAX_MS = 10_000;
// A3 / RAS-15
export const RETOMAR_MAX_MS = 10 * 60_000; // até 10 min sem posição boa: retoma sozinho
export const VIAGEM_MAX_MS = 4 * 3600_000; // até 4 h desde o início: pergunta se continua
