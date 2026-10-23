import { normalizeAdditionalSections, parseAdditionalSections, sectionMembershipSql } from './site';
import { parseAnnouncement, announcementJson, type Announcement } from './announcement';
// Stories and their photos in the database. Since epic #25 step 4 this is the source of truth: publishing, editing and
// unpublishing write here (src/lib/story-publish.ts) and nothing reads the build for content after the one-time
// adoption (src/lib/story-adopt.ts). Every function is synchronous like the rest of the db code and every query is
// parameterized. Public pages read the rows through public-stories.ts; every write below clears the page cache
// (invalidateStories) so the change shows on the next request.
import { assertOwnStoryImages, escapeStoryBlocks, parseStoredStoryBlocks, normalizeStoryBlocks, type PhotoFit, type PhotoFitFill, type StoryBlock } from './story-blocks';
import { getDb } from './db';
import { invalidateStories } from './public-cache';
import { indexStory } from './search-index';
import { photoLayoutOrDefault, type PhotoLayout } from './photo-layouts';

export type StoryStatus = 'live' | 'unpublished';
export type StorySource = 'git' | 'form' | 'studio' | 'editor' | 'agent';

export interface StoryPhoto {
  position: number;
  kind: 'lead' | 'gallery';
  /** Relative to DATA_DIR/media; served at /media/<path>. Null for a photo we do not hold. */
  path: string | null;
  /** The photo's own address when we do not hold the file (a remote https:// photo or an uncopied file). */
  url: string | null;
  alt: string;
  sha256: string | null;
  /** Size of the stored file; lets the sync skip re-hashing an unchanged photo. */
  bytes: number | null;
  focalX?: number;
  focalY?: number;
  zoom?: number;
  fit?: PhotoFit;
  fitFill?: PhotoFitFill;
}

/** The content schema's fields (src/content.config.ts) plus what the database adds. Optional fields are undefined when absent. */
export interface StoryInput {
  announcement?: Announcement | null;
  slug: string;
  title: string;
  dek?: string;
  section: string;
  additionalSections?: string[];
  area?: string;
  column?: string;
  author: string;
  authorTitle?: string;
  church?: string;
  /** YYYY-MM-DD */
  date: string;
  image?: string;
  imageAlt?: string;
  photoCredit?: string;
  photos: string[];
  photoAlts: string[];
  /** How the photos are arranged on the story page (migration 016); 'one' is the original look. */
  photoLayout?: PhotoLayout;
  featured: boolean;
  draft: boolean;
  body: string;
  storyBlocks?: StoryBlock[];
  status: StoryStatus;
  source: StorySource;
  draftId?: number;
  publishedAt: number;
  publishedBy?: number;
  contentHash?: string;
  /** Set by dashboard/Studio changes; left alone when undefined. */
  editedAt?: number;
  photoRows: StoryPhoto[];
}

export interface Story extends StoryInput {
  id: number;
  updatedAt: number;
}

type Row = Record<string, unknown>;

const opt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const optNum = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

function fromRow(r: Row, photoRows: StoryPhoto[]): Story {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    title: String(r.title),
    dek: opt(r.dek),
    section: String(r.section),
    additionalSections: parseAdditionalSections(r.additional_sections, String(r.section)),
    area: opt(r.area),
    column: opt(r.story_column),
    author: String(r.author),
    authorTitle: opt(r.author_title),
    church: opt(r.church),
    date: String(r.date),
    image: opt(r.image),
    imageAlt: opt(r.image_alt),
    photoCredit: opt(r.photo_credit),
    photos: JSON.parse(String(r.photos)) as string[],
    photoAlts: JSON.parse(String(r.photo_alts)) as string[],
    photoLayout: photoLayoutOrDefault(r.photo_layout),
    featured: Number(r.featured) === 1,
    draft: Number(r.draft) === 1,
    body: String(r.body),
    storyBlocks: escapeStoryBlocks(parseStoredStoryBlocks(r.story_blocks)),
    announcement: parseAnnouncement(r.announcement),
    status: r.status as StoryStatus,
    source: r.source as StorySource,
    draftId: optNum(r.draft_id),
    publishedAt: Number(r.published_at),
    updatedAt: Number(r.updated_at),
    publishedBy: optNum(r.published_by),
    contentHash: opt(r.content_hash),
    editedAt: optNum(r.edited_at),
    photoRows,
  };
}

