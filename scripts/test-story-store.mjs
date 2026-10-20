#!/usr/bin/env node
// End-to-end check of the story tables, the sync from the built site and GET /media (issue 26, epic 25 step 1).
// It runs the BUILT server (dist/server/entry.mjs) twice against a throwaway data folder. Synthetic data only.
//   npm run build
//   SCRATCH=/tmp/imc-story-store node scripts/test-story-store.mjs        # run from the repo root
// SCRATCH is created fresh (an existing folder is removed first) and deleted at the end unless KEEP=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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
const PORT = Number(process.env.PORT || 4531);
const BASE = `http://localhost:${PORT}`;

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- server ----
let server;
let log = [];
const allLog = []; // every server log line of every part (never reset), for the leak check
async function startServer(extraEnv = {}) {
  log = [];
  server = spawn('node', ['dist/server/entry.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production', STORY_SYNC_TEST: '1', ...extraEnv },
  });
  const sink = (d) => { const lines = String(d).split('\n').filter(Boolean); log.push(...lines); allLog.push(...lines); };
  server.stdout.on('data', sink);
  server.stderr.on('data', sink);
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/'); return; } catch { await sleep(250); } }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill();
  await done;
  server = undefined;
}
/** The first /media request after a start kicks the import off; wait for its log line. */
async function waitForSync() {
  await fetch(BASE + '/media/stories/none/' + '0'.repeat(64) + '.jpg');
  for (let i = 0; i < 80; i++) {
    const line = log.find((l) => l.includes('[stories] mirrored the build') || l.includes('[stories] sync failed'));
    if (line) return line;
    await sleep(100);
  }
  return '';
}
// The synthetic story of part 5 (zz-test-*) must never survive a run: it would be committed and published.
// Removes any such file from the sources and from dist; rebuilds the site when it may have been built in.
const SYNTHETIC_DIRS = ['src/content/stories', 'public/images', 'dist/client/images'].map((d) => path.join(ROOT, d));
function removeSynthetic() {
  let sources = false, dist = false;
  for (const dir of SYNTHETIC_DIRS) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.startsWith('zz-test-')) continue;
      fs.rmSync(path.join(dir, f), { force: true });
      if (dir.includes(`${path.sep}dist${path.sep}`)) dist = true; else sources = true;
    }
  }
  return { sources, dist };
}
function restoreSite() {
  const { sources, dist } = removeSynthetic();
  if (sources || dist) {
    console.log('Removed leftover zz-test-* files; rebuilding the site so dist/ no longer has the synthetic story.');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  }
}
async function cleanup() {
  await stopServer().catch(() => {});
  try { restoreSite(); } catch (err) { console.error('Could not restore the site, run npm run build:', err.message); }
  if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)));

restoreSite();

