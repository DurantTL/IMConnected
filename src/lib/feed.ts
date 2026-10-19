// Story feed data shared by /stories.json and /rss.xml.
// URLs are absolute so the items work outside the site (email, feed readers).
import { getStories, storyUrl, type Story } from './stories';
import { getSection, areaLabel } from './site';

/** How many of the newest stories the feeds include. */
export const FEED_LIMIT = 50;

export interface FeedItem {
  id: string;
  url: string;
  title: string;
  dek?: string;
  section: string;
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
  featured: boolean;
}

export function feedItem(story: Story, site: URL): FeedItem {
  const d = story.data;
  const abs = (path: string) => new URL(path, site).href;
  return {
    id: story.id,
    url: abs(storyUrl(story)),
    title: d.title,
    dek: d.dek,
    section: d.section,
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
    featured: d.featured,
  };
}

export async function getFeedItems(site: URL): Promise<FeedItem[]> {
  const stories = await getStories();
  return stories.slice(0, FEED_LIMIT).map((s) => feedItem(s, site));
}
