import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { CodeChallengeMethod, OAuth2Client, decodeIdToken, generateCodeVerifier, generateState } from 'arctic';
import { getDb } from '../db';

// Google and Microsoft 365 sign-in (issue #11), invite-only. This module holds the provider configuration, the
// short-lived state cookie, the ID-token claim checks and the link table helpers. The routes are
// src/pages/admin/oauth/[provider]/index.ts (start) and callback.ts (which also holds the invite-only matching). Nothing here ever logs or stores a token, a code, a client secret or a PKCE verifier beyond the cookie.

export type Provider = 'google' | 'microsoft';
export const PROVIDERS: Provider[] = ['google', 'microsoft'];
export const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft 365' };
export const isProvider = (v: unknown): v is Provider => v === 'google' || v === 'microsoft';

export const OAUTH_COOKIE = '__Host-imc_oauth';
export const OAUTH_COOKIE_MS = 10 * 60 * 1000;
export const SCOPES = ['openid', 'email', 'profile'];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- configuration ----

/**
 * Endpoint overrides exist ONLY so tests can point at scripts/mock-oidc.mjs. They are never documented as a setting for
 * a real site, and a warning is logged at startup when one is set under NODE_ENV=production.
 */
const OVERRIDE_VARS = [
  'OAUTH_GOOGLE_AUTH_URL', 'OAUTH_GOOGLE_TOKEN_URL', 'OAUTH_GOOGLE_ISSUER',
  'OAUTH_MICROSOFT_AUTH_URL', 'OAUTH_MICROSOFT_TOKEN_URL', 'OAUTH_MICROSOFT_ISSUER',
];
export function overridesInUse(): string[] {
  return OVERRIDE_VARS.filter((n) => (process.env[n] || '').trim());
}
let warned = false;
export function warnIfOverridden(): void {
  if (warned) return;
  warned = true;
  const used = overridesInUse();
  if (used.length && process.env.NODE_ENV === 'production') {
    console.warn(`[oauth] WARNING: ${used.join(', ')} ${used.length > 1 ? 'are' : 'is'} set while NODE_ENV=production. These overrides are for tests only; unset them so sign-in talks to the real Google and Microsoft endpoints.`);
  }
}

function siteOrigin(): string | null {
  try {
    return new URL(process.env.SITE_URL || '').origin;
  } catch {
    return null;
  }
}

export interface ProviderConfig {
  provider: Provider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  /** The tenant for Microsoft (`organizations` by default); empty for Google. */
  tenant: string;
  /** Set only by the test override. */
  issuerOverride: string;
}

const env = (n: string) => (process.env[n] || '').trim();

/** The provider's settings, or null when its env vars are missing, SITE_URL is unusable or (Microsoft) the tenant is `consumers`. */
export function providerConfig(provider: Provider): ProviderConfig | null {
  const origin = siteOrigin();
  if (!origin) return null;
  if (provider === 'google') {
    const clientId = env('GOOGLE_CLIENT_ID');
    const clientSecret = env('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) return null;
    return {
      provider, clientId, clientSecret, tenant: '',
      redirectUri: `${origin}/admin/oauth/google/callback`,
      authUrl: env('OAUTH_GOOGLE_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env('OAUTH_GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token',
      issuerOverride: env('OAUTH_GOOGLE_ISSUER'),
    };
  }
  const clientId = env('MICROSOFT_CLIENT_ID');
  const clientSecret = env('MICROSOFT_CLIENT_SECRET');
  const tenant = env('MICROSOFT_TENANT_ID') || 'organizations';
  if (!clientId || !clientSecret) return null;
  if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant) || tenant.toLowerCase() === 'consumers') return null; // personal accounts are not supported
  return {
    provider, clientId, clientSecret, tenant,
    redirectUri: `${origin}/admin/oauth/microsoft/callback`,
    authUrl: env('OAUTH_MICROSOFT_AUTH_URL') || `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: env('OAUTH_MICROSOFT_TOKEN_URL') || `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    issuerOverride: env('OAUTH_MICROSOFT_ISSUER'),
  };
}

export const enabledProviders = (): Provider[] => PROVIDERS.filter((p) => providerConfig(p) !== null);

const client = (c: ProviderConfig) => new OAuth2Client(c.clientId, c.clientSecret, c.redirectUri);

// ---- the state cookie ----

interface Pending { p: Provider; state: string; verifier: string; nonce: string; exp: number }

// SameSite=Lax (not Strict): the provider sends the browser back with a cross-site top-level GET, which must carry it.
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