function photosOf(storyId: number): StoryPhoto[] {
  const rows = getDb().prepare('SELECT position, kind, path, url, alt, sha256, bytes, focal_x, focal_y, zoom, fit, fit_fill FROM story_photos WHERE story_id = ? ORDER BY position').all(storyId) as Row[];
  return rows.map((p) => ({
    position: Number(p.position),
    kind: p.kind as 'lead' | 'gallery',
    path: opt(p.path) ?? null,
    url: opt(p.url) ?? null,
    alt: String(p.alt),
    sha256: opt(p.sha256) ?? null,
    bytes: optNum(p.bytes) ?? null,
    focalX: Number(p.focal_x ?? 50),
    focalY: Number(p.focal_y ?? 50),
    zoom: Number(p.zoom ?? 1),
    fit: p.fit === 'contain' ? 'contain' : 'cover',
    fitFill: p.fit_fill === 'paper' || p.fit_fill === 'navy' ? p.fit_fill : 'blur',
  }));
}

/** One story by slug. Unpublished stories are only returned when asked for. */
export function getStoryBySlug(slug: string, opts: { includeUnpublished?: boolean } = {}): Story | undefined {
  const r = getDb().prepare('SELECT * FROM stories WHERE slug = ?').get(slug) as Row | undefined;
  if (!r || (r.status !== 'live' && !opts.includeUnpublished)) return undefined;
  return fromRow(r, photosOf(Number(r.id)));
}

export interface ListOptions {
  section?: string;
  area?: string;
  featured?: boolean;
  /** Default 'live'; 'all' includes unpublished stories. */
  status?: StoryStatus | 'all';
  /** 1-200, default 20. */
  limit?: number;
  offset?: number;
}

export const LIST_MAX = 200;

