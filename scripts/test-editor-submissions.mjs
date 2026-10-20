#!/usr/bin/env node
// End-to-end check of "public submissions and Studio publishes go into the dashboard" (issue 14).
// It starts everything itself: the mock GitHub API, the mock email API, a tiny Discord stand-in and three
// copies of the BUILT server (dashboard mode, SUBMISSIONS_TO=github, and a server whose database can't be opened).
// Synthetic data only; no real email, no Turnstile (unset), DNS answered by scripts/test-dns-preload.cjs.
//   npm run build
//   SCRATCH=/tmp/imc-e2e node scripts/test-editor-submissions.mjs     # run from the repo root
// SCRATCH is created fresh (an existing folder is removed first) and deleted at the end unless KEEP=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
if (!process.env.SCRATCH) throw new Error('Set SCRATCH to a throwaway folder.');
const SCRATCH = path.resolve(process.env.SCRATCH);
// Refuse to wipe anything that is not clearly a throwaway folder (the Docker image's DATA_DIR is /data).
function assertThrowaway(dir) {
  const real = path.resolve(dir);
  const roots = [os.tmpdir(), '/tmp'].map((r) => path.resolve(r) + path.sep);
  if (real === '/data' || real.startsWith('/data' + path.sep) || !roots.some((r) => real.startsWith(r) && real.length > r.length)) {
    throw new Error(`Refusing to delete ${real}: point this at a throwaway folder under ${os.tmpdir()}.`);
  }
}
assertThrowaway(SCRATCH);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const DATA_DIR = path.join(SCRATCH, 'data');
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');
const MOCK_OUT = path.join(SCRATCH, 'mock-prs');
const DIRECT = path.join(MOCK_OUT, 'direct');
const P = { gh: 4410, mail: 4411, discord: 4412, a: 4421, b: 4422, c: 4423 };
const BASE = `http://localhost:${P.a}`;
const BASE_B = `http://localhost:${P.b}`;
const BASE_C = `http://localhost:${P.c}`;
const CONFIRM_SECRET = 'e2e-confirm-secret-' + 'x'.repeat(20);
const PUBLISH_TOKEN = 'e2e-made-up-publish-token-' + 'y'.repeat(20);

// Synthetic personal data we must never see in logs, editor emails or commits.
const SUBMITTER = { name: 'Riley Sample', email: 'riley.sample@e2e-mail.com', phone: '555-0142', church: 'Example Hills Church' };
const PERSONAL = [SUBMITTER.email, SUBMITTER.phone, 'riley.sample'];

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};
const q = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(100); } return cond(); };

// ---- processes ----
const procs = [];
const logs = { gh: [], mail: [], a: [], b: [], c: [] };
function start(name, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sink = (d) => logs[name].push(...String(d).split('\n').filter(Boolean));
  p.stdout.on('data', sink);
  p.stderr.on('data', sink);
  procs.push(p);
  return p;
}
async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return; } catch { await sleep(250); }
  }
  throw new Error('did not start: ' + url);
}
const discord = [];
const discordServer = http.createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; discord.push(raw); res.writeHead(204); res.end(); }).listen(P.discord);

const common = {
  AUTH_SECRET: 'e2e-auth-secret-' + 'z'.repeat(24),
  GITHUB_TOKEN: 'mock-token',
  GITHUB_REPO: 'mock/repo',
  GITHUB_API_URL: `http://localhost:${P.gh}`,
  RESEND_API_KEY: 'mock-resend-key',
  EMAIL_FROM: 'IMConnected <noreply@e2e-mail.com>',
  EMAIL_API_URL: `http://localhost:${P.mail}/emails`,
  EMAIL_CONFIRM_SECRET: CONFIRM_SECRET,
  PUBLISH_TOKEN,
  DISCORD_WEBHOOK_URL: `http://localhost:${P.discord}/hook`,
  SUBMIT_RATE_LIMIT: '100',
  TRUST_PROXY: 'true',
  NODE_OPTIONS: '--require ' + path.resolve('scripts/test-dns-preload.cjs'),
  TURNSTILE_SECRET_KEY: '',
};
delete process.env.SUBMISSIONS_TO;

start('gh', 'node', ['scripts/mock-github.mjs'], { MOCK_PORT: String(P.gh), MOCK_OUT });
start('mail', 'node', ['scripts/mock-email.mjs'], { MOCK_EMAIL_PORT: String(P.mail) });
await waitFor(`http://localhost:${P.mail}/x`);
start('a', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.a), HOST: '127.0.0.1', DATA_DIR, SITE_URL: BASE });
start('b', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.b), HOST: '127.0.0.1', DATA_DIR, SITE_URL: BASE_B, SUBMISSIONS_TO: 'github' });
const notADir = path.join(SCRATCH, 'not-a-folder');
fs.writeFileSync(notADir, 'a file, so a database folder inside it can never be created');
start('c', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.c), HOST: '127.0.0.1', DATA_DIR: path.join(notADir, 'data'), SITE_URL: BASE_C });
for (const port of [P.gh, P.a, P.b, P.c]) await waitFor(`http://localhost:${port}/`);

async function cleanup() {
  for (const p of procs) p.kill();
  discordServer.close();
  if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true });
}

