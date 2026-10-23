import { canonicalSectionKey, normalizeAdditionalSections } from './site';
import { getDb } from './db';
import type { DraftFields } from './drafts';
import { normalizeStoryBlocks, photoFit, photoFitFill, type PhotoFit, type PhotoFitFill } from './story-blocks';
import { normalizeAnnouncement } from './announcement';
import { normalizeRef } from './newsletter-issues';
import { normalizeKeyPoints } from './key-points';
export interface RevisionPhoto { id: number; key: string; alt: string; caption: string; focalX: number; focalY: number; zoom: number; fit?: PhotoFit; fitFill?: PhotoFitFill }
export interface EditorialSnapshot { fields: DraftFields; photos: RevisionPhoto[] }
/** Explicit editorial whitelist. Never spread Draft: it contains private submission/account data.
 * Scheduled publishing (issue #124) is deliberately absent: publish_at, publish_at_by and suggested_publish_at are actions and
 * advice, not editorial state, so restoring a revision never schedules, unschedules or reschedules anything. */
export function editorialSnapshot(id: number, f: DraftFields): EditorialSnapshot {
  const fields: DraftFields = {
    title: f.title, dek: f.dek, section: f.section, additionalSections: normalizeAdditionalSections(f.additionalSections, f.section), area: f.area, column: '', author: f.author, authorTitle: f.authorTitle,
    newsletterIssue: normalizeRef(f.newsletterIssue), // number and position only; an older revision has none (null)
    keyPoints: normalizeKeyPoints(f.keyPoints),
    church: f.church, date: f.date, photoCredit: f.photoCredit, photoLayout: f.photoLayout, featured: f.featured, body: f.body,
    storyBlocks: normalizeStoryBlocks(f.storyBlocks ?? []), announcement: normalizeAnnouncement(f.announcement),
  };
  const rows = getDb().prepare('SELECT id, media_key, alt, caption, focal_x, focal_y, zoom, fit, fit_fill FROM draft_photos WHERE draft_id=? ORDER BY position, id').all(id) as Record<string, unknown>[];
  const photos = rows.map((p) => ({ id: Number(p.id), key: String(p.media_key), alt: String(p.alt), caption: String(p.caption), focalX: Number(p.focal_x), focalY: Number(p.focal_y), zoom: Number(p.zoom), fit: photoFit(p.fit), fitFill: photoFitFill(p.fit_fill) }));
  return { fields, photos };
}
export function recordDraftRevision(id: number, userId: number, snapshot: EditorialSnapshot): void {
  const payload = JSON.stringify(snapshot);
  if (payload.length > 600_000) throw new Error('The story revision is too large.');
  getDb().prepare('INSERT INTO draft_revisions(draft_id,user_id,created_at,payload) VALUES(?,?,?,?)').run(id, userId, Date.now(), payload);
  getDb().prepare('DELETE FROM draft_revisions WHERE draft_id=? AND id NOT IN (SELECT id FROM draft_revisions WHERE draft_id=? ORDER BY id DESC LIMIT 20)').run(id, id);
}
export function listDraftRevisions(id: number): { id: number; createdAt: number; editor: string }[] {
  return (getDb().prepare("SELECT r.id,r.created_at,COALESCE(u.name,'Former editor') editor FROM draft_revisions r LEFT JOIN users u ON u.id=r.user_id WHERE r.draft_id=? ORDER BY r.id DESC LIMIT 20").all(id) as { id: number; created_at: number; editor: string }[]).map((r) => ({ id: r.id, createdAt: r.created_at, editor: r.editor }));
}
export function readDraftRevision(draftId: number, revisionId: number): EditorialSnapshot | null {
  const row = getDb().prepare('SELECT payload FROM draft_revisions WHERE draft_id=? AND id=?').get(draftId, revisionId) as { payload: string } | undefined;
  if (!row) return null;
  const snapshot = JSON.parse(row.payload) as EditorialSnapshot;
  snapshot.fields.section = canonicalSectionKey(snapshot.fields.section) as string; // issue #136: a revision saved while Columns existed restores as Features, and a column name restores as empty (column names are retired)
  snapshot.fields.column = '';
  snapshot.fields.additionalSections = normalizeAdditionalSections(snapshot.fields.additionalSections, snapshot.fields.section);
  snapshot.fields.newsletterIssue = normalizeRef(snapshot.fields.newsletterIssue);
  snapshot.fields.keyPoints = normalizeKeyPoints(snapshot.fields.keyPoints); // an older revision has none: it restores to []
  return snapshot;
}
