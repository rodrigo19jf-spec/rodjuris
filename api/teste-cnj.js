// Página de teste para a Vercel: uma única tentativa em cada API do CNJ, em paralelo,
// mostrando status HTTP, tempo e o início da resposta. Abra: /api/teste-cnj
const NUM = '00008323520184013202';
const DATAJUD_KEY = process.env.DATAJUD_API_KEY || 'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';
const LIMITE_MS = 20_000;

async function sondar(nome, url, init = {}) {
  const inicio = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMITE_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'rodjuris/1.0', ...(init.headers || {}) } });
    const corpo = (await r.text()).replace(/\s+/g, ' ').slice(0, 300);
    return { nome, ok: r.ok, detalhe: `HTTP ${r.status}`, tempo: Date.now() - inicio, corpo };
  } catch (err) {
    const motivo = err?.name === 'AbortError' ? `sem resposta em ${LIMITE_MS / 1000}s` : `${err?.name}: ${err?.message} ${err?.cause?.code || err?.cause?.message || ''}`;
    return { nome, ok: false, detalhe: motivo, tempo: Date.now() - inicio, corpo: '' };
  } finally {
    clearTimeout(timer);
  }
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export default async function handler(req, res) {
  const hoje = new Date().toISOString().slice(0, 10);
  const resultados = await Promise.all([
    sondar('Origem (ipinfo.io)', 'https://ipinfo.io/json'),
    sondar('DJEN (publicações)', `https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroProcesso=${NUM}&dataDisponibilizacaoInicio=2025-01-01&dataDisponibilizacaoFim=${hoje}&pagina=1&itensPorPagina=5`),
    sondar('DataJud (andamentos)', 'https://api-publica.datajud.cnj.jus.br/api_publica_trf1/_search', {
      method: 'POST',
      headers: { Authorization: `APIKey ${DATAJUD_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { match: { numeroProcesso: NUM } }, size: 1 }),
    }),
  ]);
  const linhas = resultados
    .map((r) => `<li style="margin-bottom:1rem">${r.ok ? '✅' : '❌'} <b>${esc(r.nome)}</b> — ${esc(r.detalhe)} — ${(r.tempo / 1000).toFixed(1)} s<br><code style="font-size:.8rem;color:#555;word-break:break-all">${esc(r.corpo)}</code></li>`)
    .join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teste CNJ</title><body style="font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.5">
<h1>Teste de conexão com o CNJ</h1>
<p><b>Região da Vercel:</b> ${esc(process.env.VERCEL_REGION || 'desconhecida')}</p>
<ul style="padding-left:1rem">${linhas}</ul></body></html>`);
}
