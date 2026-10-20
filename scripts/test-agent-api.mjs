#!/usr/bin/env node
// End-to-end check of the AI agent story API and the authenticated Studio story list (issue 21).
// It starts everything itself: the mock GitHub API, the mock email API and four copies of the BUILT server
// (main, no agent token, a short agent token, and a fresh one for the rate limit). Synthetic data only: made-up
// tokens, no real email, no real GitHub.
//   npm run build
//   SCRATCH=/tmp/imc-agent-e2e node scripts/test-agent-api.mjs        # run from the repo root
// SCRATCH is created fresh (an existing folder is removed first) and deleted at the end unless KEEP=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const P = { gh: 4510, mail: 4511, a: 4521, b: 4522, c: 4523, d: 4524, e: 4525 };
const BASE = `http://localhost:${P.a}`;
const AGENT_TOKEN = 'e2e-made-up-agent-token-' + 'a'.repeat(24);
const PUBLISH_TOKEN = 'e2e-made-up-publish-token-' + 'p'.repeat(24);
const TOOLS_ORIGIN = 'https://tools.e2e-example.test';
const EVIL_ORIGIN = 'https://evil.e2e-example.test';

// Synthetic personal data of a "form" submitter that must never appear in the Studio list.
const SUBMITTER = { name: 'Riley Sample', email: 'riley.sample@e2e-mail.com', phone: '555-0142', church: 'Example Hills Church' };

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(100); } return cond(); };
const q = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

// ---- processes ----
const procs = [];
const logs = { gh: [], mail: [], a: [], b: [], c: [], d: [], e: [] };
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
async function cleanup() {
  for (const p of procs) p.kill();
  if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true });
}

// ---- synthetic images (valid and tiny, or just the magic bytes) ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(r, g, b, size = 32) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_A = png(200, 90, 40);
const PNG_B = png(40, 120, 200);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(40, 1), Buffer.from([0xff, 0xd9])]);
const dataUrl = (bytes, mime = 'image/png') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

// ================= part 0: migration 010 on a database that already has data =================
{
  const { openDatabase, runMigrations, readMigrationsFromDir } = await import(path.join(ROOT, 'src/lib/db/db-core.mjs'));
  const mdir = path.join(ROOT, 'src/lib/db/migrations');
  const all = readMigrationsFromDir(mdir);
  const dir = path.join(SCRATCH, 'migrate');
  const db = openDatabase(dir);
  runMigrations(db, all.filter((m) => m.name < '010'));
  const now = Date.now();
  db.prepare("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('m@e2e-mail.com', 'M', 'editor', 'active', ?, ?)").run(now, now);
  const ins = db.prepare("INSERT INTO drafts (id, status, source, title, section, body, slug, submitter_email, created_at, created_by, updated_at, updated_by, published_via_studio, studio_overwrote_at) VALUES (?, ?, ?, ?, 'news', 'b', ?, ?, ?, 1, ?, 1, ?, ?)");
  ins.run(7, 'new', 'form', 'Form draft', null, 'x@e2e-mail.com', now, now, 0, null);
  ins.run(9, 'published', 'studio', 'Studio draft', '2026-10-19-studio', null, now, now, 1, 123);
  ins.run(12, 'in_review', 'editor', 'Editor draft', null, null, now, now, 0, null);
  const ph = db.prepare('INSERT INTO draft_photos (id, draft_id, path, url, ext, alt, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ph.run(31, 7, '7/aa.png', null, 'png', 'one', 0, now);
  ph.run(32, 7, '7/bb.png', null, 'png', 'two', 1, now);
  ph.run(40, 9, null, '/images/stories/x/photo-1.jpg', null, 'studio', 0, now);
  const applied = runMigrations(db, all);
  check('migration 010 applies on a database with drafts and photos', applied.length === 1 && applied[0].startsWith('010_'), JSON.stringify(applied));
  const rows = db.prepare('SELECT id, status, source, title, slug, submitter_email, published_via_studio pvs, studio_overwrote_at so FROM drafts ORDER BY id').all();
  check('...every draft row is kept with its id and values', rows.length === 3 && rows[0].id === 7 && rows[0].submitter_email === 'x@e2e-mail.com' && rows[1].slug === '2026-10-19-studio' && rows[1].pvs === 1 && rows[1].so === 123 && rows[2].source === 'editor', JSON.stringify(rows));
  const photos = db.prepare('SELECT id, draft_id, path, url, alt, position FROM draft_photos ORDER BY id').all();
  check('...and the photos survive (the rebuild must not cascade-delete them)', photos.length === 3 && photos[0].draft_id === 7 && photos[2].url === '/images/stories/x/photo-1.jpg' && photos[1].alt === 'two', JSON.stringify(photos));
  check('...with a clean foreign key check', db.prepare('PRAGMA foreign_key_check').all().length === 0);
  check('...and the new columns exist', db.prepare("SELECT source_url, agent_note FROM drafts WHERE id = 7").get().source_url === null);
  let ok = true;
  try { db.prepare("INSERT INTO drafts (status, source, created_at, updated_at, source_url) VALUES ('new', 'agent', 1, 1, 'https://x.test/1')").run(); } catch { ok = false; }
  check('...source "agent" is now allowed', ok);
  let dup = false;
  try { db.prepare("INSERT INTO drafts (status, source, created_at, updated_at, source_url) VALUES ('new', 'agent', 1, 1, 'https://x.test/1')").run(); } catch { dup = true; }
  check('...a second agent draft for the same source_url is refused by the unique index', dup);
  let bad = false;
  try { db.prepare("INSERT INTO drafts (status, source, created_at, updated_at) VALUES ('new', 'robot', 1, 1)").run(); } catch { bad = true; }
  check('...an unknown source is still refused', bad);
  db.prepare("DELETE FROM drafts WHERE id = 7").run();
  check('...deleting a draft still cascades to its photos (foreign key rebuilt)', db.prepare('SELECT COUNT(*) c FROM draft_photos WHERE draft_id = 7').get().c === 0);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('drafts','draft_photos')").all().map((r) => r.name);
  check('...the indexes are back', ['drafts_slug', 'drafts_status_created', 'draft_photos_draft', 'drafts_agent_source_url'].every((n) => idx.includes(n)), idx.join());
  db.close();
}

// ================= servers =================
const common = {
  AUTH_SECRET: 'e2e-auth-secret-' + 'z'.repeat(24),
  GITHUB_TOKEN: 'mock-token',
  GITHUB_REPO: 'mock/repo',
  GITHUB_API_URL: `http://localhost:${P.gh}`,
  RESEND_API_KEY: 'mock-resend-key',
  EMAIL_FROM: 'IMConnected <noreply@e2e-mail.com>',
  EMAIL_API_URL: `http://localhost:${P.mail}/emails`,
  PUBLISH_TOKEN,
  PUBLISH_ORIGINS: TOOLS_ORIGIN,
  TRUST_PROXY: 'true',
  HOST: '127.0.0.1',
};
delete process.env.AGENT_API_TOKEN;
delete process.env.SUBMISSIONS_TO;

start('gh', 'node', ['scripts/mock-github.mjs'], { MOCK_PORT: String(P.gh), MOCK_OUT });
start('mail', 'node', ['scripts/mock-email.mjs'], { MOCK_EMAIL_PORT: String(P.mail) });
await waitFor(`http://localhost:${P.mail}/x`);
start('a', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.a), DATA_DIR, SITE_URL: BASE, AGENT_API_TOKEN: AGENT_TOKEN });
start('b', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.b), DATA_DIR: path.join(SCRATCH, 'data-b'), SITE_URL: `http://localhost:${P.b}`, PUBLISH_TOKEN: '' }); // no agent token, no publish token
start('c', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.c), DATA_DIR: path.join(SCRATCH, 'data-c'), SITE_URL: `http://localhost:${P.c}`, AGENT_API_TOKEN: 'too-short-token' });
start('d', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.d), DATA_DIR: path.join(SCRATCH, 'data-d'), SITE_URL: `http://localhost:${P.d}`, AGENT_API_TOKEN: AGENT_TOKEN });
start('e', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.e), DATA_DIR: path.join(SCRATCH, 'data-e'), SITE_URL: `http://localhost:${P.e}`, AGENT_API_TOKEN: PUBLISH_TOKEN }); // the agent token reuses the publish token
for (const port of [P.gh, P.a, P.b, P.c, P.d, P.e]) await waitFor(`http://localhost:${port}/`);

