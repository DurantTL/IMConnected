// The story list IMConnected Studio imports from (GET /api/stories).
//
// "Published" means live on the site NOW, which can be newer than the last build (the site rebuilds 3-5 minutes
// after a publish), so the list is the built collection plus the dashboard's own record, exactly like
// /admin/published: built stories, minus ones an editor unpublished, with the dashboard's `published` drafts
// (live since the last build, or edited since) taking the place of the built copy. No GitHub call is needed,
// so the list works when GitHub is down or unconfigured. A story committed straight to git by hand and not yet
// deployed is the one thing it cannot see.
//
// Items use feedItem() from src/lib/feed.ts, so a story has exactly the /stories.json fields. Drafts are the
// same shape without `url` (they are not live) plus `id` (the draft id), `status` and `source`. Only whitelisted
// fields are copied: submitter name, email, phone and church never leave the database through this list.
import { feedItem, type FeedItem, type FeedSource } from './feed';
import { getStories } from './stories';
import { listLiveDrafts, listOpenDraftsNewestFirst, listPhotos as listPhotosOf, listUnpublishedSlugs, type Draft, type DraftPhoto, type DraftSource } from './drafts';

export const STUDIO_LIST_MAX = 100;
export const STUDIO_DRAFT_LIMIT = 20;

export interface StudioStory extends FeedItem {
  status: 'published';
  /** Where it came from: the dashboard draft's source (form, studio, editor, agent), or "site" for a story that was committed to git. */
  source: DraftSource | 'site';
}
export interface StudioDraft extends Omit<FeedItem, 'id' | 'url'> {
  id: number;
  status: 'new' | 'in_review';
  source: DraftSource;
}

// Photos a draft may point at without any login: files already on the site. Uploads (DATA_DIR/uploads) are only
// served to signed-in editors by /api/admin/photos/<id>, so a draft's uploaded photos are left out.
const publicPhoto = (p: DraftPhoto) => !!p.url && (/^\/images\/[A-Za-z0-9._\-/]+$/.test(p.url) || /^https:\/\//.test(p.url));

function draftAsFeedSource(slugOrId: string, d: Draft, photos: DraftPhoto[]): FeedSource {
  // Only a lead photo that is public counts as the lead; a gallery photo is never promoted to lead.
  const lead = photos[0] && publicPhoto(photos[0]) ? photos[0] : undefined;
  const rest = lead ? photos.slice(1).filter(publicPhoto) : [];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? new Date(`${d.date}T00:00:00Z`) : new Date(d.createdAt);
  return {
    id: slugOrId,
    data: {
      title: d.title || 'Untitled story',
      dek: d.dek || undefined,
      section: d.section,
      area: d.area || undefined,
      column: d.column || undefined,
      author: d.author,
      authorTitle: d.authorTitle || undefined,
      church: d.church || undefined,
      date,
      image: lead?.url ?? undefined,
      imageAlt: lead ? lead.alt || d.title : undefined,
      photoCredit: lead && d.photoCredit ? d.photoCredit : undefined,
      photos: rest.map((p) => p.url as string),
      photoAlts: rest.map((p) => p.alt),
      featured: d.featured,
    },
  };
}

export async function listPublishedForStudio(site: URL, opts: { limit: number; section?: string }): Promise<StudioStory[]> {
  const items = new Map<string, StudioStory>();
  try {
    for (const s of await getStories()) items.set(s.id, { ...feedItem(s, site), status: 'published', source: 'site' });
  } catch (err) {
    console.error('[stories] could not read the built story list', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
  }
  try {
    for (const slug of listUnpublishedSlugs()) items.delete(slug);
    for (const d of listLiveDrafts()) {
      const slug = d.slug as string;
      const built = items.get(slug);
      // A draft being edited again (in review) holds unpublished edits: the live text is the built copy, if there is one.
      if (d.status !== 'published') {
        if (built) items.set(slug, { ...built, source: d.source });
        continue;
      }
      items.set(slug, { ...feedItem(draftAsFeedSource(slug, d, listPhotosOf(d.id)), site), status: 'published', source: d.source });
    }
  } catch (err) {
    // The dashboard database being down must not hide the stories that were in the last build.
    console.error('[stories] could not read the dashboard record', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
  }
  return [...items.values()]
    .filter((s) => !opts.section || s.section === opts.section)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, opts.limit);
}

export function listDraftsForStudio(site: URL, opts: { section?: string; limit?: number } = {}): StudioDraft[] {
  return listOpenDraftsNewestFirst(opts.limit ?? STUDIO_DRAFT_LIMIT, opts.section).map(({ draft, photos }) => {
    // A draft is not live: no `url`, and its `id` is the draft's own.
    const { id: _slug, url: _url, ...item } = feedItem(draftAsFeedSource(String(draft.id), draft, photos), site);
    return { ...item, id: draft.id, status: draft.status as 'new' | 'in_review', source: draft.source };
  });
}
