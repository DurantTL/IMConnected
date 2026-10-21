// Story drafts: the rows in `drafts` / `draft_photos` and the uploaded photo files under DATA_DIR/uploads/.
// Submitter contact fields live here for signed-in editors to read. They are never logged or committed.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDb } from './db';
import { dataDir } from './db/db-core.mjs';
import { getSection, isValidArea } from './site';
import { validDate } from './storyfile';
import { ERRORS, type ErrorCode } from './messages';
import { DEFAULT_PHOTO_LAYOUT, isPhotoLayout, photoLayoutOrDefault, type PhotoLayout } from './photo-layouts';

export type DraftStatus = 'new' | 'in_review' | 'published' | 'rejected';
export type DraftSource = 'form' | 'studio' | 'editor' | 'agent';
export const STATUSES: DraftStatus[] = ['new', 'in_review', 'published', 'rejected'];
export const STATUS_LABEL: Record<DraftStatus, string> = { new: 'New', in_review: 'In review', published: 'Published', rejected: 'Rejected' };
export const SOURCE_LABEL: Record<DraftSource, string> = { form: 'Submit form', studio: 'Studio', editor: 'Editor', agent: 'AI agent' };

/** Rejected drafts keep their photos this long. */
export const REJECTED_PHOTO_DAYS = 30;
/** Largest text the save endpoint accepts per field (publishing enforces the real limits in LIMITS). */
export const FIELD_MAX = { title: 300, dek: 600, short: 200, body: 100_000 };

export interface DraftFields {
  title: string;
  dek: string;
  section: string;
  area: string;
  column: string;
  author: string;
  authorTitle: string;
  church: string;
  date: string;
  photoCredit: string;
  /** How the story page arranges the photos (src/lib/photo-layouts.ts). */
  photoLayout: PhotoLayout;
  featured: boolean;
  body: string;
}

export interface Draft extends DraftFields {
  id: number;
  status: DraftStatus;
  source: DraftSource;
  slug: string | null;
  publishedCommit: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  submitterPhone: string | null;
  submitterChurch: string | null;
  emailVerified: boolean;
  /** Source `agent` only: the original post's URL (http or https) and the agent's note to the editors. */
  sourceUrl: string | null;
  agentNote: string | null;
  rejectNote: string | null;
  rejectedAt: number | null;
  createdAt: number;
  updatedAt: number;
  updatedByName: string | null;
  publishedAt: number | null;
  publishedByName: string | null;
  /** Studio published over this story while this draft had unpublished edits (ms), else null. */
  studioOverwroteAt: number | null;
  /** When an editor unpublished the story (the draft keeps its slug; cleared by a publish) */
  unpublishedAt: number | null;
  /** True when this draft's story is live on the site (published and not unpublished since). */
  live: boolean;
}

export interface DraftPhoto {
  id: number;
  draftId: number;
  path: string | null;
  url: string | null;
  ext: string | null;
  alt: string;
  caption: string;
  position: number;
}

export interface DraftListItem {
  id: number;
  status: DraftStatus;
  source: DraftSource;
  title: string;
  section: string;
  slug: string | null;
  church: string;
  author: string;
  emailVerified: boolean;
  photoCount: number;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const sn = (v: unknown) => (typeof v === 'string' ? v : null);
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));

/** Shown as the publisher of a story that Studio published. */
export const STUDIO_NAME = 'IMConnected Studio';

const DRAFT_SELECT = `SELECT d.*, u.name AS updated_by_name, p.name AS published_by_name
  FROM drafts d LEFT JOIN users u ON u.id = d.updated_by LEFT JOIN users p ON p.id = d.published_by`;