try {
  // ---- helpers ----
  const emails = () => logs.mail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && m.subject);
  const call = async (base, method, url, { token, headers = {}, body, json } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload = body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, text, data };
  };
  const agentPost = (json, opts = {}) => call(BASE, 'POST', '/api/agent/stories', { token: AGENT_TOKEN, json, ...opts });
  const story = (over = {}) => ({
    title: 'Example Pathfinder Club Hosts Fall Campout',
    dek: 'Forty youth camped, cooked and prayed together.',
    body: 'Pathfinders from several clubs gathered at a camp for a weekend of knot tying, cooking and worship.\n\nLeaders said the weekend ended with a sunrise devotional.',
    section: 'youth', area: 'pathfinders', author: 'Staff Writer', church: 'Example Hills Church', date: '2026-10-12',
    sourceUrl: 'https://www.facebook.com/example-page/posts/1001', note: 'Picked because it has two clear photos.',
    photos: [{ data: dataUrl(PNG_A), alt: 'Campers around a fire' }, { data: dataUrl(JPG, 'image/jpeg'), alt: 'Tents in a row' }],
    ...over,
  });
  const draftRows = () => q('SELECT id, source FROM drafts');
  const uploadFiles = () => { const root = path.join(DATA_DIR, 'uploads'); const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name)); }; walk(root); return out; };

  // ---- editors (inserted directly; sign-in has its own tests) ----
  await fetch(BASE + '/admin/login'); // makes the server open the database and apply migrations
  const mkUser = (email, name, notify = 1) => {
    const now = Date.now();
    const id = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at, notify_submissions) VALUES (?, ?, 'editor', 'active', ?, ?, ?)", email, name, now, now, notify).lastInsertRowid);
    const token = randomBytes(32).toString('base64url');
    run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600_000);
    return { id, email, token };
  };
  const E1 = mkUser('editor-one@e2e-mail.com', 'Test Editor');
  const E2 = mkUser('editor-two@e2e-mail.com', 'Quiet Editor', 0);
  const cookie = (u) => ({ Cookie: `__Host-imc_session=${u.token}` });
  const adminGet = (u, user) => call(BASE, 'GET', u, { headers: cookie(user) });
  const adminForm = (u, user, fields) => call(BASE, 'POST', u, { headers: { ...cookie(user), Origin: BASE, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

  // ================= auth =================
  {
    let r = await call(BASE, 'POST', '/api/agent/stories', { json: story() });
    check('no token: 401', r.status === 401 && r.data.ok === false, `${r.status} ${r.text.slice(0, 100)}`);
    r = await call(BASE, 'POST', '/api/agent/stories', { token: 'x'.repeat(AGENT_TOKEN.length), json: story() });
    check('wrong token (same length): 401', r.status === 401);
    r = await call(BASE, 'POST', '/api/agent/stories', { token: 'short', json: story() });
    check('wrong token (different length): 401', r.status === 401);
    r = await call(BASE, 'POST', '/api/agent/stories', { token: PUBLISH_TOKEN, json: story() });
    check('the Studio PUBLISH_TOKEN is not accepted by the agent route: 401', r.status === 401);
    r = await call(BASE, 'GET', '/api/agent/sections');
    check('GET /api/agent/sections without a token: 401', r.status === 401);
    r = await call(BASE, 'POST', '/api/agent/stories', { json: story(), headers: { Authorization: 'Basic ' + AGENT_TOKEN } });
    check('a non-Bearer Authorization header: 401', r.status === 401);
    check('none of those created a draft', draftRows().length === 0);

    r = await call(`http://localhost:${P.b}`, 'POST', '/api/agent/stories', { token: AGENT_TOKEN, json: story() });
    check('AGENT_API_TOKEN unset: 503', r.status === 503 && r.data.ok === false, String(r.status));
    r = await call(`http://localhost:${P.b}`, 'GET', '/api/agent/sections', { token: AGENT_TOKEN });
    check('...also for /api/agent/sections', r.status === 503);
    r = await call(`http://localhost:${P.c}`, 'POST', '/api/agent/stories', { token: 'too-short-token', json: story() });
    check('AGENT_API_TOKEN shorter than 32 characters: 503 (even with the matching token)', r.status === 503);

    r = await call(BASE, 'GET', '/api/agent/stories', { token: AGENT_TOKEN });
    check('GET on /api/agent/stories: 405', r.status === 405);
  }

  // ================= the agent token must differ from the publish token =================
  {
    const E = `http://localhost:${P.e}`;
    const story1 = story({ photos: [] });
    let r = await call(E, 'POST', '/api/agent/stories', { token: PUBLISH_TOKEN, json: story1 });
    check('AGENT_API_TOKEN equal to PUBLISH_TOKEN: the agent route answers 503, even with that token', r.status === 503 && r.data.error === 'not_configured', `${r.status} ${r.text.slice(0, 100)}`);
    r = await call(E, 'GET', '/api/agent/sections', { token: PUBLISH_TOKEN });
    check('...also /api/agent/sections', r.status === 503);
    r = await call(E, 'POST', '/api/publish', { token: PUBLISH_TOKEN, json: { newsletter: { name: 'x', issueDate: '2026-10-19' }, stories: [] } });
    check('...and /api/publish (the agent cannot commit to main with the shared secret)', r.status === 503);
    r = await call(E, 'GET', '/api/stories', { token: PUBLISH_TOKEN });
    check('...and /api/stories', r.status === 503);
    check('...nothing reached GitHub from it', !logs.gh.some((l) => /^(POST|PUT|PATCH) /.test(l)));
    check('...the log says so without naming a value', logs.e.some((l) => l.includes('AGENT_API_TOKEN and PUBLISH_TOKEN are the same')) && !logs.e.join('\n').includes(PUBLISH_TOKEN));
  }

  // ================= rate-limit window =================
  {
    const { takeSlot } = await import(path.join(ROOT, 'src/lib/rate-window.ts'));
    const hits = [];
    const H = 3600_000;
    const t0 = 1_000_000;
    const first = Array.from({ length: 60 }, (_, i) => takeSlot(hits, t0 + i, 60, H));
    check('limiter: 60 requests in the window are allowed', first.every(Boolean) && hits.length === 60);
    const retries = Array.from({ length: 200 }, (_, i) => takeSlot(hits, t0 + 100 + i, 60, H));
    check('limiter: further requests are refused and NOT recorded (the list does not grow)', retries.every((x) => !x) && hits.length === 60);
    check('limiter: after the first hits age out, a request succeeds again even though the client kept retrying', takeSlot(hits, t0 + H + 10, 60, H) === true && hits.length === 60 - 11 + 1);
    check('limiter: a client that stops waiting for the whole window starts fresh', takeSlot(hits, t0 + 3 * H, 60, H) === true && hits.length === 1);
  }

  // ================= sections =================
  {
    const r = await call(BASE, 'GET', '/api/agent/sections', { token: AGENT_TOKEN });
    const youth = (r.data.sections || []).find((s) => s.key === 'youth');
    check('GET /api/agent/sections lists sections and areas', r.status === 200 && r.data.ok && r.data.sections.length === 5 && youth?.areas?.some((a) => a.key === 'pathfinders') && r.data.sections.find((s) => s.key === 'kids').areas === null, r.text.slice(0, 200));
  }

  // ================= create =================
  let id1;
  const mailBefore = emails().length;
  {
    const r = await agentPost(story());
    check('POST with 2 data: photos: 201 created', r.status === 201 && r.data.ok === true && r.data.status === 'created' && Number.isInteger(r.data.id), `${r.status} ${r.text.slice(0, 200)}`);
    id1 = r.data.id;
    check('...the response url points at the draft in the dashboard', r.data.url === `${BASE}/admin/drafts/${id1}`, r.data.url);
    const d = q('SELECT * FROM drafts WHERE id = ?', id1)[0] ?? {};
    check('draft: source agent, status new, no author account', d.source === 'agent' && d.status === 'new' && d.created_by === null && d.updated_by === null);
    check('draft: fields stored (title, dek, section, area, author, church, date)', d.title === 'Example Pathfinder Club Hosts Fall Campout' && d.dek.startsWith('Forty') && d.section === 'youth' && d.area === 'pathfinders' && d.author === 'Staff Writer' && d.church === 'Example Hills Church' && d.date === '2026-10-12');
    check('draft: source_url and agent_note stored', d.source_url === 'https://www.facebook.com/example-page/posts/1001' && d.agent_note === 'Picked because it has two clear photos.');
    check('draft: no submitter contact details at all', d.submitter_name === null && d.submitter_email === null && d.submitter_phone === null);
    const photos = q('SELECT * FROM draft_photos WHERE draft_id = ? ORDER BY position', id1);
    check('two photos recorded in order, as uploads with their alt text', photos.length === 2 && photos.every((p) => p.path && !p.url) && photos[0].ext === 'png' && photos[1].ext === 'jpg' && photos[0].alt === 'Campers around a fire' && photos[1].alt === 'Tents in a row');
    check('the photo files exist under DATA_DIR/uploads/<draft>/ with their exact bytes', photos.length === 2 && photos.every((p) => p.path.startsWith(`${id1}/`)) && fs.readFileSync(path.join(DATA_DIR, 'uploads', photos[0].path)).equals(PNG_A) && fs.readFileSync(path.join(DATA_DIR, 'uploads', photos[1].path)).equals(JPG));

    // dashboard
    const page = await adminGet(`/admin/drafts/${id1}`, E1);
    check('the dashboard draft page shows the "From AI agent" badge', page.status === 200 && page.text.includes('From AI agent'));
    check('...the submitter panel says "AI agent" and holds no email or phone rows', page.text.includes('<dd>AI agent</dd>') && !/<dt>Email<\/dt>/.test(page.text) && !/<dt>Phone<\/dt>/.test(page.text));
    check('...the agent note is shown', page.text.includes('Picked because it has two clear photos.'));
    const tag = /<a [^>]*>View original post<\/a>/.exec(page.text)?.[0] ?? '';
    check('..."View original post" links to the source with rel="noopener noreferrer"', tag.includes('href="https://www.facebook.com/example-page/posts/1001"') && /rel="noopener noreferrer"/.test(tag), tag);
    const photoIds = q('SELECT id FROM draft_photos WHERE draft_id = ? ORDER BY position', id1).map((r) => r.id);
    check('...both photos are listed (served through the editor-only photo route)', photoIds.every((p) => page.text.includes(`/api/admin/photos/${p}`)));
    const img = await fetch(`${BASE}/api/admin/photos/${photoIds[0]}`, { headers: cookie(E1) });
    check('...an editor can load the photo; without a session it is refused', img.status === 200 && Buffer.from(await img.arrayBuffer()).equals(PNG_A) && (await fetch(`${BASE}/api/admin/photos/${photoIds[0]}`, { redirect: 'manual' })).status === 401);
    const inbox = await adminGet('/admin', E1);
    check('the inbox shows the draft with a "From AI agent" badge and a Source filter', inbox.text.includes('Example Pathfinder Club Hosts Fall Campout') && inbox.text.includes('From AI agent') && inbox.text.includes('Source: AI agent'));

    // editors are notified
    check('editors who opted in get the "new story" email, saying it is from the AI agent', await until(() => emails().length > mailBefore));
    const mail = emails().slice(mailBefore);
    const toE1 = mail.filter((m) => m.to.includes(E1.email));
    check('...one email to the opted-in editor, none to the one who opted out', toE1.length === 1 && mail.every((m) => !m.to.includes(E2.email)), JSON.stringify(mail.map((m) => m.to)));
    const m1 = toE1[0] ?? { subject: '', text: '', html: '' };
    check('...it says "from the AI agent" and links to the draft', /from the AI agent/i.test(m1.subject) && /from the AI agent/i.test(m1.text) && m1.text.includes(`${BASE}/admin/drafts/${id1}`));
    check('...it holds only the title and church, not the story text, the note or the source link', !m1.text.includes('knot tying') && !m1.html.includes('knot tying') && !m1.text.includes('Picked because') && !m1.text.includes('facebook.com'));
  }

  // ================= idempotent by sourceUrl =================
  {
    const mailCount = emails().length;
    const files0 = uploadFiles().length;
    const r = await agentPost(story({ title: 'Example Pathfinder Club Hosts Fall Campout (updated)', note: 'Updated note.', photos: [{ data: dataUrl(PNG_B), alt: 'New photo' }] }));
    check('the same sourceUrl again: 201 "updated" with the same id', r.status === 201 && r.data.status === 'updated' && r.data.id === id1, r.text.slice(0, 200));
    check('...still exactly one agent draft', q("SELECT COUNT(*) c FROM drafts WHERE source = 'agent' AND source_url = ?", 'https://www.facebook.com/example-page/posts/1001')[0].c === 1);
    const d = q('SELECT title, agent_note, status FROM drafts WHERE id = ?', id1)[0];
    check('...its text and note were replaced and it is still new', d.title.endsWith('(updated)') && d.agent_note === 'Updated note.' && d.status === 'new');
    const photos = q('SELECT * FROM draft_photos WHERE draft_id = ?', id1);
    check('...its photos were replaced and the old files deleted', photos.length === 1 && photos[0].alt === 'New photo' && uploadFiles().length === files0 - 1 && fs.readFileSync(path.join(DATA_DIR, 'uploads', photos[0].path)).equals(PNG_B));
    await sleep(600);
    check('...editors are not emailed again for an update', emails().length === mailCount);
    const r2 = await agentPost(story({ title: 'Example Pathfinder Club Hosts Fall Campout (again)', photos: undefined }));
    check('a re-post without a photos list leaves the photos alone', r2.status === 201 && r2.data.status === 'updated' && q('SELECT COUNT(*) c FROM draft_photos WHERE draft_id = ?', id1)[0].c === 1);
    const v = q('SELECT updated_at FROM drafts WHERE id = ?', id1)[0].updated_at;
    const r3 = await agentPost(story({ title: 'Again', photos: undefined }));
    check('...and each update moves the draft version forward (an open editor page gets a conflict)', r3.status === 201 && q('SELECT updated_at FROM drafts WHERE id = ?', id1)[0].updated_at > v);
  }

  // ================= after an editor touches it: 409 =================
  {
    const d = q('SELECT updated_at, title FROM drafts WHERE id = ?', id1)[0];
    const saved = await adminForm(`/api/admin/drafts/${id1}/save`, E1, { version: String(d.updated_at), title: 'Edited by a person', section: 'youth', area: 'pathfinders', date: '2026-10-12', body: 'Edited body text.' });
    check('an editor saves the draft', saved.status === 200 && saved.data.ok === true, saved.text.slice(0, 200));
    check('...it is now in review', q('SELECT status, updated_by FROM drafts WHERE id = ?', id1)[0].status === 'in_review');
    const before = q('SELECT title, body, agent_note FROM drafts WHERE id = ?', id1)[0];
    const r = await agentPost(story({ title: 'Agent tries again' }));
    check('a re-post now gets 409 already_reviewed with the draft id', r.status === 409 && r.data.ok === false && r.data.error === 'already_reviewed' && r.data.id === id1, r.text.slice(0, 200));
    const after = q('SELECT title, body, agent_note FROM drafts WHERE id = ?', id1)[0];
    check('...and the editor\'s draft is untouched, with no second draft', JSON.stringify(before) === JSON.stringify(after) && q("SELECT COUNT(*) c FROM drafts WHERE source = 'agent'").length === 1 && q("SELECT COUNT(*) c FROM drafts WHERE source = 'agent' AND source_url = 'https://www.facebook.com/example-page/posts/1001'")[0].c === 1);

    // a new draft that an editor only adds a photo to (status stays "new") also counts as touched
    const r1 = await agentPost(story({ title: 'Second Story For Photo Touch', sourceUrl: 'https://www.facebook.com/example-page/posts/1002', photos: [] }));
    check('(second draft created)', r1.status === 201 && r1.data.status === 'created');
    const id2 = r1.data.id;
    const ver = q('SELECT updated_at FROM drafts WHERE id = ?', id2)[0].updated_at;
    const fd = new FormData();
    fd.set('version', String(ver)); fd.set('op', 'upload'); fd.append('photos', new Blob([PNG_A]), 'a.png');
    const up = await call(BASE, 'POST', `/api/admin/drafts/${id2}/photos`, { headers: { ...cookie(E1), Origin: BASE }, body: fd });
    check('an editor uploads a photo to it (it stays "new")', up.status === 303 && q('SELECT status FROM drafts WHERE id = ?', id2)[0].status === 'new');
    const r2 = await agentPost(story({ title: 'Agent tries again', sourceUrl: 'https://www.facebook.com/example-page/posts/1002' }));
    check('...a re-post still gets 409, because an editor changed it', r2.status === 409 && r2.data.error === 'already_reviewed' && r2.data.id === id2);

    // rejected and published drafts are closed to the agent as well
    const r3 = await agentPost(story({ title: 'Third Story To Reject', sourceUrl: 'https://www.facebook.com/example-page/posts/1003', photos: [] }));
    run("UPDATE drafts SET status = 'rejected', rejected_at = ? WHERE id = ?", Date.now(), r3.data.id);
    const r4 = await agentPost(story({ title: 'again', sourceUrl: 'https://www.facebook.com/example-page/posts/1003' }));
    check('a rejected draft is closed to the agent: 409', r4.status === 409 && r4.data.id === r3.data.id);
  }

  // ================= validation =================
  {
    const rowsBefore = draftRows().length;
    const filesBefore = uploadFiles().length;
    const bad = async (name, over, code, status = 400) => {
      const r = await agentPost(story({ sourceUrl: 'https://www.facebook.com/example-page/posts/bad-' + Math.random().toString(36).slice(2), ...over }));
      check(`rejected: ${name}`, r.status === status && r.data.ok === false && (!code || r.data.error === code) && typeof r.data.message === 'string', `${r.status} ${r.text.slice(0, 160)}`);
    };
    await bad('a remote photo URL', { photos: [{ data: 'https://scontent.xx.fbcdn.net/v/t39/photo.jpg', alt: 'x' }] }, 'photo_remote_url');
    await bad('a photo given only as a url key', { photos: [{ url: 'https://example.test/a.jpg', alt: 'x' }] }, 'photo_remote_url');
    await bad('a photo that is a bare string', { photos: ['https://example.test/a.jpg'] }, 'photo_invalid');
    await bad('an oversized photo (over 10 MB)', { photos: [{ data: dataUrl(Buffer.concat([PNG_A, Buffer.alloc(10.5 * 1024 * 1024)])), alt: 'x' }] }, 'photo_too_large');
    await bad('a non-image photo (text)', { photos: [{ data: dataUrl(Buffer.from('just some text, not an image at all'), 'image/png'), alt: 'x' }] }, 'photo_not_image');
    await bad('an SVG photo', { photos: [{ data: dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'), alt: 'x' }] }, 'photo_not_image');
    await bad('a photo that is not base64', { photos: [{ data: 'data:image/png;base64,@@@not-base64@@@', alt: 'x' }] }, 'photo_invalid');
    await bad('too many photos (7)', { photos: Array.from({ length: 7 }, () => ({ data: dataUrl(PNG_A), alt: '' })) }, 'too_many_photos');
    await bad('photos that are not a list', { photos: 'nope' }, 'photos_invalid');
    await bad('a missing title', { title: '' }, 'title_required');
    await bad('a title over 140 characters', { title: 'x'.repeat(141) }, 'title_too_long');
    await bad('a missing body', { body: '  ' }, 'body_required');
    await bad('a body that is too long', { body: 'x'.repeat(20001) }, 'body_too_long');
    await bad('a summary that is too long', { dek: 'x'.repeat(241) }, 'dek_too_long');
    await bad('an unknown section', { section: 'sports', area: '' }, 'bad_section');
    await bad('an area that does not belong to the section', { section: 'youth', area: 'churches' }, 'bad_area');
    await bad('an area without a section', { section: '', area: 'churches' }, 'bad_area');
    await bad('a bad date', { date: '2026-13-45' }, 'bad_date');
    await bad('a javascript: source link', { sourceUrl: 'javascript:alert(1)' }, 'bad_source_url');
    await bad('a non-link source', { sourceUrl: 'not a url' }, 'bad_source_url');
    await bad('a title that is not text', { title: 12 }, 'bad_field');
    await bad('a note that is too long', { note: 'x'.repeat(1001) }, 'note_too_long');
    let r = await call(BASE, 'POST', '/api/agent/stories', { token: AGENT_TOKEN, headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    check('rejected: invalid JSON', r.status === 400 && r.data.error === 'invalid_json');
    r = await call(BASE, 'POST', '/api/agent/stories', { token: AGENT_TOKEN, headers: { 'Content-Type': 'application/json' }, body: '[1,2]' });
    check('rejected: a JSON list instead of an object', r.status === 400);
    r = await call(BASE, 'POST', '/api/agent/stories', { token: AGENT_TOKEN, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', body: 'y', pad: 'z'.repeat(41 * 1024 * 1024) }) });
    check('rejected: a request over 40 MB', r.status === 400 && r.data.error === 'too_large', `${r.status} ${r.text.slice(0, 100)}`);
    check('none of the rejected requests created a draft or left a file behind', draftRows().length === rowsBefore && uploadFiles().length === filesBefore, `${draftRows().length} vs ${rowsBefore}, ${uploadFiles().length} vs ${filesBefore}`);
  }

  // ================= missing section, hostile text =================
  {
    const r = await agentPost(story({ title: 'No Section Chosen Yet', sourceUrl: 'https://www.facebook.com/example-page/posts/2001', section: undefined, area: undefined, photos: [] }));
    check('a missing section is allowed (the editor picks it)', r.status === 201 && q('SELECT section, area FROM drafts WHERE id = ?', r.data.id)[0].section === '');
    const page = await adminGet(`/admin/drafts/${r.data.id}`, E1);
    check('...and the editor page opens with "Choose a section"', page.status === 200 && page.text.includes('Choose a section'));
    const inbox = await adminGet('/admin?status=all', E1);
    check('...the inbox lists it', inbox.status === 200 && inbox.text.includes('No Section Chosen Yet'));
  }
  {
    const X = '<script>alert("xss")</script>';
    const hostile = story({
      title: `Title ${X}`, dek: `Dek ${X}`, body: `Body ${X}\n\n<img src=x onerror=alert(1)> and [a link](javascript:alert(1)) done`,
      author: `Author ${X}`, church: `Church ${X}`, note: `Note ${X} <b>bold</b>`,
      sourceUrl: 'https://www.facebook.com/example-page/posts/3001?x="onmouseover="alert(1)',
      photos: [{ data: dataUrl(PNG_A), alt: `Alt ${X}` }],
    });
    const mailBefore2 = emails().length;
    const r = await agentPost(hostile);
    check('hostile text in every field is accepted as plain data (201)', r.status === 201, r.text.slice(0, 200));
    const id = r.data.id;
    const d = q('SELECT * FROM drafts WHERE id = ?', id)[0];
    check('...control characters and HTML in the body are escaped before storing (no "<")', !d.body.includes('<') && d.body.includes('&lt;script>'), d.body.slice(0, 80));
    const page = await adminGet(`/admin/drafts/${id}`, E1);
    const hits = [/<script>alert\("xss"\)/, /<[a-z][^>]*\son(error|mouseover)\s*=/i, /<img src=x/].map((re) => re.exec(page.text)).filter(Boolean).map((m) => page.text.slice(Math.max(0, m.index - 60), m.index + 80));
    check('...the draft page shows no live <script> or event handler from any field', hits.length === 0, JSON.stringify(hits));
    check('...the text is shown escaped instead', page.text.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;') || page.text.includes('&lt;script&gt;'));
    check('...the original-post link is a plain, quoted URL', !/href="[^"]*"onmouseover/.test(page.text));
    const inbox = await adminGet('/admin?source=agent&status=all', E1);
    check('...nor does the inbox', inbox.status === 200 && !/<script>alert\("xss"\)/.test(inbox.text));
    const prev = await adminForm(`/api/admin/drafts/${id}/preview`, E1, { title: d.title, dek: d.dek, author: d.author, church: d.church, body: d.body, section: d.section });
    check('...nor does the preview (and its link to javascript: is neutralised)', prev.status === 200 && prev.data.ok && !/<script/i.test(prev.data.doc.replace(/<style[\s\S]*?<\/style>/, '')) && !/<img src=x/.test(prev.data.doc) && !/href="javascript:/i.test(prev.data.doc), String(prev.data.doc).slice(0, 300));
    await until(() => emails().length > mailBefore2);
    const html = emails().slice(mailBefore2).map((m) => m.html).join('');
    check('...nor does the editor email', !/<script/i.test(html) && html.includes('&lt;script&gt;'));
  }

  // ================= logs, audit, CORS, middleware =================
  {
    const log = logs.a.join('\n');
    check('the server log has the draft id only: no title, text, note, source link or token', /\[agent\] draft #\d+ created/.test(log) && !log.includes('Pathfinder') && !log.includes('knot tying') && !log.includes('Picked because') && !log.includes('facebook.com') && !log.includes(AGENT_TOKEN) && !log.includes(PUBLISH_TOKEN));
    const au = q("SELECT action, target, detail, user_id FROM audit_log WHERE action = 'agent.story' ORDER BY id");
    check('audit entries "agent.story" exist, with the draft as target and no text', au.length >= 4 && au.every((a) => /^draft:\d+$/.test(a.target) && a.user_id === null && !/Pathfinder|facebook|knot/.test(a.detail ?? '')), JSON.stringify(au[0]));
    check('...one per accepted request (draft 1: created + 3 updates) and none for the 409', q("SELECT COUNT(*) c FROM audit_log WHERE action = 'agent.story' AND target = ?", `draft:${id1}`)[0].c === 4);

    // no CORS
    const pre = await fetch(BASE + '/api/agent/stories', { method: 'OPTIONS', headers: { Origin: TOOLS_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    check('the agent route has no CORS: a preflight gets no Access-Control-* headers', ![...pre.headers.keys()].some((k) => k.startsWith('access-control-')) && pre.status !== 204 && pre.status !== 200, `${pre.status}`);
    const withOrigin = await agentPost(story({ title: 'Origin header present', sourceUrl: 'https://www.facebook.com/example-page/posts/4001', photos: [] }), { headers: { Origin: EVIL_ORIGIN } });
    check('...a POST has no Access-Control-* headers either', ![...withOrigin.headers.keys()].some((k) => k.startsWith('access-control-')));
    check('the middleware Origin check does not apply: a POST with a foreign Origin header and the token works (no browser involved)', withOrigin.status === 201);

    // the agent can't reach /api/admin
    const paths = [['GET', '/api/admin/audit'], ['GET', '/api/admin/editors'], ['POST', '/api/admin/drafts/new'], ['POST', `/api/admin/drafts/${id1}/publish`], ['POST', `/api/admin/drafts/${id1}/reject`], ['POST', '/api/admin/stories/unpublish'], ['POST', '/api/admin/stories/edit'], ['GET', `/api/admin/photos/1`], ['GET', '/admin'], ['GET', `/admin/drafts/${id1}`]];
    const results = [];
    for (const token of [AGENT_TOKEN, PUBLISH_TOKEN]) {
      for (const [method, url] of paths) {
        for (const withOrigin of [false, true]) {
          const r = await call(BASE, method, url, { token, headers: withOrigin ? { Origin: BASE } : {}, body: method === 'POST' ? new URLSearchParams({ version: '1' }) : undefined });
          results.push({ method, url, withOrigin, status: r.status, ok: [301, 302, 303, 401, 403].includes(r.status) && !r.text.includes('Example Pathfinder') });
        }
      }
    }
    check('the agent (or Studio) bearer token opens nothing under /admin or /api/admin (401/403/redirect to sign-in)', results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
    check('...no draft was published or rejected by those calls', q("SELECT COUNT(*) c FROM drafts WHERE status IN ('published') AND source = 'agent'")[0].c === 0);
    check('...and the agent route cannot publish, reject or edit published stories at all (no such field is read)', q("SELECT COUNT(*) c FROM drafts WHERE source = 'agent' AND (published_commit IS NOT NULL OR slug IS NOT NULL)")[0].c === 0);
    check('no GitHub call was made by any agent request', !logs.gh.some((l) => /^(POST|PUT|PATCH) /.test(l)));
  }

  // ================= rate limit =================
  {
    const D = `http://localhost:${P.d}`;
    let last;
    let allOk = true;
    for (let i = 0; i < 60; i++) {
      last = await call(D, 'GET', '/api/agent/sections', { token: AGENT_TOKEN });
      if (last.status !== 200) allOk = false;
    }
    check('60 requests in an hour are fine', allOk);
    last = await call(D, 'GET', '/api/agent/sections', { token: AGENT_TOKEN });
    check('the 61st gets 429 with Retry-After', last.status === 429 && last.headers.get('retry-after') !== null && last.data.ok === false);
    last = await call(D, 'POST', '/api/agent/stories', { token: AGENT_TOKEN, json: story() });
    check('...for the story endpoint too (one limit per token)', last.status === 429);
    last = await call(D, 'GET', '/api/agent/sections', { token: 'x'.repeat(AGENT_TOKEN.length) });
    check('...but a wrong token still gets 401 first', last.status === 401);
  }

  // ================= source filter in the inbox =================
  {
    run("INSERT INTO drafts (status, source, title, section, created_at, updated_at, submitter_name, submitter_email) VALUES ('new', 'form', 'Plain Form Story', 'news', ?, ?, ?, ?)", Date.now(), Date.now(), SUBMITTER.name, SUBMITTER.email);
    const all = await adminGet('/admin?status=all', E1);
    const only = await adminGet('/admin?status=all&source=agent', E1);
    check('the inbox "Source: AI agent" filter shows only agent drafts', all.text.includes('Plain Form Story') && !only.text.includes('Plain Form Story') && only.text.includes('Second Story For Photo Touch'));
    check('...and the Source select keeps its choice', /<option value="agent"[^>]*selected/.test(only.text));
  }

  // ================= GET /api/stories (Studio) =================
  {
    const S = (u, o = {}) => call(BASE, 'GET', u, o);
    let r = await call(BASE, 'OPTIONS', '/api/stories', { headers: { Origin: TOOLS_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    check('preflight from an allowed origin: 204 with Allow-Origin and Authorization allowed', r.status === 204 && r.headers.get('access-control-allow-origin') === TOOLS_ORIGIN && /authorization/i.test(r.headers.get('access-control-allow-headers') || '') && /GET/.test(r.headers.get('access-control-allow-methods') || ''));
    r = await call(BASE, 'OPTIONS', '/api/stories', { headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    check('preflight from a foreign origin: no CORS headers', ![...r.headers.keys()].some((k) => k.startsWith('access-control-')), [...r.headers.keys()].join());
    r = await S('/api/stories', { headers: { Origin: EVIL_ORIGIN }, token: PUBLISH_TOKEN });
    check('a GET with the right token from a foreign origin carries no Allow-Origin (the browser would block it)', r.status === 200 && r.headers.get('access-control-allow-origin') === null);

    r = await S('/api/stories', { headers: { Origin: TOOLS_ORIGIN } });
    check('no token: 401', r.status === 401 && r.data.ok === false && r.headers.get('access-control-allow-origin') === TOOLS_ORIGIN);
    r = await S('/api/stories', { token: 'x'.repeat(PUBLISH_TOKEN.length) });
    check('wrong token: 401', r.status === 401);
    r = await S('/api/stories', { token: AGENT_TOKEN });
    check('the agent token is not accepted here: 401', r.status === 401);
    r = await call(`http://localhost:${P.b}`, 'GET', '/api/stories', { token: PUBLISH_TOKEN });
    check('PUBLISH_TOKEN unset: 503', r.status === 503);
    r = await call(BASE, 'POST', '/api/stories', { token: PUBLISH_TOKEN, json: {} });
    check('POST is not allowed: 405', r.status === 405);

    // Make some data: studio publish through the mock GitHub, a stack of drafts
    const pub = await call(BASE, 'POST', '/api/publish', { token: PUBLISH_TOKEN, json: { newsletter: { name: 'E2E Issue', issueDate: '2026-10-19' }, stories: [{ ref: 'a', title: 'Studio Story Live Before The Next Build', section: 'news', area: 'churches', author: 'Studio Author', dek: 'Published seconds ago.', body: 'A made-up story body for the list.', photos: [{ url: dataUrl(PNG_A), alt: 'Studio alt' }, { url: 'https://stories.imadventist.org/images/x/photo.jpg', alt: 'Second' }] }] } });
    check('(Studio publishes a story through the mock GitHub API)', pub.status === 200 && pub.data.ok, pub.text.slice(0, 200));
    const slug = '2026-10-19-studio-story-live-before-the-next-build';
    const now = Date.now();
    for (let i = 0; i < 22; i++) {
      run("INSERT INTO drafts (status, source, title, section, author, church, date, created_at, updated_at, submitter_name, submitter_email, submitter_phone, submitter_church) VALUES ('new', 'form', ?, 'kids', 'Sample Author', 'Sample Church', '2026-10-10', ?, ?, ?, ?, ?, ?)", `Bulk draft ${String(i).padStart(2, '0')}`, now + 1000 + i, now + 1000 + i, SUBMITTER.name, SUBMITTER.email, SUBMITTER.phone, SUBMITTER.church);
    }
    const urlDraft = Number(run("INSERT INTO drafts (status, source, title, section, author, date, created_at, updated_at) VALUES ('in_review', 'editor', 'Editor Draft With Site Photo', 'features', 'Editor Writer', '2026-10-11', ?, ?)", now + 5000, now + 5000).lastInsertRowid);
    run("INSERT INTO draft_photos (draft_id, url, alt, position, created_at) VALUES (?, '/images/stories/some-story/photo-1.jpg', 'Site photo', 0, ?)", urlDraft, now);
    run("INSERT INTO drafts (status, source, title, section, created_at, updated_at) VALUES ('rejected', 'form', 'Rejected Never Listed', 'news', ?, ?)", now + 9000, now + 9000);
    run("INSERT INTO drafts (status, source, title, section, created_at, updated_at) VALUES ('published', 'form', 'Published Draft Not In Drafts List', 'news', ?, ?)", now + 9001, now + 9001);

    r = await S('/api/stories?limit=50', { token: PUBLISH_TOKEN, headers: { Origin: TOOLS_ORIGIN } });
    const d = r.data;
    check('the right token from an allowed origin: 200 {ok, version 1, stories, drafts}', r.status === 200 && d.ok === true && d.version === 1 && Array.isArray(d.stories) && Array.isArray(d.drafts) && r.headers.get('access-control-allow-origin') === TOOLS_ORIGIN && r.headers.get('cache-control') === 'no-store', r.text.slice(0, 200));

    // stories
    const built = d.stories.filter((s) => s.source === 'site');
    check('stories: the built stories are there (newest first)', built.length >= 6 && d.stories.every((s, i, a) => i === 0 || a[i - 1].date >= s.date), `${built.length}`);
    const feed = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/client/stories.json'), 'utf8')).stories;
    const strip = (o) => { const { status, source, url, image, photos, ...rest } = o; return rest; };
    const sameAsFeed = feed.every((f) => { const s = built.find((b) => b.id === f.id); return s && JSON.stringify(strip(s)) === JSON.stringify(strip(f)); });
    check('stories: each item has exactly the /stories.json fields and values (feedItem), plus status and source', sameAsFeed && built.every((s) => s.status === 'published'), JSON.stringify(built[0]).slice(0, 300));
    const feedKeys = new Set(feed.flatMap((f) => Object.keys(f)));
    check('...no field of the public item is missing or renamed', [...feedKeys].every((k) => built.some((s) => k in s)), [...feedKeys].join());
    const live = d.stories.find((s) => s.id === slug);
    check('stories: a story published since the last build is in the list (from the dashboard record)', !!live && live.status === 'published' && live.source === 'studio' && live.title === 'Studio Story Live Before The Next Build' && live.url === `${BASE}/stories/${slug}/`, JSON.stringify(live));
    check('...with absolute links and its photos', live && live.image === `${BASE}/images/stories/${slug}/photo-1.png` && live.imageAlt === 'Studio alt' && live.photos[0] === 'https://stories.imadventist.org/images/x/photo.jpg' && live.photoAlts[0] === 'Second' && live.sectionLabel === 'News' && live.areaLabel === 'Churches' && live.date === '2026-10-19');
    check('...Studio\'s reads: title, dek, section, sectionLabel, areaLabel, date, url, image, imageAlt, photoCredit/photos, status and source are present', live && ['title', 'dek', 'section', 'sectionLabel', 'areaLabel', 'date', 'url', 'image', 'imageAlt', 'photos', 'photoAlts', 'status', 'source'].every((k) => k in live));
    check('...and every url is on the site\'s own origin', d.stories.every((s) => s.url.startsWith(BASE + '/')));

    // unpublish hides it
    run('UPDATE drafts SET unpublished_at = ? WHERE slug = ?', Date.now(), slug);
    r = await S('/api/stories', { token: PUBLISH_TOKEN });
    check('stories: an unpublished story disappears from the list', !r.data.stories.some((s) => s.id === slug));
    run('UPDATE drafts SET unpublished_at = NULL WHERE slug = ?', slug);
    // a live story being edited again keeps its live text
    run("UPDATE drafts SET status = 'in_review', title = 'UNPUBLISHED EDIT' WHERE slug = ?", slug);
    r = await S('/api/stories', { token: PUBLISH_TOKEN });
    check('stories: edits waiting in review on a live story are not shown as live text', !r.text.includes('UNPUBLISHED EDIT'));
    run("UPDATE drafts SET status = 'published', title = 'Studio Story Live Before The Next Build' WHERE slug = ?", slug);

    // drafts
    check('drafts: the 20 newest new/in_review drafts, newest first', d.drafts.length === 20 && d.drafts[0].title === 'Editor Draft With Site Photo' && d.drafts[1].title === 'Bulk draft 21', d.drafts.map((x) => x.title).slice(0, 3).join('|'));
    check('...never rejected or published ones', !r.text.includes('Rejected Never Listed') && !r.text.includes('Published Draft Not In Drafts List') && d.drafts.every((x) => ['new', 'in_review'].includes(x.status)));
    check('...each has id, status and source, and no url (they are not live)', d.drafts.every((x) => Number.isInteger(x.id) && x.status && x.source && !('url' in x)));
    const ed = d.drafts[0];
    check('...a draft that points at a site photo gets an absolute image URL', ed.image === `${BASE}/images/stories/some-story/photo-1.jpg` && ed.imageAlt === 'Site photo' && ed.sectionLabel === 'Features' && ed.source === 'editor' && ed.status === 'in_review');
    const agentDraft = (await S('/api/stories', { token: PUBLISH_TOKEN, headers: {} })).data;
    const a1 = agentDraft.drafts.find((x) => x.id === id1);
    // id1 is in review (the editor saved it); the newest 20 are bulk ones, so look it up with a section filter
    const youth = await S('/api/stories?section=youth', { token: PUBLISH_TOKEN });
    const ag = youth.data.drafts.find((x) => x.id === id1);
    check('...agent drafts are listed with source "agent" and NO image (uploaded photos are only served to signed-in editors)', !a1 && !!ag && ag.source === 'agent' && !('image' in ag) && ag.photos.length === 0 && ag.title === 'Edited by a person', JSON.stringify(ag));
    check('...the section filter applies to stories and drafts', youth.status === 200 && youth.data.stories.every((s) => s.section === 'youth') && youth.data.drafts.every((x) => x.section === 'youth') && youth.data.drafts.length >= 2);
    r = await S('/api/stories?section=nope', { token: PUBLISH_TOKEN });
    check('...an unknown section: 400', r.status === 400);
    r = await S('/api/stories?limit=1', { token: PUBLISH_TOKEN });
    check('...limit=1 returns one story', r.data.stories.length === 1);
    r = await S('/api/stories?limit=abc', { token: PUBLISH_TOKEN });
    check('...a junk limit falls back to the default', r.status === 200 && r.data.stories.length >= 6);

    // a draft with a stored date that is not a real day must not take the other drafts down with it
    run("INSERT INTO drafts (status, source, title, section, author, date, created_at, updated_at) VALUES ('new', 'form', 'Bad Date Draft', 'columns', 'Sample Author', '2026-13-40', ?, ?)", now + 9500, now + 9500);
    r = await S('/api/stories', { token: PUBLISH_TOKEN });
    const bd = (r.data.drafts || []).find((x) => x.title === 'Bad Date Draft');
    check('a stored bad-date draft still lists, with its created date, next to the others', r.status === 200 && r.data.drafts.length === 20 && !!bd && bd.date === new Date(now + 9500).toISOString().slice(0, 10) && r.data.drafts.some((x) => x.title === 'Bulk draft 21'), r.text.slice(0, 200));
    const cal = await adminForm(`/api/admin/drafts/${urlDraft}/save`, E1, { version: String(q('SELECT updated_at FROM drafts WHERE id = ?', urlDraft)[0].updated_at), title: 'Cal', section: 'features', date: '2026-02-31', body: 'x' });
    check('saving a draft with a date that is not a real day (2026-02-31) is refused', cal.status === 400 && cal.data.ok === false, `${cal.status} ${cal.text.slice(0, 100)}`);

    // privacy
    const whole = (await S('/api/stories?limit=100', { token: PUBLISH_TOKEN })).text;
    check('no submitter email, phone, name or church in the response', ![SUBMITTER.email, 'riley.sample', SUBMITTER.phone, SUBMITTER.name, SUBMITTER.church].some((v) => whole.includes(v)), '');
    check('no agent note or source link in the response', !whole.includes('Picked because') && !whole.includes('facebook.com') && !whole.includes('Updated note'));
    check('the request did not write anything to the log but counts', !logs.a.join('\n').includes(PUBLISH_TOKEN));
  }

  console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} check(s) FAILED.`);
} catch (err) {
  console.error('Test script crashed:', err);
  fails++;
} finally {
  await cleanup();
}
process.exit(fails === 0 ? 0 : 1);
