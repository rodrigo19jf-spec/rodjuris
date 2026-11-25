import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setConfig } from '../server/db.js';
import { criarApp } from '../server/app.js';
import { aliasDataJud, cnjValido, formatarCnj } from '../server/cnj.js';
import { verificarLembretes, verificarTudo } from '../server/monitor.js';
import { definirEnvioPush, definirTransporteEmail } from '../server/notificador.js';
import { definirEsperas } from '../server/fontes.js';

definirEsperas([0, 0]);

// Gera um número CNJ válido (calcula o dígito verificador).
function gerarCnj(seq, ano = '2024', j = '8', tr = '26', origem = '0100') {
  const n = String(seq).padStart(7, '0');
  const dv = String(98n - (BigInt(n + ano + j + tr + origem + '00') % 97n)).padStart(2, '0');
  return n + dv + ano + j + tr + origem;
}
const NUM = gerarCnj(1234567);
const NUM_OUTRO = gerarCnj(7654321);

// ───────── APIs do CNJ simuladas ─────────
const djen = { porProcesso: {}, porOab: [] };
const datajud = {};
const chamadas = [];
async function fetchFalso(url, init = {}) {
  const u = new URL(url);
  chamadas.push(`${init.method || 'GET'} ${u.host}${u.pathname}`);
  const resp = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.host === 'comunicaapi.pje.jus.br') {
    const itens = u.searchParams.get('numeroOab') ? djen.porOab : djen.porProcesso[u.searchParams.get('numeroProcesso')] || [];
    return resp({ status: 'success', count: itens.length, items: itens });
  }
  if (u.host === 'api-publica.datajud.cnj.jus.br') {
    assert.match(init.headers.Authorization, /^APIKey /);
    const numero = JSON.parse(init.body).query.match.numeroProcesso;
    const src = datajud[numero];
    return resp({ hits: { hits: src ? [{ _source: src }] : [] } });
  }
  throw new Error(`URL inesperada: ${url}`);
}

const pub = (id, numero, texto, data = '2026-11-20') => ({
  id,
  numero_processo: numero,
  data_disponibilizacao: data,
  siglaTribunal: 'TJSP',
  nomeOrgao: '1ª Vara Cível',
  tipoComunicacao: 'Intimação',
  texto: `<p>${texto}</p>`,
  hash: `h${id}`,
});

let db, servidor, base, cookie;
const emails = [];
const pushes = [];

async function req(caminho, { metodo = 'GET', corpo, semCookie = false } = {}) {
  const res = await fetch(base + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(cookie && !semCookie ? { Cookie: cookie } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, corpo: await res.json() };
}

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    // Postgres de verdade: começa de um banco limpo.
    const { default: postgres } = await import('postgres');
    const sql = postgres(url, { onnotice: () => {} });
    await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await sql.end();
  }
  db = await openDb(url || ':memory:');
  definirTransporteEmail({ sendMail: async (m) => emails.push(m) });
  definirEnvioPush(async (sub, payload) => pushes.push(JSON.parse(payload)));
  const app = criarApp(db, { fetchFn: fetchFalso });
  await new Promise((r) => (servidor = app.listen(0, r)));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(async () => {
  servidor?.close();
  await db?.close();
});

test('número CNJ: validação, formatação e tribunal', () => {
  assert.ok(cnjValido(NUM));
  assert.ok(!cnjValido(NUM.replace(/^1/, '2')));
  assert.equal(formatarCnj(NUM), `1234567-${NUM.slice(7, 9)}.2024.8.26.0100`);
  assert.equal(aliasDataJud(NUM), 'tjsp');
  assert.equal(aliasDataJud(gerarCnj(1, '2023', '4', '03', '6100')), 'trf3');
  assert.equal(aliasDataJud(gerarCnj(1, '2023', '5', '02', '0001')), 'trt2');
  assert.equal(aliasDataJud(gerarCnj(1, '2023', '8', '07', '0001')), 'tjdft');
});

test('exige senha e login', async () => {
  cookie = null;
  assert.equal((await req('/api/processos')).status, 401);
  assert.equal((await req('/api/auth/configurar', { metodo: 'POST', corpo: { senha: 'curta' } })).status, 400);
  assert.equal((await req('/api/auth/configurar', { metodo: 'POST', corpo: { senha: 'senha-forte-123' } })).status, 200);
  assert.equal((await req('/api/processos')).status, 200);
  assert.equal((await req('/api/auth/configurar', { metodo: 'POST', corpo: { senha: 'outra-senha-123' } })).status, 409);
  cookie = null;
  assert.equal((await req('/api/auth/entrar', { metodo: 'POST', corpo: { senha: 'errada' } })).status, 401);
  assert.equal((await req('/api/auth/entrar', { metodo: 'POST', corpo: { senha: 'senha-forte-123' } })).status, 200);
});

test('cadastro de processo valida o número e consulta o DataJud', async () => {
  datajud[NUM] = {
    tribunal: 'TJSP',
    classe: { nome: 'Procedimento Comum Cível' },
    orgaoJulgador: { nome: '1ª Vara Cível de São Paulo' },
    assuntos: [{ nome: 'Indenização por Dano Moral' }],
    movimentos: [{ codigo: 26, nome: 'Distribuído por sorteio', dataHora: '2024-03-01T10:00:00.000Z' }],
  };
  djen.porProcesso[NUM] = [pub(1, NUM, 'Cite-se o réu.', '2026-10-01')];

  assert.equal((await req('/api/processos', { metodo: 'POST', corpo: { numero: '123' } })).status, 400);
  const consulta = await req('/api/processos/consultar', { metodo: 'POST', corpo: { numero: formatarCnj(NUM) } });
  assert.equal(consulta.status, 200);
  assert.equal(consulta.corpo.classe, 'Procedimento Comum Cível');

  const r = await req('/api/processos', { metodo: 'POST', corpo: { numero: formatarCnj(NUM), titulo: 'Silva x Banco', cliente: 'Maria Silva' } });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.tribunal, 'TJSP');
  assert.equal((await req('/api/processos', { metodo: 'POST', corpo: { numero: NUM } })).status, 409);
});

