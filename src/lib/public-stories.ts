import { storyBlockPhotos, mapStoryPhotos } from './story-blocks';
// Where the public pages get their stories (epic #25, step 4). Server-side only.
//
// One source: the stories table. The built content collection is NOT a fallback any more: after the one-time adoption
// (story-adopt.ts) the database is the truth, and an empty table is a real empty site. If the table can't be read,
// pages answer 503 (StoriesUnavailable / unavailableResponse) instead of showing stale built content.
// Photo addresses on these pages are the row's /media copy when we hold the file, else the photo's own address.
import type { PublicStory } from './stories';
import { getStoryBySlug, listStories, LIST_MAX, type Story } from './story-store';
import { adoptionDone, adoptionInFlight } from './story-adopt';
import { getDb } from './db';
import { cacheGeneration, TTL_MS } from './public-cache';
import { renderStoryBlocksSafe } from './story-block-render';
import { renderMediaMarkdown } from './story-media-render';

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
      photoLayout: s.photoLayout,
      announcement: s.announcement,
      storyBlocks: s.storyBlocks && mapStoryPhotos(s.storyBlocks, (block) => {
        if (!block.url) return block;
        const sources = [...(s.image ? [s.image] : []), ...s.photos];
        const index = block.photoIndex !== undefined && sources[block.photoIndex] === block.url ? block.photoIndex : sources.indexOf(block.url);
        return index < 0 ? block : { ...block, url: photoUrl(s, index, block.url) };
      }),
      photoFocus: s.photoRows.map((p) => ({ focalX: p.focalX ?? 50, focalY: p.focalY ?? 50, zoom: p.zoom ?? 1 })),
      featured: s.featured,
    },
  };
}

/** Every live story straight from the table, newest first. Not cached: callers that need the freshest answer (the Studio list) use it. */
export function listLiveFromDb(): PublicStory[] {
  const out: PublicStory[] = [];
  for (let offset = 0; ; offset += LIST_MAX) {
    const page = listStories({ limit: LIST_MAX, offset });
    for (const s of page) if (!s.draft) out.push(toPublicStory(s));
    if (page.length < LIST_MAX) return out;
  }
}

/**
 * The database cannot be read. Pages and feeds answer 503 (unavailableResponse) rather than show anything else: the
 * build is no longer a source of content, and an old copy of the site would hide a real problem.
 */
export class StoriesUnavailable extends Error {
  constructor(cause?: unknown) {
    super('The stories could not be read.');
    if (cause !== undefined) console.error('[stories] could not read the stories table:', cause instanceof Error ? cause.message.slice(0, 200) : 'unknown error');
  }
}

/** A 503 that says to try again; never cached (only 200 responses are) and marked no-store. */
export function unavailableResponse(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Back in a moment</title><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1>We’ll be right back</h1><p>IMConnected can’t load its stories right now. Please try again in a minute.</p></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '30' } },
  );
}

/** The 503 response for a StoriesUnavailable; any other error is rethrown. */
export function asUnavailable(err: unknown): Response {
  if (err instanceof StoriesUnavailable) return unavailableResponse();
  throw err;
}

/** Wait (up to 60 s) for the one-time adoption only when the table is still empty, i.e. a brand new database. */
export async function ready(): Promise<void> {
  const db = getDb(); // starts the adoption on the first use after a start
  if (adoptionDone()) return;
  const running = adoptionInFlight();
  if (!running) return;
  let empty = false;
  try {
    empty = Number((db.prepare('SELECT COUNT(*) AS n FROM stories').get() as { n: number }).n) === 0;
  } catch { /* the read below reports it */ }
  if (empty) await Promise.race([running, new Promise((r) => setTimeout(r, 60_000).unref?.())]);
}

// The whole list is kept for reuse by the home page, the section pages and the feeds; it goes with every invalidation.
let listed: { generation: number; at: number; stories: PublicStory[] } | undefined;

/** Published stories, newest first (date, then slug). Throws StoriesUnavailable when the table can't be read. */
export async function getPublicStories(): Promise<PublicStory[]> {
  try {
    await ready();
    const generation = cacheGeneration();
    if (listed && listed.generation === generation && Date.now() - listed.at < TTL_MS) return listed.stories;
    const stories = listLiveFromDb();
    listed = { generation, at: Date.now(), stories };
    return stories;
  } catch (err) {
    throw new StoriesUnavailable(err);
  }
}

/** One published story, or undefined for an unknown or unpublished slug. Throws StoriesUnavailable when the table can't be read. */
export async function getPublicStory(slug: string): Promise<PublicStory | undefined> {
  try {
    await ready();
    const s = getStoryBySlug(slug);
    return s && !s.draft ? toPublicStory(s) : undefined;
  } catch (err) {
    throw new StoriesUnavailable(err);
  }
}

/** A story's body as HTML. Raw HTML in the Markdown is neutralised, and links with a script scheme become "#". */
export async function renderStoryBody(story: PublicStory): Promise<string> {
  return (await renderStoryContent(story)).html;
}

export async function renderStoryContent(story: PublicStory): Promise<{ html: string; used: Set<string>; usedPhotoIndices?: Set<number> }> {
  if (story.data.storyBlocks?.length) {
    const photos = storyBlockPhotos(story.data.storyBlocks).filter((p) => p.url);
    return { html: await renderStoryBlocksSafe(story.data.storyBlocks, { flyerUrl: story.data.announcement ? story.data.image : undefined }), used: new Set(photos.filter((p) => p.photoIndex === undefined).map((p) => p.url!)), usedPhotoIndices: new Set(photos.filter((p) => p.photoIndex !== undefined).map((p) => p.photoIndex!)) };
  }
  const d = story.data;
  const photos = [...(d.image ? [{ src: d.image, alt: d.imageAlt ?? '' }] : []), ...d.photos.map((src, i) => ({ src, alt: d.photoAlts[i] ?? '' }))].map((photo, i) => ({ ...photo, ...d.photoFocus?.[i] }));
  const rendered = await renderMediaMarkdown(story.body ?? '', photos, false, d.announcement ? 0 : undefined);
  return { html: rendered.html, used: new Set(), usedPhotoIndices: rendered.used };
}
