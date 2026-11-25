// Leitura da Consulta Pública do PJe do TJMG (1º grau).
// https://pje-consulta-publica.tjmg.jus.br/pje/ConsultaPublica/listView.seam
//
// Fluxo (igual ao navegador): abre a página → envia a pesquisa pelo número (requisição AJAX do JSF)
// → abre o detalhe do processo → lê dados e movimentações (1ª página, as mais recentes).
//
// Observações:
// - Só funciona para processos do TJMG que tramitam no PJe; os do eproc não aparecem aqui.
// - O TJMG está migrando processos do PJe para o eproc; depois disso o PJe para de ser atualizado.
// - A página tem reCAPTCHA no código, hoje desligado. Se o tribunal ligá-lo, a consulta deixa de
//   funcionar e o app passa a avisar o erro (não tentamos contornar o captcha).

import { formatarCnj, somenteDigitos } from './cnj.js';
import { ErroFonte } from './fontes.js';

export const PJE_TJMG_URL = process.env.PJE_TJMG_URL || 'https://pje-consulta-publica.tjmg.jus.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const TIMEOUT_MS = process.env.VERCEL ? 12_000 : 25_000;

/** Processo do TJMG? (segmento 8, tribunal 13) */
export function ehTjmg(numero) {
  const d = somenteDigitos(numero);
  return d.length === 20 && d.slice(13, 16) === '813';
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ordm: 'º', ordf: 'ª' };
export function decodificarEntidades(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, nome) => ENTIDADES[nome.toLowerCase()] ?? decodificarNomeada(m));
}
// Entidades com acento (á, ç, õ...) usadas pelo PJe.
function decodificarNomeada(m) {
  const mapa = {
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
    acirc: 'â', ecirc: 'ê', ocirc: 'ô', Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', atilde: 'ã', otilde: 'õ', Atilde: 'Ã', Otilde: 'Õ',
    ccedil: 'ç', Ccedil: 'Ç', agrave: 'à', Agrave: 'À', uuml: 'ü', middot: '·', ndash: '–', mdash: '—',
  };
  return mapa[m.slice(1, -1)] ?? m;
}

