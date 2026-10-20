// Stories and their photos in the database (epic #25, step 1). Every function is synchronous like the rest of
// the db code and every query is parameterized. Until step 4, git is the source of truth and these rows are a
// mirror of the built site (see story-sync.ts). Public pages read them through public-stories.ts once the mirror
// is complete; every write below clears the page cache (invalidateStories) so the change shows on the next request.
import { getDb } from './db';
import { invalidateStories } from './public-cache';

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
}

/** The content schema's fields (src/content.config.ts) plus what the database adds. Optional fields are undefined when absent. */
export interface StoryInput {
  slug: string;
  title: string;
  dek?: string;
  section: string;
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
  featured: boolean;
  draft: boolean;
  body: string;
  status: StoryStatus;
  source: StorySource;
  draftId?: number;
  publishedAt: number;
  publishedBy?: number;
  contentHash?: string;
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
    featured: Number(r.featured) === 1,
    draft: Number(r.draft) === 1,
    body: String(r.body),
    status: r.status as StoryStatus,
    source: r.source as StorySource,
    draftId: optNum(r.draft_id),
    publishedAt: Number(r.published_at),
    updatedAt: Number(r.updated_at),
    publishedBy: optNum(r.published_by),
    contentHash: opt(r.content_hash),
    photoRows,
  };
}

function photosOf(storyId: number): StoryPhoto[] {
  const rows = getDb().prepare('SELECT position, kind, path, url, alt, sha256, bytes FROM story_photos WHERE story_id = ? ORDER BY position').all(storyId) as Row[];
  return rows.map((p) => ({
    position: Number(p.position),
    kind: p.kind as 'lead' | 'gallery',
    path: opt(p.path) ?? null,
    url: opt(p.url) ?? null,
    alt: String(p.alt),
    sha256: opt(p.sha256) ?? null,
    bytes: optNum(p.bytes) ?? null,
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
  if (opts.section) { where.push('section = ?'); args.push(opts.section); }
  if (opts.area) { where.push('area = ?'); args.push(opts.area); }
  if (opts.featured !== undefined) { where.push('featured = ?'); args.push(opts.featured ? 1 : 0); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

/** Stories, newest first (date, then slug), with paging. */
export function listStories(opts: ListOptions = {}): Story[] {
  const { sql, args } = filters(opts);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20) || 20, 1), LIST_MAX);
  const offset = Math.max(Math.trunc(opts.offset ?? 0) || 0, 0);
  const rows = getDb().prepare(`SELECT * FROM stories ${sql} ORDER BY date DESC, slug ASC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[];
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

/**
 * Insert or update a story by slug, replacing its photo rows, in one transaction.
 * When the row exists with the same contentHash, status and source, nothing is written ('unchanged').
 */
export function upsertStory(s: StoryInput, now = Date.now()): 'inserted' | 'updated' | 'unchanged' {
  const db = getDb();
  // draft_id and published_by are plain columns (no foreign keys, see migration 011), so check them here.
  if (s.draftId !== undefined && !db.prepare('SELECT 1 FROM drafts WHERE id = ?').get(s.draftId)) throw new Error('upsertStory: unknown draft');
  if (s.publishedBy !== undefined && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(s.publishedBy)) throw new Error('upsertStory: unknown user');
  // Callers do all file reading and hashing before this: the write lock is held only for these few statements.
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db.prepare('SELECT id, content_hash, status, source FROM stories WHERE slug = ?').get(s.slug) as
      { id: number; content_hash: string | null; status: string; source: string } | undefined;
    if (cur && s.contentHash && cur.content_hash === s.contentHash && cur.status === s.status && cur.source === s.source) {
      db.exec('COMMIT');
      return 'unchanged';
    }
    const cols = [s.title, nul(s.dek), s.section, nul(s.area), nul(s.column), s.author, nul(s.authorTitle), nul(s.church), s.date, nul(s.image), nul(s.imageAlt), nul(s.photoCredit),
      JSON.stringify(s.photos), JSON.stringify(s.photoAlts), s.featured ? 1 : 0, s.draft ? 1 : 0, s.body, s.status, s.source, s.draftId ?? null,
      s.publishedAt, now, s.publishedBy ?? null, s.contentHash ?? null];
    let id: number;
    if (cur) {
      id = Number(cur.id);
      db.prepare(`UPDATE stories SET title=?, dek=?, section=?, area=?, story_column=?, author=?, author_title=?, church=?, date=?, image=?, image_alt=?, photo_credit=?,
        photos=?, photo_alts=?, featured=?, draft=?, body=?, status=?, source=?, draft_id=?, published_at=?, updated_at=?, published_by=?, content_hash=? WHERE id = ?`).run(...cols, id);
      db.prepare('DELETE FROM story_photos WHERE story_id = ?').run(id);
    } else {
      const r = db.prepare(`INSERT INTO stories (title, dek, section, area, story_column, author, author_title, church, date, image, image_alt, photo_credit,
        photos, photo_alts, featured, draft, body, status, source, draft_id, published_at, updated_at, published_by, content_hash, slug)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...cols, s.slug);
      id = Number(r.lastInsertRowid);
    }
    const ins = db.prepare('INSERT INTO story_photos (story_id, position, kind, path, url, alt, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of s.photoRows) ins.run(id, p.position, p.kind, p.path, p.url, p.alt, p.sha256, p.bytes);
    db.exec('COMMIT');
    invalidateStories();
    return cur ? 'updated' : 'inserted';
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Take a story off the site (the row and its photos stay). True when a live story was changed. */
export function unpublishStory(slug: string, now = Date.now()): boolean {
  const r = getDb().prepare("UPDATE stories SET status = 'unpublished', updated_at = ? WHERE slug = ? AND status = 'live'").run(now, slug);
  if (Number(r.changes) > 0) invalidateStories();
  return Number(r.changes) > 0;
}

/** Keep a story off the public pages while the build with this marker is running (see migration 012). */
export function holdStory(slug: string, buildMarker: string, now = Date.now()): void {
  getDb().prepare('INSERT OR REPLACE INTO story_holds (slug, build_marker, created_at) VALUES (?, ?, ?)').run(slug, buildMarker, now);
  invalidateStories();
}

/** The build marker a story is held for, if it is held. */
export function getHold(slug: string): string | undefined {
  return (getDb().prepare('SELECT build_marker FROM story_holds WHERE slug = ?').get(slug) as { build_marker: string } | undefined)?.build_marker;
}

export function listHolds(): Map<string, string> {
  return new Map((getDb().prepare('SELECT slug, build_marker FROM story_holds').all() as { slug: string; build_marker: string }[]).map((r) => [r.slug, r.build_marker]));
}

export function releaseHold(slug: string): void {
  getDb().prepare('DELETE FROM story_holds WHERE slug = ?').run(slug);
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
