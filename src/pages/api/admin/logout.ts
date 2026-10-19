import type { APIRoute } from 'astro';
import { SESSION_COOKIE, readSession, revokeSession, clearSessionCookie } from '../../../lib/auth/session';
import { audit } from '../../../lib/auth/audit';

export const prerender = false;

// Middleware has already checked the session (when one exists) and the Origin.
export const POST: APIRoute = ({ cookies, locals, url, clientAddress }) => {
  const token = cookies.get(SESSION_COOKIE)?.value;
  const found = readSession(token);
  if (found) {
    revokeSession(found.session.id);
    audit('auth.logout', { userId: found.user.id, ip: clientAddress });
  }
  clearSessionCookie(cookies, url);
  return new Response(null, { status: 303, headers: { Location: '/admin/login', 'Cache-Control': 'no-store' } });
};
