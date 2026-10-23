import { canonicalSectionKey, normalizeAdditionalSections } from './site';
import { normalizeAnnouncement } from './announcement';
import { storyBlockPhotos } from './story-blocks';
// Reads the editor form (save and preview) into draft fields, refusing oversized values instead of cutting them.
import { FIELD_MAX, type DraftFields } from './drafts';
import { clean } from './storyfile';
import { OWN_PHOTO_ERROR, checkStoryBlockLength, parseStoryBlocks, storyBlocksToMarkdown, photoZoom, photoFit, photoFitFill, type PhotoCrop } from './story-blocks';
import { DEFAULT_PHOTO_LAYOUT } from './photo-layouts';
import { validIssueNumber, validPosition } from './newsletter-issues';
import { KEY_POINT_LIMITS, validateKeyPoints } from './key-points';

function text(form: FormData, name: string, max: number, label: string): string {
  const v = form.get(name);
  if (v === null) return '';
  if (typeof v !== 'string') throw new Error(`${label} could not be read.`);
  if (v.length > max) throw new Error(`${label} is too long.`);
  return clean(v).replace(/\r\n?/g, '\n');
}

const line = (form: FormData, name: string, max: number, label: string) => text(form, name, max, label).replace(/\s+/g, ' ').trim();

/** Throws an Error with an editor-readable message. */
export function readDraftFields(form: FormData): { fields: DraftFields; photoAlts: Map<number, string>; layout: string | null; photoFocus: Map<number, PhotoCrop>; photoCaptions: Map<number, string> } {
  const fields: DraftFields = {
    title: line(form, 'title', FIELD_MAX.title, 'The title'),
    dek: line(form, 'dek', FIELD_MAX.dek, 'The summary'),
    section: canonicalSectionKey(line(form, 'section', 40, 'The section')),
    area: line(form, 'area', 40, 'The category'),
    column: '', // issue #136: column names are retired; a column field in an old form is ignored
    author: line(form, 'author', FIELD_MAX.short, 'The author'),
    authorTitle: line(form, 'authorTitle', FIELD_MAX.short, 'The author title'),
    church: line(form, 'church', FIELD_MAX.short, 'The church'),
    date: line(form, 'date', 10, 'The date'),
    photoCredit: line(form, 'photoCredit', FIELD_MAX.short, 'The photo credit'),
    photoLayout: DEFAULT_PHOTO_LAYOUT, // placeholder: the real choice is `layout` below (null = the form did not send it)
    featured: form.get('featured') === '1',
    body: text(form, 'body', FIELD_MAX.body, 'The story text'),
  };
  if (form.has('additionalSectionsPresent')) fields.additionalSections = normalizeAdditionalSections(form.getAll('additionalSections'), fields.section);
  // The Settings tab's Newsletter issue picker. A form without the marker (an older page) keeps what the draft has.
  if (form.has('newsletterIssuePresent')) {
    const rawIssue = String(form.get('newsletterIssue') ?? '').trim();
    if (!rawIssue) fields.newsletterIssue = null;
    else {
      const number = /^\d{1,4}$/.test(rawIssue) ? Number(rawIssue) : NaN;
      if (!validIssueNumber(number)) throw new Error('Choose one of the listed newsletter issues.');
      const rawPosition = String(form.get('newsletterPosition') ?? '').trim();
      const position = rawPosition ? (/^\d{1,4}$/.test(rawPosition) ? Number(rawPosition) : NaN) : null;
      if (position !== null && !validPosition(position)) throw new Error('The position in the issue must be a whole number from 1 to 999.');
      fields.newsletterIssue = { number, position };
    }
  }
  // The Settings tab's Key points (issue #117): three optional one-line inputs. A form without the marker keeps what the draft has.
  if (form.has('keyPointsPresent')) {
    const raw = [0, 1, 2].map((i) => form.get(`keyPoint${i}`)).map((v) => (typeof v === 'string' ? v : ''));
    if (raw.some((v) => v.length > KEY_POINT_LIMITS.length * 2)) throw new Error(`A key point is longer than ${KEY_POINT_LIMITS.length} characters.`);
    try { fields.keyPoints = validateKeyPoints(raw); } catch (e) { throw new Error((e as Error).message); }
  }
  if (form.has('announcementKind')) {
    const kind = line(form, 'announcementKind', 20, 'Content type');
    if (kind === 'story') fields.announcement = null;
    else {
      const links = [0, 1, 2].map((i) => ({ label: line(form, `announcementLink${i}Label`, 120, 'Link label'), url: line(form, `announcementLink${i}Url`, 2048, 'Link address') })).filter((p) => p.label || p.url);
      fields.announcement = normalizeAnnouncement({ kind, eventDate: line(form, 'eventDate', 10, 'Event date'), location: line(form, 'eventLocation', 200, 'Location'), videoUrl: line(form, 'announcementVideo', 2048, 'Video address'), links });
    }
  }
  const rawBlocks = form.get('storyBlocks');
  if (rawBlocks !== null) {
    if (typeof rawBlocks !== 'string') throw new Error('Story modules could not be read.');
    fields.storyBlocks = parseStoryBlocks(rawBlocks);
    // A draft's image modules point at the draft's own uploaded photos by ID. An address (any address) is never accepted from a form.
    if (storyBlockPhotos(fields.storyBlocks).some((b) => b.url)) throw new Error(OWN_PHOTO_ERROR);
    if (fields.storyBlocks.length) {
      const projection = storyBlocksToMarkdown(fields.storyBlocks);
      // The modules own the text. Without JavaScript the Markdown box could still be edited, and that edit would be silently dropped: refuse it.
      if (form.get('body') !== null && fields.body.trim() !== clean(projection).trim()) { // a client that sends no Markdown box edited nothing there
        throw new Error('This story is built from modules, so its text is edited in the modules, which need JavaScript. Your change to the Markdown box was not saved. Open the editor with JavaScript turned on to edit the text of this story.');
      }
      checkStoryBlockLength(fields.storyBlocks);
      fields.body = projection;
    }
  }
  const photoFocus = new Map<number, PhotoCrop>();
  for (const key of form.keys()) {
    const match = /^photo_(\d{1,12})_(focal[XY]|zoom)$/.exec(key);
    if (!match) continue;
    const id = Number(match[1]);
    const name = match[2] as keyof PhotoCrop;
    const raw = form.get(key);
    if (typeof raw !== 'string' || !raw.trim() || !Number.isFinite(Number(raw))) throw new Error(name === 'zoom' ? 'Photo zoom must be between 100% and 300%.' : 'Photo focus must be between 0 and 100.');
    const point = photoFocus.get(id) ?? {};
    if (name === 'zoom') point.zoom = photoZoom(Number(raw));
    else {
      if (Number(raw) < 0 || Number(raw) > 100) throw new Error('Photo focus must be between 0 and 100.');
      point[name] = Number(raw);
    }
    photoFocus.set(id, point);
  }
  // Fit whole photo. The editor sends a hidden "cover" before its checkbox (value "contain"), so the LAST value wins and an unchecked
  // box still means cover; a form that has neither field (an older page) preserves what the draft has.
  for (const key of form.keys()) {
    const match = /^photo_(\d{1,12})_(fit|fitFill)$/.exec(key);
    if (!match) continue;
    const id = Number(match[1]);
    const raw = form.getAll(key).at(-1);
    const point = photoFocus.get(id) ?? {};
    if (match[2] === 'fit') point.fit = photoFit(raw);
    else point.fitFill = photoFitFill(raw);
    photoFocus.set(id, point);
  }
  const photoAlts = new Map<number, string>();
  for (const key of form.keys()) {
    const m = /^photo_(\d{1,12})_alt$/.exec(key);
    if (!m) continue;
    const id = Number(m[1]);
    photoAlts.set(id, line(form, key, 300, 'Photo text'));
  }
  // Captions (issue #84): visible text under a photo, one line of plain text up to 300 characters. A photo without the field keeps its caption.
  const photoCaptions = new Map<number, string>();
  for (const key of form.keys()) {
    const m = /^photo_(\d{1,12})_caption$/.exec(key);
    if (m) photoCaptions.set(Number(m[1]), line(form, key, 300, 'The photo caption'));
  }
  // The photo layout is taken exactly as sent (no trimming), so " mosaic " is refused like the APIs refuse it. A form that does not
  // have the field at all (a page opened before this existed) means "keep what the draft has": null.
  const rawLayout = form.get('photoLayout');
  if (rawLayout !== null && typeof rawLayout !== 'string') throw new Error('The photo layout could not be read.');
  return { fields, photoAlts, layout: rawLayout, photoFocus, photoCaptions };
}

export const intParam = (v: unknown): number | null => {
  const s = typeof v === 'string' ? v : '';
  return /^\d{1,16}$/.test(s) ? Number(s) : null;
};
