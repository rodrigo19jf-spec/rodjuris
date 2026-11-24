import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setConfig } from '../server/db.js';
import { criarApp } from '../server/app.js';
import { aliasDataJud, cnjValido, formatarCnj } from '../server/cnj.js';
import { verificarLembretes, verificarTudo } from '../server/monitor.js';
import { definirEnvioPush, definirTransporteEmail } from '../server/notificador.js';

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
  db = openDb(':memory:');
  definirTransporteEmail({ sendMail: async (m) => emails.push(m) });
  definirEnvioPush(async (sub, payload) => pushes.push(JSON.parse(payload)));
  const app = criarApp(db, { fetchFn: fetchFalso });
  await new Promise((r) => (servidor = app.listen(0, r)));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor?.close());

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
  setConfig(db, 'email_ativo', '1');
  setConfig(db, 'email_destino', 'advogado@example.com');
  db.prepare("INSERT INTO push_subscriptions (endpoint, dados) VALUES ('https://push.example/1', '{}')").run();

  // Aguarda a verificação em segundo plano disparada pelo cadastro.
  for (let i = 0; i < 50 && !db.prepare('SELECT ultima_verificacao FROM processos').get().ultima_verificacao; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const proc = db.prepare('SELECT * FROM processos').get();
  assert.ok(proc.ultima_verificacao, 'linha de base criada');
  assert.equal(proc.classe, 'Procedimento Comum Cível', 'dados do DataJud preenchidos');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publicacoes WHERE lida = 0').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM andamentos').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notificacoes').get().n, 0);

  // Nova publicação e novo andamento.
  djen.porProcesso[NUM].push(pub(2, NUM, 'Intime-se o autor para manifestação em 15 dias.'));
  datajud[NUM].movimentos.push({ codigo: 11010, nome: 'Mero expediente', dataHora: '2026-11-20T12:00:00.000Z' });

  const r = await verificarTudo(db, { fetchFn: fetchFalso, pausaMs: 0 });
  assert.equal(r.publicacoes, 1);
  assert.equal(r.andamentos, 1);
  assert.deepEqual(r.erros, []);

  const avisos = db.prepare('SELECT * FROM notificacoes ORDER BY id').all();
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
  setConfig(db, 'oab_numero', '123456');
  setConfig(db, 'oab_uf', 'SP');
  djen.porOab = [pub(10, NUM_OUTRO, 'Antiga')];
  await verificarTudo(db, { fetchFn: fetchFalso, pausaMs: 0 }); // linha de base da OAB
  const antes = db.prepare('SELECT COUNT(*) n FROM notificacoes').get().n;

  djen.porOab.push(pub(11, NUM_OUTRO, 'Processo não cadastrado — nova intimação'));
  djen.porOab.push(pub(2, NUM, 'Intime-se o autor para manifestação em 15 dias.')); // já existe
  const r = await verificarTudo(db, { fetchFn: fetchFalso, pausaMs: 0 });
  assert.equal(r.publicacoes, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notificacoes').get().n, antes + 1);
  const lista = await req('/api/publicacoes?lida=0');
  assert.equal(lista.corpo.itens.length, 1);
  assert.equal(lista.corpo.itens[0].processo_id, null);
});

test('lembretes: CRUD e disparo na antecedência configurada', async () => {
  const proc = db.prepare('SELECT id FROM processos').get();
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
  assert.ok(r.erros.some((e) => /DJEN: HTTP 503/.test(e)));
  assert.match(db.prepare('SELECT erro_verificacao FROM processos WHERE numero = ?').get(NUM).erro_verificacao, /DJEN/);
  assert.ok(chamadas.some((c) => c.includes('api_publica_tjsp/_search')));
});
