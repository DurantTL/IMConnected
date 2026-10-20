// TEMPORARY (epic #25, until step 4): mirror the built stories into the `stories` table and copy their photos
// into DATA_DIR/media, so later steps can serve from the database. Git stays the source of truth meanwhile.
//
// Where the stories come from at run time: the Markdown sources are NOT in the Docker image (only dist/,
// node_modules, scripts and src/lib/db are copied), but Astro bakes the built content collection (front matter
// and body) into the server bundle, which is what getStories() reads and what /api/stories already relies on.
// Photos come from dist/client/images/stories/..., the build's copy of public/images/stories/....
//
// Runs once per start, lazily: the first database open (getDb) or the first /media request kicks it off in the
// background. It never throws into a request, and a failure is logged and retried at most once a minute.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mediaDir, MEDIA_TYPES } from './media';
import { getStoryHash, slugsBySource, unpublishStory, upsertStory, type StoryInput, type StoryPhoto } from './story-store';
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
const sha256Of = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const extOf = (p: string) => { const e = path.extname(p).slice(1).toLowerCase(); return e === 'jpeg' ? 'jpg' : e; };

/** A built photo path (/images/...) to its file inside dist/client, or null. */
function builtPhotoFile(clientDir: string | null, src: string): string | null {
  if (!clientDir || !src.startsWith('/images/')) return null;
  const root = path.join(clientDir, 'images') + path.sep;
  const file = path.resolve(clientDir, '.' + src);
  return file.startsWith(root) ? file : null;
}

interface Located { src: string; kind: 'lead' | 'gallery'; alt: string }

/** Copy one photo into DATA_DIR/media/stories/<slug>/<sha256>.<ext> unless it is already there. */
function mirrorPhoto(clientDir: string | null, slug: string, p: Located, position: number): StoryPhoto {
  const remote = (): StoryPhoto => ({ position, kind: p.kind, path: null, url: p.src, alt: p.alt, sha256: null });
  const file = builtPhotoFile(clientDir, p.src);
  const ext = extOf(p.src);
  if (!file || !MEDIA_TYPES[ext] || !SAFE_SLUG.test(slug)) return remote();
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    console.error(`[stories] photo not found in the build for ${slug}: ${p.src}`);
    return remote();
  }
  const sha = sha256Of(data);
  const rel = `stories/${slug}/${sha}.${ext}`;
  const dest = path.join(mediaDir(), rel);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  }
  return { position, kind: p.kind, path: rel, url: null, alt: p.alt, sha256: sha };
}

/** Cheap fingerprint of a built photo (size and mtime), so an unchanged story needs no file reads. */
function fingerprint(clientDir: string | null, src: string): string {
  const file = builtPhotoFile(clientDir, src);
  try { if (file) { const st = fs.statSync(file); return `${st.size}:${Math.floor(st.mtimeMs)}`; } } catch { /* missing */ }
  return 'none';
}

export interface SyncResult { inserted: number; updated: number; unchanged: number; unpublished: number; skipped: number }

/** One pass. Exported so tests and tools can call it; the server uses ensureStorySync(). */
export async function syncStoriesFromBuild(): Promise<SyncResult> {
  const { getStories } = await import('./stories');
  const built = await getStories();
  const clientDir = builtClientDir();
  const editorUnpublished = listUnpublishedSlugs();
  const result: SyncResult = { inserted: 0, updated: 0, unchanged: 0, unpublished: 0, skipped: 0 };
  const seen = new Set<string>();

  for (const entry of built) {
    const slug = entry.id;
    const d = entry.data;
    seen.add(slug);
    try {
      const located: Located[] = [];
      if (d.image) located.push({ src: d.image, kind: 'lead', alt: d.imageAlt ?? '' });
      d.photos.forEach((src, i) => located.push({ src, kind: 'gallery', alt: d.photoAlts[i] ?? '' }));
      const status = editorUnpublished.has(slug) ? 'unpublished' : 'live';
      const date = d.date.toISOString().slice(0, 10);
      const base = {
        slug, title: d.title, dek: d.dek, section: d.section, area: d.area, column: d.column, author: d.author, authorTitle: d.authorTitle,
        church: d.church, date, image: d.image, imageAlt: d.imageAlt, photoCredit: d.photoCredit, photos: d.photos, photoAlts: d.photoAlts,
        featured: d.featured, draft: d.draft, body: entry.body ?? '',
      };
      const contentHash = sha256Of(Buffer.from(JSON.stringify([base, located.map((p) => fingerprint(clientDir, p.src))])));
      const story: StoryInput = {
        ...base, status, source: 'git', publishedAt: Date.parse(date), contentHash,
        photoRows: [],
      };
      // Photo files are only read and copied when the story is new or changed (the hash check comes first).
      const outcome = upsertIfChanged(story, () => located.map((p, i) => mirrorPhoto(clientDir, slug, p, i)));
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
  return result;
}

function upsertIfChanged(story: StoryInput, photos: () => StoryPhoto[]): 'inserted' | 'updated' | 'unchanged' {
  const cur = getStoryHash(story.slug);
  if (cur && cur.hash === story.contentHash && cur.status === story.status && cur.source === story.source) return 'unchanged';
  story.photoRows = photos();
  return upsertStory(story);
}

let running: Promise<void> | undefined;
let done = false;
let lastFailure = 0;
const RETRY_MS = 60_000;

/**
 * Kick off the import once per start, in the background. Safe to call on every request: after the first
 * success it is a boolean check. Never throws, and public pages never wait for it.
 */
export function ensureStorySync(): void {
  if (done || running) return;
  if (lastFailure && Date.now() - lastFailure < RETRY_MS) return;
  running = (async () => {
    // Let the caller (usually getDb, still assigning its connection) finish first.
    await new Promise((r) => setTimeout(r, 0));
    try {
      const r = await syncStoriesFromBuild();
      done = true;
      console.log(`[stories] mirrored the build: ${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.unpublished} unpublished, ${r.skipped} skipped`);
    } catch (err) {
      lastFailure = Date.now();
      console.error('[stories] sync failed:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    } finally {
      running = undefined;
    }
  })();
}