function toDraft(r: Row): Draft {
  return {
    id: n(r.id),
    status: r.status as DraftStatus,
    source: r.source as DraftSource,
    title: s(r.title),
    dek: s(r.dek),
    section: s(r.section),
    area: s(r.area),
    column: s(r.story_column),
    author: s(r.author),
    authorTitle: s(r.author_title),
    church: s(r.church),
    date: s(r.date),
    photoCredit: s(r.photo_credit),
    photoLayout: photoLayoutOrDefault(r.photo_layout),
    featured: n(r.featured) === 1,
    body: s(r.body),
    slug: sn(r.slug),
    publishedCommit: sn(r.published_commit),
    submitterName: sn(r.submitter_name),
    submitterEmail: sn(r.submitter_email),
    submitterPhone: sn(r.submitter_phone),
    submitterChurch: sn(r.submitter_church),
    emailVerified: n(r.email_verified) === 1,
    sourceUrl: sn(r.source_url),
    agentNote: sn(r.agent_note),
    rejectNote: sn(r.reject_note),
    rejectedAt: r.rejected_at == null ? null : n(r.rejected_at),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    updatedByName: sn(r.updated_by_name),
    publishedAt: r.published_at == null ? null : n(r.published_at),
    // A Studio publish has no editor (published_by is NULL) and sets published_via_studio.
    publishedByName: n(r.published_via_studio) === 1 ? STUDIO_NAME : sn(r.published_by_name),
    studioOverwroteAt: r.studio_overwrote_at == null ? null : n(r.studio_overwrote_at),
    unpublishedAt: r.unpublished_at == null ? null : n(r.unpublished_at),
    live: r.published_commit != null && r.slug != null && r.unpublished_at == null,
  };
}

function toPhoto(r: Row): DraftPhoto {
  return { id: n(r.id), draftId: n(r.draft_id), path: sn(r.path), url: sn(r.url), ext: sn(r.ext), alt: s(r.alt), caption: s(r.caption), position: n(r.position) };
}

/** Run `fn` inside one write transaction (BEGIN IMMEDIATE ... COMMIT; rolled back if it throws). */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);

export function emptyFields(over: Partial<DraftFields> = {}): DraftFields {
  return { title: '', dek: '', section: 'news', area: 'conference', column: '', author: '', authorTitle: '', church: '', date: todayUtc(), photoCredit: '', photoLayout: DEFAULT_PHOTO_LAYOUT, featured: false, body: '', ...over };
}

export interface NewDraft {
  source: DraftSource;
  userId?: number | null;
  status?: DraftStatus;
  fields?: Partial<DraftFields>;
  slug?: string | null;
  submitter?: { name?: string; email?: string; phone?: string; church?: string };
  emailVerified?: boolean;
  /** Source `agent` only. */
  sourceUrl?: string | null;
  agentNote?: string | null;
}

/** Create a draft (also the entry point for the submit form and Studio in the next issue). */
export function createDraft(opts: NewDraft): number {
  const f = emptyFields(opts.fields);
  const now = Date.now();
  const status = opts.status ?? (opts.source === 'editor' ? 'in_review' : 'new');
  const sub = opts.submitter ?? {};
  const r = getDb()
    .prepare(
      `INSERT INTO drafts (status, source, title, dek, section, area, story_column, author, author_title, church, date, photo_credit, photo_layout, featured, body,
         slug, submitter_name, submitter_email, submitter_phone, submitter_church, email_verified, created_at, created_by, updated_at, updated_by, source_url, agent_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      status, opts.source, f.title, f.dek, f.section, f.area, f.column, f.author, f.authorTitle, f.church, f.date, f.photoCredit, f.photoLayout, f.featured ? 1 : 0, f.body,
      opts.slug ?? null, sub.name ?? null, sub.email ?? null, sub.phone ?? null, sub.church ?? null, opts.emailVerified ? 1 : 0,
      now, opts.userId ?? null, now, opts.userId ?? null, opts.sourceUrl ?? null, opts.agentNote ?? null,
    );
  return Number(r.lastInsertRowid);
}

export function getDraft(id: number): Draft | null {
  const r = getDb().prepare(`${DRAFT_SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
  return r ? toDraft(r) : null;
}

export function getDraftBySlug(slug: string): Draft | null {
  const r = getDb().prepare(`${DRAFT_SELECT} WHERE d.slug = ?`).get(slug) as Row | undefined;
  return r ? toDraft(r) : null;
}

/** Drafts whose story is live (including ones being edited again). */
export function listLiveDrafts(): Draft[] {
  return (getDb().prepare(`${DRAFT_SELECT} WHERE d.slug IS NOT NULL AND d.published_commit IS NOT NULL AND d.unpublished_at IS NULL ORDER BY d.published_at DESC`).all() as Row[]).map(toDraft);
}

/** Slugs the editor has unpublished (they may still be in the last site build). */
export function listUnpublishedSlugs(): Set<string> {
  return new Set((getDb().prepare('SELECT slug FROM drafts WHERE slug IS NOT NULL AND unpublished_at IS NOT NULL').all() as { slug: string }[]).map((r) => r.slug));
}

export type StatusFilter = DraftStatus | 'open' | 'all';
export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'open', label: 'New and in review' },
  { value: 'new', label: 'New' },
  { value: 'in_review', label: 'In review' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'published', label: 'Published' },
  { value: 'all', label: 'All' },
];

