#!/usr/bin/env node
// End-to-end check of editor account management (invites, roles, disable, reset 2FA, audit log, retention)
// against the BUILT server (dist/server/entry.mjs), a local mock of the Resend API and a throwaway data folder.
//   npm run build
//   DATA_DIR=/tmp/x node scripts/test-editor-accounts.mjs
// The script starts and stops the server (PORT, default 4397) and the mock email API (MOCK_EMAIL_PORT, default 4012).
// Optional: SCREENSHOT_DIR (default $DATA_DIR/../shots) for the 390px screenshots. Playwright is not a dependency
// of the site: PLAYWRIGHT_ROOT (default /opt/node-tools) and CHROMIUM_PATH (default /opt/pw-browsers/chromium).
// Synthetic data only; the site's real email is never contacted (EMAIL_API_URL points at the mock).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TOTP, Secret } from 'otpauth';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { chromium } = createRequire((process.env.PLAYWRIGHT_ROOT || '/opt/node-tools') + '/package.json')('playwright');

if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to a throwaway data folder (it is created if missing).');
const DATA_DIR = path.resolve(process.env.DATA_DIR);
const PORT = Number(process.env.PORT || 4397);
const MAIL_PORT = Number(process.env.MOCK_EMAIL_PORT || 4012);
const BASE = `http://localhost:${PORT}`;
const MAIL = `http://localhost:${MAIL_PORT}`;
const SHOTS = path.resolve(process.env.SCREENSHOT_DIR || path.join(DATA_DIR, '..', 'shots'));
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');
fs.mkdirSync(SHOTS, { recursive: true });

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (sql, ...args) => Number(q(sql, ...args)[0].n);

class Client {
  constructor(ip) { this.ip = ip; this.cookie = ''; }
  async req(method, url, form, extraHeaders = {}) {
    const headers = { Origin: BASE, 'X-Forwarded-For': this.ip, ...extraHeaders };
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
    return {
      status: res.status, loc: res.headers.get('location'), text,
      error: unesc((/class="admin-error"[^>]*>([^<]*)</.exec(text) || [])[1] || ''),
      ok: unesc((/class="admin-ok"[^>]*>([^<]*)</.exec(text) || [])[1] || ''),
    };
  }
  get(u) { return this.req('GET', u); }
  post(u, f, h) { return this.req('POST', u, f, h); }
}
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const totp = (secret, offset = 0) =>
  new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + offset * 30000 });

// ---- people (synthetic) ----
const ADMIN = { email: 'alice.admin@example.test', name: 'Alice <Admin> & Co', password: 'alice admin long password 11', ip: '10.7.0.1' };
const EDITOR = { email: 'eddie.editor@example.test', name: 'Eddie Editor', password: 'eddie editor long password 22', ip: '10.7.1.1' };
const FRAN = { email: 'fran.fallback@example.test', name: 'Fran Fallback' };
const recovery = (u) => u.recovery[u.used++];

// ---- processes ----
const children = [];
const mails = [];
let serverLog = '';
function start(cmd, args, env, onLine) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  child.stderr.on('data', (d) => onLine(String(d)));
  children.push(child);
  return child;
}
const stopAll = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stopAll);

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// Bootstrap the first admin (also applies the migrations), then seed rows the daily cleanup must remove.
const out = execFileSync('node', ['scripts/create-admin.mjs', ADMIN.email, ADMIN.name], { env: { ...process.env, DATA_DIR } }).toString();
const adminInvitePath = new URL(out.match(/https?:\/\/\S+/)[0]).pathname;
const YEAR = 365 * 24 * 3600 * 1000;
{
  const now = Date.now();
  const aid = q('SELECT id FROM users WHERE email = ?', ADMIN.email)[0].id;
  run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('old.invitee@example.test', 'Old Invitee', 'editor', 'invited', ?, ?)", now, now);
  const oid = q("SELECT id FROM users WHERE email = 'old.invitee@example.test'")[0].id;
  run('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)', 'seeded-expired-invite', oid, now - 1000);
  run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', 'seeded-expired-session', aid, now - 9 * 86400000, now - 9 * 86400000, now - 2 * 86400000);
  run("INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at) VALUES (?, 'seeded-expired-challenge', 'login', ?)", aid, now - 1000);
  run("INSERT INTO audit_log (at, user_id, action, target) VALUES (?, ?, 'seed.too_old', NULL)", now - 2 * YEAR - 86400000, aid);
  run("INSERT INTO audit_log (at, user_id, action, target) VALUES (?, ?, 'seed.recent', NULL)", now - YEAR, aid);
}

