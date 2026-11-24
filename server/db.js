import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS processos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL,                -- somente dígitos (20)
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
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  atualizado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_processos_numero ON processos(numero);

CREATE TABLE IF NOT EXISTS publicacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (origem, external_id)
);
CREATE INDEX IF NOT EXISTS ix_publicacoes_data ON publicacoes(data_disponibilizacao DESC);
CREATE INDEX IF NOT EXISTS ix_publicacoes_processo ON publicacoes(processo_id);

CREATE TABLE IF NOT EXISTS andamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  processo_id INTEGER NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
  external_key TEXT NOT NULL,
  data TEXT,
  nome TEXT,
  complemento TEXT,
  lida INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (processo_id, external_key)
);
CREATE INDEX IF NOT EXISTS ix_andamentos_processo ON andamentos(processo_id, data DESC);

CREATE TABLE IF NOT EXISTS lembretes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  descricao TEXT,
  tipo TEXT NOT NULL DEFAULT 'lembrete' CHECK (tipo IN ('lembrete','prazo','audiencia','reuniao','outro')),
  data_hora TEXT NOT NULL,             -- ISO UTC
  antecedencia_min INTEGER NOT NULL DEFAULT 60,
  processo_id INTEGER REFERENCES processos(id) ON DELETE SET NULL,
  concluido INTEGER NOT NULL DEFAULT 0,
  notificado_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_lembretes_data ON lembretes(data_hora);

CREATE TABLE IF NOT EXISTS notificacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  mensagem TEXT,
  link TEXT,
  lida INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function getConfig(db, chave, padrao = null) {
  const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  return row ? row.valor : padrao;
}

export function setConfig(db, chave, valor) {
  db.prepare(
    'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
  ).run(chave, valor == null ? null : String(valor));
}

export function agoraIso() {
  return new Date().toISOString();
}
