import { SECTIONS, canonicalSectionKey, getSection, normalizeAdditionalSections, parseAdditionalSections, sectionMembershipSql } from './site';
import { parseAnnouncement, announcementJson, type Announcement } from './announcement';
import { refFromRow, type NewsletterRef } from './newsletter-issues';
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
import { normalizeKeyPoints } from './key-points';

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
  /** Visible caption (migration 029, up to 300 characters); plain text, '' when none. Undefined is treated as ''. */
  caption?: string;
}

/** The content schema's fields (src/content.config.ts) plus what the database adds. Optional fields are undefined when absent. */
export interface StoryInput {
  announcement?: Announcement | null;
  slug: string;
  title: string;
  dek?: string;
  section: string;
  additionalSections?: string[];
  /** Newsletter issue (migration 028). undefined keeps the stored one on a rewrite (null on insert); null clears. Reads carry the issue's date and title. */
  newsletterIssue?: NewsletterRef | null;
  /** Key points (migration 033, issue #117): up to three plain-text lines. undefined keeps the stored list on a rewrite ([] on insert); [] clears. */
  keyPoints?: string[];
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
    newsletterIssue: refFromRow(r.newsletter_issue === null || r.newsletter_issue === undefined ? r : { ...r, ...(getDb().prepare('SELECT date AS issue_date, title AS issue_title FROM newsletter_issues WHERE number = ?').get(Number(r.newsletter_issue)) as Row | undefined) }),
    keyPoints: normalizeKeyPoints(r.key_points),
    area: opt(r.area),
    column: undefined, // issue #136: column names are retired
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
  const rows = getDb().prepare('SELECT position, kind, path, url, alt, sha256, bytes, focal_x, focal_y, zoom, fit, fit_fill, caption FROM story_photos WHERE story_id = ? ORDER BY position').all(storyId) as Row[];
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
    caption: String(p.caption ?? ''),
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
  const cur = mode === 'insert' ? undefined : (db.prepare('SELECT id, content_hash, status, source, announcement, additional_sections, newsletter_issue, newsletter_position, key_points FROM stories WHERE slug = ?').get(s.slug) as
    { key_points: string; id: number; content_hash: string | null; status: string; source: string; announcement: string | null; additional_sections: string; newsletter_issue: number | null; newsletter_position: number | null } | undefined);
  // undefined keeps the stored issue (Studio, adoption and the import script never send one); null clears it.
  const issue = s.newsletterIssue === undefined ? (cur?.newsletter_issue == null ? null : { number: Number(cur.newsletter_issue), position: cur.newsletter_position == null ? null : Number(cur.newsletter_position) }) : s.newsletterIssue;
  if (issue && !db.prepare('SELECT 1 FROM newsletter_issues WHERE number = ?').get(issue.number)) throw new Error('writeStory: unknown newsletter issue');
  // undefined keeps the stored key points (Studio, bulk edit, adoption and the import script never send them); [] clears.
  const keyPoints = normalizeKeyPoints(s.keyPoints === undefined ? cur?.key_points : s.keyPoints);
  const additionalSections = normalizeAdditionalSections(s.additionalSections === undefined ? parseAdditionalSections(cur?.additional_sections) : s.additionalSections, s.section);
  if (cur && s.contentHash && cur.content_hash === s.contentHash && cur.status === s.status && cur.source === s.source && JSON.stringify(parseAdditionalSections(cur.additional_sections, s.section)) === JSON.stringify(additionalSections) && (cur.newsletter_issue ?? null) === (issue?.number ?? null) && (cur.newsletter_position ?? null) === (issue?.position ?? null) && JSON.stringify(normalizeKeyPoints(cur.key_points)) === JSON.stringify(keyPoints)) return { outcome: 'unchanged', id: Number(cur.id) };
  // Module text follows the body contract (every "<" is &lt;), and an image module may only show this story's own photos.
  const blocks = escapeStoryBlocks(normalizeStoryBlocks(s.storyBlocks ?? []));
  assertOwnStoryImages(blocks, [...(s.image ? [s.image] : []), ...s.photos]);
  const cols = [s.title, nul(s.dek), s.section, nul(s.area), '', s.author, nul(s.authorTitle), nul(s.church), s.date, nul(s.image), nul(s.imageAlt), nul(s.photoCredit),
    JSON.stringify(s.photos), JSON.stringify(s.photoAlts), s.featured ? 1 : 0, s.draft ? 1 : 0, s.body, s.status, s.source, s.draftId ?? null,
    s.publishedAt, now, s.publishedBy ?? null, s.contentHash ?? null, photoLayoutOrDefault(s.photoLayout), JSON.stringify(blocks), s.announcement === undefined ? cur?.announcement ?? null : announcementJson(s.announcement), JSON.stringify(additionalSections), issue?.number ?? null, issue?.position ?? null, JSON.stringify(keyPoints)];
  const editedAt = s.editedAt === undefined ? null : editStamp(s.editedAt);
  let id: number;
  if (cur) {
    id = Number(cur.id);
    db.prepare(`UPDATE stories SET title=?, dek=?, section=?, area=?, story_column=?, author=?, author_title=?, church=?, date=?, image=?, image_alt=?, photo_credit=?,
      photos=?, photo_alts=?, featured=?, draft=?, body=?, status=?, source=?, draft_id=?, published_at=?, updated_at=?, published_by=?, content_hash=?, photo_layout=?, story_blocks=?, announcement=?, additional_sections=?, newsletter_issue=?, newsletter_position=?, key_points=?, edited_at=COALESCE(?, edited_at), rev=rev+1 WHERE id = ?`).run(...cols, editedAt, id);
    db.prepare('DELETE FROM story_photos WHERE story_id = ?').run(id);
  } else {
    const r = db.prepare(`INSERT INTO stories (title, dek, section, area, story_column, author, author_title, church, date, image, image_alt, photo_credit,
      photos, photo_alts, featured, draft, body, status, source, draft_id, published_at, updated_at, published_by, content_hash, photo_layout, story_blocks, announcement, additional_sections, newsletter_issue, newsletter_position, key_points, edited_at, slug)
      VALUES (${Array(cols.length + 2).fill('?').join(',')})`).run(...cols, editedAt, s.slug);
    id = Number(r.lastInsertRowid);
  }
  const ins = db.prepare('INSERT INTO story_photos (story_id, position, kind, path, url, alt, sha256, bytes, focal_x, focal_y, zoom, fit, fit_fill, caption) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const p of s.photoRows) ins.run(id, p.position, p.kind, p.path, p.url, p.alt, p.sha256, p.bytes, p.focalX ?? 50, p.focalY ?? 50, p.zoom ?? 1, p.fit ?? 'cover', p.fitFill ?? 'blur', (p.caption ?? '').slice(0, 300));
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

// ---- Editor dashboard: the paged Published list (issue #140) ----
// Read-only. Every filter is whitelisted by parsePublishedFilter() and every value is a bound parameter; the search
// text is LIKE-escaped. The set is the live, non-draft stories (what the public site shows).

export const PUBLISHED_SORTS = ['published_desc', 'published_asc', 'edited_desc', 'date_desc', 'title', 'section', 'event'] as const;
export type PublishedSort = (typeof PUBLISHED_SORTS)[number];
export const PUBLISHED_PER_PAGE = [25, 50, 100] as const;
export const PUBLISHED_Q_MAX = 200;
const PUBLISHED_PAGE_MAX = 100_000;

export const PUBLISHED_KINDS = ['all', 'story', 'announcement', 'event'] as const;
export type PublishedKind = (typeof PUBLISHED_KINDS)[number];

export interface PublishedFilter {
  /** Content type: no announcement is a story (issue #164). */
  kind: PublishedKind;
  q: string;
  section: string;
  area: string;
  issue: number | 'none' | null;
  /** Story date year, "2026". */
  year: string;
  featured: boolean;
  openDraft: boolean;
  /** Edited (dashboard or Studio change) since the first day of the current America/Chicago month. */
  editedThisMonth: boolean;
  sort: PublishedSort;
  perPage: number;
  page: number;
}

export interface PublishedRow {
  slug: string;
  kind: 'story' | 'announcement' | 'event';
  title: string;
  section: string;
  area?: string;
  church?: string;
  author: string;
  date: string;
  featured: boolean;
  issue: number | null;
  editedAt: number | null;
  publishedAt: number | null;
  publishedBy: string | null;
  openDraft: boolean;
  draftId: number | null;
  /** The announcement's event date (YYYY-MM-DD), or null when it has none (issue #168). */
  eventDate: string | null;
}

/** Wall clock in America/Chicago for an instant. */
function chicagoParts(ms: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) };
}

