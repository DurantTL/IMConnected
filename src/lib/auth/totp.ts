import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
import { getDb } from '../db';
import { decryptSecret, encryptSecret } from './secret';

const PERIOD = 30;
const ISSUER = 'IMConnected';

function totp(secretBase32: string, email: string): TOTP {
  return new TOTP({ issuer: ISSUER, label: email, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: Secret.fromBase32(secretBase32) });
}

interface Row {
  secret_enc: string;
  confirmed_at: number | null;
  last_used_step: number;
}
const row = (userId: number) =>
  getDb().prepare('SELECT secret_enc, confirmed_at, last_used_step FROM totp_credentials WHERE user_id = ?').get(userId) as Row | undefined;

export const hasConfirmedTotp = (userId: number): boolean => row(userId)?.confirmed_at != null;

/** The in-progress enrollment's secret (created on first call, reused on reload). Null if already confirmed. */
export function pendingTotpSecret(userId: number): string | null {
  const r = row(userId);
  if (r?.confirmed_at != null) return null;
  if (r) return decryptSecret(r.secret_enc);
  const secret = new Secret({ size: 20 }).base32;
  getDb()
    .prepare('INSERT OR IGNORE INTO totp_credentials (user_id, secret_enc, created_at) VALUES (?, ?, ?)')
    .run(userId, encryptSecret(secret), Date.now());
  return decryptSecret(row(userId)!.secret_enc);
}

/** QR code for the authenticator app, as an inline SVG string (no external request). */
export async function totpQrSvg(secretBase32: string, email: string): Promise<string> {
  return QRCode.toString(totp(secretBase32, email).toString(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

/**
 * Check a 6-digit code (window +-1 step) and burn its time step. A step at or before last_used_step is
 * refused, and the UPDATE is conditional so two parallel requests can't both use the same step.
 * With confirm=true this also marks the enrollment confirmed.
 */
export function verifyTotp(userId: number, email: string, code: string, opts: { confirm?: boolean } = {}): boolean {
  const r = row(userId);
  if (!r || (opts.confirm ? r.confirmed_at != null : r.confirmed_at == null)) return false;
  if (!/^\d{6}$/.test(code)) return false;
  const t = totp(decryptSecret(r.secret_enc), email);
  const now = Date.now();
  const delta = t.validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(now / 1000 / PERIOD) + delta;
  const res = getDb()
    .prepare(
      'UPDATE totp_credentials SET last_used_step = ?, confirmed_at = CASE WHEN confirmed_at IS NULL THEN ? ELSE confirmed_at END WHERE user_id = ? AND last_used_step < ?',
    )
    .run(step, now, userId, step);
  return Number(res.changes) === 1;
}
