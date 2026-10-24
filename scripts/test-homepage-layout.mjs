// Issue #155: the home page layout editor. Built server on a throwaway DATA_DIR, synthetic stories only, no external requests.
// Set SHOTS=<dir> (with PLAYWRIGHT_ROOT and CHROMIUM_PATH) to also write screenshots of /admin/homepage and a trimmed home page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
import { defaultBlocks, normalizeHomepageBlocks, readableHomepageBlocks, RAIL_LIMIT } from '../src/lib/homepage-layout.ts';

const ROOT = process.cwd(), PORT = process.env.PORT || '4871', BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-homepage-layout-'));
const shots = process.env.SHOTS || ''; if (shots) fs.mkdirSync(shots, { recursive: true });
let db, server, browser, checks = 0; const logs = [];
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log('PASS ' + name); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_ORDER = ['intro', 'spotlight', 'featured', 'hero', 'latest_issue', 'topics', 'rail:features', 'community', 'rail:youth', 'rail:kids', 'archive', 'cta'];

// What the page shows, in page order, from the markup alone.
const MARKERS = [
  ['intro', /<section class="home-intro"/g], ['spotlight', /<section class="event-spotlight"/g], ['featured', /<(?:section|article|div) class="featured-panel"/g],
  ['hero', /<section class="hero"/g], ['latest_issue', /<section class="block latest-issue"/g], ['topics', /<nav class="topic-directory"/g],
  ['community', /<section class="block community-section"/g], ['archive', /<section class="block archive-rail"/g], ['cta', /<section class="cta"/g],
  ['rail', /<section class="block" data-sec="([a-z]+)"/g],
];
const order = (html) => MARKERS.flatMap(([key, re]) => [...html.matchAll(re)].map((m) => ({ at: m.index, key: key === 'rail' ? `rail:${m[1]}` : key }))).sort((a, b) => a.at - b.at).map((m) => m.key);

