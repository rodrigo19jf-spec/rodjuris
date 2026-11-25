import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { getConfig, setConfig } from './db.js';

export const TZ = process.env.TZ_APP || 'America/Sao_Paulo';

export function formatarDataHora(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(iso));
}

/** Lê a configuração de SMTP (variáveis de ambiente têm prioridade sobre a tela de Configurações). */
export async function configEmail(db) {
  const linhas = await db.all("SELECT chave, valor FROM config WHERE chave LIKE 'smtp%' OR chave LIKE 'email%'");
  const cfg = Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));
  const c = (chave, env) => process.env[env] || cfg[chave] || '';
  return {
    ativo: (process.env.EMAIL_ATIVO ?? cfg.email_ativo ?? '0') === '1',
    destino: c('email_destino', 'EMAIL_DESTINO'),
    host: c('smtp_host', 'SMTP_HOST'),
    port: Number(c('smtp_port', 'SMTP_PORT') || 587),
    secure: (process.env.SMTP_SECURE ?? cfg.smtp_seguro ?? '0') === '1',
    user: c('smtp_usuario', 'SMTP_USER').trim(),
    // Senha de app do Gmail aparece como "abcd efgh ijkl mnop": os espaços não fazem parte dela.
    pass: /gmail|googlemail/i.test(c('smtp_host', 'SMTP_HOST')) ? c('smtp_senha', 'SMTP_PASS').replace(/\s+/g, '') : c('smtp_senha', 'SMTP_PASS'),
    from: c('smtp_remetente', 'SMTP_FROM'),
  };
}

let transporteTeste = null;
/** Permite aos testes trocar o transporte de e-mail. */
export function definirTransporteEmail(t) {
  transporteTeste = t;
}

export async function enviarEmail(db, assunto, texto, { forcar = false } = {}) {
  const cfg = await configEmail(db);
  if (!forcar && !cfg.ativo) return { enviado: false, motivo: 'desativado' };
  if (!cfg.destino || (!cfg.host && !transporteTeste)) return { enviado: false, motivo: 'SMTP ou destinatário não configurado' };
  const transporte =
    transporteTeste ||
    nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
  await transporte.sendMail({
    from: cfg.from || cfg.user,
    to: cfg.destino,
    subject: `[RodJuris] ${assunto}`,
    text: texto,
  });
  return { enviado: true };
}

/** Garante um par de chaves VAPID (gerado uma única vez e guardado no banco). */
export async function chavesVapid(db) {
  let pub = process.env.VAPID_PUBLIC_KEY || (await getConfig(db, 'vapid_publica'));
  let priv = process.env.VAPID_PRIVATE_KEY || (await getConfig(db, 'vapid_privada'));
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey;
    priv = k.privateKey;
    await setConfig(db, 'vapid_publica', pub);
    await setConfig(db, 'vapid_privada', priv);
  }
  return { publicKey: pub, privateKey: priv };
}

let enviarPushImpl = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);
export function definirEnvioPush(fn) {
  enviarPushImpl = fn;
}

export async function enviarPush(db, titulo, mensagem, link) {
  const subs = await db.all('SELECT endpoint, dados FROM push_subscriptions');
  if (subs.length === 0) return { enviados: 0 };
  const { publicKey, privateKey } = await chavesVapid(db);
  const vapidDetails = {
    subject: process.env.VAPID_SUBJECT || 'mailto:rodjuris@localhost',
    publicKey,
    privateKey,
  };
  const payload = JSON.stringify({ title: titulo, body: mensagem, url: link || '/' });
  let enviados = 0;
  for (const s of subs) {
    try {
      await enviarPushImpl(JSON.parse(s.dados), payload, { vapidDetails, TTL: 86400 });
      enviados++;
    } catch (err) {
      // 404/410: inscrição expirada (ex.: usuário revogou a permissão) — remove.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
      } else {
        console.error('[push] falha ao enviar:', err?.message || err);
      }
    }
  }
  return { enviados };
}

/**
 * Cria um aviso dentro do app e o replica por e-mail e push.
 * Falhas de e-mail/push são registradas no log mas não interrompem o fluxo.
 */
export async function notificar(db, { tipo, titulo, mensagem, link, emailTexto }) {
  await db.run(
    'INSERT INTO notificacoes (tipo, titulo, mensagem, link) VALUES (?, ?, ?, ?)',
    tipo,
    titulo,
    mensagem ?? null,
    link ?? null,
  );
  try {
    await enviarEmail(db, titulo, emailTexto || `${titulo}\n\n${mensagem || ''}`);
  } catch (err) {
    console.error('[email] falha ao enviar:', err?.message || err);
  }
  try {
    await enviarPush(db, titulo, (mensagem || '').slice(0, 180), link);
  } catch (err) {
    console.error('[push] falha:', err?.message || err);
  }
}