try {
  // ================= part 0: migration 011 on a database that already has data =================
  {
    const { openDatabase, runMigrations, readMigrationsFromDir } = await import(path.join(ROOT, 'src/lib/db/db-core.mjs'));
    const all = readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations'));
    const before = all.filter((m) => m.name < '011');
    check('migrations 001-010 are present and 011 is the new one', before.length === 10 && all.some((m) => m.name === '011_stories.sql'));
    const dir = path.join(SCRATCH, 'migrate');
    const db = openDatabase(dir);
    runMigrations(db, before);
    const now = Date.now();
    db.prepare("INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (1, 'old.editor@example.test', 'Old Editor', 'editor', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO drafts (id, status, source, title, section, body, created_at, updated_at) VALUES (7, 'new', 'form', 'Old draft', 'news', 'Body', ?, ?)").run(now, now);
    db.prepare("INSERT INTO draft_photos (draft_id, path, ext, alt, position, created_at) VALUES (7, 'draft-7/a.jpg', 'jpg', 'alt', 0, ?)").run(now);
    const snap = () => ({
      users: db.prepare('SELECT * FROM users').all(), drafts: db.prepare('SELECT * FROM drafts').all(), photos: db.prepare('SELECT * FROM draft_photos').all(),
    });
    const a = JSON.stringify(snap());
    const applied = runMigrations(db, all);
    check('migration 011 applies on a database with drafts and accounts', applied.join() === '011_stories.sql', applied.join());
    check('migration 011 loses no account, draft or draft photo', JSON.stringify(snap()) === a);
    const tables = db.prepare("SELECT name, strict FROM pragma_table_list WHERE name IN ('stories', 'story_photos')").all();
    check('stories and story_photos are STRICT tables', tables.length === 2 && tables.every((t) => Number(t.strict) === 1), JSON.stringify(tables));
    const idx = db.prepare("SELECT name, \"unique\" AS u FROM pragma_index_list('stories')").all();
    check('unique index on slug and a (section, area, date) index exist', idx.some((i) => i.name === 'stories_slug' && Number(i.u) === 1) && idx.some((i) => i.name === 'stories_listing'), JSON.stringify(idx));
    const cols = db.prepare("SELECT group_concat(name) AS c FROM pragma_index_info('stories_listing')").get().c;
    check('listing index covers section, area, date', cols === 'section,area,date', cols);
    let dup = false;
    const ins = "INSERT INTO stories (slug, title, section, author, date, published_at, updated_at) VALUES ('dup', 't', 'news', 'a', '2026-01-01', 1, 1)";
    db.exec(ins);
    try { db.exec(ins); } catch { dup = true; }
    check('a second story with the same slug is refused', dup);
    db.close();
  }

  // ================= part 1: first start =================
  const builtIds = fs.readdirSync(path.join(ROOT, 'src/content/stories')).filter((f) => f.endsWith('.md')).map((f) => {
    const raw = fs.readFileSync(path.join(ROOT, 'src/content/stories', f), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    const fm = parseYaml(m[1]);
    return { id: f.replace(/\.md$/, ''), fm, body: m[2] };
  }).filter((s) => !s.fm.draft);
  check('the repo has stories to mirror', builtIds.length > 0, String(builtIds.length));

  await startServer();
  const line1 = await waitForSync();
  check('first start mirrored the build and hashed its photos', /mirrored the build: \d+ new.* [1-9]\d* photos hashed, [1-9]\d* copied/.test(line1), line1);
  const rows = q('SELECT * FROM stories ORDER BY slug');
  check('every built story is in stories', rows.length === builtIds.length && builtIds.every((s) => rows.some((r) => r.slug === s.id)), `${rows.length} vs ${builtIds.length}`);

  const dateOf = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const nul = (v) => (v === undefined ? null : v);
  let identical = true;
  const diffs = [];
  for (const s of builtIds) {
    const r = rows.find((x) => x.slug === s.id);
    if (!r) { identical = false; continue; }
    const f = s.fm;
    const want = {
      title: f.title, dek: nul(f.dek), section: f.section, area: nul(f.area), story_column: nul(f.column), author: f.author, author_title: nul(f.authorTitle),
      church: nul(f.church), date: dateOf(f.date), image: nul(f.image), image_alt: nul(f.imageAlt), photo_credit: nul(f.photoCredit),
      photos: JSON.stringify(f.photos ?? []), photo_alts: JSON.stringify(f.photoAlts ?? []), featured: f.featured ? 1 : 0, draft: 0,
      body: s.body.trim(), status: 'live', source: 'git',
    };
    for (const [k, v] of Object.entries(want)) {
      const got = k === 'body' ? String(r[k]).trim() : r[k];
      if (got !== v) { identical = false; diffs.push(`${s.id}.${k}: ${JSON.stringify(got)} != ${JSON.stringify(v)}`); }
    }
    if (r.draft_id !== null || r.published_by !== null) { identical = false; diffs.push(`${s.id}: draft_id/published_by not null`); }
  }
  check('every field of every story is identical to the Markdown', identical, diffs.slice(0, 3).join(' | '));

  // photos: rows, files on disk, served with the right type and headers
  let photosOk = true;
  let photoCount = 0;
  const why = [];
  for (const s of builtIds) {
    const wantSrc = [s.fm.image, ...(s.fm.photos ?? [])].filter(Boolean);
    const r = rows.find((x) => x.slug === s.id);
    const pr = q('SELECT * FROM story_photos WHERE story_id = ? ORDER BY position', r.id);
    if (pr.length !== wantSrc.length) { photosOk = false; why.push(`${s.id}: ${pr.length} rows for ${wantSrc.length} photos`); continue; }
    for (let i = 0; i < pr.length; i++) {
      photoCount++;
      const src = fs.readFileSync(path.join(ROOT, 'public', wantSrc[i]));
      const p = pr[i];
      if (p.path !== `stories/${s.id}/${sha(src)}.jpg` || p.sha256 !== sha(src) || p.position !== i || p.url !== null) { photosOk = false; why.push(`${s.id}#${i}: row ${p.path}`); continue; }
      if (!fs.existsSync(path.join(DATA_DIR, 'media', p.path))) { photosOk = false; why.push(`${s.id}#${i}: file missing`); continue; }
      const res = await fetch(`${BASE}/media/${p.path}`);
      const body = Buffer.from(await res.arrayBuffer());
      const ok = res.status === 200 && res.headers.get('content-type') === 'image/jpeg' &&
        res.headers.get('cache-control') === 'public, max-age=31536000, immutable' && res.headers.get('x-content-type-options') === 'nosniff' && sha(body) === sha(src);
      if (!ok) { photosOk = false; why.push(`${s.id}#${i}: ${res.status} ${res.headers.get('content-type')} ${res.headers.get('cache-control')}`); }
    }
    if (pr[0] && s.fm.image && pr[0].kind !== 'lead') { photosOk = false; why.push(`${s.id}: first photo is not the lead`); }
    if (pr[0] && s.fm.image && pr[0].alt !== (s.fm.imageAlt ?? '')) { photosOk = false; why.push(`${s.id}: lead alt`); }
  }
  check(`all ${photoCount} photos are rows, files and served from /media with the right type and cache headers`, photosOk && photoCount > 0, why.slice(0, 3).join(' | '));
  const head = await fetch(`${BASE}/media/${q('SELECT path FROM story_photos LIMIT 1')[0].path}`, { method: 'HEAD' });
  check('HEAD works and has no body', head.status === 200 && head.headers.get('content-type') === 'image/jpeg' && (await head.text()) === '');

  // public pages still come from the build
  const home = await (await fetch(BASE + '/')).text();
  check('public pages are unchanged (still the build, no /media links)', home.includes('/images/stories/') && !home.includes('/media/'));

  // ---- traversal and other refusals ----
  const bad = [
    '/media/../imconnected.db', '/media/..%2fimconnected.db', '/media/%2e%2e/imconnected.db', '/media/%2E%2E%2Fimconnected.db', '/media/stories/../../imconnected.db',
    '/media/stories/..%2f..%2fimconnected.db', '/media/stories/..%5c..%5cimconnected.db', '/media/..\\imconnected.db', '/media/%252e%252e/imconnected.db',
    '/media//etc/passwd', '/media/%2fetc%2fpasswd', '/media/%00.jpg', '/media/imconnected.db', '/media/imconnected.db-wal', '/media/imconnected.jpg',
    '/media/stories/', '/media/', '/media', '/media/stories/x.txt', '/media/.hidden.jpg', '/media/stories/%2e%2e/%2e%2e/etc/passwd.jpg',
  ];
  const odd = [];
  for (const u of bad) {
    const res = await fetch(BASE + u, { redirect: 'manual' }).catch(() => null);
    const t = res ? await res.text() : '';
    if (!res || res.status !== 404 || t.includes('SQLite format') || t.includes('root:')) odd.push(`${u} -> ${res?.status}`);
  }
  check('traversal attempts (plain, encoded, double-encoded, backslash, absolute) all return 404', odd.length === 0, odd.join(' | '));
  // raw request lines the fetch client would normalise away
  const raw = await new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const s = net.connect(PORT, '127.0.0.1', () => s.write('GET /media/../imconnected.db HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let out = '';
      s.on('data', (d) => (out += d));
      s.on('close', () => resolve(out));
    });
  });
  check('an unnormalised /media/../imconnected.db request line does not return the database', /^HTTP\/1\.1 404/.test(raw) && !raw.includes('SQLite format'), raw.slice(0, 80));
  // a non-image file placed inside the media folder (and a symlink out of it) is still refused
  fs.writeFileSync(path.join(DATA_DIR, 'media', 'secret.txt'), 'nope');
  fs.symlinkSync(DB_FILE, path.join(DATA_DIR, 'media', 'link.jpg'));
  const t1 = await fetch(BASE + '/media/secret.txt');
  const t2 = await fetch(BASE + '/media/link.jpg');
  check('only jpg/png/webp are served, and a symlink out of the folder is refused', t1.status === 404 && t2.status === 404, `${t1.status} ${t2.status}`);
  fs.rmSync(path.join(DATA_DIR, 'media', 'secret.txt'));
  fs.rmSync(path.join(DATA_DIR, 'media', 'link.jpg'));
  const post = await fetch(BASE + '/media/x.jpg', { method: 'POST' });
  check('POST /media is not allowed', post.status === 404 || post.status === 405, String(post.status));

  // ================= part 2: second start changes nothing =================
  const dump = () => JSON.stringify([q('SELECT * FROM stories ORDER BY id'), q('SELECT * FROM story_photos ORDER BY id')]);
  const mediaState = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.startsWith('.')) out.push(`${p}:${fs.statSync(p).mtimeMs}:${fs.statSync(p).size}`); } };
    walk(path.join(DATA_DIR, 'media'));
    return out.sort().join('\n');
  };
  const dump1 = dump(), media1 = mediaState();
  await stopServer();
  await sleep(1100); // so a rewrite could not hide behind an equal timestamp
  await startServer();
  const line2 = await waitForSync();
  check('second start: nothing new, updated, copied or hashed', /0 new, 0 updated, \d+ unchanged.* 0 photos hashed, 0 copied/.test(line2), line2);
  check('second start: the stories and story_photos tables are byte-identical (updated_at included)', dump() === dump1);
  check('second start: no photo file was copied again or touched', mediaState() === media1);

  // photos touched (new mtimes, same bytes): nothing is hashed or rewritten
  await stopServer();
  const photoDir = path.join(ROOT, 'dist/client/images/stories');
  const later = new Date(Date.now() + 60_000);
  let touched = 0;
  const touch = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) touch(p); else { fs.utimesSync(p, later, later); touched++; } } };
  touch(photoDir);
  await startServer();
  const line2b = await waitForSync();
  check(`start after touching ${touched} built photos (new build marker): photos are re-hashed read-only, none copied, nothing updated`, /0 new, 0 updated, \d+ unchanged.* [1-9]\d* photos hashed, 0 copied/.test(line2b), line2b);
  check('...and the tables and media files are still identical', dump() === dump1 && mediaState() === media1);
  // a media file that went missing is restored (and only that one is hashed again)
  await stopServer();
  const gone = q('SELECT path FROM story_photos ORDER BY id LIMIT 1')[0].path;
  fs.rmSync(path.join(DATA_DIR, 'media', gone));
  await startServer();
  const line2c = await waitForSync();
  check('a missing media file is copied back, hashing only that photo (marker unchanged)', /, 1 photos hashed, 1 copied/.test(line2c) && fs.existsSync(path.join(DATA_DIR, 'media', gone)), line2c);

  // same-size, different-content replacement at the same path, after a new build
  await stopServer();
  const lead = q("SELECT s.slug, s.image, p.path, p.sha256 FROM stories s JOIN story_photos p ON p.story_id = s.id WHERE p.position = 0 AND p.kind = 'lead' ORDER BY s.slug LIMIT 1")[0];
  const builtFile = path.join(ROOT, 'dist/client', lead.image);
  const original = fs.readFileSync(builtFile);
  try {
    const swapped = Buffer.from(original);
    swapped[Math.floor(swapped.length / 2)] ^= 0xff; // same size, different bytes
    fs.writeFileSync(builtFile, swapped);
    fs.utimesSync(builtFile, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000)); // a "new build": the marker changes
    await startServer();
    const line2d = await waitForSync();
    const after = q('SELECT sha256, path FROM story_photos WHERE path LIKE ? AND position = 0', `stories/${lead.slug}/%`)[0];
    check('same-size replacement at the same path is picked up after a new build', after.sha256 === sha(swapped) && /[1-9]\d* updated/.test(line2d) && /[1-9]\d* copied/.test(line2d), `${line2d} ${after.sha256}`);
    const served = Buffer.from(await (await fetch(`${BASE}/media/${after.path}`)).arrayBuffer());
    check('...and /media serves the new bytes', sha(served) === sha(swapped));
    await stopServer();
    fs.writeFileSync(builtFile, original);
    fs.utimesSync(builtFile, new Date(Date.now() + 240_000), new Date(Date.now() + 240_000));
    await startServer();
    const line2e = await waitForSync();
    check('swapping the original back is picked up too', q('SELECT sha256 FROM story_photos WHERE path LIKE ? AND position = 0', `stories/${lead.slug}/%`)[0].sha256 === lead.sha256, line2e);
    await stopServer();
    await startServer();
    const line2f = await waitForSync();
    check('same path, size and marker: nothing hashed, copied or updated', /0 new, 0 updated, \d+ unchanged.* 0 photos hashed, 0 copied/.test(line2f), line2f);
  } finally {
    fs.writeFileSync(builtFile, original);
  }

  // ================= part 3: unpublished stories stay unpublished =================
  await stopServer();
  const target = builtIds[0].id;
  run("INSERT INTO drafts (status, source, title, section, slug, unpublished_at, created_at, updated_at) VALUES ('published', 'editor', 'x', 'news', ?, ?, 1, 1)", target, Date.now());
  run("INSERT INTO stories (slug, title, section, author, date, source, published_at, updated_at) VALUES ('gone-from-build', 't', 'news', 'a', '2026-01-01', 'git', 1, 1)");
  await startServer();
  const line3 = await waitForSync();
  const st = Object.fromEntries(q('SELECT slug, status FROM stories').map((r) => [r.slug, r.status]));
  check('a story the dashboard unpublished is mirrored as unpublished', st[target] === 'unpublished', `${st[target]} :: ${line3}`);
  check('a mirrored story that left the build becomes unpublished', st['gone-from-build'] === 'unpublished');
  check('the other stories stay live', builtIds.slice(1).every((s) => st[s.id] === 'live'));
  await stopServer();
  run('UPDATE drafts SET unpublished_at = NULL WHERE slug = ?', target);
  await startServer();
  await waitForSync();
  check('republishing in the dashboard brings the mirrored story back to live', q('SELECT status FROM stories WHERE slug = ?', target)[0].status === 'live');

  // ================= part 4: a story that always fails stops after 5 passes =================
  await stopServer();
  const failing = builtIds[builtIds.length - 1].id;
  await startServer({ STORY_SYNC_TEST_FAIL_SLUG: failing, STORY_SYNC_TEST_RETRY_MS: '300' });
  await fetch(BASE + '/media/stories/none/' + '0'.repeat(64) + '.jpg');
  const passes = () => log.filter((l) => l.includes('[stories] mirrored the build')).length;
  for (let i = 0; i < 100 && passes() < 5; i++) await sleep(100);
  await sleep(1500); // longer than several retry waits
  for (let i = 0; i < 5; i++) await fetch(BASE + '/media/stories/none/' + '0'.repeat(64) + '.jpg'); // every call re-checks the sync
  await sleep(800);
  check('a story that always fails is attempted exactly 5 passes, then no timer or request starts another', passes() === 5 && log.some((l) => l.includes('pass 5 of 5')), `passes=${passes()}`);
  check('...and the other stories were still mirrored', q('SELECT COUNT(*) AS n FROM stories WHERE slug != ? AND source = ?', failing, 'git')[0].n >= builtIds.length - 1);

  // ================= part 5: a lead image outside images/stories is tracked by the build marker =================
  // Needs a real build with one extra synthetic story; the extra files are removed and the site rebuilt afterwards.
  await stopServer();
  const extraMd = path.join(ROOT, 'src/content/stories/zz-test-marker.md');
  const extraPub = path.join(ROOT, 'public/images/zz-test-marker.png');
  const extraDist = path.join(ROOT, 'dist/client/images/zz-test-marker.png');
  const pngLike = (fill) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, fill)]);
  restoreSite(); // a stale synthetic story from an interrupted earlier run, in the sources or in dist
  try {
    fs.writeFileSync(extraPub, pngLike(1));
    fs.writeFileSync(extraMd, '---\ntitle: "Synthetic marker test story"\nsection: news\narea: churches\nauthor: "Test Author"\ndate: 2026-10-01\nimage: "/images/zz-test-marker.png"\nimageAlt: "A synthetic test image"\nphotos: []\nfeatured: false\ndraft: false\n---\nSynthetic text for the build marker test.\n');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    await startServer();
    await waitForSync();
    const row = () => q("SELECT p.sha256, p.path FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = 'zz-test-marker'")[0];
    check('a story whose lead image lives at /images/<name>.png (outside stories/) is mirrored', row()?.sha256 === sha(pngLike(1)), JSON.stringify(row()));
    await stopServer();
    const swapped = pngLike(2);
    fs.writeFileSync(extraDist, swapped); // same size, different bytes, new mtime; the Markdown is untouched
    const t = new Date(Date.now() + 300_000);
    fs.utimesSync(extraDist, t, t);
    await startServer();
    const line5 = await waitForSync();
    check('a same-size swap of that image is picked up after a new build', row()?.sha256 === sha(swapped) && /, [1-9]\d* copied/.test(line5), `${line5} ${JSON.stringify(row())}`);
    const served = Buffer.from(await (await fetch(`${BASE}/media/${row().path}`)).arrayBuffer());
    check('...and /media serves the new bytes with the png type', sha(served) === sha(swapped));
    await stopServer();
  } finally {
    removeSynthetic();
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' }); // put dist/ back as it was
  }
  await startServer();
  await waitForSync();

  const leaked = allLog.filter((l) => /[\w.+-]+@[\w-]+\.[a-z]{2,}|password|token/i.test(l));
  check('no server log line of any part has contact details or secrets', leaked.length === 0, leaked.join(' | '));
} catch (err) {
  console.error('ERROR', err);
  fails++;
} finally {
  await cleanup();
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
