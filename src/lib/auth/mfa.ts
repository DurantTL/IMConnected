import type { SessionUser } from './session';
import { hasConfirmedTotp } from './totp';

/**
 * Whether a session that has not passed 2FA may enroll a second factor. Only true for a user with no
 * confirmed second factor yet (first-time enrollment); anyone who has one must verify it instead,
 * otherwise a stolen password could register an attacker's authenticator.
 * Enrollment handlers must call this and must also be listed by exact path in MFA_PAGES / MFA_API in
 * src/middleware.ts. Issue 3 (passkeys) extends this with a "has a passkey" check.
 */
export function canEnrollWithoutMfa(user: SessionUser): boolean {
  return !hasConfirmedTotp(user.id);
}