try {
  // ---- synthetic images ----
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const png = (r, g, b, size = 32) => {
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
    const raw = Buffer.concat(Array.from({ length: size }, () => row));
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  const PNG_A = png(200, 90, 40);
  const PNG_B = png(40, 120, 200);

  // ---- helpers ----
  const emails = () => logs.mail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && m.subject);
  const ghCalls = () => logs.gh.filter((l) => /^(GET|POST|PATCH|DELETE|PUT) /.test(l));
  const commits = () => (fs.existsSync(DIRECT) ? fs.readdirSync(DIRECT) : []);
  const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
  const batchLines = () => logs.mail.filter((l) => l.startsWith('{"batchRequest"')).map((l) => JSON.parse(l).batchRequest);
  const mailTo = (list, addr) => list.filter((m) => m.to.includes(addr));

  async function postForm(base, url, fields, files = []) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    for (const f of files) fd.append('photos', new Blob([f.bytes]), f.filename);
    const res = await fetch(base + url, { method: 'POST', headers: { Origin: base, Accept: 'application/json' }, body: fd, redirect: 'manual' });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, data };
  }
  const TITLE = 'Harvest Day & <Music> at the Church';
  const form = (over = {}) => ({
    name: SUBMITTER.name, email: SUBMITTER.email, phone: SUBMITTER.phone, church: SUBMITTER.church,
    section: 'news', area: 'churches', title: TITLE, dek: '', photoCredit: 'Sam Sample', caption: 'Volunteers sorting boxes',
    body: 'Our church family gathered on Sunday for the annual Harvest Day. <script>alert(1)</script> Volunteers packed boxes, sang together and shared a meal. ' + 'More than forty people took part and the boxes went out the same afternoon. '.repeat(2),
    consent: 'yes', website: '', t: Date.now() - 10000, ...over,
  });

  // ---- editors (inserted directly; sign-in has its own tests) ----
  await fetch(BASE + '/admin/login'); // makes the server open the database and apply migrations
  const mkUser = (email, name, status = 'active') => {
    const now = Date.now();
    const id = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, 'editor', ?, ?, ?)", email, name, status, now, now).lastInsertRowid);
    const token = randomBytes(32).toString('base64url');
    run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600_000);
    return { id, email, token };
  };
  const E1 = mkUser('editor-one@e2e-mail.com', 'Test Editor');
  const E2 = mkUser('editor-two@e2e-mail.com', 'Second Editor');
  const E3 = mkUser('editor-three@e2e-mail.com', 'Disabled Editor', 'disabled');
  const E4 = mkUser('editor-four@e2e-mail.com', 'Invited Editor', 'invited');
  const E5 = mkUser('editor-five@e2e-mail.com', 'Fifth Editor');
  const E6 = mkUser('editor-six@e2e-mail.com', 'Sixth Editor');
  const adminGet = async (u, user, base = BASE) => { const r = await fetch(base + u, { headers: { Cookie: `__Host-imc_session=${user.token}` }, redirect: 'manual' }); return { status: r.status, text: await r.text() }; };
  const adminPost = async (u, user, fields) => {
    const r = await fetch(BASE + u, { method: 'POST', headers: { Cookie: `__Host-imc_session=${user.token}`, Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
    return { status: r.status, text: await r.text() };
  };

  // ================= My account setting =================
  {
    check('migration 005: notify_submissions defaults to on for a new editor', q('SELECT notify_submissions n FROM users WHERE id = ?', E1.id)[0].n === 1);
    let r = await adminGet('/admin/account', E1);
    check('My account shows "Email me when a story is submitted", checked by default', /Email me when a story is submitted/.test(r.text) && /<input[^>]*id="notify"[^>]*checked/.test(r.text), r.text.slice(r.text.indexOf('id="notify"') - 50, r.text.indexOf('id="notify"') + 200));
    r = await adminPost('/admin/account', E2, { action: 'notify' }); // checkbox left unticked
    check('turning the setting off saves it', r.status === 200 && q('SELECT notify_submissions n FROM users WHERE id = ?', E2.id)[0].n === 0 && /will not get emails/.test(r.text));
    r = await adminGet('/admin/account', E2);
    check('...and the page then shows it unchecked', /id="notify"/.test(r.text) && !/<input[^>]*id="notify"[^>]*checked/.test(r.text));
    run('UPDATE users SET notify_submissions = 1 WHERE id IN (?, ?)', E3.id, E4.id); // opted in, but disabled / not yet active
  }

  // ================= a form submission becomes a draft =================
  let draftId;
  {
    const ghBefore = ghCalls().length, mailBefore = emails().length, prBefore = dirs(MOCK_OUT).length;
    const r = await postForm(BASE, '/api/submit', form(), [{ bytes: PNG_A, filename: 'one.png' }, { bytes: PNG_B, filename: 'two.png' }]);
    check('the form submission is accepted (200)', r.status === 200 && r.data.ok === true, r.text.slice(0, 200));
    const rows = q("SELECT * FROM drafts WHERE source = 'form'");
    check('exactly one draft was created', rows.length === 1, String(rows.length));
    const d = rows[0] ?? {};
    draftId = d.id;
    check('draft: status new, source form, not verified, title and church set', d.status === 'new' && d.source === 'form' && d.email_verified === 0 && d.title === TITLE && d.church === SUBMITTER.church);
    check('draft: submitter name, email, phone and church are stored', d.submitter_name === SUBMITTER.name && d.submitter_email === SUBMITTER.email && d.submitter_phone === SUBMITTER.phone && d.submitter_church === SUBMITTER.church);
    check('draft: the story text is stored escaped (no raw HTML)', d.body.includes('&lt;script&gt;') && !d.body.includes('<script>'));
    const photos = q('SELECT * FROM draft_photos WHERE draft_id = ? ORDER BY position', draftId);
    check('two photos recorded in order, as uploads', photos.length === 2 && photos.every((p) => p.path && !p.url) && photos[0].ext === 'png');
    check('the photo files exist under DATA_DIR/uploads/<draft>/ with their bytes', photos.every((p) => p.path.startsWith(`${draftId}/`) && fs.existsSync(path.join(DATA_DIR, 'uploads', p.path))) && fs.readFileSync(path.join(DATA_DIR, 'uploads', photos[0].path)).equals(PNG_A));
    check('NO GitHub call and no pull request for a dashboard submission', ghCalls().length === ghBefore && dirs(MOCK_OUT).length === prBefore, ghCalls().slice(ghBefore).join(' | '));

    // editor emails and the Discord ping are sent in the background, after the response
    await until(() => batchLines().length >= 1 && discord.length >= 1);
    await sleep(200);
    const sent = emails().slice(mailBefore);
    const conf = mailTo(sent, SUBMITTER.email);
    check('the submitter got exactly one confirmation email', conf.length === 1 && /confirm/i.test(conf[0].subject));
    const toEditors = sent.filter((m) => /^New story submission:/.test(m.subject));
    const recips = toEditors.map((m) => m.to.join(',')).sort();
    check('exactly one notification per opted-in active editor (E1, E5, E6), one recipient each (no BCC)', toEditors.length === 3 && toEditors.every((m) => m.to.length === 1) && recips.join('|') === [E1, E5, E6].map((e) => e.email).sort().join('|'), JSON.stringify(recips));
    check('...sent as ONE batch request of 3 messages', batchLines().join(',') === '3', batchLines().join(','));
    check('opted-out (E2), disabled (E3) and invited (E4) editors got nothing', [E2, E3, E4].every((e) => mailTo(emails(), e.email).length === 0));
    const n = toEditors.find((m) => m.to[0] === E1.email) ?? { subject: '', text: '', html: '' };
    check('notification subject is "New story submission: <title>"', n.subject === `New story submission: ${TITLE}`, n.subject);
    check('notification links to /admin/drafts/<id> on SITE_URL', n.text.includes(`${BASE}/admin/drafts/${draftId}`) && n.html.includes(`${BASE}/admin/drafts/${draftId}`));
    check('notification HTML-escapes the title and shows the church', n.html.includes('Harvest Day &amp; &lt;Music&gt; at the Church') && !n.html.includes('<Music>') && n.html.includes(SUBMITTER.church));
    const everything = JSON.stringify(n);
    check('notification holds no submitter email, phone or name, and none of the story text', ![...PERSONAL, SUBMITTER.name, 'Harvest Day. ', 'annual Harvest', 'boxes'].some((s) => everything.includes(s)), everything.slice(0, 300));

    await until(() => discord.length >= 1);
    const hook = discord.map((x) => { try { return JSON.parse(x).content; } catch { return ''; } });
    check('the Discord ping still fires, with the title, church and dashboard link only', hook.length === 1 && hook[0].includes('Harvest Day & \\<Music\\> at the Church') && !hook[0].includes('<Music>') && hook[0].includes(SUBMITTER.church) && hook[0].includes(`/admin/drafts/${draftId}`) && ![...PERSONAL, SUBMITTER.name].some((s) => hook[0].includes(s)), hook.join('|'));

    // Resend answering 429 once: retried after retry-after, and still delivered
    await fetch(`http://localhost:${P.mail}/rate-limit-once`);
    const t0 = Date.now();
    const mailMark = emails().length;
    const limited = await postForm(BASE, '/api/submit', form({ title: 'Rate Limited Story' }));
    const limitedMs = Date.now() - t0;
    const forLimited = () => emails().slice(mailMark).filter((m) => /^New story submission: Rate Limited Story/.test(m.subject));
    await until(() => forLimited().length >= 3);
    const got = forLimited();
    check('the submit response did not wait for the 429 retry (background send)', limitedMs < 900, `${limitedMs} ms`);
    check('a 429 from the batch endpoint is retried once and all 3 editor emails still arrive', limited.status === 200 && logs.mail.some((l) => l.includes('rateLimited')) && got.length === 3 && Date.now() - t0 >= 900, `${got.length} emails`);
    run("DELETE FROM drafts WHERE title = 'Rate Limited Story'");

    // a failing email service never fails the submission
    await fetch(`http://localhost:${P.mail}/fail-on`);
    const failing = await postForm(BASE, '/api/submit', form({ title: 'Email Down Story' }));
    await sleep(500);
    await fetch(`http://localhost:${P.mail}/fail-off`);
    check('the email service failing does not fail the submission (draft still saved)', failing.status === 200 && q("SELECT COUNT(*) n FROM drafts WHERE title = 'Email Down Story'")[0].n === 1, failing.text.slice(0, 200));
    run("DELETE FROM drafts WHERE title = 'Email Down Story'");

    // a bad photo is refused before anything is saved
    const bad = await postForm(BASE, '/api/submit', form({ title: 'Bad photo story' }), [{ bytes: Buffer.from('this is not an image'), filename: 'x.png' }]);
    check('a non-image photo is refused (400) and no draft is created', bad.status === 400 && /isn't a JPG, PNG or WebP/.test(bad.data.error) && q("SELECT COUNT(*) n FROM drafts WHERE title = 'Bad photo story'")[0].n === 0, bad.text.slice(0, 200));
    // the old checks still apply
    const trap = await postForm(BASE, '/api/submit', form({ title: 'Trap story', website: 'http://spam.example' }));
    check('honeypot still pretends success but saves nothing', trap.status === 200 && q("SELECT COUNT(*) n FROM drafts WHERE title = 'Trap story'")[0].n === 0);
    const typo = await postForm(BASE, '/api/submit', form({ title: 'Typo story', email: 'riley@gmial.com' }));
    check('email typo check still refuses (400)', typo.status === 400 && /Did you mean/.test(typo.data.error) && q("SELECT COUNT(*) n FROM drafts WHERE title = 'Typo story'")[0].n === 0);
    const foreign = await fetch(BASE + '/api/submit', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: new FormData() });
    check('foreign Origin still refused (403)', foreign.status === 403);
  }

  // ================= confirmation =================
  {
    const conf = mailTo(emails(), SUBMITTER.email)[0];
    const token = /\/confirm\/\?t=([A-Za-z0-9_.-]+)/.exec(conf.text)?.[1] ?? '';
    const payload = Buffer.from(token.split('.')[0], 'base64url').toString();
    check('the confirmation token signs the draft id with the d: prefix', payload.startsWith(`d:${draftId}.`), payload);
    const post = async (t, base = BASE) => { const r = await fetch(base + '/api/confirm', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ t }) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
    let inbox = await adminGet('/admin', E1);
    check('before confirming, the inbox shows "Email not verified" for it', inbox.text.includes('Email not verified'));
    const page = await fetch(BASE + `/confirm/?t=${token}`);
    const pageText = await page.text();
    check('the confirm page and its Confirm button are unchanged', page.status === 200 && pageText.includes('id="confirm-btn"') && pageText.includes('Thank you — your story is confirmed. Our editors will review it soon.'));
    let r = await post(token);
    check('confirming succeeds (200)', r.status === 200 && r.data.ok === true, JSON.stringify(r));
    check('...and sets drafts.email_verified = 1', q('SELECT email_verified v FROM drafts WHERE id = ?', draftId)[0].v === 1);
    inbox = await adminGet('/admin', E1);
    check('the inbox now shows the "Email verified" badge', inbox.text.includes('Email verified'));
    const detail = await adminGet(`/admin/drafts/${draftId}`, E1);
    check('the editor-only draft page shows the submitter details and verified state', detail.status === 200 && detail.text.includes(SUBMITTER.email) && /verified/i.test(detail.text));
    r = await post(token);
    check('confirming twice is harmless (200)', r.status === 200);
    const exp = Date.now() - 20 * 86400_000;
    const mk = (payload) => Buffer.from(payload).toString('base64url') + '.' + createHmac('sha256', CONFIRM_SECRET).update(payload).digest().toString('base64url');
    r = await post(mk(`d:${draftId}.${Math.floor(exp / 1000)}`));
    check('an expired token says "This link has expired. Please email us."', r.status === 400 && r.data.error === 'This link has expired. Please email us.', JSON.stringify(r));
    r = await post(token.slice(0, -2) + 'AA');
    check('a tampered token says "This link isn\'t valid."', r.status === 400 && r.data.error === "This link isn't valid.", JSON.stringify(r));
    r = await post(mk(`d:999999.${Math.floor(Date.now() / 1000) + 3600}`));
    check('a signed token for a draft that does not exist answers 200 and changes nothing', r.status === 200 && q('SELECT COUNT(*) n FROM drafts WHERE email_verified = 1')[0].n === 1);
    check('confirm-by-draft made no GitHub label call', !ghCalls().some((l) => /labels/.test(l)));
  }

  // ================= SUBMISSIONS_TO=github keeps the PR path =================
  let prToken, prNumber;
  {
    const draftsBefore = q('SELECT COUNT(*) n FROM drafts')[0].n;
    const mailBefore = emails().length;
    const r = await postForm(BASE_B, '/api/submit', form({ title: 'Github Mode Story' }), [{ bytes: PNG_A, filename: 'one.png' }]);
    check('SUBMISSIONS_TO=github: submission accepted', r.status === 200 && r.data.ok === true, r.text.slice(0, 200));
    const prs = dirs(path.join(MOCK_OUT, 'submission'));
    check('...it opened a pull request (branch submission/<slug> with PR.md, story file and photo)', prs.length === 1 && fs.existsSync(path.join(MOCK_OUT, 'submission', prs[0], 'PR.md')) && fs.existsSync(path.join(MOCK_OUT, 'submission', prs[0], 'src/content/stories')), prs.join(','));
    check('...and created no draft', q('SELECT COUNT(*) n FROM drafts')[0].n === draftsBefore);
    await sleep(300);
    const sent = emails().slice(mailBefore);
    check('...it sent only the confirmation email (no editor notifications)', sent.length === 1 && sent[0].to[0] === SUBMITTER.email, JSON.stringify(sent.map((m) => m.subject)));
    prToken = /\/confirm\/\?t=([A-Za-z0-9_.-]+)/.exec(sent[0]?.text ?? '')?.[1] ?? '';
    const payload = Buffer.from(prToken.split('.')[0], 'base64url').toString();
    prNumber = Number(/^(\d+)\./.exec(payload)?.[1]);
    check('...its confirmation token is the old PR-number kind (no d: prefix)', /^\d+\.\d+$/.test(payload), payload);
    // An old-style PR token, presented to the dashboard server (GitHub configured): still honoured.
    const pr = await fetch(BASE + '/api/confirm', { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json' }, body: JSON.stringify({ t: prToken }) });
    const labels = fs.readFileSync(path.join(MOCK_OUT, 'submission', prs[0], 'LABELS.txt'), 'utf8');
    check('an old PR-style token is still accepted and labels the PR email-verified', pr.status === 200 && labels.includes('email-verified') && !labels.includes('email-unverified'), labels);
    check('...without touching any draft', q('SELECT COUNT(*) n FROM drafts WHERE email_verified = 1')[0].n === 1);
    // ...and without GitHub configured (server C has no usable database but also uses the shared mock; blank the token instead)
    const noGh = await fetch(BASE_C + '/api/confirm', { method: 'POST', headers: { Origin: BASE_C, 'Content-Type': 'application/json' }, body: JSON.stringify({ t: 'bad.token' }) });
    check('a malformed token is "This link isn\'t valid." (400)', noGh.status === 400 && (await noGh.json()).error === "This link isn't valid.");
  }

  // ================= dashboard: badge, home section =================
  {
    const open = q("SELECT COUNT(*) n FROM drafts WHERE status IN ('new','in_review')")[0].n;
    let r = await adminGet('/admin', E1);
    const m = /nav-count[^>]*><span aria-hidden="true">(\d+)</.exec(r.text);
    check('the Drafts nav item shows a count badge of new + in review', m && Number(m[1]) === open && open >= 1, `badge=${m?.[1]} open=${open}`);
    // more drafts so the "5 newest" limit shows
    const now = Date.now();
    for (let i = 1; i <= 6; i++) {
      run("INSERT INTO drafts (status, source, title, created_at, updated_at) VALUES ('in_review', 'editor', ?, ?, ?)", `Home Draft ${i}`, now + i * 1000, now + i * 1000);
    }
    run("UPDATE drafts SET status = 'in_review' WHERE id = ?", draftId);
    r = await adminGet('/admin', E1);
    const m2 = /nav-count[^>]*><span aria-hidden="true">(\d+)</.exec(r.text);
    const open2 = q("SELECT COUNT(*) n FROM drafts WHERE status IN ('new','in_review')")[0].n;
    check('the visible badge number is aria-hidden and a visually hidden "drafts waiting" text follows', /nav-count[^>]*><span aria-hidden="true">\d+<\/span><span class="visually-hidden"> drafts? waiting/.test(r.text));
    check('the badge counts in-review drafts too', m2 && Number(m2[1]) === open2, `badge=${m2?.[1]} open=${open2}`);
    const sec = r.text.slice(r.text.indexOf('id="home-new"'), r.text.indexOf('id="home-pub"'));
    const items = sec.match(/<li>/g) || [];
    check('the home section lists the 5 newest drafts (and not an older one)', items.length === 5 && sec.includes('Home Draft 6') && sec.includes('Home Draft 2') && !sec.includes('Home Draft 1<'), `items=${items.length}`);
    run('DELETE FROM drafts WHERE source = ?', 'editor');
    run("UPDATE drafts SET status = 'new' WHERE id = ?", draftId);
  }

  // ================= Studio publishes =================
  {
    const studio = (body) => fetch(BASE + '/api/publish', { method: 'POST', headers: { Authorization: `Bearer ${PUBLISH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
    const payload = (bodyText) => ({
      newsletter: { name: 'Test Newsletter', issueDate: '2026-10-19' },
      stories: [
        { ref: 'a', title: 'Studio Story One', section: 'news', area: 'conference', author: 'Studio Author', dek: 'A short summary.', body: bodyText, photos: [{ url: 'data:image/png;base64,' + PNG_A.toString('base64'), alt: 'A box', caption: '' }] },
        { ref: 'b', title: 'Studio Story Two', section: 'features', author: 'Studio Author', body: 'Second story text, plain.' },
      ],
    });
    const before = commits().length;
    let r = await studio(payload('First version of the story text.'));
    check('Studio publish succeeds with the same response as before', r.status === 200 && r.data.ok && r.data.commit && r.data.stories.length === 2 && r.data.stories[0].url.endsWith('/stories/2026-10-19-studio-story-one/'), JSON.stringify(r.data).slice(0, 200));
    const sha1 = r.data.commit;
    check('...it committed straight to main (a direct commit with the story file and photo)', commits().length === before + 1 && fs.existsSync(path.join(DIRECT, sha1, 'src/content/stories/2026-10-19-studio-story-one.md')) && fs.existsSync(path.join(DIRECT, sha1, 'public/images/stories/2026-10-19-studio-story-one/photo-1.png')));
    let rows = q("SELECT * FROM drafts WHERE source = 'studio' ORDER BY id");
    check('both stories are recorded as drafts: status published, source studio, published_by NULL', rows.length === 2 && rows.every((d) => d.status === 'published' && d.published_by === null && d.published_at));
    const one = rows.find((d) => d.slug === '2026-10-19-studio-story-one') ?? {};
    check('...with slug, commit, title, author and date set', one.published_commit === sha1 && one.title === 'Studio Story One' && one.author === 'Studio Author' && one.date === '2026-10-19' && one.section === 'news' && one.area === 'conference' && /First version/.test(one.body));
    check('...and the photo recorded as a site image', q('SELECT url, path, alt FROM draft_photos WHERE draft_id = ?', one.id).some((p) => p.url === '/images/stories/2026-10-19-studio-story-one/photo-1.png' && !p.path && p.alt === 'A box'));
    let pub = await adminGet('/admin/published', E1);
    check('the Published page shows them as published by "IMConnected Studio"', pub.text.includes('Studio Story One') && pub.text.includes('IMConnected Studio'));
    const home = await adminGet('/admin', E1);
    check('the inbox "Newest published" section lists them', home.text.slice(home.text.indexOf('id="home-pub"')).includes('Studio Story One'));
    const histo = await adminGet('/admin?status=published', E1);
    check('the Published filter of the inbox shows them with a Studio source badge', histo.text.includes('Studio Story One') && histo.text.includes('>Studio<'));
    check('the audit log has a draft.published_studio entry', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.published_studio'")[0].n === 2);

    r = await studio(payload('Second version of the story text, corrected.'));
    const sha2 = r.data.commit;
    rows = q("SELECT * FROM drafts WHERE source = 'studio' ORDER BY id");
    const one2 = rows.find((d) => d.slug === '2026-10-19-studio-story-one') ?? {};
    check('re-publishing the same slug updates the same row (still 2 rows, same id)', r.status === 200 && r.data.stories[0].status === 'updated' && rows.length === 2 && one2.id === one.id, `${rows.length} rows`);
    check('...with the new commit and text, still published and not duplicated', one2.published_commit === sha2 && sha2 !== sha1 && /Second version/.test(one2.body) && q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', one.id)[0].n === 1 && q("SELECT COUNT(*) n FROM drafts WHERE slug = '2026-10-19-studio-story-one'")[0].n === 1);
    const bad = await studio({ newsletter: { issueDate: 'nope' }, stories: [] });
    check('an invalid Studio request is still refused (400) and records nothing', bad.status === 400 && q("SELECT COUNT(*) n FROM drafts WHERE source = 'studio'")[0].n === 2);
  }

  // ================= Studio publishes over a story that has a linked draft =================
  {
    const studio = (body) => fetch(BASE + '/api/publish', { method: 'POST', headers: { Authorization: `Bearer ${PUBLISH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
    const now = Date.now();
    // (a) an editor draft still in review, with an uploaded photo, linked to the slug
    const slugA = '2026-10-21-linked-story';
    const idA = Number(run("INSERT INTO drafts (status, source, title, dek, church, author_title, featured, body, slug, date, created_at, updated_at) VALUES ('in_review', 'editor', 'My Unfinished Edits', 'Edited summary', 'Mine Church', 'Elder', 1, 'My unsaved-to-site words.', ?, '2026-10-21', ?, ?)", slugA, now, now).lastInsertRowid);
    fs.mkdirSync(path.join(DATA_DIR, 'uploads', String(idA)), { recursive: true });
    const relA = `${idA}/${'ab'.repeat(16)}.png`;
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', relA), PNG_B);
    run("INSERT INTO draft_photos (draft_id, path, ext, alt, position, created_at) VALUES (?, ?, 'png', 'Mine', 0, ?)", idA, relA, now);
    const versionA = q('SELECT updated_at u FROM drafts WHERE id = ?', idA)[0].u;
    // (b) a closed (published) editor draft linked to another slug
    const slugB = '2026-10-22-closed-story';
    const idB = Number(run("INSERT INTO drafts (status, source, title, church, author_title, story_column, featured, body, slug, published_commit, published_at, date, created_at, updated_at) VALUES ('published', 'editor', 'Old Title', 'Old Church', 'Old Role', 'Old Col', 1, 'Old body.', ?, 'oldsha', ?, '2026-10-22', ?, ?)", slugB, now, now, now).lastInsertRowid);
    const pay = (title, date) => ({ newsletter: { name: 'N', issueDate: date }, stories: [{ ref: 'x', title, section: 'news', area: 'conference', author: 'Studio Author', body: 'Studio text for the linked story.' }] });
    let r = await studio(pay('Linked Story', '2026-10-21'));
    check('Studio publish over a story whose linked draft is in review succeeds', r.status === 200 && r.data.ok, JSON.stringify(r.data).slice(0, 200));
    const a = q('SELECT * FROM drafts WHERE id = ?', idA)[0];
    check('...the in-review draft keeps its fields and status', a.status === 'in_review' && a.title === 'My Unfinished Edits' && a.dek === 'Edited summary' && a.church === 'Mine Church' && a.author_title === 'Elder' && a.featured === 1 && a.body === 'My unsaved-to-site words.' && a.updated_at === versionA, JSON.stringify(a).slice(0, 300));
    check('...its uploaded photo row and file are untouched', q('SELECT path FROM draft_photos WHERE draft_id = ?', idA).length === 1 && fs.existsSync(path.join(DATA_DIR, 'uploads', relA)));
    check('...only the live markers are set (commit, published_at) and no second row was made for the slug', a.published_commit === r.data.commit && a.published_at && a.studio_overwrote_at && q('SELECT COUNT(*) n FROM drafts WHERE slug = ?', slugA)[0].n === 1);
    check('...an audit entry draft.studio_overwrote_live names the draft', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.studio_overwrote_live' AND target = ?", `draft:${idA}`)[0].n === 1);
    const pageA = await adminGet(`/admin/drafts/${idA}`, E1);
    check('...the editor sees "IMConnected Studio published over this story on <date>; your saved edits here are not live."', /IMConnected Studio published over this story on[\s\S]*?; your saved edits here are not live\./.test(pageA.text));
    r = await studio(pay('Closed Story', '2026-10-22'));
    const b = q('SELECT * FROM drafts WHERE id = ?', idB)[0];
    check('a closed linked draft is updated in place with ALL content columns', r.status === 200 && b.title === 'Closed Story' && b.church === '' && b.author_title === '' && b.story_column === '' && b.featured === 0 && b.status === 'published' && b.published_by === null && b.published_commit === r.data.commit && q('SELECT COUNT(*) n FROM drafts WHERE slug = ?', slugB)[0].n === 1, JSON.stringify(b).slice(0, 300));
    check('...and is credited to IMConnected Studio (flag set, no editor)', b.published_via_studio === 1 && b.published_by === null);
    const pubTab = await adminGet('/admin/published', E1);
    const rowB = pubTab.text.slice(pubTab.text.indexOf('Closed Story'), pubTab.text.indexOf('Closed Story') + 900);
    check('...the Published tab and the draft page say Studio', /by IMConnected Studio/.test(rowB) && (await adminGet(`/admin/drafts/${idB}`, E1)).text.includes('published by IMConnected Studio'));

    // Alice (E1) publishes from the dashboard, the story is reloaded, then Studio publishes over it
    const idC = Number(run("INSERT INTO drafts (status, source, title, dek, section, area, author, date, body, created_at, updated_at) VALUES ('in_review', 'editor', 'Credit Story', '', 'news', 'conference', 'Alice Author', '2026-10-23', 'Credit story body text.', ?, ?)", now, now).lastInsertRowid);
    let pr = await adminPost(`/api/admin/drafts/${idC}/publish`, E1, { version: q('SELECT updated_at u FROM drafts WHERE id = ?', idC)[0].u });
    const c1 = q('SELECT * FROM drafts WHERE id = ?', idC)[0];
    check('a dashboard publish credits the editor (published_by set, not Studio)', pr.status === 303 && c1.status === 'published' && c1.published_by === E1.id && c1.published_via_studio === 0, String(pr.status));
    check('...the draft page says published by Test Editor', (await adminGet(`/admin/drafts/${idC}`, E1)).text.includes('published by Test Editor'));
    await adminPost('/api/admin/stories/edit', E1, { slug: c1.slug });
    check('reloading the story reopens the same draft in review', q('SELECT status FROM drafts WHERE id = ?', idC)[0].status === 'in_review');
    r = await studio(pay('Credit Story', '2026-10-23'));
    const c2 = q('SELECT * FROM drafts WHERE id = ?', idC)[0];
    check('Studio then publishes the same slug: the in-progress draft is credited to Studio, not the editor', r.status === 200 && c2.published_via_studio === 1 && c2.published_by === null && c2.status === 'in_review' && c2.published_commit === r.data.commit, JSON.stringify(c2).slice(0, 300));
    const pubTab2 = await adminGet('/admin/published', E1);
    const rowC = pubTab2.text.slice(pubTab2.text.indexOf('Credit Story'), pubTab2.text.indexOf('Credit Story') + 900);
    const homeC = await adminGet('/admin', E1);
    const homeRow = homeC.text.slice(homeC.text.indexOf('id="home-pub"'));
    check('...the Published tab and the inbox overview say Studio and never the editor', /by IMConnected Studio/.test(rowC) && !/by Test Editor/.test(rowC) && homeRow.includes('by IMConnected Studio'));
    pr = await adminPost(`/api/admin/drafts/${idC}/publish`, E1, { version: c2.updated_at });
    const c3 = q('SELECT * FROM drafts WHERE id = ?', idC)[0];
    check('publishing again from the dashboard credits the editor again (flag cleared)', pr.status === 303 && c3.status === 'published' && c3.published_by === E1.id && c3.published_via_studio === 0 && (await adminGet(`/admin/drafts/${idC}`, E1)).text.includes('published by Test Editor'), String(pr.status));

    // a rejected draft with uploads: its files are replaced/deleted when Studio publishes over its slug
    const idD = Number(run("INSERT INTO drafts (status, source, title, slug, date, rejected_at, created_at, updated_at) VALUES ('rejected', 'editor', 'Rejected Story', '2026-10-24-rejected-story', '2026-10-24', ?, ?, ?)", now, now, now).lastInsertRowid);
    fs.mkdirSync(path.join(DATA_DIR, 'uploads', String(idD)), { recursive: true });
    const relD = `${idD}/${'cd'.repeat(16)}.png`;
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', relD), PNG_A);
    run("INSERT INTO draft_photos (draft_id, path, ext, position, created_at) VALUES (?, ?, 'png', 0, ?)", idD, relD, now);
    r = await studio(pay('Rejected Story', '2026-10-24'));
    const d = q('SELECT * FROM drafts WHERE id = ?', idD)[0];
    check('a rejected linked draft becomes published by Studio, and its upload rows and files are removed', r.status === 200 && d.status === 'published' && d.published_via_studio === 1 && q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', idD)[0].n === 0 && !fs.existsSync(path.join(DATA_DIR, 'uploads', relD)));
    check('...whereas the in-review draft from before still has its upload', fs.existsSync(path.join(DATA_DIR, 'uploads', relA)));
  }

  // ================= the database is unavailable =================
  {
    const ghBefore = ghCalls().length, mailBefore = emails().length, dcBefore = discord.length;
    const r = await postForm(BASE_C, '/api/submit', form({ title: 'Lost Story' }), [{ bytes: PNG_A, filename: 'one.png' }]);
    check('database unavailable: submit answers 503 "Submissions are temporarily unavailable. Please email us your story."', r.status === 503 && r.data.error === 'Submissions are temporarily unavailable. Please email us your story.', r.text.slice(0, 200));
    await sleep(200);
    check('...nothing else happened (no email, no Discord ping, no GitHub call)', emails().length === mailBefore && discord.length === dcBefore && ghCalls().length === ghBefore);
    const noJs = await fetch(BASE_C + '/api/submit', { method: 'POST', headers: { Origin: BASE_C }, body: (() => { const fd = new FormData(); for (const [k, v] of Object.entries(form())) fd.append(k, String(v)); return fd; })() });
    check('...and the no-JavaScript form shows the same message', noJs.status === 503 && (await noJs.text()).includes('Submissions are temporarily unavailable. Please email us your story.'));

    const before = commits().length;
    const pr = await fetch(BASE_C + '/api/publish', {
      method: 'POST', headers: { Authorization: `Bearer ${PUBLISH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ newsletter: { name: 'N', issueDate: '2026-10-20' }, stories: [{ ref: 'z', title: 'Published Without A Database', section: 'news', area: 'conference', author: 'Studio Author', body: 'This text goes live even if the dashboard database is down.' }] }),
    });
    const data = await pr.json();
    check('database unavailable: Studio publish still succeeds and commits', pr.status === 200 && data.ok && commits().length === before + 1 && fs.existsSync(path.join(DIRECT, data.commit, 'src/content/stories/2026-10-20-published-without-a-database.md')), JSON.stringify(data).slice(0, 200));
    check('...and the server logged that it could not record it', logs.c.some((l) => l.includes('[publish] could not record the stories in the dashboard')), logs.c.join('\n').slice(-400));
  }

  // ================= no personal data in logs, editor emails or commits =================
  {
    const all = [...logs.a, ...logs.b, ...logs.c].join('\n');
    check('no submitter email, phone or name in any server log', ![...PERSONAL, SUBMITTER.name].some((s) => all.includes(s)), PERSONAL.filter((s) => all.includes(s)).join(','));
    const editorMail = emails().filter((m) => !m.to.includes(SUBMITTER.email));
    check('no submitter email or phone in any email sent to editors', editorMail.length >= 1 && !editorMail.some((m) => PERSONAL.some((s) => JSON.stringify(m).includes(s))));
    const hay = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!/\.(png|jpg|webp)$/.test(f)) hay.push(fs.readFileSync(f, 'utf8')); } };
    walk(DIRECT);
    check('no submitter email or phone in any commit to main', !hay.some((t) => PERSONAL.some((s) => t.includes(s))));
    const subDir = path.join(MOCK_OUT, 'submission');
    const prStory = hay.length && dirs(subDir).length ? fs.readdirSync(path.join(subDir, dirs(subDir)[0], 'src/content/stories')).map((f) => fs.readFileSync(path.join(subDir, dirs(subDir)[0], 'src/content/stories', f), 'utf8')).join('') : '';
    check('(github mode) the story file in the PR holds no submitter email or phone either', prStory.length > 0 && !PERSONAL.some((s) => prStory.includes(s)));
  }
} catch (err) {
  check('the run completed without an exception', false, String(err && err.stack ? err.stack : err).slice(0, 800));
} finally {
  await cleanup();
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
