#!/usr/bin/env node
// End-to-end check of editor sign-in against a RUNNING built server and a throwaway data folder.
//   DATA_DIR=/tmp/x AUTH_SECRET=<32+ chars> SITE_URL=http://localhost:4396 TRUST_PROXY=true PORT=4396 node dist/server/entry.mjs &
//   DATA_DIR=/tmp/x SITE_URL=http://localhost:4396 node scripts/test-editor-auth.mjs
// Uses synthetic data only. TRUST_PROXY=true lets the test use a different X-Forwarded-For per scenario.
// Cookies are sent by hand (the session cookie is Secure, which curl's jar won't send over http).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const BASE = (process.env.SITE_URL || 'http://localhost:4396').replace(/\/+$/, '');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '');
if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to the throwaway data folder the server uses.');

const EMAIL = 'tester@example.test';
const PASSWORD = 'correct horse battery staple 42';
let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};

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
      const [k, v] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (k === '__Host-imc_session') this.cookie = v ? `${k}=${v}` : '';
    }
    const text = await res.text();
    return { status: res.status, loc: res.headers.get('location'), text, cc: res.headers.get('cache-control'),
      error: (/role="alert"[^>]*>([^<]*)</.exec(text) || [])[1] };
  }
  get(u) { return this.req('GET', u); }
  post(u, f) { return this.req('POST', u, f); }
}
const code = (secret, offset = 0) =>
  new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + offset * 30000 });
const wrongCode = (secret) => {
  const valid = new Set([-1, 0, 1].map((o) => code(secret, o)));
  for (let i = 0; i < 1e6; i += 7919) { const c = String(i).padStart(6, '0'); if (!valid.has(c)) return c; }
};

// 1. Bootstrap invite (synthetic admin)
const out = execFileSync('node', ['scripts/create-admin.mjs', EMAIL, 'Test Editor'], { env: { ...process.env, DATA_DIR } }).toString();
const invitePath = new URL(out.match(/https?:\/\/\S+/)[0]).pathname;

const a = new Client('10.1.0.1');
let r = await a.get('/admin');
check('dashboard without a session redirects to login', r.status === 302 && r.loc === '/admin/login');
r = await a.get('/admin/invite');
check('bare /admin/invite is not open', r.status === 302 && r.loc === '/admin/login');
r = await a.get('/api/admin/anything');
check('API without a session is 401', r.status === 401);

r = await a.get(invitePath);
check('invite page shows the form with the name prefilled', r.status === 200 && r.text.includes('value="Test Editor"'));
check('admin pages are no-store', /no-store/.test(r.cc || ''));
r = await a.post(invitePath, { name: 'Test Editor', password: 'short', confirm: 'short' });
check('short password rejected', r.status === 200 && /at least 12/.test(r.error || ''), r.error);
r = await a.post(invitePath, { name: 'Test Editor', password: 'password1234', confirm: 'password1234' });
check('common password rejected', /too common/.test(r.error || ''), r.error);
r = await a.post(invitePath, { name: 'Test Editor', password: EMAIL, confirm: EMAIL });
check('password equal to email rejected', /email/.test(r.error || ''), r.error);
r = await a.post(invitePath, { name: 'Test Editor', password: PASSWORD, confirm: PASSWORD });
check('invite accepted, sent to 2FA enrollment', r.status === 303 && r.loc === '/admin/2fa/setup' && a.cookie.startsWith('__Host-imc_session='), `${r.status} ${r.loc}`);
const b = new Client('10.1.0.2');
r = await b.get(invitePath);
check('invite link is single-use', r.status === 404);

// 2. Dashboard unreachable until 2FA is enrolled
for (const p of ['/admin', '/admin/account']) {
  r = await a.get(p);
  check(`${p} unreachable before enrollment`, r.status === 302 && r.loc === '/admin/2fa', `${r.status} ${r.loc}`);
}
r = await a.get('/api/admin/anything');
check('API unreachable before enrollment', r.status === 403);
r = await a.get('/admin/2fa');
check('/admin/2fa sends an unenrolled user to setup', r.status === 302 && r.loc === '/admin/2fa/setup');

