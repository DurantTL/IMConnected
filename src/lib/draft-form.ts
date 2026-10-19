// Reads the editor form (save and preview) into draft fields, refusing oversized values instead of cutting them.
import { FIELD_MAX, type DraftFields } from './drafts';
import { clean } from './storyfile';

function text(form: FormData, name: string, max: number, label: string): string {
  const v = form.get(name);
  if (v === null) return '';
  if (typeof v !== 'string') throw new Error(`${label} could not be read.`);
  if (v.length > max) throw new Error(`${label} is too long.`);
  return clean(v).replace(/\r\n?/g, '\n');
}

const line = (form: FormData, name: string, max: number, label: string) => text(form, name, max, label).replace(/\s+/g, ' ').trim();

/** Throws an Error with an editor-readable message. */
export function readDraftFields(form: FormData): { fields: DraftFields; photoMeta: Map<number, { alt: string; caption: string }> } {
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
    featured: form.get('featured') === '1',
    body: text(form, 'body', FIELD_MAX.body, 'The story text'),
  };
  const photoMeta = new Map<number, { alt: string; caption: string }>();
  for (const key of form.keys()) {
    const m = /^photo_(\d{1,12})_alt$/.exec(key);
    if (!m) continue;
    const id = Number(m[1]);
    photoMeta.set(id, { alt: line(form, key, 300, 'Photo text'), caption: line(form, `photo_${id}_caption`, 300, 'Photo text') });
  }
  return { fields, photoMeta };
}

export const intParam = (v: unknown): number | null => {
  const s = typeof v === 'string' ? v : '';
  return /^\d{1,16}$/.test(s) ? Number(s) : null;
};
