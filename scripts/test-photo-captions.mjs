#!/usr/bin/env node
// End-to-end check of per-photo captions (issue #84). It runs the BUILT server (dist/server/entry.mjs) against a throwaway
// data folder and checks:
//   * Studio's POST /api/publish: a caption is stored (migration 029), cut at 300 characters, and a "Photo:" caption is a credit, not a caption
//   * the story page: a <figcaption class="photo-caption"> under its own photo in every layout, in the lead figure, in the gallery
//     and inline ({{photo N}}); plain text only (a hostile caption shows literally, never as markup); no figcaption at all for an empty caption
//   * /stories.json and GET /api/stories: additive imageCaption / photoCaptions, version unchanged, photoFocus carries no caption
//   * the adoption/import path: a story with no captions has the empty default
//   * (optional, needs Playwright) in a real browser: captions are visible, nothing overflows at 390/768/1280 px, the photo viewer shows the
//     caption (as text, never markup), and an axe scan (AXE_JS) has no violation.
// Synthetic data only: made-up tokens, generated pictures. Nothing is written into the repository.
//
//   npm run build
//   SCRATCH=/tmp/imc-photo-captions node scripts/test-photo-captions.mjs     # run from the repo root
//   PLAYWRIGHT_ROOT=... CHROMIUM_PATH=... CHROMIUM_NO_SANDBOX=1 AXE_JS=/path/to/axe.min.js SCRATCH=... node scripts/test-photo-captions.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.SCRATCH) throw new Error('Set SCRATCH to a throwaway folder.');
const SCRATCH = path.resolve(process.env.SCRATCH);
{
  const roots = [os.tmpdir(), '/tmp'].map((r) => path.resolve(r) + path.sep);
  if (SCRATCH === '/data' || SCRATCH.startsWith('/data' + path.sep) || !roots.some((r) => SCRATCH.startsWith(r) && SCRATCH.length > r.length)) throw new Error(`Refusing to use ${SCRATCH}: point this at a throwaway folder under ${os.tmpdir()}.`);
}
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const PORT = Number(process.env.PORT || 4561);
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLISH_TOKEN = 'e2e-made-up-publish-token-' + 'p'.repeat(24);
const DATA_DIR = path.join(SCRATCH, 'data');
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 700)}`); if (!ok) fails++; };
const skip = (name, why) => console.log(`SKIP  ${name} (${why})`);
const info = (line) => console.log(`INFO  ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, ...args) => { const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };

let server;
const serverLog = [];
async function startServer() {
  server = spawn('node', ['dist/server/entry.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production', STORY_SYNC_TEST: '1', AUTH_SECRET: 'e2e-made-up-auth-secret-' + 'a'.repeat(24), TRUST_PROXY: 'true', PUBLISH_TOKEN, RESEND_API_KEY: '', SITE_URL: BASE },
  });
  const sink = (d) => serverLog.push(...String(d).split('\n').filter(Boolean));
  server.stdout.on('data', sink); server.stderr.on('data', sink);
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/submit/'); return; } catch { await sleep(250); } }
  throw new Error('the server did not start:\n' + serverLog.join('\n'));
}
const cleanup = async () => { server?.kill(); if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true }); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)));

// ---- synthetic pictures ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(w, h, a, b) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = (x / w + y / h) / 2; for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * t); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PICS = [[720, 480, [200, 90, 40], [250, 200, 90]], [480, 720, [40, 120, 200], [150, 220, 240]], [600, 600, [60, 140, 80], [200, 240, 150]], [720, 405, [130, 60, 160], [230, 180, 230]]].map(([w, h, a, b]) => png(w, h, a, b));
const dataUrl = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

