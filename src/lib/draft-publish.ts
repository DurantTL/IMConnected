// Turns an editor draft into the story's Markdown and photo files, commits them to the base branch,
// and handles loading a live story back into the editor and unpublishing it.
import fs from 'node:fs';
import { parseFrontmatter } from 'astro/markdown';
import { commitToBase, fileExistsOnBase, readFileFromBase, type GitHubConfig, type NewFile } from './github';
import { LIMITS } from './limits';
import { PUBLISH_LIMITS } from './publish';
import { EditorError } from './messages';
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
  /** Public path of every uploaded photo that is in the commit, by draft photo id. */
  uploaded: Map<number, string>;
}

/**
 * Check the draft against the content schema and build the story files, the same way /api/publish does.
 * Throws EditorError (a code from messages.ts) with something an editor can act on.
 */
export async function buildDraftFiles(cfg: GitHubConfig, draft: Draft, photos: DraftPhoto[]): Promise<BuiltDraft> {
  const title = oneLine(draft.title);
  const author = oneLine(draft.author);
  const dek = oneLine(draft.dek);
  const body = clean(draft.body).trim();
  const section = draft.section;
  const area = draft.area || undefined;

  if (!title) throw new EditorError('title_required');
  if (title.length > LIMITS.title) throw new EditorError('title_long');
  if (!author) throw new EditorError('author_required');
  if (author.length > PUBLISH_LIMITS.author) throw new EditorError('author_long');
  if (dek.length > LIMITS.dek) throw new EditorError('dek_long');
  if (!body) throw new EditorError('body_required');
  if (body.length > LIMITS.bodyMax) throw new EditorError('body_long');
  if (!getSection(section)) throw new EditorError('section_required');
  if (!isValidArea(section, area)) throw new EditorError('area_bad');
  if (!validDate(draft.date)) throw new EditorError('date_required');
  if (section !== 'columns' && draft.column) throw new EditorError('column_only');
  const column = oneLine(draft.column).slice(0, PUBLISH_LIMITS.name);
  const authorTitle = oneLine(draft.authorTitle).slice(0, PUBLISH_LIMITS.author);
  const church = oneLine(draft.church).slice(0, 160);
  const photoCredit = oneLine(draft.photoCredit).slice(0, 120);
  if (photos.length > LIMITS.maxPhotos) throw new EditorError('photos_many');

  const rendered = await renderMarkdownSafe(body);
  if (rendered.unsafeLinks) throw new EditorError('link_unsafe');

  const slug = draft.slug ?? (await freshSlug(cfg, draft.date, title));
  if (!validSlug(slug)) throw new EditorError('slug_bad');

  const files: NewFile[] = [];
  const photoPaths: string[] = [];
  const uploaded = new Map<number, string>();
  const retained = new Set(photos.filter((p) => p.url).map((p) => p.url as string));
  let counter = 0;
  for (const p of photos) {
    if (p.url) {
      const url = existingImageUrl(p.url);
      if (!url) throw new EditorError('photo_link_bad');
      photoPaths.push(url);
      continue;
    }
    const full = p.path ? uploadFile(p.path) : null;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(full!);
    } catch {
      throw new EditorError('photo_missing');
    }
    const ext = sniffImage(new Uint8Array(bytes.subarray(0, 16)));
    if (!ext) throw new EditorError('photo_not_image');
    let publicPath: string;
    do publicPath = storyPhotoPath(slug, ++counter, ext);
    while (retained.has(publicPath));
    files.push({ path: `public${publicPath}`, content: bytes.toString('base64'), encoding: 'base64' });
    photoPaths.push(publicPath);
    uploaded.set(p.id, publicPath);
  }

  const alts = photos.map((p) => clean(p.alt).replace(/\s+/g, ' ').trim().slice(0, PUBLISH_LIMITS.alt));
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
      imageAlt: photos.length ? alts[0] || title : undefined,
      photoCredit,
      photoAlts: alts.slice(1),
      featured: draft.featured,
      draft: false,
    }) +
    escapeHtmlInMarkdown(body) +
    '\n';
  files.unshift({ path: storyPath(slug), content: md, encoding: 'utf-8' });
  return { slug, files, title, uploaded };
}

/** `<date>-<title>` and, if that file or draft exists already, `-2`, `-3` ... */
async function freshSlug(cfg: GitHubConfig, date: string, title: string): Promise<string> {
  const base = `${date}-${slugify(title)}`;
  for (let n = 1; n <= 30; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!getDraftBySlug(slug) && !(await fileExistsOnBase(cfg, storyPath(slug)))) return slug;
  }
  throw new EditorError('slug_none');
}

/** The commit message for a publish. */
export const publishMessage = (title: string, editorName: string) => `Publish "${oneLine(title)}" (edited by ${oneLine(editorName) || 'an editor'})`;

// ---- live stories ----

export interface LoadedStory {
  fields: DraftFields;
  photos: { url: string; alt: string; caption: string }[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Read a live story from the base branch (GitHub contents API) into editor fields. Null when it isn't there. */
export async function loadStory(cfg: GitHubConfig, slug: string): Promise<LoadedStory | null> {
  if (!validSlug(slug)) throw new EditorError('slug_bad');
  const file = await readFileFromBase(cfg, storyPath(slug));
  if (!file) return null;
  const { frontmatter: fm, content } = parseFrontmatter(file.content) as { frontmatter: Record<string, unknown>; content: string };
  const section = getSection(str(fm.section)) ? str(fm.section) : '';
  if (!section) throw new EditorError('section_unknown');
  const d = fm.date;
  const date = d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : validDate(str(d)) ? str(d) : '';
  if (!date) throw new EditorError('date_unreadable');
  const gallery = Array.isArray(fm.photos) ? fm.photos.map(str) : [];
  const galleryAlts = Array.isArray(fm.photoAlts) ? fm.photoAlts.map(str) : [];
  const lead = str(fm.image);
  const photos = [
    ...(lead ? [{ url: lead, alt: str(fm.imageAlt), caption: '' }] : []),
    ...gallery.map((url, i) => ({ url, alt: galleryAlts[i] ?? '', caption: '' })).filter((p) => p.url),
  ];
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
    photos,
  };
}

/** Commit `draft: true` to a live story. Returns its title, or null when the story file doesn't exist. */
export async function unpublishStory(cfg: GitHubConfig, slug: string, editorName: string): Promise<{ title: string; sha: string; time?: number } | null> {
  if (!validSlug(slug)) throw new EditorError('slug_bad');
  const file = await readFileFromBase(cfg, storyPath(slug));
  if (!file) return null;
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(file.content);
  if (!m) throw new EditorError('no_frontmatter');
  let block = m[2];
  block = /^draft:.*$/m.test(block) ? block.replace(/^draft:.*$/m, 'draft: true') : `${block}\ndraft: true`;
  const next = m[1] + block + file.content.slice(m[1].length + m[2].length);
  const title = str((parseFrontmatter(file.content).frontmatter as Record<string, unknown>).title) || slug;
  const { sha, time } = await commitToBase(cfg, {
    files: [{ path: storyPath(slug), content: next, encoding: 'utf-8' }],
    message: `Unpublish "${oneLine(title)}" (by ${oneLine(editorName) || 'an editor'})`,
  });
  return { title, sha, time };
}
