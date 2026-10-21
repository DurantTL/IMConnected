#!/usr/bin/env node
// End-to-end check of story search on SQLite FTS5 (issue 28, epic 25 step 3).
// It runs the BUILT server (dist/server/entry.mjs) against throwaway data folders. Synthetic data only; no GitHub, no email.
//   npm run build
//   SCRATCH=/tmp/imc-search node scripts/test-search.mjs        # run from the repo root
// SCRATCH is created fresh (an existing folder is removed first) and deleted at the end unless KEEP=1.
// Optional: Playwright (PLAYWRIGHT_ROOT, default /opt/node-tools) and Chromium (CHROMIUM_PATH) check the search page in a
// browser; with SHOTS=<folder> it also saves screenshots of the page with results at 390, 768 and 1280px.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
const DATA = path.join(SCRATCH, 'data');
const DB_FILE = path.join(DATA, 'imconnected.db');

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 600)}`);
  if (!ok) fails++;
};
const info = (line) => console.log(`INFO  ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(50); } return cond(); };
const db = (fn) => { const d = new DatabaseSync(DB_FILE); d.exec('PRAGMA busy_timeout = 5000'); try { return fn(d); } finally { d.close(); } };
const q = (sql, ...args) => db((d) => d.prepare(sql).all(...args));
const run = (sql, ...args) => db((d) => d.prepare(sql).run(...args));

const procs = new Set();
const log = [];
function startServer(extra = {}) {
  log.length = 0;
  const p = spawn('node', ['dist/server/entry.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), NODE_ENV: 'production', DATA_DIR: DATA, STORY_SYNC_TEST: '1', TRUST_PROXY: 'true', SITE_URL: BASE, RESEND_API_KEY: '', AUTH_SECRET: 'e2e-made-up-auth-secret-' + 'a'.repeat(24), ...extra },
  });
  const sink = (d) => log.push(...String(d).split('\n').filter(Boolean));
  p.stdout.on('data', sink);
  p.stderr.on('data', sink);
  procs.add(p);
  return p;
}
async function stopServer(p) {
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill();
  await done;
  procs.delete(p);
}
async function waitFor(url) {
  for (let i = 0; i < 80; i++) { try { await fetch(url); return; } catch { await sleep(250); } }
  throw new Error('did not start: ' + url);
}
async function cleanup() {
  for (const p of procs) p.kill();
  if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)));
const synced = () => log.some((l) => l.includes('[stories] adopting the build'));

