import { walkStoryBlocks, storyBlockPhotos, mapStoryPhotos } from './story-blocks';
// Publishing to the database (epic #25, step 4). Server-side only. There is no git and no GitHub call anywhere here.
//
// A publish is: (1) check and build everything in memory, (2) copy the photos into DATA_DIR/media/stories/<slug>/
// <sha256>.<ext> (content-addressed, so a retry or an identical photo is a no-op), (3) ONE transaction that changes
// the draft row and the stories / story_photos / search rows together, (4) clear the page cache. If anything fails
// before the commit, the transaction is rolled back and the files this attempt created are deleted: nothing is left
// half-written, and the draft is still editable. Step 3 has no `await`, so the slug check and the writes cannot
// interleave with another publish in this process; a second process is stopped by the UNIQUE indexes on
// stories.slug and drafts.slug.
import fs from 'node:fs';
import { checkStoryBlockLength, normalizeStoryBlocks, unescapeStoryBlockPlainText, storyBlocksToMarkdown, type PhotoFit, type PhotoFitFill, type StoryBlock } from './story-blocks';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { LIMITS } from './limits';
import { PUBLISH_LIMITS, type PreparedStudioStory } from './publish';
import { EditorError } from './messages';
import { getSection, isValidArea } from './site';
import { slugify, sniffImage } from './submission';
import { clean, escapeHtmlInMarkdown, validDate } from './storyfile';
import { renderMarkdownSafe } from './markdown';
import { getDb } from './db';
import { invalidateStories } from './public-cache';
import { mediaDir, resolveMediaFile } from './media';
import { getDraftBySlug, markUnpublished, syncPublishedDraftFields, publishDraftRow, recordStudioPublish, tx, uploadFile, removeUploadFiles, type Draft, type DraftFields, type DraftPhoto } from './drafts';
import { photoLayoutOrDefault } from './photo-layouts';
import { normalizeKeyPoints } from './key-points';
import { getStoryBySlug, storyExists, unpublishStory as hideStory, writeStory, type Story, type StoryInput, type StoryPhoto } from './story-store';

const SLUG = /^[a-z0-9][a-z0-9-]{0,159}$/;
export const validSlug = (slug: unknown): slug is string => typeof slug === 'string' && SLUG.test(slug);

const oneLine = (v: string) => clean(v).replace(/\s+/g, ' ').trim();
/** A photo caption as stored: one line of plain text, at most PUBLISH_LIMITS.caption characters (rendering escapes it). */
export const captionText = (v: unknown): string => oneLine(typeof v === 'string' ? v : '').slice(0, PUBLISH_LIMITS.caption);
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---- photos ----

export type PhotoInput =
  | { kind: 'file'; bytes: Uint8Array; ext: string; alt: string; draftPhotoId?: number }
  | { kind: 'keep'; url: string; alt: string };

export interface StoredPhotos {
  rows: StoryPhoto[];
  /** The photo addresses in order, lead first (what `image` and `photos` hold). */
  sources: string[];
  /** Absolute paths of the files this attempt created (deleted if the publish fails). */
  created: string[];
  /** Absolute paths of every uploaded file this publish relies on, created now or already there. */
  files: string[];
  /** Public address of every uploaded photo by draft photo id. */
  uploaded: Map<number, string>;
}

/** Write one photo under the media folder; returns its relative path and whether this call created the file. */
async function storeFile(slug: string, bytes: Uint8Array, ext: string, sha: string): Promise<{ rel: string; created: string | null }> {
  const rel = `stories/${slug}/${sha}.${ext}`;
  const dest = path.join(mediaDir(), rel);
  if (fs.existsSync(dest)) return { rel, created: null };
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tmp, bytes, { flag: 'wx' });
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return { rel, created: dest };
}

/**
 * Turn a draft's / Studio's photo list into story_photos rows. `existing` is the story already in the database (for a
 * republish): a kept photo that is one of its photos reuses that row. Anything else is refused (photo_link_bad).
 */
