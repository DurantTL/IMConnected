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

export function bySection(stories: Story[], section: string, area?: string): Story[] {
  return stories.filter(
    (s) => s.data.section === section && (!area || s.data.area === area),
  );
}
