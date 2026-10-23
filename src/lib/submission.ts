// Parses and validates a submit-form payload; the story becomes a dashboard draft (src/lib/drafts.ts).
import { getSection, isValidArea } from './site';
import { LIMITS } from './limits';
import { normalizeAnnouncement, type Announcement } from './announcement';
import { conferenceDay } from './event-spotlight';
export { sniffImage } from './image-formats.mjs';

export interface Submission {
  /** What the visitor is sending (issue #123). Only an announcement or event carries `announcement`. */
  kind: 'story' | 'announcement' | 'event';
  announcement: Announcement | null;
  name: string;
  email: string;
  phone: string;
  church: string;
  section: string;
  area?: string;
  title: string;
  dek: string;
  body: string;
  /** The no-JavaScript single caption field: it becomes the caption of the first photo. */
  caption: string;
  photoCredit: string;
  photos: File[];
  /** Per photo, in the order chosen: a visible caption and alt text (issue #122). Both one line of plain text. */
  photoTexts: { caption: string; alt: string }[];
}

/** One line of plain text: control characters removed, whitespace (including newlines) collapsed. Too long is an error, never cut. */
function oneLine(fd: FormData, k: string, label: string): string {
  const raw = fd.get(k);
  if (raw === null || typeof raw !== 'string') return '';
  const v = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (v.length > LIMITS.photoText) throw new ValidationError(`${label} is too long. Please keep it to ${LIMITS.photoText} characters or fewer.`);
  return v;
}

export class ValidationError extends Error {}

const str = (fd: FormData, k: string, max: number) => String(fd.get(k) ?? '').trim().slice(0, max);
/** Plain text on one line (control characters, C1 and U+2028/2029 become spaces, whitespace collapsed); no length cut. */
const cleanLine = (v: unknown) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

export function parseSubmission(fd: FormData): Submission {
  const rawKind = str(fd, 'kind', 20) || 'story';
  if (rawKind !== 'story' && rawKind !== 'announcement' && rawKind !== 'event') throw new ValidationError('Please choose what you are sending: a story, an announcement or an event.');
  const s: Submission = {
    kind: rawKind,
    announcement: null,
    name: str(fd, 'name', 120),
    email: str(fd, 'email', 200),
    phone: str(fd, 'phone', 40),
    church: str(fd, 'church', 160),
    section: str(fd, 'section', 40),
    area: str(fd, 'area', 40) || undefined,
    title: str(fd, 'title', LIMITS.title),
    dek: str(fd, 'dek', LIMITS.dek),
    body: String(fd.get('body') ?? '').trim(),
    caption: '',
    photoCredit: str(fd, 'photoCredit', 120),
    photos: fd.getAll('photos').filter((p): p is File => p instanceof File && p.size > 0),
    photoTexts: [],
  };
  s.caption = oneLine(fd, 'caption', 'The photo caption');

  if (!s.name || !s.email || !s.church || !s.title || !s.body) throw new ValidationError('Please fill in all required fields.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) throw new ValidationError('Please enter a valid email address.');
  const section = getSection(s.section);
  if (!section || !section.submittable) throw new ValidationError('Please choose a section.');
  if (!isValidArea(s.section, s.area)) throw new ValidationError('Please choose a category for this section.');
  const noun = s.kind === 'story' ? 'story' : s.kind === 'event' ? 'event details' : 'announcement';
  const min = s.kind === 'story' ? LIMITS.bodyMin : LIMITS.bodyMinNotice;
  if (s.body.length < min) throw new ValidationError(`Your ${noun} ${noun === 'event details' ? 'are' : 'is'} a little short — please write at least ${min} characters.`);
  if (s.body.length > LIMITS.bodyMax) throw new ValidationError(`Your ${noun} ${noun === 'event details' ? 'are' : 'is'} too long for the form. Please email it to us instead.`);
  if (s.kind !== 'story') {
    // A typed announcement (src/lib/announcement.ts decides what is valid). Links and video stay editor-only, and the
    // event fields are ignored for a plain announcement, so a story or announcement can never carry them.
    const eventDate = s.kind === 'event' ? String(fd.get('eventDate') ?? '').trim() : '';
    const location = s.kind === 'event' ? cleanLine(fd.get('location')) : '';
    if (s.kind === 'event') {
      if (!eventDate) throw new ValidationError('Please enter the date of your event.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new ValidationError('Please enter the event date as a real date, like 2026-11-14.');
      if (location.length > 200) throw new ValidationError('The location is too long. Please keep it under 200 characters.');
    }
    try {
      s.announcement = normalizeAnnouncement({ kind: s.kind, ...(eventDate ? { eventDate } : {}), ...(location ? { location } : {}) });
    } catch (e) {
      throw new ValidationError(e instanceof Error && /date/i.test(e.message) ? 'Please enter the event date as a real date, like 2026-11-14.' : 'Please check the event details and try again.');
    }
    if (eventDate && eventDate < conferenceDay()) throw new ValidationError('The event date has already passed. Please choose today or a later date.');
  }
  if (fd.get('consent') !== 'yes') throw new ValidationError('Please check the permission box.');
  if (s.photos.length > LIMITS.maxPhotos) throw new ValidationError(`Please upload up to ${LIMITS.maxPhotos} photos.`);
  for (const p of s.photos) {
    if (p.size > LIMITS.maxPhotoMB * 1024 * 1024) throw new ValidationError(`"${p.name}" is larger than ${LIMITS.maxPhotoMB} MB.`);
  }
  // Per-photo fields caption_0..caption_5 and alt_0..alt_5 (the order the photos were chosen). A form without them (no JavaScript)
  // has the single caption field, which captions the first photo and never becomes alt text.
  s.photoTexts = s.photos.map((_, i) => ({
    caption: fd.has(`caption_${i}`) ? oneLine(fd, `caption_${i}`, `The caption for photo ${i + 1}`) : i === 0 ? s.caption : '',
    alt: oneLine(fd, `alt_${i}`, `The description for photo ${i + 1}`),
  }));
  return s;
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'story';
}

/**
 * Plain text from the form → safe Markdown.
 * HTML is escaped (Astro renders raw HTML inside .md files) and link syntax is neutralised,
 * so a submission can't inject scripts or links. Editors can add formatting in review.
 */
export function textToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\[\]]/g, (m) => '\\' + m)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

