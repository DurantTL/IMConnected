// Turns a submit-form payload into a Markdown story + photo files.
import { getSection, isValidArea } from './site';
import { LIMITS } from './limits';
import type { NewFile } from './github';

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

/** Detect image type from magic bytes — never trust the browser-sent MIME type. */
export function sniffImage(buf: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  const ascii = (a: number, b: number) => String.fromCharCode(...buf.slice(a, b));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
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

const yaml = (v: string) => JSON.stringify(v); // JSON strings are valid YAML double-quoted scalars

export async function buildFiles(s: Submission, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  const slug = `${date}-${slugify(s.title)}-${rand}`;

  const files: NewFile[] = [];
  const photoPaths: string[] = [];
  for (const [i, p] of s.photos.entries()) {
    const bytes = new Uint8Array(await p.arrayBuffer());
    const ext = sniffImage(bytes);
    if (!ext) throw new ValidationError(`"${p.name}" isn't a JPG, PNG or WebP image.`);
    const publicPath = `/images/stories/${slug}/photo-${i + 1}.${ext}`;
    photoPaths.push(publicPath);
    files.push({ path: `public${publicPath}`, content: Buffer.from(bytes).toString('base64'), encoding: 'base64' });
  }

  const fm: string[] = [
    '---',
    `title: ${yaml(s.title)}`,
    ...(s.dek ? [`dek: ${yaml(s.dek)}`] : []),
    `section: ${s.section}`,
    ...(s.area ? [`area: ${s.area}`] : []),
    `author: ${yaml(s.name)}`,
    `church: ${yaml(s.church)}`,
    `date: ${date}`,
    ...(photoPaths[0] ? [`image: ${yaml(photoPaths[0])}`, `imageAlt: ${yaml(s.caption || s.title)}`] : []),
    ...(s.photoCredit ? [`photoCredit: ${yaml(s.photoCredit)}`] : []),
    ...(photoPaths.length > 1 ? ['photos:', ...photoPaths.slice(1).map((p) => `  - ${yaml(p)}`)] : []),
    'featured: false',
    'draft: false',
    '---',
    '',
  ];
  const md = fm.join('\n') + textToMarkdown(s.body) + '\n';
  files.unshift({ path: `src/content/stories/${slug}.md`, content: md, encoding: 'utf-8' });

  return { slug, files, photoCount: photoPaths.length };
}

/** Email verification line for the PR body, e.g. "unverified (confirmation sent)". */
export const EMAIL_PENDING = 'unverified (confirmation pending)';
export const emailSent = 'unverified (confirmation sent)';
export const emailNotSent = (reason: string) => `unverified (not sent: ${reason})`;

export function prBody(s: Submission, slug: string, photoCount: number, emailStatus: string = EMAIL_PENDING): string {
  const section = getSection(s.section);
  const area = section?.areas?.find((a) => a.key === s.area)?.label;
  const words = s.body.split(/\s+/).filter(Boolean).length;
  const esc = (v: string) => v.replace(/\|/g, '\\|').replace(/[<>]/g, '');
  return [
    `## New story submission`,
    '',
    `| | |`,
    `|---|---|`,
    `| **Submitted by** | ${esc(s.name)} |`,
    `| **Email** | ${esc(s.email)} |`,
    `| **Email status** | ${esc(emailStatus)} |`,
    ...(s.phone ? [`| **Phone** | ${esc(s.phone)} |`] : []),
    `| **Church / school / club** | ${esc(s.church)} |`,
    `| **Section** | ${section?.label}${area ? ` → ${area}` : ''} |`,
    `| **Length** | ${words} words |`,
    `| **Photos** | ${photoCount} |`,
    ...(s.caption ? [`| **Caption** | ${esc(s.caption)} |`] : []),
    ...(s.photoCredit ? [`| **Photo credit** | ${esc(s.photoCredit)} |`] : []),
    '',
    `Story file: \`src/content/stories/${slug}.md\``,
    '',
    '### Editor checklist',
    '- [ ] Headline and summary (`dek`) are clear',
    '- [ ] Lead paragraph covers who, what, when, where, why',
    '- [ ] Names, titles and SDA terms are correct',
    '- [ ] Photos are appropriate and permission is confirmed',
    '- [ ] Set `featured: true` if it should appear at the top of the home page',
    '',
    '**Merge to publish. Close to reject.**',
    '',
    '_The submitter confirmed accuracy and photo/name permission on the form._',
  ].join('\n');
}
