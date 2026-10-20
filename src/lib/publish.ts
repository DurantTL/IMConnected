// Validates a Studio publish request and turns it into story files for a direct commit.
import { getSection, isValidArea } from './site';
import { LIMITS } from './limits';
import { slugify, sniffImage, textToMarkdown } from './submission';
import { clean, validDate, leadImageFields, storyFrontmatter, storyPhotoPath } from './storyfile';
import type { NewFile } from './github';

export class PublishError extends Error {
  constructor(message: string, public ref?: string) {
    super(message);
  }
}

export const PUBLISH_LIMITS = { maxStories: 12, maxBodyBytes: 40 * 1024 * 1024, author: 120, alt: 300, caption: 300, quote: 2000, attribution: 200, url: 2000, name: 80 };

export interface PublishedStory {
  ref: string;
  slug: string;
  path: string;
  /** What the dashboard records for the history (no personal data: Studio stories carry none). */
  record: { title: string; dek: string; section: string; area?: string; author: string; date: string; photoCredit: string; body: string; photos: Photo[] };
}

interface Photo {
  url: string;
  alt: string;
  caption: string;
}

function parsePhoto(raw: unknown, ref: string): { photo: Photo; data?: { ext: string; base64: string } } {
  if (!raw || typeof raw !== 'object') throw new PublishError('Each photo needs a url.', ref);
  const p = raw as Record<string, unknown>;
  const url = typeof p.url === 'string' ? p.url.trim() : '';
  const alt = clean(p.alt).trim().slice(0, PUBLISH_LIMITS.alt);
  const caption = clean(p.caption).trim().slice(0, PUBLISH_LIMITS.caption);
  if (/^data:/i.test(url)) {
    const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
    if (!m) throw new PublishError('A photo data URL must be base64 encoded.', ref);
    const bytes = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    if (bytes.length > LIMITS.maxPhotoMB * 1024 * 1024) throw new PublishError(`A photo is larger than ${LIMITS.maxPhotoMB} MB.`, ref);
    const ext = sniffImage(new Uint8Array(bytes.subarray(0, 16)));
    if (!ext) throw new PublishError('A photo is not a JPG, PNG or WebP image.', ref);
    return { photo: { url: '', alt, caption }, data: { ext, base64: bytes.toString('base64') } };
  }
  if (url.length > PUBLISH_LIMITS.url) throw new PublishError('A photo URL is too long.', ref);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PublishError('A photo URL is not valid. Use an https:// link or a data: image.', ref);
  }
  if (parsed.protocol !== 'https:') throw new PublishError('Photo links must start with https://.', ref);
  return { photo: { url: parsed.href, alt, caption } };
}

