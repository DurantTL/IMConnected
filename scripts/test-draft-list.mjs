#!/usr/bin/env node
// End-to-end check of the editor drafts list (issue #139): search, filters, sorting, paging, status cards and the
// bulk bar, against the BUILT server with a throwaway DATA_DIR and 64+ synthetic drafts. No network, no real data.
//   npm run build
//   node scripts/test-draft-list.mjs            # from the repo root
// Optional: SHOTS=<folder> saves screenshots (needs Playwright; PLAYWRIGHT_ROOT, CHROMIUM_PATH, CHROMIUM_NO_SANDBOX=1).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const ROOT = process.cwd();
const PORT = 4871;
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-draft-list-'));
const shots = process.env.SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
let db, server, browser, checks = 0;
const logs = [];
const check = (name, ok, extra = '') => { assert.ok(ok, name + (extra ? ` (${extra})` : '')); checks++; console.log('PASS ' + name); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  db = openDatabase(scratch);
  runMigrations(db, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  const run = (sql, ...v) => db.prepare(sql).run(...v);
  const rows = (sql, ...v) => db.prepare(sql).all(...v);
  run('INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)', 'git_adopted_at', String(Date.now()), Date.now());
  const now = Date.now();
  const user = Number(run("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES('editor@synthetic.invalid','Synthetic editor','editor','active',?,?)", now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  run('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)', createHash('sha256').update(token).digest('hex'), user, now, now, now + 86400000);
  for (const [n, title] of [[5, 'Synthetic issue five'], [6, '']]) run('INSERT INTO newsletter_issues(number,date,title,created_at,updated_at) VALUES(?,?,?,?,?)', n, '2026-09-01', title, now, now);

  // ---- 64 synthetic drafts, deterministic so the expectations below can be computed here ----
  const DAY = 86400000;
  const sections = ['news', 'youth', 'features'];
  const sources = ['form', 'agent', 'editor', 'studio'];
  const specials = {
    3: { title: 'Synthetic 100% Turnout Report' },
    4: { title: 'Synthetic 100 Percent Decoy' },
    5: { title: 'Synthetic a_b Underscore Notes' },
    6: { title: 'Synthetic aXb Decoy Notes' },
    7: { title: 'Synthetic back\\slash Letter' },
    8: { title: 'synthetic lowercase NEEDLE title' },
    9: { church: 'Synthetic Haystack Church' },
    10: { author: 'Synthetic Haystack Author' },
    11: { body: 'The haystackbodyword appears only in this body.' },
    12: { submitterChurch: 'Synthetic Submitter Fellowship' },
  };
  const D = [];
  for (let i = 1; i <= 64; i++) {
    const sp = specials[i] || {};
    const kind = i % 16 === 0 ? 'event' : i % 8 === 0 ? 'announcement' : 'story';
    const status = i % 11 === 0 ? 'rejected' : i % 13 === 0 ? 'published' : i % 2 === 0 ? 'in_review' : 'new';
    const d = {
      i, kind, status,
      title: sp.title ?? `Synthetic Draft ${String(i).padStart(2, '0')} ${['Alpha', 'Bravo', 'Charlie', 'Delta'][i % 4]}`,
      church: sp.church ?? `Synthetic Church ${i % 5}`,
      author: sp.author ?? `Synthetic Author ${i % 7}`,
      body: sp.body ?? `Synthetic body number ${i}.`,
      submitterChurch: sp.submitterChurch ?? null,
      section: sections[i % 3],
      additional: i % 10 === 0 ? ['features'] : [],
      source: sources[i % 4],
      date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`,
      issue: i % 9 === 0 ? 5 : i % 9 === 1 ? 6 : null,
      created: now - (100 - i) * 3600000 * 5,
      updated: now - ((i * 37) % 64) * 3600000 - i, // a different order from created
      publishAt: [20, 22, 24].includes(i) ? now + (30 - i) * DAY : null,
    };
    if (d.publishAt && d.status !== 'in_review') d.status = 'in_review';
    D.push(d);
    run(
      `INSERT INTO drafts(id,status,source,title,section,area,additional_sections,author,church,date,body,announcement,submitter_name,submitter_email,submitter_phone,submitter_church,newsletter_issue,publish_at,created_at,updated_at,email_verified)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      i, d.status, d.source, d.title, d.section, '', JSON.stringify(d.additional), d.author, d.church, d.date, d.body,
      d.kind === 'story' ? null : JSON.stringify({ kind: d.kind, links: [] }),
      `Submitter Person ${i}`, `submitter${i}@contacts.invalid`, `555-0100-${String(i).padStart(2, '0')}`, d.submitterChurch, d.issue, d.publishAt, d.created, d.updated, i % 3 === 0 ? 1 : 0,
    );
  }
  // ---- live stories for the Published cards (issue #164): 4 stories, 3 announcements, 2 events; plus rows that never count ----
  const LIVE = { story: 0, announcement: 0, event: 0 };
  // Dates relative to today's America/Chicago day so the event ordering holds on any run date.
  const ymdNow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  let ln = 0;
  // opts: eventDate (string; null leaves it out; a number is stored as a non-text value), source, pub (published_at), slug, title.
  const liveIns = (kind, status, draft, opts = {}) => {
    ln++;
    const slug = opts.slug ?? `synth-live-${ln}`;
    const ann = kind === 'story' ? null : JSON.stringify({ kind, ...(opts.eventDate === null ? {} : { eventDate: opts.eventDate ?? '2026-12-01' }) });
    run("INSERT INTO stories(slug,title,dek,section,area,author,church,date,body,status,source,published_at,updated_at,featured,draft,additional_sections,announcement) VALUES(?,?,'Synthetic summary.','news',NULL,'Synthetic Author','Synthetic Church','2026-06-01','Synthetic body.',?,?,?,?,0,?,'[]',?)",
      slug, opts.title ?? `Synthetic Live ${ln}`, status, opts.source ?? 'editor', opts.pub ?? now, opts.pub ?? now, draft, ann);
    if (status === 'live' && !draft) LIVE[kind]++;
    return slug;
  };
  for (let j = 0; j < 4; j++) liveIns('story', 'live', 0);
  for (let j = 0; j < 3; j++) liveIns('announcement', 'live', 0);
  // Events, inserted the way Studio (source studio) and the archive adoption (source git) leave them: no draft row at all.
  const EV = {
    far: liveIns('event', 'live', 0, { eventDate: addDays(ymdNow, 30), source: 'studio', title: 'Synthetic Event Far', slug: 'synth-ev-far' }),
    soon: liveIns('event', 'live', 0, { eventDate: addDays(ymdNow, 2), source: 'git', title: 'Synthetic Event Soon', slug: 'synth-ev-soon' }),
    today: liveIns('event', 'live', 0, { eventDate: ymdNow, source: 'studio', title: 'Synthetic Event Today', slug: 'synth-ev-today' }),
    yesterday: liveIns('event', 'live', 0, { eventDate: addDays(ymdNow, -1), source: 'git', title: 'Synthetic Event Yesterday', slug: 'synth-ev-yesterday' }),
    old: liveIns('event', 'live', 0, { eventDate: addDays(ymdNow, -40), source: 'git', title: 'Synthetic Event Old', slug: 'synth-ev-old' }),
    none: liveIns('event', 'live', 0, { eventDate: null, title: 'Synthetic Event No Date', slug: 'synth-ev-none', pub: now - 1000 }),
    num: liveIns('event', 'live', 0, { eventDate: 20261201, title: 'Synthetic Event Odd Date', slug: 'synth-ev-num', pub: now - 2000 }),
  };
  const EV_ORDER = [EV.today, EV.soon, EV.far, EV.yesterday, EV.old, EV.none, EV.num];
  // 27 more announcements (30 in all) so the live section has a second page; newest published first is by published_at.
  const ANN_EXTRA = [];
  for (let j = 0; j < 27; j++) ANN_EXTRA.push(liveIns('announcement', 'live', 0, { slug: `synth-ann-${String(j).padStart(2, '0')}`, title: `Synthetic Announcement ${String(j).padStart(2, '0')}`, source: j % 2 ? 'git' : 'studio', pub: now - 5000 - j * 1000 }));
  liveIns('event', 'unpublished', 0); liveIns('announcement', 'live', 1);
  const ids = (list) => list.map((d) => d.i);
  const open = (d) => d.status === 'new' || d.status === 'in_review';
  const by = (cmp) => (list) => [...list].sort((a, b) => cmp(a, b) || a.i - b.i);
  const stories = D.filter((d) => d.kind === 'story');

  server = spawn(process.execPath, ['dist/server/entry.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: scratch, SITE_URL: BASE, AUTH_SECRET: 'synthetic-draft-list-auth-' + 's'.repeat(40), AGENT_API_TOKEN: '', PUBLISH_TOKEN: '', RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '', NO_PROXY: 'localhost,127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/admin/login'); ready = true; break; } catch { await delay(100); } }
  check('built server starts', ready);
  // HOLD=<seconds> keeps the seeded server up for manual looks (prints the session cookie value; synthetic only).
  if (process.env.HOLD) { console.log('TOKEN=' + token); await delay(Number(process.env.HOLD) * 1000); }
  const headers = { Origin: BASE, Cookie: `__Host-imc_session=${token}` };
  const get = async (url) => { const r = await fetch(BASE + url, { redirect: 'manual', headers }); return { status: r.status, text: await r.text() }; };
  // The draft ids shown in the table, in order.
  const shown = (html) => [...html.matchAll(/class="adm-title" href="\/admin\/drafts\/(\d+)"/g)].map((m) => Number(m[1]));
  const list = async (qs, base = '/admin') => { const r = await get(base + (qs ? '?' + qs : '')); assert.equal(r.status, 200, `GET ${qs}`); return { ...r, ids: shown(r.text) }; };
  const same = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);
  const sameSet = (a, b) => same([...a].sort((x, y) => x - y), [...b].sort((x, y) => x - y));

  // ---- default view, paging, totals ----
  const openStories = stories.filter(open);
  const updatedDesc = by((a, b) => b.updated - a.updated || b.i - a.i);
  const resort = (arr, cmp) => [...arr].sort(cmp);
  const byUpdated = (arr) => resort(arr, (a, b) => b.updated - a.updated || b.i - a.i);
  let r = await list('');
  check('default: open stories, newest updated first, 25 per page', same(r.ids, ids(byUpdated(openStories)).slice(0, 25)), `${r.ids.length}`);
  check('summary line shows the total and the sort label', r.text.includes(`<strong>${openStories.length}</strong> drafts shown`) && r.text.includes('Recently updated'));
  check('"Showing 1–25 of N"', r.text.includes(`Showing 1–25 of ${openStories.length}`));
  check('pager is a nav labelled Pages with the current page marked', /<nav aria-label="Pages">/.test(r.text) && /aria-current="page"[^>]*>1<\/a>|aria-current="page"[^>]*aria-label="Page 1"/.test(r.text) && r.text.includes('rel="next"') && !r.text.includes('rel="prev"'));
  r = await list('page=2');
  check('page 2 shows rows 26 to 50', same(r.ids, ids(byUpdated(openStories)).slice(25, 50)) || r.ids.length === openStories.length - 25, `${r.ids.length}`);
  const allOpenAll = D.filter((d) => open(d));
  r = await list('kind=all&perPage=100&sort=title');
  check('perPage=100 shows everything open across all types on one page', r.ids.length === allOpenAll.length && sameSet(r.ids, ids(allOpenAll)));
  r = await list('kind=all&page=999');
  const lastCount = allOpenAll.length - Math.floor((allOpenAll.length - 1) / 25) * 25;
  check('a page past the end shows the last page', r.ids.length === lastCount && r.text.includes(`of ${allOpenAll.length}`) && !r.text.includes('rel="next"'));
  check('page=abc, page=0 and page=-3 are page 1', same((await list('page=abc')).ids, (await list('')).ids) && same((await list('page=0')).ids, (await list('')).ids) && same((await list('page=-3')).ids, (await list('')).ids));
  check('perPage=7 falls back to 25', (await list('perPage=7')).ids.length === 25);
  r = await list('kind=all&status=all&perPage=50&page=2');
  check('pager links keep the query state (status, kind, perPage)', r.text.includes('href="/admin?kind=all&amp;status=all&amp;perPage=50"') && r.text.includes('aria-label="Pages"'));

  // ---- status cards ----
  r = await list('');
  const cnt = (f) => stories.filter(f).length;
  const card = (label) => { const m = r.text.match(new RegExp(`<a class="adm-stat"[^>]*>\\s*<span class="adm-stat-label">${label}</span>\\s*<strong>(\\d+)</strong>`)); return m ? Number(m[1]) : -1; };
  check('status cards carry counts for the current kind', card('Needs a person') === cnt(open) && card('New') === cnt((d) => d.status === 'new') && card('In review') === cnt((d) => d.status === 'in_review') && card('Scheduled') === cnt((d) => d.publishAt && open(d)) && card('Rejected') === cnt((d) => d.status === 'rejected'));
  check('the active card has aria-current and the others do not', /<a class="adm-stat" href="\/admin"[^>]*aria-current="true"/.test(r.text) && (r.text.match(/class="adm-stat"[^>]*aria-current/g) || []).length === 1);
  r = await list('status=rejected');
  check('card links set status; the Rejected card is current', /href="\/admin\?status=rejected" aria-current="true"/.test(r.text) && r.text.includes('Rejected') && sameSet(r.ids, ids(stories.filter((d) => d.status === 'rejected'))));
  const evCounts = (await list('', '/admin/events')).text.match(/<strong>(\d+)<\/strong>\s*<span class="adm-stat-note">New and in review/);
  check('cards honour the content type (events page)', evCounts && Number(evCounts[1]) === D.filter((d) => d.kind === 'event' && open(d)).length);

  // ---- status filter ----
  for (const [s, f] of [['new', (d) => d.status === 'new'], ['in_review', (d) => d.status === 'in_review'], ['scheduled', (d) => d.publishAt && open(d)], ['published', (d) => d.status === 'published'], ['rejected', (d) => d.status === 'rejected'], ['all', () => true], ['open', open]]) {
    const x = await list(`kind=all&perPage=100&status=${s}`);
    check(`status=${s}`, sameSet(x.ids, ids(D.filter(f))), `${x.ids.length} vs ${D.filter(f).length}`);
  }
  r = await list('status=scheduled');
  check('scheduled defaults to soonest first and shows the Central time', same(r.ids, ids(D.filter((d) => d.kind === 'story' && d.publishAt && open(d)).sort((a, b) => a.publishAt - b.publishAt || a.i - b.i))) && /Scheduled for\s*<time[^>]*>[^<]*CDT|Scheduled for\s*<time[^>]*>[^<]*CST/.test(r.text) && r.text.includes('Publish time, soonest first'));

  // ---- kind and presets ----
  for (const k of ['story', 'announcement', 'event', 'all']) {
    const x = await list(`status=all&perPage=100&kind=${k}`);
    const exp = k === 'all' ? D : D.filter((d) => d.kind === k);
    check(`kind=${k}`, sameSet(x.ids, ids(exp)));
  }
  check('/admin/announcements and /admin/events are kind presets', sameSet((await list('status=all&perPage=100', '/admin/announcements')).ids, ids(D.filter((d) => d.kind === 'announcement'))) && sameSet((await list('status=all&perPage=100', '/admin/events')).ids, ids(D.filter((d) => d.kind === 'event'))));
  check('...and the preset path wins over a kind parameter', sameSet((await list('status=all&kind=all&perPage=100', '/admin/events')).ids, ids(D.filter((d) => d.kind === 'event'))));
  check('...their own links stay on the preset path', (await get('/admin/events?status=all&perPage=100')).text.includes('href="/admin/events?status=rejected&amp;perPage=100"'));

  // ---- Published card (issue #164) ----
  for (const [pth, k] of [['/admin', 'story'], ['/admin/announcements', 'announcement'], ['/admin/events', 'event']]) {
    const t = (await get(pth)).text;
    const m = t.match(/<a class="adm-stat" href="([^"]*)" aria-label="([^"]*)">\s*<span class="adm-stat-label">Published<\/span>\s*<strong>(\d+)<\/strong>\s*<span class="adm-stat-note">([^<]*)<\/span>/);
    check(`${pth}: Published card shows ${LIVE[k]} live ${k} items`, m && Number(m[3]) === LIVE[k], m ? m[3] : 'no card');
    check(`${pth}: Published card (issue #168: the live section's #live on the two type pages, the published list for stories) for ${k}, says it is live, reads well to screen readers`, m && m[1].replace(/&amp;/g, '&') === (k === 'story' ? '/admin/published?kind=story' : '#live') && m[4] === 'Live on the site' && m[2] === `Published, ${LIVE[k]}, live on the site`, m ? `${m[1]} ${m[2]}` : '');
    check(`${pth}: the Published card is not a draft status (no status= in its link, not aria-current)`, m && !m[1].includes('status=') && !/class="adm-stat"[^>]*href="[^"]*published\?[^"]*"[^>]*aria-current/.test(t));
  }
  r = await list('kind=all&status=all&perPage=100');
  check('/admin?kind=all: the Published card counts every type and opens the whole list', new RegExp(`>\\s*<strong>${LIVE.story + LIVE.announcement + LIVE.event}<\\/strong>\\s*<span class="adm-stat-note">Live on the site`).test(r.text) && r.text.includes('href="/admin/published"'));
  check('the draft status filters are unchanged: status=published is still the drafts table, not the live stories', sameSet((await list('kind=all&status=published&perPage=100')).ids, ids(D.filter((d) => d.status === 'published'))));
  check('Newest published heading links to the whole published list (the panel shows every type)', (await get('/admin')).text.includes('<h2 id="home-pub"><a class="adm-head-link" href="/admin/published">Newest published</a></h2>'));

  // ---- section, source, issue, dates ----
  const base = 'kind=all&status=all&perPage=100';
  check('section filter matches the primary section and extra memberships', sameSet((await list(`${base}&section=features`)).ids, ids(D.filter((d) => d.section === 'features' || d.additional.includes('features')))));
  check('section=youth', sameSet((await list(`${base}&section=youth`)).ids, ids(D.filter((d) => d.section === 'youth' || d.additional.includes('youth')))));
  check('retired section key columns is read as features', sameSet((await list(`${base}&section=columns`)).ids, (await list(`${base}&section=features`)).ids));
  for (const s of sources) check(`source=${s}`, sameSet((await list(`${base}&source=${s}`)).ids, ids(D.filter((d) => d.source === s))));
  check('issue=5', sameSet((await list(`${base}&issue=5`)).ids, ids(D.filter((d) => d.issue === 5))));
  check('issue=6', sameSet((await list(`${base}&issue=6`)).ids, ids(D.filter((d) => d.issue === 6))));
  check('issue=none', sameSet((await list(`${base}&issue=none`)).ids, ids(D.filter((d) => d.issue === null))));
  check('from/to story-date range', sameSet((await list(`${base}&from=2026-03-01&to=2026-05-31`)).ids, ids(D.filter((d) => d.date >= '2026-03-01' && d.date <= '2026-05-31'))));
  check('from alone and to alone', sameSet((await list(`${base}&from=2026-08-01`)).ids, ids(D.filter((d) => d.date >= '2026-08-01'))) && sameSet((await list(`${base}&to=2026-02-28`)).ids, ids(D.filter((d) => d.date <= '2026-02-28'))));
  check('filters combine', sameSet((await list(`${base}&source=agent&section=news&issue=none`)).ids, ids(D.filter((d) => d.source === 'agent' && (d.section === 'news' || d.additional.includes('news')) && d.issue === null))));

  // ---- search ----
  const q = async (term, extra = '') => list(`${base}${extra}&q=${encodeURIComponent(term)}`);
  check('search is case-insensitive and finds a title', sameSet((await q('needle')).ids, [8]) && sameSet((await q('NEEDLE')).ids, [8]));
  check('search finds church, submitter church, author and body', sameSet((await q('haystack church')).ids, [9]) && sameSet((await q('haystack author')).ids, [10]) && sameSet((await q('haystackbodyword')).ids, [11]) && sameSet((await q('submitter fellowship')).ids, [12]));
  check('search matches a substring', sameSet((await q('ndercore')).ids, [5]) === false && sameSet((await q('nderscore')).ids, [5]));
  check('% is literal', sameSet((await q('100%')).ids, [3]) && sameSet((await q('%')).ids, [3]));
  check('_ is literal', sameSet((await q('a_b')).ids, [5]) && sameSet((await q('_')).ids, [5]));
  check('a backslash is literal', sameSet((await q('back\\slash')).ids, [7]) && sameSet((await q('\\')).ids, [7]));
  check('search never matches contact details (email, phone, submitter name)', (await q('contacts.invalid')).ids.length === 0 && (await q('submitter12@')).ids.length === 0 && (await q('555-0100')).ids.length === 0 && (await q('Submitter Person')).ids.length === 0);
  check('an empty or whitespace search is no filter', (await list(`${base}&q=%20%20`)).ids.length === 64);
  check('an injection attempt is only text and the table survives', (await q("'; DROP TABLE drafts;--")).ids.length === 0 && rows('SELECT COUNT(*) n FROM drafts')[0].n === 64);
  const long = 'x'.repeat(300);
  const longPage = await q(long);
  check('a 300 character search is cut to 200 characters, not an error', longPage.status === 200 && longPage.text.includes('value="' + 'x'.repeat(200) + '"') && !longPage.text.includes('x'.repeat(201)));
  const xss = (await q('<script>alert(1)</script>')).text;
  check('search text is escaped in the page (only the quoted value attribute holds it raw)', xss.includes('Search: &lt;script&gt;') && !xss.replace(/value="[^"]*"/g, '').includes('<script>alert(1)'));
  check('the search box and chips are rendered', (await q('needle')).text.includes('Search: needle') && (await q('needle')).text.includes('Clear filters'));

  // ---- sorts (stable, id tiebreak) ----
  const sortCheck = (name, sortKey, cmp) => async () => {
    const x = await list(`kind=all&status=all&perPage=100&sort=${sortKey}`);
    check(`sort=${name}`, same(x.ids, ids(resort(D, cmp))), x.ids.slice(0, 6).join());
  };
  await sortCheck('updated', 'updated', (a, b) => b.updated - a.updated || b.i - a.i)();
  await sortCheck('created_desc', 'created_desc', (a, b) => b.created - a.created || b.i - a.i)();
  await sortCheck('created_asc', 'created_asc', (a, b) => a.created - b.created || a.i - b.i)();
  await sortCheck('date_desc', 'date_desc', (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || b.i - a.i)();
  await sortCheck('title', 'title', (a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : 0) || a.i - b.i)();
  await sortCheck('scheduled', 'scheduled', (a, b) => (a.publishAt === null) - (b.publishAt === null) || (a.publishAt ?? 0) - (b.publishAt ?? 0) || a.i - b.i)();
  r = await list('sort=title');
  check('sortable headers carry aria-sort and are links', /<th scope="col" aria-sort="ascending"><a href="\/admin\?sort=title">Story<\/a>/.test(r.text) || /aria-sort="ascending"><a href="\/admin\?sort=title"/.test(r.text));
  check('an inactive sortable header says aria-sort="none"', /aria-sort="none"><a href="[^"]*sort=date_desc"/.test(r.text));

  // A chosen sort must not stick to the status cards: Scheduled keeps its soonest-first default.
  r = await list('sort=title&q=Synthetic');
  const schedHref = (r.text.match(/<a class="adm-stat" href="([^"]*)"[^>]*>\s*<span class="adm-stat-label">Scheduled</) || [])[1];
  check('status card links drop the chosen sort (keeping other filters)', schedHref && !schedHref.includes('sort=') && schedHref.includes('status=scheduled') && schedHref.includes('q=Synthetic'), schedHref);
  const afterCard = await list(schedHref.replace(/^\/admin\?/, '').replace(/&amp;/g, '&'));
  check('...so Scheduled opens in publish-time order', same(afterCard.ids, ids(D.filter((d) => d.kind === 'story' && d.publishAt && open(d)).sort((a, b) => a.publishAt - b.publishAt || a.i - b.i))) && afterCard.text.includes('Publish time, soonest first'));
  r = await list('status=scheduled&sort=updated');
  check('a sort equal to the default is left out of links (Sort select submits it always)', !/href="[^"]*sort=updated/.test((await list('sort=updated&status=new')).text) && !/href="[^"]*sort=scheduled/.test((await list('status=scheduled&sort=scheduled')).text));
  check('an explicit non-default sort survives a filter change but not a card click', /href="[^"]*sort=title/.test((await list('sort=title')).text.replace(/<a class="adm-stat"[^>]*>/g, '')));

  // ---- invalid values fall back ----
  const plain = (await list('')).ids;
  for (const bad of ['sort=bogus', 'status=bogus', 'kind=bogus', 'source=nobody', 'source=form%27%20OR%201%3D1', 'section=zzz', 'issue=abc', 'issue=0', 'issue=99999', 'from=2026-13-45', 'to=notadate', 'perPage=1e9', 'page=1.5']) {
    check(`invalid ${bad} falls back to the default view`, same((await list(bad)).ids, plain));
  }

  // ---- the page itself ----
  r = await list('kind=all&status=all&q=Synthetic&section=news&issue=5&from=2026-01-01');
  check('removable chip per active filter and a Clear filters link', ['Search: Synthetic', 'Section: ', 'Issue #5', 'From 2026-01-01'].every((t) => r.text.includes(t)) && r.text.includes('remove filter'));
  check('Show 25/50/100 per page links', ['perPage=50', 'perPage=100'].every((t) => r.text.includes(t)) && /Show[\s\S]*25[\s\S]*per page/.test(r.text));
  check('the search card has Search, Section, Type, Source, Sort by, More filters and Apply', ['name="q"', 'name="section"', 'name="kind"', 'name="source"', 'name="sort"', '<details', 'More filters', 'name="issue"', 'name="from"', 'name="to"', '>Apply<'].every((t) => r.text.includes(t)) && /<form[^>]*method="get"/.test(r.text));
  check('Table: uppercase header styling hooks, Story, Status, Section, Source, Issue, Story date, Updated', ['Story</a>', 'Status</th>', 'Section</th>', 'Source</th>', 'Issue</th>', 'Story date</a>', 'Updated</a>'].every((t) => r.text.includes(t)));
  check('"From AI agent" and "Email verified" badges remain', (await list('kind=all&status=all&perPage=100&source=agent')).text.includes('From AI agent') && (await list('kind=all&status=all&perPage=100&source=form')).text.includes('Email verified'));
  const allPages = [await get('/admin'), await get('/admin?kind=all&status=all&perPage=100'), await get('/admin?status=published&q=synthetic'), await get('/admin/events')];
  check('no submitter email, phone or name appears in any list HTML', allPages.every((p) => !p.text.includes('contacts.invalid') && !p.text.includes('555-0100') && !p.text.includes('Submitter Person')));

  // ---- home blocks stay on the unfiltered view ----
  check('Newest drafts/published blocks appear on plain /admin and /admin?kind=all', (await get('/admin')).text.includes('Newest drafts') && (await get('/admin?kind=all')).text.includes('Newest published'));
  check('...and not on a filtered or paged view or a preset', ['/admin?status=new', '/admin?q=a', '/admin?page=2', '/admin?sort=title', '/admin/events', '/admin/announcements'].every((u) => !allPages.concat([]).length || true) && (await Promise.all(['/admin?status=new', '/admin?q=a', '/admin?page=2', '/admin?sort=title', '/admin/events', '/admin/announcements'].map(get))).every((p) => !p.text.includes('Newest drafts')));

  // ---- bulk bar and the confirm step ----
  r = await list('');
  check('bulk bar is posted to /admin/bulk and checkboxes are only on the page rows', r.text.includes('id="bulk-form"') && r.text.includes('action="/admin/bulk"') && (r.text.match(/class="bulk-item"/g) || []).length === r.ids.length);
  r = await list('kind=all&status=all&perPage=100');
  const pickableCount = D.filter(open).length;
  check('only new and in-review rows get a checkbox', (r.text.match(/class="bulk-item"/g) || []).length === pickableCount);
  const target = D.find((d) => d.status === 'new' && d.kind === 'story');
  const fd = new FormData();
  fd.set('action', 'reject'); fd.set('id', String(target.i)); fd.set(`v_${target.i}`, String(target.updated));
  const post = await fetch(BASE + '/admin/bulk', { method: 'POST', headers, body: fd });
  const postText = await post.text();
  check('a bulk reject only reaches the confirmation page; nothing is rejected yet', post.status === 200 && /confirm/i.test(postText) && rows('SELECT status FROM drafts WHERE id=?', target.i)[0].status === 'new');
  const fdPub = new FormData();
  fdPub.set('action', 'publish'); fdPub.set('id', String(target.i)); fdPub.set(`v_${target.i}`, String(target.updated));
  await fetch(BASE + '/admin/bulk', { method: 'POST', headers, body: fdPub });
  check('...and a bulk publish too', rows('SELECT status FROM drafts WHERE id=?', target.i)[0].status === 'new');

  // ---- issue #148: "Default order" and Status = Scheduled through the form ----
  const sortOptions = (html) => (/<select name="sort">([\s\S]*?)<\/select>/.exec(html) || [])[1] || '';
  r = await list('');
  check('Sort starts with "Default order (recently updated)" (empty value), selected by default', /^\s*<option value="" selected>Default order \(recently updated\)<\/option>/.test(sortOptions(r.text)));
  r = await list('status=scheduled');
  check('under Scheduled the default option reads "(soonest scheduled)" and is selected', /^\s*<option value="" selected>Default order \(soonest scheduled\)<\/option>/.test(sortOptions(r.text)) && !/<option value="scheduled" selected>/.test(sortOptions(r.text)));
  r = await list('status=scheduled&sort=updated');
  check('an explicit non-default sort stays selected, not Default order', /<option value="updated" selected>/.test(sortOptions(r.text)) && !/<option value="" selected>/.test(sortOptions(r.text)));
  r = await list('sort=title');
  check('the chosen sort is selected and Default order is not', /<option value="title" selected>/.test(sortOptions(r.text)) && !/<option value="" selected>/.test(sortOptions(r.text)));
  const schedOrder = ids(D.filter((d) => d.kind === 'story' && d.publishAt && open(d)).sort((a, b) => a.publishAt - b.publishAt || a.i - b.i));
  // The form submits every control, so changing Status to Scheduled sends the Sort select's visible value (now Default order = empty).
  r = await list('q=&section=&kind=story&source=&sort=&status=scheduled&issue=&from=&to=');
  check('submitting the form with Status = Scheduled and Default order lists soonest first', same(r.ids, schedOrder) && schedOrder.length > 1, r.ids.join());
  check('...and that view shows Default order (soonest scheduled) selected', /<option value="" selected>Default order \(soonest scheduled\)/.test(sortOptions(r.text)));
  r = await list('q=&section=&kind=story&source=&sort=&status=new&issue=&from=&to=');
  check('an empty sort under another status is that status default (recently updated)', same(r.ids, (await list('status=new')).ids));
  const pageLinks = (await list('status=scheduled&sort=&perPage=50')).text;
  check('no link carries the default sort (sort=scheduled) under Scheduled', !/href="[^"]*[?&;]sort=scheduled/.test(pageLinks));

  // ---- issue #148: `back` keeps the drafts view after bulk actions ----
  const bulk = async (fields) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    const res = await fetch(BASE + '/admin/bulk', { method: 'POST', headers, body: f });
    return { status: res.status, text: await res.text() };
  };
  const backsOf = (html) => [...html.matchAll(/name="back" value="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const cancelOf = (html) => [...html.matchAll(/<a class="cms-btn secondary" href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  r = await list('q=Synthetic&sort=title&perPage=50&page=2&status=all');
  check('the bulk bar carries the current drafts view as `back` (path and query)', /name="back" value="\/admin\?q=Synthetic&amp;sort=title&amp;perPage=50&amp;page=2&amp;status=all"/.test(r.text), (r.text.match(/name="back" value="[^"]*"/) || [''])[0]);
  const t2 = D.find((d) => d.status === 'new' && d.kind === 'story' && d.i !== target.i);
  const t3 = D.find((d) => d.status === 'in_review' && d.kind === 'story' && !d.publishAt && d.i !== t2.i);
  const one = (d) => ({ action: 'reject', id: String(d.i), [`v_${d.i}`]: String(d.updated) });
  const want = '/admin?q=Synthetic&status=all&sort=title&perPage=50&page=2';
  let b = await bulk({ ...one(t2), back: '/admin?q=Synthetic&status=all&sort=title&perPage=50&page=2' });
  check('bulk Reject confirmation: Cancel and the form carry the rebuilt view', b.status === 200 && cancelOf(b.text).includes(want) && backsOf(b.text).every((v) => v === want) && backsOf(b.text).length > 0, `${cancelOf(b.text)} ${backsOf(b.text)}`);
  b = await bulk({ ...one(t2), step: 'run', back: '/admin?q=Synthetic&status=all&sort=title&perPage=50&page=2' });
  check('bulk Reject result: Back to the list returns to the view', b.status === 200 && /1 of 1 rejected/.test(b.text) && cancelOf(b.text).includes(want), cancelOf(b.text));
  b = await bulk({ action: 'edit', id: String(t3.i), [`v_${t3.i}`]: String(t3.updated), back: '/admin/events?status=all&sort=updated&kind=story&q=x' });
  check('bulk Edit fields page on a preset path keeps that path; kind is ignored; default sort left out', b.status === 200 && cancelOf(b.text).includes('/admin/events?q=x&status=all') && backsOf(b.text).every((v) => v === '/admin/events?q=x&status=all'), `${cancelOf(b.text)}`);
  b = await bulk({ action: 'edit', step: 'run', id: String(t3.i), [`v_${t3.i}`]: String(t3.updated), tick_featured: '1', e_featured: 'on', back: '/admin/announcements?status=scheduled&sort=' });
  check('bulk Edit fields result keeps /admin/announcements and the status', b.status === 200 && /1 of 1 updated/.test(b.text) && cancelOf(b.text).includes('/admin/announcements?status=scheduled'), cancelOf(b.text));
  b = await bulk({ ...one(t3), back: 'kind=all&status=scheduled&perPage=100' });
  check('a bare query string works too, and is rebuilt with the type', cancelOf(b.text).includes('/admin?kind=all&status=scheduled&perPage=100'), `${cancelOf(b.text)}`);
  b = await bulk({ ...one(t3) });
  check('without `back` the list is plain /admin', b.status === 200 && cancelOf(b.text).includes('/admin') && cancelOf(b.text).every((h) => h === '/admin'));
  for (const back of ['//evil.example', '//evil.example/admin', 'https://evil.example/', 'http://evil.example/admin?x=1', '/admin/editors', '/admin/editors?status=all', '/admin/published', '/admin/events/../editors', '/administrator', '%2F%2Fevil.example', '%2Fadmin%2Feditors', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)', '@evil.example', '/admin?next=https://evil.example', 'x'.repeat(5000)]) {
    b = await bulk({ ...one(t3), back });
    const carried = backsOf(b.text), cancels = cancelOf(b.text);
    const good = (v) => /^\/admin(\/announcements|\/events)?(\?[A-Za-z0-9_=&.%+-]*)?$/.test(v) && !/evil|editors|published/i.test(v);
    check(`malicious back ${JSON.stringify(back.slice(0, 32))} only yields a drafts list address`, b.status === 200 && carried.length > 0 && carried.every(good) && cancels.length > 0 && cancels.every(good) && !/evil/i.test(b.text), `${carried} | ${cancels}`);
  }

  // ---- issue #168: "Live on the site" on /admin/events and /admin/announcements ----
  const section = (html) => { const a = html.indexOf('<section class="adm-live"'); return a === -1 ? '' : html.slice(a, html.indexOf('</section>', a)); };
  const liveSlugs = (html) => [...section(html).matchAll(/name="slug" value="([^"]+)" form="bulk-live-(?:event|announcement)"/g)].map((m) => m[1]);
  const liveRows = (html) => [...section(html).matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]).filter((x) => x.includes('bulk-item'));
  const liveSet = (kind) => rows("SELECT slug FROM stories WHERE status = 'live' AND draft = 0 AND json_extract(announcement, '$.kind') = ?", kind).map((x) => x.slug);
  const evHtml = (await get('/admin/events')).text;
  const annHtml = (await get('/admin/announcements')).text;
  const storyHtml = (await get('/admin')).text;
  check('events page: h2 "Live events (n)" with every live event counted', evHtml.includes(`<h2 id="live-heading">Live events (${LIVE.event})</h2>`) && LIVE.event === 7);
  check('announcements page: h2 "Live announcements (n)"', annHtml.includes(`<h2 id="live-heading">Live announcements (${LIVE.announcement})</h2>`) && LIVE.announcement === 30);
  check('the live section comes after the drafts table and its bulk bar, and has id="live"', section(evHtml).includes('id="live"') && evHtml.indexOf('id="live"') > evHtml.indexOf('class="adm-table-card"') && evHtml.indexOf('id="live"') > evHtml.indexOf('id="bulk-form"'));
  check('events page lists exactly the live events (Studio and archive ones with no draft row included), none of the announcements or stories', [...liveSlugs(evHtml)].sort().join() === liveSet('event').sort().join() && liveSlugs(evHtml).length === LIVE.event);
  check('announcements page: only announcements (25 on the first page), no event or story slugs', liveSlugs(annHtml).length === 25 && liveSlugs(annHtml).every((x) => liveSet('announcement').includes(x)));
  check('/admin (stories) has no live section and no live bulk bar', !storyHtml.includes('id="live"') && !storyHtml.includes('bulk-live-'));
  check('events: upcoming soonest first (today counts as upcoming), then past newest first, then undated', same(liveSlugs(evHtml), EV_ORDER), liveSlugs(evHtml).join());
  const rowOf = (html, slug) => liveRows(html).find((x) => x.includes(`value="${slug}"`)) || '';
  check('each event row shows its event date, "No date" when missing or not text', rowOf(evHtml, EV.today).includes(`datetime="${ymdNow}"`) && rowOf(evHtml, EV.far).includes(`datetime="${addDays(ymdNow, 30)}"`) && rowOf(evHtml, EV.none).includes('No date') && rowOf(evHtml, EV.num).includes('No date') && !rowOf(evHtml, EV.old).includes('No date'));
  check('announcement rows have no event-date column', !section(annHtml).includes('Event date'));
  check('rows carry the published columns: title to the public page, section, story date, published day, View on site, Edit, Unpublish with a back value', ['Section</th>', 'Story date</th>', 'Published</th>'].every((t) => section(evHtml).includes(t)) && /href="http[^"]*\/stories\/synth-ev-today\/" rel="noopener"/.test(rowOf(evHtml, EV.today)) && rowOf(evHtml, EV.today).includes('View on site') && rowOf(evHtml, EV.today).includes('action="/api/admin/stories/edit"') && rowOf(evHtml, EV.today).includes('action="/api/admin/stories/unpublish"') && rowOf(evHtml, EV.today).includes('name="back" value="/admin/events"') && rowOf(evHtml, EV.today).includes('data-confirm='));
  const ev2 = (await get('/admin/events?status=all&q=Synthetic&perPage=50')).text;
  check('the live section ignores the drafts filters (same rows) and its Unpublish carries the drafts view as back', same(liveSlugs(ev2), EV_ORDER) && rowOf(ev2, EV.today).includes('name="back" value="/admin/events?status=all&amp;q=Synthetic&amp;perPage=50"'));
  // Announcements: the published list's default order, newest published first.
  const annOrder = rows("SELECT slug FROM stories WHERE status = 'live' AND draft = 0 AND json_extract(announcement, '$.kind') = 'announcement' ORDER BY published_at DESC, slug ASC").map((x) => x.slug);
  check('announcements: newest published first', same(liveSlugs(annHtml), annOrder.slice(0, 25)), liveSlugs(annHtml).slice(0, 4).join());
  // livePage: its own parameter, whitelisted, clamped, never touching the drafts table.
  const ap2 = (await get('/admin/announcements?livePage=2')).text;
  check('livePage=2 shows the other five announcements and "Showing 26–30 of 30"', same(liveSlugs(ap2), annOrder.slice(25)) && section(ap2).includes('Showing 26–30 of 30'));
  for (const bad of ['abc', '0', '-1', '1.5', '1e3', '', '%27%20OR%201%3D1']) check(`livePage=${JSON.stringify(decodeURIComponent(bad))} is page 1`, same(liveSlugs((await get(`/admin/announcements?livePage=${bad}`)).text), annOrder.slice(0, 25)));
  check('livePage=999 and 999999 are clamped to the last page; more than six digits is not a page number (page 1)', same(liveSlugs((await get('/admin/announcements?livePage=999')).text), annOrder.slice(25)) && same(liveSlugs((await get('/admin/announcements?livePage=999999')).text), annOrder.slice(25)) && same(liveSlugs((await get('/admin/announcements?livePage=99999999999')).text), annOrder.slice(0, 25)));
  check('the drafts table is untouched by livePage (same rows as without it)', same(shown((await get('/admin/announcements?livePage=2&status=all')).text), shown((await get('/admin/announcements?status=all')).text)) && shown((await get('/admin/announcements?status=all')).text).length === 4);
  const pagerLinks = [...section(annHtml).matchAll(/href="([^"]*livePage[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  check('the live pager uses livePage links that end in #live and a labelled nav', section(annHtml).includes('aria-label="Pages of live announcements"') && pagerLinks.includes('/admin/announcements?livePage=2#live'));
  const pagerKeep = (await get('/admin/announcements?status=all&q=Synthetic&livePage=2')).text;
  check('...and keep the drafts filters, with page 1 leaving livePage out', section(pagerKeep).includes('href="/admin/announcements?q=Synthetic&amp;status=all#live"') && section(pagerKeep).includes('href="/admin/announcements?q=Synthetic&amp;status=all&amp;livePage=2#live"'));
  check('the section ends with "See all n in Published" linking to the type', section(annHtml).includes(`<a href="/admin/published?kind=announcement">See all ${LIVE.announcement} in Published</a>`) && section(evHtml).includes(`<a href="/admin/published?kind=event">See all ${LIVE.event} in Published</a>`));
  // Published list: the new `event` sort and the unchanged default.
  const pubEv = await fetch(BASE + '/admin/published?kind=event&sort=event', { headers }).then((x) => x.text());
  const pubSlugs = [...pubEv.matchAll(/name="slug" value="([^"]+)" form="bulk-form"/g)].map((m) => m[1]);
  check('/admin/published?sort=event orders events like the live section, and the sort menu offers it', same(pubSlugs, EV_ORDER) && /<option value="event" selected>Event date/.test(pubEv));
  const pubAll = await fetch(BASE + '/admin/published?kind=all&sort=event&perPage=100', { headers }).then((x) => x.text());
  const pubAllSlugs = [...pubAll.matchAll(/name="slug" value="([^"]+)" form="bulk-form"/g)].map((m) => m[1]);
  const at = (x) => pubAllSlugs.indexOf(x);
  const storySlugs = rows("SELECT slug FROM stories WHERE status = 'live' AND draft = 0 AND announcement IS NULL").map((x) => x.slug);
  check('sort=event over all types: upcoming soonest first, then past newest first, then everything undated', pubAllSlugs.length === LIVE.story + LIVE.announcement + LIVE.event && at(EV.today) < at(EV.soon) && at(EV.soon) < at(EV.far) && at(EV.far) < at(EV.yesterday) && at(EV.yesterday) < at(EV.old) && at(EV.old) < at(EV.none) && at(EV.none) < at(EV.num) && storySlugs.every((x) => at(x) > at(EV.old)), pubAllSlugs.slice(0, 8).join());
  check('an unknown sort on the published list still falls back to the default', (await fetch(BASE + '/admin/published?sort=eventually', { headers }).then((x) => x.text())).includes('<option value="" selected>Default order (published, newest first)'));
  // Two bulk bars on one page: distinct names, no id collisions.
  const ids2 = [...evHtml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  check('two bulk bars have distinct accessible names and no duplicate ids', evHtml.includes('aria-label="Bulk actions for drafts"') && evHtml.includes('aria-label="Bulk actions for live events"') && annHtml.includes('aria-label="Bulk actions for live announcements"') && new Set(ids2).size === ids2.length, ids2.filter((x, k) => ids2.indexOf(x) !== k).join());
  check('headings: one h1, h2 for the live section, no skipped level; both tables have captions', (evHtml.match(/<h1[ >]/g) || []).length === 1 && !/<h3[ >]/.test(section(evHtml)) && section(evHtml).includes('<caption class="visually-hidden">Live events, 1 to 7 of 7</caption>') && evHtml.includes('<caption class="visually-hidden">Drafts,'));
  check('the live bulk bar offers Unpublish and Edit fields only', /id="bulk-live-event"[\s\S]*Unpublish selected[\s\S]*Edit fields/.test(evHtml) && !/bulk-live-event[\s\S]{0,900}Reject selected/.test(evHtml));
  check('no submitter contact details on either page', [evHtml, annHtml].every((h) => !h.includes('contacts.invalid') && !h.includes('555-0100') && !h.includes('Submitter Person')));

  // ---- layout in a real browser (optional) ----
  const root = process.env.PLAYWRIGHT_ROOT || '/opt/node-tools';
  let chromium = null;
  try { chromium = createRequire(path.join(root, 'package.json'))('playwright').chromium; } catch { /* no browser available */ }
  if (chromium) {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === BASE ? route.continue() : route.abort()));
    await context.addCookies([{ name: '__Host-imc_session', value: token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.setDefaultTimeout(12000);
    for (const [name, url] of [['home', '/admin'], ['filtered', '/admin?kind=all&status=all&q=synthetic&section=news&perPage=50&page=2'], ['events-live', '/admin/events?status=all'], ['announcements-live', '/admin/announcements?livePage=2']]) {
      for (const w of [360, 390, 768, 1280]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.goto(BASE + url);
        const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        check(`${name}: no horizontal page scroll at ${w}px`, fits);
        if (shots && (w === 390 || w === 1280)) await page.screenshot({ path: path.join(shots, `admin-${name}-${w}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE + '/admin?perPage=100');
    await page.locator('input.bulk-item').first().check();
    check('ticking a row shows the count and enables the bulk buttons', (await page.locator('#bulk-count').innerText()).startsWith('1 selected') && !(await page.locator('#bulk-form button[type=submit]').first().isDisabled()));
    check('the bulk bar is sticky', (await page.locator('#bulk-form').evaluate((n) => getComputedStyle(n).position)) === 'sticky');
    await page.goto(BASE + '/admin');
    await page.locator('select[name=sort]').selectOption('title');
    await page.waitForURL(/sort=title/);
    check('with JavaScript a select applies on change and the URL keeps the state', page.url().includes('sort=title'));
    check('no uncaught browser errors', errors.length === 0, errors.join('; '));
  } else console.log('SKIP browser checks (Playwright not found)');
  // ---- issue #168: Unpublish and bulk from the live section return to the same Announcements/Events view ----
  const postForm = async (url, fields) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    const res = await fetch(BASE + url, { method: 'POST', redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
  };
  const stat = (slug) => rows('SELECT status FROM stories WHERE slug = ?', slug)[0]?.status;
  let u = await postForm('/api/admin/stories/unpublish', { slug: EV.old, back: '/admin/events?status=all&sort=title&perPage=50&livePage=2&kind=all&junk=1' });
  check('Unpublish from the live section returns to /admin/events with the rebuilt view (kind and junk dropped) and a notice', u.status === 303 && u.location === '/admin/events?status=all&sort=title&perPage=50&livePage=2&n=unpublished' && stat(EV.old) === 'unpublished', u.location);
  LIVE.event--;
  u = await postForm('/api/admin/stories/unpublish', { slug: ANN_EXTRA[0], back: '/admin/announcements?status=scheduled' });
  check('...and an Announcements back address goes to /admin/announcements', u.status === 303 && u.location === '/admin/announcements?status=scheduled&n=unpublished' && stat(ANN_EXTRA[0]) === 'unpublished', u.location);
  LIVE.announcement--;
  u = await postForm('/api/admin/stories/unpublish', { slug: 'synth-no-such-story', back: '/admin/events?livePage=3' });
  check('a failed Unpublish returns to the same view with an error code', u.status === 303 && u.location === '/admin/events?livePage=3&e=story_missing', u.location);
  u = await postForm('/api/admin/stories/unpublish', { slug: EV.yesterday, back: '/admin/published?kind=event&sort=event&perPage=50' });
  check('a Published list back address is still tried first and returns to the Published list', u.status === 303 && u.location === '/admin/published?kind=event&sort=event&perPage=50&n=unpublished' && stat(EV.yesterday) === 'unpublished', u.location);
  LIVE.event--;
  for (const back of ['//evil.example', '//evil.example/admin/events', 'https://evil.example/admin/events', '/admin/editors', '/admin/events/../editors', '/administrator', '%2F%2Fevil.example', '/\\evil.example', 'javascript:alert(1)', '/admin/events%3Fx', 'x'.repeat(5000), '']) {
    u = await postForm('/api/admin/stories/unpublish', { slug: '', back });
    check(`a hostile back ${JSON.stringify(back.slice(0, 30))} falls back to the plain Published list (nothing is unpublished, never an external address)`, u.status === 303 && u.location === '/admin/published?e=slug_bad', u.location);
  }
  // Bulk: confirmation, Edit fields and result pages rebuild the same address and never unpublish before the confirm step.
  const bulkLive = async (fields) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    const res = await fetch(BASE + '/admin/bulk', { method: 'POST', headers, body: f });
    return { status: res.status, text: await res.text() };
  };
  const wantEv = '/admin/events?status=all&livePage=2';
  let bl = await bulkLive({ action: 'unpublish', slug: EV.soon, back: '/admin/events?livePage=2&status=all&junk=1' });
  check('bulk Unpublish confirmation from the live section: Cancel and the hidden back are the rebuilt events view, nothing is unpublished yet', bl.status === 200 && cancelOf(bl.text).includes(wantEv) && backsOf(bl.text).length > 0 && backsOf(bl.text).every((v) => v === wantEv) && stat(EV.soon) === 'live', `${cancelOf(bl.text)} ${backsOf(bl.text)}`);
  bl = await bulkLive({ action: 'editstory', slug: EV.soon, back: '/admin/events?livePage=2&status=all' });
  check('bulk Edit fields page keeps the events view', bl.status === 200 && cancelOf(bl.text).includes(wantEv) && backsOf(bl.text).every((v) => v === wantEv), `${cancelOf(bl.text)}`);
  bl = await bulkLive({ action: 'unpublish', step: 'run', slug: EV.soon, back: '/admin/events?livePage=2&status=all' });
  check('bulk Unpublish result: "Back to the list" returns to /admin/events?…', bl.status === 200 && /1 of 1 unpublished/.test(bl.text) && cancelOf(bl.text).includes(wantEv) && stat(EV.soon) === 'unpublished', `${cancelOf(bl.text)}`);
  LIVE.event--;
  bl = await bulkLive({ action: 'unpublish', slug: EV.far, back: '/admin/announcements?status=all&page=3&livePage=2' });
  check('a drafts page parameter and livePage both survive the back round trip', cancelOf(bl.text).includes('/admin/announcements?status=all&page=3&livePage=2'), `${cancelOf(bl.text)}`);
  bl = await bulkLive({ action: 'unpublish', slug: EV.far, back: '?kind=event&sort=event' });
  check('a bare Published query string is still the Published list', cancelOf(bl.text).includes('/admin/published?kind=event&sort=event'), `${cancelOf(bl.text)}`);
  for (const back of ['//evil.example', 'https://evil.example/', '/admin/editors', '/admin/events/../editors', '%2F%2Fevil.example', '/\\evil.example', 'javascript:alert(1)', 'x'.repeat(5000)]) {
    bl = await bulkLive({ action: 'unpublish', slug: EV.far, back });
    check(`bulk Unpublish with a hostile back ${JSON.stringify(back.slice(0, 30))} only yields the plain Published list`, bl.status === 200 && backsOf(bl.text).length > 0 && backsOf(bl.text).every((v) => v === '/admin/published') && cancelOf(bl.text).every((v) => v === '/admin/published') && !/evil/i.test(bl.text) && stat(EV.far) === 'live', `${backsOf(bl.text)} | ${cancelOf(bl.text)}`);
  }
  // Counts follow the live set, and an empty live section says so.
  const ev3 = (await get('/admin/events')).text;
  check('after the unpublishes the heading, card and rows follow the live set', ev3.includes(`<h2 id="live-heading">Live events (${LIVE.event})</h2>`) && same(liveSlugs(ev3), EV_ORDER.filter((x) => stat(x) === 'live')) && ev3.includes(`Published, ${LIVE.event}, live on the site`), `${LIVE.event} ${liveSlugs(ev3)}`);
  rows("SELECT slug FROM stories WHERE status = 'live' AND json_extract(announcement, '$.kind') = 'event'").forEach((x) => run("UPDATE stories SET status = 'unpublished', rev = rev + 1 WHERE slug = ?", x.slug));
  const ev4 = (await get('/admin/events')).text;
  check('with no live events: "Live events (0)", "Nothing live yet." and no live bulk bar', ev4.includes('<h2 id="live-heading">Live events (0)</h2>') && section(ev4).includes('Nothing live yet.') && !ev4.includes('bulk-live-event') && ev4.includes('aria-label="Published, 0, live on the site"'));
  console.log(`\n${checks} draft list checks passed.`);
} finally {
  await browser?.close();
  if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
  db?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
