#!/usr/bin/env node
// End-to-end check of the database-rendered public pages and feeds (issue 27, epic 25 step 2).
// It starts the mock GitHub API and the BUILT server (dist/server/entry.mjs) against a throwaway data folder, and
// compares every page with a BASELINE: the dist/client folder of a build from before this change (the
// prerendered pages). Synthetic data only: a made-up publish token, the mock GitHub API, no real email.
//
//   # once: build the code from before the change into a folder, e.g. from the previous commit on main
//   git worktree add /tmp/imc-before <commit-before-step-2> && (cd /tmp/imc-before && npm ci && npm run build) \
//     && cp -r /tmp/imc-before/dist/client /tmp/imc-baseline
//   npm run build
//   SCRATCH=/tmp/imc-public-pages BASELINE_DIR=/tmp/imc-baseline node scripts/test-public-pages.mjs    # from the repo root
//
// SCRATCH is created fresh (an existing folder is removed first) and deleted at the end unless KEEP=1.
// Without BASELINE_DIR the comparison checks are skipped and reported as SKIP (that is not a pass of the issue).
// Optional: Playwright (PLAYWRIGHT_ROOT, default /opt/node-tools) and Chromium (CHROMIUM_PATH) for the search check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const BASELINE = process.env.BASELINE_DIR ? path.resolve(process.env.BASELINE_DIR) : '';
if (BASELINE && !fs.existsSync(path.join(BASELINE, 'index.html'))) throw new Error('BASELINE_DIR must be a dist/client folder with index.html.');

const PORT = Number(process.env.PORT || 4541);
const GH_PORT = Number(process.env.MOCK_PORT || 4542);
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLISH_TOKEN = 'e2e-made-up-publish-token-' + 'p'.repeat(24);
const MOCK_OUT = path.join(SCRATCH, 'mock-prs'); // never the repo's .mock-prs
const dirs = { main: path.join(SCRATCH, 'data-main'), partial: path.join(SCRATCH, 'data-partial') };
const dbFile = (dir) => path.join(dir, 'imconnected.db');

let fails = 0;
let skips = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 600)}`);
  if (!ok) fails++;
};
const skip = (name) => { console.log(`SKIP  ${name} (no BASELINE_DIR)`); skips++; };
const info = (line) => console.log(`INFO  ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(50); } return cond(); };
let currentDb = dbFile(dirs.main);
const q = (sql, ...args) => { const db = new DatabaseSync(currentDb); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new DatabaseSync(currentDb); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

// ---- processes ----
const procs = new Set();
function start(cmd, args, env, log) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sink = (d) => log.push(...String(d).split('\n').filter(Boolean));
  p.stdout.on('data', sink);
  p.stderr.on('data', sink);
  procs.add(p);
  return p;
}
const stop = async (p) => {
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill();
  await done;
  procs.delete(p);
};
async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) { try { await fetch(url); return; } catch { await sleep(250); } }
  throw new Error('did not start: ' + url);
}
async function cleanup() {
  for (const p of procs) p.kill();
  if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)));

const ghLog = [];
const common = {
  HOST: '127.0.0.1', NODE_ENV: 'production', STORY_SYNC_TEST: '1', AUTH_SECRET: 'e2e-made-up-auth-secret-' + 'a'.repeat(24), TRUST_PROXY: 'true',
  GITHUB_TOKEN: 'mock-token', GITHUB_REPO: 'mock/repo', GITHUB_API_URL: `http://127.0.0.1:${GH_PORT}`, PUBLISH_TOKEN,
  RESEND_API_KEY: '', BUILD_COMMITS_FILE: path.join(SCRATCH, 'build-commits.txt'), PORT: String(PORT), SITE_URL: BASE,
};
const serverLog = [];
let server;
async function startServer(dataDir, extra = {}) {
  serverLog.length = 0;
  currentDb = dbFile(dataDir);
  server = start('node', ['dist/server/entry.mjs'], { ...common, DATA_DIR: dataDir, ...extra }, serverLog);
  await waitFor(BASE + '/submit/');
}
const stopServer = async () => { await stop(server); server = undefined; };
const COMMITS = path.join(SCRATCH, 'build-commits.txt'); // the image's commit list (BUILD_COMMITS_FILE); absent = a local build
const fakeShas = (n, seed) => Array.from({ length: n }, (_, i) => createHash('sha1').update(`${seed}-${i}`).digest('hex'));
/** Write the image's commit list the way docker.yml does ("<sha> <unix seconds>", newest first); times are spread from `newestSec` back. */
const writeList = (n, seed, newestSec, extra = []) => fs.writeFileSync(COMMITS, [...extra, ...fakeShas(n - extra.length, seed)].map((sha, i) => `${sha} ${newestSec - i * 60}`).join('\n') + '\n');
const latestUnpublishSha = () => JSON.parse(q("SELECT detail FROM audit_log WHERE action = 'draft.unpublish' ORDER BY id DESC LIMIT 1")[0].detail).commit;
const restartMain = async (extra = {}) => { await stopServer(); await startServer(dirs.main, extra); await get('/'); return until(synced, 20000); };
const synced = () => serverLog.some((l) => l.includes('[stories] mirrored the build'));

