// Estimativa de prazos processuais em dias úteis (CPC, arts. 219, 220 e 224) — APENAS PARA SUGESTÃO.
//
// Considera: sábados, domingos, feriados nacionais (fixos e móveis: Carnaval, Sexta-feira Santa,
// Corpus Christi) e a suspensão de 20/12 a 20/1 (CPC, art. 220).
// NÃO considera: feriados estaduais/municipais, suspensões por portaria do tribunal, prazos em dobro
// (Fazenda Pública, Defensoria, litisconsortes com procuradores distintos) nem regras especiais.
// Por isso o app sempre marca o resultado como "sugestão — confirme a data".

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), em UTC. */
export function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const cacheFeriados = new Map();
export function feriadosNacionais(ano) {
  if (cacheFeriados.has(ano)) return cacheFeriados.get(ano);
  const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map((md) => `${ano}-${md}`);
  const p = pascoa(ano);
  const mais = (dias) => ymd(new Date(p.getTime() + dias * 86_400_000));
  const moveis = [mais(-48), mais(-47), mais(-2), mais(60)]; // Carnaval (seg e ter), Sexta-feira Santa, Corpus Christi
  const conjunto = new Set([...fixos, ...moveis]);
  cacheFeriados.set(ano, conjunto);
  return conjunto;
}

/** Período de suspensão de prazos de 20/12 a 20/1 (CPC, art. 220). */
function emRecesso(d) {
  const m = d.getUTCMonth() + 1;
  const dia = d.getUTCDate();
  return (m === 12 && dia >= 20) || (m === 1 && dia <= 20);
}

export function ehDiaUtil(d) {
  const sem = d.getUTCDay();
  return sem !== 0 && sem !== 6 && !feriadosNacionais(d.getUTCFullYear()).has(ymd(d)) && !emRecesso(d);
}

/** Data (AAAA-MM-DD) em Brasília a partir de um instante ISO. */
export function dataBrasilia(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Último dia de um prazo de `dias` dias úteis cuja ciência ocorreu em `dataCiencia` (AAAA-MM-DD).
 * Exclui o dia do começo e inclui o do vencimento (CPC, art. 224); só conta dias úteis (art. 219).
 */
export function vencimentoDiasUteis(dataCiencia, dias) {
  const d = new Date(`${dataCiencia}T12:00:00Z`);
  let contados = 0;
  while (contados < dias) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (ehDiaUtil(d)) contados++;
  }
  return ymd(d);
}

/** Soma dias corridos a uma data AAAA-MM-DD. */
export function somarDiasCorridos(data, dias) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return ymd(d);
}

/** Instante ISO para uma data AAAA-MM-DD num horário de Brasília. */
export function isoBrasilia(data, hora = '18:00') {
  return new Date(`${data}T${hora}:00-03:00`).toISOString();
}

function normalizar(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A parte intimada parece ser o cliente cadastrado? */
export function parteEhCliente(parte, cliente) {
  const p = normalizar(parte);
  const c = normalizar(cliente);
  if (!p || !c) return false;
  if (p.includes(c) || c.includes(p)) return true;
  const palavras = (s) => s.split(' ').filter((w) => w.length > 3 && !['ESTADO', 'MUNICIPIO', 'LTDA', 'EIRELI'].includes(w));
  const pc = new Set(palavras(c));
  return palavras(p).some((w) => pc.has(w));
}

/**
 * Lê o texto de um andamento do eproc e, se for uma intimação com prazo em aberto, extrai os dados.
 * Ex.: "Refer. ao Evento 31; Movimentado por: ...; Prazo:15 dias - Status: ABERTO - Parte: FULANO (AUTOR)"
 */
export function lerIntimacaoComPrazo(andamento) {
  const texto = `${andamento.nome || ''} ${andamento.complemento || ''}`;
  if (!/intima|cita/i.test(andamento.nome || '')) return null;
  const prazo = texto.match(/Prazo:\s*(\d{1,3})\s*dias?/i);
  if (!prazo || !/Status:\s*ABERTO/i.test(texto)) return null;
  const parte = texto.match(/Parte:\s*([^;]+?)(?:\s*\([^)]*\))?\s*(?:;|$)/i)?.[1]?.trim() || null;
  return { dias: Number(prazo[1]), parte };
}
