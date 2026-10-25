#!/usr/bin/env node
// End-to-end check of Google / Microsoft 365 sign-in (issue #11) against the BUILT server (dist/server/entry.mjs), the local
// mock OpenID Connect provider scripts/mock-oidc.mjs and a throwaway data folder.
//   npm run build
//   DATA_DIR=/tmp/imc-oauth node scripts/test-editor-oauth.mjs
// The script starts and stops: the mock provider (MOCK_OIDC_PORT, default 4417), a server (PORT, default 4398) with a Microsoft
// tenant id and the test endpoints, a second server (PORT + 1) with NO test flag and tenant "organizations" (overrides ignored,
// Microsoft off) and a third (PORT + 2) with an override that is not https or loopback (Google off). The OAUTH_* endpoint
// overrides and OAUTH_TEST_ENDPOINTS=1 are for this test only; they are set with NODE_ENV=production on purpose, to check the
// startup warnings. All names, addresses and secrets are made up; no real Google or Microsoft endpoint is contacted.
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
const PORT3 = PORT + 2;
const OIDC_PORT = Number(process.env.MOCK_OIDC_PORT || 4417);
const BASE = `http://localhost:${PORT}`;
const BASE2 = `http://localhost:${PORT2}`;
const BASE3 = `http://localhost:${PORT3}`;
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
const logs = ['', '', '', ''];
const seenCodes = [];
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
// An invited user gets an unused, unexpired invite (`invite: 'expired'` an expired one, `'none'` no row), like the Editors page makes.
const addUser = (email, name, status, role = 'editor', invite = 'open') => {
  const now = Date.now();
  run('INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', email, name, role, status, now, now);
  const id = q('SELECT id FROM users WHERE email = ?', email)[0].id;
  if (status === 'invited' && invite !== 'none') {
    run('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)', `seed-${email}`, id, invite === 'expired' ? now - 60_000 : now + 3_600_000);
  }
  return id;
};
const UNVERIFIED = 'una.unverified@example.test';
const TAMPER = 'tam.tamper@example.test';
const DISABLED = 'dee.disabled@example.test';
const MSONLY = 'mo.micro@example.test';
const ORGUSER = 'orla.org@example.test';
const EXPIRED = 'ed.expired@example.test';
const NOINVITE = 'nora.noinvite@example.test';
const ADMINU = 'alice.admin@example.test';
addUser(UNVERIFIED, 'Una Unverified', 'invited');
addUser(TAMPER, 'Tam Tamper', 'invited');
const disabledId = addUser(DISABLED, 'Dee Disabled', 'disabled');
addUser(MSONLY, 'Mo Micro', 'invited');
addUser(ORGUSER, 'Orla Org', 'invited');
addUser(EXPIRED, 'Ed Expired', 'invited', 'editor', 'expired');
addUser(NOINVITE, 'Nora NoInvite', 'invited', 'editor', 'none');
const adminId = addUser(ADMINU, 'Alice Admin', 'invited', 'admin');
const pre = { users: count('SELECT COUNT(*) n FROM users') };

