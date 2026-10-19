import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2; // scrypt needs 128*N*r bytes; node's default cap is exactly 32 MB

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256; // "no maximum below 256": longer is refused so hashing time stays bounded

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2) };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Returns scrypt$N$r$p$<salt>$<hash> (base64url), so parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  try {
    const got = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p), expected.length);
    return got.length === expected.length && timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// A fixed hash (of a throwaway string, same parameters as real ones) so the first unknown-email
// sign-in costs the same as every other.
const DUMMY_HASH = 'scrypt$32768$8$1$RgaHVDTdA7wRZT3tULJmdQ$sMEdv8rnY9QzKONfw1SyQm8CdIDUfrVBidGflPfQmKEaNrZoECXd3U_Xywtn34tnnKGyqUhWDxfHbyuiFmRJqg';
/** Do the same scrypt work for an address that has no usable password, so timing doesn't reveal it. */
export async function dummyVerify(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

const COMMON = new Set(
  [
    'password1234', 'password12345', 'password123456', 'passwordpassword', 'qwertyuiopas', 'qwerty123456',
    'qwertyuiop12', '123456789012', '1234567890123', '12345678910', '111111111111', '000000000000',
    'iloveyou1234', 'letmein12345', 'welcome12345', 'welcome1234567', 'administrator', 'adminadmin123',
    'changeme1234', 'changemenow1', 'abcdefghijkl', 'abc123abc123', 'trustno1trustno1', 'sunshine12345',
    'football1234', 'baseball1234', 'dragon123456', 'monkey123456', 'princess1234', 'master123456',
    'iowamissouri', 'imconnected', 'imconnected1', 'imconnected123', 'adventist1234', 'seventhdayadventist',
  ].map((s) => s.toLowerCase()),
);

/** Returns a message when the password is unacceptable, else null. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  const lower = password.toLowerCase();
  if (lower === email.toLowerCase()) return 'The password can’t be your email address.';
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return 'That password is too common. Choose something less guessable.';
  return null;
}
