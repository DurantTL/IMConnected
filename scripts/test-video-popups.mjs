// Synthetic Studio video UI/export regression. Intercept every request, including provider players.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
const { chromium } = require('playwright');
if (!process.env.STUDIO_HTML) throw new Error('Set STUDIO_HTML');
const html = fs.readFileSync(process.env.STUDIO_HTML, 'utf8'), BASE = 'http://localhost:4808';
let count = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log('PASS ' + name); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const network = [], errors = [];
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url()); network.push(u.href);
    if (u.origin === BASE && u.pathname === '/imconnected.html') return route.fulfill({ contentType: 'text/html', body: html });
    if (['www.youtube-nocookie.com', 'player.vimeo.com'].includes(u.hostname)) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Synthetic player</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#18242c;color:#e9f3f5;font:16px Arial,sans-serif;text-align:center}</style></head><body><main>Local mock video player</main></body></html>' });
    return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
  page.setDefaultTimeout(10000);
  await page.goto(BASE + '/imconnected.html'); await page.waitForFunction(() => window.IMStudio?.Store?.getDocument());
  await page.waitForFunction(() => document.getElementById('templateDialog')?.open);
  await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); const doc = IMStudio.Templates.create('blank'); doc.blocks = []; IMStudio.Store.replaceDocument(doc, { record: false }); });
  await page.locator('#addBlockBtn').click(); await page.locator('[data-block-type=video]').click();
  check('Video is a first-class module available from the block library', await page.evaluate(() => IMStudio.Store.getSelectedBlock().type === 'video'));
  await page.getByLabel('Video title', { exact: true }).fill('Synthetic overview <safe>');
  await page.getByLabel('YouTube or Vimeo URL', { exact: true }).fill('https://youtu.be/abcdefghijk?t=10');
  const providerRequests = () => network.filter((u) => /youtube|vimeo/.test(u));
  check('pasting a video URL loads no external player', providerRequests().length === 0 && await page.locator('iframe:not(#previewFrame)').count() === 0);
  const preview = page.getByRole('button', { name: 'Preview video popup', exact: true });
  await preview.focus(); await page.keyboard.press('Enter');
  check('keyboard preview opens one native dialog with a derived player', await page.locator('dialog.im-video-dialog').evaluate((d) => d.open) && await page.locator('.im-video-dialog iframe').getAttribute('src') === 'https://www.youtube-nocookie.com/embed/abcdefghijk?rel=0');
  check('video title renders literally and close control receives focus', await page.locator('.im-video-dialog h2').textContent() === 'Synthetic overview <safe>' && await page.getByRole('button', { name: 'Close video', exact: true }).evaluate((b) => b === document.activeElement));
  if (process.env.AXE_JS) { await page.addScriptTag({ path: process.env.AXE_JS }); const result = await page.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })); if (result.violations.length) console.log(JSON.stringify(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })) })))); check('Studio video dialog passes axe', result.violations.length === 0); }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.im-video-dialog')?.open && !document.querySelector('.im-video-dialog iframe'));
  check('Escape stops playback, clears the frame, and restores preview-button focus', await page.locator('.im-video-dialog iframe').count() === 0 && await preview.evaluate((b) => b === document.activeElement));
  await page.getByLabel('YouTube or Vimeo URL', { exact: true }).fill('https://vimeo.com/12345678'); await preview.click();
  check('subsequent Vimeo playback reuses the same popup', await page.locator('dialog.im-video-dialog').count() === 1 && await page.locator('.im-video-dialog iframe').getAttribute('src') === 'https://player.vimeo.com/video/12345678');
  await page.getByRole('button', { name: 'Close video', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.im-video-dialog')?.open && !document.querySelector('.im-video-dialog iframe'));
  check('Close stops the Vimeo player', await page.locator('.im-video-dialog iframe').count() === 0);
  await page.evaluate(() => IMStudio.Store.persistNow()); await page.reload(); await page.waitForFunction(() => window.IMStudio?.Store?.getDocument());
  check('Video modules survive save and reload with title and URL', await page.evaluate(() => { const b = IMStudio.Store.getDocument().blocks[0]; return b.type === 'video' && b.title === 'Synthetic overview <safe>' && b.videoUrl === 'https://vimeo.com/12345678'; }));
  const output = await page.evaluate(() => { const d = IMStudio.Store.getDocumentClone(); d.blocks.push(IMStudio.Templates.makeBlock('eventList', { events: [IMStudio.Templates.event({ name: 'Synthetic announcement', videoUrl: 'https://youtu.be/abcdefghijk' })] })); return { email: IMStudio.Renderer.renderEmail(d), web: IMStudio.Renderer.renderWeb(d), wp: IMStudio.Renderer.renderWordPressBlocks(d), serialized: JSON.stringify(d) }; });
  check('email retains watch links without embedded players, dialogs or script', output.email.includes('https://vimeo.com/12345678') && !/<iframe|<dialog|<script|data-video-popup/i.test(output.email));
  check('WordPress export emits a native provider embed, never raw iframe/script', output.wp.includes('<!-- wp:embed') && output.wp.includes('"providerNameSlug":"vimeo"') && !/<iframe|<script/i.test(output.wp));
  check('saved newsletter carries data only, with no popup DOM or credentials', !/iframe|im-video-dialog|Authorization|Bearer/.test(output.serialized));
  const web = await context.newPage(); web.on('pageerror', (e) => errors.push(String(e)));
  const beforeWeb = providerRequests().length;
  await web.setContent(output.web);
  check('website HTML is self-contained and loads no player on page load', await web.locator('a[data-video-popup]').count() === 2 && await web.locator('iframe').count() === 0 && providerRequests().length === beforeWeb);
  const link = web.locator('a[data-video-popup]').first(); await link.focus(); await web.keyboard.press('Enter');
  check('exported website opens standalone video in a popup', await web.locator('.im-video-dialog').evaluate((d) => d.open) && await web.locator('iframe').getAttribute('src') === 'https://player.vimeo.com/video/12345678');
  await web.frameLocator('.im-video-dialog iframe').getByText('Local mock video player').waitFor();
  for (const width of [1440, 390]) {
    await web.setViewportSize({ width, height: 900 });
    check('exported popup fits viewport at ' + width + 'px', await web.locator('.im-video-dialog').evaluate((d) => { const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await web.screenshot({ path: path.join(process.env.SHOTS, `studio-video-${width}.png`), fullPage: true }); }
  }
  await web.keyboard.press('Escape');
  await web.waitForFunction(() => !document.querySelector('.im-video-dialog')?.open && !document.querySelector('.im-video-dialog iframe'));
  check('website Escape removes player and restores source link focus', await web.locator('iframe').count() === 0 && await link.evaluate((a) => a === document.activeElement));
  await web.locator('a[data-video-popup]').last().click();
  check('announcement video also opens the derived YouTube popup', await web.locator('iframe').getAttribute('src') === 'https://www.youtube-nocookie.com/embed/abcdefghijk?rel=0');
  await web.mouse.click(2, 2);
  await web.waitForFunction(() => !document.querySelector('.im-video-dialog')?.open && !document.querySelector('.im-video-dialog iframe'));
  check('website backdrop click stops the player', await web.locator('iframe').count() === 0 && !await web.locator('.im-video-dialog').evaluate((d) => d.open));
  const hostile = await page.evaluate(() => ['javascript:alert(1)', 'https://youtube.com.evil.invalid/watch?v=abcdefghijk', 'https://youtube.com:444/watch?v=abcdefghijk', 'https://youtube.com@evil.invalid/watch?v=abcdefghijk', '<iframe src=x>', 'http://vimeo.com/123', 'https://vimeo.com/123/anything'].map((url) => { const d = IMStudio.Templates.create('blank'); d.blocks = [IMStudio.Templates.makeBlock('video', { title: '</script><img src=x onerror=alert(1)>', videoUrl: url })]; return { allowed: IMStudio.Utils.announcementVideo(url), html: IMStudio.Renderer.renderWeb(d), issues: IMStudio.Validation.validate(d) }; }));
  check('hostile URLs fail validation and never become popup targets or raw HTML', hostile.every((r) => !r.allowed && !r.html.includes('data-video-popup data-video-title=') && !r.html.includes('<img src=x onerror=') && r.issues.some((i) => i.severity === 'error' && i.path === 'videoUrl')));
  check('normal video labels cannot break out of an exported script', !output.web.includes('<safe>') && output.web.includes('&lt;safe&gt;'));
  check('hostile titles with a valid video remain text and cannot create executable markup', await page.evaluate(() => { const d = IMStudio.Templates.create('blank'); d.blocks = [IMStudio.Templates.makeBlock('video', { title: '</script><img src=x onerror=alert(1)>', videoUrl: 'https://vimeo.com/12345678' })]; const html = IMStudio.Renderer.renderWeb(d), parsed = new DOMParser().parseFromString(html, 'text/html'); return parsed.querySelectorAll('script').length === 1 && !parsed.querySelector('img,[onerror]') && parsed.querySelector('a[data-video-popup]').dataset.videoTitle === '</script><img src=x onerror=alert(1)>'; }));
  const noScript = await browser.newContext({ javaScriptEnabled: false }); const fallback = await noScript.newPage(); await fallback.setContent(output.web);
  check('without JavaScript, provider watch links remain available', await fallback.locator('a[href="https://vimeo.com/12345678"]').count() === 1 && await fallback.locator('iframe').count() === 0);
  await noScript.close();
  check('Studio and website popup workflows have no uncaught JavaScript errors', errors.length === 0);
  console.log(`\n${count} video popup checks passed.`);
} finally { await browser.close(); }
