#!/usr/bin/env node
// End-to-end check of Google / Microsoft 365 sign-in (issue #11) against the BUILT server (dist/server/entry.mjs), the local
// mock OpenID Connect provider scripts/mock-oidc.mjs and a throwaway data folder.
//   npm run build
//   DATA_DIR=/tmp/imc-oauth node scripts/test-editor-oauth.mjs
// The script starts and stops: the mock provider (MOCK_OIDC_PORT, default 4417), a server (PORT, default 4398) whose Microsoft
// tenant is a specific tenant id, and a second server (PORT + 1) on the same data whose tenant is "organizations". The
// OAUTH_* endpoint overrides below are for this test only; they are set with NODE_ENV=production on purpose, to check the
// startup warning. All names, addresses and secrets are made up; no real Google or Microsoft endpoint is contacted.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to a throwaway data folder (it is created if missing).');
const DATA_DIR = path.resolve(process.env.DATA_DIR);
const PORT = Number(process.env.PORT || 4398);
const PORT2 = PORT + 1;
const OIDC_PORT = Number(process.env.MOCK_OIDC_PORT || 4417);
const BASE = `http://localhost:${PORT}`;
const BASE2 = `http://localhost:${PORT2}`;
const OIDC = `http://localhost:${OIDC_PORT}`;
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');
const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER_TENANT = '99999999-8888-4777-8666-555555555555';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};
const q = (sql, ...args) => {
  const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000');
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};
const run = (sql, ...args) => {
  const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000');
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
};
const count = (sql, ...args) => Number(q(sql, ...args)[0].n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const totp = (secret, offset = 0) =>
  new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + offset * 30000 });

// A cookie jar by hand (the cookies are Secure, which fetch over http would not keep) that also remembers raw Set-Cookie lines.
class Client {
  constructor(ip, base = BASE) { this.ip = ip; this.base = base; this.jar = {}; this.setCookies = []; }
  get cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, url, form) {
    const headers = { Origin: this.base, 'X-Forwarded-For': this.ip };
    if (this.cookie) headers.Cookie = this.cookie;
    let body;
    if (form) { body = new URLSearchParams(form); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(url.startsWith('http') ? url : this.base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      this.setCookies.push(c);
      const [pair] = c.split(';');
      const k = pair.slice(0, pair.indexOf('=')), v = pair.slice(pair.indexOf('=') + 1);
      if (v) this.jar[k] = v; else delete this.jar[k];
    }
    const text = await res.text();
    return {
      status: res.status, loc: res.headers.get('location'), text,
      error: unesc((/class="admin-error"[^>]*>([^<]*)</.exec(text) || [])[1] || ''),
      ok: unesc((/class="admin-ok"[^>]*>([^<]*)</.exec(text) || [])[1] || ''),
    };
  }
  get(u) { return this.req('GET', u); }
  post(u, f) { return this.req('POST', u, f); }
  hasSession() { return '__Host-imc_session' in this.jar; }
}

// ---- processes ----
const children = [];
let serverLog = '';
function start(args, env, onLine) {
  const child = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const feed = (d) => String(d).split('\n').filter(Boolean).forEach(onLine);
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  children.push(child);
  return child;
}
const stopAll = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stopAll);

function assertThrowaway(dir) {
  const real = path.resolve(dir);
  const roots = [os.tmpdir(), '/tmp'].map((r) => path.resolve(r) + path.sep);
  if (real === '/data' || real.startsWith('/data' + path.sep) || !roots.some((r) => real.startsWith(r) && real.length > r.length)) {
    throw new Error(`Refusing to delete ${real}: point this at a throwaway folder under ${os.tmpdir()}.`);
  }
}
assertThrowaway(DATA_DIR);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// An invited editor through the normal bootstrap (also applies the migrations), more rows by SQL.
const INVITEE = 'ivy.invited@example.test';
execFileSync('node', ['scripts/create-admin.mjs', INVITEE, 'Ivy Invited'], { env: { ...process.env, DATA_DIR } });
const addUser = (email, name, status, role = 'editor') => {
  const now = Date.now();
  run('INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', email, name, role, status, now, now);
  return q('SELECT id FROM users WHERE email = ?', email)[0].id;
};
const UNVERIFIED = 'una.unverified@example.test';
const TAMPER = 'tam.tamper@example.test';
const DISABLED = 'dee.disabled@example.test';
const MSONLY = 'mo.micro@example.test';
const ORGUSER = 'orla.org@example.test';
addUser(UNVERIFIED, 'Una Unverified', 'invited');
addUser(TAMPER, 'Tam Tamper', 'invited');
const disabledId = addUser(DISABLED, 'Dee Disabled', 'disabled');
addUser(MSONLY, 'Mo Micro', 'invited');
addUser(ORGUSER, 'Orla Org', 'invited');
const pre = { users: count('SELECT COUNT(*) n FROM users') };

