// Shared by the server (src/lib/db/index.ts) and scripts/create-admin.mjs.
// Plain JS on purpose so the script can import it without a build step.
import fs from 'node:fs';
import path from 'node:path';

// node:sqlite is still flagged experimental on Node 22 and prints a warning on first load.
// Drop only that one warning; every other warning still prints.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text ?? '')) return;
  return emit.call(process, warning, ...args);
};
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
process.emitWarning = emit;
export { DatabaseSync };

/** Migration files are named like 001_init.sql. */
export const MIGRATION_NAME = /^\d{3}_.*\.sql$/;

/** Directory holding imconnected.db: DATA_DIR, else ./data (the Docker image sets DATA_DIR=/data). */
export function dataDir() {
  return path.resolve(process.env.DATA_DIR || './data');
}

/** Open (creating if needed) the database with WAL and foreign keys on. */
export function openDatabase(dir = dataDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'imconnected.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000;'); // first, so the WAL switch below waits on a concurrent opener
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (err) {
    db.close(); // e.g. a read-only file: don't leak a handle on every request
    throw err;
  }
  return db;
}

/**
 * Apply numbered migrations ({ name: '001_init.sql', sql }) that are not yet recorded in
 * schema_migrations. Each runs in its own transaction. Returns the names applied this call.
 */
export function runMigrations(db, migrations) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;',
  );
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const applied = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have applied it between our check and taking the write lock.
      const again = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(m.name);
      if (!again) {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, Date.now());
        applied.push(m.name);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return applied;
}

/** Read *.sql files from a directory (used by the script; the server bundles them instead). */
export function readMigrationsFromDir(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => MIGRATION_NAME.test(f))
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

/**
 * Remove every second factor of one user: authenticator, passkeys, recovery codes, pending WebAuthn
 * challenges and all their sessions. Shared by scripts/reset-2fa.mjs and the admin Editors page.
 * The caller wraps it (and its audit entry) in a transaction. Their password stays; with no factor
 * left, the next sign-in is sent to enrollment. Returns what was removed.
 */
export function resetTwoFactor(db, userId) {
  const t = db.prepare('DELETE FROM totp_credentials WHERE user_id = ?').run(userId);
  const k = db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM webauthn_challenges WHERE user_id = ?').run(userId);
  const r = db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  // Google / Microsoft links go too (issue #11): a first factor someone else may still hold is cleared along with the second factor.
  const o = db.prepare('DELETE FROM oauth_accounts WHERE user_id = ?').run(userId);
  const s = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return { authenticators: Number(t.changes), passkeys: Number(k.changes), recoveryCodes: Number(r.changes), oauthLinks: Number(o.changes), sessions: Number(s.changes) };
}

/**
 * The next user id, never reused (see migration 009). Call inside the transaction that inserts the user
 * and insert with this explicit id. Every place that inserts into users must use it.
 */
export function allocateUserId(db) {
  const mark = db.prepare('SELECT last_id FROM user_id_mark WHERE id = 1').get();
  const top = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM users').get().m;
  const id = Math.max(Number(mark?.last_id ?? 0), Number(top)) + 1;
  db.prepare('INSERT INTO user_id_mark (id, last_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_id = excluded.last_id').run(id);
  return id;
}
