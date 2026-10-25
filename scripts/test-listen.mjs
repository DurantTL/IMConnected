// "Listen to this story" (issue #118): synthetic stories, built server, throwaway DATA_DIR, stubbed speechSynthesis.
//   npm run build && NO_PROXY=localhost,127.0.0.1 PLAYWRIGHT_ROOT=/opt/node-tools CHROMIUM_PATH=/opt/pw-browsers/chromium \
//     CHROMIUM_NO_SANDBOX=1 node scripts/test-listen.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { rankVoices, parseSettings } from '../src/lib/listen-voices.ts';
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
const ARIA = 'Microsoft Aria Online (Natural) - English (United States)';
const SHA = 'a'.repeat(64);
// A loose list (each item is a paragraph inside the li) must still be read once.
const BODY = `## A synthetic heading\n\nFirst synthetic paragraph about the dinner. It has two sentences.\n\n- Synthetic list item one\n\n- Synthetic list item two\n\n> Synthetic quote from nobody in particular.\n\n${LONG}\n`;
let refTexts;
const count = (hay, needle) => hay.split(needle).length - 1;

try {
  db = openDatabase(scratch);
  runMigrations(db, readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
  const now = Date.now();
  db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)").run(now);
  const insert = db.prepare("INSERT INTO stories(slug,title,dek,section,author,date,body,key_points,image,image_alt,announcement,published_at,updated_at) VALUES(?,?,?,'news','Synthetic Author','2026-10-22',?,?,'/images/stories/synthetic.jpg','Synthetic alt',?,?,?)");
  const id = Number(insert.run('synthetic-listen', TITLE, DEK, BODY, JSON.stringify(['Synthetic key point alpha', 'Synthetic key point beta']), null, now, now).lastInsertRowid);
  db.prepare("INSERT INTO story_photos(story_id,position,kind,path,sha256,alt,caption) VALUES(?,0,'lead','stories/synthetic-listen/'||?||'.jpg',?,'Synthetic alt',?)").run(id, SHA, SHA, CAPTION);
  insert.run('synthetic-event', 'Synthetic open house', 'A made-up open house.', 'Synthetic event body paragraph.', '[]',
    JSON.stringify({ kind: 'event', eventDate: '2026-12-05', location: 'Synthetic Hall', links: [{ label: 'Synthetic register link', url: 'https://example.invalid/register' }], videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }), now, now);
  db.close(); db = undefined;

  server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT, DATA_DIR: scratch, SITE_URL: base, AUTH_SECRET: 'synthetic-listen-auth-' + 'x'.repeat(40), RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  for (let n = 0; n < 100; n++) { try { await fetch(base + '/'); ready = true; break; } catch { await delay(100); } }
  check('isolated built server starts', ready);

  const html = await (await fetch(base + '/stories/synthetic-listen/')).text();
  check('story page serves the Listen control server-rendered as hidden', /<div[^>]*data-listen[^>]*\shidden[\s>]/.test(html) && html.includes(CAPTION));

  const { chromium } = createRequire(path.join(process.env.PLAYWRIGHT_ROOT || '/opt/node-tools', 'package.json'))('playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: process.env.CHROMIUM_NO_SANDBOX === '0' ? [] : ['--no-sandbox'] });
  // The stub models what Chrome and Safari do: pause() leaves the synthesis paused, cancel() does not clear that,
  // and a paused synthesis speaks nothing until resume(). `pauseEnds` makes pause() fire `end` (some browsers do).
  const open = async (viewport, slug, opts = {}) => {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', (r) => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
    await context.addInitScript((o) => {
      if (o.unsupported) { delete window.SpeechSynthesisUtterance; Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }); return; }
      window.__spoken = []; window.__calls = []; window.__hold = !!o.hold; window.__pauseEnds = !!o.pauseEnds; window.__noRestart = !!o.noRestart; window.__cancelEnds = !!o.cancelEnds;
      const VOICES = [{ lang: 'fr-FR', name: 'Thomas', default: false, localService: true }, { lang: 'en-US', name: 'Microsoft David Desktop - English (United States)', default: true, localService: true }, { lang: 'en-US', name: 'eSpeak English', default: false, localService: true }, { lang: 'en-US', name: 'Samantha', default: false, localService: true }, { lang: 'en-US', name: 'Google US English', default: false, localService: false }, { lang: 'en-US', name: 'Microsoft Aria Online (Natural) - English (United States)', default: false, localService: false }];
      window.__late = !!o.late;
      class U { constructor(text) { this.text = text; this.lang = ''; this.voice = null; } }
      window.SpeechSynthesisUtterance = U;
      const synth = {
        speaking: false, paused: false, cur: null, voiceCalls: 0,
        getVoices() { this.voiceCalls++; window.__voiceCalls = this.voiceCalls; return window.__late && !window.__lateFired ? [] : VOICES; },
        addEventListener(type, fn) { if (type === 'voiceschanged') window.__voicesChanged = fn; },
        speak(u) { window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name, rate: u.rate, pitch: u.pitch, played: !this.paused }); this.cur = u; this.speaking = true; this.flush(); },
        flush() { const u = this.cur; if (u && !this.paused && !window.__hold) setTimeout(() => { if (this.cur === u && !this.paused) { this.cur = null; this.speaking = false; u.onend && u.onend({}); } }, 0); },
        cancel() { window.__calls.push('cancel'); const u = this.cur; this.cur = null; this.speaking = false; /* stays paused, like Chrome */ if (window.__cancelEnds && u) setTimeout(() => u.onend && u.onend({}), 0); },
        pause() { window.__calls.push('pause'); this.paused = true; if (window.__pauseEnds && this.cur) { const u = this.cur; this.cur = null; setTimeout(() => u.onend && u.onend({}), 0); } },
        resume() { window.__calls.push('resume'); this.paused = false; if (window.__noRestart && this.cur) { this.speaking = false; return; } /* engine that does not restart */ this.flush(); },
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    }, opts);
    const page = await context.newPage();
    await page.goto(`${base}/stories/${slug}/`);
    return { context, page };
  };
  const finished = (page) => page.waitForFunction(() => document.querySelector('[data-listen-status]').textContent === 'Finished.');

  // No support: nothing shows.
  let { context, page } = await open({ width: 1280, height: 900 }, 'synthetic-listen', { unsupported: true });
  check('control stays hidden when speechSynthesis is missing', !(await page.locator('[data-listen]').isVisible()) && await page.locator('[data-listen]').getAttribute('hidden') !== null);
  await context.close();

  for (const width of [390, 1280]) {
    ({ context, page } = await open({ width, height: 900 }, 'synthetic-listen'));
    const box = page.locator('[data-listen]');
    check(`Listen control is shown when speech is supported (${width}px)`, await box.isVisible());
    check(`the group has a short label (${width}px)`, (await box.getAttribute('aria-label')) === 'Listen');
    check(`voices are asked for once up front, not on every start (${width}px)`, (await page.evaluate(() => window.__voiceCalls)) === 1);
    check(`no speech starts on its own (${width}px)`, (await page.evaluate(() => window.__spoken.length)) === 0);
    const start = page.locator('[data-listen-start]');
    const size = await start.boundingBox();
    check(`Listen button is a real button with a 44px target (${width}px)`, (await start.evaluate((e) => e.tagName)) === 'BUTTON' && size.height >= 44 && size.width >= 44);
    check(`nothing overflows horizontally (${width}px)`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await start.focus(); await page.keyboard.press('Enter');
    await finished(page);
    const spoken = await page.evaluate(() => window.__spoken);
    const texts = spoken.map((s) => s.text);
    if (!refTexts) refTexts = texts;
    const joined = texts.join(' ');
    check(`chunks start with the title then the dek (${width}px)`, texts[0] === TITLE + '.' && texts[1] === DEK);
    const at = (s) => joined.indexOf(s);
    check(`order is key points then body: heading, paragraph, list, quote (${width}px)`, [at('Synthetic key point alpha'), at('A synthetic heading'), at('First synthetic paragraph'), at('Synthetic list item one'), at('Synthetic list item two'), at('Synthetic quote'), at('and then it ends')].every((n, i, a) => n > -1 && (i === 0 ? n > at(DEK) : n > a[i - 1])));
    check(`a loose list (li > p) is read once (${width}px)`, count(joined, 'Synthetic list item one') === 1 && count(joined, 'Synthetic list item two') === 1);
    check(`photo caption, byline, share row and button labels are not read (${width}px)`, !joined.includes('caption volunteers') && !joined.includes('Share') && !joined.includes('Copy link') && !joined.includes('Listen to this story') && !joined.includes('Synthetic Author'));
    check(`every chunk is sentence-sized and no text is lost (${width}px)`, texts.every((t) => t.length <= 200) && texts.length >= 10 && joined.includes('and then it ends') && joined.replace(/\s+/g, ' ').includes('each one adding a little more detail about the synthetic evening, each one'));
    check(`an English voice is preferred (${width}px)`, spoken.every((s) => s.lang.startsWith('en') && s.voice === ARIA && s.rate === 0.95 && s.pitch === 1));
    check(`controls return to Listen and focus lands on it after "Finished." (${width}px)`, await start.isVisible() && !(await page.locator('[data-listen-stop]').isVisible()) && await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-listen-start')));
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
    const spokenCount = await page.evaluate(() => window.__spoken.length);
    await page.evaluate(() => { window.__calls.length = 0; });
    await stopBtn.click();
    await delay(100);
    check(`Stop cancels speech and no more chunks follow (${width}px)`, (await page.evaluate(() => window.__calls.includes('cancel'))) && (await page.evaluate(() => window.__spoken.length)) === spokenCount && await start.isVisible());
    check(`focus returns to Listen after Stop (${width}px)`, await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-listen-start')));

    // Pause, Stop, then Listen again must speak (Chrome and Safari stay paused after cancel).
    await page.evaluate(() => { window.__hold = true; window.__spoken.length = 0; });
    await start.click();
    await pauseBtn.click();
    await stopBtn.click();
    await page.evaluate(() => { window.__spoken.length = 0; window.__hold = false; });
    await start.click();
    await finished(page);
    check(`Pause, Stop, Listen speaks again (${width}px)`, await page.evaluate(() => window.__spoken.length > 5 && window.__spoken.every((s) => s.played)));

    // pagehide stops speech and resets the controls.
    await page.evaluate(() => { window.__hold = true; window.__calls.length = 0; });
    await start.click();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    check(`pagehide cancels speech and resets the controls (${width}px)`, (await page.evaluate(() => window.__calls.includes('cancel'))) && await start.isVisible() && !(await pauseBtn.isVisible()) && (await page.locator('[data-listen-status]').textContent()) === '');
    await context.close();
  }

  // A browser whose pause() fires "end": the next chunk must wait for Resume.
  ({ context, page } = await open({ width: 390, height: 900 }, 'synthetic-listen', { pauseEnds: true, hold: true }));
  await page.locator('[data-listen-start]').click();
  await page.locator('[data-listen-pause]').click();
  await delay(150);
  check('nothing new is spoken while paused, even if the browser fires end', (await page.evaluate(() => window.__spoken.length)) === 1 && (await page.locator('[data-listen-pause]').textContent()) === 'Resume');
  await page.evaluate(() => { window.__hold = false; });
  await page.locator('[data-listen-pause]').click();
  await finished(page);
  check('Resume then carries on to the end', await page.evaluate(() => window.__spoken.length > 5 && window.__spoken.every((s) => s.played)));
  await context.close();

  // An engine whose resume() does not restart speech and whose cancel() fires `end`: the watchdog says the current chunk
  // again exactly once, and no chunk is skipped or repeated otherwise.
  ({ context, page } = await open({ width: 390, height: 900 }, 'synthetic-listen', { noRestart: true, cancelEnds: true }));
  await page.evaluate(() => { window.__hold = true; });
  await page.locator('[data-listen-start]').click();
  await page.locator('[data-listen-pause]').click();
  await page.evaluate(() => { window.__hold = false; });
  await page.locator('[data-listen-pause]').click();
  await finished(page);
  const wd = (await page.evaluate(() => window.__spoken)).map((s) => s.text);
  const dupes = wd.filter((t, i) => i > 0 && t === wd[i - 1]);
  check('watchdog re-speaks the stuck chunk exactly once', dupes.length === 1 && wd.length === refTexts.length + 1 && wd[0] === wd[1]);
  check('no chunk is skipped or read twice otherwise', wd.filter((t, i) => !(i === 1)).join('|') === refTexts.join('|'));
  await context.close();

  // Stop while the watchdog is waiting cancels it: nothing is spoken afterwards.
  ({ context, page } = await open({ width: 390, height: 900 }, 'synthetic-listen', { noRestart: true, cancelEnds: true, hold: true }));
  await page.locator('[data-listen-start]').click();
  await page.locator('[data-listen-pause]').click();
  await page.locator('[data-listen-pause]').click();
  await page.locator('[data-listen-stop]').click();
  await delay(700);
  check('Stop clears a pending resume watchdog', (await page.evaluate(() => window.__spoken.length)) === 1);
  await context.close();

  // Voice ranking (issue #165): pure checks.
  {
    const V = (name, lang = 'en-US', localService = true) => ({ name, lang, localService, default: false });
    const sample = [V('Thomas', 'fr-FR'), V('Microsoft David Desktop - English (United States)'), V('eSpeak English'), V('Samantha'), V('Google US English', 'en-US', false), V('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false)];
    const names = (list) => list.map((v) => v.name);
    const want = ['Microsoft Aria Online (Natural) - English (United States)', 'Google US English', 'Samantha', 'Microsoft David Desktop - English (United States)', 'eSpeak English'];
    check('rankVoices: natural first, then Google network, ordinary, then robotic; other languages dropped', JSON.stringify(names(rankVoices(sample, 'en-US'))) === JSON.stringify(want));
    check('rankVoices: same order for a bare "en" page and for reversed input (deterministic)', JSON.stringify(names(rankVoices(sample, 'en'))) === JSON.stringify(want) && JSON.stringify(names(rankVoices([...sample].reverse(), 'en-US'))) === JSON.stringify(want));
    check('rankVoices: input is not mutated', sample[0].name === 'Thomas' && sample.length === 6);
    check('rankVoices: exact locale beats other English at the same tier', names(rankVoices([V('Daniel', 'en-GB'), V('Samantha', 'en-US')], 'en-US'))[0] === 'Samantha' && names(rankVoices([V('Samantha', 'en-US'), V('Daniel', 'en-GB')], 'en-GB'))[0] === 'Daniel');
    check('rankVoices: a local voice never outranks a better network one, and only breaks ties', names(rankVoices([V('Alex'), V('Samantha (Enhanced)', 'en-US', false)], 'en-US'))[0] === 'Samantha (Enhanced)' && names(rankVoices([V('Zed', 'en-US', false), V('Yan', 'en-US', true)], 'en-US'))[0] === 'Yan');
    check('rankVoices: Premium, Siri, Neural and novelty voices land in the right tiers', names(rankVoices([V('Zarvox'), V('Fred'), V('Karen'), V('Siri Voice 1'), V('Ava (Premium)'), V('Jenny Neural')], 'en-US')).join('|') === 'Jenny Neural|Ava (Premium)|Siri Voice 1|Karen|Fred|Zarvox');
    check('rankVoices: a page language with no voices falls back to English; one with voices uses it', names(rankVoices(sample, 'de')).length === 5 && names(rankVoices(sample, 'fr')).join() === 'Thomas');
    check('parseSettings: unknown rate and bad JSON fall back to defaults', JSON.stringify(parseSettings('{"voice":"X","rate":5}')) === '{"voice":"X","rate":0.95}' && JSON.stringify(parseSettings('nope')) === '{"voice":"","rate":0.95}' && parseSettings('{"voice":7,"rate":1.3}').rate === 1.3 && parseSettings('{"voice":7,"rate":1.3}').voice === '');
  }

  // Voice and speed control (issue #165).
  for (const width of [390, 1280]) {
    ({ context, page } = await open({ width, height: 900 }, 'synthetic-listen'));
    const summary = page.locator('[data-listen-settings] summary');
    const sbox = await summary.boundingBox();
    check(`"Voice and speed" is visible, labelled and at least 44px (${width}px)`, (await summary.isVisible()) && (await summary.textContent()).trim() === 'Voice and speed' && sbox.height >= 44);
    check(`the settings panel starts closed (${width}px)`, !(await page.locator('[data-listen-voice]').isVisible()));
    await page.locator('[data-listen-start]').focus();
    await page.keyboard.press('Tab');
    check(`Voice and speed is the next Tab stop after Listen, so it works by keyboard (${width}px)`, await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'SUMMARY'));
    await page.keyboard.press('Enter');
    check(`Enter opens it (${width}px)`, await page.locator('[data-listen-voice]').isVisible());
    const voiceOpts = await page.locator('[data-listen-voice] option').allTextContents();
    check(`Voice lists English voices only, best first, with (recommended) on the first (${width}px)`, voiceOpts.length === 5 && voiceOpts[0] === ARIA + ' (recommended)' && !voiceOpts.join().includes('Thomas') && voiceOpts.filter((t) => t.includes('(recommended)')).length === 1 && voiceOpts[1] === 'Google US English');
    check(`Speed offers Slower, Normal, Faster and Fastest, Normal selected (${width}px)`, (await page.locator('[data-listen-rate] option').allTextContents()).join() === 'Slower,Normal,Faster,Fastest' && (await page.locator('[data-listen-rate]').inputValue()) === '0.95');
    const vsel = await page.locator('[data-listen-voice]').boundingBox(), rsel = await page.locator('[data-listen-rate]').boundingBox(), tbtn = await page.locator('[data-listen-try]').boundingBox();
    check(`selects and Try voice are 44px tall and nothing overflows with the panel open (${width}px)`, vsel.height >= 44 && rsel.height >= 44 && tbtn.height >= 44 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(`each control has a label (${width}px)`, (await page.locator('label[for="listen-voice"]').textContent()) === 'Voice' && (await page.locator('label[for="listen-rate"]').textContent()) === 'Speed');

    // Choose, persist, and use.
    await page.locator('[data-listen-voice]').selectOption('Google US English');
    await page.locator('[data-listen-rate]').selectOption('1.15');
    check(`choices are saved under imc.listen.v1 (${width}px)`, (await page.evaluate(() => localStorage.getItem('imc.listen.v1'))) === '{"voice":"Google US English","rate":1.15}');
    await page.evaluate(() => window.__voicesChanged && window.__voicesChanged());
    check(`a late voices-changed event keeps the reader's choice (${width}px)`, (await page.locator('[data-listen-voice]').inputValue()) === 'Google US English');
    await page.reload();
    check(`settings persist across a reload (${width}px)`, (await page.locator('[data-listen-voice]').inputValue()) === 'Google US English' && (await page.locator('[data-listen-rate]').inputValue()) === '1.15');
    await page.locator('[data-listen-start]').click();
    await finished(page);
    let sp = await page.evaluate(() => window.__spoken);
    check(`utterances carry the chosen voice and rate (${width}px)`, sp.length > 5 && sp.every((s) => s.voice === 'Google US English' && s.rate === 1.15 && s.pitch === 1));

    // An invalid stored value falls back.
    await page.evaluate(() => localStorage.setItem('imc.listen.v1', '{"voice":"No Such Voice","rate":5}'));
    await page.reload();
    check(`an unknown stored voice and speed fall back to recommended and 0.95 (${width}px)`, (await page.locator('[data-listen-voice]').inputValue()) === ARIA && (await page.locator('[data-listen-rate]').inputValue()) === '0.95');
    await page.evaluate(() => localStorage.setItem('imc.listen.v1', 'not json'));
    await page.reload();
    check(`unreadable stored settings fall back too (${width}px)`, (await page.locator('[data-listen-voice]').inputValue()) === ARIA && (await page.locator('[data-listen-rate]').inputValue()) === '0.95');

    // A change in the middle of a story applies from the next chunk, without restarting or stealing focus.
    await page.evaluate(() => { window.__hold = true; window.__spoken.length = 0; });
    await page.locator('[data-listen-start]').click();
    await page.locator('[data-listen-settings] summary').click();
    await page.locator('[data-listen-voice]').selectOption('Samantha');
    await page.locator('[data-listen-rate]').selectOption('1.3');
    await page.locator('[data-listen-rate]').focus();
    check(`a mid-story change does not restart the story or move focus (${width}px)`, (await page.evaluate(() => window.__spoken.length)) === 1 && (await page.evaluate(() => window.__spoken[0].voice)) === ARIA && (await page.evaluate(() => document.activeElement.id)) === 'listen-rate' && (await page.locator('[data-listen-status]').textContent()) === 'Reading the story aloud.');
    await page.evaluate(() => { window.__hold = false; window.speechSynthesis.flush(); });
    await finished(page);
    sp = await page.evaluate(() => window.__spoken);
    check(`the next chunk uses the new voice and speed, and the story is not restarted (${width}px)`, sp.length === refTexts.length && sp.slice(1).every((s) => s.voice === 'Samantha' && s.rate === 1.3) && sp[1].text === refTexts[1]);

    // Try voice speaks only the sample.
    await page.evaluate(() => { window.__spoken.length = 0; });
    await page.locator('[data-listen-try]').click();
    await delay(50);
    sp = await page.evaluate(() => window.__spoken);
    check(`Try voice speaks only the sample with the chosen voice and speed (${width}px)`, sp.length === 1 && sp[0].text === 'This is how stories will sound.' && sp[0].voice === 'Samantha' && sp[0].rate === 1.3);
    await page.evaluate(() => { window.__hold = true; window.__spoken.length = 0; });
    await page.locator('[data-listen-start]').click();
    await page.locator('[data-listen-settings] summary').evaluate((el) => { el.parentElement.open = true; });
    await page.locator('[data-listen-try]').focus();
    await page.evaluate(() => { window.__hold = false; });
    await page.locator('[data-listen-try]').click();
    await delay(100);
    sp = await page.evaluate(() => window.__spoken);
    check(`Try voice while reading replaces the story with just the sample and keeps focus (${width}px)`, sp.length === 2 && sp[1].text === 'This is how stories will sound.' && await page.locator('[data-listen-start]').isVisible() && await page.evaluate(() => document.activeElement.hasAttribute('data-listen-try')));
    await context.close();
  }

  // Voices that load late fill the list; a stored choice is kept.
  ({ context, page } = await open({ width: 390, height: 900 }, 'synthetic-listen', { late: true }));
  check('with no voices yet the Voice list is empty and disabled', (await page.locator('[data-listen-voice] option').count()) === 0 && await page.locator('[data-listen-voice]').isDisabled());
  await page.evaluate(() => localStorage.setItem('imc.listen.v1', '{"voice":"Samantha","rate":0.8}'));
  await page.reload();
  await page.evaluate(() => { window.__lateFired = true; window.__voicesChanged(); });
  check('late voices fill the list and the stored choice is selected', (await page.locator('[data-listen-voice] option').count()) === 5 && (await page.locator('[data-listen-voice]').inputValue()) === 'Samantha' && (await page.locator('[data-listen-rate]').inputValue()) === '0.8');
  await context.close();

  // No speech support: the settings never show without the player.
  ({ context, page } = await open({ width: 390, height: 900 }, 'synthetic-listen', { unsupported: true }));
  check('Voice and speed stays hidden when speechSynthesis is missing', !(await page.locator('[data-listen-settings] summary').isVisible()));
  await context.close();

  // No client chunk may contain a regex lookbehind: Safari before 16.4 fails to parse the whole chunk.
  const astro = path.resolve('dist/client/_astro');
  const bad = fs.readdirSync(astro).filter((f) => f.endsWith('.js') && /\(\?<[=!]/.test(fs.readFileSync(path.join(astro, f), 'utf8')));
  check('no client script uses a regex lookbehind' + (bad.length ? ' (' + bad.join(', ') + ')' : ''), bad.length === 0);

  // An event story reads its When/Where details but neither the register link nor the video helper text.
  ({ context, page } = await open({ width: 390, height: 900 }, 'synthetic-event'));
  check('the event page renders a video player to skip', (await page.locator('.story-video-player').count()) === 1);
  await page.locator('[data-listen-start]').click();
  await finished(page);
  const eventTexts = (await page.evaluate(() => window.__spoken)).map((s) => s.text).join(' ');
  const pos = (s) => eventTexts.indexOf(s);
  check('an event story reads When and Where between the dek and the body', pos('When:') > pos('A made-up open house.') && pos('Where: Synthetic Hall') > pos('When:') && pos('Synthetic event body paragraph') > pos('Where:'));
  check('buttons and the video helper text are not read', !eventTexts.includes('Synthetic register link') && !eventTexts.includes('Opens a video popup') && !eventTexts.includes('Play video'));
  await context.close();

  console.log(`\n${checks} listen checks passed.`);
} finally {
  await browser?.close();
  if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
  db?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
