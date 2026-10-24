// Home page layout (issue #155, migration 037): an ordered list of blocks, each shown or hidden; section rails also name a
// section from site.ts (section definitions stay there). Pure rules only; homepage-layout-store.ts reads and saves.
import { SECTIONS, canonicalSectionKey, getSection } from './site.ts';

/** The fixed blocks, in today's page order. Rails (`rail-<id>`) are the only repeatable blocks. */
export const FIXED_BLOCKS = ['intro', 'spotlight', 'featured', 'hero', 'latest_issue', 'topics', 'community', 'archive', 'cta'] as const;
export type FixedBlockKey = typeof FIXED_BLOCKS[number];
export interface HomepageBlock { key: string; visible: boolean; section?: string }
export interface HomepageLayout { version: number; blocks: HomepageBlock[] }
export const RAIL_LIMIT = 8;
export const RAIL_KEY = /^rail-[a-z0-9]{1,16}$/;
export const isRailKey = (key: string) => RAIL_KEY.test(key);

/** Admin-facing names and one-line descriptions of the fixed blocks. */
export const BLOCK_INFO: Record<FixedBlockKey, { label: string; note: string }> = {
  intro: { label: 'Introduction', note: 'The page title, tagline and story count.' },
  spotlight: { label: 'Event spotlight', note: 'Upcoming events and announcements (shown only when there are some).' },
  featured: { label: 'Featured story panel', note: 'The newest featured story. When hidden, that story can appear in the top stories and rails instead.' },
  hero: { label: 'Top stories', note: 'The lead story and the latest list.' },
  latest_issue: { label: 'Latest newsletter issue', note: 'Previews of the newest issue (shown only when there is one).' },
  topics: { label: 'Section directory', note: 'The “Find your next story” links with story counts.' },
  community: { label: 'Across the Conference', note: 'The News areas side by side.' },
  archive: { label: 'From the archive', note: 'Older stories (shown only when there are enough).' },
  cta: { label: 'Submit a story', note: 'The call to action at the end of the page.' },
};

/** Home page copy for a rail's “more” link; any other section gets a generic one. */
const RAIL_MORE: Record<string, string> = { features: 'All features', youth: 'More youth news', kids: 'More for kids' };
export const railMoreLabel = (section: string) => RAIL_MORE[section] ?? `More ${getSection(section)?.short ?? 'stories'}`;
/** Rails that skip the stories already shown in the hero (today's behaviour: Kids never did). */
export const railSkipsShown = (section: string) => section !== 'kids';

export function defaultBlocks(): HomepageBlock[] {
  return [
    { key: 'intro', visible: true }, { key: 'spotlight', visible: true }, { key: 'featured', visible: true }, { key: 'hero', visible: true },
    { key: 'latest_issue', visible: true }, { key: 'topics', visible: true },
    { key: 'rail-features', visible: true, section: 'features' }, { key: 'community', visible: true },
    { key: 'rail-youth', visible: true, section: 'youth' }, { key: 'rail-kids', visible: true, section: 'kids' },
    { key: 'archive', visible: true }, { key: 'cta', visible: true },
  ];
}
export const defaultLayout = (): HomepageLayout => ({ version: 0, blocks: defaultBlocks() });

export const newRailKey = (taken: Set<string>): string => {
  let key: string;
  do { key = `rail-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`; } while (taken.has(key));
  return key;
};

/** Add every fixed block that is missing, visible, right after the block that precedes it in the default order. */
function fillMissing(blocks: HomepageBlock[]): HomepageBlock[] {
  const out = [...blocks];
  FIXED_BLOCKS.forEach((key, i) => {
    if (out.some((b) => b.key === key)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const p = out.findIndex((b) => b.key === FIXED_BLOCKS[j]); if (p >= 0) { at = p + 1; break; } }
    out.splice(at, 0, { key, visible: true });
  });
  return out;
}

/** Strict: for saving. Refuses anything unknown, repeated, over the rail limit, or with an invalid section. Missing fixed blocks are added. */
export function normalizeHomepageBlocks(value: unknown): HomepageBlock[] {
  if (!Array.isArray(value) || value.length > FIXED_BLOCKS.length + RAIL_LIMIT) throw new Error('The home page layout could not be read.');
  const seen = new Set<string>(); let rails = 0;
  const blocks = value.map((raw): HomepageBlock => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each home page block needs a key.');
    const r = raw as Record<string, unknown>;
    if (typeof r.key !== 'string' || seen.has(r.key)) throw new Error('Each home page block must be known and appear once.');
    if (typeof r.visible !== 'boolean') throw new Error('Choose whether each block is shown.');
    seen.add(r.key);
    if (isRailKey(r.key)) {
      if (++rails > RAIL_LIMIT) throw new Error(`Use at most ${RAIL_LIMIT} section rails.`);
      const section = canonicalSectionKey(r.section);
      if (typeof section !== 'string' || !SECTIONS.some((s) => s.key === section)) throw new Error('Choose a valid section for each rail.');
      return { key: r.key, visible: r.visible, section };
    }
    if (!(FIXED_BLOCKS as readonly string[]).includes(r.key)) throw new Error('Each home page block must be known and appear once.');
    return { key: r.key, visible: r.visible };
  });
  const full = fillMissing(blocks);
  if (!full.some((b) => b.visible)) throw new Error('Keep at least one home page block shown.');
  return full;
}

/** Lenient: for reading stored data. Drops unknown, repeated or invalid blocks and restores missing fixed ones; never throws. */
export function readableHomepageBlocks(value: unknown): HomepageBlock[] {
  if (!Array.isArray(value)) return defaultBlocks();
  const seen = new Set<string>(), kept: HomepageBlock[] = []; let rails = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.key !== 'string' || seen.has(r.key) || typeof r.visible !== 'boolean') continue;
    if (isRailKey(r.key)) {
      const section = canonicalSectionKey(r.section);
      if (typeof section !== 'string' || !SECTIONS.some((s) => s.key === section) || rails >= RAIL_LIMIT) continue;
      rails++; seen.add(r.key); kept.push({ key: r.key, visible: r.visible, section });
    } else if ((FIXED_BLOCKS as readonly string[]).includes(r.key)) { seen.add(r.key); kept.push({ key: r.key, visible: r.visible }); }
  }
  const full = fillMissing(kept);
  return full.some((b) => b.visible) ? full : defaultBlocks();
}
