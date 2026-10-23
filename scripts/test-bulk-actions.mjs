#!/usr/bin/env node
// End-to-end check of dashboard bulk publish and unpublish (issue #88). It starts its own copy of the BUILT server
// against a throwaway data folder, so it needs only DATA_DIR and PORT. Synthetic data only: made-up secrets, no
// email, no GitHub.
//   npm run build
//   DATA_DIR=/tmp/imc-bulk PORT=4390 [SHOTS=/tmp/shots] [AXE_JS=<axe.min.js>] node scripts/test-bulk-actions.mjs
// Run from the repo root. Playwright (Chromium) and axe are optional: PLAYWRIGHT_ROOT (default /opt/node-tools),
// CHROMIUM_PATH (default /opt/pw-browsers/chromium), CHROMIUM_NO_SANDBOX=1, AXE_JS.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to a throwaway data folder.');
const DATA_DIR = path.resolve(process.env.DATA_DIR);
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 4390);
const BASE = `http://localhost:${PORT}`;
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : '';

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

// ---- the server ----
const env = { ...process.env, DATA_DIR, PORT: String(PORT), SITE_URL: BASE, AUTH_SECRET: 'synthetic-auth-secret-0123456789abcdef', TRUST_PROXY: 'true', PUBLISH_TOKEN: 'made-up-publish-token-0123456789abcdef' };
delete env.RESEND_API_KEY;
const server = spawn('node', ['dist/server/entry.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/admin/login'); break; } catch { await sleep(200); } }

// ---- editors (signed in by inserting a session; the sign-in flows have their own tests) ----
const mkUser = (email, name, role) => {
  const now = Date.now();
  const id = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)", email, name, role, now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600_000);
  return { id, name, token };
};
const E1 = mkUser('bulk-editor@example.test', 'Bulk Editor', 'editor');
const ADM = mkUser('bulk-admin@example.test', 'Bulk Admin', 'admin');

class Client {
  constructor(user) { this.cookie = user ? `__Host-imc_session=${user.token}` : ''; }
  async req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (method !== 'GET' && h.Origin === undefined) h.Origin = BASE;
    if (h.Origin === null) delete h.Origin;
    const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    const loc = res.headers.get('location');
    return { status: res.status, loc, text: buf.toString('utf8'), headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  /** A form post; a value that is an array becomes repeated fields. */
  form(u, fields, headers) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, String(x));
    return this.req('POST', u, body, { 'Content-Type': 'application/x-www-form-urlencoded', ...headers });
  }
}
const c1 = new Client(E1);
const cAdmin = new Client(ADM);
const anon = new Client(null);

const draftRow = (id) => q('SELECT * FROM drafts WHERE id = ?', id)[0];
const version = (id) => draftRow(id).updated_at;
const idOf = (r) => Number(/\/admin\/drafts\/(\d+)/.exec(r.loc || '')?.[1]);
const baseFields = (over = {}) => ({ title: 'Volunteers Needed for Camp Meeting', dek: 'Cooks, drivers and greeters are welcome.', section: 'news', area: 'churches', column: '', author: 'Pat Example', authorTitle: 'Communication Volunteer', church: 'Example Hills Church', date: '2026-10-19', photoCredit: '', featured: '', body: 'Camp meeting is **coming up** and we need help.\n\n- Cooks\n- Drivers', ...over });
async function mkDraft(title, over = {}) {
  const r = await c1.form('/api/admin/drafts/new', {});
  const id = idOf(r);
  const s = await c1.form(`/api/admin/drafts/${id}/save`, { version: version(id), ...baseFields({ title, ...over }) });
  if (s.status !== 200) throw new Error(`could not save the synthetic draft ${title}: ${s.status} ${s.text.slice(0, 120)}`);
  return id;
}
// The server also adopts the built archive stories on first start; only our own (slug contains "bulk") are counted.
const bulkStories = () => q("SELECT COUNT(*) n FROM stories WHERE slug LIKE '%bulk%'")[0].n;
const searchHits = async (term) => { const r = await anon.get('/api/search?q=' + encodeURIComponent(term)); try { return JSON.parse(r.text).results.map((x) => x.slug); } catch { return []; } };
async function surfaces(slug, titleText) {
  const page = await anon.get(`/stories/${slug}/`);
  const sec = await anon.get('/news/');
  const json = await anon.get('/stories.json');
  const rss = await anon.get('/rss.xml');
  return { page: page.status === 200, section: sec.text.includes(`/stories/${slug}/`), json: json.text.includes(`/stories/${slug}/`), rss: rss.text.includes(`/stories/${slug}/`), search: (await searchHits(titleText)).includes(slug) };
}
const allTrue = (o) => Object.values(o).every(Boolean);
const noneTrue = (o) => Object.entries(o).filter(([k]) => k !== 'page').every(([, v]) => !v);
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const versionsIn = (html) => Object.fromEntries([...html.matchAll(/<input[^>]*name="v_(\d+)"[^>]*value="(\d+)"/g)].map((m) => [m[1], Number(m[2])]));