function filters(opts: ListOptions): { sql: string; args: (string | number)[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const status = opts.status ?? 'live';
  if (status !== 'all') { where.push('status = ?'); args.push(status); }
  if (opts.section) { where.push(opts.area ? 'section = ?' : sectionMembershipSql()); args.push(...(opts.area ? [opts.section] : [opts.section, opts.section])); }
  if (opts.area) { where.push('area = ?'); args.push(opts.area); }
  if (opts.featured !== undefined) { where.push('featured = ?'); args.push(opts.featured ? 1 : 0); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

/** Stories, newest first (date, then published_at, then slug), with paging. */
export function listStories(opts: ListOptions = {}): Story[] {
  const { sql, args } = filters(opts);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20) || 20, 1), LIST_MAX);
  const offset = Math.max(Math.trunc(opts.offset ?? 0) || 0, 0);
  const rows = getDb().prepare(`SELECT * FROM stories ${sql} ORDER BY date DESC, published_at DESC, slug ASC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[];
  return rows.map((r) => fromRow(r, photosOf(Number(r.id))));
}

export const listRecent = (limit = 20, offset = 0) => listStories({ limit, offset });
export const listBySection = (section: string, area?: string, limit = 20, offset = 0) => listStories({ section, area, limit, offset });
export const listFeatured = (limit = 20, offset = 0) => listStories({ featured: true, limit, offset });

/** How many stories match (same filters as listStories, ignoring paging). */
export function countStories(opts: Omit<ListOptions, 'limit' | 'offset'> = {}): number {
  const { sql, args } = filters(opts);
  const r = getDb().prepare(`SELECT COUNT(*) AS n FROM stories ${sql}`).get(...args) as { n: number };
  return Number(r.n);
}

const nul = (v: string | undefined) => v ?? null;

let appliedAt015: number | undefined;
/**
 * A person's edit is stamped no earlier than one millisecond after migration 015 was applied, whatever the host clock says:
 * if the clock steps backwards, a step-4 edit must still look newer than the upgrade (the adoption and the import script
 * compare edited_at with that moment).
 */
export function editStamp(now: number): number {
  if (appliedAt015 === undefined) {
    try {
      appliedAt015 = Number((getDb().prepare("SELECT applied_at FROM schema_migrations WHERE name = '015_stories_source_of_truth.sql'").get() as { applied_at: number } | undefined)?.applied_at ?? 0);
    } catch { appliedAt015 = 0; }
  }
  return Math.max(now, appliedAt015 + 1);
}

export type WriteOutcome = 'inserted' | 'updated' | 'unchanged';

/**
 * Write one story and its photo rows and index it for search. NO transaction of its own: the caller has one open
 * (BEGIN IMMEDIATE), so a publish can change several tables, or several stories, all or nothing. `mode: 'insert'`
 * fails with a UNIQUE error when the slug exists (a new story must never silently take another's address).
 */
export function writeStory(s: StoryInput, now: number, mode: 'upsert' | 'insert' = 'upsert'): { outcome: WriteOutcome; id: number } {
  const db = getDb();
  // draft_id and published_by are plain columns (no foreign keys, see migration 011), so check them here.
  if (s.draftId !== undefined && !db.prepare('SELECT 1 FROM drafts WHERE id = ?').get(s.draftId)) throw new Error('writeStory: unknown draft');
  if (s.publishedBy !== undefined && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(s.publishedBy)) throw new Error('writeStory: unknown user');
  const cur = mode === 'insert' ? undefined : (db.prepare('SELECT id, content_hash, status, source, announcement, additional_sections FROM stories WHERE slug = ?').get(s.slug) as
    { id: number; content_hash: string | null; status: string; source: string; announcement: string | null; additional_sections: string } | undefined);
  const additionalSections = normalizeAdditionalSections(s.additionalSections === undefined ? parseAdditionalSections(cur?.additional_sections) : s.additionalSections, s.section);
  if (cur && s.contentHash && cur.content_hash === s.contentHash && cur.status === s.status && cur.source === s.source && JSON.stringify(parseAdditionalSections(cur.additional_sections, s.section)) === JSON.stringify(additionalSections)) return { outcome: 'unchanged', id: Number(cur.id) };
  // Module text follows the body contract (every "<" is &lt;), and an image module may only show this story's own photos.
  const blocks = escapeStoryBlocks(normalizeStoryBlocks(s.storyBlocks ?? []));
  assertOwnStoryImages(blocks, [...(s.image ? [s.image] : []), ...s.photos]);
  const cols = [s.title, nul(s.dek), s.section, nul(s.area), nul(s.column), s.author, nul(s.authorTitle), nul(s.church), s.date, nul(s.image), nul(s.imageAlt), nul(s.photoCredit),
    JSON.stringify(s.photos), JSON.stringify(s.photoAlts), s.featured ? 1 : 0, s.draft ? 1 : 0, s.body, s.status, s.source, s.draftId ?? null,
    s.publishedAt, now, s.publishedBy ?? null, s.contentHash ?? null, photoLayoutOrDefault(s.photoLayout), JSON.stringify(blocks), s.announcement === undefined ? cur?.announcement ?? null : announcementJson(s.announcement), JSON.stringify(additionalSections)];
  const editedAt = s.editedAt === undefined ? null : editStamp(s.editedAt);
  let id: number;
  if (cur) {
    id = Number(cur.id);
    db.prepare(`UPDATE stories SET title=?, dek=?, section=?, area=?, story_column=?, author=?, author_title=?, church=?, date=?, image=?, image_alt=?, photo_credit=?,
      photos=?, photo_alts=?, featured=?, draft=?, body=?, status=?, source=?, draft_id=?, published_at=?, updated_at=?, published_by=?, content_hash=?, photo_layout=?, story_blocks=?, announcement=?, additional_sections=?, edited_at=COALESCE(?, edited_at), rev=rev+1 WHERE id = ?`).run(...cols, editedAt, id);
    db.prepare('DELETE FROM story_photos WHERE story_id = ?').run(id);
  } else {
    const r = db.prepare(`INSERT INTO stories (title, dek, section, area, story_column, author, author_title, church, date, image, image_alt, photo_credit,
      photos, photo_alts, featured, draft, body, status, source, draft_id, published_at, updated_at, published_by, content_hash, photo_layout, story_blocks, announcement, additional_sections, edited_at, slug)
      VALUES (${Array(cols.length + 2).fill('?').join(',')})`).run(...cols, editedAt, s.slug);
    id = Number(r.lastInsertRowid);
  }
  const ins = db.prepare('INSERT INTO story_photos (story_id, position, kind, path, url, alt, sha256, bytes, focal_x, focal_y, zoom, fit, fit_fill) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const p of s.photoRows) ins.run(id, p.position, p.kind, p.path, p.url, p.alt, p.sha256, p.bytes, p.focalX ?? 50, p.focalY ?? 50, p.zoom ?? 1, p.fit ?? 'cover', p.fitFill ?? 'blur');
  indexStory(db, id, s, now); // search index row (migration 013), in the same transaction: findable as soon as it is saved
  return { outcome: cur ? 'updated' : 'inserted', id };
}

/**
 * Insert or update a story by slug, replacing its photo rows, in one transaction of its own (the adoption pass and
 * tests use this). When the row exists with the same contentHash, status and source, nothing is written ('unchanged').
 * Callers do all file reading and hashing first: the write lock is held only for these few statements.
 */
export function upsertStory(s: StoryInput, now = Date.now()): WriteOutcome {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const { outcome } = writeStory(s, now);
    db.exec('COMMIT');
    if (outcome !== 'unchanged') invalidateStories();
    return outcome;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Take a story off the site (the row and its photos stay). True when a live story was changed. `editedAt` marks it as
 * changed through the dashboard. No transaction of its own, so a caller can combine it with the draft's change; the
 * caller invalidates the cache after committing (use unpublishStoryNow outside a transaction).
 */
export function unpublishStory(slug: string, now = Date.now(), edited = false): boolean {
  const r = getDb().prepare("UPDATE stories SET status = 'unpublished', updated_at = ?, edited_at = CASE WHEN ? THEN MAX(?, COALESCE(edited_at, 0) + 1) ELSE edited_at END, rev = rev + 1 WHERE slug = ? AND status = 'live'").run(now, edited ? 1 : 0, editStamp(now), slug);
  return Number(r.changes) > 0;
}

/** Whether a story row exists, live or not. */
export function storyExists(slug: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM stories WHERE slug = ?').get(slug);
}

/** Slugs of the stories of one source with a given status (the git sync uses this to find stories that left the build). */
export function slugsBySource(source: StorySource, status: StoryStatus): string[] {
  return (getDb().prepare('SELECT slug FROM stories WHERE source = ? AND status = ?').all(source, status) as { slug: string }[]).map((r) => r.slug);
}

/** What the sync needs to decide whether a story changed, without loading it. */
export function getStoryHash(slug: string): { hash: string | null; status: string; source: string } | undefined {
  const r = getDb().prepare('SELECT content_hash, status, source FROM stories WHERE slug = ?').get(slug) as { content_hash: string | null; status: string; source: string } | undefined;
  return r ? { hash: r.content_hash, status: r.status, source: r.source } : undefined;
}
