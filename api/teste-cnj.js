// Página de teste para a Vercel: verifica se o DJEN e o DataJud respondem a partir da região escolhida.
// Abra: https://SEU-PROJETO.vercel.app/api/teste-cnj
import { testarConexoes } from '../server/fontes.js';

async function origem() {
  try {
    const r = await fetch('https://ipinfo.io/json', { headers: { Accept: 'application/json' } });
    const j = await r.json();
    return `${j.city || '?'} / ${j.country || '?'} (${j.org || 'provedor desconhecido'})`;
  } catch {
    return 'não foi possível identificar';
  }
}

export default async function handler(req, res) {
  const inicio = Date.now();
  const [local, resultados] = await Promise.all([origem(), testarConexoes()]);
  const linhas = resultados.map((r) => `<li>${r.ok ? '✅' : '❌'} <b>${r.fonte}:</b> ${r.mensagem.replace(/</g, '&lt;')}</li>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teste CNJ</title><body style="font-family:system-ui;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5">
<h1>Teste de conexão com o CNJ</h1>
<p><b>Região da Vercel:</b> ${process.env.VERCEL_REGION || 'desconhecida'}<br><b>Acessando a partir de:</b> ${local}</p>
<ul>${linhas}</ul>
<p style="color:#666">Tempo: ${((Date.now() - inicio) / 1000).toFixed(1)} s</p></body></html>`);
}
