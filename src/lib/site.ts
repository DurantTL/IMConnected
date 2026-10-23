// Central site settings. Edit names, sections and links here.

export const SITE = {
  name: 'IMConnected',
  tagline: 'Stories of faith in action across Iowa and Missouri',
  publisher: 'Iowa-Missouri Conference of Seventh-day Adventists',
  publisherUrl: 'https://imsda.org',
  contactEmail: 'communication@imsda.org',
  description:
    'News, features and stories from the churches, schools and ministries of the Iowa-Missouri Conference of Seventh-day Adventists.',
};

export type SectionKey = 'news' | 'features' | 'youth' | 'kids';

export interface Section {
  key: SectionKey;
  label: string;
  /** Short label used in the nav and on cards */
  short: string;
  blurb: string;
  /** Sub-areas (shown as filter chips and their own pages) */
  areas?: { key: string; label: string }[];
  /** Can the public submit to this section? */
  submittable: boolean;
}

export const SECTIONS: Section[] = [
  {
    key: 'news',
    label: 'News',
    short: 'News',
    blurb: 'What’s happening in our conference, churches, schools and camp.',
    areas: [
      { key: 'conference', label: 'Conference' },
      { key: 'churches', label: 'Churches' },
      { key: 'schools', label: 'Schools' },
      { key: 'camp', label: 'Camp' },
    ],
    submittable: true,
  },
  {
    key: 'features',
    label: 'Features',
    short: 'Features',
    blurb: 'Longer stories, testimonies and regular voices from across the conference.',
    submittable: true,
  },
  {
    key: 'youth',
    label: 'Youth & Pathfinders',
    short: 'Youth',
    blurb: 'Youth ministry, Pathfinders and Adventurers in action.',
    areas: [
      { key: 'youth', label: 'Youth' },
      { key: 'pathfinders', label: 'Pathfinders' },
      { key: 'adventurers', label: 'Adventurers' },
    ],
    submittable: true,
  },
  {
    key: 'kids',
    label: 'Kids',
    short: 'Kids',
    blurb: 'Stories, activities and Bible lessons for younger readers.',
    submittable: true,
  },
];

/** Issue #136: the Columns section was merged into Features. Older clients, saved forms and archive files that still say "columns" are read as "features". */
export const LEGACY_SECTION_KEYS: Record<string, SectionKey> = { columns: 'features' };
export function canonicalSectionKey<T>(value: T): T | SectionKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_SECTION_KEYS, value) ? LEGACY_SECTION_KEYS[value] : value;
}

/** The same path under the section's new key (/columns/page/2/ -> /features/page/2/), or null when the first segment is not a retired section. */
export function legacySectionPath(pathname: string): string | null {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  return m && Object.prototype.hasOwnProperty.call(LEGACY_SECTION_KEYS, m[1]) ? `/${LEGACY_SECTION_KEYS[m[1]]}${m[2] ?? '/'}` : null;
}

export const SECTION_KEYS = SECTIONS.map((s) => s.key) as [SectionKey, ...SectionKey[]];

/** One primary section retains its area; additional sections only add discovery memberships. */
export function normalizeAdditionalSections(value: unknown, primary = ''): SectionKey[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((key) => typeof key !== 'string' || !SECTION_KEYS.includes(canonicalSectionKey(key) as SectionKey))) {
    throw new Error('Additional sections must be a list of valid section keys.');
  }
  const selected = new Set(value.map((key) => canonicalSectionKey(key)));
  const main = canonicalSectionKey(primary);
  return SECTION_KEYS.filter((key) => key !== main && selected.has(key));
}

export function parseAdditionalSections(value: unknown, primary = ''): SectionKey[] {
  return normalizeAdditionalSections(typeof value === 'string' ? JSON.parse(value) : value, primary);
}

export const belongsToSection = (story: { section: string; additionalSections?: string[] }, section: string) =>
  story.section === section || !!story.additionalSections?.includes(section);

/** Aliases come only from fixed SQL in this repository; values are always bound parameters. */
export const sectionMembershipSql = (prefix = '') =>
  `(${prefix}section = ? OR EXISTS (SELECT 1 FROM json_each(${prefix}additional_sections) memberships WHERE memberships.value = ?))`;

export function getSection(key: string): Section | undefined {
  return SECTIONS.find((s) => s.key === key);
}

export function areaLabel(sectionKey: string, areaKey?: string): string | undefined {
  if (!areaKey) return undefined;
  return getSection(sectionKey)?.areas?.find((a) => a.key === areaKey)?.label;
}

/** All valid section/area pairs, used to validate submissions. */
export function isValidArea(sectionKey: string, areaKey?: string): boolean {
  const s = getSection(sectionKey);
  if (!s) return false;
  if (!s.areas) return !areaKey;
  return !!areaKey && s.areas.some((a) => a.key === areaKey);
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// Issue #96: /<section>/page/<n>/ is a list page, so no area may be called "page" (it could never be reached).
if (SECTIONS.some((s) => s.areas?.some((a) => a.key === 'page'))) throw new Error('An area may not be called "page": it is reserved for paging.');
