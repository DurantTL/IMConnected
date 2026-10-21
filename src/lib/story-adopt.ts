// ONE-TIME ADOPTION of the built stories (epic #25, step 4). Server-side only.
//
// Until step 3 the stories table was a mirror of the built content collection and git was the source of truth.
// From step 4 the table IS the source of truth (publishing writes it directly, see story-publish.ts). So the first
// start of this version on a database that has not adopted yet runs ONE last import of the build, shaped exactly like
// the old mirror pass (so every live story stays live, every unpublished story stays unpublished, and a story the
// build has that the table lacks or has older is brought in), and then records `git_adopted_at` in app_state, in
// the same transaction that retires any holds. From then on:
//   * the build is never read for content again: a later start, even with an OLDER image, finds the flag and does
//     nothing, so a redeploy can never revert a dashboard edit;
//   * story_holds (migration 012) is inert: no code reads or writes it after this pass.
// A story edited in the database (source other than 'git') is never overwritten, even by this pass.
//
// Where the stories come from: the Markdown sources are NOT in the Docker image, but Astro bakes the built content
// collection (front matter and body) into the server bundle, which getStories() reads. Photos come from
// dist/client/images/stories/..., the build's copy of public/images/stories/....
//
// How it runs: getDb() calls ensureAdoption() on every use (a boolean check once finished). The pass runs in the
// background, never throws into a request, and is polite to the event loop: photos are read with async streams and
// it yields between stories. All file reading, hashing and copying for a story happens BEFORE its database write,
// and each story is written in its own short transaction. A failed pass (or a failed story) is retried after about a
// minute, at most 5 passes per process, and the flag is only set by a pass in which nothing failed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { mediaDir, MEDIA_TYPES } from './media';
import { buildCommits, holdActive, type Hold } from './story-holds';
import { photoLayoutOrDefault } from './photo-layouts';
import { getStoryBySlug, writeStory, type StoryInput, type StoryPhoto } from './story-store';
import { invalidateStories } from './public-cache';
import { getDb } from './db';
import { reindexAll } from './search-index';

/** The built site's static files (dist/client): next to the server bundle, else ./dist/client, or BUILT_CLIENT_DIR. */
export function builtClientDir(): string | null {
  const candidates: string[] = [];
  if (process.env.BUILT_CLIENT_DIR) candidates.push(path.resolve(process.env.BUILT_CLIENT_DIR));
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) candidates.push(path.join(dir, 'client'));
  } catch { /* not a file URL */ }
  candidates.push(path.resolve('dist/client'));
  return candidates.find((c) => fs.existsSync(path.join(c, 'images'))) ?? null;
}

const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const sha256Of = (text: string) => createHash('sha256').update(text).digest('hex');
const extOf = (p: string) => { const e = path.extname(p).slice(1).toLowerCase(); return e === 'jpeg' ? 'jpg' : e; };
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** A built photo path (/images/...) to its file inside dist/client, or null. */
function builtPhotoFile(clientDir: string | null, src: string): string | null {
  if (!clientDir || !src.startsWith('/images/')) return null;
  const root = path.join(clientDir, 'images') + path.sep;
  const file = path.resolve(clientDir, '.' + src);
  return file.startsWith(root) ? file : null;
}

interface Located { src: string; kind: 'lead' | 'gallery'; alt: string }

export interface SyncResult { inserted: number; updated: number; unchanged: number; unpublished: number; skipped: number; hashed: number; copied: number }

/**
 * Cheap fingerprint of the current build: the data-layer chunk's name plus the path, size and mtime of exactly the
 * built files the stories reference (every image and photos entry under /images/, deduplicated and sorted). No
 * folder is walked, so a photo anywhere under /images (not only /images/stories) is covered.
 */
