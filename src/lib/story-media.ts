// Shared, import-free marker contract. A marker never carries a URL or HTML.
export interface InlineStoryPhoto { src: string; alt: string; focalX?: number; focalY?: number; zoom?: number }
export function photoMarkerIndex(line: string, photoCount: number): number | null {
  const match = /^\{\{photo\s+([1-9]\d{0,2})\}\}$/.exec(line.trim());
  const index = match ? Number(match[1]) - 1 : -1;
  return index >= 0 && index < photoCount ? index : null;
}
export const isMediaMarkerLine = (line: string): boolean => /^\{\{\s*(?:photo|gallery)\b[^{}\n]*\}?\}?$/.test(line.trim());
/** Derived feed/search text must not leak valid or malformed marker syntax. */
export const stripMediaMarkers = (text: string): string => text.replace(/\{\{\s*(?:photo|gallery)\b[^}\n]*(?:\}\}?|$)/gm, '');
