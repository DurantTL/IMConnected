import type { Session, SessionUser } from './session';
import { checkFreshFactor } from './factor';
import { LOCKED_MESSAGE } from './ratelimit';
import { audit } from './audit';
import { getDb } from '../db';

/** A sensitive admin action needs a second factor proved within this long. */
export const FRESH_MS = 10 * 60 * 1000;

export const isFresh = (session: Session): boolean => Date.now() - session.freshAt < FRESH_MS;

export type FreshOutcome = { ok: true } | { ok: false; status: 401 | 429; error: string };

/**
 * Fresh second factor for a sensitive change. Passes when the session proved a factor in the last
 * 10 minutes (2FA at sign-in counts). Otherwise the form must carry an authenticator or recovery code,
 * or a passkey assertion (the same helper My account uses), under the sign-in rate limits. A successful
 * check restarts the 10-minute window for this session.
 */
export async function requireFresh(user: SessionUser, session: Session, form: FormData, ip: string): Promise<FreshOutcome> {
  if (isFresh(session)) return { ok: true };
  // Nothing typed and no passkey assertion: the form is asking for the factor, so this is not a failed attempt.
  const typed = form.get('code');
  const assertion = form.get('assertion');
  if ((typeof typed !== 'string' || !typed.trim()) && (typeof assertion !== 'string' || !assertion)) {
    return { ok: false, status: 401, error: 'Enter a fresh authenticator or recovery code, or confirm with a passkey, to make this change.' };
  }
  const r = await checkFreshFactor(user, form, ip);
  if (r === 'locked') return { ok: false, status: 429, error: LOCKED_MESSAGE };
  if (r === 'invalid') return { ok: false, status: 401, error: 'That code or passkey is not valid. Enter a fresh authenticator or recovery code, or confirm with a passkey.' };
  const now = Date.now();
  getDb().prepare('UPDATE sessions SET fresh_at = ? WHERE id = ?').run(now, session.id);
  session.freshAt = now;
  audit('auth.fresh_verified', { userId: user.id, ip, detail: { method: r } });
  return { ok: true };
}
