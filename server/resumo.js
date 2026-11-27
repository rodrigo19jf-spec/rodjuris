import { agoraIso, getConfig, setConfig } from './db.js';
import { formatarCnj } from './cnj.js';
import { dataBrasilia, feriadosNacionais } from './prazos.js';
import { formatarDataHora, notificar } from './notificador.js';

/** Processos em acompanhamento diário, com o que há de novo e de pendente em cada um. */
export async function processosDiarios(db) {
  const agora = agoraIso();
  const em3 = new Date(Date.now() + 3 * 86_400_000).toISOString();
  return db.all(
    `SELECT p.id, p.numero, p.titulo, p.cliente, p.status, p.proximo_passo,
       (SELECT COUNT(*)::int FROM publicacoes pu WHERE pu.processo_id = p.id AND pu.lida = 0) AS pub_nao_lidas,
       (SELECT COUNT(*)::int FROM andamentos an WHERE an.processo_id = p.id AND an.lida = 0) AS and_nao_lidos,
       (SELECT an.nome FROM andamentos an WHERE an.processo_id = p.id ORDER BY an.data DESC NULLS LAST, an.id DESC LIMIT 1) AS ultimo_andamento,
       (SELECT an.data FROM andamentos an WHERE an.processo_id = p.id ORDER BY an.data DESC NULLS LAST, an.id DESC LIMIT 1) AS ultimo_andamento_data,
       (SELECT COUNT(*)::int FROM lembretes l WHERE l.processo_id = p.id AND l.concluido = 0 AND l.data_hora < ?) AS lembretes_atrasados,
       (SELECT l.titulo FROM lembretes l WHERE l.processo_id = p.id AND l.concluido = 0 AND l.data_hora <= ? ORDER BY l.data_hora LIMIT 1) AS proximo_lembrete_titulo,
       (SELECT l.data_hora FROM lembretes l WHERE l.processo_id = p.id AND l.concluido = 0 AND l.data_hora <= ? ORDER BY l.data_hora LIMIT 1) AS proximo_lembrete
     FROM processos p
     WHERE p.acompanhamento_diario = 1
     ORDER BY (SELECT COUNT(*) FROM publicacoes pu WHERE pu.processo_id = p.id AND pu.lida = 0)
            + (SELECT COUNT(*) FROM andamentos an WHERE an.processo_id = p.id AND an.lida = 0) > 0 DESC,
            LOWER(COALESCE(p.titulo, p.cliente, p.numero))`,
    agora,
    em3,
    em3,
  );
}

const HORA_RESUMO = Number(process.env.RESUMO_DIARIO_HORA || 8);

/** Dia útil para o resumo: segunda a sexta, exceto feriados nacionais (o recesso forense não conta aqui). */
function diaDeTrabalho(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const sem = d.getUTCDay();
  return sem !== 0 && sem !== 6 && !feriadosNacionais(d.getUTCFullYear()).has(ymd);
}

function horaBrasilia(iso) {
  return Number(new Date(iso).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }));
}

/** Monta o texto do resumo (e-mail) e a mensagem curta (celular). */
export function textoResumo(lista) {
  const comNovidade = lista.filter((p) => p.pub_nao_lidas + p.and_nao_lidos > 0);
  const linhas = lista.map((p) => {
    const nome = p.titulo || p.cliente || formatarCnj(p.numero);
    const partes = [`• ${nome} (${formatarCnj(p.numero)})`];
    if (p.proximo_passo) partes.push(`  Próximo passo: ${p.proximo_passo}`);
    const novidades = [];
    if (p.pub_nao_lidas) novidades.push(`${p.pub_nao_lidas} publicação(ões)`);
    if (p.and_nao_lidos) novidades.push(`${p.and_nao_lidos} andamento(s)`);
    partes.push(`  Novidades: ${novidades.length ? novidades.join(' e ') + ' não lido(s)' : 'nenhuma'}`);
    if (p.ultimo_andamento) partes.push(`  Último andamento: ${p.ultimo_andamento}${p.ultimo_andamento_data ? ` (${formatarDataHora(p.ultimo_andamento_data)})` : ''}`);
    if (p.lembretes_atrasados) partes.push(`  ⚠ ${p.lembretes_atrasados} lembrete(s) atrasado(s)`);
    if (p.proximo_lembrete) partes.push(`  Próximo lembrete: ${p.proximo_lembrete_titulo} — ${formatarDataHora(p.proximo_lembrete)}`);
    return partes.join('\n');
  });
  const curta = [
    comNovidade.length ? `${comNovidade.length} com novidade` : 'Sem novidades',
    ...lista.filter((p) => p.proximo_passo).slice(0, 3).map((p) => `${p.titulo || formatarCnj(p.numero)}: ${p.proximo_passo}`),
  ].join(' · ');
  return {
    titulo: `Acompanhamento diário — ${lista.length} processo(s)`,
    mensagem: curta,
    emailTexto: `Resumo dos processos em acompanhamento diário:\n\n${linhas.join('\n\n')}\n\nAbra o RodJuris para ver os detalhes.`,
  };
}

/** Envia o resumo uma vez por dia útil, a partir das 8h (horário de Brasília). */
export async function enviarResumoDiario(db, { agora = agoraIso() } = {}) {
  const hoje = dataBrasilia(agora);
  const hora = horaBrasilia(agora);
  if (hora < HORA_RESUMO || hora >= 20 || !diaDeTrabalho(hoje)) return { enviado: false, motivo: 'fora do horário' };
  if ((await getConfig(db, 'resumo_diario_ultimo')) === hoje) return { enviado: false, motivo: 'já enviado hoje' };
  await setConfig(db, 'resumo_diario_ultimo', hoje);
  const lista = await processosDiarios(db);
  if (!lista.length) return { enviado: false, motivo: 'nenhum processo em acompanhamento diário' };
  const r = textoResumo(lista);
  await notificar(db, { tipo: 'resumo', titulo: r.titulo, mensagem: r.mensagem, link: '/#/processos?grupo=diario', emailTexto: r.emailTexto });
  return { enviado: true, processos: lista.length };
}
