#!/usr/bin/env node
// Reset one editor's second factor after they lost their authenticator AND recovery codes.
// Usage: node scripts/reset-2fa.mjs <email>
//   Docker: docker compose exec imconnected node scripts/reset-2fa.mjs <email>
// A PERSON runs this on the server, only after confirming the editor's identity out of band (for
// example a call), and right before the editor signs in. It deletes the authenticator, the passkeys, the recovery
// codes, any linked Google or Microsoft account and every session of that user, in one transaction. The editor's password stays; at the next
// sign-in they enroll a new authenticator and get new recovery codes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, readMigrationsFromDir, resetTwoFactor } from '../src/lib/db/db-core.mjs';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email || process.argv.length > 3) {
  console.error('Usage: node scripts/reset-2fa.mjs <email>');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDatabase();
runMigrations(db, readMigrationsFromDir(path.join(here, '../src/lib/db/migrations')));

const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (!user) {
  console.error('No account with that email. Nothing changed.');
  process.exit(1);
}

db.exec('BEGIN IMMEDIATE');
try {
  const n = resetTwoFactor(db, user.id);
  db.prepare('INSERT INTO audit_log (at, user_id, action, target, detail, ip) VALUES (?, NULL, ?, ?, ?, NULL)').run(
    Date.now(), 'admin.reset_2fa', `user:${user.id}`, JSON.stringify(n),
  );
  db.exec('COMMIT');
  console.log(`Reset two-factor for user ${user.id}: removed ${n.authenticators} authenticator, ${n.passkeys} passkeys, ${n.recoveryCodes} recovery codes, ${n.oauthLinks} linked Google/Microsoft accounts, ${n.sessions} sessions. They enroll a new authenticator or passkey at their next sign-in.`);
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
