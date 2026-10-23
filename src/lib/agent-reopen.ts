import { createHash } from 'node:crypto';
import { getDb } from './db';
import { mergeAgentAnnouncement, createDraft, getDraftBySlug, resetDraftFromStory, tx, writeUpload, removeUploadFiles } from './drafts';
import { loadStory, validSlug } from './story-publish';
import { getSection, isValidArea } from './site';
import { AgentError, assertPhotoMarkers, AgentConflict, REQUEST_ID_RE, parseAgentStory, refusalDetails, refusalReason } from './agent';
import { LIMITS } from './limits';
import { audit } from './auth/audit';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const FIELDS = ['title', 'dek', 'body', 'section', 'area', 'author', 'church', 'date', 'photoLayout', 'announcement', 'additionalSections', 'authorTitle', 'photoCredit', 'featured'] as const;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export interface ReopenRequest { slug: string; requestHash: string; payloadHash: string; changes: Record<string, unknown>; photos?: unknown[]; note?: string }
/** RequestId is opaque; retry the identical JSON body. Receipts retain hashes only. */
export function parseAgentReopen(value: unknown, raw: string): ReopenRequest {
  if (!object(value)) throw new AgentError('invalid_json', 'The request body must be a JSON object.');
  if (Object.keys(value).some((k) => !['slug', 'requestId', 'changes', 'photos', 'note'].includes(k))) throw new AgentError('bad_field', 'Unknown reopen field.');
  if (!validSlug(value.slug)) throw new AgentError('bad_slug', 'Send the published story slug.');
  if (typeof value.requestId !== 'string' || !REQUEST_ID_RE.test(value.requestId)) throw new AgentError('bad_request_id', 'requestId must contain 8–128 letters, digits, underscores or hyphens.');
  const changes = value.changes === undefined ? {} : value.changes;
  if (!object(changes) || Object.keys(changes).some((k) => !(FIELDS as readonly string[]).includes(k))) throw new AgentError('bad_field', 'changes must contain only supported editorial fields.');
  for (const [key, v] of Object.entries(changes)) if (key !== 'announcement' && key !== 'additionalSections' && key !== 'featured' && typeof v !== 'string') throw new AgentError('bad_field', `"${key}" must be text.`);
  if (value.photos !== undefined && !Array.isArray(value.photos)) throw new AgentError('photos_invalid', 'photos must be a list of new images to append.');
  if (value.note !== undefined && typeof value.note !== 'string') throw new AgentError('bad_field', 'note must be text.');
  return { slug: value.slug, requestHash: hash(value.requestId), payloadHash: hash(raw), changes, photos: value.photos as unknown[] | undefined, note: value.note as string | undefined };
}