const baseEnv = {
  DATA_DIR, HOST: '127.0.0.1', AUTH_SECRET: 'e2e-oauth-secret-0123456789abcdefghijkl', TRUST_PROXY: 'true', NODE_ENV: 'production',
  GOOGLE_CLIENT_ID: 'mock-google-client', GOOGLE_CLIENT_SECRET: 'mock-google-secret',
  MICROSOFT_CLIENT_ID: 'mock-ms-client', MICROSOFT_CLIENT_SECRET: 'mock-ms-secret',
  OAUTH_GOOGLE_AUTH_URL: `${OIDC}/google/authorize`, OAUTH_GOOGLE_TOKEN_URL: `${OIDC}/google/token`, OAUTH_GOOGLE_ISSUER: `${OIDC}/google`,
  OAUTH_MICROSOFT_AUTH_URL: `${OIDC}/microsoft/authorize`, OAUTH_MICROSOFT_TOKEN_URL: `${OIDC}/microsoft/token`, OAUTH_MICROSOFT_ISSUER: `${OIDC}/microsoft`,
};
const testFlag = { OAUTH_TEST_ENDPOINTS: '1' };
start(['scripts/mock-oidc.mjs'], { MOCK_OIDC_PORT: String(OIDC_PORT) }, () => {});
start(['dist/server/entry.mjs'], { ...baseEnv, ...testFlag, PORT: String(PORT), SITE_URL: BASE, MICROSOFT_TENANT_ID: TENANT }, (l) => { logs[1] += l + '\n'; });
// Server 2: the real endpoints (no test flag) and a non-GUID tenant, so Microsoft is off.
start(['dist/server/entry.mjs'], { ...baseEnv, PORT: String(PORT2), SITE_URL: BASE2, MICROSOFT_TENANT_ID: 'organizations' }, (l) => { logs[2] += l + '\n'; });
// Server 3: the test flag, but a token endpoint that is plain http on a public host: Google is unconfigured.
start(['dist/server/entry.mjs'], { ...baseEnv, ...testFlag, OAUTH_GOOGLE_TOKEN_URL: 'http://idp.example.test/token', PORT: String(PORT3), SITE_URL: BASE3, MICROSOFT_TENANT_ID: TENANT }, (l) => { logs[3] += l + '\n'; });
for (let i = 0; i < 80; i++) {
  try { await fetch(BASE + '/admin/login', { redirect: 'manual' }); await fetch(BASE2 + '/admin/login', { redirect: 'manual' }); await fetch(BASE3 + '/admin/login', { redirect: 'manual' }); await fetch(OIDC + '/__log'); break; } catch { await sleep(250); }
}
const serverLog = () => logs.join('\n');

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
  if (back.searchParams.get('code')) seenCodes.push(back.searchParams.get('code'));
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
  let r;
  // ---- configuration and the login page ----
  check('startup warns about test-only endpoint overrides under NODE_ENV=production (with OAUTH_TEST_ENDPOINTS=1)', /\[oauth\] WARNING: .*OAUTH_GOOGLE_AUTH_URL.*OAUTH_TEST_ENDPOINTS=1/.test(logs[1]), logs[1].slice(0, 300));
  check('without OAUTH_TEST_ENDPOINTS=1 the overrides are ignored, and the startup log says so', /\[oauth\] WARNING: .*OAUTH_GOOGLE_AUTH_URL.*ignored/.test(logs[2]), logs[2].slice(0, 300));
  check('a non-GUID MICROSOFT_TENANT_ID switches Microsoft off with one startup note (no secret in it)', /Microsoft sign-in is OFF/.test(logs[2]) && !/mock-ms-secret/.test(logs[2]));
  const s2 = new Client('10.8.1.3', BASE2);
  r = await s2.get('/admin/login');
  check('server 2: Google button yes, Microsoft button no (tenant "organizations")', r.text.includes('href="/admin/oauth/google"') && !r.text.includes('/admin/oauth/microsoft'));
  r = await s2.get('/admin/oauth/microsoft');
  check('server 2: the Microsoft start link answers "unavailable"', r.loc === '/admin/login?oauth=unavailable', String(r.loc));
  r = await s2.get('/admin/oauth/google');
  check('server 2: test endpoints ignored, Google goes to the real https://accounts.google.com endpoint', /^https:\/\/accounts\.google\.com\//.test(r.loc || ''), String(r.loc));
  const s3 = new Client('10.8.1.4', BASE3);
  r = await s3.get('/admin/login');
  check('server 3: an override that is not https or loopback leaves that provider unconfigured (no Google button, Microsoft still on)', !r.text.includes('/admin/oauth/google') && r.text.includes('href="/admin/oauth/microsoft"'));
  r = await s3.get('/admin/oauth/google');
  check('server 3: its start link answers "unavailable"', r.loc === '/admin/login?oauth=unavailable', String(r.loc));
  r = await new Client('10.8.1.1').get('/admin/login');
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
  const failCount0 = count("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.oauth_failed'");
  res = await signIn(c3, 'google', googleId(TAMPER), { tamper: (u) => { u.searchParams.set('state', u.searchParams.get('state').slice(0, -2) + 'xx'); } });
  check('a tampered state is rejected (not counted, not audited: it can be forged cross-site)', res.cb.loc === '/admin/login?oauth=failed' && count('SELECT COUNT(*) n FROM audit_log WHERE action = \'auth.oauth_failed\'') === failCount0 && q('SELECT status FROM users WHERE email = ?', TAMPER)[0].status === 'invited' && !c3.hasSession(), `${res.cb.loc} ${lastFailReason()}`);
  res = await signIn(c3, 'google', googleId(TAMPER), { keepCookie: false });
  check('a callback without the state cookie (another browser) is rejected', res.cb.loc === '/admin/login?oauth=failed' && count("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.oauth_failed'") === failCount0 && !c3.hasSession());
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

  res = await signIn(m1, 'microsoft', msId(ORGUSER, { tid: OTHER_TENANT, omit: ['preferred_username'] }));
  check('Microsoft is single-tenant: a foreign tenant with an invited editor\'s email claim is refused', res.cb.loc === '/admin/login?oauth=no_account' && lastFailReason() === 'claims_tenant' && q('SELECT status FROM users WHERE email = ?', ORGUSER)[0].status === 'invited');
  const mp = new Client('10.8.5.5');
  res = await signIn(mp, 'microsoft', msId(ORGUSER, { tid: '9188040d-6c67-4c5b-b112-36a304b66dad' }));
  check('...and so is the personal-account tenant id', res.cb.loc === '/admin/login?oauth=no_account' && !mp.hasSession());
  const mw = new Client('10.8.5.6');
  res = await signIn(mw, 'microsoft', msId(ORGUSER, { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }));
  check('Microsoft with the right tenant but a wrong issuer is refused', res.cb.loc === '/admin/login?oauth=failed' && lastFailReason() === 'claims_claims' && !mw.hasSession(), `${res.cb.loc} ${lastFailReason()}`);
  res = await signIn(m1, 'microsoft', msId(ORGUSER, { aud: 'someone-elses-client' }));
  check('Microsoft with a wrong audience is refused', res.cb.loc === '/admin/login?oauth=failed' && lastFailReason() === 'claims_claims');
  const orla = new Client('10.8.5.2');
  res = await signIn(orla, 'microsoft', { tid: TENANT, oid: OID.replace('eeee', 'dddd'), email: ORGUSER });
  check('Microsoft, the configured tenant: the email claim matches an invited editor', res.cb.status === 303 && res.cb.loc === '/admin/2fa/setup', `${res.cb.loc}`);

  // ---- an expired or missing invite is not accepted through OAuth; a second account for a linked editor is not matched ----
  const ex = new Client('10.8.5.3');
  for (const [label, email] of [['an expired invite', EXPIRED], ['an invited user with no invite row', NOINVITE]]) {
    res = await signIn(ex, 'google', googleId(email));
    check(`${label} is not accepted via Google (no_match), nothing created`, res.cb.loc === '/admin/login?oauth=no_account' && lastFailReason() === 'no_match' && q('SELECT status FROM users WHERE email = ?', email)[0].status === 'invited' && count('SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = (SELECT id FROM users WHERE email = ?)', email) === 0 && !ex.hasSession(), `${res.cb.loc} ${lastFailReason()}`);
  }
  const g2 = new Client('10.8.5.4');
  res = await signIn(g2, 'google', googleId(INVITEE, { sub: 'g-a-second-ivy-account' }));
  check('a second Google account with an already-linked editor\'s email is not matched', res.cb.loc === '/admin/login?oauth=no_account' && lastFailReason() === 'no_match' && count("SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ? AND provider = 'google'", ivyRow.id) === 1 && !g2.hasSession());

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

  // ---- set a password (an editor who joined with OAuth has none) ----
  r = await acc.get('/admin/account');
  check('an editor with no password sees "Set a password" and not "Change password"', r.text.includes('<h2 id="pws">Set a password</h2>') && !r.text.includes('<h2 id="pw">Change password</h2>'));
  const GOOD = 'ivy sets a long password 77';
  r = await acc.post('/admin/account', { action: 'password_set', next: GOOD, confirm: GOOD + 'x', code: recovery[2] });
  check('set a password: mismatched confirmation is refused', /don’t match/.test(r.error) && count('SELECT COUNT(*) n FROM password_credentials WHERE user_id = ?', ivyRow.id) === 0);
  r = await acc.post('/admin/account', { action: 'password_set', next: 'short', confirm: 'short', code: recovery[2] });
  check('set a password: the existing password rules apply', r.error !== '' && count('SELECT COUNT(*) n FROM password_credentials WHERE user_id = ?', ivyRow.id) === 0, r.error);
  r = await acc.post('/admin/account', { action: 'password_set', next: GOOD, confirm: GOOD, code: '' });
  check('set a password: needs a fresh second factor', r.status === 401 && count('SELECT COUNT(*) n FROM password_credentials WHERE user_id = ?', ivyRow.id) === 0, `${r.status} ${r.error}`);
  r = await acc.post('/admin/account', { action: 'password_set', next: GOOD, confirm: GOOD, code: recovery[2] });
  check('set a password: works with a fresh recovery code, audited', r.status === 200 && /Password set/.test(r.ok) && count('SELECT COUNT(*) n FROM password_credentials WHERE user_id = ?', ivyRow.id) === 1 && audits('auth.password_set').length === 1, `${r.status} ${r.error} ${r.ok}`);
  r = await acc.get('/admin/account');
  check('...the page now offers Change password instead', r.text.includes('<h2 id="pw">Change password</h2>') && !r.text.includes('<h2 id="pws">'));
  const pw = new Client('10.8.6.4');
  r = await pw.post('/admin/login', { email: INVITEE, password: GOOD });
  check('...and the new password signs in (first step)', r.status === 303 && r.loc === '/admin/2fa', `${r.status} ${r.loc}`);
  r = await acc.post('/admin/account', { action: 'oauth_unlink', provider: 'microsoft', code: recovery[3] });
  check('with a password set, the last provider can now be unlinked', r.status === 200 && /unlinked/.test(r.ok) && count('SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ?', ivyRow.id) === 0, `${r.status} ${r.error} ${r.ok}`);

  // ---- administrators: see and remove links; 2FA reset clears them ----
  const alice = new Client('10.8.6.5');
  res = await signIn(alice, 'google', googleId(ADMINU));
  r = await alice.get('/admin/2fa/setup');
  const aSecret = (/class="totp-secret[^>]*>([^<]+)</.exec(r.text) || [])[1]?.replace(/\s/g, '');
  r = await alice.post('/admin/2fa/setup', { code: totp(aSecret) });
  check('(setup) an administrator invited through Google enrolls an authenticator', res.cb.loc === '/admin/2fa/setup' && (await alice.get('/admin/editors')).status === 200);
  r = await alice.get('/admin/editors');
  check('Editors lists linked providers with the date and an Unlink action (admin)', /Linked sign-in: Microsoft 365 \(since \d{4}-\d\d-\d\d\)/.test(unesc(r.text)) && r.text.includes('Unlink Microsoft 365') && r.text.includes('Unlink Google'));
  const orlaId = q('SELECT id FROM users WHERE email = ?', ORGUSER)[0].id;
  run("UPDATE users SET role = 'editor' WHERE id = ?", ivyRow.id); // create-admin.mjs made Ivy an administrator; from here on she is an ordinary editor
  r = await acc.post('/admin/editors', { action: 'oauth_unlink', id: String(orlaId), provider: 'microsoft' });
  check('an editor (not an admin) cannot unlink anyone else', r.status === 403 && count("SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ?", orlaId) === 1, String(r.status));
  r = await alice.post('/admin/editors', { action: 'oauth_unlink', id: String(orlaId), provider: 'microsoft' });
  const ul = q("SELECT user_id, detail, target FROM audit_log WHERE action = 'auth.oauth_unlinked' ORDER BY id DESC LIMIT 1")[0];
  check('an administrator unlinks it (fresh sign-in covers the factor), audited with the actor', r.status === 200 && /Linked account removed/.test(r.ok) && count('SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ?', orlaId) === 0 && ul.user_id === adminId && ul.target === `user:${orlaId}` && /admin/.test(ul.detail), `${r.status} ${r.error} ${r.ok}`);
  r = await alice.post('/admin/editors', { action: 'oauth_unlink', id: String(orlaId), provider: 'microsoft' });
  check('unlinking a link that is not there is a 404', r.status === 404);
  const moId = q('SELECT id FROM users WHERE email = ?', MSONLY)[0].id;
  check('(setup) another editor has a link and a session', count('SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ?', moId) === 1 && count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', moId) >= 1);
  r = await alice.post('/admin/editors', { action: 'reset2fa', id: String(moId) });
  const rz = q("SELECT detail FROM audit_log WHERE action = 'admin.reset_2fa' ORDER BY id DESC LIMIT 1")[0];
  check('Reset two-step sign-in also removes that editor\'s linked accounts (same transaction, audited)', r.status === 200 && count('SELECT COUNT(*) n FROM oauth_accounts WHERE user_id = ?', moId) === 0 && count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', moId) === 0 && JSON.parse(rz.detail).oauthLinks === 1, `${r.status} ${r.error} ${rz.detail}`);
  r = await alice.get('/admin/editors');
  check('...and the reset confirmation text says so', /any linked Google or Microsoft 365 account/.test(unesc(r.text)));

  // ---- rate limiting and flooding ----
  const junk = new Client('10.8.7.1');
  const auditBefore = count('SELECT COUNT(*) n FROM audit_log');
  for (let i = 0; i < 15; i++) await junk.get('/admin/oauth/google/callback?code=x&state=y'); // no cookie at all
  await junk.get('/admin/oauth/google'); // a real start, then wrong states
  for (let i = 0; i < 15; i++) await junk.get('/admin/oauth/google/callback?code=x&state=wrong-' + i);
  await junk.get('/admin/oauth/microsoft/callback?code=x&state=y');
  const junkAudits = q("SELECT action FROM audit_log WHERE ip = '10.8.7.1'").map((x) => x.action);
  check('cookie-less and wrong-state callbacks never count against the IP and are not audited', count("SELECT COUNT(*) n FROM login_attempts WHERE key = 'ip:10.8.7.1'") === 0 && !junkAudits.includes('auth.oauth_failed') && junkAudits.length <= 1, JSON.stringify(junkAudits));
  res = await signIn(junk, 'google', googleId(TAMPER));
  check('...so that IP can still sign in afterwards', res.cb.loc === '/admin/2fa', String(res.cb.loc));
  void auditBefore;

  const rl = new Client('10.8.7.7');
  for (let i = 0; i < 10; i++) await signIn(rl, 'google', googleId(UNVERIFIED, { email_verified: false })); // valid state, failing sign-in
  check('10 failed sign-ins with a valid state are counted against the IP', count("SELECT COUNT(*) n FROM login_attempts WHERE key = 'ip:10.8.7.7' AND ok = 0") === 10);
  await setIdentity(googleId(UNVERIFIED));
  const lockedStartedBefore = audits('auth.oauth_started').length;
  r = await rl.get('/admin/oauth/google');
  check('...then the IP is locked: it cannot start a new flow', r.loc === '/admin/login?oauth=locked', `${r.loc}`);
  check('...and a locked start writes no audit row', audits('auth.oauth_started').length === lockedStartedBefore);
  r = await rl.get('/admin/login?oauth=locked');
  check('...and the page shows the standard lockout text', /Too many attempts/.test(r.error) && r.status === 429);
  // A callback with a valid state arriving while locked: lockout text, no audit row, no new attempt.
  const rl2 = new Client('10.8.7.8');
  await setIdentity(googleId(UNVERIFIED, { email_verified: false }));
  const st8 = await rl2.get('/admin/oauth/google');
  const au8 = await fetch(st8.loc, { redirect: 'manual' });
  const bk8 = new URL(au8.headers.get('location'));
  for (let i = 0; i < 10; i++) run("INSERT INTO login_attempts (key, at, ok) VALUES ('ip:10.8.7.8', ?, 0)", Date.now());
  const failedAuditsBefore = audits('auth.oauth_failed').length;
  r = await rl2.get(bk8.pathname + bk8.search);
  check('a valid-state callback from a locked IP gets the lockout text with no audit row and no new attempt', r.loc === '/admin/login?oauth=locked' && audits('auth.oauth_failed').length === failedAuditsBefore && count("SELECT COUNT(*) n FROM login_attempts WHERE key = 'ip:10.8.7.8'") === 10, `${r.loc}`);

  const flood = new Client('10.8.7.9');
  let lastLoc = '';
  for (let i = 0; i < 40; i++) lastLoc = (await flood.get('/admin/oauth/google')).loc || '';
  check('starts are limited per IP (30 in 15 minutes) and their audit rows stop at the limit', lastLoc === '/admin/login?oauth=locked' && count("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.oauth_started' AND ip = '10.8.7.9'") === 30);

  // ---- the claim rules against the REAL issuers (no overrides) ----
  const { validateClaims: vc, microsoftIssuer } = await import('../src/lib/auth/oauth-claims.mjs');
  const exp = Math.floor(Date.now() / 1000) + 600;
  const gCfg = { provider: 'google', clientId: 'cid', issuerOverride: '' };
  const gOk = { iss: 'https://accounts.google.com', aud: 'cid', exp, nonce: 'n1', sub: 's1', email: 'A@Example.test', email_verified: true };
  check('claims (no overrides): Google issuer https://accounts.google.com and accounts.google.com are accepted; the address is lower-cased', vc(gCfg, gOk, 'n1').ok && vc(gCfg, { ...gOk, iss: 'accounts.google.com' }, 'n1').ok && vc(gCfg, gOk, 'n1').email === 'a@example.test');
  check('claims (no overrides): any other Google issuer is refused, including the mock issuer', !vc(gCfg, { ...gOk, iss: 'https://evil.example.test' }, 'n1').ok && !vc(gCfg, { ...gOk, iss: `${OIDC}/google` }, 'n1').ok && !vc(gCfg, { ...gOk, iss: 'https://accounts.google.com.evil.test' }, 'n1').ok);
  check('claims: Google needs aud, a live exp, the nonce and email_verified', !vc(gCfg, { ...gOk, aud: 'x' }, 'n1').ok && vc(gCfg, { ...gOk, aud: ['x', 'cid'] }, 'n1').ok && !vc(gCfg, { ...gOk, exp: 1 }, 'n1').ok && !vc(gCfg, gOk, 'n2').ok && !vc(gCfg, gOk, '').ok && vc(gCfg, { ...gOk, email_verified: false }, 'n1').reason === 'unverified');
  const mCfg = { provider: 'microsoft', clientId: 'mid', tenant: TENANT, issuerOverride: '' };
  const mOk = { iss: microsoftIssuer(TENANT), aud: 'mid', exp, nonce: 'n1', tid: TENANT, oid: OID, preferred_username: 'B@Example.test' };
  check('claims (no overrides): Microsoft issuer https://login.microsoftonline.com/<tenant>/v2.0 is accepted; subject is <tid>:<oid>', vc(mCfg, mOk, 'n1').ok && vc(mCfg, mOk, 'n1').subject === `${TENANT}:${OID}` && microsoftIssuer(TENANT) === `https://login.microsoftonline.com/${TENANT}/v2.0`);
  check('claims (no overrides): other Microsoft issuers are refused (other tenant, v1 sts.windows.net, the mock)', !vc(mCfg, { ...mOk, iss: microsoftIssuer(OTHER_TENANT) }, 'n1').ok && !vc(mCfg, { ...mOk, iss: `https://sts.windows.net/${TENANT}/` }, 'n1').ok && !vc(mCfg, { ...mOk, iss: `${OIDC}/microsoft` }, 'n1').ok);
  check('claims: Microsoft refuses another tenant and the personal-account tenant, and a non-GUID configuration', vc(mCfg, { ...mOk, tid: OTHER_TENANT, iss: microsoftIssuer(OTHER_TENANT) }, 'n1').reason === 'tenant' && !vc(mCfg, { ...mOk, tid: '9188040d-6c67-4c5b-b112-36a304b66dad', iss: microsoftIssuer('9188040d-6c67-4c5b-b112-36a304b66dad') }, 'n1').ok && !vc({ ...mCfg, tenant: 'organizations' }, mOk, 'n1').ok && !vc({ ...mCfg, tenant: '9188040d-6c67-4c5b-b112-36a304b66dad' }, { ...mOk, tid: '9188040d-6c67-4c5b-b112-36a304b66dad', iss: microsoftIssuer('9188040d-6c67-4c5b-b112-36a304b66dad') }, 'n1').ok);
  check('claims: Microsoft takes email, else preferred_username, only from the configured tenant', vc(mCfg, { ...mOk, email: 'c@example.test' }, 'n1').email === 'c@example.test' && vc(mCfg, mOk, 'n1').email === 'b@example.test' && vc(mCfg, { ...mOk, preferred_username: undefined }, 'n1').reason === 'no_email');

  // ---- audit ----
  check('links, sign-ins and failures are audited', audits('auth.oauth_linked').length >= 4 && audits('auth.oauth_login').length >= 4 && audits('auth.oauth_failed').length >= 10 && audits('auth.oauth_unlinked').length === 3 && audits('auth.oauth_started').length >= 5);
  const allAudit = JSON.stringify(q('SELECT action, target, detail FROM audit_log'));
  check('no token, authorization code, secret or address of a stranger in the audit log', !/mock-access|mock-google-secret|mock-ms-secret|code_verifier|id_token|stranger\.person/.test(allAudit) && seenCodes.length > 20 && !seenCodes.some((c) => allAudit.includes(c)), String(seenCodes.length));
  check('no token, authorization code, secret or stranger address in any server log', !/mock-access|mock-google-secret|mock-ms-secret|id_token|stranger\.person/.test(serverLog()) && !seenCodes.some((c) => serverLog().includes(c)));
  check('the only users added are the seeded ones (nothing was created by a rejected sign-in)', count('SELECT COUNT(*) n FROM users') === pre.users);
} finally {
  stopAll();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
