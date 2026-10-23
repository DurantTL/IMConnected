#!/usr/bin/env node
// End-to-end check of inline photo size and alignment (issue #86). It runs the BUILT server against a throwaway data folder:
//   * a Studio-published story whose body places {{photo N wide|full|left|right}} markers renders data-placement on the right figures,
//     every photo still a link to its full image; a plain marker is unchanged; an unknown option publishes no media
//   * image modules with a placement render the same attribute
//   * (needs Playwright; fails without it unless ALLOW_SKIP=1) at 390 and 1280 px: plain = text column width, wide wider than the column,
//     full wider again but within the page, left/right floated at about 45% from 768 px and stacked at column width below it, text beside
//     a float stays readable; no horizontal scroll at 320, 390, 768 and 1280; the photo viewer still opens; axe has no violation.
// Synthetic data only.
//
//   npm run build
//   SCRATCH=/tmp/imc-photo-placement PORT=4571 node scripts/test-photo-placement.mjs     # run from the repo root
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

const PORT = Number(process.env.PORT || 4571);
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLISH_TOKEN = 'e2e-made-up-publish-token-' + 'p'.repeat(24);
const DATA_DIR = path.join(SCRATCH, 'data');
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 700)}`); if (!ok) fails++; };
const skip = (name, why) => { if (process.env.ALLOW_SKIP === '1') console.log(`SKIP  ${name} (${why})`); else check(`${name} can run (set ALLOW_SKIP=1 to skip)`, false, why); };
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
async function stopServer() { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once('exit', r)); server.kill(); await done; }
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
const photo = (i, alt, extra = {}) => ({ url: dataUrl(PICS[i]), alt, ...extra });
const LOREM = 'Synthetic paragraph text for a layout test. The congregation gathered for a short service and shared a meal afterwards. '.repeat(6);
const OPTS = ['wide', 'full', 'left', 'right'];
const bodyText = `${LOREM}\n\n{{photo 2}}\n\n${LOREM}\n\n${OPTS.map((o, i) => `{{photo ${i % 3 + 1} ${o}}}\n\n${LOREM}\n\n${LOREM}`).join('\n\n')}\n\n{{photo 1 huge}}\n\nClosing paragraph.`;
const slugOf = (res, ref) => res.data.stories?.find((s) => s.ref === ref)?.slug;

try {
  await startServer();
  const res = await call('POST', '/api/publish', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` }, json: { newsletter: { name: 'E2E Issue', issueDate: '2099-01-02' }, stories: [
    { ref: 'inline', title: 'Zz placement inline', section: 'news', area: 'churches', author: 'Test Author', body: bodyText, photos: [photo(0, 'Alt one'), photo(1, 'Alt two'), photo(2, 'Alt three')] },
    { ref: 'mods', title: 'Zz placement modules', section: 'news', area: 'churches', author: 'Test Author', body: 'Synthetic body.', photos: [photo(0, 'Mod one'), photo(1, 'Mod two'), photo(2, 'Mod three')] },
  ] } });
  check('Studio publish accepts the stories', res.status === 200 && res.data.stories?.length === 2, res.text.slice(0, 300));
  const inlineSlug = slugOf(res, 'inline'), modsSlug = slugOf(res, 'mods');
  const page = async (slug) => (await call('GET', `/stories/${slug}/`)).text;
  const html = await page(inlineSlug);
  for (const o of OPTS) check(`inline {{photo N ${o}}} renders data-placement="${o}" on a figure whose link goes to the full image`, new RegExp(`<figure class="story-inline-photo" data-placement="${o}"><a href="/media/stories/[^"]+" data-photo`).test(html));
  check('a plain marker has no data-placement', /<figure class="story-inline-photo"><a/.test(html));
  check('an unknown option publishes no media and leaves no marker text or extra figure', (html.match(/<figure class="story-inline-photo/g) ?? []).length === 5 && !html.includes('photo 1 huge'));

  // image modules: set story_blocks directly (the editor's JSON), restart, render
  {
    const ph = JSON.parse(q('SELECT photos FROM stories WHERE slug = ?', modsSlug)[0].photos); const lead = q('SELECT image FROM stories WHERE slug = ?', modsSlug)[0].image;
    const urls = [lead, ...ph];
    const blocks = [{ id: 't0', type: 'text', text: LOREM }, ...OPTS.map((o, i) => ({ id: `i${i}`, type: 'image', url: urls[i % 3], photoIndex: i % 3, alt: `Module ${o}`, placement: o })), { id: 'tn', type: 'text', text: LOREM }, { id: 'ip', type: 'image', url: urls[0], photoIndex: 0, alt: 'Module plain' }];
    await stopServer();
    const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE stories SET story_blocks = ?, rev = rev + 1 WHERE slug = ?').run(JSON.stringify(blocks), modsSlug);
    db.close();
    await startServer();
    const mh = await page(modsSlug);
    for (const o of OPTS) check(`image module placement ${o} renders data-placement and a link to the full image`, new RegExp(`<figure class="story-module story-module-image"[^>]*data-placement="${o}"><a href="/media/stories/[^"]+" data-photo`).test(mh));
    check('an image module without placement has no data-placement', /<figure class="story-module story-module-image" data-module-id="ip"><a/.test(mh));
  }

  let pw;
  if (process.env.PLAYWRIGHT_ROOT) { try { pw = createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json'))('playwright'); } catch { /* fall back */ } }
  for (const spec of pw ? [] : ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { pw = require(spec); break; } catch { /* next */ } }
  let browser, why = '';
  if (!pw) why = 'Playwright is not installed';
  else { try { browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.CHROMIUM_NO_SANDBOX === '1' || process.getuid?.() === 0 ? ['--no-sandbox'] : [] }); } catch (err) { why = 'no browser could be started: ' + String(err.message).split('\n')[0]; } }
  if (!browser) skip('browser checks (widths, floats, overflow, viewer, axe)', why);
  else {
    const targets = [{ name: 'inline', slug: inlineSlug, sel: 'figure.story-inline-photo' }, { name: 'modules', slug: modsSlug, sel: 'figure.story-module-image' }];
    const measure = (p, sel) => p.evaluate((s) => {
      const prose = document.querySelector('.prose').getBoundingClientRect();
      return { prose: prose.width, vw: document.documentElement.clientWidth, figs: [...document.querySelectorAll(s)].map((f) => { const r = f.getBoundingClientRect(); const cs = getComputedStyle(f); return { placement: f.dataset.placement ?? 'plain', width: r.width, left: r.left, right: r.right, float: cs.float, next: (() => { const n = f.nextElementSibling; if (!n || !n.firstChild) return 0; const range = document.createRange(); range.selectNodeContents(n); const lines = [...range.getClientRects()]; return lines.length ? Math.min(...lines.slice(0, 3).map((l) => l.width)) : 0; })() }; }) };
    }, sel);
    const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;
    const overflow = [];
    for (const w of [320, 390, 768, 1280]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
      const p = await ctx.newPage();
      for (const t of targets) {
        await p.goto(`${BASE}/stories/${t.slug}/`, { waitUntil: 'load' });
        await p.evaluate(async () => { await Promise.all(Array.from(document.images).map((i) => (i.loading === 'lazy' ? (i.loading = 'eager', i.decode().catch(() => {})) : i.decode().catch(() => {})))); });
        const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        if (m.sw > m.cw) overflow.push(`${t.name}@${w}: ${m.sw} > ${m.cw}`);
        if (w === 390 || w === 1280) {
          const r = await measure(p, t.sel);
          const by = (k) => r.figs.find((f) => f.placement === k);
          const plain = by('plain'), wide = by('wide'), full = by('full'), left = by('left'), right = by('right');
          const tag = `${t.name}@${w}`;
          check(`${tag}: all five photos present`, r.figs.length === 5, JSON.stringify(r.figs.map((f) => f.placement)));
          check(`${tag}: a plain photo is the text column width`, near(plain.width, r.prose), `${plain.width} vs ${r.prose}`);
          check(`${tag}: wide and full stay inside the page and are centred`, wide.left >= -1 && wide.right <= r.vw + 1 && full.left >= -1 && full.right <= r.vw + 1 && near((wide.left + wide.right) / 2, r.vw / 2, 12) && near((full.left + full.right) / 2, r.vw / 2, 12), JSON.stringify({ wide, full, vw: r.vw }));
          if (w === 1280) {
            check(`${tag}: wide is wider than the text column and full is wider than wide`, wide.width > r.prose + 40 && full.width > wide.width + 40, JSON.stringify({ prose: r.prose, wide: wide.width, full: full.width }));
            check(`${tag}: left and right float at about 45% of the column`, left.float === 'left' && right.float === 'right' && near(left.width / r.prose, 0.45, 0.02) && near(right.width / r.prose, 0.45, 0.02), JSON.stringify({ left, right, prose: r.prose }));
            check(`${tag}: text beside a float stays readable (at least 240px wide)`, left.next >= 240, String(left.next));
          } else {
            check(`${tag}: left and right stack at full column width on phones, with no float`, left.float === 'none' && right.float === 'none' && near(left.width, r.prose) && near(right.width, r.prose), JSON.stringify({ left, right, prose: r.prose }));
          }
        }
      }
      await ctx.close();
    }
    check('no horizontal scroll at 320, 390, 768 and 1280 px', overflow.length === 0, overflow.join('; '));

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/stories/${inlineSlug}/`, { waitUntil: 'load' });
    const order = await p.evaluate(() => [...document.querySelector('.prose').children].map((k) => k.matches('figure') ? 'F' + (k.dataset.placement ?? '') : k.tagName));
    check('floated photos keep their place in the reading order (DOM order unchanged)', order.indexOf('Fleft') > order.indexOf('Ffull') && order.indexOf('Fright') > order.indexOf('Fleft') && order[order.indexOf('Fleft') - 1] === 'P', order.join(','));
    await p.locator('figure[data-placement=left] a[data-photo]').click();
    await p.waitForSelector('dialog.viewer[open]');
    check('the photo viewer still opens from a floated photo', true);
    await p.keyboard.press('Escape');
    if (process.env.AXE_JS && fs.existsSync(process.env.AXE_JS)) {
      const axeSrc = fs.readFileSync(process.env.AXE_JS, 'utf8');
      const bad = [];
      for (const w of [390, 1280]) {
        await p.setViewportSize({ width: w, height: 900 });
        for (const t of targets) {
          await p.goto(`${BASE}/stories/${t.slug}/`, { waitUntil: 'load' });
          await p.addScriptTag({ content: axeSrc });
          const v = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => `${x.id} (${x.impact}, ${x.nodes.length}) ${x.nodes[0]?.target}`));
          info(`axe ${t.name}@${w}: ${v.length ? v.join('; ') : 'no violations'}`);
          bad.push(...v.map((x) => `${t.name}@${w}: ${x}`));
        }
      }
      check('axe scan: no violation on pages with placed photos', bad.length === 0, bad.join(' | '));
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
