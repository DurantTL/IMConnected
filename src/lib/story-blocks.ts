// Version-one story modules. Pure validation and Markdown projection shared by the editor and server.
// The Markdown body remains available to search, feeds and older consumers; the structured modules own layout.
export const STORY_BLOCK_TYPES = ['text', 'heading', 'quote', 'list', 'image', 'gallery', 'flyer', 'video', 'button', 'divider'] as const;
export type StoryBlockType = (typeof STORY_BLOCK_TYPES)[number];
export interface StoryPhotoRef {
  photoId?: number;
  photoIndex?: number;
  url?: string;
  alt?: string;
  focalX?: number;
  focalY?: number;
  zoom?: number;
}
export interface StoryBlock extends StoryPhotoRef {
  id: string;
  type: StoryBlockType;
  text?: string;
  level?: 2 | 3;
  items?: string[];
  photos?: StoryPhotoRef[];
  columns?: 2 | 3;
  label?: string;
}

export interface PhotoCrop { focalX?: number; focalY?: number; zoom?: number }


export const STORY_BLOCK_LIMIT = 60;
/** All module text together becomes the Markdown body, which publishing limits to LIMITS.bodyMax: saving refuses it first. */
export const STORY_BLOCKS_TEXT_MAX = 20_000; // = LIMITS.bodyMax (limits.ts); no imports here: scripts/import-git-stories.mjs loads this file with Node's type stripping
// Same as clean() in storyfile.ts: control characters out (a copy, because this file must stay import-free).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const clean = (v: string) => v.replace(CONTROL, '');
const error = (message: string): never => { throw new Error(message); };
const text = (value: unknown, limit: number, label: string): string => {
  if (value === undefined) return '';
  // Limits count the text as typed: a stored "<" is &lt; (4 characters), which must never push a field over its limit.
  if (typeof value !== 'string' || value.replace(/&lt;/g, '<').length > limit) return error(`${label} must be text of at most ${limit.toLocaleString('en-US')} characters.`);
  return clean(value);
};

/**
 * A constrained image source: only a story's own published photo paths (/media/stories/... or /images/stories/...).
 * Never an external address, HTML, CSS, a data URL or a protected draft endpoint. Whether the path belongs to THIS
 * story is checked by assertOwnStoryImages.
 */
export function isStoryImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (!/^\/(?:media|images)\/stories\/[A-Za-z0-9._/-]+$/.test(value)) return false;
  return !value.split('/').some((part) => part === '.' || part === '..');
}

export const OWN_PHOTO_ERROR = "Image modules can only use this story's own photos.";

/** Every image module with an address must point at one of the story's own photos (`own` = its lead image and gallery). */
export function assertOwnStoryImages(blocks: readonly StoryBlock[], own: Iterable<string>): void {
  const ordered = [...own], allowed = new Set(ordered);
  for (const p of storyBlockPhotos(blocks)) if (p.url && (!allowed.has(p.url) || p.photoIndex !== undefined && ordered[p.photoIndex] !== p.url)) error(OWN_PHOTO_ERROR);
}

/** Shared traversal keeps photo ownership, publishing and derived data aligned. */
export function storyBlockPhotos(blocks: readonly StoryBlock[]): StoryPhotoRef[] {
  return blocks.flatMap((b) => ['image', 'flyer'].includes(b.type) ? [b] : b.type === 'gallery' ? b.photos ?? [] : []);
}
export function mapStoryPhotos(blocks: StoryBlock[], map: (photo: StoryPhotoRef) => StoryPhotoRef | null): StoryBlock[] {
  return blocks.flatMap((b) => {
    if (['image', 'flyer'].includes(b.type)) { const photo = map(b); return photo ? [{ ...b, ...photo }] : []; }
    if (b.type === 'gallery') return [{ ...b, photos: (b.photos ?? []).flatMap((p) => { const photo = map(p); return photo ? [photo] : []; }) }];
    return [b];
  });
}
function normalizePhoto(r: Record<string, unknown>): StoryPhotoRef {
  const p: StoryPhotoRef = {};
  if (r.photoId !== undefined) {
    if (typeof r.photoId !== 'number' || !Number.isSafeInteger(r.photoId) || r.photoId < 1) return error('Choose a valid story photo.');
    p.photoId = r.photoId;
  }
  if (r.photoIndex !== undefined) {
    if (!Number.isInteger(r.photoIndex) || Number(r.photoIndex) < 0 || Number(r.photoIndex) > 5) return error('Choose a valid story photo position.');
    p.photoIndex = r.photoIndex as number;
  }
  if (r.url !== undefined && r.url !== '') { if (!isStoryImageUrl(r.url)) return error(OWN_PHOTO_ERROR); p.url = r.url; }
  p.alt = text(r.alt, 300, 'Photo description');
  if (r.focalX !== undefined) p.focalX = focalPoint(r.focalX);
  if (r.focalY !== undefined) p.focalY = focalPoint(r.focalY);
  if (r.zoom !== undefined) p.zoom = photoZoom(r.zoom);
  return p;
}