function semTags(html) {
  return decodificarEntidades(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Converte "02/09/2026 00:28:46" (horário de Brasília) para ISO UTC. */
export function dataHoraBrParaIso(s) {
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, d, mes, a, h = '00', mi = '00', se = '00'] = m;
  return new Date(`${a}-${mes}-${d}T${h}:${mi}:${se}-03:00`).toISOString();
}

/** Pequeno "navegador": guarda cookies, decodifica ISO-8859-1 e aplica tempo-limite. */
function criarSessao(fetchFn) {
  const cookies = new Map();
  return async function pedir(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchFn(url, {
        ...init,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,*/*',
          ...(cookies.size ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...(init.headers || {}),
        },
      });
      const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const [par] = c.split(';');
        const i = par.indexOf('=');
        if (i > 0) cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
      }
      if (!res.ok) throw new ErroFonte(`O PJe do TJMG respondeu com erro (HTTP ${res.status}).`, { status: res.status, temporario: res.status >= 500 || res.status === 429 });
      const buf = await res.arrayBuffer();
      return new TextDecoder('latin1').decode(buf);
    } catch (err) {
      if (err instanceof ErroFonte) throw err;
      throw new ErroFonte(`O PJe do TJMG ${err?.name === 'AbortError' ? 'não respondeu a tempo' : 'não pôde ser acessado'}.`, { temporario: true });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Extrai os dados e as movimentações da página de detalhe do processo. */
export function lerDetalhePje(html) {
  const texto = decodificarEntidades(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<(br|\/div|\/td|\/tr|\/label|\/span|\/li|\/p|\/h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const campo = (rotulo) => {
    const i = texto.findIndex((l) => l === rotulo);
    if (i < 0) return null;
    const v = texto[i + 1]?.trim();
    return v && !/^(Número Processo|Data da Distribuição|Classe Judicial|Assunto|Jurisdição|Órgão Julgador)$/.test(v) ? v : null;
  };

  const movimentos = [];
  const ini = html.indexOf('processoEvento:tb');
  if (ini >= 0) {
    const fim = html.indexOf('</tbody>', ini);
    const corpo = html.slice(ini, fim > ini ? fim : undefined);
    for (const tr of corpo.split(/<tr[\s>]/i).slice(1)) {
      const td = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
      const linha = td ? semTags(td[1]) : '';
      const m = linha.match(/^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})\s*-\s*(.+)$/);
      if (m) {
        movimentos.push({ external_key: `pje|${m[1]}|${m[2]}`, data: dataHoraBrParaIso(m[1]), nome: m[2], complemento: null });
      }
    }
  }
  const migrado = movimentos.find((m) => /migrad[ao] a tramita/i.test(m.nome)) || null;
  return {
    classe: campo('Classe Judicial'),
    assunto: campo('Assunto'),
    orgao: campo('Órgão Julgador'),
    jurisdicao: campo('Jurisdição'),
    distribuicao: campo('Data da Distribuição'),
    movimentos,
    migrado,
  };
}

/**
 * Consulta um processo na Consulta Pública do PJe do TJMG.
 * @returns {Promise<null | {tribunal, classe, assunto, orgao, movimentos, migrado}>} null = não está no PJe
 */
export async function buscarProcessoPjeTjmg(numero, { fetchFn = fetch } = {}) {
  const pedir = criarSessao(fetchFn);
  const listaUrl = `${PJE_TJMG_URL}/pje/ConsultaPublica/listView.seam`;
  const pagina = await pedir(listaUrl);
  const action = pagina.match(/<form id="fPP"[^>]*action="([^"]+)"/)?.[1];
  const viewState = pagina.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/)?.[1];
  if (!action || !viewState) throw new ErroFonte('O PJe do TJMG mudou a página de consulta (formulário não encontrado).');
  if (/if \(true\)\s*\{\s*grecaptcha\.execute/.test(pagina)) {
    throw new ErroFonte('O PJe do TJMG passou a exigir captcha na consulta pública; a leitura automática não é possível.');
  }
  const mes = new Date().toLocaleDateString('pt-BR', { month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });
  const campos = [
    ['AJAXREQUEST', '_viewRoot'],
    ['fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso', formatarCnj(numero)],
    ['mascaraProcessoReferenciaRadio', 'on'],
    ['fPP:j_id161:processoReferenciaInput', ''],
    ['fPP:dnp:nomeParte', ''],
    ['fPP:j_id179:nomeSocial', ''],
    ['fPP:j_id188:alcunha', ''],
    ['fPP:j_id197:nomeAdv', ''],
    ['fPP:j_id206:classeJudicial', ''],
    ['fPP:j_id206:sgbClasseJudicial_selection', ''],
    ['tipoMascaraDocumento', 'on'],
    ['fPP:dpDec:documentoParte', ''],
    ['fPP:Decoration:numeroOAB', ''],
    ['fPP:Decoration:j_id240', ''],
    ['fPP:Decoration:estadoComboOAB', 'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue'],
    ['fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate', ''],
    ['fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate', mes],
    ['fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate', ''],
    ['fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate', mes],
    ['fPP', 'fPP'],
    ['autoScroll', ''],
    ['javax.faces.ViewState', viewState],
    ['fPP:j_id261', 'fPP:j_id261'],
    ['AJAX:EVENTS_COUNT', '1'],
  ];
  const resultado = await pedir(PJE_TJMG_URL + decodificarEntidades(action), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: PJE_TJMG_URL,
      Referer: listaUrl,
      Accept: '*/*',
    },
    body: new URLSearchParams(campos).toString(),
  });
  const total = Number(resultado.match(/(\d+)\s*resultados? encontrados?/i)?.[1] ?? 0);
  const link = resultado.match(/DetalheProcessoConsultaPublica\/listView\.seam\?ca=[0-9a-f]+/)?.[0];
  if (!link || total !== 1 || !resultado.includes(formatarCnj(numero))) return null; // não está no PJe

  const detalhe = await pedir(`${PJE_TJMG_URL}/pje/ConsultaPublica/${link}`, { headers: { Referer: listaUrl } });
  if (!detalhe.includes(formatarCnj(numero))) throw new ErroFonte('O PJe do TJMG devolveu uma página inesperada para o processo.');
  return { tribunal: 'TJMG', ...lerDetalhePje(detalhe) };
}
