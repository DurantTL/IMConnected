import type { APIRoute } from 'astro';
import { agentAuth, agentJson } from '../../../lib/agent-api';
import { AGENT_JSON_ALLOWANCE_BYTES, AGENT_LIMITS, agentRateLimited, maxImageBytesPerRequest } from '../../../lib/agent';
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
    readBack: { byId: '/api/agent/stories/<id>', bySourceUrl: '/api/agent/stories?sourceUrl=<link>', method: 'GET' },
    requestId: { field: 'requestId', pattern: '8-128 characters: letters, digits, underscore, hyphen', behavior: 'An identical retry answers 200 with status "replayed" and changes nothing; the same requestId with a different body is 409 request_id_reused.' },
    announcement: { kinds: ['announcement', 'event'], fields: ['kind', 'eventDate', 'location', 'links', 'videoUrl'], maxLinks: 3, videoProviders: ['YouTube', 'Vimeo'], flyer: 'First uploaded photo; JPG, PNG, WebP or AVIF. Use body text for an accessible summary.', omission: 'Preserves existing metadata on update; null clears it.' },
    reopen: { endpoint: '/api/agent/stories/reopen', method: 'POST', required: ['slug', 'requestId'], photos: 'Append only, maximum six total; lead flyer retained.', review: 'An editor must publish the update. Open or rejected drafts cannot be overwritten.', retries: 'Retry the identical JSON body with the same requestId.' },
    limits: { title: LIMITS.title, dek: LIMITS.dek, body: LIMITS.bodyMax, photos: LIMITS.maxPhotos, photoMB: LIMITS.maxPhotoMB, note: AGENT_LIMITS.note },
  });
};

export const ALL: APIRoute = () => agentJson(405, { ok: false, error: 'method_not_allowed', message: 'Use GET.' }, { Allow: 'GET' });
