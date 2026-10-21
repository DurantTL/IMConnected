#!/usr/bin/env node
// Import Markdown stories that were committed by hand into the database (epic #25, step 4).
//
// Stories live in the database now. The Markdown files in src/content/stories are a frozen archive that the site never
// reads. If someone adds or changes a story file in git anyway (or you have a folder of them), this script brings them
// in. It PRINTS WHAT IT WOULD CHANGE and changes nothing unless you pass --apply.
//
// Usage:
//   node scripts/import-git-stories.mjs [--dir src/content/stories] [--public public] [--apply] [--force]
//   Docker: copy the folder in first, e.g.
//     docker compose cp ./stories imconnected:/tmp/stories && docker compose cp ./public-images imconnected:/tmp/public
//     docker compose exec imconnected node scripts/import-git-stories.mjs --dir /tmp/stories --public /tmp/public --apply
//
//   --dir     folder of .md story files (top level only; the file name without .md is the story's address)
//   --public  folder that holds images/ (a story's /images/... photos are read from <public>/images/...)
//   --apply   write the changes (default: only report)
//   --force   also overwrite a story that was published, edited or unpublished in the dashboard or Studio since its
//             last import. Without --force such a story is always left alone.
//
// What it does for each file:
//   * no story with that address in the database: it is created (live; a file with draft: true is skipped);
//   * a story that was only ever imported from git and whose text differs: it is updated;
//   * a story that was changed in the dashboard or Studio since (stories.source is not 'git', or stories.edited_at is
//     set): left alone, reported as "changed in the dashboard or Studio ... --force overwrites it with the file", unless --force;
//   * an identical story: unchanged.
// Photos are copied to DATA_DIR/media/stories/<slug>/<sha256>.<ext>. The site's page cache is in the server's memory, so
// the server shows the change within about 10 minutes (or at once after a restart), and search picks new stories up
// within about a minute. Use synthetic data in tests; never run this against a real server's data without a backup.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { openDatabase, runMigrations, readMigrationsFromDir, dataDir } from '../src/lib/db/db-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const unknown = args.filter((a) => a.startsWith('--') && !['--dir', '--public', '--apply', '--force', '--help'].includes(a));
if (unknown.length) { console.error(`Unknown option ${unknown[0]}. Use --help.`); process.exit(2); }
const APPLY = flag('--apply');
const FORCE = flag('--force');
const DIR = path.resolve(opt('--dir', path.join(here, '../src/content/stories')));
const PUBLIC = path.resolve(opt('--public', path.join(here, '../public')));

// Sections, areas and limits come from the site's own definitions (src/lib/site.ts and limits.ts, so there is no second
// copy to drift). They are TypeScript files with only type annotations, which Node can load by stripping the types: built in
// from Node 22.18, behind --experimental-strip-types from 22.6 (package.json requires 22.22). On a Node that does not strip by
// default the script re-runs itself once with the flag, so it works on any 22.6+ image.
let site, limitsMod, blockMod;
try {
  site = await import(path.join(here, '../src/lib/site.ts'));
  limitsMod = await import(path.join(here, '../src/lib/limits.ts'));
  blockMod = await import(path.join(here, '../src/lib/story-blocks.ts'));
} catch (err) {
  if (!process.env.IMPORT_STRIP_RETRY && /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension/.test(String(err?.code ?? err))) {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, IMPORT_STRIP_RETRY: '1' } });
    process.exit(r.status ?? 2);
  }
  console.error('Cannot load src/lib/site.ts and limits.ts to check sections and limits:', err instanceof Error ? err.message : err);
  process.exit(2);
}
const LIMITS = limitsMod.LIMITS;

/** Same rule as src/lib/markdown.ts safeUrl: web, mail, tel, relative and anchor targets only. */
function safeUrl(raw) {
  const v = raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&(colon|tab|newline);/gi, (_, n) => ({ colon: ':', tab: '\t', newline: '\n' })[n.toLowerCase()])
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000- \u007f-\u009f]+/g, '')
    .toLowerCase();
  if (/^(https?:|mailto:|tel:)/.test(v)) return true;
  const colon = v.indexOf(':');
  if (colon === -1) return true;
  const stop = v.search(/[/?#]/);
  return stop !== -1 && stop < colon;
}
/** Link and image targets in Markdown text: [x](target "title"), ![x](target) and reference definitions. */
function linkTargets(md) {
  const out = [];
  for (const m of md.matchAll(/\]\(\s*<?([^)\s>]*)/g)) out.push(m[1]);
  for (const m of md.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?(\S+)/gm)) out.push(m[1]);
  return out;
}