test('primeira verificação cria a linha de base sem avisar; novidades depois geram aviso, e-mail e push', async () => {
  await setConfig(db, 'email_ativo', '1');
  await setConfig(db, 'email_destino', 'advogado@example.com');
  await db.run("INSERT INTO push_subscriptions (endpoint, dados) VALUES ('https://push.example/1', '{}')");

  // Aguarda a verificação em segundo plano disparada pelo cadastro.
  for (let i = 0; i < 50 && !(await db.get('SELECT ultima_verificacao FROM processos')).ultima_verificacao; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const proc = (await db.get('SELECT * FROM processos'));
  assert.ok(proc.ultima_verificacao, 'linha de base criada');
  assert.equal(proc.classe, 'Procedimento Comum Cível', 'dados do DataJud preenchidos');
  assert.equal((await db.get('SELECT COUNT(*)::int n FROM publicacoes WHERE lida = 0')).n, 0);
  assert.equal((await db.get('SELECT COUNT(*)::int n FROM andamentos')).n, 1);
  assert.equal((await db.get('SELECT COUNT(*)::int n FROM notificacoes')).n, 0);

  // Nova publicação e novo andamento.
  djen.porProcesso[NUM].push(pub(2, NUM, 'Intime-se o autor para manifestação em 15 dias.'));
  datajud[NUM].movimentos.push({ codigo: 11010, nome: 'Mero expediente', dataHora: '2026-11-20T12:00:00.000Z' });

  const r = await verificarTudo(db, { fetchFn: fetchFalso, pausaMs: 0 });
  assert.equal(r.publicacoes, 1);
  assert.equal(r.andamentos, 1);
  assert.deepEqual(r.erros, []);

  const avisos = (await db.all('SELECT * FROM notificacoes ORDER BY id'));
  assert.equal(avisos.length, 2);
  assert.match(avisos[0].titulo, /1 nova\(s\) publicação/);
  assert.match(avisos[1].titulo, /1 novo\(s\) andamento/);
  assert.equal(emails.length, 2);
  assert.match(emails[0].text, /Intime-se o autor/);
  assert.equal(emails[0].to, 'advogado@example.com');
  assert.equal(pushes.length, 2);

  // Repetir a verificação não duplica.
  const r2 = await verificarTudo(db, { fetchFn: fetchFalso, pausaMs: 0 });
  assert.equal(r2.publicacoes + r2.andamentos, 0);

  const painel = await req('/api/painel');
  assert.equal(painel.corpo.publicacoesNaoLidas, 1);
  const det = await req(`/api/processos/${proc.id}`);
  assert.equal(det.corpo.publicacoes.length, 2);
  assert.equal(det.corpo.publicacoes[0].texto, 'Intime-se o autor para manifestação em 15 dias.');
  await req(`/api/processos/${proc.id}/marcar-lido`, { metodo: 'POST' });
  assert.equal((await req('/api/painel')).corpo.publicacoesNaoLidas, 0);
});

test('monitoramento pela OAB vincula publicações a processos cadastrados', async () => {
  await setConfig(db, 'oab_numero', '123456');
  await setConfig(db, 'oab_uf', 'SP');
  djen.porOab = [pub(10, NUM_OUTRO, 'Antiga')];
  await verificarTudo(db, { fetchFn: fetchFalso, pausaMs: 0 }); // linha de base da OAB
  const antes = (await db.get('SELECT COUNT(*)::int n FROM notificacoes')).n;

  djen.porOab.push(pub(11, NUM_OUTRO, 'Processo não cadastrado — nova intimação'));
  djen.porOab.push(pub(2, NUM, 'Intime-se o autor para manifestação em 15 dias.')); // já existe
  const r = await verificarTudo(db, { fetchFn: fetchFalso, pausaMs: 0 });
  assert.equal(r.publicacoes, 1);
  assert.equal((await db.get('SELECT COUNT(*)::int n FROM notificacoes')).n, antes + 1);
  const lista = await req('/api/publicacoes?lida=0');
  assert.equal(lista.corpo.itens.length, 1);
  assert.equal(lista.corpo.itens[0].processo_id, null);
});

test('lembretes: CRUD e disparo na antecedência configurada', async () => {
  const proc = (await db.get('SELECT id FROM processos'));
  const daqui2h = new Date(Date.now() + 2 * 3600_000).toISOString();
  const r = await req('/api/lembretes', {
    metodo: 'POST',
    corpo: { titulo: 'Prazo contestação', tipo: 'prazo', data_hora: daqui2h, antecedencia_min: 180, processo_id: proc.id },
  });
  assert.equal(r.status, 201);
  assert.equal((await req('/api/lembretes', { metodo: 'POST', corpo: { titulo: '', data_hora: daqui2h } })).status, 400);
  await req('/api/lembretes', { metodo: 'POST', corpo: { titulo: 'Reunião futura', data_hora: new Date(Date.now() + 10 * 86400_000).toISOString() } });

  emails.length = 0;
  assert.equal(await verificarLembretes(db), 1, 'só o que está dentro da antecedência');
  assert.equal(await verificarLembretes(db), 0, 'não repete');
  assert.match(emails[0].subject, /Prazo: Prazo contestação/);

  // Mudar a data reagenda o aviso.
  await req(`/api/lembretes/${r.corpo.id}`, { metodo: 'PUT', corpo: { data_hora: new Date(Date.now() + 3600_000).toISOString() } });
  assert.equal(await verificarLembretes(db), 1);

  const ag = await req(`/api/lembretes?de=${encodeURIComponent(new Date().toISOString())}&concluido=0`);
  assert.equal(ag.corpo.length, 2);
  await req(`/api/lembretes/${r.corpo.id}`, { metodo: 'PUT', corpo: { concluido: true } });
  assert.equal((await req('/api/lembretes?concluido=0')).corpo.length, 1);
  assert.equal((await req(`/api/lembretes/${r.corpo.id}`, { metodo: 'DELETE' })).status, 200);
});

test('falha de uma API é registrada sem interromper a outra', async () => {
  const quebrado = async (url, init) => {
    if (String(url).includes('comunicaapi')) return { ok: false, status: 503, text: async () => 'indisponível' };
    return fetchFalso(url, init);
  };
  const r = await verificarTudo(db, { fetchFn: quebrado, pausaMs: 0 });
  assert.ok(r.erros.some((e) => /DJEN: .*HTTP 503/.test(e)));
  assert.match((await db.get('SELECT erro_verificacao FROM processos WHERE numero = ?', NUM)).erro_verificacao, /DJEN/);
  assert.ok(chamadas.some((c) => c.includes('api_publica_tjsp/_search')));
});

test('DataJud sobrecarregado (HTTP 429): tenta de novo e, se persistir, mostra mensagem clara', async () => {
  let falhas = 1;
  const instavel = async (url, init) => {
    if (String(url).includes('datajud') && falhas-- > 0) {
      return { ok: false, status: 429, text: async () => '{"error":{"type":"es_rejected_execution_exception"}}' };
    }
    return fetchFalso(url, init);
  };
  const ok = await req('/api/processos/consultar', { metodo: 'POST', corpo: { numero: NUM } });
  assert.equal(ok.status, 200);
  const app2 = criarApp(db, { fetchFn: instavel });
  const s2 = await new Promise((r) => { const s = app2.listen(0, () => r(s)); });
  try {
    const url = `http://127.0.0.1:${s2.address().port}/api/processos/consultar`;
    const h = { 'Content-Type': 'application/json', Cookie: cookie };
    let r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ numero: NUM }) });
    assert.equal(r.status, 200, 'recupera após uma falha temporária');
    falhas = 99;
    r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ numero: NUM }) });
    assert.equal(r.status, 502);
    assert.match((await r.json()).erro, /DataJud \(CNJ\) está instável.*salvar o processo assim mesmo/);
  } finally {
    s2.close();
  }
});

test('DJEN bloqueado por país: explica que o servidor precisa estar no Brasil', async () => {
  const bloqueado = async (url, init) => {
    if (String(url).includes('comunicaapi')) {
      return { ok: false, status: 403, text: async () => '<H1>403 ERROR</H1>The Amazon CloudFront distribution is configured to block access from your country.' };
    }
    return fetchFalso(url, init);
  };
  const r = await verificarTudo(db, { fetchFn: bloqueado, pausaMs: 0 });
  assert.ok(r.erros.some((e) => /servidores localizados no Brasil/.test(e)));
});

test('botão de diagnóstico do CNJ', async () => {
  const r = await req('/api/diagnostico', { metodo: 'POST', corpo: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.map((x) => x.fonte), ['DJEN (publicações)', 'DataJud (andamentos)', 'PJe TJMG (andamentos)', 'eproc TJMG (MNI)']);
  assert.ok(r.corpo.slice(0, 2).every((x) => x.ok));
  process.env.PJE_TJMG = '0';
  try {
    assert.equal((await req('/api/diagnostico', { metodo: 'POST', corpo: {} })).corpo.length, 3, 'PJE_TJMG=0 desliga o PJe (o eproc continua listado)');
  } finally {
    delete process.env.PJE_TJMG;
  }
});

test('agendador (/api/cron): exige a chave e executa lembretes + monitoramento', async () => {
  const antigo = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await req('/api/cron', { semCookie: true })).status, 503);
    process.env.CRON_SECRET = 'segredo-de-teste-123';
    assert.equal((await req('/api/cron?chave=errada', { semCookie: true })).status, 401);
    const r = await req('/api/cron?chave=segredo-de-teste-123', { semCookie: true });
    assert.equal(r.status, 200);
    assert.equal(typeof r.corpo.lembretes, 'number');
    assert.equal(r.corpo.processos, 0, 'processos verificados há pouco não são consultados de novo');
    await db.run('UPDATE processos SET ultima_verificacao = ?', new Date(Date.now() - 5 * 3600_000).toISOString());
    const r2 = await req('/api/cron?chave=segredo-de-teste-123', { semCookie: true });
    assert.equal(r2.corpo.processos, 1, 'processo com verificação vencida é consultado');
  } finally {
    if (antigo === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = antigo;
  }
});

test('ids inválidos na URL não derrubam a API', async () => {
  assert.equal((await req('/api/processos/abc')).status, 404);
  assert.equal((await req('/api/lembretes/xyz', { metodo: 'DELETE' })).status, 404);
});

test('URL do banco: remove parâmetros extras e mantém o sslmode', async () => {
  const { limparUrl } = await import('../server/db.js');
  assert.equal(
    limparUrl('postgres://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x'),
    'postgres://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require',
  );
});

test('encontra a URL do banco mesmo com prefixo da Vercel', async () => {
  const { urlDoBanco } = await import('../server/db.js');
  assert.equal(urlDoBanco({ STORAGE_POSTGRES_URL: 'postgres://x' }), 'postgres://x');
  assert.equal(urlDoBanco({ POSTGRES_URL: 'postgres://a', STORAGE_POSTGRES_URL: 'postgres://b' }), 'postgres://a');
  assert.equal(urlDoBanco({ STORAGE_POSTGRES_URL_NON_POOLING: 'postgres://c' }), '');
});

