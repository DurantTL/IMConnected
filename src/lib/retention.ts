import { getDb } from './db';
import { IDLE_MS } from './auth/session';

const DAY_MS = 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_MS = 2 * 365 * DAY_MS;

/** Delete old audit entries (2 years) and expired sessions, WebAuthn challenges and invites. Returns the counts. */
export function runRetention(now = Date.now()) {
  const db = getDb();
  const audit = db.prepare('DELETE FROM audit_log WHERE at < ?').run(now - AUDIT_RETENTION_MS);
  const sessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - IDLE_MS);
  const challenges = db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(now);
  const invites = db.prepare('DELETE FROM invites WHERE expires_at <= ?').run(now);
  return { audit: Number(audit.changes), sessions: Number(sessions.changes), challenges: Number(challenges.changes), invites: Number(invites.changes) };
}

let lastRun = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function safeRun(): void {
  try {
    const n = runRetention();
    lastRun = Date.now();
    if (n.audit || n.sessions || n.challenges || n.invites) console.log(`[retention] removed ${n.audit} audit entries, ${n.sessions} sessions, ${n.challenges} challenges, ${n.invites} invites`);
  } catch (err) {
    console.error('[retention] failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Called from the middleware on admin requests once the database is open. The first call after a start
 * runs the cleanup (startup), a daily timer repeats it, and a request that finds the last run over a day
 * old runs it too (in case the timer was missed). Cheap otherwise: one timestamp compare.
 */
export function ensureRetention(): void {
  if (!timer) {
    timer = setInterval(safeRun, DAY_MS);
    timer.unref?.();
  }
  if (Date.now() - lastRun >= DAY_MS) safeRun();
}