export async function storePhotos(slug: string, items: PhotoInput[], existing: Story | undefined, fail: (code: 'photo_link_bad') => Error = (c) => new EditorError(c)): Promise<StoredPhotos> {
  const rows: StoryPhoto[] = [];
  const sources: string[] = [];
  const created: string[] = [];
  const files: string[] = [];
  const uploaded = new Map<number, string>();
  const oldSources = existing ? [...(existing.image ? [existing.image] : []), ...existing.photos] : [];
  try {
    for (const [i, item] of items.entries()) {
      const kind = i === 0 ? 'lead' : 'gallery';
      if (item.kind === 'file') {
        const sha = sha256(item.bytes);
        const { rel, created: made } = await storeFile(slug, item.bytes, item.ext, sha);
        if (made) created.push(made);
        files.push(path.join(mediaDir(), rel));
        const src = `/media/${rel}`;
        rows.push({ position: i, kind, path: rel, url: null, alt: item.alt, sha256: sha, bytes: item.bytes.length });
        sources.push(src);
        if (item.draftPhotoId !== undefined) uploaded.set(item.draftPhotoId, src);
        continue;
      }
      const at = oldSources.indexOf(item.url);
      const old = at >= 0 ? existing!.photoRows.find((r) => r.position === at) : undefined;
      if (old) {
        rows.push({ ...old, position: i, kind, alt: item.alt });
        sources.push(item.url);
        continue;
      }
      if (/^https:\/\//i.test(item.url)) {
        let href: string;
        try { href = new URL(item.url).href; } catch { throw fail('photo_link_bad'); }
        if (item.url.length > PUBLISH_LIMITS.url) throw fail('photo_link_bad');
        rows.push({ position: i, kind, path: null, url: href, alt: item.alt, sha256: null, bytes: null });
        sources.push(href);
        continue;
      }
      // A photo already in this story's media folder (for example an uploaded photo the draft now points at).
      const m = /^\/media\/(stories\/([A-Za-z0-9][A-Za-z0-9._-]{0,150})\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(?:jpg|png|webp|avif))$/.exec(item.url);
      const found = m && m[2] === slug ? resolveMediaFile(m[1]) : null;
      if (!found) throw fail('photo_link_bad');
      const bytes = await fs.promises.readFile(found.file);
      rows.push({ position: i, kind, path: m![1], url: null, alt: item.alt, sha256: sha256(bytes), bytes: bytes.length });
      sources.push(item.url);
    }
  } catch (err) {
    removeFiles(created);
    throw err;
  }
  return { rows, sources, created, files, uploaded };
}

/**
 * Delete files a failed attempt created, but only those no story_photos row references (checked now, after the rollback):
 * the same content-addressed file may belong to a story that was published meanwhile, and it must survive.
 */
/**
 * Inside the transaction, just before COMMIT: every uploaded photo this publish relies on must still be on disk. A file that
 * was already there when we looked may have been deleted since by another publish's rollback (it created and then removed
 * the same content-addressed file). Throws a retryable error so nothing is written and the editor sees "try again".
 */
export function assertFilesExist(files: string[]): void {
  const hook = process.env.STORY_SYNC_TEST === '1' ? process.env.PUBLISH_TEST_DELETE_FILE : undefined;
  if (hook && fs.existsSync(hook)) for (const f of files) fs.rmSync(f, { force: true }); // test only: a concurrent rollback
  if (files.some((f) => !fs.existsSync(f))) throw new EditorError('publish_retry');
}

export function removeFiles(files: string[]): void {
  const root = mediaDir() + path.sep;
  for (const f of files) {
    try {
      const rel = f.startsWith(root) ? f.slice(root.length).split(path.sep).join('/') : null;
      if (rel && getDb().prepare('SELECT 1 FROM story_photos WHERE path = ?').get(rel)) continue;
      fs.rmSync(f, { force: true });
    } catch { /* best effort */ }
  }
}

/** The photo fields of a story row from stored photos. */
function photoFields(p: StoredPhotos, alts: string[], title: string) {
  return {
    image: p.sources[0],
    imageAlt: p.sources.length ? alts[0] || title : undefined,
    photos: p.sources.slice(1),
    photoAlts: alts.slice(1),
  };
}

// ---- dashboard publish ----

