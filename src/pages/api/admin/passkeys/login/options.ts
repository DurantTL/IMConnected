import type { APIRoute } from 'astro';
import { authenticationOptions, passkeysEnabled } from '../../../../../lib/auth/passkeys';
import { isIpLocked } from '../../../../../lib/auth/ratelimit';
import { clientIp } from '../../../../../lib/request';

export const prerender = false;

// Open (no session): options for the passwordless "Sign in with a passkey" ceremony. Discoverable
// credentials, so the list of allowed credentials is empty and nothing here depends on who is asking.
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!passkeysEnabled()) return reply(503, { ok: false, error: 'Passkeys are not available on this site.' });
  if (isIpLocked(clientIp(request, clientAddress))) return reply(429, { ok: false, error: 'Too many attempts. Please wait 15 minutes and try again.' });
  const options = await authenticationOptions('login', null);
  return options ? reply(200, { ok: true, options }) : reply(429, { ok: false, error: 'Busy. Please try again in a few minutes.' });
};
