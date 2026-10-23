import { normalizeAdditionalSections } from './site';
import { normalizeAnnouncement, type Announcement } from './announcement';
import { photoMarkerIndex } from './story-media';
// Validates a request from the AI agent (POST /api/agent/stories) into a story draft.
// The agent's text gets the same treatment as a dashboard draft: control characters removed, every "<" in the
// body written as &lt; (escapeHtmlInMarkdown), and nothing is ever fetched: photos must be data: images.
import { getSection, isValidArea } from './site';
import { LIMITS } from './limits';
import { sniffImage } from './submission';
import { clean, escapeHtmlInMarkdown, validDate } from './storyfile';
import { takeSlot } from './rate-window';
import { isPhotoLayout, PHOTO_LAYOUT_VALUES, type PhotoLayout } from './photo-layouts';

export class AgentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const AGENT_LIMITS = { maxBodyBytes: 40 * 1024 * 1024, author: 120, authorTitle: 120, photoCredit: 120, church: 160, alt: 300, note: 1000, url: 2000, perHour: 60, batchMaxStories: 20, batchStoriesPerHour: 300 };
/** Room kept for the JSON around the photos (title, body of up to 20,000 characters, keys, quotes). */
export const AGENT_JSON_ALLOWANCE_BYTES = 128 * 1024;
/**
 * Photos travel as base64 data: URLs, which are 4/3 the size of the image: the most image bytes one request can
 * carry is floor(maxBodyBytes * 3 / 4) minus the JSON allowance (about 30 MB, not 40 MB).
 */
export function maxImageBytesPerRequest(): number {
  return Math.floor((AGENT_LIMITS.maxBodyBytes * 3) / 4) - AGENT_JSON_ALLOWANCE_BYTES;
}

/** A 409 (or other non-400 refusal) that carries a stable `reason` and extra fields for the response. */
export class AgentConflict extends AgentError {
  constructor(code: string, message: string, public status = 409, public details: Record<string, unknown> = {}) {
    super(code, message);
  }
}

export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export type RefusalReason = 'published' | 'in_review' | 'editor_editing' | 'rejected' | 'open_draft_exists';

/** The body fields every "this draft cannot be changed" 409 carries, so the agent knows what to do next. */
export function refusalDetails(reason: RefusalReason, id: number | null, slug: string | null, live = true): { reason: RefusalReason; id: number | null; message: string } {
  const gone = 'The agent API cannot send anything more for it; contact the communication director if something must change.';
  const messages: Record<RefusalReason, string> = {
    published: live
      ? `This story is already published. Use POST /api/agent/stories/reopen with slug ${slug ?? '<slug>'} to propose changes for review.`
      : `This story was published and later unpublished, so it cannot be reopened through the API. An editor must handle it; ${gone}`,
    in_review: `An editor has this draft in review, so it was not changed. ${gone}`,
    editor_editing: `An editor is working on this draft, so it was not changed. ${gone}`,
    rejected: `An editor rejected this draft, so it was not changed. ${gone}`,
    open_draft_exists: 'A draft for this story is already waiting for review, so nothing was changed. An editor will see it.',
  };
  return { reason, id, message: messages[reason] };
}

/** Which refusal reason fits a draft the agent may not overwrite. */
export function refusalReason(status: string, touchedByEditor: boolean): RefusalReason {
  if (status === 'published') return 'published';
  if (status === 'rejected') return 'rejected';
  if (status === 'in_review') return 'in_review';
  return touchedByEditor ? 'editor_editing' : 'open_draft_exists';
}

/** Canonical text of a JSON value (sorted keys), so a retry with reordered keys still counts as identical. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** null = no requestId sent. Throws AgentError (400) for a malformed one. */
export function parseRequestId(o: Record<string, unknown>): string | null {
  if (o.requestId === undefined || o.requestId === null) return null;
  if (typeof o.requestId !== 'string' || !REQUEST_ID_RE.test(o.requestId)) throw new AgentError('bad_request_id', 'requestId must contain 8–128 letters, digits, underscores or hyphens.');
  return o.requestId;
}

/** The link the agent sent, normalized exactly as it is stored (so lookups and updates find the same draft). */
export function normalizeSourceUrl(rawUrl: string): string {
  if (rawUrl.length > AGENT_LIMITS.url) throw new AgentError('bad_source_url', 'sourceUrl is too long.');
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new AgentError('bad_source_url', 'sourceUrl must be an http(s) link.');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw new AgentError('bad_source_url', 'sourceUrl must be an http(s) link.');
  return u.href;
}