/** `<date>-<title>` and, if that address is taken (a story or another draft), `-2`, `-3` ... Synchronous: see the file header. */
function freshSlug(date: string, title: string): string {
  const base = `${date}-${slugify(title)}`;
  for (let n = 1; n <= 30; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!getDraftBySlug(slug) && !storyExists(slug)) return slug;
  }
  throw new EditorError('slug_none');
}

export interface DraftPublished {
  slug: string;
  title: string;
  uploaded: Map<number, string>;
  /** True when this publish was the draft's first (issue #121: the only one that may email the submitter). */
  firstPublish: boolean;
}

/**
 * Check the draft against the content rules and publish it, all or nothing. `version` is the draft version the editor
 * is looking at: if the draft changed since, nothing is published (EditorError 'conflict'). Throws EditorError with a
 * code an editor can act on; anything else is an unexpected failure (the caller shows "could not publish").
 */
export async function publishDraft(draft: Draft, photos: DraftPhoto[], version: number, userId: number, scheduled?: { now: number }): Promise<DraftPublished> {
  const title = oneLine(draft.title);
  const author = oneLine(draft.author);
  const dek = oneLine(draft.dek);
  let draftBlocks: StoryBlock[];
  try { draftBlocks = normalizeStoryBlocks(draft.storyBlocks ?? []); } catch { throw new EditorError('blocks_bad'); }
  if (walkStoryBlocks(draftBlocks).some((b) => b.type === 'gallery' && (b.photos?.length ?? 0) < 2)) throw new EditorError('blocks_bad');
  if (walkStoryBlocks(draftBlocks).some((b) => ['button', 'video'].includes(b.type) && !b.url)) throw new EditorError('link_unsafe');
  // The Markdown is built and measured as typed (the same rule as saving); every "<" becomes &lt; only when it is written
  // (here for the body, in writeStory for the modules), so escaping can never push a field over its limit.
  const body = clean(draftBlocks.length ? storyBlocksToMarkdown(draftBlocks) : draft.body).trim();
  const section = draft.section;
  const area = draft.area || undefined;

  if (!title) throw new EditorError('title_required');
  if (title.length > LIMITS.title) throw new EditorError('title_long');
  if (!author) throw new EditorError('author_required');
  if (author.length > PUBLISH_LIMITS.author) throw new EditorError('author_long');
  if (dek.length > LIMITS.dek) throw new EditorError('dek_long');
  if (!body) throw new EditorError('body_required');
  if (body.replace(/&lt;/g, '<').length > LIMITS.bodyMax || body.length > 4 * LIMITS.bodyMax) throw new EditorError('body_long');
  try { checkStoryBlockLength(draftBlocks); } catch { throw new EditorError('body_long'); } // same rule as saving
  if (!getSection(section)) throw new EditorError('section_required');
  if (!isValidArea(section, area)) throw new EditorError('area_bad');
  if (!validDate(draft.date)) throw new EditorError('date_required');
  const column = ''; // issue #136: column names are retired
  const authorTitle = oneLine(draft.authorTitle).slice(0, PUBLISH_LIMITS.author);
  const church = oneLine(draft.church).slice(0, 160);
  const photoCredit = oneLine(draft.photoCredit).slice(0, 120);
  if (photos.length > LIMITS.maxPhotos) throw new EditorError('photos_many');

  const rendered = await renderMarkdownSafe(body);
  if (rendered.unsafeLinks) throw new EditorError('link_unsafe');

  const slug = draft.slug ?? freshSlug(draft.date, title);
  if (!validSlug(slug)) throw new EditorError('slug_bad');

  // Read the photo bytes now (nothing is written yet).
  const items: PhotoInput[] = [];
  for (const p of photos) {
    if (p.url) { items.push({ kind: 'keep', url: p.url, alt: '' }); continue; }
    const full = p.path ? uploadFile(p.path) : null;
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(full!);
    } catch {
      throw new EditorError('photo_missing');
    }
    const ext = sniffImage(bytes);
    if (!ext) throw new EditorError('photo_not_image');
    items.push({ kind: 'file', bytes, ext, alt: '', draftPhotoId: p.id });
  }
  const alts = photos.map((p) => clean(p.alt).replace(/\s+/g, ' ').trim().slice(0, PUBLISH_LIMITS.alt));
  items.forEach((it, i) => { it.alt = alts[i]; });

  const existing = getStoryBySlug(slug, { includeUnpublished: true });
  const stored = await storePhotos(slug, items, existing);
  const storyBlocks: StoryBlock[] = mapStoryPhotos(draftBlocks, (block) => {
    const index = photos.findIndex((p) => p.id === block.photoId);
    if (index < 0) { removeFiles(stored.created); throw new EditorError('photo_missing'); }
    const photo = photos[index];
    return { ...block, photoId: undefined, photoIndex: index, url: stored.sources[index], alt: block.alt || photo.alt, focalX: photo.focalX ?? 50, focalY: photo.focalY ?? 50, zoom: photo.zoom ?? 1, fit: photo.fit ?? 'cover', fitFill: photo.fitFill ?? 'blur' };
  });
  stored.rows.forEach((row, i) => { row.focalX = photos[i].focalX ?? 50; row.focalY = photos[i].focalY ?? 50; row.zoom = photos[i].zoom ?? 1; row.fit = photos[i].fit ?? 'cover'; row.fitFill = photos[i].fitFill ?? 'blur'; row.caption = captionText(photos[i].caption); });
  const now = Date.now();
  const story: StoryInput = {
    slug, title, dek: dek || undefined, section, additionalSections: draft.additionalSections, newsletterIssue: draft.newsletterIssue ?? null, keyPoints: normalizeKeyPoints(draft.keyPoints), area, column: column || undefined, author, authorTitle: authorTitle || undefined, church: church || undefined,
    date: draft.date, photoCredit: stored.sources.length && photoCredit ? photoCredit : undefined,
    ...photoFields(stored, alts, title),
    announcement: draft.announcement, photoLayout: draft.photoLayout, featured: draft.featured, draft: false, body: escapeHtmlInMarkdown(body), storyBlocks,
    status: 'live', source: draft.source, draftId: draft.id, publishedAt: now, publishedBy: userId, editedAt: now, photoRows: stored.rows,
  };

  // One transaction, no await inside: draft row (version check + slug) and the story rows change together.
  const db = getDb();
  let firstPublish = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // A new address may have been taken since freshSlug looked (another process); never take another story's.
      if (!draft.slug && (storyExists(slug) || getDraftBySlug(slug))) throw new EditorError('slug_taken');
      const r = publishDraftRow(draft.id, version, { slug, userId }, scheduled);
      if (!r.ok) throw new EditorError(r.code);
      firstPublish = r.firstPublish;
      writeStory(story, now, draft.slug ? 'upsert' : 'insert');
      assertFilesExist(stored.files);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  } catch (err) {
    removeFiles(stored.created);
    if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new EditorError('slug_taken');
    throw err;
  }
  invalidateStories();
  return { slug, title, uploaded: stored.uploaded, firstPublish };
}

