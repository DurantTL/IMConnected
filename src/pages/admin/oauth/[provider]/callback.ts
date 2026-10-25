import type { APIRoute } from 'astro';
import { SESSION_COOKIE, createSession, readSession, revokeSession, setSessionCookie } from '../../../../lib/auth/session';
import { audit } from '../../../../lib/auth/audit';
import { clearFlowCookie, exchangeCode, isProvider, providerConfig, readFlow, sessionBinding, validateClaims, type Provider } from '../../../../lib/auth/oauth';
import { isAccountLocked, isIpLocked, releaseAttempt, reserveIpAttempt } from '../../../../lib/auth/ratelimit';
import { clientIp } from '../../../../lib/request';
import { getDb } from '../../../../lib/db';

export const prerender = false;

// Return from Google / Microsoft. Two intents, both bound in the single-use `__Host-imc_oauth` cookie:
//
// SIGN-IN (first factor, invite-only). A provider account signs in only through
//   1. an existing oauth_accounts link (matched by the provider's stable subject), or
//   2. an INVITED editor with an open (unused, unexpired) invite whose email equals the provider's VERIFIED email: that links the
//      account, activates the editor and goes to authenticator enrollment. This is the ONLY email match: an ACTIVE editor who has no
//      link for that provider is rejected, so an administrator's unlink or a 2FA reset can't be undone by signing in again.
//   Anything else is rejected and nothing is created. Success starts a session with mfa_passed=0 (/admin/2fa).
//
// LINK (an active editor adds a provider from My account). Only with a fully signed-in session (2FA passed) of the same user the
// cookie was made for; the provider subject is linked to that user (the provider's email need not equal the account email), unless it
// already belongs to anyone. The session is never changed. Returns to /admin/account?oauth=<code>.
//
// Failures redirect with a code that the destination page maps to fixed text, so nothing from the provider or the URL is reflected.

const go = (to: string) => new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } });

interface UserRow { id: number; status: string }

