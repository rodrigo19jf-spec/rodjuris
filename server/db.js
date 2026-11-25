// Camada de banco de dados (PostgreSQL).
//
// - Com DATABASE_URL (ou POSTGRES_URL) definida: conecta a um Postgres de verdade
//   (Supabase, Neon, Postgres próprio...). É o modo usado na Vercel.
// - Sem ela: usa o PGlite, um Postgres embutido que grava em arquivo (./dados/pg).
//   É o modo usado no computador local ou numa VPS, sem precisar instalar nada.
//
// Todas as funções são assíncronas e usam "?" como marcador de parâmetro.

import fs from 'node:fs';

const AGORA_SQL = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processos (
  id SERIAL PRIMARY KEY,
  numero TEXT NOT NULL UNIQUE,
  titulo TEXT,
  cliente TEXT,
  parte_contraria TEXT,
  tribunal TEXT,
  orgao TEXT,
  classe TEXT,
  assunto TEXT,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','suspenso','encerrado')),
  observacoes TEXT,
  monitorar INTEGER NOT NULL DEFAULT 1,
  ultima_verificacao TEXT,
  erro_verificacao TEXT,
  datajud_em TEXT,                         -- última consulta bem-sucedida ao DataJud
  datajud_pendente INTEGER NOT NULL DEFAULT 0, -- 1 = DataJud falhou, tentar de novo
  datajud_tentativa TEXT,                  -- última tentativa no DataJud
  pje_situacao TEXT,                       -- PJe TJMG: null (não verificado), 'ativo', 'ausente', 'migrado'
  pje_em TEXT,                             -- primeira leitura bem-sucedida no PJe (linha de base)
  pje_verificado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT ${AGORA_SQL},
  atualizado_em TEXT NOT NULL DEFAULT ${AGORA_SQL}
);

CREATE TABLE IF NOT EXISTS publicacoes (
  id SERIAL PRIMARY KEY,
  processo_id INTEGER REFERENCES processos(id) ON DELETE SET NULL,
  origem TEXT NOT NULL DEFAULT 'djen',
  external_id TEXT NOT NULL,
  numero_processo TEXT,
  data_disponibilizacao TEXT,
  tribunal TEXT,
  orgao TEXT,
  tipo TEXT,
  texto TEXT,
  link TEXT,
  lida INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT ${AGORA_SQL},
  UNIQUE (origem, external_id)
);
CREATE INDEX IF NOT EXISTS ix_publicacoes_data ON publicacoes(data_disponibilizacao DESC);
CREATE INDEX IF NOT EXISTS ix_publicacoes_processo ON publicacoes(processo_id);

CREATE TABLE IF NOT EXISTS andamentos (
  id SERIAL PRIMARY KEY,
  processo_id INTEGER NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
  external_key TEXT NOT NULL,
  data TEXT,
  nome TEXT,
  complemento TEXT,
  fonte TEXT,                              -- 'datajud' ou 'pje'
  lida INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT ${AGORA_SQL},
  UNIQUE (processo_id, external_key)
);
CREATE INDEX IF NOT EXISTS ix_andamentos_processo ON andamentos(processo_id, data DESC);

CREATE TABLE IF NOT EXISTS lembretes (
  id SERIAL PRIMARY KEY,
  titulo TEXT NOT NULL,
  descricao TEXT,
  tipo TEXT NOT NULL DEFAULT 'lembrete' CHECK (tipo IN ('lembrete','prazo','audiencia','reuniao','outro')),
  data_hora TEXT NOT NULL,
  antecedencia_min INTEGER NOT NULL DEFAULT 60,
  processo_id INTEGER REFERENCES processos(id) ON DELETE SET NULL,
  concluido INTEGER NOT NULL DEFAULT 0,
  notificado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT ${AGORA_SQL}
);
CREATE INDEX IF NOT EXISTS ix_lembretes_data ON lembretes(data_hora);

CREATE TABLE IF NOT EXISTS notificacoes (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  mensagem TEXT,
  link TEXT,
  lida INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT ${AGORA_SQL}
);

CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  expira_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  dados TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT ${AGORA_SQL}
);
`;

// Migrações para bancos criados por versões anteriores (cada item roda uma única vez).
const MIGRACOES = [
  `ALTER TABLE processos ADD COLUMN IF NOT EXISTS datajud_em TEXT;
   ALTER TABLE processos ADD COLUMN IF NOT EXISTS datajud_pendente INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE processos ADD COLUMN IF NOT EXISTS datajud_tentativa TEXT;
   UPDATE processos SET datajud_em = ultima_verificacao
     WHERE datajud_em IS NULL AND EXISTS (SELECT 1 FROM andamentos an WHERE an.processo_id = processos.id);`,
  `ALTER TABLE processos ADD COLUMN IF NOT EXISTS pje_situacao TEXT;
   ALTER TABLE processos ADD COLUMN IF NOT EXISTS pje_em TEXT;
   ALTER TABLE processos ADD COLUMN IF NOT EXISTS pje_verificado_em TEXT;
   ALTER TABLE andamentos ADD COLUMN IF NOT EXISTS fonte TEXT;
   UPDATE andamentos SET fonte = 'datajud' WHERE fonte IS NULL;`,
];

/** Cria as tabelas (se preciso) e aplica as migrações pendentes. `exec` roda SQL sem parâmetros. */
async function prepararEsquema(exec, consultar, tabelasExistem) {
  if (!tabelasExistem) {
    await exec(SCHEMA);
    await exec(`INSERT INTO config (chave, valor) VALUES ('schema_versao', '${MIGRACOES.length}') ON CONFLICT (chave) DO NOTHING`);
    return;
  }
  const linhas = await consultar("SELECT valor FROM config WHERE chave = 'schema_versao'");
  const versao = Number(linhas[0]?.valor || 0);
  for (let i = versao; i < MIGRACOES.length; i++) {
    await exec(MIGRACOES[i]);
    await exec(
      `INSERT INTO config (chave, valor) VALUES ('schema_versao', '${i + 1}') ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor`,
    );
  }
}

/** Troca os marcadores "?" por $1, $2... (o SQL do app não usa "?" dentro de textos). */
function converter(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function normalizarParametros(params) {
  return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

function criarApi(executar, fechar) {
  const api = {
    /** Executa e devolve { rows, rowCount }. */
    run: (sql, ...params) => executar(converter(sql), normalizarParametros(params)),
    /** Devolve todas as linhas. */
    all: async (sql, ...params) => (await api.run(sql, ...params)).rows,
    /** Devolve a primeira linha (ou undefined). */
    get: async (sql, ...params) => (await api.run(sql, ...params)).rows[0],
    /** Devolve o primeiro valor da primeira linha. */
    valor: async (sql, ...params) => {
      const linha = await api.get(sql, ...params);
      return linha ? Object.values(linha)[0] : undefined;
    },
    close: fechar,
  };
  return api;
}

export function urlDoBanco(env = process.env) {
  if (env.DATABASE_URL || env.POSTGRES_URL) return env.DATABASE_URL || env.POSTGRES_URL;
  // Integrações da Vercel podem usar um prefixo (ex.: STORAGE_POSTGRES_URL).
  const chave = Object.keys(env).find((k) => /(^|_)(POSTGRES_URL|DATABASE_URL)$/.test(k) && env[k]);
  return chave ? env[chave] : '';
}

/** Remove parâmetros extras da URL (ex.: "supa=..." da integração Supabase), mantendo só o sslmode. */
export function limparUrl(url) {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (k !== 'sslmode') u.searchParams.delete(k);
  return u.toString();
}

async function abrirPostgres(urlOriginal) {
  const url = limparUrl(urlOriginal);
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, {
    prepare: false, // compatível com poolers (Supabase/Neon em modo transação)
    // Uma consulta por vez em cada conexão: o pooler do Supabase (modo transação)
    // pode travar quando várias consultas são enviadas em sequência na mesma conexão.
    max_pipeline: 1,
    max: Number(process.env.DB_MAX_CONEXOES || 5),
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
    ssl: /localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url) ? false : 'require',
  });
  // Cria as tabelas só na primeira vez (deixa as partidas a frio da Vercel mais rápidas).
  const [{ existe }] = await sql.unsafe("SELECT to_regclass('public.push_subscriptions') IS NOT NULL AS existe");
  await prepararEsquema((t) => sql.unsafe(t), async (t) => [...(await sql.unsafe(t))], existe);
  return criarApi(
    async (texto, params) => {
      const r = await sql.unsafe(texto, params);
      return { rows: [...r], rowCount: r.count ?? r.length };
    },
    () => sql.end({ timeout: 5 }),
  );
}

async function abrirPglite(pasta) {
  const { PGlite } = await import('@electric-sql/pglite');
  if (pasta && pasta !== ':memory:') fs.mkdirSync(pasta, { recursive: true });
  const pg = pasta && pasta !== ':memory:' ? new PGlite(pasta) : new PGlite();
  const { rows } = await pg.query("SELECT to_regclass('public.push_subscriptions') IS NOT NULL AS existe");
  await prepararEsquema((t) => pg.exec(t), async (t) => (await pg.query(t)).rows, rows[0].existe);
  // O PGlite atende uma consulta por vez: enfileira para evitar disputas.
  let fila = Promise.resolve();
  return criarApi(
    (texto, params) => {
      const p = fila.then(async () => {
        const r = await pg.query(texto, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      });
      fila = p.catch(() => {});
      return p;
    },
    () => pg.close(),
  );
}

/**
 * Abre o banco. `destino` pode ser uma URL postgres://..., ':memory:' (testes) ou uma pasta (PGlite).
 * Sem argumento: usa DATABASE_URL/POSTGRES_URL se houver; senão, PGlite em DB_DIR (padrão ./dados/pg).
 */
export async function openDb(destino) {
  if (destino === undefined && !urlDoBanco() && process.env.VERCEL) {
    const err = new Error('Banco de dados não configurado: conecte um banco Postgres ao projeto na Vercel (aba Storage).');
    err.publico = true;
    throw err;
  }
  const alvo = destino ?? (urlDoBanco() || process.env.DB_DIR || './dados/pg');
  if (/^postgres(ql)?:\/\//.test(alvo)) return abrirPostgres(alvo);
  return abrirPglite(alvo);
}

export async function getConfig(db, chave, padrao = null) {
  const row = await db.get('SELECT valor FROM config WHERE chave = ?', chave);
  return row ? row.valor : padrao;
}

export async function setConfig(db, chave, valor) {
  await db.run(
    'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor',
    chave,
    valor == null ? null : String(valor),
  );
}

export function agoraIso() {
  return new Date().toISOString();
}