/** Start a flow: store state, the PKCE verifier and a nonce in the 10-minute cookie, return the provider URL to redirect to. */
export function beginFlow(c: ProviderConfig, cookies: AstroCookies): string {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const nonce = randomBytes(24).toString('base64url');
  const pending: Pending = { p: c.provider, state, verifier, nonce, exp: Date.now() + OAUTH_COOKIE_MS };
  cookies.set(OAUTH_COOKIE, Buffer.from(JSON.stringify(pending)).toString('base64url'), { ...cookieOptions, maxAge: OAUTH_COOKIE_MS / 1000 });
  const url = client(c).createAuthorizationURLWithPKCE(c.authUrl, state, CodeChallengeMethod.S256, verifier, SCOPES);
  url.searchParams.set('nonce', nonce);
  if (c.provider === 'google') url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export function clearFlowCookie(cookies: AstroCookies): void {
  cookies.set(OAUTH_COOKIE, '', { ...cookieOptions, maxAge: 0 });
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Read and validate the cookie against the `state` the provider returned. The cookie is single use: callers clear it. */
export function readFlow(cookies: AstroCookies, provider: Provider, returnedState: string): { verifier: string; nonce: string } | 'missing' | 'expired' | 'mismatch' {
  const raw = cookies.get(OAUTH_COOKIE)?.value;
  if (!raw || raw.length > 1000) return 'missing';
  let pending: Pending;
  try {
    pending = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return 'mismatch';
  }
  if (!pending || typeof pending.state !== 'string' || typeof pending.verifier !== 'string' || typeof pending.nonce !== 'string' || typeof pending.exp !== 'number') return 'mismatch';
  if (pending.exp < Date.now()) return 'expired';
  if (pending.p !== provider || !returnedState || !safeEqual(pending.state, returnedState)) return 'mismatch';
  return { verifier: pending.verifier, nonce: pending.nonce };
}

// ---- code exchange and claims ----

export interface Claims {
  iss?: unknown; aud?: unknown; exp?: unknown; nonce?: unknown; sub?: unknown;
  email?: unknown; email_verified?: unknown; preferred_username?: unknown; tid?: unknown; oid?: unknown;
}

/**
 * Exchange the code (PKCE verifier included) and read the ID token's claims. The ID token comes straight from the token
 * endpoint over TLS in answer to our authenticated request, so its signature is not re-checked (OpenID Connect Core 3.1.3.7);
 * issuer, audience, expiry and nonce are checked in validateClaims().
 */
export async function exchangeCode(c: ProviderConfig, code: string, verifier: string): Promise<Claims | null> {
  try {
    const tokens = await client(c).validateAuthorizationCode(c.tokenUrl, code, verifier);
    return decodeIdToken(tokens.idToken()) as Claims;
  } catch {
    return null; // never surface the provider's error body: it can echo the code
  }
}

export type ClaimResult = { ok: true; subject: string; email: string } | { ok: false; reason: 'claims' | 'tenant' | 'no_email' | 'unverified' };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const emailish = (v: unknown): string => {
  const s = str(v).trim().toLowerCase();
  return s.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(s) ? s : '';
};

/**
 * Whether the ID token proves a provider account and a verified email.
 *  - All: audience is our client id, not expired, nonce equals the one in the cookie, issuer is the provider's.
 *  - Google: `email_verified` must be true (boolean or the string "true"); the subject is `sub`.
 *  - Microsoft, a specific tenant id (a GUID): `tid` must equal it; the address is `email`, else `preferred_username`.
 *  - Microsoft, `organizations` or `common` (or a tenant given as a domain): the `email` claim is required;
 *    `preferred_username` is never used because any tenant can set it to anything. The subject is `<tid>:<oid>`.
 */
export function validateClaims(c: ProviderConfig, claims: Claims | null, nonce: string, now = Date.now()): ClaimResult {
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'claims' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(c.clientId)) return { ok: false, reason: 'claims' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return { ok: false, reason: 'claims' };
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) return { ok: false, reason: 'claims' };
  const iss = str(claims.iss);

  if (c.provider === 'google') {
    const issuers = c.issuerOverride ? [c.issuerOverride] : ['https://accounts.google.com', 'accounts.google.com'];
    if (!issuers.includes(iss)) return { ok: false, reason: 'claims' };
    const sub = str(claims.sub);
    if (!sub || sub.length > 190) return { ok: false, reason: 'claims' };
    const email = emailish(claims.email);
    if (!email) return { ok: false, reason: 'no_email' };
    if (!(claims.email_verified === true || claims.email_verified === 'true')) return { ok: false, reason: 'unverified' };
    return { ok: true, subject: sub, email };
  }

  const tid = str(claims.tid).toLowerCase();
  const oid = str(claims.oid).toLowerCase();
  if (!GUID.test(tid) || !GUID.test(oid)) return { ok: false, reason: 'claims' };
  const expectedIss = c.issuerOverride || `https://login.microsoftonline.com/${tid}/v2.0`;
  if (iss.toLowerCase() !== expectedIss.toLowerCase()) return { ok: false, reason: 'claims' };
  let email: string;
  if (GUID.test(c.tenant)) {
    if (tid !== c.tenant.toLowerCase()) return { ok: false, reason: 'tenant' };
    email = emailish(claims.email) || emailish(claims.preferred_username);
  } else {
    email = emailish(claims.email);
  }
  if (!email) return { ok: false, reason: 'no_email' };
  return { ok: true, subject: `${tid}:${oid}`, email };
}

// ---- links ----

export interface LinkRow { id: number; provider: Provider; email_at_link: string; created_at: number }

export function listLinks(userId: number): LinkRow[] {
  return getDb().prepare('SELECT id, provider, email_at_link, created_at FROM oauth_accounts WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as LinkRow[];
}

/** First-factor methods the user has besides the given link: a password, a passkey (when passkeys work here) or another configured provider. */
export function otherFirstFactors(userId: number, exceptProvider: Provider, passkeysOn: boolean): number {
  const db = getDb();
  let n = 0;
  if (db.prepare('SELECT 1 FROM password_credentials WHERE user_id = ?').get(userId)) n++;
  if (passkeysOn && db.prepare('SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1').get(userId)) n++;
  const enabled = new Set(enabledProviders());
  for (const l of listLinks(userId)) if (l.provider !== exceptProvider && enabled.has(l.provider)) n++;
  return n;
}
