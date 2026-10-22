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
  const layoutBefore = await blocks();
  await page.locator('#module-library-search').fill('HEADING');
  check('library search is labelled, case-insensitive and reports its count', await page.getByLabel('Find a module').inputValue() === 'HEADING' && await page.locator('[data-add-module]:visible').count() === 1 && await page.locator('#module-library-results').textContent() === '1 module found');
  await page.locator('#module-library-search').fill('no-such-module');
  check('library no-results state has a visible recovery action', await page.locator('#module-library-empty').isVisible() && await page.locator('[data-add-module]:visible').count() === 0 && await page.locator('#module-library-reset').isVisible());
  await page.locator('#module-library-reset').click();
  check('clearing library search restores the same eleven module controls without changing content', await page.locator('[data-add-module]:visible').count() === 11 && await page.locator('#module-library-search').inputValue() === '' && JSON.stringify(await blocks()) === JSON.stringify(layoutBefore));
  for (const layout of ['news', 'recap', 'announcement']) {
    await page.getByRole('button', { name: /^1\. Paragraph/ }).click();
    const before = await blocks();
    await page.locator(`[data-insert-layout="${layout}"]`).click();
    const inserted = await blocks();
    check(`${layout} starter inserts four unique modules after selection and preserves both existing modules`, inserted.length === before.length + 4 && inserted[0].id === before[0].id && inserted[5].id === before[1].id && new Set(inserted.map((block) => block.id)).size === inserted.length && inserted.slice(1, 5).every((block) => !before.some((old) => old.id === block.id)) && inserted.every((block) => !['button', 'image'].includes(block.type)) && JSON.stringify(inserted[0]) === JSON.stringify(before[0]) && JSON.stringify(inserted[5]) === JSON.stringify(before[1]));
    await page.locator('#blocks-undo').click();
    check(`${layout} starter is one atomic undo change`, JSON.stringify(await blocks()) === JSON.stringify(before));
    await page.locator('#blocks-redo').click();
    check(`${layout} starter redo restores its stable IDs`, JSON.stringify(await blocks()) === JSON.stringify(inserted));
    await page.locator('#blocks-undo').click();
  }
  for (let i = 0; i < 14; i++) await page.locator('[data-insert-layout="news"]').click();
  check('starter layouts can fill the story up to 58 modules', (await blocks()).length === 58);
  const beforeLimit = await blocks();
  await page.locator('[data-insert-layout="news"]').click();
  check('a starter that would exceed 60 modules makes no partial change', JSON.stringify(await blocks()) === JSON.stringify(beforeLimit) && (await page.locator('#module-status').textContent()).includes('No modules were added'));
  await page.locator('[data-add-module="divider"]').click();
  await page.locator('[data-add-module="divider"]').click();
  const atLimit = await blocks();
  await page.locator('[data-insert-layout="announcement"]').click();
  check('starter insertion at the 60-module limit preserves every existing ID', atLimit.length === 60 && JSON.stringify(await blocks()) === JSON.stringify(atLimit));
  for (let i = 0; i < 16; i++) await page.locator('#blocks-undo').click();
  check('rejected starters do not consume undo history', JSON.stringify(await blocks()) === JSON.stringify(layoutBefore));
  const paneBoxes = await Promise.all(['.sb-outline', '.ed-preview', '#module-inspector'].map((selector) => page.locator(selector).boundingBox()));
  check('1440px builder places outline left, composed canvas center and inspector right', paneBoxes.every(Boolean) && paneBoxes[0].x + paneBoxes[0].width <= paneBoxes[1].x + 1 && paneBoxes[1].x + paneBoxes[1].width <= paneBoxes[2].x + 1 && Math.abs(paneBoxes[0].y - paneBoxes[1].y) < 2 && Math.abs(paneBoxes[1].y - paneBoxes[2].y) < 2);

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
  let x = Number(await page.locator(`[name="photo_${photo.id}_focalX"]`).inputValue());
  let y = Number(await page.locator(`[name="photo_${photo.id}_focalY"]`).inputValue());
  check('pointer dragging and arrow-key focal adjustments update bounded values', Math.abs(x - 31) <= 1 && Math.abs(y - 60) <= 1);
  const zoom = page.getByRole('slider', { name: 'Photo 1 zoom', exact: true });
  await zoom.fill('2');
  await page.getByRole('button', { name: 'Zoom photo 1 in', exact: true }).click();
  check('zoom slider and buttons update the crop and accessible percentage', await zoom.inputValue() === '2.1' && await zoom.getAttribute('aria-valuetext') === '210 percent' && await page.locator(`[data-focus-preview="${photo.id}"]`).evaluate((image) => image.style.scale) === '2.1');
  await page.getByRole('button', { name: 'Reset crop', exact: true }).click();
  check('Reset crop restores the complete default crop', await zoom.inputValue() === '1' && await page.locator(`[name="photo_${photo.id}_focalX"]`).inputValue() === '50' && await page.locator(`[name="photo_${photo.id}_focalY"]`).inputValue() === '50');
  await zoom.fill('1.8');
  const crop = page.locator(`[data-pan-photo="${photo.id}"]`);
  await crop.scrollIntoViewIfNeeded();
  await crop.locator('img').evaluate((image) => image.decode());
  const cropBox = await crop.boundingBox();
  await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cropBox.x + cropBox.width / 2 + 20, cropBox.y + cropBox.height / 2 + 12, { steps: 3 });
  await page.mouse.up();
  x = Number(await page.locator(`[name="photo_${photo.id}_focalX"]`).inputValue());
  y = Number(await page.locator(`[name="photo_${photo.id}_focalY"]`).inputValue());
  check('dragging the crop moves the zoomed image in the pointer direction', x < 50 && x > 0 && y < 50 && y > 0);
  await crop.press('Shift+ArrowLeft');
  check('crop keyboard panning moves by ten percent with Shift', Math.abs(Number(await page.locator(`[name="photo_${photo.id}_focalX"]`).inputValue()) - x - 10) < .01);
  x = Number(await page.locator(`[name="photo_${photo.id}_focalX"]`).inputValue());
  y = Number(await page.locator(`[name="photo_${photo.id}_focalY"]`).inputValue());
  check('crop preview fills its clipping frame without stretching', await crop.evaluate((frame) => {
    const image = frame.querySelector('img'); const style = getComputedStyle(image);
    return getComputedStyle(frame).overflow === 'hidden' && style.objectFit === 'cover' && Math.abs(image.clientHeight - frame.clientHeight) <= 1 && Math.abs(image.clientWidth - frame.clientWidth) <= 1;
  }));
  const saveResponse = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${id}/save` && response.request().method() === 'POST');
  await page.locator('#save-btn').click();
  const saved = await saveResponse;
  check('modular story and focus save successfully', saved.status() === 200 && (await saved.json()).ok);
  await page.reload();
  if (shots) {
    await page.locator('[data-studio-tab=photos]').click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, 'story-photo-zoom-pan.png'), fullPage: true });
  }
  await page.locator('[data-studio-tab=content]').click();
  await page.locator('#module-workspace').waitFor({ state: 'visible' });
  check('module order and content survive reload', JSON.stringify(await blocks()) === JSON.stringify(expected));
  const storedPhoto = db.prepare('SELECT * FROM draft_photos WHERE id=?').get(photo.id);
  check('focal settings survive reload in SQLite', storedPhoto.focal_x === x && storedPhoto.focal_y === y);
  check('zoom survives reload in SQLite and the editor form', storedPhoto.zoom === 1.8 && await page.locator(`[name="photo_${photo.id}_zoom"]`).inputValue() === '1.8');
  await page.waitForFunction(() => {
    const frame = document.getElementById('preview');
    const image = frame?.contentDocument?.querySelector('.story-module-image img');
    return image?.complete && image.naturalWidth > 0;
  });
  check('private preview loads the authenticated uploaded image', true);
  check('private preview matches the saved zoom and clips the image', await page.frameLocator('#preview').locator('.story-module-image img').evaluate((image) => image.style.scale === '1.8' && getComputedStyle(image.parentElement).overflow === 'hidden'));
  check('preview keeps scripts disabled in its sandbox', !(await page.locator('#preview').getAttribute('sandbox') || '').split(/\s+/).includes('allow-scripts'));
  const canvasHeading = page.frameLocator('#preview').locator(`[data-module-id="${expected.find((block) => block.type === 'heading').id}"]`);
  await canvasHeading.press('Enter');
  check('Enter on a canvas module selects it, highlights it and focuses its inspector field', await canvasHeading.getAttribute('data-preview-selected') !== null && await canvasHeading.evaluate((module) => module.style.outline.includes('3px')) && await page.locator('[data-module-field="text"]').evaluate((field) => field === document.activeElement) && await page.locator('#module-title').textContent() === 'Heading settings');
  const canvasQuote = page.frameLocator('#preview').locator(`[data-module-id="${expected.find((block) => block.type === 'quote').id}"]`);
  await canvasQuote.press('Space');
  check('Space selects a different canvas module and clears the previous highlight', await canvasQuote.getAttribute('data-preview-selected') !== null && await canvasHeading.getAttribute('data-preview-selected') === null && await page.locator('#module-title').textContent() === 'Quote settings');
  const canvasUrl = await page.locator('#preview').evaluate((frame) => frame.contentWindow.location.href);
  await page.frameLocator('#preview').locator('a[href="https://example.invalid/synthetic-details"]').click();
  check('canvas links select settings without navigating the private preview', await page.locator('#module-title').textContent() === 'Button / link settings' && await page.locator('[data-module-field="label"]').evaluate((field) => field === document.activeElement) && await page.locator('#preview').evaluate((frame) => frame.contentWindow.location.href) === canvasUrl);
  if (shots) await page.screenshot({ path: path.join(shots, 'story-builder-canvas-selection.png') });

  const axePath = process.env.AXE_JS || (() => { try { return playwrightRequire.resolve('axe-core/axe.min.js'); } catch { return ''; } })();
  if (axePath && fs.existsSync(axePath)) {
    await page.addScriptTag({ path: axePath });
    check('canvas keeps native heading and list semantics while exposing keyboard selection', await canvasHeading.evaluate((heading) => heading.matches('h2,h3') && !heading.hasAttribute('role') && heading.tabIndex === 0) && await page.frameLocator('#preview').getByRole('heading', { name: 'A synthetic heading', exact: true }).count() === 1 && await page.frameLocator('#preview').getByRole('list').filter({ hasText: 'First synthetic item' }).getByRole('listitem').count() === 2);
    // Sandbox scripts stay disabled. Audit an exact snapshot of the enhanced frame DOM
    // in a diagnostic page, where axe's asynchronous checks can execute.
    const canvasSnapshot = await page.locator('#preview').evaluate((frame) => frame.contentDocument.documentElement.outerHTML);
    const canvasBox = await page.locator('#preview').boundingBox();
    const canvasAudit = await context.newPage();
    await canvasAudit.setViewportSize({ width: Math.round(canvasBox.width), height: Math.round(canvasBox.height) });
    await canvasAudit.setContent(canvasSnapshot);
    await canvasAudit.evaluate(fs.readFileSync(axePath, 'utf8'));
    const canvasViolations = await canvasAudit.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) })));
    await canvasAudit.close();
    if (shots) fs.writeFileSync(path.join(shots, 'editor-canvas-axe-results.json'), JSON.stringify(canvasViolations, null, 2));
    if (canvasViolations.length) console.error(JSON.stringify(canvasViolations, null, 2));
    check('enhanced canvas DOM snapshot passes axe WCAG A/AA checks', canvasViolations.length === 0);

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
    await page.locator(`[data-select-module="${expected.find((block) => block.type === 'heading').id}"]`).click();
    await page.locator('#preview').evaluate((frame) => frame.contentWindow.scrollTo(0, 0));
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, 'story-builder-desktop.png') });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('[data-studio-tab=photos]').click();
  check('phone crop controls reflow without horizontal overflow and retain touch targets', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.sb-zoom-controls button')].every((button) => button.getBoundingClientRect().height >= 44)));
  if (shots) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, 'story-photo-zoom-pan-mobile.png'), fullPage: true });
  }
  await page.locator('[data-studio-tab=content]').click();
  await page.waitForTimeout(100);
  check('editor reflows without horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check('phone Build view keeps its inspector visible and its preview hidden and inert', await page.getByRole('button', { name: 'Build', exact: true }).isVisible() && await page.locator('#module-inspector').isVisible() && await page.locator('.ed-preview').evaluate((pane) => pane.hidden && pane.inert));
  await page.locator('.ed-tabs [data-view=preview]').click();
  check('phone Preview view removes library and inspector controls from the focus order', await page.locator('.ed-preview').isVisible() && await page.locator('.ed-write').evaluate((pane) => pane.hidden && pane.inert) && await page.locator('#module-inspector').evaluate((pane) => pane.hidden && pane.inert));
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  check('phone Build action restores the selected inspector', await page.locator('#module-inspector').isVisible() && await page.locator('.ed-write').isVisible());

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
  await page.locator('[data-studio-tab=content]').click();
  await page.waitForFunction(() => document.getElementById('preview')?.contentDocument?.querySelector('[data-module-id]'));
  check('published draft preview renders its saved title and modules from disabled fields', await page.frameLocator('#preview').locator('h1').textContent() === row.title && await page.frameLocator('#preview').locator('[data-module-id]').count() === expected.length);
  check('published draft preview has no editable canvas affordances', await page.frameLocator('#preview').locator('[data-module-id][tabindex], [data-preview-selected]').count() === 0);
  const forgedPreview = new FormData();
  forgedPreview.set('title', 'This unsaved title must be ignored');
  forgedPreview.set('storyBlocks', 'invalid-json');
  forgedPreview.set(`photo_${photo.id}_focalX`, '0');
  forgedPreview.set(`photo_${photo.id}_zoom`, '3');
  const closedPreview = await post(`/api/admin/drafts/${id}/preview`, forgedPreview);
  const closedDoc = await closedPreview.json();
  check('readonly preview ignores posted replacement content and uses stored photo crop', closedPreview.status === 200 && closedDoc.ok && closedDoc.doc.includes(row.title) && !closedDoc.doc.includes('This unsaved title must be ignored') && closedDoc.doc.includes(`object-position:${x}% ${y}%`) && closedDoc.doc.includes('scale:1.8;'));


  const publicPage = await context.newPage();
  await publicPage.goto(BASE + `/stories/${row.slug}/`);
  const renderedIds = await publicPage.locator('[data-module-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-module-id')));
  check('published modules retain their saved order', JSON.stringify(renderedIds) === JSON.stringify(expected.map((block) => block.id)));
  check('inline image is rendered once rather than duplicated in the hero/gallery', await publicPage.locator('article img').count() === 1);
  check('an all-inline story keeps its global photo credit exactly once', (await publicPage.locator('article').innerText()).split('Synthetic Photographer').length - 1 === 1);
  const focus = await publicPage.locator('.story-module-image img').evaluate((image) => image.style.objectPosition);
  check('published image uses the persisted focal point', focus === `${x}% ${y}%`);
  check('published image keeps its zoom inside a clipping link to the original', await publicPage.locator('.story-module-image img').evaluate((image) => image.style.scale === '1.8' && image.parentElement.href === image.src && getComputedStyle(image.parentElement).overflow === 'hidden'));
  const original = await fetch(BASE + await publicPage.locator('.story-module-image img').getAttribute('src'));
  check('crop adjustments leave the original uploaded bytes intact', original.ok && Buffer.from(await original.arrayBuffer()).equals(png));
  const feed = await (await fetch(BASE + '/stories.json')).json();
  const feedStory = feed.stories.find((story) => story.id === row.slug);
  check('public feed adds crop metadata without changing its version', feed.version === 1 && feedStory?.photoFocus?.[0]?.zoom === 1.8 && feedStory.photoFocus[0].focalX === x);
  check('published action link remains functional content', await publicPage.locator('article a[href="https://example.invalid/synthetic-details"]').count() === 1);
  await publicPage.goto(BASE + '/');
  const storyCard = publicPage.locator(`.card[href="/stories/${row.slug}/"]`).filter({ has: publicPage.locator('img') }).first();
  check('public story cards preserve crop metadata in their own clipping frame', await storyCard.locator('img').evaluate((image) => image.style.scale === '1.8' && getComputedStyle(image.closest('.media')).overflow === 'hidden'));
  // Publish a separate synthetic legacy story to protect the existing lead/layout credit paths.
  const createLegacy = async () => {
    const response = await post('/api/admin/drafts/new', new FormData());
    assert.equal(response.status, 303);
    return Number(response.headers.get('location').split('/').pop());
  };
  let legacyId = await createLegacy();
  const legacyDraft = () => db.prepare('SELECT * FROM drafts WHERE id=?').get(legacyId);
  const credit = 'Synthetic Photographer <em>escaped credit</em>';
  const saveLegacy = async (photoLayout, bodyText = legacy) => {
    const data = new FormData();
    for (const [key, value] of Object.entries({ version: legacyDraft().updated_at, title: 'Synthetic legacy credit', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: bodyText, photoCredit: credit, photoLayout })) data.set(key, String(value));
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
  await saveLegacy('one'); await uploadLegacy();
  const legacyPhoto = db.prepare('SELECT id FROM draft_photos WHERE draft_id=?').get(legacyId);
  const cropForm = new FormData();
  for (const [key, value] of Object.entries({ version: legacyDraft().updated_at, title: legacyDraft().title, author: 'Synthetic Editor', section: 'news', area: 'conference', date: legacyDraft().date, body: legacy, photoCredit: credit, [`photo_${legacyPhoto.id}_zoom`]: 2 })) cropForm.set(key, String(value));
  assert.equal((await post(`/api/admin/drafts/${legacyId}/save`, cropForm)).status, 200);
  await publishLegacy();
  check('legacy lead photo credit appears once and remains escaped text', (await publicPage.locator('article').innerText()).split(credit).length - 1 === 1 && await publicPage.locator('article em').count() === 0);
  check('zoomed legacy lead photos clip and retain their original enlargement link', await publicPage.locator('.story-lead-crop img').evaluate((image) => image.style.scale === '2' && image.parentElement.href === image.src && getComputedStyle(image.parentElement).overflow === 'hidden'));
  legacyId = await createLegacy();
  await saveLegacy('twoUp'); await uploadLegacy(); await uploadLegacy();
  const pairPhotos = db.prepare('SELECT id FROM draft_photos WHERE draft_id=? ORDER BY position').all(legacyId);
  const pairForm = new FormData();
  for (const [key, value] of Object.entries({ version: legacyDraft().updated_at, title: legacyDraft().title, author: 'Synthetic Editor', section: 'news', area: 'conference', date: legacyDraft().date, body: legacy, photoCredit: credit, photoLayout: 'twoUp' })) pairForm.set(key, String(value));
  for (const photo of pairPhotos) { pairForm.set(`photo_${photo.id}_zoom`, '2.2'); pairForm.set(`photo_${photo.id}_focalX`, '0'); pairForm.set(`photo_${photo.id}_focalY`, '100'); }
  assert.equal((await post(`/api/admin/drafts/${legacyId}/save`, pairForm)).status, 200);
  await publishLegacy();
  check('noninline photo layout keeps the existing credit exactly once', await publicPage.locator('[data-photo-layout="twoUp"]').count() === 1 && (await publicPage.locator('article').innerText()).split(credit).length - 1 === 1);
  check('paired photos clip zoom at edge focal points without losing their links', await publicPage.locator('[data-photo-layout="twoUp"] img').evaluateAll((images) => images.length === 2 && images.every((image) => image.style.scale === '2.2' && image.style.objectPosition === '0% 100%' && getComputedStyle(image.parentElement).overflow === 'hidden' && image.parentElement.href === image.src)));
  legacyId = await createLegacy();
  await saveLegacy('one'); await uploadLegacy(); await uploadLegacy();
  await page.goto(BASE + `/admin/drafts/${legacyId}`);
  await page.locator('[data-studio-tab=content]').click();
  await page.locator('#f-body').fill('Before the inline photo.\n\nAfter the inline photo.');
  await page.locator('#f-body').evaluate((body) => { body.setSelectionRange(24, 24); });
  await page.locator('#inline-photo-choice').selectOption('2');
  await page.locator('#insert-inline-photo').click();
  check('Markdown Insert photo places the chosen story-owned marker at the cursor', (await page.locator('#f-body').inputValue()).includes('{{photo 2}}'));
  await page.waitForFunction(() => document.getElementById('preview')?.contentDocument?.querySelector('.story-inline-photo img'));
  check('Markdown private preview resolves the marker through the authenticated photo endpoint', await page.frameLocator('#preview').locator('.story-inline-photo img').getAttribute('src').then((src) => /^\/api\/admin\/photos\/\d+$/.test(src)));
  const inlineSave = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${legacyId}/save` && response.request().method() === 'POST');
  await page.locator('#save-btn').click(); assert.equal((await inlineSave).status(), 200);
  await publishLegacy();
  check('published photo marker is inline once and excluded from the separate photo group', await publicPage.locator('.prose .story-inline-photo').count() === 1 && await publicPage.locator('article img').count() === 2 && await publicPage.locator('.gallery').count() === 0);
  await publicPage.locator('.story-inline-photo a').click();
  check('inline marker photos use the existing enlargement viewer', await publicPage.locator('dialog.viewer').evaluate((dialog) => dialog.open));
  await publicPage.keyboard.press('Escape');
  legacyId = await createLegacy();
  await saveLegacy('heroGrid'); await uploadLegacy(); await uploadLegacy(); await uploadLegacy();
  await page.goto(BASE + `/admin/drafts/${legacyId}`);
  await page.locator('[data-studio-tab=content]').click();
  await page.locator('#f-body').fill('Before the gallery.\n\nAfter the gallery.');
  await page.locator('#gallery-photo-start').selectOption('3');
  await page.locator('#gallery-photo-end').selectOption('1');
  await page.locator('#insert-inline-gallery').click();
  check('gallery picker refuses reversed ranges without changing the text', !(await page.locator('#f-body').inputValue()).includes('{{gallery') && (await page.locator('#gallery-marker-status').innerText()).includes('ascending'));
  await page.locator('#gallery-photo-start').selectOption('1'); await page.locator('#gallery-photo-end').selectOption('3'); await page.locator('#gallery-columns').selectOption('3');
  await page.locator('#insert-inline-gallery').click();
  check('gallery picker inserts its bounded range and chosen columns', (await page.locator('#f-body').inputValue()).includes('{{gallery 1-3 columns=3}}'));
  const gallerySave = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${legacyId}/save` && response.request().method() === 'POST');
  await page.locator('#save-btn').click(); assert.equal((await gallerySave).status(), 200);
  await publishLegacy();
  check('published gallery renders every selected slot exactly once', await publicPage.locator('.story-inline-gallery img').count() === 3 && await publicPage.locator('article img').count() === 3);
  for (const [width, columns] of [[1440, 3], [390, 2]]) {
    await publicPage.setViewportSize({ width, height: 900 });
    check(`gallery uses ${columns} columns at ${width}px without overflow`, await publicPage.locator('.story-inline-gallery').evaluate((el, count) => getComputedStyle(el).gridTemplateColumns.split(' ').length === count && document.documentElement.scrollWidth <= innerWidth, columns));
    if (shots) await publicPage.screenshot({ path: path.join(shots, `story-gallery-${width}.png`), fullPage: true });
  }
  await publicPage.locator('.story-inline-gallery a').first().click();
  check('gallery photos use the same enlargement viewer', await publicPage.locator('dialog.viewer').evaluate((dialog) => dialog.open));
  await publicPage.keyboard.press('Escape');
  legacyId = await createLegacy(); await saveLegacy('twoUp'); await uploadLegacy(); await uploadLegacy();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(BASE + `/admin/drafts/${legacyId}`); await page.locator('[data-studio-tab=content]').click(); await page.locator('#use-modules').click();
  await page.locator('[data-add-module="gallery"]').click();
  const visualBefore = JSON.parse(await page.locator('#story-blocks').inputValue());
  assert.equal(visualBefore.at(-1).type, 'gallery'); assert.equal(visualBefore.at(-1).photos.length, 2);
  check('Gallery module selects the available story photos and exposes labelled controls', visualBefore.at(-1).type === 'gallery' && visualBefore.at(-1).photos.length === 2 && await page.locator('#module-fields').getByLabel('Gallery columns', { exact: true }).count() === 1);
  await page.getByRole('button', { name: 'Move gallery photo 2 earlier', exact: true }).focus();
  await page.keyboard.press('Enter');
  check('gallery keyboard reorder retains focus on the moved row at the boundary', await page.locator('[data-gallery-order="0"]').evaluate((el) => el === document.activeElement));
  await page.locator('#module-fields').getByLabel('Gallery columns', { exact: true }).selectOption('3');
  const visualOrdered = JSON.parse(await page.locator('#story-blocks').inputValue());
  check('Gallery keyboard controls reverse ordered stable IDs and save column settings', visualOrdered.at(-1).photos[0].photoId === visualBefore.at(-1).photos[1].photoId && visualOrdered.at(-1).columns === 3);
  await page.getByRole('button', { name: 'Duplicate module', exact: true }).click();
  check('Gallery duplication uses a new module ID and retains photo ordering', JSON.parse(await page.locator('#story-blocks').inputValue()).at(-1).id !== visualOrdered.at(-1).id);
  await page.locator('#blocks-undo').click();
  check('Gallery duplication can be undone atomically', JSON.stringify(JSON.parse(await page.locator('#story-blocks').inputValue())) === JSON.stringify(visualOrdered));
  await page.waitForFunction(() => document.getElementById('preview')?.contentDocument?.querySelectorAll('.story-inline-gallery img').length === 2);
  const visualSave = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${legacyId}/save` && response.request().method() === 'POST');
  await page.locator('#save-btn').click(); assert.equal((await visualSave).status(), 200); await publishLegacy();
  check('published Gallery module excludes its photos from the surrounding layout', await publicPage.locator('.story-inline-gallery img').count() === 2 && await publicPage.locator('article img').count() === 2 && await publicPage.locator('[data-photo-layout]').count() === 0);
  legacyId = await createLegacy(); await saveLegacy('heroGrid'); await uploadLegacy();
  await page.goto(BASE + `/admin/drafts/${legacyId}`);
  await page.locator('[data-studio-tab=settings]').click();
  await page.locator('[name=announcementKind]').selectOption('event');
  await page.locator('[name=eventDate]').fill('2026-12-01'); await page.locator('[name=eventLocation]').fill('Synthetic Hall <north>');
  await page.locator('[name=announcementLink0Label]').fill('Register'); await page.locator('[name=announcementLink0Url]').fill('https://example.invalid/register');
  await page.locator('[name=announcementVideo]').fill('https://youtu.be/abcdefghijk');
  const flyerPhotoId = db.prepare('SELECT id FROM draft_photos WHERE draft_id=?').get(legacyId).id;
  await page.locator('[name="photo_' + flyerPhotoId + '_zoom"]').evaluate((el) => { el.value = '3'; });
  await page.locator('[data-studio-tab=content]').click(); await page.locator('#use-modules').click();
  await page.locator('[data-add-module="flyer"]').click();
  await page.locator('[data-studio-tab=photos]').click(); await page.locator('[name="photo_' + flyerPhotoId + '_alt"]').fill('Corrected synthetic flyer description'); await page.locator('[data-studio-tab=content]').click();
  await page.locator('[data-add-module="video"]').click(); await page.locator('[data-module-field=label]').fill('Synthetic event overview'); await page.locator('[data-module-field=url]').fill('https://vimeo.com/12345678');
  await page.locator('[data-add-module="button"]').click(); await page.locator('[data-module-field=label]').fill('Event page'); await page.locator('[data-module-field=url]').fill('https://example.invalid/event');
  await page.waitForFunction(() => { const doc = document.getElementById('preview')?.contentDocument; return doc?.querySelector('.story-flyer img') && doc.querySelectorAll('.story-module-video a').length === 2; });
  check('announcement private preview shows the full flyer and safe provider links without players', await page.frameLocator('#preview').locator('iframe,[data-load-video]').count() === 0 && await page.frameLocator('#preview').locator('.story-flyer img').evaluate((img) => img.alt === 'Corrected synthetic flyer description' && !img.style.scale && !img.style.aspectRatio.includes('16')));
  const announcementSave = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${legacyId}/save` && response.request().method() === 'POST');
  await page.locator('#save-btn').click(); assert.equal((await announcementSave).status(), 200); await publishLegacy();
  check('announcement publishes details, module links and one uncropped flyer', await publicPage.locator('.story-flyer img').count() === 1 && await publicPage.locator('article img').count() === 1 && (await publicPage.locator('.announcement-details').innerText()).includes('Synthetic Hall <north>') && await publicPage.getByRole('link', { name: 'Event page', exact: true }).count() === 1);
  check('announcement video players make no embedded request before reader action', await publicPage.locator('iframe').count() === 0 && await publicPage.locator('[data-load-video]').count() === 2);
  const mediaFeed = await (await fetch(BASE + '/stories.json')).json();
  check('feed keeps version1 and adds typed announcement fields', mediaFeed.version === 1 && mediaFeed.stories.find((s) => s.id === legacyDraft().slug)?.announcement?.kind === 'event');
  for (const width of [1440, 390]) {
    await publicPage.setViewportSize({ width, height: 1000 });
    check(`flyer stays full aspect and article fits at ${width}px`, await publicPage.locator('.story-flyer img').evaluate((img) => Math.abs(img.getBoundingClientRect().height / img.getBoundingClientRect().width - img.naturalHeight / img.naturalWidth) < .02 && !img.style.scale && document.documentElement.scrollWidth <= innerWidth));
    if (shots) await publicPage.screenshot({ path: path.join(shots, `announcement-story-${width}.png`), fullPage: true });
  }
  if (process.env.AXE_JS) { await publicPage.addScriptTag({ path: process.env.AXE_JS }); const scan = await publicPage.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })); check('announcement details, flyer, buttons and video affordances pass axe', scan.violations.length === 0); }
  await publicPage.getByRole('button', { name: 'Play video: Announcement video', exact: true }).focus(); await publicPage.keyboard.press('Enter');
  check('keyboard Play loads only the derived privacy-provider iframe with a title', await publicPage.locator('iframe').count() === 1 && await publicPage.locator('iframe').getAttribute('src') === 'https://www.youtube-nocookie.com/embed/abcdefghijk?rel=0' && await publicPage.locator('iframe').getAttribute('title') === 'Announcement video');
  legacyId = await createLegacy(); await saveLegacy('one', 'Synthetic inline flyer.\n\n{{photo 1}}\n\nEvent summary.'); await uploadLegacy();
  const markerForm = new FormData(); for (const [key, value] of Object.entries({ version: legacyDraft().updated_at, title: 'Synthetic inline flyer', author: 'Synthetic Editor', section: 'news', area: 'conference', date: legacyDraft().date, body: legacyDraft().body, announcementKind: 'announcement' })) markerForm.set(key, String(value));
  assert.equal((await post(`/api/admin/drafts/${legacyId}/save`, markerForm)).status, 200);
  const markerPreview = await (await post(`/api/admin/drafts/${legacyId}/preview`, markerForm)).json();
  check('announcement inline marker preview shows one full flyer', (markerPreview.doc.match(/<img /g) || []).length === 1 && markerPreview.doc.includes('story-inline-photo story-flyer'));
  await publishLegacy(); check('announcement inline marker publishes one full flyer with no crop', await publicPage.locator('article img').count() === 1 && await publicPage.locator('.story-flyer img').evaluate((img) => !img.style.scale && img.style.aspectRatio === 'auto'));
  await publicPage.goto(BASE + '/announcements/');
  check('public board lists live event and announcement types and exposes navigation', await publicPage.locator('[data-board-kind=event]').count() === 1 && await publicPage.locator('[data-board-kind=announcement]').count() === 1 && await publicPage.locator('.nav a[aria-current=page][href="/announcements/"]').count() === 1);
  await publicPage.getByRole('button', { name: /^Events / }).click();
  check('board filters events and announces its result count', await publicPage.locator('[data-board-kind]:visible').count() === 1 && await publicPage.locator('#board-count').textContent() === '1 update');
  await publicPage.getByRole('button', { name: /^All updates / }).click();
  for (const width of [1440, 390]) {
    await publicPage.setViewportSize({ width, height: 1000 });
    check(`announcements board fits at ${width}px without flyer cropping`, await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.board-flyer img')].every((img) => getComputedStyle(img).objectFit === 'contain')));
    if (shots) await publicPage.screenshot({ path: path.join(shots, `announcements-board-${width}.png`), fullPage: true });
  }
  if (process.env.AXE_JS) { await publicPage.addScriptTag({ path: process.env.AXE_JS }); const boardAxe = await publicPage.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })); check('public announcements board passes axe', boardAxe.violations.length === 0); }
  const boardSource = await (await fetch(BASE + '/announcements/')).text();
  check('board server response contains both types and no private photo endpoint', (boardSource.match(/data-board-kind=/g) || []).length === 2 && !boardSource.includes('/api/admin/photos/'));
  // Prime the origin cache, then a human-only local test action removes the announcement.
  const hideAnnouncement = new FormData(); hideAnnouncement.set('slug', legacyDraft().slug);
  const unlisted = await post('/api/admin/stories/unpublish', hideAnnouncement);
  check('local human unpublish succeeds', unlisted.status === 303);
  const boardAfter = await (await fetch(BASE + '/announcements/')).text();
  check('unpublish immediately invalidates cached board and removes that announcement', !boardAfter.includes('data-board-kind="announcement"') && boardAfter.includes('data-board-kind="event"'));
  legacyId = await createLegacy(); await saveLegacy('one'); await uploadLegacy();
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(BASE + `/admin/drafts/${legacyId}`); await page.locator('[data-studio-tab=content]').click(); await page.locator('#use-modules').click();
  await page.locator('[data-add-module=section]').click();
  const sectionState = JSON.parse(await page.locator('#story-blocks').inputValue()), section = sectionState.at(-1);
  check('Section inserts two columns with distinct stable paragraph IDs', section.type === 'section' && section.content.length === 2 && section.content[0][0].id !== section.content[1][0].id && await page.locator('#module-count').textContent() === '4');
  const choose = async (id) => page.locator(`[data-select-module="${id}"]`).click();
  await choose(section.content[0][0].id); await page.locator('[data-module-field=text]').fill('Synthetic left column text.');
  await page.locator('[data-add-module=image]').click();
  await choose(section.content[1][0].id); await page.locator('[data-module-field=text]').fill('Synthetic right column text.');
  const beforeCrossDrop = await page.locator('#story-blocks').inputValue();
  await page.locator(`#module-outline [data-module-id="${section.content[0][0].id}"]`).evaluate((target, id) => { const dataTransfer = new DataTransfer(); dataTransfer.setData('text/plain', id); target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer })); }, section.content[1][0].id);
  check('cross-column drag is rejected visibly without reordering the source', await page.locator('#story-blocks').inputValue() === beforeCrossDrop && (await page.locator('#module-status').textContent()).includes('Move to column'));
  await page.getByRole('button', { name: 'Move to column 1', exact: true }).click();
  check('child modules can move across columns without losing content', JSON.parse(await page.locator('#story-blocks').inputValue()).at(-1).content[0].at(-1).text === 'Synthetic right column text.');
  await page.getByRole('button', { name: 'Move to column 2', exact: true }).click();
  await choose(section.id); const beforeSectionDuplicate = await page.locator('#story-blocks').inputValue();
  await page.getByRole('button', { name: 'Duplicate module', exact: true }).click();
  const duplicatedSections = JSON.parse(await page.locator('#story-blocks').inputValue()); const flattenedSections = duplicatedSections.flatMap((b) => [b, ...(b.content?.flat() ?? [])]);
  check('section duplication regenerates every descendant ID', new Set(flattenedSections.map((b) => b.id)).size === flattenedSections.length && duplicatedSections.at(-1).content[0][0].text === 'Synthetic left column text.');
  await page.locator('#blocks-undo').click(); check('section duplication is one undo step', await page.locator('#story-blocks').inputValue() === beforeSectionDuplicate);
  await page.getByLabel('Section columns', { exact: true }).selectOption('1');
  check('changing to one column preserves all children in reading order', JSON.parse(await page.locator('#story-blocks').inputValue()).at(-1).content[0].length === 3);
  await page.locator('#blocks-undo').click();
  await page.waitForFunction((id) => document.getElementById('preview')?.contentDocument?.querySelector(`[data-module-id="${id}"]`), section.content[1][0].id);
  await page.frameLocator('#preview').locator(`[data-module-id="${section.content[1][0].id}"]`).focus(); await page.frameLocator('#preview').locator(`[data-module-id="${section.content[1][0].id}"]`).press('Enter');
  check('keyboard canvas selection opens a nested child inspector', await page.locator('[data-module-field=text]').inputValue() === 'Synthetic right column text.');
  const sectionSave = page.waitForResponse((response) => response.url() === BASE + `/api/admin/drafts/${legacyId}/save` && response.request().method() === 'POST'); await page.locator('#save-btn').click(); assert.equal((await sectionSave).status(), 200); await publishLegacy();
  for (const [width, columns] of [[1440, 2], [390, 1]]) { await publicPage.setViewportSize({ width, height: 1000 }); check(`section reads in ${columns} columns at ${width}px`, await publicPage.locator('.story-section').evaluate((el, n) => getComputedStyle(el).gridTemplateColumns.split(' ').length === n && el.textContent.indexOf('left column') < el.textContent.indexOf('right column') && document.documentElement.scrollWidth <= innerWidth, columns)); if (shots) await publicPage.screenshot({ path: path.join(shots, `story-sections-${width}.png`), fullPage: true }); }
  check('nested image appears once and section source order survives publishing', await publicPage.locator('article img').count() === 1 && await publicPage.locator('.story-section img').count() === 1);
  const brokenData = path.join(scratch, 'synthetic-broken-db'); fs.mkdirSync(brokenData); fs.writeFileSync(path.join(brokenData, 'imconnected.db'), 'synthetic invalid sqlite fixture');
  const unavailableServer = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT + 1), DATA_DIR: brokenData, SITE_URL: `http://localhost:${PORT + 1}`, AUTH_SECRET: 'synthetic-unavailable-' + 'x'.repeat(32), RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', PUBLISH_TOKEN: '', AGENT_API_TOKEN: '' }, stdio: 'ignore' });
  try {
    let unavailableResponse;
    for (let attempt = 0; attempt < 80; attempt++) { try { unavailableResponse = await fetch(`http://localhost:${PORT + 1}/announcements/`); break; } catch { await sleep(100); } }
    check('unreadable database makes the board503/no-store with no frozen archive fallback', unavailableResponse?.status === 503 && unavailableResponse.headers.get('cache-control') === 'no-store' && !(await unavailableResponse.text()).includes('data-board-kind'));
  } finally { const stopped = new Promise((resolve) => unavailableServer.once('exit', resolve)); unavailableServer.kill('SIGTERM'); await Promise.race([stopped, sleep(2000)]); if (unavailableServer.exitCode === null) unavailableServer.kill('SIGKILL'); }
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
