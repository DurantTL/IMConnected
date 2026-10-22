// Multiple-section contract: synthetic local server, accounts and isolated SQLite only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
import { normalizeAdditionalSections } from '../src/lib/site.ts';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-sections-'));
const base = 'http://localhost:4881', agent = 'synthetic-sections-agent-' + 'a'.repeat(40), studio = 'synthetic-sections-studio-' + 's'.repeat(40);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let db, server, browser, checks = 0;
const check = (label, ok) => { assert.ok(ok, label); checks++; console.log('PASS ' + label); };
try {
  check('duplicates and the primary section normalize to canonical extra memberships', JSON.stringify(normalizeAdditionalSections(['youth', 'news', 'youth', 'kids'], 'news')) === '["youth","kids"]');
  for (const value of [null, 'youth', [7], ['unknown'], ['<script>'], new Array(21).fill('youth')]) { let refused = false; try { normalizeAdditionalSections(value, 'news'); } catch { refused = true; } check('invalid or unbounded additional memberships are refused', refused); }
  db = openDatabase(scratch); const migrations = readMigrationsFromDir(path.resolve('src/lib/db/migrations'));
  runMigrations(db, migrations.filter((m) => !m.name.startsWith('024_')));
  const run = (sql, ...args) => db.prepare(sql).run(...args), row = (sql, ...args) => db.prepare(sql).get(...args), rows = (sql, ...args) => db.prepare(sql).all(...args);
  run("INSERT INTO stories(slug,title,section,author,date,body,published_at,updated_at) VALUES('synthetic-legacy','Synthetic legacy','news','Synthetic Author','2026-10-22','Legacy body.',1,1)");
  run("INSERT INTO drafts(source,status,title,created_at,updated_at) VALUES('editor','in_review','Synthetic legacy',1,1)");
  runMigrations(db, migrations);
  check('upgrade preserves legacy stories and drafts with empty memberships', row("SELECT additional_sections FROM stories WHERE slug='synthetic-legacy'").additional_sections === '[]' && row("SELECT additional_sections FROM drafts WHERE title='Synthetic legacy'").additional_sections === '[]');
  const now = Date.now(), session = randomBytes(32).toString('base64url');
  run("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)", now);
  const user = Number(run("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES('synthetic-editor@example.invalid','Synthetic Editor','editor','active',?,?)", now, now).lastInsertRowid);
  run('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)', createHash('sha256').update(session).digest('hex'), user, now, now, now + 3600000);
  server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '4881', DATA_DIR: scratch, SITE_URL: base, AUTH_SECRET: 'synthetic-section-auth-' + 'x'.repeat(40), AGENT_API_TOKEN: agent, PUBLISH_TOKEN: studio, PUBLISH_ORIGINS: base, RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; server.stdout.on('data', (d) => logs.push(String(d))); server.stderr.on('data', (d) => logs.push(String(d)));
  let ready = false; for (let n = 0; n < 100; n++) { try { await fetch(base + '/admin/login'); ready = true; break; } catch { await delay(100); } } check('isolated built server starts', ready);
  const headers = { Origin: base, Cookie: `__Host-imc_session=${session}` };
  const json = async (endpoint, payload, token = agent) => { const response = await fetch(base + endpoint, { method: 'POST', headers: { Origin: base, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: response.status, data: await response.json() }; };
  const admin = async (endpoint, data) => { const response = await fetch(base + endpoint, { method: 'POST', redirect: 'manual', headers, body: data }); return { status: response.status, response, text: await response.text() }; };
  const fields = (draft, additional = undefined) => {
    const f = new FormData(); for (const [key, value] of Object.entries({ version: draft.updated_at, title: draft.title, dek: draft.dek, section: draft.section, area: draft.area, author: draft.author, authorTitle: draft.author_title, church: draft.church, date: draft.date, photoCredit: draft.photo_credit, body: draft.body })) f.set(key, String(value ?? ''));
    if (additional !== undefined) { f.set('additionalSectionsPresent', '1'); additional.forEach((key) => f.append('additionalSections', key)); } return f;
  };
  const source = { title: 'Synthetic camp membership', section: 'news', area: 'camp', author: 'Synthetic Author', body: 'Synthetic camp membership provides an invitation and report for readers.', sourceUrl: 'https://example.invalid/synthetic-camp' };
  let out = await json('/api/agent/stories', { ...source, additionalSections: ['news', 'youth', 'youth'] }); const id = out.data.id;
  const draft = () => row('SELECT * FROM drafts WHERE id=?', id);
  check('agent creates a private News/Camp draft also assigned to Youth', out.status === 201 && draft().additional_sections === '["youth"]' && draft().section === 'news' && draft().area === 'camp' && !row('SELECT 1 FROM stories WHERE draft_id=?', id));
  out = await json('/api/agent/stories', { ...source, body: source.body + ' Legacy update.' }); check('older agent updates preserve omitted memberships', out.status === 201 && draft().additional_sections === '["youth"]');
  out = await json('/api/agent/stories', { ...source, additionalSections: [] }); check('explicit empty agent list clears memberships', out.status === 201 && draft().additional_sections === '[]');
  await json('/api/agent/stories', { ...source, additionalSections: ['youth'] });
  for (const additionalSections of [null, ['unknown'], 'youth']) { const before = JSON.stringify(draft()); out = await json('/api/agent/stories', { ...source, additionalSections }); check('invalid agent sections fail atomically', out.status === 400 && out.data.error === 'bad_additional_sections' && JSON.stringify(draft()) === before); }
  let response = await fetch(base + '/admin?section=youth&status=all', { headers }); check('editor section filter matches additional memberships', response.status === 200 && (await response.text()).includes(source.title));
  response = await fetch(base + '/api/stories?section=youth', { headers: { Authorization: 'Bearer ' + studio, Origin: base } }); let listing = await response.json(); check('Studio draft discovery includes additional memberships and field', listing.drafts.find((d) => d.id === id)?.additionalSections.join() === 'youth');
  let saved = await admin(`/api/admin/drafts/${id}/save`, fields(draft())); check('legacy editor form omission preserves existing memberships', saved.status === 200 && draft().additional_sections === '["youth"]');
  saved = await admin(`/api/admin/drafts/${id}/save`, fields(draft(), ['kids'])); check('new editor form changes memberships without publishing', saved.status === 200 && draft().additional_sections === '["kids"]' && !row('SELECT 1 FROM stories WHERE draft_id=?', id));
  const revision = row("SELECT id FROM draft_revisions WHERE draft_id=? AND json_extract(payload,'$.fields.additionalSections[0]')='youth' ORDER BY id DESC", id);
  const restore = new FormData(); restore.set('version', String(draft().updated_at)); restore.set('revisionId', String(revision.id));
  const restored = await admin(`/api/admin/drafts/${id}/revisions`, restore); check('revision restore restores prior memberships', restored.status === 200 && draft().additional_sections === '["youth"]');
  const publish = new FormData(); publish.set('version', String(draft().updated_at)); const published = await admin(`/api/admin/drafts/${id}/publish`, publish);
  const live = () => row('SELECT * FROM stories WHERE draft_id=?', id);
  check('synthetic human publication writes memberships with primary area intact', published.status === 303 && published.response.headers.get('location').includes('n=published') && live()?.additional_sections === '["youth"]' && live().area === 'camp');
  for (const endpoint of ['/news/', '/news/camp/', '/youth/']) { response = await fetch(base + endpoint); const text = await response.text(); check('published story is discoverable at ' + endpoint, response.status === 200 && text.includes(source.title)); }
  response = await fetch(base + '/youth/pathfinders/'); check('additional membership does not borrow the primary area', !(await response.text()).includes(source.title));
  response = await fetch(base + '/stories/' + live().slug + '/'); const html = await response.text(); check('story canonical URL and both section links are retained', response.status === 200 && html.includes('/news/') && html.includes('/youth/') && html.includes('/stories/' + live().slug + '/'));
  const feed = await (await fetch(base + '/stories.json')).json(); const item = feed.stories.find((s) => s.id === live().slug); check('version1 feed adds memberships without duplicate entries', feed.version === 1 && item.additionalSections.join() === 'youth' && feed.stories.filter((s) => s.id === live().slug).length === 1);
  const rss = await (await fetch(base + '/rss.xml')).text(); check('RSS adds an additional section category', rss.includes('<category>Youth &amp; Pathfinders</category>'));
  let search; for (let n = 0; n < 30; n++) { search = await (await fetch(base + '/api/search?q=membership&section=youth')).json(); if (search.ok) break; await delay(100); } check('search section filters find cross-section stories exactly once', search.ok && search.results.filter((s) => s.slug === live().slug).length === 1);
  listing = await (await fetch(base + '/api/stories?section=youth', { headers: { Authorization: 'Bearer ' + studio, Origin: base } })).json(); check('Studio published discovery matches additional membership', listing.stories.find((s) => s.id === live().slug)?.additionalSections.join() === 'youth');
  const beforeReopen = JSON.stringify(live()); out = await json('/api/agent/stories/reopen', { slug: live().slug, requestId: 'synthetic-membership-reopen' }); check('agent reopen preserves omitted memberships and never updates live content', out.status === 201 && draft().additional_sections === '["youth"]' && JSON.stringify(live()) === beforeReopen);
  const again = new FormData(); again.set('version', String(draft().updated_at)); await admin(`/api/admin/drafts/${id}/publish`, again);
  out = await json('/api/agent/stories/reopen', { slug: live().slug, requestId: 'synthetic-membership-clear', changes: { additionalSections: [] } }); check('explicit reopen change clears extras only in review draft', out.status === 201 && draft().additional_sections === '[]' && live().additional_sections === '["youth"]');

  const studioStory = { ref: 'synthetic-studio', title: 'Synthetic Studio sections', section: 'news', area: 'camp', author: 'Synthetic Author', body: 'Synthetic Studio story body.' };
  const studioPayload = (extra) => ({ newsletter: { issueDate: '2026-10-22', name: 'Synthetic' }, stories: [{ ...studioStory, ...extra }] });
  out = await json('/api/publish', studioPayload({ additionalSections: ['youth'] }), studio); const studioRow = () => row('SELECT * FROM stories WHERE title=?', studioStory.title);
  check('Studio publish accepts additional memberships', out.status === 200 && studioRow().additional_sections === '["youth"]');
  out = await json('/api/publish', studioPayload({}), studio); check('older Studio republishes preserve omitted memberships on story and linked draft', out.status === 200 && studioRow().additional_sections === '["youth"]' && row('SELECT additional_sections FROM drafts WHERE slug=?', studioRow().slug).additional_sections === '["youth"]');
  const beforeInvalid = JSON.stringify(studioRow()); out = await json('/api/publish', studioPayload({ additionalSections: ['unknown'] }), studio); check('invalid Studio assignments fail without changing the published story', out.status === 400 && JSON.stringify(studioRow()) === beforeInvalid);
  out = await json('/api/publish', studioPayload({ additionalSections: [] }), studio); check('explicit empty Studio assignments clear memberships', out.status === 200 && studioRow().additional_sections === '[]');

  const archive = path.join(scratch, 'archive'); fs.mkdirSync(archive); const file = path.join(archive, 'synthetic-section-import.md');
  const markdown = (extra) => `---\ntitle: Synthetic section import\nsection: news\narea: camp\nauthor: Synthetic Author\ndate: 2026-10-22\n${extra}---\nSynthetic imported story.\n`;
  const imp = () => spawnSync(process.execPath, ['scripts/import-git-stories.mjs', '--dir', archive, '--public', archive, '--apply'], { env: { ...process.env, DATA_DIR: scratch }, encoding: 'utf8' });
  fs.writeFileSync(file, markdown('additionalSections: [youth]\n')); let imported = imp(); const importedRow = () => row("SELECT * FROM stories WHERE slug='synthetic-section-import'"); check('standalone importer accepts additional section metadata', imported.status === 0 && importedRow().additional_sections === '["youth"]');
  fs.writeFileSync(file, markdown('')); imported = imp(); check('legacy archive omission preserves imported extra memberships', imported.status === 0 && importedRow().additional_sections === '["youth"]');
  fs.writeFileSync(file, markdown('additionalSections: []\n')); imported = imp(); check('explicit empty archive list clears extra memberships', imported.status === 0 && importedRow().additional_sections === '[]');
  fs.writeFileSync(file, markdown('additionalSections: [unknown]\n')); imported = imp(); check('invalid archive list fails atomically', imported.status === 1 && importedRow().additional_sections === '[]');
  const capabilities = await (await fetch(base + '/api/agent/sections', { headers: { Authorization: 'Bearer ' + agent } })).json(); check('agent capability discovery documents additional assignments', capabilities.additionalSections.values.includes('youth') && capabilities.additionalSections.field === 'additionalSections');

  if (process.env.PLAYWRIGHT_ROOT) {
    const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json')), { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await context.route('**/*', (r) => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
    await context.addCookies([{ name: '__Host-imc_session', value: session, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]); const page = await context.newPage();
    await page.goto(base + '/admin/drafts/' + id); await page.locator('[data-studio-tab=settings]').click();
    const news = page.locator('input[name=additionalSections][value=news]'), youth = page.locator('input[name=additionalSections][value=youth]');
    check('primary section is visibly selected and cannot be unchecked independently', await news.isChecked() && await news.isDisabled());
    await youth.check(); await page.locator('#f-section').selectOption('youth');
    check('changing the primary section updates the disabled selection and keeps former primary as an extra', await youth.isChecked() && await youth.isDisabled() && await news.isChecked() && !await news.isDisabled());
    await page.locator('#f-section').selectOption('news'); await page.locator('#f-area').selectOption('camp');
    await Promise.all([page.waitForResponse((response) => response.url().endsWith(`/api/admin/drafts/${id}/save`) && response.status() === 200), page.getByRole('button', { name: 'Save changes', exact: true }).click()]);
    check('browser checkbox save persists both section assignments', draft().additional_sections === '["youth"]' && draft().section === 'news' && draft().area === 'camp');
    if (process.env.AXE_JS) { await page.addScriptTag({ path: process.env.AXE_JS }); const result = await page.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })); check('multi-section settings pass axe A/AA', result.violations.length === 0); }
    await page.setViewportSize({ width: 390, height: 844 }); check('multi-section controls fit a phone viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  console.log(`\n${checks} additional section checks passed.`);
} finally { await browser?.close(); if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); } db?.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
