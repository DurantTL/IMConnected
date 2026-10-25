#!/usr/bin/env node
// Reset one editor's second factor after they lost their authenticator AND recovery codes.
// Usage: node scripts/reset-2fa.mjs <email> [--yes-last-admin]
//   Docker: docker compose exec imconnected node scripts/reset-2fa.mjs <email>
// A PERSON runs this on the server, only after confirming the editor's identity out of band (for
// example a call), and right before the editor signs in. It deletes the authenticator, the passkeys, the recovery
// codes, any linked Google or Microsoft account and every session (an editor with no password goes back to Invited and needs a new invite) of that user, in one transaction. The editor's password stays; at the next
// sign-in they enroll a new authenticator and get new recovery codes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, readMigrationsFromDir, resetTwoFactor } from '../src/lib/db/db-core.mjs';

const args = process.argv.slice(2);
const yesLastAdmin = args.includes('--yes-last-admin');
const positional = args.filter((a) => !a.startsWith('--'));
const email = (positional[0] || '').trim().toLowerCase();
if (!email || positional.length !== 1 || args.some((a) => a.startsWith('--') && a !== '--yes-last-admin')) {
  console.error('Usage: node scripts/reset-2fa.mjs <email> [--yes-last-admin]');
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
  // A reset also removes a password-less editor's linked Google/Microsoft accounts and passkeys and puts them back to Invited. For the ONLY
  // active administrator that would leave nobody who can sign in, so it needs an explicit flag (and then create-admin.mjs to get back in).
  const me = db.prepare('SELECT role, status FROM users WHERE id = ?').get(user.id);
  const noPassword = !db.prepare('SELECT 1 FROM password_credentials WHERE user_id = ?').get(user.id);
  const otherAdmins = Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?").get(user.id).n);
  const strandsLastAdmin = me.role === 'admin' && me.status === 'active' && noPassword && otherAdmins === 0;
  if (strandsLastAdmin && !yesLastAdmin) {
    db.exec('ROLLBACK');
    console.error('WARNING: this is the only active administrator and they have no password (they sign in with Google, Microsoft or a passkey).');
    console.error('Resetting would remove those, put the account back to Invited and leave NO active administrator able to sign in.');
    console.error('Nothing changed. If you really mean it, run again with --yes-last-admin, then run: node scripts/create-admin.mjs <email> "<name>" to get a new invite.');
    process.exit(2);
  }
  const n = resetTwoFactor(db, user.id);
  db.prepare('INSERT INTO audit_log (at, user_id, action, target, detail, ip) VALUES (?, NULL, ?, ?, ?, NULL)').run(
    Date.now(), 'admin.reset_2fa', `user:${user.id}`, JSON.stringify(n),
  );
  db.exec('COMMIT');
  console.log(`Reset two-factor for user ${user.id}: removed ${n.authenticators} authenticator, ${n.passkeys} passkeys, ${n.recoveryCodes} recovery codes, ${n.oauthLinks} linked Google/Microsoft accounts, ${n.sessions} sessions. ` + (strandsLastAdmin
    ? 'They were the only active administrator and have no password, so they are back to Invited and NOBODY can sign in now: run node scripts/create-admin.mjs <email> "<name>" and open the new invite link.'
    : n.reinvite ? 'They have no password, so they are back to Invited: an administrator sends them a new invite from the Editors page (Send a new invite).' : 'They enroll a new authenticator or passkey at their next sign-in.'));
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
