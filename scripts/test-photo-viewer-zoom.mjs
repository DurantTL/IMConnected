#!/usr/bin/env node
// End-to-end check of reader zoom in the photo viewer (issue #83, src/scripts/photo-viewer.ts).
// Runs the BUILT server (dist/server/entry.mjs) against a throwaway data folder with one synthetic story (a Studio publish
// with three generated photos and an inline {{photo 2}} marker), then drives a real Chromium:
//   buttons and the keys + - 0 change the scale (fit to 4x, clamped), Ctrl+wheel zoom, two-finger pinch through CDP touch
//   events, double-click and double-tap toggle fit and 2x, drag pan and its clamping (also on a phone), the polite
//   announcement, prev/next resets zoom, Esc closes and focus returns to the photo link, reduced motion is instant,
//   no horizontal page scroll at 320 px, an axe scan with the viewer open, and the photo links work without JavaScript.
// The browser checks FAIL (not skip) when no browser can be started unless ALLOW_SKIP=1.
//
//   npm run build
//   PLAYWRIGHT_ROOT=/opt/node-tools CHROMIUM_PATH=... CHROMIUM_NO_SANDBOX=1 AXE_JS=.../axe.min.js SCRATCH=/tmp/imc-zoom node scripts/test-photo-viewer-zoom.mjs
// Synthetic data only; made-up tokens; nothing is written into the repository. SCRATCH is created fresh and deleted at the end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.SCRATCH) throw new Error('Set SCRATCH to a throwaway folder.');
const SCRATCH = path.resolve(process.env.SCRATCH);
{
  const roots = [os.tmpdir(), '/tmp'].map((r) => path.resolve(r) + path.sep);
  if (!roots.some((r) => SCRATCH.startsWith(r) && SCRATCH.length > r.length)) throw new Error(`Refusing to use ${SCRATCH}: point SCRATCH at a throwaway folder under ${os.tmpdir()}.`);
}
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const PORT = Number(process.env.PORT || 4562);
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLISH_TOKEN = 'e2e-made-up-publish-token-' + 'p'.repeat(24);
const DATA_DIR = path.join(SCRATCH, 'data');