export interface AgentPhoto {
  bytes: Uint8Array;
  ext: string;
  alt: string;
  /** Optional crop, validated; undefined = the editor defaults (50 / 50 / 1). */
  focalX?: number;
  focalY?: number;
  zoom?: number;
}

export interface AgentStory {
  /** null = remove the announcement. An object is never here: it is `announcementPatch` (merged where the draft is known). */
  announcement?: Announcement | null;
  /** A partial announcement object (see mergeAnnouncement); create needs `kind`, an update/reopen merges it into the stored one. */
  announcementPatch?: Record<string, unknown>;
  /** '' = not sent or cleared (see `present`). */
  authorTitle: string;
  photoCredit: string;
  /** undefined = not sent. */
  featured?: boolean;
  title: string;
  dek: string;
  /** Safe Markdown. */
  body: string;
  /** '' when the agent sent none: the editor picks it. */
  section: string;
  additionalSections?: string[];
  area: string;
  author: string;
  church: string;
  /** '' = not given (today on create, unchanged on update). */
  date: string;
  sourceUrl: string | null;
  note: string;
  /** null = not sent: a new draft gets the default look, an updated one keeps its layout. */
  photoLayout: PhotoLayout | null;
  /** null = the request had no `photos` key: an update leaves the draft's photos alone. */
  photos: AgentPhoto[] | null;
  /** Optional retry key (raw); stored only as a hash. */
  requestId?: string | null;
  /** Hash input for retry protection: the request's content without the requestId. */
  payloadKey?: string;
  /**
   * Keys the request actually sent (value not undefined). An update changes only these; an explicit "" or null
   * clears an optional text field. Missing = every key counts as sent (callers that build the input by hand).
   */
  present?: ReadonlySet<string>;
}

const PHOTO_MAX_BYTES = LIMITS.maxPhotoMB * 1024 * 1024;

function optional(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new AgentError('bad_field', `"${key}" must be text.`);
  return clean(v);
}
const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim();

function parsePhoto(raw: unknown): AgentPhoto {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentError('photo_invalid', 'Each photo must be an object like {"data":"data:image/jpeg;base64,...","alt":"..."}.');
  const p = raw as Record<string, unknown>;
  const data = typeof p.data === 'string' ? p.data.trim() : '';
  if (!data.startsWith('data:')) {
    // A link, a bare URL, or a "url" key: the site never fetches remote images (links expire, and fetching is an SSRF risk).
    throw new AgentError('photo_remote_url', 'Photos must be data: URLs. The site never downloads remote photo links.');
  }
  const comma = data.indexOf(',');
  const head = comma === -1 ? '' : data.slice(0, comma);
  if (!/^data:[^;,]*;base64$/i.test(head)) throw new AgentError('photo_invalid', 'A photo data URL must be base64 encoded (data:image/jpeg;base64,...).');
  const b64 = data.slice(comma + 1).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new AgentError('photo_invalid', 'A photo is not valid base64.');
  if ((b64.length * 3) / 4 > PHOTO_MAX_BYTES + 3) throw new AgentError('photo_too_large', `A photo is larger than ${LIMITS.maxPhotoMB} MB.`);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > PHOTO_MAX_BYTES) throw new AgentError('photo_too_large', `A photo is larger than ${LIMITS.maxPhotoMB} MB.`);
  const ext = sniffImage(bytes);
  if (!ext) throw new AgentError('photo_not_image', 'A photo is not a JPG, PNG, WebP or AVIF image.');
  const alt = oneLine(optional(p, 'alt')).slice(0, AGENT_LIMITS.alt);
  const crop: { focalX?: number; focalY?: number; zoom?: number } = {};
  for (const [key, lo, hi] of [['focalX', 0, 100], ['focalY', 0, 100], ['zoom', 1, 3]] as const) {
    const v = p[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new AgentError('bad_photo_crop', `Photo ${key} must be a number from ${lo} to ${hi}.`);
    crop[key] = key === 'zoom' ? Math.round(v * 100) / 100 : v;
  }
  return { bytes: new Uint8Array(bytes), ext, alt, ...crop };
}

