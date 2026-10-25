#!/usr/bin/env node
// Issue #99: the /issues/ browser (stories grouped by newsletter issue). Starts its own copy of the BUILT server against a
// throwaway DATA_DIR seeded with synthetic issues and stories (made-up secrets, no email, no GitHub).
//   npm run build
//   PORT=4895 [SHOTS=<folder>] [PLAYWRIGHT_ROOT=<folder>] [CHROMIUM_PATH=<browser>] [CHROMIUM_NO_SANDBOX=1] [AXE_JS=<axe.min.js>] node scripts/test-issues-browser.mjs
// Playwright and axe are optional here (the browser checks are skipped without them).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const PORT = Number(process.env.PORT || 4895);
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-issues-'));
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : '';
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 700)}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- synthetic data (seeded before the server opens the database) ----
const db = openDatabase(scratch);
runMigrations(db, readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
const now = Date.now();
db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)").run(now);
const user = (email, role) => {
  const id = Number(db.prepare("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").run(email, 'Synthetic ' + role, role, now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)').run(createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600_000);
  return `__Host-imc_session=${token}`;
};
const ADMIN = user('issues-admin@example.test', 'admin');
const issue = (number, date, title) => db.prepare('INSERT INTO newsletter_issues (number, date, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(number, date, title, now, now);
let tick = 0;
const story = (slug, over) => {
  const o = { section: 'news', area: 'churches', date: '2026-09-01', issue: null, position: null, status: 'live', draft: 0, ...over };
  db.prepare("INSERT INTO stories (slug, title, dek, section, area, author, date, body, status, source, published_at, updated_at, draft, newsletter_issue, newsletter_position) VALUES (?, ?, 'A made-up summary.', ?, ?, 'Synthetic Author', ?, 'A made-up paragraph.', ?, 'editor', ?, ?, ?, ?, ?)")
    .run(slug, 'Synthetic ' + slug, o.section, o.area, o.date, o.status, now + tick, now + tick++, o.draft, o.issue, o.position);
};
issue(12, '2026-09-14', 'Synthetic Autumn Edition');
issue(10, '2026-08-17', '');
issue(9, '2026-08-03', 'Nothing Live Here');     // only an unpublished story
issue(8, '2026-07-20', '');                      // no stories at all
issue(7, '2026-07-06', 'Only A Draft');          // only a draft-flagged story
issue(3, '2026-05-04', '');
issue(14, '2026-09-28', 'Unpublished Higher Issue'); // higher number, but its only story is unpublished: never "latest"
// Issue 12: positions 2 and 1, then two without a position (newest first), plus one unpublished story that must never show.
story('s-pos2', { issue: 12, position: 2, date: '2026-08-30' });
story('s-pos1', { issue: 12, position: 1, date: '2026-08-25', section: 'kids', area: null });
story('s-none-old', { issue: 12, date: '2026-09-10' });
story('s-none-new', { issue: 12, date: '2026-09-12' });
story('s-hidden', { issue: 12, position: 3, status: 'unpublished' });
story('s-ten', { issue: 10, position: 1, date: '2026-08-10' });
story('s-nine', { issue: 9, position: 1, status: 'unpublished' });
story('s-seven', { issue: 7, position: 1, draft: 1 });
story('s-three-a', { issue: 3, position: 1, date: '2026-04-20' });
story('s-three-b', { issue: 3, position: 2, date: '2026-04-21' });
story('s-fourteen', { issue: 14, position: 1, status: 'unpublished' });
story('s-plain', { date: '2026-09-20' });
db.close();


// ---- the server ----
const logs = [];
const server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: scratch, SITE_URL: BASE, AUTH_SECRET: 'synthetic-issues-secret-' + 'x'.repeat(40), TRUST_PROXY: 'true', RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '', PUBLISH_TOKEN: '', AGENT_API_TOKEN: '', TURNSTILE_SECRET_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => logs.push(String(d)));
server.stderr.on('data', (d) => logs.push(String(d)));
const get = async (u, headers = {}) => { const r = await fetch(BASE + u, { redirect: 'manual', headers }); return { status: r.status, text: await r.text(), headers: r.headers }; };
const post = async (u, fields) => { const r = await fetch(BASE + u, { method: 'POST', redirect: 'manual', headers: { Cookie: ADMIN, Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }); return { status: r.status, text: await r.text() }; };
const slugsOn = (html) => [...(html.match(/<main[\s\S]*<\/main>/)?.[0] ?? html).matchAll(/href="\/stories\/([^"/]+)\/"/g)].map((m) => m[1]);
const canon = (html) => html.match(/<link rel="canonical" href="https?:\/\/[^/]+([^"]*)"/)?.[1];
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
let browser;
try {
  for (let i = 0; i < 150; i++) { try { if ((await fetch(BASE + '/admin/login')).status === 200) break; } catch { /* starting */ } await sleep(100); }

  // ================= /issues/ =================
  const list = await get('/issues/');
  check('/issues/ answers 200 with the public cache header', list.status === 200 && list.headers.get('cache-control') === 'public, max-age=60, stale-while-revalidate=300', `${list.status} ${list.headers.get('cache-control')}`);
  const heads = [...list.text.matchAll(/<h2 id="issue-(\d+)"/g)].map((m) => Number(m[1]));
  check('lists exactly the issues with a live, non-draft story, newest first (12, 10, 3)', heads.join() === '12,10,3', heads.join());
  check('issues with no story, only an unpublished story or only a draft are not listed', !/Issue #(9|8|7)\b/.test(strip(list.text)) && !list.text.includes('/issues/9/') && !list.text.includes('/issues/8/') && !list.text.includes('/issues/7/'));
  const block = (n) => list.text.match(new RegExp(`<section class="issue-block" aria-labelledby="issue-${n}">[\\s\\S]*?</section>`))?.[0] ?? '';
  const b12 = block(12), t12 = strip(b12);
  check('issue 12 shows its number, title, sent date and a story count of 4 (the unpublished story is not counted)', t12.includes('Issue #12') && t12.includes('Synthetic Autumn Edition') && t12.includes('Sent September 14, 2026') && t12.includes('4 stories') && !t12.includes('5 stories'), t12.slice(0, 300));
  check('issue 12 previews its first three stories in newsletter order (position 1, position 2, then the newest without a position)', slugsOn(b12).join() === 's-pos1,s-pos2,s-none-new', slugsOn(b12).join());
  check('the preview cards are the existing story cards in a three-column grid, with a link to the issue', (b12.match(/<a class="card /g) ?? []).length === 3 && b12.includes('grid cols-3') && b12.includes('href="/issues/12/"') && t12.includes('See all 4 stories'));
  const t10 = strip(block(10)), t3 = strip(block(3));
  check('a one-story issue says "1 story"; an issue without a title shows no title; its date is shown', t10.includes('1 story') && !t10.includes('1 stories') && t10.includes('Sent August 17, 2026') && !block(10).includes('class="issue-title"'), t10.slice(0, 200));
  check('issue 3 counts only its live stories (2) and lists them in position order', t3.includes('2 stories') && slugsOn(block(3)).join() === 's-three-a,s-three-b', slugsOn(block(3)).join());
  check('a story without an issue is not on the issues list', !list.text.includes('s-plain'));
  check('/issues/ has canonical, title and description', canon(list.text) === '/issues/' && /<title>IMConnected Issues \| IMConnected<\/title>/.test(list.text) && /<meta name="description" content="Browse IMConnected stories by the newsletter issue/.test(list.text), `${canon(list.text)} ${list.text.match(/<title>[^<]*/)?.[0]}`);
  check('headings are in order on /issues/: one h1, then h2 per issue, then h3 cards', (list.text.match(/<h1[ >]/g) ?? []).length === 1 && !/<h2[\s\S]*?<h1/.test(list.text.match(/<main[\s\S]*<\/main>/)?.[0] ?? '') && !/<h4/.test(list.text.match(/<main[\s\S]*<\/main>/)?.[0] ?? ''));
  const again = await get('/issues');
  check('/issues (no slash) is served from the page cache', again.status === 200 && again.headers.get('x-page-cache') === 'hit', again.headers.get('x-page-cache'));

  // ================= /issues/<n>/ =================
  const p12 = await get('/issues/12/');
  check('/issues/12/ answers 200 and lists the live stories in newsletter order, position-less ones after (newest first), the unpublished one never', p12.status === 200 && slugsOn(p12.text).join() === 's-pos1,s-pos2,s-none-new,s-none-old', slugsOn(p12.text).join());
  const t = strip(p12.text);
  check('the intro reads "IMConnected Issue #12 · Sent September 14, 2026" and the title is the heading', t.includes('IMConnected Issue #12 · Sent September 14, 2026') && /<h1>Synthetic Autumn Edition<\/h1>/.test(p12.text), t.slice(t.indexOf('IMConnected Issue'), t.indexOf('IMConnected Issue') + 120));
  check('/issues/12/ has its own canonical, title and description', canon(p12.text) === '/issues/12/' && /<title>IMConnected Issue #12: Synthetic Autumn Edition \| IMConnected<\/title>/.test(p12.text) && /<meta name="description" content="4 stories from IMConnected Issue #12, sent September 14, 2026: Synthetic Autumn Edition\./.test(p12.text), `${canon(p12.text)} ${p12.text.match(/<title>[^<]*/)?.[0]}`);
  const p10 = await get('/issues/10/');
  check('an issue with no title uses "Issue #10" as its heading', /<h1>Issue #10<\/h1>/.test(p10.text) && /<title>IMConnected Issue #10 \| IMConnected<\/title>/.test(p10.text));
  const steps = (html) => ({ prev: html.match(/<a class="issue-step"[^>]*href="([^"]+)"[^>]*rel="prev"|<a class="issue-step" href="([^"]+)" rel="prev"/)?.slice(1).find(Boolean) ?? null, next: html.match(/<a class="issue-step is-next" href="([^"]+)" rel="next"/)?.[1] ?? null });
  const s12 = steps(p12.text), s10 = steps(p10.text), p3 = await get('/issues/3/'), s3 = steps(p3.text);
  check('previous and next link only to listed issues: 12 has previous #10 and no next; 10 has previous #3 and next #12; 3 has next #10 and no previous', s12.prev === '/issues/10/' && s12.next === null && s10.prev === '/issues/3/' && s10.next === '/issues/12/' && s3.prev === null && s3.next === '/issues/10/', JSON.stringify([s12, s10, s3]));
  check('the previous/next navigation is labelled and never links to the empty issues 7, 8 or 9', p10.text.includes('aria-label="Other issues"') && !/\/issues\/[789]\//.test(p12.text + p10.text + p3.text));
  const bad = [];
  for (const u of ['/issues/99/', '/issues/9/', '/issues/8/', '/issues/7/']) {
    const r = await get(u);
    if (r.status !== 404 || r.headers.get('cache-control') !== 'no-store' || !r.text.includes('We couldn’t find that page')) bad.push(`${u} ${r.status} ${r.headers.get('cache-control')}`);
  }
  check('unknown, empty (no live story), unpublished-only and draft-only issue numbers are 404 with the 404 page and Cache-Control: no-store', bad.length === 0, bad.join(' | '));
  const bad2 = [];
  for (const u of ['/issues/0/', '/issues/02/', '/issues/012/', '/issues/abc/', '/issues/-1/', '/issues/1.5/', '/issues/10000/', '/issues/12/extra/']) {
    const r = await get(u);
    if (r.status !== 404 || /public/.test(r.headers.get('cache-control') ?? '') || r.headers.get('x-page-cache') || !r.text.includes('We couldn’t find that page')) bad2.push(`${u} ${r.status} ${r.headers.get('cache-control')} ${r.headers.get('x-page-cache')}`);
  }
  check('malformed issue numbers (0, 02, 012, abc, -1, 1.5, 10000, extra segment) are 404 with the 404 page, never cacheable and never in the page cache', bad2.length === 0, bad2.join(' | '));

  // ================= provenance link =================
  const sp = await get('/stories/s-pos1/');
  check('the provenance line on a story links to its issue page', sp.status === 200 && /Originally published in <a href="\/issues\/12\/">IMConnected Issue #12<\/a> · <time datetime="2026-09-14">September 14, 2026<\/time>/.test(sp.text), sp.text.slice(sp.text.indexOf('Originally') - 20, sp.text.indexOf('Originally') + 200));

  // ================= navigation =================
  const nav = (html) => html.match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
  const home = await get('/');
  check('the default menu has an "Issues" link to /issues/, and it is the current page on /issues/', /<a [^>]*href="\/issues\/"[^>]*>\s*Issues\s*<\/a>/.test(nav(home.text)) && /<a [^>]*href="\/issues\/"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/issues\/"/.test(nav(list.text)), nav(list.text).slice(0, 400));
  // ---- home page "Latest issue" line and module (issue #115) ----
  const lineOf = (h) => strip(h.match(/<p class="latest-issue-line">[\s\S]*?<\/p>/)?.[0] ?? '').trim();
  const modOf = (h) => h.match(/<section class="block latest-issue"[\s\S]*?<\/section>/)?.[0] ?? '';
  check('home: highest-numbered issue with a live story wins (12, not the unpublished-only 14), in a dated line linking to /issues/12/', lineOf(home.text) === 'Latest issue: No. 12 · September 14, 2026' && /<p class="latest-issue-line"><a href="\/issues\/12\/">/.test(home.text), lineOf(home.text));
  const hm = modOf(home.text), hmt = strip(hm);
  check('home module shows number, title, sent date, story count (4) and a link to the issue', hmt.includes('Issue No. 12') && hmt.includes('Synthetic Autumn Edition') && hmt.includes('Sent September 14, 2026') && hmt.includes('4 stories') && hm.includes('href="/issues/12/"') && hmt.includes('See all 4 stories'), hmt.slice(0, 300));
  check('home module previews up to 3 stories in newsletter position order', slugsOn(hm).join() === 's-pos1,s-pos2,s-none-new', slugsOn(hm).join());
  check('home never mentions the skipped issue 14', !home.text.includes('/issues/14/') && !home.text.includes('Unpublished Higher Issue'));
  check('the Issues link is also current on an issue page', /aria-current="page"[^>]*href="\/issues\/"|href="\/issues\/"[^>]*aria-current="page"/.test(nav(p12.text)));
  // A saved menu keeps exactly what the administrator saved: the default Issues link is NOT added to it (documented), and hiding it works.
  const nv = Number(JSON.parse((await get('/api/navigation')).text).version);
  const items = JSON.parse((await get('/api/navigation')).text).items;
  check('/api/navigation lists the Issues link in the default menu', items.some((i) => i.id === 'issues' && i.href === '/issues/' && i.label === 'Issues'), JSON.stringify(items).slice(0, 300));
  const form = { version: nv, action: 'save' };
  const kept = items.filter((i) => i.id !== 'issues');
  kept.forEach((it, i) => { form[`id.${i}`] = it.id; form[`order.${i}`] = i + 1; form[`label.${i}`] = it.label; form[`href.${i}`] = it.href; if (it.visible) form[`visible.${i}`] = 'on'; });
  let r = await post('/admin/navigation', form);
  const saved = JSON.parse((await get('/api/navigation')).text);
  check('an administrator can remove the Issues link (saved menu has no Issues entry)', r.status === 200 && saved.version === nv + 1 && !saved.items.some((i) => i.id === 'issues'), `${r.status} ${JSON.stringify(saved).slice(0, 200)}`);
  check('after the save the header no longer shows Issues and the page still renders', !/href="\/issues\/"/.test(nav((await get('/issues/')).text)) && (await get('/issues/')).status === 200);
  const nv2 = saved.version;
  r = await post('/admin/navigation', { version: nv2, action: 'reset' });
  check('Restore default menu brings the Issues link back', r.status === 200 && JSON.parse((await get('/api/navigation')).text).items.some((i) => i.id === 'issues'), String(r.status));

  // ================= newsletter signup link and Print button (issue #116) =================
  const story0 = await get('/stories/s-pos1/');
  check('no signup link by default: the story page keeps only the submit call to action', !story0.text.includes('Get IMConnected in your inbox') && !story0.text.includes('newsletter-ask') && story0.text.includes('href="/submit/"') && JSON.parse((await get('/api/navigation')).text).newsletterSignup === '');
  check('the Print button is rendered hidden (script unhides it) and the print stylesheet ships', /<button type="button" data-print hidden>Print this story<\/button>/.test(story0.text) && story0.text.includes('data-print'), '');
  const navNow = JSON.parse((await get('/api/navigation')).text);
  const navForm = (version, signup, extra = {}) => { const f = { version, action: 'save', ...extra }; if (signup !== undefined) f.newsletter_signup = signup; navNow.items.forEach((it, i) => { f[`id.${i}`] = it.id; f[`order.${i}`] = i + 1; f[`label.${i}`] = it.label; f[`href.${i}`] = it.href; if (it.visible) f[`visible.${i}`] = 'on'; }); return f; };
  for (const bad of ['http://example.invalid/signup', '/signup', '//example.invalid/signup', 'javascript:alert(1)', 'ftp://example.invalid/', 'https://user:pw@example.invalid/']) {
    const rb = await post('/admin/navigation', navForm(navNow.version, bad));
    check('non-HTTPS or unsafe signup link refused (field refilled, aria-invalid, inline error): ' + bad, rb.status === 400 && rb.text.includes('aria-invalid="true"') && rb.text.includes('id="newsletter-signup-error"') && rb.text.includes('Use a full HTTPS link for the newsletter signup.') && rb.text.includes('aria-describedby="newsletter-signup-error newsletter-signup-help"') && JSON.parse((await get('/api/navigation')).text).version === navNow.version, String(rb.status));
  }
  const SIGNUP = 'https://signup.example.invalid/join?list=synthetic';
  r = await post('/admin/navigation', navForm(navNow.version, SIGNUP));
  const withSignup = JSON.parse((await get('/api/navigation')).text);
  check('an administrator saves the signup link; /api/navigation carries it (additive)', r.status === 200 && withSignup.version === navNow.version + 1 && withSignup.newsletterSignup === SIGNUP && Array.isArray(withSignup.items), `${r.status} ${JSON.stringify(withSignup).slice(0, 200)}`);
  const story1 = await get('/stories/s-pos1/'), ask = story1.text.match(/<section class="cta cta-pair newsletter-ask"[\s\S]*?<\/section>/)?.[0] ?? '';
  check('story page (cache cleared by the save) ends with the newsletter button beside the submit call to action', ask.includes('Get IMConnected in your inbox') && ask.includes(`href="${SIGNUP}"`) && !/<a [^>]*href="https:\/\/signup[^>]*target=/.test(ask) && ask.includes('Share what’s happening at your church') && ask.includes('href="/submit/"'), ask.slice(0, 300));
  check('with a link set, the story page shows no reader counts or numbers in the ask', !/\d/.test(strip(ask)));
  const audit = (() => { const d = openDatabase(scratch); try { return d.prepare("SELECT detail FROM audit_log WHERE action='site.navigation' ORDER BY id DESC LIMIT 1").get().detail; } finally { d.close(); } })();
  check('the audit entry names the changed field but not the address', audit.includes('newsletterSignup') && !audit.includes('signup.example'), audit);
  r = await post('/admin/navigation', { version: withSignup.version, action: 'reset' });
  check('Restore default menu keeps the signup link', r.status === 200 && JSON.parse((await get('/api/navigation')).text).newsletterSignup === SIGNUP, String(r.status));
  r = await post('/admin/navigation', navForm(withSignup.version + 1, ''));
  check('clearing the field removes the button again', r.status === 200 && JSON.parse((await get('/api/navigation')).text).newsletterSignup === '' && !(await get('/stories/s-pos1/')).text.includes('Get IMConnected in your inbox'), String(r.status));

  // ================= cache invalidation =================
  await get('/issues/3/'); await get('/issues/');
  const primed = await get('/issues/3/');
  check('issue 3 is cached and shows both stories before the change', primed.headers.get('x-page-cache') === 'hit' && slugsOn(primed.text).length === 2 && (await get('/issues/')).text.includes('2 stories'));
  r = await post('/api/admin/stories/unpublish', { slug: 's-three-b' });
  const after3 = await get('/issues/3/'), afterList = await get('/issues/');
  check('unpublishing a story updates the issue page and the list at once (issue 3 now has 1 story)', r.status === 303 && slugsOn(after3.text).join() === 's-three-a' && strip(block2(afterList.text, 3)).includes('1 story'), `${r.status} ${slugsOn(after3.text)}`);
  function block2(html, n) { return html.match(new RegExp(`<section class="issue-block" aria-labelledby="issue-${n}">[\\s\\S]*?</section>`))?.[0] ?? ''; }
  r = await post('/api/admin/stories/unpublish', { slug: 's-three-a' });
  const gone = await get('/issues/3/'), goneList = await get('/issues/'), prov = await get('/issues/10/');
  check('unpublishing the last live story of an issue makes the issue page 404 (no-store), drops it from the list and from the neighbours', gone.status === 404 && gone.headers.get('cache-control') === 'no-store' && !goneList.text.includes('issue-3"') && steps(prov.text).prev === null && steps(prov.text).next === '/issues/12/', `${gone.status} ${steps(prov.text).prev}`);
  // an admin issue edit shows at once on the cached pages
  await get('/issues/12/'); await get('/issues/'); await get('/stories/s-pos1/');
  const cachedBefore = await get('/issues/12/'), cachedList = await get('/issues/'), cachedStory = await get('/stories/s-pos1/');
  const ver = (n) => { const d = openDatabase(scratch); try { return d.prepare('SELECT updated_at u FROM newsletter_issues WHERE number = ?').get(n).u; } finally { d.close(); } };
  check('before the admin edit the pages are cached with the old date', cachedBefore.headers.get('x-page-cache') === 'hit' && cachedList.headers.get('x-page-cache') === 'hit' && cachedStory.text.includes('September 14, 2026'));
  r = await post('/admin/issues', { number: 12, version: ver(12), action: 'save', date: '2026-09-15', title: 'Corrected Synthetic Title' });
  const e12 = await get('/issues/12/'), eList = await get('/issues/'), eStory = await get('/stories/s-pos1/');
  check('an admin issue edit (date and title) shows at once on the issue page, the list and the story provenance line', r.status === 200 && strip(e12.text).includes('Sent September 15, 2026') && /<h1>Corrected Synthetic Title<\/h1>/.test(e12.text) && strip(eList.text).includes('Corrected Synthetic Title') && strip(eList.text).includes('Sent September 15, 2026') && eStory.text.includes('September 15, 2026') && !eStory.text.includes('>September 14, 2026<'), `${r.status} ${strip(e12.text).slice(0, 200)}`);
  const eHome = await get('/');
  check('an admin issue edit also clears the cached home page (new date and title in the line and module)', lineOf(eHome.text) === 'Latest issue: No. 12 · September 15, 2026' && strip(modOf(eHome.text)).includes('Corrected Synthetic Title') && eHome.headers.get('x-page-cache') !== 'hit', lineOf(eHome.text));
  const empty = await post('/admin/issues', { number: 8, version: ver(8), action: 'delete' });
  const emptyList = await get('/issues/');
  check('deleting an unused issue works and leaves the list unchanged', empty.status === 200 && [...emptyList.text.matchAll(/<h2 id="issue-(\d+)"/g)].map((m) => m[1]).join() === '12,10');
  check('the issue links say their visible words first (label in name), with the issue number only as hidden extra text', !/class="issue-more"[^>]*aria-label/.test(emptyList.text) && /class="issue-more"[^>]*>(See all \d+ stories|Open this issue)<span class="sr-only"> in Issue #12<\/span>/.test(emptyList.text));
  check('hostile text in an issue title is escaped, never rendered as HTML (in the page or the title; meta attributes keep it as inert quoted text)', await (async () => {
    await post('/admin/issues', { number: 10, version: ver(10), action: 'save', date: '2026-08-17', title: '<img src=x onerror=alert(1)> & <b>bold</b>' });
    const l = (await get('/issues/')).text, p = (await get('/issues/10/')).text;
    const mainOf = (h) => h.match(/<main[\s\S]*<\/main>/)?.[0] ?? '';
    return !/<img src=x|<b>bold/.test(mainOf(l) + mainOf(p)) && !/<title>[^<]*<(img|b)/.test(l + p) && l.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &lt;b&gt;bold&lt;/b&gt;');
  })());

  // ================= browser: axe, 320px, no JavaScript, row alignment, screenshots =================
  let chromium;
  try {
    const req = process.env.PLAYWRIGHT_ROOT ? createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json')) : createRequire(import.meta.url);
    ({ chromium } = req('playwright'));
  } catch { /* skipped below */ }
  const axePath = process.env.AXE_JS && fs.existsSync(process.env.AXE_JS) ? process.env.AXE_JS : '';
  if (!chromium) console.log('SKIP  browser checks (Playwright not found; set PLAYWRIGHT_ROOT)');
  else {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    for (const noJs of [false, true]) {
      const ctx = await browser.newContext({ javaScriptEnabled: !noJs });
      await ctx.route('**/*', (route) => { const u = new URL(route.request().url()); return u.origin === BASE || ['data:', 'about:', 'blob:'].includes(u.protocol) ? route.continue() : route.abort(); });
      for (const [name, url] of [['issues', '/issues/'], ['issue', '/issues/12/']]) {
        for (const width of noJs ? [390] : [320, 390, 768, 1280]) {
          const page = await ctx.newPage();
          await page.setViewportSize({ width, height: 1000 });
          const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
          const res = await page.goto(BASE + url, { waitUntil: 'load' });
          const tag = `${name} at ${width}px${noJs ? ' without JavaScript' : ''}`;
          const dim = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }));
          check(`${tag}: loads, no horizontal scroll, no script errors`, res.status() === 200 && dim.s <= dim.w && errors.length === 0, `${res.status()} ${JSON.stringify(dim)} ${errors}`);
          const ragged = await page.evaluate(() => {
            const rows = new Map();
            for (const card of document.querySelectorAll('main .grid > .card.with-photo')) { // text-only cards have no picture block, so only cards with a photo share a headline line (issue #162)
              const key = `${[...card.parentElement.parentElement.children].indexOf(card.parentElement)}:${card.offsetTop}`;
              (rows.get(key) || rows.set(key, []).get(key)).push(card);
            }
            return [...rows.values()].filter((row) => row.length > 1).flatMap((row) => new Set(row.map((c) => c.querySelector('h2,h3').offsetTop)).size > 1 ? [row.map((c) => c.querySelector('h2,h3').textContent).join(' | ')] : []);
          });
          check(`${tag}: card headlines line up across each row`, ragged.length === 0, ragged.join(' || '));
          const uneven = await page.evaluate(() => {
              // Every card in a grid row starts at the row's top (a short text-only card is top-aligned, never centred or pushed down),
              // and a text-only card is as tall as its text and padding, never a tall empty box (issue #162).
              const bad = [];
              for (const grid of document.querySelectorAll('main .grid')) {
                const cards = [...grid.children].filter((c) => c.classList.contains('card')).sort((a, b) => a.offsetTop - b.offsetTop);
                let row = [];
                const flush = () => { if (row.length > 1 && Math.max(...row.map((c) => c.offsetTop)) - Math.min(...row.map((c) => c.offsetTop)) > 1) bad.push('tops: ' + row.map((c) => c.querySelector('h2,h3').textContent).join(' | ')); row = []; };
                for (const c of cards) { if (row.length && c.offsetTop - row[0].offsetTop > 40) flush(); row.push(c); }
                flush();
              }
              for (const c of document.querySelectorAll('main .grid > .card.without-photo')) {
                const copy = c.querySelector('.card-copy');
                if (c.offsetHeight > copy.offsetHeight + 56) bad.push('tall: ' + c.querySelector('h2,h3').textContent + ' ' + c.offsetHeight + '/' + copy.offsetHeight);
              }
              return bad;
            });
          check(`${tag}: every card in a row starts at the row's top and text-only cards are as short as their text`, uneven.length === 0, uneven.join(' || '));
          const small = await page.evaluate(() => [...document.querySelectorAll('main a, main button')].filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && !a.classList.contains('card') && getComputedStyle(a).display !== 'inline' && r.height < 43.5; }).map((a) => `${a.className}:${Math.round(a.getBoundingClientRect().height)}`));
          check(`${tag}: the issue, step and heading links are at least 44px tall`, small.length === 0, small.join());
          if (axePath && !noJs) {
            await page.addScriptTag({ path: axePath });
            const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((x) => ({ id: x.id, nodes: x.nodes.map((n) => n.target.join(' ') + ': ' + n.failureSummary.slice(0, 160)) })));
            check(`${tag}: passes axe WCAG A/AA`, v.length === 0, JSON.stringify(v));
          }
          const hs = await page.evaluate(() => [...document.querySelectorAll('main h1,main h2,main h3,main h4')].map((h) => Number(h.tagName[1])));
          check(`${tag}: headings never skip a level`, hs[0] === 1 && hs.every((l, i) => i === 0 || l <= hs[i - 1] + 1), hs.join());
          if (SHOTS && !noJs && (width === 390 || width === 1280)) await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true });
          await page.close();
        }
      }
      await ctx.close();
    }
    if (!axePath) console.log('SKIP  axe checks (set AXE_JS)');
  }

  // ================= home "Latest issue": next issue down, one issue, then none (issue #115) =================
  const mut = (fn) => { const d = openDatabase(scratch); try { fn(d); } finally { d.close(); } };
  await get('/'); // prime the cache; the admin unpublish route below must clear it
  for (const sl of ['s-pos1', 's-pos2', 's-none-old', 's-none-new']) await post('/api/admin/stories/unpublish', { slug: sl });
  const h10 = await get('/');
  check('home: when issue 12 has no live story the line and module fall to the next issue (10)', lineOf(h10.text) === 'Latest issue: No. 10 · August 17, 2026' && strip(modOf(h10.text)).includes('1 story') && slugsOn(modOf(h10.text)).join() === 's-ten', lineOf(h10.text));
  await post('/api/admin/stories/unpublish', { slug: 's-ten' });
  // An issue older than the 90-day home window: its preview must not repeat in the "From the archive" rail.
  mut((d) => { d.prepare("UPDATE stories SET status = 'live', rev = rev + 1 WHERE slug = 's-three-a'").run(); });
  const h3 = await get('/');
  check('home: an old issue (3) previews its story once, never again in the archive rail', lineOf(h3.text) === 'Latest issue: No. 3 · May 4, 2026' && slugsOn(modOf(h3.text)).join() === 's-three-a' && slugsOn(h3.text).filter((sl) => sl === 's-three-a').length === 1, `${lineOf(h3.text)} ${slugsOn(h3.text).join()}`);
  await post('/api/admin/stories/unpublish', { slug: 's-three-a' });
  const h0 = await get('/');
  check('home: with no issue holding a live story neither the line nor the module renders, and the page still answers 200', h0.status === 200 && !h0.text.includes('latest-issue') && !/Latest issue/.test(strip(homeMainText(h0.text))), `${h0.status}`);
  function homeMainText(h) { return h.match(/<main[\s\S]*<\/main>/)?.[0] ?? h; }
  if (chromium) {
    // reseed one live issue story so the layout can be measured at five widths
    mut((d) => { d.prepare("UPDATE stories SET status = 'live', rev = rev + 1 WHERE slug IN ('s-pos1','s-pos2','s-none-new')").run(); });
    await post('/admin/issues', { number: 12, version: (() => { const d = openDatabase(scratch); try { return d.prepare('SELECT updated_at u FROM newsletter_issues WHERE number = 12').get().u; } finally { d.close(); } })(), action: 'save', date: '2026-09-15', title: 'Corrected Synthetic Title' });
    for (const width of [360, 390, 768, 1024, 1280]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(BASE + '/', { waitUntil: 'load' });
      const m = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth, line: !!document.querySelector('.latest-issue-line a'), mod: !!document.querySelector('.latest-issue .grid .card') }));
      check(`home at ${width}px: Latest issue line and module show, no horizontal scroll`, m.s <= m.w && m.line && m.mod, JSON.stringify(m));
      await ctx.close();
    }
  }
} catch (err) {
  console.error(err);
  console.error(logs.join('').slice(-4000));
  fails++;
} finally {
  await browser?.close();
  server.kill();
  await Promise.race([new Promise((r) => server.once('exit', r)), sleep(3000)]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll issues-browser checks passed.');
process.exitCode = fails ? 1 : 0;
