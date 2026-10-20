// TEMPORARY (epic #25, until step 4): mirror the built stories into the `stories` table and copy their photos
// into DATA_DIR/media, so later steps can serve from the database. Git stays the source of truth meanwhile.
//
// Where the stories come from at run time: the Markdown sources are NOT in the Docker image (only dist/,
// node_modules, scripts and src/lib/db are copied), but Astro bakes the built content collection (front matter
// and body) into the server bundle, which is what getStories() reads and what /api/stories already relies on.
// Photos come from dist/client/images/stories/..., the build's copy of public/images/stories/....
//
// How it runs: getDb() calls ensureStorySync() on every use (a cheap check once it has finished) and /media does
// too. The pass runs in the background and never throws into a request. It is polite to the event loop: photos
// are read with async streams, and it yields between stories. All file reading, hashing and copying for a story
// happens BEFORE its database write, and each story is written in its own short transaction, so the sync never
// holds the write lock while doing file I/O. A photo is reused WITHOUT being read only when its source path is the
// one the stored row came from, its size matches (story_photos.bytes), its file is in the media folder, and the
// build marker (DATA_DIR/media/.build-marker: a hash of the built data-layer chunk name and of the path, size and
// mtime of exactly the built files the stories reference, wherever they live under /images) is unchanged since the last fully successful pass. After a new build the marker differs,
// so each size-matching photo is stream-hashed read-only (async, yielding) and compared with the stored sha256;
// it is copied only when the bytes really changed (a same-size replacement is therefore picked up).
// A pass with a failed story (or a thrown error) is retried after about a minute, at most 5 passes per process.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { mediaDir, MEDIA_TYPES } from './media';
import { getStoryHash, getStoryBySlug, slugsBySource, unpublishStory, upsertStory, type StoryInput, type StoryPhoto } from './story-store';
import { listUnpublishedSlugs } from './drafts';

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

const markerFile = () => path.join(mediaDir(), '.build-marker');

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
 * `markerChanged` is true after a new build (or when no verified pass has been recorded).
 */
async function mirrorPhoto(clientDir: string | null, slug: string, p: Located, position: number, known: StoryPhoto | undefined, knownSrc: string | undefined, markerChanged: boolean, result: SyncResult): Promise<StoryPhoto> {
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
      if (!markerChanged) return reuse;
      // New build: same path and size can still be different bytes. Hash read-only; copy only on a mismatch.
      result.hashed++;
      if ((await hashFile(file)) === known.sha256) return reuse;
      verified = true;
    }
  }
  if (!verified) result.hashed++; // each photo is counted once, even when it was hashed to verify and then copied
  const { rel, sha, bytes } = await copyAndHash(file, slug, ext, result);
  return { position, kind: p.kind, path: rel, url: null, alt: p.alt, sha256: sha, bytes };
}

/** One pass. Exported so tests and tools can call it; the server uses ensureStorySync(). */
export async function syncStoriesFromBuild(): Promise<SyncResult> {
  const { getStories } = await import('./stories');
  const built = await getStories();
  const clientDir = builtClientDir();
  const referenced: string[] = [];
  for (const entry of built) for (const src of [entry.data.image, ...entry.data.photos]) {
    const f = src ? builtPhotoFile(clientDir, src) : null;
    if (f) referenced.push(f);
  }
  const marker = await buildMarker(clientDir, referenced);
  const markerChanged = (await fs.promises.readFile(markerFile(), 'utf8').catch(() => '')) !== marker;
  const result: SyncResult = { inserted: 0, updated: 0, unchanged: 0, unpublished: 0, skipped: 0, hashed: 0, copied: 0 };
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

      // 1. Files first: stat, hash and copy with no transaction open.
      if (failSlug() === slug) throw new Error('test failure');
      const prev = getStoryBySlug(slug, { includeUnpublished: true });
      const known = prev?.photoRows ?? [];
      const prevSrc = prev ? [...(prev.image ? [prev.image] : []), ...prev.photos] : [];
      const photoRows: StoryPhoto[] = [];
      for (let i = 0; i < located.length; i++) photoRows.push(await mirrorPhoto(clientDir, slug, located[i], i, known.find((k) => k.position === i), prevSrc[i], markerChanged, result));
      // Read the dashboard's unpublish list right before the write, so one made during this pass is not missed.
      const status = listUnpublishedSlugs().has(slug) ? 'unpublished' : 'live';

      const base = {
        slug, title: d.title, dek: d.dek, section: d.section, area: d.area, column: d.column, author: d.author, authorTitle: d.authorTitle,
        church: d.church, date, image: d.image, imageAlt: d.imageAlt, photoCredit: d.photoCredit, photos: d.photos, photoAlts: d.photoAlts,
        featured: d.featured, draft: d.draft, body: entry.body ?? '',
      };
      const contentHash = sha256Of(JSON.stringify([base, photoRows]));
      const story: StoryInput = { ...base, status, source: 'git', publishedAt: Date.parse(date), contentHash, photoRows };

      // 2. Then one short write for this story (a no-op when nothing changed).
      const cur = getStoryHash(slug);
      const outcome = cur && cur.hash === contentHash && cur.status === status && cur.source === 'git' ? 'unchanged' : upsertStory(story);
      result[outcome]++;
      if (status === 'unpublished' && outcome !== 'unchanged') result.unpublished++;
    } catch (err) {
      result.skipped++;
      console.error(`[stories] could not mirror ${slug}:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }

  // A mirrored story that left the build (an unpublish or delete in git) is no longer live.
  for (const slug of slugsBySource('git', 'live')) {
    if (!seen.has(slug) && unpublishStory(slug)) result.unpublished++;
  }
  // Record the build as verified only when every story was mirrored.
  if (result.skipped === 0 && markerChanged) {
    try {
      await fs.promises.mkdir(mediaDir(), { recursive: true });
      await fs.promises.writeFile(markerFile(), marker);
    } catch (err) {
      console.error('[stories] could not record the build marker:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }
  return result;
}

const RETRY_MS = (testHooks && Number(process.env.STORY_SYNC_TEST_RETRY_MS)) || 60_000;
const MAX_PASSES = 5;
let busy = false;
let done = false;
let passes = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRetry(): void {
  if (retryTimer || passes >= MAX_PASSES) return;
  retryTimer = setTimeout(() => { retryTimer = undefined; ensureStorySync(); }, RETRY_MS);
  retryTimer.unref?.();
}

/**
 * Start the import in the background if it has not finished. Safe on every call: a boolean check once done, and
 * it does nothing while a pass runs or a retry is waiting. Never throws; public pages never wait for it. A pass
 * that fails, or in which a story could not be mirrored, is retried after a minute, up to 5 passes per process.
 */
export function ensureStorySync(): void {
  if (done || busy || retryTimer || passes >= MAX_PASSES) return;
  busy = true;
  passes++;
  void (async () => {
    await yieldToLoop(); // let the caller (usually getDb) finish first
    try {
      const r = await syncStoriesFromBuild();
      console.log(`[stories] mirrored the build: ${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.unpublished} unpublished, ${r.skipped} skipped, ${r.hashed} photos hashed, ${r.copied} copied`);
      if (r.skipped === 0) done = true;
      else { console.error(`[stories] ${r.skipped} stories could not be mirrored; pass ${passes} of ${MAX_PASSES}`); scheduleRetry(); }
    } catch (err) {
      console.error('[stories] sync failed:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
      scheduleRetry();
    } finally {
      busy = false;
    }
  })();
}
