import type { APIRoute } from 'astro';
import { SESSION_COOKIE, readSession, revokeSession, clearSessionCookie } from '../../../lib/auth/session';
import { audit } from '../../../lib/auth/audit';
import { clientIp } from '../../../lib/request';

export const prerender = false;

// Open in the middleware (Origin is still checked) so an expired session can sign out too.
export const POST: APIRoute = ({ cookies, request, clientAddress }) => {
  const found = readSession(cookies.get(SESSION_COOKIE)?.value);
  if (found) {
    revokeSession(found.session.id);
    audit('auth.logout', { userId: found.user.id, ip: clientIp(request, clientAddress) });
  }
  clearSessionCookie(cookies);
  return new Response(null, { status: 303, headers: { Location: '/admin/login', 'Cache-Control': 'no-store' } });
};