// ---- helpers ----
const ip = (n) => ({ 'X-Forwarded-For': `203.0.113.${n}` }); // TRUST_PROXY=true: the rightmost entry is the client
async function search(params, headers = {}) {
  const qs = typeof params === 'string' ? params : new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/api/search?${qs}`, { headers: { ...ip(1), ...headers } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, body, source: res.headers.get('x-search-source') };
}
const slugsOf = (r) => (r.body?.results ?? []).map((x) => x.slug);

// ---- the built stories (read from the Markdown sources, for words to search) ----
const storyDir = path.join(ROOT, 'src/content/stories');
const sources = fs.readdirSync(storyDir).filter((f) => f.endsWith('.md')).map((f) => {
  const raw = fs.readFileSync(path.join(storyDir, f), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const fm = m[1];
  return { slug: f.replace(/\.md$/, ''), title: fm.match(/^title:\s*(.+)$/m)[1].replace(/^["']|["']$/g, ''), section: fm.match(/^section:\s*(\S+)/m)[1], draft: /^draft:\s*true/m.test(fm), body: m[2] };
}).filter((s) => !s.draft);
if (sources.length < 4) throw new Error('expected at least 4 built stories');
/** A long, body-only word of a story (not in its title) that no other story contains. */
function uniqueBodyWord(s) {
  const others = sources.filter((o) => o !== s).map((o) => (o.title + ' ' + o.body).toLowerCase());
  const words = [...new Set((s.body.replace(/\([^)]*\)/g, ' ').match(/[A-Za-z]{8,}/g) ?? []).map((w) => w.toLowerCase()))];
  return words.find((w) => !s.title.toLowerCase().includes(w) && !others.some((o) => o.includes(w)));
}
const withWord = sources.map((s) => ({ s, word: uniqueBodyWord(s) })).filter((x) => x.word);
if (withWord.length < 3) throw new Error('could not find distinctive body words');
const [A, B, C] = withWord; // A: unpublished in the dashboard, B: held, C: stays live
const aSection = A.s.section;

try {
  // ================= part 1: a fresh start (the one-time adoption of the build has not run yet) =================
  // Prepare the database the way the dashboard leaves it: story A unpublished, story B unpublished then republished and held.
  const { openDatabase, runMigrations, readMigrationsFromDir } = await import(pathToFileURL(path.join(ROOT, 'src/lib/db/db-core.mjs')).href);
  {
    const d = openDatabase(DATA);
    runMigrations(d, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
    const now = Date.now();
    const ins = d.prepare("INSERT INTO drafts (status, source, title, dek, section, area, author, date, body, slug, published_commit, published_at, unpublished_at, created_at, updated_at) VALUES ('in_review', 'editor', ?, '', ?, '', 'Test Author', '2026-10-01', 'A made-up body.', ?, 'abc', ?, ?, ?, ?)");
    ins.run(A.s.title, A.s.section, A.s.slug, now - 9000, now - 5000, now - 9000, now - 5000); // unpublished
    ins.run(B.s.title, B.s.section, B.s.slug, now - 9000, null, now - 9000, now - 5000); // republished while held
    d.prepare('INSERT INTO story_holds_retired (slug, build_marker, unpublish_sha, unpublish_time, released_at, created_at) VALUES (?, NULL, ?, ?, NULL, ?)').run(B.s.slug, 'a'.repeat(40), now - 6000, now - 6000);
    d.close();
  }
  const server1 = startServer({ STORY_SYNC_TEST_DELAY_MS: '8000', SEARCH_REPAIR_TEST_MS: '0' });
  await waitFor(BASE + '/submit/');
  {
    const r = await search({ q: C.word });
    check('fresh start: on a brand new, still empty database the first search waits for the adoption, then answers from the index (never from the build)', r.status === 200 && r.source === 'index' && synced() && q('SELECT COUNT(*) AS n FROM stories')[0].n > 0, `${r.status} ${r.source} synced=${synced()}`);
    check('fresh start: a word from a story body finds that story', slugsOf(r).includes(C.s.slug), r.text.slice(0, 300));
    const a = await search({ q: A.word });
    check('fresh start: a story unpublished in the dashboard is not returned', a.status === 200 && !slugsOf(a).includes(A.s.slug), r.text.slice(0, 200));
    const b = await search({ q: B.word });
    check('fresh start: a story with an active hold (unpublish not provably in this build) is not returned', b.status === 200 && !slugsOf(b).includes(B.s.slug), b.text.slice(0, 200));
    const t = await search({ q: C.s.title.split(/\s+/).slice(0, 3).join(' ') });
    check('fresh start: a title search finds the story', slugsOf(t).includes(C.s.slug), t.text.slice(0, 200));
    check('fresh start: a one-letter word must match a whole word, never a prefix', slugsOf(await search({ q: `${C.word} ${C.word[0]}` })).length === 0);
    const nm = await search({ q: 'zzzqqqxxnomatch' });
    check('fresh start: no matches is a 200 with ok: true and an empty list (not an error)', nm.status === 200 && nm.body?.ok === true && nm.body.results.length === 0);
    const sec = await search({ q: C.word, section: C.s.section === 'news' ? 'kids' : 'news' });
    check('fresh start: the section filter applies', sec.status === 200 && !slugsOf(sec).includes(C.s.slug));
  }
  check('(wait for the adoption)', await until(synced, 25000), log.slice(-4).join(' | '));

  // ================= part 2: after the mirror =================
  {
    const r = await search({ q: C.word });
    check('after the mirror: the FTS5 index is used', r.status === 200 && r.source === 'index', `${r.status} ${r.source}`);
    for (const { s, word } of withWord.filter((x) => x !== A && x !== B)) {
      const x = await search({ q: word });
      if (!slugsOf(x).includes(s.slug)) check(`a word from the body of ${s.slug} finds it`, false, x.text.slice(0, 200));
    }
    check('a word from a story body finds that story (every live built story with a distinctive word)', slugsOf(r).includes(C.s.slug));
    const hit = r.body.results.find((x) => x.slug === C.s.slug);
    check('a result has url, title, section, date, author and a highlighted snippet', hit.url === `/stories/${C.s.slug}/` && hit.title === C.s.title && hit.section === C.s.section && /^\d{4}-\d{2}-\d{2}$/.test(hit.date) && hit.author && new RegExp(`<mark>${C.word}`, 'i').test(hit.snippet), JSON.stringify(hit).slice(0, 300));
    check('search responses are never cached and are JSON', /no-store/.test(r.headers.get('cache-control')) && /application\/json/.test(r.headers.get('content-type')) && r.headers.get('x-content-type-options') === 'nosniff');
    check('the dashboard-unpublished story is not returned', !slugsOf(await search({ q: A.word })).includes(A.s.slug));
    check('the held story is not returned', !slugsOf(await search({ q: B.word })).includes(B.s.slug));
    check('every returned result is a live story in the table (the same set the pages show)', (await search({ q: 'the' })).body.results.every((x) => q("SELECT status FROM stories WHERE slug = ?", x.slug)[0]?.status === 'live'));
    const ft = await search({ q: C.s.title.split(/\s+/).slice(0, 2).join(' ') });
    check('title words find the story, and it ranks first', slugsOf(ft)[0] === C.s.slug, JSON.stringify(slugsOf(ft)));
    check('a one-letter word must match a whole word, never a prefix', slugsOf(await search({ q: `${C.word} ${C.word[0]}` })).length === 0);
    check('a prefix finds the story (typing the start of a word)', slugsOf(await search({ q: C.word.slice(0, 5) })).includes(C.s.slug));
    check('upper case and extra spaces make no difference', slugsOf(await search({ q: `   ${C.word.toUpperCase()}   ` })).includes(C.s.slug));
    const sec = await search({ q: C.word, section: C.s.section });
    const other = await search({ q: C.word, section: C.s.section === 'news' ? 'kids' : 'news' });
    check('the section filter keeps its own section and drops the rest', slugsOf(sec).includes(C.s.slug) && !slugsOf(other).includes(C.s.slug));
    const badSec = await search({ q: 'baptism', section: 'nope' });
    check('an unknown section is a 400', badSec.status === 400 && badSec.body?.ok === false);
    check('the search index was written by the sync (one row per story, stamped with updated_at)', q('SELECT COUNT(*) AS n FROM stories s JOIN stories_fts f ON f.rowid = s.id WHERE f.stamp = s.updated_at')[0].n === q('SELECT COUNT(*) AS n FROM stories')[0].n);
  }

  // ---- hostile queries ----
  {
    const long = 'a'.repeat(5000);
    const cases = [
      ['"', '%22'], ['*', '*'], ['NEAR(', 'NEAR('], ['<script>', '%3Cscript%3E'], ['a very long string', long], ['unicode', encodeURIComponent('café 你好 ☃ 🙂 Ünï')], ['empty', ''],
      ['unbalanced quote', '%22unterminated'], ['NEAR with args', encodeURIComponent('NEAR(a b, 2)')], ['boolean words', 'a%20AND%20OR%20NOT%20b'], ['column filter', 'title%3Afoo'], ['column filter braces', encodeURIComponent('{title body} : x')],
      ['minus and caret', '-foo%20%5Ebar'], ['star colon', '*%3A*'], ['parentheses', encodeURIComponent('(((')], ['backslash', '%5C'], ['null byte', 'a%00b'], ['control chars', '%01%02%03'], ['lone surrogate', '%ED%A0%80'],
      ['xss payload', encodeURIComponent('"><img src=x onerror=alert(1)>')], ['sql payload', encodeURIComponent("'; DROP TABLE stories; --")], ['fts rank hack', encodeURIComponent('rank MATCH bm25(')], ['many words', Array.from({ length: 150 }, (_, i) => 'w' + i).join('%20').slice(0, 190)],
      ['200 chars', 'b'.repeat(200)], ['201 chars', 'b'.repeat(201)], ['percent only', '%25'], ['emoji only', encodeURIComponent('🙂🙂')], ['malformed percent', '%E0%A4%A'],
    ];
    const bad = [];
    for (const [label, qv] of cases) {
      const r = await search(label === 'empty' ? 'q=' : `q=${qv}`);
      const okStatus = r.status === 200 || r.status === 400;
      // an address that is not valid UTF-8 or percent-encoding is refused by the server itself (400, plain text) before the route runs
      const json = (r.body && /application\/json/.test(r.headers.get('content-type'))) || (r.status === 400 && ['lone surrogate', 'malformed percent'].includes(label));
      const raw = /<script|<img|onerror|<b>|<\/?svg/i.test(r.text);
      if (!okStatus || !json || raw) bad.push(`${label}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    check(`${cases.length} hostile queries (", *, NEAR(, <script>, very long, unicode, empty, ...) answer 200 or 400 in JSON, never 500, never raw HTML`, bad.length === 0, bad.join(' | '));
    const st = async (qv) => (await search(qv === '' ? 'q=' : `q=${qv}`)).status;
    check('an empty query, a query of punctuation only and a query over 200 characters are 400', (await st('')) === 400 && (await st('%22')) === 400 && (await st('*')) === 400 && (await st('b'.repeat(201))) === 400 && (await st('a'.repeat(5000))) === 400);
    check('a query of exactly 200 characters is accepted', (await st('b'.repeat(200))) === 200);
    check('a missing q is a 400', (await search('')).status === 400);
    check('repeated q parameters use the first', (await search(`q=${C.word}&q=zzz`)).body?.results.some((x) => x.slug === C.s.slug));
    const syntaxy = await search({ q: `"${C.word}" OR NEAR(x y) title:zz*` });
    check('FTS syntax in the query is just words: operators are not interpreted (AND semantics, no results for the junk words)', syntaxy.status === 200 && syntaxy.body.results.length === 0);
    const echoed = await search({ q: '<script>alert(1)</script>' });
    check('the query is never echoed back', echoed.status === 200 && !echoed.text.includes('alert') && !echoed.text.includes('<'));
    const noDrop = q("SELECT COUNT(*) AS n FROM stories")[0].n > 0 && q("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'stories_fts'")[0].n === 1;
    check('the SQL payload changed nothing', noDrop);
    const post = await fetch(`${BASE}/api/search?q=x`, { method: 'POST' });
    await post.arrayBuffer();
    check('POST is 405', post.status === 405);
    const longUrl = await fetch(`${BASE}/api/search?q=${'a'.repeat(60000)}`).then(async (r) => { await r.arrayBuffer(); return r.status; }).catch(() => 'closed');
    check('an absurdly long address never gives a 500', longUrl !== 500, String(longUrl));
  }

  // ---- unpublishing and publishing ----
  {
    const slug = C.s.slug;
    run("UPDATE stories SET rev = rev + 1, status = 'unpublished' WHERE slug = ?", slug);
    check('a story unpublished is gone from the very next search', !slugsOf(await search({ q: C.word })).includes(slug));
    run("UPDATE stories SET rev = rev + 1, status = 'live' WHERE slug = ?", slug);
    check('...and back when it is live again', slugsOf(await search({ q: C.word })).includes(slug));
    run('UPDATE stories SET rev = rev + 1, draft = 1 WHERE slug = ?', slug);
    check('a story marked draft is never returned', !slugsOf(await search({ q: C.word })).includes(slug));
    run('UPDATE stories SET rev = rev + 1, draft = 0 WHERE slug = ?', slug);

    // a story saved by something other than the sync (stamp missing): found at once, because a search first indexes what is new
    const now = Date.now();
    const insert = (slug2, title, body, extra = {}) => run(
      "INSERT INTO stories (slug, title, dek, section, author, church, date, body, status, source, published_at, updated_at) VALUES (?, ?, ?, 'news', ?, ?, '2026-10-20', ?, 'live', 'editor', ?, ?)",
      slug2, title, extra.dek ?? null, extra.author ?? 'Sam Synthetic', extra.church ?? 'Test Church', body, now, now);
    insert('zz-just-published', 'Just published today', 'A made-up story about a zyxwvortex that was published a moment ago.');
    const jp = await search({ q: 'zyxwvortex' });
    check('a just-published story is findable immediately', jp.status === 200 && slugsOf(jp).join() === 'zz-just-published', jp.text.slice(0, 300));
    check('...and was added to the index', q("SELECT COUNT(*) AS n FROM stories_fts WHERE rowid = (SELECT id FROM stories WHERE slug = 'zz-just-published')")[0].n === 1);
    run("UPDATE stories SET rev = rev + 1, body = 'Now about a zyxwquasar instead.', updated_at = updated_at + 1 WHERE slug = 'zz-just-published'");
    check('an edited story is found by its new text and not its old text', slugsOf(await search({ q: 'zyxwquasar' })).includes('zz-just-published') && !slugsOf(await search({ q: 'zyxwvortex' })).includes('zz-just-published'));
    run("UPDATE stories SET rev = rev + 1, status = 'unpublished' WHERE slug = 'zz-just-published'");
    check('...and unpublished it is gone', slugsOf(await search({ q: 'zyxwquasar' })).length === 0);

    // fields: dek, author, church; accents; Markdown
    insert('zz-fields', 'Plain headline', 'Body words only: ![alt text](/x.jpg) with a [link label](https://example.test/zzsecret) and **bold** text and a ```fence``` and \\[escaped\\] &lt;tag&gt; &amp; more.',
      { dek: 'The zzdekword appears only in the dek', author: 'Zzauthorname Fictional', church: 'Zzchurchtown Fellowship' });
    for (const [word, what] of [['zzdekword', 'dek'], ['zzauthorname', 'author'], ['zzchurchtown', 'church'], ['label', 'link text']]) {
      check(`a word from the ${what} finds the story`, slugsOf(await search({ q: word })).includes('zz-fields'));
    }
    check('Markdown link addresses are not indexed (only the text)', slugsOf(await search({ q: 'zzsecret' })).length === 0);
    const fx = (await search({ q: 'escaped' })).body.results.find((x) => x.slug === 'zz-fields');
    check('the snippet is plain text with entities and escapes resolved, then escaped again', fx && fx.snippet.includes('&lt;tag&gt;') && fx.snippet.includes('&amp; more') && !fx.snippet.includes('\\[') && !fx.snippet.includes('**') && !fx.snippet.includes('https://'), fx?.snippet);
    insert('zz-accents', 'Café Ünïcode évènement', 'Un récit sur le zürich festival.');
    check('accents are folded both ways', slugsOf(await search({ q: 'cafe unicode' })).includes('zz-accents') && slugsOf(await search({ q: 'ZÜRICH' })).includes('zz-accents') && slugsOf(await search({ q: 'Café' })).includes('zz-accents'));
    insert('zz-cjk', '你好 world', '今日は雪だるまを作りました。');
    check('non-Latin text can be searched', slugsOf(await search({ q: '你好' })).includes('zz-cjk'));

    // hostile STORED text: the snippet must never carry markup other than <mark>
    const hostile = 'Intro <script>alert("x")</script> then zzhostileword followed by <img src=x onerror=alert(1)> and <b>bold</b> end &lt;script&gt; and "quotes" & \'single\'.';
    insert('zz-hostile', 'Hostile <img src=x onerror=alert(2)> title', hostile, { dek: 'dek <script>bad()</script> zzhostileword' });
    const h = await search({ q: 'zzhostileword' });
    const hs = h.body.results.find((x) => x.slug === 'zz-hostile')?.snippet ?? '';
    const strip = hs.replace(/<\/?mark>/g, '');
    check('a hostile story is found, and its snippet holds no markup but <mark>: every other < and > is escaped', hs.includes('<mark>zzhostileword</mark>') && !/[<>]/.test(strip) && !/<(script|img|b)\b/i.test(hs), hs);
    check('...quotes and ampersands are escaped too', !/["']/.test(strip.replace(/&quot;|&#39;/g, '')) && !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(strip), strip);
    const dekHit = (await search({ q: 'bad' })).body.results.find((x) => x.slug === 'zz-hostile');
    check('a match found only in the dek still gives an escaped snippet', dekHit && !/<(?!\/?mark>)/.test(dekHit.snippet), JSON.stringify(dekHit));
  }

  // ---- rate limit ----
  {
    let limited = 0;
    let other = 0;
    for (let i = 0; i < 140; i++) { const r = await search({ q: 'baptism' }, ip(77)); if (r.status === 429) limited++; else if (r.status !== 200) other++; }
    const r429 = await search({ q: 'baptism' }, ip(77));
    check('one address is rate limited (429 with Retry-After) after 120 searches in 10 minutes', limited >= 15 && other === 0 && r429.status === 429 && r429.headers.get('retry-after') === '300' && r429.body?.ok === false, `${limited} ${other} ${r429.status}`);
    check('...and another address is not affected', (await search({ q: 'baptism' }, ip(78))).status === 200);
  }

  // ================= part 3: the page in a browser =================
  {
    let chromium;
    try {
      const root = process.env.PLAYWRIGHT_ROOT || '/opt/node-tools';
      ({ chromium } = createRequire(path.join(root, 'package.json'))('playwright'));
    } catch { /* optional */ }
    const browser = chromium ? await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] }).catch(() => null) : null;
    if (!browser) info('Playwright/Chromium is not available: the browser checks are skipped');
    else {
      try {
        run("UPDATE stories SET rev = rev + 1, status = 'live' WHERE slug = 'zz-hostile'");
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(`${BASE}/search/?q=${encodeURIComponent(C.word)}`, { waitUntil: 'load' });
        await page.waitForSelector('.search-result', { timeout: 15000 }).catch(() => {});
        const links = await page.$$eval('.search-result a', (as) => as.map((a) => a.getAttribute('href')));
        check('page: ?q= runs the search and shows the story, linked to /stories/<slug>/', links.includes(`/stories/${C.s.slug}/`) && links.every((h) => /^\/stories\/[^/]+\/$/.test(h)), JSON.stringify(links));
        check('page: the highlighted word is a <mark> in the snippet', (await page.$$eval('.search-result mark', (ms) => ms.map((m) => m.textContent.toLowerCase()))).some((t) => t.startsWith(C.word.slice(0, 5))));
        check('page: nothing sideways at 390px (no horizontal scroll)', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), await page.evaluate(() => `${document.documentElement.scrollWidth} > ${window.innerWidth}`));
        check('page: the field, section menu and button are visible and the form is labelled', (await page.$$eval('#search-form input, #search-form select, #search-form button', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.right <= window.innerWidth; }))).every(Boolean) && (await page.$$eval('#search-form label', (ls) => ls.length)) === 2);
        // submitting the form searches again and updates the address
        await page.fill('#search-q', 'zzhostileword');
        await page.selectOption('#search-section', 'news');
        await page.click('#search-form button');
        await page.waitForFunction(() => document.querySelector('.search-result h2')?.textContent.includes('Hostile'), null, { timeout: 15000 }).catch(() => {});
        const hostile = await page.evaluate(() => ({ title: document.querySelector('.search-result h2')?.textContent, imgs: document.querySelectorAll('.search-results img, .search-results script, .search-results b').length, xss: window.__xss, marks: document.querySelectorAll('.search-result mark').length, snippet: document.querySelector('.snippet')?.textContent, url: location.search }));
        check('page: a hostile story shows as text (title and snippet are literal text, no element was created, no script ran)', hostile.title === 'Hostile <img src=x onerror=alert(2)> title' && hostile.imgs === 0 && hostile.xss === undefined && hostile.marks >= 1 && hostile.snippet.includes('end <script> and') && !hostile.snippet.includes('onerror') && errors.length === 0, JSON.stringify(hostile) + errors.join());
        check('page: the address keeps the search (?q= and section)', hostile.url === '?q=zzhostileword&section=news', hostile.url);
        await page.fill('#search-q', 'zzzqqqxxnomatch');
        await page.click('#search-form button');
        await page.waitForFunction(() => /No stories matched/.test(document.getElementById('search-status').textContent), null, { timeout: 15000 }).catch(() => {});
        check('page: no matches says so', (await page.textContent('#search-status')).includes('No stories matched') && (await page.$$('.search-result')).length === 0);
        await page.fill('#search-q', '"');
        await page.click('#search-form button');
        await page.waitForFunction(() => /Type a word/.test(document.getElementById('search-status').textContent), null, { timeout: 15000 }).catch(() => {});
        check('page: a query of punctuation shows the server\'s message', (await page.textContent('#search-status')).includes('Type a word'));
        // screenshots with results
        if (SHOTS) {
          for (const w of [390, 768, 1280]) {
            await page.setViewportSize({ width: w, height: 900 });
            await page.goto(`${BASE}/search/?q=${encodeURIComponent('conference')}`, { waitUntil: 'load' });
            await page.waitForSelector('.search-result', { timeout: 15000 }).catch(() => {});
            check(`page: results show at ${w}px`, (await page.$$('.search-result')).length >= 2);
            check(`page: no horizontal scroll at ${w}px`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
            await page.screenshot({ path: path.join(SHOTS, `search-${w}.png`), fullPage: true });
          }
          info(`screenshots in ${SHOTS}`);
        }
      } finally { await browser.close(); }
    }
  }

  // ================= part 4: the index cannot be read =================
  {
    await stopServer(server1);
    const server2 = startServer({ SEARCH_REPAIR_TEST_MS: '0' });
    await waitFor(BASE + '/submit/');
    await search({ q: 'baptism' });
    check('after a restart (adoption already done: no second pass) the index persists and is used', !synced() && (await search({ q: C.word })).source === 'index');
    run('DROP TABLE stories_fts');
    const r = await search({ q: C.word });
    check('when the index table is unreadable, search says it is not available (200, ok: false, no results), never a 500 and never a wrong "no matches" from the old build', r.status === 200 && r.body?.ok === false && r.body.results.length === 0 && r.body.total === 0, `${r.status} ${r.source} ${r.text.slice(0, 200)}`);
    check('...hostile queries still never give a 500', [await search('q=NEAR('), await search({ q: '<script>' }), await search('q=%22'), await search('q=')].every((x) => x.status === 200 || x.status === 400));
    await stopServer(server2);
  }


  // ================= part 5: upgrade (013 on a populated database), repair limits =================
  {
    const DATA2 = path.join(SCRATCH, 'data-upgrade');
    const DB2 = path.join(DATA2, 'imconnected.db');
    const db2 = (fn) => { const d = new DatabaseSync(DB2); d.exec('PRAGMA busy_timeout = 5000'); try { return fn(d); } finally { d.close(); } };
    const now = Date.now();
    const d0 = openDatabase(DATA2);
    runMigrations(d0, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')).filter((m) => m.name < '013'));
    const addStory = (d, slug, body) => d.prepare("INSERT INTO stories (slug, title, section, author, date, body, status, source, published_at, updated_at) VALUES (?, ?, 'news', 'Sam Synthetic', '2026-10-20', ?, 'live', 'editor', ?, ?)").run(slug, 'Upgrade story ' + slug, body, now, now);
    for (const n of [1, 2, 3]) addStory(d0, `zz-old-${n}`, `Made-up text with the word zzoldword${n} in it.`);
    d0.close();
    let srv = startServer({ DATA_DIR: DATA2, STORY_SYNC_TEST_DELAY_MS: '6000' }); // the default repair throttle (once a minute)
    await waitFor(BASE + '/submit/');
    const t0 = Date.now();
    const early = await search({ q: 'zzoldword2' });
    check('upgrade: right after 015 on a populated database, search answers at once from the index (no waiting for the adoption pass) and finds the old story', early.status === 200 && early.source === 'index' && Date.now() - t0 < 2000 && slugsOf(early).includes('zz-old-2'), `${early.status} ${early.source} ${early.text.slice(0, 150)}`);
    check('(wait for the adoption)', await until(synced, 25000), log.slice(-4).join(' | '));
    const counts = db2((d) => [d.prepare('SELECT COUNT(*) AS n FROM stories').get().n, d.prepare('SELECT COUNT(*) AS n FROM stories s JOIN stories_fts f ON f.rowid = s.id WHERE f.stamp = s.updated_at').get().n]);
    check('upgrade: the adoption pass indexed every story', counts[0] >= 3 && counts[0] === counts[1], JSON.stringify(counts));
    const late = await search({ q: 'zzoldword3' });
    check('upgrade: after the pass, search uses the index and finds the old story', late.source === 'index' && slugsOf(late).includes('zz-old-3'), `${late.source} ${late.text.slice(0, 150)}`);
    await stopServer(srv);

    // repair limits: a failing row is logged once, a lock is never waited on, a request repairs at most a few rows
    srv = startServer({ DATA_DIR: DATA2, SEARCH_REPAIR_TEST_MS: '0', SEARCH_TEST_FAIL_SLUG: 'zz-bad' });
    await waitFor(BASE + '/submit/');
    await search({ q: 'zzoldword1' });
    db2((d) => { addStory(d, 'zz-bad', 'The zzbadword text.'); addStory(d, 'zz-good', 'zzgoodtoken alpha beta.'); });
    for (let i = 0; i < 6; i++) await search({ q: 'zzgoodtoken' });
    const fails = log.filter((l) => l.includes('could not index story')).length;
    check('repair: one failing row is logged once and not retried on every search; the other rows are still indexed', fails === 1 && slugsOf(await search({ q: 'zzgoodtoken' })).includes('zz-good') && slugsOf(await search({ q: 'zzbadword' })).length === 0, `${fails} ${log.slice(-3).join(' | ')}`);
    check('repair: the failing row is only skipped, nothing else is affected (a search for it is a normal 200)', (await search({ q: 'zzbadword' })).status === 200);

    // prefix rules: one-letter words are whole-word only, and only the first 4 words are prefixes
    check('a one-letter word is a whole word, not a prefix (zzgoodtoken a: no match; "alpha" is not "a")', slugsOf(await search({ q: 'zzgoodtoken a' })).length === 0 && slugsOf(await search({ q: 'zzgoodtoken al' })).includes('zz-good'));
    check('only the first 4 words are prefixes: four prefixes match, a fifth must be a whole word', slugsOf(await search({ q: 'zzgoodtoken alp bet zzg' })).includes('zz-good') && slugsOf(await search({ q: 'zzgoodtoken alp bet zzg zzgood' })).length === 0 && slugsOf(await search({ q: 'zzgoodtoken alp bet zzg zzgoodtoken' })).includes('zz-good'));

    db2((d) => addStory(d, 'zz-locked', 'The zzlockedword text.'));
    const locker = new DatabaseSync(DB2);
    locker.exec('BEGIN IMMEDIATE');
    const t1 = Date.now();
    const locked = await search({ q: 'zzoldword1' });
    const lockedMs = Date.now() - t1;
    check('repair: with another writer holding the database lock a search is still answered at once (the request never waits on a lock)', locked.status === 200 && slugsOf(locked).includes('zz-old-1') && lockedMs < 1500, `${locked.status} ${lockedMs}ms`);
    locker.exec('ROLLBACK');
    locker.close();
    await search({ q: 'zzlockedword' });
    check('...and once the lock is gone the row is repaired by a later search', slugsOf(await search({ q: 'zzlockedword' })).includes('zz-locked'));
    db2((d) => { for (let i = 0; i < 80; i++) addStory(d, `zz-many-${i}`, `Bulk text zzmanyword${i}.`); });
    await search({ q: 'zzoldword1' });
    const indexed = db2((d) => d.prepare("SELECT COUNT(*) AS n FROM stories s JOIN stories_fts f ON f.rowid = s.id WHERE s.slug LIKE 'zz-many-%'").get().n);
    check('repair: one request repairs at most 50 rows', indexed === 50, String(indexed));
    await stopServer(srv);
  }

  const leaked = log.filter((l) => /[\w.+-]+@[\w-]+\.[a-z]{2,}|password|secret/i.test(l));
  check('no server log line has contact details or secrets', leaked.length === 0, leaked.join(' | '));
} catch (err) {
  console.error('ERROR', err);
  fails++;
} finally {
  await cleanup();
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
