// Issue #119: home page featured-story panel and statline. Synthetic stories, a throwaway DATA_DIR per scenario, local server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const port = process.env.PORT || '4891', base = `http://localhost:${port}`;
let checks = 0;
const check = (label, ok, detail = '') => { assert.ok(ok, `${label} ${detail}`); checks++; console.log('PASS ' + label); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const chicago = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
const [y, m, d] = ['year', 'month', 'day'].map((t) => Number(chicago.find((p) => p.type === t).value));
const ago = (days) => new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);

// A solid-colour PNG, so no real photo is needed.
function png(w, h, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), cr = Buffer.alloc(4); len.writeUInt32BE(data.length); cr.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

async function scenario(name, seedFn, run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-home-featured-'));
  let server, db;
  const logs = [];
  try {
    db = openDatabase(scratch); runMigrations(db, readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
    const now = Date.now();
    db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)").run(now);
    let n = 0;
    const seed = (slug, days, { section = 'news', area = 'conference', featured = 0, church = '', announcement = null, image = '', imageAlt = '', dek = 'Synthetic summary.' } = {}) => {
      db.prepare("INSERT INTO stories(slug,title,dek,section,area,author,church,date,image,image_alt,body,status,source,published_at,updated_at,featured,announcement) VALUES(?,?,?,?,?,'Synthetic Editor',?,?,?,?,'Synthetic body.','live','editor',?,?,?,?)")
        .run(slug, `Synthetic ${slug}`, dek, section, area, church, ago(days), image, imageAlt, now + n, now + n++, featured, announcement && JSON.stringify(announcement));
    };
    seedFn(seed, scratch, db);
    server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: port, DATA_DIR: scratch, SITE_URL: base, AUTH_SECRET: 'synthetic-home-featured-' + 'x'.repeat(40), RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (c) => logs.push(String(c))); server.stderr.on('data', (c) => logs.push(String(c)));
    let home;
    for (let i = 0; i < 100; i++) { try { home = await fetch(base + '/'); break; } catch { await delay(100); } }
    check(`[${name}] home answers 200`, home?.status === 200, String(home?.status));
    await run(await home.text());
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
    db?.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
}
const statline = (html) => html.match(/<p class="home-statline">([^<]*)<\/p>/)?.[1];
const panel = (html) => html.match(/<section class="featured-panel"[\s\S]*?<\/section>/)?.[0] ?? '';
const hrefs = (text) => [...text.matchAll(/href="\/stories\/([^"/]+)\//g)].map((x) => x[1]);

await scenario('empty', () => {}, (html) => {
  check('no stories: no statline and no panel', statline(html) === undefined && !html.includes('featured-panel'));
});

await scenario('none featured', (seed) => { seed('a', 1, { church: 'Synthetic Church One' }); seed('b', 2, { church: 'Synthetic Church One' }); }, (html) => {
  check('none featured: no panel renders', !html.includes('data-featured-panel'));
  check('two stories, one church: singular church, plural stories', statline(html) === '2 stories from 1 church, school or club across Iowa and Missouri', String(statline(html)));
});

await scenario('one story', (seed) => seed('solo', 1, { church: 'Synthetic Church One' }), (html) => {
  check('one story, one church: all singular', statline(html) === '1 story from 1 church, school or club across Iowa and Missouri', String(statline(html)));
});

await scenario('no church names', (seed) => { seed('a', 1, { church: '  ' }); seed('b', 2); }, (html) => {
  check('no church values: the line states only the story count', statline(html) === '2 stories across Iowa and Missouri', String(statline(html)));
});

