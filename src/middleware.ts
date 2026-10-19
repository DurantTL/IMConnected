import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, readSession, touchSession, clearSessionCookie } from './lib/auth/session';

// Runs for every request, including while prerendering public pages at build time. For anything
// outside /admin and /api/admin it returns immediately without touching the database, cookies or headers.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Reachable with no session (sign-in screens and invite links).
const OPEN_PAGES = ['/admin/login', '/admin/invite'];
// Reachable with a first-factor session that hasn't passed 2FA yet.
const MFA_PAGES = ['/admin/login', '/admin/2fa', '/admin/enroll'];
const MFA_API = ['/api/admin/2fa', '/api/admin/enroll', '/api/admin/logout'];
// Sign-in API routes added by later issues (e.g. /api/admin/login) go in this list when they exist.
const OPEN_API: string[] = [];

const under = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(p + '/'));

function guardedKind(path: string): 'page' | 'api' | null {
  if (path === '/admin' || path.startsWith('/admin/')) return 'page';
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return 'api';
  return null;
}

function siteHost(): string | null {
  try {
    return process.env.SITE_URL ? new URL(process.env.SITE_URL).host : null;
  } catch {
    return null;
  }
}

function originOk(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = new Set<string>([url.host]);
  const site = siteHost();
  if (site) allowed.add(site);
  const reqHost = request.headers.get('host');
  if (reqHost) allowed.add(reqHost);
  if (process.env.TRUST_PROXY === 'true') {
    const fwd = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    if (fwd) allowed.add(fwd);
  }
  return allowed.has(host);
}

function harden(res: Response): Response {
  const set = (r: Response) => {
    r.headers.set('Cache-Control', 'no-store');
    r.headers.set('X-Robots-Tag', 'noindex');
    r.headers.set('X-Frame-Options', 'DENY');
    return r;
  };
  try {
    return set(res);
  } catch {
    // Immutable headers (e.g. a redirect built by the framework): copy the response.
    return set(new Response(res.body, res));
  }
}

const redirect = (to: string) => harden(new Response(null, { status: 302, headers: { Location: to } }));
const json = (status: number, error: string) =>
  harden(new Response(JSON.stringify({ ok: false, error }), { status, headers: { 'Content-Type': 'application/json' } }));

export const onRequest = defineMiddleware(async (context, next) => {
  const url = context.url;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const kind = guardedKind(path);
  if (!kind) return next();

  const request = context.request;
  if (!SAFE_METHODS.has(request.method) && !originOk(request, url)) {
    return json(403, 'Cross-origin request blocked.');
  }

  const found = readSession(context.cookies.get(SESSION_COOKIE)?.value);
  if (!found) {
    if (context.cookies.has(SESSION_COOKIE)) clearSessionCookie(context.cookies, url);
    if (under(path, kind === 'page' ? OPEN_PAGES : OPEN_API)) return harden(await next());
    return kind === 'page' ? redirect('/admin/login') : json(401, 'Sign in required.');
  }

  touchSession(found.session);
  context.locals.user = found.user;
  context.locals.session = found.session;

  if (!found.session.mfaPassed && !under(path, kind === 'page' ? MFA_PAGES : MFA_API)) {
    return kind === 'page' ? redirect('/admin/2fa') : json(403, 'Two-factor verification required.');
  }
  return harden(await next());
});
