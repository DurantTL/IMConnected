#!/usr/bin/env node
// Issue #140: the dashboard's Published list (search, filters, sorts, pages, summary cards). Synthetic stories in a throwaway
// DATA_DIR, the BUILT server on a local port, an editor signed in by a session row. Nothing real, no email, no GitHub.
//   npm run build
//   PORT=4895 [SHOTS=/tmp/shots] node scripts/test-published-list.mjs      (uses a temp folder; DATA_DIR is ignored)
// Playwright (PLAYWRIGHT_ROOT, default /opt/node-tools) and Chromium (CHROMIUM_PATH) are optional: they add the no-horizontal-scroll checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const port = process.env.PORT || '4895', base = `http://localhost:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-published-list-'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, server, db;
const logs = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };
const stop = () => { try { server?.kill(); } catch { /* gone */ } };
process.on('exit', stop);

const chicago = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
const [CY, CM] = ['year', 'month'].map((t) => Number(chicago.find((p) => p.type === t).value));
// First instant of this Chicago month, to the hour (good enough to place edits clearly before or after it).
const monthStart = Date.UTC(CY, CM - 1, 1, 12);
const DAY = 86_400_000;

try {
  db = openDatabase(scratch);
  runMigrations(db, readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
  const now = Date.now();
  db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)").run(now);
  const uid = Number(db.prepare("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('list-editor@example.test', 'List Editor', 'editor', 'active', ?, ?)").run(now, now).lastInsertRowid);
  const pubUid = Number(db.prepare("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES ('list-pub@example.test', 'Pat Publisher', 'editor', 'active', ?, ?)").run(now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)').run(createHash('sha256').update(token).digest('hex'), uid, now, now, now + 3600_000);
  for (const [n, date] of [[1, '2026-01-05'], [2, '2026-02-05'], [3, '2026-03-05']]) db.prepare("INSERT INTO newsletter_issues (number, date, title, created_at, updated_at) VALUES (?, ?, '', ?, ?)").run(n, date, now, now);

  // 66 live stories: s01..s66. Section rotates; area for news/youth; issue 1-3 on the first 30, none after; two years of dates.
  const SECS = [['news', 'conference'], ['features', ''], ['youth', 'pathfinders'], ['kids', ''], ['news', 'churches'], ['news', 'schools']];
  const WORDS = ['Camp', 'Rally', 'Harvest', 'Choir', 'Service', 'Garden'];
  const pad = (n) => String(n).padStart(2, '0');
  const ins = db.prepare("INSERT INTO stories(slug,title,dek,section,area,author,church,date,body,status,source,published_at,updated_at,featured,draft,additional_sections,newsletter_issue,edited_at) VALUES(?,?,'Synthetic summary.',?,?,?,?,?,?,?,'editor',?,?,?,?,?,?,?)");
  const S = {};
  for (let i = 1; i <= 66; i++) {
    const [sec, area] = SECS[(i - 1) % SECS.length];
    const s = {
      slug: `synth-s${pad(i)}`, title: `Synthetic ${WORDS[i % 6]} Story ${pad(i)}`, sec, area, church: `Synthetic Church ${(i % 4) + 1}`,
      date: i <= 40 ? `2026-${pad(((i - 1) % 9) + 1)}-${pad(((i * 3) % 27) + 1)}` : `2025-${pad(((i - 1) % 12) + 1)}-${pad(((i * 5) % 27) + 1)}`,
      featured: i % 7 === 0 ? 1 : 0, issue: i <= 30 ? ((i - 1) % 3) + 1 : null, pub: i % 13 === 0 ? monthStart - 90 * DAY - i * 3600_000 : now - i * 3600_000,
      edited: null, first: null,
      body: i === 5 ? 'Plain text with 100% turnout and a snake_case word.' : i === 6 ? 'A back\\slash and 100 percent.' : i === 9 ? 'Findable hidden-needle phrase in the body.' : `Synthetic body ${i}.`,
      extra: i === 2 ? '["youth"]' : '[]',
    };
    // "Edited" = changed after the story first went live (edited_at more than 60 s after the first publish):
    //  - every 11th: a real edit (after publishing, this month); every 13th: published long ago, edited 40 days before this month began... still later than its publish;
    //  - 14: edited_at only 10 s after publishing, which is what a plain first publish writes, so it is NOT edited;
    //  - 15: republished with changes (published_at and edited_at both just now) but its draft record says it first went live 30 days ago, so it IS edited.
    if (i % 11 === 0) s.edited = Math.max(monthStart + i * 60_000, s.pub + 120_000);
    else if (i % 13 === 0) s.edited = monthStart - 40 * DAY;
    else if (i === 14) s.edited = s.pub + 10_000;
    else if (i === 15) { s.edited = s.pub; s.first = now - 30 * DAY; }
    s.isEdited = !!s.edited && s.edited > (s.first ?? s.pub) + 60_000;
    S[i] = s;
    ins.run(s.slug, s.title, s.sec, s.area || null, `Synthetic Author ${(i % 3) + 1}`, s.church, s.date, s.body, 'live', s.pub, s.pub, s.featured, 0, s.extra, s.issue, s.edited);
  }
  // Stories that must never be listed: two unpublished and one live story flagged draft.
  ins.run('synth-gone-1', 'Synthetic Unpublished One', 'news', 'conference', 'Synthetic Author 1', 'Synthetic Church 1', '2026-05-01', 'x', 'unpublished', now, now, 1, 0, '[]', 1, null);
  ins.run('synth-gone-2', 'Synthetic Unpublished Two', 'news', 'conference', 'Synthetic Author 1', 'Synthetic Church 1', '2026-05-02', 'x', 'unpublished', now, now, 0, 0, '[]', null, null);
  ins.run('synth-flagged-draft', 'Synthetic Flagged Draft', 'news', 'conference', 'Synthetic Author 1', 'Synthetic Church 1', '2026-05-03', 'x', 'live', now, now, 0, 1, '[]', null, null);
  // Dashboard publish records: story 3 was published by Pat Publisher at a known time; story 4 has the same slug but was unpublished.
  const T3 = now - 1800_000; // newer than every seeded publish time
  const T3_DAY = new Date(T3).toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric' });
  const dIns = db.prepare("INSERT INTO drafts (status, source, slug, title, section, author, church, date, body, published_commit, published_at, published_by, unpublished_at, created_at, updated_at) VALUES (?, 'editor', ?, ?, 'news', 'Synthetic Author', '', '2026-06-01', 'x', ?, ?, ?, ?, ?, ?)");
  dIns.run('published', S[3].slug, S[3].title, 'db', T3, pubUid, null, now, now);
  dIns.run('in_review', S[4].slug, S[4].title, 'db', T3 + 1, pubUid, now, now, now); // unpublished earlier and re-opened: its record is not a live publish
  dIns.run('published', S[15].slug, S[15].title, 'db', S[15].pub, pubUid, null, now, now);
  db.prepare('UPDATE drafts SET submitter_notified_at = ? WHERE slug = ?').run(S[15].first, S[15].slug);
  db.prepare('UPDATE stories SET published_at = ?, rev = rev + 1 WHERE slug = ?').run(T3 - 1, S[3].slug);
  db.close(); db = undefined;

  server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: port, DATA_DIR: scratch, SITE_URL: base, AUTH_SECRET: 'synthetic-published-list-' + 'x'.repeat(40), TRUST_PROXY: 'true', RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (c) => logs.push(String(c))); server.stderr.on('data', (c) => logs.push(String(c)));
  for (let i = 0; i < 150; i++) { try { await fetch(base + '/admin/login'); break; } catch { await delay(100); } }

  const get = async (qs = '') => {
    const res = await fetch(`${base}/admin/published${qs}`, { headers: { Cookie: `__Host-imc_session=${token}` }, redirect: 'manual' });
    return { status: res.status, html: await res.text() };
  };
  const rowsOf = (html) => [...html.matchAll(/<tr>\s*<td class="adm-pick"[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  const slugsOf = (html) => rowsOf(html).map((r) => /name="slug" value="([^"]+)" form="bulk-form"/.exec(r)?.[1]);
  const totalOf = (html) => Number(/<strong>(\d+)<\/strong> (?:story|stories) shown/.exec(html)?.[1] ?? -1);
  const sl = (...ns) => ns.map((n) => S[n].slug);
  const allSlugs = Object.values(S).map((s) => s.slug);
  const live = (pred) => Object.values(S).filter(pred).map((s) => s.slug);

  // ---------- baseline ----------
  let r = await get();
  check('the page answers 200 for a signed-in editor', r.status === 200, String(r.status));
  check('default: 25 rows, 66 matching, newest published first', slugsOf(r.html).length === 25 && totalOf(r.html) === 66, `${slugsOf(r.html).slice(0, 3)} ${totalOf(r.html)}`);
  // Story 3's live publish record (T3, in 2026-06) is later than every other published_at (now - i hours): so it is first.
  check('published-at comes from the dashboard publish record: story 3 (record T3) sorts first and shows "by Pat Publisher"', slugsOf(r.html)[0] === S[3].slug && rowsOf(r.html)[0].includes('by Pat Publisher'), slugsOf(r.html)[0]);
  const hasT3Date = rowsOf(r.html)[0].includes(T3_DAY);
  check('...with that record\'s day (America/Chicago) in the Published column', hasT3Date, rowsOf(r.html)[0].slice(0, 400));
  check('a story whose draft record was unpublished shows no publisher', !rowsOf((await get('?q=' + S[4].slug)).html)[0]?.includes('Pat Publisher'));
  check('unpublished and flagged-draft stories are never listed (default, 100 a page)', !(await get('?perPage=100')).html.match(/synth-gone-|synth-flagged-draft/));
  const all100 = slugsOf((await get('?perPage=100')).html);
  check('perPage=100 lists all 66 live stories exactly once', all100.length === 66 && new Set(all100).size === 66 && allSlugs.every((s) => all100.includes(s)), String(all100.length));
  check('the lists links to the public page with rel="noopener" and shows church and /stories/<slug>/', /href="http[^"]*\/stories\/synth-s03\/" rel="noopener"/.test(r.html) && rowsOf(r.html)[0].includes('/stories/synth-s03/') && rowsOf(r.html)[0].includes('Synthetic Church'));
  check('each row keeps Edit (to /api/admin/stories/edit) and Unpublish, and a bulk checkbox on the bulk form', rowsOf(r.html).every((x) => x.includes('action="/api/admin/stories/edit"') && x.includes('action="/api/admin/stories/unpublish"') && x.includes('form="bulk-form"')) && r.html.includes('id="bulk-form"') && r.html.includes('Unpublish selected') && r.html.includes('Edit fields'));

  // ---------- summary cards ----------
  const featuredN = live((s) => s.featured).length;
  const editedMonthN = live((s) => s.isEdited && s.edited >= monthStart).length;
  const yearN = live((s) => s.date.startsWith(String(CY))).length;
  const card = (html, label) => { const m = new RegExp(`<a class="adm-stat" href="([^"]*)"( aria-current="true")?><span class="adm-stat-label">${label}[^<]*</span><strong>(\\d+)</strong>`).exec(html); return m && { href: m[1].replace(/&amp;/g, '&'), active: !!m[2], n: Number(m[3]) }; };

  // Open drafts through the real Edit action (loads the story into a draft linked to the slug).
  for (const n of [10, 20, 30]) {
    const er = await fetch(`${base}/api/admin/stories/edit`, { method: 'POST', headers: { Cookie: `__Host-imc_session=${token}`, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ slug: S[n].slug }), redirect: 'manual' });
    check(`(setup) Edit on story ${n} opens a draft`, (er.status === 302 || er.status === 303) && /\/admin\/drafts\/\d+/.test(er.headers.get('location') || ''), `${er.status} ${er.headers.get('location')}`);
  }
  // Story 4's draft record is also "in review" (see above).
  r = await get();
  const openN = 4;
  check('card All live = 66, active with no filter', card(r.html, 'All live')?.n === 66 && card(r.html, 'All live').active);
  check(`card Featured = ${featuredN}`, card(r.html, 'Featured')?.n === featuredN, JSON.stringify(card(r.html, 'Featured')));
  check(`card With an open draft = ${openN}`, card(r.html, 'With an open draft')?.n === openN, JSON.stringify(card(r.html, 'With an open draft')));
  check(`card Edited this month (Chicago) = ${editedMonthN}`, card(r.html, 'Edited this month')?.n === editedMonthN, JSON.stringify(card(r.html, 'Edited this month')));
  check(`card This year = ${yearN}`, card(r.html, 'This year')?.n === yearN, JSON.stringify(card(r.html, 'This year')));
  for (const [label, n] of [['Featured', featuredN], ['With an open draft', openN], ['Edited this month', editedMonthN], ['This year', yearN]]) {
    const c = card(r.html, label);
    const rr = await get(c.href.replace('/admin/published', ''));
    const cc = card(rr.html, label);
    check(`the ${label} card links to a filter showing exactly ${n} with aria-current`, totalOf(rr.html) === n && cc?.active === true && card(rr.html, 'All live').active === false, `${c.href} total=${totalOf(rr.html)}`);
  }

  // ---------- search ----------
  const q = async (term) => { const x = await get('?perPage=100&q=' + encodeURIComponent(term)); return { total: totalOf(x.html), slugs: slugsOf(x.html), html: x.html }; };
  let x = await q('harvest');
  check('search is case-insensitive over the title', x.total === live((s) => /harvest/i.test(s.title)).length && x.total > 0, String(x.total));
  x = await q('SYNTH-S07');
  check('search matches the slug', x.slugs.length === 1 && x.slugs[0] === 'synth-s07', x.slugs.join());
  x = await q('synthetic church 2');
  check('search matches the church', x.total === live((s) => s.church === 'Synthetic Church 2').length, String(x.total));
  x = await q('author 3');
  check('search matches the author', x.total === 22, String(x.total));
  x = await q('hidden-needle');
  check('search matches the body', x.slugs.join() === 'synth-s09', x.slugs.join());
  x = await q('100%');
  check('a literal % is matched literally (only story 5 has "100%")', x.slugs.join() === 'synth-s05', x.slugs.join());
  x = await q('%');
  check('a lone % matches only stories that contain a percent sign', x.slugs.join() === 'synth-s05', x.slugs.join());
  x = await q('snake_case');
  check('a literal _ is matched literally', x.slugs.join() === 'synth-s05', x.slugs.join());
  x = await q('_');
  check('a lone _ matches only text with an underscore, not any character', x.slugs.join() === 'synth-s05', x.slugs.join());
  x = await q('back\\slash');
  check('a backslash is matched literally', x.slugs.join() === 'synth-s06', x.slugs.join());
  x = await q("'; DROP TABLE stories; --");
  check('SQL in the search box is just text: no match, the page still renders, stories survive', x.total === 0 && (await get()).status === 200 && totalOf((await get()).html) === 66);
  x = await q('"><img src=x onerror=alert(1)><script>alert(1)</script>');
  const noAttrs = x.html.replace(/="[^"]*"/g, '=""').replace(/<script[\s\S]*?<\/script>/g, '');
  check('the search text cannot break out of its attributes or become markup anywhere on the page', !/<img src=x/.test(noAttrs) && !/<script>alert/.test(noAttrs) && x.html.includes('Search: &quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;') && x.html.includes('value="&quot;'), x.html.match(/.{40}onerror.{40}/g)?.join(' | '));
  x = await q('x'.repeat(500));
  check('the search text is cut to 200 characters', x.html.includes('value="' + 'x'.repeat(200) + '"') && !x.html.includes('x'.repeat(201)));
  x = await q('   ');
  check('a blank search is no search', x.total === 66);

  // ---------- filters ----------
  const f = async (qs) => { const y = await get('?perPage=100&' + qs); return { total: totalOf(y.html), slugs: slugsOf(y.html), html: y.html }; };
  const same = (got, want) => got.length === want.length && want.every((s) => got.includes(s));
  x = await f('section=news');
  check('section = membership of the primary section', same(x.slugs, live((s) => s.sec === 'news')), String(x.total));
  x = await f('section=youth');
  check('section includes stories that list it as an additional section (story 2)', same(x.slugs, live((s) => s.sec === 'youth' || s.extra.includes('youth'))) && x.slugs.includes(S[2].slug), String(x.total));
  x = await f('section=news&area=schools');
  check('section + area filters by the primary section and area', same(x.slugs, live((s) => s.sec === 'news' && s.area === 'schools')) && x.total > 0, String(x.total));
  x = await f('area=schools');
  check('an area without a section is ignored', x.total === 66, String(x.total));
  x = await f('section=features&area=schools');
  check('an area that does not belong to the section is ignored', same(x.slugs, live((s) => s.sec === 'features')), String(x.total));
  x = await f('section=columns');
  check('the retired columns key means features', same(x.slugs, live((s) => s.sec === 'features')), String(x.total));
  x = await f('issue=2');
  check('issue=<n> lists that issue', same(x.slugs, live((s) => s.issue === 2)) && x.total === 10, String(x.total));
  x = await f('issue=none');
  check('issue=none lists stories without an issue', same(x.slugs, live((s) => s.issue === null)) && x.total === 36, String(x.total));
  x = await f('year=2025');
  check('year filters on the story date year', same(x.slugs, live((s) => s.date.startsWith('2025'))) && x.total === 26, String(x.total));
  x = await f('featured=yes');
  check('featured=yes lists featured stories only', same(x.slugs, live((s) => s.featured)), String(x.total));
  x = await f('openDraft=yes');
  check('openDraft=yes lists stories with an open In review / new draft', same(x.slugs, [S[4].slug, ...sl(10, 20, 30)]) && /adm-badge opendraft/.test(x.html), x.slugs.join());
  x = await f('edited=month');
  check('edited=month lists stories edited since the start of the Chicago month', same(x.slugs, live((s) => s.isEdited && s.edited >= monthStart)) && !x.slugs.includes(S[14].slug), String(x.total));
  x = await f('q=' + S[15].slug + '&edited=month');
  check('a story republished with changes counts as edited even though published_at equals edited_at (first publish comes from the draft record)', S[15].isEdited && S[15].edited >= monthStart ? x.slugs.join() === S[15].slug : true);
  x = await f('section=news&featured=yes&year=2026&issue=1');
  check('filters combine (AND)', same(x.slugs, live((s) => s.sec === 'news' && s.featured && s.date.startsWith('2026') && s.issue === 1)), `${x.total} ${x.slugs}`);
  x = await f('q=synthetic&section=kids&issue=none');
  check('search combines with other filters', same(x.slugs, live((s) => s.sec === 'kids' && s.issue === null)), String(x.total));

  // ---------- sorts ----------
  const order = async (sort) => slugsOf((await get(`?perPage=100&sort=${sort}`)).html);
  const bySlug = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const mine = Object.values(S);
  let got = await order('published_desc');
  check('sort published_desc: story 3 (record) first, then by published time newest first (story 1, 2, 4...)', got[0] === S[3].slug && got.slice(1, 4).join() === sl(1, 2, 4).join(), got.slice(0, 4).join());
  got = await order('published_asc');
  check('sort published_asc is the reverse of the stored publish times', got[got.length - 1] === S[3].slug && got[0] === S[65].slug, `${got[0]} ${got[got.length - 1]}`);
  got = await order('edited_desc');
  const editedSorted = mine.filter((s) => s.isEdited).sort((a, b) => b.edited - a.edited || bySlug(a.slug, b.slug)).map((s) => s.slug);
  const neverEdited = mine.filter((s) => !s.isEdited).map((s) => s.slug).sort(bySlug);
  check('sort edited_desc: edited stories newest edit first, others (including plain first publishes) last in slug order', got.join() === [...editedSorted, ...neverEdited].join(), got.slice(0, 5).join());
  got = await order('date_desc');
  check('sort date_desc: story date newest first, slug breaks ties', got.join() === [...mine].sort((a, b) => b.date.localeCompare(a.date) || bySlug(a.slug, b.slug)).map((s) => s.slug).join());
  got = await order('title');
  check('sort title: A to Z, slug breaks ties', got.join() === [...mine].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || bySlug(a.slug, b.slug)).map((s) => s.slug).join(), got.slice(0, 4).join());
  got = await order('section');
  const secKey = (s) => s.sec + '\u0000' + (s.area || '');
  check('sort section: grouped by section then area, slug breaks ties', got.join() === [...mine].sort((a, b) => bySlug(secKey(a), secKey(b)) || bySlug(a.slug, b.slug)).map((s) => s.slug).join(), got.slice(0, 4).join());
  const again = await order('title');
  check('sorting is stable: the same query returns the same order', again.join() === (await order('title')).join());

  // ---------- paging ----------
  const p1 = await get('?sort=title'), p2 = await get('?sort=title&page=2'), p3 = await get('?sort=title&page=3');
  const s1 = slugsOf(p1.html), s2 = slugsOf(p2.html), s3 = slugsOf(p3.html);
  check('25 a page over 66 stories is 25 + 25 + 16 with no overlap, matching the full sorted order', s1.length === 25 && s2.length === 25 && s3.length === 16 && [...s1, ...s2, ...s3].join() === (await order('title')).join());
  check('the pager says where you are and links the other pages', p2.html.includes('Showing 26 to 50 of 66') && /aria-current="page"[^>]*aria-label="Page 2"|aria-label="Page 2"[^>]*aria-current="page"/.test(p2.html) && p2.html.includes('rel="prev"') && p2.html.includes('rel="next"') && p3.html.includes('Showing 51 to 66 of 66') && !p3.html.includes('rel="next"'));
  check('page links keep the other query parameters', /href="\/admin\/published\?sort=title&amp;page=3"/.test(p2.html));
  x = await get('?perPage=50&page=2');
  check('perPage=50 makes two pages, 50 then 16', slugsOf((await get('?perPage=50')).html).length === 50 && slugsOf(x.html).length === 16);
  x = await get('?page=99');
  check('a page past the end shows the last page', slugsOf(x.html).length === 16 && x.html.includes('Showing 51 to 66 of 66'));
  x = await get('?q=zzzz-no-such-story');
  check('no matches says so, with no table and a clear-filters link', totalOf(x.html) === 0 && x.html.includes('No published stories match these filters.') && x.html.includes('Clear filters') && !x.html.includes('class="adm-table"'));

  // ---------- invalid parameters fall back to the default ----------
  const base66 = slugsOf((await get()).html).join();
  for (const qs of ['sort=title;DROP', 'sort=nope', 'perPage=7', 'perPage=100000', 'perPage=abc', 'page=-3', 'page=abc', 'page=0', 'section=nope', 'issue=abc', 'issue=-1', 'issue=99999', 'year=20x6', 'year=2026-01', 'featured=no', 'openDraft=1', 'edited=week', 'section[]=news', 'q[]=x']) {
    const y = await get('?' + qs);
    check(`invalid parameter "${qs}" falls back to the default list`, y.status === 200 && slugsOf(y.html).join() === base66 && totalOf(y.html) === 66, `${y.status} ${totalOf(y.html)}`);
  }
  x = await get('?issue=7');
  check('an issue number nothing uses is an empty list, not an error', x.status === 200 && totalOf(x.html) === 0);

  // ---------- review follow-ups ----------
  x = await get('?perPage=100');
  const row14 = rowsOf(x.html).find((t) => t.includes('/stories/synth-s14/'));
  check('a plain first publish (edited_at 10 s after publishing) shows no Edited date', !!row14 && /data-label="Edited">—</.test(row14), row14?.slice(-500));
  const row11 = rowsOf(x.html).find((t) => t.includes('/stories/synth-s11/'));
  check('a really edited story shows an Edited date', /data-label="Edited"><time/.test(row11 || ''));
  x = await get('?issue=42&year=1999');
  check('an issue or year missing from the menus stays as a selected option, so Apply keeps it', /<option value="42" selected>Issue #42<\/option>/.test(x.html) && /<option value="1999" selected>1999<\/option>/.test(x.html));
  x = await get('?sort=title');
  check('the off Previous link is aria-disabled', /<span class="adm-off" aria-disabled="true">Previous<\/span>/.test(x.html));
  check('row Edit and Unpublish buttons carry the story title in their accessible names', /<button class="cms-btn" type="submit">Edit<span class="adm-sr"> [^<]+<\/span><\/button>/.test(x.html) && /Unpublish<span class="adm-sr"> [^<]+<\/span>/.test(x.html));

  // ---------- chips, form, notices, failure message ----------
  x = await get('?section=news&featured=yes&q=synthetic');
  check('active filters show as removable chips, and the form is a GET form', /adm-chip/.test(x.html) && x.html.includes('Section: News') && x.html.includes('Remove filter Featured') && /<form class="adm-search" method="get"/.test(x.html));
  r = await get('?n=unpublished&e=slug_bad');
  check('?n= and ?e= notices still show', r.html.includes('off the site now') && /role="alert"/.test(r.html));
  check('the list shows no email addresses', !/list-pub@example\.test|list-editor@example\.test/.test((await get()).html));

  // ---------- browser: no horizontal scroll, screenshots (optional; needs Playwright and Chromium) ----------
  let browser;
  try {
    const { chromium } = createRequire((process.env.PLAYWRIGHT_ROOT || '/opt/node-tools') + '/package.json')('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox'] });
  } catch (err) {
    console.log('SKIP  browser checks (Playwright/Chromium not available):', String(err.message).slice(0, 100));
  }
  if (browser) {
    try {
      const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : '';
      if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
      for (const width of [360, 390, 768, 1280]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.setExtraHTTPHeaders({ Cookie: `__Host-imc_session=${token}` });
        const page = await context.newPage();
        for (const [name, qs] of [['default', ''], ['filtered', '?section=news&sort=title&perPage=50&page=1']]) {
          await page.goto(`${base}/admin/published${qs}`);
          await page.waitForSelector('.adm-table');
          const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          check(`${width}px ${name}: no horizontal page scroll`, over <= 0, `scrollWidth overflow ${over}px: ` + (over > 0 ? await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !e.closest('.adm-table-wrap')).slice(0, 4).map((e) => e.tagName + '.' + e.className).join(' ')) : ''));
          const small = await page.evaluate(() => {
            const sel = ['.adm-search select', '.adm-search input[type=search]', '.adm-apply', '.adm-table .bulk-pick', '.adm-actions .cms-btn', '.adm-pager nav a', '.adm-chip a'];
            return sel.flatMap((q) => [...document.querySelectorAll(q)].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5 ? `${q} ${Math.round(r.width)}x${Math.round(r.height)}` : null; })).filter(Boolean);
          });
          check(`${width}px ${name}: controls are at least 44px`, small.length === 0, small.slice(0, 4).join('; '));
          if (width < 768) {
            const side = await page.evaluate(() => { const b = [...document.querySelectorAll('.adm-actions')][0].querySelectorAll('.cms-btn'); const a = b[0].getBoundingClientRect(), c = b[1].getBoundingClientRect(); return Math.abs(a.top - c.top) < 2 && c.left - a.right >= 4; });
            check(`${width}px ${name}: Edit and Unpublish sit side by side with a gap`, side);
          }
          if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `published-${name}-${width}.png`), fullPage: width < 768 });
        }
        await context.close();
      }
    } catch (err) {
      check('browser checks ran to the end', false, String(err).slice(0, 300));
    } finally {
      await browser.close();
    }
  }

  // The load-failure message: make the table unreadable (rename it), then restore it.
  stop(); await delay(500);
  db = openDatabase(scratch);
  db.exec('ALTER TABLE stories RENAME TO stories_away');
  db.close(); db = undefined;
  server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: port, DATA_DIR: scratch, SITE_URL: base, AUTH_SECRET: 'synthetic-published-list-' + 'x'.repeat(40), TRUST_PROXY: 'true', RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (c) => logs.push(String(c))); server.stderr.on('data', (c) => logs.push(String(c)));
  for (let i = 0; i < 150; i++) { try { await fetch(base + '/admin/login'); break; } catch { await delay(100); } }
  r = await get();
  check('when the story list cannot be read the page says so and shows no list', r.status === 200 && r.html.includes('The story list could not be read. Please reload in a minute.') && !r.html.includes('class="adm-table"'), `${r.status}`);
} catch (err) {
  check('the script ran to the end', false, String(err?.stack || err).slice(0, 600));
} finally {
  stop();
  try { db?.close(); } catch { /* closed */ }
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} check(s) FAILED\n${logs.slice(-6).join('')}` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
