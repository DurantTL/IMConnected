// Shared, import-free marker contract. A marker never carries a URL or HTML.
export interface InlineStoryPhoto { src: string; alt: string; caption?: string; focalX?: number; focalY?: number; zoom?: number; fit?: 'cover' | 'contain'; fitFill?: 'blur' | 'paper' | 'navy' }
/** Size/alignment options of an inline photo (issue #86). No option = the text column width. Lower case only. */
export const PHOTO_PLACEMENTS = ['wide', 'full', 'left', 'right'] as const;
export type PhotoPlacement = (typeof PHOTO_PLACEMENTS)[number];
export const isPhotoPlacement = (value: unknown): value is PhotoPlacement => typeof value === 'string' && (PHOTO_PLACEMENTS as readonly string[]).includes(value);
/** `{{photo N}}` or `{{photo N wide|full|left|right}}`; an unknown option is not a valid marker. */
export function parsePhotoMarker(line: string, photoCount: number): { index: number; placement?: PhotoPlacement } | null {
  const match = /^\{\{photo\s+([1-9]\d{0,2})(?:\s+(wide|full|left|right))?\}\}$/.exec(line.trim());
  const index = match ? Number(match[1]) - 1 : -1;
  return match && index >= 0 && index < photoCount ? { index, placement: match[2] as PhotoPlacement | undefined } : null;
}
export function photoMarkerIndex(line: string, photoCount: number): number | null {
  return parsePhotoMarker(line, photoCount)?.index ?? null;
}
/** Strict range grammar; all selected positions must exist and at least two photos are required. */
export function galleryMarker(line: string, photoCount: number): { indices: number[]; columns: 2 | 3 } | null {
  const m = /^\{\{gallery ([1-9]\d{0,2})-([1-9]\d{0,2}) columns=([23])\}\}$/.exec(line.trim());
  if (!m) return null;
  const first = Number(m[1]) - 1, last = Number(m[2]) - 1;
  if (first >= last || last >= photoCount) return null;
  return { indices: Array.from({ length: last - first + 1 }, (_, i) => first + i), columns: Number(m[3]) as 2 | 3 };
}
export const isMediaMarkerLine = (line: string): boolean => /^\{\{\s*(?:photo|gallery)\b[^{}\n]*\}?\}?$/.test(line.trim());
/** Derived feed/search text must not leak valid or malformed marker syntax. */
export const stripMediaMarkers = (text: string): string => text.replace(/\{\{\s*(?:photo|gallery)\b[^}\n]*(?:\}\}?|$)/gm, '');