// ---- unpublish and edit ----

/** Take a story off the site and return its draft (if any) to review, in one transaction. Null when there is no such story. */
export function unpublishLive(slug: string, userId: number): { title: string } | null {
  if (!validSlug(slug)) throw new EditorError('slug_bad');
  const row = getStoryBySlug(slug, { includeUnpublished: true });
  if (!row) return null;
  tx(() => {
    markUnpublished(slug, userId);
    hideStory(slug, Date.now(), true);
  });
  invalidateStories();
  return { title: row.title };
}

/**
 * Change a few fields of one live story through the story writer (bulk edit, issue #89): one transaction, `rev` bumped,
 * `edited_at` set (a person's edit), search entry rewritten, caches invalidated. `compute` sees the stored story inside the
 * transaction and returns only the fields to change (or null for "nothing to change"); it may throw an EditorError to refuse.
 * Returns null when there is no such story.
 */
export function editLiveStory(slug: string, compute: (story: Story) => Partial<StoryInput> | null): { title: string; changed: boolean } | null {
  if (!validSlug(slug)) throw new EditorError('slug_bad');
  let out: { title: string; changed: boolean } | null = null;
  tx(() => {
    const row = getStoryBySlug(slug, { includeUnpublished: true });
    if (!row) return;
    const patch = compute(row);
    out = { title: row.title, changed: !!patch };
    if (!patch) return;
    const now = Date.now();
    // contentHash is cleared like every dashboard write; editedAt makes the one-time import leave the story alone.
    const next = { ...row, ...patch, contentHash: undefined, editedAt: now };
    writeStory(next, now);
    // The closed draft linked to this story keeps the same metadata, so unpublishing and publishing again cannot revert the edit.
    syncPublishedDraftFields(slug, row.draftId, { section: next.section, area: next.area ?? '', column: '', additionalSections: next.additionalSections ?? [], featured: next.featured, date: next.date, announcement: 'announcement' in patch ? next.announcement ?? null : undefined });
  });
  const result = out as { title: string; changed: boolean } | null;
  if (result?.changed) invalidateStories();
  return result;
}

