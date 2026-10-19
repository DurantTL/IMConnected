import type { APIRoute } from 'astro';
import { authenticationOptions, passkeysEnabled } from '../../../../lib/auth/passkeys';

export const prerender = false;

// For a signed-in user (password step done): options to prove a second factor with one of their own
// passkeys. Before 2FA this is the sign-in second factor; after it, a fresh proof for a sensitive change.
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ locals }) => {
  const user = locals.user;
  const session = locals.session;
  if (!user || !session) return reply(401, { ok: false, error: 'Sign in required.' });
  if (!passkeysEnabled()) return reply(503, { ok: false, error: 'Passkeys are not available on this site.' });
  const options = await authenticationOptions(session.mfaPassed ? 'fresh' : 'second_factor', user.id);
  return options ? reply(200, { ok: true, options }) : reply(404, { ok: false, error: 'No passkey is registered for this account.' });
};
