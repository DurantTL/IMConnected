// Home page featured panel and statline (issue #119). Pure array work on the live stories the page already loaded.
import type { PublicStory } from './stories';

/** The newest live story marked featured, announcements and events excluded (they have the spotlight). Input is newest first. */
export function featuredPanelStory(stories: PublicStory[]): PublicStory | undefined {
  return stories.find((s) => s.data.featured && !s.data.announcement);
}

/**
 * A comparison key for a church value, or '' when it should not be counted: whitespace collapsed, curly quotes straightened,
 * case folded, "Seventh-day Adventist" and "SDA" the same token, and anything naming the conference office itself left out.
 */
export function churchKey(raw: string | undefined): string {
  const t = (raw ?? '').replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.includes('conference')) return '';
  return t.replace(/\bseventh[- ]day adventist\b/g, 'sda').replace(/\s+/g, ' ');
}

/** Live stories and distinct non-empty church values among them (trimmed, case-insensitive). Never an estimate. */
export function siteCounts(stories: PublicStory[]): { stories: number; churches: number } {
  const churches = new Set<string>();
  for (const s of stories) {
    const c = churchKey(s.data.church);
    if (c) churches.add(c);
  }
  return { stories: stories.length, churches: churches.size };
}

/** One line from the counts, or '' when there are no stories. With no church named it states the story count alone. */
export function statline(stories: PublicStory[], region = 'Iowa and Missouri'): string {
  const { stories: n, churches } = siteCounts(stories);
  if (n === 0) return '';
  const head = `${n} ${n === 1 ? 'story' : 'stories'}`;
  return churches === 0 ? `${head} across ${region}` : `${head} from ${churches} ${churches === 1 ? 'church, school or club' : 'churches, schools and clubs'} across ${region}`;
}
