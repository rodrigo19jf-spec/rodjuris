import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, setConfig, agoraIso } from './db.js';
import { cnjValido, siglaTribunal, somenteDigitos } from './cnj.js';
import { buscarProcessoDataJud, testarConexoes } from './fontes.js';
import { buscarProcessoPjeTjmg, ehTjmg } from './pje_tjmg.js';
import { buscarProcessoEproc, eprocDisponivel, testarEproc } from './eproc_mni.js';
import { textoClasse } from './classes_cnj.js';
import { SITUACOES_CUMPRIMENTO, calcularPrazo, sincronizarCumprimento } from './cumprimento.js';
import { dataBrasilia } from './prazos.js';
import { chavesVapid, configEmail, enviarEmail, enviarPush } from './notificador.js';
import { executarCiclo, verificarAvisosEproc, verificarProcesso, verificarTudo } from './monitor.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'jurify_sessao';
const SESSAO_DIAS = 30;
const SERVERLESS = !!process.env.VERCEL;
// Na Vercel cada execução dura no máximo 60 s: o monitoramento para antes disso
// e continua na próxima chamada.
const PRAZO_MS = SERVERLESS ? 25_000 : Infinity; // o cron-job.org grátis espera no máximo 30 s

// ───────────── senha / sessão ─────────────
function hashSenha(senha, sal = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(senha, sal, 64).toString('hex');
  return `${sal}:${h}`;
}
function conferirSenha(senha, armazenado) {
  if (!armazenado) return false;
  const [sal, h] = armazenado.split(':');
  const calc = crypto.scryptSync(senha, sal, 64);
  const ref = Buffer.from(h, 'hex');
  return ref.length === calc.length && crypto.timingSafeEqual(ref, calc);
}
function lerCookie(req, nome) {
  const c = req.headers.cookie || '';
  for (const parte of c.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}
function iguaisSeguro(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ───────────── validação ─────────────
const TIPOS_LEMBRETE = ['lembrete', 'prazo', 'audiencia', 'reuniao', 'outro'];
const STATUS_PROC = ['ativo', 'suspenso', 'encerrado'];
const LIMINAR = ['deferida', 'indeferida', 'nao_analisada', 'nao_requerida'];

function texto(v, max = 5000) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function erro(res, status, mensagem) {
  return res.status(status).json({ erro: mensagem });
}
function isoValido(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** Converte o :id da URL em inteiro positivo (ou null). */
function idNum(v) {
  return /^\d{1,9}$/.test(String(v)) ? Number(v) : null;
}
/** Express 4 não captura erros de funções assíncronas: este invólucro repassa para o tratador de erros. */
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Mantém uma tarefa rodando depois da resposta (na Vercel, usa waitUntil). */
async function emSegundoPlano(promessa) {
  const p = promessa.catch((e) => console.error('[segundo plano]', e));
  if (SERVERLESS) {
    try {
      const { waitUntil } = await import('@vercel/functions');
      waitUntil(p);
    } catch {
      /* fora da Vercel: a promessa segue normalmente */
    }
  }
}

/**
 * Cria o app Express.
 * @param {object|() => Promise<object>} banco o banco já aberto, ou uma função que o abre (Vercel: conexão sob demanda)
 */
export function criarApp(banco, { fetchFn = fetch } = {}) {
  const obterDb = typeof banco === 'function' ? banco : async () => banco;
  const obterDbManutencao = obterDb;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/saude', (req, res) => res.json({ ok: true }));

  // Abre (ou reaproveita) a conexão com o banco para as rotas da API.
  app.use(
    '/api',
    a(async (req, res, next) => {
      req.db = await obterDb();
      next();
    }),
  );

  // ───────────── agendador (cron-job.org / Vercel Cron) ─────────────
  // Protegido pela variável CRON_SECRET: aceita "Authorization: Bearer <segredo>" ou "?chave=<segredo>".
  app.all(
    '/api/cron',
    a(async (req, res) => {
      const segredo = process.env.CRON_SECRET;
      if (!segredo) return erro(res, 503, 'Defina a variável CRON_SECRET para ativar o agendador.');
      const enviado = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.chave || '');
      if (!iguaisSeguro(enviado, segredo)) return erro(res, 401, 'Chave do agendador inválida.');
      const r = await executarCiclo(req.db, { fetchFn, prazoMs: PRAZO_MS });
      res.json(r);
    }),
  );

  // ───────────── manutenção do banco (protegida pelo CRON_SECRET) ─────────────
  // /api/manutencao?chave=...            → mostra sessões e travas no banco
  // /api/manutencao?chave=...&liberar=1  → encerra sessões presas e configura tempo-limite para o futuro
  app.get(
    '/api/manutencao',
    a(async (req, res) => {
      const segredo = process.env.CRON_SECRET;
      if (!segredo) return erro(res, 503, 'Defina a variável CRON_SECRET.');
      if (!iguaisSeguro(String(req.query.chave || ''), segredo)) return erro(res, 401, 'Chave inválida.');
      const db = await obterDbManutencao();
      const sessoes = await db.all(
        `SELECT pid, usename AS usuario, state AS estado, wait_event_type AS espera_tipo, wait_event AS espera,
                to_char(now() - xact_start, 'HH24:MI:SS') AS transacao_ha,
                to_char(now() - query_start, 'HH24:MI:SS') AS consulta_ha,
                pg_blocking_pids(pid) AS bloqueada_por,
                left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS consulta
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
         ORDER BY xact_start NULLS LAST`,
      );
      const resultado = { sessoes };
      if (req.query.liberar === '1') {
        const presas = await db.all(
          `SELECT pid, pg_terminate_backend(pid) AS encerrada
           FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
             AND (state IN ('idle in transaction', 'idle in transaction (aborted)')
                  OR (state = 'active' AND now() - query_start > interval '30 seconds')
                  OR pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity))`,
        );
        resultado.encerradas = presas;
        resultado.ajustes = [];
        for (const cmd of [
          "ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '60s'",
          "ALTER ROLE CURRENT_USER SET statement_timeout = '45s'",
        ]) {
          try {
            await db.run(cmd);
            resultado.ajustes.push({ cmd, ok: true });
          } catch (e) {
            resultado.ajustes.push({ cmd, ok: false, erro: e.message });
          }
        }
      }
      res.json(resultado);
    }),
  );

  // ───────────── autenticação ─────────────
  const tentativas = new Map(); // ip -> { n, ate }
  async function sessaoValida(req) {
    const token = lerCookie(req, COOKIE);
    if (!token) return false;
    const s = await req.db.get('SELECT expira_em FROM sessoes WHERE token = ?', token);
    return !!s && s.expira_em > agoraIso();
  }
  async function criarSessao(req, res) {
    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + SESSAO_DIAS * 86_400_000).toISOString();
    await req.db.run('DELETE FROM sessoes WHERE expira_em < ?', agoraIso());
    await req.db.run('INSERT INTO sessoes (token, expira_em) VALUES (?, ?)', token, expira);
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSAO_DIAS * 86_400_000,
      path: '/',
    });
  }

  app.get(
    '/api/auth/estado',
    a(async (req, res) => {
      res.json({ configurado: !!(await getConfig(req.db, 'senha_hash')), autenticado: await sessaoValida(req) });
    }),
  );

  app.post(
    '/api/auth/configurar',
    a(async (req, res) => {
      if (await getConfig(req.db, 'senha_hash')) return erro(res, 409, 'Senha já configurada.');
      const senha = String(req.body?.senha || '');
      if (senha.length < 8) return erro(res, 400, 'A senha precisa ter pelo menos 8 caracteres.');
      await setConfig(req.db, 'senha_hash', hashSenha(senha));
      await criarSessao(req, res);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/auth/entrar',
    a(async (req, res) => {
      const ip = req.ip;
      const t = tentativas.get(ip);
      if (t && t.n >= 5 && t.ate > Date.now()) return erro(res, 429, 'Muitas tentativas. Aguarde alguns minutos.');
      if (!conferirSenha(String(req.body?.senha || ''), await getConfig(req.db, 'senha_hash'))) {
        const n = t && t.ate > Date.now() ? t.n + 1 : 1;
        tentativas.set(ip, { n, ate: Date.now() + 10 * 60_000 });
        return erro(res, 401, 'Senha incorreta.');
      }
      tentativas.delete(ip);
      await criarSessao(req, res);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/auth/sair',
    a(async (req, res) => {
      const token = lerCookie(req, COOKIE);
      if (token) await req.db.run('DELETE FROM sessoes WHERE token = ?', token);
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    }),
  );

  app.use(
    '/api',
    a(async (req, res, next) => ((await sessaoValida(req)) ? next() : erro(res, 401, 'Não autenticado.'))),
  );

  app.post(
    '/api/auth/trocar-senha',
    a(async (req, res) => {
      const { atual, nova } = req.body || {};
      if (!conferirSenha(String(atual || ''), await getConfig(req.db, 'senha_hash'))) return erro(res, 400, 'Senha atual incorreta.');
      if (String(nova || '').length < 8) return erro(res, 400, 'A nova senha precisa ter pelo menos 8 caracteres.');
      await setConfig(req.db, 'senha_hash', hashSenha(String(nova)));
      await req.db.run('DELETE FROM sessoes');
      await criarSessao(req, res);
      res.json({ ok: true });
    }),
  );

  // ───────────── painel ─────────────
  app.get(
    '/api/painel',
    a(async (req, res) => {
      const db = req.db;
      const agora = agoraIso();
      const em7 = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const [ativos, monitorados, pubNaoLidas, andNaoLidos, atrasados, proximos, publicacoes, ultima, avisosEproc, liminares] = await Promise.all([
        db.valor("SELECT COUNT(*)::int FROM processos WHERE status = 'ativo'"),
        db.valor("SELECT COUNT(*)::int FROM processos WHERE monitorar = 1 AND status <> 'encerrado'"),
        db.valor('SELECT COUNT(*)::int FROM publicacoes WHERE lida = 0'),
        db.valor('SELECT COUNT(*)::int FROM andamentos WHERE lida = 0'),
        db.valor('SELECT COUNT(*)::int FROM lembretes WHERE concluido = 0 AND data_hora < ?', agora),
        db.all(
          `SELECT l.*, p.numero AS processo_numero FROM lembretes l LEFT JOIN processos p ON p.id = l.processo_id
           WHERE l.concluido = 0 AND l.data_hora <= ? ORDER BY l.data_hora LIMIT 15`,
          em7,
        ),
        db.all(
          `SELECT pu.id, pu.processo_id, pu.numero_processo, pu.data_disponibilizacao, pu.tribunal, pu.tipo,
                  substr(pu.texto, 1, 300) AS texto, p.titulo AS processo_titulo
           FROM publicacoes pu LEFT JOIN processos p ON p.id = pu.processo_id
           WHERE pu.lida = 0 ORDER BY pu.data_disponibilizacao DESC, pu.id DESC LIMIT 10`,
        ),
        getConfig(db, 'ultima_verificacao_geral'),
        db.all(
          `SELECT a.*, p.id AS processo_id, p.titulo AS processo_titulo
           FROM avisos_eproc a LEFT JOIN processos p ON p.numero = a.numero_processo
           ORDER BY a.disponibilizado_em DESC NULLS LAST LIMIT 30`,
        ),
        db.all(
          `SELECT id, numero, titulo, cliente, cumprimento_situacao, cumprimento_prazo, cumprimento_responsavel, cumprimento_multa,
                  (SELECT MAX(pr.data) FROM providencias pr WHERE pr.processo_id = processos.id) AS ultima_providencia
           FROM processos
           WHERE liminar = 'deferida' AND cumprimento_situacao IN ('pendente', 'andamento', 'parcial')
           ORDER BY cumprimento_prazo NULLS LAST, id`,
        ),
      ]);
      res.json({
        processosAtivos: ativos,
        processosMonitorados: monitorados,
        publicacoesNaoLidas: pubNaoLidas,
        andamentosNaoLidos: andNaoLidos,
        lembretesAtrasados: atrasados,
        proximos,
        publicacoes,
        ultimaVerificacao: ultima,
        avisosEproc,
        liminares,
      });
    }),
  );

  // ───────────── processos ─────────────
  function dadosProcesso(body, parcial = false) {
    const out = {};
    if (!parcial || body.numero !== undefined) {
      const numero = somenteDigitos(body.numero);
      if (numero.length !== 20) throw new Error('Número do processo deve ter 20 dígitos (padrão CNJ).');
      if (!cnjValido(numero)) throw new Error('Número do processo inválido (dígito verificador não confere).');
      out.numero = numero;
    }
    for (const k of ['titulo', 'cliente', 'parte_contraria', 'tribunal', 'orgao', 'classe', 'assunto', 'observacoes']) {
      if (!parcial || body[k] !== undefined) out[k] = texto(body[k]);
    }
    if (!parcial || body.status !== undefined) {
      out.status = STATUS_PROC.includes(body.status) ? body.status : 'ativo';
    }
    if (!parcial || body.monitorar !== undefined) out.monitorar = body.monitorar === false || body.monitorar === 0 ? 0 : 1;
    if (!parcial || body.liminar !== undefined) {
      if (body.liminar && !LIMINAR.includes(body.liminar)) throw new Error('Situação da liminar inválida.');
      out.liminar = body.liminar || null;
    }
    if (!parcial || body.cumprimento_situacao !== undefined) {
      if (body.cumprimento_situacao && !SITUACOES_CUMPRIMENTO.includes(body.cumprimento_situacao)) {
        throw new Error('Situação do cumprimento inválida.');
      }
      out.cumprimento_situacao = body.cumprimento_situacao || null;
    }
    for (const k of ['cumprimento_prazo', 'cumprimento_data']) {
      if (!parcial || body[k] !== undefined) {
        const v = body[k] ? String(body[k]).slice(0, 10) : null;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Data inválida no cumprimento da liminar.');
        out[k] = v;
      }
    }
    for (const k of ['cumprimento_responsavel', 'cumprimento_multa']) {
      if (!parcial || body[k] !== undefined) out[k] = texto(body[k], 300);
    }
    if (body.cumprimento_cobranca_dias !== undefined && body.cumprimento_cobranca_dias !== null && body.cumprimento_cobranca_dias !== '') {
      out.cumprimento_cobranca_dias = Math.max(1, Math.min(Number(body.cumprimento_cobranca_dias) || 3, 30));
    }
    if (out.numero && !out.tribunal && !parcial) out.tribunal = siglaTribunal(out.numero);
    return out;
  }

  /** Regras do cumprimento: liminar deferida começa "pendente"; ao marcar "cumprida", registra a data. */
  function ajustarCumprimento(d, atual = {}) {
    const final = { ...atual, ...d };
    if (final.liminar === 'deferida' && !final.cumprimento_situacao) d.cumprimento_situacao = 'pendente';
    if (final.cumprimento_situacao === 'cumprida' && !final.cumprimento_data) d.cumprimento_data = dataBrasilia(agoraIso());
    return d;
  }

  async function processoPorId(db, id) {
    const n = idNum(id);
    return n ? db.get('SELECT * FROM processos WHERE id = ?', n) : undefined;
  }

  app.get(
    '/api/processos',
    a(async (req, res) => {
      const where = [];
      const params = [];
      if (STATUS_PROC.includes(req.query.status)) {
        where.push('p.status = ?');
        params.push(req.query.status);
      }
      if (LIMINAR.includes(req.query.liminar)) {
        where.push('p.liminar = ?');
        params.push(req.query.liminar);
      } else if (req.query.liminar === 'sem_info') {
        where.push('p.liminar IS NULL');
      }
      if (req.query.cumprimento === 'pendente') {
        where.push("p.liminar = 'deferida' AND p.cumprimento_situacao IN ('pendente', 'andamento', 'parcial')");
      } else if (req.query.cumprimento === 'cumprida') {
        where.push("p.liminar = 'deferida' AND p.cumprimento_situacao = 'cumprida'");
      }
      if (req.query.q) {
        const q = `%${String(req.query.q).trim()}%`;
        const qd = somenteDigitos(req.query.q);
        where.push('(p.titulo ILIKE ? OR p.cliente ILIKE ? OR p.parte_contraria ILIKE ? OR p.numero LIKE ?)');
        params.push(q, q, q, qd ? `%${qd}%` : q);
      }
      const rows = await req.db.all(
        `SELECT * FROM (
           SELECT p.*,
             (SELECT COUNT(*)::int FROM publicacoes pu WHERE pu.processo_id = p.id AND pu.lida = 0) AS pub_nao_lidas,
             (SELECT COUNT(*)::int FROM andamentos an WHERE an.processo_id = p.id AND an.lida = 0) AS and_nao_lidos,
             (SELECT MIN(l.data_hora) FROM lembretes l WHERE l.processo_id = p.id AND l.concluido = 0) AS proximo_lembrete
           FROM processos p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ) t
         ORDER BY (pub_nao_lidas + and_nao_lidos) > 0 DESC, atualizado_em DESC`,
        ...params,
      );
      res.json(rows);
    }),
  );

  app.post(
    '/api/processos/consultar',
    a(async (req, res) => {
      const numero = somenteDigitos(req.body?.numero);
      if (numero.length !== 20 || !cnjValido(numero)) return erro(res, 400, 'Número do processo inválido.');
      // TJMG: tenta primeiro a Consulta Pública do PJe (rápida e direto do tribunal).
      if (ehTjmg(numero) && process.env.PJE_TJMG !== '0') {
        try {
          const pje = await buscarProcessoPjeTjmg(numero, { fetchFn });
          if (pje) return res.json({ ...pje, fonte: 'PJe TJMG', movimentos: pje.movimentos.slice(0, 5) });
        } catch (err) {
          console.warn('[pje-tjmg]', err.message);
        }
      }
      if (eprocDisponivel(numero)) {
        try {
          const ep = await buscarProcessoEproc(numero, { fetchFn });
          if (ep) {
            const classe = await textoClasse(req.db, ep.classeCodigo, { fetchFn });
            return res.json({ ...ep, classe, fonte: 'eproc TJMG', movimentos: ep.movimentos.slice(0, 5) });
          }
        } catch (err) {
          console.warn('[eproc]', err.message);
        }
      }
      try {
        const dj = await buscarProcessoDataJud(numero, { fetchFn });
        if (!dj) return erro(res, 404, 'Processo não encontrado no DataJud (pode estar em segredo de justiça ou ainda não indexado).');
        res.json({ ...dj, fonte: 'DataJud', movimentos: dj.movimentos.slice(0, 5) });
      } catch (err) {
        erro(
          res,
          502,
          err.temporario
            ? 'O DataJud (CNJ) está instável no momento. Pode salvar o processo assim mesmo: tribunal, vara, classe e andamentos serão preenchidos automaticamente quando ele voltar.'
            : err.message,
        );
      }
    }),
  );

  app.get(
    '/api/processos/:id',
    a(async (req, res) => {
      const p = await processoPorId(req.db, req.params.id);
      if (!p) return erro(res, 404, 'Processo não encontrado.');
      [p.publicacoes, p.andamentos, p.lembretes, p.providencias] = await Promise.all([
        req.db.all('SELECT * FROM publicacoes WHERE processo_id = ? ORDER BY data_disponibilizacao DESC, id DESC LIMIT 200', p.id),
        req.db.all('SELECT * FROM andamentos WHERE processo_id = ? ORDER BY data DESC LIMIT 300', p.id),
        req.db.all('SELECT * FROM lembretes WHERE processo_id = ? ORDER BY concluido, data_hora', p.id),
        req.db.all('SELECT * FROM providencias WHERE processo_id = ? ORDER BY data DESC, id DESC', p.id),
      ]);
      res.json(p);
    }),
  );

  app.post(
    '/api/processos',
    a(async (req, res) => {
      let d;
      try {
        d = ajustarCumprimento(dadosProcesso(req.body || {}));
      } catch (e) {
        return erro(res, 400, e.message);
      }
      if (await req.db.get('SELECT 1 FROM processos WHERE numero = ?', d.numero)) {
        return erro(res, 409, 'Este processo já está cadastrado.');
      }
      const cols = Object.keys(d);
      const novo = await req.db.get(
        `INSERT INTO processos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *`,
        ...cols.map((c) => d[c]),
      );
      await sincronizarCumprimento(req.db, novo.id);
      res.status(201).json(novo);
      // Primeira verificação em segundo plano (cria a linha de base, sem avisos).
      if (novo.monitorar) emSegundoPlano(verificarProcesso(req.db, novo, { fetchFn }));
    }),
  );

  app.put(
    '/api/processos/:id',
    a(async (req, res) => {
      const atual = await processoPorId(req.db, req.params.id);
      if (!atual) return erro(res, 404, 'Processo não encontrado.');
      let d;
      try {
        d = ajustarCumprimento(dadosProcesso(req.body || {}, true), atual);
      } catch (e) {
        return erro(res, 400, e.message);
      }
      if (d.numero && d.numero !== atual.numero) {
        if (await req.db.get('SELECT 1 FROM processos WHERE numero = ? AND id <> ?', d.numero, atual.id)) {
          return erro(res, 409, 'Outro processo já usa este número.');
        }
        d.ultima_verificacao = null; // novo número → nova linha de base
      }
      const cols = Object.keys(d);
      if (cols.length) {
        await req.db.run(
          `UPDATE processos SET ${cols.map((c) => `${c} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`,
          ...cols.map((c) => d[c]),
          agoraIso(),
          atual.id,
        );
      }
      await sincronizarCumprimento(req.db, atual.id);
      res.json(await req.db.get('SELECT * FROM processos WHERE id = ?', atual.id));
    }),
  );

  // ───────────── providências (histórico do cumprimento) ─────────────
  app.post(
    '/api/processos/:id/providencias',
    a(async (req, res) => {
      const p = await processoPorId(req.db, req.params.id);
      if (!p) return erro(res, 404, 'Processo não encontrado.');
      const data = String(req.body?.data || dataBrasilia(agoraIso())).slice(0, 10);
      const descricao = texto(req.body?.descricao, 2000);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return erro(res, 400, 'Data inválida.');
      if (!descricao) return erro(res, 400, 'Descreva a providência.');
      const nova = await req.db.get(
        'INSERT INTO providencias (processo_id, data, descricao) VALUES (?, ?, ?) RETURNING *',
        p.id,
        data,
        descricao,
      );
      res.status(201).json(nova);
    }),
  );

  app.delete(
    '/api/providencias/:id',
    a(async (req, res) => {
      const id = idNum(req.params.id);
      const r = id ? await req.db.run('DELETE FROM providencias WHERE id = ?', id) : { rowCount: 0 };
      if (!r.rowCount) return erro(res, 404, 'Providência não encontrada.');
      res.json({ ok: true });
    }),
  );

  // Calculadora de prazo (sugestão para preencher a data-limite).
  app.post(
    '/api/prazos/calcular',
    a(async (req, res) => {
      try {
        res.json(calcularPrazo(req.body || {}));
      } catch (e) {
        erro(res, 400, e.message);
      }
    }),
  );

  app.delete(
    '/api/processos/:id',
    a(async (req, res) => {
      const id = idNum(req.params.id);
      const r = id ? await req.db.run('DELETE FROM processos WHERE id = ?', id) : { rowCount: 0 };
      if (!r.rowCount) return erro(res, 404, 'Processo não encontrado.');
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/processos/:id/verificar',
    a(async (req, res) => {
      const p = await processoPorId(req.db, req.params.id);
      if (!p) return erro(res, 404, 'Processo não encontrado.');
      res.json(await verificarProcesso(req.db, p, { fetchFn }));
    }),
  );

  app.post(
    '/api/processos/:id/marcar-lido',
    a(async (req, res) => {
      const id = idNum(req.params.id);
      if (id) {
        await req.db.run('UPDATE publicacoes SET lida = 1 WHERE processo_id = ?', id);
        await req.db.run('UPDATE andamentos SET lida = 1 WHERE processo_id = ?', id);
      }
      res.json({ ok: true });
    }),
  );

  // ───────────── publicações ─────────────
  app.get(
    '/api/publicacoes',
    a(async (req, res) => {
      const where = [];
      const params = [];
      if (req.query.lida === '0' || req.query.lida === '1') {
        where.push('pu.lida = ?');
        params.push(Number(req.query.lida));
      }
      if (idNum(req.query.processo_id)) {
        where.push('pu.processo_id = ?');
        params.push(idNum(req.query.processo_id));
      }
      if (req.query.q) {
        const q = `%${String(req.query.q).trim()}%`;
        where.push('(pu.texto ILIKE ? OR pu.numero_processo LIKE ? OR pu.orgao ILIKE ?)');
        params.push(q, `%${somenteDigitos(req.query.q) || '#'}%`, q);
      }
      const limite = Math.min(Number(req.query.limite) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const rows = await req.db.all(
        `SELECT pu.*, p.titulo AS processo_titulo, p.cliente AS processo_cliente
         FROM publicacoes pu LEFT JOIN processos p ON p.id = pu.processo_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY pu.data_disponibilizacao DESC, pu.id DESC LIMIT ? OFFSET ?`,
        ...params,
        limite + 1,
        offset,
      );
      res.json({ itens: rows.slice(0, limite), temMais: rows.length > limite });
    }),
  );

  app.put(
    '/api/publicacoes/:id/lida',
    a(async (req, res) => {
      const id = idNum(req.params.id);
      if (id) await req.db.run('UPDATE publicacoes SET lida = ? WHERE id = ?', req.body?.lida === false ? 0 : 1, id);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/publicacoes/marcar-todas',
    a(async (req, res) => {
      await req.db.run('UPDATE publicacoes SET lida = 1 WHERE lida = 0');
      res.json({ ok: true });
    }),
  );

  // ───────────── lembretes / agenda ─────────────
  async function dadosLembrete(db, body) {
    const titulo = texto(body.titulo, 300);
    if (!titulo) throw new Error('Informe o título.');
    const data = isoValido(body.data_hora);
    if (!data) throw new Error('Data/hora inválida.');
    const processoId = body.processo_id ? idNum(body.processo_id) : null;
    if (body.processo_id && (!processoId || !(await db.get('SELECT 1 FROM processos WHERE id = ?', processoId)))) {
      throw new Error('Processo vinculado não existe.');
    }
    return {
      titulo,
      descricao: texto(body.descricao),
      tipo: TIPOS_LEMBRETE.includes(body.tipo) ? body.tipo : 'lembrete',
      data_hora: data,
      antecedencia_min: Math.max(0, Math.min(Number(body.antecedencia_min ?? 60) || 0, 60 * 24 * 30)),
      processo_id: processoId,
      concluido: body.concluido ? 1 : 0,
      sugerido: body.sugerido === true || body.sugerido === 1 ? 1 : 0,
    };
  }

  app.get(
    '/api/lembretes',
    a(async (req, res) => {
      const where = [];
      const params = [];
      if (req.query.de) {
        where.push('l.data_hora >= ?');
        params.push(isoValido(req.query.de) || '');
      }
      if (req.query.ate) {
        where.push('l.data_hora < ?');
        params.push(isoValido(req.query.ate) || '9999');
      }
      if (req.query.concluido === '0' || req.query.concluido === '1') {
        where.push('l.concluido = ?');
        params.push(Number(req.query.concluido));
      }
      res.json(
        await req.db.all(
          `SELECT l.*, p.numero AS processo_numero, p.titulo AS processo_titulo
           FROM lembretes l LEFT JOIN processos p ON p.id = l.processo_id
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY l.data_hora LIMIT 1000`,
          ...params,
        ),
      );
    }),
  );

  app.post(
    '/api/lembretes',
    a(async (req, res) => {
      let d;
      try {
        d = await dadosLembrete(req.db, req.body || {});
      } catch (e) {
        return erro(res, 400, e.message);
      }
      const cols = Object.keys(d);
      const novo = await req.db.get(
        `INSERT INTO lembretes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING *`,
        ...cols.map((c) => d[c]),
      );
      res.status(201).json(novo);
    }),
  );

  app.put(
    '/api/lembretes/:id',
    a(async (req, res) => {
      const id = idNum(req.params.id);
      const atual = id ? await req.db.get('SELECT * FROM lembretes WHERE id = ?', id) : undefined;
      if (!atual) return erro(res, 404, 'Lembrete não encontrado.');
      let d;
      try {
        d = await dadosLembrete(req.db, { ...atual, ...req.body });
      } catch (e) {
        return erro(res, 400, e.message);
      }
      // Mudou a data ou a antecedência → volta a avisar.
      const reagendar = d.data_hora !== atual.data_hora || d.antecedencia_min !== atual.antecedencia_min;
      const cols = Object.keys(d);
      await req.db.run(
        `UPDATE lembretes SET ${cols.map((c) => `${c} = ?`).join(', ')}${reagendar ? ', notificado_em = NULL' : ''} WHERE id = ?`,
        ...cols.map((c) => d[c]),
        atual.id,
      );
      res.json(await req.db.get('SELECT * FROM lembretes WHERE id = ?', atual.id));
    }),
  );

  app.delete(
    '/api/lembretes/:id',
    a(async (req, res) => {
      const id = idNum(req.params.id);
      const r = id ? await req.db.run('DELETE FROM lembretes WHERE id = ?', id) : { rowCount: 0 };
      if (!r.rowCount) return erro(res, 404, 'Lembrete não encontrado.');
      res.json({ ok: true });
    }),
  );

  // ───────────── avisos (sininho) ─────────────
  app.get(
    '/api/notificacoes',
    a(async (req, res) => {
      const [naoLidas, itens] = await Promise.all([
        req.db.valor('SELECT COUNT(*)::int FROM notificacoes WHERE lida = 0'),
        req.db.all('SELECT * FROM notificacoes ORDER BY id DESC LIMIT 50'),
      ]);
      res.json({ naoLidas, itens });
    }),
  );
  app.post(
    '/api/notificacoes/marcar-lidas',
    a(async (req, res) => {
      await req.db.run('UPDATE notificacoes SET lida = 1 WHERE lida = 0');
      res.json({ ok: true });
    }),
  );

  // ───────────── configurações ─────────────
  const CHAVES_CONFIG = [
    'oab_numero', 'oab_uf', 'intervalo_horas', 'email_ativo', 'email_destino',
    'smtp_host', 'smtp_port', 'smtp_seguro', 'smtp_usuario', 'smtp_remetente',
  ];
  app.get(
    '/api/config',
    a(async (req, res) => {
      const out = {};
      for (const k of CHAVES_CONFIG) out[k] = await getConfig(req.db, k, '');
      out.intervalo_horas ||= '4';
      out.smtp_senha_definida = !!(await configEmail(req.db)).pass;
      out.email_via_env = !!process.env.SMTP_HOST;
      out.push_inscricoes = await req.db.valor('SELECT COUNT(*)::int FROM push_subscriptions');
      out.ultima_verificacao_geral = await getConfig(req.db, 'ultima_verificacao_geral');
      out.ultimo_ciclo = await getConfig(req.db, 'ultimo_ciclo');
      out.serverless = SERVERLESS;
      out.agendador_configurado = !!process.env.CRON_SECRET;
      out.eproc_configurado = !!(process.env.EPROC_USUARIO && process.env.EPROC_SENHA);
      res.json(out);
    }),
  );

  app.put(
    '/api/config',
    a(async (req, res) => {
      const b = req.body || {};
      for (const k of CHAVES_CONFIG) {
        if (b[k] === undefined) continue;
        let v = String(b[k] ?? '').trim().slice(0, 300);
        if (k === 'oab_numero') v = somenteDigitos(v);
        if (k === 'oab_uf') v = v.toUpperCase().slice(0, 2);
        if (k === 'intervalo_horas') v = String(Math.max(1, Math.min(Number(v) || 4, 24)));
        if (k === 'email_ativo' || k === 'smtp_seguro') v = v === '1' || v === 'true' ? '1' : '0';
        await setConfig(req.db, k, v);
      }
      if (typeof b.smtp_senha === 'string' && b.smtp_senha) await setConfig(req.db, 'smtp_senha', b.smtp_senha);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/config/testar-email',
    a(async (req, res) => {
      try {
        const r = await enviarEmail(req.db, 'Teste de e-mail', 'Se você recebeu esta mensagem, os avisos por e-mail estão funcionando. ✅', {
          forcar: true,
        });
        if (!r.enviado) return erro(res, 400, `E-mail não enviado: ${r.motivo}.`);
        res.json({ ok: true });
      } catch (e) {
        erro(res, 502, `Falha no envio: ${e.message}`);
      }
    }),
  );

  app.post(
    '/api/diagnostico',
    a(async (req, res) => {
      const numero = somenteDigitos(req.body?.numero);
      const [cnj, pje] = await Promise.all([
        testarConexoes(numero.length === 20 && cnjValido(numero) ? numero : undefined, { fetchFn }),
        (async () => {
          if (process.env.PJE_TJMG === '0') return null;
          try {
            // Processo público de exemplo do PJe do TJMG (só para testar a conexão).
            const r = await buscarProcessoPjeTjmg('50014287820248130251', { fetchFn });
            return { fonte: 'PJe TJMG (andamentos)', ok: true, mensagem: r ? `Conectado — ${r.movimentos.length} movimentação(ões) lidas no processo de teste.` : 'Conectado — processo de teste não encontrado.' };
          } catch (e) {
            return { fonte: 'PJe TJMG (andamentos)', ok: false, mensagem: e.message };
          }
        })(),
      ]);
      const eproc = process.env.EPROC_TJMG === '0' ? null : await testarEproc({ fetchFn });
      res.json([...cnj, ...(pje ? [pje] : []), ...(eproc ? [eproc] : [])]);
    }),
  );

  app.post(
    '/api/verificar-agora',
    a(async (req, res) => {
      const r = await verificarTudo(req.db, { fetchFn, prazoMs: PRAZO_MS, pausaMs: SERVERLESS ? 300 : 1500 });
      if (r.emAndamento) return erro(res, 409, 'Já existe uma verificação em andamento.');
      try {
        r.avisosEproc = (await verificarAvisosEproc(req.db, { fetchFn, forcar: true })).novos;
      } catch (e) {
        r.erros.push(`eproc (avisos): ${e.message}`);
      }
      res.json(r);
    }),
  );

  // ───────────── push ─────────────
  app.get(
    '/api/push/chave',
    a(async (req, res) => res.json({ publicKey: (await chavesVapid(req.db)).publicKey })),
  );
  app.post(
    '/api/push/inscrever',
    a(async (req, res) => {
      const sub = req.body;
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
        return erro(res, 400, 'Inscrição inválida.');
      }
      await req.db.run(
        'INSERT INTO push_subscriptions (endpoint, dados) VALUES (?, ?) ON CONFLICT (endpoint) DO UPDATE SET dados = excluded.dados',
        sub.endpoint,
        JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }),
      );
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/push/cancelar',
    a(async (req, res) => {
      await req.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', String(req.body?.endpoint || ''));
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/push/testar',
    a(async (req, res) => {
      res.json(await enviarPush(req.db, 'RodJuris — teste', 'As notificações no celular estão funcionando. ✅', '/#/'));
    }),
  );

  // ───────────── arquivos estáticos (PWA) ─────────────
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));
  app.use('/api', (req, res) => erro(res, 404, 'Rota não encontrada.'));
  app.use((err, req, res, _next) => {
    console.error(err);
    erro(res, 500, err?.publico ? err.message : 'Erro interno.');
  });

  return app;
}
