// Version-one story modules. Pure validation and Markdown projection shared by the editor and server.
// The Markdown body remains available to search, feeds and older consumers; the structured modules own layout.
export const STORY_BLOCK_TYPES = ['text', 'heading', 'quote', 'list', 'image', 'button', 'divider'] as const;
export type StoryBlockType = (typeof STORY_BLOCK_TYPES)[number];
export interface StoryBlock {
  id: string;
  type: StoryBlockType;
  text?: string;
  level?: 2 | 3;
  items?: string[];
  photoId?: number;
  url?: string;
  label?: string;
  alt?: string;
  focalX?: number;
  focalY?: number;
}

export const STORY_BLOCK_LIMIT = 60;
const error = (message: string): never => { throw new Error(message); };
const text = (value: unknown, limit: number, label: string): string => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit) return error(`${label} must be text of at most ${limit.toLocaleString('en-US')} characters.`);
  return value.replace(/\u0000/g, '');
};

/** A constrained image source, never arbitrary HTML, CSS, a data URL or a protected draft endpoint. */
export function isStoryImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (/^\/(?:media|images)\/stories\/[A-Za-z0-9._/-]+$/.test(value)) {
    return !value.split('/').some((part) => part === '.' || part === '..');
  }
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch { return false; }
}

/** Explicit action links only. No script schemes, protocol-relative addresses or embedded credentials. */
export function isStoryButtonUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const u = new URL(value);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol) && !u.username && !u.password;
  } catch { return false; }
}

export function focalPoint(value: unknown): number {
  if (value === undefined || value === null || value === '') return 50;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) return error('Photo focus must be between 0 and 100.');
  return Math.round(n * 100) / 100;
}

/** Omits the style for the default focus so existing stories keep their original markup. */
export function photoFocusStyle(focus?: { focalX?: number; focalY?: number } | null): string | undefined {
  const x = focalPoint(focus?.focalX), y = focalPoint(focus?.focalY);
  return x === 50 && y === 50 ? undefined : `object-position:${x}% ${y}%;`;
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
    if (b.type === 'image') {
      if (r.photoId !== undefined) {
        if (typeof r.photoId !== 'number' || !Number.isSafeInteger(r.photoId) || r.photoId < 1) return error('Choose a valid story photo.');
        b.photoId = r.photoId;
      }
      if (r.url !== undefined && r.url !== '') {
        if (!isStoryImageUrl(r.url)) return error('Choose an uploaded story photo or a valid HTTPS image.');
        b.url = r.url;
      }
      b.alt = text(r.alt, 300, 'Photo description');
      if (r.focalX !== undefined) b.focalX = focalPoint(r.focalX);
      if (r.focalY !== undefined) b.focalY = focalPoint(r.focalY);
      total += b.alt.length;
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

export function parseStoryBlocks(input: unknown): StoryBlock[] {
  if (typeof input !== 'string') return normalizeStoryBlocks(input);
  if (input.length > 400_000) return error('The story modules are too large.');
  try { return normalizeStoryBlocks(JSON.parse(input)); } catch (e) {
    if (e instanceof SyntaxError) return error('The story modules could not be read.');
    throw e;
  }
}
export const parseStoredStoryBlocks = parseStoryBlocks;

const plainMarkdown = (value: string) => value.replace(/[\\`*_[\]<>#]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');

/** Search/legacy projection. Image modules do not add an inaccessible draft-photo URL to the body. */
export function storyBlocksToMarkdown(blocks: StoryBlock[]): string {
  return normalizeStoryBlocks(blocks).map((b) => {
    switch (b.type) {
      case 'text': return b.text || '';
      case 'heading': return `${'#'.repeat(b.level || 2)} ${plainMarkdown(b.text || '')}`;
      case 'quote': return (b.text || '').split('\n').map((line) => `> ${line}`).join('\n');
      case 'list': return (b.items || []).map((item) => `- ${plainMarkdown(item)}`).join('\n');
      case 'image': return b.alt ? plainMarkdown(b.alt) : '';
      case 'button': return b.url ? `[${plainMarkdown(b.label || b.url)}](${b.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : plainMarkdown(b.label || '');
      case 'divider': return '---';
    }
  }).filter(Boolean).join('\n\n');
}
export const blocksToMarkdown = storyBlocksToMarkdown;
