import type { Announcement } from './announcement';
// Story feed data shared by /stories.json and /rss.xml.
// URLs are absolute so the items work outside the site (email, feed readers).
import { mapStoryPhotos, escapeStoryBlocks, type StoryBlock } from './story-blocks';
import { storyUrl } from './stories';
import { getPublicStories } from './public-stories';
import { getSection, areaLabel, normalizeAdditionalSections } from './site';
import { photoLayoutOrDefault } from './photo-layouts';
import { stripMediaMarkers } from './story-media';

/** How many of the newest stories the feeds include. */
export const FEED_LIMIT = 50;

export interface FeedItem {
  id: string;
  url: string;
  title: string;
  dek?: string;
  section: string;
  additionalSections?: string[];
  /** Additive (issue #98): present only for a story with a newsletter issue. */
  newsletterIssue?: { number: number; date: string; title: string; position: number | null };
  sectionLabel: string;
  area?: string;
  areaLabel?: string;
  column?: string;
  author: string;
  authorTitle?: string;
  church?: string;
  /** YYYY-MM-DD */
  date: string;
  image?: string;
  imageAlt?: string;
  photoCredit?: string;
  photos: string[];
  /** Alt text for each of `photos`, same order; entries may be empty */
  photoAlts: string[];
  /** Visible caption of the lead photo (issue #84); omitted when it has none. Plain text: escape it like any text. */
  imageCaption?: string;
  /** Visible caption of each of `photos`, same order; entries may be empty. Plain text. */
  photoCaptions: string[];
  /** How the story page arranges the photos: one, twoUp, heroGrid, mosaic, stack, carousel or threeUp (one = lead photo, others in a row) */
  photoLayout: string;
  storyBlocks?: StoryBlock[];
  announcement?: Announcement | null;
  photoFocus?: { focalX: number; focalY: number; zoom?: number; fit?: 'cover' | 'contain'; fitFill?: 'blur' | 'paper' | 'navy' }[];
  featured: boolean;
}

/** What feedItem reads from a story: a content-collection entry, or the same fields built from a dashboard draft. */
export interface FeedSource {
  id: string;
  data: {
    title: string;
    dek?: string;
    section: string;
  additionalSections?: string[];
    newsletterIssue?: { number: number; date: string; title: string; position: number | null } | null;
    area?: string;
    column?: string;
    author: string;
    authorTitle?: string;
    church?: string;
    date: Date;
    image?: string;
    imageAlt?: string;
    photoCredit?: string;
    photos: string[];
    photoAlts: string[];
    photoLayout?: string;
    storyBlocks?: StoryBlock[];
    announcement?: Announcement | null;
    photoFocus?: { focalX: number; focalY: number; zoom?: number; fit?: 'cover' | 'contain'; fitFill?: 'blur' | 'paper' | 'navy'; caption?: string }[];
    featured: boolean;
  };
}

export function feedItem(story: FeedSource, site: URL): FeedItem {
  const d = story.data;
  const abs = (path: string) => new URL(path, site).href;
  const leadCaption = d.image ? d.photoFocus?.[0]?.caption ?? '' : '';
  return {
    id: story.id,
    url: abs(storyUrl(story)),
    title: d.title,
    dek: d.dek ? stripMediaMarkers(d.dek) : undefined,
    section: d.section,
    additionalSections: normalizeAdditionalSections(d.additionalSections, d.section),
    ...(d.newsletterIssue ? { newsletterIssue: d.newsletterIssue } : {}),
    sectionLabel: getSection(d.section)?.label ?? d.section,
    area: d.area,
    areaLabel: areaLabel(d.section, d.area),
    column: d.column,
    author: d.author,
    authorTitle: d.authorTitle,
    church: d.church,
    date: d.date.toISOString().slice(0, 10),
    image: d.image ? abs(d.image) : undefined,
    imageAlt: d.imageAlt,
    photoCredit: d.photoCredit,
    photos: d.photos.map(abs),
    photoAlts: d.photos.map((_, i) => d.photoAlts[i] ?? ''),
    photoLayout: photoLayoutOrDefault(d.photoLayout),
    ...(leadCaption ? { imageCaption: leadCaption } : {}),
    photoCaptions: d.photos.map((_, i) => d.photoFocus?.[i + (d.image ? 1 : 0)]?.caption ?? ''),
    ...(d.storyBlocks?.length ? { storyBlocks: mapStoryPhotos(escapeStoryBlocks(d.storyBlocks), (b) => b.url ? { ...b, url: abs(b.url) } : b) } : {}),
    ...(d.photoFocus?.some((p) => p.focalX !== 50 || p.focalY !== 50 || (p.zoom ?? 1) !== 1 || (p.fit ?? 'cover') !== 'cover') ? { photoFocus: d.photoFocus.map(({ caption: _caption, ...crop }) => crop) } : {}),
    ...(d.announcement ? { announcement: d.announcement } : {}),
    featured: d.featured,
  };
}

export async function getFeedItems(site: URL): Promise<FeedItem[]> {
  const stories = await getPublicStories();
  return stories.slice(0, FEED_LIMIT).map((s) => feedItem(s, site));
}
