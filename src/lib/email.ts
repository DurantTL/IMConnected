// Confirmation email (Resend HTTP API, no SDK) and the signed confirm token.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SITE } from './site';

const RESEND_URL = 'https://api.resend.com/emails';
const TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function confirmSecret(env = process.env): string | null {
  const s = env.EMAIL_CONFIRM_SECRET;
  return s && s.length >= 32 ? s : null;
}

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest();

/**
 * base64url(payload).base64url(HMAC-SHA256(secret, payload)). The payload is `d:<draft id>.<expiryUnix>` for
 * a dashboard submission, or the older `<pr number>.<expiryUnix>` that emails sent while submissions opened
 * pull requests still carry (kind 'pr'; they are only honoured when GitHub is configured).
 */
export function makeConfirmToken(id: number, secret: string, nowMs = Date.now(), kind: 'draft' | 'pr' = 'draft'): string {
  const payload = `${kind === 'draft' ? 'd:' : ''}${id}.${Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS}`;
  return `${b64u(payload)}.${b64u(sign(secret, payload))}`;
}

export type TokenCheck = { ok: true; kind: 'draft' | 'pr'; id: number } | { ok: false; reason: 'invalid' | 'expired' };

export function verifyConfirmToken(token: string, secret: string, nowMs = Date.now()): TokenCheck {
  const parts = String(token).split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return { ok: false, reason: 'invalid' };
  const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
  const given = Buffer.from(parts[1], 'base64url');
  const expected = sign(secret, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
  const m = /^(d:)?(\d{1,9})\.(\d{1,12})$/.exec(payload);
  if (!m) return { ok: false, reason: 'invalid' };
  if (Number(m[3]) * 1000 < nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, kind: m[1] ? 'draft' : 'pr', id: Number(m[2]) };
}

const escHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim();

export function buildConfirmEmail(title: string, confirmUrl: string) {
  const t = oneLine(title);
  const text = [
    `Thank you for sending "${t}" to ${SITE.name}.`,
    '',
    'Please confirm that this is your email address by opening the link below. Your story is already with our editors, and confirming simply helps us trust that we can reach you.',
    '',
    confirmUrl,
    '',
    `If you didn't send a story, you can ignore this message. Questions? Reply to this email or write to ${SITE.contactEmail}.`,
    '',
    `The ${SITE.name} team`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433;max-width:560px;margin:0 auto;padding:24px;line-height:1.5">
<p>Thank you for sending &ldquo;${escHtml(t)}&rdquo; to ${escHtml(SITE.name)}.</p>
<p>Please confirm that this is your email address. Your story is already with our editors, and confirming simply helps us trust that we can reach you.</p>
<p style="margin:28px 0"><a href="${escHtml(confirmUrl)}" style="background:#1f4e79;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;display:inline-block;font-weight:600">Confirm my story</a></p>
<p style="font-size:14px;color:#555">Or paste this link into your browser:<br>${escHtml(confirmUrl)}</p>
<p style="font-size:14px;color:#555">If you didn't send a story, you can ignore this message. Questions? Reply to this email or write to ${escHtml(SITE.contactEmail)}.</p>
<p>The ${escHtml(SITE.name)} team</p>
</body></html>`;
  return { subject: 'Please confirm your IMConnected story', text, html };
}

export type SendResult = { sent: true } | { sent: false; reason: string };

/** Posts one message through the Resend HTTP API. Never throws; never logs the address. */
export async function postEmail(msg: { to: string; subject: string; text: string; html: string }, env = process.env): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'email sending is not configured' };
  if (!env.EMAIL_FROM) return { sent: false, reason: 'sender address is not configured' };
  try {
    const res = await fetch(env.EMAIL_API_URL || RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [msg.to],
        reply_to: env.EMAIL_REPLY_TO || SITE.contactEmail,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
      signal: AbortSignal.timeout(8000),
    });
    await res.arrayBuffer().catch(() => {});
    if (!res.ok) return { sent: false, reason: `the email service answered ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error && err.name === 'TimeoutError' ? 'the email service timed out' : 'the email service could not be reached' };
  }
}

const BATCH_MAX = 100; // Resend's limit per batch request
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends one message per recipient through Resend's batch endpoint (POST <emails URL>/batch, a JSON array), 100 at a
 * time. A 429 is retried once after its retry-after (capped at 5 s). Never throws; never logs addresses.
 */
export async function postEmailBatch(msgs: { to: string; subject: string; text: string; html: string }[], env = process.env): Promise<{ sent: number; failed: number }> {
  if (!msgs.length) return { sent: 0, failed: 0 };
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: 0, failed: msgs.length };
  const url = (env.EMAIL_API_URL || RESEND_URL).replace(/\/+$/, '') + '/batch';
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < msgs.length; i += BATCH_MAX) {
    const chunk = msgs.slice(i, i + BATCH_MAX);
    const body = JSON.stringify(
      chunk.map((m) => ({ from: env.EMAIL_FROM, to: [m.to], reply_to: env.EMAIL_REPLY_TO || SITE.contactEmail, subject: m.subject, text: m.text, html: m.html })),
    );
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(8000),
        });
        await res.arrayBuffer().catch(() => {});
        if (res.ok) ok = true;
        else if (res.status === 429 && attempt === 0) {
          const wait = Number(res.headers.get('retry-after'));
          await sleepMs(Math.min(5000, Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000));
        } else break;
      } catch {
        break;
      }
    }
    if (ok) sent += chunk.length;
    else failed += chunk.length;
  }
  return { sent, failed };
}

/** Sends the confirmation email for a draft (kind 'pr': for the old pull-request path). Never throws; never logs the address. */
export async function sendConfirmationEmail(opts: { to: string; title: string; id: number; kind?: 'draft' | 'pr' }, env = process.env): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'email sending is not configured' };
  if (!env.EMAIL_FROM) return { sent: false, reason: 'sender address is not configured' };
  const secret = confirmSecret(env);
  if (!secret) return { sent: false, reason: 'confirmation secret is not configured' };

  const site = (env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
  const url = `${site}/confirm/?t=${makeConfirmToken(opts.id, secret, Date.now(), opts.kind ?? 'draft')}`;
  return postEmail({ to: opts.to, ...buildConfirmEmail(opts.title, url) }, env);
}

/** The "new story" email to an editor: only the title and church (escaped in the HTML), plus a link. */
export function buildSubmissionNotice(title: string, church: string, link: string) {
  const t = oneLine(title);
  const c = oneLine(church);
  const text = [`A new story was submitted to ${SITE.name}.`, '', `Title: ${t}`, ...(c ? [`Church: ${c}`] : []), '', `Open it in the dashboard: ${link}`, '', 'You get this email because "Email me when a story is submitted" is on in My account.'].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433;max-width:560px;margin:0 auto;padding:24px;line-height:1.5">
<p>A new story was submitted to ${escHtml(SITE.name)}.</p>
<p><strong>${escHtml(t)}</strong>${c ? `<br>${escHtml(c)}` : ''}</p>
<p style="margin:28px 0"><a href="${escHtml(link)}" style="background:#1f4e79;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;display:inline-block;font-weight:600">Open in the dashboard</a></p>
<p style="font-size:14px;color:#555">You get this email because &ldquo;Email me when a story is submitted&rdquo; is on in My account.</p>
</body></html>`;
  return { subject: `New story submission: ${t}`, text, html };
}
