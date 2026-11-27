import { agoraIso } from './db.js';

/** Processos em acompanhamento diário, com o que há de novo e de pendente em cada um. */
export async function processosDiarios(db) {
  const agora = agoraIso();
  const em3 = new Date(Date.now() + 3 * 86_400_000).toISOString();
  return db.all(
    `SELECT p.id, p.numero, p.titulo, p.cliente, p.status, p.proximo_passo, p.proxima_consulta, p.consulta_intervalo, p.ultima_consulta,
       (SELECT COUNT(*)::int FROM publicacoes pu WHERE pu.processo_id = p.id AND pu.lida = 0) AS pub_nao_lidas,
       (SELECT COUNT(*)::int FROM andamentos an WHERE an.processo_id = p.id AND an.lida = 0) AS and_nao_lidos,
       (SELECT an.nome FROM andamentos an WHERE an.processo_id = p.id ORDER BY an.data DESC NULLS LAST, an.id DESC LIMIT 1) AS ultimo_andamento,
       (SELECT an.data FROM andamentos an WHERE an.processo_id = p.id ORDER BY an.data DESC NULLS LAST, an.id DESC LIMIT 1) AS ultimo_andamento_data,
       (SELECT COUNT(*)::int FROM lembretes l WHERE l.processo_id = p.id AND l.concluido = 0 AND l.data_hora < ?) AS lembretes_atrasados,
       (SELECT l.titulo FROM lembretes l WHERE l.processo_id = p.id AND l.concluido = 0 AND l.data_hora <= ? ORDER BY l.data_hora LIMIT 1) AS proximo_lembrete_titulo,
       (SELECT l.data_hora FROM lembretes l WHERE l.processo_id = p.id AND l.concluido = 0 AND l.data_hora <= ? ORDER BY l.data_hora LIMIT 1) AS proximo_lembrete
     FROM processos p
     WHERE p.acompanhamento_diario = 1
     ORDER BY p.proxima_consulta NULLS LAST, LOWER(COALESCE(p.titulo, p.cliente, p.numero))`,
    agora,
    em3,
    em3,
  );
}
