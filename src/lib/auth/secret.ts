import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** AUTH_SECRET must be set and at least 32 characters, or /admin refuses to run. */
export function authSecretOk(): boolean {
  return (process.env.AUTH_SECRET || '').length >= 32;
}

function subkey(purpose: string): Buffer {
  const secret = process.env.AUTH_SECRET || '';
  if (secret.length < 32) throw new Error('AUTH_SECRET is missing or shorter than 32 characters.');
  return Buffer.from(hkdfSync('sha256', secret, 'imconnected', purpose, 32));
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', subkey('totp-secret v1'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable stored secret.');
  const d = createDecipheriv('aes-256-gcm', subkey('totp-secret v1'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/**
 * Signed tokens for short-lived cookies the server must be able to trust (the Google / Microsoft flow cookie). Format:
 * `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`, the MAC over the payload part, keyed by an HKDF subkey of AUTH_SECRET named
 * by `purpose` (so a token for one purpose never verifies for another). verifyToken() compares MACs in constant time, on equal-length
 * buffers, BEFORE parsing the JSON; anything unsigned, altered or signed with another key or purpose is null.
 */
export function signToken(purpose: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', subkey(purpose)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(purpose: string, token: string): Record<string, unknown> | null {
  const dot = token.indexOf('.');
  if (dot < 1 || token.indexOf('.', dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return null; // one canonical spelling of a SHA-256 MAC: 43 base64url characters
  // Compare the base64url TEXT of the expected MAC (equal lengths), so a non-canonical spelling of the same bytes can't verify.
  const expected = Buffer.from(createHmac('sha256', subkey(purpose)).update(body).digest('base64url'));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Keyed hash for high-entropy random values (recovery codes). */
export function keyedHash(value: string): string {
  return createHmac('sha256', subkey('recovery-code v1')).update(value).digest('hex');
}
