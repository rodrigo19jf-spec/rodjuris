import { agoraIso, getConfig, setConfig } from './db.js';
import { formatarCnj, somenteDigitos } from './cnj.js';
import { buscarProcessoDataJud, buscarPublicacoesDjen } from './fontes.js';
import { formatarDataHora, notificar } from './notificador.js';

const DIA = 86_400_000;
// Na primeira verificação de um processo, busca publicações deste período para trás
// e as guarda como "já lidas" (linha de base), sem disparar avisos.
const DIAS_LINHA_DE_BASE = 180;
// Nas verificações seguintes, volta alguns dias para pegar publicações disponibilizadas com atraso.
const DIAS_MARGEM = 7;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function resumo(texto, max = 1500) {
  const t = String(texto || '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Grava publicações novas; devolve apenas as que ainda não existiam. */
function gravarPublicacoes(db, itens, { processoId = null, linhaDeBase = false } = {}) {
  const porNumero = db.prepare('SELECT id FROM processos WHERE numero = ?');
  const inserir = db.prepare(`
    INSERT INTO publicacoes (processo_id, origem, external_id, numero_processo, data_disponibilizacao, tribunal, orgao, tipo, texto, link, lida)
    VALUES (?, 'djen', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (origem, external_id) DO NOTHING`);
  const vincular = db.prepare(
    "UPDATE publicacoes SET processo_id = ? WHERE origem = 'djen' AND external_id = ? AND processo_id IS NULL",
  );
  const novas = [];
  for (const p of itens) {
    const pid = processoId ?? porNumero.get(p.numero_processo)?.id ?? null;
    const r = inserir.run(
      pid,
      p.external_id,
      p.numero_processo,
      p.data_disponibilizacao,
      p.tribunal,
      p.orgao,
      p.tipo,
      p.texto,
      p.link,
      linhaDeBase ? 1 : 0,
    );
    if (r.changes > 0) novas.push({ ...p, processo_id: pid });
    else if (pid) vincular.run(pid, p.external_id);
  }
  return novas;
}

function gravarAndamentos(db, processoId, movimentos, { linhaDeBase = false } = {}) {
  const inserir = db.prepare(`
    INSERT INTO andamentos (processo_id, external_key, data, nome, complemento, lida)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (processo_id, external_key) DO NOTHING`);
  const novos = [];
  for (const m of movimentos) {
    const r = inserir.run(processoId, m.external_key, m.data, m.nome, m.complemento, linhaDeBase ? 1 : 0);
    if (r.changes > 0) novos.push(m);
  }
  return novos;
}

function textoEmailPublicacoes(cabecalho, pubs) {
  const blocos = pubs.map(
    (p) =>
      `Processo: ${formatarCnj(p.numero_processo)}\nData: ${p.data_disponibilizacao || '-'} | ${p.tribunal || ''} ${p.orgao ? '— ' + p.orgao : ''}\nTipo: ${p.tipo || '-'}\n${p.link ? 'Link: ' + p.link + '\n' : ''}\n${resumo(p.texto)}`,
  );
  return `${cabecalho}\n\n${blocos.join('\n\n────────────────────────\n\n')}`;
}

/**
 * Verifica um processo: publicações no DJEN + movimentações no DataJud.
 * @returns {{ publicacoes: number, andamentos: number, erros: string[] }}
 */
export async function verificarProcesso(db, processo, { fetchFn = fetch, avisar = true } = {}) {
  const linhaDeBase = !processo.ultima_verificacao;
  const desde = linhaDeBase
    ? new Date(Date.now() - DIAS_LINHA_DE_BASE * DIA)
    : new Date(new Date(processo.ultima_verificacao).getTime() - DIAS_MARGEM * DIA);
  const erros = [];
  let novasPubs = [];
  let novosAnd = [];

  try {
    const itens = await buscarPublicacoesDjen({ numeroProcesso: processo.numero }, desde, { fetchFn });
    novasPubs = gravarPublicacoes(db, itens, { processoId: processo.id, linhaDeBase });
  } catch (err) {
    erros.push(`DJEN: ${err.message}`);
  }

  try {
    const dj = await buscarProcessoDataJud(processo.numero, { fetchFn });
    if (dj) {
      novosAnd = gravarAndamentos(db, processo.id, dj.movimentos, { linhaDeBase });
      // Preenche campos vazios do cadastro com os dados oficiais.
      db.prepare(`
        UPDATE processos SET
          tribunal = COALESCE(NULLIF(tribunal, ''), ?),
          classe   = COALESCE(NULLIF(classe, ''), ?),
          orgao    = COALESCE(NULLIF(orgao, ''), ?),
          assunto  = COALESCE(NULLIF(assunto, ''), ?)
        WHERE id = ?`).run(dj.tribunal, dj.classe, dj.orgao, dj.assunto, processo.id);
    }
  } catch (err) {
    erros.push(`DataJud: ${err.message}`);
  }

  db.prepare('UPDATE processos SET ultima_verificacao = ?, erro_verificacao = ? WHERE id = ?').run(
    agoraIso(),
    erros.length ? erros.join(' | ') : null,
    processo.id,
  );

  if (avisar && !linhaDeBase) {
    const nome = processo.titulo || processo.cliente || formatarCnj(processo.numero);
    if (novasPubs.length > 0) {
      await notificar(db, {
        tipo: 'publicacao',
        titulo: `${novasPubs.length} nova(s) publicação(ões) — ${nome}`,
        mensagem: `${formatarCnj(processo.numero)}: ${resumo(novasPubs[0].tipo || novasPubs[0].texto, 140)}`,
        link: `/#/processos/${processo.id}`,
        emailTexto: textoEmailPublicacoes(
          `Novas publicações no DJEN para o processo ${formatarCnj(processo.numero)} (${nome}).`,
          novasPubs,
        ),
      });
    }
    if (novosAnd.length > 0) {
      const linhas = novosAnd
        .map((m) => `• ${formatarDataHora(m.data)} — ${m.nome}${m.complemento ? ` (${m.complemento})` : ''}`)
        .join('\n');
      await notificar(db, {
        tipo: 'andamento',
        titulo: `${novosAnd.length} novo(s) andamento(s) — ${nome}`,
        mensagem: `${novosAnd[0].nome}`,
        link: `/#/processos/${processo.id}`,
        emailTexto: `Novas movimentações no processo ${formatarCnj(processo.numero)} (${nome}):\n\n${linhas}`,
      });
    }
  }

  return { publicacoes: novasPubs.length, andamentos: novosAnd.length, erros, linhaDeBase };
}

/** Monitora tudo que sai no DJEN em nome do advogado (número da OAB), se configurado. */
export async function verificarOab(db, { fetchFn = fetch, avisar = true } = {}) {
  const numero = somenteDigitos(getConfig(db, 'oab_numero', ''));
  const uf = String(getConfig(db, 'oab_uf', '') || '').toUpperCase();
  if (!numero || !uf) return { publicacoes: 0, ignorado: true };

  const chaveUlt = `oab_ultima_verificacao_${numero}_${uf}`;
  const ultima = getConfig(db, chaveUlt);
  const linhaDeBase = !ultima;
  const desde = linhaDeBase ? new Date(Date.now() - 30 * DIA) : new Date(new Date(ultima).getTime() - DIAS_MARGEM * DIA);

  const itens = await buscarPublicacoesDjen({ numeroOab: numero, ufOab: uf }, desde, { fetchFn });
  const novas = gravarPublicacoes(db, itens, { linhaDeBase });
  setConfig(db, chaveUlt, agoraIso());

  if (avisar && !linhaDeBase && novas.length > 0) {
    await notificar(db, {
      tipo: 'publicacao',
      titulo: `${novas.length} nova(s) publicação(ões) em nome da OAB ${numero}/${uf}`,
      mensagem: novas
        .slice(0, 3)
        .map((p) => formatarCnj(p.numero_processo))
        .join(', '),
      link: '/#/publicacoes',
      emailTexto: textoEmailPublicacoes(`Novas publicações no DJEN em nome da OAB ${numero}/${uf}.`, novas),
    });
  }
  return { publicacoes: novas.length, linhaDeBase };
}

let verificando = false;

/** Verifica todos os processos marcados para monitoramento + a OAB. */
export async function verificarTudo(db, { fetchFn = fetch, pausaMs = 1500 } = {}) {
  if (verificando) return { emAndamento: true };
  verificando = true;
  const resultado = { processos: 0, publicacoes: 0, andamentos: 0, erros: [] };
  try {
    const lista = db
      .prepare("SELECT * FROM processos WHERE monitorar = 1 AND status != 'encerrado' ORDER BY ultima_verificacao IS NOT NULL, ultima_verificacao")
      .all();
    for (const p of lista) {
      const r = await verificarProcesso(db, p, { fetchFn });
      resultado.processos++;
      resultado.publicacoes += r.publicacoes;
      resultado.andamentos += r.andamentos;
      if (r.erros.length) resultado.erros.push(`${formatarCnj(p.numero)}: ${r.erros.join(' | ')}`);
      if (pausaMs) await esperar(pausaMs); // respeita os servidores do CNJ
    }
    try {
      const o = await verificarOab(db, { fetchFn });
      resultado.publicacoes += o.publicacoes || 0;
    } catch (err) {
      resultado.erros.push(`OAB: ${err.message}`);
    }
    setConfig(db, 'ultima_verificacao_geral', agoraIso());
  } finally {
    verificando = false;
  }
  return resultado;
}

/** Dispara os lembretes cujo horário de aviso já chegou. */
export async function verificarLembretes(db, agora = new Date()) {
  const pendentes = db
    .prepare(`
      SELECT l.*, p.numero AS processo_numero, p.titulo AS processo_titulo
      FROM lembretes l LEFT JOIN processos p ON p.id = l.processo_id
      WHERE l.concluido = 0 AND l.notificado_em IS NULL`)
    .all();
  const marcar = db.prepare('UPDATE lembretes SET notificado_em = ? WHERE id = ?');
  let disparados = 0;
  for (const l of pendentes) {
    const evento = new Date(l.data_hora).getTime();
    const aviso = evento - Number(l.antecedencia_min || 0) * 60_000;
    if (agora.getTime() < aviso) continue;
    marcar.run(agora.toISOString(), l.id);
    // Lembretes cadastrados já muito no passado não geram aviso.
    if (agora.getTime() - evento > DIA) continue;
    const rotulo = { prazo: 'Prazo', audiencia: 'Audiência', reuniao: 'Reunião', lembrete: 'Lembrete', outro: 'Lembrete' }[l.tipo] || 'Lembrete';
    const proc = l.processo_numero ? `\nProcesso: ${formatarCnj(l.processo_numero)}${l.processo_titulo ? ` (${l.processo_titulo})` : ''}` : '';
    await notificar(db, {
      tipo: 'lembrete',
      titulo: `${rotulo}: ${l.titulo}`,
      mensagem: `${formatarDataHora(l.data_hora)}${l.descricao ? ' — ' + l.descricao : ''}`,
      link: '/#/lembretes',
      emailTexto: `${rotulo}: ${l.titulo}\nQuando: ${formatarDataHora(l.data_hora)}${proc}\n\n${l.descricao || ''}`,
    });
    disparados++;
  }
  return disparados;
}
