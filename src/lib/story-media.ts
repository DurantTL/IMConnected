// Shared, import-free marker contract. A marker never carries a URL or HTML.
export interface InlineStoryPhoto { src: string; alt: string; focalX?: number; focalY?: number; zoom?: number }
export function photoMarkerIndex(line: string, photoCount: number): number | null {
  const match = /^\{\{photo\s+([1-9]\d{0,2})\}\}$/.exec(line.trim());
  const index = match ? Number(match[1]) - 1 : -1;
  return index >= 0 && index < photoCount ? index : null;
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
