import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

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

/** Keyed hash for high-entropy random values (recovery codes). */
export function keyedHash(value: string): string {
  return createHmac('sha256', subkey('recovery-code v1')).update(value).digest('hex');
}
