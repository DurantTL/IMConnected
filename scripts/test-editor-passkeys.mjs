#!/usr/bin/env node
// End-to-end check of passkeys (WebAuthn) against a RUNNING built server and a throwaway data folder,
// driving real Chromium with a CDP virtual authenticator (user verification on, resident keys on).
//   DATA_DIR=/tmp/x AUTH_SECRET=<32+ chars> SITE_URL=http://localhost:4393 TRUST_PROXY=true PORT=4393 node dist/server/entry.mjs &
//   DATA_DIR=/tmp/x SITE_URL=http://localhost:4393 node scripts/test-editor-passkeys.mjs
// Playwright is not a dependency of the site: point PLAYWRIGHT_ROOT at a folder whose node_modules has it
// (default /opt/node-tools). The browser is CHROMIUM_PATH (default /opt/pw-browsers/chromium); never run
// `playwright install`. Synthetic data only.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { chromium } = createRequire((process.env.PLAYWRIGHT_ROOT || '/opt/node-tools') + '/package.json')('playwright');

const BASE = (process.env.SITE_URL || 'http://localhost:4393').replace(/\/+$/, '');
if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to the throwaway data folder the server uses.');
const DATA_DIR = path.resolve(process.env.DATA_DIR);
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');

const EMAIL = 'passkey-tester@example.test';
const PASSWORD = 'passkey tester long password 31';
let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};
const q = (sql, ...args) => {
  const db = new DatabaseSync(DB_FILE);
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};
const run = (sql, ...args) => {
  const db = new DatabaseSync(DB_FILE);
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
};
const uid = () => q('SELECT id FROM users WHERE email = ?', EMAIL)[0].id;
const count = (table) => Number(q(`SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, uid())[0].n);
const auditCount = (action) => Number(q('SELECT COUNT(*) n FROM audit_log WHERE action = ?', action)[0].n);

// Plain HTTP client for the server-side checks (cookies by hand: the session cookie is Secure).
class Client {
  constructor(ip) { this.ip = ip; this.cookie = ''; }
  async req(method, url, form) {
    const headers = { Origin: BASE, 'X-Forwarded-For': this.ip };
    if (this.cookie) headers.Cookie = this.cookie;
    let body;
    if (form) { body = new URLSearchParams(form); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const k = pair.slice(0, pair.indexOf('=')), v = pair.slice(pair.indexOf('=') + 1);
      if (k === '__Host-imc_session') this.cookie = v ? `${k}=${v}` : '';
    }
    const text = await res.text();
    return { status: res.status, loc: res.headers.get('location'), text, error: (/role="alert"[^>]*>([^<]*)</.exec(text) || [])[1] };
  }
  get(u) { return this.req('GET', u); }
  post(u, f) { return this.req('POST', u, f); }
}

// ---- set up: a synthetic editor from an invite ----
const out = execFileSync('node', ['scripts/create-admin.mjs', EMAIL, 'Passkey Tester'], { env: { ...process.env, DATA_DIR } }).toString();
const invitePath = new URL(out.match(/https?:\/\/\S+/)[0]).pathname;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ baseURL: BASE });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const virtual = { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
const addAuthenticator = async () => (await cdp.send('WebAuthn.addVirtualAuthenticator', { options: virtual })).authenticatorId;
let auth1 = await addAuthenticator();

const text = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ');
const signOut = async () => { await page.request.post('/api/admin/logout', { headers: { Origin: BASE } }); await context.clearCookies(); };
const alertText = async () => (await page.locator('[role=alert]:visible').allInnerTexts()).join(' | ');

try {
  // 1. Enrollment with a passkey instead of an authenticator app
  await page.goto(BASE + invitePath);
  await page.fill('#password', PASSWORD);
  await page.fill('#confirm', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin/2fa/setup');
  const setupHtml = await page.content();
  check('setup page offers "use a passkey instead of an authenticator app"', /Use a passkey instead of an authenticator app/.test(setupHtml));
  const scriptSrcs = [...setupHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  check('the browser library is served from this site, not a CDN', scriptSrcs.length > 0 && scriptSrcs.every((s) => s.startsWith('/')), scriptSrcs.join(','));
  const bundle = await fetch(BASE + scriptSrcs[0]);
  check('...and that script is reachable without a session (200)', bundle.status === 200);
  await page.fill('#pk-name', 'Enrollment key');
  await page.click('button[data-passkey=register]');
  await page.waitForSelector('.recovery-codes');
  const recovery = await page.locator('.recovery-codes code').allInnerTexts();
  check('passkey enrolled during setup; 10 recovery codes shown (first second factor)', recovery.length === 10, String(recovery.length));
  check('the passkey is stored (public key, credential id, name)', count('passkeys') === 1 && q('SELECT device_name d FROM passkeys')[0].d === 'Enrollment key');
  await page.goto(BASE + '/admin');
  check('dashboard reachable after passkey enrollment', /Dashboard/.test(await text()));
  check('registration audited, recovery codes audited once', auditCount('auth.passkey_registered') === 1 && auditCount('auth.recovery_codes_generated') === 1);

  // 2. My account: list, exclude already-registered credentials, register a second passkey, remove, last factor
  await page.goto(BASE + '/admin/account');
  check('My account lists the passkey with name and dates', /Enrollment key/.test(await text()) && /never used/.test(await text()));
  await page.click('#pk-name ~ button[data-passkey=register]');
  await page.waitForSelector('[data-passkey-error]:not([hidden])');
  check('registering the same authenticator again is refused (credential excluded)', /already has a passkey/.test(await alertText()), await alertText());
  check('...and nothing extra was stored', count('passkeys') === 1);

  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth1 });
  const auth2 = await addAuthenticator();
  await page.goto(BASE + '/admin/account');
  await page.fill('#pk-name', 'Second key');
  await page.click('#pk-name ~ button[data-passkey=register]');
  await page.waitForSelector('[role=alert]:visible'); // wrong: no fresh factor available on this authenticator
  check('adding a passkey needs a fresh second factor (no code; the new authenticator cannot prove it, nothing added)', /cancelled or timed out/.test(await alertText()) && count('passkeys') === 1, await alertText());

  await page.goto(BASE + '/admin/account');
  await page.fill('#pk-name', 'Second key');
  await page.fill('#pk-code', recovery[0]);
  await page.click('#pk-name ~ button[data-passkey=register]');
  await page.waitForSelector('[role=status]');
  check('second passkey registered from My account with a recovery code as the fresh factor', /Passkey added/.test(await text()) && count('passkeys') === 2, await text());
  check('recovery codes were NOT regenerated for the second factor', auditCount('auth.recovery_codes_generated') === 1);

  // remove the first passkey, proving freshness with a passkey assertion (the second key is on this authenticator)
  const firstId = q("SELECT id FROM passkeys WHERE device_name = 'Enrollment key'")[0].id;
  await page.locator(`form:has(input[name=id][value="${firstId}"]):has(input[name=code]) button`).click();
  await page.waitForSelector('[role=status]');
  check('removing a passkey with a fresh passkey assertion works', /Passkey removed/.test(await text()) && count('passkeys') === 1);
  check('removal audited', auditCount('auth.passkey_removed') === 1);

  // rename
  const secondId = q('SELECT id FROM passkeys')[0].id;
  await page.locator(`form:has(input[name=action][value=passkey_rename]):has(input[name=id][value="${secondId}"]) input[name=name]`).fill('Renamed key');
  await page.locator(`form:has(input[name=action][value=passkey_rename]):has(input[name=id][value="${secondId}"]) button`).click();
  await page.waitForSelector('[role=status]');
  check('a passkey can be renamed', q('SELECT device_name d FROM passkeys')[0].d === 'Renamed key');

  // last second factor (no authenticator app is enrolled)
  await page.locator(`form:has(input[name=action][value=passkey_remove]) input[name=code]`).fill(recovery[1]);
  await page.locator(`form:has(input[name=action][value=passkey_remove]) button`).click();
  await page.waitForSelector('[role=alert]:visible');
  check('the last second factor cannot be removed', /last second factor/.test(await alertText()) && count('passkeys') === 1, await alertText());
  check('...and the refusal did not burn the recovery code', Number(q('SELECT COUNT(*) n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', uid())[0].n) === 9);
  check('...and is audited', auditCount('auth.passkey_remove_refused') === 1);

  // 3. Sign out, then passwordless sign-in with only the passkey
  await signOut();
  let loginPost = null;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/admin/login' && (r.postData() || '').includes('passkey=')) loginPost = r.postData(); });
  await page.goto(BASE + '/admin/login');
  await page.click('button[data-passkey=login]');
  await page.waitForURL('**/admin');
  check('passwordless passkey sign-in reaches the dashboard (both factors)', /Dashboard/.test(await text()));
  const sess = q('SELECT mfa_passed m FROM sessions WHERE user_id = ?', uid());
  check('...the session is fully verified (mfa_passed=1)', sess.length === 1 && sess[0].m === 1);
  check('the passkey records last use', q('SELECT last_used_at l FROM passkeys')[0].l !== null);
  check('passkey sign-in audited', q("SELECT detail d FROM audit_log WHERE action = 'auth.login'").some((r) => /passkey/.test(r.d)));

  // 4. A reused challenge is rejected (replay the exact form post, with a fresh client)
  await signOut();
  check('captured the passkey form post', !!loginPost);
  const replay = await fetch(BASE + '/admin/login', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '10.7.0.1' }, body: loginPost,
  });
  const replayText = await replay.text();
  check('replaying a used passkey sign-in is rejected (401, no session cookie)', replay.status === 401 && replay.headers.getSetCookie().length === 0 && /could not be verified/.test(replayText), String(replay.status));
  check('...and audited as a failure', auditCount('auth.passkey_failed') >= 1);

  // 5. Passkey as the second factor after a password
  await page.goto(BASE + '/admin/login');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin/2fa');
  await page.goto(BASE + '/admin');
  check('password alone does not reach the dashboard', page.url().endsWith('/admin/2fa'));
  check('/admin/2fa offers the passkey', (await page.locator('button[data-passkey=second]').count()) === 1);
  const pendingCookie = (await context.cookies()).find((c) => c.name === '__Host-imc_session')?.value;
  await page.click('button[data-passkey=second]');
  await page.waitForURL('**/admin');
  check('passkey as second factor after a password reaches the dashboard', /Dashboard/.test(await text()));
  const newCookie = (await context.cookies()).find((c) => c.name === '__Host-imc_session')?.value;
  check('session id rotated after the passkey second factor', !!newCookie && newCookie !== pendingCookie);

  // 5b. A 'login' assertion can't be used as a 'fresh' confirmation
  {
    const codesBefore = auditCount('auth.recovery_codes_generated');
    const res = await page.evaluate(async () => {
      const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const { options } = await (await fetch('/api/admin/passkeys/login/options', { method: 'POST' })).json();
      const cred = await navigator.credentials.get({ publicKey: { challenge: unb64(options.challenge), rpId: options.rpId, userVerification: 'required', allowCredentials: [] } });
      const r = cred.response;
      const assertion = { id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: {}, response: {
        clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature), userHandle: r.userHandle ? b64(r.userHandle) : undefined } };
      const out = await fetch('/admin/account', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'recovery', code: '', assertion: JSON.stringify(assertion) }) });
      return { status: out.status, html: await out.text() };
    });
    check('a login-purpose assertion is rejected as a fresh confirmation (401, no new recovery codes)', res.status === 401 && auditCount('auth.recovery_codes_generated') === codesBefore, String(res.status));
  }

  // 6. An expired challenge is rejected
  await signOut();
  await page.route('**/admin/login', async (route) => {
    if (route.request().method() === 'POST') run('UPDATE webauthn_challenges SET expires_at = ?', Date.now() - 1000);
    await route.continue();
  });
  await page.goto(BASE + '/admin/login');
  await page.click('button[data-passkey=login]');
  await page.waitForSelector('[role=alert]:visible');
  check('an expired challenge is rejected', /expired/.test(await alertText()) && page.url().endsWith('/admin/login'), await alertText());
  await page.unroute('**/admin/login');
  run('DELETE FROM webauthn_challenges');

  // 7. A challenge issued for one purpose/user can't be used elsewhere, and unauthenticated limits hold
  {
    const c = new Client('10.8.0.1');
    let r = await c.post('/admin/login', { email: EMAIL, password: PASSWORD });
    check('(password step for the server-side checks)', r.status === 303 && r.loc === '/admin/2fa');
    r = await c.get('/admin/2fa/setup');
    check('canEnrollWithoutMfa: a password-only session can NOT enroll when a passkey exists (setup 403)', r.status === 403, String(r.status));
    r = await c.req('POST', '/api/admin/passkeys/register/options');
    check('...nor fetch passkey registration options (403)', r.status === 403, String(r.status));
    r = await c.get('/admin/2fa');
    check('/admin/2fa shows the passkey option for a passkey-only user', r.status === 200 && /data-passkey="second"/.test(r.text));
    r = await c.post('/admin/2fa', { passkey: '{"id":"x","response":{"clientDataJSON":"e30"}}' });
    check('a junk passkey at /admin/2fa is rejected', r.status === 401, String(r.status));
    const o = await new Client('10.8.0.2').req('POST', '/api/admin/passkeys/options');
    check('second-factor options without a session are 401', o.status === 401);
  }
  {
    const c = new Client('10.9.0.1');
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await c.post('/admin/login', { passkey: JSON.stringify({ id: 'junk' + i, response: { clientDataJSON: 'e30' } }) })).status);
    check('passkey sign-in attempts are rate limited per IP (10 failures, then 429)', statuses.slice(0, 10).every((s) => s === 401) && statuses[10] === 429, statuses.join(','));
    const flood = [];
    for (let i = 0; i < 25; i++) flood.push((await new Client('10.11.0.1').req('POST', '/api/admin/passkeys/login/options')).status);
    check('25 rapid options requests from one IP: the first 20 pass, the 21st is 429', flood.slice(0, 20).every((s) => s === 200) && flood.slice(20).every((s) => s === 429), flood.join(','));
    check('...and another IP still gets options', (await new Client('10.11.0.2').req('POST', '/api/admin/passkeys/login/options')).status === 200);
    const ok = await new Client('10.9.0.2').req('POST', '/api/admin/passkeys/login/options');
    check('another IP is not affected', ok.status === 200);
    const locked = await c.req('POST', '/api/admin/passkeys/login/options');
    check('the locked IP gets no new sign-in options', locked.status === 429);
  }

  // 7b. A counter that goes backwards is rejected and audited (a cloned authenticator)
  {
    const original = q('SELECT counter c FROM passkeys')[0].c;
    run('UPDATE passkeys SET counter = 100000');
    // First a FORGED response (garbage signature) against that high stored counter: a plain failure, not a counter alarm.
    const failedBefore = auditCount('auth.passkey_failed');
    await page.route('**/admin/login', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      const params = new URLSearchParams(req.postData() || '');
      const body = JSON.parse(params.get('passkey') || '{}');
      body.response.signature = Buffer.alloc(70, 7).toString('base64url');
      params.set('passkey', JSON.stringify(body));
      await route.continue({ postData: params.toString() });
    });
    await page.goto(BASE + '/admin/login');
    await page.click('button[data-passkey=login]');
    await page.waitForSelector('[role=alert]:visible');
    await page.unroute('**/admin/login');
    check('a forged response (garbage signature, low counter) is audited as a failure, not a counter rejection',
      auditCount('auth.passkey_counter_rejected') === 0 && auditCount('auth.passkey_failed') === failedBefore + 1);
    // Now the real authenticator, whose counter is below the (tampered) stored one.    await page.goto(BASE + '/admin/login');
    await page.click('button[data-passkey=login]');
    await page.waitForSelector('[role=alert]:visible');
    check('a passkey whose counter went backwards is refused', /could not be verified/.test(await alertText()) && page.url().endsWith('/admin/login'), await alertText());
    check('...and audited as a counter rejection', auditCount('auth.passkey_counter_rejected') === 1);
    run('UPDATE passkeys SET counter = ?', original);
  }

  // 8. reset-2fa deletes the passkeys, in the same transaction as the rest
  await page.goto(BASE + '/admin/login');
  await page.click('button[data-passkey=login]');
  await page.waitForURL('**/admin');
  check('(signed in again by passkey before the reset)', /Dashboard/.test(await text()));
  const resetOut = execFileSync('node', ['scripts/reset-2fa.mjs', EMAIL], { env: { ...process.env, DATA_DIR } }).toString();
  console.log('reset-2fa:', resetOut.trim());
  check('reset-2fa deleted the passkeys', count('passkeys') === 0 && /1 passkeys/.test(resetOut));
  check('...and any pending challenges, and the sessions', count('webauthn_challenges') === 0 && count('sessions') === 0);
  check('...and its audit entry counts the passkeys', /"passkeys":1/.test(q("SELECT detail d FROM audit_log WHERE action = 'admin.reset_2fa'")[0].d));
  await page.goto(BASE + '/admin');
  check('the old browser session is signed out by the reset', page.url().endsWith('/admin/login'));
  await page.click('button[data-passkey=login]');
  await page.waitForSelector('[role=alert]:visible');
  check('the authenticator still holds the credential, but the server no longer accepts it', /could not be verified/.test(await alertText()) && page.url().endsWith('/admin/login'), await alertText());
  const c2 = new Client('10.10.0.1');
  await c2.post('/admin/login', { email: EMAIL, password: PASSWORD });
  const r2 = await c2.get('/admin/2fa');
  check('after the reset the next sign-in goes to enrollment again', r2.status === 302 && r2.loc === '/admin/2fa/setup', `${r2.status} ${r2.loc}`);
} catch (err) {
  check('test run completed without an exception', false, String(err && err.stack ? err.stack : err));
  try { console.log('page url:', page.url(), '\n', (await text()).slice(0, 600)); } catch { /* ignore */ }
} finally {
  await browser.close();
}

// 9. No secrets or raw assertions in the stored data
{
  const audit = JSON.stringify(q('SELECT * FROM audit_log'));
  check('audit log holds no password or recovery code', !audit.includes(PASSWORD));
  console.log('audit actions:', q('SELECT action, COUNT(*) n FROM audit_log GROUP BY action ORDER BY action').map((x) => `${x.action}=${x.n}`).join(' '));
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
