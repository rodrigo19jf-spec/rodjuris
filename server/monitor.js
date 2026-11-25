import { agoraIso, getConfig, setConfig } from './db.js';
import { formatarCnj, somenteDigitos } from './cnj.js';
import { buscarProcessoDataJud, buscarPublicacoesDjen } from './fontes.js';
import { buscarProcessoPjeTjmg, ehTjmg } from './pje_tjmg.js';
import { buscarProcessoEproc, eprocDisponivel, listarAvisosPendentesEproc } from './eproc_mni.js';
import { textoClasse } from './classes_cnj.js';
import { agendarCobrancas } from './cumprimento.js';
import { dataBrasilia, isoBrasilia, lerIntimacaoComPrazo, parteEhCliente, somarDiasCorridos, vencimentoDiasUteis } from './prazos.js';
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

export async function intervaloHoras(db) {
  return Math.max(1, Math.min(Number(await getConfig(db, 'intervalo_horas', '4')) || 4, 24));
}

/** Grava publicações novas; devolve apenas as que ainda não existiam. */
async function gravarPublicacoes(db, itens, { processoId = null, linhaDeBase = false } = {}) {
  const novas = [];
  for (const p of itens) {
    const pid = processoId ?? (await db.get('SELECT id FROM processos WHERE numero = ?', p.numero_processo))?.id ?? null;
    const r = await db.run(
      `INSERT INTO publicacoes (processo_id, origem, external_id, numero_processo, data_disponibilizacao, tribunal, orgao, tipo, texto, link, lida)
       VALUES (?, 'djen', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (origem, external_id) DO NOTHING`,
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
    if (r.rowCount > 0) novas.push({ ...p, processo_id: pid });
    else if (pid) {
      await db.run(
        "UPDATE publicacoes SET processo_id = ? WHERE origem = 'djen' AND external_id = ? AND processo_id IS NULL",
        pid,
        p.external_id,
      );
    }
  }
  return novas;
}

async function gravarAndamentos(db, processoId, movimentos, { linhaDeBase = false, fonte = 'datajud' } = {}) {
  const novos = [];
  for (const m of movimentos) {
    const r = await db.run(
      `INSERT INTO andamentos (processo_id, external_key, data, nome, complemento, lida, fonte)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (processo_id, external_key) DO NOTHING`,
      processoId,
      m.external_key,
      m.data,
      m.nome,
      m.complemento,
      linhaDeBase ? 1 : 0,
      fonte,
    );
    if (r.rowCount > 0) novos.push(m);
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

// Quando o DataJud (CNJ) está sobrecarregado, pausa as consultas por um tempo para não piorar a fila.
const PAUSA_DATAJUD_MIN = 10;
// Processos cujo DataJud falhou são tentados de novo neste intervalo.
const RETENTATIVA_DATAJUD_MIN = 20;

async function dataJudPausado(db) {
  const ate = await getConfig(db, 'datajud_pausa_ate');
  return !!ate && ate > agoraIso();
}
async function pausarDataJud(db) {
  await setConfig(db, 'datajud_pausa_ate', new Date(Date.now() + PAUSA_DATAJUD_MIN * 60_000).toISOString());
}

const DIAS_RECHECAR_PJE_AUSENTE = 7;

/** O processo deve ser consultado no PJe do TJMG nesta verificação? */
function deveConsultarPje(processo) {
  if (process.env.PJE_TJMG === '0' || !ehTjmg(processo.numero)) return false;
  if (processo.pje_situacao === 'migrado') return false;
  if (processo.pje_situacao === 'ausente') {
    // Processos que não estão no PJe são reconferidos de vez em quando.
    return !processo.pje_verificado_em || Date.now() - new Date(processo.pje_verificado_em).getTime() > DIAS_RECHECAR_PJE_AUSENTE * DIA;
  }
  return true;
}

/**
 * Sugere lembretes de prazo a partir de intimações com prazo em aberto nos andamentos (eproc).
 * Só sugere quando a parte intimada corresponde ao cliente cadastrado (ou se o cliente não foi informado).
 * A data é a MAIS CEDO possível (ciência no próprio dia da expedição) e sempre precisa ser confirmada.
 */
export async function sugerirPrazosDeAndamentos(db, processo, andamentos) {
  let criados = 0;
  for (const a of andamentos) {
    const intimacao = lerIntimacaoComPrazo(a);
    if (!intimacao || !a.data) continue;
    const semCliente = !processo.cliente;
    if (!semCliente && intimacao.parte && !parteEhCliente(intimacao.parte, processo.cliente)) continue;
    const ciencia = dataBrasilia(a.data);
    const vencimento = vencimentoDiasUteis(ciencia, intimacao.dias);
    const descricao = [
      `Sugestão automática a partir do andamento de ${formatarDataHora(a.data)}: "${a.nome}".`,
      intimacao.parte ? `Parte intimada: ${intimacao.parte}.` : null,
      semCliente ? '⚠️ O cliente não está cadastrado neste processo: verifique se a intimação é para o seu cliente.' : null,
      `Estimativa: ${intimacao.dias} dias úteis contados como se a ciência fosse no mesmo dia (${ciencia.split('-').reverse().join('/')}). Se a ciência ocorrer depois, o prazo final também será mais tarde.`,
      'Não considera feriados locais, suspensões do tribunal nem prazos em dobro (Fazenda Pública, Defensoria etc.). Confira e ajuste a data.',
    ]
      .filter(Boolean)
      .join('\n');
    const r = await db.run(
      `INSERT INTO lembretes (titulo, descricao, tipo, data_hora, antecedencia_min, processo_id, sugerido, origem)
       VALUES (?, ?, 'prazo', ?, 2880, ?, 1, ?) ON CONFLICT (origem) DO NOTHING`,
      `Prazo de ${intimacao.dias} dias — ${processo.titulo || formatarCnj(processo.numero)}`,
      descricao,
      isoBrasilia(vencimento, '18:00'),
      processo.id,
      `andamento|${processo.id}|${a.external_key}`,
    );
    if (r.rowCount > 0) criados++;
  }
  if (criados > 0) {
    await notificar(db, {
      tipo: 'lembrete',
      titulo: `${criados} sugestão(ões) de prazo — ${processo.titulo || formatarCnj(processo.numero)}`,
      mensagem: 'Confira a data e confirme em Lembretes.',
      link: '/#/lembretes',
      emailTexto: `O RodJuris identificou intimação com prazo em aberto no processo ${formatarCnj(processo.numero)} e criou ${criados} sugestão(ões) de lembrete de prazo.\n\nAs datas são estimativas: confira e confirme em Lembretes.`,
    });
  }
  return criados;
}

function deveConsultarEproc(processo) {
  if (processo.eproc_situacao !== 'ausente') return true;
  return !processo.eproc_verificado_em || Date.now() - new Date(processo.eproc_verificado_em).getTime() > DIAS_RECHECAR_PJE_AUSENTE * DIA;
}

async function preencherCadastro(db, processoId, dados) {
  await db.run(
    `UPDATE processos SET
       tribunal = COALESCE(NULLIF(tribunal, ''), ?),
       classe   = CASE WHEN classe IS NULL OR classe = '' OR classe LIKE 'Classe CNJ %' THEN COALESCE(?, classe) ELSE classe END,
       orgao    = COALESCE(NULLIF(orgao, ''), ?),
       assunto  = COALESCE(NULLIF(assunto, ''), ?)
     WHERE id = ?`,
    dados.tribunal ?? null,
    dados.classe ?? null,
    dados.orgao ?? null,
    dados.assunto ?? null,
    processoId,
  );
}

/**
 * Verifica um processo:
 * - publicações no DJEN;
 * - andamentos no PJe do TJMG (se o processo estiver lá) ou, senão, no DataJud.
 * Opções djen/datajud/pje permitem consultar só algumas fontes (ex.: nova tentativa só do DataJud).
 */
export async function verificarProcesso(
  db,
  processo,
  { fetchFn = fetch, avisar = true, djen: usarDjen = true, datajud: usarDatajud = true, pje: usarPje = true, eproc: usarEproc = true } = {},
) {
  const linhaDeBase = !processo.ultima_verificacao; // publicações
  const desde = linhaDeBase
    ? new Date(Date.now() - DIAS_LINHA_DE_BASE * DIA)
    : new Date(new Date(processo.ultima_verificacao).getTime() - DIAS_MARGEM * DIA);
  const erros = [];
  const avisosAndamentos = []; // andamentos novos (fora da linha de base) para avisar
  const agora = agoraIso();

  const promessaDjen = usarDjen
    ? buscarPublicacoesDjen({ numeroProcesso: processo.numero }, desde, { fetchFn }).then(
        (v) => ({ ok: true, v }),
        (e) => ({ ok: false, e }),
      )
    : null;

  // 1) PJe do TJMG (rápido e direto do tribunal), quando aplicável.
  let pjeAtivo = false;
  let migrouAgora = null;
  if (usarPje && deveConsultarPje(processo)) {
    try {
      const pje = await buscarProcessoPjeTjmg(processo.numero, { fetchFn });
      if (!pje) {
        await db.run("UPDATE processos SET pje_situacao = 'ausente', pje_verificado_em = ? WHERE id = ?", agora, processo.id);
      } else {
        const baseDoPje = !processo.pje_em;
        const novos = await gravarAndamentos(db, processo.id, pje.movimentos, { linhaDeBase: baseDoPje, fonte: 'pje' });
        if (!baseDoPje) avisosAndamentos.push(...novos);
        await preencherCadastro(db, processo.id, pje);
        const situacao = pje.migrado ? 'migrado' : 'ativo';
        if (pje.migrado && processo.pje_situacao !== 'migrado') migrouAgora = pje.migrado;
        await db.run(
          'UPDATE processos SET pje_situacao = ?, pje_em = COALESCE(pje_em, ?), pje_verificado_em = ? WHERE id = ?',
          situacao,
          agora,
          agora,
          processo.id,
        );
        pjeAtivo = situacao === 'ativo';
      }
    } catch (e) {
      if (!e?.temporario) erros.push(`PJe TJMG: ${e?.message || e}`);
      pjeAtivo = processo.pje_situacao === 'ativo'; // instabilidade: não cai para o DataJud nesta rodada
    }
  }

  // 2) eproc do TJMG pelo webservice oficial (MNI), com o login do advogado.
  let eprocAtivo = false;
  if (!pjeAtivo && usarEproc && eprocDisponivel(processo.numero) && deveConsultarEproc(processo)) {
    try {
      const ep = await buscarProcessoEproc(processo.numero, { fetchFn });
      if (!ep) {
        await db.run("UPDATE processos SET eproc_situacao = 'ausente', eproc_verificado_em = ? WHERE id = ?", agora, processo.id);
      } else {
        const baseDoEproc = !processo.eproc_em;
        const novos = await gravarAndamentos(db, processo.id, ep.movimentos, { linhaDeBase: baseDoEproc, fonte: 'eproc' });
        if (!baseDoEproc) {
          avisosAndamentos.push(...novos);
          if (avisar) await sugerirPrazosDeAndamentos(db, processo, novos);
        }
        await preencherCadastro(db, processo.id, { ...ep, classe: await textoClasse(db, ep.classeCodigo, { fetchFn }) });
        await db.run(
          "UPDATE processos SET eproc_situacao = 'ativo', eproc_em = COALESCE(eproc_em, ?), eproc_verificado_em = ? WHERE id = ?",
          agora,
          agora,
          processo.id,
        );
        eprocAtivo = true;
      }
    } catch (e) {
      if (!e?.temporario) erros.push(e?.message || String(e));
      eprocAtivo = processo.eproc_situacao === 'ativo' && !!e?.temporario; // instabilidade: não cai para o DataJud
    }
  }

  // 3) DataJud, só se o processo não estiver sendo acompanhado pelo PJe nem pelo eproc.
  let datajudPendente = Number(processo.datajud_pendente || 0);
  if (usarDatajud && (pjeAtivo || eprocAtivo)) {
    datajudPendente = 0;
    await db.run('UPDATE processos SET datajud_pendente = 0 WHERE id = ?', processo.id);
  } else if (usarDatajud) {
    const linhaDeBaseDJ = !processo.datajud_em; // só a 1ª resposta bem-sucedida do DataJud
    if (await dataJudPausado(db)) {
      datajudPendente = 1;
    } else {
      try {
        const dj = await buscarProcessoDataJud(processo.numero, { fetchFn });
        datajudPendente = 0;
        if (dj) {
          const novos = await gravarAndamentos(db, processo.id, dj.movimentos, { linhaDeBase: linhaDeBaseDJ, fonte: 'datajud' });
          if (!linhaDeBaseDJ) avisosAndamentos.push(...novos);
          await preencherCadastro(db, processo.id, dj);
        }
        await db.run('UPDATE processos SET datajud_em = ? WHERE id = ?', agora, processo.id);
      } catch (e) {
        if (e?.temporario) {
          datajudPendente = 1; // instabilidade do CNJ: tenta de novo em breve, sem tratar como erro
          if (e.status === 429 || !e.status) await pausarDataJud(db);
        } else {
          erros.push(`DataJud: ${e?.message || e}`);
        }
      }
    }
    await db.run('UPDATE processos SET datajud_pendente = ?, datajud_tentativa = ? WHERE id = ?', datajudPendente, agora, processo.id);
  }

  // 4) Publicações do DJEN.
  let novasPubs = [];
  if (promessaDjen) {
    const r = await promessaDjen;
    if (r.ok) novasPubs = await gravarPublicacoes(db, r.v, { processoId: processo.id, linhaDeBase });
    else erros.push(`DJEN: ${r.e?.message || r.e}`);
    await db.run(
      'UPDATE processos SET ultima_verificacao = ?, erro_verificacao = ? WHERE id = ?',
      agoraIso(),
      erros.length ? erros.join(' | ') : null,
      processo.id,
    );
  }

  const nome = processo.titulo || processo.cliente || formatarCnj(processo.numero);
  if (avisar && !linhaDeBase && novasPubs.length > 0) {
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
  if (avisar && avisosAndamentos.length > 0) {
    const linhas = avisosAndamentos
      .map((m) => `• ${formatarDataHora(m.data)} — ${m.nome}${m.complemento ? ` (${m.complemento})` : ''}`)
      .join('\n');
    await notificar(db, {
      tipo: 'andamento',
      titulo: `${avisosAndamentos.length} novo(s) andamento(s) — ${nome}`,
      mensagem: `${avisosAndamentos[0].nome}`,
      link: `/#/processos/${processo.id}`,
      emailTexto: `Novas movimentações no processo ${formatarCnj(processo.numero)} (${nome}):\n\n${linhas}`,
    });
  }
  if (avisar && migrouAgora && processo.pje_em) {
    await notificar(db, {
      tipo: 'andamento',
      titulo: `Processo migrado do PJe para o eproc — ${nome}`,
      mensagem: `${formatarCnj(processo.numero)}: os andamentos passam a vir do DataJud.`,
      link: `/#/processos/${processo.id}`,
      emailTexto: `O processo ${formatarCnj(processo.numero)} (${nome}) foi migrado do PJe para o eproc no TJMG (${formatarDataHora(migrouAgora.data)}).\nA partir de agora, os andamentos serão acompanhados pelo DataJud e as publicações continuam pelo DJEN.`,
    });
  }

  return {
    publicacoes: novasPubs.length,
    andamentos: avisosAndamentos.length,
    erros,
    linhaDeBase,
    datajudPendente: !!datajudPendente,
    pje: pjeAtivo,
    eproc: eprocAtivo,
  };
}

/** Nova tentativa só no DataJud para os processos que ficaram pendentes (respeitando a pausa e o prazo). */
export async function retentarDataJud(db, { fetchFn = fetch, prazoMs = Infinity, inicio = Date.now() } = {}) {
  const r = { processos: 0, andamentos: 0 };
  if (await dataJudPausado(db)) return r;
  const limite = new Date(Date.now() - RETENTATIVA_DATAJUD_MIN * 60_000).toISOString();
  const lista = await db.all(
    `SELECT * FROM processos
     WHERE monitorar = 1 AND status <> 'encerrado' AND datajud_pendente = 1
       AND (datajud_tentativa IS NULL OR datajud_tentativa < ?)
     ORDER BY datajud_tentativa NULLS FIRST`,
    limite,
  );
  for (const p of lista) {
    if (Date.now() - inicio > prazoMs) break;
    const v = await verificarProcesso(db, p, { fetchFn, djen: false, pje: false, eproc: false });
    r.processos++;
    r.andamentos += v.andamentos;
    if (v.datajudPendente) break; // continua instável: tenta de novo no próximo ciclo
  }
  return r;
}

/** Monitora tudo que sai no DJEN em nome do advogado (número da OAB), se configurado. */
export async function verificarOab(db, { fetchFn = fetch, avisar = true, forcar = true } = {}) {
  const numero = somenteDigitos(await getConfig(db, 'oab_numero', ''));
  const uf = String((await getConfig(db, 'oab_uf', '')) || '').toUpperCase();
  if (!numero || !uf) return { publicacoes: 0, ignorado: true };

  const chaveUlt = `oab_ultima_verificacao_${numero}_${uf}`;
  const ultima = await getConfig(db, chaveUlt);
  if (!forcar && ultima && Date.now() - new Date(ultima).getTime() < (await intervaloHoras(db)) * 3_600_000) {
    return { publicacoes: 0, ignorado: true };
  }
  const linhaDeBase = !ultima;
  const desde = linhaDeBase ? new Date(Date.now() - 30 * DIA) : new Date(new Date(ultima).getTime() - DIAS_MARGEM * DIA);

  const itens = await buscarPublicacoesDjen({ numeroOab: numero, ufOab: uf }, desde, { fetchFn });
  const novas = await gravarPublicacoes(db, itens, { linhaDeBase });
  await setConfig(db, chaveUlt, agoraIso());

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

/**
 * Verifica os processos monitorados + a OAB.
 * - forcar=true (botão "Verificar agora"): todos os processos.
 * - forcar=false (agendador): só os que não foram verificados dentro do intervalo configurado.
 * - prazoMs: para antes de estourar o tempo (na Vercel cada execução tem no máximo 60 s);
 *   o que sobrar fica para a próxima execução.
 */
export async function verificarTudo(db, { fetchFn = fetch, pausaMs = 1500, forcar = true, prazoMs = Infinity } = {}) {
  if (verificando) return { emAndamento: true };
  verificando = true;
  const inicio = Date.now();
  const resultado = { processos: 0, publicacoes: 0, andamentos: 0, erros: [], pendentes: 0 };
  try {
    const limite = new Date(Date.now() - (await intervaloHoras(db)) * 3_600_000).toISOString();
    const lista = await db.all(
      `SELECT * FROM processos
       WHERE monitorar = 1 AND status <> 'encerrado'
         ${forcar ? '' : 'AND (ultima_verificacao IS NULL OR ultima_verificacao < ?)'}
       ORDER BY ultima_verificacao IS NOT NULL, ultima_verificacao`,
      ...(forcar ? [] : [limite]),
    );
    for (const [i, p] of lista.entries()) {
      if (Date.now() - inicio > prazoMs) {
        resultado.pendentes = lista.length - i;
        break;
      }
      const r = await verificarProcesso(db, p, { fetchFn });
      resultado.processos++;
      resultado.publicacoes += r.publicacoes;
      resultado.andamentos += r.andamentos;
      if (r.erros.length) resultado.erros.push(`${formatarCnj(p.numero)}: ${r.erros.join(' | ')}`);
      if (pausaMs && i < lista.length - 1) await esperar(pausaMs); // respeita os servidores do CNJ
    }
    if (Date.now() - inicio <= prazoMs) {
      try {
        const o = await verificarOab(db, { fetchFn, forcar });
        resultado.publicacoes += o.publicacoes || 0;
      } catch (err) {
        resultado.erros.push(`OAB: ${err.message}`);
      }
    }
    if (!resultado.pendentes) await setConfig(db, 'ultima_verificacao_geral', agoraIso());
  } finally {
    verificando = false;
  }
  return resultado;
}

/** Dispara os lembretes cujo horário de aviso já chegou. */
export async function verificarLembretes(db, agora = new Date()) {
  const pendentes = await db.all(
    `SELECT l.*, p.numero AS processo_numero, p.titulo AS processo_titulo
     FROM lembretes l LEFT JOIN processos p ON p.id = l.processo_id
     WHERE l.concluido = 0 AND l.notificado_em IS NULL`,
  );
  let disparados = 0;
  for (const l of pendentes) {
    const evento = new Date(l.data_hora).getTime();
    const aviso = evento - Number(l.antecedencia_min || 0) * 60_000;
    if (agora.getTime() < aviso) continue;
    // Marca antes de avisar: se duas execuções rodarem juntas, só uma avisa.
    const r = await db.run('UPDATE lembretes SET notificado_em = ? WHERE id = ? AND notificado_em IS NULL', agora.toISOString(), l.id);
    if (r.rowCount === 0) continue;
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

const MINUTOS_AVISOS_EPROC = 60;

/**
 * Lista as intimações/citações pendentes no eproc (MNI) e avisa as novas.
 * Só LISTA: não abre o teor, então não registra ciência nem inicia prazo.
 */
export async function verificarAvisosEproc(db, { fetchFn = fetch, forcar = false, env = process.env } = {}) {
  if (env.EPROC_TJMG === '0' || !env.EPROC_USUARIO || !env.EPROC_SENHA) return { ignorado: true, novos: 0 };
  const ultima = await getConfig(db, 'eproc_avisos_em');
  if (!forcar && ultima && Date.now() - new Date(ultima).getTime() < MINUTOS_AVISOS_EPROC * 60_000) return { ignorado: true, novos: 0 };
  const avisos = await listarAvisosPendentesEproc({ fetchFn, env });
  const linhaDeBase = !ultima;
  const novos = [];
  for (const a of avisos) {
    const r = await db.run(
      'INSERT INTO avisos_eproc (id, numero_processo, tipo, disponibilizado_em) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
      a.id,
      a.numero_processo,
      a.tipo,
      a.disponibilizado_em,
    );
    if (r.rowCount > 0) novos.push(a);
  }
  // Os que não estão mais pendentes (você já abriu no eproc) saem da lista.
  const atuais = new Set(avisos.map((a) => a.id));
  for (const { id } of await db.all('SELECT id FROM avisos_eproc')) {
    if (!atuais.has(id)) {
      await db.run('DELETE FROM avisos_eproc WHERE id = ?', id);
      // Ciência registrada no eproc: conclui o lembrete "Tomar ciência" correspondente.
      await db.run('UPDATE lembretes SET concluido = 1 WHERE origem = ? AND concluido = 0', `aviso|${id}`);
    }
  }
  await setConfig(db, 'eproc_avisos_em', agoraIso());

  {
    for (const a of novos) {
      const proc = await db.get('SELECT id, titulo, cliente FROM processos WHERE numero = ?', a.numero_processo);
      const nome = proc ? proc.titulo || proc.cliente || formatarCnj(a.numero_processo) : formatarCnj(a.numero_processo);
      const tipo = { I: 'Intimação', C: 'Citação', N: 'Notificação', V: 'Vista' }[a.tipo] || 'Comunicação';
      if (a.disponibilizado_em) {
        // Ciência tácita: 10 dias corridos após a disponibilização (Lei 11.419/2006, art. 5º, §3º).
        const limite = somarDiasCorridos(dataBrasilia(a.disponibilizado_em), 10);
        await db.run(
          `INSERT INTO lembretes (titulo, descricao, tipo, data_hora, antecedencia_min, processo_id, sugerido, origem)
           VALUES (?, ?, 'prazo', ?, 1440, ?, 1, ?) ON CONFLICT (origem) DO NOTHING`,
          `Tomar ciência: ${tipo.toLowerCase()} no eproc — ${nome}`,
          `${tipo} disponibilizada no eproc em ${formatarDataHora(a.disponibilizado_em)}.\nSe você não abrir antes, a ciência é considerada automaticamente ao fim de 10 dias corridos (Lei 11.419/2006, art. 5º, §3º) — e o prazo começa a contar.\nSugestão automática: confira e confirme.`,
          isoBrasilia(limite, '09:00'),
          proc?.id ?? null,
          `aviso|${a.id}`,
        );
      }
      if (linhaDeBase) continue; // pendências que já existiam: só a sugestão, sem aviso
      await notificar(db, {
        tipo: 'publicacao',
        titulo: `${tipo} pendente no eproc — ${nome}`,
        mensagem: `${formatarCnj(a.numero_processo)}${a.disponibilizado_em ? ` · disponibilizada em ${formatarDataHora(a.disponibilizado_em)}` : ''}. Abra no eproc para tomar ciência.`,
        link: proc ? `/#/processos/${proc.id}` : '/#/',
        emailTexto: `Há uma nova ${tipo.toLowerCase()} pendente no eproc (TJMG).\n\nProcesso: ${formatarCnj(a.numero_processo)} (${nome})${a.disponibilizado_em ? `\nDisponibilizada em: ${formatarDataHora(a.disponibilizado_em)}` : ''}\n\nO RodJuris apenas avisa: a ciência só é registrada quando você abrir a comunicação no eproc.`,
      });
    }
  }
  return { novos: linhaDeBase ? 0 : novos.length, pendentes: avisos.length, linhaDeBase };
}

/**
 * Um "ciclo" do agendador: lembretes + monitoramento do que estiver vencido.
 * Chamado pelo cron-job.org (Vercel) ou pelo relógio interno (servidor comum).
 */
export async function executarCiclo(db, { fetchFn = fetch, prazoMs = Infinity, pausaMs = 1500 } = {}) {
  const inicio = Date.now();
  await agendarCobrancas(db); // próxima cobrança das liminares pendentes de cumprimento
  const lembretes = await verificarLembretes(db);
  const monitor = await verificarTudo(db, { fetchFn, forcar: false, prazoMs, pausaMs });
  let avisosEproc = { novos: 0 };
  try {
    avisosEproc = await verificarAvisosEproc(db, { fetchFn });
  } catch (e) {
    console.warn('[eproc avisos]', e.message);
    avisosEproc = { novos: 0, erro: e.message };
  }
  const retentativa = monitor.emAndamento ? { processos: 0, andamentos: 0 } : await retentarDataJud(db, { fetchFn, prazoMs, inicio });
  await setConfig(db, 'ultimo_ciclo', agoraIso());
  return {
    lembretes,
    ...monitor,
    avisosEproc: avisosEproc.novos,
    datajudRetentativas: retentativa.processos,
    andamentos: (monitor.andamentos || 0) + retentativa.andamentos,
  };
}
