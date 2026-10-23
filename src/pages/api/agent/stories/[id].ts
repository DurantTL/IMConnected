import type { APIRoute } from 'astro';
import { agentAuth, agentJson } from '../../../../lib/agent-api';
import { agentRateLimited } from '../../../../lib/agent';
import { readAgentDraftById } from '../../../../lib/agent-read';

// GET /api/agent/stories/<id>: what the agent's own draft holds now (including an editor's later changes).
// Drafts from any other source are 404, exactly like a missing id. Same bearer token and 60/hour window as the
// rest of /api/agent/*. `stories/reopen` is a static route and takes precedence over this dynamic one.
export const prerender = false;

export const GET: APIRoute = ({ request, params }) => {
  const denied = agentAuth(request);
  if (denied) return denied;
  if (agentRateLimited()) return agentJson(429, { ok: false, error: 'rate_limited', message: 'Too many requests. The limit is 60 per hour.' }, { 'Retry-After': '3600' });
  const id = /^[1-9]\d{0,9}$/.test(params.id ?? '') ? Number(params.id) : 0;
  let draft;
  try {
    draft = id ? readAgentDraftById(id) : null;
  } catch {
    return agentJson(503, { ok: false, error: 'unavailable', message: 'The draft could not be read right now. Please try again in a few minutes.' });
  }
  if (!draft) return agentJson(404, { ok: false, error: 'not_found', message: 'No draft from the agent has that id.' });
  return agentJson(200, { ok: true, draft });
};

export const ALL: APIRoute = () => agentJson(405, { ok: false, error: 'method_not_allowed', message: 'Use GET.' }, { Allow: 'GET' });
