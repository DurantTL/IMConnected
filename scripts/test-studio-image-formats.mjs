// Synthetic image bytes and intercepted requests only. Run for each authorized Studio HTML file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/workspace/.tools/browser', 'package.json'));
const { chromium } = require('playwright');
if (!process.env.STUDIO_HTML) throw new Error('Set STUDIO_HTML to the builder under test.');
const html = fs.readFileSync(process.env.STUDIO_HTML, 'utf8'), base = 'http://localhost:4813', wp = 'https://wp.synthetic.invalid';
const token = 'synthetic-format-import-token', formats = ['webp', 'avif'];
const fixtures = formats.map((ext) => fs.readFileSync(new URL(`./fixtures/synthetic-photo.${ext}`, import.meta.url)));
const fixture = { ok: true, stories: [], drafts: formats.map((ext, i) => ({ id: 71 + i, title: 'Synthetic ' + ext + ' flyer', dek: 'A synthetic announcement with an original flyer.', section: 'news', sectionLabel: 'News', source: 'agent', status: 'new', announcement: { kind: 'announcement', links: [] }, draftFlyer: { draftId: 71 + i, photoId: 81 + i, key: String(i + 1).repeat(32), alt: 'Synthetic full-aspect flyer' } })) };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log('PASS ' + label); };
async function setup(connected) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), uploads = [], errors = [], transfers = [];
  page.on('pageerror', (e) => errors.push(String(e))); page.setDefaultTimeout(10000);
  if (connected) await page.addInitScript(({ wp }) => sessionStorage.setItem('imconnected_studio_wp_session', JSON.stringify({ siteUrl: wp, username: 'synthetic-editor', token: 'synthetic-basic-auth' })), { wp });
  await page.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base && url.pathname === '/imconnected.html') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.origin === base && url.pathname === '/api/stories') return route.fulfill({ json: fixture });
    if (url.origin === base && url.pathname === '/api/studio-draft-flyer') {
      const at = Number(url.searchParams.get('draftId')) - 71; transfers.push(request.headers().authorization);
      return route.fulfill({ contentType: 'image/' + formats[at], body: fixtures[at] });
    }
    if (url.origin === wp && url.pathname === '/wp-json/wp/v2/users/me') return route.fulfill({ json: { id: 9, name: 'Synthetic Editor', capabilities: { upload_files: true } } });
    if (url.origin === wp && url.pathname === '/wp-json/wp/v2/media' && request.method() === 'POST') {
      const raw = request.postDataBuffer(), type = request.headers()['content-type'];
      const parsed = await new Response(raw, { headers: { 'Content-Type': type } }).formData(), file = parsed.get('file');
      uploads.push({ name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
      return route.fulfill({ json: { id: uploads.length, source_url: wp + '/copied-' + file.name } });
    }
    return route.abort();
  });
  await page.goto(base + '/imconnected.html'); await page.waitForFunction(() => window.IMStudio?.Store?.getDocument());
  await page.locator('#templateDialog[open]').waitFor();
  await page.evaluate(() => { document.querySelector('#templateDialog')?.close(); const doc = IMStudio.Templates.create('blank'); doc.blocks = []; IMStudio.Store.replaceDocument(doc, { record: false }); });
  if (connected) await page.waitForFunction(() => IMStudio.Media.canUpload());
  await page.locator('#moreBtn').click(); await page.locator('[data-menu-action=import-site]').click();
  await page.locator('#importSiteUrl').fill(base); await page.locator('#importToken').fill(token); await page.locator('#importTestBtn').click();
  await page.locator('#importRows input[type=checkbox]').first().waitFor();
  for (const box of await page.locator('#importRows input[type=checkbox]').all()) await box.check();
  await page.locator('#importAddBtn').click();
  await page.waitForFunction(() => { const events = IMStudio.Store.getDocument().blocks.flatMap((b) => b.events || []); return events.length === 2 && events.every((e) => e.imageUrl && !e.flyerPending && !e.flyerError); });
  return { page, uploads, errors, transfers };
}
try {
  const local = await setup(false);
  let events = await local.page.evaluate(() => IMStudio.Store.getDocumentClone().blocks.flatMap((b) => b.events || []));
  for (const [i, ext] of formats.entries()) {
    const event = events.find((e) => e.name === 'Synthetic ' + ext + ' flyer');
    check(ext + ' draft flyer imports locally with correct data MIME and original bytes', event.imageUrl.startsWith('data:image/' + ext + ';base64,') && Buffer.from(event.imageUrl.split(',')[1], 'base64').equals(fixtures[i]));
    check(ext + ' is decoded by the browser at its original aspect', await local.page.evaluate(async (src) => { const image = new Image(); image.src = src; await image.decode(); return image.naturalWidth === 48 && image.naturalHeight === 72; }, event.imageUrl));
  }
  const outputs = await local.page.evaluate(() => { const d = IMStudio.Store.getDocumentClone(); return { email: IMStudio.Renderer.renderEmail(d), web: IMStudio.Renderer.renderWeb(d), wp: IMStudio.Renderer.renderWordPressBlocks(d) }; });
  for (const [kind, output] of Object.entries(outputs)) check(kind + ' retains both supported image data formats', formats.every((ext) => output.includes('data:image/' + ext + ';base64,')));
  check('private transfer uses only the supplied Studio bearer', local.transfers.length === 2 && local.transfers.every((value) => value === 'Bearer ' + token));
  await local.page.evaluate(() => IMStudio.Store.persistNow()); await local.page.reload(); await local.page.waitForFunction(() => window.IMStudio?.Store?.getDocument());
  const restored = await local.page.evaluate(() => IMStudio.Store.getDocumentClone().blocks.flatMap((b) => b.events || []));
  check('both imported flyer formats survive saved-draft reload', restored.length === 2 && events.every((e) => restored.find((r) => r.id === e.id)?.imageUrl === e.imageUrl));
  await local.page.evaluate(({ wp }) => IMStudio.Store.addBlock('story', 'document', { title: 'Synthetic compatibility guidance', body: 'Synthetic email test.', photos: [IMStudio.Templates.photo({ url: wp + '/synthetic.avif' })] }), { wp });
  check('email Send Check retains AVIF compatibility guidance', await local.page.evaluate(() => JSON.stringify(IMStudio.Validation.validate(IMStudio.Store.getDocumentClone())).includes('An image uses AVIF')));
  check('local format imports produce no uncaught errors', local.errors.length === 0); await local.page.close();

  const connected = await setup(true);
  for (const [i, ext] of formats.entries()) {
    const upload = connected.uploads.find((file) => file.type === 'image/' + ext);
    check(ext + ' WordPress transfer uses matching filename, MIME and original bytes', !!upload && upload.name.endsWith('.' + ext) && upload.bytes.equals(fixtures[i]));
  }
  check('both copied flyers replace their local slot with the returned public address', await connected.page.evaluate(({ wp }) => IMStudio.Store.getDocument().blocks.flatMap((b) => b.events || []).every((e) => e.imageUrl.startsWith(wp + '/copied-')), { wp }));
  const fallback = await connected.page.evaluate(async (base64) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth'), originalToBlob = HTMLCanvasElement.prototype.toBlob;
    try {
      Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 2000 });
      HTMLCanvasElement.prototype.toBlob = function (callback) { originalToBlob.call(this, callback, 'image/png'); };
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), file = new File([bytes, new Uint8Array(200000)], 'synthetic.webp', { type: 'image/webp' });
      const result = await IMStudio.Media.preparePhoto(file); return { name: result.name, type: result.type };
    } finally { Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', descriptor); HTMLCanvasElement.prototype.toBlob = originalToBlob; }
  }, fixtures[0].toString('base64'));
  check('browser encoder fallback updates the filename to match PNG bytes', fallback.type === 'image/png' && fallback.name.endsWith('.png'));
  check('connected format imports produce no uncaught errors', connected.errors.length === 0); await connected.page.close();
  console.log(`\n${checks} Studio image format checks passed: ${process.env.STUDIO_HTML}`);
} finally { await browser.close(); }
