#!/usr/bin/env node
// Browser integration of the built editor. Synthetic local data only; no credentials or external services.
// npm run build
// PLAYWRIGHT_ROOT=/workspace/.tools/browser CHROMIUM_PATH=/usr/bin/chromium node scripts/test-story-builder-ui.mjs
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
const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
const { chromium } = require('playwright');
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
  for (const [name, value] of Object.entries({ version: draft().updated_at, title: 'Synthetic modular editor integration', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: legacy, photoLayout: 'one' })) initial.set(name, String(value));
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

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Secure cookies are accepted for localhost by Chromium, matching the application's local development contract.
  await context.addCookies([{ name: '__Host-imc_session', value: token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await context.route('**/*', (route) => { const url = new URL(route.request().url()); return url.origin === BASE || url.protocol === 'data:' || url.protocol === 'about:' ? route.continue() : route.abort(); });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(BASE + draftPath);
  await page.locator('#use-modules').click();
  const blocks = () => page.locator('#story-blocks').inputValue().then(JSON.parse);
  check('enabling modules preserves the complete legacy Markdown', (await blocks())[0].text === legacy);
  await page.locator('[data-add-module="heading"]').click();
  await page.locator('[data-module-field="text"]').fill('A synthetic heading');
  await page.getByRole('button', { name: 'Move module 2 up', exact: true }).click();
  check('accessible Move controls reorder actual module state', (await blocks())[0].type === 'heading');
  await page.getByRole('button', { name: 'Duplicate module', exact: true }).click();
  check('duplicate creates a distinct stable module ID', (await blocks()).length === 3 && new Set((await blocks()).map((b) => b.id)).size === 3);
  await page.locator('#blocks-undo').click();
  check('Undo restores the module list', (await blocks()).length === 2);
  await page.locator('#blocks-redo').click();
  check('Redo restores the duplicated module', (await blocks()).length === 3);
  await page.locator('#blocks-undo').click();
  await page.locator('[data-add-module="list"]').click();
  await page.locator('[data-module-field="items"]').fill('First synthetic item\nSecond synthetic item');
  await page.locator('[data-add-module="button"]').click();
  await page.locator('[data-module-field="label"]').fill('Synthetic details');
  await page.locator('[data-module-field="url"]').fill('https://example.invalid/synthetic-details');
  await page.locator('[data-add-module="image"]').click();
  await page.locator('[data-module-field="alt"]').fill('Synthetic image used only in this test');
  await page.locator('[data-add-module="quote"]').click();
  await page.locator('[data-module-field="text"]').fill('A synthetic quoted statement.');
  await page.locator('[data-add-module="divider"]').click();
  const expected = await blocks();
  check('all seven supported module types are represented', new Set(expected.map((b) => b.type)).size === 7);

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
  const axePath = process.env.AXE_JS || '/workspace/.tools/a11y/node_modules/axe-core/axe.min.js';
  if (fs.existsSync(axePath)) {
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
  if (shots) await page.screenshot({ path: path.join(shots, 'story-builder-mobile.png') });
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
  const focus = await publicPage.locator('.story-module-image img').evaluate((image) => image.style.objectPosition);
  check('published image uses the persisted focal point', focus === `${x}% ${y}%`);
  check('published action link remains functional content', await publicPage.locator('article a[href="https://example.invalid/synthetic-details"]').count() === 1);
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
