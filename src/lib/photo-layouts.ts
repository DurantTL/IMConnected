// How a story's photos are arranged on its page (issue #35). The values and labels match the story block layouts of
// IMConnected Studio, so a story published from a newsletter looks like the email. Pure functions: no I/O, safe to use
// from pages, components, the editor and the API validators alike.

export const PHOTO_LAYOUTS = [
  { value: 'one', label: 'One hero', hint: 'One large lead photo; any others in a row under the text.' },
  { value: 'twoUp', label: 'Two up', hint: 'The first two photos side by side.' },
  { value: 'heroGrid', label: 'Hero + grid', hint: 'One large photo, then the next two side by side.' },
  { value: 'mosaic', label: 'Mosaic', hint: 'All photos in rows of two.' },
  { value: 'stack', label: 'Stack', hint: 'All photos one under another.' },
] as const;

export type PhotoLayout = (typeof PHOTO_LAYOUTS)[number]['value'];

/** The look every story had before layouts existed. A story without a layout uses it. */
export const DEFAULT_PHOTO_LAYOUT: PhotoLayout = 'one';

export const PHOTO_LAYOUT_VALUES: readonly string[] = PHOTO_LAYOUTS.map((l) => l.value);

export function isPhotoLayout(v: unknown): v is PhotoLayout {
  return typeof v === 'string' && PHOTO_LAYOUT_VALUES.includes(v);
}

/** A stored or submitted value as a layout; anything unknown or missing is the default. */
export function photoLayoutOrDefault(v: unknown): PhotoLayout {
  return isPhotoLayout(v) ? v : DEFAULT_PHOTO_LAYOUT;
}

/** One row of a laid-out set of photos: `hero` and `wide` are one photo across the full width, `pair` is two side by side. */
export interface PhotoRow {
  kind: 'hero' | 'wide' | 'pair';
  /** Indexes into the story's photo list (lead first). */
  photos: number[];
}

export interface PhotoPlan {
  /** 'plain' is today's look: the lead photo above the text and the rest in a row under it. */
  mode: 'plain' | 'layout';
  rows: PhotoRow[];
  /** Photos the layout has no place for; they go in the plain row under the text so none is lost. */
  rest: number[];
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

/**
 * Which photo goes where for `count` photos (the lead plus the others). Fewer photos than a layout needs degrade
 * gracefully: with a single photo every layout is the plain look, and a layout never leaves a gap.
 */
export function planPhotos(layout: PhotoLayout, count: number): PhotoPlan {
  if (layout === 'one' || count < 2) return { mode: 'plain', rows: [], rest: [] };
  const pairsFrom = (from: number, to: number): PhotoRow[] => {
    const rows: PhotoRow[] = [];
    for (let i = from; i < to; i += 2) rows.push(i + 1 < to ? { kind: 'pair', photos: [i, i + 1] } : { kind: 'wide', photos: [i] });
    return rows;
  };
  switch (layout) {
    case 'twoUp':
      return { mode: 'layout', rows: [{ kind: 'pair', photos: [0, 1] }], rest: range(2, count) };
    case 'heroGrid': {
      const grid = Math.min(count, 3);
      return { mode: 'layout', rows: [{ kind: 'hero', photos: [0] }, ...pairsFrom(1, grid)], rest: range(3, count) };
    }
    case 'mosaic':
      return { mode: 'layout', rows: pairsFrom(0, count), rest: [] };
    case 'stack':
      return { mode: 'layout', rows: range(0, count).map((i) => ({ kind: 'wide' as const, photos: [i] })), rest: [] };
  }
}
