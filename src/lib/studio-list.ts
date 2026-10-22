import { belongsToSection } from './site';
// The story list IMConnected Studio imports from (GET /api/stories).
//
// "Published" means live on the site NOW: the rows of the stories table that are live, newest first, exactly the
// stories /stories.json lists (but more of them). A publish or an unpublish shows here on the next request.
//
// Items use feedItem() from src/lib/feed.ts, so a story has exactly the /stories.json fields. Drafts are the
// same shape without `url` (they are not live) plus `id` (the draft id), `status` and `source`. Only whitelisted
// fields are copied: submitter name, email, phone and church never leave the database through this list.
import { feedItem, type FeedItem, type FeedSource } from './feed';
import { listLiveFromDb, StoriesUnavailable } from './public-stories';
import { getDb } from './db';
import { validDate } from './storyfile';
import { storyExcerpt } from './excerpt';
import { listOpenDraftsNewestFirst, type Draft, type DraftPhoto, type DraftSource } from './drafts';
import { studioDraftFlyer, type StudioDraftFlyer } from './studio-draft-flyer';

export const STUDIO_LIST_MAX = 100;
export const STUDIO_DRAFT_LIMIT = 20;

export interface StudioStory extends FeedItem {
  /** First paragraph of the body as plain text (at most 400 characters), or an empty string. */
  excerpt: string;
  status: 'published';
  /** Where it came from: the story's source (form, studio, editor, agent), or "site" for a story imported from git. */
  source: DraftSource | 'site';
}
export interface StudioDraft extends Omit<FeedItem, 'id' | 'url'> {
  draftFlyer?: StudioDraftFlyer;
  excerpt: string;
  id: number;
  status: 'new' | 'in_review';
  source: DraftSource;
}

// Photos a draft may point at without any login: files already on the site. Uploads (DATA_DIR/uploads) are only
// served to signed-in editors by /api/admin/photos/<id>, so a draft's uploaded photos are left out.
const publicPhoto = (p: DraftPhoto) => !!p.url && (/^\/(images|media)\/[A-Za-z0-9._\-/]+$/.test(p.url) || /^https:\/\//.test(p.url));

function draftAsFeedSource(slugOrId: string, d: Draft, photos: DraftPhoto[]): FeedSource {
  // Only a lead photo that is public counts as the lead; a gallery photo is never promoted to lead.
  const lead = photos[0] && publicPhoto(photos[0]) ? photos[0] : undefined;
  const rest = lead ? photos.slice(1).filter(publicPhoto) : [];
  // A stored date that isn't a real calendar day (older drafts were saved with a loose check) must not break the whole list.
  const date = validDate(d.date) ? new Date(`${d.date}T00:00:00Z`) : new Date(d.createdAt);
  return {
    id: slugOrId,
    data: {
      announcement: d.announcement,
      title: d.title || 'Untitled story',
      dek: d.dek || undefined,
      section: d.section,
      additionalSections: d.additionalSections,
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
      photoLayout: d.photoLayout,
      // Draft modules may reference private uploads, so only public story modules are exported.
      photoFocus: [lead, ...rest].filter((p): p is DraftPhoto => !!p).map((p) => ({ focalX: p.focalX, focalY: p.focalY, zoom: p.zoom })),
      featured: d.featured,
    },
  };
}

export async function listPublishedForStudio(site: URL, opts: { limit: number; section?: string }): Promise<StudioStory[]> {
  // The stories table is the source of truth: "published" means live on the site right now. Throws StoriesUnavailable
  // when it can't be read (the endpoint answers 503).
  const sources = new Map<string, DraftSource | 'site'>();
  let live: ReturnType<typeof listLiveFromDb>;
  try {
    const rows = getDb().prepare('SELECT slug, source FROM stories').all() as { slug: string; source: string }[];
    for (const r of rows) sources.set(r.slug, r.source === 'git' ? 'site' : (r.source as DraftSource));
    live = listLiveFromDb(); // read straight from the table, never the page cache: a change by another process shows at once
  } catch (err) {
    throw new StoriesUnavailable(err);
  }
  return live
    .filter((s) => !opts.section || belongsToSection(s.data, opts.section))
    .slice(0, opts.limit)
    .map((s) => ({ ...feedItem(s, site), excerpt: storyExcerpt(s.body), status: 'published' as const, source: sources.get(s.id) ?? 'site' }));
}

export function listDraftsForStudio(site: URL, opts: { section?: string; limit?: number } = {}): StudioDraft[] {
  return listOpenDraftsNewestFirst(opts.limit ?? STUDIO_DRAFT_LIMIT, opts.section).map(({ draft, photos }) => {
    // A draft is not live: no `url`, and its `id` is the draft's own.
    const { id: _slug, url: _url, ...item } = feedItem(draftAsFeedSource(String(draft.id), draft, photos), site);
    const flyer = draft.announcement ? studioDraftFlyer(draft.id) : null;
    return { ...item, ...(flyer ? { draftFlyer: flyer } : {}), excerpt: storyExcerpt(draft.body), id: draft.id, status: draft.status as 'new' | 'in_review', source: draft.source };
  });
}
