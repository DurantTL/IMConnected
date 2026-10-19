// Turns an editor draft into the story's Markdown and photo files, commits them to the base branch,
// and handles loading a live story back into the editor and unpublishing it.
import fs from 'node:fs';
import { parseFrontmatter } from 'astro/markdown';
import { commitToBase, fileExistsOnBase, readFileFromBase, type GitHubConfig, type NewFile } from './github';
import { LIMITS } from './limits';
import { PUBLISH_LIMITS, PublishError } from './publish';
import { getSection, isValidArea } from './site';
import { slugify, sniffImage } from './submission';
import { clean, escapeHtmlInMarkdown, leadImageFields, storyFrontmatter, storyPhotoPath, validDate } from './storyfile';
import { renderMarkdownSafe } from './markdown';
import { getDraftBySlug, uploadFile, type Draft, type DraftFields, type DraftPhoto } from './drafts';

export const storyPath = (slug: string) => `src/content/stories/${slug}.md`;
const SLUG = /^[a-z0-9][a-z0-9-]{0,159}$/;
export const validSlug = (slug: unknown): slug is string => typeof slug === 'string' && SLUG.test(slug);

const oneLine = (v: string) => clean(v).replace(/\s+/g, ' ').trim();

/** A story image already on the site: a path under /images/ or an https:// URL. */
function existingImageUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length > PUBLISH_LIMITS.url) return null;
  if (/^\/images\/[A-Za-z0-9._\-/]+$/.test(url) && !url.includes('..')) return url;
  try {
    return new URL(url).protocol === 'https:' ? new URL(url).href : null;
  } catch {
    return null;
  }
}

export interface BuiltDraft {
  slug: string;
  files: NewFile[];
  title: string;
}

/**
 * Check the draft against the content schema and build the story files, the same way /api/publish does.
 * Throws PublishError with a message an editor can act on.
 */
export async function buildDraftFiles(cfg: GitHubConfig, draft: Draft, photos: DraftPhoto[]): Promise<BuiltDraft> {
  const fail = (m: string) => new PublishError(m);
  const title = oneLine(draft.title);
  const author = oneLine(draft.author);
  const dek = oneLine(draft.dek);
  const body = clean(draft.body).trim();
  const section = draft.section;
  const area = draft.area || undefined;

  if (!title) throw fail('Add a title before publishing.');
  if (title.length > LIMITS.title) throw fail(`The title is longer than ${LIMITS.title} characters.`);
  if (!author) throw fail('Add an author before publishing.');
  if (author.length > PUBLISH_LIMITS.author) throw fail('The author name is too long.');
  if (dek.length > LIMITS.dek) throw fail(`The summary is longer than ${LIMITS.dek} characters.`);
  if (!body) throw fail('Add the story text before publishing.');
  if (body.length > LIMITS.bodyMax) throw fail(`The story is longer than ${LIMITS.bodyMax} characters.`);
  if (!getSection(section)) throw fail('Choose a section.');
  if (!isValidArea(section, area)) throw fail('Choose a category that belongs to this section.');
  if (!validDate(draft.date)) throw fail('Choose a valid date.');
  if (section !== 'columns' && draft.column) throw fail('A column name is only for the Columns section.');
  const column = oneLine(draft.column).slice(0, PUBLISH_LIMITS.name);
  const authorTitle = oneLine(draft.authorTitle).slice(0, PUBLISH_LIMITS.author);
  const church = oneLine(draft.church).slice(0, 160);
  const photoCredit = oneLine(draft.photoCredit).slice(0, 120);
  if (photos.length > LIMITS.maxPhotos) throw fail(`Use up to ${LIMITS.maxPhotos} photos per story.`);

  const rendered = await renderMarkdownSafe(body);
  if (rendered.unsafeLinks) throw fail('A link in the story is not a web, email or phone link. Use https:// addresses.');

  const slug = draft.slug ?? (await freshSlug(cfg, draft.date, title));
  if (!validSlug(slug)) throw fail('The story address is not valid.');

  const files: NewFile[] = [];
  const photoPaths: string[] = [];
  const retained = new Set(photos.filter((p) => p.url).map((p) => p.url as string));
  let counter = 0;
  for (const p of photos) {
    if (p.url) {
      const url = existingImageUrl(p.url);
      if (!url) throw fail('A photo link is not valid. Photos must be on this site or use an https:// link.');
      photoPaths.push(url);
      continue;
    }
    const full = p.path ? uploadFile(p.path) : null;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(full!);
    } catch {
      throw fail('An uploaded photo is missing from the server. Delete it and upload it again.');
    }
    const ext = sniffImage(new Uint8Array(bytes.subarray(0, 16)));
    if (!ext) throw fail('An uploaded photo is not a JPG, PNG or WebP image.');
    let publicPath: string;
    do publicPath = storyPhotoPath(slug, ++counter, ext);
    while (retained.has(publicPath));
    files.push({ path: `public${publicPath}`, content: bytes.toString('base64'), encoding: 'base64' });
    photoPaths.push(publicPath);
  }

  const first = photos[0];
  const lead = first
    ? leadImageFields({ alt: clean(first.alt).trim().slice(0, PUBLISH_LIMITS.alt), caption: clean(first.caption).trim().slice(0, PUBLISH_LIMITS.caption) }, title, photoCredit)
    : null;
  const md =
    storyFrontmatter({
      title,
      dek,
      section,
      area,
      column,
      author,
      authorTitle,
      church,
      date: draft.date,
      photoPaths,
      imageAlt: lead?.alt,
      photoCredit: lead?.credit,
      featured: draft.featured,
      draft: false,
    }) +
    escapeHtmlInMarkdown(body) +
    '\n';
  files.unshift({ path: storyPath(slug), content: md, encoding: 'utf-8' });
  return { slug, files, title };
}

