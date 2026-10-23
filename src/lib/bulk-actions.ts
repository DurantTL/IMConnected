// Per-item publish and unpublish, shared by the single-item routes and the bulk action (issue #88). The bulk page
// calls these one story at a time, so every rule of the single path (version check, validation, slug reservation, one
// transaction, audit entry, cache invalidation) applies to each item, and a failure never rolls back the others.
import { getDraft, isEditable, listPhotos, rejectDraft, retireUploads, type OpResult } from './drafts';
import { publishDraft, unpublishLive, validSlug } from './story-publish';
import { EditorError, ERRORS, type ErrorCode } from './messages';
import { getStoryBySlug } from './story-store';
import { audit } from './auth/audit';
import { notifySubmitterOfPublication } from './submitter-notice';

export const BULK_MAX = 50;

const publishing = new Set<number>();

export type ItemResult = { ok: true; slug: string; title: string } | { ok: false; code: ErrorCode };

/**
 * Publish one draft at the version the person was looking at. `scheduled` (issue #124) is set only by the scheduler, which
 * carries out a person's earlier decision: the same code runs, the actor is the person who scheduled it, and the audit
 * entry says so.
 */
export async function publishDraftItem(draftId: number, version: number, userId: number, ip: string, opts: { scheduled?: { now: number } } = {}): Promise<ItemResult> {
  const draft = getDraft(draftId);
  if (!draft) return { ok: false, code: 'draft_gone' };
  if (!isEditable(draft)) return { ok: false, code: 'not_publishable' };
  if (version !== draft.updatedAt) return { ok: false, code: 'conflict' };
  if (publishing.has(draft.id)) return { ok: false, code: 'already_publishing' };
  publishing.add(draft.id);
  try {
    // One transaction: the draft row (version check, slug) and the story, its photos and its search entry.
    const out = await publishDraft(draft, listPhotos(draft.id), version, userId, opts.scheduled);
    // Housekeeping after the story is recorded: a failure here must never read as "not published".
    try {
      audit('draft.publish', { userId, target: `draft:${draft.id}`, detail: opts.scheduled ? { slug: out.slug, scheduled: true } : { slug: out.slug }, ip });
      retireUploads(draft.id, out.uploaded);
    } catch (err) {
      console.error('[drafts] published; cleanup afterwards failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
    // After the commit, and only for the draft's first publish: the one thank-you email to a confirmed form submitter.
    // Started without waiting, so the response never waits for the email service; it can never block or undo the publish.
    if (out.firstPublish) void notifySubmitterOfPublication(draft.id, out.slug, out.title, { userId, ip }).catch(() => console.error(`[drafts] submitter notice for draft ${draft.id} failed unexpectedly`));
    return { ok: true, slug: out.slug, title: out.title };
  } catch (err) {
    if (err instanceof EditorError) return { ok: false, code: err.code };
    console.error('[drafts] publish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return { ok: false, code: 'publish_failed' };
  } finally {
    publishing.delete(draft.id);
  }
}

/** Take one live story off the site. */
export function unpublishStoryItem(slug: string, userId: number, ip: string, requireLive = false): ItemResult {
  if (!validSlug(slug)) return { ok: false, code: 'slug_bad' };
  try {
    // Bulk only: a story that is already off the site (a reloaded result page, a stale list) is left alone, so another
    // editor's draft version and the audit log are not disturbed and a story republished in between is not taken down.
    if (requireLive && getStoryBySlug(slug)?.status !== 'live') return { ok: false, code: getStoryBySlug(slug, { includeUnpublished: true }) ? 'not_live' : 'story_missing' };
    const out = unpublishLive(slug, userId);
    if (!out) return { ok: false, code: 'story_missing' };
    try {
      audit('draft.unpublish', { userId, target: `story:${slug}`, detail: { slug }, ip });
    } catch {
      /* the audit entry is a convenience */
    }
    return { ok: true, slug, title: out.title };
  } catch (err) {
    if (err instanceof EditorError) return { ok: false, code: err.code };
    console.error('[drafts] unpublish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return { ok: false, code: 'unpublish_failed' };
  }
}

/** Plain-language reason for a failed item in the bulk result. */
export function bulkReason(code: ErrorCode, did = 'published'): string {
  if (code === 'conflict') return `Version conflict: this draft was changed after the list loaded, so nothing was ${did}. Open it to review the changes.`;
  return ERRORS[code];
}

/** Reject one new or in-review draft at the version the person was looking at (issue #89). Shared by the single route and the bulk action. */
export function rejectDraftItem(draftId: number, version: number, userId: number, note: string, ip: string): OpResult {
  const r = rejectDraft(draftId, version, userId, note);
  if (r.ok) audit('draft.reject', { userId, target: `draft:${draftId}`, ip });
  return r;
}
