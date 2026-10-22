#!/usr/bin/env node
// End-to-end check of story photo layouts and the click-to-enlarge viewer (issue #35).
// It runs the BUILT server (dist/server/entry.mjs) against a throwaway data folder and checks:
//   * the layout planner (src/lib/photo-layouts.ts) for every layout with 1, 2, 3, 4 and 6 photos
//   * migration 016 on a database that already has stories and drafts (existing rows read 'one')
//   * Studio's POST /api/publish: photoLayout accepted, validated (400), defaulting to 'one'
//   * the story page markup of every layout and photo count (rows, links, lazy/eager, alt text, no photo lost)
//   * a story with no layout keeps the original markup (the baseline comparison is in test-public-pages.mjs)
//   * /stories.json carries photoLayout and keeps version 1; GET /api/stories too
//   * the AI agent API (photoLayout validated, kept on an update that omits it)
//   * the dashboard: the picker, save validation, publish, and edit-a-live-story keep the layout
//   * (optional, needs Playwright) in a real browser: no horizontal scroll at 390/768/1280 px for every layout and photo
//     count, the viewer with keyboard, touch swipe, focus trap and focus return, no-JavaScript links, and an axe scan
//     when AXE_JS points at axe.min.js (axe-core is NOT a dependency of this repo).
// Synthetic data only: made-up tokens, generated pictures, no real email. Nothing is written into the repository.
//
//   npm run build
//   SCRATCH=/tmp/imc-photo-layouts node scripts/test-photo-layouts.mjs                       # run from the repo root
//   SHOTS=/tmp/shots AXE_JS=/path/to/axe.min.js SCRATCH=... node scripts/test-photo-layouts.mjs   # with screenshots and axe
// SCRATCH is created fresh (an existing folder is removed first) and deleted at the end unless KEEP=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.SCRATCH) throw new Error('Set SCRATCH to a throwaway folder.');
const SCRATCH = path.resolve(process.env.SCRATCH);
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
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const PORT = Number(process.env.PORT || 4551);
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLISH_TOKEN = 'e2e-made-up-publish-token-' + 'p'.repeat(24);
const AGENT_TOKEN = 'e2e-made-up-agent-token-' + 'a'.repeat(24);
const DATA_DIR = path.join(SCRATCH, 'data');
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');

let fails = 0;
let skips = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 700)}`);
  if (!ok) fails++;
};
const skip = (name, why) => { console.log(`SKIP  ${name} (${why})`); skips++; };
const info = (line) => console.log(`INFO  ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

// ---- processes ----
const procs = new Set();
const serverLog = [];
let server;
async function startServer() {
  serverLog.length = 0;
  server = spawn('node', ['dist/server/entry.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production', STORY_SYNC_TEST: '1',
      AUTH_SECRET: 'e2e-made-up-auth-secret-' + 'a'.repeat(24), TRUST_PROXY: 'true', PUBLISH_TOKEN, AGENT_API_TOKEN: AGENT_TOKEN,
      RESEND_API_KEY: '', SITE_URL: BASE,
    },
  });
  const sink = (d) => serverLog.push(...String(d).split('\n').filter(Boolean));
  server.stdout.on('data', sink);
  server.stderr.on('data', sink);
  procs.add(server);
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/submit/'); return; } catch { await sleep(250); } }
  throw new Error('the server did not start:\n' + serverLog.join('\n'));
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill();
  await done;
  procs.delete(server);
}
async function cleanup() {
  for (const p of procs) p.kill();
  if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)));

// ---- synthetic pictures: valid PNGs, each a different colour pair and shape (landscape, portrait, square) ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(w, h, a, b) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * t);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const SHAPES = [[720, 480], [480, 720], [600, 600], [720, 480], [540, 720], [720, 405]];
const COLOURS = [[[200, 90, 40], [250, 200, 90]], [[40, 120, 200], [150, 220, 240]], [[60, 140, 80], [200, 240, 150]], [[130, 60, 160], [230, 180, 230]], [[180, 50, 70], [250, 160, 150]], [[70, 80, 100], [180, 190, 210]]];
const PICS = SHAPES.map(([w, h], i) => png(w, h, COLOURS[i][0], COLOURS[i][1]));
const dataUrl = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const LAYOUTS = ['one', 'twoUp', 'heroGrid', 'mosaic', 'stack'];
const COUNTS = [1, 2, 3, 4, 6];