export interface LoadedStory {
  fields: DraftFields;
  photos: { url: string; alt: string; caption: string; focalX?: number; focalY?: number; zoom?: number; fit?: PhotoFit; fitFill?: PhotoFitFill }[];
}

/** A live story from the database as editor fields and photos. Null when there is no live story with that address. */
export function loadStory(slug: string): LoadedStory | null {
  if (!validSlug(slug)) throw new EditorError('slug_bad');
  const s = getStoryBySlug(slug);
  if (!s) return null;
  if (!getSection(s.section)) throw new EditorError('section_unknown');
  const sources = [...(s.image ? [s.image] : []), ...s.photos];
  // Image modules can only show the story's own photos (writes refuse anything else); drop one that does not, never add a source.
  const storyBlocks = s.storyBlocks && mapStoryPhotos(unescapeStoryBlockPlainText(s.storyBlocks), (p) => p.url && sources.includes(p.url) ? p : null);
  const alts = [s.imageAlt ?? '', ...s.photoAlts];
  return {
    fields: {
      title: s.title, dek: s.dek ?? '', section: s.section, additionalSections: s.additionalSections, newsletterIssue: s.newsletterIssue ?? null, keyPoints: normalizeKeyPoints(s.keyPoints), area: s.area ?? '', column: s.column ?? '', author: s.author, authorTitle: s.authorTitle ?? '',
      church: s.church ?? '', date: s.date, photoCredit: s.photoCredit ?? '', announcement: s.announcement, photoLayout: photoLayoutOrDefault(s.photoLayout), featured: s.featured, body: s.body, storyBlocks,
    },
    photos: sources.map((url, i) => {
      const inline = storyBlockPhotos(storyBlocks ?? []).find((b) => b.url === url);
      return { url, alt: alts[i] ?? inline?.alt ?? '', caption: s.photoRows.find((p) => p.position === i)?.caption ?? '', focalX: s.photoRows.find((p) => p.position === i)?.focalX ?? inline?.focalX ?? 50, focalY: s.photoRows.find((p) => p.position === i)?.focalY ?? inline?.focalY ?? 50, zoom: s.photoRows.find((p) => p.position === i)?.zoom ?? inline?.zoom ?? 1, fit: s.photoRows.find((p) => p.position === i)?.fit ?? inline?.fit ?? 'cover', fitFill: s.photoRows.find((p) => p.position === i)?.fitFill ?? inline?.fitFill ?? 'blur' };
    }),
  };
}

// ---- Studio ----

export interface StudioPublished {
  ref: string;
  slug: string;
  status: 'created' | 'updated';
}

function photoIdentity(photo: StoryPhoto): string {
  if (photo.path) return `file:${photo.path}:${photo.sha256}`;
  try { return photo.url && new URL(photo.url).protocol === 'https:' ? `url:${new URL(photo.url).href}` : ''; }
  catch { return ''; }
}

/**
 * Publish the stories of one Studio request in ONE transaction, with the dashboard records. The photos' bytes are
 * written first; if the transaction fails they are deleted again and nothing else has changed.
 */
