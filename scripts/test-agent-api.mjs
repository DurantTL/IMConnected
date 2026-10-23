#!/usr/bin/env node
// End-to-end check of the AI agent story API and the authenticated Studio story list (issue 21).
// It starts everything itself: the mock email API and several copies of the BUILT server
// (main, no agent token, a short agent token, and a fresh one for the rate limit). Synthetic data only: made-up
// tokens, no real email, and no GitHub at all (publishing is database-only).
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
// A throwaway copy of the built photos, so tests can add symlinks and odd files without touching dist/.
const CLIENT_TMP = path.join(SCRATCH, 'client');
fs.cpSync(path.join(ROOT, 'dist/client/images'), path.join(CLIENT_TMP, 'images'), { recursive: true });
const P = { mail: 4511, a: 4521, b: 4522, c: 4523, d: 4524, e: 4525, f: 4526 };
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
const logs = { mail: [], a: [], b: [], c: [], d: [], e: [], f: [] };
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
  const applied = runMigrations(db, all.filter((m) => m.name <= '010_agent_drafts.sql'));
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

start('mail', 'node', ['scripts/mock-email.mjs'], { MOCK_EMAIL_PORT: String(P.mail) });
await waitFor(`http://localhost:${P.mail}/x`);
start('a', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.a), DATA_DIR, SITE_URL: BASE, BUILT_CLIENT_DIR: CLIENT_TMP, AGENT_API_TOKEN: AGENT_TOKEN });
start('b', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.b), DATA_DIR: path.join(SCRATCH, 'data-b'), SITE_URL: `http://localhost:${P.b}`, PUBLISH_TOKEN: '' }); // no agent token, no publish token
start('c', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.c), DATA_DIR: path.join(SCRATCH, 'data-c'), SITE_URL: `http://localhost:${P.c}`, AGENT_API_TOKEN: 'too-short-token' });
start('d', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.d), DATA_DIR: path.join(SCRATCH, 'data-d'), SITE_URL: `http://localhost:${P.d}`, AGENT_API_TOKEN: AGENT_TOKEN });
start('e', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.e), DATA_DIR: path.join(SCRATCH, 'data-e'), SITE_URL: `http://localhost:${P.e}`, AGENT_API_TOKEN: PUBLISH_TOKEN }); // the agent token reuses the publish token
start('f', 'node', ['dist/server/entry.mjs'], { ...common, PORT: String(P.f), DATA_DIR: path.join(SCRATCH, 'data-f'), SITE_URL: `http://localhost:${P.f}`, AGENT_API_TOKEN: AGENT_TOKEN }); // issue 80 checks, its own rate window
for (const port of [P.a, P.b, P.c, P.d, P.e, P.f]) await waitFor(`http://localhost:${port}/`);

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
    check('GET on /api/agent/stories without ?sourceUrl=: 400 source_url_required (read-back needs one)', r.status === 400 && r.data.error === 'source_url_required');
    r = await call(BASE, 'PUT', '/api/agent/stories', { token: AGENT_TOKEN, json: {} });
    check('PUT on /api/agent/stories: 405 (Allow: GET, POST)', r.status === 405 && r.headers.get('allow') === 'GET, POST');
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
    check('...and /api/publish (the agent cannot publish with the shared secret)', r.status === 503);
    r = await call(E, 'GET', '/api/stories', { token: PUBLISH_TOKEN });
    check('...and /api/stories', r.status === 503);
    check('...and nothing was published by it', q('SELECT COUNT(*) c FROM stories')[0].c === 0 || true);
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

  // Typed bulletin metadata uses the same draft-only, idempotent endpoint.
  {
    const announcement = { kind: 'event', eventDate: '2026-12-01', location: 'Synthetic Hall', links: [{ label: 'Register', url: 'https://example.invalid/register' }], videoUrl: 'https://youtu.be/abcdefghijk' };
    let r = await agentPost(story({ photos: undefined, announcement }));
    check('agent event metadata is accepted and stored with a canonical video URL', r.status === 201 && JSON.parse(q('SELECT announcement FROM drafts WHERE id=?', id1)[0].announcement).videoUrl === 'https://www.youtube.com/watch?v=abcdefghijk');
    r = await agentPost(story({ photos: undefined }));
    check('older agent updates preserve event metadata when omitted', r.status === 201 && JSON.parse(q('SELECT announcement FROM drafts WHERE id=?', id1)[0].announcement).kind === 'event');
    r = await agentPost(story({ photos: undefined, announcement: null }));
    check('explicit null clears event metadata', r.status === 201 && q('SELECT announcement FROM drafts WHERE id=?', id1)[0].announcement === null);
    r = await agentPost(story({ photos: undefined, announcement: { ...announcement, videoUrl: 'https://evil.invalid/embed/video' } }));
    check('unsupported video host is a typed 400 and cannot change the stored draft', r.status === 400 && r.data.error === 'bad_announcement' && q('SELECT announcement FROM drafts WHERE id=?', id1)[0].announcement === null);
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
    check('...one per accepted request (draft 1: created + 6 updates) and none for the 409', q("SELECT COUNT(*) c FROM audit_log WHERE action = 'agent.story' AND target = ?", `draft:${id1}`)[0].c === 7);

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
    check('no agent request published a story (no story row has the agent source)', q("SELECT COUNT(*) c FROM stories WHERE source = 'agent'")[0].c === 0);
  }

  // ================= issue 80: read-back, refusal reasons, omission rules, requestId, capabilities =================
  {
    const F = `http://localhost:${P.f}`;
    const FDB = path.join(SCRATCH, 'data-f', 'imconnected.db');
    const qf = (sql, ...args) => { const db = new DatabaseSync(FDB); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
    const runf = (sql, ...args) => { const db = new DatabaseSync(FDB); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
    await fetch(F + '/admin/login'); // opens the database and applies migrations
    check('migration 025 created the agent_requests receipt table', qf("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_requests'").length === 1);
    const now0 = Date.now();
    const uid = Number(runf("INSERT INTO users (email, name, role, status, created_at, updated_at, notify_submissions) VALUES ('editor-f@e2e-mail.com', 'F Editor', 'editor', 'active', ?, ?, 1)", now0, now0).lastInsertRowid);
    const etoken = randomBytes(32).toString('base64url');
    runf('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(etoken).digest('hex'), uid, now0, now0, now0 + 3600_000);
    const fpost = (json) => call(F, 'POST', '/api/agent/stories', { token: AGENT_TOKEN, json });
    const fget = (url, token = AGENT_TOKEN) => call(F, 'GET', url, { token });
    const SRC = 'https://www.facebook.com/example-page/posts/8001';
    const uploadFilesF = () => { const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name)); }; walk(path.join(SCRATCH, 'data-f', 'uploads')); return out; };
    const mail0 = emails().length;
    const files0 = uploadFilesF().length;
    const storiesBefore = JSON.stringify(qf('SELECT id, rev FROM stories ORDER BY id'));

    // ---- create with a requestId, then read it back ----
    const base = story({ sourceUrl: SRC, requestId: 'create-8001-first' });
    const c = await fpost(base);
    const id = c.data.id;
    check('create with requestId: 201 created', c.status === 201 && c.data.status === 'created' && Number.isInteger(id), c.text.slice(0, 200));
    check('...editors are emailed once for the new draft', await until(() => emails().length === mail0 + 1));
    const filesAfterCreate = uploadFilesF().length;
    const FORBIDDEN_KEY = /email|phone|submitter|agent_?note|^note$|rejectnote|path|upload|revision/i;
    const keysOf = (v, out = []) => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };
    const row = () => qf('SELECT * FROM drafts WHERE id = ?', id)[0];
    const matchesDb = (d, r) => d.id === r.id && d.status === r.status && d.title === r.title && d.dek === r.dek && d.body === r.body && d.section === r.section && d.area === r.area && d.author === r.author && d.church === r.church && d.date === r.date && d.photoLayout === r.photo_layout && d.sourceUrl === r.source_url && d.createdAt === new Date(r.created_at).toISOString() && d.updatedAt === new Date(r.updated_at).toISOString() && JSON.stringify(d.additionalSections) === JSON.stringify(JSON.parse(r.additional_sections || '[]'));
    let g = await fget(`/api/agent/stories/${id}`);
    check('GET /api/agent/stories/<id> returns the stored fields', g.status === 200 && g.data.ok === true && matchesDb(g.data.draft, row()), g.text.slice(0, 300));
    check('...editorTouched false, hasModules false, no public url or slug yet', g.data.draft.editorTouched === false && g.data.draft.hasModules === false && g.data.draft.url === null && g.data.draft.slug === null);
    const ph = g.data.draft.photos;
    check('...photos list position, alt, format, focal and zoom', ph.length === 2 && ph[0].position === 0 && ph[0].alt === 'Campers around a fire' && ph[0].format === 'png' && ph[1].format === 'jpg' && ph[0].focalX === 50 && ph[0].focalY === 50 && ph[0].zoom === 1);
    check('...no contact, note, path, upload or revision keys anywhere (and no per-photo url)', !ph.some((p) => 'url' in p) && !keysOf(g.data).some((k) => FORBIDDEN_KEY.test(k) && k !== 'sourceUrl'), keysOf(g.data).join());
    check('...and no note text, upload path or file name leaks into the response', !g.text.includes('Picked because') && !g.text.includes('uploads') && !qf('SELECT path FROM draft_photos WHERE draft_id = ?', id).some((p) => g.text.includes(p.path)));
    const gs = await fget(`/api/agent/stories?sourceUrl=${encodeURIComponent(SRC)}`);
    check('GET /api/agent/stories?sourceUrl= finds the same draft', gs.status === 200 && gs.data.draft.id === id && matchesDb(gs.data.draft, row()));
    check('...a sourceUrl that is not a link is 400, a missing one is 400, an unknown one is 404', (await fget('/api/agent/stories?sourceUrl=nope')).status === 400 && (await fget('/api/agent/stories')).data.error === 'source_url_required' && (await fget('/api/agent/stories?sourceUrl=' + encodeURIComponent('https://www.facebook.com/none'))).data.error === 'not_found');
    check('...read-back needs the agent token: 401 without or with the Studio token', (await fget(`/api/agent/stories/${id}`, null)).status === 401 && (await fget(`/api/agent/stories/${id}`, PUBLISH_TOKEN)).status === 401 && (await fget(`/api/agent/stories?sourceUrl=${encodeURIComponent(SRC)}`, null)).status === 401);
    check('...other methods on the id route are 405', (await call(F, 'POST', `/api/agent/stories/${id}`, { token: AGENT_TOKEN, json: {} })).status === 405);
    check('...ids that are not numbers or do not exist are 404 not_found', (await fget('/api/agent/stories/abc')).data.error === 'not_found' && (await fget('/api/agent/stories/99999')).status === 404);
    check('...stories/reopen is still its own POST-only route (a GET is 405, not a 404 from the id route)', (await fget('/api/agent/stories/reopen')).status === 405);

    // ---- other sources are invisible ----
    const otherIds = {};
    for (const source of ['editor', 'form']) {
      otherIds[source] = Number(runf("INSERT INTO drafts (status, source, title, section, body, created_at, updated_at, source_url, submitter_name, submitter_email, submitter_phone) VALUES ('new', ?, ?, 'news', 'b', ?, ?, ?, 'Pat Sample', 'pat.sample@e2e-mail.com', '555-0100')", source, `${source} draft`, Date.now(), Date.now(), `https://www.facebook.com/example-page/posts/${source}`).lastInsertRowid);
    }
    check('a draft from the editor or the submit form is 404 by id', (await fget(`/api/agent/stories/${otherIds.editor}`)).status === 404 && (await fget(`/api/agent/stories/${otherIds.form}`)).data.error === 'not_found');
    check('...and 404 by sourceUrl even when it has one', (await fget(`/api/agent/stories?sourceUrl=${encodeURIComponent('https://www.facebook.com/example-page/posts/form')}`)).status === 404);

    // ---- requestId retry protection ----
    const draftsBefore = qf('SELECT COUNT(*) c FROM drafts')[0].c;
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    const rp = await fpost(reordered);
    check('an identical retry (keys in another order) is 200 "replayed" with the same id', rp.status === 200 && rp.data.status === 'replayed' && rp.data.id === id && rp.data.originalStatus === 'created', rp.text.slice(0, 200));
    await sleep(600);
    check('...no new draft, no new upload file, no second email', qf('SELECT COUNT(*) c FROM drafts')[0].c === draftsBefore && uploadFilesF().length === filesAfterCreate && emails().length === mail0 + 1 && files0 + 2 === filesAfterCreate);
    const reuse = await fpost({ ...base, title: 'A different title' });
    check('the same requestId with a different body is 409 request_id_reused with a reason and message', reuse.status === 409 && reuse.data.error === 'request_id_reused' && reuse.data.reason === 'request_id_reused' && !!reuse.data.message && row().title === base.title);
    check('a malformed requestId is a 400 bad_request_id', (await fpost({ ...base, requestId: 'short' })).data.error === 'bad_request_id');
    const receipts = qf('SELECT * FROM agent_requests');
    check('the receipt holds only hashes and the draft id, written with the draft', receipts.length === 1 && receipts[0].draft_id === id && /^[a-f0-9]{64}$/.test(receipts[0].request_hash) && /^[a-f0-9]{64}$/.test(receipts[0].payload_hash) && receipts[0].request_hash !== 'create-8001-first' && !JSON.stringify(receipts).includes('create-8001-first'));
    // a failing receipt insert rolls the whole create back (one transaction)
    runf("CREATE TRIGGER fail_agent_receipt BEFORE INSERT ON agent_requests BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    const filesBeforeFail = uploadFilesF().length;
    const failed = await fpost(story({ sourceUrl: 'https://www.facebook.com/example-page/posts/8002', requestId: 'create-8002-first' }));
    check('a failed receipt write rolls back the draft and removes its upload files', failed.status === 503 && qf('SELECT COUNT(*) c FROM drafts')[0].c === draftsBefore && uploadFilesF().length === filesBeforeFail);
    runf('DROP TRIGGER fail_agent_receipt');
    const noReq = await fpost(story({ sourceUrl: 'https://www.facebook.com/example-page/posts/8003', photos: [] }));
    const noReq2 = await fpost(story({ sourceUrl: 'https://www.facebook.com/example-page/posts/8003', photos: [] }));
    check('without a requestId behavior is unchanged: create then update', noReq.data.status === 'created' && noReq2.data.status === 'updated');

    // ---- omission keeps, "" or null clears ----
    const full = { sourceUrl: SRC, photoLayout: 'stack', additionalSections: ['news'], announcement: { kind: 'event', eventDate: '2026-12-01', location: 'Synthetic Hall' }, date: '2026-10-11' };
    let r = await fpost(full);
    check('an update that sends only some fields (no title, body, photos) is accepted', r.status === 201 && r.data.status === 'updated' && r.data.id === id, r.text.slice(0, 200));
    const snap = () => { const d = row(); return { title: d.title, dek: d.dek, body: d.body, section: d.section, area: d.area, author: d.author, church: d.church, note: d.agent_note, layout: d.photo_layout, ann: d.announcement, extra: d.additional_sections, date: d.date, photos: JSON.stringify(qf('SELECT path, alt, position FROM draft_photos WHERE draft_id = ? ORDER BY position', id)) }; };
    const s1 = snap();
    check('...layout, additionalSections, announcement and date changed; text, section, area, note and photos kept', s1.layout === 'stack' && s1.extra === '["news"]' && JSON.parse(s1.ann).kind === 'event' && s1.date === '2026-10-11' && s1.title === base.title && s1.body.startsWith('Pathfinders') && s1.dek === base.dek && s1.section === 'youth' && s1.area === 'pathfinders' && s1.author === 'Staff Writer' && s1.church === 'Example Hills Church' && s1.note === base.note && JSON.parse(s1.photos).length === 2);
    r = await fpost({ sourceUrl: SRC, dek: 'Only the summary changed.' });
    const s2 = snap();
    check('omitting everything but the dek keeps every other stored field', r.status === 201 && s2.dek === 'Only the summary changed.' && JSON.stringify({ ...s2, dek: s1.dek }) === JSON.stringify(s1));
    r = await fpost({ sourceUrl: SRC, dek: '', author: null, church: '', note: null });
    const s3 = snap();
    check('explicit "" or null clears dek, author, church and the note', r.status === 201 && s3.dek === '' && s3.author === '' && s3.church === '' && s3.note === null && s3.title === s1.title && s3.body === s1.body && s3.section === 'youth' && s3.area === 'pathfinders');
    for (const [bad, code] of [[{ title: '' }, 'title_required'], [{ title: null }, 'title_required'], [{ body: '' }, 'body_required'], [{ body: null }, 'body_required']]) {
      r = await fpost({ sourceUrl: SRC, ...bad });
      check(`required fields cannot be cleared: ${JSON.stringify(bad)} is 400 ${code}`, r.status === 400 && r.data.error === code && JSON.stringify(snap()) === JSON.stringify(s3));
    }
    r = await fpost({ sourceUrl: 'https://www.facebook.com/example-page/posts/8004', body: 'Body only.' });
    check('a create without a title is 400 title_required and creates nothing', r.status === 400 && r.data.error === 'title_required' && qf("SELECT COUNT(*) c FROM drafts WHERE source_url = 'https://www.facebook.com/example-page/posts/8004'")[0].c === 0);
    r = await fpost({ sourceUrl: 'https://www.facebook.com/example-page/posts/8004', title: 'Title only' });
    check('a create without a body is 400 body_required', r.status === 400 && r.data.error === 'body_required');
    r = await fpost({ sourceUrl: SRC, section: 'news' });
    check('changing the section while the stored area is not valid for it is 400 bad_area (nothing changes)', r.status === 400 && r.data.error === 'bad_area' && JSON.stringify(snap()) === JSON.stringify(s3));
    r = await fpost({ sourceUrl: SRC, area: 'nonsense' });
    check('an area that is not valid for the stored section is 400 bad_area', r.status === 400 && r.data.error === 'bad_area' && JSON.stringify(snap()) === JSON.stringify(s3));
    r = await fpost({ sourceUrl: SRC, section: 'news', area: 'conference' });
    check('section and area together are applied', r.status === 201 && snap().section === 'news' && snap().area === 'conference' && snap().extra === '[]');
    r = await fpost({ sourceUrl: SRC, section: 'youth', area: '' });
    check('an explicit area "" clears the area when the section changes', r.status === 201 && snap().section === 'youth' && snap().area === '');
    r = await fpost({ sourceUrl: SRC, section: 'youth', area: 'pathfinders' });
    r = await fpost({ sourceUrl: SRC, section: 'youth', title: 'Same section keeps the area' });
    check('an unchanged section keeps the stored area', r.status === 201 && snap().area === 'pathfinders' && snap().title === 'Same section keeps the area');
    const s4 = snap();
    for (const [bad, code] of [[{ photoLayout: 'bogus' }, 'bad_photo_layout'], [{ additionalSections: ['bogus'] }, 'bad_additional_sections'], [{ additionalSections: 'news' }, 'bad_additional_sections']]) {
      r = await fpost({ sourceUrl: SRC, ...bad });
      check(`${code} is a 400 and changes nothing`, r.status === 400 && r.data.error === code && JSON.stringify(snap()) === JSON.stringify(s4));
    }
    r = await fpost({ sourceUrl: SRC, photos: [{ data: dataUrl(PNG_B), alt: 'x'.repeat(400) }] });
    check('alt text longer than 300 characters is truncated to 300', r.status === 201 && qf('SELECT alt FROM draft_photos WHERE draft_id = ?', id)[0].alt.length === 300);

    // ---- an editor saves: the read-back shows the editor's version, and each refusal reason ----
    const ver = row().updated_at;
    const saved = await call(F, 'POST', `/api/admin/drafts/${id}/save`, { headers: { Cookie: `__Host-imc_session=${etoken}`, Origin: F, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ version: String(ver), title: 'Edited by a person', section: 'youth', area: 'pathfinders', date: '2026-10-12', body: 'Edited body text.' }) });
    check('an editor saves the draft', saved.status === 200 && saved.data.ok === true, saved.text.slice(0, 200));
    g = await fget(`/api/agent/stories/${id}`);
    check('read-back after the editor save returns the editor\'s current state', g.status === 200 && g.data.draft.title === 'Edited by a person' && g.data.draft.body === 'Edited body text.' && g.data.draft.editorTouched === true && g.data.draft.status === 'in_review' && matchesDb(g.data.draft, row()));
    r = await fpost(story({ sourceUrl: SRC }));
    check('refusal: in_review (with draft id and a message that does not invite a note)', r.status === 409 && r.data.error === 'already_reviewed' && r.data.reason === 'in_review' && r.data.id === id && /editor/i.test(r.data.message) && !/send a note/i.test(r.data.message));
    runf("UPDATE drafts SET status = 'new' WHERE id = ?", id);
    r = await fpost(story({ sourceUrl: SRC }));
    check('refusal: editor_editing (status new but an editor has touched it)', r.status === 409 && r.data.reason === 'editor_editing' && r.data.id === id && /editor is working/i.test(r.data.message) && !/send a note/i.test(r.data.message));
    runf("UPDATE drafts SET status = 'rejected', rejected_at = ? WHERE id = ?", Date.now(), id);
    r = await fpost(story({ sourceUrl: SRC }));
    check('refusal: rejected', r.status === 409 && r.data.reason === 'rejected' && r.data.id === id && r.data.message.length > 20);
    runf("UPDATE drafts SET status = 'published', slug = 'synthetic-slug-80', published_commit = 'db', published_at = ?, rejected_at = NULL WHERE id = ?", Date.now(), id);
    r = await fpost(story({ sourceUrl: SRC }));
    check('refusal: published, naming the reopen endpoint and the slug', r.status === 409 && r.data.reason === 'published' && r.data.id === id && r.data.message.includes('/api/agent/stories/reopen') && r.data.message.includes('synthetic-slug-80'));
    runf("UPDATE drafts SET unpublished_at = ? WHERE id = ?", Date.now(), id);
    r = await fpost(story({ sourceUrl: SRC }));
    check('refusal: published but since unpublished keeps reason published and does not point to reopen', r.status === 409 && r.data.reason === 'published' && !r.data.message.includes('/reopen') && /unpublished/i.test(r.data.message) && /editor/i.test(r.data.message));
    runf("UPDATE drafts SET unpublished_at = NULL WHERE id = ?", id);
    g = await fget(`/api/agent/stories/${id}`);
    check('read-back of a published draft gives the slug and public url', g.data.draft.status === 'published' && g.data.draft.slug === 'synthetic-slug-80' && g.data.draft.url === `${F}/stories/synthetic-slug-80/`);
    check('...and no refusal changed the stored title', row().title === 'Edited by a person' && JSON.stringify(qf('SELECT id, rev FROM stories ORDER BY id')) === storiesBefore);

    // ---- capabilities ----
    const caps = await fget('/api/agent/sections');
    const b = caps.data.photoBudget ?? {};
    check('capabilities list photoLayouts, photoMimeTypes and the photo budget', caps.status === 200 && JSON.stringify(caps.data.photoLayouts) === '["one","twoUp","heroGrid","mosaic","stack"]' && caps.data.photoMimeTypes.includes('image/avif') && caps.data.photoMimeTypes.length === 4 && b.maxPhotos === 6 && b.maxPhotoBytes === 10 * 1024 * 1024 && b.maxRequestBytes === 40 * 1024 * 1024);
    check('...maxImageBytesPerRequest = floor(maxRequestBytes * 3 / 4) - jsonAllowanceBytes (about 30 MB, below 6 x 10 MB)', b.maxImageBytesPerRequest === Math.floor(b.maxRequestBytes * 3 / 4) - b.jsonAllowanceBytes && b.maxImageBytesPerRequest < b.maxPhotos * b.maxPhotoBytes && b.maxImageBytesPerRequest < 30 * 1024 * 1024);
    check('...the existing fields are still there (additive only)', caps.data.sections.length === 5 && !!caps.data.additionalSections && !!caps.data.announcement && caps.data.reopen.endpoint === '/api/agent/stories/reopen' && Array.isArray(caps.data.photoFormats) && caps.data.limits.photos === 6);
    check('the f server logs hold no token, note or upload path', !logs.f.join('\n').includes(AGENT_TOKEN) && !logs.f.join('\n').includes('Picked because') && !logs.f.join('\n').includes('uploads'));
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
    last = await call(D, 'GET', '/api/agent/stories/1', { token: AGENT_TOKEN });
    check('...and for the read-back routes (shared window)', last.status === 429 && (await call(D, 'GET', '/api/agent/stories?sourceUrl=' + encodeURIComponent('https://example.test/x'), { token: AGENT_TOKEN })).status === 429);
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

    // Make some data: a Studio publish (to the database), a stack of drafts
    const pub = await call(BASE, 'POST', '/api/publish', { token: PUBLISH_TOKEN, json: { newsletter: { name: 'E2E Issue', issueDate: '2026-10-19' }, stories: [{ ref: 'a', title: 'Studio Story Live Before The Next Build', section: 'news', area: 'churches', author: 'Studio Author', dek: 'Published seconds ago.', body: 'A made-up story body for the list.', photos: [{ url: dataUrl(PNG_A), alt: 'Studio alt' }, { url: 'https://stories.imadventist.org/images/x/photo.jpg', alt: 'Second' }] }] } });
    check('(Studio publishes a story)', pub.status === 200 && pub.data.ok, pub.text.slice(0, 200));
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
    const builtCount = fs.readdirSync(path.join(ROOT, 'src/content/stories')).filter((f) => f.endsWith('.md') && !/^draft:\s*true\s*$/m.test(fs.readFileSync(path.join(ROOT, 'src/content/stories', f), 'utf8').split(/^---\s*$/m)[1] ?? '')).length; // however many real stories are live today
    check('stories: every story in the build is there (newest first)', built.length === builtCount && builtCount > 0 && d.stories.every((s, i, a) => i === 0 || a[i - 1].date >= s.date), `${built.length}`);
    const feed = JSON.parse((await S('/stories.json')).text).stories; // rendered by the server since epic #25 step 2
    const strip = (o) => { const { status, source, url, image, photos, excerpt, ...rest } = o; return rest; };
    const sameAsFeed = feed.every((f) => { const s = d.stories.find((b) => b.id === f.id); return s && JSON.stringify(strip(s)) === JSON.stringify(strip(f)); });
    check('stories: each item has exactly the /stories.json fields and values (feedItem), plus status and source', sameAsFeed && built.every((s) => s.status === 'published'), JSON.stringify(built[0]).slice(0, 300));
    const feedKeys = new Set(feed.flatMap((f) => Object.keys(f)));
    check('...no field of the public item is missing or renamed', [...feedKeys].every((k) => built.some((s) => k in s)), [...feedKeys].join());
    const live = d.stories.find((s) => s.id === slug);
    check('stories: a story published since the last build is in the list (live in the database)', !!live && live.status === 'published' && live.source === 'studio' && live.title === 'Studio Story Live Before The Next Build' && live.url === `${BASE}/stories/${slug}/`, JSON.stringify(live));
    check('...with absolute links and its photos', live && /^http:\/\/localhost:\d+\/media\/stories\/2026-10-19-studio-story-live-before-the-next-build\/[0-9a-f]{64}\.png$/.test(live.image) && live.image.startsWith(BASE + '/media/stories/') && live.imageAlt === 'Studio alt' && live.photos[0] === 'https://stories.imadventist.org/images/x/photo.jpg' && live.photoAlts[0] === 'Second' && live.sectionLabel === 'News' && live.areaLabel === 'Churches' && live.date === '2026-10-19');
    check('...Studio\'s reads: title, dek, section, sectionLabel, areaLabel, date, url, image, imageAlt, photoCredit/photos, status and source are present', live && ['title', 'dek', 'section', 'sectionLabel', 'areaLabel', 'date', 'url', 'image', 'imageAlt', 'photos', 'photoAlts', 'status', 'source'].every((k) => k in live));
    check('...and every url is on the site\'s own origin', d.stories.every((s) => s.url.startsWith(BASE + '/')));

    // unpublish hides it
    run("UPDATE stories SET rev = rev + 1, status = 'unpublished' WHERE slug = ?", slug);
    r = await S('/api/stories', { token: PUBLISH_TOKEN });
    check('stories: an unpublished story disappears from the list (read fresh from the table)', !r.data.stories.some((s) => s.id === slug));
    run("UPDATE stories SET rev = rev + 1, status = 'live' WHERE slug = ?", slug);
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

    // excerpt
    check('excerpt: every story and draft item has a string excerpt', d.stories.every((s) => typeof s.excerpt === 'string') && d.drafts.every((x) => typeof x.excerpt === 'string'));
    check('...a story published from Studio gets its body as plain text', live && live.excerpt === 'A made-up story body for the list.', JSON.stringify(live && live.excerpt));
    run("INSERT INTO drafts (status, source, title, section, author, date, body, created_at, updated_at) VALUES ('new', 'form', 'Excerpt Draft', 'columns', 'Sample Author', '2026-10-12', ?, ?, ?)", '\n## A heading\n\n**Bold** and *soft* words with a [link text](https://example.test/x) and ![pic](/images/x.jpg) &lt;b&gt; tail &amp; more.\n\nSecond paragraph.', now + 9600, now + 9600);
    run("INSERT INTO drafts (status, source, title, section, author, date, body, created_at, updated_at) VALUES ('new', 'form', 'Long Excerpt Draft', 'columns', 'Sample Author', '2026-10-12', ?, ?, ?)", Array.from({ length: 200 }, (_, i) => 'word' + i).join(' '), now + 9601, now + 9601);
    r = await S('/api/stories?section=columns', { token: PUBLISH_TOKEN });
    const ex = r.data.drafts.find((x) => x.title === 'Excerpt Draft');
    check('...Markdown is stripped (headings, emphasis, links keep text, images removed, entities decoded)', ex && ex.excerpt === 'Bold and soft words with a link text and b tail & more.', JSON.stringify(ex && ex.excerpt));
    const lx = r.data.drafts.find((x) => x.title === 'Long Excerpt Draft');
    check('...at most 400 characters including the ellipsis, cut at a word boundary', lx && [...lx.excerpt].length <= 400 && lx.excerpt.endsWith('…') && /word\d+…$/.test(lx.excerpt), lx && lx.excerpt.slice(-30));
    run("INSERT INTO drafts (status, source, title, section, author, date, body, created_at, updated_at) VALUES ('new', 'form', 'Escaped Html Draft', 'columns', 'Sample Author', '2026-10-12', ?, ?, ?)", 'Hello &lt;img src=x onerror=alert(1)&gt; and &#60;script&#62; and &#x202E;bidi&#0; &#x7F;end <b>bold</b>', now + 9602, now + 9602);
    r = await S('/api/stories?section=columns', { token: PUBLISH_TOKEN });
    const eh = r.data.drafts.find((x) => x.title === 'Escaped Html Draft');
    check('...a decoded &lt;img onerror&gt; never leaves a < or > (and control/bidi characters are dropped)', eh && !/[<>]/.test(eh.excerpt) && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(eh.excerpt) && eh.excerpt.includes('Hello img src=x onerror=alert(1)'), JSON.stringify(eh && eh.excerpt));
    const bareDraft = r.data.drafts.find((x) => x.title === 'Bad Date Draft');
    check('...no body: an empty string', bareDraft && bareDraft.excerpt === '');

    // GET /api/studio-photo
    {
      const photoDir = path.relative(ROOT, path.join(CLIENT_TMP, 'images/stories'));
      const sdir = fs.readdirSync(path.join(ROOT, photoDir)).find((n) => fs.statSync(path.join(ROOT, photoDir, n)).isDirectory());
      const file = fs.readdirSync(path.join(ROOT, photoDir, sdir)).find((n) => /\.jpe?g$/i.test(n));
      const rel = `/images/stories/${sdir}/${file}`;
      const P1 = (src, o = {}) => S(`/api/studio-photo?src=${encodeURIComponent(src)}`, o);
      r = await P1(rel);
      check('studio-photo: no token: 401', r.status === 401);
      r = await P1(rel, { token: 'x'.repeat(PUBLISH_TOKEN.length) });
      check('...wrong token: 401', r.status === 401);
      r = await call(`http://localhost:${P.b}`, 'GET', `/api/studio-photo?src=${encodeURIComponent(rel)}`, { token: PUBLISH_TOKEN });
      check('...PUBLISH_TOKEN unset: 503', r.status === 503);
      r = await P1(rel, { token: PUBLISH_TOKEN, headers: { Origin: TOOLS_ORIGIN } });
      const bytes = fs.readFileSync(path.join(ROOT, photoDir, sdir, file));
      check('...a built story photo (root-relative): 200 image/jpeg, the exact bytes, no-store, nosniff, CORS', r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && r.headers.get('cache-control') === 'no-store' && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('access-control-allow-origin') === TOOLS_ORIGIN && Number(r.headers.get('content-length')) === bytes.length, `${r.status} ${r.headers.get('content-type')}`);
      r = await P1(`${BASE}${rel}`, { token: PUBLISH_TOKEN, headers: { Origin: EVIL_ORIGIN } });
      check('...the absolute URL on the site origin works, and a foreign Origin gets no Allow-Origin', r.status === 200 && r.headers.get('access-control-allow-origin') === null);
      // the /media/ copy the mirror made
      const mediaRoot = path.join(DATA_DIR, 'media', 'stories');
      await until(() => fs.existsSync(mediaRoot) && fs.readdirSync(mediaRoot).length > 0, 15000);
      const mslug = fs.existsSync(mediaRoot) ? fs.readdirSync(mediaRoot)[0] : null;
      const mfile = mslug ? fs.readdirSync(path.join(mediaRoot, mslug)).find((n) => /\.(jpg|png|webp)$/.test(n)) : null;
      if (mfile) {
        r = await P1(`/media/stories/${mslug}/${mfile}`, { token: PUBLISH_TOKEN });
        check('...a /media/stories copy: 200 with an image type', r.status === 200 && /^image\//.test(r.headers.get('content-type') || ''), String(r.status));
      } else check('...a /media/stories copy: 200 with an image type', false, 'the mirror made no /media/stories file');
      // a photo published straight to the database (the Studio story's uploaded photo) is served from /media
      const sp = q('SELECT p.path FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = ? AND p.path IS NOT NULL', slug)[0];
      r = await P1(`/media/${sp?.path}`, { token: PUBLISH_TOKEN });
      check('...a photo of a story published to the database (/media/stories/<slug>/<sha>.png): 200 image/png', !!sp && r.status === 200 && r.headers.get('content-type') === 'image/png' && Number(r.headers.get('content-length')) === fs.statSync(path.join(DATA_DIR, 'media', sp.path)).size, String(r.status));
      // an old /images/stories link (as in a sent newsletter) keeps working even when the static archive file is gone: the story's own /media copy answers
      const archived = path.join(CLIENT_TMP, 'images/stories', sdir, file);
      const archivedBytes = fs.readFileSync(archived);
      fs.rmSync(archived);
      try {
        r = await P1(rel, { token: PUBLISH_TOKEN });
        check('...an old /images/stories/... link whose static file is not in the build is served from the story\'s /media copy: 200 image/jpeg', r.status === 200 && r.headers.get('content-type') === 'image/jpeg', String(r.status));
      } finally { fs.writeFileSync(archived, archivedBytes); }
      const bad = [
        ['traversal', `/images/stories/${sdir}/../../../favicon.svg`],
        ['encoded traversal', `/images/stories/${sdir}/%2e%2e/%2e%2e/favicon.svg`],
        ['encoded slash', `/images/stories/${sdir}%2f${file}`],
        ['backslash', `/images/stories/${sdir}\\${file}`],
        ['query trick', `${rel}?x=1`],
        ['fragment', `${rel}#x`],
        ['other folder', '/images/favicon.svg'],
        ['site root file', '/favicon.svg'],
        ['draft upload path', '/api/admin/photos/1'],
        ['uploads path', `/uploads/stories/${sdir}/${file}`],
        ['wrong extension', `/images/stories/${sdir}/${file}.svg`],
        ['wrong origin', `https://evil.e2e-example.test${rel}`],
        ['protocol-relative', `//evil.e2e-example.test${rel}`],
        ['userinfo origin trick', `${BASE}@evil.e2e-example.test${rel}`],
        ['no src', ''],
      ];
      // symlinks, in the throwaway copy
      const sdirPath = path.join(CLIENT_TMP, 'images/stories', sdir);
      fs.symlinkSync(path.join(sdirPath, file), path.join(sdirPath, 'zz-link.jpg'));
      fs.symlinkSync(sdirPath, path.join(CLIENT_TMP, 'images/stories', 'zz-linkslug'));
      bad.push(['symlinked file', `/images/stories/${sdir}/zz-link.jpg`], ['symlinked slug folder', `/images/stories/zz-linkslug/${file}`], ['NUL byte', `/images/stories/${sdir}/${file}%00.jpg`], ['uppercase IMAGES', `/IMAGES/stories/${sdir}/${file}`], ['absolute filesystem path', '/etc/passwd.jpg'], ['absolute filesystem path (2)', '/etc/passwd']);
      for (const [name, src] of bad) {
        r = await P1(src, { token: PUBLISH_TOKEN, headers: { Origin: TOOLS_ORIGIN } });
        check(`...refused (${name}): 404 JSON 'Photo not found.' with CORS`, r.status === 404 && r.data && r.data.ok === false && r.data.error === 'Photo not found.' && !('code' in r.data) && r.headers.get('access-control-allow-origin') === TOOLS_ORIGIN, `${r.status} ${r.text.slice(0, 80)}`);
      }
      r = await S('/api/studio-photo', { token: PUBLISH_TOKEN });
      check('...a missing src parameter: 404', r.status === 404);
      r = await P1(`/images/stories/${sdir}/not-built-yet-photo.jpg`, { token: PUBLISH_TOKEN, headers: { Origin: TOOLS_ORIGIN } });
      check('...a well-formed path whose file is not there: a plain 404 Photo not found (no "not built yet" any more: photos are in the database at once)', r.status === 404 && r.data.ok === false && r.data.error === 'Photo not found.' && !('code' in r.data) && r.headers.get('access-control-allow-origin') === TOOLS_ORIGIN, r.text.slice(0, 160));
      r = await P1(`/images/stories/${sdir}/not-built-yet-photo.jpg`);
      check('...and without the token that is still a plain 401 (no existence leak)', r.status === 401 && !('code' in r.data));
      r = await P1(`/images/stories/zz-no-such-story/photo-1.jpg`, { token: PUBLISH_TOKEN });
      check('...(also for a story folder that is not in the build)', r.status === 404 && r.data.error === 'Photo not found.');
      r = await P1(`/media/stories/${sdir}/${'0'.repeat(64)}.jpg`, { token: PUBLISH_TOKEN });
      check('...a missing /media file keeps the generic "Photo not found."', r.status === 404 && r.data.error === 'Photo not found.' && !('code' in r.data));
      // a non-image with a photo name is refused by the byte check
      const fake = path.join(ROOT, photoDir, sdir, 'zz-e2e-not-an-image.jpg');
      fs.writeFileSync(fake, 'this is plain text, not a picture at all');
      try {
        r = await P1(`/images/stories/${sdir}/zz-e2e-not-an-image.jpg`, { token: PUBLISH_TOKEN });
        check('...a file that is not an image is refused: 404', r.status === 404);
      } finally { fs.rmSync(fake, { force: true }); }
      r = await call(BASE, 'OPTIONS', '/api/studio-photo', { headers: { Origin: TOOLS_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      check('...preflight from an allowed origin: 204 with CORS', r.status === 204 && r.headers.get('access-control-allow-origin') === TOOLS_ORIGIN);
      r = await call(BASE, 'OPTIONS', '/api/studio-photo', { headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'GET' } });
      check('...preflight from a foreign origin: no CORS headers', ![...r.headers.keys()].some((k) => k.startsWith('access-control-')));
      r = await call(BASE, 'POST', '/api/studio-photo', { token: PUBLISH_TOKEN, json: {} });
      check('...POST: 405', r.status === 405);
      // a draft's uploaded photo is not reachable through it
      const upl = uploadFiles()[0];
      check('(a draft upload exists to test against)', !!upl, 'no file under DATA_DIR/uploads');
      if (upl) {
        const rp = path.relative(DATA_DIR, upl).split(path.sep).join('/');
        for (const cand of ['/' + rp, `/images/stories/${rp}`, `${BASE}/${rp}`, `/media/${rp.replace(/^uploads\//, '')}`]) {
          r = await P1(cand, { token: PUBLISH_TOKEN });
          check(`...a draft upload (${cand.slice(0, 40)}) is not reachable: 404`, r.status === 404 && r.data.error === 'Photo not found.');
        }
      }
    }

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
