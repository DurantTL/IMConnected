#!/usr/bin/env node
// Browser integration of the built editor. Synthetic local data only; no credentials or external services.
// npm run build
// [PLAYWRIGHT_ROOT=<folder>] [CHROMIUM_PATH=<browser>] [CHROMIUM_NO_SANDBOX=1] [AXE_JS=<axe.min.js>] node scripts/test-story-builder-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Playwright is not a dependency of this repo. PLAYWRIGHT_ROOT (a folder whose node_modules has it) overrides the normal resolution.
const playwrightRequire = process.env.PLAYWRIGHT_ROOT ? createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json')) : createRequire(import.meta.url);
const { chromium } = (() => {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { return playwrightRequire(spec); } catch { /* try the next */ } }
  throw new Error('Playwright was not found. Install it or set PLAYWRIGHT_ROOT to a folder whose node_modules has it.');
})();
// CHROMIUM_PATH picks a browser; CHROMIUM_NO_SANDBOX=1 adds --no-sandbox (needed only when running as root, e.g. in a container).
const launchOptions = () => ({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
const PORT = Number(process.env.PORT || 4791);
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-builder-ui-'));
const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const serverLog = [];
let browser;
let db;
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  cwd: ROOT,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: scratch, SITE_URL: BASE,
    AUTH_SECRET: 'synthetic-story-builder-auth-' + 'x'.repeat(32), RESEND_API_KEY: '',
    GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '',
    PUBLISH_TOKEN: '', AGENT_API_TOKEN: '', TURNSTILE_SECRET_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (data) => serverLog.push(String(data)));
server.stderr.on('data', (data) => serverLog.push(String(data)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Built server exited: ${serverLog.join('')}`);
    try { const response = await fetch(BASE + '/admin/login'); if (response.status === 200) { ready = true; break; } } catch {}
    await sleep(100);
  }
  check('built server starts with an isolated migrated database', ready);
  db = new DatabaseSync(path.join(scratch, 'imconnected.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const now = Date.now();
  const userId = Number(db.prepare("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES ('builder-synthetic@example.invalid','Synthetic Editor','editor','active',?,?)").run(now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)').run(createHash('sha256').update(token).digest('hex'), userId, now, now, now + 3600_000);
  const post = (url, form) => fetch(BASE + url, { method: 'POST', headers: { Origin: BASE, Cookie: `__Host-imc_session=${token}` }, body: form, redirect: 'manual' });
  const created = await post('/api/admin/drafts/new', new FormData());
  const draftPath = created.headers.get('location');
  check('new draft is created through the authenticated API', created.status === 303 && /^\/admin\/drafts\/\d+$/.test(draftPath || ''));
  const id = Number(draftPath.split('/').pop());
  const draft = () => db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  const legacy = 'This is synthetic Markdown preserved when the story moves into modules. **Existing formatting** remains editable and searchable.';
  const initial = new FormData();
  for (const [name, value] of Object.entries({ version: draft().updated_at, title: 'Synthetic modular editor integration', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: legacy, photoLayout: 'one', photoCredit: 'Synthetic Photographer' })) initial.set(name, String(value));
  const initialResponse = await post(`/api/admin/drafts/${id}/save`, initial);
  check('legacy Markdown is saved through the real draft endpoint', initialResponse.status === 200 && (await initialResponse.json()).ok);
  // A synthetic landscape fixture makes the focal-point interaction visible without real people or photos.
  const crcTable = Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, checksum]);
  };
  const width = 640, height = 400, pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + x * 3 + 1;
    let color = [160 + Math.round(y / 12), 209 + Math.round(y / 24), 212];
    if ((x - 175) ** 2 + (y - 116) ** 2 < 47 ** 2) color = [224, 164, 78];
    if (y > 260 - 60 * Math.sin(x / 120)) color = [49, 112, 116];
    if (y > 340 - 65 * Math.cos(x / 180)) color = [19, 65, 78];
    pixels[at] = color[0]; pixels[at + 1] = color[1]; pixels[at + 2] = color[2];
  }
  const dimensions = Buffer.alloc(13); dimensions.writeUInt32BE(width); dimensions.writeUInt32BE(height, 4); dimensions[8] = 8; dimensions[9] = 2;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', dimensions), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  const upload = new FormData(); upload.set('version', String(draft().updated_at)); upload.set('op', 'upload'); upload.set('photos', new Blob([png], { type: 'image/png' }), 'synthetic.png');
  const uploaded = await post(`/api/admin/drafts/${id}/photos`, upload);
  const photo = db.prepare('SELECT * FROM draft_photos WHERE draft_id=?').get(id);
  check('a synthetic photo is uploaded through the real photo endpoint', uploaded.status === 303 && !!photo);

  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Secure cookies are accepted for localhost by Chromium, matching the application's local development contract.
  await context.addCookies([{ name: '__Host-imc_session', value: token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await context.route('**/*', (route) => { const url = new URL(route.request().url()); return url.origin === BASE || url.protocol === 'data:' || url.protocol === 'about:' ? route.continue() : route.abort(); });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('dialog', (dialog) => dialog.accept());
  const emptyCreated = await post('/api/admin/drafts/new', new FormData());
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(BASE + emptyCreated.headers.get('location'));
  await page.locator('#module-workspace').waitFor({ state: 'visible' });
  check('new empty stories show a writing prompt and paragraph placeholder', await page.locator('#module-start-writing').isVisible() && await page.locator('[data-module-field="text"]').getAttribute('placeholder') === 'Start writing your story here…');
  const emptyId = Number(/\/drafts\/(\d+)/.exec(emptyCreated.headers.get('location'))[1]);
  const emptyBefore = db.prepare('SELECT status, updated_at, updated_by FROM drafts WHERE id=?').get(emptyId);
  check('opening an empty phone story does not focus a text field or summon the keyboard', await page.evaluate(() => !document.activeElement.matches('input,textarea,[contenteditable=true]')));
  if (shots) {
    await page.locator('#module-start-writing').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, 'story-empty-mobile.png') });
  }
  await page.waitForTimeout(21500); // longer than the 20-second autosave timer
  const emptyAfter = db.prepare('SELECT status, updated_at, updated_by FROM drafts WHERE id=?').get(emptyId);
  check('merely opening an empty draft does not autosave it (no new version, no editor recorded, no status change)', JSON.stringify(emptyAfter) === JSON.stringify(emptyBefore), JSON.stringify([emptyBefore, emptyAfter]));
  await page.getByRole('button', { name: 'Start writing', exact: true }).click();
  check('Start writing explicitly focuses the paragraph field', await page.locator('[data-module-field="text"]').evaluate((field) => field === document.activeElement));
  await page.getByRole('button', { name: 'Delete module', exact: true }).click();
  check('deleting the last module focuses the visible Add paragraph action', await page.locator('[data-add-module="text"]').evaluate((button) => button === document.activeElement));
  await page.locator('#blocks-undo').click();
  check('undoing the final deletion restores focus to the restored module', await page.locator('[data-select-module]').evaluate((button) => button === document.activeElement));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(BASE + draftPath);
  const blocks = () => page.locator('#story-blocks').inputValue().then(JSON.parse);
  const selectedHasFocus = () => page.evaluate(() => document.activeElement.matches('[data-select-module][aria-pressed="true"]'));
  check('existing Markdown stays in Markdown mode until the editor chooses modules', (await blocks()).length === 0 && await page.locator('#markdown-workspace').isVisible() && await page.locator('#f-body').inputValue() === legacy);
  await page.locator('#use-modules').click();
  check('enabling modules preserves the complete legacy Markdown', (await blocks())[0].text === legacy);
  await page.locator('[data-add-module="heading"]').click();
  await page.locator('[data-module-field="text"]').fill('A synthetic heading');
  await page.getByRole('button', { name: /^1\. Paragraph/ }).focus();
  await page.keyboard.press('Enter');
  check('Enter selects a module and restores actual focus after rendering', await selectedHasFocus());
  const labelMismatch = await page.evaluate(() => [...document.querySelectorAll('#module-outline button')].filter((b) => {
    const label = b.getAttribute('aria-label');
    if (label === null) return false; // no aria-label: the visible text is the name
    const visible = [...b.childNodes].filter((n) => !(n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true')).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return !label.trim().toLowerCase().startsWith(visible);
  }).map((b) => b.outerHTML.slice(0, 80)));
  check('outline buttons\' accessible names start with their visible text (WCAG 2.5.3)', labelMismatch.length === 0, labelMismatch.join(' | '));
  await page.keyboard.press('Tab');
  check('Tab continues from the selected module to its next available action', await page.getByRole('button', { name: 'Move down, module 1', exact: true }).evaluate((button) => button === document.activeElement));
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab returns to the selected module', await selectedHasFocus());
  await page.getByRole('button', { name: /^2\. Heading/ }).focus();
  await page.keyboard.press('Space');
  check('Space selects the heading and keeps actual focus on it', await selectedHasFocus() && await page.locator('#module-title').textContent() === 'Heading settings');
  await page.getByRole('button', { name: /^1\. Paragraph/ }).click();
  check('pointer selection keeps focus on the selected outline button', await selectedHasFocus());
  await page.getByRole('button', { name: 'Move up, module 2', exact: true }).click();
  check('accessible Move controls reorder actual module state', (await blocks())[0].type === 'heading');
  await page.getByRole('button', { name: 'Duplicate module', exact: true }).click();
  check('duplicate creates a distinct stable module ID', (await blocks()).length === 3 && new Set((await blocks()).map((b) => b.id)).size === 3);
  check('duplicate focuses the new module outline button', await selectedHasFocus());
  await page.locator('#blocks-undo').click();
  check('Undo restores the module list', (await blocks()).length === 2);
  check('Undo restores focus to the previous selection', await selectedHasFocus());
  await page.locator('#blocks-redo').click();
  check('Redo restores the duplicated module', (await blocks()).length === 3);
  check('Redo focuses the restored duplicate', await selectedHasFocus());
  await page.getByRole('button', { name: 'Delete module', exact: true }).click();
  check('deleting a module focuses its remaining neighbour', (await blocks()).length === 2 && await selectedHasFocus());
  await page.locator('#blocks-undo').click();
  await page.locator('#blocks-undo').click();
  await page.locator('[data-add-module="list"]').click();
  await page.locator('[data-module-field="items"]').fill('First synthetic item\nSecond synthetic item');
  await page.locator('[data-add-module="button"]').click();
  await page.locator('[data-module-field="label"]').fill('Synthetic details');
  await page.locator('[data-module-field="url"]').fill('https://example.invalid/synthetic-details');
  await page.locator('[data-add-module="image"]').click();
  await page.locator('[data-module-field="photoId"]').selectOption('');
  await page.locator('[data-module-field="photoId"]').selectOption(String(photo.id));
  check('changing the image preserves focus on the recreated photo selector', await page.locator('[data-module-field="photoId"]').evaluate((select) => select === document.activeElement));
  await page.locator('[data-module-field="alt"]').fill('Synthetic image used only in this test');
  await page.locator('[data-add-module="quote"]').click();
  await page.locator('[data-module-field="text"]').fill('A synthetic quoted statement.');
  await page.locator('[data-add-module="divider"]').click();
  const expected = await blocks();
  check('all seven supported module types are represented', new Set(expected.map((b) => b.type)).size === 7);
  // a hidden invalid address must not block Save silently: the field is plain text and the server explains the problem
  const buttonModule = expected.find((b) => b.type === 'button');
  await page.locator(`[data-select-module="${buttonModule.id}"]`).click();
  check('the button address field is a plain text field (a type=url field would block Save without a word)', await page.locator('[data-module-field="url"]').getAttribute('type') === 'text');
  await page.locator('[data-module-field="url"]').fill('not an address');
  await page.locator('[data-select-module]').first().click();
  const badSave = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${id}/save` && response.request().method() === 'POST');
  await page.locator('#save-btn').click();
  const badSaved = await badSave;
  check('Save with an invalid address in a hidden module answers with a clear message', badSaved.status() === 400 && /Button links/.test((await badSaved.json()).error) && /Button links/.test(await page.locator('#save-status').textContent()));
  await page.locator(`[data-select-module="${buttonModule.id}"]`).click();
  await page.locator('[data-module-field="url"]').fill(buttonModule.url);

  await page.locator('[data-studio-tab=photos]').click();
  await page.locator('.sb-focus-settings').evaluate((details) => { details.open = true; });
  const focal = page.locator(`[data-focal="${photo.id}"]`);
  await focal.scrollIntoViewIfNeeded();
  const box = await focal.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, 'focal control is visible');
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .75);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .30, box.y + box.height * .70, { steps: 3 });
  await page.mouse.up();
  await focal.press('ArrowRight');
  await focal.press('Shift+ArrowUp');
  const x = Number(await page.locator(`[name="photo_${photo.id}_focalX"]`).inputValue());
  const y = Number(await page.locator(`[name="photo_${photo.id}_focalY"]`).inputValue());
  check('pointer dragging and arrow-key focal adjustments update bounded values', Math.abs(x - 31) <= 1 && Math.abs(y - 60) <= 1);
  const saveResponse = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${id}/save` && response.request().method() === 'POST');
  await page.locator('#save-btn').click();
  const saved = await saveResponse;
  check('modular story and focus save successfully', saved.status() === 200 && (await saved.json()).ok);
  await page.reload();
  await page.locator('[data-studio-tab=content]').click();
  await page.locator('#module-workspace').waitFor({ state: 'visible' });
  check('module order and content survive reload', JSON.stringify(await blocks()) === JSON.stringify(expected));
  const storedPhoto = db.prepare('SELECT * FROM draft_photos WHERE id=?').get(photo.id);
  check('focal settings survive reload in SQLite', storedPhoto.focal_x === x && storedPhoto.focal_y === y);
  await page.waitForFunction(() => {
    const frame = document.getElementById('preview');
    const image = frame?.contentDocument?.querySelector('.story-module-image img');
    return image?.complete && image.naturalWidth > 0;
  });
  check('private preview loads the authenticated uploaded image', true);
  check('preview keeps scripts disabled in its sandbox', !(await page.locator('#preview').getAttribute('sandbox') || '').split(/\s+/).includes('allow-scripts'));
  const axePath = process.env.AXE_JS || (() => { try { return playwrightRequire.resolve('axe-core/axe.min.js'); } catch { return ''; } })();
  if (axePath && fs.existsSync(axePath)) {
    await page.addScriptTag({ path: axePath });
    const accessibility = [];
    for (const panel of ['content', 'settings', 'photos', 'review']) {
      await page.locator(`[data-studio-tab=${panel}]`).click();
      const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) })));
      accessibility.push({ panel, violations });
    }
    if (shots) fs.writeFileSync(path.join(shots, 'editor-axe-results.json'), JSON.stringify(accessibility, null, 2));
    if (accessibility.some((result) => result.violations.length)) console.error(JSON.stringify(accessibility, null, 2));
    check('all four editor panels pass axe WCAG A/AA checks', accessibility.every((result) => result.violations.length === 0));
    await page.locator('[data-studio-tab=content]').click();
  } else console.log('SKIP editor axe checks: install axe-core or set AXE_JS');
  if (shots) {
    await page.locator('[data-studio-tab=photos]').click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, 'story-photos-desktop.png') });
    await page.locator('[data-studio-tab=content]').click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, 'story-builder-desktop.png') });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(100);
  check('editor reflows without horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check('phone header scrolls normally and desktop actions leave the focus order', await page.locator('.studio-head').evaluate((head) => getComputedStyle(head).position === 'static') && !(await page.locator('#save-btn').isVisible()) && await page.locator('#mobile-save-btn').isVisible());
  await page.locator('#module-fields').scrollIntoViewIfNeeded();
  const phoneSave = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${id}/save` && response.request().method() === 'POST');
  await page.locator('#mobile-save-btn').click();
  check('phone action bar saves through the existing authenticated form', (await phoneSave).status() === 200);
  const bar = await page.locator('.studio-mobile-actions').boundingBox();
  check('phone actions stay compact and visible at the viewport edge', bar && bar.height < 100 && Math.abs(bar.y + bar.height - 900) < 2);
  await page.locator('.studio-mobile-actions [data-open-panel="review"]').click();
  check('phone Review action opens the publishing review panel', await page.locator('#studio-panel-review').isVisible());
  await page.locator('[data-studio-tab=content]').click();
  await page.locator('[data-select-module]').last().click();
  await page.locator('#module-fields').scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  check('bottom content remains scrollable above the phone action bar', await page.locator('#module-fields').evaluate((fields) => fields.getBoundingClientRect().bottom <= document.querySelector('.studio-mobile-actions').getBoundingClientRect().top));
  if (shots) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, 'story-builder-mobile.png') });
  }
  await page.locator('[data-studio-tab=content]').focus();
  await page.keyboard.press('ArrowRight');
  check('workspace tabs support keyboard selection and hide inactive controls', await page.locator('#studio-panel-settings').isVisible() && await page.locator('#story-builder').evaluate((panel) => panel.hidden && panel.inert));
  await page.locator('[data-studio-tab=content]').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-studio-tab=review]').click();
  await Promise.all([page.waitForURL((url) => url.searchParams.get('n') === 'published'), page.locator('#publish-form button').click()]);
  const row = draft();
  check('local Publish creates a live modular story', row.status === 'published' && !!row.slug);
  const publicPage = await context.newPage();
  await publicPage.goto(BASE + `/stories/${row.slug}/`);
  const renderedIds = await publicPage.locator('[data-module-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-module-id')));
  check('published modules retain their saved order', JSON.stringify(renderedIds) === JSON.stringify(expected.map((block) => block.id)));
  check('inline image is rendered once rather than duplicated in the hero/gallery', await publicPage.locator('article img').count() === 1);
  check('an all-inline story keeps its global photo credit exactly once', (await publicPage.locator('article').innerText()).split('Synthetic Photographer').length - 1 === 1);
  const focus = await publicPage.locator('.story-module-image img').evaluate((image) => image.style.objectPosition);
  check('published image uses the persisted focal point', focus === `${x}% ${y}%`);
  check('published action link remains functional content', await publicPage.locator('article a[href="https://example.invalid/synthetic-details"]').count() === 1);
  // Publish a separate synthetic legacy story to protect the existing lead/layout credit paths.
  const createLegacy = async () => {
    const response = await post('/api/admin/drafts/new', new FormData());
    assert.equal(response.status, 303);
    return Number(response.headers.get('location').split('/').pop());
  };
  let legacyId = await createLegacy();
  const legacyDraft = () => db.prepare('SELECT * FROM drafts WHERE id=?').get(legacyId);
  const credit = 'Synthetic Photographer <em>escaped credit</em>';
  const saveLegacy = async (photoLayout) => {
    const data = new FormData();
    for (const [key, value] of Object.entries({ version: legacyDraft().updated_at, title: 'Synthetic legacy credit', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: legacy, photoCredit: credit, photoLayout })) data.set(key, String(value));
    assert.equal((await post(`/api/admin/drafts/${legacyId}/save`, data)).status, 200);
  };
  const uploadLegacy = async () => {
    const data = new FormData(); data.set('version', String(legacyDraft().updated_at)); data.set('op', 'upload'); data.set('photos', new Blob([png], { type: 'image/png' }), 'synthetic.png');
    assert.equal((await post(`/api/admin/drafts/${legacyId}/photos`, data)).status, 303);
  };
  const publishLegacy = async () => {
    const data = new FormData(); data.set('version', String(legacyDraft().updated_at));
    assert.equal((await post(`/api/admin/drafts/${legacyId}/publish`, data)).status, 303);
    await publicPage.goto(BASE + `/stories/${legacyDraft().slug}/`);
  };
  await saveLegacy('one'); await publishLegacy();
  check('a legacy story with zero photos does not gain a dangling credit', !(await publicPage.locator('article').innerText()).includes(credit));
  legacyId = await createLegacy();
  await saveLegacy('one'); await uploadLegacy(); await publishLegacy();
  check('legacy lead photo credit appears once and remains escaped text', (await publicPage.locator('article').innerText()).split(credit).length - 1 === 1 && await publicPage.locator('article em').count() === 0);
  legacyId = await createLegacy();
  await saveLegacy('twoUp'); await uploadLegacy(); await uploadLegacy(); await publishLegacy();
  check('noninline photo layout keeps the existing credit exactly once', await publicPage.locator('[data-photo-layout="twoUp"]').count() === 1 && (await publicPage.locator('article').innerText()).split(credit).length - 1 === 1);
  check('editor browser interactions have no uncaught errors', pageErrors.length === 0);
  console.log(`\n${checks} story-builder browser checks passed.`);
} catch (error) {
  console.error(error);
  console.error(serverLog.join('').slice(-12000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  db?.close();
  if (server.exitCode === null) {
    const done = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([done, sleep(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