try {
  // Pure rules.
  check('the default blocks are today\'s page order with everything visible', JSON.stringify(defaultBlocks().map((b) => b.section ? `rail:${b.section}` : b.key)) === JSON.stringify(DEFAULT_ORDER) && defaultBlocks().every((b) => b.visible));
  check('missing fixed blocks come back visible at their default place', JSON.stringify(readableHomepageBlocks([{ key: 'cta', visible: false }]).map((b) => b.key)) === JSON.stringify(['intro', 'spotlight', 'featured', 'hero', 'latest_issue', 'topics', 'community', 'archive', 'cta']) && readableHomepageBlocks([{ key: 'cta', visible: false }]).at(-1).visible === false);
  check('reading drops unknown blocks, bad rails and repeats; saving refuses them', readableHomepageBlocks([{ key: 'zzz', visible: true }, { key: 'rail-a', visible: true, section: 'nope' }, { key: 'intro', visible: true }, { key: 'intro', visible: false }]).filter((b) => b.key === 'intro').length === 1
    && [[{ key: 'zzz', visible: true }], [{ key: 'rail-a', visible: true, section: 'nope' }], [{ key: 'intro', visible: true }, { key: 'intro', visible: true }]].every((v) => { try { normalizeHomepageBlocks(v); return false; } catch { return true; } }));
  check('the retired columns key is read as features', normalizeHomepageBlocks([...defaultBlocks().filter((b) => b.key !== 'rail-features'), { key: 'rail-old', visible: true, section: 'columns' }]).find((b) => b.key === 'rail-old').section === 'features');
  check('a second rail for the same section is refused when saving and dropped when reading', (() => { const two = [...defaultBlocks(), { key: 'rail-twin', visible: true, section: 'kids' }]; try { normalizeHomepageBlocks(two); return false; } catch (e) { return e.message === 'Each section can have only one rail.' && readableHomepageBlocks(two).filter((b) => b.section === 'kids').length === 1 && !readableHomepageBlocks(two).some((b) => b.key === 'rail-twin'); } })());

  db = openDatabase(scratch); runMigrations(db, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  const now = Date.now(), run = (sql, ...v) => db.prepare(sql).run(...v), row = (sql, ...v) => db.prepare(sql).get(...v), rows = (sql, ...v) => db.prepare(sql).all(...v);
  run('INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)', 'git_adopted_at', String(now), now);
  const sessions = {};
  for (const role of ['admin', 'editor']) { const id = Number(run('INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES(?,?,?,\'active\',?,?)', `${role}@synthetic.invalid`, `Synthetic ${role}`, role, now, now).lastInsertRowid), token = randomBytes(32).toString('base64url'); run('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)', createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600000); sessions[role] = { id, token }; }
  run('INSERT INTO newsletter_issues (number, date, title, created_at, updated_at) VALUES (?,?,?,?,?)', 7, '2026-10-01', 'Synthetic Issue', now, now);
  const day = (n) => new Date(now - n * 86400000).toISOString().slice(0, 10);
  const ins = db.prepare("INSERT INTO stories (slug,title,dek,section,area,author,date,body,status,source,published_at,updated_at,draft,featured,newsletter_issue,newsletter_position,church) VALUES (?,?,?,?,?,'Synthetic Author',?,'A made-up paragraph.','live','editor',?,?,0,?,?,?,?)");
  let n = 0;
  const add = (title, section, area, age, featured = 0, issue = null) => { n++; ins.run(`synthetic-${n}`, title, 'A made-up summary.', section, area, day(age), now, now, featured, issue, issue ? n : null, `Synthetic Church ${n % 3}`); };
  add('Synthetic featured panel story', 'features', '', 2, 1, 7);
  add('Synthetic second featured', 'news', 'churches', 3, 1);
  for (let i = 0; i < 4; i++) add(`Synthetic news conference ${i}`, 'news', 'conference', 4 + i, 0, i < 3 ? 7 : null);
  for (let i = 0; i < 3; i++) add(`Synthetic news churches ${i}`, 'news', 'churches', 8 + i);
  add('Synthetic news camp', 'news', 'camp', 12);
  for (let i = 0; i < 4; i++) add(`Synthetic feature ${i}`, 'features', '', 14 + i);
  for (let i = 0; i < 4; i++) add(`Synthetic youth ${i}`, 'youth', 'pathfinders', 20 + i);
  for (let i = 0; i < 4; i++) add(`Synthetic kids ${i}`, 'kids', '', 30 + i);
  for (let i = 0; i < 8; i++) add(`Synthetic archive ${i}`, ['news', 'features', 'youth', 'kids'][i % 4], i % 4 === 0 ? 'conference' : i % 4 === 2 ? 'youth' : '', 120 + i * 20);
  run("INSERT INTO stories (slug,title,dek,section,area,author,date,body,status,source,published_at,updated_at,draft,announcement) VALUES ('synthetic-event','Synthetic gathering','A made-up invitation.','news','conference','Synthetic Author',?,'A made-up paragraph.','live','editor',?,?,0,?)", day(0), now, now, JSON.stringify({ kind: 'event', eventDate: day(-5), location: 'Synthetic Hall', links: [] }));
  const storyState = () => JSON.stringify(rows("SELECT id,rev,updated_at,date,featured FROM stories WHERE section<>'kids' ORDER BY id")); // the kids rows are edited by the test itself
  const storiesBefore = storyState();

  server = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT, DATA_DIR: scratch, SITE_URL: BASE, AUTH_SECRET: 'synthetic-homepage-auth-' + 's'.repeat(40), AGENT_API_TOKEN: '', PUBLISH_TOKEN: '', RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => logs.push(String(d))); server.stderr.on('data', (d) => logs.push(String(d)));
  let ready = false; for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/admin/login'); ready = true; break; } catch { await delay(100); } }
  check('isolated built server starts with the homepage migration', ready && !!row("SELECT name FROM sqlite_master WHERE name='homepage_layout'"));
  const headers = (role = 'admin') => ({ Origin: BASE, Cookie: `__Host-imc_session=${sessions[role].token}` });
  const get = async (url, role) => { const res = await fetch(BASE + url, { redirect: 'manual', headers: role ? headers(role) : {} }); return { status: res.status, text: await res.text() }; };
  const home = async () => (await get('/')).text;
  const saved = () => { const r = row('SELECT version,blocks FROM homepage_layout WHERE id=1'); return r ? { version: r.version, blocks: JSON.parse(r.blocks) } : { version: 0, blocks: defaultBlocks() }; };
  const form = (blocks, version, action = 'save') => { const f = new URLSearchParams(); f.set('version', String(version)); f.set('action', action); blocks.forEach((b, i) => { f.set(`key.${i}`, b.key); if (b.visible) f.set(`visible.${i}`, 'on'); if (b.section !== undefined) f.set(`section.${i}`, b.section); }); return f; };
  const post = (blocks, version, action = 'save', role = 'admin', extra = {}) => fetch(BASE + '/admin/homepage', { method: 'POST', redirect: 'manual', headers: { ...(role ? headers(role) : {}), ...extra, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(blocks, version, action) });
  // Buttons other than Save only stage: the response is the page with the changed layout carried in its form fields.
  const parseRows = (html) => ({
    version: Number(/name="version" value="(\d+)"/.exec(html)?.[1]),
    rows: html.split('<li class="homepage-row"').slice(1).map((li) => ({ key: /name="key\.\d+" value="([^"]+)"/.exec(li)[1], visible: /name="visible\.\d+"[^>]*checked/.test(li), ...(/name="section\.\d+"/.test(li) ? { section: /<option value="([a-z]+)"[^>]*selected/.exec(li)?.[1] ?? '' } : {}) })),
  });
  const stage = async (action, from = saved()) => { const res = await post(from.blocks, from.version, action); const html = await res.text(); return { status: res.status, html, ...(res.status === 403 ? {} : parseRows(html)) }; };
  const act = async (action) => { const st = await stage(action); if (st.status !== 200) return st; const res = await post(st.rows, st.version, 'save'); return { ...st, status: res.status }; }; // stage, then Save the staged rows
  const idx = (key) => saved().blocks.findIndex((b) => b.key === key);
  const railKeys = () => saved().blocks.filter((b) => b.key.startsWith('rail-')).map((b) => b.key);
  const toggle = (blocks, keys, visible) => blocks.map((b) => keys.includes(b.key) ? { ...b, visible } : b);

  // Default page.
  const base = await home();
  check('with no layout saved, the home page shows today\'s blocks in today\'s order', JSON.stringify(order(base)) === JSON.stringify(DEFAULT_ORDER));
  check('the featured panel keeps its own wrapper and the intro keeps one h1', (base.match(/<h1/g) || []).length === 1 && base.includes('id="home-title"'));

  // Access.
  check('anonymous users cannot open the layout page', (await get('/admin/homepage')).status === 302);
  check('editors cannot read the layout page', (await get('/admin/homepage', 'editor')).status === 403);
  check('editors cannot change the layout', (await post(defaultBlocks(), 0, 'save', 'editor')).status === 403 && !row('SELECT 1 x FROM homepage_layout'));
  check('layout changes require a same-origin POST', (await post(defaultBlocks(), 0, 'save', 'admin', { Origin: 'http://evil.invalid' })).status === 403 && !row('SELECT 1 x FROM homepage_layout'));
  const page = await get('/admin/homepage', 'admin');
  check('administrators get the layout page with working form buttons and no JavaScript needed', page.status === 200 && page.text.includes('name="action" value="up:1"') && page.text.includes('value="down:0"') && page.text.includes('Restore default layout') && page.text.includes('Add section rail') && page.text.includes('href="/admin/homepage"') && !/<script[^>]*src=/.test(page.text.split('<main')[1] || ''));
  check('the page lists every default block and three rails with section selects', page.text.includes('Introduction') && page.text.includes('Section directory') && (page.text.match(/name="section\.\d+"/g) || []).length === 3);

  // Hide, show.
  let r = await post(toggle(defaultBlocks(), ['hero', 'latest_issue'], false), 0);
  check('saving hides blocks (200, version 1)', r.status === 200 && saved().version === 1);
  let html = await home();
  check('hidden blocks vanish from the home page on the very next request', JSON.stringify(order(html)) === JSON.stringify(DEFAULT_ORDER.filter((k) => k !== 'hero' && k !== 'latest_issue')));
  check('hiding the hero leaves no stray heading, empty state or empty wrapper', !html.includes('Stories worth sharing') && !html.includes('No stories yet') && !/<div class="wrap magazine-home">\s*<\/div>/.test(html) && (html.match(/<h1/g) || []).length === 1);
  r = await post(toggle(saved().blocks, ['hero', 'latest_issue'], true), 1);
  check('showing them again restores the default page', r.status === 200 && JSON.stringify(order(await home())) === JSON.stringify(DEFAULT_ORDER));
  r = await post(toggle(saved().blocks, ['featured'], false), 2);
  html = await home();
  check('hiding the featured panel keeps the hero, one heading, and its story becomes an ordinary story', r.status === 200 && !order(html).includes('featured') && order(html).includes('hero') && (html.match(/Stories worth sharing/g) || []).length === 1 && html.includes('Synthetic featured panel story'));
  r = await post(toggle(saved().blocks, ['featured', 'intro'], false), 3);
  html = await home();
  check('hiding the intro keeps exactly one (screen-reader) h1 and no home-intro', r.status === 200 && !order(html).includes('intro') && (html.match(/<h1/g) || []).length === 1 && html.includes('<h1 class="sr-only">IMConnected</h1>'));
  r = await post(toggle(saved().blocks, ['featured', 'intro'], true), 4);
  check('the layout returns to the default order', JSON.stringify(order(await home())) === JSON.stringify(DEFAULT_ORDER));
  r = await post(toggle(saved().blocks, defaultBlocks().map((b) => b.key).concat(railKeys()), false), 5);
  check('hiding every block is refused and nothing changes', r.status === 400 && saved().version === 5 && (await r.text()).includes('at least one'));

  // Staging: Move, Show, section, Add, Remove and Restore change nothing until Save.
  const v0 = saved().version, auditCount = () => rows("SELECT COUNT(*) c FROM audit_log WHERE action='homepage.update'")[0].c, audits0 = auditCount();
  let st = await stage(`up:${idx('cta')}`);
  check('Move up only stages: unsaved banner, status text, focus target, new order shown, nothing saved or audited', st.status === 200 && st.html.includes('Unsaved changes') && st.html.includes('Moved Submit a story to position 11 of 12.') && st.rows.at(-2).key === 'cta' && st.html.includes('data-focus="act-cta-up"') && saved().version === v0 && JSON.stringify(order(await home())) === JSON.stringify(DEFAULT_ORDER) && auditCount() === audits0);
  check('rows have ids to return to, and buttons keep their visible text first', st.html.includes('id="block-cta"') && st.html.includes('formaction="/admin/homepage#block-cta"') && />Move up<span class="sr-only"[^>]*> Submit a story<\/span>/.test(st.html));
  st = await stage('up:0');
  check('the first block cannot move up (400, layout still shown)', st.status === 400 && st.html.includes('cannot move further') && st.rows.length === 12);
  st = await stage('down:11');
  check('the last block cannot move down', st.status === 400);
  st = await stage('reset', { blocks: toggle(saved().blocks, ['hero'], false), version: saved().version });
  check('Restore default layout only stages the defaults too', st.status === 200 && st.html.includes('Unsaved changes') && st.rows.every((x) => x.visible) && saved().version === v0);
  st = await stage('save', { blocks: toggle(saved().blocks, ['hero'], false), version: saved().version - 1 });
  check('a stale Save re-shows the submitted layout with the conflict (409), never dropping it', st.status === 409 && st.html.includes('Someone else changed this layout') && st.html.includes('Unsaved changes') && st.rows.find((x) => x.key === 'hero').visible === false && saved().version === v0);
  st = await stage('save', { blocks: saved().blocks.map((b) => b.key === 'rail-kids' ? { ...b, section: 'youth' } : b), version: saved().version });
  check('two rails on one section are refused with the submitted layout still shown', st.status === 400 && st.html.includes('Each section can have only one rail.') && st.rows.filter((x) => x.section === 'youth').length === 2 && saved().version === v0);
  st = await stage('save', { blocks: toggle(saved().blocks, ['hero'], false), version: v0 });
  check('Save saves the staged layout (version, audit, page) and says so', st.status === 200 && saved().version === v0 + 1 && st.html.includes('Home page layout saved') && !st.html.includes('Unsaved changes') && !order(await home()).includes('hero') && auditCount() === audits0 + 1);
  st = await stage('save', { blocks: toggle(saved().blocks, ['hero'], true), version: saved().version });
  check('showing it again and saving restores the default page', st.status === 200 && JSON.stringify(order(await home())) === JSON.stringify(DEFAULT_ORDER));

  // Reorder (stage, then Save).
  r = await act(`up:${idx('cta')}`);
  check('Move up then Save swaps a block with the one before it (cta above archive)', r.status === 200 && JSON.stringify(order(await home())) === JSON.stringify([...DEFAULT_ORDER.slice(0, 10), 'cta', 'archive']));
  r = await act(`down:${idx('cta')}`);
  check('Move down then Save puts it back', r.status === 200 && JSON.stringify(order(await home())) === JSON.stringify(DEFAULT_ORDER));
  r = await act(`up:${idx('spotlight')}`);
  check('the event spotlight can move above the intro', r.status === 200 && JSON.stringify(order(await home())) === JSON.stringify(['spotlight', 'intro', ...DEFAULT_ORDER.slice(2)]));
  r = await post(saved().blocks.map((b) => ({ ...b, visible: b.key === 'spotlight' })), saved().version);
  html = await home();
  check('with only the spotlight showing the page has exactly one h1, placed before it', r.status === 200 && JSON.stringify(order(html)) === JSON.stringify(['spotlight']) && (html.match(/<h1/g) || []).length === 1 && html.indexOf('<h1') < html.indexOf('<section class="event-spotlight"'));
  st = await act('reset');
  check('Restore default then Save writes the defaults (version bumps) and the page matches the original', st.status === 200 && JSON.stringify(saved().blocks) === JSON.stringify(defaultBlocks()) && JSON.stringify(order(await home())) === JSON.stringify(DEFAULT_ORDER) && (await home()) === base);

  // Rails (one per section).
  const kids = railKeys()[2];
  let s = saved(); r = await post(s.blocks.map((b) => b.key === kids ? { ...b, section: 'news' } : b), s.version);
  html = await home();
  check('a rail can show another section (Kids rail switched to News)', r.status === 200 && order(html).filter((k) => k === 'rail:news').length === 1 && !order(html).includes('rail:kids') && html.includes('href="/news/">More News'));
  check('the News rail uses the same cards and the section blurb', /<section class="block" data-sec="news"><div class="block-head"><div><h2>News<\/h2><p>What’s happening/.test(html));
  s = saved(); r = await post(s.blocks.map((b) => b.key === kids ? { ...b, section: 'kids' } : b), s.version);
  check('switching back restores the original markup', (await home()) === base);
  s = saved(); r = await post(s.blocks.map((b) => b.key === railKeys()[0] ? { ...b, section: 'columns' } : b), s.version);
  check('the retired columns key is accepted as features', r.status === 200 && saved().blocks.find((b) => b.key === railKeys()[0]).section === 'features');
  const kidsPart = (await get('/admin/homepage', 'admin')).text.split('Section for the Kids rail')[1] || '';
  check('rails are named by their section and a rail\'s select disables sections other rails use', kidsPart.includes('<option value="youth"') && /<option value="youth"[^>]*disabled/.test(kidsPart) && /<option value="kids"[^>]*selected/.test(kidsPart) && !/<option value="kids"[^>]*disabled/.test(kidsPart));
  st = await stage('add');
  check('Add section rail stages a rail with an unused section (News) and focuses its select', st.status === 200 && st.rows.find((x) => x.section === 'news') && st.html.includes('Added a News rail.') && /data-focus="section-rail-/.test(st.html) && railKeys().length === 3);
  r = await act('add');
  check('Add then Save saves the new rail', r.status === 200 && railKeys().length === 4 && !!saved().blocks.find((b) => b.section === 'news'));
  st = await stage('add');
  check('with every section used, another rail cannot be added', st.status === 400 && st.html.includes('Every section already has a rail.') && st.rows.length === saved().blocks.length);
  check('the page disables Add when every section has a rail', /<button[^>]*value="add"[^>]*disabled/.test((await get('/admin/homepage', 'admin')).text) && railKeys().length <= RAIL_LIMIT);
  const extra = railKeys().filter((k) => !['rail-features', 'rail-youth', 'rail-kids'].includes(k));
  st = await stage(`remove:${idx(extra[0])}`);
  check('Remove stages the removal and moves focus to the status', st.status === 200 && st.rows.length === saved().blocks.length - 1 && st.html.includes('Removed the News rail.') && st.html.includes('data-focus="staged-status"') && railKeys().length === 4);
  r = await act(`remove:${idx(extra[0])}`);
  check('a rail can be removed (back to three)', r.status === 200 && railKeys().length === 3 && JSON.stringify(railKeys()) === JSON.stringify(['rail-features', 'rail-youth', 'rail-kids']));
  st = await stage(`remove:${idx('hero')}`);
  check('a fixed block cannot be removed', st.status === 400 && idx('hero') >= 0);
  await act('reset');
  const resave = async () => { const s2 = saved(); await post(s2.blocks, s2.version); }; // a real save clears the page cache after a direct database edit
  const kidDates = rows("SELECT id,date FROM stories WHERE section='kids'");
  run("UPDATE stories SET date=?, rev=rev+1 WHERE section='kids'", day(400)); await resave();
  check('a rail whose section has no recent stories is skipped and leaves no empty wrapper', !order(await home()).includes('rail:kids') && !/<div class="wrap magazine-home">\s*<\/div>/.test(await home()));
  for (const k of kidDates) run('UPDATE stories SET date=?, rev=rev+1 WHERE id=?', k.date, k.id); await resave();
  check('the rail returns when its section has recent stories again', order(await home()).includes('rail:kids'));

  // Validation, conflict, audit, no story writes.
  s = saved();
  r = await post(s.blocks.map((b) => b.key === 'rail-kids' ? { ...b, section: 'bogus' } : b), s.version);
  check('an invalid section key is refused and nothing changes', r.status === 400 && saved().version === s.version && (await r.text()).includes('valid section'));
  r = await post([...s.blocks, { key: 'mystery', visible: true }], s.version);
  check('an unknown block key is refused', r.status === 400 && saved().version === s.version);
  r = await post(s.blocks, s.version - 1);
  check('a stale version gets the conflict message (409) and changes nothing', r.status === 409 && (await r.text()).includes('Someone else changed this layout') && saved().version === s.version);
  r = await post(s.blocks, 'x');
  check('a malformed version is refused', r.status === 400 && saved().version === s.version);
  const audits = rows("SELECT detail,target,user_id FROM audit_log WHERE action='homepage.update'");
  check('every save writes a homepage.update audit entry with counts and the version only', audits.length === saved().version && audits.every((a) => a.target === 'site:homepage' && a.user_id === sessions.admin.id && Object.keys(JSON.parse(a.detail)).sort().join() === 'blocks,rails,version,visible' && !/synthetic|section/i.test(a.detail)));
  check('saving the layout never writes story rows', storyState() === storiesBefore);

  // Fallbacks: a damaged saved layout, then an unreadable table.
  // A second process has an empty page cache, so it renders from the database as it is now.
  const freshHome = async () => {
    const port = Number(PORT) + 1;
    const second = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: scratch, SITE_URL: BASE, AUTH_SECRET: 'synthetic-homepage-auth-' + 's'.repeat(40), AGENT_API_TOKEN: '', PUBLISH_TOKEN: '', RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: 'ignore' });
    try {
      for (let i = 0; i < 100; i++) { try { const res = await fetch(`http://localhost:${port}/`); return { status: res.status, text: await res.text() }; } catch { await delay(150); } }
      return { status: 0, text: '' };
    } finally { second.kill(); await Promise.race([new Promise((res) => second.once('exit', res)), delay(3000)]); }
  };
  run('UPDATE homepage_layout SET version=version+1, blocks=? WHERE id=1', JSON.stringify([{ key: 'cta', visible: true }, { key: 'zzz', visible: true }, { key: 'rail-x', visible: true, section: 'nope' }]));
  let fresh = await freshHome();
  check('a damaged saved layout drops bad entries and restores the missing fixed blocks in place', fresh.status === 200 && JSON.stringify(order(fresh.text)) === JSON.stringify(DEFAULT_ORDER.filter((k) => !k.startsWith('rail:'))));
  run('UPDATE homepage_layout SET blocks=? WHERE id=1', '{"not":"a list"}');
  fresh = await freshHome();
  check('a saved layout that is not a list shows the default layout', fresh.status === 200 && JSON.stringify(order(fresh.text)) === JSON.stringify(DEFAULT_ORDER));
  run('DELETE FROM homepage_layout');
  fresh = await freshHome();
  check('a layout-less database renders exactly the reference home page (the first rendering, from before any layout was saved)', fresh.status === 200 && fresh.text === base);
  run('DROP TABLE homepage_layout');
  fresh = await freshHome();
  check('a missing or unreadable layout table shows the default layout, not an error', fresh.status === 200 && JSON.stringify(order(fresh.text)) === JSON.stringify(DEFAULT_ORDER));

  // Screenshots.
  if (shots) {
    run('CREATE TABLE homepage_layout (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version>0), blocks TEXT NOT NULL CHECK(json_valid(blocks) AND length(blocks)<=30000), updated_at INTEGER NOT NULL) STRICT');
    const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('**/*', (route) => new URL(route.request().url()).origin === BASE ? route.continue() : route.abort());
    await ctx.addCookies([{ name: '__Host-imc_session', value: sessions.admin.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const p = await ctx.newPage();
    // The table was recreated empty: save once through the page (version 0 -> 1) with two blocks hidden.
    await post(toggle(defaultBlocks(), ['latest_issue', 'archive'], false), 0);
    for (const w of [390, 1280]) {
      await p.setViewportSize({ width: w, height: 900 });
      await p.goto(BASE + '/admin/homepage'); await p.screenshot({ path: path.join(shots, `admin-homepage-${w}.png`), fullPage: true });
      await p.goto(BASE + '/'); await p.waitForLoadState('networkidle'); await p.screenshot({ path: path.join(shots, `home-two-hidden-${w}.png`), fullPage: true });
      check(`home page with two blocks hidden has no horizontal scroll at ${w}px`, await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    }
    if (process.env.AXE_JS) {
      await p.goto(BASE + '/admin/homepage'); await p.addScriptTag({ path: process.env.AXE_JS });
      const scan = await p.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
      if (scan.violations.length) console.log(JSON.stringify(scan.violations.map((x) => ({ id: x.id, nodes: x.nodes.map((nd) => nd.failureSummary) }))));
      check('the layout page passes axe', scan.violations.length === 0);
    }
  }
  console.log(`\n${checks} homepage layout checks passed.`);
} catch (e) { console.log(logs.join('').slice(-2000)); throw e; } finally { await browser?.close(); if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); } db?.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