const baseEnv = {
  DATA_DIR, HOST: '127.0.0.1', AUTH_SECRET: 'e2e-oauth-secret-0123456789abcdefghijkl', TRUST_PROXY: 'true', NODE_ENV: 'production',
  GOOGLE_CLIENT_ID: 'mock-google-client', GOOGLE_CLIENT_SECRET: 'mock-google-secret',
  MICROSOFT_CLIENT_ID: 'mock-ms-client', MICROSOFT_CLIENT_SECRET: 'mock-ms-secret',
  OAUTH_GOOGLE_AUTH_URL: `${OIDC}/google/authorize`, OAUTH_GOOGLE_TOKEN_URL: `${OIDC}/google/token`, OAUTH_GOOGLE_ISSUER: `${OIDC}/google`,
  OAUTH_MICROSOFT_AUTH_URL: `${OIDC}/microsoft/authorize`, OAUTH_MICROSOFT_TOKEN_URL: `${OIDC}/microsoft/token`, OAUTH_MICROSOFT_ISSUER: `${OIDC}/microsoft`,
};
start(['scripts/mock-oidc.mjs'], { MOCK_OIDC_PORT: String(OIDC_PORT) }, () => {});
start(['dist/server/entry.mjs'], { ...baseEnv, PORT: String(PORT), SITE_URL: BASE, MICROSOFT_TENANT_ID: TENANT }, (l) => { serverLog += l + '\n'; });
start(['dist/server/entry.mjs'], { ...baseEnv, PORT: String(PORT2), SITE_URL: BASE2 }, (l) => { serverLog += l + '\n'; });
for (let i = 0; i < 80; i++) {
  try { await fetch(BASE + '/admin/login', { redirect: 'manual' }); await fetch(BASE2 + '/admin/login', { redirect: 'manual' }); await fetch(OIDC + '/__log'); break; } catch { await sleep(250); }
}

const setIdentity = (id) => fetch(OIDC + '/__identity', { method: 'POST', body: JSON.stringify(id) });
const googleId = (email, extra = {}) => ({ email, email_verified: true, sub: 'g-' + email, ...extra });
const msId = (email, extra = {}) => ({ email, tid: TENANT, oid: OID, ...extra });

/** Plays the browser: start link, provider, callback. `tamper(url)` may change the callback URL; returns the callback response. */
async function signIn(client, provider, identity, { tamper, keepCookie = true } = {}) {
  await setIdentity(identity);
  const start = await client.get(`/admin/oauth/${provider}`);
  if (start.status !== 303 || !start.loc?.startsWith(OIDC)) return { start, cb: start };
  const auth = await fetch(start.loc, { redirect: 'manual' });
  let back = new URL(auth.headers.get('location'));
  if (tamper) back = tamper(back) || back;
  const saved = { ...client.jar };
  if (!keepCookie) delete client.jar['__Host-imc_oauth'];
  const cb = await client.get(back.pathname + back.search);
  if (!keepCookie) Object.assign(client.jar, { '__Host-imc_oauth': saved['__Host-imc_oauth'] });
  return { start, cb, back, auth };
}
const audits = (action) => q('SELECT * FROM audit_log WHERE action = ?', action);
const lastFailReason = () => JSON.parse(q("SELECT detail FROM audit_log WHERE action = 'auth.oauth_failed' ORDER BY id DESC LIMIT 1")[0].detail).reason;
const oauthRows = () => count('SELECT COUNT(*) n FROM oauth_accounts');
const sessionRows = () => count('SELECT COUNT(*) n FROM sessions');