export function listDrafts(filter: { status: StatusFilter; section?: string; source?: DraftSource }): DraftListItem[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.status === 'open') where.push("d.status IN ('new', 'in_review')");
  else if (filter.status !== 'all') {
    where.push('d.status = ?');
    args.push(filter.status);
  }
  if (filter.section) {
    where.push('d.section = ?');
    args.push(filter.section);
  }
  if (filter.source) {
    where.push('d.source = ?');
    args.push(filter.source);
  }
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.status, d.source, d.title, d.section, d.slug, d.church, d.author, d.submitter_church, d.email_verified, d.created_at, d.updated_at,
         (SELECT COUNT(*) FROM draft_photos ph WHERE ph.draft_id = d.id) AS photo_count
       FROM drafts d ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.created_at DESC, d.id DESC LIMIT 500`,
    )
    .all(...args) as Row[];
  return rows.map((r) => ({
    id: n(r.id),
    status: r.status as DraftStatus,
    source: r.source as DraftSource,
    title: s(r.title),
    section: s(r.section),
    slug: sn(r.slug),
    church: s(r.submitter_church) || s(r.church),
    author: s(r.author),
    emailVerified: n(r.email_verified) === 1,
    photoCount: n(r.photo_count),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  }));
}

export function listPhotos(draftId: number): DraftPhoto[] {
  return (getDb().prepare('SELECT * FROM draft_photos WHERE draft_id = ? ORDER BY position, id').all(draftId) as Row[]).map(toPhoto);
}

export function getPhoto(id: number): DraftPhoto | null {
  const r = getDb().prepare('SELECT * FROM draft_photos WHERE id = ?').get(id) as Row | undefined;
  return r ? toPhoto(r) : null;
}

/** A draft can be edited while it is new or in review. */
export const isEditable = (d: Pick<Draft, 'status'>) => d.status === 'new' || d.status === 'in_review';

/**
 * Take the optimistic lock: succeeds only when the draft's updated_at is still `expected`, and moves it
 * forward (always strictly, even within one millisecond). Call inside tx().
 */
function takeVersion(id: number, expected: number, userId: number, extra = ''): number | null {
  // `extra` is a fixed SQL fragment with no bound values.
  const next = Math.max(Date.now(), expected + 1);
  const r = getDb()
    .prepare(`UPDATE drafts SET updated_at = ?, updated_by = ?${extra ? ', ' + extra : ''} WHERE id = ? AND updated_at = ? AND status IN ('new', 'in_review')`)
    .run(next, userId, id, expected);
  return Number(r.changes) === 1 ? next : null;
}

export type Failure = { ok: false; reason: 'conflict' | 'locked' | 'invalid'; code: ErrorCode; message: string };
const fail = (reason: Failure['reason'], code: ErrorCode): Failure => ({ ok: false, reason, code, message: ERRORS[code] });
export type SaveResult = { ok: true; updatedAt: number } | Failure;

const CONFLICT = fail('conflict', 'conflict');

/** Validation common to saving (lenient) — publishing enforces the full rules. */
export function checkFieldValues(f: DraftFields): ErrorCode | null {
  if (!getSection(f.section)) return 'bad_section';
  if (f.date && !validDate(f.date)) return 'bad_date';
  if (!isPhotoLayout(f.photoLayout)) return 'bad_layout';
  return null;
}

export function saveDraft(id: number, expected: number, f: DraftFields, photoAlts: Map<number, string>, userId: number): SaveResult {
  const bad = checkFieldValues(f);
  if (bad) return fail('invalid', bad);
  const area = isValidArea(f.section, f.area) ? f.area : '';
  return tx(() => {
    const cur = getDb().prepare('SELECT status FROM drafts WHERE id = ?').get(id) as { status: DraftStatus } | undefined;
    if (!cur) return fail('invalid', 'draft_gone') as SaveResult;
    if (!isEditable({ status: cur.status })) return fail('locked', 'closed') as SaveResult;
    const v = takeVersion(id, expected, userId, "status = 'in_review'");
    if (v === null) return CONFLICT;
    getDb()
      .prepare('UPDATE drafts SET title = ?, dek = ?, section = ?, area = ?, story_column = ?, author = ?, author_title = ?, church = ?, date = ?, photo_credit = ?, photo_layout = ?, featured = ?, body = ? WHERE id = ?')
      .run(f.title, f.dek, f.section, area, f.section === 'columns' ? f.column : '', f.author, f.authorTitle, f.church, f.date, f.photoCredit, f.photoLayout, f.featured ? 1 : 0, f.body, id);
    const upd = getDb().prepare('UPDATE draft_photos SET alt = ? WHERE id = ? AND draft_id = ?');
    for (const [pid, alt] of photoAlts) upd.run(alt, pid, id);
    return { ok: true, updatedAt: v } as SaveResult;
  });
}

export type OpResult = { ok: true; updatedAt: number } | Failure;

/** Max photos a draft may hold. */
export function photoCount(draftId: number): number {
  return Number((getDb().prepare('SELECT COUNT(*) AS c FROM draft_photos WHERE draft_id = ?').get(draftId) as { c: number }).c);
}

export const uploadsRoot = () => path.join(dataDir(), 'uploads');

/** Resolve a stored relative upload path to a file, or null when it would leave the uploads folder. */
export function uploadFile(rel: string): string | null {
  const root = path.resolve(uploadsRoot());
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

/** Write an upload to disk under a random name; returns the relative path to store. */
export function writeUpload(draftId: number, bytes: Uint8Array, ext: string): string {
  const rel = `${draftId}/${randomBytes(16).toString('hex')}.${ext}`;
  const full = uploadFile(rel)!;
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  fs.writeFileSync(full, bytes, { mode: 0o600 });
  return rel;
}

function removeUploadFiles(rels: (string | null)[]): void {
  for (const rel of rels) {
    const full = rel ? uploadFile(rel) : null;
    if (full) fs.rmSync(full, { force: true });
  }
}

/** Add uploaded photos (already validated and written to disk). On a conflict the files are removed again. */
export function addUploadedPhotos(draftId: number, expected: number, userId: number, files: { rel: string; ext: string }[]): OpResult {
  const res = tx((): OpResult => {
    const v = takeVersion(draftId, expected, userId);
    if (v === null) return lockFailure(draftId);
    const start = Number((getDb().prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM draft_photos WHERE draft_id = ?').get(draftId) as { p: number }).p);
    const ins = getDb().prepare('INSERT INTO draft_photos (draft_id, path, ext, position, created_at) VALUES (?, ?, ?, ?, ?)');
    files.forEach((f, i) => ins.run(draftId, f.rel, f.ext, start + i, Date.now()));
    return { ok: true, updatedAt: v };
  });
  if (!res.ok) removeUploadFiles(files.map((f) => f.rel));
  return res;
}

function lockFailure(draftId: number): OpResult {
  const cur = getDb().prepare('SELECT status FROM drafts WHERE id = ?').get(draftId) as { status: DraftStatus } | undefined;
  if (cur && !isEditable({ status: cur.status })) return fail('locked', 'closed');
  return CONFLICT;
}

/** Reorder, set the lead image, or delete one photo, under the same version check as a save. */
export function changePhoto(draftId: number, expected: number, userId: number, op: 'up' | 'down' | 'lead' | 'delete', photoId: number): OpResult {
  let removed: string | null = null;
  const res = tx((): OpResult => {
    const photos = listPhotos(draftId);
    const i = photos.findIndex((p) => p.id === photoId);
    if (i === -1) return fail('invalid', 'photo_gone');
    const v = takeVersion(draftId, expected, userId);
    if (v === null) return lockFailure(draftId);
    const order = photos.map((p) => p.id);
    if (op === 'delete') {
      order.splice(i, 1);
      removed = photos[i].path;
      getDb().prepare('DELETE FROM draft_photos WHERE id = ?').run(photoId);
    } else if (op === 'lead') {
      order.splice(i, 1);
      order.unshift(photoId);
    } else {
      const j = op === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < order.length) [order[i], order[j]] = [order[j], order[i]];
    }
    const set = getDb().prepare('UPDATE draft_photos SET position = ? WHERE id = ?');
    order.forEach((id, pos) => set.run(pos, id));
    return { ok: true, updatedAt: v };
  });
  if (res.ok && removed) removeUploadFiles([removed]);
  return res;
}

/** Replace a draft's photos (used when a published story is loaded into the editor). Call inside tx(). */
export function replacePhotos(draftId: number, photos: { url: string; alt: string; caption: string }[]): string[] {
  const old = listPhotos(draftId).map((p) => p.path).filter((p): p is string => !!p);
  getDb().prepare('DELETE FROM draft_photos WHERE draft_id = ?').run(draftId);
  const ins = getDb().prepare('INSERT INTO draft_photos (draft_id, url, alt, caption, position, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  photos.forEach((p, i) => ins.run(draftId, p.url, p.alt, p.caption, i, Date.now()));
  return old;
}

export { removeUploadFiles };

/** Mark a draft rejected (optional internal note). Works from new or in_review. */
export function rejectDraft(id: number, expected: number, userId: number, note: string): OpResult {
  return tx((): OpResult => {
    const now = Date.now();
    const r = getDb()
      .prepare("UPDATE drafts SET status = 'rejected', reject_note = ?, rejected_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ? AND status IN ('new', 'in_review')")
      .run(note || null, now, Math.max(now, expected + 1), userId, id, expected);
    return Number(r.changes) === 1 ? { ok: true, updatedAt: Math.max(now, expected + 1) } : lockFailure(id);
  });
}

/** Restoring a rejected draft returns it to in_review. */
export function restoreDraft(id: number, expected: number, userId: number): OpResult {
  return tx((): OpResult => {
    const now = Date.now();
    const next = Math.max(now, expected + 1);
    const r = getDb()
      .prepare("UPDATE drafts SET status = 'in_review', rejected_at = NULL, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ? AND status = 'rejected'")
      .run(next, userId, id, expected);
    return Number(r.changes) === 1 ? { ok: true, updatedAt: next } : CONFLICT;
  });
}

/** The marker stored in drafts.published_commit for a story published to the database (the column predates the move off git). */
export const DB_PUBLISH_MARKER = 'db';

/**
 * Publish the draft row: under the version check (updated_at must still be `expected`, the draft still new / in
 * review) mark it published, take the slug (the unique index refuses a slug another draft holds) and move the
 * version forward. Call inside the same transaction that writes the story, so both happen or neither does.
 * Throws only on a database error; a lost race is returned as a Failure.
 */
export function publishDraftRow(id: number, expected: number, info: { slug: string; userId: number }): { ok: true; updatedAt: number } | Failure {
  const now = Date.now();
  const next = Math.max(now, expected + 1);
  try {
    const r = getDb()
      .prepare("UPDATE drafts SET status = 'published', slug = ?, published_commit = ?, published_at = ?, published_by = ?, updated_at = ?, updated_by = ?, rejected_at = NULL, unpublished_at = NULL, studio_overwrote_at = NULL, published_via_studio = 0 WHERE id = ? AND updated_at = ? AND status IN ('new', 'in_review')")
      .run(info.slug, DB_PUBLISH_MARKER, now, info.userId, next, info.userId, id, expected);
    return Number(r.changes) === 1 ? { ok: true, updatedAt: next } : (lockFailure(id) as Failure);
  } catch (err) {
    if (/UNIQUE/i.test(err instanceof Error ? err.message : '')) return fail('conflict', 'slug_taken');
    throw err;
  }
}

/**
 * After a publish the photos live in the database's media folder. Turn the published uploads into site images (so the draft
 * still shows them) and delete the uploaded files and folder. `published` maps photo id -> public path.
 */
export function retireUploads(draftId: number, published: Map<number, string>): void {
  const rows = listPhotos(draftId).filter((p) => p.path && published.has(p.id));
  if (!rows.length) return;
  tx(() => {
    const upd = getDb().prepare('UPDATE draft_photos SET url = ?, path = NULL, ext = NULL WHERE id = ?');
    for (const p of rows) upd.run(published.get(p.id)!, p.id);
  });
  removeUploadFiles(rows.map((p) => p.path));
  const dir = uploadFile(String(draftId));
  if (dir) {
    try {
      fs.rmdirSync(dir); // only when empty
    } catch {
      /* other uploads remain */
    }
  }
}

/** After an unpublish the story's draft goes back to in review, keeping its slug so publishing again restores it. */
export function markUnpublished(slug: string, userId: number): void {
  const now = Date.now();
  getDb()
    .prepare("UPDATE drafts SET status = CASE WHEN status = 'published' THEN 'in_review' ELSE status END, unpublished_at = ?, updated_at = MAX(?, updated_at + 1), updated_by = ? WHERE slug = ?")
    .run(now, now, userId, slug);
}

let lastCleanup = 0;
/**
 * Deletes the photos of drafts rejected more than 30 days ago (the draft text stays). Cheap and
 * idempotent; called when the inbox opens, at most once a day per server process.
 */
export function cleanupRejectedPhotos(now = Date.now(), force = false): number {
  if (!force && now - lastCleanup < 24 * 60 * 60 * 1000) return 0;
  lastCleanup = now;
  const cutoff = now - REJECTED_PHOTO_DAYS * 24 * 60 * 60 * 1000;
  const photos = getDb()
    .prepare("SELECT ph.id, ph.path FROM draft_photos ph JOIN drafts d ON d.id = ph.draft_id WHERE d.status = 'rejected' AND d.rejected_at IS NOT NULL AND d.rejected_at < ?")
    .all(cutoff) as { id: number; path: string | null }[];
  if (!photos.length) return 0;
  removeUploadFiles(photos.map((p) => p.path));
  const del = getDb().prepare('DELETE FROM draft_photos WHERE id = ?');
  for (const p of photos) del.run(p.id);
  return photos.length;
}

/** Put a live story's current content into an existing draft (a draft linked to that slug) and reopen it. */
export function reloadDraftFromStory(id: number, userId: number, f: DraftFields, photos: { url: string; alt: string; caption: string }[]): void {
  let old: string[] = [];
  tx(() => {
    const now = Date.now();
    getDb()
      .prepare(
        "UPDATE drafts SET status = 'in_review', rejected_at = NULL, studio_overwrote_at = NULL, title = ?, dek = ?, section = ?, area = ?, story_column = ?, author = ?, author_title = ?, church = ?, date = ?, photo_credit = ?, photo_layout = ?, featured = ?, body = ?, updated_at = MAX(?, updated_at + 1), updated_by = ? WHERE id = ?",
      )
      .run(f.title, f.dek, f.section, f.area, f.column, f.author, f.authorTitle, f.church, f.date, f.photoCredit, f.photoLayout, f.featured ? 1 : 0, f.body, now, userId, id);
    old = replacePhotos(id, photos);
  });
  removeUploadFiles(old);
}

/** An editor draft for a live story: its text and photos, linked to the story's slug. */
export function createDraftFromStory(userId: number, slug: string, f: DraftFields, photos: { url: string; alt: string; caption: string }[]): number {
  return tx(() => {
    const id = createDraft({ source: 'editor', userId, fields: f, slug });
    replacePhotos(id, photos);
    return id;
  });
}

const AUDIT_SAVE_EVERY_MS = 10 * 60 * 1000;
/** True when this editor has not had a draft.save audit entry for this draft in the last 10 minutes. */
export function saveAuditDue(userId: number, draftId: number): boolean {
  const r = getDb()
    .prepare('SELECT MAX(at) AS at FROM audit_log WHERE action = ? AND user_id = ? AND target = ?')
    .get('draft.save', userId, `draft:${draftId}`) as { at: number | null };
  return !r.at || Date.now() - r.at > AUDIT_SAVE_EVERY_MS;
}

/** New plus in-review drafts (the badge on the Drafts nav item). */
export function countOpenDrafts(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS c FROM drafts WHERE status IN ('new', 'in_review')").get() as { c: number }).c);
}

export interface SubmissionInput {
  title: string;
  dek: string;
  section: string;
  area?: string;
  /** Already safe Markdown (textToMarkdown). */
  body: string;
  church: string;
  photoCredit: string;
  caption: string;
  submitter: { name: string; email: string; phone: string; church: string };
  /** Validated image bytes with their sniffed extension. */
  photos: { bytes: Uint8Array; ext: string }[];
}

/**
 * A public submission becomes a `new` draft (source form), with its photos saved under DATA_DIR/uploads.
 * All or nothing: if anything fails the row and the files are removed again and the error is rethrown.
 */
export function createSubmissionDraft(sub: SubmissionInput): number {
  const written: string[] = [];
  try {
    return tx(() => {
      const id = createDraft({
        source: 'form',
        status: 'new',
        fields: { title: sub.title, dek: sub.dek, section: sub.section, area: sub.area ?? '', author: sub.submitter.name, church: sub.church, photoCredit: sub.photoCredit, body: sub.body },
        submitter: sub.submitter,
      });
      const ins = getDb().prepare('INSERT INTO draft_photos (draft_id, path, ext, alt, position, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      sub.photos.forEach((p, i) => {
        const rel = writeUpload(id, p.bytes, p.ext);
        written.push(rel);
        ins.run(id, rel, p.ext, i === 0 ? sub.caption : '', i, Date.now());
      });
      return id;
    });
  } catch (err) {
    removeUploadFiles(written);
    throw err;
  }
}

/** The submitter confirmed their address. Does not move the draft's version (an editor may be mid-edit). */
export function markEmailVerified(draftId: number): boolean {
  const r = getDb().prepare('UPDATE drafts SET email_verified = 1 WHERE id = ? AND source = ? AND submitter_email IS NOT NULL').run(draftId, 'form');
  return Number(r.changes) === 1;
}

export interface StudioStory {
  slug: string;
  title: string;
  dek: string;
  section: string;
  area?: string;
  author: string;
  date: string;
  photoCredit: string;
  photoLayout: PhotoLayout;
  /** The Markdown that was published. */
  body: string;
  photos: { url: string; alt: string; caption: string }[];
}

/** Recent live stories for the inbox overview: only the columns it shows. */
export function listRecentPublished(limit: number): { slug: string; title: string; publishedAt: number | null; publishedByName: string | null }[] {
  const rows = getDb()
    .prepare(
      `SELECT d.slug, d.title, d.published_at, d.published_via_studio, u.name AS by_name FROM drafts d LEFT JOIN users u ON u.id = d.published_by
       WHERE d.slug IS NOT NULL AND d.published_commit IS NOT NULL AND d.unpublished_at IS NULL ORDER BY d.published_at DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map((r) => ({
    slug: s(r.slug),
    title: s(r.title),
    publishedAt: r.published_at == null ? null : n(r.published_at),
    publishedByName: n(r.published_via_studio) === 1 ? STUDIO_NAME : sn(r.by_name),
  }));
}

