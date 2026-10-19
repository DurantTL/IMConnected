import { randomBytes } from 'node:crypto';
import { getDb } from '../db';
import { keyedHash } from './secret';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export const RECOVERY_COUNT = 10;

/** Accepts "abcde-fghij", lowercase, spaces; returns the canonical form or null. */
export function normalizeRecovery(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-9]{10}$/.test(s) ? s : null;
}

function newCode(): string {
  // Rejection sampling: 248 = 8 * 31, so bytes 248-255 are skipped and every letter is equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  let s = '';
  while (s.length < 10) {
    for (const b of randomBytes(16)) {
      if (b < limit && s.length < 10) s += ALPHABET[b % ALPHABET.length];
    }
  }
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Replace all of a user's codes with 10 fresh ones. Returns them in plain text, for one-time display. */
export function generateRecoveryCodes(userId: number): string[] {
  const db = getDb();
  const codes = Array.from({ length: RECOVERY_COUNT }, newCode);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const c of codes) ins.run(userId, keyedHash(normalizeRecovery(c)!));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return codes;
}

/** Burn a recovery code. The conditional UPDATE makes it single-use even under parallel requests. */
export function useRecoveryCode(userId: number, input: string): boolean {
  const code = normalizeRecovery(input);
  if (!code) return false;
  const res = getDb()
    .prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .run(Date.now(), userId, keyedHash(code));
  return Number(res.changes) === 1;
}

export const remainingRecoveryCodes = (userId: number): number =>
  Number((getDb().prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n);
