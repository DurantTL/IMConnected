import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { getDb } from '../db';
import type { SessionUser } from './session';
import { hasConfirmedTotp } from './totp';

// Passkeys (WebAuthn). The relying party comes from SITE_URL, never from the request, so a forged Host
// or Origin header can't change what a credential is bound to.

export const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_PENDING_LOGIN_CHALLENGES = 2000;
export type Purpose = 'register' | 'login' | 'second_factor' | 'fresh';

/** RP ID = hostname of SITE_URL; expected origin = its origin. Null (passkeys off) if SITE_URL is unset or invalid. */
export function relyingParty(): { id: string; origin: string; name: string } | null {
  try {
    const u = new URL(process.env.SITE_URL || '');
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null; // WebAuthn needs a secure context
    return { id: u.hostname, origin: u.origin, name: 'IMConnected editors' };
  } catch {
    return null;
  }
}
export const passkeysEnabled = (): boolean => relyingParty() !== null;

export interface PasskeyRow {
  id: string;
  device_name: string;
  created_at: number;
  last_used_at: number | null;
}
export const listPasskeys = (userId: number): PasskeyRow[] =>
  getDb().prepare('SELECT id, device_name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as PasskeyRow[];
export const countPasskeys = (userId: number): number =>
  Number((getDb().prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId) as { n: number }).n);
export const hasPasskey = (userId: number): boolean => countPasskeys(userId) > 0;

// ---- challenges: stored server-side, single use, 5 minutes ----

function storeChallenge(purpose: Purpose, userId: number | null, challenge: string): boolean {
  const db = getDb();
  const now = Date.now();
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(now);
  if (userId === null) {
    const n = Number((db.prepare("SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = 'login'").get() as { n: number }).n);
    if (n >= MAX_PENDING_LOGIN_CHALLENGES) return false; // unauthenticated endpoint: keep the table bounded
  } else {
    // A signed-in user starting a new ceremony of this kind replaces their older unused ones.
    db.prepare('DELETE FROM webauthn_challenges WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  }
  db.prepare('INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?)').run(userId, challenge, purpose, now + CHALLENGE_MS);
  return true;
}

/** Consume a challenge: the DELETE makes it single-use even for parallel requests. */
function consumeChallenge(challenge: string, purpose: Purpose, userId: number | null): 'ok' | 'expired' | 'unknown' {
  const row = getDb()
    .prepare('DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND user_id IS ? RETURNING expires_at')
    .get(challenge, purpose, userId) as { expires_at: number } | undefined;
  if (!row) return 'unknown'; // never issued to this user for this purpose, or already used
  return row.expires_at > Date.now() ? 'ok' : 'expired';
}

/** The challenge a browser response was made for, read from its clientDataJSON. */
function challengeOf(response: unknown): string | null {
  try {
    const r = response as { response?: { clientDataJSON?: unknown } };
    if (typeof r.response?.clientDataJSON !== 'string') return null;
    const c = JSON.parse(Buffer.from(r.response.clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof c.challenge === 'string' && c.challenge.length <= 200 ? c.challenge : null;
  } catch {
    return null;
  }
}

export function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const userHandle = (userId: number) => new TextEncoder().encode(`imc-user:${userId}`);
const transportsOf = (json: string | null): AuthenticatorTransportFuture[] | undefined => {
  try {
    return json ? (JSON.parse(json) as AuthenticatorTransportFuture[]) : undefined;
  } catch {
    return undefined;
  }
};

// ---- registration ----

export async function registrationOptions(user: SessionUser) {
  const rp = relyingParty();
  if (!rp) return null;
  const existing = getDb().prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id) as { id: string; transports: string | null }[];
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.name,
    userID: userHandle(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: transportsOf(p.transports) })), // no duplicates
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  return storeChallenge('register', user.id, options.challenge) ? options : null;
}

export type RegistrationResult = 'ok' | 'expired' | 'invalid' | 'duplicate' | 'off';

/** Verify a registration response and store the credential. The caller decides whether to allow it (enrollment rules, fresh factor). */
export async function finishRegistration(user: SessionUser, response: unknown, name: string): Promise<{ result: RegistrationResult; id?: string }> {
  const rp = relyingParty();
  if (!rp) return { result: 'off' };
  const challenge = challengeOf(response);
  if (!challenge) return { result: 'invalid' };
  const c = consumeChallenge(challenge, 'register', user.id);
  if (c !== 'ok') return { result: c === 'expired' ? 'expired' : 'invalid' };
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
    });
    if (!v.verified) return { result: 'invalid' };
    info = v.registrationInfo;
  } catch {
    return { result: 'invalid' };
  }
  const db = getDb();
  const id = info.credential.id;
  const n = countPasskeys(user.id);
  const label = cleanName(name) || `Passkey ${n + 1}`;
  const res = db
    .prepare('INSERT OR IGNORE INTO passkeys (id, user_id, public_key, counter, transports, device_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      id,
      user.id,
      Buffer.from(info.credential.publicKey).toString('base64url'),
      info.credential.counter,
      info.credential.transports ? JSON.stringify(info.credential.transports) : null,
      label,
      Date.now(),
    );
  return Number(res.changes) === 1 ? { result: 'ok', id } : { result: 'duplicate' };
}

