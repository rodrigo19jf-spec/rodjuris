// Audiências (menu próprio): cada uma gera um lembrete automático (tipo "audiência").

import { formatarCnj } from './cnj.js';
import { isoBrasilia } from './prazos.js';

export const ANTECEDENCIAS_AUDIENCIA = [60, 120, 1440, 2880, 10080]; // 1 h, 2 h, 1 dia, 2 dias, 1 semana

/** Cria ou atualiza o lembrete de uma audiência. */
export async function sincronizarLembreteAudiencia(db, audienciaId) {
  const a = await db.get('SELECT * FROM audiencias WHERE id = ?', audienciaId);
  if (!a) return;
  const origem = `aud|${a.id}`;
  const existente = await db.get('SELECT * FROM lembretes WHERE origem = ?', origem);
  const proc = a.numero_processo ? await db.get('SELECT id, titulo FROM processos WHERE numero = ?', a.numero_processo) : null;
  const nome = a.titulo || proc?.titulo || (a.numero_processo ? formatarCnj(a.numero_processo) : 'sem processo informado');
  const dataHora = isoBrasilia(a.data, a.hora || '09:00');
  const titulo = `Audiência — ${nome}`;
  const descricao = [
    a.descricao,
    a.numero_processo ? `Processo ${formatarCnj(a.numero_processo)}` : null,
    a.sei ? `SEI ${a.sei}` : null,
    a.observacoes,
  ]
    .filter(Boolean)
    .join('\n');
  const antecedencia = ANTECEDENCIAS_AUDIENCIA.includes(Number(a.antecedencia_min)) ? Number(a.antecedencia_min) : 1440;
  if (existente) {
    const reagendar = existente.data_hora !== dataHora || existente.antecedencia_min !== antecedencia;
    await db.run(
      `UPDATE lembretes SET titulo = ?, descricao = ?, data_hora = ?, antecedencia_min = ?, processo_id = ?${reagendar ? ', notificado_em = NULL, concluido = 0' : ''} WHERE id = ?`,
      titulo,
      descricao,
      dataHora,
      antecedencia,
      proc?.id ?? null,
      existente.id,
    );
  } else {
    await db.run(
      `INSERT INTO lembretes (titulo, descricao, tipo, data_hora, antecedencia_min, processo_id, origem)
       VALUES (?, ?, 'audiencia', ?, ?, ?, ?)`,
      titulo,
      descricao,
      dataHora,
      antecedencia,
      proc?.id ?? null,
      origem,
    );
  }
}

export async function removerLembreteAudiencia(db, audienciaId) {
  await db.run('DELETE FROM lembretes WHERE origem = ?', `aud|${audienciaId}`);
}
