import type { PublicStory } from './stories';

/**
 * Homepage "From the archive" rail (issue #100).
 *
 * Where the rail's "all of the archive" link points. Issue #99 (the issues browser) switches this to '/issues/'.
 */
export const ARCHIVE_LINK = '/news/';
export const ARCHIVE_LINK_LABEL = 'Browse the archive';
/** The rail shows this many stories (phones hide the fourth in CSS) and is hidden entirely below the minimum. */
export const ARCHIVE_RAIL_SIZE = 4;
export const ARCHIVE_RAIL_MIN = 2;

// Hook for the newsletter-issue data (#98/#99): when a story knows its issue, the card can show "Issue #N" beside its date.

/** FNV-1a hash of a string, as the seed of the day's shuffle. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32: a small deterministic generator, so the same seed always gives the same sequence. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ArchiveRailOptions {
  /** The America/Chicago day (YYYY-MM-DD, `conferenceDay()`); it seeds the shuffle and anchors the window. */
  today: string;
  /** The homepage recency window in days (`HOMEPAGE_RECENT_DAYS`); only stories older than this qualify. */
  recentDays: number;
  /** Story ids already shown higher on the page; never repeated. */
  exclude?: Iterable<string>;
  count?: number;
}

/**
 * Picks the day's archive stories: live stories dated before the recency window, minus those already on the page, in a
 * deterministic shuffle seeded by the day. Candidates are sorted by id first, so the input order never matters. Stories
 * with a photo come first, and a section is repeated only once every available section has been used. Returns [] when
 * fewer than ARCHIVE_RAIL_MIN stories qualify (the block is then hidden).
 */
export function archiveRail<T extends PublicStory>(stories: T[], { today, recentDays, exclude = [], count = ARCHIVE_RAIL_SIZE }: ArchiveRailOptions): T[] {
  const [y, m, d] = today.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d - recentDays)).toISOString().slice(0, 10);
  const skip = new Set(exclude);
  const pool = stories
    .filter((s) => !skip.has(s.id) && s.data.date.toISOString().slice(0, 10) < cutoff)
    .sort((a, b) => a.id.localeCompare(b.id));
  const next = rng(seedOf(today));
  // Fisher-Yates over the id-sorted pool.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const ordered = [...pool.filter((s) => s.data.image), ...pool.filter((s) => !s.data.image)];
  const picked: T[] = [];
  const sections = new Set<string>();
  for (const s of ordered) {
    if (picked.length >= count) break;
    if (!sections.has(s.data.section)) { picked.push(s); sections.add(s.data.section); }
  }
  for (const s of ordered) {
    if (picked.length >= count) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.length >= ARCHIVE_RAIL_MIN ? picked : [];
}
