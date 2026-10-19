import type { SessionUser } from './session';
import { audit } from './audit';
import { isLocked, recordFailure, releaseAttempt, reserveAttempt } from './ratelimit';
import { finishAuthentication, parseJson } from './passkeys';
import { normalizeRecovery, useRecoveryCode } from './recovery';
import { verifyTotp } from './totp';

export type FactorResult = 'totp' | 'recovery' | 'locked' | 'invalid';

/**
 * Check a TOTP or recovery code for a signed-in user, under the same rate limits as the password
 * step. Records the failure and audit entries. The caller acts on the result (rotate the session etc.).
 */
export function checkSecondFactor(user: SessionUser, input: string, ip: string): FactorResult {
  if (isLocked(ip, user.email)) return 'locked';
  const code = input.trim();
  const compact = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(compact) && verifyTotp(user.id, user.email, compact)) return 'totp';
  if (normalizeRecovery(code) && useRecoveryCode(user.id, code)) {
    audit('auth.recovery_code_used', { userId: user.id, ip });
    return 'recovery';
  }
  recordFailure(ip, user.email);
  audit('auth.2fa_failed', { userId: user.id, ip });
  return 'invalid';
}

export type PasskeyFactorResult = 'passkey' | 'locked' | 'invalid';

/**
 * Check a passkey assertion as a signed-in user's second factor (or as a fresh proof for a sensitive
 * change), under the same rate limits as the other factors. The attempt is counted before the first
 * await and released on success. `purpose` must match the options the browser was given.
 */
export async function checkPasskeyFactor(user: SessionUser, assertion: unknown, purpose: 'second_factor' | 'fresh', ip: string): Promise<PasskeyFactorResult> {
  if (isLocked(ip, user.email)) return 'locked';
  const attempt = reserveAttempt(ip, user.email);
  const res = await finishAuthentication(assertion, purpose, user.id);
  if (res.status === 'ok') {
    releaseAttempt(attempt);
    return 'passkey';
  }
  audit(res.status === 'counter' ? 'auth.passkey_counter_rejected' : 'auth.passkey_failed', { userId: user.id, ip, detail: { reason: res.status, purpose } });
  return 'invalid';
}

/**
 * A fresh second factor for a sensitive change, from a form: a typed authenticator or recovery code, or
 * (when no code was typed) a passkey assertion made for the 'fresh' purpose.
 */
export async function checkFreshFactor(user: SessionUser, form: FormData, ip: string): Promise<FactorResult | PasskeyFactorResult> {
  const read = (name: string, max: number) => {
    const v = form.get(name);
    return typeof v === 'string' && v.length <= max ? v : '';
  };
  const code = read('code', 40);
  const assertion = read('assertion', 20000);
  if (!code.trim() && assertion) return checkPasskeyFactor(user, parseJson(assertion), 'fresh', ip);
  return checkSecondFactor(user, code, ip);
}