/**
 * Record Studio publishes as `published` drafts (source studio, published_by NULL). A slug that already has a
 * draft is updated in place only when that draft is a Studio one or is closed (published / rejected). A linked
 * draft that is still new / in review (it may hold an editor's unsaved-to-site work, or be mid-publish with the
 * slug reserved) is never touched except for the live markers, and gets a notice. Call it INSIDE the transaction that
 * writes the stories (no transaction of its own); delete `oldUploads` (a rejected draft's own files) after the commit.
 */
export function recordStudioPublish(stories: StudioStory[], commit: string = DB_PUBLISH_MARKER): { ids: number[]; overwrote: number[]; oldUploads: string[] } {
  const ids: number[] = [];
  const overwrote: number[] = [];
  let oldUploads: string[] = [];
  {
    const now = Date.now();
    for (const st of stories) {
      const fields = emptyFields({ title: st.title, dek: st.dek, section: st.section, area: st.area ?? '', author: st.author, date: st.date, photoCredit: st.photoCredit, photoLayout: st.photoLayout, body: st.body });
      const cur = getDraftBySlug(st.slug);
      let id: number;
      if (cur && isEditable(cur)) {
        id = cur.id;
        getDb().prepare('UPDATE drafts SET published_commit = ?, published_at = ?, published_by = NULL, published_via_studio = 1, unpublished_at = NULL, studio_overwrote_at = ? WHERE id = ?').run(commit, now, now, id);
        overwrote.push(id);
      } else {
        if (cur) {
          id = cur.id;
          getDb()
            .prepare(
              "UPDATE drafts SET status = 'published', title = ?, dek = ?, section = ?, area = ?, story_column = '', author = ?, author_title = '', church = '', date = ?, photo_credit = ?, photo_layout = ?, featured = 0, body = ?, published_commit = ?, published_at = ?, published_by = NULL, published_via_studio = 1, unpublished_at = NULL, rejected_at = NULL, studio_overwrote_at = NULL, updated_at = MAX(?, updated_at + 1), updated_by = NULL WHERE id = ?",
            )
            .run(fields.title, fields.dek, fields.section, fields.area, fields.author, fields.date, fields.photoCredit, fields.photoLayout, fields.body, commit, now, now, id);
        } else {
          id = createDraft({ source: 'studio', status: 'published', fields, slug: st.slug });
          getDb().prepare('UPDATE drafts SET published_commit = ?, published_at = ?, published_via_studio = 1 WHERE id = ?').run(commit, now, id);
        }
        // Photos: only a Studio draft's own are replaced (it holds no uploads); another draft's uploaded files are never deleted.
        // A rejected draft may still hold its uploads: they are replaced and the files deleted once the commit below succeeds.
        const keepsUploads = cur && cur.source !== 'studio' && cur.status !== 'rejected' && listPhotos(id).some((p) => p.path);
        if (!keepsUploads) oldUploads = oldUploads.concat(replacePhotos(id, st.photos));
      }
      ids.push(id);
    }
  }
  return { ids, overwrote, oldUploads };
}

