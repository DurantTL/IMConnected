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

/** base64url(prNumber.expiryUnix).base64url(HMAC-SHA256(secret, prNumber.expiryUnix)) */
export function makeConfirmToken(prNumber: number, secret: string, nowMs = Date.now()): string {
  const payload = `${prNumber}.${Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS}`;
  return `${b64u(payload)}.${b64u(sign(secret, payload))}`;
}

export type TokenCheck = { ok: true; prNumber: number } | { ok: false; reason: 'invalid' | 'expired' };

export function verifyConfirmToken(token: string, secret: string, nowMs = Date.now()): TokenCheck {
  const parts = String(token).split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return { ok: false, reason: 'invalid' };
  const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
  const given = Buffer.from(parts[1], 'base64url');
  const expected = sign(secret, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
  const m = /^(\d{1,9})\.(\d{1,12})$/.exec(payload);
  if (!m) return { ok: false, reason: 'invalid' };
  if (Number(m[2]) * 1000 < nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, prNumber: Number(m[1]) };
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

/** Sends the confirmation email. Never throws; never logs the address. */
export async function sendConfirmationEmail(opts: { to: string; title: string; prNumber: number }, env = process.env): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'email sending is not configured' };
  if (!env.EMAIL_FROM) return { sent: false, reason: 'sender address is not configured' };
  const secret = confirmSecret(env);
  if (!secret) return { sent: false, reason: 'confirmation secret is not configured' };

  const site = (env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
  const url = `${site}/confirm/?t=${makeConfirmToken(opts.prNumber, secret)}`;
  const mail = buildConfirmEmail(opts.title, url);
  try {
    const res = await fetch(env.EMAIL_API_URL || RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [opts.to],
        reply_to: env.EMAIL_REPLY_TO || SITE.contactEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
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