/**
 * A line-based check: standalone `{{photo N}}` lines outside fenced or indented code (a backslash-escaped one counts, the
 * renderer still renders it) must point at a photo the draft will have. Not a full CommonMark parse (lazy continuations,
 * setext headings and similar edge cases are not replicated); quotes, lists and inline markers are not checked.
 */
export function assertPhotoMarkers(body: string, photoCount: number): void {
  let fence: string | null = null;
  for (const raw of body.split('\n')) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) { if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null; continue; }
    if (fenceMatch) { fence = fenceMatch[1]; continue; }
    if (/^(?: {4,}|\t)/.test(raw)) continue;
    const line = raw.trim();
    // The renderer drops the backslash of an escaped marker and still renders it, so it is checked like any other.
    const n = photoMarkerIndex(line.startsWith('\\{{') ? line.slice(1) : line, Infinity);
    if (n !== null && n >= photoCount) throw new AgentError('bad_photo_marker', `The marker "${line}" points to photo ${n + 1}, but the story will have ${photoCount} photo${photoCount === 1 ? '' : 's'}.`);
  }
}

/** Throws AgentError (HTTP 400) with a stable `code`. */
export function parseAgentStory(input: unknown): AgentStory {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AgentError('invalid_json', 'The request body must be a JSON object.');
  const o = input as Record<string, unknown>;
  const present = new Set(Object.keys(o).filter((k) => o[k] !== undefined));
  const requestId = parseRequestId(o);

  const title = oneLine(optional(o, 'title'));
  const dek = oneLine(optional(o, 'dek'));
  const bodyRaw = optional(o, 'body').trim();
  const author = oneLine(optional(o, 'author'));
  const church = oneLine(optional(o, 'church'));
  const authorTitle = oneLine(optional(o, 'authorTitle'));
  const photoCredit = oneLine(optional(o, 'photoCredit'));
  const section = optional(o, 'section').trim();
  const area = optional(o, 'area').trim();
  const date = optional(o, 'date').trim();
  const note = optional(o, 'note').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // A missing title or body is checked when the draft is created: an update that omits them keeps the stored text.
  // Sending one as "" or null is never allowed.
  if (present.has('title') && !title) throw new AgentError('title_required', 'A story needs a title.');
  if (title.length > LIMITS.title) throw new AgentError('title_too_long', `The title is longer than ${LIMITS.title} characters.`);
  if (dek.length > LIMITS.dek) throw new AgentError('dek_too_long', `The summary (dek) is longer than ${LIMITS.dek} characters.`);
  if (present.has('body') && !bodyRaw) throw new AgentError('body_required', 'A story needs body text.');
  if (bodyRaw.length > LIMITS.bodyMax) throw new AgentError('body_too_long', `The body is longer than ${LIMITS.bodyMax} characters.`);
  if (author.length > AGENT_LIMITS.author) throw new AgentError('author_too_long', 'The author is too long.');
  if (church.length > AGENT_LIMITS.church) throw new AgentError('church_too_long', 'The church is too long.');
  if (authorTitle.length > AGENT_LIMITS.authorTitle) throw new AgentError('author_title_too_long', `The author title is longer than ${AGENT_LIMITS.authorTitle} characters.`);
  if (photoCredit.length > AGENT_LIMITS.photoCredit) throw new AgentError('photo_credit_too_long', `The photo credit is longer than ${AGENT_LIMITS.photoCredit} characters.`);
  if (o.featured !== undefined && typeof o.featured !== 'boolean') throw new AgentError('bad_field', '"featured" must be true or false.');
  if (note.length > AGENT_LIMITS.note) throw new AgentError('note_too_long', `The note is longer than ${AGENT_LIMITS.note} characters.`);

  // A missing section is allowed (the editor picks it); a wrong one is not.
  if (section && !getSection(section)) throw new AgentError('bad_section', 'That section does not exist. GET /api/agent/sections lists the valid ones.');
  // An area without a section is checked against the draft's stored section when an update applies it.
  if (area && section && !isValidArea(section, area)) throw new AgentError('bad_area', 'That area is not valid for this section.');
  let photoLayout: PhotoLayout | null = null;
  if (o.photoLayout !== undefined && o.photoLayout !== null) {
    if (!isPhotoLayout(o.photoLayout)) throw new AgentError('bad_photo_layout', `photoLayout must be one of: ${PHOTO_LAYOUT_VALUES.join(', ')}.`);
    photoLayout = o.photoLayout;
  }
  if (date && !validDate(date)) throw new AgentError('bad_date', 'The date must look like 2026-10-19.');

  let sourceUrl: string | null = null;
  const rawUrl = optional(o, 'sourceUrl').trim();
  if (rawUrl) {
    sourceUrl = normalizeSourceUrl(rawUrl);
  }

  let photos: AgentPhoto[] | null = null;
  if (o.photos !== undefined && o.photos !== null) {
    if (!Array.isArray(o.photos)) throw new AgentError('photos_invalid', 'photos must be a list.');
    if (o.photos.length > LIMITS.maxPhotos) throw new AgentError('too_many_photos', `Send up to ${LIMITS.maxPhotos} photos.`);
    photos = o.photos.map(parsePhoto);
  }

  let additionalSections: string[] | undefined;
  if (o.additionalSections !== undefined) { try { additionalSections = normalizeAdditionalSections(o.additionalSections, section); } catch (e) { throw new AgentError('bad_additional_sections', (e as Error).message); } }
  let announcement: Announcement | null | undefined;
  let announcementPatch: Record<string, unknown> | undefined;
  if (o.announcement === null) announcement = null;
  else if (o.announcement !== undefined) {
    // Validate the fields now (with a stand-in kind when the patch has none); the real merge happens against the stored value.
    try {
      if (!o.announcement || typeof o.announcement !== 'object' || Array.isArray(o.announcement)) throw new Error('Announcement must be an object or null.');
      const patch = o.announcement as Record<string, unknown>;
      normalizeAnnouncement({ kind: 'event', ...patch });
      announcementPatch = patch;
    } catch (e) { throw new AgentError('bad_announcement', (e as Error).message); }
  }
  const { requestId: _ignored, ...content } = o;
  return { additionalSections, announcement, announcementPatch, authorTitle, photoCredit, featured: o.featured as boolean | undefined, title, dek, body: escapeHtmlInMarkdown(bodyRaw), section, area, author, church, date, sourceUrl, note, photoLayout, photos, requestId, payloadKey: canonicalJson(content), present };
}