export function buildPublish(input: unknown, existing: (path: string) => Promise<boolean>) {
  return (async () => {
    if (!input || typeof input !== 'object') throw new PublishError('The request body must be a JSON object.');
    const body = input as Record<string, unknown>;
    const nl = (body.newsletter ?? {}) as Record<string, unknown>;
    const issueDate = nl.issueDate;
    if (!validDate(issueDate)) throw new PublishError('newsletter.issueDate must be a date like 2026-10-19.');
    const name = clean(nl.name).replace(/\s+/g, ' ').trim().slice(0, PUBLISH_LIMITS.name) || 'IMConnected';

    const list = body.stories;
    if (!Array.isArray(list) || list.length < 1) throw new PublishError('Send at least one story.');
    if (list.length > PUBLISH_LIMITS.maxStories) throw new PublishError(`Send up to ${PUBLISH_LIMITS.maxStories} stories at a time.`);

    const files: NewFile[] = [];
    const stories: PublishedStory[] = [];
    const usedSlugs = new Set<string>();

    for (const [i, raw] of list.entries()) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const ref = clean(r.ref).slice(0, 200) || `story-${i + 1}`;
      const fail = (msg: string) => new PublishError(msg, ref);

      const title = clean(r.title).trim();
      const author = clean(r.author).trim();
      const dek = clean(r.dek).trim();
      const storyBody = clean(r.body).trim();
      const quote = clean(r.quote).trim();
      const attribution = clean(r.attribution).trim();
      const section = typeof r.section === 'string' ? r.section.trim() : '';
      const area = typeof r.area === 'string' && r.area.trim() ? r.area.trim() : undefined;

      if (!title) throw fail('Every story needs a title.');
      if (title.length > LIMITS.title) throw fail(`The title is longer than ${LIMITS.title} characters.`);
      if (!author) throw fail('Every story needs an author.');
      if (author.length > PUBLISH_LIMITS.author) throw fail('The author name is too long.');
      if (dek.length > LIMITS.dek) throw fail(`The summary is longer than ${LIMITS.dek} characters.`);
      if (!storyBody) throw fail('Every story needs body text.');
      if (storyBody.length > LIMITS.bodyMax) throw fail('The story body is too long.');
      if (quote.length > PUBLISH_LIMITS.quote || attribution.length > PUBLISH_LIMITS.attribution) throw fail('The quote or attribution is too long.');
      if (!getSection(section)) throw fail('That section does not exist.');
      if (!isValidArea(section, area)) throw fail('That category is not valid for this section.');

      const rawPhotos = r.photos === undefined ? [] : r.photos;
      if (!Array.isArray(rawPhotos)) throw fail('photos must be a list.');
      if (rawPhotos.length > LIMITS.maxPhotos) throw fail(`Use up to ${LIMITS.maxPhotos} photos per story.`);

      const baseSlug = `${issueDate}-${slugify(title)}`;
      let slug = baseSlug;
      for (let n = 2; usedSlugs.has(slug); n++) slug = `${baseSlug}-${n}`;
      usedSlugs.add(slug);

      const photoPaths: string[] = [];
      const photoMeta: Photo[] = [];
      for (const [pi, rp] of rawPhotos.entries()) {
        const parsed = parsePhoto(rp, ref);
        if (parsed.data) {
          const publicPath = storyPhotoPath(slug, pi + 1, parsed.data.ext);
          files.push({ path: `public${publicPath}`, content: parsed.data.base64, encoding: 'base64' });
          photoPaths.push(publicPath);
        } else {
          photoPaths.push(parsed.photo.url);
        }
        photoMeta.push(parsed.photo);
      }

      const lead = photoPaths[0] ? leadImageFields(photoMeta[0], title) : null;
      const frontmatter = storyFrontmatter({
        title,
        dek,
        section,
        area,
        author,
        date: issueDate,
        photoPaths,
        imageAlt: lead?.alt,
        photoCredit: lead?.credit,
        photoAlts: photoMeta.slice(1).map((m) => m.alt),
        featured: false,
        draft: false,
      });

      let md = frontmatter + textToMarkdown(storyBody);
      if (quote) {
        const lines = textToMarkdown(quote).split('\n').map((l) => (l ? `> ${l}` : '>'));
        if (attribution) lines.push('>', `> — ${textToMarkdown(attribution).replace(/\n+/g, ' ')}`);
        md += '\n\n' + lines.join('\n');
      }
      files.push({ path: `src/content/stories/${slug}.md`, content: md + '\n', encoding: 'utf-8' });
      stories.push({
        ref,
        slug,
        path: `src/content/stories/${slug}.md`,
        record: { title, dek, section, area, author, date: issueDate, photoCredit: lead?.credit ?? '', body: md.slice(frontmatter.length), photos: photoPaths.map((url, i) => ({ url, alt: photoMeta[i].alt, caption: photoMeta[i].caption })) },
      });
    }

    const statuses = await Promise.all(stories.map((s) => existing(s.path)));
    return {
      name,
      issueDate,
      files,
      stories: stories.map((s, i) => ({ ref: s.ref, slug: s.slug, record: s.record, status: statuses[i] ? ('updated' as const) : ('created' as const) })),
    };
  })();
}