/** Explicit action links only. No script schemes, protocol-relative addresses or embedded credentials. */
export function isStoryButtonUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\<>"]/.test(value)) return false;
  try {
    const u = new URL(value);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol) && !u.username && !u.password;
  } catch { return false; }
}

/** Derive embed URLs from exact providers/IDs; never accept iframe HTML or arbitrary embed addresses. */
export function parseStoryVideo(value: unknown): { provider: 'YouTube' | 'Vimeo'; url: string; embed: string } | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\<>"']/.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com'].includes(u.hostname)) {
      const id = u.hostname === 'youtu.be' ? /^\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname)?.[1] : u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname)?.[1];
      if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
      return { provider: 'YouTube', url: `https://www.youtube.com/watch?v=${id}`, embed: `https://www.youtube-nocookie.com/embed/${id}?rel=0` };
    }
    if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(u.hostname)) {
      const id = /^\/(?:video\/)?([1-9]\d{0,11})\/?$/.exec(u.pathname)?.[1];
      if (id) return { provider: 'Vimeo', url: `https://vimeo.com/${id}`, embed: `https://player.vimeo.com/video/${id}` };
    }
  } catch { /* unsupported input */ }
  return null;
}

export function focalPoint(value: unknown): number {
  if (value === undefined || value === null || value === '') return 50;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) return error('Photo focus must be between 0 and 100.');
  return Math.round(n * 100) / 100;
}

export function photoZoom(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 3) return error('Photo zoom must be between 100% and 300%.');
  return Math.round(n * 100) / 100;
}

/** Zoomed images need a clipping parent. Defaults keep existing markup and object-position unchanged. */
export function photoFocusStyle(focus?: PhotoCrop | null): string | undefined {
  const x = focalPoint(focus?.focalX), y = focalPoint(focus?.focalY);
  const zoom = photoZoom(focus?.zoom);
  return x === 50 && y === 50 && zoom === 1 ? undefined : `object-position:${x}% ${y}%;${zoom === 1 ? '' : `scale:${zoom};transform-origin:${x}% ${y}%;`}`;
}

export function normalizeStoryBlocks(input: unknown): StoryBlock[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > STORY_BLOCK_LIMIT) return error(`A story can have at most ${STORY_BLOCK_LIMIT} modules.`);
  const ids = new Set<string>();
  let total = 0;
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error('Every module must be an object.');
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(r.id) || ids.has(r.id)) return error('Every module needs a unique valid ID.');
    if (!STORY_BLOCK_TYPES.includes(r.type as StoryBlockType)) return error('Choose a supported story module.');
    ids.add(r.id);
    const b: StoryBlock = { id: r.id, type: r.type as StoryBlockType };
    if (['text', 'heading', 'quote'].includes(b.type)) {
      b.text = text(r.text, b.type === 'heading' ? 300 : 20_000, 'Module text');
      total += b.text.length;
    }
    if (b.type === 'heading') {
      if (r.level !== undefined && r.level !== 2 && r.level !== 3) return error('Module headings must use level 2 or 3.');
      b.level = r.level === 3 ? 3 : 2;
    }
    if (b.type === 'list') {
      if (r.items !== undefined && (!Array.isArray(r.items) || r.items.length > 50)) return error('A list can have at most 50 items.');
      b.items = ((r.items ?? []) as unknown[]).map((item) => text(item, 2000, 'List item'));
      total += b.items.join('').length;
    }
    if (['image', 'flyer'].includes(b.type)) { Object.assign(b, normalizePhoto(r)); total += b.alt?.length ?? 0; }
    if (b.type === 'gallery') {
      if (r.columns !== undefined && r.columns !== 2 && r.columns !== 3) return error('Gallery columns must be 2 or 3.');
      b.columns = r.columns === 3 ? 3 : 2;
      if (r.photos !== undefined && (!Array.isArray(r.photos) || r.photos.length > 6)) return error('A gallery can contain up to 6 story photos.');
      b.photos = ((r.photos ?? []) as unknown[]).map((p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return error('Choose a valid story photo.');
        return normalizePhoto(p as Record<string, unknown>);
      });
      const identities = b.photos.map((p) => p.photoId ? `id:${p.photoId}` : p.photoIndex !== undefined ? `index:${p.photoIndex}` : p.url);
      if (new Set(identities).size !== identities.length) return error('Choose each gallery photo once.');
      total += b.photos.reduce((n, p) => n + (p.alt?.length ?? 0), 0);
    }
    if (b.type === 'video') {
      b.label = text(r.label, 120, 'Video title');
      b.url = text(r.url, 2048, 'Video URL');
      if (b.url) { const video = parseStoryVideo(b.url); if (!video) return error('Use a supported HTTPS YouTube or Vimeo video URL.'); b.url = video.url; }
      total += b.label.length + b.url.length;
    }
    if (b.type === 'button') {
      b.label = text(r.label, 120, 'Button label');
      b.url = text(r.url, 2048, 'Button URL');
      if (b.url && !isStoryButtonUrl(b.url)) return error('Button links must start with http://, https://, mailto: or tel:.');
      total += b.label.length + b.url.length;
    }
    if (total > 100_000) return error('The story modules contain too much text.');
    return b;
  });
}