try {
  // ---- configuration and the login page ----
  check('startup warns about test-only endpoint overrides under NODE_ENV=production', /\[oauth\] WARNING: .*OAUTH_GOOGLE_AUTH_URL/.test(serverLog), serverLog.slice(0, 300));
  let r = await new Client('10.8.1.1').get('/admin/login');
  check('login page shows both provider buttons when both are configured', r.text.includes('href="/admin/oauth/google"') && r.text.includes('Sign in with Google') && r.text.includes('href="/admin/oauth/microsoft"') && r.text.includes('Sign in with Microsoft 365'));
  r = await new Client('10.8.1.2').get('/admin/oauth/github');
  check('an unknown provider is not a sign-in path (signed-out visitors go to the login page; a signed-in one gets 404)', r.status === 302 && r.loc === '/admin/login', `${r.status} ${r.loc}`);

  // ---- the flow's cookie, state and PKCE ----
  const flow = new Client('10.8.2.1');
  await setIdentity(googleId(INVITEE));
  const st = await flow.get('/admin/oauth/google');
  const authUrl = new URL(st.loc);
  const oc = flow.setCookies.find((c) => c.startsWith('__Host-imc_oauth='));
  check('start redirects to the provider with PKCE S256, state, nonce and scope "openid email profile"',
    st.status === 303 && authUrl.searchParams.get('code_challenge_method') === 'S256' && !!authUrl.searchParams.get('code_challenge') && authUrl.searchParams.get('state')?.length >= 32 && !!authUrl.searchParams.get('nonce') && authUrl.searchParams.get('scope') === 'openid email profile' && authUrl.searchParams.get('redirect_uri') === `${BASE}/admin/oauth/google/callback`, st.loc);
  check('state cookie: __Host- name, HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=600, no Domain', !!oc && /HttpOnly/i.test(oc) && /Secure/i.test(oc) && /SameSite=Lax/i.test(oc) && /Path=\//i.test(oc) && /Max-Age=600/i.test(oc) && !/Domain=/i.test(oc), oc);
  check('the authorization URL carries no client secret and the cookie does not hold it', !st.loc.includes('mock-google-secret') && !Buffer.from(flow.jar['__Host-imc_oauth'], 'base64url').toString().includes('mock-google-secret'));

  // ---- invited email -> account activated, linked, enrollment, no dashboard without a second factor ----
  const ivy = new Client('10.8.3.1');
  const sessionsBefore = sessionRows();
  let res = await signIn(ivy, 'google', googleId(INVITEE));
  check('an invited email signs in and is sent to authenticator/passkey enrollment', res.cb.status === 303 && res.cb.loc === '/admin/2fa/setup' && ivy.hasSession(), `${res.cb.status} ${res.cb.loc}`);
  check('the state cookie is cleared by the callback', !('__Host-imc_oauth' in ivy.jar));
  const ivyRow = q('SELECT id, status FROM users WHERE email = ?', INVITEE)[0];
  check('the invite is accepted: user active, one oauth link, no password stored', ivyRow.status === 'active' && count('SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ? AND provider = ?', ivyRow.id, 'google') === 1 && count('SELECT COUNT(*) n FROM password_credentials WHERE user_id = ?', ivyRow.id) === 0);
  const link = q('SELECT * FROM oauth_accounts WHERE user_id = ?', ivyRow.id)[0];
  check('the link stores provider, subject, email at link time and a date', link.provider === 'google' && link.provider_user_id === 'g-' + INVITEE && link.email_at_link === INVITEE && link.created_at > 0);
  check('the emailed invite link is used up', count('SELECT COUNT(*) n FROM invites WHERE user_id = ? AND used_at IS NULL', ivyRow.id) === 0);
  check('the session starts with mfa_passed = 0', q('SELECT mfa_passed m FROM sessions WHERE user_id = ?', ivyRow.id)[0].m === 0 && sessionRows() === sessionsBefore + 1);
  for (const p of ['/admin', '/admin/account', '/admin/editors', '/admin/published']) {
    r = await ivy.get(p);
    check(`no dashboard without the second factor: ${p} -> /admin/2fa`, r.status === 302 && r.loc === '/admin/2fa', `${r.status} ${r.loc}`);
  }
  r = await ivy.post('/api/admin/logout');
  r = await signIn(ivy, 'google', googleId(INVITEE)); // a new sign-in; the account is active and linked now
  check('a linked, enrolled-less editor signing in again goes to /admin/2fa (which sends them to setup)', r.cb.status === 303 && r.cb.loc === '/admin/2fa');
  r = await ivy.get('/admin/2fa');
  check('...and /admin/2fa sends an editor with no second factor to enrollment', r.status === 302 && r.loc === '/admin/2fa/setup');
  r = await ivy.get('/api/admin/drafts/1/save');
  check('API routes refuse a session without the second factor (403)', r.status === 403, String(r.status));
  r = await ivy.get('/admin/2fa/setup');
  const secret = (/class="totp-secret[^>]*>([^<]+)</.exec(r.text) || [])[1]?.replace(/\s/g, '');
  check('enrollment page is reachable and shows an authenticator secret', r.status === 200 && /^[A-Z2-7]{32}$/.test(secret || ''));
  r = await ivy.post('/admin/2fa/setup', { code: totp(secret) });
  const recovery = [...r.text.matchAll(/<code>([A-Z0-9-]+)<\/code>/g)].map((m) => m[1]);
  check('authenticator enrolled, 10 recovery codes shown', recovery.length === 10, `${r.status} ${recovery.length}`);
  r = await ivy.get('/admin');
  check('after enrollment the dashboard is open', r.status === 200);

  // ---- a linked editor: sign in again -> second factor -> dashboard ----
  await ivy.post('/api/admin/logout');
  const ivy2 = new Client('10.8.3.2');
  const usersBefore = count('SELECT COUNT(*) n FROM users');
  res = await signIn(ivy2, 'google', googleId(INVITEE, { email: 'someone.else@example.test' })); // the link is by subject, not the email
  check('an existing link signs in by provider subject (even if the provider email changed)', res.cb.status === 303 && res.cb.loc === '/admin/2fa', `${res.cb.status} ${res.cb.loc}`);
  check('...no new user or link was created', count('SELECT COUNT(*) n FROM users') === usersBefore && oauthRows() === 1);
  r = await ivy2.get('/admin');
  check('...and the dashboard still needs the second factor', r.status === 302 && r.loc === '/admin/2fa');
  r = await ivy2.post('/admin/2fa', { code: '000000' });
  check('a wrong code does not open the dashboard', r.status === 401 && (await ivy2.get('/admin')).status === 302);
  r = await ivy2.post('/admin/2fa', { code: totp(secret, 1) });
  check('the authenticator code completes sign-in', r.status === 303 && r.loc === '/admin', `${r.status} ${r.loc}`);
  check('...dashboard now opens', (await ivy2.get('/admin')).status === 200);

  // ---- rejections: nothing is created ----
  const stranger = 'stranger.person@example.test';
  const c1 = new Client('10.8.4.1');
  let u0 = count('SELECT COUNT(*) n FROM users'), o0 = oauthRows(), s0 = sessionRows();
  res = await signIn(c1, 'google', googleId(stranger));
  r = await c1.get(res.cb.loc);
  check('a non-invited email is rejected with the invite message', res.cb.status === 303 && res.cb.loc === '/admin/login?oauth=no_account' && r.status === 401 && r.error === "This account isn't set up for IMConnected. Ask an admin for an invite", `${res.cb.loc} ${r.error}`);
  check('...no user, link or session was created', count('SELECT COUNT(*) n FROM users') === u0 && oauthRows() === o0 && sessionRows() === s0 && !c1.hasSession());
  check('...the failure is audited without the address', lastFailReason() === 'no_match' && !JSON.stringify(q('SELECT detail, target FROM audit_log')).includes('stranger.person'));

  const c2 = new Client('10.8.4.2');
  for (const [label, extra] of [['email_verified=false', { email_verified: false }], ['email_verified="false"', { email_verified: 'false' }], ['email_verified missing', { omit: ['email_verified'] }]]) {
    res = await signIn(c2, 'google', googleId(UNVERIFIED, extra));
    check(`Google ${label} is rejected`, res.cb.loc === '/admin/login?oauth=unverified' && q('SELECT status FROM users WHERE email = ?', UNVERIFIED)[0].status === 'invited' && oauthRows() === o0 && !c2.hasSession(), `${res.cb.loc}`);
  }
  r = await c2.get('/admin/login?oauth=unverified');
  check('...the unverified page text is fixed text', /hasn’t verified this email/.test(r.error), r.error);
  res = await signIn(c2, 'google', googleId(UNVERIFIED, { omit: ['email'] }));
  check('Google with no email claim is rejected', res.cb.loc === '/admin/login?oauth=failed' && lastFailReason() === 'claims_no_email');
  r = await c2.get('/admin/login?oauth=%3Cscript%3Ealert(1)%3C/script%3E');
  check('an unknown ?oauth= code shows the generic text and reflects nothing', r.error.startsWith('Sign-in with that provider') && !r.text.includes('<script>alert'));

  // tampered state, missing cookie, replay
  const c3 = new Client('10.8.4.3');
  res = await signIn(c3, 'google', googleId(TAMPER), { tamper: (u) => { u.searchParams.set('state', u.searchParams.get('state').slice(0, -2) + 'xx'); } });
  check('a tampered state is rejected', res.cb.loc === '/admin/login?oauth=failed' && lastFailReason() === 'state_mismatch' && q('SELECT status FROM users WHERE email = ?', TAMPER)[0].status === 'invited' && !c3.hasSession(), `${res.cb.loc} ${lastFailReason()}`);
  res = await signIn(c3, 'google', googleId(TAMPER), { keepCookie: false });
  check('a callback without the state cookie (another browser) is rejected', res.cb.loc === '/admin/login?oauth=failed' && lastFailReason() === 'state_missing' && !c3.hasSession());
  res = await signIn(c3, 'google', googleId(TAMPER), { tamper: (u) => { u.searchParams.delete('state'); } });
  check('a callback with no state is rejected', res.cb.loc === '/admin/login?oauth=failed' && !c3.hasSession());
  const c4 = new Client('10.8.4.4');
  await setIdentity(googleId(TAMPER));
  const st4 = await c4.get('/admin/oauth/google');
  const auth4 = await fetch(st4.loc, { redirect: 'manual' });
  const back4 = new URL(auth4.headers.get('location'));
  const cookieCopy = c4.jar['__Host-imc_oauth'];
  const cbMicro = await c4.get(back4.pathname.replace('/google/', '/microsoft/') + back4.search);
  check('a state from the Google flow does not work on the Microsoft callback', cbMicro.loc === '/admin/login?oauth=failed' && !c4.hasSession());
  c4.jar['__Host-imc_oauth'] = cookieCopy;
  const cbOk = await c4.get(back4.pathname + back4.search); // this one is genuine: TAMPER is invited, so it links
  check('the genuine callback still works for the same flow once', cbOk.status === 303 && cbOk.loc === '/admin/2fa/setup', `${cbOk.loc}`);
  const c5 = new Client('10.8.4.5');
  c5.jar['__Host-imc_oauth'] = cookieCopy;
  const replay = await c5.get(back4.pathname + back4.search);
  check('replaying the same callback (code and cookie) is rejected', replay.loc === '/admin/login?oauth=failed' && lastFailReason() === 'exchange' && !c5.hasSession(), `${replay.loc} ${lastFailReason()}`);

  // claim checks
  const c6 = new Client('10.8.4.6');
  const cases = [
    ['a wrong nonce', googleId(TAMPER, { nonce: 'wrong' })],
    ['a wrong audience', googleId(TAMPER, { aud: 'someone-elses-client' })],
    ['an expired ID token', googleId(TAMPER, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['a wrong issuer', googleId(TAMPER, { iss: 'https://evil.example.test' })],
  ];
  for (const [label, id] of cases) {
    res = await signIn(c6, 'google', id);
    check(`${label} is rejected`, res.cb.loc === '/admin/login?oauth=failed' && lastFailReason() === 'claims_claims' && !c6.hasSession(), `${res.cb.loc} ${lastFailReason()}`);
  }

  // disabled editor with a link
  run('INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email_at_link, created_at) VALUES (?, ?, ?, ?, ?)', 'google', 'g-disabled', disabledId, DISABLED, Date.now());
  const c7 = new Client('10.8.4.7');
  res = await signIn(c7, 'google', googleId(DISABLED, { sub: 'g-disabled' }));
  check('a disabled editor with a link gets the same rejection and no session', res.cb.loc === '/admin/login?oauth=no_account' && !c7.hasSession());
  res = await signIn(c7, 'google', googleId(DISABLED, { sub: 'g-other' }));
  check('a disabled editor is not matched by email either', res.cb.loc === '/admin/login?oauth=no_account' && !c7.hasSession() && q('SELECT status FROM users WHERE id = ?', disabledId)[0].status === 'disabled');

  // ---- Microsoft: specific tenant (server 1) ----
  const m1 = new Client('10.8.5.1');
  res = await signIn(m1, 'microsoft', msId(MSONLY, { tid: OTHER_TENANT }));
  check('Microsoft, specific tenant: a token from another tenant is rejected', res.cb.loc === '/admin/login?oauth=no_account' && lastFailReason() === 'claims_tenant' && !m1.hasSession(), `${res.cb.loc} ${lastFailReason()}`);
  res = await signIn(m1, 'microsoft', msId('nobody@example.test', { omit: ['email'], preferred_username: 'nobody@example.test' }));
  check('...a non-invited address is rejected', res.cb.loc === '/admin/login?oauth=no_account');
  res = await signIn(m1, 'microsoft', { tid: TENANT, oid: OID, preferred_username: MSONLY });
  check('Microsoft, specific tenant: preferred_username from the configured tenant is accepted', res.cb.status === 303 && res.cb.loc === '/admin/2fa/setup', `${res.cb.loc}`);
  check('...link stored as <tid>:<oid>', q("SELECT provider_user_id p FROM oauth_accounts WHERE provider = 'microsoft'")[0].p === `${TENANT}:${OID}`);

  // ---- Microsoft: organizations (server 2) ----
  const m2 = new Client('10.8.5.2', BASE2);
  await setIdentity({ tid: OTHER_TENANT, oid: OID, preferred_username: ORGUSER });
  let st2 = await m2.get('/admin/oauth/microsoft');
  let au = await fetch(st2.loc, { redirect: 'manual' });
  let bk = new URL(au.headers.get('location'));
  let cb2 = await m2.get(bk.pathname + bk.search);
  check('Microsoft, organizations: preferred_username alone is NOT trusted (email claim required)', cb2.loc === '/admin/login?oauth=failed' && lastFailReason() === 'claims_no_email' && q('SELECT status FROM users WHERE email = ?', ORGUSER)[0].status === 'invited');
  await setIdentity({ tid: OTHER_TENANT, oid: OID, email: ORGUSER });
  st2 = await m2.get('/admin/oauth/microsoft');
  au = await fetch(st2.loc, { redirect: 'manual' });
  bk = new URL(au.headers.get('location'));
  cb2 = await m2.get(bk.pathname + bk.search);
  check('Microsoft, organizations: the email claim from any work tenant matches an invited editor', cb2.status === 303 && cb2.loc === '/admin/2fa/setup', `${cb2.loc}`);
  check('...its subject is that tenant\'s <tid>:<oid>', q("SELECT provider_user_id p FROM oauth_accounts WHERE provider = 'microsoft' AND user_id = (SELECT id FROM users WHERE email = ?)", ORGUSER)[0].p === `${OTHER_TENANT}:${OID}`);

  // ---- My account: linked providers and unlinking ----
  const acc = new Client('10.8.6.1');
  await signIn(acc, 'google', googleId(INVITEE)); // Ivy: linked to Google, authenticator enrolled, no password, no passkey
  r = await acc.post('/admin/2fa', { code: recovery[0] });
  check('(setup) Ivy signs in with Google plus a recovery code', r.status === 303 && r.loc === '/admin');
  r = await acc.get('/admin/account');
  check('My account lists the linked provider with an Unlink button', r.text.includes('Linked sign-in accounts') && r.text.includes('Google') && r.text.includes('value="oauth_unlink"') && !r.text.includes('Microsoft 365</strong>'));
  r = await acc.post('/admin/account', { action: 'oauth_unlink', provider: 'google', code: recovery[1] });
  check('unlinking the only first-factor method is refused (and no code is spent)', r.status === 409 && /only way to sign in/.test(r.error) && count("SELECT COUNT(*) n FROM oauth_accounts WHERE provider = 'google' AND user_id = ?", ivyRow.id) === 1, `${r.status} ${r.error}`);
  check('...the refusal is audited', audits('auth.oauth_unlink_refused').length === 1);
  // give Ivy a second provider by signing in with Microsoft using her email (specific tenant, preferred_username)
  const ivyMs = new Client('10.8.6.2');
  await signIn(ivyMs, 'microsoft', { tid: TENANT, oid: 'ffffffff-0000-4111-8222-333333333333', email: INVITEE });
  check('(setup) a second provider links to the same active editor by verified email', count("SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ?", ivyRow.id) === 2);
  r = await acc.get('/admin/account');
  check('My account lists both providers', r.text.includes('Google') && r.text.includes('Microsoft 365'));
  r = await acc.post('/admin/account', { action: 'oauth_unlink', provider: 'google', code: '' });
  check('unlinking without a fresh second factor is refused', r.status === 401 && count("SELECT COUNT(*) n FROM oauth_accounts WHERE provider = 'google' AND user_id = ?", ivyRow.id) === 1, `${r.status} ${r.error}`);
  r = await acc.post('/admin/account', { action: 'oauth_unlink', provider: 'google', code: '12345678' });
  check('unlinking with a wrong code is refused', r.status === 401 && count("SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ?", ivyRow.id) === 2);
  r = await acc.post('/admin/account', { action: 'oauth_unlink', provider: 'github', code: recovery[1] });
  check('an unknown provider is refused', r.status === 404);
  r = await acc.post('/admin/account', { action: 'oauth_unlink', provider: 'google', code: recovery[1] });
  check('with a fresh recovery code and another provider left, unlink works', r.status === 200 && /unlinked/.test(r.ok) && count("SELECT COUNT(*) n FROM oauth_accounts WHERE provider = 'google' AND user_id = ?", ivyRow.id) === 0, `${r.status} ${r.error} ${r.ok}`);
  r = await acc.post('/admin/account', { action: 'oauth_unlink', provider: 'microsoft', code: recovery[2] });
  check('...and the last remaining provider can then not be unlinked', r.status === 409 && count('SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ?', ivyRow.id) === 1);
  const other = new Client('10.8.6.3');
  await signIn(other, 'microsoft', { tid: TENANT, oid: OID, preferred_username: MSONLY });
  check("another editor's link is untouched by Ivy's unlinks", count("SELECT COUNT(*) n FROM oauth_accounts WHERE provider = 'microsoft' AND user_id <> ?", ivyRow.id) >= 1);

  // ---- rate limiting ----
  const rl = new Client('10.8.7.7');
  for (let i = 0; i < 10; i++) await rl.get('/admin/oauth/google/callback?code=x&state=y');
  r = await rl.get('/admin/oauth/google/callback?code=x&state=y');
  check('repeated failed callbacks lock the IP (same limits as password sign-in)', r.loc === '/admin/login?oauth=locked', `${r.loc}`);
  r = await rl.get('/admin/oauth/google');
  check('...a locked IP cannot start a new flow either', r.loc === '/admin/login?oauth=locked');
  r = await rl.get('/admin/login?oauth=locked');
  check('...and the page shows the standard lockout text', /Too many attempts/.test(r.error) && r.status === 429);

  // ---- audit ----
  check('links, sign-ins and failures are audited', audits('auth.oauth_linked').length >= 4 && audits('auth.oauth_login').length >= 4 && audits('auth.oauth_failed').length >= 10 && audits('auth.oauth_unlinked').length === 1 && audits('auth.oauth_started').length >= 5);
  const allAudit = JSON.stringify(q('SELECT action, target, detail FROM audit_log'));
  check('no token, code, secret or address of a stranger in the audit log', !/mock-access|mock-google-secret|mock-ms-secret|code_verifier|id_token|stranger\.person/.test(allAudit));
  check('no token, code or secret in the server log', !/mock-access|mock-google-secret|mock-ms-secret|id_token/.test(serverLog));
  check('the only users added are the seeded ones (nothing was created by a rejected sign-in)', count('SELECT COUNT(*) n FROM users') === pre.users);
} finally {
  stopAll();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
