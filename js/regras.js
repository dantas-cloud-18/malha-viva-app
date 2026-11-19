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
// Parada e velocidade do GPS (viagem v-a6dea9d4, 19/11)
export const VEL_GPS_PREC_MAX_M = 50;     // pior que isso: velocidade do GPS ignorada (dava 0 com o trem a 10 m/s)
export const VEL_GPS_JANELA_MS = 12_000;  // "parado" do GPS contra o avanço do km nesta janela...
export const VEL_GPS_AVANCO_M = 40;       // ...de mais que isso = a velocidade do GPS está errada
export const RAPIDO_ZERA_MS = 3_000;      // só 3 s seguidos acima de 2 m/s zeram a contagem da parada
export const SILENCIO_PARADA_S = 20;      // silêncio deste tamanho numa estação = parada estimada
export const SILENCIO_PARADA_MAX_S = 180; // acima disso não dá para dizer onde o trem parou
// RAS-10: envio em lote
export const LOTE_MIN = 5;
export const ENVIO_MAX_MS = 10_000;
// A3 / RAS-15
export const RETOMAR_MAX_MS = 10 * 60_000; // até 10 min sem posição boa: retoma sozinho
export const VIAGEM_MAX_MS = 4 * 3600_000; // até 4 h desde o início: pergunta se continua
