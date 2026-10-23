#!/usr/bin/env node
// End-to-end check of "public submissions and Studio publishes go into the dashboard" (issue 14).
// It starts everything itself: the mock email API, a tiny Discord stand-in and two copies of the BUILT server
// (the normal one, and one whose database can't be opened). There is no GitHub mock: publishing is database-only.
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
const P = { mail: 4411, discord: 4412, a: 4421, c: 4423 };
const BASE = `http://localhost:${P.a}`;
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
const logs = { mail: [], a: [], c: [] };
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

start('mail', 'node', ['scripts/mock-email.mjs'], { MOCK_EMAIL_PORT: String(P.mail) });
await waitFor(`http://localhost:${P.mail}/x`);
start('a', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.a), HOST: '127.0.0.1', DATA_DIR, SITE_URL: BASE });
const notADir = path.join(SCRATCH, 'not-a-folder');
fs.writeFileSync(notADir, 'a file, so a database folder inside it can never be created');
start('c', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.c), HOST: '127.0.0.1', DATA_DIR: path.join(notADir, 'data'), SITE_URL: BASE_C });
for (const port of [P.a, P.c]) await waitFor(`http://localhost:${port}/`);

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
    const mailBefore = emails().length;
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
    check('a submission creates a draft only: nothing is published and no story row exists', q('SELECT COUNT(*) n FROM stories')[0].n === 0 || q("SELECT COUNT(*) n FROM stories WHERE title = ?", TITLE)[0].n === 0);

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
    check('a non-image photo is refused (400) and no draft is created', bad.status === 400 && /isn't a JPG, PNG, WebP or AVIF/.test(bad.data.error) && q("SELECT COUNT(*) n FROM drafts WHERE title = 'Bad photo story'")[0].n === 0, bad.text.slice(0, 200));
    // the old checks still apply
    const trap = await postForm(BASE, '/api/submit', form({ title: 'Trap story', website: 'http://spam.example' }));
    check('honeypot still pretends success but saves nothing', trap.status === 200 && q("SELECT COUNT(*) n FROM drafts WHERE title = 'Trap story'")[0].n === 0);
    const typo = await postForm(BASE, '/api/submit', form({ title: 'Typo story', email: 'riley@gmial.com' }));
    check('email typo check still refuses (400)', typo.status === 400 && /Did you mean/.test(typo.data.error) && q("SELECT COUNT(*) n FROM drafts WHERE title = 'Typo story'")[0].n === 0);
    const foreign = await fetch(BASE + '/api/submit', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: new FormData() });
    check('foreign Origin still refused (403)', foreign.status === 403);
  }

  // ================= per-photo captions and alt text (issue #122) =================
  {
    const PNG_C = png(90, 160, 70);
    const HOSTILE = 'Boxes <script>alert(7)</script> & "friends"';
    const mk = (title, over = {}) => form({ title, caption: '', ...over });
    const photosOf = (title) => q('SELECT p.* FROM draft_photos p JOIN drafts d ON d.id = p.draft_id WHERE d.title = ? ORDER BY p.position', title);
    const T1 = 'Per Photo Text Story';
    let r = await postForm(BASE, '/api/submit', mk(T1, { caption_0: HOSTILE, alt_0: 'Orange square', caption_1: 'Second caption', alt_1: 'Blue square', caption_2: '', alt_2: 'Green square' }), [{ bytes: PNG_A, filename: 'a.png' }, { bytes: PNG_B, filename: 'b.png' }, { bytes: PNG_C, filename: 'c.png' }]);
    let ph = photosOf(T1);
    check('per-photo caption and alt are saved in the order the photos were chosen', r.status === 200 && ph.length === 3 && ph[0].caption === HOSTILE && ph[0].alt === 'Orange square' && ph[1].caption === 'Second caption' && ph[1].alt === 'Blue square' && ph[2].caption === '' && ph[2].alt === 'Green square', JSON.stringify(ph.map((x) => [x.caption, x.alt])));
    check('the caption with markup is stored raw (never HTML-escaped in the database)', ph[0].caption.includes('<script>'));
    const draftT1 = q('SELECT id FROM drafts WHERE title = ?', T1)[0].id;

    // no JavaScript: the one caption field captions the FIRST photo and never becomes alt text
    const T2 = 'No Script Caption Story';
    r = await postForm(BASE, '/api/submit', mk(T2, { caption: 'Volunteers\nsorting   boxes\u0007' }), [{ bytes: PNG_A, filename: 'a.png' }, { bytes: PNG_B, filename: 'b.png' }]);
    ph = photosOf(T2);
    check('without JavaScript the single caption field is the first photo caption, not its alt text', r.status === 200 && ph.length === 2 && ph[0].caption === 'Volunteers sorting boxes' && ph[0].alt === '' && ph[1].caption === '' && ph[1].alt === '', JSON.stringify(ph.map((x) => [x.caption, x.alt])));
    check('newlines and control characters are flattened to one line', !/[\u0000-\u001f]/.test(ph[0].caption));
    const T2b = 'Per Photo Beats Single Story';
    await postForm(BASE, '/api/submit', mk(T2b, { caption: 'Single field', caption_0: 'Per-photo wins' }), [{ bytes: PNG_A, filename: 'a.png' }]);
    check('a per-photo caption_0 takes precedence over the single field', photosOf(T2b)[0]?.caption === 'Per-photo wins');

    // validation: too long is a clear 400 and nothing is saved
    const T3 = 'Long Caption Story';
    r = await postForm(BASE, '/api/submit', mk(T3, { caption_0: 'x'.repeat(301) }), [{ bytes: PNG_A, filename: 'a.png' }]);
    check('a caption over 300 characters is refused with a clear 400 and no draft', r.status === 400 && /caption for photo 1 is too long/.test(r.data.error) && q('SELECT COUNT(*) n FROM drafts WHERE title = ?', T3)[0].n === 0, r.text.slice(0, 200));
    r = await postForm(BASE, '/api/submit', mk(T3, { alt_1: 'y'.repeat(301) }), [{ bytes: PNG_A, filename: 'a.png' }, { bytes: PNG_B, filename: 'b.png' }]);
    check('alt text over 300 characters is refused with a clear 400', r.status === 400 && /description for photo 2 is too long/.test(r.data.error) && q('SELECT COUNT(*) n FROM drafts WHERE title = ?', T3)[0].n === 0, r.text.slice(0, 200));
    r = await postForm(BASE, '/api/submit', mk(T3, { caption: 'z'.repeat(301) }), [{ bytes: PNG_A, filename: 'a.png' }]);
    check('the single (no-JavaScript) caption is held to 300 too', r.status === 400 && /caption is too long/.test(r.data.error));
    r = await postForm(BASE, '/api/submit', mk('Exactly 300 Story', { caption_0: 'c'.repeat(300), alt_0: 'a'.repeat(300) }), [{ bytes: PNG_A, filename: 'a.png' }]);
    check('exactly 300 characters is accepted', r.status === 200 && photosOf('Exactly 300 Story')[0].caption.length === 300);

    // the editor shows both, escaped
    const editor = await adminGet(`/admin/drafts/${draftT1}`, E1);
    check('the editor shows the caption and alt per photo, inside a quoted value attribute with quotes and ampersands escaped (inert text)', editor.status === 200 && editor.text.includes('value="Boxes <script>alert(7)</script> &amp; &quot;friends&quot;"') && !editor.text.replace(/value="[^"]*"/g, '').includes('<script>alert(7)') && editor.text.includes('Orange square') && editor.text.includes('Second caption'), editor.text.slice(editor.text.indexOf('photo_') - 50, editor.text.indexOf('photo_') + 400));

    // published, the story page escapes it too
    const row = q('SELECT updated_at FROM drafts WHERE id = ?', draftT1)[0];
    const pub = await fetch(BASE + `/api/admin/drafts/${draftT1}/publish`, { method: 'POST', headers: { Cookie: `__Host-imc_session=${E1.token}`, Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ version: String(row.updated_at) }), redirect: 'manual' });
    const slug = q('SELECT slug FROM drafts WHERE id = ?', draftT1)[0].slug;
    check('the editor can publish it', pub.status === 303 && !!slug && q('SELECT COUNT(*) n FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = ?', slug)[0].n === 3, `${pub.status} ${pub.headers.get('location')}`);
    const sp = q('SELECT caption, alt FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = ? ORDER BY p.position', slug);
    check('story_photos keep the caption raw and the alt separate', sp[0].caption === HOSTILE && sp[0].alt === 'Orange square', JSON.stringify(sp));
    const page = await (await fetch(BASE + `/stories/${slug}/`)).text();
    check('the story page shows the caption escaped, as text', page.includes('Boxes &lt;script&gt;alert(7)&lt;/script&gt;') && !page.includes('<script>alert(7)') && page.includes('photo-caption'), page.slice(page.indexOf('photo-caption') - 100, page.indexOf('photo-caption') + 300));
    run('DELETE FROM drafts WHERE title IN (?, ?, ?, ?)', T2, T2b, 'Exactly 300 Story', T3);
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
  }

  // ================= the old pull-request path is gone =================
  {
    const draftsBefore = q('SELECT COUNT(*) n FROM drafts')[0].n;
    // SUBMISSIONS_TO=github is no longer read: even set, a submission is a dashboard draft
    check('the server code has no SUBMISSIONS_TO switch any more', !fs.readFileSync('src/pages/api/submit.ts', 'utf8').includes('SUBMISSIONS_TO'));
    // an old PR-number confirmation link (from an email sent when submissions opened pull requests)
    const payload = `41.${Math.floor(Date.now() / 1000) + 3600}`;
    const prToken = Buffer.from(payload).toString('base64url') + '.' + createHmac('sha256', CONFIRM_SECRET).update(payload).digest().toString('base64url');
    const pr = await fetch(BASE + '/api/confirm', { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json' }, body: JSON.stringify({ t: prToken }) });
    check('an old PR-style confirmation link is no longer honoured: "This link isn\'t valid." (400), no GitHub call possible', pr.status === 400 && (await pr.json()).error === "This link isn't valid.");
    check('...without touching any draft', q('SELECT COUNT(*) n FROM drafts WHERE email_verified = 1')[0].n === 1 && q('SELECT COUNT(*) n FROM drafts')[0].n === draftsBefore);
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
    const storiesBefore = q('SELECT COUNT(*) n FROM stories')[0].n;
    let r = await studio(payload('First version of the story text.'));
    check('Studio publish succeeds with the same response as before', r.status === 200 && r.data.ok && 'commit' in r.data && r.data.commit === null && r.data.stories.length === 2 && r.data.stories[0].url.endsWith('/stories/2026-10-19-studio-story-one/'), JSON.stringify(r.data).slice(0, 200));
    const slug1 = '2026-10-19-studio-story-one';
    const sRow = q('SELECT * FROM stories WHERE slug = ?', slug1)[0] ?? {};
    check('...it wrote both stories to the database, live, source studio (no GitHub token is set on this server)', q('SELECT COUNT(*) n FROM stories')[0].n === storiesBefore + 2 && sRow.status === 'live' && sRow.source === 'studio' && sRow.title === 'Studio Story One' && sRow.section === 'news' && sRow.area === 'conference' && /First version/.test(sRow.body) && sRow.image_alt === 'A box');
    const sPhoto = q('SELECT p.* FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = ?', slug1);
    check('...with the photo copied to stories/<slug>/<sha256>.png in the media folder', sPhoto.length === 1 && sPhoto[0].path === `stories/${slug1}/${createHash('sha256').update(PNG_A).digest('hex')}.png` && fs.readFileSync(path.join(DATA_DIR, 'media', sPhoto[0].path)).equals(PNG_A) && sRow.image === `/media/${sPhoto[0].path}`);
    const pageNow = await fetch(BASE + `/stories/${slug1}/`);
    const jsonNow = await (await fetch(BASE + '/stories.json')).text();
    const rssNow = await (await fetch(BASE + '/rss.xml')).text();
    const found = await (await fetch(BASE + '/api/search?q=studio+story')).json();
    const listed = await (await fetch(BASE + '/api/stories?limit=100', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` } })).json();
    check('...and the very next request shows it: story page, /stories.json, /rss.xml, search and /api/stories', pageNow.status === 200 && jsonNow.includes(slug1) && rssNow.includes(slug1) && found.results.some((x) => x.slug === slug1) && listed.stories.some((x) => x.id === slug1 && x.source === 'studio'));
    check('...the home and section pages list them too, with the photo', (await (await fetch(BASE + '/')).text()).includes(`/media/${sPhoto[0].path}`) && (await (await fetch(BASE + '/features/')).text()).includes('2026-10-19-studio-story-two'));
    let rows = q("SELECT * FROM drafts WHERE source = 'studio' ORDER BY id");
    check('both stories are recorded as drafts: status published, source studio, published_by NULL', rows.length === 2 && rows.every((d) => d.status === 'published' && d.published_by === null && d.published_at));
    const one = rows.find((d) => d.slug === '2026-10-19-studio-story-one') ?? {};
    check('...with slug, commit, title, author and date set', one.published_commit === 'db' && one.title === 'Studio Story One' && one.author === 'Studio Author' && one.date === '2026-10-19' && one.section === 'news' && one.area === 'conference' && /First version/.test(one.body));
    check('...and the photo recorded as a site image', q('SELECT url, path, alt FROM draft_photos WHERE draft_id = ?', one.id).some((p) => p.url === `/media/${sPhoto[0].path}` && !p.path && p.alt === 'A box'));
    let pub = await adminGet('/admin/published', E1);
    check('the Published page shows them as published by "IMConnected Studio"', pub.text.includes('Studio Story One') && pub.text.includes('IMConnected Studio'));
    const home = await adminGet('/admin', E1);
    check('the inbox "Newest published" section lists them', home.text.slice(home.text.indexOf('id="home-pub"')).includes('Studio Story One'));
    const histo = await adminGet('/admin?status=published', E1);
    check('the Published filter of the inbox shows them with a Studio source badge', histo.text.includes('Studio Story One') && histo.text.includes('>Studio<'));
    check('the audit log has a draft.published_studio entry', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.published_studio'")[0].n === 2);

    r = await studio(payload('Second version of the story text, corrected.'));
    rows = q("SELECT * FROM drafts WHERE source = 'studio' ORDER BY id");
    const one2 = rows.find((d) => d.slug === '2026-10-19-studio-story-one') ?? {};
    check('re-publishing the same slug updates the same row (still 2 rows, same id)', r.status === 200 && r.data.stories[0].status === 'updated' && rows.length === 2 && one2.id === one.id, `${rows.length} rows`);
    check('...with the new commit and text, still published and not duplicated', /Second version/.test(one2.body) && q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', one.id)[0].n === 1 && q("SELECT COUNT(*) n FROM drafts WHERE slug = '2026-10-19-studio-story-one'")[0].n === 1);
    check('...and the story row was updated in place, live at once, with the new text', q('SELECT COUNT(*) n FROM stories WHERE slug = ?', slug1)[0].n === 1 && (await (await fetch(BASE + `/stories/${slug1}/`)).text()).includes('Second version of the story text, corrected.'));
    const bad = await studio({ newsletter: { issueDate: 'nope' }, stories: [] });
    check('an invalid Studio request is still refused (400) and records nothing', bad.status === 400 && q("SELECT COUNT(*) n FROM drafts WHERE source = 'studio'")[0].n === 2 && q('SELECT COUNT(*) n FROM stories')[0].n === storiesBefore + 2);
    // all or nothing: a bad second story leaves the good first one unpublished too
    const mixed = await studio({ newsletter: { name: 'N', issueDate: '2026-10-19' }, stories: [{ ref: 'ok', title: 'Mixed Batch Good', section: 'news', area: 'conference', author: 'A', body: 'Good text.' }, { ref: 'bad', title: 'Mixed Batch Bad', section: 'nonsense', author: 'A', body: 'Bad.' }] });
    check('a Studio request with one invalid story publishes nothing (400, names the story)', mixed.status === 400 && mixed.data.ref === 'bad' && !q("SELECT 1 FROM stories WHERE slug LIKE '%mixed-batch%'").length);
    // a database error part-way leaves nothing half-written (a trigger makes the second story's insert fail)
    run("CREATE TRIGGER zz_fail_studio BEFORE INSERT ON stories WHEN NEW.title = 'Studio Boom' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    const snap = () => JSON.stringify([q('SELECT * FROM stories ORDER BY id'), q('SELECT * FROM story_photos ORDER BY id'), q('SELECT * FROM drafts ORDER BY id'), q('SELECT rowid, * FROM stories_fts')]);
    const media = () => { const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name))); }; walk(path.join(DATA_DIR, 'media')); return out.sort().join(); };
    const snapBefore = snap(), mediaBefore = media();
    const boom = await studio({ newsletter: { name: 'N', issueDate: '2026-10-19' }, stories: [{ ref: 'g', title: 'Studio Good First', section: 'news', area: 'conference', author: 'A', body: 'Good.', photos: [{ url: 'data:image/png;base64,' + PNG_B.toString('base64'), alt: 'x', caption: '' }] }, { ref: 'b', title: 'Studio Boom', section: 'news', area: 'conference', author: 'A', body: 'Boom.' }] });
    check('a database error part-way through a Studio publish answers 502 and leaves nothing half-written (no rows, no draft records, no media file)', boom.status === 502 && snap() === snapBefore && media() === mediaBefore, String(boom.status));
    run('DROP TRIGGER zz_fail_studio');
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
    check('...only the live markers are set (commit, published_at) and no second row was made for the slug', a.published_commit === 'db' && a.published_at && a.studio_overwrote_at && q('SELECT COUNT(*) n FROM drafts WHERE slug = ?', slugA)[0].n === 1);
    check('...an audit entry draft.studio_overwrote_live names the draft', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.studio_overwrote_live' AND target = ?", `draft:${idA}`)[0].n === 1);
    const pageA = await adminGet(`/admin/drafts/${idA}`, E1);
    check('...the editor sees "IMConnected Studio published over this story on <date>; your saved edits here are not live."', /IMConnected Studio published over this story on[\s\S]*?; your saved edits here are not live\./.test(pageA.text));
    r = await studio(pay('Closed Story', '2026-10-22'));
    const b = q('SELECT * FROM drafts WHERE id = ?', idB)[0];
    check('a closed linked draft is updated in place with ALL content columns', r.status === 200 && b.title === 'Closed Story' && b.church === '' && b.author_title === '' && b.story_column === '' && b.featured === 0 && b.status === 'published' && b.published_by === null && b.published_commit === 'db' && q('SELECT COUNT(*) n FROM drafts WHERE slug = ?', slugB)[0].n === 1, JSON.stringify(b).slice(0, 300));
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
    check('Studio then publishes the same slug: the in-progress draft is credited to Studio, not the editor', r.status === 200 && c2.published_via_studio === 1 && c2.published_by === null && c2.status === 'in_review' && c2.published_commit === 'db', JSON.stringify(c2).slice(0, 300));
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

  // ================= announcements and events from the public form (issue #123) =================
  {
    const chicagoDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() + offset * 86400_000));
    const SHORT = 'Join us for a community potluck this Sabbath afternoon at noon.'; // well over 40, well under 200
    const EV_TITLE = 'Fall Potluck <script>alert(2)</script>';
    const EV_LOC = 'Fellowship hall <img src=x onerror=alert(3)>';
    const evDate = chicagoDay(10);
    const bodyOf = (n) => 'x'.repeat(n - 1) + '.';
    const outsideAttrs = (html) => html.replace(/="[^"]*"/g, '=""'); // quoted attribute values are inert text; markup outside them is what must stay clean
    const draftsByTitle = (t) => q('SELECT * FROM drafts WHERE title = ?', t);

    let r = await postForm(BASE, '/api/submit', form({ kind: 'event', title: EV_TITLE, body: SHORT, eventDate: evDate, location: EV_LOC }), [{ bytes: PNG_A, filename: 'flyer.png' }]);
    const ev = draftsByTitle(EV_TITLE)[0] ?? {};
    const evAnn = (() => { try { return JSON.parse(ev.announcement); } catch { return null; } })();
    check('event with a date: accepted and saved as a form/new draft', r.status === 200 && ev.source === 'form' && ev.status === 'new', r.text.slice(0, 200));
    check('...as a typed event announcement with the date and location, and no links or video', evAnn?.kind === 'event' && evAnn.eventDate === evDate && evAnn.location === EV_LOC && evAnn.links.length === 0 && !('videoUrl' in evAnn), String(ev.announcement));
    check('...with the flyer stored as its first photo and the body kept as safe text', q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', ev.id)[0].n === 1 && ev.body === SHORT);
    check('...and the submitter details are kept like any form draft', ev.submitter_email === SUBMITTER.email && ev.email_verified === 0);
    const evTab = await adminGet('/admin/events', E1);
    check('the editor inbox Events tab lists it, title escaped (no raw <script> element)', evTab.status === 200 && evTab.text.includes('Fall Potluck &lt;script&gt;alert(2)&lt;/script&gt;') && !outsideAttrs(evTab.text).includes('<script>alert(2)'));
    const storyTab = await adminGet('/admin', E1);
    check('...and not under Stories', !storyTab.text.includes('Fall Potluck'));
    const page = await adminGet(`/admin/drafts/${ev.id}`, E1);
    check('the editor sees the location as inert text (no raw <img> element from the location)', page.status === 200 && page.text.includes('value="Fellowship hall <img src=x') && !outsideAttrs(page.text).includes('<img src=x'));
    check('editors are told "New event submission: <title>" (the escaped title, no contact details)', await until(() => emails().some((m) => m.subject === `New event submission: ${EV_TITLE}`)) && !emails().filter((m) => m.subject === `New event submission: ${EV_TITLE}`).some((m) => PERSONAL.some((x) => JSON.stringify(m).includes(x))));
    check('nothing is published: no story row for it', q('SELECT COUNT(*) n FROM stories WHERE title = ?', EV_TITLE)[0].n === 0);

    r = await postForm(BASE, '/api/submit', form({ kind: 'event', title: 'Event no date', body: SHORT }));
    check('event without a date: 400 and no draft', r.status === 400 && /date of your event/.test(r.data.error) && draftsByTitle('Event no date').length === 0, r.text.slice(0, 200));
    for (const bad of ['next friday', '2026-13-45', '2026-02-30', '11/14/2026', `${evDate}T00:00junk`]) {
      r = await postForm(BASE, '/api/submit', form({ kind: 'event', title: 'Event bad date', body: SHORT, eventDate: bad }));
      check(`event with a malformed date "${bad}": 400 and no draft`, r.status === 400 && /real date/.test(r.data.error) && draftsByTitle('Event bad date').length === 0, r.text.slice(0, 200));
    }
    r = await postForm(BASE, '/api/submit', form({ kind: 'event', title: 'Event past', body: SHORT, eventDate: chicagoDay(-2) }));
    check('event dated before today (America/Chicago): 400', r.status === 400 && /already passed/.test(r.data.error) && draftsByTitle('Event past').length === 0, r.text.slice(0, 200));
    r = await postForm(BASE, '/api/submit', form({ kind: 'event', title: 'Event today', body: SHORT, eventDate: chicagoDay(0) }));
    check('event dated today (America/Chicago): accepted', r.status === 200 && draftsByTitle('Event today').length === 1, r.text.slice(0, 200));
    r = await postForm(BASE, '/api/submit', form({ kind: 'event', title: 'Event tab place', body: SHORT, eventDate: evDate, location: '  Fellowship\thall\u2028East\u0085 wing\n ' }));
    check('a pasted tab, line separator or newline in the location becomes a single space (accepted)', r.status === 200 && JSON.parse(draftsByTitle('Event tab place')[0]?.announcement ?? 'null')?.location === 'Fellowship hall East wing', r.text.slice(0, 200));
    const noJsFd = (over) => { const fd = new FormData(); for (const [k, v] of Object.entries(form(over))) fd.append(k, String(v)); return fd; };
    const noJs = await fetch(BASE + '/api/submit', { method: 'POST', headers: { Origin: BASE }, body: noJsFd({ kind: 'event', title: 'Event nojs', body: SHORT, eventDate: evDate }), redirect: 'manual' });
    check('no-JavaScript event submission redirects to /submit/thanks/?type=event', noJs.status === 303 && noJs.headers.get('location') === '/submit/thanks/?type=event', `${noJs.status} ${noJs.headers.get('location')}`);
    const noJsStory = await fetch(BASE + '/api/submit', { method: 'POST', headers: { Origin: BASE }, body: noJsFd({ title: 'Story nojs' }), redirect: 'manual' });
    check('no-JavaScript story still redirects to plain /submit/thanks/', noJsStory.status === 303 && noJsStory.headers.get('location') === '/submit/thanks/');
    const noJsBad = await fetch(BASE + '/api/submit', { method: 'POST', headers: { Origin: BASE }, body: noJsFd({ kind: 'event', title: 'Event nojs bad', body: SHORT }) });
    check('no-JavaScript error page has a neutral heading', noJsBad.status === 400 && (await noJsBad.text()).includes('We couldn’t send your submission'));
    run("DELETE FROM drafts WHERE title IN ('Event tab place', 'Event nojs', 'Story nojs')");
    r = await postForm(BASE, '/api/submit', form({ kind: 'event', title: 'Event long place', body: SHORT, eventDate: evDate, location: 'p'.repeat(201) }));
    check('event with a location over 200 characters: 400', r.status === 400 && draftsByTitle('Event long place').length === 0);

    r = await postForm(BASE, '/api/submit', form({ kind: 'announcement', title: 'Notice 40', body: bodyOf(40), eventDate: 'garbage', location: 'ignored place' }));
    const n40 = draftsByTitle('Notice 40')[0] ?? {};
    check('announcement with a 40-character body: accepted as a typed announcement, event fields ignored', r.status === 200 && JSON.parse(n40.announcement ?? 'null')?.kind === 'announcement' && n40.source === 'form' && n40.status === 'new' && !/eventDate|location/.test(n40.announcement), String(n40.announcement) + r.text.slice(0, 100));
    r = await postForm(BASE, '/api/submit', form({ kind: 'announcement', title: 'Notice 39', body: bodyOf(39) }));
    check('announcement with a 39-character body: 400 and no draft', r.status === 400 && /at least 40/.test(r.data.error) && draftsByTitle('Notice 39').length === 0, r.text.slice(0, 200));
    const annTab = await adminGet('/admin/announcements', E1);
    check('the Announcements tab lists the announcement and not the event', annTab.text.includes('Notice 40') && !annTab.text.includes('Fall Potluck'));

    r = await postForm(BASE, '/api/submit', form({ kind: 'event', title: 'Event short body', body: bodyOf(39), eventDate: evDate }));
    check('event with a 39-character body: 400', r.status === 400 && draftsByTitle('Event short body').length === 0);
    r = await postForm(BASE, '/api/submit', form({ kind: 'party', title: 'Unknown kind' }));
    check('an unknown type is refused (400)', r.status === 400 && draftsByTitle('Unknown kind').length === 0);

    // the story path is unchanged: still 200 characters, no announcement, event fields ignored
    r = await postForm(BASE, '/api/submit', form({ title: 'Story still needs 200', body: bodyOf(60) }));
    check('story with a 60-character body: still 400 (200 minimum)', r.status === 400 && /at least 200/.test(r.data.error) && draftsByTitle('Story still needs 200').length === 0, r.text.slice(0, 200));
    r = await postForm(BASE, '/api/submit', form({ kind: 'story', title: 'Story with stray fields', eventDate: evDate, location: 'Nowhere' }));
    const st = draftsByTitle('Story with stray fields')[0] ?? {};
    check('story (explicit kind) saves no announcement and ignores event fields', r.status === 200 && st.announcement === null, String(st.announcement));
    r = await postForm(BASE, '/api/submit', form({ title: 'Story without kind field' }));
    check('a form that sends no type (older client) is a plain story', r.status === 200 && draftsByTitle('Story without kind field')[0]?.announcement === null);
    const storiesTab = await adminGet('/admin', E1);
    check('the plain stories show under Stories', storiesTab.text.includes('Story with stray fields'));
    check('the submitter confirmation email is sent for the event too', await until(() => mailTo(emails(), SUBMITTER.email).length >= 2));
    run("DELETE FROM drafts WHERE title IN (?, 'Event today', 'Notice 40', 'Story with stray fields', 'Story without kind field')", EV_TITLE);
  }

  // ---- the form itself, in Chromium (skipped when Playwright is not installed) ----
  {
    const chicagoDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() + offset * 86400_000));
    let chromium = null;
    try {
      const pr = createRequire(process.env.PLAYWRIGHT_ROOT ? path.join(process.env.PLAYWRIGHT_ROOT, 'package.json') : import.meta.url);
      for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { chromium = pr(spec).chromium; break; } catch { /* next */ } }
    } catch { /* none */ }
    if (!chromium) console.log('SKIP  form type chooser in Chromium (Playwright not found)');
    else {
      const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--disable-dev-shm-usage', '--disable-gpu', ...(process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
      try {
        const shots = process.env.SHOTS_DIR;
        if (shots) fs.mkdirSync(shots, { recursive: true });
        const html = await (await fetch(BASE + '/submit/')).text();
        check('without JavaScript the form has the type radios (Story checked) and every event field', /name="kind" value="story" checked/.test(html) && /name="kind" value="announcement"/.test(html) && /name="kind" value="event"/.test(html) && /<legend>What are you sending\?<\/legend>/.test(html) && /name="eventDate"/.test(html) && /name="location"/.test(html));
        for (const [w, h] of [[390, 844], [1280, 900]]) {
          const ctx = await browser.newContext({ viewport: { width: w, height: h } });
          const p = await ctx.newPage();
          const errs = [];
          p.on('pageerror', (e) => errs.push(String(e)));
          await p.goto(BASE + '/submit/');
          const vis = (sel) => p.locator(sel).isVisible();
          const hint = () => p.locator('#body-hint').innerText();
          check(`[${w}px] Story is selected and the event fields are hidden`, await p.locator('input[value="story"]').isChecked() && !(await vis('#eventDate')) && !(await vis('#location')));
          const storyHint = await hint();
          if (shots) await p.screenshot({ path: path.join(shots, `form-story-${w}.png`) });
          await p.locator('.type-choice label', { hasText: 'Event' }).click();
          check(`[${w}px] choosing Event shows date and location and makes the date required`, (await vis('#eventDate')) && (await vis('#location')) && await p.locator('#eventDate').evaluate((el) => el.required));
          const evHint = await hint();
          check(`[${w}px] the body hint and label change for an event (minimum 40, not 200)`, evHint !== storyHint && /40 characters/.test(evHint) && /Event details/.test(await p.locator('#body-label').innerText()) && (await p.locator('#body').evaluate((el) => el.minLength)) === 40);
          check(`[${w}px] the date label says it is required for events, and min is today (America/Chicago)`, /required for events/.test(await p.locator('label[for="eventDate"]').innerText()) && (await p.locator('#eventDate').getAttribute('min')) === chicagoDay(0));
          check(`[${w}px] switching to Event announces the added fields in a polite live region`, /added/.test(await p.locator('form > p.sr-only[role="status"]').innerText()) && (await p.locator('form > p.sr-only[role="status"]').getAttribute('aria-live')) === 'polite');
          check(`[${w}px] the button says "Send my event"`, (await p.locator('#submit-btn').innerText()) === 'Send my event');
          const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          check(`[${w}px] no horizontal scroll with Event chosen`, overflow <= 0, String(overflow));
          if (shots) {
            await p.locator('#eventDate').scrollIntoViewIfNeeded();
            await p.screenshot({ path: path.join(shots, `form-event-${w}.png`) });
            await p.screenshot({ path: path.join(shots, `form-event-${w}-full.png`), fullPage: true });
          }
          await p.locator('.type-choice label', { hasText: 'Announcement' }).click();
          check(`[${w}px] ...and leaving Event announces them removed`, await (async () => { await p.locator('.type-choice label', { hasText: 'Announcement' }).click(); return /removed/.test(await p.locator('form > p.sr-only[role="status"]').innerText()); })());
          check(`[${w}px] choosing Announcement hides the date and location again`, !(await vis('#eventDate')) && !(await vis('#location')) && /Say what people need/.test(await hint()));
          await p.locator('.type-choice label', { hasText: 'Story' }).click();
          check(`[${w}px] back to Story restores the 200-character minimum`, (await p.locator('#body').evaluate((el) => el.minLength)) === 200 && (await hint()) === storyHint);
          check(`[${w}px] no page errors`, errs.length === 0, errs.join('|'));
          await ctx.close();
        }
      } finally { await browser.close(); }
    }
  }

  // ================= the database is unavailable =================
  {
    const mailBefore = emails().length, dcBefore = discord.length;
    const r = await postForm(BASE_C, '/api/submit', form({ title: 'Lost Story' }), [{ bytes: PNG_A, filename: 'one.png' }]);
    check('database unavailable: submit answers 503 "Submissions are temporarily unavailable. Please email us your story."', r.status === 503 && r.data.error === 'Submissions are temporarily unavailable. Please email us your story.', r.text.slice(0, 200));
    await sleep(200);
    check('...nothing else happened (no email, no Discord ping)', emails().length === mailBefore && discord.length === dcBefore);
    const noJs = await fetch(BASE_C + '/api/submit', { method: 'POST', headers: { Origin: BASE_C }, body: (() => { const fd = new FormData(); for (const [k, v] of Object.entries(form())) fd.append(k, String(v)); return fd; })() });
    check('...and the no-JavaScript form shows the same message', noJs.status === 503 && (await noJs.text()).includes('Submissions are temporarily unavailable. Please email us your story.'));

    const pr = await fetch(BASE_C + '/api/publish', {
      method: 'POST', headers: { Authorization: `Bearer ${PUBLISH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ newsletter: { name: 'N', issueDate: '2026-10-20' }, stories: [{ ref: 'z', title: 'Published Without A Database', section: 'news', area: 'conference', author: 'Studio Author', body: 'This text must not go anywhere without a database.' }] }),
    });
    const data = await pr.json();
    check('database unavailable: Studio publish fails cleanly (502) instead of pretending to publish', pr.status === 502 && data.ok === false, JSON.stringify(data).slice(0, 200));
    // the public pages answer 503 rather than showing stale or empty content
    const pages = {};
    for (const u of ['/', '/news/', '/stories/some-story/', '/stories.json', '/rss.xml']) { const res = await fetch(BASE_C + u); pages[u] = [res.status, res.headers.get('cache-control'), (await res.text()).includes('Back in a moment') || u.endsWith('.json') || u.endsWith('.xml')]; }
    check('database unavailable: home, section, story, /stories.json and /rss.xml answer 503 (no-store), never stale built content', Object.values(pages).every(([st, cc]) => st === 503 && /no-store/.test(cc)), JSON.stringify(pages));
    const studioList = await fetch(BASE_C + '/api/stories', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` } });
    check('...and /api/stories answers 503 too', studioList.status === 503);
    const srch = await (await fetch(BASE_C + '/api/search?q=baptism')).json();
    check('...and search says it is not available instead of "no matches"', srch.ok === false && srch.total === 0);
  }

  // ================= no personal data in logs, editor emails or commits =================
  {
    const all = [...logs.a, ...logs.c].join('\n');
    check('no submitter email, phone or name in any server log', ![...PERSONAL, SUBMITTER.name].some((s) => all.includes(s)), PERSONAL.filter((s) => all.includes(s)).join(','));
    const editorMail = emails().filter((m) => !m.to.includes(SUBMITTER.email));
    check('no submitter email or phone in any email sent to editors', editorMail.length >= 1 && !editorMail.some((m) => PERSONAL.some((s) => JSON.stringify(m).includes(s))));
    const rows = JSON.stringify([q('SELECT * FROM stories'), q('SELECT * FROM story_photos')]);
    const pages = (await Promise.all(['/', '/stories.json', '/rss.xml', '/news/', '/api/search?q=studio'].map(async (u) => (await fetch(BASE + u)).text()))).join('\n');
    check('no submitter email or phone in any story row or public page or feed', ![...PERSONAL].some((s) => rows.includes(s) || pages.includes(s)));
  }
} catch (err) {
  check('the run completed without an exception', false, String(err && err.stack ? err.stack : err).slice(0, 800));
} finally {
  await cleanup();
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
