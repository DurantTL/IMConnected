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
  /**
   * When the story first went live on the site (ISO 8601), whatever its own story `date` says. Editing, republishing,
   * unpublishing and publishing again never move it (stories.first_live_at, migration 040). Studio sorts by it so a newsletter picks up what was added since the last one.
   */
  uploadedAt: string;
}
export interface StudioDraft extends Omit<FeedItem, 'id' | 'url'> {
  draftFlyer?: StudioDraftFlyer;
  excerpt: string;
  id: number;
  status: 'new' | 'in_review';
  source: DraftSource;
  /** When the draft was created (ISO 8601). */
  uploadedAt: string;
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
      keyPoints: d.keyPoints,
      newsletterIssue: d.newsletterIssue?.date === undefined ? undefined : { number: d.newsletterIssue.number, date: d.newsletterIssue.date, title: d.newsletterIssue.title ?? '', position: d.newsletterIssue.position },
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
      photoFocus: [lead, ...rest].filter((p): p is DraftPhoto => !!p).map((p) => ({ focalX: p.focalX, focalY: p.focalY, zoom: p.zoom, fit: p.fit, fitFill: p.fitFill, caption: p.caption })),
      featured: d.featured,
    },
  };
}

/** `date` (the default): the story's own date, newest first. `uploaded`: the time it first went live, newest first. */
export type StudioSort = 'date' | 'uploaded';

const iso = (ms: number) => (Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(0)).toISOString();

export async function listPublishedForStudio(site: URL, opts: { limit: number; section?: string; sort?: StudioSort }): Promise<StudioStory[]> {
  // The stories table is the source of truth: "published" means live on the site right now. Throws StoriesUnavailable
  // when it can't be read (the endpoint answers 503).
  const sources = new Map<string, DraftSource | 'site'>();
  const uploaded = new Map<string, number>();
  let live: ReturnType<typeof listLiveFromDb>;
  try {
    // First time live: stories.first_live_at (set once, never moved); older rows fall back to the draft's first-publish
    // stamp, else the story's own published_at.
    const rows = getDb().prepare(
      'SELECT s.slug, s.source, COALESCE(s.first_live_at, NULLIF(d.submitter_notified_at, 0), s.published_at) AS first_live FROM stories s LEFT JOIN drafts d ON d.slug = s.slug',
    ).all() as { slug: string; source: string; first_live: number | null }[];
    for (const r of rows) {
      sources.set(r.slug, r.source === 'git' ? 'site' : (r.source as DraftSource));
      let ms = Number(r.first_live ?? 0);
      // A bare story date (adoption/import) is UTC midnight, which is the evening before in America/Chicago: show noon Chicago that day.
      if (ms > 0 && ms % 86_400_000 === 0) ms += 18 * 3_600_000;
      uploaded.set(r.slug, ms);
    }
    live = listLiveFromDb(); // read straight from the table, never the page cache: a change by another process shows at once
  } catch (err) {
    throw new StoriesUnavailable(err);
  }
  const inSection = live.filter((s) => !opts.section || belongsToSection(s.data, opts.section));
  // listLiveFromDb is already newest story date first; a stable sort keeps that as the tie-break.
  if (opts.sort === 'uploaded') inSection.sort((a, b) => (uploaded.get(b.id) ?? 0) - (uploaded.get(a.id) ?? 0));
  return inSection
    .slice(0, opts.limit)
    .map((s) => ({ ...feedItem(s, site), excerpt: storyExcerpt(s.body), status: 'published' as const, source: sources.get(s.id) ?? 'site', uploadedAt: iso(uploaded.get(s.id) ?? 0) }));
}

export function listDraftsForStudio(site: URL, opts: { section?: string; limit?: number } = {}): StudioDraft[] {
  return listOpenDraftsNewestFirst(opts.limit ?? STUDIO_DRAFT_LIMIT, opts.section).map(({ draft, photos }) => {
    // A draft is not live: no `url`, and its `id` is the draft's own.
    const { id: _slug, url: _url, ...item } = feedItem(draftAsFeedSource(String(draft.id), draft, photos), site);
    const flyer = draft.announcement ? studioDraftFlyer(draft.id) : null;
    return { ...item, ...(flyer ? { draftFlyer: flyer } : {}), excerpt: storyExcerpt(draft.body), id: draft.id, status: draft.status as 'new' | 'in_review', source: draft.source, uploadedAt: iso(draft.createdAt) };
  });
}
