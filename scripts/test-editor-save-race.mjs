#!/usr/bin/env node
// Actual editor client, synthetic page and intercepted local requests only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-editor-save-race-'));
const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
const { chromium } = require('playwright');
let browser;
try {
  const bundle = path.join(scratch, 'editor.js');
  await build({ input: path.join(root, 'src/scripts/draft-editor.ts'), output: { file: bundle, format: 'iife' }, platform: 'browser' });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const saves = [];
  let published = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route('http://editor.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/save') {
      saves.push(route.request().postData());
      if (saves.length === 1) await pending;
      await route.fulfill({ json: { ok: true, updatedAt: saves.length + 1, savedBy: 'Synthetic Editor' } });
    } else if (pathname === '/preview') await route.fulfill({ json: { ok: true, doc: '<p>Private preview</p>' } });
    else if (pathname === '/publish') {
      published++;
      assert.equal(saves.length, 2, 'Publish must wait for a second save of the newer edits');
      await route.fulfill({ status: 204 });
    } else await route.fulfill({ contentType: 'text/html', body: `
      <form id="draft-form" data-save="/save" data-preview="/preview"><fieldset>
        <textarea id="f-body" name="body">Initial story</textarea>
        <select id="f-section"><option value="news">News</option></select>
        <select id="f-area"><option value="" data-section="news">None</option></select>
        <div id="f-column-wrap"></div><input name="version" value="1">
        <button id="save-btn" type="submit">Save</button></fieldset></form>
      <div id="save-status"></div><div id="conflict" hidden></div><iframe id="preview"></iframe><div id="split"></div>
      <form id="publish-form" action="/publish" method="post"><input name="version" value="1"><button id="publish" type="submit">Publish</button></form>` });
  });
  await page.goto('http://editor.test/');
  await page.addScriptTag({ content: fs.readFileSync(bundle, 'utf8') });
  await page.fill('#f-body', 'First saved text');
  await page.click('#save-btn');
  for (let i = 0; i < 50 && !saves.length; i++) await page.waitForTimeout(20);
  assert.equal(saves.length, 1);
  await page.fill('#f-body', 'Newer text typed while saving');
  await page.click('#publish');
  assert.equal(published, 0, 'Publish must wait while the first save is pending');
  release();
  for (let i = 0; i < 100 && !published; i++) await page.waitForTimeout(20);
  assert.equal(published, 1);
  assert.equal(saves.length, 2);
  assert.ok(saves[0].includes('First saved text'));
  assert.ok(saves[1].includes('Newer text typed while saving'));
  console.log('PASS pending-save publishing flushes the latest edits before submitting');
} finally {
  await browser?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
