// Editor account management for administrators: list, invite, role, disable and re-enable, reset 2FA.
// Every function here assumes the caller already checked the acting user is an admin and passed the
// fresh-factor check (src/lib/auth/fresh.ts). Audit entries hold ids only, never emails.
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './db';
import { audit } from './auth/audit';
import { allocateUserId, resetTwoFactor } from './db/db-core.mjs';
import { buildInviteEmail, postEmail } from './email';
import { siteUrl } from './draft-http';
import type { Role } from './auth/session';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export type Status = 'invited' | 'active' | 'disabled';

export interface EditorRow {
  id: number;
  name: string;
  email: string;
  role: Role;
  status: Status;
  totp: boolean;
  passkeys: number;
  recoveryCodes: number;
  lastSignIn: number | null;
  inviteExpiresAt: number | null;
  /** Linked Google / Microsoft accounts (issue #11): provider, date and the address the editor linked; no tokens. */
  links: { provider: 'google' | 'microsoft'; createdAt: number; email: string }[];
}

export function listEditors(): EditorRow[] {
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.status,
              EXISTS (SELECT 1 FROM totp_credentials t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS totp,
              (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
              (SELECT COUNT(*) FROM recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS recovery,
              u.last_login_at AS last_sign_in,
              (SELECT MAX(i.expires_at) FROM invites i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > ?) AS invite_expires
         FROM users u ORDER BY (u.status = 'disabled'), u.role, lower(u.name)`,
    )
    .all(Date.now()) as { id: number; name: string; email: string; role: Role; status: Status; totp: number; passkeys: number; recovery: number; last_sign_in: number | null; invite_expires: number | null }[];
  const links = getDb().prepare('SELECT user_id, provider, email_at_link, created_at FROM oauth_accounts ORDER BY created_at').all() as { user_id: number; provider: 'google' | 'microsoft'; email_at_link: string; created_at: number }[];
  return rows.map((r) => ({
    links: links.filter((l) => l.user_id === r.id).map((l) => ({ provider: l.provider, createdAt: l.created_at, email: l.email_at_link })),
    id: r.id, name: r.name, email: r.email, role: r.role, status: r.status,
    totp: r.totp === 1, passkeys: Number(r.passkeys), recoveryCodes: Number(r.recovery),
    lastSignIn: r.last_sign_in, inviteExpiresAt: r.invite_expires,
  }));
}

/** Replace any unused invites of a user with one new 7-day invite. Returns the raw token (only its hash is stored). */
function replaceInvite(userId: number): string {
  const db = getDb();
  const token = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(userId);
  db.prepare('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), userId, Date.now() + INVITE_TTL_MS);
  return token;
}

export const inviteLink = (token: string) => `${siteUrl()}/admin/invite/${token}`;

export type InviteResult =
  | { ok: true; userId: number; link: string; emailed: boolean; emailError?: string; resent: boolean }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/;

async function deliver(actorName: string, to: string, token: string): Promise<{ link: string; emailed: boolean; emailError?: string }> {
  const link = inviteLink(token);
  const res = await postEmail({ to, ...buildInviteEmail(actorName, link) });
  return res.sent ? { link, emailed: true } : { link, emailed: false, emailError: res.reason };
}

/** Check invite fields without touching anything (the page calls this before asking for a fresh factor). */
export function checkInviteInput(input: { email: string; name: string; role: string }): { ok: true; email: string; name: string; role: Role } | { ok: false; error: string } {
  const email = input.email.trim().toLowerCase();
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: 'Enter a valid email address.' };
  if (!name) return { ok: false, error: 'Enter the person’s name.' };
  if (input.role !== 'admin' && input.role !== 'editor') return { ok: false, error: 'Choose a role.' };
  return { ok: true, email, name, role: input.role as Role };
}

export const userExists = (id: number): boolean => Number.isInteger(id) && id > 0 && getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(id) !== undefined;

/** Create an invited user (or re-invite one still waiting) and send or hand back the link. */
export async function inviteEditor(actor: { id: number; name: string }, input: { email: string; name: string; role: string }, ip: string): Promise<InviteResult> {
  const checked = checkInviteInput(input);
  if (!checked.ok) return checked;
  const { email, name, role } = checked;
  const db = getDb();
  const now = Date.now();
  let userId = 0;
  let resent = false;
  let token = '';
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT id, status FROM users WHERE email = ?').get(email) as { id: number; status: Status } | undefined;
    if (existing && existing.status !== 'invited') {
      db.exec('ROLLBACK');
      return { ok: false, error: 'That email already has an account.' };
    }
    if (existing) {
      userId = existing.id;
      resent = true;
      db.prepare('UPDATE users SET name = ?, role = ?, updated_at = ? WHERE id = ?').run(name, role, now, userId);
    } else {
      userId = allocateUserId(db); // ids are never reused, even after a revoked invite
      db.prepare("INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'invited', ?, ?)").run(userId, email, name, role, now, now);
    }
    token = replaceInvite(userId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
  const sent = await deliver(actor.name, email, token);
  audit(resent ? 'admin.invite_resent' : 'admin.invite', { userId: actor.id, target: `user:${userId}`, ip, detail: { role, emailed: sent.emailed } });
  return { ok: true, userId, resent, ...sent };
}

/** New 7-day invite for a user who has not accepted yet; the old link stops working. */
export async function resendInvite(actor: { id: number; name: string }, targetId: number, ip: string): Promise<InviteResult> {
  const db = getDb();
  const u = db.prepare("SELECT email, role FROM users WHERE id = ? AND status = 'invited'").get(targetId) as { email: string; role: Role } | undefined;
  if (!u) return { ok: false, error: 'That person has already accepted, or does not exist.' };
  const token = replaceInvite(targetId);
  const sent = await deliver(actor.name, u.email, token);
  audit('admin.invite_resent', { userId: actor.id, target: `user:${targetId}`, ip, detail: { role: u.role, emailed: sent.emailed } });
  return { ok: true, userId: targetId, resent: true, ...sent };
}

export type ChangeResult = { ok: true } | { ok: false; error: string; status: number };

/**
 * Change a role, or disable/enable, in ONE transaction that also protects the last active admin:
 * the only active admin can be neither demoted nor disabled, whoever asks.
 */
function change(actor: { id: number }, targetId: number, ip: string, apply: (t: { role: Role; status: Status }) => { role?: Role; status?: Status; action: string; detail?: Record<string, unknown> } | { error: string; status?: number }): ChangeResult {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const t = db.prepare('SELECT role, status FROM users WHERE id = ?').get(targetId) as { role: Role; status: Status } | undefined;
    if (!t) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'That person was not found.', status: 404 };
    }
    const next = apply(t);
    if ('error' in next) {
      db.exec('ROLLBACK');
      return { ok: false, error: next.error, status: next.status ?? 400 };
    }
    const role = next.role ?? t.role;
    const status = next.status ?? t.status;
    const losesAdmin = t.role === 'admin' && t.status === 'active' && !(role === 'admin' && status === 'active');
    if (losesAdmin) {
      const others = Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?").get(targetId) as { n: number }).n);
      if (others === 0) {
        audit('admin.last_admin_refused', { userId: actor.id, target: `user:${targetId}`, ip, detail: { attempted: next.action } });
        db.exec('COMMIT'); // keep the audit entry
        return { ok: false, error: 'You can’t do that: this is the last active administrator. Make someone else an administrator first.', status: 409 };
      }
    }
    db.prepare('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?').run(role, status, Date.now(), targetId);
    if (status === 'disabled') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId); // signed out at once
    audit(next.action, { userId: actor.id, target: `user:${targetId}`, ip, detail: next.detail });
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}

export function changeRole(actor: { id: number }, targetId: number, role: string, ip: string): ChangeResult {
  if (role !== 'admin' && role !== 'editor') return { ok: false, error: 'Choose a role.', status: 400 };
  return change(actor, targetId, ip, (t) =>
    t.role === role ? { error: 'That person already has that role.' } : { role, action: 'admin.role_changed', detail: { from: t.role, to: role } },
  );
}

export function disableUser(actor: { id: number }, targetId: number, ip: string): ChangeResult {
  return change(actor, targetId, ip, (t) =>
    t.status !== 'active' ? { error: 'Only an active account can be disabled.' } : { status: 'disabled', action: 'admin.disabled' },
  );
}

export function enableUser(actor: { id: number }, targetId: number, ip: string): ChangeResult {
  return change(actor, targetId, ip, (t) =>
    t.status !== 'disabled' ? { error: 'That account is not disabled.' } : { status: 'active', action: 'admin.enabled' },
  );
}

/** Remove TOTP, passkeys, recovery codes, pending challenges and sessions (same code as scripts/reset-2fa.mjs). */
export function resetUserTwoFactor(actor: { id: number }, targetId: number, ip: string): ChangeResult {
  if (actor.id === targetId) return { ok: false, error: 'Use My account to change your own two-step sign-in.', status: 400 };
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const t = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!t) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'That person was not found.', status: 404 };
    }
    const n = resetTwoFactor(db, targetId);
    audit('admin.reset_2fa', { userId: actor.id, target: `user:${targetId}`, ip, detail: n });
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}

/** Remove one linked Google / Microsoft account from an editor (an administrator's action; audited with the actor, never an address). */
export function unlinkOauth(actor: { id: number }, targetId: number, provider: string, ip: string): ChangeResult {
  if (provider !== 'google' && provider !== 'microsoft') return { ok: false, error: 'Choose a provider.', status: 400 };
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const gone = db.prepare('DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?').run(targetId, provider);
    if (Number(gone.changes) !== 1) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'That linked account was not found.', status: 404 };
    }
    audit('auth.oauth_unlinked', { userId: actor.id, target: `user:${targetId}`, ip, detail: { provider, by: 'admin' } });
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}

/**
 * Cancel an invite that was never accepted: in one transaction the unused invites and the never-activated
 * user row are deleted (the address can then be invited again, e.g. after a typo). Accepted accounts are
 * disabled instead, never deleted.
 */
export function revokeInvite(actor: { id: number }, targetId: number, ip: string): ChangeResult {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const t = db.prepare("SELECT role FROM users WHERE id = ? AND status = 'invited'").get(targetId) as { role: Role } | undefined;
    if (!t) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'That person has already accepted, or does not exist.', status: 400 };
    }
    db.prepare('DELETE FROM invites WHERE user_id = ?').run(targetId);
    db.prepare("DELETE FROM users WHERE id = ? AND status = 'invited'").run(targetId);
    audit('admin.invite_revoked', { userId: actor.id, target: `user:${targetId}`, ip, detail: { role: t.role } });
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}
