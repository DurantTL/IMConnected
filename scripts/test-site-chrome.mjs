// Header and footer editor (issue #156). Built-server + browser integration. Synthetic content, disposable SQLite,
// no external requests. Run after `npm run build`; PORT picks the port (default 4871); SHOTS=<folder> saves screenshots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
const { chromium } = require('playwright');
const ROOT = process.cwd(), PORT = process.env.PORT || '4871', BASE = `http://localhost:${PORT}`, scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-chrome-'));
const shots = process.env.SHOTS || ''; if (shots) fs.mkdirSync(shots, { recursive: true });
let db, server, browser, checks = 0; const logs = [];
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log('PASS ' + name); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (html) => html.replace(/ data-chrome[a-z-]*="[^"]*"/g, '');
const part = (html, tag) => strip(html.match(new RegExp(`<${tag}[ >][\\s\\S]*?</${tag}>`))?.[0] ?? '');
// Today's header and footer markup, as it was fixed in code before issue #156 (data-chrome hooks stripped).
const TODAY_HEADER = [
  '<div class="publication-line"><div class="wrap"><span>Faith in action. Close to home.</span><a href="https://imsda.org">Iowa-Missouri Conference <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M7 7h10v10"></path></svg></a></div></div>',
  '<p class="masthead-note">The stories.<br>The people.<br><strong>Our community.</strong></p>',
  '<a class="btn accent header-submit" href="/submit/">Submit a Story</a>',
  '<div class="conference-strip"><div class="wrap"><p><span aria-hidden="true">Iowa-Missouri Conference</span><span class="sr-only">Iowa-Missouri Conference of Seventh-day Adventists</span></p></div></div>',
  '</nav><span class="masthead-edition">Iowa + Missouri</span></div>',
  '<a href="/search/">Search</a><a class="btn accent" href="/submit/">Submit a Story</a>',
];
const TODAY_FOOTER = [
  '<div class="footer-statement"><p>Connected by community.<br><em>Inspired by faith.</em></p><a class="btn" href="/submit/">Share your story <span aria-hidden="true">↗</span></a></div>',
  '<p class="footer-intro">Stories of faith in action across Iowa and Missouri. A publication of the <a href="https://imsda.org">Iowa-Missouri Conference of Seventh-day Adventists</a>.</p>',
  '<h2>Sections</h2>',
  '<h2>Get involved</h2><ul><li><a href="/submit/">Submit a story</a></li><li><a href="/search/">Search stories</a></li><li><a href="mailto:communication@imsda.org">communication@imsda.org</a></li><li><a href="https://imsda.org">imsda.org</a></li></ul>',
  `<p class="fine">© ${new Date().getFullYear()} Iowa-Missouri Conference of Seventh-day Adventists. All rights reserved.</p><a class="footer-editor" href="/admin">Editor sign in <span aria-hidden="true">→</span></a>`,
];
const DEFAULTS = {
  h_showTopLine: true, h_topLineText: 'Faith in action. Close to home.', h_topLineLinkLabel: 'Iowa-Missouri Conference', h_topLineLinkUrl: 'https://imsda.org',
  h_showMastheadNote: true, h_note0: 'The stories.', h_note1: 'The people.', h_note2: 'Our community.',
  h_showStrip: true, h_stripText: 'Iowa-Missouri Conference', h_edition: 'Iowa + Missouri', h_showSearch: true, h_showSubmit: true, h_submitLabel: 'Submit a Story',
  f_statementLine1: 'Connected by community.', f_statementLine2: 'Inspired by faith.', f_showStatementButton: true, f_statementButtonLabel: 'Share your story', f_statementButtonUrl: '/submit/',
  f_intro: 'Stories of faith in action across Iowa and Missouri. A publication of the Iowa-Missouri Conference of Seventh-day Adventists.',
  f_showSections: true, f_sectionsHeading: 'Sections', f_involvedHeading: 'Get involved', f_contactEmail: 'communication@imsda.org', f_contactAfter: 2,
  f_copyright: 'Iowa-Missouri Conference of Seventh-day Adventists', f_showEditorLink: true,
};
const DEFAULT_LINKS = [['Submit a story', '/submit/'], ['Search stories', '/search/'], ['imsda.org', 'https://imsda.org']];
try {
  db = openDatabase(scratch); runMigrations(db, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  db.prepare('INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)').run('git_adopted_at', String(Date.now()), Date.now());
  const row = (sql, ...v) => db.prepare(sql).get(...v), rows = (sql, ...v) => db.prepare(sql).all(...v), run = (sql, ...v) => db.prepare(sql).run(...v);
  const now = Date.now(), sessions = {};
  for (const role of ['admin', 'editor']) { const id = Number(run("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)", `${role}@synthetic.invalid`, `Synthetic ${role}`, role, now, now).lastInsertRowid), token = randomBytes(32).toString('base64url'); run('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)', createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600000); sessions[role] = { id, token }; }
  run("INSERT INTO stories(slug,title,dek,section,area,author,date,body,status,source,published_at,updated_at,draft) VALUES('synthetic-chrome-story','Synthetic chrome story','A synthetic dek.','news','conference','Synthetic Editor','2026-10-01','Synthetic body text.','live','editor',?,?,0)", now, now);
  const storiesBefore = JSON.stringify(rows('SELECT * FROM stories ORDER BY id'));
  check('migration 038 is applied and site_chrome is empty', row("SELECT name FROM schema_migrations WHERE name='038_site_chrome.sql'") && row('SELECT COUNT(*) AS n FROM site_chrome').n === 0);
  if (await fetch(BASE + '/admin/login').then(() => true, () => false)) throw new Error(`Port ${PORT} is already in use; set PORT to a free port.`);
  server = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT, DATA_DIR: scratch, SITE_URL: BASE, AUTH_SECRET: 'synthetic-chrome-auth-' + 's'.repeat(40), AGENT_API_TOKEN: 'synthetic-chrome-agent-' + 'a'.repeat(40), PUBLISH_TOKEN: '', RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => logs.push(String(d))); server.stderr.on('data', (d) => logs.push(String(d)));
  let ready = false; for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/admin/login'); ready = true; break; } catch { await delay(100); } }
  check('isolated built server starts', ready);
  const headers = (role = 'admin') => ({ Origin: BASE, Cookie: `__Host-imc_session=${sessions[role].token}` });
  const get = async (url, role) => { const res = await fetch(BASE + url, { redirect: 'manual', headers: role ? headers(role) : {} }); return { status: res.status, text: await res.text() }; };
  const api = async () => (await fetch(BASE + '/api/navigation')).json();
  const formOf = (over = {}, links = DEFAULT_LINKS, version = 0, action = 'save') => {
    const f = new FormData(); f.set('version', String(version)); f.set('action', action);
    const v = { ...DEFAULTS, ...over };
    for (const [k, val] of Object.entries(v)) { if (val === true) f.set(k, 'on'); else if (val !== false) f.set(k, String(val)); }
    for (let i = 0; i < 8; i++) { const l = links[i] ?? ['', '']; f.set(`label.${i}`, l[0]); f.set(`href.${i}`, l[1]); f.set(`order.${i}`, String(i + 1)); }
    return f;
  };
  const save = (over, o = {}) => fetch(BASE + '/admin/header-footer', { method: 'POST', redirect: 'manual', headers: o.noOrigin ? { Cookie: headers().Cookie } : headers(o.role), body: formOf(over, o.links, o.version ?? 0, o.action) });
  const version = () => api().then((j) => j.chrome.version);

  // 1. Defaults reproduce today's markup, on a server page and on a prerendered page.
  for (const url of ['/', '/submit/']) {
    const page = (await get(url)).text, header = part(page, 'header'), footer = part(page, 'footer');
    check(`defaults: ${url} header matches today's markup`, TODAY_HEADER.every((s) => header.includes(s)));
    check(`defaults: ${url} footer matches today's markup`, TODAY_FOOTER.every((s) => footer.includes(s)));
  }
  const initial = await api();
  check('GET /api/navigation carries an additive versioned chrome object with defaults and still the old fields', initial.chrome.version === 0 && initial.version === 0 && Array.isArray(initial.items) && initial.chrome.header.topLine.text === 'Faith in action. Close to home.' && initial.chrome.footer.involved.links.length === 4 && initial.chrome.footer.involved.links[2].url === 'mailto:communication@imsda.org');

  // 2. Access.
  check('anonymous users cannot open the page', (await get('/admin/header-footer')).status === 302);
  check('editors cannot read the page', (await get('/admin/header-footer', 'editor')).status === 403);
  check('editors cannot change the header and footer', (await save({ h_submitLabel: 'Editor try' }, { role: 'editor' })).status === 403 && await version() === 0);
  check('same-origin POST is required', (await save({ h_submitLabel: 'No origin' }, { noOrigin: true })).status === 403 && await version() === 0);
  const adminPage = await get('/admin/header-footer', 'admin');
  check('administrators see the form with a version field, both sections and Restore defaults', adminPage.status === 200 && adminPage.text.includes('name="version"') && adminPage.text.includes('Header</legend>') && adminPage.text.includes('Footer</legend>') && adminPage.text.includes('Restore defaults') && adminPage.text.includes('Move link 1 down'));
  check('the sidebar links the page for administrators only', adminPage.text.includes('href="/admin/header-footer"') && !(await get('/admin', 'editor')).text.includes('/admin/header-footer'));

  // 3. Refused values.
  for (const [name, over] of [
    ['javascript: top line link', { h_topLineLinkUrl: 'javascript:alert(1)' }],
    ['protocol-relative top line link', { h_topLineLinkUrl: '//evil.invalid' }],
    ['http: top line link', { h_topLineLinkUrl: 'http://example.invalid/' }],
    ['mailto: in a statement button', { f_statementButtonUrl: 'mailto:someone@example.invalid' }],
    ['admin path in a statement button', { f_statementButtonUrl: '/admin' }],
    ['not an email address', { f_contactEmail: 'not an email' }],
    ['email with a query character', { f_contactEmail: 'a?subject=x@example.invalid' }],
    ['email with a percent sign', { f_contactEmail: 'a%40b@example.invalid' }],
    ['email without a dotted domain', { f_contactEmail: 'someone@example' }],
    ['mailto: scheme typed as the contact email', { f_contactEmail: 'mailto:a@example.invalid' }],
    ['top line text too long', { h_topLineText: 'x'.repeat(81) }],
    ['newline in a line', { h_note0: 'one\ntwo' }],
    ['empty submit label', { h_submitLabel: '   ' }],
  ]) check('refused: ' + name, (await save(over)).status === 400 && await version() === 0);
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'http://example.invalid/', '//evil.invalid', '/%61dmin']) check('refused Get involved link address: ' + url, (await save({}, { links: [['Bad', url]] })).status === 400 && await version() === 0);
  check('eight Get involved links plus the contact email are accepted (nine entries)', (await save({}, { links: Array.from({ length: 8 }, (_, i) => [`L${i}`, `/l${i}/`]) })).status === 200 && (await api()).chrome.footer.involved.links.length === 9);
  check('chrome version 1 after a valid save', await version() === 1);

  // 4. A real change shows on a server page and in the API.
  const before = (await get('/')).text; // primes the page cache
  const changed = { h_topLineText: 'Top <script>alert(1)</script> line', h_topLineLinkLabel: 'Home & Away', h_topLineLinkUrl: 'https://example.invalid/home', h_note0: 'Line <b>one</b>', h_stripText: 'Strip <i>text</i>', h_edition: 'Edition "Q" & more', h_submitLabel: 'Send <it>', f_statementLine1: 'Statement <one>', f_statementLine2: 'Statement two', f_statementButtonLabel: 'Tell us', f_statementButtonUrl: '/announcements/', f_intro: 'Plain <intro> sentence.', f_sectionsHeading: 'Topics', f_involvedHeading: 'Help out', f_contactEmail: 'hello@example.invalid', f_contactAfter: 1, f_copyright: 'Synthetic <Holder>' };
  const links = [['Give <now>', '/give/'], ['Calendar', 'https://example.invalid/cal'], ['Volunteer', '/volunteer/']];
  const saved = await fetch(BASE + '/admin/header-footer', { method: 'POST', redirect: 'manual', headers: headers(), body: formOf(changed, links, 1) });
  check('administrator saves text, links and the contact email', saved.status === 200 && await version() === 2);
  const after = (await get('/')).text, ah = part(after, 'header'), af = part(after, 'footer');
  check('the cached page was invalidated and shows the new text', before !== after && ah.includes('Home &amp; Away') && af.includes('Topics'));
  check('script-like text renders as escaped text (header)', ah.includes('Top &lt;script&gt;alert(1)&lt;/script&gt; line') && !ah.includes('<script>alert') && ah.includes('Line &lt;b&gt;one&lt;/b&gt;') && ah.includes('Strip &lt;i&gt;text&lt;/i&gt;') && ah.includes('Send &lt;it&gt;') && ah.includes('Edition &quot;Q&quot; &amp; more'));
  check('script-like text renders as escaped text (footer)', af.includes('Statement &lt;one&gt;') && af.includes('Plain &lt;intro&gt; sentence.') && af.includes('Synthetic &lt;Holder&gt;') && af.includes('Give &lt;now&gt;'));
  const stripBlock = ah.match(/<div class="conference-strip">[\s\S]*?<\/p>/)?.[0] ?? '';
  check('a changed conference strip is ordinary visible text (no aria-hidden, no sr-only copy)', stripBlock.includes('<span>Strip &lt;i&gt;text&lt;/i&gt;</span>') && !/aria-hidden|sr-only/.test(stripBlock));
  check('links and the contact email keep the chosen order', af.includes('<li><a href="/give/">Give &lt;now&gt;</a></li><li><a href="mailto:hello@example.invalid">hello@example.invalid</a></li><li><a href="https://example.invalid/cal">Calendar</a></li><li><a href="/volunteer/">Volunteer</a></li>') && ah.includes('href="https://example.invalid/home"') && af.includes('href="/announcements/"'));
  const pub = await api();
  check('the API chrome carries the new visible values', pub.chrome.version === 2 && pub.chrome.header.submit === 'Send <it>' && pub.chrome.footer.involved.links.length === 4 && pub.version === 0);
  const auditRows = rows("SELECT user_id,detail FROM audit_log WHERE action='site_chrome.update' ORDER BY id");
  check('the audit entry holds the version and changed field names only', auditRows.length === 2 && auditRows.every((r) => r.user_id === sessions.admin.id) && JSON.parse(auditRows[1].detail).version === 2 && JSON.parse(auditRows[1].detail).fields.includes('header.topLineText') && JSON.parse(auditRows[1].detail).fields.includes('footer.involvedLinks') && !auditRows[1].detail.includes('script') && !auditRows[1].detail.includes('example.invalid'));
  check('a stale version is a conflict and changes nothing', (await save({ h_submitLabel: 'Stale' }, { version: 1 })).status === 409 && await version() === 2 && (await api()).chrome.header.submit === 'Send <it>');
  const race = await Promise.all([save({ h_submitLabel: 'Race A' }, { version: 2 }), save({ h_submitLabel: 'Race B' }, { version: 2 })]);
  check('concurrent saves accept one version only', race.map((r) => r.status).sort().join() === '200,409' && await version() === 3);

  // 5. Hide things: no empty wrappers.
  const hide = { h_showTopLine: false, h_showMastheadNote: false, h_showStrip: false, h_edition: '', h_showSearch: false, h_showSubmit: false, f_showStatementButton: false, f_intro: '', f_showSections: false, f_showEditorLink: false, f_contactEmail: '' };
  check('administrator hides parts', (await save(hide, { version: 3, links: [] })).status === 200 && await version() === 4);
  const hid = (await get('/')).text, hh = part(hid, 'header'), hf = part(hid, 'footer');
  check('hidden header parts leave nothing behind', !hh.includes('publication-line') && !hh.includes('masthead-note') && !hh.includes('conference-strip') && !hh.includes('masthead-edition') && !hh.includes('header-search') && !hh.includes('header-submit') && !hh.includes('href="/search/"') && !hh.includes('href="/submit/"') && hh.includes('menu-toggle') && hh.includes('class="brand"'));
  check('hidden footer parts leave nothing behind (an empty Get involved column goes too)', !hf.includes('footer-intro') && !hf.includes('Topics') && !hf.includes('footer-editor') && !hf.includes('href="/admin"') && !hf.includes('Help out') && !/<a class="btn"/.test(hf) && hf.includes('footer-statement') && hf.includes('footer-bottom') && hf.includes('class="brand"'));
  check('the API drops hidden values', (await api()).chrome.header.topLine === null && (await api()).chrome.footer.involved === null && (await api()).chrome.footer.statement.button === null && (await api()).chrome.footer.editor === false);

  // 6. Restore defaults.
  const staged = await save({}, { version: 4, action: 'reset' }), stagedHtml = await staged.text();
  check('Restore defaults only stages the defaults in the form (nothing saved until Save)', staged.status === 200 && stagedHtml.includes('Unsaved') && stagedHtml.includes('value="Faith in action. Close to home."') && await version() === 4 && (await get('/')).text.includes('Help out') === false);
  check('saving the staged defaults restores the default configuration', (await save({}, { version: 4 })).status === 200 && await version() === 5);
  const auditCount = () => row("SELECT COUNT(*) AS n FROM audit_log WHERE action='site_chrome.update'").n, n0 = auditCount();
  const same = await save({}, { version: 5 });
  check('a save with no change neither bumps the version nor writes an audit entry', same.status === 200 && (await same.text()).includes('No changes to save') && await version() === 5 && auditCount() === n0);
  const restored = (await get('/')).text;
  check('restored pages match today\'s markup again', TODAY_HEADER.every((s) => part(restored, 'header').includes(s)) && TODAY_FOOTER.every((s) => part(restored, 'footer').includes(s)));

  // 7. The prerendered page refreshes from the API (browser).
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === BASE ? route.continue() : route.abort());
  await context.addCookies([{ name: '__Host-imc_session', value: sessions.admin.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.setDefaultTimeout(12000);
  check('prerendered /submit/ is served the defaults before any refresh', (await get('/submit/')).text.includes('Faith in action. Close to home.'));
  check('(setup) save the changed text, links and visibility again', (await save(changed, { version: 5, links })).status === 200 && await version() === 6);
  await page.goto(BASE + '/submit/');
  await page.waitForFunction(() => document.querySelector('.site-footer h2')?.textContent === 'Topics');
  const dom = await page.evaluate(() => ({
    top: document.querySelector('.publication-line span')?.textContent, topLink: document.querySelector('.publication-line a')?.getAttribute('href'), topLabel: document.querySelector('.publication-line a')?.textContent.trim(),
    note: document.querySelector('.masthead-note')?.textContent, noteTag: !!document.querySelector('.masthead-note b'), strip: document.querySelector('.conference-strip p')?.textContent, stripPlain: !document.querySelector('.conference-strip [aria-hidden], .conference-strip .sr-only'), edition: document.querySelector('.masthead-edition')?.textContent,
    submit: document.querySelector('.header-submit')?.textContent, mobileSubmit: document.querySelector('#mobile-nav .btn')?.textContent,
    statement: document.querySelector('.footer-statement p')?.textContent, button: document.querySelector('.footer-statement .btn')?.textContent, buttonHref: document.querySelector('.footer-statement .btn')?.getAttribute('href'),
    intro: document.querySelector('.footer-intro')?.textContent, introTag: !!document.querySelector('.footer-intro intro'), headings: Array.from(document.querySelectorAll('.site-footer h2')).map((h) => h.textContent),
    links: Array.from(document.querySelectorAll('.site-footer [data-chrome-list] a')).map((a) => a.getAttribute('href') + '|' + a.textContent), copyright: document.querySelector('.footer-bottom .fine')?.textContent, injected: document.querySelectorAll('.site-header script, .site-footer script, .site-footer b, .site-header i').length,
  }));
  check('API refresh updates header text, link and visibility on a prerendered page via textContent', dom.top === 'Top <script>alert(1)</script> line' && dom.topLink === 'https://example.invalid/home' && dom.topLabel === 'Home & Away' && dom.note === 'Line <b>one</b>The people.Our community.' && !dom.noteTag && dom.strip === 'Strip <i>text</i>' && dom.stripPlain && dom.edition === 'Edition "Q" & more' && dom.submit === 'Send <it>' && dom.mobileSubmit === 'Send <it>');
  check('API refresh updates footer statement, intro, headings, links and copyright', dom.statement === 'Statement <one>Statement two' && dom.button.trim() === 'Tell us ↗' && dom.buttonHref === '/announcements/' && dom.intro === 'Plain <intro> sentence.' && !dom.introTag && dom.headings.join() === 'Topics,Help out' && dom.links.join() === '/give/|Give <now>,mailto:hello@example.invalid|hello@example.invalid,https://example.invalid/cal|Calendar,/volunteer/|Volunteer' && dom.copyright === `© ${new Date().getFullYear()} Synthetic <Holder>. All rights reserved.` && dom.injected === 0);
  if (shots) { await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: path.join(shots, 'changed-submit-1280.png'), fullPage: true }); }
  check('(setup) hide parts again', (await save(hide, { version: 6, links: [] })).status === 200 && await version() === 7);
  await page.goto(BASE + '/search/');
  await page.waitForFunction(() => !document.querySelector('.publication-line') && !document.querySelector('.footer-editor'));
  check('API refresh removes hidden parts from a prerendered page without empty wrappers', await page.evaluate(() => !document.querySelector('.masthead-note, .conference-strip, .masthead-edition, .header-search, .header-submit, .footer-intro, .footer-statement .btn, [data-chrome="sections"], [data-chrome="involved"], .footer-editor, #mobile-nav [data-chrome]')));
  const rendered = await get('/search/');
  check('/search/ prerendered HTML is still the defaults (the build never reads the database)', rendered.text.includes('Faith in action. Close to home.') && rendered.text.includes('Editor sign in'));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(BASE + '/submit/'); await page.waitForFunction(() => !document.querySelector('.footer-editor'));
  check('no horizontal scroll at 390px on a changed page', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (shots) await page.screenshot({ path: path.join(shots, 'hidden-submit-390.png'), fullPage: true });
  check('(setup) restore defaults', (await save({}, { version: 7 })).status === 200 && await version() === 8);

  // 7b. Layout when parts are hidden (1280px).
  await page.setViewportSize({ width: 1280, height: 900 });
  check('(setup) hide only the masthead note', (await save({ h_showMastheadNote: false }, { version: await version() })).status === 200);
  await page.goto(BASE + '/');
  const geo = await page.evaluate(() => { const b = document.querySelector('.site-header .brand').getBoundingClientRect(), a = document.querySelector('.masthead-actions').getBoundingClientRect(); return { mid: b.left + b.width / 2, w: innerWidth, brandRight: b.right, actionsLeft: a.left, actionsRight: a.right }; });
  check('with the masthead note hidden the logo stays centred and the actions stay on the right', Math.abs(geo.mid - geo.w / 2) < 6 && geo.actionsLeft >= geo.brandRight - 1 && geo.actionsRight > geo.w - 60);
  if (shots) await page.screenshot({ path: path.join(shots, 'note-hidden-1280.png'), clip: { x: 0, y: 0, width: 1280, height: 260 } });
  check('(setup) hide only the Sections column', (await save({ f_showSections: false }, { version: await version() })).status === 200);
  await page.goto(BASE + '/');
  const cols = await page.evaluate(() => ({ tracks: getComputedStyle(document.querySelector('.site-footer .cols')).gridTemplateColumns.split(' ').length, kids: document.querySelector('.site-footer .cols').children.length }));
  check('with the Sections column hidden the footer grid has no empty column', cols.kids === 2 && cols.tracks === 2);
  if (shots) { await page.locator('.site-footer').scrollIntoViewIfNeeded(); await page.locator('.site-footer').screenshot({ path: path.join(shots, 'sections-hidden-1280.png') }); }
  check('(setup) restore defaults again', (await save({}, { version: await version() })).status === 200);
  // The client never trusts a mailto: outside the contact email entry.
  await context.route('**/api/navigation', async (route) => { const res = await route.fetch(), j = await res.json(); j.chrome.footer.involved.links = [{ label: 'Bad', url: 'mailto:a@example.invalid' }]; await route.fulfill({ response: res, json: j }); });
  await page.goto(BASE + '/submit/'); await delay(800);
  check('a mailto: link that is not the contact entry is ignored by the client refresh', await page.locator('.site-footer [data-chrome-list] a').count() === 4 && !(await page.locator('.site-footer [data-chrome-list]').innerText()).includes('Bad'));
  await context.unroute('**/api/navigation');
  // A stored row that no longer validates: public pages show the defaults and the admin can always restore.
  const putRow = (cfg, version = 50) => run('INSERT INTO site_chrome(id,version,config,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,config=excluded.config,updated_at=excluded.updated_at', version, JSON.stringify(cfg), Date.now());
  putRow({ header: { stripText: 'Custom strip' }, footer: {} });
  // A direct database write does not clear the page cache, so each case reads a section page nothing has fetched yet.
  const partial = await get('/youth/');
  check('a stored row missing fields is filled with the defaults', part(partial.text, 'header').includes('Custom strip') && part(partial.text, 'header').includes('Submit a Story') && partial.status === 200);
  for (const [name, cfg, url] of [['over-long text', { header: { topLineText: 'x'.repeat(500) }, footer: {} }, '/news/'], ['a javascript: link', { header: {}, footer: { statementButtonUrl: 'javascript:alert(1)' } }, '/features/'], ['a wrong type', { header: { showSearch: 'yes' }, footer: {} }, '/kids/']]) {
    putRow(cfg);
    const pub = await get(url), adminBroken = await get('/admin/header-footer', 'admin');
    check(`broken stored row (${name}): public pages show the defaults and the admin page still opens with a notice`, TODAY_HEADER.every((x) => part(pub.text, 'header').includes(x)) && adminBroken.status === 200 && adminBroken.text.includes('could not be read') && adminBroken.text.includes('value="50"'));
  }
  check('the API serves the defaults while the stored row is broken', (await api()).chrome.header.topLine.text === 'Faith in action. Close to home.');
  const stagedBroken = await save({}, { version: 50, action: 'reset' });
  check('Restore defaults works on a broken row (staged)', stagedBroken.status === 200 && (await stagedBroken.text()).includes('Unsaved'));
  check('saving the defaults repairs a broken row (version bump, audited as repaired)', (await save({}, { version: 50 })).status === 200 && await version() === 51 && JSON.parse(rows("SELECT detail FROM audit_log WHERE action='site_chrome.update' ORDER BY id DESC LIMIT 1")[0].detail).repaired === true);
  // 8. The admin form: no horizontal scroll, Move up/down, and without JavaScript it still submits.
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(BASE + '/admin/header-footer');
  await page.locator('[data-chrome-move="1"]').first().click();
  check('Move down swaps the first two link positions', await page.locator('.chrome-row').first().locator('input[type=text]').first().inputValue() === 'Search stories');
  if (shots) await page.screenshot({ path: path.join(shots, 'admin-header-footer-1280.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 800 }); await page.goto(BASE + '/admin/header-footer');
  check('admin page has no horizontal scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (shots) await page.screenshot({ path: path.join(shots, 'admin-header-footer-390.png'), fullPage: true });
  if (process.env.AXE_JS) { await page.addScriptTag({ path: process.env.AXE_JS }); const scan = await page.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })); if (scan.violations.length) console.log(JSON.stringify(scan.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.failureSummary) })))); check('admin header and footer page passes axe', scan.violations.length === 0); }
  check('stories are never written by the header and footer editor', JSON.stringify(rows('SELECT * FROM stories ORDER BY id')) === storiesBefore);
  check('no uncaught browser errors', errors.length === 0);
  console.log(`\n${checks} site chrome checks passed.`);
} finally { await browser?.close(); if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); } db?.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
