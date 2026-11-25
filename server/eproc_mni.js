// Cliente do webservice oficial do eproc do TJMG — MNI 2.2.2 (Modelo Nacional de Interoperabilidade, CNJ).
// WSDL: https://eproc1g.tjmg.jus.br/eproc/wsdl.php?srv=intercomunicacao2.2
//
// Usa o login e a senha do advogado no eproc, definidos SOMENTE por variáveis de ambiente
// (EPROC_USUARIO e EPROC_SENHA) — nunca no banco, no código ou no GitHub.
//
// ⚠️ Operações usadas: apenas LEITURA.
//   - consultarProcesso (sem documentos): dados e movimentações.
//   - consultarAvisosPendentes: lista intimações/citações pendentes.
// A operação consultarTeorComunicacao NÃO é usada de propósito: no MNI ela registra a ciência da
// intimação (o prazo começaria a contar). O app só avisa; quem abre a intimação é você, no eproc.

import { XMLParser } from 'fast-xml-parser';
import { somenteDigitos } from './cnj.js';
import { ErroFonte } from './fontes.js';
import { ehTjmg } from './pje_tjmg.js';

const NS_SERVICO = 'http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/';
const NS_TIPOS = 'http://www.cnj.jus.br/tipos-servico-intercomunicacao-2.2.2';
const TIMEOUT_MS = process.env.VERCEL ? 15_000 : 30_000;

const ENDERECOS = {
  1: process.env.EPROC_TJMG_URL_1G || 'https://eproc1g-ws.tjmg.jus.br/eproc/ws/controlador_ws.php?srv=intercomunicacao2.2',
  2: process.env.EPROC_TJMG_URL_2G || 'https://eproc2g-ws.tjmg.jus.br/eproc/ws/controlador_ws.php?srv=intercomunicacao2.2',
};

export function credenciaisEproc(env = process.env) {
  const usuario = String(env.EPROC_USUARIO || '').trim();
  const senha = String(env.EPROC_SENHA || '');
  return usuario && senha ? { usuario, senha } : null;
}

/** O MNI do eproc deve ser usado para este processo? (TJMG + credenciais configuradas) */
export function eprocDisponivel(numero, env = process.env) {
  return env.EPROC_TJMG !== '0' && ehTjmg(numero) && !!credenciaisEproc(env);
}