try {
  // ================= guards =================
  {
    let r = await anon.form('/admin/bulk', { action: 'publish', id: ['1'], v_1: '1' });
    check('a bulk request without a session is sent to the login page', r.status === 302 && r.loc === '/admin/login', `${r.status} ${r.loc}`);
    r = await c1.form('/admin/bulk', { action: 'publish', id: ['1'], v_1: '1' }, { Origin: 'http://evil.example' });
    check('a cross-origin bulk request is 403', r.status === 403, String(r.status));
    r = await c1.form('/admin/bulk', { action: 'publish', id: ['1'], v_1: '1' }, { Origin: null });
    check('a bulk request without an Origin header is 403', r.status === 403, String(r.status));
    r = await c1.get('/admin/bulk');
    check('opening the bulk address directly (GET) just returns to the list', r.status === 302 && r.loc === '/admin', `${r.status} ${r.loc}`);
    check('there is no viewer role: the only roles are admin and editor, and both may publish like the single buttons', q("SELECT sql FROM sqlite_master WHERE name = 'users'")[0].sql.includes("role IN ('admin', 'editor')"));
  }

  // ================= the lists carry checkboxes without JavaScript =================
  const A = await mkDraft('Bulk Alpha Camp Report');
  const B = await mkDraft('Bulk Bravo Youth Rally');
  const C = await mkDraft('Bulk Charlie Health Fair');
  const HOSTILE = '<script>alert(1)</script> Bulk Delta';
  const D = await mkDraft(HOSTILE);
  run("UPDATE drafts SET submitter_email = 'riley.sample@bulk-mail.test', submitter_phone = '555-0142', submitter_name = 'Riley Sample' WHERE id = ?", D);
  let list = await c1.get('/admin');
  check('the drafts list has a form-linked checkbox and a hidden version per draft, and a bulk form that posts to /admin/bulk', [A, B, C, D].every((id) => new RegExp(`name="id" value="${id}" form="bulk-form"`).test(list.text) && new RegExp(`name="v_${id}" value="\\d+" form="bulk-form"`).test(list.text)) && /<form[^>]*id="bulk-form"[^>]*action="\/admin\/bulk"/.test(list.text));
  check('each checkbox is named by its story title (aria-label), and the hostile title is escaped in the list', list.text.includes('aria-label="Bulk Alpha Camp Report"') && list.text.includes('>&lt;script&gt;alert(1)&lt;/script&gt; Bulk Delta<'));
  check('"Select all" is a real labelled checkbox, hidden until JavaScript runs', /<label[^>]*id="bulk-all-label"[^>]*hidden[^>]*><input[^>]*type="checkbox"[^>]*id="bulk-all"/.test(list.text) && list.text.includes('Select all on this page'));
  const listVersions = versionsIn(list.text);
  check('the list versions match the stored draft versions', [A, B, C, D].every((id) => listVersions[id] === version(id)), JSON.stringify(listVersions));

  // ================= confirmation page =================
  {
    let r = await c1.form('/admin/bulk', { action: 'publish', id: [A, D], [`v_${A}`]: listVersions[A], [`v_${D}`]: listVersions[D] });
    const t = text(r.text);
    check('the confirmation lists the selected titles and takes no action', r.status === 200 && t.includes('Bulk Alpha Camp Report') && t.includes('Nothing happens until you confirm') && bulkStories() === 0 && draftRow(A).status === 'in_review', `${r.status} ${t.slice(0, 300)} stories=${bulkStories()}`);
    check('a hostile title shows literally and creates no element', t.includes(HOSTILE) && !r.text.includes('<script>alert(1)</script>') && r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    check('the confirmation shows no submitter email, phone or name', !/riley|bulk-mail|555-0142/i.test(r.text));
    check('the confirmation has an explicit confirm button and a cancel link', r.text.includes('name="step" value="run"') && /Yes, publish these 2/.test(r.text) && r.text.includes('>Cancel<'));
    r = await c1.form('/admin/bulk', { action: 'publish' });
    check('no selection is a 400 with a clear message', r.status === 400 && text(r.text).includes('Nothing was selected'), String(r.status));
    const many = Array.from({ length: 51 }, (_, i) => String(1000 + i));
    r = await c1.form('/admin/bulk', { action: 'publish', id: many });
    check('51 items on the confirmation step are refused with 400 and a clear message', r.status === 400 && /at most 50/.test(text(r.text)), `${r.status} ${text(r.text).slice(0, 200)}`);
    r = await c1.form('/admin/bulk', { action: 'publish', step: 'run', id: many });
    check('51 items on the run step are refused too, and nothing is processed', r.status === 400 && bulkStories() === 0, `${r.status} stories=${bulkStories()}`);
    r = await c1.form('/admin/bulk', { action: 'unpublish', slug: Array.from({ length: 51 }, (_, i) => `2026-01-01-x-${i}`) });
    check('51 stories to unpublish are refused with 400', r.status === 400);
    r = await c1.form('/admin/bulk', { action: 'publish', id: Array.from({ length: 50 }, (_, i) => String(2000 + i)) });
    check('exactly 50 items are accepted (missing drafts are flagged)', r.status === 200 && text(r.text).includes('No longer exists'));
  }

  // ================= bulk publish with one stale version =================
  {
    // A person edits B after the list loaded: its version moves on.
    const s = await c1.form(`/api/admin/drafts/${B}/save`, { version: version(B), ...baseFields({ title: 'Bulk Bravo Youth Rally', dek: 'Changed after the list loaded.' }) });
    check('(setup) draft B was changed after the list loaded', s.status === 200 && version(B) !== listVersions[B]);
    const bBefore = JSON.stringify(draftRow(B));
    const auditBefore = q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.publish'")[0].n;
    const r = await c1.form('/admin/bulk', { action: 'publish', step: 'run', id: [A, B, C], [`v_${A}`]: listVersions[A], [`v_${B}`]: listVersions[B], [`v_${C}`]: listVersions[C] });
    const t = text(r.text);
    check('the result says 2 of 3 were published and names the failure as a version conflict', r.status === 200 && t.includes('2 of 3 published') && t.includes('Version conflict') && t.includes('1 could not be published'), t.slice(0, 300));
    const slugA = draftRow(A).slug, slugC = draftRow(C).slug;
    check('A and C are published, B is untouched', draftRow(A).status === 'published' && draftRow(C).status === 'published' && JSON.stringify(draftRow(B)) === bBefore && draftRow(B).status === 'in_review' && !draftRow(B).slug);
    check('two draft.publish audit rows were written, one per story', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.publish'")[0].n === auditBefore + 2 && q("SELECT target FROM audit_log WHERE action = 'draft.publish' ORDER BY id DESC LIMIT 2").map((x) => x.target).sort().join() === [`draft:${A}`, `draft:${C}`].sort().join());
    const sa = await surfaces(slugA, 'Bulk Alpha Camp Report');
    const sc = await surfaces(slugC, 'Bulk Charlie Health Fair');
    check('A and C are on the page, section, feeds and search at once', allTrue(sa) && allTrue(sc), JSON.stringify([sa, sc]));
    const slugsNow = q('SELECT slug FROM stories').map((x) => x.slug);
    check('B is not live anywhere', slugsNow.filter((x) => x.includes('bulk')).length === 2 && !(await searchHits('Bulk Bravo Youth Rally')).length, `${slugsNow} ${await searchHits('Bulk Bravo Youth Rally')}`);
    check('the failed item is offered again, pre-selected, with a link to open it', new RegExp(`name="id" value="${B}" checked`).test(r.text) && r.text.includes(`/admin/drafts/${B}`) && !new RegExp(`name="id" value="${A}"`).test(r.text));
    check('the result page has a focusable heading and a status message', /<h1[^>]*id="bulk-heading"[^>]*tabindex="-1"/.test(r.text) && /role="status"/.test(r.text));
    const retryVersions = versionsIn(r.text);
    check('a version-conflict retry carries the draft\'s current version (and is confirmed again first)', retryVersions[B] === version(B));
    const ra = await c1.form('/admin/bulk', { action: 'publish', step: 'run', id: [A], [`v_${A}`]: listVersions[A] });
    check('re-running an already published draft fails with a plain reason instead of republishing', text(ra.text).includes('Only a new or in-review draft can be published') && q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.publish'")[0].n === auditBefore + 2);

    // ================= bulk unpublish =================
    const unpubBefore = q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.unpublish'")[0].n;
    const pub = await c1.get('/admin/published');
    check('the published list has a checkbox per live story and an Unpublish bulk bar', pub.text.includes(`name="slug" value="${slugA}" form="bulk-form"`) && pub.text.includes('Unpublish selected') && pub.text.includes('aria-label="Bulk Alpha Camp Report"'));
    let r2 = await cAdmin.form('/admin/bulk', { action: 'unpublish', slug: [slugA, slugC] });
    check('the unpublish confirmation lists titles and unpublishes nothing yet', r2.status === 200 && text(r2.text).includes('Bulk Alpha Camp Report') && (await surfaces(slugA, 'Bulk Alpha Camp Report')).page);
    r2 = await cAdmin.form('/admin/bulk', { action: 'unpublish', step: 'run', slug: [slugA, slugC, '2026-01-01-never-existed'] });
    const t2 = text(r2.text);
    check('bulk unpublish reports 2 unpublished and 1 failed with a plain reason', r2.status === 200 && t2.includes('2 of 3 unpublished') && t2.includes('That story was not found'), t2.slice(0, 300));
    const ua = await surfaces(slugA, 'Bulk Alpha Camp Report');
    const uc = await surfaces(slugC, 'Bulk Charlie Health Fair');
    check('both stories are gone from the pages, feeds and search', ua.page === false && uc.page === false && noneTrue(ua) && noneTrue(uc), JSON.stringify([ua, uc]));
    check('two draft.unpublish audit rows were written, and the drafts are back in review', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.unpublish'")[0].n === unpubBefore + 2 && draftRow(A).status === 'in_review' && draftRow(C).status === 'in_review');
  }
} finally {
  /* browser section below runs after the HTTP checks */
}

// ================= browser =================
let browser;
try {
  const { chromium } = createRequire((process.env.PLAYWRIGHT_ROOT || '/opt/node-tools') + '/package.json')('playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox'] });
} catch (err) {
  console.log('SKIP  browser checks (Playwright/Chromium not available):', err.message.slice(0, 100));
}
if (browser) {
  try {
    const axePath = process.env.AXE_JS && fs.existsSync(process.env.AXE_JS) ? process.env.AXE_JS : '';
    if (!axePath) console.log('SKIP  axe checks (set AXE_JS to an axe.min.js)');
    for (const width of [390, 1280]) {
      // fresh drafts for each width
      const ids = [];
      for (let i = 1; i <= 4; i++) ids.push(await mkDraft(`Bulk Browser ${width} Story ${i}`));
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1 });
      await context.addCookies([{ name: '__Host-imc_session', value: E1.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true }); } };
      const axeOk = async (name) => {
        if (!axePath) return;
        await page.addScriptTag({ path: axePath });
        const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.length}`));
        check(`${width}px: axe finds no WCAG A/AA violations on ${name}`, v.length === 0, v.join('; '));
      };
      await page.goto(`${BASE}/admin`);
      await page.waitForSelector('#bulk-all');
      check(`${width}px: the list has no horizontal scroll`, await noOverflow());
      check(`${width}px: the JS count and "Select all" appear`, (await page.isVisible('#bulk-all')) && (await page.textContent('#bulk-count')).trim() === '0 selected');
      const small = await page.evaluate(() => [...document.querySelectorAll('label.bulk-pick, .bulk-all, #bulk-form button')].filter((e) => e.getBoundingClientRect().width > 0).filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).length);
      check(`${width}px: checkboxes and the action buttons have 44px targets`, small === 0, String(small));
      await axeOk('the drafts list');
      await page.check('#bulk-all');
      const n = (await page.textContent('#bulk-count')).trim();
      const checked = await page.evaluate(() => [...document.querySelectorAll('input.bulk-item')].filter((i) => i.checked).length);
      check(`${width}px: "Select all" ticks every draft on the page and the count says so`, n === `${checked} selected` && checked >= 4, `${n} / ${checked}`);
      await page.focus('#bulk-form button[type=submit]');
      check(`${width}px: the action bar button is reachable by keyboard`, await page.evaluate(() => document.activeElement?.closest('#bulk-form') !== null));
      await shot('list');
      // only the four browser drafts of this width, so the earlier drafts (B, D) are not published here
      await page.evaluate(() => { document.querySelectorAll('input.bulk-item').forEach((i) => { if (!/Bulk Browser/.test(i.getAttribute('aria-label') || '')) i.checked = false; }); document.querySelector('input.bulk-item').dispatchEvent(new Event('change', { bubbles: true })); });
      const storiesBefore = bulkStories();
      await page.click('#bulk-form button[type=submit]');
      await page.waitForSelector('text=Nothing happens until you confirm');
      check(`${width}px: the confirmation page lists the selected titles`, (await page.textContent('ol.bulk-titles')).includes(`Bulk Browser ${width} Story 1`) && !(await page.textContent('main')).includes('riley'));
      check(`${width}px: the confirmation page has no horizontal scroll and focuses its heading`, (await noOverflow()) && (await page.evaluate(() => document.activeElement?.id)) === 'bulk-heading');
      await axeOk('the confirmation page');
      await shot('confirm');
      check(`${width}px: nothing was published before confirming`, storiesBefore === bulkStories());
      await page.click('button:has-text("Yes, publish")');
      await page.waitForSelector('text=Everything went through');
      check(`${width}px: the result page announces the outcome (status role, focused heading) and has no horizontal scroll`, (await page.textContent('[role=status]')).includes('4 items were published') && (await page.evaluate(() => document.activeElement?.id)) === 'bulk-heading' && (await noOverflow()));
      check(`${width}px: all four were published`, q("SELECT COUNT(*) n FROM drafts WHERE status = 'published' AND title LIKE ?", `Bulk Browser ${width}%`)[0].n === 4);
      await axeOk('the result page');
      await shot('result');
      // the published page: select all, unpublish through the same steps
      await page.goto(`${BASE}/admin/published`);
      await page.waitForSelector('#bulk-all');
      check(`${width}px: the published list has no horizontal scroll`, await noOverflow());
      await axeOk('the published list');
      await shot('published');
      await context.close();
    }
  } catch (err) {
    check('browser checks ran to the end', false, String(err).slice(0, 300));
  } finally {
    await browser.close();
  }
}

check('the server log holds no submitter email or phone', !/bulk-mail|555-0142/.test(serverLog.join('')));
stop();
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
