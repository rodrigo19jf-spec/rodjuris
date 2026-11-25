// Audiência agendada no cadastro do processo → lembrete automático (tipo "audiência").

import { formatarCnj } from './cnj.js';
import { isoBrasilia } from './prazos.js';

export const ANTECEDENCIAS_AUDIENCIA = [60, 120, 1440, 2880, 10080]; // 1 h, 2 h, 1 dia, 2 dias, 1 semana

/** Cria, atualiza ou remove o lembrete da audiência conforme o cadastro do processo. */
export async function sincronizarAudiencia(db, processoId) {
  const p = await db.get('SELECT * FROM processos WHERE id = ?', processoId);
  if (!p) return;
  const origem = `audiencia|${p.id}`;
  const existente = await db.get('SELECT * FROM lembretes WHERE origem = ?', origem);
  if (!p.audiencia_data) {
    if (existente && !existente.concluido) await db.run('DELETE FROM lembretes WHERE id = ?', existente.id);
    return;
  }
  const dataHora = isoBrasilia(p.audiencia_data, p.audiencia_hora || '09:00');
  const nome = p.titulo || p.cliente || formatarCnj(p.numero);
  const titulo = `Audiência — ${nome}`;
  const descricao = [p.audiencia_descricao, `Processo ${formatarCnj(p.numero)}${p.orgao ? ` · ${p.orgao}` : ''}`]
    .filter(Boolean)
    .join('\n');
  const antecedencia = ANTECEDENCIAS_AUDIENCIA.includes(Number(p.audiencia_antecedencia_min)) ? Number(p.audiencia_antecedencia_min) : 1440;
  if (existente) {
    const reagendar = existente.data_hora !== dataHora || existente.antecedencia_min !== antecedencia;
    await db.run(
      `UPDATE lembretes SET titulo = ?, descricao = ?, data_hora = ?, antecedencia_min = ?, concluido = 0${reagendar ? ', notificado_em = NULL' : ''} WHERE id = ?`,
      titulo,
      descricao,
      dataHora,
      antecedencia,
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
      p.id,
      origem,
    );
  }
}