// ---- http helpers ----
async function call(method, url, { headers = {}, json, body } = {}) {
  const h = { ...headers };
  let payload = body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
  const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, data, loc: res.headers.get('location') };
}
const studioPublish = (stories, issueDate = '2099-01-02') => call('POST', '/api/publish', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` }, json: { newsletter: { name: 'E2E Issue', issueDate }, stories } });
const agentPost = (json, token = AGENT_TOKEN) => call('POST', '/api/agent/stories', { headers: { Authorization: `Bearer ${token}` }, json });

// ================= part 1: the planner =================
const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules/rolldown/dist/index.mjs')).href);
await build({ input: path.join(ROOT, 'src/lib/photo-layouts.ts'), output: { file: path.join(SCRATCH, 'photo-layouts.mjs'), format: 'esm' }, platform: 'node', logLevel: 'silent' });
const PL = await import(pathToFileURL(path.join(SCRATCH, 'photo-layouts.mjs')).href);

// What each layout shows for each count, written out by hand (not derived from the planner): rows, then photos left for the row under the text.
const EXPECT = {
  one: { 1: ['', 0], 2: ['', 0], 3: ['', 0], 4: ['', 0], 6: ['', 0] },
  twoUp: { 1: ['', 0], 2: ['pair', 0], 3: ['pair', 1], 4: ['pair', 2], 6: ['pair', 4] },
  heroGrid: { 1: ['', 0], 2: ['hero,wide', 0], 3: ['hero,pair', 0], 4: ['hero,pair', 1], 6: ['hero,pair', 3] },
  mosaic: { 1: ['', 0], 2: ['pair', 0], 3: ['pair,wide', 0], 4: ['pair,pair', 0], 6: ['pair,pair,pair', 0] },
  stack: { 1: ['', 0], 2: ['wide,wide', 0], 3: ['wide,wide,wide', 0], 4: ['wide,wide,wide,wide', 0], 6: ['wide,wide,wide,wide,wide,wide', 0] },
};
{
  check('the layouts are Studio\'s five: one, twoUp, heroGrid, mosaic, stack (default one)', JSON.stringify(PL.PHOTO_LAYOUTS.map((l) => l.value)) === JSON.stringify(LAYOUTS) && PL.DEFAULT_PHOTO_LAYOUT === 'one');
  check('isPhotoLayout accepts the five and refuses anything else', LAYOUTS.every(PL.isPhotoLayout) && ['', 'ONE', 'carousel', 'one ', 'filmstrip', null, undefined, 5, {}].every((v) => !PL.isPhotoLayout(v)));
  check('photoLayoutOrDefault falls back to one', PL.photoLayoutOrDefault('mosaic') === 'mosaic' && PL.photoLayoutOrDefault('x') === 'one' && PL.photoLayoutOrDefault(undefined) === 'one');
  const bad = [];
  for (const L of LAYOUTS) {
    for (const n of COUNTS) {
      const plan = PL.planPhotos(L, n);
      const [rows, rest] = EXPECT[L][n];
      const got = plan.mode === 'plain' ? '' : plan.rows.map((r) => r.kind).join(',');
      const placed = plan.rows.flatMap((r) => r.photos);
      const every = plan.mode === 'plain' || [...placed, ...plan.rest].sort((a, b) => a - b).join() === Array.from({ length: n }, (_, i) => i).join();
      if (got !== rows || plan.rest.length !== rest || !every) bad.push(`${L}/${n}: ${got} +${plan.rest.length} placed=${placed} rest=${plan.rest}`);
    }
  }
  check('every layout with 1, 2, 3, 4 and 6 photos plans the expected rows, places each photo exactly once and degrades (one photo = the plain look)', bad.length === 0, bad.join(' | '));
}

// ================= part 2: migration 016 on a database that already has data =================
{
  const { openDatabase, runMigrations, readMigrationsFromDir } = await import(path.join(ROOT, 'src/lib/db/db-core.mjs'));
  const all = readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations'));
  const dir = path.join(SCRATCH, 'migrate');
  const db = openDatabase(dir);
  runMigrations(db, all.filter((m) => m.name < '016'));
  const now = Date.now();
  db.prepare("INSERT INTO stories (slug, title, section, author, date, published_at, updated_at) VALUES ('2026-10-01-old-story', 'Old story', 'news', 'Test Author', '2026-10-01', ?, ?)").run(now, now);
  db.prepare("INSERT INTO drafts (status, source, title, created_at, updated_at) VALUES ('in_review', 'editor', 'Old draft', ?, ?)").run(now, now);
  const applied = runMigrations(db, all.filter((m) => m.name < '017'));
  check('migration 016 applies on a database with stories and drafts', applied.length === 1 && applied[0].startsWith('016_'), JSON.stringify(applied));
  check('...the existing story and draft read photo_layout = one (nothing changes for them)',
    db.prepare("SELECT photo_layout p FROM stories WHERE slug = '2026-10-01-old-story'").get().p === 'one' && db.prepare('SELECT photo_layout p FROM drafts').get().p === 'one');
  let refused = false;
  try { db.prepare("UPDATE stories SET photo_layout = 'carousel', rev = rev + 1").run(); } catch { refused = true; }
  check('...an unknown layout is refused by the database itself', refused);
  let guard = false;
  try { db.prepare("UPDATE stories SET photo_layout = 'mosaic'").run(); } catch { guard = true; }
  check('...and migration 015\'s rev guard still stops a write that does not bump rev', guard);
  check('...with a clean foreign key check', db.prepare('PRAGMA foreign_key_check').all().length === 0);
  runMigrations(db, all.filter((m) => m.name < '018'));
  db.prepare("INSERT INTO draft_photos (draft_id, url, created_at, focal_x, focal_y) SELECT id, 'https://example.invalid/synthetic.png', ?, 17, 83 FROM drafts").run(now);
  db.prepare("INSERT INTO story_photos (story_id, position, kind, url, focal_x, focal_y) SELECT id, 0, 'lead', 'https://example.invalid/synthetic.png', 17, 83 FROM stories").run();
  const cropMigration = runMigrations(db, all.filter((m) => m.name < '019'));
  check('migration 018 preserves existing draft and published photo crops at 100% zoom', cropMigration.length === 1 && cropMigration[0].startsWith('018_') && ['draft_photos', 'story_photos'].every((table) => {
    const photo = db.prepare(`SELECT focal_x, focal_y, zoom FROM ${table}`).get();
    return photo.focal_x === 17 && photo.focal_y === 83 && photo.zoom === 1;
  }));
  let invalidZoom = false;
  try { db.prepare('UPDATE story_photos SET zoom = .99').run(); } catch { invalidZoom = true; }
  check('published photo zoom is constrained to 100–300% by the database', invalidZoom && db.prepare('PRAGMA foreign_key_check').all().length === 0);
  db.close();
}

// ================= part 3: the server =================
let browserSkipReason = '';
try {
  await startServer();
  await fetch(BASE + '/admin/login'); // opens the database, applies the migrations and adopts the built stories

  // ---- Studio publish: every layout x count, in batches (the endpoint takes up to 12 stories and 20 requests an hour) ----
  const wanted = [];
  for (const L of LAYOUTS) for (const n of COUNTS) wanted.push({ L, n });
  const published = new Map(); // `${L}/${n}` -> slug
  for (let i = 0; i < wanted.length; i += 12) {
    const batch = wanted.slice(i, i + 12);
    const res = await studioPublish(batch.map(({ L, n }) => ({
      ref: `${L}-${n}`, title: `Zz layout ${L} ${n}`, section: 'news', area: 'churches', author: 'Test Author',
      body: `Synthetic story for the ${L} layout with ${n} photo${n === 1 ? '' : 's'}. It is made up by the test.\n\nA second paragraph keeps the text from being one line.`,
      photoLayout: L, photos: PICS.slice(0, n).map((b, k) => ({ url: dataUrl(b), alt: `Synthetic ${L} photo ${k + 1}` })),
    })));
    check(`Studio publish of ${batch.length} synthetic stories with photoLayout is accepted`, res.status === 200 && res.data.ok === true && res.data.stories?.length === batch.length, `${res.status} ${res.text.slice(0, 200)}`);
    for (const s of res.data.stories ?? []) published.set(s.ref.replace('-', '/'), s.slug);
  }
  const dbLayouts = Object.fromEntries(q("SELECT slug, photo_layout FROM stories WHERE slug LIKE '2099-01-02-zz-layout-%'").map((r) => [r.slug, r.photo_layout]));
  check('the layout of each published story is stored as sent', wanted.every(({ L, n }) => dbLayouts[published.get(`${L}/${n}`)] === L), JSON.stringify(dbLayouts).slice(0, 300));

  // ---- validation and default ----
  const base = { ref: 'v', title: 'Zz layout validation', section: 'news', area: 'churches', author: 'Test Author', body: 'Synthetic text.', photos: [{ url: dataUrl(PICS[0]), alt: 'x' }] };
  for (const bad of ['carousel', 'ONE', 'mosaic ', '', 5, ['one'], { a: 1 }, true]) {
    const r = await studioPublish([{ ...base, photoLayout: bad }]);
    check(`Studio publish with photoLayout ${JSON.stringify(bad)} is a 400 that names the choices`, r.status === 400 && r.data.ok === false && /photoLayout must be one of: one, twoUp, heroGrid, mosaic, stack/.test(r.data.error) && r.data.ref === 'v', `${r.status} ${r.text.slice(0, 160)}`);
  }
  check('...and nothing was written by the refused requests', q("SELECT COUNT(*) AS n FROM stories WHERE slug LIKE '%zz-layout-validation%'")[0].n === 0);
  const noField = await studioPublish([{ ...base, ref: 'nf', title: 'Zz layout default' }]);
  const nullField = await studioPublish([{ ...base, ref: 'nl', title: 'Zz layout null', photoLayout: null }]);
  check('Studio publish without photoLayout (or null) defaults to one', noField.status === 200 && nullField.status === 200
    && q("SELECT photo_layout p FROM stories WHERE slug LIKE '%zz-layout-default'")[0].p === 'one' && q("SELECT photo_layout p FROM stories WHERE slug LIKE '%zz-layout-null'")[0].p === 'one', `${noField.status} ${nullField.status}`);
  const again = await studioPublish([{ ...base, ref: 'again', title: 'Zz layout default', photoLayout: 'mosaic' }]);
  check('a republish with a new layout changes the story\'s layout in place', again.status === 200 && again.data.stories[0].status === 'updated' && q("SELECT photo_layout p FROM stories WHERE slug LIKE '%zz-layout-default'")[0].p === 'mosaic');
  const draftRow = q("SELECT photo_layout p FROM drafts WHERE slug LIKE '%zz-layout-default'")[0];
  check('...and the Studio history draft carries it', draftRow?.p === 'mosaic');

  // ---- the story pages ----
  const articleOf = (html) => html.slice(html.indexOf('<article'), html.indexOf('</article>'));
  const bad = [];
  let pagesChecked = 0;
  for (const { L, n } of wanted) {
    const slug = published.get(`${L}/${n}`);
    const page = await call('GET', `/stories/${slug}/`);
    const art = articleOf(page.text);
    const [rows, rest] = EXPECT[L][n];
    const label = `${L}/${n}`;
    if (page.status !== 200) { bad.push(`${label}: ${page.status}`); continue; }
    pagesChecked++;
    const fig = /<figure class="photos photos-(\w+)"[^>]*>([\s\S]*?)<\/figure>/.exec(art);
    const gallery = /<section class="gallery"[^>]*>([\s\S]*?)<\/section>/.exec(art);
    const galleryLinks = gallery ? [...gallery[1].matchAll(/<a href="([^"]+)"/g)].length : 0;
    if (!rows) {
      // The plain look: lead figure with the eager image (unchanged markup) and the others in the gallery row.
      if (fig) bad.push(`${label}: has a laid-out figure but should look plain`);
      if (!/<figure>\s*<img src="\/media\/[^"]+" alt="Synthetic[^"]*" loading="eager"\s*\/?>/.test(art)) bad.push(`${label}: lead figure markup changed`);
      if (galleryLinks !== n - 1) bad.push(`${label}: gallery has ${galleryLinks} links, wanted ${n - 1}`);
      if (n > 1 && !/<section class="gallery" aria-label="Photos">/.test(art)) bad.push(`${label}: gallery label changed`);
      continue;
    }
    if (!fig || fig[1] !== L) { bad.push(`${label}: no ${L} figure`); continue; }
    const kinds = [...fig[2].matchAll(/class="photos-row photos-(hero|wide|pair)"/g)].map((m) => m[1]).join(',');
    const links = [...fig[2].matchAll(/<a href="(\/media\/[^"]+)" data-photo[^>]*>\s*<img ([^>]*)>/g)];
    if (kinds !== rows) bad.push(`${label}: rows ${kinds}, wanted ${rows}`);
    if (links.length + galleryLinks !== n) bad.push(`${label}: ${links.length} laid out + ${galleryLinks} in the row under the text, wanted ${n} in all`);
    if (galleryLinks !== rest) bad.push(`${label}: ${galleryLinks} left for the row under the text, wanted ${rest}`);
    links.forEach((m, i) => {
      const a = m[2];
      const lazy = /loading="lazy"/.test(a);
      if (i === 0 ? !/loading="eager"/.test(a) : !lazy) bad.push(`${label}: photo ${i + 1} loading`);
      if (!/decoding="async"/.test(a)) bad.push(`${label}: photo ${i + 1} decoding`);
      if (!new RegExp(`alt="Synthetic ${L} photo \\d"`).test(a)) bad.push(`${label}: photo ${i + 1} alt`);
    });
    if (/<figcaption>[^<]*<\/figcaption>/.test(fig[2]) && !/<figcaption>Photo: /.test(fig[2])) bad.push(`${label}: a caption that is not the credit`);
    const proseAt = art.search(/<div\b[^>]*class="prose"(?:\s|>)/);
    if (proseAt < 0 || art.indexOf(fig[0]) > proseAt) bad.push(`${label}: photos are not above the text`);
  }
  check(`all ${wanted.length} layout x photo-count pages have the expected rows, links, loading, decoding and alt text, and no photo is lost (${pagesChecked} pages)`, bad.length === 0, bad.slice(0, 6).join(' | '));

  // a story with no layout keeps exactly the markup it had: the adopted stories of the build (the byte-for-byte comparison is test-public-pages)
  const adopted = q("SELECT slug FROM stories WHERE source = 'git' AND status = 'live' AND image IS NOT NULL ORDER BY slug LIMIT 3").map((r) => r.slug);
  const oldOk = [];
  for (const slug of adopted) {
    const art = articleOf((await call('GET', `/stories/${slug}/`)).text);
    oldOk.push(!/class="photos/.test(art) && /<figure>\s*<img src="[^"]+" alt="[^"]*" loading="eager"\s*\/?>/.test(art));
  }
  check(`stories adopted from the build (photo_layout one) keep the original lead figure and no layout markup (${adopted.length} checked)`, adopted.length > 0 ? oldOk.every(Boolean) : true, JSON.stringify(oldOk));

  // ---- feeds ----
  const feed = await call('GET', '/stories.json');
  const items = feed.data.stories ?? [];
  const mine = items.find((s) => s.url.includes(published.get('mosaic/4') ?? '~'));
  check('/stories.json keeps version 1 and every story has photoLayout (right after photoAlts)', feed.data.version === 1 && items.length > 0 && items.every((s) => LAYOUTS.includes(s.photoLayout)) && items.every((s) => { const k = Object.keys(s); return k.indexOf('photoLayout') === k.indexOf('photoAlts') + 1; }), `${feed.data.version} ${JSON.stringify(items[0]).slice(0, 200)}`);
  info(`/stories.json lists the newest ${items.length} stories; the synthetic mosaic story is ${mine ? 'among them' : 'not among them'}`);
  const sf = await call('GET', '/api/stories', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` } });
  const sfItems = [...(sf.data.stories ?? []), ...(sf.data.drafts ?? [])];
  check('the Studio list (GET /api/stories) has photoLayout on stories and drafts', sf.status === 200 && sfItems.length > 0 && sfItems.every((s) => LAYOUTS.includes(s.photoLayout)), `${sf.status} ${JSON.stringify(sfItems[0]).slice(0, 200)}`);
  const rss = await call('GET', '/rss.xml');
  check('/rss.xml is unchanged in shape (no photoLayout element)', rss.status === 200 && !/photoLayout/i.test(rss.text));

  // ---- AI agent API ----
  const agentStory = (over = {}) => ({ title: 'Zz agent layout story', body: 'Synthetic text from the agent test.', section: 'news', area: 'churches', author: 'Staff Writer', sourceUrl: 'https://example.test/posts/1', photos: [{ data: dataUrl(PICS[0]), alt: 'A' }, { data: dataUrl(PICS[1]), alt: 'B' }], ...over });
  const a1 = await agentPost(agentStory({ photoLayout: 'stack' }));
  check('the agent API accepts photoLayout and stores it on the new draft', a1.status < 300 && a1.data.ok === true && q("SELECT photo_layout p, source FROM drafts WHERE source = 'agent'")[0]?.p === 'stack', `${a1.status} ${a1.text.slice(0, 200)}`);
  const a2 = await agentPost(agentStory({ photoLayout: 'carousel', sourceUrl: 'https://example.test/posts/2' }));
  check('...an unknown photoLayout is a 400 (bad_photo_layout) and creates no draft', a2.status === 400 && a2.data.error === 'bad_photo_layout' && q("SELECT COUNT(*) AS n FROM drafts WHERE source_url = 'https://example.test/posts/2'")[0].n === 0, `${a2.status} ${a2.text.slice(0, 200)}`);
  const a2b = await agentPost(agentStory({ photoLayout: 7, sourceUrl: 'https://example.test/posts/2' }));
  check('...a non-text photoLayout is a 400 too', a2b.status === 400 && a2b.data.error === 'bad_photo_layout', `${a2b.status}`);
  const a3 = await agentPost(agentStory({ body: 'Synthetic text, edited by the agent.' }));
  check('...an update that leaves photoLayout out keeps the draft\'s layout', a3.status < 300 && a3.data.status === 'updated' && q("SELECT photo_layout p FROM drafts WHERE source = 'agent'")[0].p === 'stack', `${a3.status} ${a3.text.slice(0, 200)}`);
  const a4 = await agentPost(agentStory({ photoLayout: 'twoUp' }));
  check('...and one that sends it changes it', a4.status < 300 && q("SELECT photo_layout p FROM drafts WHERE source = 'agent'")[0].p === 'twoUp');
  run("UPDATE drafts SET updated_by = ?, updated_at = updated_at + 1 WHERE source = 'agent' AND source_url = 'https://example.test/posts/1'", Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('editor-zero@example.test', 'Zero Editor', 'editor', 'active', 1, 1)").lastInsertRowid));
  const a4b = await agentPost(agentStory({ photoLayout: 'stack' }));
  check('...an agent update with photoLayout on a draft an editor has touched is a 409 and the layout stays', a4b.status === 409 && q("SELECT photo_layout p FROM drafts WHERE source_url = 'https://example.test/posts/1'")[0].p === 'twoUp', `${a4b.status} ${a4b.text.slice(0, 160)}`);
  const a5 = await agentPost(agentStory({ title: 'Zz agent default', sourceUrl: 'https://example.test/posts/3' }));
  check('...a new draft without photoLayout gets one', a5.status < 300 && q("SELECT photo_layout p FROM drafts WHERE source_url = 'https://example.test/posts/3'")[0].p === 'one');

  // ---- the dashboard (an editor inserted straight into the database; sign-in has its own tests) ----
  const now = Date.now();
  const uid = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('editor-one@example.test', 'Test Editor', 'editor', 'active', ?, ?)", now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(token).digest('hex'), uid, now, now, now + 3600_000);
  const ck = { Cookie: `__Host-imc_session=${token}`, Origin: BASE };
  const form = (fields) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, String(v)); return fd; };
  const mk = await call('POST', '/api/admin/drafts/new', { headers: ck, body: form({}) });
  const draftId = Number(/\/admin\/drafts\/(\d+)/.exec(mk.loc ?? '')?.[1]);
  const version = () => q('SELECT updated_at u FROM drafts WHERE id = ?', draftId)[0].u;
  check('set-up: a dashboard draft can be created', Number.isInteger(draftId), `${mk.status} ${mk.loc}`);
  const fields = (over = {}) => ({ version: version(), title: 'Zz dashboard layout story', dek: '', section: 'news', area: 'churches', column: '', author: 'Test Author', authorTitle: '', church: '', date: '2099-02-01', photoCredit: 'Test Photographer', body: 'Synthetic dashboard text.\n\nA second paragraph.', ...over });
  const okSave = await call('POST', `/api/admin/drafts/${draftId}/save`, { headers: ck, body: form(fields({ photoLayout: 'mosaic' })) });
  check('saving with a valid layout stores it', okSave.status === 200 && okSave.data.ok === true && q('SELECT photo_layout p FROM drafts WHERE id = ?', draftId)[0].p === 'mosaic', `${okSave.status} ${okSave.text.slice(0, 200)}`);
  for (const badValue of ['carousel', ' mosaic ', 'MOSAIC', '']) {
    const badSave = await call('POST', `/api/admin/drafts/${draftId}/save`, { headers: ck, body: form(fields({ photoLayout: badValue })) });
    check(`saving a draft with the photo layout ${JSON.stringify(badValue)} is refused (400) and the draft keeps its layout (mosaic)`, badSave.status === 400 && badSave.data.ok === false && /photo layout/i.test(badSave.data.error) && q('SELECT photo_layout p FROM drafts WHERE id = ?', draftId)[0].p === 'mosaic', `${badSave.status} ${badSave.text.slice(0, 200)}`);
  }
  const noLayoutSave = await call('POST', `/api/admin/drafts/${draftId}/save`, { headers: ck, body: form(fields({ title: 'Zz dashboard layout story (old page save)' })) });
  check('a save from a form without the picker (a page opened before this existed) keeps the draft\'s layout and saves the rest', noLayoutSave.status === 200 && q('SELECT photo_layout p, title FROM drafts WHERE id = ?', draftId).every((r) => r.p === 'mosaic' && /old page save/.test(r.title)), noLayoutSave.text.slice(0, 200));
  await call('POST', `/api/admin/drafts/${draftId}/save`, { headers: ck, body: form(fields({ photoLayout: 'mosaic' })) });
  await call('POST', `/api/admin/drafts/${draftId}/save`, { headers: ck, body: form(fields({ photoLayout: 'heroGrid' })) });
  for (const [i, pic] of [PICS[0], PICS[1], PICS[2]].entries()) {
    const fd = form({ version: version(), op: 'upload' });
    fd.append('photos', new Blob([pic], { type: 'image/png' }), `synthetic-${i}.png`);
    const up = await call('POST', `/api/admin/drafts/${draftId}/photos`, { headers: ck, body: fd });
    if (up.status !== 303 && up.status !== 302) check('set-up: a photo uploads', false, `${up.status} ${up.loc}`);
  }
  const editor = await call('GET', `/admin/drafts/${draftId}`, { headers: ck });
  const radios = [...editor.text.matchAll(/<input[^>]*name="photoLayout"[^>]*>/g)].map((m) => m[0]);
  check('the editor shows a "Photo layout" picker: five radio cards, the draft\'s layout checked', editor.status === 200 && /<legend>Photo layout<\/legend>/.test(editor.text) && radios.length === 5
    && LAYOUTS.every((L) => radios.some((r) => r.includes(`value="${L}"`))) && radios.filter((r) => /\schecked/.test(r)).length === 1 && /value="heroGrid"[^>]*checked|checked[^>]*value="heroGrid"/.test(radios.join('')), `${editor.status} ${radios.join(' ').slice(0, 300)}`);
  check('...with a small preview and a name for each card', (editor.text.match(/class="lay-mini lay-/g) ?? []).length === 5 && ['One hero', 'Two up', 'Hero + grid', 'Mosaic', 'Stack'].every((l) => editor.text.includes(`>${l}</span>`)));
  const pub = await call('POST', `/api/admin/drafts/${draftId}/publish`, { headers: ck, body: form({ version: version() }) });
  const slug = q('SELECT slug FROM drafts WHERE id = ?', draftId)[0].slug;
  check('publishing the draft carries the layout to the story', /n=published/.test(pub.loc ?? '') && q('SELECT photo_layout p FROM stories WHERE slug = ?', slug)[0]?.p === 'heroGrid', `${pub.status} ${pub.loc}`);
  const live = articleOf((await call('GET', `/stories/${slug}/`)).text);
  check('...and the story page shows the Hero + grid (hero, then a pair) with the credit line only', /photos-heroGrid/.test(live) && /photos-row photos-hero/.test(live) && /photos-row photos-pair/.test(live) && /<figcaption>Photo: Test Photographer<\/figcaption>/.test(live), live.slice(0, 300));
  await call('POST', '/api/admin/stories/unpublish', { headers: ck, body: form({ slug }) });
  const edit = await call('POST', '/api/admin/stories/edit', { headers: ck, body: form({ slug: published.get('mosaic/4') }) });
  const editId = Number(/\/admin\/drafts\/(\d+)/.exec(edit.loc ?? '')?.[1]);
  check('"Edit" on a live story loads its layout into the draft', Number.isInteger(editId) && q('SELECT photo_layout p FROM drafts WHERE id = ?', editId)[0]?.p === 'mosaic', `${edit.status} ${edit.loc}`);

  // ---- no secrets or contact details in the log ----
  check('the server log has no token or email address', !serverLog.some((l) => l.includes(PUBLISH_TOKEN) || l.includes(AGENT_TOKEN) || /@example\.test/.test(l)));

  // ================= part 4: a real browser (optional) =================
  let pw;
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { pw = require(spec); break; } catch { /* try the next */ } }
  if (!pw) {
    browserSkipReason = 'Playwright is not installed';
  } else {
    let browser;
    try { browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] }); } catch (err) { browserSkipReason = 'no browser could be launched: ' + String(err.message).split('\n')[0]; }
    if (browser) {
      const overflow = [];
      const WIDTHS = [390, 768, 1280];
      for (const w of WIDTHS) {
        const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        for (const { L, n } of wanted) {
          await page.goto(`${BASE}/stories/${published.get(`${L}/${n}`)}/`, { waitUntil: 'load' });
          await page.evaluate(async () => { await Promise.all(Array.from(document.images).map((i) => (i.loading === 'lazy' ? (i.loading = 'eager', i.decode().catch(() => {})) : i.decode().catch(() => {})))); });
          const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
          if (m.sw > m.cw || m.bw > m.cw) overflow.push(`${L}/${n}@${w}: scrollWidth ${m.sw} > ${m.cw}`);
          if (SHOTS) {
            const box = await page.locator('.article').boundingBox();
            await page.screenshot({ path: path.join(SHOTS, `${L}-${n}-${w}.png`), clip: { x: 0, y: Math.max(0, box.y), width: w, height: Math.min(1400, box.height + 40) } });
          }
        }
        await ctx.close();
      }
      check(`no horizontal scroll for any layout x photo count (25 pages) at ${WIDTHS.join(', ')} px`, overflow.length === 0, overflow.slice(0, 5).join(' | '));
      if (SHOTS) info(`screenshots: ${fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).length} files in ${SHOTS}`);

      // layout geometry: the pair is two equal columns, the hero is wider than the pair photos, nothing is taller than it should be
      {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/stories/${published.get('heroGrid/4')}/`);
        const g = await page.evaluate(() => [...document.querySelectorAll('.photos a')].map((a) => { const r = a.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }));
        check('at 390 px Hero + grid is one wide photo (16:9) over two half-width photos (3:2)', g.length === 3 && g[0].w > g[1].w * 1.9 && Math.abs(g[0].w / g[0].h - 16 / 9) < 0.05 && Math.abs(g[1].w - g[2].w) <= 1 && Math.abs(g[1].w / g[1].h - 1.5) < 0.05, JSON.stringify(g));
        await ctx.close();
      }

      // the viewer, with a mouse/keyboard and with touch
      for (const touch of [false, true]) {
        const ctx = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 800 }, hasTouch: touch, isMobile: touch });
        const page = await ctx.newPage();
        const tag = touch ? 'touch' : 'desktop';
        await page.goto(`${BASE}/stories/${published.get('heroGrid/6')}/`);
        const first = page.locator('a[data-photo]').first();
        check(`${tag}: all 6 photos are links to the full image`, (await page.locator('a[data-photo]').count()) === 6);
        if (touch) await first.tap(); else await first.click();
        const dlg = page.locator('dialog.viewer');
        await dlg.waitFor({ state: 'visible' });
        const st = await page.evaluate(() => { const d = document.querySelector('dialog.viewer'); return { open: d.open, modal: d.getAttribute('aria-modal'), label: d.getAttribute('aria-label'), active: document.activeElement?.getAttribute('aria-label'), count: d.querySelector('.viewer-count').textContent, alt: d.querySelector('.viewer-img').getAttribute('alt'), describedby: d.getAttribute('aria-describedby'), desc: document.getElementById(d.getAttribute('aria-describedby') ?? 'none')?.textContent, live: document.getElementById(d.getAttribute('aria-describedby') ?? 'none')?.getAttribute('aria-live'), src: d.querySelector('.viewer-img').getAttribute('src') }; });
        check(`${tag}: clicking a photo opens the dialog (aria-modal, labelled with the photo's alt text), focus on the close button`, st.open && st.modal === 'true' && st.label === 'Photo viewer' && st.alt === 'Synthetic heroGrid photo 1' && st.active === 'Close photo viewer' && st.count === 'Synthetic heroGrid photo 1 (1 of 6)' && /\/media\/stories\//.test(st.src), JSON.stringify(st));
        check(`${tag}: on open the dialog's accessible description is the opened photo's alt text and "1 of 6" (what a screen reader reads), and the region stays live for moves`, st.desc === 'Synthetic heroGrid photo 1 (1 of 6)' && st.live === 'polite', JSON.stringify(st));
        const names = await page.evaluate(() => [...document.querySelectorAll('dialog.viewer button')].map((b) => b.getAttribute('aria-label')));
        check(`${tag}: the buttons are named`, JSON.stringify(names) === JSON.stringify(['Close photo viewer', 'Previous photo', 'Next photo']), JSON.stringify(names));
        await page.keyboard.press('ArrowRight');
        check(`${tag}: ArrowRight shows the next photo (label and counter follow)`, (await dlg.getAttribute('aria-label')) === 'Photo viewer' && (await page.locator('.viewer-img').getAttribute('alt')) === 'Synthetic heroGrid photo 2' && (await page.locator('.viewer-count').textContent()) === 'Synthetic heroGrid photo 2 (2 of 6)');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        check(`${tag}: ArrowLeft goes back and wraps round to the last photo`, (await page.locator('.viewer-img').getAttribute('alt')) === 'Synthetic heroGrid photo 6');
        await page.keyboard.press('Home');
        await page.keyboard.press('End');
        check(`${tag}: Home and End jump to the ends`, (await page.locator('.viewer-count').textContent()).endsWith('(6 of 6)'));
        // swipe: a synthetic touch pointer drag on the dialog
        const swipe = (dx) => page.evaluate((d) => { const el = document.querySelector('dialog.viewer'); const ev = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', clientX: x, clientY: 300, bubbles: true })); ev('pointerdown', 200); ev('pointerup', 200 + d); }, dx);
        await swipe(-120);
        check(`${tag}: a swipe left shows the next photo`, (await page.locator('.viewer-count').textContent()).endsWith('(1 of 6)'));
        await swipe(120);
        check(`${tag}: a swipe right shows the previous photo`, (await page.locator('.viewer-count').textContent()).endsWith('(6 of 6)'));
        await swipe(20);
        check(`${tag}: a short or sideways drag does nothing`, (await page.locator('.viewer-count').textContent()).endsWith('(6 of 6)'));
        // a swipe that ends on the dark area must not also close the dialog (the browser follows a touch with a click)
        await page.evaluate(() => { const el = document.querySelector('dialog.viewer'); el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 200, clientY: 300, bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientX: 60, clientY: 300, bubbles: true })); el.click(); });
        check(`${tag}: the click that follows a swipe does not close the viewer (a plain click on the dark area still does, below)`, await dlg.isVisible() && (await page.locator('.viewer-count').textContent()).endsWith('(1 of 6)'));
        await page.waitForTimeout(450);
        // a real click on the dark area (outside the photo) closes it and focus goes back to the photo that was opened
        if (!touch) {
          const sb = await page.locator('.viewer-stage').boundingBox();
          await page.mouse.click(sb.x + 6, sb.y + sb.height / 2);
          const back = await page.evaluate(() => ({ open: document.querySelector('dialog.viewer').open, focusHref: document.activeElement?.getAttribute('href'), isFirst: document.activeElement === document.querySelectorAll('a[data-photo]')[0] }));
          check('desktop: a mouse click on the dark area closes the viewer and focus returns to the photo that was opened', !back.open && back.isFirst, JSON.stringify(back));
          await page.locator('a[data-photo]').first().click();
          await page.locator('dialog.viewer').waitFor({ state: 'visible' });
          await page.keyboard.press('End'); await page.keyboard.press('Home');
        }
        // focus trap: tabbing never leaves the dialog
        let escaped = false;
        for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); if (!(await page.evaluate(() => !!document.activeElement?.closest('dialog.viewer')))) escaped = true; }
        for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); if (!(await page.evaluate(() => !!document.activeElement?.closest('dialog.viewer')))) escaped = true; }
        check(`${tag}: Tab and Shift+Tab stay inside the dialog (the page behind is inert)`, !escaped);
        const bg = await page.evaluate(() => { const l = document.querySelector('.share button'); l.focus(); return document.activeElement === l; });
        check(`${tag}: the page behind cannot take focus while it is open`, !bg);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(50);
        const closed = await page.evaluate(() => ({ open: document.querySelector('dialog.viewer').open, back: document.activeElement?.getAttribute('data-photo') !== null && document.activeElement?.tagName === 'A', href: document.activeElement?.getAttribute('href'), lock: document.documentElement.classList.contains('viewer-open') }));
        check(`${tag}: Esc closes it, scrolling is unlocked and focus returns to the photo that was opened`, !closed.open && closed.back && /^\/media\//.test(closed.href) && !closed.lock, JSON.stringify(closed));
        // close button and a click on the dark area
        await page.locator('a[data-photo]').nth(2).focus();
        await page.keyboard.press('Enter');
        await dlg.waitFor({ state: 'visible' });
        check(`${tag}: Enter on a focused photo opens it at that photo`, (await page.locator('.viewer-count').textContent()).endsWith('(3 of 6)'));
        await page.getByRole('button', { name: 'Close photo viewer' }).click();
        const back3 = await page.evaluate(() => document.activeElement === document.querySelectorAll('a[data-photo]')[2]);
        check(`${tag}: the close button closes it and returns focus to photo 3`, !(await dlg.isVisible()) && back3);
        await page.locator('a[data-photo]').nth(1).click({ modifiers: ['Control'] }).catch(() => {});
        await ctx.close();
      }

      // a long alt text (about 250 characters) must not run over the photo at 390 px: the visible caption is clamped to two lines
      {
        const longAlt = ('A synthetic description of a long photo caption written for the test. ').repeat(4).slice(0, 250);
        const pr = await studioPublish([{ ref: 'long', title: 'Zz layout long alt', section: 'news', area: 'churches', author: 'Test Author', body: 'Synthetic text.', photoLayout: 'stack', photos: [{ url: dataUrl(PICS[0]), alt: longAlt }, { url: dataUrl(PICS[1]), alt: 'Second' }] }], '2099-01-03');
        const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/stories/${pr.data.stories?.[0]?.slug}/`);
        await page.locator('a[data-photo]').first().tap();
        await page.locator('dialog.viewer').waitFor({ state: 'visible' });
        await page.waitForTimeout(300);
        const m = await page.evaluate(() => { const c = document.querySelector('.viewer-count').getBoundingClientRect(); const i = document.querySelector('.viewer-img').getBoundingClientRect(); const a = document.querySelector('.viewer-alt'); const pos = document.querySelector('.viewer-pos').getBoundingClientRect(); return { capTop: c.top, capH: c.height, imgBottom: i.bottom, full: document.querySelector('.viewer-count').textContent.length, clamped: a.scrollHeight > a.clientHeight, posText: document.querySelector('.viewer-pos').textContent, posVisible: pos.height > 0 && pos.bottom <= c.bottom + 0.5 }; });
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'viewer-long-alt-390.png') });
        check('a 250-character alt text: the visible alt is clamped to two lines, the "(n of total)" position stays visible below it, the caption does not overlap the photo at 390 px, and the full text is still in the page', m.clamped && m.capH < 62 && /^ \(1 of \d+\)$/.test(m.posText) && m.posVisible && m.capTop >= m.imgBottom - 1 && m.full > 250, JSON.stringify(m));
        // a tap that drifts a little (under the swipe threshold) on the dark area still closes the viewer
        await page.evaluate(() => { const el = document.querySelector('dialog.viewer'); el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 300, bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientX: 120, clientY: 300, bubbles: true })); el.querySelector('.viewer-stage').click(); });
        check('a tap that drifts 20 px on the dark area still closes the viewer (it is not mistaken for a swipe)', !(await page.locator('dialog.viewer').isVisible()));
        await ctx.close();
      }

      // no JavaScript: the photos are plain links to the full image (and the full image loads)
      {
        const ctx = await browser.newContext({ javaScriptEnabled: false });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/stories/${published.get('mosaic/4')}/`);
        const hrefs = await page.locator('a[data-photo]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
        const codes = await Promise.all(hrefs.map(async (h) => (await fetch(BASE + h)).status));
        check('without JavaScript every photo is a link to the full image, and the image loads', hrefs.length === 4 && codes.every((c) => c === 200) && (await page.locator('dialog').count()) === 0, JSON.stringify([hrefs.length, codes]));
        await ctx.close();
      }

      // a story with no layout: the lead photo and the row under the text open in the viewer too
      {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/stories/${published.get('one/4')}/`);
        const n = await page.locator('a[data-photo]').count();
        await page.locator('.article > figure a[data-photo]').click();
        await page.locator('dialog.viewer').waitFor({ state: 'visible' });
        const lead = await page.evaluate(() => document.querySelector('.viewer-count').textContent);
        await page.keyboard.press('Escape');
        await page.locator('.gallery a').nth(1).click();
        const second = await page.evaluate(() => document.querySelector('.viewer-count').textContent);
        check('a "One hero" story: the lead photo and the photos under the text all open in the viewer, in order', n === 4 && /\(1 of 4\)$/.test(lead) && /\(3 of 4\)$/.test(second), JSON.stringify([n, lead, second]));
        await page.goto(`${BASE}/stories/${published.get('one/4')}/`); // fresh page, focus at the top
        for (let i = 0; i < 60 && !(await page.evaluate(() => document.activeElement?.matches('.article > figure > a'))); i++) await page.keyboard.press('Tab'); // real keyboard focus, so :focus-visible applies
        const ring = await page.evaluate(() => { const a = document.querySelector('.article > figure > a'); const r = a.getBoundingClientRect(); const cs = getComputedStyle(a); return { w: r.width, h: r.height, outline: cs.outlineStyle, ow: cs.outlineWidth }; });
        check('a "One hero" lead link has a real box and a visible keyboard focus outline', ring.w > 100 && ring.h > 50 && ring.outline !== 'none' && parseFloat(ring.ow) > 0, JSON.stringify(ring));
        await ctx.close();
      }
      // the same One hero story looks the same before and after the script wraps its lead photo in a link
      {
        const shot = async (js) => {
          const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: js, reducedMotion: 'reduce' });
          const page = await ctx.newPage();
          await page.goto(`${BASE}/stories/${published.get('one/4')}/`, { waitUntil: 'load' });
          await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => {})))).catch(() => {});
          await page.waitForTimeout(200);
          const box = await page.locator('.article > figure').first().boundingBox();
          const buf = await page.screenshot({ clip: box });
          await ctx.close();
          return { buf, box };
        };
        const [off, on] = [await shot(false), await shot(true)];
        check('a "One hero" story\'s lead figure is pixel-identical with and without JavaScript (same box, same pixels)', off.box.width === on.box.width && off.box.height === on.box.height && Buffer.compare(off.buf, on.buf) === 0, `${JSON.stringify(off.box)} vs ${JSON.stringify(on.box)} bytes ${off.buf.length}/${on.buf.length}`);
      }

      // axe, when a copy of axe-core is available (never installed into this repo)
      if (process.env.AXE_JS && fs.existsSync(process.env.AXE_JS)) {
        const axeSrc = fs.readFileSync(process.env.AXE_JS, 'utf8');
        const scan = async (page) => (await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(' '), targets: v.nodes.map((n) => n.target.join(' ')) })))) ;
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await ctx.newPage();
        const results = {};
        for (const [name, key, open] of [['a story with no layout (the reference)', 'one/4', false], ['Hero + grid, viewer closed', 'heroGrid/4', false], ['Mosaic, viewer closed', 'mosaic/6', false], ['Stack, viewer closed', 'stack/3', false], ['Hero + grid, viewer OPEN', 'heroGrid/4', true]]) {
          await page.goto(`${BASE}/stories/${published.get(key)}/`);
          await page.addScriptTag({ content: axeSrc });
          if (open) { await page.locator('a[data-photo]').nth(1).click(); await page.locator('dialog.viewer').waitFor({ state: 'visible' }); }
          results[name] = await scan(page);
        }
        const base0 = results[Object.keys(results)[0]];
        const baseRule = new Map(base0.map((v) => [v.id, v]));
        for (const [name, v] of Object.entries(results)) info(`axe: ${name}: ${v.length ? v.map((x) => `${x.id} (${x.impact}, ${x.nodes} nodes) at ${x.target}`).join('; ') : 'no violations'}`);
        // new = a rule the plain page does not have, more nodes for a rule than the plain page has, or a node whose target the plain page does not have
        const fresh = Object.entries(results).flatMap(([name, v]) => v.flatMap((x) => {
          const b = baseRule.get(x.id);
          if (!b) return [`${name}: ${x.id} (new rule)`];
          const out = [];
          if (x.nodes > b.nodes) out.push(`${name}: ${x.id} has ${x.nodes} nodes, the plain page ${b.nodes}`);
          for (const t of x.targets) if (!b.targets.includes(t)) out.push(`${name}: ${x.id} at ${t}`);
          return out;
        }));
        check('axe scan: no violation on a layout page or with the viewer open that the plain story page does not already have', fresh.length === 0, fresh.join(' | '));
        await ctx.close();
      } else {
        skip('axe scan', 'set AXE_JS to the path of axe.min.js (axe-core is not a dependency of this repo)');
      }
      await browser.close();
    }
  }
  if (browserSkipReason) skip('browser checks (overflow, viewer, no-JavaScript, axe)', browserSkipReason);
} catch (err) {
  console.log('FAIL  unexpected error: ' + (err && err.stack ? err.stack : err));
  fails++;
} finally {
  await stopServer();
  await cleanup();
}
console.log(fails ? `\n${fails} check(s) FAILED` : `\nAll checks passed${skips ? ` (${skips} group(s) skipped)` : ''}`);
process.exit(fails ? 1 : 0);
