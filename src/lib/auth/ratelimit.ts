import { createHash } from 'node:crypto';
import { getDb } from '../db';

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_PER_IP = 10;
export const MAX_PER_ACCOUNT = 5;
/** One message for every lockout, whichever key tripped it, so it reveals nothing about the account. */
export const LOCKED_MESSAGE = 'Too many attempts. Please wait 15 minutes and try again.';

const ipKey = (ip: string) => `ip:${ip}`;
/** Hashed so the table never holds addresses typed by strangers. Works for unknown emails too. */
export const accountKey = (email: string) => `acct:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;

function failures(key: string): number {
  const since = Date.now() - WINDOW_MS;
  return Number((getDb().prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND ok = 0 AND at > ?').get(key, since) as { n: number }).n);
}

/** Locked while the account has 5 failures, or the IP has 10, inside the last 15 minutes. */
export function isLocked(ip: string, email: string): boolean {
  return failures(ipKey(ip)) >= MAX_PER_IP || failures(accountKey(email)) >= MAX_PER_ACCOUNT;
}

/** Locked attempts are not recorded, so hammering a locked account can't extend the lockout. */
export function recordFailure(ip: string, email: string): void {
  const db = getDb();
  const now = Date.now();
  const ins = db.prepare('INSERT INTO login_attempts (key, at, ok) VALUES (?, ?, 0)');
  ins.run(ipKey(ip), now);
  ins.run(accountKey(email), now);
  db.prepare('DELETE FROM login_attempts WHERE at < ?').run(now - 24 * 60 * 60 * 1000);
}

/** A success clears that account's failures (the IP's count stays). */
export function recordSuccess(email: string): void {
  getDb().prepare('DELETE FROM login_attempts WHERE key = ?').run(accountKey(email));
}
