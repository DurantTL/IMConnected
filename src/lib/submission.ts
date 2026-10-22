// Parses and validates a submit-form payload; the story becomes a dashboard draft (src/lib/drafts.ts).
import { getSection, isValidArea } from './site';
import { LIMITS } from './limits';
export { sniffImage } from './image-formats.mjs';

export interface Submission {
  name: string;
  email: string;
  phone: string;
  church: string;
  section: string;
  area?: string;
  title: string;
  dek: string;
  body: string;
  caption: string;
  photoCredit: string;
  photos: File[];
}

export class ValidationError extends Error {}

const str = (fd: FormData, k: string, max: number) => String(fd.get(k) ?? '').trim().slice(0, max);

export function parseSubmission(fd: FormData): Submission {
  const s: Submission = {
    name: str(fd, 'name', 120),
    email: str(fd, 'email', 200),
    phone: str(fd, 'phone', 40),
    church: str(fd, 'church', 160),
    section: str(fd, 'section', 40),
    area: str(fd, 'area', 40) || undefined,
    title: str(fd, 'title', LIMITS.title),
    dek: str(fd, 'dek', LIMITS.dek),
    body: String(fd.get('body') ?? '').trim(),
    caption: str(fd, 'caption', 300),
    photoCredit: str(fd, 'photoCredit', 120),
    photos: fd.getAll('photos').filter((p): p is File => p instanceof File && p.size > 0),
  };

  if (!s.name || !s.email || !s.church || !s.title || !s.body) throw new ValidationError('Please fill in all required fields.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) throw new ValidationError('Please enter a valid email address.');
  const section = getSection(s.section);
  if (!section || !section.submittable) throw new ValidationError('Please choose a section.');
  if (!isValidArea(s.section, s.area)) throw new ValidationError('Please choose a category for this section.');
  if (s.body.length < LIMITS.bodyMin) throw new ValidationError(`Your story is a little short — please write at least ${LIMITS.bodyMin} characters.`);
  if (s.body.length > LIMITS.bodyMax) throw new ValidationError('Your story is too long for the form. Please email it to us instead.');
  if (fd.get('consent') !== 'yes') throw new ValidationError('Please check the permission box.');
  if (s.photos.length > LIMITS.maxPhotos) throw new ValidationError(`Please upload up to ${LIMITS.maxPhotos} photos.`);
  for (const p of s.photos) {
    if (p.size > LIMITS.maxPhotoMB * 1024 * 1024) throw new ValidationError(`"${p.name}" is larger than ${LIMITS.maxPhotoMB} MB.`);
  }
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

