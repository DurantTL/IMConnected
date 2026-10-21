// Shared by /api/publish (Studio) and the /admin story editor: how a story's Markdown file is written.
// One place for the frontmatter order, the quoting rules and the body safety escape.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** A string with control characters removed; anything that is not a string becomes ''. */
export const clean = (v: unknown) => (typeof v === 'string' ? v.replace(CONTROL, '') : '');

/**
 * A YAML double-quoted scalar. JSON strings are valid YAML, and < > are written as \u003c \u003e so a
 * title can never put a literal tag into the committed file (YAML reads them back as < and >).
 */
export const yaml = (v: string) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

export function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface PhotoMeta {
  alt: string;
  caption: string;
}

/**
 * Lead image fields: a caption that starts with "Photo:" is a credit; otherwise the alt text is the
 * alt, then the caption, then the title.
 */
export function leadImageFields(photo: PhotoMeta, title: string, explicitCredit = ''): { alt: string; credit: string } {
  const captionCredit = /^photo:/i.test(photo.caption) ? photo.caption.replace(/^photo:\s*/i, '').trim() : '';
  const credit = explicitCredit.trim() || captionCredit;
  const alt = photo.alt || (credit ? '' : photo.caption) || title;
  return { alt, credit };
}

export interface StoryFrontmatter {
  title: string;
  dek?: string;
  section: string;
  area?: string;
  column?: string;
  author: string;
  authorTitle?: string;
  church?: string;
  date: string;
  /** Public paths or https URLs, lead image first. */
  photoPaths: string[];
  imageAlt?: string;
  photoCredit?: string;
  /** Alt text for the gallery photos (every photo after the lead), in the same order as photoPaths.slice(1). */
  photoAlts?: string[];
  /** Written only when it is not the default ('one'). */
  photoLayout?: string;
  featured: boolean;
  draft: boolean;
}

/** The frontmatter block, ending with the closing --- and a newline. */
export function storyFrontmatter(f: StoryFrontmatter): string {
  const fm: string[] = [
    '---',
    `title: ${yaml(f.title)}`,
    ...(f.dek ? [`dek: ${yaml(f.dek)}`] : []),
    `section: ${f.section}`,
    ...(f.area ? [`area: ${f.area}`] : []),
    ...(f.column ? [`column: ${yaml(f.column)}`] : []),
    `author: ${yaml(f.author)}`,
    ...(f.authorTitle ? [`authorTitle: ${yaml(f.authorTitle)}`] : []),
    ...(f.church ? [`church: ${yaml(f.church)}`] : []),
    `date: ${f.date}`,
  ];
  if (f.photoPaths[0]) {
    fm.push(`image: ${yaml(f.photoPaths[0])}`, `imageAlt: ${yaml(f.imageAlt ?? '')}`);
    if (f.photoCredit) fm.push(`photoCredit: ${yaml(f.photoCredit)}`);
  }
  if (f.photoPaths.length > 1) fm.push('photos:', ...f.photoPaths.slice(1).map((p) => `  - ${yaml(p)}`));
  if (f.photoAlts?.some((a) => a)) fm.push('photoAlts:', ...f.photoAlts.map((a) => `  - ${yaml(a)}`));
  if (f.photoLayout && f.photoLayout !== 'one') fm.push(`photoLayout: ${f.photoLayout}`);
  fm.push(`featured: ${f.featured ? 'true' : 'false'}`, `draft: ${f.draft ? 'true' : 'false'}`, '---', '');
  return fm.join('\n');
}

/**
 * Editors write Markdown, but raw HTML must never reach the committed file (the site renders .md with
 * raw HTML passing through). Every "<" becomes &lt;, including inside code, so the file never holds a
 * tag, comment or autolink. ">" and "&" stay, so block quotes and already-escaped submissions (which
 * contain &lt; &gt; &amp;) are unchanged.
 */
export function escapeHtmlInMarkdown(md: string): string {
  return md.replace(/\r\n?/g, '\n').replace(/</g, '&lt;');
}

/** Public path (or https URL) for an uploaded photo inside a story. */
export const storyPhotoPath = (slug: string, n: number, ext: string) => `/images/stories/${slug}/photo-${n}.${ext}`;
