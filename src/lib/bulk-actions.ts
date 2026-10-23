// Per-item publish and unpublish, shared by the single-item routes and the bulk action (issue #88). The bulk page
// calls these one story at a time, so every rule of the single path (version check, validation, slug reservation, one
// transaction, audit entry, cache invalidation) applies to each item, and a failure never rolls back the others.
import { getDraft, isEditable, listPhotos, retireUploads } from './drafts';
import { publishDraft, unpublishLive, validSlug } from './story-publish';
import { EditorError, ERRORS, type ErrorCode } from './messages';
import { audit } from './auth/audit';

export const BULK_MAX = 50;

const publishing = new Set<number>();

export type ItemResult = { ok: true; slug: string; title: string } | { ok: false; code: ErrorCode };

/** Publish one draft at the version the person was looking at. */
export async function publishDraftItem(draftId: number, version: number, userId: number, ip: string): Promise<ItemResult> {
  const draft = getDraft(draftId);
  if (!draft) return { ok: false, code: 'draft_gone' };
  if (!isEditable(draft)) return { ok: false, code: 'not_publishable' };
  if (version !== draft.updatedAt) return { ok: false, code: 'conflict' };
  if (publishing.has(draft.id)) return { ok: false, code: 'already_publishing' };
  publishing.add(draft.id);
  try {
    // One transaction: the draft row (version check, slug) and the story, its photos and its search entry.
    const out = await publishDraft(draft, listPhotos(draft.id), version, userId);
    // Housekeeping after the story is recorded: a failure here must never read as "not published".
    try {
      audit('draft.publish', { userId, target: `draft:${draft.id}`, detail: { slug: out.slug }, ip });
      retireUploads(draft.id, out.uploaded);
    } catch (err) {
      console.error('[drafts] published; cleanup afterwards failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
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
export function unpublishStoryItem(slug: string, userId: number, ip: string): ItemResult {
  if (!validSlug(slug)) return { ok: false, code: 'slug_bad' };
  try {
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
export function bulkReason(code: ErrorCode): string {
  if (code === 'conflict') return 'Version conflict: this draft was changed after the list loaded, so nothing was published. Open it to review the changes.';
  return ERRORS[code];
}
