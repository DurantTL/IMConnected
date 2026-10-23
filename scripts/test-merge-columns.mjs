#!/usr/bin/env node
// Issue #136: the Columns section is merged into Features. Migration 036 on a database that already has columns rows,
// the public pages, feeds, search and navigation afterwards. Synthetic data, a throwaway DATA_DIR, a local server.
// (The agent API, Studio and revision-restore mappings are checked in test-agent-api.mjs and test-editor-drafts.mjs.)
//   npm run build && node scripts/test-merge-columns.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const port = process.env.PORT || '4893', base = `http://localhost:${port}`;
let checks = 0;
const check = (label, ok, detail = '') => { assert.ok(ok, `${label} ${detail}`); checks++; console.log('PASS ' + label); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = path.resolve('src/lib/db/migrations');
const all = readMigrationsFromDir(dir);
const today = new Date().toISOString().slice(0, 10);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-merge-columns-'));
let server, db;
try {
  db = openDatabase(scratch);
  runMigrations(db, all.filter((m) => m.name < '036'));
  const now = Date.now();
  db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)").run(now);
  let n = 0;
  const story = (slug, section, extras, column = null, area = null) => db.prepare("INSERT INTO stories(slug,title,dek,section,area,story_column,author,date,body,status,source,published_at,updated_at,additional_sections) VALUES(?,?,?,?,?,?, 'Synthetic Editor', ?, 'Synthetic body text for the story.', 'live','editor',?,?,?)")
    .run(slug, `Synthetic ${slug}`, 'Synthetic summary.', section, area, column, today, now + n, now + n++, JSON.stringify(extras));
  story('col-plain', 'columns', [], 'From the Synthetic Desk');
  story('col-with-features', 'columns', ['features', 'youth'], 'Voices Column');
  story('news-with-columns', 'news', ['columns', 'youth'], null, 'churches');
  story('news-untouched', 'news', ['youth'], null, 'churches');
  story('feature-with-name', 'features', [], 'A Stray Column Name');
  story('youth-mixed', 'youth', ['kids', 'columns', 'features'], null, 'youth');
  story('feature-plain', 'features', []);
  story('feature-with-columns', 'features', ['columns']);
  const before = Object.fromEntries(db.prepare('SELECT slug, rev, updated_at, title, body, area FROM stories').all().map((r) => [r.slug, r]));
  const dr = db.prepare("INSERT INTO drafts(status,source,title,section,area,story_column,author,date,body,additional_sections,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  dr.run('new', 'form', 'Synthetic column draft', 'columns', '', 'Draft Column', 'Synthetic Author', today, 'b', '["features"]', now, now);
  dr.run('in_review', 'editor', 'Synthetic extras draft', 'news', 'churches', '', 'Synthetic Author', today, 'b', '["columns","kids"]', now, now);
  dr.run('in_review', 'editor', 'Synthetic untouched draft', 'kids', '', '', 'Synthetic Author', today, 'b', '["youth"]', now, now);
  const draftBefore = db.prepare('SELECT id, updated_at, title FROM drafts ORDER BY id').all();
  const applied = runMigrations(db, all);
  check('migration 036 applies on a database that has columns rows', applied.length === 1 && applied[0].startsWith('036_'), JSON.stringify(applied));
  const row = (slug) => db.prepare('SELECT slug, section, story_column, additional_sections, rev, updated_at, title, body, area FROM stories WHERE slug = ?').get(slug);
  check('a columns story becomes features, loses its column name, keeps its other fields, and bumps rev', row('col-plain').section === 'features' && row('col-plain').story_column === '' && row('col-plain').rev === before['col-plain'].rev + 1 && row('col-plain').updated_at === before['col-plain'].updated_at && row('col-plain').body === before['col-plain'].body);
  check('...and drops features from its additional sections (a primary is never an extra)', row('col-with-features').additional_sections === '["youth"]', row('col-with-features').additional_sections);
  check('a "columns" extra becomes "features" (central order, de-duplicated, never the primary); such stories bump rev', row('news-with-columns').section === 'news' && row('news-with-columns').additional_sections === '["features","youth"]' && row('youth-mixed').additional_sections === '["features","kids"]' && row('youth-mixed').rev === before['youth-mixed'].rev + 1 && row('news-with-columns').rev === before['news-with-columns'].rev + 1 && row('news-with-columns').area === 'churches', JSON.stringify(row('news-with-columns')));
  check('a features story whose only extra was columns ends with an empty list', row('feature-with-columns').additional_sections === '[]' && row('feature-with-columns').section === 'features');
  check('a column name on any story is emptied (rev bumped)', row('feature-with-name').story_column === '' && row('feature-with-name').rev === before['feature-with-name'].rev + 1 && db.prepare("SELECT count(*) c FROM stories WHERE COALESCE(story_column,'') <> ''").get().c === 0 && db.prepare("SELECT count(*) c FROM drafts WHERE story_column <> ''").get().c === 0);
  check('stories that mentioned no columns are untouched (same rev)', row('news-untouched').rev === before['news-untouched'].rev && row('news-untouched').additional_sections === '["youth"]' && row('feature-plain').rev === before['feature-plain'].rev);
  const d = db.prepare('SELECT id, section, story_column, additional_sections, updated_at, title FROM drafts ORDER BY id').all();
  check('drafts follow: section, extras and an empty column name, nothing else', d[0].section === 'features' && d[0].story_column === '' && d[0].additional_sections === '[]' && d[1].section === 'news' && d[1].additional_sections === '["features","kids"]' && d[2].section === 'kids' && d[2].additional_sections === '["youth"]' && d.every((x, i) => x.updated_at === draftBefore[i].updated_at && x.title === draftBefore[i].title), JSON.stringify(d));
  check('no row says columns any more, and no extra equals its primary', db.prepare("SELECT (SELECT count(*) FROM stories WHERE section='columns' OR additional_sections LIKE '%columns%' OR EXISTS (SELECT 1 FROM json_each(additional_sections) WHERE value = stories.section)) + (SELECT count(*) FROM drafts WHERE section='columns' OR additional_sections LIKE '%columns%' OR EXISTS (SELECT 1 FROM json_each(additional_sections) WHERE value = drafts.section)) AS c").get().c === 0);
  check('...and the foreign key check is clean', db.prepare('PRAGMA foreign_key_check').all().length === 0);
  // A saved website menu from before the merge still has the built-in Columns link.
  db.prepare("INSERT INTO site_navigation(id,version,items,updated_at) VALUES(1,3,?,?)").run(JSON.stringify([
    { id: 'home', label: 'Latest', href: '/', visible: true }, { id: 'features', label: 'Features', href: '/features/', visible: true }, { id: 'columns', label: 'Columns', href: '/columns/', visible: true }, { id: 'kids', label: 'Kids', href: '/kids/', visible: true }]), now);
  db.close(); db = null;

  server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: port, DATA_DIR: scratch, SITE_URL: base, AUTH_SECRET: 'synthetic-merge-columns-' + 'x'.repeat(24), RESEND_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; server.stdout.on('data', (c) => logs.push(String(c))); server.stderr.on('data', (c) => logs.push(String(c)));
  let home;
  for (let i = 0; i < 100; i++) { try { home = await fetch(base + '/'); break; } catch { await delay(100); } }
  const html = await home.text();
  check('the home page answers', home.status === 200);
  check('the home page has no "Voices & perspectives" block, no Columns link and no Columns topic', !/Voices &amp; perspectives|voices-section|All columns/.test(html) && !/href="\/columns\//.test(html) && !/data-sec="columns"/.test(html));
  check('...and the Features block and topic directory are there, counting the migrated stories', /data-sec="features"/.test(html) && /<a href="\/features\/"[^>]*><span>Features<\/span><span class="topic-count">7 stories/.test(html), (html.match(/<nav class="topic-directory"[\s\S]*?<\/nav>/) ?? [''])[0].slice(0, 600));
  const feat = await (await fetch(base + '/features/')).text();
  check('/features/ lists the migrated column stories and shows no column name', ['col-plain', 'col-with-features'].every((s) => feat.includes(`/stories/${s}/`)) && !feat.includes('From the Synthetic Desk') && !feat.includes('Voices Column') && !feat.includes('A Stray Column Name') && !/>Columns</.test(feat));
  check('...and its blurb covers both', feat.includes('Longer stories, testimonies and regular voices from across the conference.'));
  const page = await (await fetch(base + '/stories/col-plain/')).text();
  check('the story page shows no column name, only the section', !page.includes('From the Synthetic Desk') && (page.split('<h1')[0].match(/<a class="kicker"[^>]*>[^<]*<\/a>/g) ?? []).join('').includes('Features'));
  const plain = await (await fetch(base + '/stories/feature-plain/')).text();
  check('a Features story shows just the section too', (plain.split('<h1')[0].match(/<a class="kicker"[^>]*>[^<]*<\/a>/g) ?? []).join('').includes('Features') && !plain.split('<h1')[0].includes('From the Synthetic Desk'));
  const feed = await (await fetch(base + '/stories.json')).json();
  const fs1 = feed.stories.find((s) => s.url.includes('/col-plain/'));
  check('/stories.json: section is features, no column name is exposed, the version is unchanged', feed.version === 1 && fs1?.section === 'features' && fs1.sectionLabel === 'Features' && fs1.column === undefined && !feed.stories.some((s) => s.section === 'columns' || (s.additionalSections ?? []).includes('columns')));
  const rss = await (await fetch(base + '/rss.xml')).text();
  check('/rss.xml has no Columns category', !/Columns/.test(rss) && /<category>Features<\/category>/.test(rss));
  const search = async (qs) => { let t = ''; for (let i = 0; i < 100; i++) { t = await (await fetch(base + '/api/search?' + qs)).text(); if (!t.includes('"ok":false')) break; await delay(200); } return t; };
  const sr = await search('q=synthetic&section=features');
  check('search by section features finds the migrated stories', ['col-plain', 'col-with-features', 'feature-plain'].every((s) => sr.includes(`/${s}/`)), sr.slice(0, 300));
  check('an old search link with section=columns is read as features', (await search('q=synthetic&section=columns')).includes('/col-plain/'));
  const nav = await (await fetch(base + '/api/navigation')).json();
  check('GET /api/navigation skips the old saved Columns item (not rejected)', nav.items.map((i) => i.id).join() === 'home,features,kids', JSON.stringify(nav.items));
  // a relabelled item that no longer points at /columns/ stays; the old built-in item is skipped even when relabelled
  const setMenu = (items) => { const d2 = openDatabase(scratch); d2.prepare('UPDATE site_navigation SET items = ?, version = version + 1').run(JSON.stringify(items)); d2.close(); };
  const navIds = async () => (await (await fetch(base + '/api/navigation')).json()).items.map((i) => i.id).join();
  setMenu([{ id: 'home', label: 'Latest', href: '/', visible: true }, { id: 'columns', label: 'Voices', href: '/columns/', visible: true }, { id: 'archive', label: 'Archive', href: '/features/', visible: true }]);
  check('the old Columns item is skipped even when relabelled', await navIds() === 'home,archive');
  setMenu([{ id: 'home', label: 'Latest', href: '/', visible: true }, { id: 'columns', label: 'Columns', href: '/features/', visible: true }]);
  check('an item with id columns that was repointed away from /columns/ stays', await navIds() === 'home,columns');
  setMenu([{ id: 'home', label: 'Latest', href: '/', visible: false }, { id: 'columns', label: 'Columns', href: '/columns/', visible: true }]);
  const fallback = await navIds();
  check('when removing the old item leaves no visible link, the default menu links are shown', fallback.startsWith('home,news,features') && !fallback.includes('columns'), fallback);
  const moved = await fetch(base + '/columns/', { redirect: 'manual' });
  check('/columns/ answers 301 to /features/', moved.status === 301 && new URL(moved.headers.get('location'), base).pathname === '/features/');
  console.log(`\nAll ${checks} checks passed`);
} finally {
  if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
  db?.close(); fs.rmSync(scratch, { recursive: true, force: true });
}