/** `<date>-<title>` and, if that file or draft exists already, `-2`, `-3` ... */
async function freshSlug(cfg: GitHubConfig, date: string, title: string): Promise<string> {
  const base = `${date}-${slugify(title)}`;
  for (let n = 1; n <= 30; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!getDraftBySlug(slug) && !(await fileExistsOnBase(cfg, storyPath(slug)))) return slug;
  }
  throw new PublishError('Could not find a free address for this story. Change the title and try again.');
}

export async function publishDraft(cfg: GitHubConfig, draft: Draft, photos: DraftPhoto[], editorName: string): Promise<{ slug: string; sha: string }> {
  const built = await buildDraftFiles(cfg, draft, photos);
  const { sha } = await commitToBase(cfg, { files: built.files, message: `Publish "${oneLine(built.title)}" (edited by ${oneLine(editorName) || 'an editor'})` });
  return { slug: built.slug, sha };
}

// ---- live stories ----

export interface LoadedStory {
  fields: DraftFields;
  photos: { url: string; alt: string; caption: string }[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Read a live story from the base branch (GitHub contents API) into editor fields. Null when it isn't there. */
export async function loadStory(cfg: GitHubConfig, slug: string): Promise<LoadedStory | null> {
  if (!validSlug(slug)) throw new PublishError('That story address is not valid.');
  const file = await readFileFromBase(cfg, storyPath(slug));
  if (!file) return null;
  const { frontmatter: fm, content } = parseFrontmatter(file.content) as { frontmatter: Record<string, unknown>; content: string };
  const section = getSection(str(fm.section)) ? str(fm.section) : '';
  if (!section) throw new PublishError('That story uses a section this editor does not know.');
  const d = fm.date;
  const date = d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : validDate(str(d)) ? str(d) : new Date().toISOString().slice(0, 10);
  const urls = [str(fm.image), ...(Array.isArray(fm.photos) ? fm.photos.map(str) : [])].filter(Boolean);
  return {
    fields: {
      title: str(fm.title),
      dek: str(fm.dek),
      section,
      area: str(fm.area),
      column: str(fm.column),
      author: str(fm.author),
      authorTitle: str(fm.authorTitle),
      church: str(fm.church),
      date,
      photoCredit: str(fm.photoCredit),
      featured: fm.featured === true,
      body: content.replace(/^\r?\n/, '').replace(/\s+$/, ''),
    },
    photos: urls.map((url, i) => ({ url, alt: i === 0 ? str(fm.imageAlt) : '', caption: '' })),
  };
}

/** Commit `draft: true` to a live story. Returns its title, or null when the story file doesn't exist. */
export async function unpublishStory(cfg: GitHubConfig, slug: string, editorName: string): Promise<{ title: string; sha: string } | null> {
  if (!validSlug(slug)) throw new PublishError('That story address is not valid.');
  const file = await readFileFromBase(cfg, storyPath(slug));
  if (!file) return null;
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(file.content);
  if (!m) throw new PublishError('That story file has no frontmatter, so it was left alone.');
  let block = m[2];
  block = /^draft:.*$/m.test(block) ? block.replace(/^draft:.*$/m, 'draft: true') : `${block}\ndraft: true`;
  const next = m[1] + block + file.content.slice(m[1].length + m[2].length);
  const title = str((parseFrontmatter(file.content).frontmatter as Record<string, unknown>).title) || slug;
  const { sha } = await commitToBase(cfg, {
    files: [{ path: storyPath(slug), content: next, encoding: 'utf-8' }],
    message: `Unpublish "${oneLine(title)}" (by ${oneLine(editorName) || 'an editor'})`,
  });
  return { title, sha };
}
