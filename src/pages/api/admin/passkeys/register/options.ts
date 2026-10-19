import type { APIRoute } from 'astro';
import { canEnrollWithoutMfa } from '../../../../../lib/auth/mfa';
import { passkeysEnabled, registrationOptions } from '../../../../../lib/auth/passkeys';
import { audit } from '../../../../../lib/auth/audit';
import { clientIp } from '../../../../../lib/request';

export const prerender = false;

// Options to register a passkey. Allowed for a fully signed-in user, or for a first-time enrollment
// (password step done, no second factor yet). Anyone else with only a password is refused, so a stolen
// password can't plant a passkey. The actual registration is verified by the page that receives it.
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ locals, request, clientAddress }) => {
  const user = locals.user;
  const session = locals.session;
  if (!user || !session) return reply(401, { ok: false, error: 'Sign in required.' });
  if (!passkeysEnabled()) return reply(503, { ok: false, error: 'Passkeys are not available on this site.' });
  if (!session.mfaPassed && !canEnrollWithoutMfa(user)) {
    audit('auth.enroll_refused', { userId: user.id, ip: clientIp(request, clientAddress), detail: { factor: 'passkey' } });
    return reply(403, { ok: false, error: 'Two-factor is already set up for this account.' });
  }
  const options = await registrationOptions(user);
  return options ? reply(200, { ok: true, options }) : reply(503, { ok: false, error: 'Passkeys are not available right now.' });
};