/** Reopen the current live version for human review, without writing any public story state. */
export function reopenAgentStory(input: ReopenRequest, ip: string): { id: number; status: 'reopened' | 'replayed' } {
  const written: string[] = [];
  let oldFiles: string[] = [];
  let result: { id: number; status: 'reopened' | 'replayed' };
  try {
    result = tx(() => {
      const db = getDb();
      const receipt = db.prepare('SELECT payload_hash,draft_id FROM agent_reopens WHERE request_hash=?').get(input.requestHash) as { payload_hash: string; draft_id: number } | undefined;
      if (receipt) {
        if (receipt.payload_hash !== input.payloadHash) throw new AgentConflict('request_id_reused', 'Use a new requestId for a different payload.', 409, { reason: 'request_id_reused', message: 'This requestId was already used for a different request. Use a new requestId, or retry the identical body.' });
        return { id: receipt.draft_id, status: 'replayed' };
      }
      const live = db.prepare("SELECT draft,published_at,published_by,source FROM stories WHERE slug=? AND status='live'").get(input.slug) as { draft: number; published_at: number; published_by: number | null; source: string } | undefined;
      if (!live || live.draft) throw new AgentConflict('story_not_found', 'No public story exists at that slug.', 404);
      const existing = getDraftBySlug(input.slug);
      if (existing && existing.status !== 'published') {
        const touched = (db.prepare('SELECT updated_by FROM drafts WHERE id=?').get(existing.id) as { updated_by: number | null }).updated_by !== null;
        throw new AgentConflict('already_reviewed', 'This story already has an open or rejected draft. Ask an editor to review it.', 409, refusalDetails(refusalReason(existing.status, touched), existing.source === 'agent' ? existing.id : null, input.slug));
      }
      const story = loadStory(input.slug);
      if (!story) throw new AgentConflict('story_not_found', 'No public story exists at that slug.', 404);
      if (Object.hasOwn(input.changes, 'body') && story.fields.storyBlocks?.length) throw new AgentConflict('module_body_conflict', 'This story uses editor modules. Omit body to preserve them, or ask an editor to update the modules.', 409, { reason: 'module_body_conflict', message: 'This story uses editor modules, so the body cannot be replaced. Omit body to preserve the modules, or ask an editor to update them.' });
      // Existing public fields may predate agent limits or contain expanded Markdown escapes.
      // Validate supplied changes only; omitted editorial values must remain byte-for-byte intact.
      // A section change without an area moves the story to the new section's default area (the first one; none = no area).
      const changes: Record<string, unknown> = { ...input.changes };
      if (typeof changes.section === 'string' && changes.area === undefined) {
        const target = getSection(changes.section);
        if (target && changes.section !== story.fields.section && !isValidArea(changes.section, story.fields.area)) changes.area = target.areas?.[0]?.key ?? '';
      }
      const parsed = parseAgentStory({ title: 'Reopened story', body: 'Existing published body is preserved.', section: story.fields.section, area: story.fields.area,
        ...changes, ...(input.photos !== undefined ? { photos: input.photos } : {}), note: input.note });
      if (story.photos.length + (parsed.photos?.length ?? 0) > LIMITS.maxPhotos) throw new AgentError('too_many_photos', `The existing and new photos together must not exceed ${LIMITS.maxPhotos}.`);
      const fields = { ...story.fields };
      for (const key of FIELDS) if (Object.hasOwn(changes, key)) {
        // Each parsed key has the corresponding DraftFields type; assign without widening that union.
        if (key === 'announcement') Object.assign(fields, { announcement: parsed.announcementPatch ? mergeAgentAnnouncement(story.fields.announcement ?? null, parsed.announcementPatch) : parsed.announcement ?? null });
        else Object.assign(fields, { [key]: key === 'date' ? parsed.date || fields.date : parsed[key] });
      }
      if (Object.hasOwn(changes, 'body')) assertPhotoMarkers(fields.body, story.photos.length + (parsed.photos?.length ?? 0));
      const id = existing?.id ?? createDraft({ source: 'agent', status: 'in_review', fields, slug: input.slug });
      if (!existing) db.prepare("UPDATE drafts SET published_commit='db',published_at=?,published_by=?,published_via_studio=? WHERE id=?").run(live.published_at, live.published_by, live.source === 'studio' ? 1 : 0, id);
      oldFiles = resetDraftFromStory(id, null, fields, story.photos);
      if (input.note !== undefined) db.prepare('UPDATE drafts SET agent_note=? WHERE id=?').run(parsed.note || null, id);
      const insert = db.prepare('INSERT INTO draft_photos(draft_id,path,ext,alt,position,created_at,focal_x,focal_y,zoom) VALUES(?,?,?,?,?,?,?,?,?)');
      for (const [i, photo] of (parsed.photos ?? []).entries()) {
        const rel = writeUpload(id, photo.bytes, photo.ext);
        written.push(rel);
        insert.run(id, rel, photo.ext, photo.alt, story.photos.length + i, Date.now(), photo.focalX ?? 50, photo.focalY ?? 50, photo.zoom ?? 1);
      }
      db.prepare('INSERT INTO agent_reopens(request_hash,payload_hash,draft_id,created_at) VALUES(?,?,?,?)').run(input.requestHash, input.payloadHash, id, Date.now());
      audit('agent.reopen', { target: `draft:${id}`, detail: { result: 'reopened' }, ip });
      return { id, status: 'reopened' };
    });
  } catch (err) {
    removeUploadFiles(written);
    throw err;
  }
  // A cleanup failure cannot turn a committed reopen into an apparent failed request.
  try { removeUploadFiles(oldFiles); } catch { console.warn('[agent] superseded upload cleanup failed'); }
  return result;
}