export async function publishStudioStories(prepared: PreparedStudioStory[]): Promise<{ stories: StudioPublished[]; ids: number[]; overwrote: number[] }> {
  const created: string[] = [];
  const planned: { p: PreparedStudioStory; stored: StoredPhotos; existed: boolean }[] = [];
  try {
    for (const p of prepared) {
      const existing = getStoryBySlug(p.slug, { includeUnpublished: true });
      const items: PhotoInput[] = p.photos.map((ph) => (ph.data ? { kind: 'file', bytes: ph.data.bytes, ext: ph.data.ext, alt: ph.alt } : { kind: 'keep', url: ph.url, alt: ph.alt }));
      const stored = await storePhotos(p.slug, items, existing);
      created.push(...stored.created);
      planned.push({ p, stored, existed: !!existing });
    }
    const now = Date.now();
    let ids: number[] = [];
    let overwrote: number[] = [];
    let oldUploads: string[] = [];
    tx(() => {
      assertFilesExist(planned.flatMap(({ stored }) => stored.files));
      for (const { p, stored } of planned) {
        // Resolve inheritance now, after all asynchronous file preparation, so an
        // older client cannot overwrite a more recent crop with a stale snapshot.
        const latest = getStoryBySlug(p.slug, { includeUnpublished: true });
        const used = new Set<number>();
        stored.rows.forEach((row, i) => {
          const identity = photoIdentity(row);
          const same = latest?.photoRows.filter((old) => !!identity && !used.has(old.position) && photoIdentity(old) === identity) ?? [];
          const previous = same.find((old) => old.position === i) ?? same[0];
          if (previous) used.add(previous.position);
          row.focalX = p.photos[i].focalX ?? previous?.focalX ?? 50;
          row.focalY = p.photos[i].focalY ?? previous?.focalY ?? 50;
          row.zoom = p.photos[i].zoom ?? previous?.zoom ?? 1;
          row.fit = p.photos[i].fit ?? previous?.fit ?? 'cover';
          row.fitFill = p.photos[i].fitFill ?? previous?.fitFill ?? 'blur';
          row.caption = p.photos[i].shownCaption ?? previous?.caption ?? '';
        });
        writeStory({
          slug: p.slug, title: p.title, dek: p.dek || undefined, section: p.section, additionalSections: p.additionalSections, area: p.area, author: p.author, date: p.date,
          photoCredit: stored.sources.length && p.photoCredit ? p.photoCredit : undefined,
          ...photoFields(stored, [p.leadAlt, ...p.photos.slice(1).map((ph) => ph.alt)], p.title),
          photoLayout: p.photoLayout, featured: false, draft: false, body: p.body, status: 'live', source: 'studio', publishedAt: now, editedAt: now, photoRows: stored.rows,
        }, now);
      }
      const rec = recordStudioPublish(planned.map(({ p, stored }) => ({
        slug: p.slug, title: p.title, dek: p.dek, section: p.section, additionalSections: getStoryBySlug(p.slug, { includeUnpublished: true })?.additionalSections, area: p.area, author: p.author, date: p.date, photoCredit: p.photoCredit, photoLayout: p.photoLayout, body: p.body, announcement: getStoryBySlug(p.slug, { includeUnpublished: true })?.announcement ?? null, newsletterIssue: getStoryBySlug(p.slug, { includeUnpublished: true })?.newsletterIssue ?? null,
        photos: stored.sources.map((url, i) => ({ url, alt: p.photos[i].alt, caption: stored.rows[i].caption ?? '', focalX: stored.rows[i].focalX, focalY: stored.rows[i].focalY, zoom: stored.rows[i].zoom, fit: stored.rows[i].fit, fitFill: stored.rows[i].fitFill })),
      })));
      ids = rec.ids; overwrote = rec.overwrote; oldUploads = rec.oldUploads;
    });
    invalidateStories();
    removeUploadFiles(oldUploads);
    return { stories: planned.map(({ p, existed }) => ({ ref: p.ref, slug: p.slug, status: existed ? 'updated' as const : 'created' as const })), ids, overwrote };
  } catch (err) {
    removeFiles(created);
    throw err;
  }
}
