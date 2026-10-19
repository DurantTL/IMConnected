// Cloudflare Turnstile server-side verification.
const DEFAULT_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const SERVER_SIDE_CODES = new Set(['invalid-input-secret', 'missing-input-secret', 'internal-error']);

export type TurnstileResult = 'skipped' | 'pass' | 'fail' | 'unreachable';

/**
 * Verifies a Turnstile token. 'skipped' when TURNSTILE_SECRET_KEY is unset (local dev).
 * 'unreachable' when Cloudflare can't be reached in 5 s (the caller fails closed).
 * TURNSTILE_VERIFY_URL overrides the endpoint for local testing only.
 */
export async function verifyTurnstile(token: string, ip: string, env = process.env): Promise<TurnstileResult> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return 'skipped';
  if (!token) return 'fail';
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch(env.TURNSTILE_VERIFY_URL || DEFAULT_VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 'unreachable';
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (data.success === true) return 'pass';
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'].filter((c) => typeof c === 'string').slice(0, 10) : [];
    console.warn(`[turnstile] verification failed: ${codes.join(',') || 'no error codes'}`);
    // Our own configuration is wrong, not the visitor: don't blame them.
    if (codes.some((c) => SERVER_SIDE_CODES.has(c))) {
      console.error('[turnstile] Cloudflare rejected the secret or had an internal error: check TURNSTILE_SECRET_KEY');
      return 'unreachable';
    }
    return 'fail';
  } catch {
    return 'unreachable';
  }
}