export const GET: APIRoute = async ({ params, url, cookies, request, clientAddress, locals }) => {
  const provider = params.provider;
  if (!isProvider(provider)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const ip = clientIp(request, clientAddress);
  const cfg = providerConfig(provider);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const flow = readFlow(cookies, provider, state);
  clearFlowCookie(cookies); // single use, whatever happens next
  const me = locals.user && locals.session?.mfaPassed ? locals.user : null; // a fully signed-in editor, if any
  // A callback without a valid state (no cookie, wrong state or provider, expired) can be forged cross-site by anyone, so it
  // is neither counted against the IP nor audited. Otherwise a web page could lock an editor's IP out of sign-in, or flood
  // the audit log, with hidden requests.
  if (typeof flow === 'string') return go(`${me ? '/admin/account' : '/admin/login'}?oauth=${flow === 'expired' ? 'expired' : 'failed'}`);
  const linking = flow.intent === 'link';
  const dest = linking ? '/admin/account' : '/admin/login';
  const fail = (shown: string) => go(`${dest}?oauth=${shown}`);
  if (!cfg) return fail('unavailable');
  if (!linking && me) return go('/admin'); // already signed in: nothing to do (a sign-in never replaces a full session)
  if (linking && (!me || me.id !== flow.uid || !locals.session || sessionBinding(locals.session.id) !== flow.sid)) {
    // A link cookie used by another session (even of the same editor, e.g. after signing out and in), another editor or nobody: refused, nothing linked.
    audit('auth.oauth_failed', { userId: me?.id ?? null, ip, detail: { provider, reason: 'link_session' } });
    return go(`${me ? '/admin/account' : '/admin/login'}?oauth=failed`);
  }
  // A locked IP gets the lockout message without an audit row per request (like the password step).
  if (isIpLocked(ip)) return fail('locked');
  // The state is valid: count the attempt before the first await (the code exchange) and release it on success.
  const attempt = reserveIpAttempt(ip);

  const failed = (reason: string, userId: number | null = null, shown = 'failed') => {
    audit('auth.oauth_failed', { userId, ip, detail: { provider, reason, ...(linking ? { intent: 'link' } : {}) } });
    return fail(shown);
  };
  if (url.searchParams.get('error')) return failed('provider_error', linking ? me!.id : null); // declined or refused; the provider's text is not shown
  if (!code || code.length > 2000 || !state || state.length > 500) return failed('bad_callback', linking ? me!.id : null);

  const claims = await exchangeCode(cfg, code, flow.verifier);
  if (!claims) return failed('exchange', linking ? me!.id : null);
  const result = validateClaims(cfg, claims, flow.nonce);
  if (!result.ok) return failed(`claims_${result.reason}`, linking ? me!.id : null, result.reason === 'unverified' ? 'unverified' : !linking && result.reason === 'tenant' ? 'no_account' : 'failed');

  const db = getDb();

  if (linking) {
    const owner = db.prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?').get(provider, result.subject) as { user_id: number } | undefined;
    if (owner) {
      releaseAttempt(attempt); // a fully authenticated editor's own refused action, not a sign-in guess: it must not count toward the IP lockout
      return failed(owner.user_id === me!.id ? 'link_exists' : 'link_taken', me!.id, owner.user_id === me!.id ? 'exists' : 'taken');
    }
    try {
      db.prepare('INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email_at_link, created_at) VALUES (?, ?, ?, ?, ?)').run(provider, result.subject, me!.id, result.email, Date.now());
    } catch {
      releaseAttempt(attempt);
      return failed('link_exists', me!.id, 'exists'); // this editor already has a link for the provider (or a concurrent duplicate)
    }
    releaseAttempt(attempt);
    audit('auth.oauth_linked', { userId: me!.id, ip, detail: { provider, via: 'account' } });
    return go('/admin/account?oauth=linked');
  }

  const finish = (userId: number, destination: string, extra: Record<string, unknown> = {}) => {
    releaseAttempt(attempt);
    const old = readSession(cookies.get(SESSION_COOKIE)?.value);
    if (old) revokeSession(old.session.id);
    const { token } = createSession(userId, { ip, userAgent: request.headers.get('user-agent'), mfaPassed: false });
    setSessionCookie(cookies, token);
    audit('auth.oauth_login', { userId, ip, detail: { provider, ...extra } });
    return go(destination);
  };

  // 1. An existing link.
  const linked = db
    .prepare('SELECT o.user_id, u.status, u.email FROM oauth_accounts o JOIN users u ON u.id = o.user_id WHERE o.provider = ? AND o.provider_user_id = ?')
    .get(provider, result.subject) as { user_id: number; status: string; email: string } | undefined;
  if (linked) {
    if (linked.status !== 'active') return failed('link_inactive', linked.user_id, 'no_account');
    if (isAccountLocked(linked.email)) return failed('locked', linked.user_id, 'locked'); // the editor's stored address, not the provider's
    return finish(linked.user_id, '/admin/2fa');
  }

  // 2. An invited editor with an open invite and this verified email: accept the invite (link + activate in one transaction).
  if (isAccountLocked(result.email)) return failed('locked', null, 'locked'); // matching is by this address, so it is the stored one
  const outcome = acceptInvite(provider, result.subject, result.email);
  if (outcome === null) return failed('no_match', null, 'no_account');
  audit('auth.oauth_linked', { userId: outcome, ip, detail: { provider, via: 'invite' } });
  audit('auth.invite_accepted', { userId: outcome, ip, detail: { via: provider } });
  return finish(outcome, '/admin/2fa/setup', { activated: true });
};

/** The user id of an invited editor with an open invite for this email, linked and activated in one transaction; null when there is none. */
function acceptInvite(provider: Provider, subject: string, email: string): number | null {
  const db = getDb();
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare("SELECT id, status FROM users WHERE email = ? AND status = 'invited'").get(email) as UserRow | undefined;
    // An unused, unexpired invite must exist: an expired or revoked invite is not accepted here either.
    const open = user ? db.prepare('SELECT 1 FROM invites WHERE user_id = ? AND used_at IS NULL AND expires_at > ?').get(user.id, now) : undefined;
    if (!user || !open) {
      db.exec('ROLLBACK');
      return null;
    }
    const activated = db.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ? AND status = 'invited'").run(now, user.id);
    if (Number(activated.changes) !== 1) {
      db.exec('ROLLBACK');
      return null;
    }
    db.prepare('UPDATE invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, user.id); // the emailed link stops working
    db.prepare('INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email_at_link, created_at) VALUES (?, ?, ?, ?, ?)').run(provider, subject, user.id, email, now);
    db.exec('COMMIT');
    return user.id;
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    return null; // a concurrent duplicate link or any database error: fail closed, create nothing
  }
}