async function buildMarker(clientDir: string | null, files: string[]): Promise<string> {
  const parts: string[] = [];
  if (clientDir) {
    try {
      for (const f of await fs.promises.readdir(path.join(clientDir, '..', 'server', 'chunks'))) if (f.startsWith('_astro_data-layer-content')) parts.push(f);
    } catch { /* no server folder next to the client folder */ }
  }
  for (const file of [...new Set(files)].sort()) {
    const st = await fs.promises.stat(file).catch(() => null);
    parts.push(st?.isFile() ? `${path.relative(clientDir ?? '', file)}:${st.size}:${Math.floor(st.mtimeMs)}` : `${path.relative(clientDir ?? '', file)}:missing`);
  }
  return sha256Of(parts.join('\n'));
}

/** Stream-hash a file read-only. */
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// Test hooks (only honoured with STORY_SYNC_TEST=1, which the story-store test sets; unset in production): fail one slug on purpose, shorten the retry wait.
const testHooks = process.env.STORY_SYNC_TEST === '1';
const failSlug = () => (testHooks ? process.env.STORY_SYNC_TEST_FAIL_SLUG : undefined);
// Also test-only: hold the first pass back for N ms (so a test can request pages while the table is still empty), and
// (no other hooks).
/** Test only: hold the pass before it writes `slug` until the file STORY_SYNC_TEST_PAUSE_FILE exists (max 30 s). */
async function testPause(slug: string): Promise<void> {
  if (!testHooks || process.env.STORY_SYNC_TEST_PAUSE_SLUG !== slug || !process.env.STORY_SYNC_TEST_PAUSE_FILE) return;
  console.log(`[stories] test: pass paused before writing ${slug}`);
  for (let i = 0; i < 600 && !fs.existsSync(process.env.STORY_SYNC_TEST_PAUSE_FILE); i++) await new Promise((r) => setTimeout(r, 50));
}
const testDelayMs = testHooks ? Number(process.env.STORY_SYNC_TEST_DELAY_MS) || 0 : 0;

/**
 * Copy one photo to DATA_DIR/media/stories/<slug>/<sha256>.<ext>, hashing it while it streams. The temp file has
 * a random name and is opened exclusively (two containers can share a PID), and is removed on any failure.
 */
async function copyAndHash(file: string, slug: string, ext: string, result: SyncResult): Promise<{ rel: string; sha: string; bytes: number }> {
  const dir = path.join(mediaDir(), 'stories', slug);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(
      fs.createReadStream(file),
      async function* (src: AsyncIterable<Buffer>) { for await (const chunk of src) { hash.update(chunk); bytes += chunk.length; yield chunk; } },
      fs.createWriteStream(tmp, { flags: 'wx' }),
    );
    const sha = hash.digest('hex');
    const rel = `stories/${slug}/${sha}.${ext}`;
    const dest = path.join(mediaDir(), rel);
    if (fs.existsSync(dest)) await fs.promises.rm(tmp, { force: true });
    else { await fs.promises.rename(tmp, dest); result.copied++; }
    return { rel, sha, bytes };
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Resolve one photo to its row. `known` is the stored row at this position and `knownSrc` the source path it came from.
 */
async function mirrorPhoto(clientDir: string | null, slug: string, p: Located, position: number, known: StoryPhoto | undefined, knownSrc: string | undefined, result: SyncResult): Promise<StoryPhoto> {
  const remote = (): StoryPhoto => ({ position, kind: p.kind, path: null, url: p.src, alt: p.alt, sha256: null, bytes: null });
  const file = builtPhotoFile(clientDir, p.src);
  const ext = extOf(p.src);
  if (!file || !MEDIA_TYPES[ext] || !SAFE_SLUG.test(slug)) return remote();
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    console.error(`[stories] photo not found in the build for ${slug}: ${p.src}`);
    return remote();
  }
  let verified = false;
  if (known?.path && known.sha256 && known.bytes === size && knownSrc === p.src && known.path.endsWith(`.${ext}`)) {
    const exists = await fs.promises.access(path.join(mediaDir(), known.path)).then(() => true, () => false);
    if (exists) {
      const reuse = { position, kind: p.kind, path: known.path, url: null, alt: p.alt, sha256: known.sha256, bytes: size };
      // Same path and size can still be different bytes. Hash read-only; copy only on a mismatch.
      result.hashed++;
      if ((await hashFile(file)) === known.sha256) return reuse;
      verified = true;
    }
  }
  if (!verified) result.hashed++; // each photo is counted once, even when it was hashed to verify and then copied
  const { rel, sha, bytes } = await copyAndHash(file, slug, ext, result);
  return { position, kind: p.kind, path: rel, url: null, alt: p.alt, sha256: sha, bytes };
}