test('DataJud instável: marca pendente sem erro, pausa e depois recupera sem avalanche de avisos', async () => {
  const { retentarDataJud, verificarProcesso } = await import('../server/monitor.js');
  const NUM3 = gerarCnj(3333333);
  djen.porProcesso[NUM3] = [];
  datajud[NUM3] = {
    tribunal: 'TJSP',
    classe: { nome: 'Execução Fiscal' },
    orgaoJulgador: { nome: 'Vara de Execuções Fiscais' },
    movimentos: [
      { codigo: 1, nome: 'Distribuição', dataHora: '2024-01-01T10:00:00.000Z' },
      { codigo: 2, nome: 'Citação', dataHora: '2024-02-01T10:00:00.000Z' },
    ],
  };
  await db.run("DELETE FROM config WHERE chave = 'datajud_pausa_ate'");
  const proc = await db.get('INSERT INTO processos (numero, titulo) VALUES (?, ?) RETURNING *', NUM3, 'Execução');
  const sobrecarregado = async (url, init) =>
    String(url).includes('datajud') ? { ok: false, status: 429, text: async () => 'es_rejected_execution_exception' } : fetchFalso(url, init);

  const r1 = await verificarProcesso(db, proc, { fetchFn: sobrecarregado });
  assert.deepEqual(r1.erros, [], 'instabilidade do CNJ não vira erro');
  let p = await db.get('SELECT * FROM processos WHERE id = ?', proc.id);
  assert.equal(p.datajud_pendente, 1);
  assert.equal(p.erro_verificacao, null);
  assert.ok(await db.get("SELECT 1 FROM config WHERE chave = 'datajud_pausa_ate' AND valor > ?", new Date().toISOString()), 'pausa ativada');

  // Durante a pausa, a nova tentativa não consulta o CNJ.
  assert.equal((await retentarDataJud(db, { fetchFn: fetchFalso })).processos, 0);

  // Pausa vencida e tentativa antiga: o DataJud volta e os andamentos entram como linha de base (sem avisos).
  await db.run("DELETE FROM config WHERE chave = 'datajud_pausa_ate'");
  await db.run('UPDATE processos SET datajud_tentativa = ? WHERE id = ?', new Date(Date.now() - 3600_000).toISOString(), proc.id);
  const avisosAntes = await db.valor('SELECT COUNT(*)::int FROM notificacoes');
  const r2 = await retentarDataJud(db, { fetchFn: fetchFalso });
  assert.equal(r2.processos, 1);
  p = await db.get('SELECT * FROM processos WHERE id = ?', proc.id);
  assert.equal(p.datajud_pendente, 0);
  assert.ok(p.datajud_em);
  assert.equal(p.classe, 'Execução Fiscal', 'cadastro preenchido automaticamente');
  assert.equal(await db.valor('SELECT COUNT(*)::int FROM andamentos WHERE processo_id = ? AND lida = 1', proc.id), 2);
  assert.equal(await db.valor('SELECT COUNT(*)::int FROM notificacoes'), avisosAntes, 'histórico antigo não gera aviso');

  // Daqui em diante, andamento novo gera aviso.
  datajud[NUM3].movimentos.push({ codigo: 3, nome: 'Sentença', dataHora: '2026-11-20T10:00:00.000Z' });
  const r3 = await verificarProcesso(db, p, { fetchFn: fetchFalso, djen: false });
  assert.equal(r3.andamentos, 1);
  assert.equal(await db.valor('SELECT COUNT(*)::int FROM notificacoes'), avisosAntes + 1);
  await db.run('DELETE FROM processos WHERE id = ?', proc.id);
});

test('atualiza banco criado pela versão anterior (migração)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { PGlite } = await import('@electric-sql/pglite');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'rodjuris-mig-'));
  const antigo = new PGlite(pasta);
  await antigo.exec(`
    CREATE TABLE processos (id SERIAL PRIMARY KEY, numero TEXT NOT NULL UNIQUE, ultima_verificacao TEXT, monitorar INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE andamentos (id SERIAL PRIMARY KEY, processo_id INTEGER, external_key TEXT);
    CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, dados TEXT NOT NULL);
    CREATE TABLE lembretes (id SERIAL PRIMARY KEY, titulo TEXT NOT NULL, data_hora TEXT NOT NULL, concluido INTEGER NOT NULL DEFAULT 0);
    INSERT INTO processos (numero, ultima_verificacao) VALUES ('1', '2026-11-01T00:00:00.000Z'), ('2', NULL);
    INSERT INTO andamentos (processo_id, external_key) VALUES (1, 'x');`);
  await antigo.close();
  const novo = await openDb(pasta);
  const linhas = await novo.all('SELECT numero, datajud_em, datajud_pendente FROM processos ORDER BY numero');
  assert.equal(linhas[0].datajud_em, '2026-11-01T00:00:00.000Z', 'processo que já tinha andamentos não refaz a linha de base');
  assert.equal(linhas[1].datajud_em, null);
  assert.equal(linhas[1].datajud_pendente, 0);
  assert.equal(await novo.valor("SELECT valor FROM config WHERE chave = 'schema_versao'"), '10');
  await novo.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

// ───────── PJe TJMG (páginas sintéticas imitando a Consulta Pública) ─────────
const pjeTjmg = { processos: {}, chamadasDataJud: [] };
function htmlResposta(html, { cookies = [] } = {}) {
  const buf = Buffer.from(html, 'latin1');
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => cookies },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => html,
    json: async () => JSON.parse(html),
  };
}
function detalhePjeHtml(numero, eventos) {
  const linhas = eventos.map((e) => `<tr class="rich-table-row"><td class="rich-table-cell"><span>${e}</span></td><td></td></tr>`).join('');
  return `<html><body><div><label>N&uacute;mero Processo</label></div><div>${formatarCnj(numero)}</div>
    <div><label>Classe Judicial</label></div><div>[C&Iacute;VEL] PROCEDIMENTO COMUM C&Iacute;VEL (7)</div>
    <div><label>Assunto</label></div><div>Indeniza&ccedil;&atilde;o por Dano Moral</div>
    <div><label>&Oacute;rg&atilde;o Julgador</label></div><div>2&ordf; Vara C&iacute;vel da Comarca de Belo Horizonte</div>
    <table id="j_id145:processoEvento"><thead><tr><th>Movimento</th></tr></thead><tbody id="j_id145:processoEvento:tb">${linhas}</tbody></table></body></html>`;
}
const fetchComPje = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host === 'pje-consulta-publica.tjmg.jus.br') {
    if (u.pathname.endsWith('/ConsultaPublica/listView.seam') && (init.method || 'GET') === 'GET') {
      return htmlResposta(
        `<form id="fPP" name="fPP" method="post" action="/pje/ConsultaPublica/listView.seam;jsessionid=abc"><input type="hidden" name="javax.faces.ViewState" id="javax.faces.ViewState" value="j_id1" /></form><script>function executarReCaptcha() { if (false) { grecaptcha.execute(); } }</script>`,
        { cookies: ['JSESSIONID=abc; path=/pje', 'BIGipServer=xyz; path=/'] },
      );
    }
    if (init.method === 'POST') {
      assert.match(init.headers.Cookie, /JSESSIONID=abc/, 'envia os cookies da sessão');
      const numero = new URLSearchParams(init.body).get('fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso');
      const achou = pjeTjmg.processos[numero.replace(/\D/g, '')];
      return htmlResposta(
        achou
          ? `<span>1 resultados encontrados</span><a href="/pje/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=00ff">${numero}</a>`
          : '<span>0 resultados encontrados</span>',
      );
    }
    if (u.pathname.includes('DetalheProcessoConsultaPublica')) {
      const [numero, eventos] = Object.entries(pjeTjmg.processos)[0];
      return htmlResposta(detalhePjeHtml(numero, eventos));
    }
  }
  if (u.host === 'api-publica.datajud.cnj.jus.br') pjeTjmg.chamadasDataJud.push(JSON.parse(init.body).query.match.numeroProcesso);
  return fetchFalso(url, init);
};

test('PJe TJMG: lê dados e movimentações (com acentos em ISO-8859-1)', async () => {
  const { lerDetalhePje, dataHoraBrParaIso, ehTjmg } = await import('../server/pje_tjmg.js');
  const NUM_MG = gerarCnj(4444444, '2024', '8', '13', '0024');
  assert.ok(ehTjmg(NUM_MG));
  assert.ok(!ehTjmg(NUM));
  const d = lerDetalhePje(detalhePjeHtml(NUM_MG, ['17/07/2026 14:29:11 - Despacho (Despacho)', '18/05/2026 10:19:09 - Conclusos para despacho']));
  assert.equal(d.classe, '[CÍVEL] PROCEDIMENTO COMUM CÍVEL (7)');
  assert.equal(d.orgao, '2ª Vara Cível da Comarca de Belo Horizonte');
  assert.equal(d.movimentos.length, 2);
  assert.equal(d.movimentos[0].nome, 'Despacho (Despacho)');
  assert.equal(d.movimentos[0].data, '2026-07-17T17:29:11.000Z');
  assert.equal(dataHoraBrParaIso('02/09/2026 00:28:46'), '2026-09-02T03:28:46.000Z');
});

