// Consulta periódica aos autos dos processos em acompanhamento diário:
// cada processo tem a data da próxima consulta (aviso às 8h daquele dia) e um intervalo em dias.

import { agoraIso } from './db.js';
import { formatarCnj } from './cnj.js';
import { dataBrasilia, feriadosNacionais, isoBrasilia, somarDiasCorridos } from './prazos.js';

export const HORA_AVISO_CONSULTA = '08:00';
export const INTERVALO_PADRAO = 7;

const origemConsulta = (id) => `consulta|${id}`;

function diaDeTrabalho(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const sem = d.getUTCDay();
  return sem !== 0 && sem !== 6 && !feriadosNacionais(d.getUTCFullYear()).has(ymd);
}

/** Data da próxima consulta: `intervalo` dias depois de `ymd`; se cair em fim de semana ou feriado, vai para o dia útil seguinte. */
export function calcularProximaConsulta(ymd, intervalo = INTERVALO_PADRAO) {
  let d = somarDiasCorridos(ymd, Math.max(1, Number(intervalo) || INTERVALO_PADRAO));
  for (let i = 0; i < 10 && !diaDeTrabalho(d); i++) d = somarDiasCorridos(d, 1);
  return d;
}

/** Cria, atualiza ou remove o lembrete da próxima consulta (aparece em Lembretes/Agenda e avisa às 8h). */
export async function sincronizarConsulta(db, processoId, { reabrir = false } = {}) {
  const p = await db.get('SELECT * FROM processos WHERE id = ?', processoId);
  const origem = origemConsulta(processoId);
  if (!p || !p.acompanhamento_diario || !p.proxima_consulta) {
    await db.run('DELETE FROM lembretes WHERE origem = ?', origem);
    return;
  }
  const nome = p.titulo || p.cliente || formatarCnj(p.numero);
  const titulo = `Consultar os autos — ${nome}`;
  const descricao = [p.proximo_passo ? `Próximo passo: ${p.proximo_passo}` : null, `Processo ${formatarCnj(p.numero)}`]
    .filter(Boolean)
    .join('\n');
  const dataHora = isoBrasilia(p.proxima_consulta, HORA_AVISO_CONSULTA);
  const existente = await db.get('SELECT * FROM lembretes WHERE origem = ?', origem);
  if (existente) {
    const reagendar = reabrir || existente.data_hora !== dataHora;
    await db.run(
      `UPDATE lembretes SET titulo = ?, descricao = ?, data_hora = ?, antecedencia_min = 0, processo_id = ?${reagendar ? ', notificado_em = NULL, concluido = 0' : ''} WHERE id = ?`,
      titulo,
      descricao,
      dataHora,
      p.id,
      existente.id,
    );
  } else {
    await db.run(
      `INSERT INTO lembretes (titulo, descricao, tipo, data_hora, antecedencia_min, processo_id, origem)
       VALUES (?, ?, 'lembrete', ?, 0, ?, ?)`,
      titulo,
      descricao,
      dataHora,
      p.id,
      origem,
    );
  }
}

/** "Consultei hoje": registra a consulta e agenda a próxima conforme o intervalo do processo. */
export async function registrarConsulta(db, processoId, { agora = agoraIso() } = {}) {
  const p = await db.get('SELECT * FROM processos WHERE id = ?', processoId);
  if (!p) return null;
  const hoje = dataBrasilia(agora);
  const proxima = calcularProximaConsulta(hoje, p.consulta_intervalo || INTERVALO_PADRAO);
  await db.run(
    'UPDATE processos SET ultima_consulta = ?, proxima_consulta = ?, atualizado_em = ? WHERE id = ?',
    hoje,
    proxima,
    agora,
    p.id,
  );
  await sincronizarConsulta(db, p.id, { reabrir: true });
  return db.get('SELECT * FROM processos WHERE id = ?', p.id);
}

export const ehLembreteDeConsulta = (l) => typeof l?.origem === 'string' && l.origem.startsWith('consulta|');
export const processoDoLembrete = (l) => Number(l.origem.split('|')[1]);

/** Processos em acompanhamento diário sem data marcada (ou sem o lembrete): agenda a 1ª consulta pelo intervalo. */
export async function agendarConsultasPendentes(db, { agora = agoraIso() } = {}) {
  const faltando = await db.all(
    `SELECT p.id, p.proxima_consulta, p.consulta_intervalo FROM processos p
     WHERE p.acompanhamento_diario = 1
       AND (p.proxima_consulta IS NULL OR NOT EXISTS (SELECT 1 FROM lembretes l WHERE l.origem = 'consulta|' || p.id))`,
  );
  for (const p of faltando) {
    if (!p.proxima_consulta) {
      await db.run('UPDATE processos SET proxima_consulta = ? WHERE id = ?', calcularProximaConsulta(dataBrasilia(agora), p.consulta_intervalo), p.id);
    }
    await sincronizarConsulta(db, p.id);
  }
  return faltando.length;
}
