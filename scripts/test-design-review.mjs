#!/usr/bin/env node
// Responsive and accessibility validation of the built public site. Local data only.
// npm run build
// PLAYWRIGHT_ROOT=/workspace/.tools/browser CHROMIUM_PATH=/usr/bin/chromium node scripts/test-design-review.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
const { chromium } = require('playwright');
const PORT = Number(process.env.PORT || 4805);
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-design-review-'));
const artifacts = path.resolve(process.env.SHOTS || path.join(scratch, 'artifacts'));
const axePath = process.env.AXE_JS || '/workspace/.tools/a11y/node_modules/axe-core/axe.min.js';
assert.ok(fs.existsSync(axePath), 'AXE_JS must point to an installed axe.min.js');
fs.mkdirSync(artifacts, { recursive: true });
const results = [];
const logs = [];
let browser;
let checks = 0;
const check = (message, value) => { assert.ok(value, message); checks++; console.log(`PASS ${message}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  cwd: ROOT,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), SITE_URL: BASE, DATA_DIR: scratch,
    AUTH_SECRET: 'synthetic-design-review-secret-' + 'x'.repeat(32), RESEND_API_KEY: '',
    GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '',
    PUBLISH_TOKEN: '', AGENT_API_TOKEN: '', TURNSTILE_SECRET_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (data) => logs.push(String(data)));
server.stderr.on('data', (data) => logs.push(String(data)));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Built server stopped: ${logs.join('')}`);
    try { if ((await fetch(BASE + '/admin/login')).status === 200) { ready = true; break; } } catch {}
    await sleep(100);
  }
  check('built design-review server starts with throwaway data', ready);
  const feedResponse = await fetch(BASE + '/stories.json');
  assert.equal(feedResponse.status, 200);
  const feed = await feedResponse.json();
  assert.ok(feed.stories.length > 0, 'Archive adoption must supply a real story to review');
  const sampleStory = feed.stories.find((story) => story.image) || feed.stories[0];
  const storyPath = new URL(sampleStory.url).pathname;
  const targets = [ ['home', '/'], ['section', '/news/'], ['story', storyPath], ['submit', '/submit/'], ['search', '/search/?q=church'], ['login', '/admin/login'] ];
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ colorScheme: 'light' });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === BASE || ['data:', 'about:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  for (const width of [360, 390, 768, 1024, 1440]) {
    for (const [name, url] of targets) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 1000 });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      const response = await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
      await page.locator('main').waitFor();
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.equal(dimensions.width, width, 'The responsive check must use its requested viewport');
      const overflow = await page.locator('body *').evaluateAll((nodes) => nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        const css = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && css.position !== 'absolute' && (rect.right > innerWidth + 1 || rect.left < -1);
      }).slice(0, 8).map((node) => ({ tag: node.tagName, id: node.id, class: node.className, right: node.getBoundingClientRect().right, text: node.textContent.slice(0, 80) })));
      await page.addScriptTag({ path: axePath });
      const axe = await page.evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
        return result.violations.map(({ id, impact, help, nodes }) => ({ id, impact, help, nodes: nodes.map(({ html, target, failureSummary }) => ({ html, target, failureSummary })) }));
      });
      results.push({ name, url, width, status: response.status(), dimensions, overflow, errors, violations: axe });
      fs.writeFileSync(path.join(artifacts, 'public-design-results.json'), JSON.stringify(results, null, 2));
      if (width === 390 || width === 1440) await page.screenshot({ path: path.join(artifacts, `${name}-${width}.png`) });
      check(`${name} at ${width}px responds successfully`, response.status() === 200);
      check(`${name} at ${width}px has no horizontal page overflow`, dimensions.scroll <= dimensions.width);
      check(`${name} at ${width}px has no uncaught script errors`, errors.length === 0);
      if (name === 'home' && width < 921) {
        const toggle = page.locator('.menu-toggle');
        await toggle.focus(); await page.keyboard.press('Enter');
        check(`mobile menu opens with keyboard at ${width}px`, await toggle.getAttribute('aria-expanded') === 'true');
        await page.keyboard.press('Escape');
        check(`Escape closes menu and restores focus at ${width}px`, await toggle.getAttribute('aria-expanded') === 'false' && await toggle.evaluate((node) => node === document.activeElement));
      }
      await page.close();
    }
  }
  const violations = results.filter((result) => result.violations.length);
  if (violations.length) console.error(JSON.stringify(violations.map(({ name, width, violations }) => ({ name, width, violations })), null, 2));
  check('all reviewed public screens pass axe WCAG A/AA checks', violations.length === 0);
  console.log(`\n${checks} design review checks passed across ${results.length} responsive screens.`);
} catch (error) {
  console.error(error);
  console.error(logs.join('').slice(-8000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([stopped, sleep(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (process.env.SHOTS) console.log(`Design evidence: ${artifacts}`);
  fs.rmSync(scratch, { recursive: true, force: true });
}
