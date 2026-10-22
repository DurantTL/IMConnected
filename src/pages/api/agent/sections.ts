import type { APIRoute } from 'astro';
import { agentAuth, agentJson } from '../../../lib/agent-api';
import { AGENT_LIMITS, agentRateLimited } from '../../../lib/agent';
import { LIMITS } from '../../../lib/limits';
import { SECTIONS } from '../../../lib/site';

// Lets the agent pick valid section and area keys. Same bearer token as POST /api/agent/stories; no CORS.
export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  const denied = agentAuth(request);
  if (denied) return denied;
  if (agentRateLimited()) return agentJson(429, { ok: false, error: 'rate_limited', message: 'Too many requests. The limit is 60 per hour.' }, { 'Retry-After': '3600' });
  return agentJson(200, {
    ok: true,
    sections: SECTIONS.map((s) => ({ key: s.key, label: s.label, areas: s.areas ? s.areas.map((a) => ({ key: a.key, label: a.label })) : null })),
    announcement: { kinds: ['announcement', 'event'], fields: ['kind', 'eventDate', 'location', 'links', 'videoUrl'], maxLinks: 3, videoProviders: ['YouTube', 'Vimeo'], flyer: 'First uploaded photo; JPG, PNG or WebP. Use body text for an accessible summary.', omission: 'Preserves existing metadata on update; null clears it.' },
    reopen: { endpoint: '/api/agent/stories/reopen', method: 'POST', required: ['slug', 'requestId'], photos: 'Append only, maximum six total; lead flyer retained.', review: 'An editor must publish the update. Open or rejected drafts cannot be overwritten.', retries: 'Retry the identical JSON body with the same requestId.' },
    limits: { title: LIMITS.title, dek: LIMITS.dek, body: LIMITS.bodyMax, photos: LIMITS.maxPhotos, photoMB: LIMITS.maxPhotoMB, note: AGENT_LIMITS.note },
  });
};

export const ALL: APIRoute = () => agentJson(405, { ok: false, error: 'method_not_allowed', message: 'Use GET.' }, { Allow: 'GET' });
