#!/usr/bin/env node
// End-to-end check of dashboard bulk publish, unpublish, reject and field edits (issues #88 and #89). It starts its own copy of the BUILT server
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
  check('each checkbox is named by its story title (aria-label), and the hostile title is escaped in the list', list.text.includes('aria-label="Bulk Alpha Camp Report (') && list.text.includes('>&lt;script&gt;alert(1)&lt;/script&gt; Bulk Delta<'));
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
    check('a version-conflict item is NOT offered for one-click retry: no checkbox, no hidden version, only a link to open the draft', !new RegExp(`name="id" value="${B}"`).test(r.text) && !new RegExp(`name="v_${B}"`).test(r.text) && r.text.includes(`/admin/drafts/${B}`) && t.includes('changed since you loaded the list') && !r.text.includes('to try again'));
    check('the result page has a focusable heading and a status message', /<h1[^>]*id="bulk-heading"[^>]*tabindex="-1"/.test(r.text) && /role="status"/.test(r.text));
    const ra = await c1.form('/admin/bulk', { action: 'publish', step: 'run', id: [A], [`v_${A}`]: listVersions[A] });
    check('re-running an already published draft fails with a plain reason instead of republishing', text(ra.text).includes('Only a new or in-review draft can be published') && q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.publish'")[0].n === auditBefore + 2);

    // ================= bulk unpublish =================
    const unpubBefore = q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.unpublish'")[0].n;
    const pub = await c1.get('/admin/published');
    check('the published list has a checkbox per live story and an Unpublish bulk bar', pub.text.includes(`name="slug" value="${slugA}" form="bulk-form"`) && pub.text.includes('Unpublish selected') && pub.text.includes('aria-label="Bulk Alpha Camp Report ('));
    let r2 = await cAdmin.form('/admin/bulk', { action: 'unpublish', slug: [slugA, slugC] });
    check('the unpublish confirmation lists titles and unpublishes nothing yet', r2.status === 200 && text(r2.text).includes('Bulk Alpha Camp Report') && (await surfaces(slugA, 'Bulk Alpha Camp Report')).page);
    r2 = await cAdmin.form('/admin/bulk', { action: 'unpublish', step: 'run', slug: [slugA, slugC, '2026-01-01-never-existed'] });
    const t2 = text(r2.text);
    check('bulk unpublish reports 2 unpublished and 1 failed with a plain reason', r2.status === 200 && t2.includes('2 of 3 unpublished') && t2.includes('That story was not found'), t2.slice(0, 300));
    const ua = await surfaces(slugA, 'Bulk Alpha Camp Report');
    const uc = await surfaces(slugC, 'Bulk Charlie Health Fair');
    check('both stories are gone from the pages, feeds and search', ua.page === false && uc.page === false && noneTrue(ua) && noneTrue(uc), JSON.stringify([ua, uc]));
    const draftSnap = JSON.stringify([draftRow(A), draftRow(C)]);
    const auditSnap = q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.unpublish'")[0].n;
    const again = await cAdmin.form('/admin/bulk', { action: 'unpublish', step: 'run', slug: [slugA, slugC] });
    check('running the same bulk unpublish again (a re-POST) fails per item with "not on the site", and changes no draft and writes no audit row', again.status === 200 && text(again.text).includes('0 of 2 unpublished') && (text(again.text).match(/This story is not on the site any more/g) || []).length === 2 && JSON.stringify([draftRow(A), draftRow(C)]) === draftSnap && q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.unpublish'")[0].n === auditSnap);
    check('two draft.unpublish audit rows were written, and the drafts are back in review', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.unpublish'")[0].n === unpubBefore + 2 && draftRow(A).status === 'in_review' && draftRow(C).status === 'in_review');
  }

  // ================= bulk reject (issue #89) =================
  {
    const R1 = await mkDraft('Bulk Reject One');
    const R2 = await mkDraft('Bulk Reject Two');
    const R3 = await mkDraft('Bulk Reject Three');
    run("UPDATE drafts SET submitter_email = 'jordan.sample@bulk-mail.test', submitter_phone = '555-0177', submitter_name = 'Jordan Sample' WHERE id IN (?, ?, ?)", R1, R2, R3);
    const lst = await c1.get('/admin');
    check('the drafts bar offers Reject selected and Edit fields next to Publish selected', ['Publish selected', 'Edit fields', 'Reject selected'].every((l) => lst.text.includes(l)) && /name="action" value="reject"/.test(lst.text));
    const vs = versionsIn(lst.text);
    let r = await c1.form('/admin/bulk', { action: 'reject', id: [R1, R2, R3, D], [`v_${R1}`]: vs[R1], [`v_${R2}`]: vs[R2], [`v_${R3}`]: vs[R3], [`v_${D}`]: vs[D] });
    const t = text(r.text);
    check('the reject confirmation lists titles, has an optional reason box and rejects nothing yet', r.status === 200 && t.includes('Bulk Reject One') && t.includes('Reject 4 drafts?') && r.text.includes('name="note"') && draftRow(R1).status !== 'rejected' && draftRow(D).status !== 'rejected', t.slice(0, 200));
    check('the reject confirmation shows no submitter contact details', !/jordan|riley|bulk-mail|555-01/i.test(r.text));
    check('a hostile title is escaped on the reject confirmation', r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !r.text.includes('<script>alert(1)</script>'));
    // R3 changes after the list loaded
    const s3 = await c1.form(`/api/admin/drafts/${R3}/save`, { version: version(R3), ...baseFields({ title: 'Bulk Reject Three', dek: 'Edited after the list loaded.' }) });
    const r3Before = JSON.stringify(draftRow(R3));
    const rejAudit = q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.reject'")[0].n;
    r = await c1.form('/admin/bulk', { action: 'reject', step: 'run', note: 'Duplicate of an earlier story', id: [R1, R2, R3, D], [`v_${R1}`]: vs[R1], [`v_${R2}`]: vs[R2], [`v_${R3}`]: vs[R3], [`v_${D}`]: vs[D] });
    const t2 = text(r.text);
    check('bulk reject: 3 of 4 rejected, the stale one fails with a version conflict reason', s3.status === 200 && r.status === 200 && t2.includes('3 of 4 rejected') && t2.includes('Version conflict') && t2.includes('nothing was rejected'), t2.slice(0, 300));
    check('the three drafts are rejected with the shared note; the stale draft is untouched', [R1, R2, D].every((id) => draftRow(id).status === 'rejected' && draftRow(id).reject_note === 'Duplicate of an earlier story' && draftRow(id).rejected_at) && JSON.stringify(draftRow(R3)) === r3Before);
    check('one draft.reject audit row per rejected draft (same action as the single reject)', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.reject'")[0].n === rejAudit + 3 && q("SELECT target FROM audit_log WHERE action = 'draft.reject' ORDER BY id DESC LIMIT 3").map((x) => x.target).sort().join() === [`draft:${R1}`, `draft:${R2}`, `draft:${D}`].sort().join());
    check('the reject result shows no contact details; the version-conflicted draft is not pre-selected, carries no version, and links to open it', !/jordan|riley|bulk-mail|555-01/i.test(r.text) && !new RegExp(`name="id" value="${R3}"`).test(r.text) && !new RegExp(`name="v_${R3}"`).test(r.text) && text(r.text).includes('This draft changed since you loaded the list') && r.text.includes(`/admin/drafts/${R3}`));
    check('no contact details in the reject audit detail', !q("SELECT detail FROM audit_log WHERE action = 'draft.reject'").some((x) => /bulk-mail|555-01|Sample/.test(String(x.detail))));
    const again = await c1.form('/admin/bulk', { action: 'reject', step: 'run', id: [R1], [`v_${R1}`]: vs[R1] });
    check('rejecting an already rejected draft fails and says so', text(again.text).includes('0 of 1 rejected') && text(again.text).includes('could not be rejected'), text(again.text).slice(0, 200));
  }

  // ================= bulk edit fields on live stories (issue #89) =================
  const mk = (title, over) => mkDraft(title, over);
  const publishAll = async (ids) => {
    const l = await c1.get('/admin');
    const v = versionsIn(l.text);
    const f = { action: 'publish', step: 'run', id: ids };
    for (const id of ids) f[`v_${id}`] = v[id];
    return c1.form('/admin/bulk', f);
  };
  const HOT = '"><img src=x onerror=alert(1)> Bulk Hotel & <b>Features';
  const E = await mk('Bulk Echo Church Update', { section: 'news', area: 'churches', date: '2026-10-10' });
  const F = await mk('Bulk Foxtrot Camp Notes', { section: 'news', area: 'camp', date: '2026-10-11' });
  const G = await mk('Bulk Golf Pathfinder Fair', { section: 'youth', area: 'pathfinders', date: '2026-10-12' });
  const H = await mk(HOT, { section: 'features', area: '', date: '2026-11-20' });
  {
    // give G an additional section the way the editor form does
    const sv = await c1.form(`/api/admin/drafts/${G}/save`, { version: version(G), ...baseFields({ title: 'Bulk Golf Pathfinder Fair', section: 'youth', area: 'pathfinders', date: '2026-10-12' }), additionalSectionsPresent: '1', additionalSections: ['kids'] });
    check('(setup) G has the Kids additional section', sv.status === 200 && q('SELECT additional_sections a FROM drafts WHERE id = ?', G)[0].a === '["kids"]');
    const pr = await publishAll([E, F, G, H]);
    check('(setup) four synthetic stories are live', text(pr.text).includes('4 of 4 published'), text(pr.text).slice(0, 200));
  }
  const SE = draftRow(E).slug, SF = draftRow(F).slug, SG = draftRow(G).slug, SH = draftRow(H).slug;
  const sRow = (slug) => q('SELECT * FROM stories WHERE slug = ?', slug)[0];
  const IGN = ['section', 'area', 'additional_sections', 'featured', 'date', 'updated_at', 'edited_at', 'rev', 'content_hash', 'story_column'];
  const stable = (slug, ignore = IGN) => JSON.stringify(Object.fromEntries(Object.entries(sRow(slug)).filter(([k]) => !ignore.includes(k))));
  const photosOf = (slug) => JSON.stringify(q('SELECT * FROM story_photos WHERE story_id = (SELECT id FROM stories WHERE slug = ?) ORDER BY position', slug));
  const findDeep = (node, slug) => { if (node && typeof node === 'object') { if (Object.values(node).some((v) => typeof v === 'string' && v.includes(`/${slug}/`))) return node; for (const v of Object.values(node)) { const f = findDeep(v, slug); if (f) return f; } } return undefined; };
  const pubPage = await c1.get('/admin/published');
  check('the published list bar offers Edit fields next to Unpublish selected', pubPage.text.includes('Unpublish selected') && /name="action" value="editstory"[^>]*>Edit fields</.test(pubPage.text));
  const edit = (fields) => c1.form('/admin/bulk', { action: 'editstory', slug: [SE, SF, SG, SH], ...fields });
  {
    let r = await edit({});
    const t = text(r.text);
    check('Edit fields first shows an unticked field chooser listing the stories (hostile title escaped)', r.status === 200 && t.includes('Edit fields on 4 stories') && t.includes('Tick only the fields you want to change') && /name="tick_section"(?![^>]*checked)/.test(r.text) && r.text.includes('&lt;b&gt;Features') && !r.text.includes('<img src=x onerror'), t.slice(0, 200));
    r = await edit({ step: 'confirm' });
    check('confirming with no field ticked is a 400 asking to tick one', r.status === 400 && text(r.text).includes('Tick at least one field'), String(r.status));
    r = await edit({ step: 'confirm', tick_area: '1', e_area: 'camp', tick_section: '1', e_section: 'news|camp' });
    check('section and area-only together are refused', r.status === 400 && text(r.text).includes('not both'));
    r = await edit({ step: 'confirm', tick_add: '1', e_add: ['news'], tick_remove: '1', e_remove: ['news'] });
    check('adding and removing the same section is refused', r.status === 400 && text(r.text).includes('both added and removed'));
    r = await edit({ step: 'confirm', tick_section: '1', e_section: 'news|nonsense' });
    check('an invalid section/category value is refused', r.status === 400);
    r = await edit({ step: 'confirm', tick_date: '1', e_date: '2026-13-45' });
    check('an invalid date is refused', r.status === 400 && text(r.text).includes('valid date'));
    const rev0 = [SE, SF, SG, SH].map((s) => sRow(s).rev).join();
    r = await edit({ step: 'confirm', tick_section: '1', e_section: 'youth|adventurers', tick_featured: '1', e_featured: 'on' });
    const ct = text(r.text);
    check('the confirmation lists exactly the ticked fields and values, and nothing else', r.status === 200 && ct.includes('Section and category: Youth & Pathfinders / Adventurers') && ct.includes('Featured: on') && !ct.includes('Date:') && !ct.includes('Additional sections:') && (r.text.match(/<ul class="bulk-changes"[\s\S]*?<\/ul>/)?.[0].match(/<li>/g) || []).length === 2, ct.slice(0, 400));
    check('the confirmation carries the ticked values to the run step and changes nothing yet', r.text.includes('name="step" value="run"') && r.text.includes('name="e_section" value="youth|adventurers"') && [SE, SF, SG, SH].map((s) => sRow(s).rev).join() === rev0);
  }
  // --- area only: one item fails, the others do not ---
  {
    const before = { E: stable(SE), F: stable(SF), G: stable(SG) };
    const revs = { E: sRow(SE).rev, F: sRow(SF).rev, G: sRow(SG).rev };
    const r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SE, SF, SG], tick_area: '1', e_area: 'camp' });
    const t = text(r.text);
    check('area-only: 2 of 3 updated, the Youth story fails with a plain reason naming its section', t.includes('2 of 3 updated') && t.includes('does not belong to this item') && t.includes('Youth & Pathfinders'), t.slice(0, 400));
    check('E got the new category (rev +1, edited_at set); F already matched and was not rewritten; G was not touched', sRow(SE).area === 'camp' && sRow(SE).rev === revs.E + 1 && sRow(SE).edited_at > 0 && sRow(SF).rev === revs.F && sRow(SG).rev === revs.G && sRow(SG).area === 'pathfinders');
    check('only the ticked field changed (every other column is identical)', stable(SE) === before.E && stable(SF) === before.F && stable(SG) === before.G);
    check('the already-matched item says so', t.includes('Already matched'));
  }
  // --- section change on live stories shows everywhere at once ---
  {
    const before = { E: stable(SE), F: stable(SF), eP: photosOf(SE) };
    const revs = { E: sRow(SE).rev, F: sRow(SF).rev };
    const auditBefore = q("SELECT COUNT(*) n FROM audit_log WHERE action = 'story.bulk_edit'")[0].n;
    const t0 = Date.now();
    const r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SE, SF], tick_section: '1', e_section: 'youth|adventurers' });
    check('section change: 2 of 2 updated', text(r.text).includes('2 of 2 updated'), text(r.text).slice(0, 300));
    check('both rows are in Youth / Adventurers; rev +1 and edited_at set by a person', [SE, SF].every((s) => sRow(s).section === 'youth' && sRow(s).area === 'adventurers' && sRow(s).edited_at >= t0) && sRow(SE).rev === revs.E + 1 && sRow(SF).rev === revs.F + 1);
    check('only the ticked fields changed (unticked fields byte-identical, photos untouched)', stable(SE) === before.E && stable(SF) === before.F && photosOf(SE) === before.eP);
    const youth = await anon.get('/youth/');
    const news = await anon.get('/news/');
    const jE = findDeep(JSON.parse((await anon.get('/stories.json')).text), SE);
    const rss = (await anon.get('/rss.xml')).text;
    const item = rss.slice(rss.indexOf(`/stories/${SE}/`), rss.indexOf('</item>', rss.indexOf(`/stories/${SE}/`)));
    const hitsYouth = JSON.parse((await anon.get('/api/search?q=Echo&section=youth')).text).results.map((x) => x.slug);
    const hitsNews = JSON.parse((await anon.get('/api/search?q=Echo&section=news')).text).results.map((x) => x.slug);
    check('the Youth page lists both at once and the News page no longer does', youth.text.includes(`/stories/${SE}/`) && youth.text.includes(`/stories/${SF}/`) && !news.text.includes(`/stories/${SE}/`) && !news.text.includes(`/stories/${SF}/`));
    check('/stories.json reports the new section and category', !!jE && jE.section === 'youth' && jE.area === 'adventurers', JSON.stringify(jE).slice(0, 200));
    check('the RSS feed carries the new section', /<category>[^<]*Youth[^<]*<\/category>/.test(item) || /youth/i.test(item), item.slice(0, 300));
    check('search with a section filter follows the change at once', hitsYouth.includes(SE) && !hitsNews.includes(SE), `${hitsYouth} / ${hitsNews}`);
    const rows = q("SELECT target, detail FROM audit_log WHERE action = 'story.bulk_edit' ORDER BY id DESC LIMIT 2");
    check('one story.bulk_edit audit row per item, listing field NAMES only (no titles or values)', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'story.bulk_edit'")[0].n === auditBefore + 2 && rows.every((x) => { const d = JSON.parse(x.detail); return Object.keys(d).join() === 'fields' && d.fields.join() === 'section,area' && !/Echo|youth|adventurers/i.test(x.detail); }), JSON.stringify(rows));
  }
  // --- additional sections: add / remove rules ---
  {
    const before = stable(SG);
    let r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SG, SH], tick_add: '1', e_add: ['youth', 'news'] });
    const gExtras = JSON.parse(sRow(SG).additional_sections);
    check('add: the primary section is never kept as an extra; news is added to the existing kids (central order)', text(r.text).includes('2 of 2 updated') && gExtras.join() === 'news,kids' && !gExtras.includes('youth'), JSON.stringify(gExtras));
    check('add on a story whose primary is not youth adds both', JSON.parse(sRow(SH).additional_sections).join() === 'news,youth');
    const newsPage = await anon.get('/news/');
    check('a story added to News shows on the News page and still on its own section page', newsPage.text.includes(`/stories/${SG}/`) && (await anon.get('/youth/')).text.includes(`/stories/${SG}/`));
    const rev = sRow(SG).rev;
    r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SG, SH], tick_remove: '1', e_remove: ['kids', 'features'] });
    check('remove: the listed extras go, absent ones are ignored', JSON.parse(sRow(SG).additional_sections).join() === 'news' && JSON.parse(sRow(SH).additional_sections).join() === 'news,youth' && sRow(SG).rev === rev + 1, JSON.stringify([sRow(SG).additional_sections, sRow(SH).additional_sections]));
    check('removing an extra that was never there says "already matched"', text(r.text).includes('Already matched'));
    r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SG], tick_add: '1', e_add: ['kids'], tick_remove: '1', e_remove: ['news'] });
    check('add and remove in one request apply together', JSON.parse(sRow(SG).additional_sections).join() === 'kids');
    check('primary section, area and every other field of G are unchanged by the extras edits', stable(SG) === before && sRow(SG).section === 'youth' && sRow(SG).area === 'pathfinders');
    check('the audit names the field "additionalSections" only', q("SELECT detail FROM audit_log WHERE action = 'story.bulk_edit' ORDER BY id DESC LIMIT 1")[0].detail === '{"fields":["additionalSections"]}');
  }
  // --- featured and date ---
  {
    const homeHero = async () => { const h = (await anon.get('/')).text; const a = h.indexOf('aria-label="Top stories"'); return h.slice(a, h.indexOf('hero-side', a)); };
    check('(setup) the Features story is not the home hero before featuring', !(await homeHero()).includes('Bulk Hotel'));
    const before = stable(SH);
    let r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SH], tick_featured: '1', e_featured: 'on' });
    check('featured on: the story leads the home page at once', text(r.text).includes('1 of 1 updated') && sRow(SH).featured === 1 && (await homeHero()).includes('Bulk Hotel'), `featured=${sRow(SH).featured} hero=${(await homeHero()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
    check('featured: only that column changed', stable(SH) === before);
    r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SH], tick_featured: '1', e_featured: 'off' });
    check('featured off: it leaves the hero again', sRow(SH).featured === 0 && !(await homeHero()).includes('Bulk Hotel'));
    const order = async () => { const h = (await anon.get('/youth/')).text; return [SE, SF, SG].map((s) => h.indexOf(`/stories/${s}/`)); };
    const o0 = await order();
    check('(setup) before the date change, E is listed after F and G on the Youth page', o0.every((x) => x > 0) && o0[0] > o0[1] && o0[0] > o0[2], JSON.stringify(o0));
    r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SE], tick_date: '1', e_date: '2026-12-05' });
    const o1 = await order();
    check('date change: E moves to the top of the Youth page', sRow(SE).date === '2026-12-05' && o1[0] > 0 && o1[0] < o1[1] && o1[0] < o1[2], JSON.stringify(o1));
    check('the date shows in /stories.json', (await anon.get('/stories.json')).text.includes('2026-12-05'));
  }
  // --- a live story with an open draft is refused ---
  {
    const ed = await c1.form('/api/admin/stories/edit', { slug: SF });
    const openId = idOf(ed);
    const rev = sRow(SF).rev;
    const r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SF, SE], tick_featured: '1', e_featured: 'on' });
    const t = text(r.text);
    check('a live story with an open draft is refused with a plain reason; the other item is still updated', openId > 0 && t.includes('1 of 2 updated') && t.includes('An open draft exists for this story') && sRow(SF).rev === rev && sRow(SF).featured === 0 && sRow(SE).featured === 1, t.slice(0, 300));
  }
  // --- a bulk edit also updates the linked closed draft, so unpublish + publish cannot revert it ---
  {
    let r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SH], tick_section: '1', e_section: 'news|churches', tick_featured: '1', e_featured: 'on' });
    check('(M1) bulk edit of a live story changed section and featured', text(r.text).includes('1 of 1 updated') && sRow(SH).section === 'news' && sRow(SH).featured === 1);
    const dh = draftRow(H);
    check('(M1) the linked published draft carries the new section, category and featured flag at once', dh.status === 'published' && dh.section === 'news' && dh.area === 'churches' && dh.featured === 1, JSON.stringify([dh.status, dh.section, dh.area, dh.featured]));
    r = await cAdmin.form('/admin/bulk', { action: 'unpublish', step: 'run', slug: [SH] });
    check('(M1) after unpublish the draft in review still shows the edited fields', text(r.text).includes('1 of 1 unpublished') && draftRow(H).status === 'in_review' && draftRow(H).section === 'news' && draftRow(H).area === 'churches' && draftRow(H).featured === 1);
    r = await publishAll([H]);
    check('(M1) publishing again keeps the bulk edit', text(r.text).includes('1 of 1 published') && sRow(SH).section === 'news' && sRow(SH).area === 'churches' && sRow(SH).featured === 1 && sRow(SH).status === 'live', JSON.stringify([sRow(SH).section, sRow(SH).featured, sRow(SH).status]));
    const r2 = await edit({});
    check('(M2) the add and remove lists are separate named groups, and so is the featured choice', ['Sections to add', 'Sections to remove', 'New featured setting'].every((l) => new RegExp(`<legend>${l}</legend>`).test(r2.text)));
    const cc = await c1.form('/admin/bulk', { action: 'editstory', step: 'confirm', slug: [SG], tick_section: '1', e_section: 'columns|' });
    check('(L2) the story confirmation says the change is live at once', text(cc.text).includes('show on the public site at once'));
  }
  // --- limits ---
  {
    let r = await c1.form('/admin/bulk', { action: 'editstory', step: 'confirm', tick_featured: '1', e_featured: 'on', slug: Array.from({ length: 51 }, (_, i) => `2026-01-01-y-${i}`) });
    check('51 stories to edit are refused with a clear message', r.status === 400 && /at most 50/.test(text(r.text)));
    r = await c1.form('/admin/bulk', { action: 'edit', step: 'run', tick_featured: '1', e_featured: 'on', id: Array.from({ length: 51 }, (_, i) => String(3000 + i)) });
    check('51 drafts to edit are refused on the run step too', r.status === 400);
    r = await c1.form('/admin/bulk', { action: 'reject', step: 'run', id: Array.from({ length: 51 }, (_, i) => String(3000 + i)) });
    check('51 drafts to reject are refused too', r.status === 400);
    r = await c1.form('/admin/bulk', { action: 'editstory', step: 'run', slug: [SG], tick_featured: '1', e_featured: 'on' }, { Origin: 'http://evil.example' });
    check('a cross-origin bulk edit is 403', r.status === 403);
  }

  // ================= bulk edit fields on drafts (issue #89) =================
  {
    const X1 = await mk('Bulk Xray Draft One', { section: 'news', area: 'schools', date: '2026-09-01' });
    const X2 = await mk('Bulk Yankee Draft Two', { section: 'features', area: '', date: '2026-09-02' });
    const X3 = await mk('Bulk Zulu Draft Three', { section: 'news', area: 'churches', date: '2026-09-03' });
    const X4 = await mk(HOT + ' Draft', { section: 'news', area: 'camp', date: '2026-09-04' });
    run("UPDATE drafts SET submitter_email = 'casey.sample@bulk-mail.test', submitter_phone = '555-0191', submitter_name = 'Casey Sample' WHERE id IN (?, ?, ?, ?)", X1, X2, X3, X4);
    const lst = await c1.get('/admin');
    const vs = versionsIn(lst.text);
    const ids = [X1, X2, X3, X4];
    const body = (extra) => ({ action: 'edit', id: ids, ...Object.fromEntries(ids.map((id) => [`v_${id}`, vs[id]])), ...extra });
    let r = await c1.form('/admin/bulk', body({}));
    check('the draft field chooser lists the drafts, escaped, with no contact details', r.status === 200 && text(r.text).includes('Edit fields on 4 drafts') && !/casey|bulk-mail|555-01/i.test(r.text) && !r.text.includes('<img src=x onerror'), text(r.text).slice(0, 200));
    r = await c1.form('/admin/bulk', body({ step: 'confirm', tick_section: '1', e_section: 'youth|pathfinders', tick_featured: '1', e_featured: 'on', tick_add: '1', e_add: ['kids'] }));
    const ct = text(r.text);
    check('the draft confirmation lists exactly the ticked fields, no contact details, and explains the saved state', r.status === 200 && ct.includes('Section and category: Youth & Pathfinders / Pathfinders') && ct.includes('Featured: on') && ct.includes('Additional sections: add Kids') && !/casey|bulk-mail|555-01/i.test(r.text) && ct.includes('moves to In review') && ct.includes('AI agent can no longer update it'), ct.slice(0, 300));
    // X3 is edited by a person after the list loaded
    const sv = await c1.form(`/api/admin/drafts/${X3}/save`, { version: version(X3), ...baseFields({ title: 'Bulk Zulu Draft Three', section: 'news', area: 'churches', date: '2026-09-03', dek: 'Changed after the list loaded.' }) });
    const x3 = JSON.stringify(draftRow(X3));
    const keep = (id) => JSON.stringify(Object.fromEntries(Object.entries(draftRow(id)).filter(([k]) => !['section', 'area', 'featured', 'additional_sections', 'updated_at', 'updated_by', 'status', 'story_column'].includes(k))));
    const k = { [X1]: keep(X1), [X2]: keep(X2), [X4]: keep(X4) };
    const revCount = (id) => q('SELECT COUNT(*) n FROM draft_revisions WHERE draft_id = ?', id)[0].n;
    const rc = { [X1]: revCount(X1), [X2]: revCount(X2), [X4]: revCount(X4) };
    const aud = q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.bulk_edit'")[0].n;
    r = await c1.form('/admin/bulk', body({ step: 'run', tick_section: '1', e_section: 'youth|pathfinders', tick_featured: '1', e_featured: 'on', tick_add: '1', e_add: ['kids', 'youth'] }));
    const t = text(r.text);
    check('draft edit: 3 of 4 updated; the draft changed after the list loaded fails with a version conflict', sv.status === 200 && t.includes('3 of 4 updated') && t.includes('Version conflict') && t.includes('nothing was changed'), t.slice(0, 300));
    check('the ticked fields changed on the three drafts and they are In review (the editor save rules)', [X1, X2, X4].every((id) => draftRow(id).section === 'youth' && draftRow(id).area === 'pathfinders' && draftRow(id).featured === 1 && draftRow(id).additional_sections === '["kids"]' && draftRow(id).status === 'in_review'), JSON.stringify([X1, X2, X4].map((id) => [draftRow(id).section, draftRow(id).area, draftRow(id).featured, draftRow(id).additional_sections, draftRow(id).status])));
    check('everything else on the drafts (text, date, contact details) is byte-identical', keep(X1) === k[X1] && keep(X2) === k[X2] && keep(X4) === k[X4]);
    check('the conflicting draft is untouched', JSON.stringify(draftRow(X3)) === x3);
    check('(I1) the version-conflicted draft is not pre-selected and carries no version; other failures would stay', !new RegExp(`name="id" value="${X3}"`).test(r.text) && !new RegExp(`name="v_${X3}"`).test(r.text) && t.includes('This draft changed since you loaded the list') && r.text.includes(`/admin/drafts/${X3}`));
    check('a draft revision of the previous state was recorded for each changed draft', [X1, X2, X4].every((id) => revCount(id) === rc[id] + 1), JSON.stringify([rc, revCount(X1), revCount(X2), revCount(X4)]));
    const last = q("SELECT target, detail FROM audit_log WHERE action = 'draft.bulk_edit' ORDER BY id DESC LIMIT 3");
    check('one draft.bulk_edit audit row per changed draft, with field names only', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.bulk_edit'")[0].n === aud + 3 && last.every((x) => /^[a-zA-Z,"\[\]:{}]+$/.test(x.detail) && JSON.parse(x.detail).fields.join() === 'section,area,additionalSections,featured'), JSON.stringify(last));
    check('the draft results show no contact details and the hostile title is escaped', !/casey|bulk-mail|555-01/i.test(r.text) && !r.text.includes('<img src=x onerror'));
    r = await c1.form('/admin/bulk', { action: 'edit', step: 'run', id: [X2, X3], [`v_${X2}`]: version(X2), [`v_${X3}`]: version(X3), tick_area: '1', e_area: 'churches' });
    check('draft area-only: the youth draft fails with its reason, the news draft is updated', text(r.text).includes('1 of 2 updated') && text(r.text).includes('does not belong to this item') && draftRow(X3).area === 'churches', text(r.text).slice(0, 300));
    r = await c1.form('/admin/bulk', { action: 'edit', step: 'run', id: [X1], [`v_${X1}`]: version(X1), tick_date: '1', e_date: '2026-11-11' });
    check('draft date change: only the date changes', draftRow(X1).date === '2026-11-11' && draftRow(X1).section === 'youth' && draftRow(X1).featured === 1);
    const closed = await c1.form('/admin/bulk', { action: 'edit', step: 'run', id: [D], [`v_${D}`]: version(D), tick_featured: '1', e_featured: 'on' });
    check('a rejected draft cannot be bulk edited', text(closed.text).includes('0 of 1 updated') && draftRow(D).featured === 0);
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
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
      await ctx.addCookies([{ name: '__Host-imc_session', value: E1.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const p = await ctx.newPage();
      p.setDefaultTimeout(15000);
      const id = await mkDraft('Bulk NoJS Story');
      await p.goto(`${BASE}/admin`);
      check('without JavaScript the non-working "Select all" is not shown', !(await p.isVisible('#bulk-all')) && !(await p.isVisible('#bulk-count')));
      await p.check(`input.bulk-item[value="${id}"]`);
      await p.click('#bulk-form button[type=submit]');
      await p.waitForSelector('text=Nothing happens until you confirm');
      check('without JavaScript a ticked checkbox still reaches the confirmation page', (await p.textContent('ol.bulk-titles')).includes('Bulk NoJS Story'));
      await p.click('button:has-text("Yes, publish")');
      await p.waitForSelector('text=Everything went through');
      check('...and confirming publishes it', draftRow(id).status === 'published');
      await ctx.close();
    }
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
      // ---- bulk edit fields on live stories, in the browser (issue #89) ----
      const tickByLabel = (pattern) => page.evaluate((src) => { const re = new RegExp(src); const items = [...document.querySelectorAll('input.bulk-item')]; items.forEach((i) => { i.checked = re.test(i.getAttribute('aria-label') || ''); }); items[0].dispatchEvent(new Event('change', { bubbles: true })); return items.filter((i) => i.checked).length; }, pattern);
      const bigTargets = async (what) => {
        const small = await page.evaluate(() => [...document.querySelectorAll('main .bulk-field label, main button, main select, main input:not([type=hidden]):not([type=checkbox]):not([type=radio]), main .cms-btn')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 43.5); }).map((e) => (e.tagName + ' ' + (e.textContent || '').trim().slice(0, 30))));
        check(`${width}px: every control on ${what} is at least 44px tall`, small.length === 0, small.join('; '));
      };
      await tickByLabel(`^Bulk Browser ${width} Story [12]\\b`);
      await page.click('#bulk-form button[value=editstory]');
      await page.waitForSelector('text=Tick only the fields you want to change');
      check(`${width}px: the field chooser has no horizontal scroll and focuses its heading`, (await noOverflow()) && (await page.evaluate(() => document.activeElement?.id)) === 'bulk-heading');
      check(`${width}px: add, remove and featured are separate groups with distinct accessible names`, (await page.getByRole('group', { name: 'Sections to add' }).count()) === 1 && (await page.getByRole('group', { name: 'Sections to remove' }).count()) === 1 && (await page.getByRole('group', { name: 'Sections to add' }).getByRole('checkbox', { name: 'News' }).count()) === 1 && (await page.getByRole('group', { name: 'New featured setting' }).count()) === 1);
      await bigTargets('the field chooser');
      await axeOk('the bulk edit field chooser');
      await shot('edit-fields');
      await page.click('button:has-text("Review the changes")');
      await page.waitForSelector('text=Tick at least one field');
      check(`${width}px: submitting with nothing ticked shows an alert error and no horizontal scroll`, (await page.isVisible('[role=alert]')) && (await noOverflow()));
      await page.check('input[name=tick_featured]');
      await page.check('input[name=tick_add]');
      await page.check('input[name=e_add][value=kids]');
      await page.click('button:has-text("Review the changes")');
      await page.waitForSelector('#bulk-changes');
      const changeList = await page.textContent('#bulk-changes');
      check(`${width}px: the confirmation shows exactly the two ticked changes`, changeList.includes('Featured: on') && changeList.includes('add Kids') && !changeList.includes('Date') && (await page.locator('#bulk-changes li').count()) === 2, changeList);
      check(`${width}px: the edit confirmation has no horizontal scroll`, await noOverflow());
      await axeOk('the bulk edit confirmation');
      await shot('edit-confirm');
      await page.click('button:has-text("Yes, edit these 2")');
      await page.waitForSelector('text=Everything went through');
      check(`${width}px: the edit result says 2 items were updated`, (await page.textContent('[role=status]')).includes('2 items were updated') && (await noOverflow()));
      check(`${width}px: both stories are featured, with the extra section`, q("SELECT COUNT(*) n FROM stories WHERE title LIKE ? AND featured = 1 AND additional_sections LIKE '%kids%'", `Bulk Browser ${width} Story _`)[0].n === 2);
      await axeOk('the bulk edit result');
      await shot('edit-result');
      // ---- bulk reject, in the browser ----
      const rj = [await mkDraft(`Bulk Rejectme ${width} One`), await mkDraft(`Bulk Rejectme ${width} Two`)];
      await page.goto(`${BASE}/admin`);
      await page.waitForSelector('#bulk-all');
      await tickByLabel(`^Bulk Rejectme ${width}`);
      await page.click('#bulk-form button[value=reject]');
      await page.waitForSelector('#bulk-note');
      check(`${width}px: the reject confirmation has a labelled reason box and no horizontal scroll`, (await page.locator('label[for=bulk-note]').count()) === 1 && (await noOverflow()));
      await bigTargets('the reject confirmation');
      await axeOk('the bulk reject confirmation');
      await shot('reject-confirm');
      await page.fill('#bulk-note', 'Not a fit for this season');
      await page.click('button:has-text("Yes, reject these 2")');
      await page.waitForSelector('text=Everything went through');
      check(`${width}px: the reject result says 2 items were rejected, and both drafts are rejected with the note`, (await page.textContent('[role=status]')).includes('2 items were rejected') && rj.every((id) => draftRow(id).status === 'rejected' && draftRow(id).reject_note === 'Not a fit for this season'));
      await axeOk('the bulk reject result');
      await shot('reject-result');
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
