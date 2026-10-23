// The /issues/ browser (issue #99): live stories grouped by the newsletter issue they first appeared in (issue #98).
// Pure array and string work, shared by the two routes and the page cache key. The issue's own date and title travel with each
// public story (newsletterIssue.date / .title, joined from newsletter_issues), so no extra database read is needed here.
import type { PublicStory } from './stories';

/** Stories shown per issue on the /issues/ list. */
export const PREVIEW_COUNT = 3;

/** A canonical issue number ("12", never "0", "012", "+12", "1e1" or a number above 9999), or null. Bounded so a cache key can't be absurd. */
export function parseIssueNumber(raw: string | undefined): number | null {
  return raw !== undefined && /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : null;
}

export const issueHref = (n: number): string => `/issues/${n}/`;

export interface IssueGroup {
  number: number;
  /** The day it was sent, YYYY-MM-DD. */
  date: string;
  title: string;
  /** Live stories: newsletter order (position ascending), then stories without a position in the input (newest first) order. */
  stories: PublicStory[];
}

/** Group live stories by issue number, newest issue (highest number) first. Issues with no story do not appear at all. */
export function groupByIssue(stories: PublicStory[]): IssueGroup[] {
  const groups = new Map<number, IssueGroup>();
  for (const s of stories) {
    const ref = s.data.newsletterIssue;
    if (!ref || !ref.date) continue;
    const g = groups.get(ref.number) ?? { number: ref.number, date: ref.date, title: ref.title ?? '', stories: [] };
    g.stories.push(s);
    groups.set(ref.number, g);
  }
  const pos = (s: PublicStory) => s.data.newsletterIssue?.position ?? Infinity;
  for (const g of groups.values()) g.stories = g.stories.map((s, i) => ({ s, i })).sort((a, b) => pos(a.s) - pos(b.s) || a.i - b.i).map((x) => x.s);
  return [...groups.values()].sort((a, b) => b.number - a.number);
}

/** The neighbours of issue `n` among the listed issues: `older` has the next lower number, `newer` the next higher. */
export function neighbours(groups: IssueGroup[], n: number): { older: IssueGroup | null; newer: IssueGroup | null } {
  const i = groups.findIndex((g) => g.number === n); // newest first
  return { newer: i > 0 ? groups[i - 1] : null, older: i >= 0 && i < groups.length - 1 ? groups[i + 1] : null };
}