test('PJe TJMG: monitora pelo PJe (sem DataJud), avisa novidades e detecta migração para o eproc', async () => {
  const { verificarProcesso } = await import('../server/monitor.js');
  await db.run("DELETE FROM config WHERE chave = 'datajud_pausa_ate'");
  const NUM_MG = gerarCnj(5555555, '2024', '8', '13', '0024');
  djen.porProcesso[NUM_MG] = [];
  pjeTjmg.processos = { [NUM_MG]: ['10/11/2026 09:00:00 - Juntada de Petição', '01/11/2026 08:00:00 - Distribuído por sorteio'] };
  pjeTjmg.chamadasDataJud = [];
  let p = await db.get('INSERT INTO processos (numero, titulo) VALUES (?, ?) RETURNING *', NUM_MG, 'Caso MG');
  const avisos0 = await db.valor('SELECT COUNT(*)::int FROM notificacoes');

  await verificarProcesso(db, p, { fetchFn: fetchComPje });
  p = await db.get('SELECT * FROM processos WHERE id = ?', p.id);
  assert.equal(p.pje_situacao, 'ativo');
  assert.equal(p.classe, '[CÍVEL] PROCEDIMENTO COMUM CÍVEL (7)', 'cadastro preenchido pelo PJe');
  assert.equal(await db.valor("SELECT COUNT(*)::int FROM andamentos WHERE processo_id = ? AND fonte = 'pje' AND lida = 1", p.id), 2, 'linha de base');
  assert.deepEqual(pjeTjmg.chamadasDataJud, [], 'processo no PJe não consulta o DataJud');
  assert.equal(await db.valor('SELECT COUNT(*)::int FROM notificacoes'), avisos0);

  pjeTjmg.processos[NUM_MG].unshift('25/11/2026 15:10:00 - Proferido despacho de mero expediente');
  const r = await verificarProcesso(db, p, { fetchFn: fetchComPje });
  assert.equal(r.andamentos, 1);
  assert.equal(await db.valor('SELECT COUNT(*)::int FROM notificacoes'), avisos0 + 1);

  pjeTjmg.processos[NUM_MG].unshift('26/11/2026 00:37:51 - Migrada a tramitação do processo do sistema eletrônico originário para o outro sistema eletrônico');
  p = await db.get('SELECT * FROM processos WHERE id = ?', p.id);
  await verificarProcesso(db, p, { fetchFn: fetchComPje });
  p = await db.get('SELECT * FROM processos WHERE id = ?', p.id);
  assert.equal(p.pje_situacao, 'migrado');
  assert.ok(await db.get("SELECT 1 FROM notificacoes WHERE titulo LIKE 'Processo migrado do PJe para o eproc%'"));
  assert.deepEqual(pjeTjmg.chamadasDataJud, [NUM_MG], 'após a migração, volta a usar o DataJud');
  await db.run('DELETE FROM processos WHERE id = ?', p.id);
});

test('PJe TJMG: processo que não está no PJe usa o DataJud e é reconferido depois de alguns dias', async () => {
  const { verificarProcesso } = await import('../server/monitor.js');
  await db.run("DELETE FROM config WHERE chave = 'datajud_pausa_ate'");
  const NUM_EPROC = gerarCnj(6666666, '2026', '8', '13', '0024');
  djen.porProcesso[NUM_EPROC] = [];
  pjeTjmg.processos = {};
  pjeTjmg.chamadasDataJud = [];
  let p = await db.get('INSERT INTO processos (numero) VALUES (?) RETURNING *', NUM_EPROC);
  await verificarProcesso(db, p, { fetchFn: fetchComPje });
  p = await db.get('SELECT * FROM processos WHERE id = ?', p.id);
  assert.equal(p.pje_situacao, 'ausente');
  assert.deepEqual(pjeTjmg.chamadasDataJud, [NUM_EPROC]);
  const verificadoEm = p.pje_verificado_em;
  await verificarProcesso(db, p, { fetchFn: fetchComPje });
  assert.equal((await db.get('SELECT pje_verificado_em FROM processos WHERE id = ?', p.id)).pje_verificado_em, verificadoEm, 'não reconsulta o PJe em seguida');
  await db.run('DELETE FROM processos WHERE id = ?', p.id);
});

