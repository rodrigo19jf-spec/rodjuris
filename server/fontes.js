// Clientes das APIs públicas e gratuitas do CNJ.
//
// DJEN / Comunica PJe — Diário de Justiça Eletrônico Nacional (publicações e intimações)
//   GET https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroProcesso=...&dataDisponibilizacaoInicio=AAAA-MM-DD
//   Também aceita numeroOab + ufOab para trazer tudo que sai em nome do advogado.
//
// DataJud — API Pública do CNJ (metadados e movimentações processuais)
//   POST https://api-publica.datajud.cnj.jus.br/api_publica_<tribunal>/_search
//   Header: Authorization: APIKey <chave pública divulgada pelo CNJ>

import { aliasDataJud, somenteDigitos } from './cnj.js';

export const DJEN_URL = process.env.DJEN_URL || 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
export const DATAJUD_URL = process.env.DATAJUD_URL || 'https://api-publica.datajud.cnj.jus.br';
// Chave pública divulgada pelo CNJ em https://datajud-wiki.cnj.jus.br/api-publica/acesso
// (o CNJ pode trocá-la; nesse caso, defina DATAJUD_API_KEY no .env).
export const DATAJUD_API_KEY =
  process.env.DATAJUD_API_KEY || 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';

const UA = 'jurify-pessoal/1.0';

function dataYmd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function getJson(fetchFn, url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetchFn(url, {
      ...init,
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA, ...(init.headers || {}) },
    });
    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} em ${new URL(url).host}: ${corpo.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Converte um item do DJEN no formato interno. */
export function normalizarComunicacao(item) {
  const externalId = String(item.id ?? item.hash ?? `${item.numero_processo}-${item.data_disponibilizacao}-${item.numeroComunicacao ?? ''}`);
  const data = item.data_disponibilizacao || item.datadisponibilizacao || null;
  return {
    external_id: externalId,
    numero_processo: somenteDigitos(item.numero_processo || item.numeroprocessocommascara || ''),
    data_disponibilizacao: data ? normalizarData(data) : null,
    tribunal: item.siglaTribunal || null,
    orgao: item.nomeOrgao || null,
    tipo: [item.tipoComunicacao, item.tipoDocumento].filter(Boolean).join(' — ') || null,
    texto: limparHtml(item.texto || ''),
    link: item.link || (item.hash ? `https://comunica.pje.jus.br/consulta/certidao/${item.hash}` : null),
  };
}

function normalizarData(valor) {
  const s = String(valor);
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return s.slice(0, 10);
}

export function limparHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Busca publicações no DJEN.
 * @param {object} filtro { numeroProcesso } ou { numeroOab, ufOab }
 * @param {Date|string} desde data inicial de disponibilização
 */
export async function buscarPublicacoesDjen(filtro, desde, { fetchFn = fetch, maxPaginas = 5 } = {}) {
  const itens = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const params = new URLSearchParams({
      pagina: String(pagina),
      itensPorPagina: '100',
      dataDisponibilizacaoInicio: dataYmd(desde),
      dataDisponibilizacaoFim: dataYmd(new Date()),
    });
    if (filtro.numeroProcesso) params.set('numeroProcesso', somenteDigitos(filtro.numeroProcesso));
    if (filtro.numeroOab) {
      params.set('numeroOab', somenteDigitos(filtro.numeroOab));
      params.set('ufOab', String(filtro.ufOab || '').toUpperCase());
    }
    const json = await getJson(fetchFn, `${DJEN_URL}?${params}`);
    const lote = Array.isArray(json?.items) ? json.items : [];
    itens.push(...lote.map(normalizarComunicacao));
    const total = Number(json?.count ?? lote.length);
    if (lote.length < 100 || itens.length >= total) break;
  }
  return itens;
}

/** Busca metadados e movimentações no DataJud. Retorna null se o processo não for encontrado. */
export async function buscarProcessoDataJud(numero, { fetchFn = fetch } = {}) {
  const alias = aliasDataJud(numero);
  if (!alias) throw new Error('Tribunal não suportado pelo DataJud para este número.');
  const json = await getJson(fetchFn, `${DATAJUD_URL}/api_publica_${alias}/_search`, {
    method: 'POST',
    headers: { Authorization: `APIKey ${DATAJUD_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { match: { numeroProcesso: somenteDigitos(numero) } }, size: 10 }),
  });
  const hits = json?.hits?.hits ?? [];
  if (hits.length === 0) return null;

  // Um mesmo número pode ter vários registros (graus/sistemas diferentes): junta tudo.
  const fontes = hits.map((h) => h._source || {});
  const principal = fontes[0];
  const movimentos = [];
  for (const src of fontes) {
    for (const m of src.movimentos || []) {
      const complemento = (m.complementosTabelados || [])
        .map((c) => [c.nome, c.descricao].filter(Boolean).join(': '))
        .filter(Boolean)
        .join('; ');
      movimentos.push({
        external_key: `${src.grau || ''}|${m.codigo ?? ''}|${m.dataHora ?? ''}|${m.nome ?? ''}`,
        data: m.dataHora || null,
        nome: m.nome || 'Movimentação',
        complemento: complemento || null,
      });
    }
  }
  movimentos.sort((a, b) => String(b.data).localeCompare(String(a.data)));

  return {
    tribunal: principal.tribunal || alias.toUpperCase(),
    classe: principal.classe?.nome || null,
    orgao: principal.orgaoJulgador?.nome || null,
    assunto: (principal.assuntos || []).map((a) => a?.nome).filter(Boolean).join(', ') || null,
    data_ajuizamento: principal.dataAjuizamento || null,
    movimentos,
  };
}
