import type { APIRoute } from 'astro';
import { SESSION_COOKIE, createSession, readSession, revokeSession, setSessionCookie } from '../../../../lib/auth/session';
import { audit } from '../../../../lib/auth/audit';
import { clearFlowCookie, exchangeCode, isProvider, providerConfig, readFlow, validateClaims, type Provider } from '../../../../lib/auth/oauth';
import { isAccountLocked, isIpLocked, releaseAttempt, reserveIpAttempt } from '../../../../lib/auth/ratelimit';
import { clientIp } from '../../../../lib/request';
import { getDb } from '../../../../lib/db';

export const prerender = false;

// First factor of Google / Microsoft sign-in. Invite-only: a provider account signs in only through
//   1. an existing oauth_accounts link, or
//   2. an active or invited editor whose email equals the provider's VERIFIED email (then the link is created).
// Anything else is rejected and nothing is created. Success starts a session with mfa_passed=0: /admin/2fa (which sends an
// editor with no second factor to enrollment), or straight to enrollment for a newly activated invite. Failures redirect to
// /admin/login?oauth=<code>; the page maps the code to fixed text, so nothing from the provider or the URL is reflected.

const go = (to: string) => new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } });
const fail = (code: string) => go(`/admin/login?oauth=${code}`);

interface UserRow { id: number; status: string }

export const GET: APIRoute = async ({ params, url, cookies, request, clientAddress }) => {
  const provider = params.provider;
  if (!isProvider(provider)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const ip = clientIp(request, clientAddress);
  const cfg = providerConfig(provider);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const flow = readFlow(cookies, provider, state);
  clearFlowCookie(cookies); // single use, whatever happens next
  // A callback without a valid state (no cookie, wrong state or provider, expired) can be forged cross-site by anyone, so it
  // is neither counted against the IP nor audited. Otherwise a web page could lock an editor's IP out of sign-in, or flood
  // the audit log, with hidden requests.
  if (typeof flow === 'string') return fail(flow === 'expired' ? 'expired' : 'failed');
  if (!cfg) return fail('unavailable');
  // A locked IP gets the lockout message without an audit row per request (like the password step).
  if (isIpLocked(ip)) return fail('locked');
  // The state is valid: count the attempt before the first await (the code exchange) and release it on success.
  const attempt = reserveIpAttempt(ip);

  const failed = (reason: string, userId: number | null = null, shown = 'failed') => {
    audit('auth.oauth_failed', { userId, ip, detail: { provider, reason } });
    return fail(shown);
  };
  if (url.searchParams.get('error')) return failed('provider_error'); // declined or refused; the provider's text is not shown
  if (!code || code.length > 2000 || !state || state.length > 500) return failed('bad_callback');

  const claims = await exchangeCode(cfg, code, flow.verifier);
  if (!claims) return failed('exchange');
  const result = validateClaims(cfg, claims, flow.nonce);
  if (!result.ok) return failed(`claims_${result.reason}`, null, result.reason === 'unverified' ? 'unverified' : result.reason === 'tenant' ? 'no_account' : 'failed');

  const db = getDb();
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

  // 2. An active or invited editor with this verified email. Link (and activate an invite) in one transaction.
  if (isAccountLocked(result.email)) return failed('locked', null, 'locked'); // matching is by this address, so it is the stored one
  const outcome = linkByEmail(provider, result.subject, result.email);
  if (outcome.kind === 'none') return failed('no_match', null, 'no_account');
  audit('auth.oauth_linked', { userId: outcome.userId, ip, detail: { provider, via: outcome.kind } });
  if (outcome.kind === 'invite') {
    audit('auth.invite_accepted', { userId: outcome.userId, ip, detail: { via: provider } });
    return finish(outcome.userId, '/admin/2fa/setup', { activated: true });
  }
  return finish(outcome.userId, '/admin/2fa');
};

function linkByEmail(provider: Provider, subject: string, email: string): { kind: 'none' } | { kind: 'invite' | 'active'; userId: number } {
  const db = getDb();
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const user = db.prepare("SELECT id, status FROM users WHERE email = ? AND status IN ('active', 'invited')").get(email) as UserRow | undefined;
    // An editor links one account per provider: a second, different Google account for the same editor is not matched.
    const already = user ? db.prepare('SELECT 1 FROM oauth_accounts WHERE user_id = ? AND provider = ?').get(user.id, provider) : undefined;
    if (!user || already) {
      db.exec('ROLLBACK');
      return { kind: 'none' };
    }
    if (user.status === 'invited') {
      // An invited editor matches only while an unused, unexpired invite exists: an expired or revoked invite is not accepted here either.
      const open = db.prepare('SELECT 1 FROM invites WHERE user_id = ? AND used_at IS NULL AND expires_at > ?').get(user.id, now);
      if (!open) {
        db.exec('ROLLBACK');
        return { kind: 'none' };
      }
      const activated = db.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ? AND status = 'invited'").run(now, user.id);
      if (Number(activated.changes) !== 1) {
        db.exec('ROLLBACK');
        return { kind: 'none' };
      }
      db.prepare('UPDATE invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, user.id); // the emailed link stops working
    }
    db.prepare('INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email_at_link, created_at) VALUES (?, ?, ?, ?, ?)').run(provider, subject, user.id, email, now);
    db.exec('COMMIT');
    return { kind: user.status === 'invited' ? 'invite' : 'active', userId: user.id };
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    return { kind: 'none' }; // a concurrent duplicate link or any database error: fail closed, create nothing
  }
}