// ───────── eproc TJMG via MNI 2.2.2 (respostas SOAP simuladas) ─────────
const mni = { processos: {}, avisos: [], operacoes: [], loginOk: true };
function soap(corpo, encoding = 'UTF-8') {
  return `<?xml version="1.0" encoding="${encoding}"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/" xmlns:ns2="http://www.cnj.jus.br/tipos-servico-intercomunicacao-2.2.2" xmlns:ns3="http://www.cnj.jus.br/intercomunicacao-2.2.2"><SOAP-ENV:Body>${corpo}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}
function xmlResposta(xml) {
  const buf = Buffer.from(xml, /encoding="ISO-8859-1"/.test(xml) ? 'latin1' : 'utf8');
  return { ok: true, status: 200, headers: { get: () => 'text/xml', getSetCookie: () => [] }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}
const fetchComEproc = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host === 'eproc1g-ws.tjmg.jus.br' || u.host === 'eproc2g-ws.tjmg.jus.br') {
    const op = init.headers.SOAPAction.replace(/"/g, '').split('/').pop();
    mni.operacoes.push(`${u.host.slice(0, 7)}:${op}`);
    assert.notEqual(op, 'consultarTeorComunicacao', 'nunca registra ciência');
    assert.match(init.body, /<tip:idConsultante>usuario-teste<\/tip:idConsultante>/);
    if (!mni.loginOk) return xmlResposta(soap(`<ns1:${op}Resposta><ns2:sucesso>false</ns2:sucesso><ns2:mensagem>Usuário ou senha inválidos</ns2:mensagem></ns1:${op}Resposta>`));
    if (op === 'consultarProcesso') {
      const numero = init.body.match(/<tip:numeroProcesso>(\d+)</)[1];
      assert.match(init.body, /<tip:incluirDocumentos>false</, 'não baixa documentos');
      const movs = u.host.startsWith('eproc1g') ? mni.processos[numero] : null;
      if (!movs) return xmlResposta(soap(`<ns1:consultarProcessoResposta><ns2:sucesso>false</ns2:sucesso><ns2:mensagem>Processo não encontrado</ns2:mensagem></ns1:consultarProcessoResposta>`));
      const xmlMovs = movs
        .map(([quando, desc, id]) => `<ns3:movimento dataHora="${quando}" identificadorMovimento="${id}"><ns3:movimentoLocal codigoMovimento="1" descricao="${desc}"/></ns3:movimento>`)
        .join('');
      return xmlResposta(
        soap(`<ns1:consultarProcessoResposta><ns2:sucesso>true</ns2:sucesso><ns2:mensagem>OK</ns2:mensagem><ns2:processo>
          <ns3:dadosBasicos numero="${numero}" classeProcessual="7"><ns3:assunto><ns3:assuntoLocal codigoAssunto="1" descricao="Dano Moral"/></ns3:assunto>
          <ns3:orgaoJulgador nomeOrgao="3ª Vara Cível de Belo Horizonte" codigoOrgao="1"/></ns3:dadosBasicos>${xmlMovs}</ns2:processo></ns1:consultarProcessoResposta>`),
      );
    }
    if (op === 'consultarAvisosPendentes') {
      const avisos = u.host.startsWith('eproc1g') ? mni.avisos : [];
      const xml = avisos
        .map(([id, numero, tipo, data]) => `<ns2:aviso idAviso="${id}" tipoComunicacao="${tipo}"><ns3:destinatario/><ns3:processo numero="${numero}"/><ns3:dataDisponibilizacao>${data}</ns3:dataDisponibilizacao></ns2:aviso>`)
        .join('');
      return xmlResposta(soap(`<ns1:consultarAvisosPendentesResposta><ns2:sucesso>true</ns2:sucesso><ns2:mensagem>OK</ns2:mensagem>${xml}</ns1:consultarAvisosPendentesResposta>`));
    }
  }
  return fetchComPje(url, init);
};

test('eproc MNI: lê movimentações, avisa novidades e não consulta o DataJud', async () => {
  const { verificarProcesso } = await import('../server/monitor.js');
  const antigo = { u: process.env.EPROC_USUARIO, s: process.env.EPROC_SENHA };
  process.env.EPROC_USUARIO = 'usuario-teste';
  process.env.EPROC_SENHA = 'senha-teste';
  try {
    await db.run("DELETE FROM config WHERE chave = 'datajud_pausa_ate'");
    const NUM_EP = gerarCnj(7777777, '2026', '8', '13', '0024');
    djen.porProcesso[NUM_EP] = [];
    pjeTjmg.processos = {};
    pjeTjmg.chamadasDataJud = [];
    mni.processos = { [NUM_EP]: [['20261120100000', 'Distribuído por sorteio', 'm1'], ['20261121110000', 'Conclusos para decisão', 'm2']] };
    mni.operacoes = [];
    let p = await db.get('INSERT INTO processos (numero, titulo) VALUES (?, ?) RETURNING *', NUM_EP, 'Caso eproc');
    const avisos0 = await db.valor('SELECT COUNT(*)::int FROM notificacoes');

    await verificarProcesso(db, p, { fetchFn: fetchComEproc });
    p = await db.get('SELECT * FROM processos WHERE id = ?', p.id);
    assert.equal(p.pje_situacao, 'ausente');
    assert.equal(p.eproc_situacao, 'ativo');
    assert.equal(p.orgao, '3ª Vara Cível de Belo Horizonte');
    assert.equal(p.assunto, 'Dano Moral');
    assert.equal(await db.valor("SELECT COUNT(*)::int FROM andamentos WHERE processo_id = ? AND fonte = 'eproc' AND lida = 1", p.id), 2, 'linha de base');
    assert.deepEqual(pjeTjmg.chamadasDataJud, [], 'com o eproc funcionando, o DataJud não é consultado');
    assert.equal(await db.valor('SELECT COUNT(*)::int FROM notificacoes'), avisos0);
    const and = await db.get("SELECT data FROM andamentos WHERE processo_id = ? AND nome = 'Conclusos para decisão'", p.id);
    assert.equal(and.data, '2026-11-21T14:00:00.000Z', 'data do MNI em horário de Brasília');

    mni.processos[NUM_EP].push(['20261125153000', 'Decisão interlocutória', 'm3']);
    const r = await verificarProcesso(db, p, { fetchFn: fetchComEproc });
    assert.equal(r.andamentos, 1);
    assert.ok(await db.get("SELECT 1 FROM notificacoes WHERE titulo LIKE '1 novo(s) andamento(s) — Caso eproc'"));
    assert.ok(mni.operacoes.every((o) => o.endsWith('consultarProcesso')));

    // Login errado: erro claro e volta para o DataJud.
    mni.loginOk = false;
    p = await db.get('SELECT * FROM processos WHERE id = ?', p.id);
    const r2 = await verificarProcesso(db, p, { fetchFn: fetchComEproc });
    assert.ok(r2.erros.some((e) => /Usuário ou senha inválidos/.test(e)));
    assert.deepEqual(pjeTjmg.chamadasDataJud, [NUM_EP]);
    mni.loginOk = true;
    await db.run('DELETE FROM processos WHERE id = ?', p.id);
  } finally {
    if (antigo.u === undefined) delete process.env.EPROC_USUARIO; else process.env.EPROC_USUARIO = antigo.u;
    if (antigo.s === undefined) delete process.env.EPROC_SENHA; else process.env.EPROC_SENHA = antigo.s;
  }
});

test('eproc MNI: intimações pendentes — linha de base, aviso das novas e limpeza das já abertas', async () => {
  const { verificarAvisosEproc } = await import('../server/monitor.js');
  const env = { EPROC_USUARIO: 'usuario-teste', EPROC_SENHA: 'senha-teste' };
  await db.run("DELETE FROM config WHERE chave = 'eproc_avisos_em'");
  await db.run('DELETE FROM avisos_eproc');
  mni.avisos = [['a1', gerarCnj(8888888, '2026', '8', '13', '0024'), 'I', '20261124090000']];
  mni.operacoes = [];
  const avisos0 = await db.valor('SELECT COUNT(*)::int FROM notificacoes');

  const r1 = await verificarAvisosEproc(db, { fetchFn: fetchComEproc, env });
  assert.equal(r1.linhaDeBase, true);
  assert.equal(await db.valor('SELECT COUNT(*)::int FROM notificacoes'), avisos0, 'pendências antigas não geram aviso');
  assert.equal((await verificarAvisosEproc(db, { fetchFn: fetchComEproc, env })).ignorado, true, 'respeita o intervalo de 1 h');

  mni.avisos.push(['a2', gerarCnj(9999999, '2026', '8', '13', '0024'), 'C', '20261125100000']);
  const r2 = await verificarAvisosEproc(db, { fetchFn: fetchComEproc, env, forcar: true });
  assert.equal(r2.novos, 1);
  assert.ok(await db.get("SELECT 1 FROM notificacoes WHERE titulo LIKE 'Citação pendente no eproc%'"));
  assert.ok(mni.operacoes.every((o) => o.endsWith('consultarAvisosPendentes')), 'só lista, nunca abre o teor');

  mni.avisos = mni.avisos.slice(1); // a1 foi aberta no eproc
  await verificarAvisosEproc(db, { fetchFn: fetchComEproc, env, forcar: true });
  assert.deepEqual((await db.all('SELECT id FROM avisos_eproc ORDER BY id')).map((x) => x.id), ['1|a2']);
});

test('eproc MNI: decodifica respostas em UTF-8 e em ISO-8859-1', async () => {
  const { decodificar } = await import('../server/eproc_mni.js');
  const xml = (enc) => `<?xml version="1.0" encoding="${enc}"?><a>Órgão Cível</a>`;
  assert.match(decodificar(Buffer.from(xml('UTF-8'), 'utf8')), /Órgão Cível/);
  assert.match(decodificar(Buffer.from(xml('ISO-8859-1'), 'latin1')), /Órgão Cível/);
  assert.match(decodificar(Buffer.from('<a>Órgão</a>', 'latin1'), 'text/xml; charset=ISO-8859-1'), /Órgão/);
});

// ───────── Melhorias: nomes das classes e sugestões de prazo ─────────
test('prazos: dias úteis com fins de semana, feriados nacionais e recesso de 20/12 a 20/1', async () => {
  const { vencimentoDiasUteis, feriadosNacionais, pascoa, parteEhCliente, lerIntimacaoComPrazo, somarDiasCorridos } = await import('../server/prazos.js');
  assert.equal(pascoa(2026).toISOString().slice(0, 10), '2026-04-05');
  const f = feriadosNacionais(2026);
  for (const d of ['2026-02-16', '2026-02-17', '2026-04-03', '2026-06-04', '2026-11-20', '2026-04-21']) assert.ok(f.has(d), d);
  // Ciência na quarta 11/11/2026: 15 dias úteis, pulando 15/11 (domingo) e 20/11 (sexta, feriado) → 03/12/2026.
  assert.equal(vencimentoDiasUteis('2026-11-11', 15), '2026-12-03');
  // Ciência na sexta: o prazo começa na segunda.
  assert.equal(vencimentoDiasUteis('2026-11-27', 1), '2026-11-30');
  // Atravessa o recesso: ciência em 18/12/2026 (sexta), 5 dias úteis → 21/12 a 20/1 suspensos → 27/01/2027.
  assert.equal(vencimentoDiasUteis('2026-12-18', 5), '2027-01-27');
  assert.equal(somarDiasCorridos('2026-11-25', 10), '2026-12-05');

  assert.ok(parteEhCliente('CONSORCIO IGC CETUS', 'Consórcio IGC Cetus Ltda'));
  assert.ok(parteEhCliente('FUNDACAO HOSPITALAR DO ESTADO DE MINAS GERAIS - FHEMIG', 'FHEMIG'));
  assert.ok(!parteEhCliente('CONSORCIO IGC CETUS', 'FHEMIG'));

  const lida = lerIntimacaoComPrazo({
    nome: 'Expedida/certificada a intimação eletrônica',
    complemento: 'Refer. ao Evento 31; Movimentado por: FULANA - USUÁRIO EPROC; Prazo:15 dias - Status: ABERTO - Parte: CONSORCIO IGC CETUS (IMPETRANTE)',
  });
  assert.deepEqual(lida, { dias: 15, parte: 'CONSORCIO IGC CETUS' });
  assert.equal(lerIntimacaoComPrazo({ nome: 'Ato ordinatório praticado', complemento: 'Prazo:15 dias - Status: ABERTO' }), null);
  assert.equal(lerIntimacaoComPrazo({ nome: 'Expedida/certificada a intimação eletrônica', complemento: 'Prazo:15 dias - Status: FECHADO' }), null);
});

test('classes CNJ: nomes conhecidos, consulta ao SGT com cache e texto provisório', async () => {
  const { nomeClasse, textoClasse } = await import('../server/classes_cnj.js');
  let chamadas = 0;
  const sgt = async (url) => {
    chamadas++;
    assert.match(url, /sgt\.cloud\.cnj\.jus\.br/, 'usa o endereço novo do SGT');
    return { ok: true, text: async () => '<ns1:Item><cod_item>1707</cod_item><cod_item_pai>1</cod_item_pai><nome>Reintegração / Manutenção de Posse</nome></ns1:Item>' };
  };
  assert.equal(await nomeClasse(db, 120, { fetchFn: sgt }), 'Mandado de Segurança Cível');
  assert.equal(chamadas, 0, 'classe comum não consulta o CNJ');
  assert.equal(await nomeClasse(db, 1707, { fetchFn: sgt }), 'Reintegração / Manutenção de Posse');
  assert.equal(await nomeClasse(db, 1707, { fetchFn: sgt }), 'Reintegração / Manutenção de Posse');
  assert.equal(chamadas, 1, 'guarda no banco');
  const fora = async () => ({ ok: false, text: async () => '' });
  assert.equal(await textoClasse(db, 99999, { fetchFn: fora }), 'Classe CNJ 99999');
});

test('eproc: classe com nome oficial e sugestão de prazo só para intimação do cliente', async () => {
  const { verificarProcesso } = await import('../server/monitor.js');
  const antigo = { u: process.env.EPROC_USUARIO, s: process.env.EPROC_SENHA };
  process.env.EPROC_USUARIO = 'usuario-teste';
  process.env.EPROC_SENHA = 'senha-teste';
  try {
    await db.run("DELETE FROM config WHERE chave = 'datajud_pausa_ate'");
    const NUM_EP = gerarCnj(1212121, '2026', '8', '13', '0024');
    djen.porProcesso[NUM_EP] = [];
    pjeTjmg.processos = {};
    mni.processos = { [NUM_EP]: [['20261101100000', 'Distribuído por sorteio', 'x1']] };
    // Cadastro antigo com o texto provisório da classe: deve ser trocado pelo nome oficial.
    let p = await db.get('INSERT INTO processos (numero, titulo, cliente, classe) VALUES (?, ?, ?, ?) RETURNING *', NUM_EP, 'MS Cetus', 'FHEMIG', 'Classe CNJ 7');
    await verificarProcesso(db, p, { fetchFn: fetchComEproc });
    p = await db.get('SELECT * FROM processos WHERE id = ?', p.id);
    assert.equal(p.classe, 'Procedimento Comum Cível');

    const intim = (parte, id, quando) => [quando, 'Expedida/certificada a intimação eletrônica', id, parte];
    mni.processos[NUM_EP].push(intim('CONSORCIO IGC CETUS (IMPETRANTE)', 'x2', '20261111093900'));
    mni.processos[NUM_EP].push(intim('FUNDACAO HOSPITALAR DO ESTADO DE MINAS GERAIS - FHEMIG (IMPETRADO)', 'x3', '20261111094500'));
    // O simulador do MNI põe a parte no complemento:
    const original = fetchComEproc;
    const comParte = async (url, init) => {
      const r = await original(url, init);
      if (!String(url).includes('eproc1g-ws')) return r;
      const xml = new TextDecoder().decode(await r.arrayBuffer()).replace(
        /<ns3:movimento dataHora="(\d+)" identificadorMovimento="(x2|x3)"><ns3:movimentoLocal codigoMovimento="1" descricao="([^"]+)"\/><\/ns3:movimento>/g,
        (m, dh, id, desc) => {
          const parte = mni.processos[NUM_EP].find((x) => x[2] === id)[3];
          return `<ns3:movimento dataHora="${dh}" identificadorMovimento="${id}"><ns3:complemento>Prazo:15 dias - Status: ABERTO - Parte: ${parte}</ns3:complemento><ns3:movimentoLocal codigoMovimento="1" descricao="${desc}"/></ns3:movimento>`;
        },
      );
      return xmlResposta(xml);
    };
    p = await db.get('SELECT * FROM processos WHERE id = ?', p.id);
    await verificarProcesso(db, p, { fetchFn: comParte });
    const sug = await db.all('SELECT * FROM lembretes WHERE processo_id = ? AND sugerido = 1', p.id);
    assert.equal(sug.length, 1, 'só a intimação da FHEMIG (cliente) gera sugestão');
    assert.equal(sug[0].tipo, 'prazo');
    assert.equal(sug[0].data_hora, '2026-12-03T21:00:00.000Z', '15 dias úteis a partir de 11/11/2026, às 18h');
    assert.match(sug[0].descricao, /FHEMIG/);
    assert.ok(await db.get("SELECT 1 FROM notificacoes WHERE titulo LIKE '1 sugestão(ões) de prazo%'"));

    // Repetir a verificação não duplica a sugestão.
    await verificarProcesso(db, await db.get('SELECT * FROM processos WHERE id = ?', p.id), { fetchFn: comParte });
    assert.equal(await db.valor('SELECT COUNT(*)::int FROM lembretes WHERE processo_id = ? AND sugerido = 1', p.id), 1);

    // Confirmar pela API.
    const r = await req(`/api/lembretes/${sug[0].id}`, { metodo: 'PUT', corpo: { sugerido: false } });
    assert.equal(r.corpo.sugerido, 0);
    await db.run('DELETE FROM processos WHERE id = ?', p.id);
  } finally {
    if (antigo.u === undefined) delete process.env.EPROC_USUARIO; else process.env.EPROC_USUARIO = antigo.u;
    if (antigo.s === undefined) delete process.env.EPROC_SENHA; else process.env.EPROC_SENHA = antigo.s;
  }
});

test('eproc: intimação pendente sugere "Tomar ciência" (10 dias corridos) e conclui sozinho após a ciência', async () => {
  const { verificarAvisosEproc } = await import('../server/monitor.js');
  const env = { EPROC_USUARIO: 'usuario-teste', EPROC_SENHA: 'senha-teste' };
  await db.run("DELETE FROM config WHERE chave = 'eproc_avisos_em'");
  await db.run('DELETE FROM avisos_eproc');
  const NUM_A = gerarCnj(3434343, '2026', '8', '13', '0024');
  mni.avisos = [['p1', NUM_A, 'I', '20261120100000']];
  await verificarAvisosEproc(db, { fetchFn: fetchComEproc, env }); // 1ª leitura: cria a sugestão, sem aviso
  let l = await db.get("SELECT * FROM lembretes WHERE origem = '1|p1' OR origem = 'aviso|1|p1'");
  assert.ok(l, 'pendência já existente também ganha sugestão');
  assert.equal(l.data_hora, '2026-11-30T12:00:00.000Z', '20/11 + 10 dias corridos = 30/11, às 9h');
  assert.equal(l.sugerido, 1);
  mni.avisos = []; // você abriu a intimação no eproc
  await verificarAvisosEproc(db, { fetchFn: fetchComEproc, env, forcar: true });
  l = await db.get('SELECT concluido FROM lembretes WHERE id = ?', l.id);
  assert.equal(l.concluido, 1, 'lembrete concluído automaticamente');
});

test('processo: situação da liminar (cadastro, edição, filtro e validação)', async () => {
  const NUM_L = gerarCnj(5656565, '2026', '8', '13', '0024');
  djen.porProcesso[NUM_L] = [];
  const antigo = process.env.PJE_TJMG;
  process.env.PJE_TJMG = '0';
  try {
    const r = await req('/api/processos', { metodo: 'POST', corpo: { numero: NUM_L, titulo: 'MS liminar', liminar: 'nao_analisada', monitorar: false } });
    assert.equal(r.status, 201);
    assert.equal(r.corpo.liminar, 'nao_analisada');
    assert.equal((await req('/api/processos', { metodo: 'POST', corpo: { numero: gerarCnj(5656566), liminar: 'talvez' } })).status, 400);
    const e = await req(`/api/processos/${r.corpo.id}`, { metodo: 'PUT', corpo: { liminar: 'deferida' } });
    assert.equal(e.corpo.liminar, 'deferida');
    const outros = await req(`/api/processos/${r.corpo.id}`, { metodo: 'PUT', corpo: { titulo: 'MS liminar (editado)' } });
    assert.equal(outros.corpo.liminar, 'deferida', 'editar outro campo não apaga a liminar');
    assert.deepEqual((await req('/api/processos?liminar=deferida')).corpo.map((p) => p.numero), [NUM_L]);
    assert.ok(!(await req('/api/processos?liminar=sem_info')).corpo.some((p) => p.numero === NUM_L));
    const limpa = await req(`/api/processos/${r.corpo.id}`, { metodo: 'PUT', corpo: { liminar: null } });
    assert.equal(limpa.corpo.liminar, null);
    await req(`/api/processos/${r.corpo.id}`, { metodo: 'DELETE' });
  } finally {
    if (antigo === undefined) delete process.env.PJE_TJMG; else process.env.PJE_TJMG = antigo;
  }
});

test('cumprimento da liminar: lembretes de prazo e de cobrança, providências e conclusão automática', async () => {
  const { agendarCobrancas } = await import('../server/cumprimento.js');
  const { vencimentoDiasUteis, dataBrasilia } = await import('../server/prazos.js');
  const antigo = process.env.PJE_TJMG;
  process.env.PJE_TJMG = '0';
  try {
    const NUM_C = gerarCnj(7878787, '2026', '8', '13', '0024');
    const hoje = dataBrasilia(new Date().toISOString());
    const prazo = vencimentoDiasUteis(hoje, 10);
    // Liminar deferida já começa "pendente".
    const r = await req('/api/processos', {
      metodo: 'POST',
      corpo: { numero: NUM_C, titulo: 'MS Cetus', cliente: 'FHEMIG', liminar: 'deferida', cumprimento_prazo: prazo, cumprimento_responsavel: 'Diretoria de Contratos', cumprimento_multa: 'R$ 1.000/dia', monitorar: false },
    });
    assert.equal(r.status, 201);
    const id = r.corpo.id;
    let p = await db.get('SELECT * FROM processos WHERE id = ?', id);
    assert.equal(p.cumprimento_situacao, 'pendente');

    const prazoL = await db.get("SELECT * FROM lembretes WHERE origem = ?", `cumprimento-prazo|${id}`);
    assert.equal(prazoL.tipo, 'prazo');
    assert.equal(prazoL.data_hora, new Date(`${prazo}T18:00:00-03:00`).toISOString());
    assert.equal(prazoL.antecedencia_min, 2880, 'aviso 2 dias antes');
    assert.match(prazoL.descricao, /Diretoria de Contratos/);
    const cobr = await db.all('SELECT * FROM lembretes WHERE origem LIKE ? AND concluido = 0', `cobranca|${id}|%`);
    assert.equal(cobr.length, 1);
    assert.equal(cobr[0].data_hora, new Date(`${vencimentoDiasUteis(hoje, 3)}T09:00:00-03:00`).toISOString(), 'cobrança em 3 dias úteis, às 9h');

    // Mudar o prazo atualiza o mesmo lembrete (sem duplicar) e volta a avisar.
    await db.run('UPDATE lembretes SET notificado_em = ? WHERE id = ?', new Date().toISOString(), prazoL.id);
    const novoPrazo = vencimentoDiasUteis(hoje, 12);
    await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { cumprimento_prazo: novoPrazo, cumprimento_situacao: 'andamento' } });
    const prazoL2 = await db.get('SELECT * FROM lembretes WHERE origem = ?', `cumprimento-prazo|${id}`);
    assert.equal(prazoL2.id, prazoL.id);
    assert.equal(prazoL2.data_hora, new Date(`${novoPrazo}T18:00:00-03:00`).toISOString());
    assert.equal(prazoL2.notificado_em, null);

    // Depois que a cobrança é avisada, o agendador cria a próxima.
    await db.run('UPDATE lembretes SET notificado_em = ? WHERE id = ?', new Date().toISOString(), cobr[0].id);
    assert.equal(await agendarCobrancas(db), 1);
    assert.equal(await agendarCobrancas(db), 0, 'não duplica');

    // Providências.
    const pr = await req(`/api/processos/${id}/providencias`, { metodo: 'POST', corpo: { data: hoje, descricao: 'Ofício enviado à Diretoria de Contratos' } });
    assert.equal(pr.status, 201);
    assert.equal((await req(`/api/processos/${id}/providencias`, { metodo: 'POST', corpo: { descricao: '' } })).status, 400);
    const det = await req(`/api/processos/${id}`);
    assert.equal(det.corpo.providencias.length, 1);

    // Painel e filtro.
    const painel = await req('/api/painel');
    const item = painel.corpo.liminares.find((l) => l.id === id);
    assert.equal(item.ultima_providencia, hoje);
    assert.ok((await req('/api/processos?cumprimento=pendente')).corpo.some((x) => x.id === id));

    // Cumprida: registra a data e conclui todos os lembretes do cumprimento.
    const c2 = await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { cumprimento_situacao: 'cumprida' } });
    assert.equal(c2.corpo.cumprimento_data, hoje, 'data do cumprimento preenchida automaticamente');
    assert.equal(await db.valor("SELECT COUNT(*)::int FROM lembretes WHERE processo_id = ? AND concluido = 0 AND (origem LIKE 'cobranca|%' OR origem LIKE 'cumprimento-prazo|%')", id), 0);
    assert.equal(await agendarCobrancas(db), 0, 'cumprida não gera cobrança');
    assert.ok((await req('/api/processos?cumprimento=cumprida')).corpo.some((x) => x.id === id));
    assert.ok(!(await req('/api/painel')).corpo.liminares.some((l) => l.id === id));

    // Reabrir reativa o lembrete do prazo.
    await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { cumprimento_situacao: 'pendente', cumprimento_data: null } });
    assert.equal((await db.get('SELECT concluido FROM lembretes WHERE origem = ?', `cumprimento-prazo|${id}`)).concluido, 0);

    assert.equal((await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { cumprimento_situacao: 'quase' } })).status, 400);
    assert.equal((await req(`/api/providencias/${pr.corpo.id}`, { metodo: 'DELETE' })).status, 200);
    await req(`/api/processos/${id}`, { metodo: 'DELETE' });
  } finally {
    if (antigo === undefined) delete process.env.PJE_TJMG; else process.env.PJE_TJMG = antigo;
  }
});

test('calculadora de prazo (dias úteis, corridos e horas)', async () => {
  const u = await req('/api/prazos/calcular', { metodo: 'POST', corpo: { data: '2026-11-11', quantidade: 15, unidade: 'uteis' } });
  assert.equal(u.corpo.data, '2026-12-03');
  const c = await req('/api/prazos/calcular', { metodo: 'POST', corpo: { data: '2026-11-11', quantidade: 5, unidade: 'corridos' } });
  assert.equal(c.corpo.data, '2026-11-16');
  const h = await req('/api/prazos/calcular', { metodo: 'POST', corpo: { data: '2026-11-11', quantidade: 48, unidade: 'horas' } });
  assert.equal(h.corpo.data, '2026-11-13');
  assert.equal((await req('/api/prazos/calcular', { metodo: 'POST', corpo: { quantidade: 5 } })).status, 400);
});

test('número SEI: cadastro, validação e busca (com ou sem pontuação)', async () => {
  const antigo = process.env.PJE_TJMG;
  process.env.PJE_TJMG = '0';
  try {
    const NUM_S = gerarCnj(9191919, '2026', '8', '13', '0024');
    const r = await req('/api/processos', { metodo: 'POST', corpo: { numero: NUM_S, titulo: 'Caso SEI', sei: '1320.01.0012345/2026-12', monitorar: false } });
    assert.equal(r.status, 201);
    assert.equal(r.corpo.sei, '1320.01.0012345/2026-12');
    assert.equal((await req(`/api/processos/${r.corpo.id}`, { metodo: 'PUT', corpo: { sei: 'abc' } })).status, 400);
    for (const q of ['1320.01.0012345/2026-12', '13200100123452026', '0012345']) {
      assert.ok((await req(`/api/processos?q=${encodeURIComponent(q)}`)).corpo.some((p) => p.id === r.corpo.id), q);
    }
    await req(`/api/processos/${r.corpo.id}`, { metodo: 'DELETE' });
  } finally {
    if (antigo === undefined) delete process.env.PJE_TJMG; else process.env.PJE_TJMG = antigo;
  }
});

test('providências: tipo, hora, lembrete opcional, edição e exclusão', async () => {
  const antigo = process.env.PJE_TJMG;
  process.env.PJE_TJMG = '0';
  try {
    const NUM_P = gerarCnj(9292929, '2026', '8', '13', '0024');
    const proc = (await req('/api/processos', { metodo: 'POST', corpo: { numero: NUM_P, titulo: 'Caso providências', monitorar: false } })).corpo;
    const envio = await req(`/api/processos/${proc.id}/providencias`, {
      metodo: 'POST',
      corpo: { data: '2026-11-25', categoria: 'envio', descricao: 'Memorando de subsídios enviado à DPGF' },
    });
    assert.equal(envio.status, 201);
    assert.equal(envio.corpo.categoria, 'envio');
    assert.equal(envio.corpo.lembrete, null, 'sem lembrete quando não pedido');

    const aud = await req(`/api/processos/${proc.id}/providencias`, {
      metodo: 'POST',
      corpo: { data: '2026-12-10', hora: '14:00', categoria: 'audiencia', descricao: 'Audiência de conciliação', lembrar: true },
    });
    const lemb = await db.get('SELECT * FROM lembretes WHERE origem = ?', `providencia|${aud.corpo.id}`);
    assert.equal(lemb.tipo, 'audiencia');
    assert.equal(lemb.data_hora, '2026-12-10T17:00:00.000Z', '14h em Brasília');
    assert.equal(lemb.antecedencia_min, 1440, 'audiência avisa 1 dia antes');
    assert.equal(lemb.processo_id, proc.id);

    // Editar a data atualiza o lembrete; desmarcar remove.
    await req(`/api/providencias/${aud.corpo.id}`, { metodo: 'PUT', corpo: { data: '2026-12-11' } });
    assert.equal((await db.get('SELECT data_hora FROM lembretes WHERE id = ?', lemb.id)).data_hora, '2026-12-11T17:00:00.000Z');
    await req(`/api/providencias/${aud.corpo.id}`, { metodo: 'PUT', corpo: { lembrar: false } });
    assert.equal(await db.get('SELECT 1 FROM lembretes WHERE origem = ?', `providencia|${aud.corpo.id}`), undefined);
    await req(`/api/providencias/${aud.corpo.id}`, { metodo: 'PUT', corpo: { lembrar: true } });

    const det = await req(`/api/processos/${proc.id}`);
    assert.deepEqual(det.corpo.providencias.map((x) => x.categoria), ['audiencia', 'envio'], 'mais recentes primeiro');
    assert.ok(det.corpo.providencias[0].lembrete_id);

    assert.equal((await req(`/api/processos/${proc.id}/providencias`, { metodo: 'POST', corpo: { data: '2026-11-25', hora: '25h', descricao: 'x' } })).status, 400);
    assert.equal((await req(`/api/providencias/${aud.corpo.id}`, { metodo: 'DELETE' })).status, 200);
    assert.equal(await db.get('SELECT 1 FROM lembretes WHERE origem = ?', `providencia|${aud.corpo.id}`), undefined, 'excluir remove o lembrete');
    await req(`/api/processos/${proc.id}`, { metodo: 'DELETE' });
  } finally {
    if (antigo === undefined) delete process.env.PJE_TJMG; else process.env.PJE_TJMG = antigo;
  }
});

test('audiência agendada no processo: lembrete automático, reagendamento, painel e remoção', async () => {
  const { dataBrasilia } = await import('../server/prazos.js');
  const antigo = process.env.PJE_TJMG;
  process.env.PJE_TJMG = '0';
  try {
    const NUM_A = gerarCnj(9393939, '2026', '8', '13', '0024');
    const daqui10 = dataBrasilia(new Date(Date.now() + 10 * 86_400_000).toISOString());
    const r = await req('/api/processos', {
      metodo: 'POST',
      corpo: { numero: NUM_A, titulo: 'Caso audiência', orgao: '2ª Vara da Fazenda', audiencia_data: daqui10, audiencia_hora: '14:00', audiencia_descricao: 'Conciliação – sala 3', monitorar: false },
    });
    assert.equal(r.status, 201);
    const id = r.corpo.id;
    let l = await db.get('SELECT * FROM lembretes WHERE origem = ?', `audiencia|${id}`);
    assert.equal(l.tipo, 'audiencia');
    assert.equal(l.data_hora, new Date(`${daqui10}T14:00:00-03:00`).toISOString());
    assert.equal(l.antecedencia_min, 1440, 'padrão: avisa 1 dia antes');
    assert.match(l.descricao, /Conciliação – sala 3/);

    const painel = await req('/api/painel');
    assert.ok(painel.corpo.audiencias.some((a) => a.id === id));

    // Reagendar: atualiza o mesmo lembrete e volta a avisar; muda a antecedência.
    await db.run('UPDATE lembretes SET notificado_em = ? WHERE id = ?', new Date().toISOString(), l.id);
    await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { audiencia_hora: '15:30', audiencia_antecedencia_min: 120 } });
    const l2 = await db.get('SELECT * FROM lembretes WHERE origem = ?', `audiencia|${id}`);
    assert.equal(l2.id, l.id);
    assert.equal(l2.data_hora, new Date(`${daqui10}T15:30:00-03:00`).toISOString());
    assert.equal(l2.antecedencia_min, 120);
    assert.equal(l2.notificado_em, null);

    // Editar outro campo não mexe na audiência.
    await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { titulo: 'Caso audiência (editado)' } });
    assert.equal((await db.get('SELECT audiencia_data FROM processos WHERE id = ?', id)).audiencia_data, daqui10);

    assert.equal((await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { audiencia_hora: '25:99' } })).status, 400);
    assert.equal((await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { audiencia_antecedencia_min: 7 } })).status, 400);

    // Apagar a data remove o aviso.
    await req(`/api/processos/${id}`, { metodo: 'PUT', corpo: { audiencia_data: null, audiencia_hora: null } });
    assert.equal(await db.get('SELECT 1 FROM lembretes WHERE origem = ?', `audiencia|${id}`), undefined);
    await req(`/api/processos/${id}`, { metodo: 'DELETE' });
  } finally {
    if (antigo === undefined) delete process.env.PJE_TJMG; else process.env.PJE_TJMG = antigo;
  }
});

test('datas e horas impossíveis são recusadas com mensagem (não derrubam o servidor)', async () => {
  const antigo = process.env.PJE_TJMG;
  process.env.PJE_TJMG = '0';
  try {
    const proc = (await req('/api/processos', { metodo: 'POST', corpo: { numero: gerarCnj(9494949, '2026', '8', '13', '0024'), monitorar: false } })).corpo;
    for (const corpo of [{ audiencia_data: '2026-02-31' }, { audiencia_hora: '24:00' }, { cumprimento_prazo: '2026-13-01' }]) {
      const r = await req(`/api/processos/${proc.id}`, { metodo: 'PUT', corpo });
      assert.equal(r.status, 400, JSON.stringify(corpo));
    }
    assert.equal((await req(`/api/processos/${proc.id}/providencias`, { metodo: 'POST', corpo: { data: '2026-04-31', descricao: 'x' } })).status, 400);
    assert.equal((await req(`/api/processos/${proc.id}/providencias`, { metodo: 'POST', corpo: { data: '2026-04-30', hora: '12:61', descricao: 'x' } })).status, 400);
    assert.equal((await req('/api/prazos/calcular', { metodo: 'POST', corpo: { data: '2026-99-99', quantidade: 5 } })).status, 400);
    await req(`/api/processos/${proc.id}`, { metodo: 'DELETE' });
  } finally {
    if (antigo === undefined) delete process.env.PJE_TJMG; else process.env.PJE_TJMG = antigo;
  }
});

test('anotações gerais: criar, buscar, etiquetas, fixar, validar e passar a acompanhar', async () => {
  const NUM_N = gerarCnj(9595959, '2025', '8', '13', '0024');
  const a1 = await req('/api/anotacoes', {
    metodo: 'POST',
    corpo: { titulo: 'Cobrança – Fornecedor X', numero_processo: formatarCnj(NUM_N), sei: '2270.01.0011111/2025-10', etiquetas: 'FHEMIG, licitação, FHEMIG', texto: 'Acordo homologado; aguardar pagamento.' },
  });
  assert.equal(a1.status, 201);
  assert.equal(a1.corpo.numero_processo, NUM_N);
  assert.equal(a1.corpo.etiquetas, 'FHEMIG, licitação', 'remove etiquetas repetidas');
  const a2 = await req('/api/anotacoes', { metodo: 'POST', corpo: { titulo: 'Contato do setor jurídico', texto: 'Ramal 1234', etiquetas: 'contatos' } });
  assert.equal(a2.status, 201);

  assert.equal((await req('/api/anotacoes', { metodo: 'POST', corpo: { titulo: '' } })).status, 400);
  assert.equal((await req('/api/anotacoes', { metodo: 'POST', corpo: { titulo: 'x', numero_processo: '123' } })).status, 400);

  const busca = async (qs) => (await req(`/api/anotacoes?${qs}`)).corpo.map((n) => n.id);
  assert.deepEqual(await busca('q=pagamento'), [a1.corpo.id]);
  assert.deepEqual(await busca('q=0011111'), [a1.corpo.id], 'busca pelo SEI');
  assert.deepEqual(await busca(`q=${NUM_N.slice(0, 7)}`), [a1.corpo.id], 'busca pelo número do processo');
  assert.deepEqual(await busca('etiqueta=licitação'), [a1.corpo.id]);
  assert.deepEqual(await busca('etiqueta=contatos'), [a2.corpo.id]);

  // Fixar sobe para o topo.
  await req(`/api/anotacoes/${a2.corpo.id}`, { metodo: 'PUT', corpo: { fixada: true } });
  assert.equal((await req('/api/anotacoes')).corpo[0].id, a2.corpo.id);

  // Sem número, não dá para acompanhar.
  assert.equal((await req(`/api/anotacoes/${a2.corpo.id}/acompanhar`, { metodo: 'POST' })).status, 400);

  // Passar a acompanhar: vira processo monitorado e sai das anotações.
  djen.porProcesso[NUM_N] = [];
  const antigo = process.env.PJE_TJMG;
  process.env.PJE_TJMG = '0';
  try {
    const proc = await req(`/api/anotacoes/${a1.corpo.id}/acompanhar`, { metodo: 'POST' });
    assert.equal(proc.status, 201);
    assert.equal(proc.corpo.numero, NUM_N);
    assert.equal(proc.corpo.monitorar, 1);
    assert.equal(proc.corpo.sei, '2270.01.0011111/2025-10');
    assert.match(proc.corpo.observacoes, /aguardar pagamento/);
    assert.match(proc.corpo.observacoes, /Etiquetas: FHEMIG, licitação/);
    assert.equal((await req(`/api/anotacoes/${a1.corpo.id}`, { metodo: 'DELETE' })).status, 404, 'a anotação saiu da lista');
    await new Promise((r) => setTimeout(r, 100));
    await req(`/api/processos/${proc.corpo.id}`, { metodo: 'DELETE' });
  } finally {
    if (antigo === undefined) delete process.env.PJE_TJMG; else process.env.PJE_TJMG = antigo;
  }
  assert.equal((await req(`/api/anotacoes/${a2.corpo.id}`, { metodo: 'DELETE' })).status, 200);
});

test('anotações: tipos de ação / assunto (subdivisão, filtro, renomear, juntar e remover)', async () => {
  const criar = (titulo, categoria) => req('/api/anotacoes', { metodo: 'POST', corpo: { titulo, categoria } });
  const ms1 = (await criar('MS 1', '  mandado  de segurança ')).corpo;
  assert.equal(ms1.categoria, 'Mandado de segurança', 'espaços limpos e 1ª letra maiúscula');
  await criar('MS 2', 'Mandado de segurança');
  await criar('Lic 1', 'Licitações');
  await criar('Lic 2', 'licitação');
  await criar('Solta', '');

  let cats = (await req('/api/anotacoes-categorias')).corpo;
  assert.deepEqual(cats.categorias.map((x) => [x.nome, x.total]), [['Licitação', 1], ['Licitações', 1], ['Mandado de segurança', 2]]);
  assert.equal(cats.semCategoria, 1);
  assert.equal(cats.total, 5);

  const titulos = async (qs) => (await req(`/api/anotacoes?${qs}`)).corpo.map((n) => n.titulo).sort();
  assert.deepEqual(await titulos('categoria=mandado de segurança'), ['MS 1', 'MS 2'], 'filtro sem diferenciar maiúsculas');
  assert.deepEqual(await titulos('categoria=__sem'), ['Solta']);

  // Juntar "Licitação" em "Licitações".
  const r = await req('/api/anotacoes-categorias/renomear', { metodo: 'POST', corpo: { de: 'Licitação', para: 'Licitações' } });
  assert.equal(r.corpo.alteradas, 1);
  assert.deepEqual(await titulos('categoria=Licitações'), ['Lic 1', 'Lic 2']);

  // Remover um tipo: anotações vão para "sem tipo".
  await req('/api/anotacoes-categorias/renomear', { metodo: 'POST', corpo: { de: 'Mandado de segurança', para: '' } });
  cats = (await req('/api/anotacoes-categorias')).corpo;
  assert.deepEqual(cats.categorias.map((x) => x.nome), ['Licitações']);
  assert.equal(cats.semCategoria, 3);

  for (const n of (await req('/api/anotacoes')).corpo) await req(`/api/anotacoes/${n.id}`, { metodo: 'DELETE' });
});