/** The current America/Chicago year and the instant (ms) the current Chicago month began. */
export function chicagoMonthStart(now = Date.now()): { year: string; startMs: number } {
  const { y, mo } = chicagoParts(now);
  const wall = Date.UTC(y, mo - 1, 1, 0, 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = chicagoParts(guess);
    guess -= Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - wall;
  }
  return { year: String(y), startMs: guess };
}

/** Turn query-string parameters into a filter. Anything unknown or malformed falls back to its default. */
export function parsePublishedFilter(params: URLSearchParams): PublishedFilter {
  const one = (k: string) => params.get(k) ?? '';
  const sec = getSection(canonicalSectionKey(one('section').trim()));
  const area = sec?.areas?.some((a) => a.key === one('area')) ? one('area') : '';
  const issueRaw = one('issue');
  const sort = (PUBLISHED_SORTS as readonly string[]).includes(one('sort')) ? (one('sort') as PublishedSort) : 'published_desc';
  const perPage = (PUBLISHED_PER_PAGE as readonly number[]).includes(Number(one('perPage'))) ? Number(one('perPage')) : 25;
  const pageRaw = /^\d{1,6}$/.test(one('page')) ? Number(one('page')) : 1;
  const kindRaw = one('kind');
  return {
    kind: (PUBLISHED_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as PublishedKind) : 'all',
    // Control characters would be noise in a LIKE; the length is capped before it reaches SQL.
    q: one('q').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, PUBLISHED_Q_MAX),
    section: sec ? sec.key : '',
    area,
    issue: issueRaw === 'none' ? 'none' : /^\d{1,4}$/.test(issueRaw) && Number(issueRaw) > 0 ? Number(issueRaw) : null,
    year: /^\d{4}$/.test(one('year')) ? one('year') : '',
    featured: one('featured') === 'yes',
    openDraft: one('openDraft') === 'yes',
    editedThisMonth: one('edited') === 'month',
    sort,
    perPage,
    page: Math.min(Math.max(pageRaw, 1), PUBLISHED_PAGE_MAX),
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const PUB_LIVE = 'd.published_commit IS NOT NULL AND d.unpublished_at IS NULL';
const PUB_AT = `COALESCE(CASE WHEN ${PUB_LIVE} THEN d.published_at END, s.published_at)`;
/** Who a Studio publish is credited to; the same name as STUDIO_NAME in drafts.ts. */
const STUDIO_PUBLISHER = 'IMConnected Studio';
const PUB_FROM = 'FROM stories s LEFT JOIN drafts d ON d.slug = s.slug LEFT JOIN users u ON u.id = d.published_by';
// "Edited" means changed after the story first went live. Publishing writes published_at and edited_at together (and republishing
// rewrites both), so neither marks the first publish; drafts.submitter_notified_at does (set once, at a draft's first publish, and
// kept by every later one; migration 034 backfilled it, 0 when unknown). Fall back to the story's own published_at.
const FIRST_LIVE = 'COALESCE(NULLIF(d.submitter_notified_at, 0), s.published_at)';
export const EDITED_GRACE_MS = 60_000;
const EDITED_COND = `s.edited_at IS NOT NULL AND s.edited_at > ${FIRST_LIVE} + ${EDITED_GRACE_MS}`;
/** The content type of a live story: no (or unreadable) announcement is a story. Bound values only ever compare against it. */
const PUB_KIND_SQL = "CASE WHEN json_valid(s.announcement) AND json_extract(s.announcement,'$.kind') IN ('announcement','event') THEN json_extract(s.announcement,'$.kind') ELSE 'story' END";
/** The announcement's event date as text, or NULL (no announcement, unreadable JSON, a missing, empty or non-text value). A constant expression. */
const EVENT_DATE_SQL = "NULLIF(CASE WHEN json_valid(s.announcement) THEN CASE WHEN json_type(s.announcement,'$.eventDate') = 'text' THEN json_extract(s.announcement,'$.eventDate') END END, '')";
const OPEN_DRAFT = "d.status IN ('new', 'in_review')";

const ORDER: Record<Exclude<PublishedSort, 'event'>, string> = {
  published_desc: `${PUB_AT} DESC, s.slug ASC`,
  published_asc: `${PUB_AT} ASC, s.slug ASC`,
  edited_desc: `CASE WHEN (${EDITED_COND}) THEN s.edited_at END IS NULL, CASE WHEN (${EDITED_COND}) THEN s.edited_at END DESC, s.slug ASC`,
  date_desc: 's.date DESC, s.slug ASC',
  title: 's.title COLLATE NOCASE ASC, s.slug ASC',
  section: "s.section COLLATE NOCASE ASC, COALESCE(s.area, '') COLLATE NOCASE ASC, s.slug ASC",
};

/**
 * ORDER BY text and its bound values. `event` (issue #168): upcoming first, soonest at the top, then past events newest
 * first, then those without a date. The text is constant; today (the America/Chicago day, YYYY-MM-DD) is the only bound
 * value, passed three times.
 */
function orderFor(sort: PublishedSort, now: number): { sql: string; args: string[] } {
  if (sort !== 'event') return { sql: ORDER[sort], args: [] };
  const { y, mo, d } = chicagoParts(now);
  const today = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ev = EVENT_DATE_SQL;
  return {
    sql: `CASE WHEN ${ev} IS NULL THEN 2 WHEN ${ev} >= ? THEN 0 ELSE 1 END, CASE WHEN ${ev} >= ? THEN ${ev} END ASC, CASE WHEN ${ev} < ? THEN ${ev} END DESC, ${ORDER.published_desc}`,
    args: [today, today, today],
  };
}

function publishedWhere(f: PublishedFilter, now: number): { sql: string; args: (string | number)[] } {
  const where = ["s.status = 'live'", 's.draft = 0'];
  const args: (string | number)[] = [];
  if (f.kind !== 'all') { where.push(`${PUB_KIND_SQL} = ?`); args.push(f.kind); }
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    where.push("(s.title LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\' OR COALESCE(s.church, '') LIKE ? ESCAPE '\\' OR s.author LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like, like);
  }
  if (f.section) {
    if (f.area) { where.push('s.section = ?', 's.area = ?'); args.push(f.section, f.area); }
    else { where.push(sectionMembershipSql('s.')); args.push(f.section, f.section); }
  }
  if (f.issue === 'none') where.push('s.newsletter_issue IS NULL');
  else if (f.issue !== null) { where.push('s.newsletter_issue = ?'); args.push(f.issue); }
  if (f.year) { where.push('substr(s.date, 1, 4) = ?'); args.push(f.year); }
  if (f.featured) where.push('s.featured = 1');
  if (f.openDraft) where.push(OPEN_DRAFT);
  if (f.editedThisMonth) { where.push(`(${EDITED_COND}) AND s.edited_at >= ?`); args.push(chicagoMonthStart(now).startMs); }
  return { sql: 'WHERE ' + where.join(' AND '), args };
}

/** One page of the Published list and how many stories match all filters. The page is clamped to the last one. */
export function listStoriesPage(f: PublishedFilter, now = Date.now()): { items: PublishedRow[]; total: number; page: number; pages: number } {
  const db = getDb();
  const { sql, args } = publishedWhere(f, now);
  const order = orderFor(f.sort, now);
  const total = Number((db.prepare(`SELECT COUNT(*) AS n ${PUB_FROM} ${sql}`).get(...args) as { n: number }).n);
  const pages = Math.max(1, Math.ceil(total / f.perPage));
  const page = Math.min(f.page, pages);
  const rows = db.prepare(`SELECT s.slug, ${PUB_KIND_SQL} AS kind, s.title, s.section, s.area, s.church, s.author, s.date, s.featured, s.newsletter_issue AS issue, CASE WHEN (${EDITED_COND}) THEN s.edited_at END AS edited_at,
      ${PUB_AT} AS pub_at, CASE WHEN ${PUB_LIVE} THEN CASE WHEN d.published_via_studio = 1 THEN ? ELSE u.name END END AS pub_by, CASE WHEN ${OPEN_DRAFT} THEN 1 ELSE 0 END AS open_draft, d.id AS draft_id, ${EVENT_DATE_SQL} AS event_date
    ${PUB_FROM} ${sql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`).all(STUDIO_PUBLISHER, ...args, ...order.args, f.perPage, (page - 1) * f.perPage) as Row[];
  return {
    total, page, pages,
    items: rows.map((r) => ({
      slug: String(r.slug), kind: (r.kind === 'announcement' || r.kind === 'event' ? r.kind : 'story') as PublishedRow['kind'], title: String(r.title), section: String(r.section), area: opt(r.area), church: opt(r.church), author: String(r.author), date: String(r.date),
      featured: Number(r.featured) === 1, issue: optNum(r.issue) ?? null, editedAt: optNum(r.edited_at) ?? null, publishedAt: optNum(r.pub_at) ?? null,
      publishedBy: opt(r.pub_by) ?? null, openDraft: Number(r.open_draft) === 1, draftId: optNum(r.draft_id) ?? null, eventDate: opt(r.event_date) ?? null,
    })),
  };
}

export interface PublishedCounts { all: number; featured: number; openDraft: number; editedThisMonth: number; thisYear: number; year: string }

/** The summary cards: one aggregate query over the live set (of one content type when `kind` is not 'all'). */
export function publishedCounts(now = Date.now(), kind: PublishedKind = 'all'): PublishedCounts {
  const { year, startMs } = chicagoMonthStart(now);
  const r = getDb().prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(s.featured = 1), 0) AS f, COALESCE(SUM(${OPEN_DRAFT}), 0) AS o,
      COALESCE(SUM((${EDITED_COND}) AND s.edited_at >= ?), 0) AS e, COALESCE(SUM(substr(s.date, 1, 4) = ?), 0) AS y ${PUB_FROM} WHERE s.status = 'live' AND s.draft = 0${kind === 'all' ? '' : ` AND ${PUB_KIND_SQL} = ?`}`).get(startMs, year, ...(kind === 'all' ? [] : [kind])) as Row;
  return { all: Number(r.n), featured: Number(r.f), openDraft: Number(r.o), editedThisMonth: Number(r.e), thisYear: Number(r.y), year };
}

/** Values for the filter menus: issues and years that at least one live story has. */
export function publishedFacets(): { issues: number[]; years: string[] } {
  const db = getDb();
  const issues = (db.prepare("SELECT DISTINCT newsletter_issue AS n FROM stories WHERE status = 'live' AND draft = 0 AND newsletter_issue IS NOT NULL ORDER BY n DESC").all() as { n: number }[]).map((r) => Number(r.n));
  const years = (db.prepare("SELECT DISTINCT substr(date, 1, 4) AS y FROM stories WHERE status = 'live' AND draft = 0 ORDER BY y DESC").all() as { y: string }[]).map((r) => String(r.y)).filter((y) => /^\d{4}$/.test(y));
  return { issues, years };
}

/** Live, non-draft items per content type: one grouped read-only query (the tabs and the Published cards). */
export function publishedKindCounts(): Record<PublishedKind, number> {
  const rows = getDb().prepare(`SELECT ${PUB_KIND_SQL} AS kind, COUNT(*) AS n FROM stories s WHERE s.status = 'live' AND s.draft = 0 GROUP BY 1`).all() as { kind: string; n: number }[];
  const out: Record<PublishedKind, number> = { all: 0, story: 0, announcement: 0, event: 0 };
  for (const r of rows) {
    const k = r.kind === 'announcement' || r.kind === 'event' ? r.kind : 'story';
    out[k] += Number(r.n);
    out.all += Number(r.n);
  }
  return out;
}

/**
 * Live items per section for one content type ('all' for every type), by membership: a story counts under its primary
 * section and under each additional section, once per section. Every section in site.ts is present, empty ones as 0.
 */
export function publishedSectionCounts(kind: PublishedKind = 'all'): Record<string, number> {
  const cond = `s.status = 'live' AND s.draft = 0${kind === 'all' ? '' : ` AND ${PUB_KIND_SQL} = ?`}`;
  const args = kind === 'all' ? [] : [kind, kind];
  const rows = getDb().prepare(`SELECT m.k AS k, COUNT(*) AS n FROM (
      SELECT s.id AS id, s.section AS k FROM stories s WHERE ${cond}
      UNION
      SELECT s.id AS id, je.value AS k FROM stories s, json_each(s.additional_sections) je WHERE ${cond}
    ) m GROUP BY m.k`).all(...args) as { k: string; n: number }[];
  const out: Record<string, number> = Object.fromEntries(SECTIONS.map((x) => [x.key, 0]));
  for (const r of rows) if (r.k in out) out[r.k] = Number(r.n);
  return out;
}
