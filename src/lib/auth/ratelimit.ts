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

/**
 * Count an attempt BEFORE the slow password check starts, so parallel requests can't all pass isLocked
 * while earlier ones are still hashing. Call right after isLocked() with no await in between. Returns
 * the row ids; on success call releaseAttempt() so a correct password doesn't count against the limit.
 */
export function reserveAttempt(ip: string, email: string): number[] {
  const db = getDb();
  const now = Date.now();
  const ins = db.prepare('INSERT INTO login_attempts (key, at, ok) VALUES (?, ?, 0)');
  const ids = [Number(ins.run(ipKey(ip), now).lastInsertRowid), Number(ins.run(accountKey(email), now).lastInsertRowid)];
  db.prepare('DELETE FROM login_attempts WHERE at < ?').run(now - 24 * 60 * 60 * 1000);
  return ids;
}

export function releaseAttempt(ids: number[]): void {
  const del = getDb().prepare('DELETE FROM login_attempts WHERE id = ?');
  for (const id of ids) del.run(id);
}

/** A success clears that account's failures (the IP's count stays). */
export function recordSuccess(email: string): void {
  getDb().prepare('DELETE FROM login_attempts WHERE key = ?').run(accountKey(email));
}

// Passkey sign-in has no email to start from (the authenticator names the account), so it reserves the
// IP first and the account once the credential identifies one. Same windows and limits as the password step.
export const isIpLocked = (ip: string): boolean => failures(ipKey(ip)) >= MAX_PER_IP;
export const isAccountLocked = (email: string): boolean => failures(accountKey(email)) >= MAX_PER_ACCOUNT;

/** Count an attempt against the IP only, before any await. Release it on success like reserveAttempt. */
export function reserveIpAttempt(ip: string): number[] {
  const db = getDb();
  const now = Date.now();
  const id = Number(db.prepare('INSERT INTO login_attempts (key, at, ok) VALUES (?, ?, 0)').run(ipKey(ip), now).lastInsertRowid);
  db.prepare('DELETE FROM login_attempts WHERE at < ?').run(now - 24 * 60 * 60 * 1000);
  return [id];
}

/** Count an attempt against the account only (the IP was already reserved). */
export function reserveAccountAttempt(email: string): number[] {
  return [Number(getDb().prepare('INSERT INTO login_attempts (key, at, ok) VALUES (?, ?, 0)').run(accountKey(email), Date.now()).lastInsertRowid)];
}