start('node', ['scripts/mock-email.mjs'], { MOCK_EMAIL_PORT: String(MAIL_PORT) }, (l) => { if (l.startsWith('{')) mails.push(JSON.parse(l)); });
start('node', ['dist/server/entry.mjs'], {
  DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1', AUTH_SECRET: 'e2e-accounts-secret-0123456789abcdefghij', SITE_URL: BASE, TRUST_PROXY: 'true',
  RESEND_API_KEY: 'test-key', EMAIL_FROM: 'IMConnected <noreply@example.test>', EMAIL_API_URL: `${MAIL}/emails`, NODE_ENV: 'production',
}, (l) => { serverLog += l + '\n'; });
for (let i = 0; i < 60; i++) {
  try { await fetch(BASE + '/admin/login', { redirect: 'manual' }); await fetch(MAIL + '/fail-off'); break; } catch { await sleep(250); }
}
const waitMails = async (n) => { for (let i = 0; i < 40 && mails.length < n; i++) await sleep(100); return mails.length >= n; };
const linkOf = (mail) => mail.text.match(/https?:\/\/\S+/)[0];

let browser;
try {
  // ======= 0. Retention at startup (first admin request) =======
  const A = new Client(ADMIN.ip);
  await A.get('/admin/login');
  check('retention: audit entry older than 2 years deleted, 1-year-old entry kept',
    count("SELECT COUNT(*) n FROM audit_log WHERE action = 'seed.too_old'") === 0 && count("SELECT COUNT(*) n FROM audit_log WHERE action = 'seed.recent'") === 1);
  check('retention: expired invite, expired session and expired challenge deleted',
    count("SELECT COUNT(*) n FROM invites WHERE token_hash = 'seeded-expired-invite'") === 0
    && count("SELECT COUNT(*) n FROM sessions WHERE id = 'seeded-expired-session'") === 0
    && count("SELECT COUNT(*) n FROM webauthn_challenges WHERE challenge = 'seeded-expired-challenge'") === 0);

  // ======= 1. First admin accepts the bootstrap invite and enrolls =======
  async function accept(client, invitePath, who) {
    let r = await client.post(invitePath, { name: who.name, password: who.password, confirm: who.password });
    if (r.status !== 303 || r.loc !== '/admin/2fa/setup') return { r };
    r = await client.get('/admin/2fa/setup');
    const secret = (/class="totp-secret[^>]*>([^<]+)</.exec(r.text) || [])[1]?.replace(/\s/g, '');
    r = await client.post('/admin/2fa/setup', { code: totp(secret) });
    const codes = [...r.text.matchAll(/<code[^>]*>([A-Z2-9]{5}-[A-Z2-9]{5})<\/code>/g)].map((m) => m[1]);
    who.secret = secret; who.recovery = codes; who.used = 0;
    return { r, secret, codes };
  }
  const a1 = await accept(A, adminInvitePath, ADMIN);
  check('first admin accepted the invite and enrolled (10 recovery codes)', a1.codes?.length === 10);
  const adminId = q('SELECT id FROM users WHERE email = ?', ADMIN.email)[0].id;

  let r = await A.get('/admin/editors');
  check('admin sees the Editors page with the invite form and the user list',
    r.status === 200 && r.text.includes('Invite someone') && r.text.includes('alice.admin@example.test') && r.text.includes('Manage '));
  check('names are HTML-escaped on the page (no raw <Admin>)', r.text.includes('Alice &lt;Admin&gt; &amp; Co') && !r.text.includes('<Admin>'));
  check('right after sign-in the fresh factor is not asked again (no code field)', !r.text.includes('name="code"'));

  // ======= 2. Invite an editor (email via the mock) =======
  r = await A.post('/admin/editors', { action: 'invite', name: EDITOR.name, email: EDITOR.email.toUpperCase(), role: 'editor' });
  check('invite created and emailed', r.status === 200 && /Invite created\. The invite email was sent\./.test(r.ok), `${r.status} ${r.ok} ${r.error}`);
  check('...the page does not reveal the link when the email went out', !r.text.includes('/admin/invite/') && !r.text.includes('id="invite-link"'));
  check('...the mock received one message', await waitMails(1) && mails.length === 1);
  const m1 = mails[0];
  check('...to the invited address (lower-cased), from the configured sender', m1.to[0] === EDITOR.email && /noreply@example\.test/.test(m1.from));
  check('...it names the inviter, the site and the link (HTML-escaped)',
    m1.html.includes('Alice &lt;Admin&gt; &amp; Co') && !m1.html.includes('Alice <Admin>') && /IMConnected/.test(m1.html) && /\/admin\/invite\/[\w-]{20,}/.test(m1.html) && m1.text.includes('Alice <Admin> & Co'));
  check('...and nothing else about people (no invitee name or email in the body)',
    !m1.html.includes('Eddie') && !m1.text.includes('Eddie') && !m1.html.includes('eddie.editor') && !m1.text.includes('eddie.editor') && !m1.html.includes('alice.admin') && !m1.text.includes('alice.admin'));
  const eddie = q('SELECT * FROM users WHERE email = ?', EDITOR.email)[0];
  check('the user exists as invited with the chosen role', eddie?.status === 'invited' && eddie?.role === 'editor');
  const inv = q('SELECT expires_at, used_at FROM invites WHERE user_id = ?', eddie.id);
  const left = inv[0].expires_at - Date.now();
  check('exactly one invite, valid for 7 days', inv.length === 1 && Math.abs(left - 7 * 86400000) < 120000, String(left));
  const link1 = linkOf(m1);
  check('invite token is stored only as a hash', count('SELECT COUNT(*) n FROM invites WHERE token_hash = ?', link1.split('/').pop()) === 0);

  // duplicate and bad input
  r = await A.post('/admin/editors', { action: 'invite', name: 'X', email: 'not-an-email', role: 'editor' });
  check('invalid email rejected', r.status === 400 && /valid email/.test(r.error), r.error);
  r = await A.post('/admin/editors', { action: 'invite', name: 'X', email: 'x@example.test', role: 'owner' });
  check('unknown role rejected', r.status === 400 && /role/i.test(r.error), r.error);
  r = await A.post('/admin/editors', { action: 'invite', name: 'Alice again', email: ADMIN.email, role: 'editor' });
  check('inviting an address that already has an account is refused', r.status === 400 && /already has an account/.test(r.error), r.error);

  // resend replaces the old invite
  r = await A.post('/admin/editors', { action: 'resend', id: String(eddie.id) });
  check('resending emails a new invite', r.status === 200 && /New invite created/.test(r.ok) && await waitMails(2), `${r.status} ${r.ok} ${r.error}`);
  const link2 = linkOf(mails[1]);
  check('...the old link stops working, still exactly one invite', link1 !== link2 && (await new Client('10.7.9.1').get(new URL(link1).pathname)).status === 404 && count('SELECT COUNT(*) n FROM invites WHERE user_id = ? AND used_at IS NULL', eddie.id) === 1);

  // ======= 3. Copy-link fallback when the email cannot be sent =======
  await fetch(MAIL + '/fail-on');
  r = await A.post('/admin/editors', { action: 'invite', name: FRAN.name, email: FRAN.email, role: 'admin' });
  const shown = (/id="invite-link"[^>]*value="([^"]+)"/.exec(r.text) || /value="([^"]+)"[^>]*id="invite-link"/.exec(r.text) || [])[1];
  check('email failure: the link is shown once, with a copy button', r.status === 200 && /could not be sent/.test(r.ok) && !!shown && /data-copy="invite-link"/.test(r.text) && /readonly/.test(r.text), `${r.status} ${r.ok}`);
  check('...and the shown link opens the accept page (invite carries the admin role)',
    (await new Client('10.7.9.2').get(new URL(shown).pathname)).status === 200 && q('SELECT role FROM users WHERE email = ?', FRAN.email)[0].role === 'admin');
  r = await A.get('/admin/editors');
  check('...a later visit to the page does not show the link again', !r.text.includes(shown) && !r.text.includes('id="invite-link"'));
  r = await A.post('/admin/editors', { action: 'invite', name: FRAN.name, email: FRAN.email, role: 'editor' });
  const shown2 = (/id="invite-link"[^>]*value="([^"]+)"/.exec(r.text) || [])[1];
  check('re-inviting a pending address replaces the old invite and updates the role',
    !!shown2 && shown2 !== shown && (await new Client('10.7.9.3').get(new URL(shown).pathname)).status === 404 && q('SELECT role FROM users WHERE email = ?', FRAN.email)[0].role === 'editor' && count('SELECT COUNT(*) n FROM invites WHERE user_id = (SELECT id FROM users WHERE email = ?)', FRAN.email) === 1);
  await fetch(MAIL + '/fail-off');

  // ======= 4. The editor accepts and enrolls =======
  const E = new Client(EDITOR.ip);
  const e1 = await accept(E, new URL(link2).pathname, EDITOR);
  check('editor accepted the (re-sent) invite and enrolled', e1.codes?.length === 10 && q('SELECT status, role FROM users WHERE id = ?', eddie.id)[0].status === 'active' && q('SELECT role FROM users WHERE id = ?', eddie.id)[0].role === 'editor');
  r = await E.get('/admin');
  check('editor reaches the dashboard', r.status === 200 && r.text.includes('New story'));

  // ======= 5. Editor view and 403s =======
  r = await E.get('/admin/editors');
  check('editor sees the editors list, names only', r.status === 200 && r.text.includes('Eddie Editor') && r.text.includes('Alice &lt;Admin&gt; &amp; Co') && !r.text.includes('@example.test'));
  check('...read-only: no invite form, manage forms or audit link', !r.text.includes('Invite someone') && !r.text.includes('action="/admin/editors"') && !r.text.includes('/admin/audit') && !r.text.includes('Fran Fallback'));
  const rowsBefore = count('SELECT COUNT(*) n FROM users');
  const e403 = [
    ['GET /admin/audit', await E.get('/admin/audit')],
    ['GET /admin/audit?action=x', await E.get('/admin/audit?action=admin.invite')],
    ['GET /api/admin/audit', await E.get('/api/admin/audit')],
    ['GET /api/admin/editors', await E.get('/api/admin/editors')],
    ['POST /api/admin/editors/invite', await E.post('/api/admin/editors/invite', { email: 'z@example.test', name: 'Z', role: 'admin' })],
    ['POST invite', await E.post('/admin/editors', { action: 'invite', name: 'Zed', email: 'zed@example.test', role: 'admin', code: '000000' })],
    ['POST role', await E.post('/admin/editors', { action: 'role', id: String(adminId), role: 'editor', code: '000000' })],
    ['POST disable', await E.post('/admin/editors', { action: 'disable', id: String(adminId), code: '000000' })],
    ['POST enable', await E.post('/admin/editors', { action: 'enable', id: String(adminId), code: '000000' })],
    ['POST reset2fa', await E.post('/admin/editors', { action: 'reset2fa', id: String(adminId), code: '000000' })],
    ['POST resend', await E.post('/admin/editors', { action: 'resend', id: String(adminId), code: '000000' })],
  ];
  for (const [name, res] of e403) check(`editor gets 403 on ${name}`, res.status === 403, String(res.status));
  check('...and nothing changed (no new user, admin still an active admin)', count('SELECT COUNT(*) n FROM users') === rowsBefore && q('SELECT role, status FROM users WHERE id = ?', adminId)[0].role === 'admin' && q('SELECT status FROM users WHERE id = ?', adminId)[0].status === 'active');
  r = await E.get('/admin');
  check('...the editor is still signed in (403 does not end the session)', r.status === 200);
  for (const p of ['/admin/editors', '/admin/audit']) {
    const anon = await new Client('10.7.9.4').get(p);
    check(`signed-out request to ${p} goes to the login page`, anon.status === 302 && anon.loc === '/admin/login');
  }
  r = await A.post('/admin/editors', { action: 'invite', name: 'Evil', email: 'evil@example.test', role: 'admin' }, { Origin: 'http://evil.example' });
  check('cross-origin POST to the Editors page is blocked (403)', r.status === 403 && count("SELECT COUNT(*) n FROM users WHERE email = 'evil@example.test'") === 0);

  // ======= 6. Fresh second factor =======
  const stale = () => run('UPDATE sessions SET fresh_at = 0 WHERE user_id = ?', adminId);
  stale();
  r = await A.get('/admin/editors');
  check('with a stale session the page asks for a code in the forms', r.text.includes('name="code"') && r.text.includes('Authenticator or recovery code'));
  const usersN = count('SELECT COUNT(*) n FROM users');
  const noCode = [
    ['invite', { action: 'invite', name: 'Gina Guest', email: 'gina.guest@example.test', role: 'editor' }],
    ['role', { action: 'role', id: String(eddie.id), role: 'admin' }],
    ['disable', { action: 'disable', id: String(eddie.id) }],
    ['enable', { action: 'enable', id: String(eddie.id) }],
    ['reset2fa', { action: 'reset2fa', id: String(eddie.id) }],
    ['resend', { action: 'resend', id: String(q('SELECT id FROM users WHERE email = ?', FRAN.email)[0].id) }],
  ];
  for (const [name, form] of noCode) {
    const res = await A.post('/admin/editors', form);
    check(`stale session, no code: ${name} refused (401)`, res.status === 401 && /fresh|code|passkey/i.test(res.error), `${res.status} ${res.error}`);
  }
  check('...nothing changed', count('SELECT COUNT(*) n FROM users') === usersN && q('SELECT role, status FROM users WHERE id = ?', eddie.id)[0].role === 'editor' && q('SELECT status FROM users WHERE id = ?', eddie.id)[0].status === 'active' && count('SELECT COUNT(*) n FROM totp_credentials WHERE user_id = ?', eddie.id) === 1);
  r = await A.post('/admin/editors', { action: 'role', id: String(eddie.id), role: 'admin', code: '000000' });
  check('stale session, wrong code: refused (401)', r.status === 401 && q('SELECT role FROM users WHERE id = ?', eddie.id)[0].role === 'editor', `${r.status}`);
  const totpNow = totp(ADMIN.secret, 1);
  r = await A.post('/admin/editors', { action: 'invite', name: 'Gina Guest', email: 'gina.guest@example.test', role: 'editor', code: totpNow });
  check('stale session, a fresh authenticator code: accepted', r.status === 200 && /Invite created/.test(r.ok) && count("SELECT COUNT(*) n FROM users WHERE email = 'gina.guest@example.test'") === 1, `${r.status} ${r.ok} ${r.error}`);
  stale();
  r = await A.post('/admin/editors', { action: 'resend', id: String(q('SELECT id FROM users WHERE email = ?', 'gina.guest@example.test')[0].id), code: recovery(ADMIN) });
  check('stale session, a recovery code: accepted (and used up)', r.status === 200 && /New invite created/.test(r.ok) && count('SELECT COUNT(*) n FROM recovery_codes WHERE user_id = ? AND used_at IS NOT NULL', adminId) === 1, `${r.status} ${r.error}`);
  r = await A.post('/admin/editors', { action: 'resend', id: String(q('SELECT id FROM users WHERE email = ?', 'gina.guest@example.test')[0].id) });
  check('...and the factor then covers the next 10 minutes (no code needed)', r.status === 200 && /New invite created/.test(r.ok), `${r.status} ${r.error}`);
  run('UPDATE sessions SET fresh_at = ? WHERE user_id = ?', Date.now() - 11 * 60 * 1000, adminId);
  r = await A.post('/admin/editors', { action: 'resend', id: String(q('SELECT id FROM users WHERE email = ?', 'gina.guest@example.test')[0].id) });
  check('...but 11 minutes later it is asked for again', r.status === 401, `${r.status}`);
  r = await A.post('/admin/editors', { action: 'resend', id: String(q('SELECT id FROM users WHERE email = ?', 'gina.guest@example.test')[0].id), code: recovery(ADMIN) });
  check('...and a recovery code reopens the window', r.status === 200);

  // ======= 7. Disable: the open session is rejected on the next request =======
  const E2 = new Client('10.7.1.2');
  await E2.post('/admin/login', { email: EDITOR.email, password: EDITOR.password });
  await E2.post('/admin/2fa', { code: recovery(EDITOR) });
  check('editor has two open sessions', (await E.get('/admin')).status === 200 && (await E2.get('/admin')).status === 200 && count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', eddie.id) === 2);
  r = await A.post('/admin/editors', { action: 'disable', id: String(eddie.id) });
  check('admin disables the editor', r.status === 200 && /Account disabled/.test(r.ok) && q('SELECT status FROM users WHERE id = ?', eddie.id)[0].status === 'disabled', `${r.status} ${r.error}`);
  check('...all their sessions were deleted at once', count('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', eddie.id) === 0);
  for (const [label, c] of [['first', E], ['second', E2]]) {
    const pg = await c.get('/admin');
    const api = await c.get('/api/admin/anything');
    check(`the ${label} open session is rejected on the next request (page redirects to login, API 401)`, pg.status === 302 && pg.loc === '/admin/login' && api.status === 401, `${pg.status} ${api.status}`);
  }
  const E3 = new Client('10.7.1.3');
  r = await E3.post('/admin/login', { email: EDITOR.email, password: EDITOR.password });
  check('a disabled editor cannot sign in', r.status !== 303 && !E3.cookie, `${r.status}`);
  r = await A.post('/admin/editors', { action: 'enable', id: String(eddie.id) });
  check('admin re-enables the editor', r.status === 200 && /re-enabled/.test(r.ok) && q('SELECT status FROM users WHERE id = ?', eddie.id)[0].status === 'active');
  const E4 = new Client('10.7.1.4');
  await E4.post('/admin/login', { email: EDITOR.email, password: EDITOR.password });
  r = await E4.post('/admin/2fa', { code: recovery(EDITOR) });
  check('...and the editor can sign in again', r.status === 303 && r.loc === '/admin' && (await E4.get('/admin')).status === 200);

  // ======= 8. Last active admin =======
  r = await A.post('/admin/editors', { action: 'disable', id: String(adminId) });
  check('the last active admin cannot disable themselves (409)', r.status === 409 && /last active administrator/.test(r.error) && q('SELECT status FROM users WHERE id = ?', adminId)[0].status === 'active', `${r.status} ${r.error}`);
  r = await A.post('/admin/editors', { action: 'role', id: String(adminId), role: 'editor' });
  check('...nor demote themselves (409)', r.status === 409 && q('SELECT role FROM users WHERE id = ?', adminId)[0].role === 'admin', `${r.status} ${r.error}`);
  check('...still signed in as an admin', (await A.get('/admin/audit')).status === 200);
  check('...both refusals are in the audit log', count("SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.last_admin_refused'") === 2);
  r = await A.post('/admin/editors', { action: 'role', id: String(eddie.id), role: 'admin' });
  check('admin promotes the editor to admin', r.status === 200 && /Role changed/.test(r.ok) && q('SELECT role FROM users WHERE id = ?', eddie.id)[0].role === 'admin');
  check('...their open session sees the new role at once (audit log now 200)', (await E4.get('/admin/audit')).status === 200 && (await E4.get('/admin/editors')).text.includes('Invite someone'));
  r = await A.post('/admin/editors', { action: 'role', id: String(adminId), role: 'editor' });
  check('with another active admin, the first admin can demote themselves', r.status === 200 && q('SELECT role FROM users WHERE id = ?', adminId)[0].role === 'editor', `${r.status} ${r.error}`);
  check('...and is an editor immediately (audit 403, POST 403)', (await A.get('/admin/audit')).status === 403 && (await A.post('/admin/editors', { action: 'invite', name: 'N', email: 'n@example.test', role: 'editor', code: '1' })).status === 403);
  r = await E4.post('/admin/editors', { action: 'disable', id: String(eddie.id) });
  check('the remaining admin is now the last one: cannot disable themselves', r.status === 409 && q('SELECT status FROM users WHERE id = ?', eddie.id)[0].status === 'active', `${r.status} ${r.error}`);
  r = await E4.post('/admin/editors', { action: 'role', id: String(adminId), role: 'admin' });
  check('...promotes the first admin back', r.status === 200 && q('SELECT role FROM users WHERE id = ?', adminId)[0].role === 'admin', `${r.status} ${r.error}`);
  r = await A.post('/admin/editors', { action: 'role', id: String(eddie.id), role: 'editor' });
  check('...and the first admin makes them an editor again', r.status === 200 && q('SELECT role FROM users WHERE id = ?', eddie.id)[0].role === 'editor', `${r.status} ${r.error}`);
  check('...E4 is an editor again (403 on the audit log)', (await E4.get('/admin/audit')).status === 403);

  // ======= 9. Reset 2FA =======
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const alertText = async () => (await page.locator('[role=alert]:visible').allInnerTexts()).join(' | ');

  page.on('response', (rs) => { if (process.env.DEBUG_NAV) console.log('   ', rs.request().method(), rs.url(), rs.status(), rs.headers()['set-cookie'] ? 'set-cookie' : ''); });
  await page.goto(BASE + '/admin/login');
  await page.fill('#email', EDITOR.email);
  await page.fill('#password', EDITOR.password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin/2fa');
  await page.fill('#code', recovery(EDITOR));
  await page.click('form[action="/admin/2fa"] button[type=submit]');
  await page.waitForURL('**/admin').catch(async (e) => { throw new Error(e.message + ' | at ' + page.url() + ' | ' + (await page.locator('main').innerText()).slice(0, 300)); });
  await page.goto(BASE + '/admin/account');
  await page.fill('#pk-name', 'Eddie laptop key');
  await page.fill('#pk-code', recovery(EDITOR));
  await page.click('#pk-name ~ button[data-passkey=register]');
  await page.waitForSelector('text=Passkey added');
  check('editor now has an authenticator app, a passkey and recovery codes', count('SELECT COUNT(*) n FROM passkeys WHERE user_id = ?', eddie.id) === 1 && count('SELECT COUNT(*) n FROM totp_credentials WHERE user_id = ?', eddie.id) === 1 && count('SELECT COUNT(*) n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', eddie.id) > 0);
  await ctx.clearCookies();
  const oldSecret = EDITOR.secret;
  const oldRecovery = EDITOR.recovery[EDITOR.used]; // an unused code from before the reset
  const E5 = new Client('10.7.1.5');
  await E5.post('/admin/login', { email: EDITOR.email, password: EDITOR.password });
  await E5.post('/admin/2fa', { code: recovery(EDITOR) });
  check('editor has an open session before the reset', (await E5.get('/admin')).status === 200);

  // seed a pending challenge so the reset has one to remove
  run("INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at) VALUES (?, 'pending-reset-check', 'fresh', ?)", eddie.id, Date.now() + 300000);
  stale();
  r = await A.post('/admin/editors', { action: 'reset2fa', id: String(eddie.id) });
  check('reset 2FA needs the admin\'s fresh factor (401 without)', r.status === 401 && count('SELECT COUNT(*) n FROM passkeys WHERE user_id = ?', eddie.id) === 1);
  r = await A.post('/admin/editors', { action: 'reset2fa', id: String(adminId), code: recovery(ADMIN) });
  check('an admin cannot reset their own 2FA here (use My account)', r.status === 400 && count('SELECT COUNT(*) n FROM totp_credentials WHERE user_id = ?', adminId) === 1, `${r.status} ${r.error}`);
  r = await A.post('/admin/editors', { action: 'reset2fa', id: String(eddie.id), code: recovery(ADMIN) });
  check('admin resets the editor\'s 2FA', r.status === 200 && /Two-step sign-in reset/.test(r.ok), `${r.status} ${r.error}`);
  check('...authenticator, passkeys, recovery codes, pending challenges and sessions all removed',
    ['totp_credentials', 'passkeys', 'recovery_codes', 'webauthn_challenges', 'sessions'].every((t) => count(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, eddie.id) === 0));
  check('...the account and password are kept', q('SELECT status FROM users WHERE id = ?', eddie.id)[0].status === 'active' && count('SELECT COUNT(*) n FROM password_credentials WHERE user_id = ?', eddie.id) === 1);
  r = await E5.get('/admin');
  check('...the editor\'s open session is rejected', r.status === 302 && r.loc === '/admin/login');

  const E6 = new Client('10.7.1.6');
  r = await E6.post('/admin/login', { email: EDITOR.email, password: EDITOR.password });
  check('next sign-in: password works but there is no dashboard yet', r.status === 303 && (await E6.get('/admin')).status === 302);
  r = await E6.get('/admin/2fa');
  check('...and enrollment is forced (2FA page sends them to setup)', r.status === 302 && r.loc === '/admin/2fa/setup', `${r.status} ${r.loc}`);
  r = await E6.post('/admin/2fa', { code: oldRecovery });
  check('old recovery codes do not work', r.status === 302 && (await E6.get('/admin')).status === 302);
  r = await E6.post('/admin/2fa', { code: totp(oldSecret, 1) });
  check('old authenticator codes do not work on the sign-in step', r.status === 302 && (await E6.get('/admin')).status === 302);
  r = await E6.post('/admin/2fa/setup', { code: totp(oldSecret, 0) });
  check('...nor as an enrollment code (the old secret is gone)', r.status === 401 && (await E6.get('/admin')).status === 302, `${r.status}`);

  await page.goto(BASE + '/admin/login');
  await page.click('button[data-passkey=login]');
  await page.waitForLoadState('load');
  await sleep(500);
  const afterPk = await page.goto(BASE + '/admin');
  check('the old passkey (still on the device) no longer signs in', page.url().includes('/admin/login') && afterPk.status() === 200, page.url());
  check('...the failed passkey attempt is audited', count("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.passkey_failed'") >= 1);

  let secret2 = (/class="totp-secret[^>]*>([^<]+)</.exec((await E6.get('/admin/2fa/setup')).text) || [])[1]?.replace(/\s/g, '');
  r = await E6.post('/admin/2fa/setup', { code: totp(secret2) });
  const codes2 = [...r.text.matchAll(/<code[^>]*>([A-Z2-9]{5}-[A-Z2-9]{5})<\/code>/g)].map((m) => m[1]);
  check('the editor enrolls again with a new secret, gets new recovery codes and reaches the dashboard',
    secret2 !== oldSecret && codes2.length === 10 && !codes2.includes(oldRecovery) && (await E6.get('/admin')).status === 200);

  // ======= 10. Audit log =======
  const wanted = ['admin.bootstrap', 'auth.invite_accepted', 'admin.invite', 'admin.invite_resent', 'admin.role_changed', 'admin.disabled', 'admin.enabled', 'admin.last_admin_refused', 'admin.reset_2fa', 'auth.fresh_verified', 'auth.totp_enrolled'];
  for (const a of wanted) check(`audit log has ${a}`, count('SELECT COUNT(*) n FROM audit_log WHERE action = ?', a) >= 1);
  check('...with the acting admin as actor and the editor as target', count("SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.disabled' AND user_id = ? AND target = ?", adminId, `user:${eddie.id}`) === 1 && count("SELECT COUNT(*) n FROM audit_log WHERE action = 'admin.reset_2fa' AND user_id = ? AND target = ?", adminId, `user:${eddie.id}`) === 1);
  check('...and no email address or token anywhere in the audit table', count("SELECT COUNT(*) n FROM audit_log WHERE detail LIKE '%@%' OR target LIKE '%@%' OR detail LIKE '%invite/%'") === 0);

  // synthetic rows to page through, plus hostile text that must be escaped
  {
    const db = new DatabaseSync(DB_FILE);
    const ins = db.prepare('INSERT INTO audit_log (at, user_id, action, target, ip) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 120; i++) ins.run(Date.now() - 1000 * i - 5000, adminId, 'test.synthetic', 'item:' + i, '203.0.113.5');
    ins.run(Date.now() - 1, null, 'x<script>alert(1)</script>', '<img src=x onerror=alert(2)>', '<b>9.9.9.9</b>');
    db.close();
  }
  await A.get('/admin/editors'); // make sure A's session is current
  r = await A.get('/admin/audit');
  check('audit page lists entries with actor name, action, target, time and IP', r.status === 200 && r.text.includes('admin.reset_2fa') && r.text.includes('Eddie Editor (user:' + eddie.id + ')') && r.text.includes('Alice &lt;Admin&gt; &amp; Co') && /<time datetime=/.test(r.text) && r.text.includes('10.7.0.1'));
  check('everything is escaped (no raw script, img or b tags from log text)', !r.text.includes('<script>alert') && !r.text.includes('<img src=x') && !r.text.includes('<b>9.9.9.9') && r.text.includes('x&lt;script&gt;'), JSON.stringify([r.text.includes('<script>alert'), r.text.includes('<img src=x'), r.text.includes('<b>9.9.9.9'), r.text.includes('x&lt;script&gt;'), (r.text.match(/.{80}<script>alert.{20}/s)||[])[0]]));
  r = await A.get('/admin/audit?action=test.synthetic');
  const items = (t) => (t.match(/class="ad-item au-item"/g) || []).length;
  check('filter by action + pagination: page 1 has 50 of 120, "Older" link, no "Newer"', items(r.text) === 50 && /page 1 of 3/.test(r.text) && r.text.includes('rel="next"') && !r.text.includes('rel="prev"'));
  const p2 = await A.get('/admin/audit?action=test.synthetic&page=2');
  const p3 = await A.get('/admin/audit?action=test.synthetic&page=3');
  const p9 = await A.get('/admin/audit?action=test.synthetic&page=99');
  check('...page 2 differs, page 3 has the last 20, a too-high page clamps to the last', items(p2.text) === 50 && p2.text !== r.text && items(p3.text) === 20 && items(p9.text) === 20 && /rel="prev"/.test(p3.text) && !/rel="next"/.test(p3.text));
  check('...filter links keep the filter', /href="\/admin\/audit\?action=test\.synthetic&amp;page=2"/.test(r.text) || /href="\/admin\/audit\?action=test\.synthetic&page=2"/.test(r.text));
  r = await A.get('/admin/audit?user=' + eddie.id);
  check('filter by person: only that person\'s entries', r.status === 200 && r.text.includes('au-action">auth.login') && !r.text.includes('au-action">admin.invite_resent') && !r.text.includes('au-action">admin.reset_2fa'), (r.text.match(/au-action[^<]*</g) || []).slice(0, 5).join(' '));
  r = await A.get('/admin/audit?user=abc&action=nope&page=-4');
  check('junk filter values are ignored, not an error', r.status === 200 && r.text.includes('admin.bootstrap') || r.status === 200);

  // ======= 11. Phone width (390px) =======
  const mctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const mp = await mctx.newPage();
  mp.setDefaultTimeout(15000);
  await mp.goto(BASE + '/admin/login');
  await mp.fill('#email', ADMIN.email);
  await mp.fill('#password', ADMIN.password);
  await mp.click('button[type=submit]');
  await mp.waitForURL('**/admin/2fa');
  await mp.fill('#code', recovery(ADMIN));
  await mp.click('form[action="/admin/2fa"] button[type=submit]');
  await mp.waitForURL('**/admin');
  const noOverflow = async (label) => {
    const w = await mp.evaluate(() => document.documentElement.scrollWidth);
    check(`390px: ${label} has no horizontal scroll (scrollWidth ${w})`, w <= 390);
  };
  await mp.goto(BASE + '/admin/editors');
  await mp.screenshot({ path: path.join(SHOTS, 'editors-390.png'), fullPage: true });
  await noOverflow('editors page');
  await mp.locator('details.ec-manage summary').first().click();
  await mp.screenshot({ path: path.join(SHOTS, 'editors-390-manage-open.png'), fullPage: true });
  await noOverflow('editors page with a manage panel open');
  const small = await mp.evaluate(() => [...document.querySelectorAll('main button, main a.ad-btn, main summary, main input:not([type=hidden]), main select')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => e.tagName + ':' + (e.name || e.textContent.trim().slice(0, 20))));
  check('390px: buttons, inputs and selects are at least 40px tall', small.length === 0, small.join(', '));
  await mp.goto(BASE + '/admin/audit');
  await mp.screenshot({ path: path.join(SHOTS, 'audit-390.png'), fullPage: false });
  await noOverflow('audit page');
  // invite link panel (mail fails so the link is shown) at phone width
  await fetch(MAIL + '/fail-on');
  await mp.goto(BASE + '/admin/editors');
  await mp.fill('#inv-name', 'Hal Phone');
  await mp.fill('#inv-email', 'hal.phone@example.test');
  await mp.click('main section form button[type=submit]');
  await mp.waitForSelector('#invite-link');
  await mp.screenshot({ path: path.join(SHOTS, 'editors-390-link.png'), fullPage: false });
  await noOverflow('invite link panel');
  await mp.click('button[data-copy]');
  check('390px: the copy button selects the link', await mp.evaluate(() => { const i = document.getElementById('invite-link'); return i.selectionEnd - i.selectionStart === i.value.length; }));
  await fetch(MAIL + '/fail-off');
  await mctx.close();

  // ======= 12. Logs =======
  check('server output holds no email address or invite token', !/@example\.test/.test(serverLog) && !/\/admin\/invite\/\w/.test(serverLog), serverLog.slice(0, 300));
} catch (err) {
  console.log('FAIL  script error: ' + (err && err.stack ? err.stack : err));
  fails++;
} finally {
  try { await browser?.close(); } catch { /* closed */ }
  stopAll();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