const ADOPTED_KEY = 'git_adopted_at';

/** True once this database has adopted the build (the flag is in app_state). */
export function isAdopted(): boolean {
  return !!getDb().prepare('SELECT 1 FROM app_state WHERE key = ?').get(ADOPTED_KEY);
}

interface HoldRow { slug: string; build_marker: string | null; unpublish_sha: string | null; unpublish_time: number | null; released_at: number | null }
/** Holds still in force in migration 012's table. Read only here, once. */
function activeHolds(): Map<string, Hold> {
  const rows = getDb().prepare('SELECT slug, build_marker, unpublish_sha, unpublish_time, released_at FROM story_holds_retired WHERE released_at IS NULL').all() as unknown as HoldRow[];
  return new Map(rows.map((r) => [r.slug, { marker: r.build_marker, unpublishSha: r.unpublish_sha, unpublishTime: r.unpublish_time === null ? null : Number(r.unpublish_time) }]));
}

/** The build's marker, used only to evaluate holds of a build that has no commit list (local and dev builds). */
async function currentMarker(clientDir: string | null, built: Awaited<ReturnType<typeof getBuilt>>): Promise<string | null> {
  if (buildCommits() !== null) return null;
  if (testHooks && process.env.STORY_SYNC_TEST_FAIL_MARKER === '1') return null;
  try {
    const referenced: string[] = [];
    for (const entry of built) for (const src of [entry.data.image, ...entry.data.photos]) {
      const f = src ? builtPhotoFile(clientDir, src) : null;
      if (f) referenced.push(f);
    }
    return await buildMarker(clientDir, referenced);
  } catch {
    return null;
  }
}

async function getBuilt() {
  const { getStories } = await import('./stories');
  return getStories();
}

export interface AdoptResult extends SyncResult { notGit: number }

/**
 * One adoption pass. Exported for tests; the server uses ensureAdoption(). Imports every built story that is missing
 * from the table or differs from its (git-sourced) row; a row whose source is not 'git' is left alone. Status follows
 * the old mirror's rule: unpublished when the dashboard unpublished it (drafts.unpublished_at) or a hold is still
 * active (the unpublish is not provably in this build), else live. A git-sourced live row that is not in the build any
 * more (deleted or draft: true) is unpublished. Sets the flag only when no story failed.
 */
