import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { getDb } from '../db';
import { signToken, verifyToken } from './secret';
import { GUID, PERSONAL_TID, validateClaims as checkClaims } from './oauth-claims.mjs';

// Google and Microsoft 365 sign-in (issue #11), invite-only. This module holds the provider configuration, the
// short-lived state cookie, the code exchange (node:crypto + fetch only, no OAuth library, like src/lib/db/gdrive.mjs),
// the claim-check wrapper (the pure rules are in oauth-claims.mjs) and the link table helpers. The routes are
// src/pages/admin/oauth/[provider]/index.ts (start) and callback.ts (which also holds the invite-only matching).
// Nothing here ever logs or stores a token, a code or a client secret; the PKCE verifier lives only in the state cookie.

export type Provider = 'google' | 'microsoft';
export const PROVIDERS: Provider[] = ['google', 'microsoft'];
export const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft 365' };
export const isProvider = (v: unknown): v is Provider => v === 'google' || v === 'microsoft';

export const OAUTH_COOKIE = '__Host-imc_oauth';
export const OAUTH_COOKIE_MS = 10 * 60 * 1000;
export const SCOPES = ['openid', 'email', 'profile'];

// ---- configuration ----

const env = (n: string) => (process.env[n] || '').trim();

/** An endpoint must be https, or http on a loopback host (tests); anything else is never contacted. */
export function safeEndpoint(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Endpoint overrides exist ONLY so tests can point at scripts/mock-oidc.mjs. Under NODE_ENV=production they are ignored
 * unless OAUTH_TEST_ENDPOINTS=1 is also set (tests only; never documented for a real site), and an override that is not
 * https or loopback http makes the provider unconfigured.
 */
const OVERRIDE_VARS = [
  'OAUTH_GOOGLE_AUTH_URL', 'OAUTH_GOOGLE_TOKEN_URL', 'OAUTH_GOOGLE_ISSUER',
  'OAUTH_MICROSOFT_AUTH_URL', 'OAUTH_MICROSOFT_TOKEN_URL', 'OAUTH_MICROSOFT_ISSUER',
];
export const overridesInUse = (): string[] => OVERRIDE_VARS.filter((n) => env(n));
const overridesAllowed = () => process.env.NODE_ENV !== 'production' || env('OAUTH_TEST_ENDPOINTS') === '1';

/** '' = no override (use the real endpoint); null = an override that is not allowed (provider off); else the URL. */
function override(name: string): string | null {
  const v = env(name);
  if (!v || !overridesAllowed()) return '';
  return safeEndpoint(v) ? v : null;
}

let warned = false;
/** Once per process, at startup: test overrides in production, and a Microsoft setup that is switched off. No secrets. */
export function warnIfOverridden(): void {
  if (warned) return;
  warned = true;
  const used = overridesInUse();
  if (used.length && process.env.NODE_ENV === 'production') {
    console.warn(
      overridesAllowed()
        ? `[oauth] WARNING: ${used.join(', ')} ${used.length > 1 ? 'are' : 'is'} set with OAUTH_TEST_ENDPOINTS=1 under NODE_ENV=production, so sign-in talks to a test endpoint. These are for tests only; unset them on a real site.`
        : `[oauth] WARNING: ${used.join(', ')} ${used.length > 1 ? 'are' : 'is'} set under NODE_ENV=production and ${used.length > 1 ? 'are' : 'is'} ignored (test-only settings). Unset ${used.length > 1 ? 'them' : 'it'}.`,
    );
  }
  if ((env('MICROSOFT_CLIENT_ID') || env('MICROSOFT_CLIENT_SECRET')) && microsoftTenant() === null) {
    console.warn('[oauth] Microsoft sign-in is OFF: MICROSOFT_TENANT_ID must be your tenant (directory) id, a GUID. organizations, common, consumers and an empty value are not supported.');
  }
}

function siteOrigin(): string | null {
  try {
    return new URL(process.env.SITE_URL || '').origin;
  } catch {
    return null;
  }
}

/** The configured Microsoft tenant GUID (lower case), or null: Microsoft is single-tenant only. */
export function microsoftTenant(): string | null {
  const t = env('MICROSOFT_TENANT_ID').toLowerCase();
  return GUID.test(t) && t !== PERSONAL_TID ? t : null;
}

export interface ProviderConfig {
  provider: Provider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  /** The Microsoft tenant GUID; empty for Google. */
  tenant: string;
  /** Set only by the test override. */
  issuerOverride: string;
}

/** The provider's settings, or null when its env vars are missing, SITE_URL is unusable, an override is refused or (Microsoft) no tenant GUID is set. */
export function providerConfig(provider: Provider): ProviderConfig | null {
  const origin = siteOrigin();
  if (!origin) return null;
  const authO = override(provider === 'google' ? 'OAUTH_GOOGLE_AUTH_URL' : 'OAUTH_MICROSOFT_AUTH_URL');
  const tokenO = override(provider === 'google' ? 'OAUTH_GOOGLE_TOKEN_URL' : 'OAUTH_MICROSOFT_TOKEN_URL');
  const issuerO = override(provider === 'google' ? 'OAUTH_GOOGLE_ISSUER' : 'OAUTH_MICROSOFT_ISSUER');
  if (authO === null || tokenO === null || issuerO === null) return null;
  if (provider === 'google') {
    const clientId = env('GOOGLE_CLIENT_ID');
    const clientSecret = env('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) return null;
    return {
      provider, clientId, clientSecret, tenant: '',
      redirectUri: `${origin}/admin/oauth/google/callback`,
      authUrl: authO || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: tokenO || 'https://oauth2.googleapis.com/token',
      issuerOverride: issuerO,
    };
  }
  const clientId = env('MICROSOFT_CLIENT_ID');
  const clientSecret = env('MICROSOFT_CLIENT_SECRET');
  const tenant = microsoftTenant();
  if (!clientId || !clientSecret || !tenant) return null;
  return {
    provider, clientId, clientSecret, tenant,
    redirectUri: `${origin}/admin/oauth/microsoft/callback`,
    authUrl: authO || `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: tokenO || `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    issuerOverride: issuerO,
  };
}

export const enabledProviders = (): Provider[] => PROVIDERS.filter((p) => providerConfig(p) !== null);

// ---- the state cookie ----

/**
 * The flow cookie's payload, signed with signToken() (so it can't be forged or altered by the holder). `i` is the intent: 'login'
 * (sign-in start) or 'link' (an editor linking a provider from My account), where `u` is the editor's user id and `s` a hash of the
 * session that started it (sessionBinding()); the callback needs the same user AND the same session.
 */
interface Pending { p: Provider; state: string; verifier: string; nonce: string; exp: number; i: 'login' | 'link'; u?: number; s?: string }
export type FlowIntent = { intent: 'login' } | { intent: 'link'; uid: number; sid: string };
const FLOW_PURPOSE = 'oauth-flow v1';

/** What a link cookie is bound to: a hash of the session's id (itself the SHA-256 of the session token); never the token. */
export const sessionBinding = (sessionId: string): string => createHash('sha256').update(`oauth-link ${sessionId}`).digest('base64url');

// SameSite=Lax (not Strict): the provider sends the browser back with a cross-site top-level GET, which must carry it.
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

const random = () => randomBytes(32).toString('base64url');

/**
 * Start a flow: store state, the PKCE verifier and a nonce in the 10-minute cookie and return the provider URL to redirect to:
 * response_type=code, client_id, redirect_uri, scope "openid email profile", state, nonce, code_challenge (S256) and
 * prompt=select_account. The client secret is never in this URL.
 */
export function beginFlow(c: ProviderConfig, cookies: AstroCookies, intent: FlowIntent = { intent: 'login' }): string {
  const state = random();
  const verifier = random();
  const nonce = random();
  const pending: Pending = { p: c.provider, state, verifier, nonce, exp: Date.now() + OAUTH_COOKIE_MS, i: intent.intent, ...(intent.intent === 'link' ? { u: intent.uid, s: intent.sid } : {}) };
  cookies.set(OAUTH_COOKIE, signToken(FLOW_PURPOSE, pending), { ...cookieOptions, maxAge: OAUTH_COOKIE_MS / 1000 });
  const url = new URL(c.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', c.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account'); // both providers: always let the person pick the account
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

/**
 * Read and validate the cookie against the `state` the provider returned. The cookie is single use: callers clear it. An unsigned,
 * altered or wrongly-signed cookie is treated exactly like a missing one ('missing': nothing counted, nothing audited).
 */
export function readFlow(cookies: AstroCookies, provider: Provider, returnedState: string): ({ verifier: string; nonce: string } & ({ intent: 'login' } | { intent: 'link'; uid: number; sid: string })) | 'missing' | 'expired' | 'mismatch' {
  const raw = cookies.get(OAUTH_COOKIE)?.value;
  if (!raw || raw.length > 1200) return 'missing';
  let pending: Pending;
  try {
    const v = verifyToken(FLOW_PURPOSE, raw) as Pending | null;
    if (!v) return 'missing';
    pending = v;
  } catch {
    return 'missing'; // no AUTH_SECRET: nothing under /admin runs anyway
  }
  if (typeof pending.state !== 'string' || typeof pending.verifier !== 'string' || typeof pending.nonce !== 'string' || typeof pending.exp !== 'number') return 'mismatch';
  if (pending.exp < Date.now()) return 'expired';
  if (pending.p !== provider || !returnedState || !safeEqual(pending.state, returnedState)) return 'mismatch';
  if (pending.i === 'link') {
    if (!Number.isInteger(pending.u) || (pending.u as number) < 1 || typeof pending.s !== 'string' || !pending.s) return 'mismatch';
    return { verifier: pending.verifier, nonce: pending.nonce, intent: 'link', uid: pending.u as number, sid: pending.s };
  }
  if (pending.i !== 'login') return 'mismatch';
  return { verifier: pending.verifier, nonce: pending.nonce, intent: 'login' };
}

// ---- code exchange and claims ----

export interface Claims {
  iss?: unknown; aud?: unknown; exp?: unknown; nonce?: unknown; sub?: unknown;
  email?: unknown; email_verified?: unknown; preferred_username?: unknown; tid?: unknown; oid?: unknown;
}

const MAX_TOKEN_RESPONSE = 100_000; // bytes

/** Base64url-decode an ID token's payload. No signature check: see exchangeCode(). */
export function decodeIdTokenPayload(idToken: string): Claims | null {
  const parts = idToken.split('.');
  if (parts.length !== 3 || idToken.length > 12_000) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Claims) : null;
  } catch {
    return null;
  }
}

/** Read a response body with a running byte limit; null when it is over the limit. */
async function readLimited(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Exchange the code at the token endpoint: POST over HTTPS (or loopback http in tests), form body with grant_type, code,
 * redirect_uri, the PKCE code_verifier and the client id and secret (client_secret_post; never in a URL), no redirects, 10 second timeout for the whole response, body capped at 100 KB (Content-Length first,
 * then a running count of the DECODED bytes, so a compressed response can't get past it). The ID token's payload is read from that response; it comes straight from the provider over TLS in
 * answer to our authenticated request, so its signature is not re-checked (OpenID Connect Core 3.1.3.7); issuer, audience,
 * expiry and nonce are checked in validateClaims(). Returns null on any failure and never surfaces the provider's body.
 */
export async function exchangeCode(c: ProviderConfig, code: string, verifier: string): Promise<Claims | null> {
  if (!safeEndpoint(c.tokenUrl)) return null;
  try {
    // client_secret_post: the client id and secret travel in the form body (Google and Entra both accept it), so there is no Basic
    // header and no encoding step to get wrong (Entra secrets contain `~`).
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, code_verifier: verifier, client_id: c.clientId, client_secret: c.clientSecret });
    const res = await fetch(c.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const text = await readLimited(res, MAX_TOKEN_RESPONSE);
    if (text === null) return null;
    const data = JSON.parse(text) as { id_token?: unknown };
    return typeof data.id_token === 'string' ? decodeIdTokenPayload(data.id_token) : null;
  } catch {
    return null;
  }
}

export type ClaimResult = { ok: true; subject: string; email: string } | { ok: false; reason: 'claims' | 'tenant' | 'no_email' | 'unverified' };

/** The claim rules (audience, expiry, nonce, issuer, verified email, Microsoft tenant) are in oauth-claims.mjs. */
export const validateClaims = (c: ProviderConfig, claims: Claims | null, nonce: string, now = Date.now()): ClaimResult => checkClaims(c, claims, nonce, now) as ClaimResult;

// ---- links ----

export interface LinkRow { id: number; provider: Provider; email_at_link: string; created_at: number }

export function listLinks(userId: number): LinkRow[] {
  return getDb().prepare('SELECT id, provider, email_at_link, created_at FROM oauth_accounts WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as LinkRow[];
}

/** First-factor methods the user has besides the given provider's link: a password, a passkey (when passkeys work here) or another configured provider. */
export function otherFirstFactors(userId: number, exceptProvider: Provider, passkeysOn: boolean): number {
  const db = getDb();
  let n = 0;
  if (db.prepare('SELECT 1 FROM password_credentials WHERE user_id = ?').get(userId)) n++;
  if (passkeysOn && db.prepare('SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1').get(userId)) n++;
  const enabled = new Set(enabledProviders());
  for (const l of listLinks(userId)) if (l.provider !== exceptProvider && enabled.has(l.provider)) n++;
  return n;
}
