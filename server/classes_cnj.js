// Nomes das classes processuais pela Tabela Processual Unificada (TPU) do CNJ.
// Fonte oficial: serviço SGT do CNJ (pesquisarItemPublicoWS). Os nomes consultados ficam guardados no banco.

import { getConfig, setConfig } from './db.js';

// Classes mais comuns, conferidas no SGT do CNJ (evitam consultas).
const CONHECIDAS = {
  7: 'Procedimento Comum Cível',
  120: 'Mandado de Segurança Cível',
  156: 'Cumprimento de sentença',
  159: 'Execução de Título Extrajudicial',
  198: 'Apelação Cível',
  202: 'Agravo de Instrumento',
  280: 'Auto de Prisão em Flagrante',
  436: 'Procedimento do Juizado Especial Cível',
  1116: 'Execução Fiscal',
  14695: 'Procedimento do Juizado Especial da Fazenda Pública',
};

const ENDERECOS_SGT = [
  process.env.SGT_URL || 'https://sgt.cloud.cnj.jus.br/api/v1/soap',
  'https://www.cnj.jus.br/sgt/sgt_ws.php', // endereço antigo (depreciado pelo CNJ), usado como reserva
];

async function consultarSgt(codigo, fetchFn) {
  const corpo = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sgt="https://www.cnj.jus.br/sgt/sgt_ws.php"><soapenv:Body><sgt:pesquisarItemPublicoWS><tipoTabela>C</tipoTabela><tipoPesquisa>C</tipoPesquisa><valorPesquisa>${Number(codigo)}</valorPesquisa></sgt:pesquisarItemPublicoWS></soapenv:Body></soapenv:Envelope>`;
  for (const url of ENDERECOS_SGT) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"https://www.cnj.jus.br/sgt/sgt_ws.php#pesquisarItemPublicoWS"' },
        body: corpo,
      });
      if (!res.ok) continue;
      const xml = await res.text();
      // Pega o item cujo código é exatamente o pedido.
      for (const item of xml.split(/<(?:\w+:)?Item>/).slice(1)) {
        if (item.match(/<cod_item>(\d+)<\/cod_item>/)?.[1] === String(Number(codigo))) {
          const nome = item.match(/<nome>([^<]+)<\/nome>/)?.[1]?.trim();
          if (nome) return nome;
        }
      }
    } catch {
      /* tenta o próximo endereço */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Nome da classe pelo código CNJ (ou null se não for possível descobrir). */
export async function nomeClasse(db, codigo, { fetchFn = fetch } = {}) {
  const c = Number(codigo);
  if (!Number.isInteger(c) || c <= 0) return null;
  if (CONHECIDAS[c]) return CONHECIDAS[c];
  const guardado = await getConfig(db, `classe_cnj_${c}`);
  if (guardado) return guardado;
  const nome = await consultarSgt(c, fetchFn);
  if (nome) await setConfig(db, `classe_cnj_${c}`, nome);
  return nome;
}

/** Texto da classe para exibir: "Mandado de Segurança Cível" ou, sem o nome, "Classe CNJ 120". */
export async function textoClasse(db, codigo, opcoes) {
  if (!codigo) return null;
  return (await nomeClasse(db, codigo, opcoes)) || `Classe CNJ ${codigo}`;
}
