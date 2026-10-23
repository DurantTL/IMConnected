#!/usr/bin/env node
// Check of scripts/import-git-stories.mjs (epic #25, step 4) against a throwaway DATA_DIR and a throwaway folder of
// synthetic Markdown stories. No server is needed.
//   SCRATCH=/tmp/.../import-test node scripts/test-import-git-stories.mjs      # from the repo root
// SCRATCH is created fresh (after a throwaway-path check) and deleted at the end unless KEEP=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.SCRATCH) throw new Error('Set SCRATCH to a throwaway folder.');
const SCRATCH = path.resolve(process.env.SCRATCH);
const roots = [os.tmpdir(), '/tmp'].map((r) => path.resolve(r) + path.sep);
if (SCRATCH === '/data' || SCRATCH.startsWith('/data' + path.sep) || !roots.some((r) => SCRATCH.startsWith(r) && SCRATCH.length > r.length)) throw new Error(`Refusing to delete ${SCRATCH}.`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const DATA = path.join(SCRATCH, 'data');
const DIR = path.join(SCRATCH, 'stories');
const PUB = path.join(SCRATCH, 'public');
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(path.join(PUB, 'images/stories/zz-hand-story'), { recursive: true });
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(40, 7), Buffer.from([0xff, 0xd9])]);
fs.writeFileSync(path.join(PUB, 'images/stories/zz-hand-story/photo-1.jpg'), JPG);
fs.writeFileSync(path.join(PUB, 'images/stories/zz-hand-story/fake.jpg'), 'plain text pretending to be a picture');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 500)}`); if (!ok) fails++; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const q = (sql, ...a) => { const db = new DatabaseSync(path.join(DATA, 'imconnected.db')); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const run = (sql, ...a) => { const db = new DatabaseSync(path.join(DATA, 'imconnected.db')); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...a); } finally { db.close(); } };
const imp = (...args) => {
  const r = spawnSync('node', ['scripts/import-git-stories.mjs', '--dir', DIR, '--public', PUB, ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA }, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const md = (title, extra = '', body = 'A synthetic story written by hand for the import test.') => `---\ntitle: "${title}"\nsection: news\narea: churches\nauthor: "Test Author"\ndate: 2026-10-05\n${extra}featured: false\ndraft: false\n---\n${body}\n`;
const write = (slug, text) => fs.writeFileSync(path.join(DIR, slug + '.md'), text);
const mediaFiles = () => { const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name))); }; walk(path.join(DATA, 'media')); return out; };

try {
  write('zz-hand-story', md('Hand Story', 'image: "/images/stories/zz-hand-story/photo-1.jpg"\nimageAlt: "A synthetic picture"\n'));
  write('zz-second-story', md('Second Hand Story'));
  let r = imp();
  check('a dry run lists what it would create and says nothing was written', r.code === 0 && /DRY RUN/.test(r.out) && /create\s+zz-hand-story/.test(r.out) && /create\s+zz-second-story/.test(r.out) && /Nothing was written/.test(r.out), r.out);
  check('...and really wrote nothing (no story rows, no media files)', q('SELECT COUNT(*) n FROM stories')[0].n === 0 && mediaFiles().length === 0);

  r = imp('--apply');
  const s1 = q("SELECT * FROM stories WHERE slug = 'zz-hand-story'")[0];
  const p1 = q("SELECT p.* FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = 'zz-hand-story'");
  check('--apply creates both stories, live, source git, not marked as edited in the dashboard', r.code === 0 && q('SELECT COUNT(*) n FROM stories')[0].n === 2 && s1.status === 'live' && s1.source === 'git' && s1.edited_at === null && s1.title === 'Hand Story' && s1.date === '2026-10-05', r.out);
  check('...the photo is copied to stories/<slug>/<sha256>.jpg in the media folder, keeping its /images address in the story', p1.length === 1 && p1[0].path === `stories/zz-hand-story/${sha(JPG)}.jpg` && fs.readFileSync(path.join(DATA, 'media', p1[0].path)).equals(JPG) && s1.image === '/images/stories/zz-hand-story/photo-1.jpg' && s1.image_alt === 'A synthetic picture');

  r = imp('--apply');
  check('running it again changes nothing ("same")', r.code === 0 && /same\s+zz-hand-story/.test(r.out) && /0 created, 0 updated, 2 unchanged/.test(r.out), r.out);

  write('zz-second-story', md('Second Hand Story, Corrected', '', 'The text was fixed in git.'));
  r = imp();
  check('a changed file is reported as an update in a dry run, and not applied', /update\s+zz-second-story/.test(r.out) && q("SELECT title FROM stories WHERE slug = 'zz-second-story'")[0].title === 'Second Hand Story');
  r = imp('--apply');
  check('...and updated with --apply', q("SELECT title, body FROM stories WHERE slug = 'zz-second-story'")[0].body === 'The text was fixed in git.' && q("SELECT title FROM stories WHERE slug = 'zz-second-story'")[0].title === 'Second Hand Story, Corrected');

  // a story changed in the dashboard since its import is never overwritten without --force
  run("UPDATE stories SET rev = rev + 1, title = 'Edited in the dashboard', source = 'editor', edited_at = ? WHERE slug = 'zz-hand-story'", Date.now());
  write('zz-hand-story', md('Hand Story Changed In Git', 'image: "/images/stories/zz-hand-story/photo-1.jpg"\nimageAlt: "A synthetic picture"\n'));
  r = imp('--apply');
  check('a story edited in the dashboard since its last import is left alone (reported, not overwritten)', /skip\s+zz-hand-story.*changed in the dashboard or Studio.*--force overwrites/.test(r.out) && q("SELECT title, source FROM stories WHERE slug = 'zz-hand-story'")[0].title === 'Edited in the dashboard', r.out);
  // unpublished in the dashboard (source still git, but edited_at set) is also protected
  run("UPDATE stories SET rev = rev + 1, title = 'Unpublished in the dashboard', source = 'git', status = 'unpublished', edited_at = ? WHERE slug = 'zz-hand-story'", Date.now());
  r = imp('--apply');
  check('...a story only unpublished in the dashboard (edited_at set) is protected too', /skip\s+zz-hand-story/.test(r.out) && q("SELECT status FROM stories WHERE slug = 'zz-hand-story'")[0].status === 'unpublished');
  r = imp('--apply', '--force');
  const f = q("SELECT * FROM stories WHERE slug = 'zz-hand-story'")[0];
  check('--force overwrites it: git text, live again, source git, edited_at cleared', /update\s+zz-hand-story.*--force/.test(r.out) && f.title === 'Hand Story Changed In Git' && f.status === 'live' && f.source === 'git' && f.edited_at === null, r.out);

  // issue #136: an older file that still says section: columns is imported as features, keeping its column name
  write('zz-old-column', md('Old Column').replace('section: news\narea: churches', 'section: columns\ncolumn: "From the Synthetic Desk"'));
  r = imp('--apply');
  const oc = q("SELECT section, area, story_column FROM stories WHERE slug = 'zz-old-column'")[0];
  check('section: columns in a hand-written file is imported as features and its column name is dropped', r.code === 0 && oc?.section === 'features' && !oc.area && oc.story_column === '', r.out + JSON.stringify(oc));

  // refusals
  write('zz-draft-story', md('Draft Story').replace('draft: false', 'draft: true'));
  write('zz-bad-section', md('Bad Section').replace('section: news', 'section: nonsense'));
  write('zz-bad-area', md('Bad Area').replace('area: churches', 'area: nonsense'));
  write('zz-no-photo', md('No Photo', 'image: "/images/stories/zz-hand-story/missing.jpg"\n'));
  write('zz-fake-photo', md('Fake Photo', 'image: "/images/stories/zz-hand-story/fake.jpg"\n'));
  write('zz-traversal', md('Traversal', 'image: "/images/../../etc/passwd.jpg"\n'));
  write('zz-remote', md('Remote Photo', 'image: "https://example.test/photo.jpg"\n'));
  write('Bad Name', md('Bad File Name'));
  write('zz-nofront', 'just text, no front matter\n');
  const before = q('SELECT COUNT(*) n FROM stories')[0].n;
  r = imp('--apply');
  check('a draft: true file is skipped; invalid files are errors (exit 1) that name the file and why', r.code === 1 && /skip\s+zz-draft-story/.test(r.out) && /ERROR\s+zz-bad-section.*unknown section/.test(r.out) && /ERROR\s+zz-bad-area.*area/.test(r.out) && /ERROR\s+zz-no-photo.*not found/.test(r.out) && /ERROR\s+zz-fake-photo.*not really a jpg/.test(r.out) && /ERROR\s+zz-traversal.*not allowed/.test(r.out) && /ERROR\s+Bad Name/.test(r.out) && /ERROR\s+zz-nofront.*front matter/.test(r.out), r.out);
  check('...only the valid new story (remote photo) was created, and no half-written rows or files exist for the failures', q('SELECT COUNT(*) n FROM stories')[0].n === before + 1 && q("SELECT url FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = 'zz-remote'")[0].url === 'https://example.test/photo.jpg' && !q("SELECT 1 FROM stories WHERE slug IN ('zz-bad-section','zz-no-photo','zz-fake-photo','zz-traversal','zz-draft-story')").length && mediaFiles().every((m) => !/zz-(no-photo|fake-photo)/.test(m)), r.out);
  // body safety, link targets and photo limits
  write('zz-html', md('Html Story', '', 'Plain text then <script>alert(1)</script> and <b>bold</b> and [fine](https://example.test/ok) and [rel](/news/).'));
  write('zz-js-link', md('Js Link', '', 'A [bad link](javascript:alert(1)) here.'));
  write('zz-data-image', md('Data Image', '', 'An ![image](data:text/html,x) here.'));
  write('zz-ref-link', md('Ref Link', '', 'See [this][1].\n\n[1]: JaVaScRiPt:alert(1)'));
  write('zz-many-photos', md('Many Photos', 'image: "/images/stories/zz-hand-story/photo-1.jpg"\nphotos:\n' + Array.from({ length: 6 }, () => '  - "/images/stories/zz-hand-story/photo-1.jpg"\n').join('')));
  fs.writeFileSync(path.join(PUB, 'images/stories/zz-hand-story/big.jpg'), Buffer.concat([JPG, Buffer.alloc(10 * 1024 * 1024 + 10)]));
  write('zz-big-photo', md('Big Photo', 'image: "/images/stories/zz-hand-story/big.jpg"\n'));
  r = imp('--apply');
  const html = q("SELECT body FROM stories WHERE slug = 'zz-html'")[0]?.body ?? '';
  check('a "<" in the body is stored as &lt; (no tag can be stored), links that are fine stay', !html.includes('<') && html.includes('&lt;script>alert(1)&lt;/script>') && html.includes('[fine](https://example.test/ok)') && html.includes('[rel](/news/)'), html);
  check('javascript:, data: and reference-style javascript: link targets are refused, nothing stored', ['zz-js-link', 'zz-data-image', 'zz-ref-link'].every((n) => new RegExp(`ERROR\\s+${n}.*not a web, mail or tel link`).test(r.out) && !q('SELECT 1 FROM stories WHERE slug = ?', n).length), r.out);
  check('more than the photo count limit, or a photo over the size limit, is refused', /ERROR\s+zz-many-photos.*more than 6 photos/.test(r.out) && /ERROR\s+zz-big-photo.*larger than 10 MB/.test(r.out) && !q("SELECT 1 FROM stories WHERE slug IN ('zz-many-photos','zz-big-photo')").length, r.out);
  const unknown = imp('--bogus');
  check('an unknown option is refused', unknown.code === 2);
  // photoLayout (issue #35): a valid one is imported, an unknown one is an error that names the file, a missing one reads "one"
  write('zz-layout-good', md('Layout Good', 'photoLayout: mosaic\n'));
  write('zz-layout-bad', md('Layout Bad', 'photoLayout: filmstrip\n'));
  write('zz-layout-none', md('Layout None'));
  r = imp('--apply');
  check('photoLayout in a story file: a valid value is imported, an unknown value is an error naming the file, a missing one means "one"',
    /ERROR\s+zz-layout-bad.*photoLayout/.test(r.out) && q("SELECT photo_layout p FROM stories WHERE slug = 'zz-layout-good'")[0]?.p === 'mosaic' && q("SELECT photo_layout p FROM stories WHERE slug = 'zz-layout-none'")[0]?.p === 'one' && q("SELECT COUNT(*) n FROM stories WHERE slug = 'zz-layout-bad'")[0].n === 0, r.out);
  r = imp('--apply');
  check('...and a second run reports the layout story as unchanged', /same\s+zz-layout-good/.test(r.out), r.out);

  // photo captions (issue #84): empty by default; imageCaption and photoCaptions are imported as plain text (a "<" is kept as typed, escaped on output)
  write('zz-caption-good', md('Caption Good', 'image: "/images/stories/zz-hand-story/photo-1.jpg"\nimageAlt: "A synthetic picture"\nimageCaption: "A synthetic lead caption <b>kept as text</b>"\nphotos:\n  - "/images/stories/zz-hand-story/photo-1.jpg"\nphotoCaptions:\n  - "Second caption"\n'));
  write('zz-caption-long', md('Caption Long', 'image: "/images/stories/zz-hand-story/photo-1.jpg"\nimageCaption: "' + 'c'.repeat(301) + '"\n'));
  r = imp('--apply');
  const capRows = (slug) => q("SELECT p.caption c FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = ? ORDER BY p.position", slug).map((x) => x.c);
  check('captions in a story file are imported per photo; a story without any has the empty default', JSON.stringify(capRows('zz-caption-good')) === JSON.stringify(['A synthetic lead caption <b>kept as text</b>', 'Second caption']) && capRows('zz-hand-story').every((c) => c === ''), JSON.stringify(capRows('zz-caption-good')));
  check('a caption over 300 characters is an error naming the file, nothing stored', /ERROR\s+zz-caption-long.*300/.test(r.out) && !q("SELECT 1 FROM stories WHERE slug = 'zz-caption-long'").length, r.out);
  r = imp('--apply');
  check('...and a second run reports the captioned story as unchanged', /same\s+zz-caption-good/.test(r.out), r.out);

  // story modules (migration 017): an image module may only show the story's own photos; module text is escaped like the body
  const mods = (blocks) => `storyBlocks: ${JSON.stringify(blocks)}\n`;
  const own = '/images/stories/zz-hand-story/photo-1.jpg';
  const lead = `image: "${own}"\nimageAlt: "A synthetic picture"\n`;
  write('zz-mod-good', md('Modules Good', lead + mods([
    { id: 'p', type: 'text', text: 'A synthetic paragraph.' },
    { id: 'h', type: 'heading', level: 2, text: 'A <b>heading</b>' },
    { id: 'i', type: 'image', url: own, alt: 'A <i>picture</i>' },
  ])));
  write('zz-mod-external', md('Modules External', lead + mods([{ id: 'i', type: 'image', url: 'https://example.test/outside.jpg', alt: 'x' }])));
  write('zz-mod-foreign', md('Modules Foreign', lead + mods([{ id: 'i', type: 'image', url: '/images/stories/another-story/photo-1.jpg', alt: 'x' }])));
  write('zz-mod-nophoto', md('Modules No Photo', mods([{ id: 'i', type: 'image', url: own, alt: 'x' }])));
  r = imp('--apply');
  const good = q("SELECT body, story_blocks FROM stories WHERE slug = 'zz-mod-good'")[0];
  check('an image module that shows the story\'s own photo is imported, with module text stored as &lt; (no "<" anywhere)', !!good && !good.story_blocks.includes('<') && !good.body.includes('<') && JSON.parse(good.story_blocks)[2].url === own && JSON.parse(good.story_blocks)[1].text.includes('&lt;b>heading&lt;/b>') && !good.body.includes('A synthetic picture') && !good.body.includes('\\&lt;'), r.out + JSON.stringify(good));
  check('an image module with an external address, another story\'s photo, or no photo at all is an error naming the file, and nothing is stored',
    ['zz-mod-external', 'zz-mod-foreign', 'zz-mod-nophoto'].every((n) => new RegExp(`ERROR\\s+${n}.*own photos`).test(r.out) && !q('SELECT 1 FROM stories WHERE slug = ?', n).length), r.out);
  r = imp('--apply');
  check('...and a second run reports the module story as unchanged', /same\s+zz-mod-good/.test(r.out), r.out);
  const cropStory = (zoom) => md('Synthetic crop metadata', lead + `photoFocus: [{ focalX: 17, focalY: 83, zoom: ${zoom} }]\n`);
  write('zz-crop-good', cropStory(1.8));
  write('zz-crop-bad', cropStory(4));
  r = imp('--apply');
  const crop = q("SELECT p.focal_x, p.focal_y, p.zoom FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = 'zz-crop-good'")[0];
  check('import preserves crop focus and zoom while rejecting out-of-range zoom', crop?.focal_x === 17 && crop.focal_y === 83 && crop.zoom === 1.8 && /ERROR\s+zz-crop-bad.*zoom/.test(r.out) && !q("SELECT 1 FROM stories WHERE slug = 'zz-crop-bad'").length, r.out);
  r = imp('--apply');
  check('a second crop import is unchanged', /same\s+zz-crop-good/.test(r.out), r.out);
  write('zz-crop-good', cropStory(2.2));
  r = imp('--apply');
  check('changing only zoom updates imported metadata', /update\s+zz-crop-good/.test(r.out) && q("SELECT p.zoom FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = 'zz-crop-good'")[0]?.zoom === 2.2, r.out);
} catch (err) {
  console.error('ERROR', err);
  fails++;
} finally {
  if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
