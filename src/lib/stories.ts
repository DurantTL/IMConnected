import { belongsToSection } from './site';
import type { Announcement } from './announcement';
import type { StoryBlock } from './story-blocks';
import { getCollection, type CollectionEntry } from 'astro:content';

export type Story = CollectionEntry<'stories'>;

/** Published stories, newest first. */
export async function getStories(): Promise<Story[]> {
  const all = await getCollection('stories', ({ data }) => !data.draft);
  return all.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function storyUrl(story: { id: string }): string {
  return `/stories/${story.id}/`;
}

/** What the public pages need from a story. A content-collection entry fits, and so does a row from the stories table (public-stories.ts). */
export interface PublicStory {
  id: string;
  /** The Markdown source */
  body?: string;
  data: {
    title: string;
    dek?: string;
    section: string;
    additionalSections?: string[];
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
    /** How the photos are arranged on the page (src/lib/photo-layouts.ts). Missing means 'one', the original look. */
    photoLayout?: string;
    storyBlocks?: StoryBlock[];
    announcement?: Announcement | null;
    photoFocus?: { focalX: number; focalY: number; zoom?: number }[];
    featured: boolean;
  };
}

export function bySection<T extends PublicStory>(stories: T[], section: string, area?: string): T[] {
  return stories.filter(
    (s) => belongsToSection(s.data, section) && (!area || s.data.section === section && s.data.area === area),
  );
}
