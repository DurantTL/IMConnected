// Pure ID-token claim checks for Google / Microsoft sign-in (issue #11). Plain .mjs with no imports so the test suite can
// load it directly and check the REAL issuer rules (scripts/test-editor-oauth.mjs). Used by src/lib/auth/oauth.ts.
import { timingSafeEqual } from 'node:crypto';

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Microsoft's fixed tenant id for personal accounts (outlook.com, live.com). Never accepted. */
export const PERSONAL_TID = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const microsoftIssuer = (tid) => `https://login.microsoftonline.com/${tid}/v2.0`;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const str = (v) => (typeof v === 'string' ? v : '');
const emailish = (v) => {
  const s = str(v).trim().toLowerCase();
  return s.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(s) ? s : '';
};

/**
 * Whether the ID token proves a provider account and a verified email.
 * `c` = { provider: 'google' | 'microsoft', clientId, tenant (Microsoft: the configured tenant GUID), issuerOverride (tests only, else '') }.
 *  - Both: audience is our client id, not expired, nonce equals the one in the sign-in cookie, issuer is the provider's.
 *  - Google: `email_verified` must be true (boolean or the string "true"); the subject is `sub`.
 *  - Microsoft is single-tenant only: `tid` must equal the configured tenant GUID (never the personal-account tenant) and the
 *    issuer must be https://login.microsoftonline.com/<tid>/v2.0. The address is `email`, else `preferred_username`
 *    (both only from that tenant). The subject is `<tid>:<oid>`.
 * Returns { ok: true, subject, email } or { ok: false, reason: 'claims' | 'tenant' | 'no_email' | 'unverified' }.
 */
export function validateClaims(c, claims, nonce, now = Date.now()) {
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'claims' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(c.clientId)) return { ok: false, reason: 'claims' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return { ok: false, reason: 'claims' };
  if (typeof claims.nonce !== 'string' || !nonce || !safeEqual(claims.nonce, nonce)) return { ok: false, reason: 'claims' };
  const iss = str(claims.iss);

  if (c.provider === 'google') {
    const issuers = c.issuerOverride ? [c.issuerOverride] : GOOGLE_ISSUERS;
    if (!issuers.includes(iss)) return { ok: false, reason: 'claims' };
    const sub = str(claims.sub);
    if (!sub || sub.length > 190) return { ok: false, reason: 'claims' };
    const email = emailish(claims.email);
    if (!email) return { ok: false, reason: 'no_email' };
    if (!(claims.email_verified === true || claims.email_verified === 'true')) return { ok: false, reason: 'unverified' };
    return { ok: true, subject: sub, email };
  }

  const tenant = str(c.tenant).toLowerCase();
  const tid = str(claims.tid).toLowerCase();
  const oid = str(claims.oid).toLowerCase();
  if (!GUID.test(tenant) || tenant === PERSONAL_TID) return { ok: false, reason: 'claims' };
  if (!GUID.test(tid) || !GUID.test(oid)) return { ok: false, reason: 'claims' };
  if (tid === PERSONAL_TID || tid !== tenant) return { ok: false, reason: 'tenant' };
  const expectedIss = c.issuerOverride || microsoftIssuer(tenant);
  if (iss.toLowerCase() !== expectedIss.toLowerCase()) return { ok: false, reason: 'claims' };
  const email = emailish(claims.email) || emailish(claims.preferred_username);
  if (!email) return { ok: false, reason: 'no_email' };
  return { ok: true, subject: `${tid}:${oid}`, email };
}