const MEDIA_TYPES = { jpg: 1, png: 1, webp: 1 };
const SLUG = /^[a-z0-9][a-z0-9-]{0,159}$/;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** jpg, png or webp by the file's first bytes (the extension is not trusted). */
function sniff(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

function readStory(file) {
  const slug = path.basename(file, '.md');
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new Error('no front matter');
  const fm = YAML.parse(m[1]);
  if (!fm || typeof fm !== 'object') throw new Error('front matter is not a mapping');
  if (!SLUG.test(slug)) throw new Error('file name is not a valid story address (lowercase letters, digits and dashes)');
  const title = str(fm.title)?.trim();
  const author = str(fm.author)?.trim();
  if (!title) throw new Error('missing title');
  if (!author) throw new Error('missing author');
  const section = str(fm.section);
  if (!site.getSection(section)) throw new Error(`unknown section "${section}"`);
  const area = str(fm.area) || undefined;
  if (!site.isValidArea(section, area)) throw new Error(`area "${area}" does not belong to section "${section}"`);
  const d = fm.date instanceof Date ? fm.date : new Date(String(fm.date));
  if (Number.isNaN(d.getTime())) throw new Error('missing or unreadable date');
  const date = d.toISOString().slice(0, 10);
  const photos = Array.isArray(fm.photos) ? fm.photos.map(String) : [];
  const photoAlts = Array.isArray(fm.photoAlts) ? fm.photoAlts.map(String) : [];
  const image = str(fm.image) || undefined;
  const photoLayout = fm.photoLayout === undefined || fm.photoLayout === null ? 'one' : String(fm.photoLayout);
  if (!['one', 'twoUp', 'heroGrid', 'mosaic', 'stack'].includes(photoLayout)) throw new Error(`unknown photoLayout "${photoLayout.slice(0, 40)}"`);
  // Same as the dashboard: every "<" becomes &lt; so no tag, comment or autolink can be stored.
  const storyBlocks = blockMod.escapeStoryBlocks(blockMod.normalizeStoryBlocks(fm.storyBlocks));
  // An image module can only show one of this story's own photos (its lead image or gallery), never another address.
  blockMod.assertOwnStoryImages(storyBlocks, [...(str(fm.image) ? [str(fm.image)] : []), ...photos]);
  blockMod.checkStoryBlockLength(storyBlocks);
  const photoFocus = Array.isArray(fm.photoFocus) ? fm.photoFocus.map((p) => ({ focalX: blockMod.focalPoint(p?.focalX), focalY: blockMod.focalPoint(p?.focalY) })) : [];
  const raw = (storyBlocks.length ? blockMod.storyBlocksToMarkdown(storyBlocks) : m[2]).replace(/\r\n?/g, '\n').trim();
  if (!raw) throw new Error('empty story text');
  if (raw.includes('<')) console.warn(`  note: ${slug} contains "<"; it is stored as &lt; and shown as plain text, never as markup`);
  const body = raw.replace(/</g, '&lt;');
  const bad = linkTargets(body).find((t) => !safeUrl(t));
  if (bad) throw new Error(`a link or image target is not a web, mail or tel link: ${bad.slice(0, 40)}`);
  if (body.length > LIMITS.bodyMax) throw new Error(`story text is longer than ${LIMITS.bodyMax} characters`);
  return {
    slug, title, dek: str(fm.dek) || undefined, section, area, column: str(fm.column) || undefined, author, authorTitle: str(fm.authorTitle) || undefined,
    church: str(fm.church) || undefined, date, image, imageAlt: str(fm.imageAlt) || undefined, photoCredit: str(fm.photoCredit) || undefined,
    photos, photoAlts, photoLayout, storyBlocks, photoFocus, featured: fm.featured === true, draft: fm.draft === true, body,
  };
}

/** Resolve a story's photos to files (or remote addresses) without copying anything yet. */
function planPhotos(s) {
  if ((s.image ? 1 : 0) + s.photos.length > LIMITS.maxPhotos) throw new Error(`more than ${LIMITS.maxPhotos} photos`);
  const located = [];
  if (s.image) located.push({ src: s.image, kind: 'lead', alt: s.imageAlt ?? '' });
  s.photos.forEach((src, i) => located.push({ src, kind: 'gallery', alt: s.photoAlts[i] ?? '' }));
  return located.map((p, position) => {
    if (/^https:\/\//i.test(p.src)) return { ...p, position, remote: true };
    if (!/^\/images\/[A-Za-z0-9._\-/]+$/.test(p.src) || p.src.includes('..')) throw new Error(`photo address not allowed: ${p.src}`);
    const ext = path.extname(p.src).slice(1).toLowerCase().replace('jpeg', 'jpg');
    if (!MEDIA_TYPES[ext]) throw new Error(`photo is not a jpg, png or webp: ${p.src}`);
    const file = path.join(PUBLIC, p.src);
    if (!file.startsWith(path.join(PUBLIC, 'images') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`photo file not found: ${p.src}`);
    if (fs.statSync(file).size > LIMITS.maxPhotoMB * 1024 * 1024) throw new Error(`photo is larger than ${LIMITS.maxPhotoMB} MB: ${p.src}`);
    const bytes = fs.readFileSync(file);
    if (sniff(bytes) !== ext) throw new Error(`photo is not really a ${ext} image: ${p.src}`);
    return { ...p, position, ext, file, bytes, sha: sha256(bytes) };
  });
}

const db = openDatabase();
runMigrations(db, readMigrationsFromDir(path.join(here, '../src/lib/db/migrations')));
const mediaRoot = path.join(dataDir(), 'media');

let files;
try {
  files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();
} catch {
  console.error(`Cannot read the stories folder ${DIR}`);
  process.exit(2);
}
console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing will be changed; add --apply)'}${FORCE ? ' with --force' : ''}\nStories folder: ${DIR}\nData folder:    ${dataDir()}\n`);

const same = (row, s) =>
  row.title === s.title && (row.dek ?? undefined) === s.dek && row.section === s.section && (row.area ?? undefined) === s.area && (row.story_column ?? undefined) === s.column &&
  row.author === s.author && (row.author_title ?? undefined) === s.authorTitle && (row.church ?? undefined) === s.church && row.date === s.date &&
  (row.image ?? undefined) === s.image && (row.image_alt ?? undefined) === s.imageAlt && (row.photo_credit ?? undefined) === s.photoCredit &&
  row.photos === JSON.stringify(s.photos) && row.photo_alts === JSON.stringify(s.photoAlts) && row.photo_layout === s.photoLayout && (row.story_blocks ?? '[]') === JSON.stringify(s.storyBlocks) && (row.featured === 1) === s.featured &&
  (row.draft === 1) === s.draft && String(row.body).replace(/\r\n?/g, '\n').trim() === s.body &&
  db.prepare('SELECT focal_x, focal_y FROM story_photos WHERE story_id = ? ORDER BY position').all(row.id).every((p, i) => p.focal_x === (s.photoFocus[i]?.focalX ?? 50) && p.focal_y === (s.photoFocus[i]?.focalY ?? 50));

const tally = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };
for (const f of files) {
  const slug = path.basename(f, '.md');
  try {
    const s = readStory(path.join(DIR, f));
    const row = db.prepare('SELECT * FROM stories WHERE slug = ?').get(slug);
    const edited = row && (row.source !== 'git' || row.edited_at !== null);
    if (row && edited && !FORCE) { tally.skipped++; console.log(`  skip     ${slug}  (changed in the dashboard or Studio since its last import, or unpublished or republished there: the database copy is newer than this file, so it is left alone. --force overwrites it with this file)`); continue; }
    if (!row && s.draft) { tally.skipped++; console.log(`  skip     ${slug}  (draft: true, not published)`); continue; }
    const plan = planPhotos(s); // also checks the photos exist
    if (row && !edited && same(row, s) && (row.status === 'live') === !s.draft) { tally.unchanged++; console.log(`  same     ${slug}`); continue; }
    const action = row ? 'update' : 'create';
    console.log(`  ${action.padEnd(8)} ${slug}${row && edited ? '  (--force: overwriting dashboard edits)' : ''}${s.draft ? '  (draft: true -> unpublished)' : ''}  [${plan.length} photo${plan.length === 1 ? '' : 's'}]`);
    tally[row ? 'updated' : 'created']++;
    if (!APPLY) continue;

    // Photos first (content-addressed, no transaction open), then one transaction for the story.
    const rows = [];
    const made = [];
    try {
      for (const p of plan) {
        if (p.remote) { rows.push({ position: p.position, kind: p.kind, path: null, url: p.src, alt: p.alt, sha256: null, bytes: null }); continue; }
        const rel = `stories/${slug}/${p.sha}.${p.ext}`;
        const dest = path.join(mediaRoot, rel);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const tmp = path.join(path.dirname(dest), `.${randomBytes(6).toString('hex')}.tmp`);
          fs.writeFileSync(tmp, p.bytes, { flag: 'wx' });
          fs.renameSync(tmp, dest);
          made.push(dest);
        }
        rows.push({ position: p.position, kind: p.kind, path: rel, url: null, alt: p.alt, sha256: p.sha, bytes: p.bytes.length });
      }
      const now = Date.now();
      const status = s.draft ? 'unpublished' : 'live';
      const cols = [s.title, s.dek ?? null, s.section, s.area ?? null, s.column ?? null, s.author, s.authorTitle ?? null, s.church ?? null, s.date, s.image ?? null, s.imageAlt ?? null, s.photoCredit ?? null,
        JSON.stringify(s.photos), JSON.stringify(s.photoAlts), s.featured ? 1 : 0, s.draft ? 1 : 0, s.body, status, 'git', Date.parse(s.date), now, sha256(JSON.stringify([s, rows])), s.photoLayout, JSON.stringify(s.storyBlocks)];
      db.exec('BEGIN IMMEDIATE');
      try {
        let id;
        if (row) {
          id = Number(row.id);
          db.prepare(`UPDATE stories SET title=?, dek=?, section=?, area=?, story_column=?, author=?, author_title=?, church=?, date=?, image=?, image_alt=?, photo_credit=?,
            photos=?, photo_alts=?, featured=?, draft=?, body=?, status=?, source=?, published_at=?, updated_at=?, content_hash=?, photo_layout=?, story_blocks=?, edited_at=NULL, rev=rev+1 WHERE id = ?`).run(...cols, id);
          db.prepare('DELETE FROM story_photos WHERE story_id = ?').run(id);
        } else {
          id = Number(db.prepare(`INSERT INTO stories (title, dek, section, area, story_column, author, author_title, church, date, image, image_alt, photo_credit,
            photos, photo_alts, featured, draft, body, status, source, published_at, updated_at, content_hash, photo_layout, story_blocks, slug) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...cols, slug).lastInsertRowid);
        }
        const ins = db.prepare('INSERT INTO story_photos (story_id, position, kind, path, url, alt, sha256, bytes, focal_x, focal_y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const r of rows) ins.run(id, r.position, r.kind, r.path, r.url, r.alt, r.sha256, r.bytes, s.photoFocus[r.position]?.focalX ?? 50, s.photoFocus[r.position]?.focalY ?? 50);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    } catch (err) {
      for (const f2 of made) { try { fs.rmSync(f2, { force: true }); } catch { /* best effort */ } }
      throw err;
    }
  } catch (err) {
    tally.errors++;
    console.log(`  ERROR    ${slug}  ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}
console.log(`\n${APPLY ? 'Done' : 'Would change'}: ${tally.created} created, ${tally.updated} updated, ${tally.unchanged} unchanged, ${tally.skipped} left alone, ${tally.errors} errors.`);
if (!APPLY && (tally.created || tally.updated)) console.log('Nothing was written. Run again with --apply to make these changes.');
if (APPLY && (tally.created || tally.updated)) console.log('The running server shows the changes within about 10 minutes (immediately after a restart).');
db.close();
process.exit(tally.errors ? 1 : 0);