// ---- 60 requests per hour per token (the agent has one token, so one counter) ----
const WINDOW_MS = 60 * 60 * 1000;
const hits: number[] = [];
/** True when this request is over the limit. */
export function agentRateLimited(now = Date.now()): boolean {
  return !takeSlot(hits, now, AGENT_LIMITS.perHour, WINDOW_MS);
}

// ---- bulk submit: a separate ceiling on stories per hour (each batch request also counts once against the 60/hour above) ----
const itemHits: number[] = [];
/** Stories per hour for batches. AGENT_BATCH_ITEMS_PER_HOUR is test/ops tuning; the default is 300. */
export function batchStoriesPerHour(env = process.env): number {
  const n = Number(env.AGENT_BATCH_ITEMS_PER_HOUR);
  return Number.isInteger(n) && n >= 1 ? n : AGENT_LIMITS.batchStoriesPerHour;
}
/**
 * Reserves `count` stories from the hourly budget. All or nothing: when the batch would not fit, nothing is
 * recorded and `retryAfter` (seconds) says when enough older stories will have aged out of the window.
 */
export function takeBatchStories(count: number, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } | { ok: false; tooLarge: true; max: number } {
  const max = batchStoriesPerHour();
  // A batch bigger than the whole ceiling can never fit: say so instead of a 429 that never succeeds.
  if (count > max) return { ok: false, tooLarge: true, max };
  let keep = 0;
  for (const t of itemHits) if (now - t < WINDOW_MS) itemHits[keep++] = t;
  itemHits.length = keep;
  if (itemHits.length + count > max) {
    const need = itemHits.length + count - max; // this many old entries must expire
    const at = need <= itemHits.length ? itemHits[need - 1] : now;
    return { ok: false, retryAfter: need > itemHits.length ? 3600 : Math.max(1, Math.ceil((at + WINDOW_MS - now) / 1000)) };
  }
  for (let i = 0; i < count; i++) itemHits.push(now);
  return { ok: true };
}
/** Gives back budget taken for stories that failed transiently (database trouble), so retries do not exhaust the hour. */
export function returnBatchStories(count: number): void {
  for (let i = 0; i < count && itemHits.length; i++) itemHits.pop();
}
