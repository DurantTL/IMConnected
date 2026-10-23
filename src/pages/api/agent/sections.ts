import type { APIRoute } from 'astro';
import { agentAuth, agentJson } from '../../../lib/agent-api';
import { AGENT_JSON_ALLOWANCE_BYTES, AGENT_LIMITS, agentRateLimited, batchStoriesPerHour, maxImageBytesPerRequest } from '../../../lib/agent';
import { PHOTO_LAYOUT_VALUES } from '../../../lib/photo-layouts';
import { LIMITS } from '../../../lib/limits';
import { SECTIONS } from '../../../lib/site';
import { IMAGE_TYPES } from '../../../lib/image-formats.mjs';

// Lets the agent pick valid section and area keys. Same bearer token as POST /api/agent/stories; no CORS.
export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  const denied = agentAuth(request);
  if (denied) return denied;
  if (agentRateLimited()) return agentJson(429, { ok: false, error: 'rate_limited', message: 'Too many requests. The limit is 60 per hour.' }, { 'Retry-After': '3600' });
  return agentJson(200, {
    ok: true,
    sections: SECTIONS.map((s) => ({ key: s.key, label: s.label, areas: s.areas ? s.areas.map((a) => ({ key: a.key, label: a.label })) : null })),
    additionalSections: { field: 'additionalSections', values: SECTIONS.map((s) => s.key), semantics: 'Extra discovery memberships. Omission preserves existing assignments; [] clears extras. Area belongs to the primary section.' },
    newsletterIssue: { field: 'newsletterIssue', shape: { number: '1-9999', date: 'YYYY-MM-DD, the day the issue was sent; a real day, not in the future', title: 'optional text, up to 200 characters', position: 'optional, 1-999: where the story sat in the issue' }, appliesTo: ['create', 'update of a new untouched draft', 'reopen changes.newsletterIssue', 'each batch item'],
      semantics: 'An unknown number creates the issue with the draft. A known number with the same date is reused. A different date, or a different non-empty title, is 400 newsletter_issue_conflict naming the stored date: the agent never changes an existing issue (an administrator corrects it). The object sets issue and position together (a missing position clears it). Omitted keeps the stored value; null clears the draft\'s issue and position. Malformed is 400 bad_newsletter_issue. Read-back returns newsletterIssue {number, date, title, position} or null.' },
    photoFormats: Object.keys(IMAGE_TYPES),
    photoLayouts: [...PHOTO_LAYOUT_VALUES],
    photoMimeTypes: Object.values(IMAGE_TYPES),
    // Photos are base64 in the JSON, 4/3 their size: maxImageBytesPerRequest = floor(maxRequestBytes * 3 / 4) - jsonAllowanceBytes.
    photoBudget: {
      maxPhotos: LIMITS.maxPhotos,
      maxPhotoBytes: LIMITS.maxPhotoMB * 1024 * 1024,
      maxRequestBytes: AGENT_LIMITS.maxBodyBytes,
      maxImageBytesPerRequest: maxImageBytesPerRequest(),
      jsonAllowanceBytes: AGENT_JSON_ALLOWANCE_BYTES,
    },
    batch: { endpoint: '/api/agent/stories/batch', method: 'POST', required: ['requestId', 'stories'], maxBatchStories: AGENT_LIMITS.batchMaxStories, maxStoriesPerHour: batchStoriesPerHour(), note: 'Each item is the same object as POST /api/agent/stories and is written independently; the response lists one result per item. The whole request shares one photoBudget (maxImageBytesPerRequest, 40 MiB body), so photo-heavy batches must be split. A batch counts as one of the 60 calls per hour and its stories count against maxStoriesPerHour; over that, the whole batch is 429 and nothing is written. Retry the identical body with the same batch requestId. See docs/AGENT-BATCH.md.' },
    readBack: { byId: '/api/agent/stories/<id>', bySourceUrl: '/api/agent/stories?sourceUrl=<link>', method: 'GET' },
    requestId: { field: 'requestId', pattern: '8-128 characters: letters, digits, underscore, hyphen', behavior: 'An identical retry answers 200 with status "replayed" and changes nothing; the same requestId with a different body is 409 request_id_reused.' },
    announcement: { kinds: ['announcement', 'event'], fields: ['kind', 'eventDate', 'location', 'links', 'videoUrl'], maxLinks: 3, videoProviders: ['YouTube', 'Vimeo'], flyer: 'First uploaded photo; JPG, PNG, WebP or AVIF. Use body text for an accessible summary.', omission: 'Preserves existing metadata on update; null clears it.',
      patch: { appliesTo: ['update of a new untouched draft (same sourceUrl)', 'reopen changes.announcement'], semantics: 'An object is a partial merge into the stored announcement: only the keys you send change; "" clears eventDate, location or videoUrl; links replaces the whole list; null removes the announcement. kind is required only when there is no announcement yet. The merged result is validated as a whole. Create takes the full object.' } },
    photoCrop: { fields: ['focalX', 'focalY', 'zoom'], ranges: { focalX: [0, 100], focalY: [0, 100], zoom: [1, 3] }, defaults: { focalX: 50, focalY: 50, zoom: 1 }, appliesTo: 'each object in photos (create, update, reopen appended photos); invalid is 400 bad_photo_crop', planned: ['fit'] },
    photoCaption: { field: 'caption', maxLength: AGENT_LIMITS.caption, appliesTo: 'each object in photos (create, update, reopen appended photos); plain text on one line, shown under the photo, never HTML or Markdown; longer than the limit is 400 photo_caption_too_long', note: 'alt describes the image for screen readers; the caption is visible to everyone. Read-back returns caption per photo. Existing photos keep their captions on reopen.' },
    storyFields: { authorTitle: { maxLength: AGENT_LIMITS.authorTitle, clear: '""' }, photoCredit: { maxLength: AGENT_LIMITS.photoCredit, clear: '""' }, featured: { type: 'boolean', note: 'Stored on the draft only; an editor still reviews and publishes.' }, omission: 'Omitted keeps the stored value (update, reopen changes).' },
    photoMarkers: { syntax: '{{photo N}}', rule: 'A standalone line; 1 = the lead photo. N may not exceed the photos the draft will have after the request (400 bad_photo_marker). This is a line-based check of standalone marker lines outside fenced or indented code (a backslash-escaped marker line counts). Markers in code, quotes, lists or mid-sentence are not checked, and malformed markers such as {{photo 0}} are ignored by the renderer and not validated.' },
    reopen: { endpoint: '/api/agent/stories/reopen', method: 'POST', required: ['slug', 'requestId'], photos: 'Append only, maximum six total; lead flyer retained.', changesFields: ['title', 'dek', 'body', 'section', 'area', 'author', 'authorTitle', 'church', 'date', 'photoCredit', 'photoLayout', 'featured', 'announcement', 'additionalSections', 'newsletterIssue'], sectionOnly: 'changes.section without changes.area moves the story to the new section\'s default area (its first area, or none).', review: 'An editor must publish the update. Open or rejected drafts cannot be overwritten.', retries: 'Retry the identical JSON body with the same requestId.' },
    limits: { title: LIMITS.title, dek: LIMITS.dek, body: LIMITS.bodyMax, photos: LIMITS.maxPhotos, photoMB: LIMITS.maxPhotoMB, note: AGENT_LIMITS.note },
  });
};

export const ALL: APIRoute = () => agentJson(405, { ok: false, error: 'method_not_allowed', message: 'Use GET.' }, { Allow: 'GET' });