// ---- fetch helpers ----
async function get(u, headers = {}) {
  const res = await fetch(BASE + u, { redirect: 'manual', headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, loc: res.headers.get('location') };
}
async function rawGet(rawPath) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write(`GET ${rawPath} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('close', () => resolve(out));
  });
}

// ---- HTML comparison helpers ----
const mainOf = (html) => { const a = html.indexOf('<main id="main">'); const b = html.lastIndexOf('</main>'); return a < 0 || b < 0 ? '' : html.slice(a, b + 7); };
const decode = (s) => s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const visibleText = (html) => decode(mainOf(html).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const headOf = (html) => {
  const head = html.slice(0, html.indexOf('</head>'));
  const pick = [...head.matchAll(/<(title)>[^<]*<\/title>|<meta (?:name|property)="(?:description|og:[a-z_:]+|twitter:[a-z]+|robots)"[^>]*>|<link rel="canonical"[^>]*>|<script type="application\/ld\+json">[\s\S]*?<\/script>/g)];
  return pick.map((m) => m[0]);
};
/** Map every /media/<path> address back to the photo's original address, so a page can be compared with the prerendered one. */
function mediaMap() {
  const out = [];
  for (const r of q('SELECT p.path, p.position, s.image, s.photos FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE p.path IS NOT NULL')) {
    const src = [...(r.image ? [r.image] : []), ...JSON.parse(r.photos)];
    out.push(['/media/' + r.path, src[r.position]]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}
const unmedia = (text, map) => map.reduce((t, [from, to]) => t.split(from).join(to), text);
const baselineHtml = (urlPath) => fs.readFileSync(path.join(BASELINE, urlPath === '/' ? '' : urlPath, 'index.html'), 'utf8');

// ================= unit checks of the cache (bundled from src/lib/public-cache.ts) =================
{
  const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules/rolldown/dist/index.mjs')).href);
  const out = path.join(SCRATCH, 'public-cache.mjs');
  await build({ input: path.join(ROOT, 'src/lib/public-cache.ts'), output: { file: out, format: 'esm' }, platform: 'node', logLevel: 'silent' });
  const pc = await import(pathToFileURL(out).href);
  pc.invalidateStories();
  for (let i = 0; i < pc.MAX_ENTRIES + 50; i++) pc.cacheSet(`/k${i}`, { body: 'x', type: 'text/html' });
  check(`the cache never holds more than ${pc.MAX_ENTRIES} entries and drops the oldest first`, pc.cacheSize() === pc.MAX_ENTRIES && !pc.cacheGet('/k0') && !!pc.cacheGet(`/k${pc.MAX_ENTRIES + 49}`), String(pc.cacheSize()));
  pc.invalidateStories();
  pc.cacheSet('/a', { body: 'x', type: 't' }, 1000);
  check('an entry expires after the TTL (10 minutes) and not before', !!pc.cacheGet('/a', 1000 + pc.TTL_MS - 1) && pc.TTL_MS === 600000);
  pc.cacheSet('/a', { body: 'x', type: 't' }, 1000);
  check('...an entry past the TTL is gone', pc.cacheGet('/a', 1000 + pc.TTL_MS + 1) === undefined);
  pc.cacheSet('/b', { body: 'x', type: 't' });
  pc.invalidateStories();
  check('invalidateStories() clears everything', pc.cacheSize() === 0 && !pc.cacheGet('/b'));
  pc.cacheSet('/big', { body: 'x'.repeat(pc.MAX_ENTRY_BYTES + 1), type: 't' });
  check('one oversized page is never kept', pc.cacheSize() === 0);
  // a render that was started before an invalidation must not be stored
  const g = pc.cacheGeneration();
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = pc.cachedPage('/slow', async () => { await gate; return { page: { body: 'old', type: 't' } }; });
  pc.invalidateStories();
  release();
  await slow;
  check('a page rendered across an invalidation is returned but not stored (no stale page after a write)', pc.cacheGeneration() !== g && pc.cacheGet('/slow') === undefined);
  // concurrent misses share one render
  let renders = 0;
  const one = () => pc.cachedPage('/shared', async () => { renders++; await sleep(30); return { page: { body: 'p', type: 't' } }; });
  const rs = await Promise.all([one(), one(), one()]);
  check('concurrent misses for one page render it once', renders === 1 && rs.every((r) => r.page?.body === 'p') && (await one()).hit === true, String(renders));
  // a non-200 is never stored and waiting requests render for themselves
  let n404 = 0;
  const miss = () => pc.cachedPage('/gone', async () => { n404++; await sleep(20); return { response: new Response(null, { status: 404 }) }; });
  const r404 = await Promise.all([miss(), miss()]);
  check('a 404 is not cached and not shared', n404 === 2 && r404.every((r) => r.response?.status === 404) && pc.cacheSize() >= 1 && !pc.cacheGet('/gone'));
  // a request after an invalidation does not join a render that began before it
  pc.invalidateStories();
  let rel2;
  const gate2 = new Promise((r) => (rel2 = r));
  const older = pc.cachedPage('/race', async () => { await gate2; return { page: { body: 'before', type: 't' } }; });
  pc.invalidateStories();
  const newer = await pc.cachedPage('/race', async () => ({ page: { body: 'after', type: 't' } }));
  rel2();
  await older;
  check('a request after an invalidation renders afresh instead of joining an older render', newer.page.body === 'after' && pc.cacheGet('/race')?.body === 'after');
  // one failing render does not fail the requests waiting for it
  pc.invalidateStories();
  let calls = 0;
  const flaky = () => pc.cachedPage('/flaky', async () => { if (calls++ === 0) { await sleep(30); throw new Error('boom'); } return { page: { body: 'ok', type: 't' } }; });
  const [f1, f2] = await Promise.allSettled([flaky(), flaky()]);
  check('a render that throws rejects only its own request; a waiting request renders on its own', f1.status === 'rejected' && f2.status === 'fulfilled' && f2.value.page.body === 'ok', JSON.stringify([f1.status, f2.status]));
  {
    const hh = await import(pathToFileURL(await (async () => { const o = path.join(SCRATCH, 'story-holds.mjs'); await build({ input: path.join(ROOT, 'src/lib/story-holds.ts'), output: { file: o, format: 'esm' }, platform: 'node', logLevel: 'silent' }); return o; })()).href);
    const sha = (i) => createHash('sha1').update(String(i)).digest('hex');
    check('a commit list that is empty or only whitespace means "no list"', hh.parseCommits('') === null && hh.parseCommits(' \n\n \r\n') === null);
    check('a good list parses (sha + time, or the old sha-only format)', hh.parseCommits(`${sha(1)} 100\n${sha(2)} 200\n`).count === 2 && hh.parseCommits(`${sha(1)}\n${sha(2)}\n`).oldestMs === null);
    check('a non-empty list with any malformed line, or a duplicate sha, is unusable (never "no list")',
      ['garbage', `${sha(1)} 100\nnot-a-sha 5`, `${sha(1)} abc`, `${sha(1)} 100\n${sha(1)} 90`, `${sha(1)} 100 extra`, sha(1).slice(1)].every((t) => hh.parseCommits(t)?.unusable === true));
  }
  const keys = {
    '/': '/', '/news/': '/news', '/news': '/news', '/news/churches/': '/news/churches', '/stories/some-slug/': '/stories/some-slug', '/stories.json': '/stories.json', '/rss.xml': '/rss.xml',
  };
  check('publicCacheKey maps the rendered paths and ignores a trailing slash', Object.entries(keys).every(([p, k]) => pc.publicCacheKey(p) === k), JSON.stringify(Object.keys(keys).map((p) => pc.publicCacheKey(p))));
  const none = ['/submit/', '/search', '/admin', '/admin/drafts', '/api/stories', '/media/x.jpg', '/images/stories/a/b.jpg', '/news/nope/', '/nope/', '/news/churches/extra', '/stories/', '/stories/a/b', '/stories/..', '/stories/%2e%2e', '/__proto__', '/constructor/x'];
  check('publicCacheKey is null for every other path (so random URLs can not fill the cache)', none.every((p) => pc.publicCacheKey(p) === null), JSON.stringify(none.filter((p) => pc.publicCacheKey(p) !== null)));
}

// ================= part 1: a fresh start, with the first import held back =================
const SKIPPED_PAGES = new Set(['submit', 'search', 'confirm', 'pagefind', '_astro', 'images']);
const pages = [];
const FEED_PATHS = ['/stories.json', '/rss.xml'];
if (BASELINE) {
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !(rel === '' && SKIPPED_PAGES.has(e.name))) walk(path.join(dir, e.name), `${rel}/${e.name}`);
      else if (e.name === 'index.html') pages.push(rel === '' ? '/' : rel + '/');
    }
  };
  walk(BASELINE, '');
}
const storyPages = pages.filter((p) => p.startsWith('/stories/'));
const listPages = pages.filter((p) => !p.startsWith('/stories/'));
const first = storyPages[0] ?? null;
const slugOf = (p) => p.split('/')[2];
const feedBase = BASELINE ? JSON.parse(fs.readFileSync(path.join(BASELINE, 'stories.json'), 'utf8')) : null;
if (BASELINE) check(`the baseline has pages to compare (${pages.length} pages, ${storyPages.length} stories)`, pages.length >= 8 && storyPages.length >= 3, `${pages.length}/${storyPages.length}`);

/** Compare every page and both feeds with the baseline. `mapped` is true once photo addresses are /media/... */
async function comparePages(label, mapped) {
  const map = mapped ? mediaMap() : [];
  const bad = [];
  const badHead = [];
  const badText = [];
  const badHeaders = [];
  for (const p of pages) {
    const res = await get(p);
    const base = baselineHtml(p);
    if (res.status !== 200) { bad.push(`${p} ${res.status}`); continue; }
    if (!/text\/html/.test(res.headers.get('content-type') ?? '') || res.headers.get('cache-control') !== 'public, max-age=60, stale-while-revalidate=300') badHeaders.push(`${p} ${res.headers.get('content-type')} ${res.headers.get('cache-control')}`);
    const live = unmedia(res.text, map);
    if (visibleText(live) !== visibleText(base)) badText.push(p);
    if (mainOf(live) !== mainOf(base)) bad.push(`${p} markup of main differs`);
    if (JSON.stringify(headOf(live)) !== JSON.stringify(headOf(base))) badHead.push(p);
  }
  check(`${label}: the visible text of main is identical to the prerendered page, on all ${pages.length} pages`, badText.length === 0, badText.join(' '));
  check(`${label}: the markup of main is identical too (photo addresses aside)`, bad.length === 0, bad.slice(0, 3).join(' | '));
  check(`${label}: title, description, canonical, Open Graph, Twitter and JSON-LD tags are identical`, badHead.length === 0, badHead.join(' '));
  check(`${label}: every page is HTML with Cache-Control: public, max-age=60, stale-while-revalidate=300`, badHeaders.length === 0, badHeaders.slice(0, 3).join(' | '));

  const js = await get('/stories.json');
  const live = JSON.parse(js.text);
  const { generated: g1, stories: s1, ...rest1 } = live;
  const { generated: g2, stories: s2, ...rest2 } = feedBase;
  const mapStories = (list) => JSON.parse(unmedia(JSON.stringify(list), map));
  check(`${label}: /stories.json is identical apart from image addresses (same version, fields, order, key order)`,
    js.status === 200 && JSON.stringify(rest1) === JSON.stringify(rest2) && live.version === 1 && JSON.stringify(mapStories(s1)) === JSON.stringify(s2) && typeof g1 === 'string' && !!g2,
    `${js.status} ${JSON.stringify(mapStories(s1)).slice(0, 200)}`);
  check(`${label}: /stories.json is JSON with the public cache header`, /application\/json/.test(js.headers.get('content-type')) && js.headers.get('cache-control') === 'public, max-age=60, stale-while-revalidate=300');
  if (mapped) check(`${label}: /stories.json photo addresses are absolute /media/ links`, s1.some((s) => s.image?.startsWith('http') && s.image.includes('/media/stories/')) && s1.every((s) => !s.image || s.image.startsWith('http')));
  const rss = await get('/rss.xml');
  check(`${label}: /rss.xml is identical apart from image addresses`, rss.status === 200 && unmedia(rss.text, map) === fs.readFileSync(path.join(BASELINE, 'rss.xml'), 'utf8') && /rss\+xml/.test(rss.headers.get('content-type')) && rss.headers.get('cache-control') === 'public, max-age=60, stale-while-revalidate=300', `${rss.status}`);
}

// In-process dashboard helpers (a signed-in editor is inserted straight into the database; sign-in has its own tests)
function signedInEditor() {
  const now = Date.now();
  const token = 'e2e-session-' + createHash('sha256').update(String(now)).digest('hex').slice(0, 24);
  const id = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('editor-one@example.test', 'Test Editor', 'editor', 'active', ?, ?)", now, now).lastInsertRowid);
  run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600_000);
  return `__Host-imc_session=${token}`;
}
async function post(u, cookie, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const res = await fetch(BASE + u, { method: 'POST', headers: { Cookie: cookie, Origin: BASE }, body: fd, redirect: 'manual' });
  const loc = res.headers.get('location');
  await res.arrayBuffer();
  return { status: res.status, loc, params: loc ? new URL(loc, BASE).searchParams : new URLSearchParams() };
}

try {
  // mock GitHub (in the scratch folder, never ./.mock-prs)
  start('node', ['scripts/mock-github.mjs'], { MOCK_PORT: String(GH_PORT), MOCK_OUT }, ghLog);
  await sleep(600);

  await startServer(dirs.main, { STORY_SYNC_TEST_DELAY_MS: '9000' });
  const t0 = Date.now();
  const homeEarly = await get('/');
  const pending = () => !synced();
  check('right after a start the stories table is still empty, yet the home page is complete (served from the build)', pending() && q('SELECT COUNT(*) AS n FROM stories')[0].n === 0 && homeEarly.status === 200 && !homeEarly.text.includes('empty-state'), `${q('SELECT COUNT(*) AS n FROM stories')[0].n}`);
  if (BASELINE) {
    await comparePages('while the mirror is still empty', false);
    check('...and those pages link the build\'s own /images photos', homeEarly.text.includes('/images/stories/') && !homeEarly.text.includes('/media/'));
  } else skip('page comparison while the mirror is empty');
  const hit1 = await get('/news/');
  const hit2 = await get('/news/');
  check('a cached page is served from memory on the second request (X-Page-Cache miss, then hit)', hit2.headers.get('x-page-cache') === 'hit' && hit1.text === hit2.text, `${hit1.headers.get('x-page-cache')} ${hit2.headers.get('x-page-cache')}`);
  check('/news and /news/ are the same page, with the same canonical link', (await get('/news')).text === hit1.text && /rel="canonical" href="[^"]*\/news\/"/.test(hit1.text));

  // ---- the dashboard unpublishes a story while the mirror is still filling ----
  let oldSnippets = [];
  /** True when no page or feed shows the story's old text or links to it. */
  const noOldText = async () => {
    const urls = ['/', `/${feedBase.stories.find((x) => x.id === slug).section}/`, `/stories/${slug}/`, '/stories.json', '/rss.xml'];
    for (const u of urls) { const r = await get(u); if (r.text.includes(`/stories/${slug}`) || oldSnippets.some((sn) => r.text.includes(sn.replace(/’/g, '&#39;')) || r.text.includes(sn))) return false; }
    return true;
  };
  let slug = null;
  let draftId = null;
  const cookie = signedInEditor();
  if (BASELINE && feedBase) {
    const target = feedBase.stories.find((s) => /^\d{4}-\d{2}-\d{2}-/.test(s.id));
    const pub = await fetch(BASE + '/api/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${PUBLISH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ newsletter: { name: 'E2E Issue', issueDate: target.id.slice(0, 10) }, stories: [{ ref: 'a', title: target.title, section: target.section, area: target.area, author: 'Studio Author', body: 'A made-up body for the dashboard test.', photos: [] }] }),
    });
    const pj = await pub.json().catch(() => ({}));
    slug = pj.stories?.[0]?.slug ?? null;
    check('set-up: a synthetic Studio publish of the same title (mock GitHub) gives the built story\'s slug, so the dashboard can unpublish it', pub.status === 200 && slug === target.id, `${pub.status} ${JSON.stringify(pj).slice(0, 200)} ${slug} vs ${target.id}`);
    draftId = q('SELECT id FROM drafts WHERE slug = ?', slug)[0]?.id ?? null;
    const before = await get(`/stories/${slug}/`);
    check('the story page is live before the unpublish', before.status === 200);
    const un = await post('/api/admin/stories/unpublish', cookie, { slug });
    check('the dashboard unpublish succeeds', un.params.get('n') === 'unpublished', un.loc);
    const after = await get(`/stories/${slug}/`);
    check('mirror still empty: the unpublished story is a real 404 straight away (page cache invalidated)', pending() && after.status === 404 && after.text.includes('We couldn’t find that page') && after.headers.get('cache-control') === 'no-store', `${after.status}`);
    check('the unpublish recorded a hold with the unpublish commit', q('SELECT unpublish_sha FROM story_holds WHERE slug = ?', slug)[0]?.unpublish_sha === latestUnpublishSha() && /^[0-9a-f]{40}$/.test(latestUnpublishSha()));
    const lists = [await get('/'), await get(`/${target.section}/`), await get('/stories.json'), await get('/rss.xml')];
    check('...and it is gone from the home page, its section page and both feeds', lists.every((r) => !r.text.includes(`/stories/${slug}`)), lists.map((r) => r.text.includes(`/stories/${slug}`)).join());
    // The editor fixes the text and publishes again. The running build still has the OLD text, so the story must stay hidden.
    const base = baselineHtml(`/stories/${slug}/`);
    oldSnippets = [...new Set([target.dek, visibleText(base).match(/[A-Z][^.]{40,}\./)?.[0]?.slice(0, 60)].filter(Boolean))];
    const d0 = q('SELECT updated_at, status FROM drafts WHERE slug = ?', slug)[0];
    check('the unpublished draft is back in review', d0?.status === 'in_review', JSON.stringify(d0));
    const rp0 = await post(`/api/admin/drafts/${draftId}/publish`, cookie, { version: d0.updated_at });
    check('the dashboard publishes it again (the editor is told it returns with the next deploy)', rp0.params.get('n') === 'published_held', rp0.loc);
    check('mirror still empty: after publishing again it stays hidden (the old built text must not come back)', pending() && (await get(`/stories/${slug}/`)).status === 404 && await noOldText(), `${await get(`/stories/${slug}/`).then((r) => r.status)}`);
  } else skip('dashboard unpublish while the mirror is empty');

  // ---- the first import finishes ----
  const done = await until(synced, 20000);
  info(`the held-back first import finished ${Date.now() - t0} ms after the start`);
  check('the first import finishes and logs a completed pass', done, serverLog.slice(-5).join(' | '));
  const rows = q('SELECT slug, status FROM stories');
  check('the stories table is now filled; the dashboard-unpublished story is mirrored as unpublished', rows.length >= 3 && (!slug || rows.find((r) => r.slug === slug)?.status === 'unpublished'), JSON.stringify(rows));
  if (slug) {
    const r = await get(`/stories/${slug}/`);
    check('after the import the unpublished story is still a 404', r.status === 404);
    const home = await get('/');
    check('after the import pages come from the table (photos are /media links, cache invalidated)', home.text.includes('/media/stories/') && !home.text.includes('/images/stories/'), home.text.match(/src="[^"]*stories[^"]*"/)?.[0]);
    const holdRow = () => q('SELECT build_marker, unpublish_sha FROM story_holds WHERE slug = ?', slug)[0];
    const x1 = latestUnpublishSha();
    check('after the import the story published again is still hidden; its hold has the unpublish commit and the build marker', q('SELECT status FROM stories WHERE slug = ?', slug)[0].status === 'unpublished' && holdRow()?.unpublish_sha === x1 && !!holdRow().build_marker && await noOldText(), JSON.stringify(holdRow()));
    check('a restart of the same image (no commit list, same build marker) keeps it hidden', await restartMain() && (await get(`/stories/${slug}/`)).status === 404 && await noOldText());
    // an image built before the unpublish (for example finishing after it): a different build, but its commits lack the unpublish
    writeList(60, 'older-image', Math.floor(Date.now() / 1000));
    run("UPDATE story_holds SET build_marker = 'an-older-build' WHERE slug = ?", slug);
    check('an image whose commit list lacks the unpublish commit keeps it hidden, even though the build differs; the old text stays away', await restartMain() && (await get(`/stories/${slug}/`)).status === 404 && !!holdRow() && await noOldText());
    // Studio publishes the same story (same slug) while it is held: still hidden until an image has the unpublish
    const target0 = feedBase.stories.find((x) => x.id === slug);
    const studio = await fetch(BASE + '/api/publish', { method: 'POST', headers: { Authorization: `Bearer ${PUBLISH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ newsletter: { name: 'E2E Issue', issueDate: slug.slice(0, 10) }, stories: [{ ref: 'a', title: target0.title, section: target0.section, area: target0.area, author: 'Studio Author', body: 'A made-up corrected body from Studio.', photos: [] }] }) });
    await studio.arrayBuffer();
    check('Studio publishes the same slug again (mock GitHub)', studio.status === 200);
    check('...it stays hidden on the server until an image has the unpublish commit', (await get(`/stories/${slug}/`)).status === 404 && await noOldText());
    writeList(60, 'newer-image', Math.floor(Date.now() / 1000), [x1]);
    check('an image whose commit list has the unpublish commit drops the hold and shows the story (Studio path)', await restartMain() && (await get(`/stories/${slug}/`)).status === 200 && q('SELECT COUNT(*) AS n FROM story_holds WHERE released_at IS NULL')[0].n === 0 && q('SELECT status FROM stories WHERE slug = ?', slug)[0].status === 'live');
  }

  // ================= part 2: equivalence with the prerendered site, served from the table =================
  if (BASELINE) await comparePages('from the database', true); else skip('page comparison from the database');

  // ---- unpublish again, now with the mirror complete ----
  if (slug) {
    const target = feedBase.stories.find((s) => s.id === slug);
    await get(`/stories/${slug}/`); await get('/'); // make sure they are cached
    const un = await post('/api/admin/stories/unpublish', cookie, { slug });
    const gone = await get(`/stories/${slug}/`);
    const list = await get('/stories.json');
    check('an unpublish with the mirror complete: 404 straight away, row unpublished, gone from /stories.json and the home page',
      un.params.get('n') === 'unpublished' && gone.status === 404 && q('SELECT status FROM stories WHERE slug = ?', slug)[0].status === 'unpublished' && !list.text.includes(slug) && !(await get('/')).text.includes(`/stories/${slug}`), `${gone.status}`);
    const section = await get(`/${target.section}/`);
    check('...and from its section page', !section.text.includes(`/stories/${slug}`));
    const d = q('SELECT updated_at FROM drafts WHERE slug = ?', slug)[0];
    await post(`/api/admin/drafts/${draftId}/publish`, cookie, { version: d.updated_at });
    check('publishing it again does not bring it back (mirror complete): 404, row unpublished, old text nowhere', (await get(`/stories/${slug}/`)).status === 404 && q('SELECT status FROM stories WHERE slug = ?', slug)[0].status === 'unpublished' && await noOldText());
    const x2 = latestUnpublishSha();
    const nowSec = Math.floor(Date.now() / 1000);
    // the 200-commit safeguard: an unpublish older than the list's window is in the build
    run('UPDATE story_holds SET unpublish_time = NULL WHERE slug = ?', slug);
    writeList(200, 'full-window-newer', nowSec + 86400);
    check('a full newer 200-commit list does not release a hold that has no recorded commit time (no safeguard)', await restartMain() && (await get(`/stories/${slug}/`)).status === 404);
    run('UPDATE story_holds SET unpublish_time = ? WHERE slug = ?', Date.now(), slug);
    check('a full 200-commit list whose oldest commit is newer than the unpublish (+10 min) releases the story: the unpublish is older than the window', await restartMain() && (await get(`/stories/${slug}/`)).status === 200 && q('SELECT COUNT(*) AS n FROM story_holds WHERE released_at IS NULL')[0].n === 0);
    await post('/api/admin/stories/unpublish', cookie, { slug });
    const x3 = latestUnpublishSha();
    check('(a new unpublish records a new commit)', x3 !== x2 && q('SELECT unpublish_sha FROM story_holds WHERE slug = ?', slug)[0].unpublish_sha === x3);
    await post(`/api/admin/drafts/${draftId}/publish`, cookie, { version: q('SELECT updated_at FROM drafts WHERE slug = ?', slug)[0].updated_at }); // published again
    writeList(200, 'full-window-older', nowSec - 7 * 86400);
    check('a full list whose oldest commit is older than the unpublish keeps it hidden', await restartMain() && (await get(`/stories/${slug}/`)).status === 404 && await noOldText());
    writeList(199, 'short-newer', nowSec + 86400);
    check('a list with fewer than 200 commits has no window safeguard: hidden', await restartMain() && (await get(`/stories/${slug}/`)).status === 404);
    fs.writeFileSync(COMMITS, fakeShas(5, 'old-format').join('\n') + '\n');
    check('the old sha-only list format is accepted (no times, so no safeguard): hidden', await restartMain() && (await get(`/stories/${slug}/`)).status === 404);
    fs.rmSync(COMMITS, { force: true });
    run("UPDATE story_holds SET build_marker = 'an-older-build' WHERE slug = ?", slug);
    check('a local build without a commit list releases the hold once its build marker differs', await restartMain() && (await get(`/stories/${slug}/`)).status === 200);
    if (BASELINE) await comparePages('after unpublish, publish again and a new build', true);

    // ---- a commit list that can't be parsed keeps every hold active ----
    await post('/api/admin/stories/unpublish', cookie, { slug });
    await post(`/api/admin/drafts/${draftId}/publish`, cookie, { version: q('SELECT updated_at FROM drafts WHERE slug = ?', slug)[0].updated_at });
    const xu = latestUnpublishSha();
    fs.writeFileSync(COMMITS, `${xu} ${nowSec}\nthis line is not a commit\n`);
    check('a malformed non-empty commit list (even one containing the unpublish commit) keeps the story hidden', await restartMain() && (await get(`/stories/${slug}/`)).status === 404 && await noOldText());
    fs.writeFileSync(COMMITS, `${xu} ${nowSec}\n${xu} ${nowSec}\n`);
    check('a commit list with a duplicate sha keeps it hidden too', await restartMain() && (await get(`/stories/${slug}/`)).status === 404);
    fs.writeFileSync(COMMITS, `${xu} ${nowSec}\n`);
    check('a good list with the unpublish commit releases it (hold kept as a released record)', await restartMain() && (await get(`/stories/${slug}/`)).status === 200 && q('SELECT released_at FROM story_holds WHERE slug = ?', slug)[0].released_at > 0);
    fs.rmSync(COMMITS, { force: true });

    // ---- the unpublish and its hold are written together, and publishing needs the hold ----
    const mockTime = q('SELECT unpublish_time FROM story_holds WHERE slug = ?', slug)[0].unpublish_time;
    check('the hold has GitHub\'s commit time, not just the server clock', Math.abs(mockTime - Date.now()) < 3600_000 && mockTime > 0, String(mockTime));
    run("CREATE TRIGGER zz_fail_hold BEFORE INSERT ON story_holds BEGIN SELECT RAISE(ABORT, 'test: hold can not be written'); END");
    const bad = await post('/api/admin/stories/unpublish', cookie, { slug });
    run('DROP TRIGGER zz_fail_hold');
    check('if the hold can\'t be written the editor gets a clear error and nothing is half-recorded (draft not marked unpublished)', bad.params.get('e') === 'unpublish_not_recorded' && q('SELECT unpublished_at FROM drafts WHERE slug = ?', slug)[0].unpublished_at === null, bad.loc);
    await post('/api/admin/stories/unpublish', cookie, { slug });
    run('DELETE FROM story_holds WHERE slug = ?', slug);
    const refused = await post(`/api/admin/drafts/${draftId}/publish`, cookie, { version: q('SELECT updated_at FROM drafts WHERE slug = ?', slug)[0].updated_at });
    check('publishing a story that was unpublished but has no hold row is refused with a clear notice', refused.params.get('e') === 'hold_missing' && q('SELECT unpublished_at FROM drafts WHERE slug = ?', slug)[0].unpublished_at !== null, refused.loc);
    await post('/api/admin/stories/unpublish', cookie, { slug }); // records the hold again
    const xr = latestUnpublishSha();
    writeList(20, 'r', nowSec, [xr]);
    check('(a released hold)', await restartMain() && q('SELECT released_at FROM story_holds WHERE slug = ?', slug)[0].released_at > 0);
    const afterRelease = await post(`/api/admin/drafts/${draftId}/publish`, cookie, { version: q('SELECT updated_at FROM drafts WHERE slug = ?', slug)[0].updated_at });
    check('...publishing after a released hold is accepted (the record of the hold is kept)', afterRelease.params.get('n') === 'published' && !afterRelease.params.get('e'), afterRelease.loc);
    fs.rmSync(COMMITS, { force: true });
    await restartMain();

    // ---- the build marker can't be worked out while unpublishing: the story must still stay hidden ----
    check('(restart with a failing build marker)', await restartMain({ STORY_SYNC_TEST_FAIL_MARKER: '1' }));
    await post('/api/admin/stories/unpublish', cookie, { slug });
    const h1 = q('SELECT build_marker, unpublish_sha FROM story_holds WHERE slug = ?', slug)[0];
    const x4 = latestUnpublishSha();
    check('a failed build marker still records the hold (marker NULL, unpublish commit set)', h1 && h1.build_marker === null && h1.unpublish_sha === x4, JSON.stringify(h1));
    const dd = q('SELECT updated_at FROM drafts WHERE slug = ?', slug)[0];
    const rp2 = await post(`/api/admin/drafts/${draftId}/publish`, cookie, { version: dd.updated_at });
    check('republishing a held story tells the editor it returns with the next deploy', rp2.params.get('n') === 'published_held', rp2.loc);
    check('...and it stays hidden', (await get(`/stories/${slug}/`)).status === 404 && await noOldText());
    check('after a restart (no commit list, NULL marker) it is still hidden: a NULL marker never counts as a different build', await restartMain() && (await get(`/stories/${slug}/`)).status === 404 && await noOldText() && q('SELECT COUNT(*) AS n FROM story_holds WHERE released_at IS NULL')[0].n === 1);
    writeList(30, 'x', nowSec, [x4]);
    check('an image that contains the unpublish commit shows it', await restartMain() && (await get(`/stories/${slug}/`)).status === 200 && q('SELECT COUNT(*) AS n FROM story_holds WHERE released_at IS NULL')[0].n === 0);
    fs.rmSync(COMMITS, { force: true });
  }

  // ---- a story row edited in the database shows on the page right away, through the cache invalidation ----
  if (slug) {
    const other = q("SELECT slug, title FROM stories WHERE status = 'live' AND slug != ? ORDER BY slug LIMIT 1", slug)[0];
    const url = `/stories/${other.slug}/`;
    const hasTitle = (r, t) => r.text.includes(`<h1 data-pagefind-meta="title">${t}</h1>`);
    run("UPDATE stories SET title = 'Edited in the database', content_hash = 'edited-1' WHERE slug = ?", other.slug);
    // The pages above are cached; an unpublish and republish in the dashboard (store writes) clears the cache.
    await post('/api/admin/stories/unpublish', cookie, { slug });
    await post(`/api/admin/drafts/${draftId}/publish`, cookie, { version: q('SELECT updated_at FROM drafts WHERE slug = ?', slug)[0].updated_at });
    const a = await get(url);
    check('a row edited in the database shows on the page (the page reads the table)', a.status === 200 && hasTitle(a, 'Edited in the database') && a.headers.get('x-page-cache') === 'miss', `${a.status} ${a.headers.get('x-page-cache')}`);
    run("UPDATE stories SET title = 'Edited a second time', content_hash = 'edited-2' WHERE slug = ?", other.slug);
    const b = await get(url);
    check('...a second edit made behind the server\'s back is not shown while the page is cached', hasTitle(b, 'Edited in the database') && b.headers.get('x-page-cache') === 'hit');
    // the server's own store write: a pass of the sync puts the built text back with upsertStory, which clears the cache
    server.kill('SIGUSR2');
    check('the server\'s re-sync ran', await until(() => serverLog.some((l) => l.includes('[stories] test re-sync')), 15000), serverLog.slice(-3).join(' | '));
    const c = await get(url);
    check('a write through the store (upsertStory) invalidates the cache: the page shows the new row at once', c.status === 200 && c.headers.get('x-page-cache') === 'miss' && !c.text.includes('Edited a second time') && !c.text.includes('Edited in the database'), `${c.status} ${c.headers.get('x-page-cache')} ${c.text.match(/<h1[^>]*>[^<]*/)?.[0]}`);
  }

  // ================= part 3: 404s, middleware, old image links =================
  {
    const bad = ['/stories/no-such-story/', '/stories/..%2fx/', '/nope/', '/news/nope/', '/news/churches/extra/', '/columns/nope/', '/stories/'];
    const out = [];
    for (const p of bad) {
      const r = await get(p);
      if (r.status !== 404 || !r.text.includes('We couldn’t find that page') || /public/.test(r.headers.get('cache-control') ?? '')) out.push(`${p} ${r.status} ${r.headers.get('cache-control')}`);
    }
    check('unknown stories, sections and areas are a real 404 with the 404 page, never cached publicly', out.length === 0, out.join(' | '));
    const raw = await rawGet('/stories/%2e%2e%2f%2e%2e%2fimconnected.db HTTP/1.1\r\nX-Ignore: 1');
    check('an encoded traversal in a story address is a 404 with no database content', /^HTTP\/1\.1 404/.test(raw) && !raw.includes('SQLite format'));
    const slugs = q("SELECT slug FROM stories WHERE slug LIKE '%<%' OR slug LIKE '%\"%'");
    check('(sanity) no story slug needs HTML escaping', slugs.length === 0);
    const xs = await get('/stories/%3Cscript%3Ealert(1)%3C%2Fscript%3E/');
    check('a script in the address never reaches the page output', xs.status === 404 && !xs.text.includes('<script>alert'));
  }
  {
    const submit = await get('/submit/');
    const media = await fetch(BASE + '/media/nothing/' + '0'.repeat(64) + '.jpg');
    await media.arrayBuffer();
    check('other public paths do not go through the page cache (no X-Page-Cache, no public cache header)', submit.status === 200 && !submit.headers.get('x-page-cache') && !/max-age=60/.test(submit.headers.get('cache-control') ?? '') && !media.headers.get('x-page-cache'));
    const adminLogin = await get('/admin/login');
    check('/admin is still guarded by the middleware (no-store, noindex) and not cached', !adminLogin.headers.get('x-page-cache') && /no-store/.test(adminLogin.headers.get('cache-control') ?? '') && /noindex/.test(adminLogin.headers.get('x-robots-tag') ?? ''));
    check('the build-time search source pages are not served', (await get('/search-source/welcome-to-imconnected/')).status === 404 && !fs.existsSync(path.join(ROOT, 'dist/client/search-source')));
    const post404 = await fetch(BASE + '/news/', { method: 'POST' });
    await post404.arrayBuffer();
    check('POST to a public page is not answered from the cache', !post404.headers.get('x-page-cache'));
  }
  {
    // old /images/stories/... links
    const withPhoto = q("SELECT s.slug, s.image, p.path FROM stories s JOIN story_photos p ON p.story_id = s.id AND p.position = 0 WHERE s.image LIKE '/images/stories/%' AND p.path IS NOT NULL ORDER BY s.slug LIMIT 1")[0];
    const old = await fetch(BASE + withPhoto.image);
    const oldBytes = Buffer.from(await old.arrayBuffer());
    const newBytes = fs.readFileSync(path.join(dirs.main, 'media', withPhoto.path));
    check('an old /images/stories/... link (as in a sent newsletter) still returns the photo', old.status === 200 && /^image\//.test(old.headers.get('content-type')) && oldBytes.equals(newBytes), `${old.status} ${old.headers.get('content-type')}`);
    // a photo that exists only in the database: redirected to its /media copy
    const rel = 'stories/zz-test-legacy/' + 'a'.repeat(64) + '.jpg';
    fs.mkdirSync(path.join(dirs.main, 'media/stories/zz-test-legacy'), { recursive: true });
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(40, 7), Buffer.from([0xff, 0xd9])]);
    fs.writeFileSync(path.join(dirs.main, 'media', rel), jpg);
    const now = Date.now();
    const id = Number(run("INSERT INTO stories (slug, title, section, author, date, image, photos, status, source, published_at, updated_at) VALUES ('zz-test-legacy', 'Synthetic', 'news', 'a', '2026-01-01', '/images/stories/zz-test-legacy/photo-1.jpg', '[]', 'unpublished', 'editor', ?, ?)", now, now).lastInsertRowid);
    run("INSERT INTO story_photos (story_id, position, kind, path, url, alt, sha256, bytes) VALUES (?, 0, 'lead', ?, NULL, '', ?, ?)", id, rel, 'a'.repeat(64), jpg.length);
    const redir = await fetch(BASE + '/images/stories/zz-test-legacy/photo-1.jpg', { redirect: 'manual' });
    await redir.arrayBuffer();
    check('an old photo link for a photo held only in the database redirects (301) to its /media copy', redir.status === 301 && redir.headers.get('location') === '/media/' + rel, `${redir.status} ${redir.headers.get('location')}`);
    const followed = await fetch(BASE + '/images/stories/zz-test-legacy/photo-1.jpg');
    check('...and following it returns the photo bytes', followed.status === 200 && Buffer.from(await followed.arrayBuffer()).equals(jpg));
    const others = ['/images/stories/zz-test-legacy/other.jpg', '/images/stories/nope/photo-1.jpg', '/images/stories/zz-test-legacy/', '/images/stories/zz-test-legacy/a/b.jpg', '/images/stories/zz-test-legacy/..%2f..%2fx.jpg'];
    const odd = [];
    for (const u of others) { const r = await fetch(BASE + u, { redirect: 'manual' }); await r.arrayBuffer(); if (r.status !== 404) odd.push(`${u} ${r.status}`); }
    check('unknown or odd old photo links are 404', odd.length === 0, odd.join(' | '));
    run("DELETE FROM story_photos WHERE story_id = ?", id);
    run("DELETE FROM stories WHERE id = ?", id);
  }

  // ================= part 4: search still links to the real story pages =================
  {
    let chromium;
    try {
      const root = process.env.PLAYWRIGHT_ROOT || '/opt/node-tools';
      ({ chromium } = createRequire(path.join(root, 'package.json'))('playwright'));
    } catch { /* optional */ }
    if (!chromium) info('Playwright is not available: the search check is skipped');
    else {
      const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] }).catch(() => null);
      if (!browser) info('Chromium did not start: the search check is skipped');
      else {
        try {
          const page = await browser.newPage();
          await page.goto(`${BASE}/search/?q=baptism`, { waitUntil: 'load' });
          await page.waitForSelector('.pagefind-ui__result-link', { timeout: 15000 }).catch(() => {});
          const hrefs = await page.$$eval('.pagefind-ui__result-link', (as) => as.map((a) => a.getAttribute('href')));
          check('search finds stories and links them to /stories/<slug>/ (not the build-time source pages)', hrefs.length > 0 && hrefs.every((h) => /^\/stories\/[^/]+\//.test(h)), JSON.stringify(hrefs));
          if (hrefs.length) { const r = await get(hrefs[0].split('#')[0]); check('...and a search result link opens the story', r.status === 200); }
        } finally { await browser.close(); }
      }
    }
  }

  // ================= part 5: a partial mirror never shows a missing story =================
  await stopServer();
  if (BASELINE) {
    const failing = feedBase.stories[feedBase.stories.length - 1].id;
    await startServer(dirs.partial, { STORY_SYNC_TEST_FAIL_SLUG: failing, STORY_SYNC_TEST_RETRY_MS: '300' });
    await get('/');
    check('(partial) one story can never be mirrored; the sync gives up after 5 passes', await until(() => serverLog.some((l) => l.includes('pass 5 of 5')), 20000), serverLog.slice(-4).join(' | '));
    check('(partial) the table is missing exactly that story', q('SELECT slug FROM stories WHERE slug = ?', failing).length === 0 && q('SELECT COUNT(*) AS n FROM stories')[0].n === feedBase.stories.length - 1);
    await comparePages('with a story that can never be mirrored (read from the build)', false);
    check('(partial) the story that failed to mirror still has its page', (await get(`/stories/${failing}/`)).status === 200);
    await stopServer();
  } else skip('partial mirror');

  const leaked = serverLog.concat(ghLog).filter((l) => /[\w.+-]+@[\w-]+\.[a-z]{2,}|password|secret/i.test(l) && !/mock-github/.test(l));
  check('no server log line has contact details or secrets', leaked.length === 0, leaked.join(' | '));
} catch (err) {
  console.error('ERROR', err);
  fails++;
} finally {
  await cleanup();
}

console.log(fails ? `\n${fails} check(s) FAILED` : `\nAll checks passed${skips ? ` (${skips} comparison group(s) skipped: set BASELINE_DIR)` : ''}`);
process.exit(fails ? 1 : 0);
