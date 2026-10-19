import { createHash, randomBytes } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { getDb } from '../db';

export const SESSION_COOKIE = '__Host-imc_session';
export const IDLE_MS = 12 * 60 * 60 * 1000; // 12 h without a request
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days from sign-in
const TOUCH_EVERY_MS = 60 * 1000; // don't write on every request

export type Role = 'admin' | 'editor';
export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}
export interface Session {
  id: string; // SHA-256 of the token
  userId: number;
  mfaPassed: boolean;
  expiresAt: number;
  lastSeenAt: number;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Start a session. Returns the raw token (for the cookie); only its hash is stored. */
export function createSession(
  userId: number,
  opts: { ip?: string | null; userAgent?: string | null; mfaPassed?: boolean } = {},
): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + ABSOLUTE_MS;
  getDb()
    .prepare(
      'INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent, mfa_passed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(hashToken(token), userId, now, now, expiresAt, opts.ip ?? null, (opts.userAgent ?? '').slice(0, 300) || null, opts.mfaPassed ? 1 : 0);
  return { token, expiresAt };
}

/** Look up a session by raw token. Returns null (and removes it) when expired or the user isn't active. */
export function readSession(token: string | undefined): { session: Session; user: SessionUser } | null {
  if (!token || token.length > 200) return null;
  const db = getDb();
  const id = hashToken(token);
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.mfa_passed, s.expires_at, s.last_seen_at,
              u.email, u.name, u.role, u.status
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as
    | { id: string; user_id: number; mfa_passed: number; expires_at: number; last_seen_at: number; email: string; name: string; role: Role; status: string }
    | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now || row.last_seen_at + IDLE_MS <= now || row.status !== 'active') {
    revokeSession(id);
    return null;
  }
  return {
    session: { id: row.id, userId: row.user_id, mfaPassed: row.mfa_passed === 1, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at },
    user: { id: row.user_id, email: row.email, name: row.name, role: row.role },
  };
}

/** Slide the idle window forward (throttled to one write a minute). */
export function touchSession(session: Session): void {
  const now = Date.now();
  if (now - session.lastSeenAt < TOUCH_EVERY_MS) return;
  getDb().prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, session.id);
  session.lastSeenAt = now;
}

/**
 * Swap a session for a fresh token (call after sign-in steps and 2FA, so a token seen earlier is useless).
 * One transaction: the old row goes, a new random token is inserted keeping the original
 * created_at and expires_at, so rotating never extends the 7-day limit. Sets the cookie.
 * Returns null when the old session is gone, expired, idle too long or its user is not active.
 * Callers must use the returned session: `locals.session` still holds the old id.
 */
export function rotateSession(oldId: string, opts: { mfaPassed: boolean; cookies: AstroCookies }): { token: string; session: Session } | null {
  const db = getDb();
  const token = randomBytes(32).toString('base64url');
  const id = hashToken(token);
  const now = Date.now();
  let expiresAt = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const old = db
      .prepare(
        `SELECT s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.ip, s.user_agent, u.status
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      )
      .get(oldId) as
      | { user_id: number; created_at: number; expires_at: number; last_seen_at: number; ip: string | null; user_agent: string | null; status: string }
      | undefined;
    // Same checks as readSession: absolute limit, idle limit, and the user must still be active.
    if (!old || old.expires_at <= now || old.last_seen_at + IDLE_MS <= now || old.status !== 'active') {
      if (old) db.prepare('DELETE FROM sessions WHERE id = ?').run(oldId);
      db.exec('COMMIT');
      return null;
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(oldId);
    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent, mfa_passed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, old.user_id, old.created_at, now, old.expires_at, old.ip, old.user_agent, opts.mfaPassed ? 1 : 0);
    db.exec('COMMIT');
    expiresAt = old.expires_at;
    setSessionCookie(opts.cookies, token);
    return {
      token,
      session: { id, userId: old.user_id, mfaPassed: opts.mfaPassed, expiresAt, lastSeenAt: now },
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}

/** Revoke by session id (the token hash). */
export function revokeSession(sessionId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/** Sign a user out everywhere, optionally keeping the session they're using now. */
export function revokeAllForUser(userId: number, exceptSessionId?: string): void {
  if (exceptSessionId) getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptSessionId);
  else getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Always Secure: Chrome and Firefox also accept Secure cookies on http://localhost.
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

export function setSessionCookie(cookies: AstroCookies, token: string): void {
  cookies.set(SESSION_COOKIE, token, { ...cookieOptions, maxAge: Math.floor(ABSOLUTE_MS / 1000) });
}

export function clearSessionCookie(cookies: AstroCookies): void {
  cookies.set(SESSION_COOKIE, '', { ...cookieOptions, maxAge: 0 });
}
