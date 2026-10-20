// Validates a request from the AI agent (POST /api/agent/stories) into a story draft.
// The agent's text gets the same treatment as a dashboard draft: control characters removed, every "<" in the
// body written as &lt; (escapeHtmlInMarkdown), and nothing is ever fetched: photos must be data: images.
import { getSection, isValidArea } from './site';
import { LIMITS } from './limits';
import { sniffImage } from './submission';
import { clean, escapeHtmlInMarkdown, validDate } from './storyfile';

export class AgentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const AGENT_LIMITS = { maxBodyBytes: 40 * 1024 * 1024, author: 120, church: 160, alt: 300, note: 1000, url: 2000, perHour: 60 };

export interface AgentPhoto {
  bytes: Uint8Array;
  ext: string;
  alt: string;
}

export interface AgentStory {
  title: string;
  dek: string;
  /** Safe Markdown. */
  body: string;
  /** '' when the agent sent none: the editor picks it. */
  section: string;
  area: string;
  author: string;
  church: string;
  /** '' = not given (today on create, unchanged on update). */
  date: string;
  sourceUrl: string | null;
  note: string;
  /** null = the request had no `photos` key: an update leaves the draft's photos alone. */
  photos: AgentPhoto[] | null;
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
  const ext = sniffImage(new Uint8Array(bytes.subarray(0, 16)));
  if (!ext) throw new AgentError('photo_not_image', 'A photo is not a JPG, PNG or WebP image.');
  const alt = oneLine(optional(p, 'alt')).slice(0, AGENT_LIMITS.alt);
  return { bytes: new Uint8Array(bytes), ext, alt };
}

/** Throws AgentError (HTTP 400) with a stable `code`. */
export function parseAgentStory(input: unknown): AgentStory {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AgentError('invalid_json', 'The request body must be a JSON object.');
  const o = input as Record<string, unknown>;

  const title = oneLine(optional(o, 'title'));
  const dek = oneLine(optional(o, 'dek'));
  const bodyRaw = optional(o, 'body').trim();
  const author = oneLine(optional(o, 'author'));
  const church = oneLine(optional(o, 'church'));
  const section = optional(o, 'section').trim();
  const area = optional(o, 'area').trim();
  const date = optional(o, 'date').trim();
  const note = optional(o, 'note').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!title) throw new AgentError('title_required', 'A story needs a title.');
  if (title.length > LIMITS.title) throw new AgentError('title_too_long', `The title is longer than ${LIMITS.title} characters.`);
  if (dek.length > LIMITS.dek) throw new AgentError('dek_too_long', `The summary (dek) is longer than ${LIMITS.dek} characters.`);
  if (!bodyRaw) throw new AgentError('body_required', 'A story needs body text.');
  if (bodyRaw.length > LIMITS.bodyMax) throw new AgentError('body_too_long', `The body is longer than ${LIMITS.bodyMax} characters.`);
  if (author.length > AGENT_LIMITS.author) throw new AgentError('author_too_long', 'The author is too long.');
  if (church.length > AGENT_LIMITS.church) throw new AgentError('church_too_long', 'The church is too long.');
  if (note.length > AGENT_LIMITS.note) throw new AgentError('note_too_long', `The note is longer than ${AGENT_LIMITS.note} characters.`);

  // A missing section is allowed (the editor picks it); a wrong one is not.
  if (section && !getSection(section)) throw new AgentError('bad_section', 'That section does not exist. GET /api/agent/sections lists the valid ones.');
  if (area && !section) throw new AgentError('bad_area', 'Send a section together with an area.');
  if (area && !isValidArea(section, area)) throw new AgentError('bad_area', 'That area is not valid for this section.');
  if (date && !validDate(date)) throw new AgentError('bad_date', 'The date must look like 2026-10-19.');

  let sourceUrl: string | null = null;
  const rawUrl = optional(o, 'sourceUrl').trim();
  if (rawUrl) {
    if (rawUrl.length > AGENT_LIMITS.url) throw new AgentError('bad_source_url', 'sourceUrl is too long.');
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new AgentError('bad_source_url', 'sourceUrl must be an http(s) link.');
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw new AgentError('bad_source_url', 'sourceUrl must be an http(s) link.');
    sourceUrl = u.href;
  }

  let photos: AgentPhoto[] | null = null;
  if (o.photos !== undefined && o.photos !== null) {
    if (!Array.isArray(o.photos)) throw new AgentError('photos_invalid', 'photos must be a list.');
    if (o.photos.length > LIMITS.maxPhotos) throw new AgentError('too_many_photos', `Send up to ${LIMITS.maxPhotos} photos.`);
    photos = o.photos.map(parsePhoto);
  }

  return { title, dek, body: escapeHtmlInMarkdown(bodyRaw), section, area, author, church, date, sourceUrl, note, photos };
}

// ---- 60 requests per hour per token (the agent has one token, so one counter) ----
const WINDOW_MS = 60 * 60 * 1000;
let hits: number[] = [];
/** True when this request is over the limit. */
export function agentRateLimited(now = Date.now()): boolean {
  hits = hits.filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  return hits.length > AGENT_LIMITS.perHour;
}
