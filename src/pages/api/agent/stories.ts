import type { APIRoute } from 'astro';
import { agentAuth, agentJson } from '../../../lib/agent-api';
import { AgentError, AGENT_LIMITS, agentRateLimited, parseAgentStory } from '../../../lib/agent';
import { readLimited } from '../../../lib/bearer';
import { upsertAgentDraft } from '../../../lib/drafts';
import { notifyEditorsOfSubmission } from '../../../lib/notify';
import { audit } from '../../../lib/auth/audit';
import { clientIp } from '../../../lib/request';
import { siteUrl } from '../../../lib/draft-http';

// Server route for the AI agent that writes up stories from the conference's Facebook pages.
// Whatever it sends becomes a `new` draft for a person to review: this route cannot publish, reject or edit
// anything an editor has touched. Bearer AGENT_API_TOKEN, no CORS, nothing under /api/admin.
export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const denied = agentAuth(request);
  if (denied) return denied;
  if (agentRateLimited()) return agentJson(429, { ok: false, error: 'rate_limited', message: 'Too many requests. The limit is 60 per hour.' }, { 'Retry-After': '3600' });

  const text = await readLimited(request, AGENT_LIMITS.maxBodyBytes);
  if (text === null) return agentJson(400, { ok: false, error: 'too_large', message: 'The request is larger than 40 MB.' });
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return agentJson(400, { ok: false, error: 'invalid_json', message: 'The request body is not valid JSON.' });
  }

  let story;
  try {
    story = parseAgentStory(input);
  } catch (err) {
    if (err instanceof AgentError) return agentJson(400, { ok: false, error: err.code, message: err.message });
    throw err;
  }

  let result;
  try {
    result = upsertAgentDraft({ ...story });
  } catch (err) {
    console.error('[agent] could not save the draft', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return agentJson(503, { ok: false, error: 'unavailable', message: 'The story could not be saved right now. Please try again in a few minutes.' });
  }
  if (!result.ok) {
    return agentJson(409, { ok: false, error: 'already_reviewed', id: result.id, message: 'An editor has already started on this story, so it was not changed.' });
  }

  console.log(`[agent] draft #${result.id} ${result.status}`);
  try {
    audit('agent.story', { target: `draft:${result.id}`, detail: { result: result.status }, ip: clientIp(request, clientAddress) });
  } catch {
    /* the audit entry is a convenience */
  }
  if (result.status === 'created') {
    // In the background: nothing here can fail or slow the response.
    void notifyEditorsOfSubmission({ id: result.id, title: story.title, church: story.church, fromAgent: true })
      .then((n) => console.log(`[agent] draft #${result.id}: editor notifications sent ${n.sent}, failed ${n.failed}`))
      .catch(() => console.warn(`[agent] draft #${result.id}: editor notifications failed`));
  }
  return agentJson(201, { ok: true, id: result.id, status: result.status, url: `${siteUrl()}/admin/drafts/${result.id}` });
};

export const ALL: APIRoute = () => {
  return agentJson(405, { ok: false, error: 'method_not_allowed', message: 'Use POST.' }, { Allow: 'POST' });
};
