#!/usr/bin/env node
// End-to-end check of the story tables, the ONE-TIME adoption of the built site (epic 25 step 4, replacing the step 1
// mirror) and GET /media. It runs the BUILT server (dist/server/entry.mjs) several times against a throwaway data
// folder, and rebuilds the site with synthetic stories (zz-test-*, so it never depends on how many real stories are live).
// Synthetic data only.
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
/** Wait for the one-time adoption of this start to log its result (or to be skipped because the flag is set). */
async function waitForAdoption() {
  await fetch(BASE + '/media/stories/none/' + '0'.repeat(64) + '.jpg');
  await fetch(BASE + '/').catch(() => {}); // any public request starts it
  for (let i = 0; i < 100; i++) {
    const line = log.find((l) => l.includes('[stories] adopting the build') || l.includes('[stories] adoption failed') || l.includes('could not be adopted'));
    if (line) return line;
    await sleep(100);
  }
  return '';
}
const adoptedFlag = () => q("SELECT value FROM app_state WHERE key = 'git_adopted_at'")[0]?.value ?? null;
// The synthetic stories (zz-test-*, also with a date in front: 2099-01-01-zz-test-*) must never survive a run: they would be
// committed and published. This removes any such file from the sources and from dist, and rebuilds the site when one may
// have been built in. The same patterns are in .gitignore and .dockerignore.
const SYNTHETIC_DIRS = ['src/content/stories', 'public/images', 'dist/client/images'].map((d) => path.join(ROOT, d));
const SYNTHETIC_PHOTO_DIRS = ['public/images/stories', 'dist/client/images/stories'].map((d) => path.join(ROOT, d));
const isSynthetic = (f) => /^(\d{4}-\d{2}-\d{2}-)?zz-test-/.test(f);
function removeSynthetic() {
  let sources = false, dist = false;
  for (const dir of [...SYNTHETIC_DIRS, ...SYNTHETIC_PHOTO_DIRS]) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!isSynthetic(f)) continue;
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      if (dir.includes(`${path.sep}dist${path.sep}`)) dist = true; else sources = true;
    }
  }
  return { sources, dist };
}
/** Remove only the "newer build" story (the base stories stay for the later parts). */
function removeNewer() {
  for (const f of ['src/content/stories/zz-test-newer.md', 'public/images/zz-test-newer.png', 'dist/client/images/zz-test-newer.png']) fs.rmSync(path.join(ROOT, f), { force: true });
}
const build = () => execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
function restoreSite() {
  const { sources, dist } = removeSynthetic();
  if (sources || dist) {
    console.log('Removed leftover zz-test-* files; rebuilding the site so dist/ no longer has the synthetic story.');
    build();
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
  // ================= part 0: migrations 011, 012 and 015 on a database that already has data =================
  {
    const { openDatabase, runMigrations, readMigrationsFromDir } = await import(path.join(ROOT, 'src/lib/db/db-core.mjs'));
    const all = readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations'));
    const before = all.filter((m) => m.name < '011');
    check('migrations 001-010 are present and 011, 012 and 015 exist', before.length === 10 && ['011_stories.sql', '012_story_holds.sql', '015_stories_source_of_truth.sql'].every((n) => all.some((m) => m.name === n)));
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
    const applied = runMigrations(db, all.filter((m) => m.name < '012'));
    check('migration 011 applies on a database with drafts and accounts', applied.join() === '011_stories.sql', applied.join());
    check('migration 011 loses no account, draft or draft photo', JSON.stringify(snap()) === a);
    const tables = db.prepare("SELECT name, strict FROM pragma_table_list WHERE name IN ('stories', 'story_photos')").all();
    check('stories and story_photos are STRICT tables', tables.length === 2 && tables.every((t) => Number(t.strict) === 1), JSON.stringify(tables));
    const idx = db.prepare("SELECT name, \"unique\" AS u FROM pragma_index_list('stories')").all();
    check('unique index on slug and a (section, area, date) index exist', idx.some((i) => i.name === 'stories_slug' && Number(i.u) === 1) && idx.some((i) => i.name === 'stories_listing'), JSON.stringify(idx));
    let dup = false;
    const ins = "INSERT INTO stories (slug, title, section, author, date, published_at, updated_at) VALUES ('dup', 't', 'news', 'a', '2026-01-01', 1, 1)";
    db.exec(ins);
    try { db.exec(ins); } catch { dup = true; }
    check('a second story with the same slug is refused', dup);
    db.prepare("INSERT INTO drafts (id, status, source, title, section, body, slug, published_commit, unpublished_at, created_at, updated_at) VALUES (8, 'in_review', 'editor', 'Unpublished long ago', 'news', 'Body', 'old-unpublished', 'abc', 5000, ?, ?)").run(now, now);
    db.prepare("INSERT INTO drafts (id, status, source, title, section, body, slug, published_commit, created_at, updated_at) VALUES (9, 'published', 'editor', 'Live one', 'news', 'Body', 'still-live', 'abc', ?, ?)").run(now, now);
    for (const slug of ['old-unpublished', 'still-live', 'held-one']) db.prepare("INSERT INTO stories (slug, title, section, author, date, published_at, updated_at) VALUES (?, 't', 'news', 'a', '2026-01-01', 1, 1)").run(slug);
    const before12 = JSON.stringify([db.prepare('SELECT * FROM users').all(), db.prepare('SELECT * FROM drafts').all(), db.prepare('SELECT slug, title FROM stories').all()]);
    const applied12 = runMigrations(db, all.filter((m) => m.name <= '012_story_holds.sql'));
    check('migration 012 applies on a database with stories, drafts and accounts, and loses nothing', applied12.join() === '012_story_holds.sql' && JSON.stringify([db.prepare('SELECT * FROM users').all(), db.prepare('SELECT * FROM drafts').all(), db.prepare('SELECT slug, title FROM stories').all()]) === before12, applied12.join());
    db.prepare("INSERT INTO story_holds (slug, build_marker, unpublish_sha, created_at) VALUES ('held-one', NULL, ?, 777)").run('a'.repeat(40));
    // migration 015, on the step-3 state
    const before15 = JSON.stringify([db.prepare('SELECT * FROM users').all(), db.prepare('SELECT * FROM drafts').all(), db.prepare('SELECT slug, title, source, status FROM stories').all(), db.prepare('SELECT * FROM story_holds').all()]);
    const applied15 = runMigrations(db, all.filter((m) => m.name <= '015_stories_source_of_truth.sql'));
    check('migration 015 applies on the step-3 state and loses nothing', applied15.at(-1) === '015_stories_source_of_truth.sql' && JSON.stringify([db.prepare('SELECT * FROM users').all(), db.prepare('SELECT * FROM drafts').all(), db.prepare('SELECT slug, title, source, status FROM stories').all(), db.prepare('SELECT * FROM story_holds_retired').all()]) === before15, applied15.join());
    const ed = Object.fromEntries(db.prepare('SELECT slug, edited_at FROM stories').all().map((r) => [r.slug, r.edited_at]));
    check('...stories unpublished or held in the dashboard get edited_at; untouched ones keep NULL', Number(ed['old-unpublished']) === 5000 && Number(ed['held-one']) === 777 && ed['still-live'] === null && ed.dup === null, JSON.stringify(ed));
    // the guard is active from the moment 015 is applied, before any adoption
    let refused = false;
    try { db.prepare("UPDATE stories SET title = 'old style write' WHERE slug = 'dup'").run(); } catch { refused = true; }
    let allowed = true;
    try { db.prepare("UPDATE stories SET title = 'new style write', rev = rev + 1 WHERE slug = 'dup'").run(); } catch { allowed = false; }
    check('on a NOT yet adopted database, an old-style UPDATE of a story (no rev bump) is refused and a rev-bumping one is allowed', refused && allowed && db.prepare("SELECT title FROM stories WHERE slug = 'dup'").get().title === 'new style write' && db.prepare("SELECT COUNT(*) n FROM app_state").get().n === 0);
    const st = db.prepare("SELECT name, \"notnull\" AS nn FROM pragma_table_info('app_state')").all().map((r) => r.name).join();
    check('app_state(key, value, updated_at) exists and starts empty', st === 'key,value,updated_at' && db.prepare('SELECT COUNT(*) AS n FROM app_state').get().n === 0, st);
    db.close();
  }

  // ---- synthetic base stories: six stories in the build, whatever the real content is today ----
  const WORDS = ['one', 'two', 'three', 'four', 'five', 'six'];
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(80, 5), Buffer.from([0xff, 0xd9])]);
  fs.mkdirSync(path.join(ROOT, 'public/images/stories/2099-01-06-zz-test-base-six'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'public/images/stories/2099-01-06-zz-test-base-six/photo-1.jpg'), JPG);
  WORDS.forEach((w, i) => {
    const photo = i === 5 ? `image: "/images/stories/2099-01-06-zz-test-base-six/photo-1.jpg"\nimageAlt: "A synthetic picture"\n` : '';
    fs.writeFileSync(path.join(ROOT, `src/content/stories/2099-01-0${i + 1}-zz-test-base-${w}.md`), `---\ntitle: "Zz test base ${w}"\nsection: news\narea: churches\nauthor: "Test Author"\ndate: 2099-01-0${i + 1}\n${photo}featured: false\ndraft: false\n---\nSynthetic story number ${w}, written by the test. It has a few made-up words to make a body.\n`);
  });
  build();

  // ================= part 1: first start adopts the build =================
  const builtIds = fs.readdirSync(path.join(ROOT, 'src/content/stories')).filter((f) => f.endsWith('.md')).map((f) => {
    const raw = fs.readFileSync(path.join(ROOT, 'src/content/stories', f), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    const fm = parseYaml(m[1]);
    return { id: f.replace(/\.md$/, ''), fm, body: m[2] };
  }).filter((s) => !s.fm.draft);
  const synth = builtIds.filter((s) => /^2099-01-0\d-zz-test-base-/.test(s.id));
  check('the repo has stories to adopt', builtIds.length > 0, String(builtIds.length));

  await startServer();
  const line1 = await waitForAdoption();
  check('first start adopted the build and hashed and copied its photos', /adopting the build: \d+ new.* [1-9]\d* photos hashed, [1-9]\d* copied/.test(line1), line1);
  check('...and recorded git_adopted_at in app_state', !!adoptedFlag());
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
    if (r.draft_id !== null || r.published_by !== null || r.edited_at !== null) { identical = false; diffs.push(`${s.id}: draft_id/published_by/edited_at not null`); }
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
  }
  check(`all ${photoCount} photos are rows, files and served from /media with the right type and cache headers`, photosOk && photoCount > 0, why.slice(0, 3).join(' | '));
  const head = await fetch(`${BASE}/media/${q('SELECT path FROM story_photos LIMIT 1')[0].path}`, { method: 'HEAD' });
  check('HEAD works and has no body', head.status === 200 && head.headers.get('content-type') === 'image/jpeg' && (await head.text()) === '');
  const home = await (await fetch(BASE + '/')).text();
  check('public pages are served from the table (/media photo links, no /images links)', home.includes('/media/stories/') && !home.includes('/images/stories/'));
  // an old newsletter link: the static archive file answers while it is in the build; the 301 answers for one that is not
  const oldRow = q("SELECT s.slug, s.image, p.path FROM stories s JOIN story_photos p ON p.story_id = s.id WHERE p.position = 0 AND s.image LIKE '/images/stories/%' LIMIT 1")[0];
  const oldRes = await fetch(BASE + oldRow.image, { redirect: 'manual' });
  check('an old /images/stories/... link still resolves (static archive file)', oldRes.status === 200 && oldRes.headers.get('content-type') === 'image/jpeg', String(oldRes.status));
  const gone = path.join(ROOT, 'dist/client', oldRow.image);
  const keep = fs.readFileSync(gone);
  try {
    fs.rmSync(gone);
    const redirected = await fetch(BASE + oldRow.image, { redirect: 'manual' });
    check('...and when the static file is not there, it 301s to the /media copy', redirected.status === 301 && redirected.headers.get('location') === `/media/${oldRow.path}`, `${redirected.status} ${redirected.headers.get('location')}`);
  } finally {
    fs.writeFileSync(gone, keep);
  }

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
  const raw = await new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const s = net.connect(PORT, '127.0.0.1', () => s.write('GET /media/../imconnected.db HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let out = '';
      s.on('data', (d) => (out += d));
      s.on('close', () => resolve(out));
    });
  });
  check('an unnormalised /media/../imconnected.db request line does not return the database', /^HTTP\/1\.1 404/.test(raw) && !raw.includes('SQLite format'), raw.slice(0, 80));
  fs.writeFileSync(path.join(DATA_DIR, 'media', 'secret.txt'), 'nope');
  fs.symlinkSync(DB_FILE, path.join(DATA_DIR, 'media', 'link.jpg'));
  const t1 = await fetch(BASE + '/media/secret.txt');
  const t2 = await fetch(BASE + '/media/link.jpg');
  check('only jpg/png/webp are served, and a symlink out of the folder is refused', t1.status === 404 && t2.status === 404, `${t1.status} ${t2.status}`);
  fs.rmSync(path.join(DATA_DIR, 'media', 'secret.txt'));
  fs.rmSync(path.join(DATA_DIR, 'media', 'link.jpg'));
  const post = await fetch(BASE + '/media/x.jpg', { method: 'POST' });
  check('POST /media is not allowed', post.status === 404 || post.status === 405, String(post.status));

  // ================= part 2: a second start adopts nothing and reads no build =================
  const dump = () => JSON.stringify([q('SELECT * FROM stories ORDER BY id'), q('SELECT * FROM story_photos ORDER BY id'), q('SELECT * FROM app_state')]);
  const mediaState = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.startsWith('.')) out.push(`${p}:${fs.statSync(p).mtimeMs}:${fs.statSync(p).size}`); } };
    walk(path.join(DATA_DIR, 'media'));
    return out.sort().join('\n');
  };
  const dump1 = dump(), media1 = mediaState();
  await stopServer();
  await sleep(1100);
  await startServer();
  await waitForAdoption(); // no adoption line is expected; this just gives it time to (wrongly) run
  await sleep(500);
  check('second start: the flag is set, so no adoption runs (no log line)', !log.some((l) => l.includes('adopting the build')), log.filter((l) => l.includes('stories')).join(' | '));
  check('second start: stories, story_photos and app_state are byte-identical', dump() === dump1);
  check('second start: no photo file was copied again or touched', mediaState() === media1);

  // ================= part 3: the transition from the step-3 state =================
  // Step-3 state = mirror rows (source git) + holds + drafts the dashboard unpublished. Emulated by taking the adoption
  // flag away and writing those rows, then starting a NEWER build (one extra story, one changed story).
  await stopServer();
  const [A, B, C, D, E, F] = synth.map((s) => s.id);
  check('the build has the 6 synthetic stories the transition part uses', synth.length === 6, String(synth.length));
  const SHAS = Array.from({ length: 4 }, (_, i) => String(i + 1).repeat(40));
  const commitsFile = path.join(SCRATCH, 'build-commits');
  fs.writeFileSync(commitsFile, SHAS.map((h, i) => `${h} ${1700000000 + i}`).join('\n') + '\n');
  const now = Date.now();
  run('DELETE FROM app_state');
  // A: unpublished in the dashboard (drafts.unpublished_at) and its row says so
  run("INSERT INTO drafts (status, source, title, section, slug, published_commit, unpublished_at, created_at, updated_at) VALUES ('in_review', 'editor', 'x', 'news', ?, 'c', ?, 1, 1)", A, now);
  run("UPDATE stories SET rev = rev + 1, status = 'unpublished', edited_at = ? WHERE slug = ?", now, A);
  // B: a hold whose unpublish commit is NOT in this image's commit list -> still held
  // C: a hold whose unpublish commit IS in the list -> released, the build's text is live
  run("INSERT INTO story_holds_retired (slug, unpublish_sha, unpublish_time, created_at) VALUES (?, ?, ?, ?)", B, 'f'.repeat(40), now, now);
  run("UPDATE stories SET rev = rev + 1, status = 'unpublished' WHERE slug = ?", B);
  run("INSERT INTO story_holds_retired (slug, unpublish_sha, unpublish_time, created_at) VALUES (?, ?, ?, ?)", C, SHAS[1], now, now);
  run("UPDATE stories SET rev = rev + 1, status = 'unpublished' WHERE slug = ?", C);
  // D: the mirror holds OLD text (the build is newer); E: a story edited in the database (never overwritten)
  run("UPDATE stories SET rev = rev + 1, title = 'OLD MIRRORED TITLE', content_hash = 'stale' WHERE slug = ?", D);
  run("UPDATE stories SET rev = rev + 1, title = 'Edited in the database', source = 'editor', edited_at = ? WHERE slug = ?", now, E);
  // a mirrored story that left the build
  run("INSERT INTO stories (slug, title, section, author, date, source, published_at, updated_at) VALUES ('gone-from-build', 't', 'news', 'a', '2026-01-01', 'git', 1, 1)");
  const wantLive = builtIds.map((s) => s.id).filter((id) => ![A, B].includes(id));
  const extraMd = path.join(ROOT, 'src/content/stories/zz-test-newer.md');
  const extraPub = path.join(ROOT, 'public/images/zz-test-newer.png');
  const pngLike = (fill) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, fill)]);
  try {
    fs.writeFileSync(extraPub, pngLike(1));
    fs.writeFileSync(extraMd, '---\ntitle: "Synthetic newer story"\nsection: news\narea: churches\nauthor: "Test Author"\ndate: 2026-10-01\nimage: "/images/zz-test-newer.png"\nimageAlt: "A synthetic test image"\nphotos: []\nfeatured: false\ndraft: false\n---\nSynthetic text that only the newer build has.\n');
    build(); // the NEWER build
    await startServer({ BUILD_COMMITS_FILE: commitsFile });
    const line3 = await waitForAdoption();
    check('transition: the first start of the new code adopts once', /adopting the build: 1 new, 2 updated/.test(line3) && !!adoptedFlag(), line3);
    const st = Object.fromEntries(q('SELECT slug, status, source, title FROM stories').map((r) => [r.slug, r]));
    check('transition: every story that was live is still live', wantLive.every((id) => st[id]?.status === 'live'), wantLive.filter((id) => st[id]?.status !== 'live').join());
    check('transition: a story unpublished in the dashboard stays unpublished', st[A].status === 'unpublished');
    check('transition: a story whose hold is still active (unpublish not in this image) stays unpublished', st[B].status === 'unpublished');
    check('transition: a story whose hold was released (unpublish commit is in this image) is live', st[C].status === 'live');
    check('transition: a mirrored story that left the build is unpublished', st['gone-from-build'].status === 'unpublished');
    check('transition: a built story newer than the mirror is updated', st[D].title !== 'OLD MIRRORED TITLE' && st[D].title === builtIds[builtIds.findIndex((s) => s.id === D)].fm.title);
    check('transition: a story missing from the database is imported', st['zz-test-newer']?.status === 'live' && st['zz-test-newer'].source === 'git');
    check('transition: a story edited in the database is never overwritten', st[E].title === 'Edited in the database' && st[E].source === 'editor');
    check('transition: the holds are retired (all released)', q('SELECT COUNT(*) AS n FROM story_holds_retired WHERE released_at IS NULL')[0].n === 0);
    const pg = await (await fetch(BASE + '/news/')).text();
    check('transition: the news page shows the imported story and not the unpublished ones', pg.includes('Synthetic newer story') && !pg.includes(builtIds.find((s) => s.id === A).fm.title));
    check('transition: search finds the imported story', (await (await fetch(BASE + '/api/search?q=synthetic+newer')).json()).results?.some((r) => r.slug === 'zz-test-newer'));
    await stopServer();

    // A later start with an OLDER build (the extra story is not in it) changes nothing.
    run("UPDATE stories SET rev = rev + 1, title = 'Edited again in the database', source = 'editor' WHERE slug = ?", F);
    const dump3 = dump();
    removeNewer();
    build();
    await sleep(1100);
    await startServer({ BUILD_COMMITS_FILE: commitsFile });
    await waitForAdoption();
    await sleep(500);
    const hasZ = fs.existsSync(path.join(ROOT, 'dist/client/images/zz-test-newer.png'));
    check('older build: confirmed that the running build has no zz-test-newer story', !hasZ);
    check('older build: no adoption ran', !log.some((l) => l.includes('adopting the build')), log.join(' | ').slice(0, 300));
    check('older build: the database is byte-identical (the story only the newer build had is still there, edits kept)', dump() === dump3 && q("SELECT status FROM stories WHERE slug = 'zz-test-newer'")[0].status === 'live');
    const pg2 = await (await fetch(BASE + '/news/')).text();
    check('older build: the news page still shows the story that only the newer build had', pg2.includes('Synthetic newer story'));
    await stopServer();
  } finally {
    removeNewer();
    build();
  }

  // ================= part 4: a story that always fails stops after 5 passes and the flag is not set =================
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const failing = builtIds[builtIds.length - 1].id;
  await startServer({ STORY_SYNC_TEST_FAIL_SLUG: failing, STORY_SYNC_TEST_RETRY_MS: '300' });
  await fetch(BASE + '/media/stories/none/' + '0'.repeat(64) + '.jpg');
  const passes = () => log.filter((l) => l.includes('[stories] adopting the build')).length;
  for (let i = 0; i < 100 && passes() < 5; i++) await sleep(100);
  await sleep(1500);
  for (let i = 0; i < 5; i++) await fetch(BASE + '/media/stories/none/' + '0'.repeat(64) + '.jpg');
  await sleep(800);
  check('a story that always fails is attempted exactly 5 passes, then no timer or request starts another', passes() === 5 && log.some((l) => l.includes('pass 5 of 5')), `passes=${passes()}`);
  check('...the flag is NOT set, and the other stories were still adopted', adoptedFlag() === null && q('SELECT COUNT(*) AS n FROM stories WHERE slug != ? AND source = ?', failing, 'git')[0].n >= builtIds.length - 1);
  await stopServer();
  // a start with the failure gone completes the adoption
  await startServer();
  await waitForAdoption();
  check('the next start completes the adoption and sets the flag', !!adoptedFlag() && q('SELECT COUNT(*) AS n FROM stories')[0].n === builtIds.length);

  // ================= part 5: people change a story while the adoption pass is running =================
  // The pass reads a story, hashes its photos (awaits), then writes. A person who publishes, edits or unpublishes in
  // between must never be overwritten or have their unpublish revived.
  {
    await stopServer();
    const E = (() => {
      const now = Date.now();
      const id = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('race-editor@example.test', 'Race Editor', 'editor', 'active', ?, ?)", now, now).lastInsertRowid);
      const token = 'race-' + sha(String(now)).slice(0, 40);
      run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', sha(token), id, now, now, now + 3600_000);
      return { id, cookie: `__Host-imc_session=${token}` };
    })();
    const PUB_TOKEN = 'race-made-up-publish-token-' + 'p'.repeat(24);
    const post = async (u, fields) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
      const res = await fetch(BASE + u, { method: 'POST', headers: { Cookie: E.cookie, Origin: BASE }, body: fd, redirect: 'manual' });
      await res.arrayBuffer();
      return new URL(res.headers.get('location') ?? '/', BASE).searchParams;
    };
    const envFor = { AUTH_SECRET: 'race-made-up-auth-secret-' + 'a'.repeat(24), PUBLISH_TOKEN: PUB_TOKEN, TRUST_PROXY: 'true', SITE_URL: BASE, RESEND_API_KEY: '' };
    const resume = path.join(SCRATCH, 'resume');
    const pausedAt = (slug) => log.some((l) => l.includes(`pass paused before writing ${slug}`));
    const staleRow = (slug) => run("UPDATE stories SET rev = rev + 1, title = 'STALE MIRROR TITLE', content_hash = 'stale' WHERE slug = ?", slug);
    const [P1, P2, P3] = [synth[1], synth[0], synth[2]];
    const FAIL = synth[5].id;
    // 5a. Publish changes (dashboard) during the pass
    run('DELETE FROM app_state');
    staleRow(P1.id);
    const now0 = Date.now();
    const draftId = Number(run("INSERT INTO drafts (status, source, title, dek, section, area, author, date, body, slug, created_at, updated_at) VALUES ('in_review', 'editor', 'Published By The Editor', '', 'news', 'churches', 'Ed Author', '2026-10-20', 'Body written by the editor during the pass.', ?, ?, ?)", P1.id, now0, now0).lastInsertRowid);
    fs.rmSync(resume, { force: true });
    await startServer({ ...envFor, STORY_SYNC_TEST_PAUSE_SLUG: P1.id, STORY_SYNC_TEST_PAUSE_FILE: resume });
    await fetch(BASE + '/');
    for (let i = 0; i < 100 && !pausedAt(P1.id); i++) await sleep(100);
    check('(the adoption pass is paused just before it writes the story)', pausedAt(P1.id));
    const pr = await post(`/api/admin/drafts/${draftId}/publish`, { version: q('SELECT updated_at u FROM drafts WHERE id = ?', draftId)[0].u });
    check('(an editor publishes changes to that story meanwhile)', pr.get('n') === 'published', pr.toString());
    fs.writeFileSync(resume, 'go');
    await waitForAdoption();
    const r1 = q('SELECT title, source, status, edited_at FROM stories WHERE slug = ?', P1.id)[0];
    check('"Publish changes" during an adoption pass is not overwritten by the build (title, source editor)', r1.title === 'Published By The Editor' && r1.source === 'editor' && r1.status === 'live' && r1.edited_at > 0, JSON.stringify(r1));
    check('...the pass still finished and set the flag', !!adoptedFlag());
    await stopServer();

    // 5b. Studio publish of the same slug during the pass
    run('DELETE FROM app_state');
    staleRow(P2.id);
    fs.rmSync(resume, { force: true });
    await startServer({ ...envFor, STORY_SYNC_TEST_PAUSE_SLUG: P2.id, STORY_SYNC_TEST_PAUSE_FILE: resume });
    await fetch(BASE + '/');
    for (let i = 0; i < 100 && !pausedAt(P2.id); i++) await sleep(100);
    const studio = await fetch(BASE + '/api/publish', { method: 'POST', headers: { Authorization: `Bearer ${PUB_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ newsletter: { name: 'N', issueDate: P2.id.slice(0, 10) }, stories: [{ ref: 'a', title: P2.fm.title, section: P2.fm.section, area: P2.fm.area, author: 'Studio Author', body: 'Studio text published during the pass.' }] }) });
    const sj = await studio.json();
    check('(Studio publishes the same story meanwhile)', studio.status === 200 && sj.stories?.[0]?.slug === P2.id, JSON.stringify(sj).slice(0, 200));
    fs.writeFileSync(resume, 'go');
    await waitForAdoption();
    const r2 = q('SELECT body, source, status FROM stories WHERE slug = ?', P2.id)[0];
    check('a Studio publish of the same slug during an adoption pass is not overwritten (source stays studio)', r2.body.includes('Studio text published during the pass.') && r2.source === 'studio' && r2.status === 'live', JSON.stringify(r2));
    await stopServer();

    // 5c. a story with no draft is unpublished between the failed pass and its retry: the retry must not bring it back
    run('DELETE FROM app_state');
    run("UPDATE stories SET rev = rev + 1, status = 'live', edited_at = NULL WHERE slug = ?", P3.id);
    staleRow(P3.id); // the build is "newer" than the table for this story, so a careless pass would rewrite it
    await startServer({ ...envFor, STORY_SYNC_TEST_FAIL_SLUG: FAIL, STORY_SYNC_TEST_RETRY_MS: '3000' });
    await fetch(BASE + '/');
    for (let i = 0; i < 100 && !log.some((l) => l.includes('pass 1 of 5')); i++) await sleep(100);
    check('(pass 1 fails on purpose; its retry is 3 s away)', log.some((l) => l.includes('pass 1 of 5')) && !adoptedFlag());
    check('(pass 1 had already re-adopted the story, so it is live from git)', q('SELECT status, source FROM stories WHERE slug = ?', P3.id)[0].status === 'live');
    const un = await post('/api/admin/stories/unpublish', { slug: P3.id });
    check('(an editor unpublishes it: it has no draft, so the row stays source git with edited_at set)', un.get('n') === 'unpublished' && q('SELECT source, status, edited_at FROM stories WHERE slug = ?', P3.id)[0].source === 'git' && q('SELECT edited_at e FROM stories WHERE slug = ?', P3.id)[0].e > 0);
    run('UPDATE stories SET rev = rev + 1, content_hash = ? WHERE slug = ?', 'stale-again', P3.id); // make the retry want to rewrite it
    for (let i = 0; i < 100 && log.filter((l) => l.includes('adopting the build')).length < 2; i++) await sleep(100);
    const r3 = q('SELECT status, source FROM stories WHERE slug = ?', P3.id)[0];
    check('the retry pass leaves it unpublished (an unpublish by step-4 code is never revived by adoption)', log.filter((l) => l.includes('adopting the build')).length >= 2 && r3.status === 'unpublished' && r3.source === 'git', JSON.stringify(r3));
    await stopServer();
    await startServer();
    await waitForAdoption();
    check('...and once the failure is gone the adoption completes and it is still unpublished', !!adoptedFlag() && q('SELECT status FROM stories WHERE slug = ?', P3.id)[0].status === 'unpublished');
    await stopServer();

    // 5d. a shared photo file deleted by a concurrent rollback before COMMIT: nothing is written, the editor is told to retry
    //     (and the clock: edits are stamped after the migration even if the host clock stepped back)
    {
      run("UPDATE schema_migrations SET applied_at = ? WHERE name = '015_stories_source_of_truth.sql'", Date.now() + 3_600_000);
      const applied = q("SELECT applied_at a FROM schema_migrations WHERE name = '015_stories_source_of_truth.sql'")[0].a;
      const hook = path.join(SCRATCH, 'delete-files');
      fs.rmSync(hook, { force: true });
      await startServer({ ...envFor, PUBLISH_TEST_DELETE_FILE: hook });
      const nowD = Date.now();
      const dId = Number(run("INSERT INTO drafts (status, source, title, dek, section, area, author, date, body, created_at, updated_at) VALUES ('in_review', 'editor', 'Photo Vanishes Story', '', 'news', 'churches', 'Ed Author', '2026-10-20', 'A story whose photo file disappears.', ?, ?)", nowD, nowD).lastInsertRowid);
      fs.mkdirSync(path.join(DATA_DIR, 'uploads', String(dId)), { recursive: true });
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 9)]);
      const rel = `${dId}/${'ef'.repeat(16)}.png`;
      fs.writeFileSync(path.join(DATA_DIR, 'uploads', rel), png);
      run("INSERT INTO draft_photos (draft_id, path, ext, alt, position, created_at) VALUES (?, ?, 'png', 'x', 0, ?)", dId, rel, nowD);
      await fetch(BASE + '/');
      const ver = () => q('SELECT updated_at u FROM drafts WHERE id = ?', dId)[0].u;
      fs.writeFileSync(hook, '1');
      const storiesBefore = q('SELECT COUNT(*) n FROM stories')[0].n;
      const bad = await post(`/api/admin/drafts/${dId}/publish`, { version: ver() });
      check('a photo file that vanished before COMMIT (a concurrent rollback) gives "try again" and writes nothing', bad.get('e') === 'publish_retry' && q('SELECT COUNT(*) n FROM stories')[0].n === storiesBefore && q('SELECT status, slug FROM drafts WHERE id = ?', dId)[0].slug === null && fs.existsSync(path.join(DATA_DIR, 'uploads', rel)), bad.toString());
      fs.rmSync(hook, { force: true });
      const ok = await post(`/api/admin/drafts/${dId}/publish`, { version: ver() });
      const slugD = q('SELECT slug FROM drafts WHERE id = ?', dId)[0].slug;
      const sD = q('SELECT edited_at, status FROM stories WHERE slug = ?', slugD)[0];
      check('...the retry publishes it', ok.get('n') === 'published' && sD.status === 'live', ok.toString());
      check('with the host clock behind the migration, a dashboard publish is still stamped after it (edited_at = migration time + 1)', Number(sD.edited_at) === Number(applied) + 1, `${sD.edited_at} vs ${applied}`);
      const un2 = await post('/api/admin/stories/unpublish', { slug: slugD });
      check('...and so is an unpublish', un2.get('n') === 'unpublished' && q('SELECT edited_at e FROM stories WHERE slug = ?', slugD)[0].e >= Number(applied) + 1);
      await stopServer();
    }

    // ================= part 6: an old (pre-step-4) image started against an adopted database changes nothing =================
    // main's story-sync.ts, as raw SQL: getHold / listHolds first, upsertStory's UPDATE, and the "left the build" unpublishStory.
    const dumpAll = () => JSON.stringify([q('SELECT * FROM stories ORDER BY id'), q('SELECT * FROM story_photos ORDER BY id'), q('SELECT * FROM app_state')]);
    const before = dumpAll();
    const raw = new DatabaseSync(DB_FILE);
    raw.exec('PRAGMA busy_timeout = 5000');
    const tries = [];
    const attempt = (name, fn) => { try { fn(); tries.push([name, 'allowed']); } catch (e) { tries.push([name, 'refused: ' + String(e.message).slice(0, 60)]); } };
    const live = raw.prepare("SELECT id, slug FROM stories WHERE status = 'live' ORDER BY id LIMIT 1").get();
    attempt('getHold', () => raw.prepare('SELECT slug, build_marker, unpublish_sha, unpublish_time, released_at FROM story_holds WHERE slug = ?').get(live.slug));
    attempt('listHolds', () => raw.prepare('SELECT slug, build_marker, unpublish_sha, unpublish_time, released_at FROM story_holds WHERE released_at IS NULL').all());
    attempt('unpublishStory (left the build)', () => raw.prepare("UPDATE stories SET status = 'unpublished', updated_at = ? WHERE slug = ? AND status = 'live'").run(Date.now(), live.slug));
    attempt('upsertStory (revert to the old build text)', () => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        raw.prepare(`UPDATE stories SET title=?, dek=?, section=?, area=?, story_column=?, author=?, author_title=?, church=?, date=?, image=?, image_alt=?, photo_credit=?,
          photos=?, photo_alts=?, featured=?, draft=?, body=?, status=?, source=?, draft_id=?, published_at=?, updated_at=?, published_by=?, content_hash=? WHERE id = ?`)
          .run('OLD IMAGE TITLE', null, 'news', null, null, 'a', null, null, '2026-01-01', null, null, null, '[]', '[]', 0, 0, 'old text', 'live', 'git', null, 1, Date.now(), null, 'x', live.id);
        raw.exec('COMMIT');
      } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* already */ } throw e; }
    });
    raw.close();
    check('an old image\'s mirror against an adopted database: its hold lookups fail and its unpublish and upsert writes are refused', tries.filter(([n]) => n === 'getHold' || n === 'listHolds' || /unpublish|upsert/.test(n)).every(([, r]) => r.startsWith('refused')), JSON.stringify(tries));
    check('...and nothing in stories, story_photos or app_state changed', dumpAll() === before);
    // the step-4 code paths still work: the server starts, publishes (rev bumps) and unpublishes through the same rows
    await startServer({ ...envFor });
    const probe = await fetch(BASE + '/');
    check('(the new code still starts and serves the adopted database)', probe.status === 200);
    await stopServer();
  }

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
