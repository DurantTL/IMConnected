// "Listen to this story" (issue #118): synthetic story, built server, throwaway DATA_DIR, stubbed speechSynthesis.
//   npm run build && NO_PROXY=localhost,127.0.0.1 PLAYWRIGHT_ROOT=/opt/node-tools CHROMIUM_PATH=/opt/pw-browsers/chromium \
//     CHROMIUM_NO_SANDBOX=1 node scripts/test-listen.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-listen-'));
const PORT = process.env.PORT || '4883';
const base = `http://localhost:${PORT}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let db, server, browser, checks = 0;
const check = (label, ok) => { assert.ok(ok, label); checks++; console.log('PASS ' + label); };

const TITLE = 'Synthetic harvest dinner feeds the neighborhood';
const DEK = 'A made-up dek about a made-up dinner.';
const CAPTION = 'Synthetic caption volunteers setting tables';
const LONG = 'This sentence goes on with several clauses, ' + 'each one adding a little more detail about the synthetic evening, '.repeat(6) + 'and then it ends.';
const SHA = 'a'.repeat(64);
const BODY = `## A synthetic heading\n\nFirst synthetic paragraph about the dinner. It has two sentences.\n\n- Synthetic list item one\n- Synthetic list item two\n\n> Synthetic quote from nobody in particular.\n\n${LONG}\n`;

