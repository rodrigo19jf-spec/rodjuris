// Acompanhamento do cumprimento de liminares deferidas.
//
// Enquanto o cumprimento estiver pendente (pendente / em andamento / parcial), o app mantém:
//   - um lembrete do PRAZO FINAL (aviso 2 dias antes), se a data foi informada;
//   - um lembrete de COBRANÇA do setor responsável a cada N dias úteis (padrão 3).
// Ao marcar como "cumprida" (ou mudar a liminar), esses lembretes são concluídos automaticamente.

import { agoraIso } from './db.js';
import { formatarCnj } from './cnj.js';
import { dataBrasilia, isoBrasilia, vencimentoDiasUteis } from './prazos.js';

export const SITUACOES_CUMPRIMENTO = ['pendente', 'andamento', 'parcial', 'cumprida'];
export const ROTULO_CUMPRIMENTO = {
  pendente: 'Pendente de cumprimento',
  andamento: 'Cumprimento em andamento',
  parcial: 'Cumprida parcialmente',
  cumprida: 'Cumprida',
};

export function cumprimentoAberto(p) {
  return p?.liminar === 'deferida' && ['pendente', 'andamento', 'parcial'].includes(p?.cumprimento_situacao);
}

const nomeProcesso = (p) => p.titulo || p.cliente || formatarCnj(p.numero);

async function concluirLembretesDoCumprimento(db, processoId) {
  await db.run(
    `UPDATE lembretes SET concluido = 1
     WHERE concluido = 0 AND (origem = ? OR origem LIKE ?)`,
    `cumprimento-prazo|${processoId}`,
    `cobranca|${processoId}|%`,
  );
}

async function criarCobranca(db, p, hoje = dataBrasilia(agoraIso())) {
  const dias = Math.max(1, Math.min(Number(p.cumprimento_cobranca_dias) || 3, 30));
  // Conta a partir da cobrança mais recente (se for futura) para nunca repetir a mesma data.
  const ultima = await db.get(
    'SELECT data_hora FROM lembretes WHERE origem LIKE ? ORDER BY data_hora DESC LIMIT 1',
    `cobranca|${p.id}|%`,
  );
  const ultimaData = ultima ? dataBrasilia(ultima.data_hora) : null;
  const base = ultimaData && ultimaData > hoje ? ultimaData : hoje;
  const data = vencimentoDiasUteis(base, dias);
  const prazo = p.cumprimento_prazo ? ` Prazo final: ${p.cumprimento_prazo.split('-').reverse().join('/')}.` : '';
  const r = await db.run(
    `INSERT INTO lembretes (titulo, descricao, tipo, data_hora, antecedencia_min, processo_id, origem)
     VALUES (?, ?, 'lembrete', ?, 0, ?, ?) ON CONFLICT (origem) DO NOTHING`,
    `Cobrar cumprimento da liminar — ${nomeProcesso(p)}`,
    `Verificar com ${p.cumprimento_responsavel || 'o setor responsável'} o andamento do cumprimento da liminar.${prazo}\nAo concluir, registre a providência no processo ou marque a liminar como cumprida.`,
    isoBrasilia(data, '09:00'),
    p.id,
    `cobranca|${p.id}|${data}`,
  );
  return r.rowCount > 0;
}

/**
 * Ajusta os lembretes do cumprimento de um processo ao estado atual do cadastro.
 * Chamado depois de criar/editar o processo.
 */
export async function sincronizarCumprimento(db, processoId) {
  const p = await db.get('SELECT * FROM processos WHERE id = ?', processoId);
  if (!p) return;
  if (!cumprimentoAberto(p)) {
    await concluirLembretesDoCumprimento(db, p.id);
    return;
  }

  // Lembrete do prazo final (data informada pelo usuário: não é "sugestão").
  const origemPrazo = `cumprimento-prazo|${p.id}`;
  const atual = await db.get('SELECT * FROM lembretes WHERE origem = ?', origemPrazo);
  if (p.cumprimento_prazo) {
    const dataHora = isoBrasilia(p.cumprimento_prazo, '18:00');
    const titulo = `Prazo para cumprimento da liminar — ${nomeProcesso(p)}`;
    const descricao = [
      p.cumprimento_responsavel ? `Responsável: ${p.cumprimento_responsavel}.` : null,
      p.cumprimento_multa ? `Multa fixada: ${p.cumprimento_multa}.` : null,
      'Ao cumprir, marque a liminar como cumprida no processo.',
    ]
      .filter(Boolean)
      .join('\n');
    if (atual) {
      const mudou = atual.data_hora !== dataHora;
      await db.run(
        `UPDATE lembretes SET titulo = ?, descricao = ?, data_hora = ?, concluido = 0${mudou ? ', notificado_em = NULL' : ''} WHERE id = ?`,
        titulo,
        descricao,
        dataHora,
        atual.id,
      );
    } else {
      await db.run(
        `INSERT INTO lembretes (titulo, descricao, tipo, data_hora, antecedencia_min, processo_id, origem)
         VALUES (?, ?, 'prazo', ?, 2880, ?, ?)`,
        titulo,
        descricao,
        dataHora,
        p.id,
        origemPrazo,
      );
    }
  } else if (atual && !atual.concluido) {
    await db.run('UPDATE lembretes SET concluido = 1 WHERE id = ?', atual.id);
  }

  // Cobrança: garante que exista uma em aberto.
  const aberta = await db.get(
    "SELECT 1 FROM lembretes WHERE origem LIKE ? AND concluido = 0 AND notificado_em IS NULL",
    `cobranca|${p.id}|%`,
  );
  if (!aberta) await criarCobranca(db, p);
}

/**
 * Chamado pelo agendador: para cada cumprimento em aberto cuja última cobrança já foi avisada
 * (ou concluída), agenda a próxima.
 */
export async function agendarCobrancas(db) {
  const pendentes = await db.all(
    `SELECT * FROM processos
     WHERE liminar = 'deferida' AND cumprimento_situacao IN ('pendente', 'andamento', 'parcial')`,
  );
  let criadas = 0;
  for (const p of pendentes) {
    const aberta = await db.get(
      'SELECT 1 FROM lembretes WHERE origem LIKE ? AND concluido = 0 AND notificado_em IS NULL',
      `cobranca|${p.id}|%`,
    );
    if (!aberta && (await criarCobranca(db, p))) criadas++;
  }
  return criadas;
}

/** Calculadora de prazo para o botão "Calcular" (sugestão — o usuário confere). */
export function calcularPrazo({ data, quantidade, unidade }) {
  const n = Math.max(1, Math.min(Number(quantidade) || 0, 3650));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) throw new Error('Informe a data da intimação.');
  if (unidade === 'corridos') {
    const d = new Date(`${data}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return { data: d.toISOString().slice(0, 10), observacao: 'Dias corridos contados a partir do dia seguinte à intimação.' };
  }
  if (unidade === 'horas') {
    const d = new Date(`${data}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Math.ceil(n / 24));
    return {
      data: d.toISOString().slice(0, 10),
      observacao: 'Prazo em horas conta minuto a minuto desde a intimação: confira o horário exato.',
    };
  }
  return {
    data: vencimentoDiasUteis(data, n),
    observacao: 'Dias úteis, desconsiderando fins de semana, feriados nacionais e o recesso de 20/12 a 20/1 (não inclui feriados locais).',
  };
}

