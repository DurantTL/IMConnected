// Story drafts: the rows in `drafts` / `draft_photos` and the uploaded photo files under DATA_DIR/uploads/.
// Submitter contact fields live here for signed-in editors to read. They are never logged or committed.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDb } from './db';
import { dataDir } from './db/db-core.mjs';
import { getSection, isValidArea } from './site';
import { ERRORS, type ErrorCode } from './messages';

export type DraftStatus = 'new' | 'in_review' | 'published' | 'rejected';
export type DraftSource = 'form' | 'studio' | 'editor';
export const STATUSES: DraftStatus[] = ['new', 'in_review', 'published', 'rejected'];
export const STATUS_LABEL: Record<DraftStatus, string> = { new: 'New', in_review: 'In review', published: 'Published', rejected: 'Rejected' };
export const SOURCE_LABEL: Record<DraftSource, string> = { form: 'Submit form', studio: 'Studio', editor: 'Editor' };

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
  rejectNote: string | null;
  rejectedAt: number | null;
  createdAt: number;
  updatedAt: number;
  updatedByName: string | null;
  publishedAt: number | null;
  publishedByName: string | null;
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
    featured: n(r.featured) === 1,
    body: s(r.body),
    slug: sn(r.slug),
    publishedCommit: sn(r.published_commit),
    submitterName: sn(r.submitter_name),
    submitterEmail: sn(r.submitter_email),
    submitterPhone: sn(r.submitter_phone),
    submitterChurch: sn(r.submitter_church),
    emailVerified: n(r.email_verified) === 1,
    rejectNote: sn(r.reject_note),
    rejectedAt: r.rejected_at == null ? null : n(r.rejected_at),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    updatedByName: sn(r.updated_by_name),
    publishedAt: r.published_at == null ? null : n(r.published_at),
    publishedByName: sn(r.published_by_name),
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
  return { title: '', dek: '', section: 'news', area: 'conference', column: '', author: '', authorTitle: '', church: '', date: todayUtc(), photoCredit: '', featured: false, body: '', ...over };
}

export interface NewDraft {
  source: DraftSource;
  userId?: number | null;
  status?: DraftStatus;
  fields?: Partial<DraftFields>;
  slug?: string | null;
  submitter?: { name?: string; email?: string; phone?: string; church?: string };
  emailVerified?: boolean;
}

/** Create a draft (also the entry point for the submit form and Studio in the next issue). */
export function createDraft(opts: NewDraft): number {
  const f = emptyFields(opts.fields);
  const now = Date.now();
  const status = opts.status ?? (opts.source === 'editor' ? 'in_review' : 'new');
  const sub = opts.submitter ?? {};
  const r = getDb()
    .prepare(
      `INSERT INTO drafts (status, source, title, dek, section, area, story_column, author, author_title, church, date, photo_credit, featured, body,
         slug, submitter_name, submitter_email, submitter_phone, submitter_church, email_verified, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      status, opts.source, f.title, f.dek, f.section, f.area, f.column, f.author, f.authorTitle, f.church, f.date, f.photoCredit, f.featured ? 1 : 0, f.body,
      opts.slug ?? null, sub.name ?? null, sub.email ?? null, sub.phone ?? null, sub.church ?? null, opts.emailVerified ? 1 : 0,
      now, opts.userId ?? null, now, opts.userId ?? null,
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

export function listDrafts(filter: { status: StatusFilter; section?: string }): DraftListItem[] {
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
  if (f.date && !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return 'bad_date';
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
      .prepare('UPDATE drafts SET title = ?, dek = ?, section = ?, area = ?, story_column = ?, author = ?, author_title = ?, church = ?, date = ?, photo_credit = ?, featured = ?, body = ? WHERE id = ?')
      .run(f.title, f.dek, f.section, area, f.section === 'columns' ? f.column : '', f.author, f.authorTitle, f.church, f.date, f.photoCredit, f.featured ? 1 : 0, f.body, id);
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

/**
 * Step 1 of publishing, before anything is committed: take the draft's lock (so saves made from the
 * page the editor is looking at now get a conflict instead of being lost) and reserve the slug (the
 * unique index refuses a slug another draft holds). Returns the new version, or why it failed.
 */
export function beginPublish(id: number, expected: number, userId: number, slug: string): { ok: true; updatedAt: number } | Failure {
  try {
    return tx(() => {
      const next = Math.max(Date.now(), expected + 1);
      const r = getDb()
        .prepare("UPDATE drafts SET updated_at = ?, updated_by = ?, slug = ? WHERE id = ? AND updated_at = ? AND status IN ('new', 'in_review')")
        .run(next, userId, slug, id, expected);
      return Number(r.changes) === 1 ? { ok: true as const, updatedAt: next } : lockFailure(id);
    }) as { ok: true; updatedAt: number } | Failure;
  } catch (err) {
    if (/UNIQUE/i.test(err instanceof Error ? err.message : '')) return fail('conflict', 'slug_taken');
    throw err;
  }
}

/** The commit failed: give back a slug this publish reserved (a draft that was never live). */
export function releaseSlug(id: number, slug: string): void {
  getDb().prepare('UPDATE drafts SET slug = NULL WHERE id = ? AND slug = ? AND published_commit IS NULL').run(id, slug);
}

/**
 * Step 2, after the commit succeeded. `lockedAt` is the version beginPublish returned. If the draft was
 * saved since (someone reloaded and edited while the commit ran), the commit and slug are still recorded
 * and the story is live, but the draft stays in review and `stale` is true: the newer edits are not live.
 */
export function markPublished(id: number, info: { slug: string; commit: string; userId: number; lockedAt: number }): { stale: boolean } {
  const now = Date.now();
  const r = getDb()
    .prepare("UPDATE drafts SET status = 'published', slug = ?, published_commit = ?, published_at = ?, published_by = ?, updated_at = ?, updated_by = ?, rejected_at = NULL, unpublished_at = NULL WHERE id = ? AND updated_at = ? AND status IN ('new', 'in_review')")
    .run(info.slug, info.commit, now, info.userId, Math.max(now, info.lockedAt + 1), info.userId, id, info.lockedAt);
  if (Number(r.changes) === 1) return { stale: false };
  getDb()
    .prepare('UPDATE drafts SET slug = ?, published_commit = ?, published_at = ?, published_by = ?, unpublished_at = NULL WHERE id = ?')
    .run(info.slug, info.commit, now, info.userId, id);
  return { stale: true };
}

/**
 * After a publish the photos live in the repo. Turn the published uploads into site images (so the draft
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
        "UPDATE drafts SET status = 'in_review', rejected_at = NULL, title = ?, dek = ?, section = ?, area = ?, story_column = ?, author = ?, author_title = ?, church = ?, date = ?, photo_credit = ?, featured = ?, body = ?, updated_at = MAX(?, updated_at + 1), updated_by = ? WHERE id = ?",
      )
      .run(f.title, f.dek, f.section, f.area, f.column, f.author, f.authorTitle, f.church, f.date, f.photoCredit, f.featured ? 1 : 0, f.body, now, userId, id);
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
