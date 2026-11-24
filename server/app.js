import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, setConfig, agoraIso } from './db.js';
import { cnjValido, siglaTribunal, somenteDigitos } from './cnj.js';
import { buscarProcessoDataJud, testarConexoes } from './fontes.js';
import { chavesVapid, configEmail, enviarEmail, enviarPush } from './notificador.js';
import { verificarProcesso, verificarTudo } from './monitor.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'jurify_sessao';
const SESSAO_DIAS = 30;

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

// ───────────── validação ─────────────
const TIPOS_LEMBRETE = ['lembrete', 'prazo', 'audiencia', 'reuniao', 'outro'];
const STATUS_PROC = ['ativo', 'suspenso', 'encerrado'];

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

export function criarApp(db, { fetchFn = fetch } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/api/saude', (req, res) => res.json({ ok: true }));

  // ───────────── autenticação ─────────────
  const tentativas = new Map(); // ip -> { n, ate }
  function sessaoValida(req) {
    const token = lerCookie(req, COOKIE);
    if (!token) return false;
    const s = db.prepare('SELECT expira_em FROM sessoes WHERE token = ?').get(token);
    return !!s && s.expira_em > agoraIso();
  }
  function criarSessao(req, res) {
    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + SESSAO_DIAS * 86_400_000).toISOString();
    db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(agoraIso());
    db.prepare('INSERT INTO sessoes (token, expira_em) VALUES (?, ?)').run(token, expira);
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSAO_DIAS * 86_400_000,
      path: '/',
    });
  }

  app.get('/api/auth/estado', (req, res) => {
    res.json({ configurado: !!getConfig(db, 'senha_hash'), autenticado: sessaoValida(req) });
  });

  app.post('/api/auth/configurar', (req, res) => {
    if (getConfig(db, 'senha_hash')) return erro(res, 409, 'Senha já configurada.');
    const senha = String(req.body?.senha || '');
    if (senha.length < 8) return erro(res, 400, 'A senha precisa ter pelo menos 8 caracteres.');
    setConfig(db, 'senha_hash', hashSenha(senha));
    criarSessao(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/entrar', (req, res) => {
    const ip = req.ip;
    const t = tentativas.get(ip);
    if (t && t.n >= 5 && t.ate > Date.now()) return erro(res, 429, 'Muitas tentativas. Aguarde alguns minutos.');
    if (!conferirSenha(String(req.body?.senha || ''), getConfig(db, 'senha_hash'))) {
      const n = t && t.ate > Date.now() ? t.n + 1 : 1;
      tentativas.set(ip, { n, ate: Date.now() + 10 * 60_000 });
      return erro(res, 401, 'Senha incorreta.');
    }
    tentativas.delete(ip);
    criarSessao(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/sair', (req, res) => {
    const token = lerCookie(req, COOKIE);
    if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.use('/api', (req, res, next) => (sessaoValida(req) ? next() : erro(res, 401, 'Não autenticado.')));

  app.post('/api/auth/trocar-senha', (req, res) => {
    const { atual, nova } = req.body || {};
    if (!conferirSenha(String(atual || ''), getConfig(db, 'senha_hash'))) return erro(res, 400, 'Senha atual incorreta.');
    if (String(nova || '').length < 8) return erro(res, 400, 'A nova senha precisa ter pelo menos 8 caracteres.');
    setConfig(db, 'senha_hash', hashSenha(String(nova)));
    db.prepare('DELETE FROM sessoes').run();
    criarSessao(req, res);
    res.json({ ok: true });
  });

  // ───────────── painel ─────────────
  app.get('/api/painel', (req, res) => {
    const agora = agoraIso();
    const em7 = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const um = (sql, ...p) => Object.values(db.prepare(sql).get(...p))[0];
    res.json({
      processosAtivos: um("SELECT COUNT(*) FROM processos WHERE status = 'ativo'"),
      processosMonitorados: um("SELECT COUNT(*) FROM processos WHERE monitorar = 1 AND status != 'encerrado'"),
      publicacoesNaoLidas: um('SELECT COUNT(*) FROM publicacoes WHERE lida = 0'),
      andamentosNaoLidos: um('SELECT COUNT(*) FROM andamentos WHERE lida = 0'),
      lembretesAtrasados: um('SELECT COUNT(*) FROM lembretes WHERE concluido = 0 AND data_hora < ?', agora),
      proximos: db
        .prepare(`SELECT l.*, p.numero AS processo_numero FROM lembretes l LEFT JOIN processos p ON p.id = l.processo_id
                  WHERE l.concluido = 0 AND l.data_hora <= ? ORDER BY l.data_hora LIMIT 15`)
        .all(em7),
      publicacoes: db
        .prepare(`SELECT pu.id, pu.processo_id, pu.numero_processo, pu.data_disponibilizacao, pu.tribunal, pu.tipo,
                         substr(pu.texto, 1, 300) AS texto, p.titulo AS processo_titulo
                  FROM publicacoes pu LEFT JOIN processos p ON p.id = pu.processo_id
                  WHERE pu.lida = 0 ORDER BY pu.data_disponibilizacao DESC, pu.id DESC LIMIT 10`)
        .all(),
      ultimaVerificacao: getConfig(db, 'ultima_verificacao_geral'),
    });
  });

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
    if (out.numero && !out.tribunal && !parcial) out.tribunal = siglaTribunal(out.numero);
    return out;
  }

  app.get('/api/processos', (req, res) => {
    const where = [];
    const params = [];
    if (STATUS_PROC.includes(req.query.status)) {
      where.push('p.status = ?');
      params.push(req.query.status);
    }
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      const qd = somenteDigitos(req.query.q);
      where.push('(p.titulo LIKE ? OR p.cliente LIKE ? OR p.parte_contraria LIKE ? OR p.numero LIKE ?)');
      params.push(q, q, q, qd ? `%${qd}%` : q);
    }
    const rows = db
      .prepare(`
        SELECT p.*,
          (SELECT COUNT(*) FROM publicacoes pu WHERE pu.processo_id = p.id AND pu.lida = 0) AS pub_nao_lidas,
          (SELECT COUNT(*) FROM andamentos a WHERE a.processo_id = p.id AND a.lida = 0) AS and_nao_lidos,
          (SELECT MIN(l.data_hora) FROM lembretes l WHERE l.processo_id = p.id AND l.concluido = 0) AS proximo_lembrete
        FROM processos p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY (pub_nao_lidas + and_nao_lidos) > 0 DESC, p.atualizado_em DESC`)
      .all(...params);
    res.json(rows);
  });

  app.post('/api/processos/consultar', async (req, res) => {
    const numero = somenteDigitos(req.body?.numero);
    if (numero.length !== 20 || !cnjValido(numero)) return erro(res, 400, 'Número do processo inválido.');
    try {
      const dj = await buscarProcessoDataJud(numero, { fetchFn });
      if (!dj) return erro(res, 404, 'Processo não encontrado no DataJud (pode estar em segredo de justiça ou ainda não indexado).');
      res.json({ ...dj, movimentos: dj.movimentos.slice(0, 5) });
    } catch (err) {
      erro(res, 502, err.message);
    }
  });

  app.get('/api/processos/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM processos WHERE id = ?').get(req.params.id);
    if (!p) return erro(res, 404, 'Processo não encontrado.');
    p.publicacoes = db
      .prepare('SELECT * FROM publicacoes WHERE processo_id = ? ORDER BY data_disponibilizacao DESC, id DESC LIMIT 200')
      .all(p.id);
    p.andamentos = db.prepare('SELECT * FROM andamentos WHERE processo_id = ? ORDER BY data DESC LIMIT 300').all(p.id);
    p.lembretes = db.prepare('SELECT * FROM lembretes WHERE processo_id = ? ORDER BY concluido, data_hora').all(p.id);
    res.json(p);
  });

  app.post('/api/processos', async (req, res) => {
    let d;
    try {
      d = dadosProcesso(req.body || {});
    } catch (e) {
      return erro(res, 400, e.message);
    }
    if (db.prepare('SELECT 1 FROM processos WHERE numero = ?').get(d.numero)) {
      return erro(res, 409, 'Este processo já está cadastrado.');
    }
    const cols = Object.keys(d);
    const r = db
      .prepare(`INSERT INTO processos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map((c) => d[c]));
    const id = Number(r.lastInsertRowid);
    const novo = db.prepare('SELECT * FROM processos WHERE id = ?').get(id);
    res.status(201).json(novo);
    // Primeira verificação em segundo plano (cria a linha de base, sem avisos).
    if (novo.monitorar) verificarProcesso(db, novo, { fetchFn }).catch((e) => console.error('[monitor]', e));
  });

  app.put('/api/processos/:id', (req, res) => {
    const atual = db.prepare('SELECT * FROM processos WHERE id = ?').get(req.params.id);
    if (!atual) return erro(res, 404, 'Processo não encontrado.');
    let d;
    try {
      d = dadosProcesso(req.body || {}, true);
    } catch (e) {
      return erro(res, 400, e.message);
    }
    if (d.numero && d.numero !== atual.numero) {
      if (db.prepare('SELECT 1 FROM processos WHERE numero = ? AND id != ?').get(d.numero, atual.id)) {
        return erro(res, 409, 'Outro processo já usa este número.');
      }
      d.ultima_verificacao = null; // novo número → nova linha de base
    }
    const cols = Object.keys(d);
    if (cols.length) {
      db.prepare(`UPDATE processos SET ${cols.map((c) => `${c} = ?`).join(', ')}, atualizado_em = ? WHERE id = ?`).run(
        ...cols.map((c) => d[c]),
        agoraIso(),
        atual.id,
      );
    }
    res.json(db.prepare('SELECT * FROM processos WHERE id = ?').get(atual.id));
  });

  app.delete('/api/processos/:id', (req, res) => {
    const r = db.prepare('DELETE FROM processos WHERE id = ?').run(req.params.id);
    if (!r.changes) return erro(res, 404, 'Processo não encontrado.');
    res.json({ ok: true });
  });

  app.post('/api/processos/:id/verificar', async (req, res) => {
    const p = db.prepare('SELECT * FROM processos WHERE id = ?').get(req.params.id);
    if (!p) return erro(res, 404, 'Processo não encontrado.');
    const r = await verificarProcesso(db, p, { fetchFn });
    res.json(r);
  });

  app.post('/api/processos/:id/marcar-lido', (req, res) => {
    db.prepare('UPDATE publicacoes SET lida = 1 WHERE processo_id = ?').run(req.params.id);
    db.prepare('UPDATE andamentos SET lida = 1 WHERE processo_id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ───────────── publicações ─────────────
  app.get('/api/publicacoes', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.lida === '0' || req.query.lida === '1') {
      where.push('pu.lida = ?');
      params.push(Number(req.query.lida));
    }
    if (req.query.processo_id) {
      where.push('pu.processo_id = ?');
      params.push(req.query.processo_id);
    }
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      where.push('(pu.texto LIKE ? OR pu.numero_processo LIKE ? OR pu.orgao LIKE ?)');
      params.push(q, `%${somenteDigitos(req.query.q) || '#'}%`, q);
    }
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = db
      .prepare(`SELECT pu.*, p.titulo AS processo_titulo, p.cliente AS processo_cliente
                FROM publicacoes pu LEFT JOIN processos p ON p.id = pu.processo_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY pu.data_disponibilizacao DESC, pu.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limite + 1, offset);
    res.json({ itens: rows.slice(0, limite), temMais: rows.length > limite });
  });

  app.put('/api/publicacoes/:id/lida', (req, res) => {
    db.prepare('UPDATE publicacoes SET lida = ? WHERE id = ?').run(req.body?.lida === false ? 0 : 1, req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/publicacoes/marcar-todas', (req, res) => {
    db.prepare('UPDATE publicacoes SET lida = 1 WHERE lida = 0').run();
    res.json({ ok: true });
  });

  // ───────────── lembretes / agenda ─────────────
  function dadosLembrete(body) {
    const titulo = texto(body.titulo, 300);
    if (!titulo) throw new Error('Informe o título.');
    const data = isoValido(body.data_hora);
    if (!data) throw new Error('Data/hora inválida.');
    const processoId = body.processo_id ? Number(body.processo_id) : null;
    if (processoId && !db.prepare('SELECT 1 FROM processos WHERE id = ?').get(processoId)) {
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
    };
  }

  app.get('/api/lembretes', (req, res) => {
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
      db
        .prepare(`SELECT l.*, p.numero AS processo_numero, p.titulo AS processo_titulo
                  FROM lembretes l LEFT JOIN processos p ON p.id = l.processo_id
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY l.data_hora LIMIT 1000`)
        .all(...params),
    );
  });

  app.post('/api/lembretes', (req, res) => {
    let d;
    try {
      d = dadosLembrete(req.body || {});
    } catch (e) {
      return erro(res, 400, e.message);
    }
    const cols = Object.keys(d);
    const r = db
      .prepare(`INSERT INTO lembretes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map((c) => d[c]));
    res.status(201).json(db.prepare('SELECT * FROM lembretes WHERE id = ?').get(Number(r.lastInsertRowid)));
  });

  app.put('/api/lembretes/:id', (req, res) => {
    const atual = db.prepare('SELECT * FROM lembretes WHERE id = ?').get(req.params.id);
    if (!atual) return erro(res, 404, 'Lembrete não encontrado.');
    let d;
    try {
      d = dadosLembrete({ ...atual, ...req.body });
    } catch (e) {
      return erro(res, 400, e.message);
    }
    // Mudou a data ou a antecedência → volta a avisar.
    const reagendar = d.data_hora !== atual.data_hora || d.antecedencia_min !== atual.antecedencia_min;
    const cols = Object.keys(d);
    db.prepare(
      `UPDATE lembretes SET ${cols.map((c) => `${c} = ?`).join(', ')}${reagendar ? ', notificado_em = NULL' : ''} WHERE id = ?`,
    ).run(...cols.map((c) => d[c]), atual.id);
    res.json(db.prepare('SELECT * FROM lembretes WHERE id = ?').get(atual.id));
  });

  app.delete('/api/lembretes/:id', (req, res) => {
    const r = db.prepare('DELETE FROM lembretes WHERE id = ?').run(req.params.id);
    if (!r.changes) return erro(res, 404, 'Lembrete não encontrado.');
    res.json({ ok: true });
  });

  // ───────────── avisos (sininho) ─────────────
  app.get('/api/notificacoes', (req, res) => {
    res.json({
      naoLidas: Object.values(db.prepare('SELECT COUNT(*) FROM notificacoes WHERE lida = 0').get())[0],
      itens: db.prepare('SELECT * FROM notificacoes ORDER BY id DESC LIMIT 50').all(),
    });
  });
  app.post('/api/notificacoes/marcar-lidas', (req, res) => {
    db.prepare('UPDATE notificacoes SET lida = 1 WHERE lida = 0').run();
    res.json({ ok: true });
  });

  // ───────────── configurações ─────────────
  const CHAVES_CONFIG = [
    'oab_numero', 'oab_uf', 'intervalo_horas', 'email_ativo', 'email_destino',
    'smtp_host', 'smtp_port', 'smtp_seguro', 'smtp_usuario', 'smtp_remetente',
  ];
  app.get('/api/config', (req, res) => {
    const out = {};
    for (const k of CHAVES_CONFIG) out[k] = getConfig(db, k, '');
    out.intervalo_horas ||= '4';
    out.smtp_senha_definida = !!configEmail(db).pass;
    out.email_via_env = !!process.env.SMTP_HOST;
    out.push_inscricoes = Object.values(db.prepare('SELECT COUNT(*) FROM push_subscriptions').get())[0];
    out.ultima_verificacao_geral = getConfig(db, 'ultima_verificacao_geral');
    res.json(out);
  });

  app.put('/api/config', (req, res) => {
    const b = req.body || {};
    for (const k of CHAVES_CONFIG) {
      if (b[k] === undefined) continue;
      let v = String(b[k] ?? '').trim().slice(0, 300);
      if (k === 'oab_numero') v = somenteDigitos(v);
      if (k === 'oab_uf') v = v.toUpperCase().slice(0, 2);
      if (k === 'intervalo_horas') v = String(Math.max(1, Math.min(Number(v) || 4, 24)));
      if (k === 'email_ativo' || k === 'smtp_seguro') v = v === '1' || v === 'true' ? '1' : '0';
      setConfig(db, k, v);
    }
    if (typeof b.smtp_senha === 'string' && b.smtp_senha) setConfig(db, 'smtp_senha', b.smtp_senha);
    res.json({ ok: true });
  });

  app.post('/api/config/testar-email', async (req, res) => {
    try {
      const r = await enviarEmail(db, 'Teste de e-mail', 'Se você recebeu esta mensagem, os avisos por e-mail estão funcionando. ✅', {
        forcar: true,
      });
      if (!r.enviado) return erro(res, 400, `E-mail não enviado: ${r.motivo}.`);
      res.json({ ok: true });
    } catch (e) {
      erro(res, 502, `Falha no envio: ${e.message}`);
    }
  });

  app.post('/api/diagnostico', async (req, res) => {
    const numero = somenteDigitos(req.body?.numero);
    res.json(await testarConexoes(numero.length === 20 && cnjValido(numero) ? numero : undefined, { fetchFn }));
  });

  app.post('/api/verificar-agora', async (req, res) => {
    const r = await verificarTudo(db, { fetchFn });
    if (r.emAndamento) return erro(res, 409, 'Já existe uma verificação em andamento.');
    res.json(r);
  });

  // ───────────── push ─────────────
  app.get('/api/push/chave', (req, res) => res.json({ publicKey: chavesVapid(db).publicKey }));
  app.post('/api/push/inscrever', (req, res) => {
    const sub = req.body;
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
      return erro(res, 400, 'Inscrição inválida.');
    }
    db.prepare(
      'INSERT INTO push_subscriptions (endpoint, dados) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET dados = excluded.dados',
    ).run(sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }));
    res.json({ ok: true });
  });
  app.post('/api/push/cancelar', (req, res) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(req.body?.endpoint || ''));
    res.json({ ok: true });
  });
  app.post('/api/push/testar', async (req, res) => {
    const r = await enviarPush(db, 'RodJuris — teste', 'As notificações no celular estão funcionando. ✅', '/#/');
    res.json(r);
  });

  // ───────────── arquivos estáticos (PWA) ─────────────
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));
  app.use('/api', (req, res) => erro(res, 404, 'Rota não encontrada.'));
  app.use((err, req, res, _next) => {
    console.error(err);
    erro(res, 500, 'Erro interno.');
  });

  return app;
}