export interface AgentDraftInput {
  title: string;
  dek: string;
  /** Already safe Markdown. */
  body: string;
  section: string;
  area: string;
  author: string;
  church: string;
  /** '' = today on create, unchanged on update. */
  date: string;
  sourceUrl: string | null;
  note: string;
  /** null = not sent: a new draft gets the default, an updated one keeps its layout. */
  photoLayout: PhotoLayout | null;
  /** null = leave an updated draft's photos alone. */
  photos: { bytes: Uint8Array; ext: string; alt: string }[] | null;
}

export type AgentUpsertResult = { ok: true; id: number; status: 'created' | 'updated' } | { ok: false; id: number };

/**
 * An AI-agent story becomes a `new` draft (source agent, no author account). The same `sourceUrl` finds the same
 * draft again, and it is updated only while no editor has touched it: still `new` and `updated_by` still NULL
 * (every editor save, photo change or publish step sets it). Otherwise `{ ok: false }` and nothing changes.
 * All or nothing, like createSubmissionDraft: on any failure the files written here are removed again.
 */
export function upsertAgentDraft(input: AgentDraftInput): AgentUpsertResult {
  const written: string[] = [];
  let oldFiles: string[] = [];
  try {
    const res = tx((): AgentUpsertResult => {
      const db = getDb();
      const existing = input.sourceUrl
        ? (db.prepare("SELECT id, status, updated_by FROM drafts WHERE source = 'agent' AND source_url = ?").get(input.sourceUrl) as { id: number; status: string; updated_by: number | null } | undefined)
        : undefined;
      let id: number;
      let status: 'created' | 'updated';
      if (existing) {
        if (existing.status !== 'new' || existing.updated_by !== null) return { ok: false, id: Number(existing.id) };
        id = Number(existing.id);
        status = 'updated';
        const now = Date.now();
        const r = db
          .prepare(
            `UPDATE drafts SET title = ?, dek = ?, body = ?, section = ?, area = ?, author = ?, church = ?, agent_note = ?, photo_layout = COALESCE(?, photo_layout),
               date = CASE WHEN ? = '' THEN date ELSE ? END, updated_at = MAX(?, updated_at + 1)
             WHERE id = ? AND status = 'new' AND updated_by IS NULL`,
          )
          .run(input.title, input.dek, input.body, input.section, input.area, input.author, input.church, input.note || null, input.photoLayout, input.date, input.date, now, id);
        if (Number(r.changes) !== 1) return { ok: false, id };
        if (input.photos) {
          oldFiles = listPhotos(id).map((p) => p.path).filter((p): p is string => !!p);
          db.prepare('DELETE FROM draft_photos WHERE draft_id = ?').run(id);
        }
      } else {
        status = 'created';
        id = createDraft({
          source: 'agent',
          status: 'new',
          fields: { title: input.title, dek: input.dek, section: input.section, area: input.area, author: input.author, church: input.church, body: input.body, ...(input.photoLayout ? { photoLayout: input.photoLayout } : {}), ...(input.date ? { date: input.date } : {}) },
          sourceUrl: input.sourceUrl,
          agentNote: input.note || null,
        });
      }
      if (input.photos) {
        const ins = db.prepare('INSERT INTO draft_photos (draft_id, path, ext, alt, position, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        input.photos.forEach((p, i) => {
          const rel = writeUpload(id, p.bytes, p.ext);
          written.push(rel);
          ins.run(id, rel, p.ext, p.alt, i, Date.now());
        });
      }
      return { ok: true, id, status };
    });
    if (res.ok) removeUploadFiles(oldFiles);
    else removeUploadFiles(written);
    return res;
  } catch (err) {
    removeUploadFiles(written);
    throw err;
  }
}

/** The newest drafts still waiting for an editor (new or in review), for the Studio story list. */
export function listOpenDraftsNewestFirst(limit: number, section?: string): { draft: Draft; photos: DraftPhoto[] }[] {
  const rows = getDb()
    .prepare(`SELECT id FROM drafts WHERE status IN ('new', 'in_review')${section ? ' AND section = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...(section ? [section, limit] : [limit])) as { id: number }[];
  const out: { draft: Draft; photos: DraftPhoto[] }[] = [];
  for (const r of rows) {
    const draft = getDraft(Number(r.id));
    if (draft) out.push({ draft, photos: listPhotos(draft.id) });
  }
  return out;
}
