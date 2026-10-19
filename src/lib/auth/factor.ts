import type { SessionUser } from './session';
import { audit } from './audit';
import { isLocked, recordFailure } from './ratelimit';
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