// 3. TOTP enrollment
r = await a.get('/admin/2fa/setup');
const secret = (/class="totp-secret[^>]*>([^<]+)</.exec(r.text) || [])[1]?.replace(/\s/g, '');
check('setup shows a QR code (inline SVG) and a manual key', r.status === 200 && r.text.includes('<svg') && /^[A-Z2-7]{32}$/.test(secret || ''));
check('no external scripts on the setup page', !/<script[^>]+src=/i.test(r.text));
const again = await a.get('/admin/2fa/setup');
check('reload shows the same pending secret', again.text.includes(secret.match(/.{4}/g).join(' ')));
const preRotate = a.cookie;
r = await a.post('/admin/2fa/setup', { code: wrongCode(secret) });
check('wrong code rejected at enrollment', r.status === 401 && !!r.error);
r = await a.post('/admin/2fa/setup', { code: code(secret) });
const recovery = [...r.text.matchAll(/<code[^>]*>([A-Z2-9]{5}-[A-Z2-9]{5})<\/code>/g)].map((m) => m[1]);
check('enrollment confirmed, 10 recovery codes shown once', r.status === 200 && recovery.length === 10 && new Set(recovery).size === 10, `${r.status} ${recovery.length}`);
check('session id rotated after enrollment', a.cookie !== preRotate);
const stale = new Client('10.1.0.1'); stale.cookie = preRotate;
r = await stale.get('/admin');
check('pre-rotation cookie no longer works', r.status === 302 && r.loc === '/admin/login');
r = await a.get('/admin');
check('dashboard reachable after enrollment', r.status === 200 && r.text.includes('Dashboard'));
r = await a.get('/admin/2fa/setup');
check('setup refused once a factor is confirmed', r.status === 403);

// 4. Sign out, sign in with password + TOTP
r = await a.post('/api/admin/logout', {});
check('sign out', r.status === 303 && r.loc === '/admin/login');
r = await a.get('/admin');
check('dashboard unreachable after sign-out', r.status === 302);

const c = new Client('10.2.0.1');
r = await c.post('/admin/login', { email: EMAIL, password: PASSWORD });
check('password step ok, goes to 2FA', r.status === 303 && r.loc === '/admin/2fa');
r = await c.get('/admin');
check('password alone does not reach the dashboard', r.status === 302 && r.loc === '/admin/2fa');
const pendingCookie = c.cookie;
r = await c.post('/admin/2fa', { code: wrongCode(secret) });
check('wrong TOTP rejected', r.status === 401 && r.error === 'That code is not valid.');
r = await c.post('/admin/2fa', { code: code(secret) }); // same step as enrollment: replay
check('TOTP replayed from the enrollment step rejected', r.status === 401);
const fresh1 = code(secret, 1);
r = await c.post('/admin/2fa', { code: fresh1 });
if (r.status === 401) r = await c.post('/admin/2fa', { code: code(secret, 0) }); // clock moved to the next step
check('fresh TOTP accepted, dashboard reached', r.status === 303 && r.loc === '/admin');
check('session id rotated after the second factor', c.cookie !== pendingCookie);
r = await c.get('/admin');
check('dashboard 200 with TOTP session', r.status === 200);
const usedCode = code(secret, 1) === fresh1 ? fresh1 : code(secret, 0);
await c.post('/api/admin/logout', {});
const d = new Client('10.2.0.2');
await d.post('/admin/login', { email: EMAIL, password: PASSWORD });
r = await d.post('/admin/2fa', { code: usedCode });
check('replayed TOTP (same step) rejected on a new sign-in', r.status === 401);

// 5. canEnrollWithoutMfa: a password-only session cannot enroll for a user who already has a factor
const dbBefore = new DatabaseSync(path.join(DATA_DIR, 'imconnected.db'));
const credBefore = JSON.stringify(dbBefore.prepare('SELECT * FROM totp_credentials').all());
r = await d.get('/admin/2fa/setup');
check('password-only session: setup page refused', r.status === 403, String(r.status));
r = await d.post('/admin/2fa/setup', { code: code(secret, 1) });
check('password-only session: enrolling is refused', r.status === 403, String(r.status));
r = await d.get('/admin');
check('...and the session is still not 2FA-verified', r.status === 302 && r.loc === '/admin/2fa');
check('...and the stored credential is unchanged', credBefore === JSON.stringify(dbBefore.prepare('SELECT * FROM totp_credentials').all()));
dbBefore.close();

// 6. Recovery code: counts as the second factor, once
r = await d.post('/admin/2fa', { code: recovery[0].toLowerCase() });
check('recovery code accepted as the second factor', r.status === 303 && r.loc === '/admin', `${r.status}`);
await d.post('/api/admin/logout', {});
const e = new Client('10.2.0.3');
await e.post('/admin/login', { email: EMAIL, password: PASSWORD });
r = await e.post('/admin/2fa', { code: recovery[0] });
check('the same recovery code fails the second time', r.status === 401);
r = await e.post('/admin/2fa', { code: recovery[1] });
check('a different recovery code works', r.status === 303 && r.loc === '/admin');

// 7. My account
r = await e.get('/admin/account');
check('account page lists sessions and 8 of 10 codes', r.status === 200 && /8 of 10 unused/.test(r.text) && r.text.includes('This session'));
const other = new Client('10.2.0.4');
await other.post('/admin/login', { email: EMAIL, password: PASSWORD });
await other.post('/admin/2fa', { code: recovery[2] });
r = await other.get('/admin');
check('second session signed in', r.status === 200);
r = await e.post('/admin/account', { action: 'password', current: 'wrong password here', next: 'another long password 99', confirm: 'another long password 99', code: recovery[3] });
check('password change needs the current password', r.status === 401 && /current password/.test(r.error || ''));
const NEW_PASSWORD = 'another long password 99';
r = await e.post('/admin/account', { action: 'password', current: PASSWORD, next: NEW_PASSWORD, confirm: NEW_PASSWORD, code: wrongCode(secret) });
check('password change needs a fresh second factor', r.status === 401);
r = await e.post('/admin/account', { action: 'password', current: PASSWORD, next: NEW_PASSWORD, confirm: NEW_PASSWORD, code: recovery[3] });
check('password changed', r.status === 200 && /Password changed/.test(r.text), r.error);
r = await other.get('/admin');
check('password change signed out the other session', r.status === 302);
r = await e.get('/admin');
check('current session survives', r.status === 200);
r = await e.post('/admin/account', { action: 'recovery', code: recovery[4] });
const regenerated = [...r.text.matchAll(/<code[^>]*>([A-Z2-9]{5}-[A-Z2-9]{5})<\/code>/g)].map((m) => m[1]);
check('recovery codes regenerated (10 new)', regenerated.length === 10 && !regenerated.some((x) => recovery.includes(x)));
const f = new Client('10.2.0.5');
await f.post('/admin/login', { email: EMAIL, password: NEW_PASSWORD });
r = await f.post('/admin/2fa', { code: recovery[5] });
check('old recovery codes stop working after regenerating', r.status === 401);
r = await f.post('/admin/2fa', { code: regenerated[0] });
check('new password + new recovery code sign in', r.status === 303 && r.loc === '/admin');
r = await f.get('/admin/account');
const ref = (/name="ref" value="([0-9a-f]{16})"/.exec(r.text) || [])[1];
check('other sessions listed with a revoke button', !!ref);
r = await f.post('/admin/account', { action: 'revoke', ref });
check('session revoked', /Session signed out/.test(r.text));
r = await e.get('/admin');
check('revoked session is gone', r.status === 302);
r = await new Client('10.2.0.6').post('/admin/login', { email: EMAIL, password: PASSWORD });
check('old password no longer works', r.status === 401);

// 8. Rate limits: identical errors, lockouts
const bad = [];
const g = new Client('10.3.0.1');
bad.push((await g.post('/admin/login', { email: EMAIL, password: 'definitely wrong 1' })).error);
bad.push((await new Client('10.3.0.2').post('/admin/login', { email: 'ghost@example.test', password: 'definitely wrong 1' })).error);
check('same error text for wrong password and unknown email', bad[0] === bad[1] && bad[0] === 'Email or password is incorrect.', JSON.stringify(bad));
// per-account lockout (fresh IPs each time so only the account counter trips)
for (let i = 2; i <= 5; i++) await new Client(`10.3.1.${i}`).post('/admin/login', { email: EMAIL, password: 'definitely wrong ' + i });
const locked1 = await new Client('10.3.9.1').post('/admin/login', { email: EMAIL, password: NEW_PASSWORD });
check('account locked after 5 failures, even with the right password', locked1.status === 429 && !!locked1.error, `${locked1.status}`);
for (let i = 1; i <= 5; i++) await new Client(`10.3.2.${i}`).post('/admin/login', { email: 'ghost@example.test', password: 'definitely wrong ' + i });
const locked2 = await new Client('10.3.9.2').post('/admin/login', { email: 'ghost@example.test', password: 'whatever it is 123' });
check('unknown email locks out identically', locked2.status === 429 && locked2.error === locked1.error, `${locked2.error} vs ${locked1.error}`);
// per-IP lockout
const h = new Client('10.4.0.1');
for (let i = 0; i < 10; i++) await h.post('/admin/login', { email: `nobody${i}@example.test`, password: 'definitely wrong' });
const locked3 = await h.post('/admin/login', { email: 'another@example.test', password: 'definitely wrong' });
check('IP locked after 10 failures', locked3.status === 429 && locked3.error === locked1.error, `${locked3.status}`);

// 9. Nothing secret in the database files
const needles = { password: PASSWORD, 'new password': NEW_PASSWORD, 'TOTP secret': secret, 'TOTP secret (grouped)': secret.match(/.{4}/g).join(' ') };
[...recovery, ...regenerated].forEach((x, i) => { needles[`recovery code ${i}`] = x; needles[`recovery code ${i} (no dash)`] = x.replace('-', ''); });
const files = fs.readdirSync(DATA_DIR).map((n) => path.join(DATA_DIR, n));
const blobs = files.map((p) => fs.readFileSync(p));
const hit = (s) => blobs.some((b) => b.includes(Buffer.from(s)));
check(`grep control: the DB files do contain the email (${files.map((p) => path.basename(p)).join(', ')})`, hit(EMAIL));
const leaked = Object.entries(needles).filter(([, v]) => hit(v)).map(([k]) => k);
check(`no plain password, TOTP secret or recovery code in the database files (${Object.keys(needles).length} values checked)`, leaked.length === 0, leaked.join(', '));
const dbf = new DatabaseSync(path.join(DATA_DIR, 'imconnected.db'));
const audit = dbf.prepare('SELECT action, COUNT(*) n FROM audit_log GROUP BY action ORDER BY action').all().map((x) => `${x.action}=${x.n}`).join(' ');
console.log('audit actions:', audit);
const auditText = JSON.stringify(dbf.prepare('SELECT * FROM audit_log').all());
check('audit log holds no password, secret or code', !Object.values(needles).some((v) => auditText.includes(v)));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
