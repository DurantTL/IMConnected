// Where the public pages get their stories (epic #25, step 2). Server-side only.
//
// Two sources, one rule: readers must never get a missing or empty page because the stories table is still
// empty or half-filled after a start.
//   * Once the mirror of the build has completed in this process (storySyncDone), pages read the stories table
//     (story-store.ts) and photos are served from /media.
//   * Until then, and whenever the database can't be read, pages read the built content collection, exactly what
//     the prerendered pages used (photos are the build's own /images/... files), minus anything the dashboard
//     unpublished. The first public request starts the mirror; when it finishes, invalidateStories() drops the
//     cached pages so the next request is served from the table.
// Both sources return the same PublicStory shape, newest first (date, then slug), so the markup is identical.
import { getStories, type PublicStory } from './stories';
import { getStoryBySlug, listHolds, listStories, LIST_MAX, type Story } from './story-store';
import { computeBuildMarker, ensureStorySync, storySyncDone } from './story-sync';
import { listUnpublishedSlugs } from './drafts';
import { cacheGeneration, TTL_MS } from './public-cache';
import { buildCommits, holdActive } from './story-holds';
import { renderMarkdownSafe } from './markdown';

/** The /media address of a photo we hold, else the photo's own address. */
function photoUrl(s: Story, index: number, original: string): string {
  const row = s.photoRows.find((p) => p.position === index);
  return row?.path ? `/media/${row.path}` : original;
}

export function toPublicStory(s: Story): PublicStory {
  const lead = s.image ? 1 : 0;
  return {
    id: s.slug,
    body: s.body,
    data: {
      title: s.title,
      dek: s.dek,
      section: s.section,
      area: s.area,
      column: s.column,
      author: s.author,
      authorTitle: s.authorTitle,
      church: s.church,
      date: new Date(`${s.date}T00:00:00.000Z`),
      image: s.image ? photoUrl(s, 0, s.image) : undefined,
      imageAlt: s.imageAlt,
      photoCredit: s.photoCredit,
      photos: s.photos.map((p, i) => photoUrl(s, lead + i, p)),
      photoAlts: s.photoAlts,
      featured: s.featured,
    },
  };
}

function listLiveFromDb(): PublicStory[] {
  const out: PublicStory[] = [];
  for (let offset = 0; ; offset += LIST_MAX) {
    const page = listStories({ limit: LIST_MAX, offset });
    for (const s of page) if (!s.draft) out.push(toPublicStory(s));
    if (page.length < LIST_MAX) return out;
  }
}

let buildMarker: Promise<string> | undefined;
/** The running build's marker; a failure is not remembered. */
function currentMarker(): Promise<string> {
  buildMarker ??= computeBuildMarker().catch((err) => { buildMarker = undefined; throw err; });
  return buildMarker;
}

async function listFromBuild(): Promise<PublicStory[]> {
  let hidden = new Set<string>();
  try {
    hidden = listUnpublishedSlugs();
    // Held stories (unpublished, then published again; the running build still has the old text) stay hidden until the
    // image contains the unpublish commit. If that can't be worked out, every held story stays hidden.
    const holds = listHolds();
    if (holds.size) {
      let marker: string | null = null;
      try {
        if (buildCommits() === null) marker = await currentMarker();
      } catch { marker = null; }
      for (const [slug, h] of holds) {
        let active = true;
        try { active = holdActive(h, marker); } catch { active = true; }
        if (active) hidden.add(slug);
      }
    }
  } catch (err) {
    console.error('[stories] could not read the unpublished list:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
  }
  return (await getStories())
    .filter((s) => !hidden.has(s.id))
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The whole list is kept for reuse by the home page, the section pages and the feeds; it goes with every invalidation.
let listed: { generation: number; at: number; stories: PublicStory[] } | undefined;

/** Published stories, newest first. */
export async function getPublicStories(): Promise<PublicStory[]> {
  ensureStorySync(); // a no-op once finished; this is what starts the first import after a start
  const generation = cacheGeneration();
  if (listed && listed.generation === generation && Date.now() - listed.at < TTL_MS) return listed.stories;
  let stories: PublicStory[] | undefined;
  if (storySyncDone()) {
    try {
      stories = listLiveFromDb();
    } catch (err) {
      console.error('[stories] could not read the stories table; using the build:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }
  stories ??= await listFromBuild();
  listed = { generation, at: Date.now(), stories };
  return stories;
}

/** One published story, or undefined for an unknown or unpublished slug. */
export async function getPublicStory(slug: string): Promise<PublicStory | undefined> {
  ensureStorySync();
  if (storySyncDone()) {
    try {
      const s = getStoryBySlug(slug);
      return s && !s.draft ? toPublicStory(s) : undefined;
    } catch (err) {
      console.error('[stories] could not read the stories table; using the build:', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
  }
  return (await listFromBuild()).find((s) => s.id === slug);
}

/** A story's body as HTML. Raw HTML in the Markdown is neutralised, and links with a script scheme become "#". */
export async function renderStoryBody(story: PublicStory): Promise<string> {
  return (await renderMarkdownSafe(story.body ?? '')).html;
}