export function cleanName(input: string): string {
  return input.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);
}

// ---- authentication ----

/** Options for signing in: no userId = discoverable (passwordless) login; with a userId = that user's own passkeys. */
export async function authenticationOptions(purpose: Exclude<Purpose, 'register'>, userId: number | null) {
  const rp = relyingParty();
  if (!rp) return null;
  const creds = userId === null ? [] : (getDb().prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(userId) as { id: string; transports: string | null }[]);
  if (userId !== null && creds.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: 'required',
    allowCredentials: userId === null ? undefined : creds.map((p) => ({ id: p.id, transports: transportsOf(p.transports) })),
  });
  return storeChallenge(purpose, userId, options.challenge) ? options : null;
}

export type AuthResult =
  | { status: 'ok'; userId: number; email: string; passkeyId: string }
  | { status: 'expired' | 'invalid' | 'unknown' | 'counter' | 'locked' | 'off' | 'inactive'; userId?: number };

/**
 * Verify an authentication response against the challenge issued for `purpose` (and for `userId`, unless
 * this is the discoverable login, where the credential names the account).
 * `onUser` runs once the credential identifies an account and before the signature check, with no await
 * in between: the caller uses it to enforce and reserve the per-account rate limit. Return 'locked' to stop.
 */
export async function finishAuthentication(
  response: unknown,
  purpose: Exclude<Purpose, 'register'>,
  userId: number | null,
  onUser?: (user: { id: number; email: string }) => 'locked' | void,
): Promise<AuthResult> {
  const rp = relyingParty();
  if (!rp) return { status: 'off' };
  const challenge = challengeOf(response);
  const credId = (response as { id?: unknown } | null)?.id;
  if (!challenge || typeof credId !== 'string' || credId.length > 1400) return { status: 'invalid' };
  const c = consumeChallenge(challenge, purpose, userId);
  if (c !== 'ok') return { status: c === 'expired' ? 'expired' : 'invalid' };

  const db = getDb();
  const row = db
    .prepare(
      `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports, u.email, u.status
         FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    )
    .get(credId) as { id: string; user_id: number; public_key: string; counter: number; transports: string | null; email: string; status: string } | undefined;
  if (!row || (userId !== null && row.user_id !== userId)) return { status: 'unknown' };
  if (row.status !== 'active') return { status: 'inactive', userId: row.user_id };
  if (onUser?.({ id: row.user_id, email: row.email }) === 'locked') return { status: 'locked', userId: row.user_id };
  // A discoverable credential names its account in userHandle; it must match the account that owns the credential.
  const handle = (response as AuthenticationResponseJSON).response?.userHandle;
  if (typeof handle === 'string' && handle && Buffer.from(handle, 'base64url').toString('utf8') !== `imc-user:${row.user_id}`) {
    return { status: 'invalid', userId: row.user_id };
  }
  try {
    const v = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter: 0, // the library checks the counter BEFORE the signature; we check it ourselves after
        transports: transportsOf(row.transports),
      },
    });
    if (!v.verified) return { status: 'invalid', userId: row.user_id };
    // A counter that did not go forward (when either value is non-zero) means a cloned authenticator.
    // Only a response with a valid signature can raise this, so a forged one can't cause false alarms.
    const next = v.authenticationInfo.newCounter;
    if ((next > 0 || row.counter > 0) && next <= row.counter) return { status: 'counter', userId: row.user_id };
    // Conditional on the stored counter, so a parallel use of the same credential can't both advance it.
    const upd = db
      .prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?')
      .run(v.authenticationInfo.newCounter, Date.now(), row.id, row.counter);
    if (Number(upd.changes) !== 1) return { status: 'counter', userId: row.user_id };
    return { status: 'ok', userId: row.user_id, email: row.email, passkeyId: row.id };
  } catch {
    return { status: 'invalid', userId: row.user_id };
  }
}

// ---- managing ----

export function renamePasskey(userId: number, id: string, name: string): boolean {
  const label = cleanName(name);
  if (!label) return false;
  return Number(getDb().prepare('UPDATE passkeys SET device_name = ? WHERE id = ? AND user_id = ?').run(label, id, userId).changes) === 1;
}

/**
 * Remove a passkey unless it is the user's last second factor (a confirmed authenticator app counts as another).
 * Callers must have checked a fresh second factor first.
 */
export function removePasskey(userId: number, id: string): 'removed' | 'last_factor' | 'not_found' {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const exists = db.prepare('SELECT 1 AS x FROM passkeys WHERE id = ? AND user_id = ?').get(id, userId);
    let out: 'removed' | 'last_factor' | 'not_found' = 'not_found';
    if (exists) {
      if (countPasskeys(userId) <= 1 && !hasConfirmedTotp(userId)) out = 'last_factor';
      else {
        db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId);
        out = 'removed';
      }
    }
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  }
}

