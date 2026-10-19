#!/usr/bin/env node
// Create the first admin (or re-invite a pending one) and print a 24 h invite URL.
// Usage: node scripts/create-admin.mjs <email> <name>
//   Docker: docker compose exec imconnected node scripts/create-admin.mjs <email> "<name>"
// Only the SHA-256 of the invite token is stored; the URL is shown once.
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const [emailArg, ...nameParts] = process.argv.slice(2);
const email = (emailArg || '').trim().toLowerCase();
const name = nameParts.join(' ').trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) {
  console.error('Usage: node scripts/create-admin.mjs <email> <name>');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDatabase();
runMigrations(db, readMigrationsFromDir(path.join(here, '../src/lib/db/migrations')));

const now = Date.now();
const existing = db.prepare('SELECT id, status FROM users WHERE email = ?').get(email);
if (existing && existing.status !== 'invited') {
  console.error('That email already has an account that is not waiting on an invite. Nothing changed.');
  process.exit(1);
}

const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');

db.exec('BEGIN IMMEDIATE');
try {
  let userId;
  if (existing) {
    userId = existing.id;
    db.prepare("UPDATE users SET name = ?, role = 'admin', updated_at = ? WHERE id = ?").run(name, now, userId);
    db.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(userId); // old links stop working
  } else {
    userId = Number(
      db.prepare("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, 'admin', 'invited', ?, ?)").run(email, name, now, now).lastInsertRowid,
    );
  }
  db.prepare('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, now + 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO audit_log (at, user_id, action, target, detail, ip) VALUES (?, NULL, ?, ?, NULL, NULL)').run(now, 'admin.bootstrap', `user:${userId}`);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const site = (process.env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
console.log(`Invite for the new admin (valid 24 hours, shown once):\n${site}/admin/invite/${token}`);
