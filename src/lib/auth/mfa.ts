import type { SessionUser } from './session';

/**
 * Whether a session that has not passed 2FA may enroll a second factor. Only true for a user with no
 * confirmed second factor yet (first-time enrollment); anyone who has one must verify it instead,
 * otherwise a stolen password could register an attacker's authenticator.
 * Enrollment handlers (issue 2) must call this and must also be listed by exact path in
 * MFA_PAGES / MFA_API in src/middleware.ts.
 */
export function canEnrollWithoutMfa(_user: SessionUser): boolean {
  // TODO(issue 2/7): return true only when the user has no confirmed passkey or TOTP secret.
  // No second-factor tables exist yet, so the set is empty for everyone.
  return true;
}