try {
  db = openDatabase(scratch);
  runMigrations(db, readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
  const now = Date.now();
  db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)").run(now);
  const id = Number(db.prepare("INSERT INTO stories(slug,title,dek,section,author,date,body,key_points,image,image_alt,published_at,updated_at) VALUES('synthetic-listen',?,?,'news','Synthetic Author','2026-10-22',?,?,'/images/stories/synthetic.jpg','Synthetic alt',?,?)")
    .run(TITLE, DEK, BODY, JSON.stringify(['Synthetic key point alpha', 'Synthetic key point beta']), now, now).lastInsertRowid);
  db.prepare("INSERT INTO story_photos(story_id,position,kind,path,sha256,alt,caption) VALUES(?,0,'lead','stories/synthetic-listen/'||?||'.jpg',?,'Synthetic alt',?)").run(id, SHA, SHA, CAPTION);
  db.close(); db = undefined;

  server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT, DATA_DIR: scratch, SITE_URL: base, AUTH_SECRET: 'synthetic-listen-auth-' + 'x'.repeat(40), RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  for (let n = 0; n < 100; n++) { try { await fetch(base + '/'); ready = true; break; } catch { await delay(100); } }
  check('isolated built server starts', ready);

  const html = await (await fetch(base + '/stories/synthetic-listen/')).text();
  check('story page serves the Listen control server-rendered as hidden', /<div[^>]*data-listen[^>]*\shidden[\s>]/.test(html) && html.includes(CAPTION));

  const { chromium } = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/opt/node-tools', 'package.json'))('playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: process.env.CHROMIUM_NO_SANDBOX === '0' ? [] : ['--no-sandbox'] });
  const open = async (viewport, stub) => {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', (r) => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
    if (stub) await context.addInitScript(() => {
      window.__spoken = []; window.__calls = [];
      class U { constructor(text) { this.text = text; this.lang = ''; this.voice = null; } }
      window.SpeechSynthesisUtterance = U;
      const synth = {
        speaking: false,
        getVoices: () => [{ lang: 'fr-FR', name: 'fr', default: false, localService: true }, { lang: 'en-GB', name: 'en', default: false, localService: true }, { lang: 'en-US', name: 'us', default: true, localService: true }],
        speak(u) { window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name }); this.speaking = true; this.cur = u; if (!window.__hold) setTimeout(() => { if (this.cur === u) { this.cur = null; u.onend && u.onend({}); } }, 0); },
        cancel() { window.__calls.push('cancel'); this.cur = null; this.speaking = false; },
        pause() { window.__calls.push('pause'); }, resume() { window.__calls.push('resume'); },
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    });
    const page = await context.newPage();
    await page.goto(base + '/stories/synthetic-listen/');
    return { context, page };
  };

  // No support: stays hidden.
  let { context, page } = await open({ width: 1280, height: 900 }, false);
  await context.addInitScript(() => {});
  const supported = await page.evaluate(() => 'speechSynthesis' in window);
  const visible = await page.locator('[data-listen]').isVisible();
  check('control stays hidden when the browser cannot speak', supported ? true : !visible);
  await context.close();
  ({ context, page } = await (async () => { const c = await browser.newContext(); await c.addInitScript(() => { delete window.SpeechSynthesisUtterance; Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }); delete window.speechSynthesis; }); const p = await c.newPage(); await p.goto(base + '/stories/synthetic-listen/'); return { context: c, page: p }; })());
  check('control stays hidden when speechSynthesis is missing', !(await page.locator('[data-listen]').isVisible()) && await page.locator('[data-listen]').getAttribute('hidden') !== null);
  await context.close();

  for (const width of [390, 1280]) {
    ({ context, page } = await open({ width, height: 900 }, true));
    const box = page.locator('[data-listen]');
    check(`Listen control is shown when speech is supported (${width}px)`, await box.isVisible());
    check(`no speech starts on its own (${width}px)`, (await page.evaluate(() => window.__spoken.length)) === 0);
    const start = page.locator('[data-listen-start]');
    const size = await start.boundingBox();
    check(`Listen button is a real button with a 44px target (${width}px)`, (await start.evaluate((e) => e.tagName)) === 'BUTTON' && size.height >= 44 && size.width >= 44);
    check(`nothing overflows horizontally (${width}px)`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await start.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__spoken.length > 5);
    await page.waitForFunction(() => document.querySelector('[data-listen-status]').textContent === 'Finished.');
    const spoken = await page.evaluate(() => window.__spoken);
    const texts = spoken.map((s) => s.text);
    const joined = texts.join(' ');
    check(`chunks start with the title then the dek (${width}px)`, texts[0] === TITLE + '.' && texts[1] === DEK);
    const at = (s) => joined.indexOf(s);
    check(`order is key points then body: heading, paragraph, list, quote (${width}px)`, [at('Synthetic key point alpha'), at('A synthetic heading'), at('First synthetic paragraph'), at('Synthetic list item one'), at('Synthetic list item two'), at('Synthetic quote'), at('and then it ends')].every((n, i, a) => n > -1 && (i === 0 ? n > at(DEK) : n > a[i - 1])));
    check(`photo caption, byline, share row and button labels are not read (${width}px)`, !joined.includes('caption volunteers') && !joined.includes('Share') && !joined.includes('Copy link') && !joined.includes('Listen to this story') && !joined.includes('Synthetic Author'));
    check(`every chunk is sentence-sized (${width}px)`, texts.every((t) => t.length <= 200) && texts.length >= 10);
    check(`an English voice is preferred (${width}px)`, spoken.every((s) => s.lang.startsWith('en') && s.voice === 'us'));
    check(`controls return to Listen when finished (${width}px)`, await start.isVisible() && !(await page.locator('[data-listen-stop]').isVisible()));
    check(`status region is polite (${width}px)`, (await page.locator('[data-listen-status]').getAttribute('aria-live')) === 'polite');

    // Pause / Resume / Stop with the stub holding the utterance.
    await page.evaluate(() => { window.__spoken.length = 0; window.__calls.length = 0; window.__hold = true; });
    await start.click();
    const pauseBtn = page.locator('[data-listen-pause]'), stopBtn = page.locator('[data-listen-stop]');
    check(`Pause and Stop appear while reading (${width}px)`, await pauseBtn.isVisible() && await stopBtn.isVisible() && !(await start.isVisible()));
    check(`nothing overflows while the controls are open (${width}px)`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await pauseBtn.click();
    check(`Pause pauses and the button becomes Resume (${width}px)`, (await pauseBtn.textContent()) === 'Resume' && (await page.evaluate(() => window.__calls.includes('pause'))));
    await pauseBtn.click();
    check(`Resume resumes (${width}px)`, (await pauseBtn.textContent()) === 'Pause' && (await page.evaluate(() => window.__calls.includes('resume'))));
    const count = await page.evaluate(() => window.__spoken.length);
    await page.evaluate(() => { window.__calls.length = 0; });
    await stopBtn.click();
    await delay(100);
    check(`Stop cancels speech and no more chunks follow (${width}px)`, (await page.evaluate(() => window.__calls.includes('cancel'))) && (await page.evaluate(() => window.__spoken.length)) === count && await start.isVisible());

    // pagehide stops speech.
    await start.click();
    await page.evaluate(() => { window.__calls.length = 0; window.dispatchEvent(new Event('pagehide')); });
    check(`pagehide cancels speech (${width}px)`, await page.evaluate(() => window.__calls.includes('cancel')));
    await context.close();
  }
  console.log(`\n${checks} listen checks passed.`);
} finally {
  await browser?.close();
  if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
  db?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