export async function adoptBuiltStories(): Promise<AdoptResult> {
  const built = await getBuilt();
  const clientDir = builtClientDir();
  const marker = await currentMarker(clientDir, built);
  const holds = activeHolds();
  // Edits made through step-4 code after the upgrade (publish, unpublish, Studio) are stamped later than this; the
  // values migration 015 backfilled from old unpublishes are older and do not protect a row from this pass.
  const appliedAt = Number((getDb().prepare("SELECT applied_at FROM schema_migrations WHERE name = '015_stories_source_of_truth.sql'").get() as { applied_at: number } | undefined)?.applied_at ?? 0);
  const result: AdoptResult = { inserted: 0, updated: 0, unchanged: 0, unpublished: 0, skipped: 0, hashed: 0, copied: 0, notGit: 0 };
  const seen = new Set<string>();

  for (const entry of built) {
    await yieldToLoop();
    const slug = entry.id;
    const d = entry.data;
    seen.add(slug);
    try {
      const located: Located[] = [];
      if (d.image) located.push({ src: d.image, kind: 'lead', alt: d.imageAlt ?? '' });
      d.photos.forEach((src, i) => located.push({ src, kind: 'gallery', alt: d.photoAlts[i] ?? '' }));
      const date = d.date.toISOString().slice(0, 10);

      if (failSlug() === slug) throw new Error('test failure');
      const prev = getStoryBySlug(slug, { includeUnpublished: true });
      const protectedRow = (r: { source: string; editedAt?: number } | undefined) => !!r && (r.source !== 'git' || (r.editedAt !== undefined && r.editedAt > appliedAt));
      if (protectedRow(prev)) { result.notGit++; continue; } // changed in the database: the build is older by definition
      // 1. Files first: stat, hash and copy with no transaction open.
      const known = prev?.photoRows ?? [];
      const prevSrc = prev ? [...(prev.image ? [prev.image] : []), ...prev.photos] : [];
      const photoRows: StoryPhoto[] = [];
      for (let i = 0; i < located.length; i++) photoRows.push(await mirrorPhoto(clientDir, slug, located[i], i, known.find((k) => k.position === i), prevSrc[i], result));
      photoRows.forEach((row, i) => {
        const point = d.photoFocus?.[i];
        if (point && (point.focalX !== 50 || point.focalY !== 50)) { row.focalX = point.focalX; row.focalY = point.focalY; }
      });
      await testPause(slug);
      const hold = holds.get(slug);
      let held = false;
      if (hold) { try { held = holdActive(hold, marker); } catch { held = true; } }

      const base = {
        slug, title: d.title, dek: d.dek, section: d.section, area: d.area, column: d.column, author: d.author, authorTitle: d.authorTitle,
        church: d.church, date, image: d.image, imageAlt: d.imageAlt, photoCredit: d.photoCredit, photos: d.photos, photoAlts: d.photoAlts,
        featured: d.featured, draft: d.draft, body: entry.body ?? '',
      };
      // The layout joins the hash only when it is not the default, so every already-adopted story keeps its hash.
      if (d.photoLayout && d.photoLayout !== 'one') (base as Record<string, unknown>).photoLayout = d.photoLayout;
      if (d.storyBlocks?.length) (base as Record<string, unknown>).storyBlocks = d.storyBlocks;
      const contentHash = sha256Of(JSON.stringify([base, photoRows]));

      // 2. Then one short write for this story. Everything that decides it is read INSIDE the transaction, because a
      // person may have published, edited or unpublished this story since `prev` was read (the photo hashing above awaits):
      // the row must still be git-sourced, unchanged since `prev` and not edited since the upgrade, else it is left alone.
      const db = getDb();
      db.exec('BEGIN IMMEDIATE');
      let outcome: 'inserted' | 'updated' | 'unchanged' | 'protected';
      try {
        const now = db.prepare('SELECT source, updated_at, edited_at, status, content_hash FROM stories WHERE slug = ?').get(slug) as { source: string; updated_at: number; edited_at: number | null; status: string; content_hash: string | null } | undefined;
        if (now && (now.source !== 'git' || (now.edited_at !== null && Number(now.edited_at) > appliedAt) || !prev || Number(now.updated_at) !== prev.updatedAt)) outcome = 'protected';
        else if (!now && prev) outcome = 'protected'; // vanished meanwhile: not ours to recreate
        else {
          const unpublishedNow = !!db.prepare('SELECT 1 FROM drafts WHERE slug = ? AND unpublished_at IS NOT NULL').get(slug);
          const status = unpublishedNow || held ? 'unpublished' : 'live';
          if (now && now.content_hash === contentHash && now.status === status) outcome = 'unchanged';
          else {
            const story: StoryInput = { ...base, status, source: 'git', publishedAt: Date.parse(date), contentHash, photoRows, photoLayout: photoLayoutOrDefault(d.photoLayout) };
            outcome = writeStory(story, Date.now(), now ? 'upsert' : 'insert').outcome as 'inserted' | 'updated';
            if (status === 'unpublished') result.unpublished++;
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        if (err instanceof Error && /UNIQUE/i.test(err.message)) outcome = 'protected'; // someone published this address meanwhile
        else throw err;
      }
      if (outcome === 'protected') result.notGit++;
      else result[outcome]++;
    } catch (err) {
      result.skipped++;
      console.error(`[stories] could not adopt ${slug}:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }

  if (result.skipped === 0) {
    // A git story that left the build (an unpublish or a delete in git) is no longer live, unless a person has touched it
    // since the upgrade. Then the flag is set and the holds retired, all in one transaction. The build is never read again.
    const db = getDb();
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const live = db.prepare("SELECT slug FROM stories WHERE source = 'git' AND status = 'live' AND (edited_at IS NULL OR edited_at <= ?)").all(appliedAt) as { slug: string }[];
      const off = db.prepare("UPDATE stories SET status = 'unpublished', updated_at = ?, rev = rev + 1 WHERE slug = ? AND status = 'live' AND source = 'git' AND (edited_at IS NULL OR edited_at <= ?)");
      for (const { slug } of live) if (!seen.has(slug) && Number(off.run(now, slug, appliedAt).changes) > 0) result.unpublished++;
      db.prepare('UPDATE story_holds_retired SET released_at = ? WHERE released_at IS NULL').run(now);
      db.prepare('INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').run(ADOPTED_KEY, new Date(now).toISOString(), now);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }
  return result;
}

const RETRY_MS = (testHooks && Number(process.env.STORY_SYNC_TEST_RETRY_MS)) || 60_000;
const MAX_PASSES = 5;
let busy = false;
let done = false;
let passes = 0;
let current: Promise<void> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** True once this process knows the database has adopted the build. */
export const adoptionDone = () => done;
/** The pass that is running now (resolves when it ends, whether it worked or not), else undefined. */
export const adoptionInFlight = () => current;

function scheduleRetry(): void {
  if (retryTimer || passes >= MAX_PASSES) return;
  retryTimer = setTimeout(() => { retryTimer = undefined; ensureAdoption(); }, RETRY_MS);
  retryTimer.unref?.();
}

/**
 * Start the adoption in the background if the database has not adopted. Safe on every call: a boolean check once done,
 * and nothing while a pass runs or a retry is waiting. Never throws; public pages do not wait for it unless the
 * table is empty (public-stories.ts). The flag is read first, so an already-adopted database never reads the build.
 */
export function ensureAdoption(): void {
  if (done || busy || retryTimer || passes >= MAX_PASSES) return;
  busy = true;
  passes++;
  current = (async () => {
    await yieldToLoop(); // let the caller (usually getDb) finish first
    try {
      if (isAdopted()) { done = true; return; }
      if (testDelayMs && passes === 1) await new Promise((r) => setTimeout(r, testDelayMs));
      const r = await adoptBuiltStories();
      console.log(`[stories] adopting the build: ${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.unpublished} unpublished, ${r.notGit} left alone, ${r.skipped} skipped, ${r.hashed} photos hashed, ${r.copied} copied`);
      // Fill the search index for every story (migration 013 leaves it empty).
      try { await reindexAll(getDb(), yieldToLoop); } catch (err) { console.error('[stories] could not build the search index:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error'); }
      if (r.skipped === 0) { done = true; console.log('[stories] the database is now the source of truth; the build is not read for content any more'); }
      else { console.error(`[stories] ${r.skipped} stories could not be adopted; pass ${passes} of ${MAX_PASSES}`); scheduleRetry(); }
      invalidateStories();
    } catch (err) {
      console.error('[stories] adoption failed:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
      scheduleRetry();
    } finally {
      busy = false;
      current = undefined;
    }
  })();
}