/** Modules become the Markdown body, which publishing limits to 20,000 characters: refuse at save with a clear message. */
export function checkStoryBlockLength(blocks: StoryBlock[]): void {
  const md = storyBlocksToMarkdown(blocks);
  if (md.replace(/&lt;/g, '<').length > STORY_BLOCKS_TEXT_MAX || md.length > 4 * STORY_BLOCKS_TEXT_MAX) { // as typed, the same rule as text(); stored size capped at 4x
    error(`The story text is too long: modules together can hold up to ${STORY_BLOCKS_TEXT_MAX.toLocaleString('en-US')} characters.`);
  }
}

const lt = (v: string) => v.replace(/</g, '&lt;');
/**
 * The same contract as the body (escapeHtmlInMarkdown): every "<" in module text becomes &lt;, so a stored module never
 * holds a tag, comment or autolink. Safe to apply twice. The renderer shows these fields as plain text (see story-block-render).
 */
export function escapeStoryBlocks(blocks: StoryBlock[]): StoryBlock[] {
  return blocks.map((b) => {
    const o: StoryBlock = { ...b };
    if (o.text !== undefined) o.text = lt(o.text);
    if (o.items) o.items = o.items.map(lt);
    if (o.alt !== undefined) o.alt = lt(o.alt);
    if (o.photos) o.photos = o.photos.map((p) => ({ ...p, alt: lt(p.alt ?? '') }));
    if (o.label !== undefined) o.label = lt(o.label);
    return o;
  });
}

export function parseStoryBlocks(input: unknown): StoryBlock[] {
  if (typeof input !== 'string') return normalizeStoryBlocks(input);
  if (input.length > 400_000) return error('The story modules are too large.');
  try { return normalizeStoryBlocks(JSON.parse(input)); } catch (e) {
    if (e instanceof SyntaxError) return error('The story modules could not be read.');
    throw e;
  }
}
export const parseStoredStoryBlocks = parseStoryBlocks;

// "<" is left for escapeHtmlInMarkdown (every consumer applies it), so it never turns into the text `\&lt;`.
const plainMarkdown = (value: string) => value.replace(/[\\`*_[\]>#]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');

/** Search/legacy projection. Image modules contribute nothing (no alt-text paragraph, no inaccessible draft-photo URL). */
export function storyBlocksToMarkdown(blocks: StoryBlock[]): string {
  return normalizeStoryBlocks(blocks).map((b) => {
    switch (b.type) {
      case 'text': return b.text || '';
      case 'heading': return `${'#'.repeat(b.level || 2)} ${plainMarkdown(b.text || '')}`;
      case 'quote': return (b.text || '').split('\n').map((line) => `> ${line}`).join('\n');
      case 'list': return (b.items || []).map((item) => `- ${plainMarkdown(item)}`).join('\n');
      case 'video': return b.url ? `[${plainMarkdown(b.label || 'Watch video')}](${b.url})` : '';
      case 'flyer': return '';
      case 'gallery': return '';
      case 'image': return ''; // an image has no text of its own: its description is an attribute, not a paragraph
      case 'button': return b.url ? `[${plainMarkdown(b.label || b.url)}](${b.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : plainMarkdown(b.label || '');
      case 'divider': return '---';
    }
  }).filter(Boolean).join('\n\n');
}
export const blocksToMarkdown = storyBlocksToMarkdown;

/**
 * Markdown to paragraph modules of at most `max` characters. Cuts only between paragraphs when it can (never inside a Markdown link
 * unless one paragraph alone is longer than `max`), then at a line break, then at a space.
 */
export function splitMarkdownIntoModules(markdown: string, max = 20_000): string[] {
  const out: string[] = [];
  let rest = markdown;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf('\n');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  out.push(rest);
  return out;
}

/**
 * Module text (paragraph, heading, quote, list items, button label, alt) back to what the editor typed: stored "&lt;" shown as "<".
 * Paragraph and quote text too. Output is escaped again on write (escapeHtmlInMarkdown for the body, escapeStoryBlocks for modules).
 */
export function unescapeStoryBlockPlainText(blocks: StoryBlock[]): StoryBlock[] {
  const un = (v: string) => v.replace(/&lt;/g, '<');
  return blocks.map((b) => {
    const o: StoryBlock = { ...b };
    if (o.text !== undefined) o.text = un(o.text); // paragraph and quote too: the editor shows what was typed, and every "<" is escaped again on write
    if (o.items) o.items = o.items.map(un);
    if (o.alt !== undefined) o.alt = un(o.alt);
    if (o.photos) o.photos = o.photos.map((p) => ({ ...p, alt: un(p.alt ?? '') }));
    if (o.label !== undefined) o.label = un(o.label);
    return o;
  });
}