function xmlEsc(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function envelope(operacao, campos) {
  const corpo = campos
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<tip:${k}>${xmlEsc(v)}</tip:${k}>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="${NS_SERVICO}" xmlns:tip="${NS_TIPOS}">
<soapenv:Header/><soapenv:Body><ser:${operacao}>${corpo}</ser:${operacao}></soapenv:Body></soapenv:Envelope>`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (nome) => ['movimento', 'aviso', 'complemento', 'polo', 'parte', 'assunto', 'documento'].includes(nome),
});

const lista = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const texto = (v) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v));

/** "20261125143005" (horário de Brasília) → ISO UTC */
export function dataMniParaIso(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, a, me, d, h = '00', mi = '00', se = '00'] = m;
  return new Date(`${a}-${me}-${d}T${h}:${mi}:${se}-03:00`).toISOString();
}

/** Decodifica pela declaração do próprio XML (<?xml encoding="...">); senão, pelo cabeçalho HTTP. */
export function decodificar(buf, contentType = '') {
  const inicio = new TextDecoder('latin1').decode(buf.slice(0, 200));
  const declarado = inicio.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i)?.[1];
  const charset = declarado || contentType.match(/charset=([^;]+)/i)?.[1] || 'utf-8';
  return new TextDecoder(/8859-1|latin-?1|1252/i.test(charset) ? 'latin1' : 'utf-8').decode(buf);
}

async function chamar(operacao, campos, { fetchFn = fetch, grau = 1 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let corpo;
  try {
    const res = await fetchFn(ENDERECOS[grau], {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        SOAPAction: `"${NS_SERVICO}${operacao}"`,
        'User-Agent': 'rodjuris/1.0',
      },
      body: envelope(operacao, campos),
    });
    const buf = await res.arrayBuffer();
    corpo = decodificar(buf, res.headers?.get?.('content-type') || '');
    if (!res.ok && !/Envelope/i.test(corpo)) {
      throw new ErroFonte(`O eproc (TJMG) respondeu com erro (HTTP ${res.status}).`, { status: res.status, temporario: res.status >= 500 || res.status === 429 });
    }
  } catch (err) {
    if (err instanceof ErroFonte) throw err;
    throw new ErroFonte(`O eproc (TJMG) ${err?.name === 'AbortError' ? 'não respondeu a tempo' : 'não pôde ser acessado'}.`, { temporario: true });
  } finally {
    clearTimeout(timer);
  }

  let doc;
  try {
    doc = parser.parse(corpo);
  } catch {
    throw new ErroFonte('O eproc (TJMG) devolveu uma resposta ilegível.', { temporario: true });
  }
  const body = doc?.Envelope?.Body ?? {};
  if (body.Fault) {
    const msg = texto(body.Fault.faultstring) || texto(body.Fault.Reason?.Text) || 'erro desconhecido';
    throw new ErroFonte(`eproc (TJMG): ${msg}`);
  }
  const resposta = body[`${operacao}Resposta`] ?? body[`${operacao}Response`];
  if (!resposta) throw new ErroFonte('O eproc (TJMG) devolveu uma resposta inesperada.');
  const sucesso = String(texto(resposta.sucesso)).toLowerCase() === 'true';
  return { sucesso, mensagem: texto(resposta.mensagem), resposta };
}

/** Mensagem do eproc indica processo inexistente / sem acesso (e não um problema de login)? */
function ehProcessoNaoEncontrado(msg) {
  return /n[ãa]o (foi )?encontrad|inexistente|n[ãa]o localizad|sem permiss|n[ãa]o (tem|possui) acesso|sigilo/i.test(msg);
}
function ehErroDeLogin(msg) {
  return /senha|usu[áa]rio|autentica|credencia|login/i.test(msg);
}

function lerMovimento(m) {
  const nacional = m.movimentoNacional;
  const local = m.movimentoLocal;
  const complementos = [...lista(m.complemento), ...lista(nacional?.complemento), ...lista(local?.complemento)].map(texto).filter(Boolean);
  const descricao = texto(local?.['@descricao']) || complementos.shift() || (nacional ? `Movimento ${nacional['@codigoNacional']}` : 'Movimentação');
  return {
    external_key: `eproc|${m['@identificadorMovimento'] || ''}|${m['@dataHora'] || ''}|${descricao}`,
    data: dataMniParaIso(m['@dataHora']),
    nome: descricao,
    complemento: complementos.join('; ') || null,
  };
}

/**
 * Consulta um processo no eproc do TJMG (1º grau; se não estiver lá, tenta o 2º grau).
 * @returns {Promise<null | {tribunal, classe, assunto, orgao, movimentos, grau}>} null = não encontrado
 */
export async function buscarProcessoEproc(numero, { fetchFn = fetch, env = process.env } = {}) {
  const cred = credenciaisEproc(env);
  if (!cred) throw new ErroFonte('Login do eproc não configurado (variáveis EPROC_USUARIO e EPROC_SENHA).');
  for (const grau of [1, 2]) {
    const r = await chamar(
      'consultarProcesso',
      [
        ['idConsultante', cred.usuario],
        ['senhaConsultante', cred.senha],
        ['numeroProcesso', somenteDigitos(numero)],
        ['movimentos', 'true'],
        ['incluirCabecalho', 'true'],
        ['incluirDocumentos', 'false'],
      ],
      { fetchFn, grau },
    );
    if (!r.sucesso) {
      if (ehProcessoNaoEncontrado(r.mensagem) && !ehErroDeLogin(r.mensagem)) continue;
      throw new ErroFonte(`eproc (TJMG): ${r.mensagem || 'consulta recusada'}`);
    }
    const p = r.resposta.processo ?? {};
    const db = p.dadosBasicos ?? {};
    const orgao = db.orgaoJulgador ?? {};
    const assuntos = lista(db.assunto)
      .map((a) => texto(a.assuntoLocal?.['@descricao']) || texto(a.codigoNacional))
      .filter(Boolean);
    const movimentos = lista(p.movimento).map(lerMovimento).sort((a, b) => String(b.data).localeCompare(String(a.data)));
    return {
      tribunal: 'TJMG',
      grau,
      classe: texto(db['@classeProcessual']) ? `Classe CNJ ${texto(db['@classeProcessual'])}` : null,
      assunto: assuntos.join(', ') || null,
      orgao: texto(orgao['@nomeOrgao']) || null,
      movimentos,
    };
  }
  return null;
}

/**
 * Lista as intimações/citações pendentes do advogado no eproc do TJMG (1º e 2º graus).
 * Apenas LISTA — não abre o teor, não registra ciência.
 */
export async function listarAvisosPendentesEproc({ fetchFn = fetch, env = process.env } = {}) {
  const cred = credenciaisEproc(env);
  if (!cred) throw new ErroFonte('Login do eproc não configurado (variáveis EPROC_USUARIO e EPROC_SENHA).');
  const avisos = [];
  for (const grau of [1, 2]) {
    const r = await chamar(
      'consultarAvisosPendentes',
      [
        ['idConsultante', cred.usuario],
        ['senhaConsultante', cred.senha],
      ],
      { fetchFn, grau },
    );
    if (!r.sucesso) {
      if (grau === 2 && !ehErroDeLogin(r.mensagem)) continue; // 2º grau pode não ter avisos/acesso
      throw new ErroFonte(`eproc (TJMG): ${r.mensagem || 'consulta recusada'}`);
    }
    for (const a of lista(r.resposta.aviso)) {
      const proc = a.processo ?? {};
      avisos.push({
        id: `${grau}|${texto(a['@idAviso'])}`,
        grau,
        tipo: texto(a['@tipoComunicacao']) || null,
        numero_processo: somenteDigitos(texto(proc['@numero'])),
        disponibilizado_em: dataMniParaIso(texto(a.dataDisponibilizacao)),
      });
    }
  }
  return avisos;
}

/** Teste de conexão/login para a tela de Ajustes (só lista avisos pendentes). */
export async function testarEproc({ fetchFn = fetch, env = process.env } = {}) {
  if (!credenciaisEproc(env)) return { fonte: 'eproc TJMG (MNI)', ok: false, mensagem: 'Login do eproc não configurado (variáveis EPROC_USUARIO e EPROC_SENHA na Vercel).' };
  try {
    const avisos = await listarAvisosPendentesEproc({ fetchFn, env });
    return { fonte: 'eproc TJMG (MNI)', ok: true, mensagem: `Login aceito — ${avisos.length} intimação(ões)/citação(ões) pendente(s) no eproc.` };
  } catch (e) {
    return { fonte: 'eproc TJMG (MNI)', ok: false, mensagem: e.message };
  }
}
