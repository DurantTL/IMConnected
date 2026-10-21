#!/usr/bin/env node
// Responsive and accessibility validation of the built public site. Local data only.
// npm run build
// [PLAYWRIGHT_ROOT=<folder>] [CHROMIUM_PATH=<browser>] [CHROMIUM_NO_SANDBOX=1] [AXE_JS=<axe.min.js>] node scripts/test-design-review.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Playwright is not a dependency of this repo. PLAYWRIGHT_ROOT (a folder whose node_modules has it) overrides the normal resolution.
const playwrightRequire = process.env.PLAYWRIGHT_ROOT ? createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json')) : createRequire(import.meta.url);
const { chromium } = (() => {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { return playwrightRequire(spec); } catch { /* try the next */ } }
  throw new Error('Playwright was not found. Install it or set PLAYWRIGHT_ROOT to a folder whose node_modules has it.');
})();
// CHROMIUM_PATH picks a browser; CHROMIUM_NO_SANDBOX=1 adds --no-sandbox (needed only when running as root, e.g. in a container).
const launchOptions = () => ({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
const PORT = Number(process.env.PORT || 4805);
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-design-review-'));
const artifacts = path.resolve(process.env.SHOTS || path.join(scratch, 'artifacts'));
// axe-core is not a dependency either: AXE_JS, else whatever 'axe-core' resolves to.
const axePath = process.env.AXE_JS || (() => { try { return playwrightRequire.resolve('axe-core/axe.min.js'); } catch { return ''; } })();
assert.ok(axePath && fs.existsSync(axePath), 'Set AXE_JS to an installed axe.min.js (axe-core is not a dependency of this repo)');
fs.mkdirSync(artifacts, { recursive: true });
const results = [];
const logs = [];
let browser;
let checks = 0;
const check = (message, value) => { assert.ok(value, message); checks++; console.log(`PASS ${message}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Screenshot fixtures must never adopt real stories from the frozen archive.
// Seed a migrated throwaway database before the server can open it.
const fixtureDb = openDatabase(scratch);
try {
  runMigrations(fixtureDb, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  const now = Date.now();
  fixtureDb.prepare("INSERT INTO app_state(key,value,updated_at) VALUES ('git_adopted_at',?,?)").run(String(now), now);
  const fixtures = [
    ['news', 'conference', 'A connected community starts with a shared story'],
    ['news', 'churches', 'A place to share stories of faith'],
    ['news', 'schools', 'Learning together, growing together'],
    ['news', 'camp', 'Room to explore and connect'],
    ['features', null, 'The stories that bring us together'],
    ['columns', null, 'A moment to pause and reflect'],
    ['youth', 'pathfinders', 'Discovering purpose through service'],
    ['kids', null, 'Small questions, bright discoveries'],
  ];
  const insert = fixtureDb.prepare(`INSERT INTO stories
    (slug,title,dek,section,area,author,date,featured,body,source,published_at,updated_at)
    VALUES (?,?,?,?,?,'Synthetic Editor','2026-10-21',?,?, 'editor',?,?)`);
  for (const [i, [section, area, title]] of fixtures.entries()) {
    insert.run(`synthetic-design-${i + 1}`, title, 'Synthetic design example for the IMConnected story magazine.', section, area, Number(i === 0),
      'This synthetic church story is a design fixture. It demonstrates the reading layout, section navigation and story search without using real people or submissions.\n\n## A shared story\n\nEvery community has a story to share. This example contains no report of a real event.', now, now);
  }
} finally {
  fixtureDb.close();
}
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
  check('design evidence contains only the eight synthetic fixture stories', feed.stories.length === 8 && feed.stories.every((story) => story.id.startsWith('synthetic-design-')));
  const sampleStory = feed.stories.find((story) => story.image) || feed.stories[0];
  const storyPath = new URL(sampleStory.url).pathname;
  const targets = [ ['home', '/'], ['section', '/news/'], ['story', storyPath], ['submit', '/submit/'], ['search', '/search/?q=church'], ['login', '/admin/login'] ];
  browser = await chromium.launch(launchOptions());
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
      if (width === 1440 && ['home', 'section', 'story', 'submit', 'search'].includes(name)) {
        const current = await page.evaluate(() => ({
          latest: document.querySelector('.nav a[href="/"]')?.getAttribute('aria-current') ?? null,
          search: document.querySelector('.header-search')?.getAttribute('aria-current') ?? null,
          mobileLatest: !!document.querySelector('.mobile-nav a[href="/"]'),
          sections: [...document.querySelectorAll('.nav a[aria-current]')].map((a) => a.getAttribute('href')),
        }));
        check(`${name}: the header marks only the current page (Latest on home, Search on search, nothing else on other pages)`,
          (current.latest === 'page') === (name === 'home') && (current.search === 'page') === (name === 'search') && current.sections.length === (name === 'home' ? 1 : name === 'section' || name === 'story' ? 1 : 0) && current.mobileLatest);
      }
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
