// Small display helpers for the drafts pages.
import { getSection, areaLabel } from './site';

/** "Oct 19, 2026, 14:05 UTC". The page script swaps in the viewer's own time zone. */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC';
}

export const sectionLabel = (key: string, area?: string) => {
  const sec = getSection(key)?.label ?? key;
  const a = areaLabel(key, area);
  return a ? `${sec} · ${a}` : sec;
};

/** Messages for the fixed ?n= codes the action routes redirect with. */
export const NOTICES: Record<string, string> = {
  rejected: 'Draft rejected. Its photos are kept for 30 days.',
  restored: 'Draft restored to In review.',
  uploaded: 'Photos uploaded.',
  photos: 'Photos updated.',
  unpublished: 'Story unpublished. It will disappear from the site in about 3–5 minutes.',
};

/** Only an address that looks like an email gets a mailto: link. */
export const looksLikeEmail = (v: string) => /^[^\s@<>"',;:?&]+@[^\s@<>"',;:?&]+\.[^\s@<>"',;:?&]+$/.test(v);
