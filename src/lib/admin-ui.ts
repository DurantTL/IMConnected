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
  photo_moved: 'Photo order saved. Inline photo markers still point at the same photos.',
  photos_markers: 'Photo order saved. A photo gallery marker no longer covers a continuous range and was marked missing; review the inline photos.',
  photo_replaced: 'Photo replaced. Its alt text, caption, crop and place in the story were kept.',
  // 'published' is shown by the draft page itself, with a link to the story.
  published: "Published. It's live now.",
  unpublished: "Story unpublished. It's off the site now.",
};

/** Only an address that looks like an email gets a mailto: link. */
/** The message for a ?n= code, or '' for anything that is not one of ours. */
export const noticeText = (code: string | null | undefined): string => (code && Object.hasOwn(NOTICES, code) ? NOTICES[code] : '');

export const looksLikeEmail = (v: string) => /^[^\s@<>"',;:?&]+@[^\s@<>"',;:?&]+\.[^\s@<>"',;:?&]+$/.test(v);
