// Cloudflare Turnstile server-side verification.
const DEFAULT_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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
    const data = (await res.json()) as { success?: boolean };
    return data.success === true ? 'pass' : 'fail';
  } catch {
    return 'unreachable';
  }
}
