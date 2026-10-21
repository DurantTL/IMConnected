// Reads the editor form (save and preview) into draft fields, refusing oversized values instead of cutting them.
import { FIELD_MAX, type DraftFields } from './drafts';
import { clean } from './storyfile';
import { parseStoryBlocks, storyBlocksToMarkdown } from './story-blocks';
import { DEFAULT_PHOTO_LAYOUT } from './photo-layouts';

function text(form: FormData, name: string, max: number, label: string): string {
  const v = form.get(name);
  if (v === null) return '';
  if (typeof v !== 'string') throw new Error(`${label} could not be read.`);
  if (v.length > max) throw new Error(`${label} is too long.`);
  return clean(v).replace(/\r\n?/g, '\n');
}

const line = (form: FormData, name: string, max: number, label: string) => text(form, name, max, label).replace(/\s+/g, ' ').trim();

/** Throws an Error with an editor-readable message. */
export function readDraftFields(form: FormData): { fields: DraftFields; photoAlts: Map<number, string>; layout: string | null; photoFocus: Map<number, { focalX: number; focalY: number }> } {
  const fields: DraftFields = {
    title: line(form, 'title', FIELD_MAX.title, 'The title'),
    dek: line(form, 'dek', FIELD_MAX.dek, 'The summary'),
    section: line(form, 'section', 40, 'The section'),
    area: line(form, 'area', 40, 'The category'),
    column: line(form, 'column', FIELD_MAX.short, 'The column'),
    author: line(form, 'author', FIELD_MAX.short, 'The author'),
    authorTitle: line(form, 'authorTitle', FIELD_MAX.short, 'The author title'),
    church: line(form, 'church', FIELD_MAX.short, 'The church'),
    date: line(form, 'date', 10, 'The date'),
    photoCredit: line(form, 'photoCredit', FIELD_MAX.short, 'The photo credit'),
    photoLayout: DEFAULT_PHOTO_LAYOUT, // placeholder: the real choice is `layout` below (null = the form did not send it)
    featured: form.get('featured') === '1',
    body: text(form, 'body', FIELD_MAX.body, 'The story text'),
  };
  const rawBlocks = form.get('storyBlocks');
  if (rawBlocks !== null) {
    if (typeof rawBlocks !== 'string') throw new Error('Story modules could not be read.');
    fields.storyBlocks = parseStoryBlocks(rawBlocks);
    if (fields.storyBlocks.length) fields.body = storyBlocksToMarkdown(fields.storyBlocks);
  }
  const photoFocus = new Map<number, { focalX: number; focalY: number }>();
  for (const key of form.keys()) {
    const match = /^photo_(\d{1,12})_focal[XY]$/.exec(key);
    if (!match) continue;
    const id = Number(match[1]);
    const point = { focalX: 50, focalY: 50 };
    for (const axis of ['X', 'Y'] as const) {
      const raw = form.get(`photo_${id}_focal${axis}`);
      if (typeof raw !== 'string' || !raw.trim() || !Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 100) throw new Error('Photo focus must be between 0 and 100.');
      point[`focal${axis}`] = Number(raw);
    }
    photoFocus.set(id, point);
  }
  const photoAlts = new Map<number, string>();
  for (const key of form.keys()) {
    const m = /^photo_(\d{1,12})_alt$/.exec(key);
    if (!m) continue;
    const id = Number(m[1]);
    photoAlts.set(id, line(form, key, 300, 'Photo text'));
  }
  // The photo layout is taken exactly as sent (no trimming), so " mosaic " is refused like the APIs refuse it. A form that does not
  // have the field at all (a page opened before this existed) means "keep what the draft has": null.
  const rawLayout = form.get('photoLayout');
  if (rawLayout !== null && typeof rawLayout !== 'string') throw new Error('The photo layout could not be read.');
  return { fields, photoAlts, layout: rawLayout, photoFocus };
}

export const intParam = (v: unknown): number | null => {
  const s = typeof v === 'string' ? v : '';
  return /^\d{1,16}$/.test(s) ? Number(s) : null;
};
