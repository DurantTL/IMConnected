import { defineMiddleware } from 'astro:middleware';
import { getDb } from './lib/db';
import { authSecretOk } from './lib/auth/secret';
import { SESSION_COOKIE, readSession, touchSession, clearSessionCookie } from './lib/auth/session';

// Runs for every request, including while prerendering public pages at build time. For anything
// outside /admin and /api/admin it returns immediately without touching the database, cookies or headers.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Reachable with no session. Invite links are exactly /admin/invite/<token> (one segment), so a
// future /admin/invite page (an admin inviting an editor) stays behind sign-in.
const OPEN_PAGES = ['/admin/login'];
const INVITE_PATH = /^\/admin\/invite\/[^/]+$/;
// Reachable with a session that has passed the first factor but not 2FA yet. EXACT paths only: the
// later sign-in issues add theirs one by one (and enrollment handlers must also call canEnrollWithoutMfa).
const MFA_PAGES = ['/admin/login', '/admin/2fa', '/admin/2fa/setup'];
const MFA_API = [
  '/api/admin/logout',
  '/api/admin/passkeys/login/options', // a leftover half-signed-in session must not block a passkey sign-in
  '/api/admin/passkeys/options',
  '/api/admin/passkeys/register/options', // the handler also calls canEnrollWithoutMfa
];
// Sign-in API routes added by later issues (e.g. /api/admin/login) go here by exact path.
// Logout is open so an expired or invalid session can still sign out and be sent to the login page.
const OPEN_API = ['/api/admin/logout', '/api/admin/passkeys/login/options'];

const isOpen = (kind: 'page' | 'api', path: string) =>
  kind === 'page' ? OPEN_PAGES.includes(path) || INVITE_PATH.test(path) : OPEN_API.includes(path);
const mfaPending = (kind: 'page' | 'api', path: string) => (kind === 'page' ? MFA_PAGES.includes(path) : MFA_API.includes(path));

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
  if (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === 'cloudflare') {
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

  // Without AUTH_SECRET (32+ characters) nothing under /admin runs: it protects the stored TOTP secrets.
  if (!authSecretOk()) {
    console.error('[auth] AUTH_SECRET is missing or shorter than 32 characters; /admin is disabled.');
    return kind === 'api'
      ? json(503, 'The editor dashboard is not configured.')
      : harden(
          new Response(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Editors unavailable</title><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1>Editor dashboard not configured</h1><p>The server is missing its AUTH_SECRET setting. The public site is not affected. Please tell the site administrator.</p></body>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          ),
        );
  }

  // A broken database must only take /admin down, never the public site.
  try {
    getDb();
  } catch (err) {
    console.error('[db] unavailable:', err instanceof Error ? err.message : err);
    return kind === 'api'
      ? json(503, 'The editor dashboard is temporarily unavailable.')
      : harden(
          new Response(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Editors unavailable</title><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1>Editor dashboard unavailable</h1><p>The editor database could not be opened. The public site is not affected. Please tell the site administrator.</p></body>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          ),
        );
  }

  const request = context.request;
  if (!SAFE_METHODS.has(request.method) && !originOk(request, url)) {
    return json(403, 'Cross-origin request blocked.');
  }

  const found = readSession(context.cookies.get(SESSION_COOKIE)?.value);
  if (!found) {
    if (context.cookies.has(SESSION_COOKIE)) clearSessionCookie(context.cookies);
    if (isOpen(kind, path)) return harden(await next());
    return kind === 'page' ? redirect('/admin/login') : json(401, 'Sign in required.');
  }

  touchSession(found.session);
  context.locals.user = found.user;
  context.locals.session = found.session;

  if (!found.session.mfaPassed && !mfaPending(kind, path)) {
    return kind === 'page' ? redirect('/admin/2fa') : json(403, 'Two-factor verification required.');
  }
  return harden(await next());
});
