// Issue #97: the home page draws from the last 90 days plus featured stories. Synthetic stories, throwaway DATA_DIR, local server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const port = process.env.PORT || '4890', base = `http://localhost:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-home-recent-'));
let server, db, checks = 0;
const logs = [], check = (label, ok, detail = '') => { assert.ok(ok, `${label} ${detail}`); checks++; console.log('PASS ' + label); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// "Today" is the America/Chicago calendar day, as the server computes it; dates are relative to it.
const chicago = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
const [y, m, d] = ['year', 'month', 'day'].map((t) => Number(chicago.find((p) => p.type === t).value));
const ago = (days) => new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);

try {
  db = openDatabase(scratch); runMigrations(db, readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
  const now = Date.now();
  db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)").run(now);
  let n = 0;
  const seed = (slug, days, section, area, featured = 0, announcement = null) => {
    db.prepare("INSERT INTO stories(slug,title,dek,section,area,author,date,image,image_alt,body,status,source,published_at,updated_at,featured,announcement) VALUES(?,?,?,?,?,'Synthetic Editor',?,'','','Synthetic body.','live','editor',?,?,?,?)")
      .run(slug, `Synthetic ${slug}`, 'Synthetic summary.', section, area, ago(days), now + n, now + n++, featured, announcement && JSON.stringify(announcement));
  };
  seed('news-today', 0, 'news', 'conference');
  seed('news-89', 89, 'news', 'conference');
  seed('news-90', 90, 'news', 'conference');
  seed('news-91', 91, 'news', 'conference');
  seed('news-400', 400, 'news', 'conference');
  seed('news-featured-400', 400, 'news', 'conference', 1);
  seed('schools-old', 120, 'news', 'schools');
  seed('churches-recent', 30, 'news', 'churches');
  seed('youth-old', 200, 'youth', 'youth');
  seed('features-old', 150, 'features', '');
  seed('kids-recent', 5, 'kids', '');
  // Old-dated events: one still upcoming and one undated stay in the event spotlight; an old announcement never does. None may reach the archive rail.
  seed('event-old-upcoming', 300, 'news', 'conference', 0, { kind: 'event', eventDate: ago(-30) });
  seed('event-old-undated', 310, 'news', 'conference', 0, { kind: 'event' });
  seed('announcement-old', 320, 'news', 'conference', 0, { kind: 'announcement' });

  server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: port, DATA_DIR: scratch, SITE_URL: base, AUTH_SECRET: 'synthetic-home-recent-' + 'x'.repeat(40), RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (c) => logs.push(String(c))); server.stderr.on('data', (c) => logs.push(String(c)));
  let home;
  for (let i = 0; i < 100; i++) { try { home = await fetch(base + '/'); break; } catch { await delay(100); } }
  check('server starts and the home page answers 200', home?.status === 200, String(home?.status));
  const html = await home.text();
  const main = html.replace(/<section class="block archive-rail"[\s\S]*?<\/section>/, '');
  const on = (slug, text = main) => text.includes(`href="/stories/${slug}/"`);

  for (const slug of ['news-today', 'news-89', 'news-90', 'churches-recent', 'kids-recent']) check(`${slug} (inside the 90 days) is on the home page`, on(slug));
  for (const slug of ['news-91', 'news-400', 'schools-old', 'youth-old', 'features-old']) check(`${slug} (older, not featured) is nowhere on the home page`, !on(slug));
  check('a featured story 400 days old is on the home page', on('news-featured-400'));
  const lead = html.match(/class="hero[^"]*"[\s\S]*?href="\/stories\/([^"/]+)\//)?.[1];
  check('the old featured story leads the hero (featured first, then newest)', lead === 'news-featured-400', String(lead));
  const side = [...(html.match(/class="latest-stories"[\s\S]*?<\/ol>/)?.[0] || '').matchAll(/href="\/stories\/([^"/]+)\//g)].map((x) => x[1]);
  check('the latest rail is newest first and holds only recent stories', side.join() === 'news-today,kids-recent,churches-recent', side.join());
  check('a section with only old stories has no block on the home page (Youth, Features)', !/<h2>Youth &amp; Pathfinders<\/h2>/.test(html) && !/<h2>Features<\/h2>/.test(html));
  check('a recent section keeps its block (Kids)', /<h2>Kids<\/h2>/.test(html));
  const schools = html.match(/<h3 class="area-title"><a href="\/news\/schools\/">[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  check('a news area with only old stories keeps its invitation', schools.includes('area-invitation') && schools.includes('Your community’s next story belongs here.') && !on('schools-old', schools));

  // Issue #100: the "From the archive" rail. Older stories not already above: news-91, news-400, schools-old, youth-old, features-old (the featured 400 day story leads the hero).
  const railOf = (text) => text.match(/<section class="block archive-rail"[\s\S]*?<\/section>/)?.[0] || '';
  const rail = railOf(html);
  const railSlugs = [...rail.matchAll(/class="card[^"]*" href="\/stories\/([^"/]+)\//g)].map((x) => x[1]);
  check('the archive rail is on the home page with its heading and explanation', /<h2 id="archive-title">From the archive<\/h2>/.test(rail) && rail.includes('Stories from past issues of IMConnected'));
  check('the archive rail shows four stories', railSlugs.length === 4, railSlugs.join());
  check('the archive rail holds only stories older than the window', railSlugs.every((x) => ['news-91', 'news-400', 'schools-old', 'youth-old', 'features-old'].includes(x)), railSlugs.join());
  const above = html.slice(0, html.indexOf('class="block archive-rail"')).split('href="/stories/').slice(1).map((chunk) => chunk.split('/')[0]);
  check('the archive rail never repeats the hero story or anything shown above', !railSlugs.includes('news-featured-400') && !above.some((x) => railSlugs.includes(x)));
  check('old upcoming and undated events are in the spotlight above, never in the archive rail', on('event-old-upcoming') && on('event-old-undated') && !railSlugs.some((x) => x.startsWith('event-')));
  check('an old announcement is not in the archive rail', !railSlugs.includes('announcement-old'));
  check('each archive card shows its original date', (rail.match(/class="meta">[^<]*· [A-Z][a-z]+ \d+, \d{4}</g) || []).length === 4);
  check('the archive rail links to the issues browser', rail.includes('href="/issues/"'));
  check('the same day gives the same archive rail', railOf(await (await fetch(base + '/')).text()) === rail);
  check('the archive rail sits after the last story block and before the submit call to action', html.indexOf('class="block archive-rail"') > html.indexOf('data-sec="kids"') && html.indexOf('class="block archive-rail"') < html.indexOf('aria-label="Submit a story"'));

  for (const [p, slugs] of [['/news/', ['news-today', 'news-91', 'news-400', 'news-featured-400', 'schools-old']], ['/news/schools/', ['schools-old']], ['/youth/', ['youth-old']], ['/features/', ['features-old']]]) {
    const text = await (await fetch(base + p)).text();
    check(`${p} still lists the old stories (${slugs.length} checked)`, slugs.every((s) => on(s, text)));
  }
  const feed = await (await fetch(base + '/stories.json')).text();
  check('/stories.json still includes the old stories', feed.includes('news-400') && feed.includes('youth-old'));
  console.log(`\n${checks} homepage recency checks passed.`);
} finally {
  if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
  db?.close(); fs.rmSync(scratch, { recursive: true, force: true });
}