let fails = 0;
let passes = 0;
let skips = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 600)}`); if (ok) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const PICS = [png(1200, 800, [200, 90, 40], [250, 200, 90]), png(800, 1200, [40, 120, 200], [150, 220, 240]), png(900, 900, [60, 140, 80], [200, 240, 150])];
const dataUrl = (b) => `data:image/png;base64,${b.toString('base64')}`;

let server;
const log = [];
async function startServer() {
  server = spawn('node', ['dist/server/entry.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production', STORY_SYNC_TEST: '1', AUTH_SECRET: 'e2e-made-up-auth-secret-' + 'a'.repeat(24), TRUST_PROXY: 'true', PUBLISH_TOKEN, RESEND_API_KEY: '', SITE_URL: BASE },
  });
  const sink = (d) => log.push(...String(d).split('\n').filter(Boolean));
  server.stdout.on('data', sink); server.stderr.on('data', sink);
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/submit/'); return; } catch { await sleep(250); } }
  throw new Error('the server did not start:\n' + log.join('\n'));
}
async function cleanup() {
  if (server && server.exitCode === null) { const done = new Promise((r) => server.once('exit', r)); server.kill(); await done; }
  if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true });
}

try {
  await startServer();
  await fetch(BASE + '/admin/login'); // opens the database and applies the migrations
  const res = await fetch(BASE + '/api/publish', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PUBLISH_TOKEN}` },
    body: JSON.stringify({ newsletter: { name: 'E2E Issue', issueDate: '2099-01-02' }, stories: [
      { ref: 'zoom', title: 'Zz zoom story', section: 'news', area: 'churches', author: 'Test Author', photoLayout: 'heroGrid', body: 'Synthetic story made up by the test.\n\n{{photo 2}}\n\nA closing paragraph.', photos: PICS.map((b, k) => ({ url: dataUrl(b), alt: `Synthetic zoom photo ${k + 1}` })) },
      { ref: 'solo', title: 'Zz zoom solo', section: 'news', area: 'churches', author: 'Test Author', body: 'One photo only.', photos: [{ url: dataUrl(PICS[0]), alt: 'Synthetic solo photo' }] },
    ] }),
  });
  const data = await res.json();
  check('Studio publish of the synthetic stories is accepted', res.status === 200 && data.ok === true && data.stories?.length === 2, JSON.stringify(data).slice(0, 200));
  const slug = data.stories?.find((s) => s.ref === 'zoom')?.slug;
  const soloSlug = data.stories?.find((s) => s.ref === 'solo')?.slug;

  let pw;
  try { pw = (process.env.PLAYWRIGHT_ROOT ? createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json')) : require)('playwright'); } catch { /* handled below */ }
  let browser;
  let why = pw ? '' : 'Playwright was not found (set PLAYWRIGHT_ROOT)';
  if (pw) { try { browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] }); } catch (e) { why = 'no browser could be launched: ' + String(e.message).split('\n')[0]; } }
  if (!browser) {
    if (process.env.ALLOW_SKIP === '1') { console.log(`SKIP  browser checks (${why})`); skips++; } else check('browser checks can run (set ALLOW_SKIP=1 to skip)', false, why);
  } else {
    const dlg = 'dialog.viewer';
    // current scale and translation of the viewer image, from its computed matrix (none = fit)
    const tf = (page) => page.evaluate(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector('.viewer-img')).transform); return { s: +m.a.toFixed(3), x: +m.e.toFixed(1), y: +m.f.toFixed(1) }; });
    const near = (a, b, e = 0.02) => Math.abs(a - b) <= e;
    const openViewer = async (page, n = 0) => { await page.locator('a[data-photo]').nth(n).click(); await page.locator(dlg).waitFor({ state: 'visible' }); await sleep(50); };
    // the image is on screen if its box overlaps the dialog by at least a third of the screen in each direction, and a zoomed image still covers the screen
    const coverage = (page) => page.evaluate(() => { const r = document.querySelector('.viewer-img').getBoundingClientRect(); const vw = innerWidth, vh = innerHeight; return { l: r.left, t: r.top, r: r.right, b: r.bottom, vw, vh }; });

    // ---------------- desktop, mouse and keyboard ----------------
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/stories/${slug}/`, { waitUntil: 'load' });
      const links = await page.evaluate(() => [...document.querySelectorAll('a[data-photo]')].map((a) => a.getAttribute('href')));
      check('the story page has photo links (the grid photos and the inline {{photo 2}} image) that all point at the story\'s own /media/ files', links.length === 3 && links.every((h) => /^\/media\/stories\/.+\.png$/.test(h)), JSON.stringify(links));
      const inline = await page.locator('.story-inline-photo a[data-photo]').count();
      check('the inline {{photo N}} image is a photo link too', inline === 1, String(inline));

      await openViewer(page, 0);
      check('the viewer opens at fit (no transform) and shows 100%', (await tf(page)).s === 1 && (await page.locator('.viewer-zoom-level').textContent()) === '100%');
      const names = await page.evaluate(() => [...document.querySelectorAll('.viewer-zoom button')].map((b) => ({ n: b.getAttribute('aria-label'), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
      check('Zoom out, Zoom in and Reset are buttons named and at least 44 px', JSON.stringify(names.map((x) => x.n)) === JSON.stringify(['Zoom out', 'Zoom in', 'Reset zoom']) && names.every((x) => x.w >= 44 && x.h >= 44), JSON.stringify(names));
      const label = await page.evaluate(() => { const b = document.querySelector('.viewer-zoom-reset'); return b.textContent.trim(); });
      check('Reset has a visible label that is part of its accessible name', 'Reset zoom'.toLowerCase().includes(label.toLowerCase()), label);

      await page.click('.viewer-zoom-in', { force: true }); await sleep(300);
      let t = await tf(page);
      check('the Zoom in button zooms by 1.5x (150%)', near(t.s, 1.5), JSON.stringify(t));
      for (let i = 0; i < 4; i++) await page.click('.viewer-zoom-in', { force: true });
      await sleep(300);
      t = await tf(page);
      check('zoom stops at 4x', near(t.s, 4) && (await page.locator('.viewer-zoom-level').textContent()) === '400%' && (await page.getAttribute('.viewer-zoom-in', 'aria-disabled')) === 'true', JSON.stringify(t));
      check('focus stays on the Zoom in button at the limit', await page.evaluate(() => document.activeElement?.classList.contains('viewer-zoom-in')));
      await page.click('.viewer-zoom-out', { force: true }); await sleep(300);
      check('the Zoom out button zooms out', near((await tf(page)).s, 4 / 1.5));
      await page.click('.viewer-zoom-reset', { force: true }); await sleep(300);
      t = await tf(page);
      check('Reset returns to fit', t.s === 1 && t.x === 0 && t.y === 0);
      await page.click('.viewer-zoom-out', { force: true }); await sleep(300);
      check('zoom does not go below fit', (await tf(page)).s === 1);

      await page.keyboard.press('+'); await sleep(300);
      const k1 = (await tf(page)).s;
      await page.keyboard.press('='); await sleep(300);
      const k2 = (await tf(page)).s;
      await page.keyboard.press('-'); await sleep(300);
      const k3 = (await tf(page)).s;
      await page.keyboard.press('0'); await sleep(300);
      const k4 = (await tf(page)).s;
      check('keys + (and =), - and 0 zoom in, in, out and reset', near(k1, 1.5) && near(k2, 2.25) && near(k3, 1.5) && k4 === 1, `${k1} ${k2} ${k3} ${k4}`);

      // announcement: a burst of changes gives one polite message
      const live = await page.evaluate(() => { const p = document.querySelector('.viewer-zoom-status'); return { role: p.getAttribute('role'), live: p.getAttribute('aria-live') }; });
      check('the zoom level has its own polite live region', live.role === 'status' && live.live === 'polite', JSON.stringify(live));
      await page.evaluate(() => { window.__msgs = []; new MutationObserver(() => window.__msgs.push(document.querySelector('.viewer-zoom-status').textContent)).observe(document.querySelector('.viewer-zoom-status'), { childList: true, characterData: true, subtree: true }); });
      for (let i = 0; i < 3; i++) await page.keyboard.press('+');
      await sleep(900);
      const msgs = await page.evaluate(() => window.__msgs.filter(Boolean));
      check('three quick zoom steps are announced once, as "338%" (not three times)', msgs.length === 1 && msgs[0] === '338%', JSON.stringify(msgs));
      await page.keyboard.press('0'); await sleep(900);

      // Ctrl+wheel
      await page.mouse.move(640, 400);
      await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control'); await sleep(200);
      const w1 = (await tf(page)).s;
      check('Ctrl+wheel up zooms in', w1 > 1.5, String(w1));
      await page.keyboard.down('Control'); await page.mouse.wheel(0, 200); await page.keyboard.up('Control'); await sleep(200);
      check('Ctrl+wheel down zooms back out', near((await tf(page)).s, 1, 0.05), String((await tf(page)).s));
      await page.mouse.wheel(0, -200); await sleep(150);
      check('a plain wheel does not zoom', (await tf(page)).s === 1);

      // double-click toggles fit and 2x
      const box = await page.locator('.viewer-img').boundingBox();
      await page.mouse.dblclick(box.x + box.width / 2 + 100, box.y + box.height / 2); await sleep(350);
      check('double-click zooms to 2x', near((await tf(page)).s, 2), JSON.stringify(await tf(page)));
      check('the viewer stayed open after the double-click', await page.locator(dlg).isVisible());
      const box2 = await page.locator('.viewer-img').boundingBox();
      await page.mouse.dblclick(box2.x + box2.width / 2, box2.y + box2.height / 2); await sleep(350);
      check('a second double-click returns to fit', (await tf(page)).s === 1);

      // pan: drag and clamp
      await page.keyboard.press('+'); await page.keyboard.press('+'); await sleep(300); // 2.25x
      const before = await tf(page);
      const cx = 640, cy = 400;
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 60, cy + 20, { steps: 4 }); await page.mouse.up(); await sleep(100);
      const after = await tf(page);
      check('dragging a zoomed photo pans it by exactly the drag (+60, +20)', near(after.x - before.x, 60, 1) && near(after.y - before.y, 20, 1), JSON.stringify({ before, after }));
      check('the viewer stays open after a drag that ends on the photo', await page.locator(dlg).isVisible());
      for (let i = 0; i < 6; i++) { await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(900, 700, { steps: 6 }); await page.mouse.up(); await sleep(60); }
      let c = await coverage(page);
      check('panning far right/down is clamped exactly: the photo edges stop at the screen edges (never lost off-screen)', near(c.l, 0, 1) && near(c.t, 0, 1), JSON.stringify(c));
      for (let i = 0; i < 10; i++) { await page.mouse.move(900, 700); await page.mouse.down(); await page.mouse.move(100, 100, { steps: 6 }); await page.mouse.up(); await sleep(60); }
      c = await coverage(page);
      check('panning far left/up is clamped exactly the same way', near(c.r, c.vw, 1) && near(c.b, c.vh, 1), JSON.stringify(c));
      check('the viewer is still open after those drags', await page.locator(dlg).isVisible());
      const k0 = await tf(page);
      await page.keyboard.press('ArrowLeft'); await sleep(100);
      const k1b = await tf(page);
      check('while zoomed (and overflowing) ArrowLeft pans by 80 px (it does not change the photo)', (await page.locator('.viewer-pos').textContent()) === ' (1 of 3)' && near(k1b.x - k0.x, 80, 1), JSON.stringify({ k0, k1b }));
      for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
      c = await coverage(page);
      check('repeated arrow keys stop at the clamp', near(c.r, c.vw, 1) && (await page.locator('.viewer-pos').textContent()) === ' (1 of 3)', JSON.stringify(c));

      // prev/next resets
      await page.click('.viewer-next'); await sleep(100);
      check('Next shows the next photo and resets the zoom to fit', (await tf(page)).s === 1 && (await page.locator('.viewer-pos').textContent()) === ' (2 of 3)');
      await page.keyboard.press('+'); await sleep(250);
      await page.keyboard.press('0'); await sleep(250);
      await page.keyboard.press('+'); await sleep(250);
      await page.click('.viewer-prev'); await sleep(100);
      check('Previous also resets the zoom', (await tf(page)).s === 1 && (await page.locator('.viewer-zoom-level').textContent()) === '100%');
      await page.keyboard.press('ArrowRight'); await sleep(100);
      check('at fit the arrow keys still change photos', (await page.locator('.viewer-pos').textContent()) === ' (2 of 3)');

      // a photo that does not overflow sideways: Up/Down pan, Left/Right fall through to photo navigation
      await page.keyboard.press('0'); await sleep(100);
      const gotoPortrait = async () => {
        for (let i = 0; i < 3 && !(await page.evaluate(() => { const im = document.querySelector('.viewer-img'); return im.naturalHeight > im.naturalWidth; })); i++) { await page.click('.viewer-next'); await sleep(150); }
        return page.evaluate(() => { const im = document.querySelector('.viewer-img'); return im.naturalHeight > im.naturalWidth; });
      };
      check('found the portrait photo', await gotoPortrait());
      const fitBox = await page.locator('.viewer-img').boundingBox();
      check('a tall photo opens fitted: the whole photo is on screen at 100%', fitBox.y >= 0 && fitBox.y + fitBox.height <= 800 && fitBox.x >= 0 && fitBox.x + fitBox.width <= 1280, JSON.stringify(fitBox));
      await page.keyboard.press('+'); await sleep(300); // 1.5x: taller than the screen, narrower than it
      const posBefore = await page.locator('.viewer-pos').textContent();
      const y0 = (await tf(page)).y;
      await page.keyboard.press('ArrowDown'); await sleep(100);
      const y1 = (await tf(page)).y;
      check('zoomed portrait photo: ArrowDown pans it (it overflows vertically) and does not change photo', near(y1 - y0, -80, 1) && (await page.locator('.viewer-pos').textContent()) === posBefore, `${y0} ${y1}`);
      // press on the zoomed photo, drag onto the dark area beside it, release: the viewer stays open
      const ib = await page.locator('.viewer-img').boundingBox();
      await page.mouse.move(ib.x + ib.width / 2, 300); await page.mouse.down(); await page.mouse.move(Math.max(2, Math.floor(ib.x / 2)), 330, { steps: 6 }); await page.mouse.up(); await sleep(150);
      check('a drag that starts on the zoomed photo and ends on the dark area does not close the viewer', await page.locator(dlg).isVisible());
      await page.mouse.click(Math.max(2, Math.floor(ib.x / 2)), 400); await sleep(150);
      check('and a plain click on the dark area right afterwards still closes it', !(await page.locator(dlg).isVisible()));
      await openViewer(page, 0);
      check('found the portrait photo again', await gotoPortrait());
      await page.keyboard.press('+'); await sleep(300);
      const pos2 = await page.locator('.viewer-pos').textContent();
      await page.keyboard.press('ArrowRight'); await sleep(150);
      const after2 = await page.locator('.viewer-pos').textContent();
      check('zoomed portrait photo: ArrowRight (no sideways overflow) still shows the next photo, and the zoom resets', after2 !== pos2 && (await tf(page)).s === 1, `${pos2} -> ${after2}`);
      check('the zoom group is described by the arrow-key hint', await page.evaluate(() => { const g = document.querySelector('.viewer-zoom'); const h = document.getElementById(g.getAttribute('aria-describedby')); return /arrow keys move the photo; press 0 to reset/.test(h?.textContent ?? ''); }));

      // close and focus return
      await page.keyboard.press('+'); await sleep(250);
      await page.keyboard.press('Escape'); await sleep(150);
      const back = await page.evaluate(() => ({ open: document.querySelector('dialog.viewer').open, link: document.activeElement?.matches('a[data-photo]'), isFirst: document.activeElement === document.querySelectorAll('a[data-photo]')[0] }));
      check('Esc closes the viewer while zoomed and focus returns to the photo link that opened it', !back.open && back.link && back.isFirst, JSON.stringify(back));
      await openViewer(page, 1);
      check('reopening starts at fit again', (await tf(page)).s === 1);
      await page.keyboard.press('Escape'); await sleep(100);
      // open the inline photo
      const inlineIdx = await page.evaluate(() => [...document.querySelectorAll('a[data-photo]')].findIndex((a) => a.closest('.story-inline-photo')));
      await openViewer(page, inlineIdx);
      await page.keyboard.press('+'); await sleep(300);
      check('the inline {{photo N}} image zooms the same way', near((await tf(page)).s, 1.5));
      await page.keyboard.press('Escape'); await sleep(100);
      check('focus returns to the inline photo link', await page.evaluate((i) => document.activeElement === document.querySelectorAll('a[data-photo]')[i], inlineIdx));

      // single-photo story
      await page.goto(`${BASE}/stories/${soloSlug}/`, { waitUntil: 'load' });
      await openViewer(page, 0);
      await page.keyboard.press('+'); await sleep(300);
      const solo = await page.evaluate(() => ({ prev: !!document.querySelector('.viewer-prev'), s: new DOMMatrix(getComputedStyle(document.querySelector('.viewer-img')).transform).a }));
      check('a one-photo story (lead photo wrapped by the script) zooms, with no prev/next', !solo.prev && near(solo.s, 1.5), JSON.stringify(solo));
      await ctx.close();
    }

    // ---------------- reduced motion ----------------
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/stories/${slug}/`, { waitUntil: 'load' });
      await openViewer(page, 0);
      await page.click('.viewer-zoom-in', { force: true });
      const imm = await page.evaluate(() => ({ s: new DOMMatrix(getComputedStyle(document.querySelector('.viewer-img')).transform).a, dur: getComputedStyle(document.querySelector('.viewer-img')).transitionDuration, smooth: document.querySelector('.viewer-img').classList.contains('smooth') }));
      check('with reduced motion a zoom step is instant (no transition, the final scale at once)', imm.s === 1.5 && !imm.smooth && /^0s(, 0s)*$/.test(imm.dur), JSON.stringify(imm));
      await ctx.close();
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
      const p2 = await ctx2.newPage();
      await p2.goto(`${BASE}/stories/${slug}/`, { waitUntil: 'load' });
      await openViewer(p2, 0);
      await p2.click('.viewer-zoom-in', { force: true });
      const sm = await p2.evaluate(() => ({ smooth: document.querySelector('.viewer-img').classList.contains('smooth'), dur: getComputedStyle(document.querySelector('.viewer-img')).transitionDuration }));
      check('without the preference a button step eases (short transition)', sm.smooth && sm.dur !== '0s', JSON.stringify(sm));
      await ctx2.close();
    }

    // ---------------- touch: pinch (CDP), double-tap, pan, phone clamp ----------------
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
      await page.goto(`${BASE}/stories/${slug}/`, { waitUntil: 'load' });
      await openViewer(page, 0);
      const r = await page.locator('.viewer-img').boundingBox();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      // pinch out: two fingers 60 px apart spread to 180 px
      await touch('touchStart', [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
      for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: cx - 30 - i * 7.5, y: cy }, { x: cx + 30 + i * 7.5, y: cy }]);
      await touch('touchEnd', []);
      await sleep(200);
      let t = await tf(page);
      check('a two-finger pinch out zooms in (about 3x for 60 -> 180 px)', t.s > 2.5 && t.s <= 4, JSON.stringify(t));
      check('the viewer did not change photo or close during the pinch', (await page.locator('.viewer-pos').textContent()) === ' (1 of 3)' && await page.locator(dlg).isVisible());
      // pinch in
      await touch('touchStart', [{ x: cx - 90, y: cy }, { x: cx + 90, y: cy }]);
      for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: cx - 90 + i * 11, y: cy }, { x: cx + 90 - i * 11, y: cy }]);
      await touch('touchEnd', []);
      await sleep(200);
      t = await tf(page);
      check('a pinch in zooms back out and cannot go below fit', t.s >= 1 && t.s < 1.3, JSON.stringify(t));
      await page.click('.viewer-zoom-reset', { force: true }); await sleep(100);
      // pinch far past 4x
      await touch('touchStart', [{ x: cx - 10, y: cy }, { x: cx + 10, y: cy }]);
      for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: cx - 10 - i * 15, y: cy }, { x: cx + 10 + i * 15, y: cy }]);
      await touch('touchEnd', []);
      await sleep(200);
      check('a huge pinch stops at 4x', near((await tf(page)).s, 4, 0.01), JSON.stringify(await tf(page)));
      // pinch, lift one finger, keep dragging with the other: the photo pans and the viewer neither closes nor changes photo
      await page.click('.viewer-zoom-reset', { force: true }); await sleep(100);
      await touch('touchStart', [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
      for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: cx - 30 - i * 8, y: cy }, { x: cx + 30 + i * 8, y: cy }]);
      const afterPinch = await tf(page);
      const raw = (type, x, y, id) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x, y, id }] });
      await raw('touchEnd', cx - 78, cy, 0); // lifts the left finger (id 0); the right finger (id 1) stays down
      await sleep(50);
      const fingerX = cx + 78;
      for (let i = 1; i <= 5; i++) await raw('touchMove', fingerX - i * 10, cy + i * 6, 1);
      await raw('touchEnd', fingerX - 50, cy + 30, 1);
      await sleep(150);
      const afterLift = await tf(page);
      check('after a pinch, the finger that stays down keeps panning the photo', afterLift.s === afterPinch.s && (near(afterLift.x - afterPinch.x, -50, 3)) && (await page.locator('.viewer-pos').textContent()) === ' (1 of 3)' && await page.locator(dlg).isVisible(), JSON.stringify({ afterPinch, afterLift }));
      await page.click('.viewer-zoom-reset', { force: true }); await sleep(100);
      // one-finger drag pans, clamped, and does not swipe to another photo
      await touch('touchStart', [{ x: cx - 10, y: cy }, { x: cx + 10, y: cy }]);
      for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: cx - 10 - i * 15, y: cy }, { x: cx + 10 + i * 15, y: cy }]);
      await touch('touchEnd', []);
      await sleep(200);
      const drag = async (dx, dy) => { await touch('touchStart', [{ x: 195, y: 390 }]); for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: 195 + (dx * i) / 6, y: 390 + (dy * i) / 6 }]); await touch('touchEnd', []); await sleep(150); };
      const p0 = await tf(page);
      await drag(-60, -40);
      const p1 = await tf(page);
      check('a one-finger drag pans a zoomed photo by the drag (-60, -40) without changing photo', near(p1.x - p0.x, -60, 2) && near(p1.y - p0.y, -40, 2) && p1.s > 3.9 && (await page.locator('.viewer-pos').textContent()) === ' (1 of 3)', JSON.stringify({ p0, p1 }));
      await drag(380, 380); await drag(380, 380); await drag(380, 380);
      let c = await coverage(page);
      const p2 = await tf(page);
      check('dragging far right/down is clamped exactly to the screen edges (phone width)', near(c.l, 0, 1) && near(c.t, 0, 2) && p2.x > p1.x, JSON.stringify({ p1, p2, c }));
      await drag(-380, -380); await drag(-380, -380); await drag(-380, -380);
      c = await coverage(page);
      const p3 = await tf(page);
      check('dragging the other way is clamped exactly too (phone width)', near(c.r, c.vw, 1) && near(c.b, c.vh, 2) && p3.x < p2.x && p3.y < p2.y, JSON.stringify({ p2, p3, c }));
      check('the viewer is still open after panning by touch', await page.locator(dlg).isVisible());
      await page.click('.viewer-zoom-reset', { force: true }); await sleep(100);
      // double-tap
      const tap = async (x, y) => { await touch('touchStart', [{ x, y }]); await touch('touchEnd', []); };
      await tap(cx, cy); await sleep(80); await tap(cx, cy); await sleep(350);
      check('a double-tap zooms to 2x', near((await tf(page)).s, 2), JSON.stringify(await tf(page)));
      check('the double-tap did not close the viewer', await page.locator(dlg).isVisible());
      await sleep(400);
      await tap(195, 390); await sleep(80); await tap(195, 390); await sleep(350);
      check('a second double-tap returns to fit', (await tf(page)).s === 1, JSON.stringify(await tf(page)));
      // swipe still changes photo at fit
      await drag(-150, 0);
      check('at fit a swipe still shows the next photo', (await page.locator('.viewer-pos').textContent()) === ' (2 of 3)');
      await ctx.close();
    }

    // ---------------- 320 px: no horizontal scroll, buttons fit ----------------
    {
      const ctx = await browser.newContext({ viewport: { width: 320, height: 640 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/stories/${slug}/`, { waitUntil: 'load' });
      const m0 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      check('no horizontal page scroll at 320 px (story page)', m0.sw <= m0.cw, JSON.stringify(m0));
      await openViewer(page, 0);
      for (let i = 0; i < 6; i++) await page.keyboard.press('+');
      await sleep(300);
      const m1 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, dsw: document.querySelector('dialog.viewer').scrollWidth, dcw: document.querySelector('dialog.viewer').clientWidth, sx: scrollX }));
      check('no horizontal page scroll at 320 px with the viewer open and fully zoomed', m1.sw <= m1.cw && m1.sx === 0, JSON.stringify(m1));
      const rects = await page.evaluate(() => [...document.querySelectorAll('dialog.viewer button')].map((b) => { const r = b.getBoundingClientRect(); return { n: b.getAttribute('aria-label'), l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; }));
      const onScreen = rects.every((r) => r.l >= 0 && r.r <= 320 && r.t >= 0 && r.b <= 640 && r.w >= 44 && r.h >= 44);
      const overlap = rects.some((a, i) => rects.some((b, j) => i < j && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b));
      check('at 320 px every viewer button is on screen, at least 44 px, and none overlap', onScreen && !overlap, JSON.stringify(rects));
      // a reader with a 20 px root font (125%) at 320 px: the zoom group wraps or hides its label, nothing overlaps or leaves the screen
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      await sleep(100);
      const big = await page.evaluate(() => [...document.querySelectorAll('dialog.viewer button')].map((b) => { const r = b.getBoundingClientRect(); return { n: b.getAttribute('aria-label'), l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; }));
      const bigOn = big.every((r) => r.l >= 0 && r.r <= 320 && r.t >= 0 && r.b <= 640 && r.w >= 44 && r.h >= 44);
      const bigOverlap = big.some((a, i) => big.some((b, j) => i < j && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b));
      const lvl = await page.evaluate(() => getComputedStyle(document.querySelector('.viewer-zoom-level')).display);
      check('at 320 px with a 20 px root font the viewer buttons stay on screen and do not overlap (the % label is hidden, the live region still announces)', bigOn && !bigOverlap && lvl === 'none', JSON.stringify({ lvl, big }));
      await ctx.close();
    }

    // ---------------- focus ring contrast ----------------
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/stories/${slug}/`, { waitUntil: 'load' });
      await openViewer(page, 0);
      await page.keyboard.press('Tab'); // close -> Zoom out
      await page.keyboard.press('Tab'); // Zoom in
      const ring = await page.evaluate(() => { const b = document.activeElement; const cs = getComputedStyle(b); return { name: b.getAttribute('aria-label'), w: cs.outlineWidth, c: cs.outlineColor, st: cs.outlineStyle }; });
      check('a zoom button has a visible 3 px white focus ring on the dark viewer when tabbed to', ring.name === 'Zoom in' && ring.w === '3px' && ring.st === 'solid' && /255, 255, 255/.test(ring.c), JSON.stringify(ring));
      await page.keyboard.press('Tab');
      check('Tab reaches Reset zoom, and keeps cycling inside the viewer', (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Reset zoom');
      await page.keyboard.press('Enter'); // activate a button with the keyboard
      await ctx.close();
    }

    // ---------------- axe with the viewer open (and zoomed) ----------------
    if (process.env.AXE_JS && fs.existsSync(process.env.AXE_JS)) {
      const axeSrc = fs.readFileSync(process.env.AXE_JS, 'utf8');
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/stories/${slug}/`, { waitUntil: 'load' });
      await page.addScriptTag({ content: axeSrc });
      const scan = async () => page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.impact}) ${v.nodes[0]?.target?.join(' ')}`));
      const plain = await scan();
      await openViewer(page, 0);
      const fit = await scan();
      await page.keyboard.press('+'); await page.keyboard.press('+'); await sleep(900);
      const zoomed = await scan();
      const fresh = [...fit, ...zoomed].filter((v) => !plain.includes(v));
      check('axe: no violation with the viewer open at fit or zoomed that the plain story page does not already have', fresh.length === 0, fresh.join(' | '));
      check('axe: the viewer itself has no violation (the dialog subtree)', await page.evaluate(async () => (await window.axe.run(document.querySelector('dialog.viewer'), { resultTypes: ['violations'] })).violations.length === 0));
      await ctx.close();
    } else if (process.env.ALLOW_SKIP === '1') { console.log('SKIP  axe scan (AXE_JS not set)'); skips++; } else check('axe scan can run (set AXE_JS to axe.min.js)', false, 'AXE_JS not set');

    // ---------------- without JavaScript ----------------
    {
      const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/stories/${slug}/`, { waitUntil: 'load' });
      const hrefs = await page.evaluate(() => [...document.querySelectorAll('.article a[href^="/media/"]')].map((a) => a.getAttribute('href')));
      const ok = hrefs.length >= 3 && (await Promise.all(hrefs.map(async (h) => { const r = await fetch(BASE + h); return r.status === 200 && /^image\//.test(r.headers.get('content-type') ?? ''); }))).every(Boolean);
      check('without JavaScript every photo is a plain link to the full image, which loads', ok, JSON.stringify(hrefs));
      check('without JavaScript there is no viewer dialog', (await page.locator('dialog.viewer').count()) === 0);
      await ctx.close();
    }
    await browser.close();
  }
  check('the server log has no token', !log.some((l) => l.includes(PUBLISH_TOKEN)));
} catch (err) {
  console.log('FAIL  unexpected error: ' + (err && err.stack ? err.stack : err));
  fails++;
} finally {
  await cleanup();
}
console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
console.log(fails ? `${fails} check(s) FAILED` : 'All checks passed');
process.exit(fails ? 1 : 0);