await scenario('featured', (seed, scratch) => {
  const dir = path.join(scratch, 'media', 'stories', 'synthetic-panel'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lead.png'), png(1200, 800, [8, 126, 139]));
  seed('recent-1', 1, { church: 'Synthetic Church One' });
  seed('recent-2', 2, { church: 'synthetic church one ' });          // same church, different case and spacing
  seed('recent-3', 3, { church: 'Synthetic Church Two' });
  seed('recent-4', 4);
  seed('recent-5', 5, { church: 'Synthetic School Three' });
  seed('old-featured', 400, { featured: 1, church: 'Synthetic Club Four', image: '/media/stories/synthetic-panel/lead.png', imageAlt: 'A plain teal rectangle' });
  seed('older-featured', 500, { featured: 1, church: 'Synthetic Church Five' });
  seed('featured-event', 1, { featured: 1, church: 'Synthetic Church Six', announcement: { kind: 'event', eventDate: ago(-10) } });
  seed('featured-announcement', 0, { featured: 1, announcement: { kind: 'announcement' } });
}, async (html) => {
  const p = panel(html);
  check('an old featured story still shows: the newest featured story fills the panel', p.includes('href="/stories/old-featured/"') && p.includes('Synthetic old-featured'));
  check('the panel names the section, the church and links to the story', p.includes('News') && p.includes('Synthetic Club Four') && /class="featured-link/.test(p));
  check('the panel photo keeps its alt text', p.includes('alt="A plain teal rectangle"') && p.includes('src="/media/stories/synthetic-panel/lead.png"'));
  check('the panel has no second, older featured story', !p.includes('older-featured'));
  check('an announcement or event marked featured is never the panel', !p.includes('featured-event') && !p.includes('featured-announcement'));
  check('the panel sits after the events and before the hero', html.indexOf('data-featured-panel') > html.indexOf('data-event-spotlight') && html.indexOf('data-featured-panel') < html.indexOf('aria-label="Top stories"'));
  const hero = html.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? '';
  check('the panel story is not repeated in the hero or the latest list', !hero.includes('/stories/old-featured/'));
  check('other featured stories still lead the hero as before', hrefs(hero).includes('older-featured'), hrefs(hero).join());
  const rest = html.replace(p, '');
  check('the panel story appears nowhere else on the page', !rest.includes('/stories/old-featured/'));
  // 9 live stories: recent 1-5, two featured, a featured event, a featured announcement.
  check('statline counts live stories and distinct churches (case-insensitive, blanks skipped)', statline(html) === '9 stories from 6 churches, schools and clubs across Iowa and Missouri', String(statline(html)));
  check('the statline sits in the intro, above the panel', html.indexOf('home-statline') < html.indexOf('data-featured-panel'));
});

const moduleOf = (html) => html.match(/<section class="block latest-issue"[\s\S]*?<\/section>/)?.[0] ?? '';
const inIssue = (seed, db, slugs, featuredSlug) => {
  db.prepare("INSERT INTO newsletter_issues (number, date, title, created_at, updated_at) VALUES (7, ?, '', 1, 1)").run(ago(3));
  slugs.forEach((slug, i) => { seed(slug, 10 + i, { featured: slug === featuredSlug ? 1 : 0 }); db.prepare('UPDATE stories SET newsletter_issue = 7, newsletter_position = ?, rev = rev + 1 WHERE slug = ?').run(i + 1, slug); });
};

await scenario('featured in a big issue', (seed, _s, db) => inIssue(seed, db, ['i1', 'i2', 'i3', 'i4'], 'i1'), (html) => {
  const mod = hrefs(moduleOf(html));
  check('a four-story issue: the module skips the panel story and still shows three', mod.join() === 'i2,i3,i4', mod.join());
  check('the panel story is the featured one', panel(html).includes('/stories/i1/'));
});

await scenario('featured in a small issue', (seed, _s, db) => inIssue(seed, db, ['j1', 'j2', 'j3'], 'j1'), (html) => {
  const mod = hrefs(moduleOf(html));
  check('a three-story issue: the module keeps the panel story rather than show fewer', mod.join() === 'j1,j2,j3', mod.join());
  check('the panel itself still shows it', panel(html).includes('/stories/j1/'));
});
await scenario('only the featured story', (seed, scratch) => {
  const dir = path.join(scratch, 'media', 'stories', 'synthetic-panel'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lead.png'), png(1200, 800, [8, 126, 139]));
  seed('only', 40, { featured: 1, church: 'Synthetic Church One', image: '/media/stories/synthetic-panel/lead.png', imageAlt: 'Synthetic only' });
}, (html) => {
  const p = panel(html);
  check('only story is featured: the panel shows it', p.includes('/stories/only/'));
  check('the empty state and the empty "Stories worth sharing" block are not shown under the panel', !html.includes('No stories yet') && !html.includes('Stories worth sharing') && !html.includes('class="hero"'));
  check('the statline still counts the story', statline(html) === '1 story from 1 church, school or club across Iowa and Missouri', String(statline(html)));
  check('the panel link is named by its title', p.includes('aria-labelledby="featured-title"') && p.includes('id="featured-title"'));
  check('alt text equal to the title becomes empty alt', /<img[^>]* alt(="")?[ >]/.test(p) && !p.includes('alt="Synthetic only"'));
  check('with no events above, the panel photo loads eagerly at high priority', p.includes('loading="eager"') && p.includes('fetchpriority="high"'));
});

await scenario('church normalisation', (seed) => {
  seed('c1', 1, { church: 'St. Mark’s Church' });
  seed('c2', 2, { church: "  st. mark's   CHURCH " });
  seed('c3', 3, { church: 'Des Moines Seventh-day Adventist Church' });
  seed('c4', 4, { church: 'Des Moines SDA Church' });
  seed('c5', 5, { church: 'Iowa-Missouri Conference' });
  seed('c6', 6, { church: 'Conference Office' });
  seed('c7', 7, { church: 'Synthetic Club' });
}, (html) => {
  check('curly/straight apostrophes, case and spacing fold together; SDA equals Seventh-day Adventist; conference-office values are not counted (7 stories, 3 places)', statline(html) === '7 stories from 3 churches, schools and clubs across Iowa and Missouri', String(statline(html)));
});

console.log(`\n${checks} home featured-panel checks passed.`);