async function call(method, url, { headers = {}, json } = {}) {
  const h = { ...headers };
  if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual' });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, data };
}
const studio = (stories) => call('POST', '/api/publish', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` }, json: { newsletter: { name: 'E2E Issue', issueDate: '2099-01-02' }, stories } });
const HOSTILE = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2"> **bold** [link](https://example.invalid) & "q"';
const photo = (i, alt, caption, extra = {}) => ({ url: dataUrl(PICS[i]), alt, ...(caption === undefined ? {} : { caption }), ...extra });
const story = (ref, title, photos, extra = {}) => ({ ref, title, section: 'news', area: 'churches', author: 'Test Author', body: 'Synthetic body text for a caption test.', photos, ...extra });
const slugOf = (res, ref) => res.data.stories?.find((s) => s.ref === ref)?.slug;
const figcaptions = (html) => [...html.matchAll(/<figcaption class="photo-caption"[^>]*>([\s\S]*?)<\/figcaption>/g)].map((m) => m[1]);

try {
  await startServer();
  const LONG = 'L'.repeat(450);
  const res = await studio([
    story('mosaic', 'Zz captions mosaic', [photo(0, 'Synthetic lead alt', 'Lead caption one'), photo(1, 'Synthetic second alt', HOSTILE), photo(2, 'Synthetic third alt'), photo(3, 'Synthetic fourth alt', 'Fourth caption')], { photoLayout: 'mosaic' }),
    story('hero', 'Zz captions hero', [photo(0, 'Alt A', 'Hero caption'), photo(1, 'Alt B', 'Pair left'), photo(2, 'Alt C')], { photoLayout: 'heroGrid' }),
    story('one', 'Zz captions plain', [photo(0, 'Plain lead alt', 'Plain lead caption'), photo(1, 'Plain second alt', 'Gallery caption'), photo(2, 'Plain third alt')]),
    story('none', 'Zz captions none', [photo(0, 'No caption lead alt'), photo(1, 'No caption second alt')], { photoLayout: 'twoUp' }),
    story('none1', 'Zz captions none plain', [photo(0, 'Plain no caption alt'), photo(1, 'Plain no caption second')]),
    story('long', 'Zz captions long', [photo(0, 'Long alt', LONG)]),
    story('credit', 'Zz captions credit', [photo(0, 'Credit alt', 'Photo: Synthetic Photographer')]),
    story('inline', 'Zz captions inline', [photo(0, 'Inline lead alt', 'Inline lead caption'), photo(1, 'Inline second alt', 'Inline photo two caption')], { body: 'Intro paragraph.\n\n{{photo 2}}\n\nClosing paragraph.' }),
  ]);
  check('Studio publish accepts photos with captions', res.status === 200 && res.data.stories?.length === 8, res.text.slice(0, 300));
  const slug = (ref) => slugOf(res, ref);

  // ---- storage ----
  const rows = (ref) => q('SELECT p.position, p.caption FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = ? ORDER BY p.position', slug(ref));
  check('migration 029: story_photos.caption exists, NOT NULL, default empty', q("SELECT name, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('story_photos') WHERE name = 'caption'").some((c) => c.nn === 1 && c.d === "''"));
  check('...and draft_photos.caption still exists', q("SELECT name FROM pragma_table_info('draft_photos') WHERE name = 'caption'").length === 1);
  check('captions round trip in order; a photo without one stores the empty string', JSON.stringify(rows('mosaic').map((r) => r.caption)) === JSON.stringify(['Lead caption one', HOSTILE, '', 'Fourth caption']), JSON.stringify(rows('mosaic')));
  check('a caption is stored as plain text on one line, never altered into markup', rows('mosaic')[1].caption === HOSTILE);
  check('a caption over 300 characters is cut at 300', rows('long')[0].caption.length === 300, rows('long')[0].caption.length);
  check('a "Photo:" caption is a credit, not a caption (nothing visible is stored)', rows('credit')[0].caption === '' && q('SELECT photo_credit AS c FROM stories WHERE slug = ?', slug('credit'))[0].c === 'Synthetic Photographer');
  check('the CHECK constraint refuses a 301-character caption', (() => { const db = new DatabaseSync(DB_FILE); try { db.prepare("UPDATE story_photos SET caption = ?, story_id = story_id WHERE story_id = (SELECT id FROM stories WHERE slug = ?)").run('x'.repeat(301), slug('long')); return false; } catch { return true; } finally { db.close(); } })());
  check('the draft record Studio keeps carries the stored caption', q("SELECT p.caption FROM draft_photos p JOIN drafts d ON d.id = p.draft_id WHERE d.slug = ? ORDER BY p.position", slug('mosaic'))[0].caption === 'Lead caption one');

  // ---- public pages ----
  const page = async (ref) => (await call('GET', `/stories/${slug(ref)}/`)).text;
  const mosaic = await page('mosaic');
  const mcaps = figcaptions(mosaic);
  check('mosaic: each captioned photo has a figcaption.photo-caption, none for the photo without one (3 of 4)', mcaps.length === 3, JSON.stringify(mcaps));
  check('mosaic: a caption sits in the same <figure> as its photo (figure.photos-tile > a + figcaption)', (mosaic.match(/<figure class="photos-tile">\s*<a href="\/media\/[^"]+" data-photo[^>]*>[\s\S]*?<\/a>\s*<figcaption class="photo-caption">/g) ?? []).length === 3);
  check('a hostile caption shows literally: escaped, no script, no image, no bold, no link', mcaps[1].includes('&lt;script&gt;window.__pwned=1&lt;/script&gt;') && mcaps[1].includes('&lt;img src=x onerror=') && !/<script>window\.__pwned/.test(mosaic) && !/<img src=x/.test(mosaic) && !/<strong>bold|<a href="https:\/\/example\.invalid"/.test(mosaic) && mcaps[1].includes('**bold**') && mcaps[1].includes('[link](https://example.invalid)'), mcaps[1]);
  check('the alt text is not repeated in the caption (alt stays on the image only)', mcaps.every((c) => !/Synthetic (lead|second|third|fourth) alt/.test(c)) && /alt="Synthetic lead alt"/.test(mosaic));
  const hero = await page('hero');
  check('heroGrid: hero and pair captions under their tiles, the third photo has none', JSON.stringify(figcaptions(hero)) === JSON.stringify(['Hero caption', 'Pair left']), JSON.stringify(figcaptions(hero)));
  const plain = await page('one');
  check('the plain layout: the lead caption replaces the visible alt line, a gallery photo\'s caption sits under it', /<figure>\s*<img[^>]*>\s*<figcaption class="photo-caption">Plain lead caption<\/figcaption>/.test(plain) || /<figure>[\s\S]{0,900}<figcaption class="photo-caption">Plain lead caption<\/figcaption>/.test(plain), figcaptions(plain).join('|'));
  check('...and the gallery caption is there, with no caption for the third photo', figcaptions(plain).includes('Gallery caption') && figcaptions(plain).length === 2, JSON.stringify(figcaptions(plain)));
  for (const ref of ['none', 'none1']) {
    const html = await page(ref);
    check(`${ref}: with no captions there is no caption markup at all`, !/photo-caption|photos-tile|gallery-item/.test(html.replace(/<style[\s\S]*?<\/style>/g, '')));
  }
  check('a 450-character caption is shown at 300 characters', figcaptions(await page('long'))[0]?.length === 300);
  const credit = await page('credit');
  check('a "Photo:" caption shows as the photo credit, not a caption', !/photo-caption/.test(credit.replace(/<style[\s\S]*?<\/style>/g, '')) && credit.includes('Synthetic Photographer'));
  const inline = await page('inline');
  check('an inline {{photo 2}} photo has its caption as a figcaption inside its figure', /<figure class="story-inline-photo">[\s\S]*?<\/a><figcaption class="photo-caption">Inline photo two caption<\/figcaption><\/figure>/.test(inline), figcaptions(inline).join('|'));

  // ---- feeds ----
  const feed = await call('GET', '/stories.json');
  const item = (ref) => feed.data.stories?.find((s) => s.id === slug(ref));
  check('/stories.json keeps version 1 and adds imageCaption and photoCaptions', feed.status === 200 && feed.data.version === 1 && item('mosaic')?.imageCaption === 'Lead caption one' && JSON.stringify(item('mosaic').photoCaptions) === JSON.stringify([HOSTILE, '', 'Fourth caption']), JSON.stringify(item('mosaic')?.photoCaptions));
  check('...a story without captions has no imageCaption and empty photoCaptions', item('none') && item('none').imageCaption === undefined && JSON.stringify(item('none').photoCaptions) === '[""]', JSON.stringify(item('none')?.photoCaptions));
  check('...photoFocus (when present) carries no caption', feed.data.stories.every((s) => (s.photoFocus ?? []).every((p) => !('caption' in p))));
  const list = await call('GET', '/api/stories', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` } });
  const ls = list.data.stories?.find((s) => s.id === slug('mosaic'));
  check('GET /api/stories (Studio list) carries the captions too', list.status === 200 && ls?.imageCaption === 'Lead caption one' && ls.photoCaptions?.[2] === 'Fourth caption', JSON.stringify(ls?.photoCaptions));
  const rss = await call('GET', '/rss.xml');
  check('/rss.xml still renders', rss.status === 200 && rss.text.includes('Zz captions mosaic'));

  // ---- an empty caption from Studio keeps the stored one (a Studio republish must not wipe an editor's caption) ----
  const clearRes = await studio([story('mosaic', 'Zz captions mosaic', [photo(0, 'Synthetic lead alt', '')], { photoLayout: 'mosaic' })]);
  check('an empty caption from Studio keeps the stored one (only the dashboard clears a caption)', clearRes.status === 200 && figcaptions(await page('mosaic')).includes('Lead caption one'));
  const changeRes = await studio([story('mosaic', 'Zz captions mosaic', [photo(0, 'Synthetic lead alt', 'A new lead caption')], { photoLayout: 'mosaic' })]);
  check('a non-empty caption from Studio replaces it', changeRes.status === 200 && figcaptions(await page('mosaic')).includes('A new lead caption') && !figcaptions(await page('mosaic')).includes('Lead caption one'));

  // ---- a real browser (optional) ----
  let pw;
  if (process.env.PLAYWRIGHT_ROOT) { try { pw = createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json'))('playwright'); } catch { /* fall back */ } }
  for (const spec of pw ? [] : ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { pw = require(spec); break; } catch { /* next */ } }
  let browser, why = '';
  if (!pw) why = 'Playwright is not installed';
  else { try { browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.CHROMIUM_NO_SANDBOX === '1' || process.getuid?.() === 0 ? ['--no-sandbox'] : [] }); } catch (err) { why = 'no browser could be started: ' + String(err.message).split('\n')[0]; } }
  if (!browser) skip('browser checks (visible captions, overflow, viewer, axe)', why);
  else {
    const overflow = [];
    const refs = ['hero', 'one', 'inline', 'none'];
    // the mosaic story was rewritten above; republish a fresh one for the browser
    const fresh = await studio([story('mosaic2', 'Zz captions mosaic browser', [photo(0, 'Synthetic lead alt', 'Lead caption one'), photo(1, 'Synthetic second alt', HOSTILE), photo(2, 'Synthetic third alt'), photo(3, 'Synthetic fourth alt', 'Fourth caption')], { photoLayout: 'mosaic' })]);
    const mosaic2 = slugOf(fresh, 'mosaic2');
    const targets = [...refs.map((r) => ({ name: r, slug: slug(r) })), { name: 'mosaic2', slug: mosaic2 }];
    for (const w of [390, 768, 1280]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
      const p = await ctx.newPage();
      for (const t of targets) {
        await p.goto(`${BASE}/stories/${t.slug}/`, { waitUntil: 'load' });
        await p.evaluate(async () => { await Promise.all(Array.from(document.images).map((i) => (i.loading === 'lazy' ? (i.loading = 'eager', i.decode().catch(() => {})) : i.decode().catch(() => {})))); });
        const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        if (m.sw > m.cw) overflow.push(`${t.name}@${w}: ${m.sw} > ${m.cw}`);
      }
      await ctx.close();
    }
    check('no horizontal scroll at 390, 768 and 1280 px on pages with captions', overflow.length === 0, overflow.join('; '));

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/stories/${mosaic2}/`, { waitUntil: 'load' });
    const visible = await p.evaluate(() => [...document.querySelectorAll('figcaption.photo-caption')].map((f) => { const r = f.getBoundingClientRect(); const fig = f.closest('figure'); const a = fig.querySelector('a[data-photo]').getBoundingClientRect(); return { text: f.textContent, shown: r.width > 0 && r.height > 0 && getComputedStyle(f).visibility !== 'hidden', under: r.top >= a.bottom - 1, within: r.left >= a.left - 1 && r.right <= a.right + 1 }; }));
    check('every caption is rendered, under its own photo and no wider than it (a tidy grid)', visible.length === 3 && visible.every((v) => v.shown && v.under && v.within), JSON.stringify(visible));
    check('the hostile caption was not executed or parsed as markup in the browser', await p.evaluate(() => window.__pwned === undefined && !document.querySelector('figcaption.photo-caption img, figcaption.photo-caption script, figcaption.photo-caption a, figcaption.photo-caption strong')));
    const tiles = await p.evaluate(() => [...document.querySelectorAll('.photos-row')].map((row) => [...row.children].map((c) => Math.round(c.getBoundingClientRect().width))));
    check('a pair row keeps two equal-width tiles with and without a caption', tiles.every((r) => r.length < 2 || Math.abs(r[0] - r[1]) <= 1), JSON.stringify(tiles));

    // the viewer: opens on the second photo (hostile caption) and shows it as text
    await p.locator('.photos a[data-photo]').nth(1).click();
    await p.waitForSelector('dialog.viewer[open]');
    const vw = await p.evaluate(() => ({ text: document.querySelector('.viewer-alt').textContent, hasChild: !!document.querySelector('.viewer-alt *'), alt: document.querySelector('.viewer-img').alt, pos: document.querySelector('.viewer-pos').textContent, pwned: window.__pwned }));
    check('the viewer shows the caption as plain text (not the alt), and keeps the alt on the image', vw.text === HOSTILE && !vw.hasChild && vw.alt === 'Synthetic second alt' && vw.pwned === undefined, JSON.stringify(vw));
    await p.keyboard.press('ArrowRight');
    const third = await p.evaluate(() => ({ text: document.querySelector('.viewer-alt').textContent, alt: document.querySelector('.viewer-img').alt }));
    check('a photo without a caption shows its alt text in the viewer, as before', third.text === 'Synthetic third alt' && third.alt === 'Synthetic third alt', JSON.stringify(third));
    await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft');
    const lead = await p.evaluate(() => document.querySelector('.viewer-alt').textContent);
    check('the first photo shows its caption in the viewer', lead === 'Lead caption one', lead);
    await p.keyboard.press('Escape');

    // the plain layout: the lead figure's caption is shown and the viewer uses it, without the credit line
    await p.goto(`${BASE}/stories/${slug('one')}/`, { waitUntil: 'load' });
    await p.locator('.article > figure a[data-photo]').first().click();
    await p.waitForSelector('dialog.viewer[open]');
    check('the plain lead photo opens in the viewer with its caption', (await p.evaluate(() => document.querySelector('.viewer-alt').textContent)) === 'Plain lead caption');
    await p.keyboard.press('Escape');

    // axe
    if (process.env.AXE_JS && fs.existsSync(process.env.AXE_JS)) {
      const axeSrc = fs.readFileSync(process.env.AXE_JS, 'utf8');
      const bad = [];
      for (const t of targets) {
        await p.goto(`${BASE}/stories/${t.slug}/`, { waitUntil: 'load' });
        await p.addScriptTag({ content: axeSrc });
        const v = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => `${x.id} (${x.impact}, ${x.nodes.length}) ${x.nodes[0]?.target}`));
        info(`axe ${t.name}: ${v.length ? v.join('; ') : 'no violations'}`);
        bad.push(...v.map((x) => `${t.name}: ${x}`));
      }
      await p.goto(`${BASE}/stories/${mosaic2}/`, { waitUntil: 'load' });
      await p.locator('.photos a[data-photo]').nth(1).click();
      await p.waitForSelector('dialog.viewer[open]');
      await p.addScriptTag({ content: axeSrc });
      const v = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => `${x.id} (${x.impact}, ${x.nodes.length}) ${x.nodes[0]?.target}`));
      info(`axe viewer open: ${v.length ? v.join('; ') : 'no violations'}`);
      bad.push(...v.map((x) => `viewer: ${x}`));
      check('axe scan: no violation on pages with captions or with the viewer showing one', bad.length === 0, bad.join(' | '));
    } else skip('axe scan', 'set AXE_JS to the path of axe.min.js');
    await browser.close();
  }

  check('the server log has no token', !serverLog.some((l) => l.includes(PUBLISH_TOKEN)));
} catch (err) {
  console.error(err);
  fails++;
} finally {
  await cleanup();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
