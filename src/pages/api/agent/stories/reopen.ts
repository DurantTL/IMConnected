import type { APIRoute } from 'astro';
import { agentAuth, agentJson } from '../../../../lib/agent-api';
import { AgentConflict, AgentError, AGENT_LIMITS, agentRateLimited } from '../../../../lib/agent';
import { parseAgentReopen, reopenAgentStory } from '../../../../lib/agent-reopen';
import { readLimited } from '../../../../lib/bearer';
import { clientIp } from '../../../../lib/request';
import { siteUrl } from '../../../../lib/draft-http';
import { getDraft } from '../../../../lib/drafts';
import { notifyEditorsOfSubmission } from '../../../../lib/notify';
export const prerender = false;
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const denied = agentAuth(request);
  if (denied) return denied;
  if (agentRateLimited()) return agentJson(429, { ok: false, error: 'rate_limited', message: 'Too many requests. The limit is 60 per hour.' }, { 'Retry-After': '3600' });
  const text = await readLimited(request, AGENT_LIMITS.maxBodyBytes);
  if (text === null) return agentJson(400, { ok: false, error: 'too_large', message: 'The request is larger than 40 MB.' });
  let value: unknown;
  try { value = JSON.parse(text); } catch { return agentJson(400, { ok: false, error: 'invalid_json', message: 'The request body is not valid JSON.' }); }
  try {
    const result = reopenAgentStory(parseAgentReopen(value, text), clientIp(request, clientAddress));
    if (result.status === 'reopened') {
      console.log(`[agent] draft #${result.id} reopened`);
      const draft = getDraft(result.id);
      if (draft) void notifyEditorsOfSubmission({ id: result.id, title: draft.title, church: draft.church, fromAgent: true })
        .catch(() => console.warn(`[agent] draft #${result.id}: editor notifications failed`));
    }
    return agentJson(result.status === 'reopened' ? 201 : 200, { ok: true, ...result, requiresReview: true, url: `${siteUrl()}/admin/drafts/${result.id}` });
  } catch (err) {
    if (err instanceof AgentConflict) return agentJson(err.status, { ok: false, error: err.code, ...err.details, message: String(err.details.message ?? err.message) });
    if (err instanceof AgentError) return agentJson(400, { ok: false, error: err.code, message: err.message });
    console.error('[agent] could not reopen the story');
    return agentJson(503, { ok: false, error: 'unavailable', message: 'The story could not be reopened right now. Retry the identical request in a few minutes.' });
  }
};
export const ALL: APIRoute = () => agentJson(405, { ok: false, error: 'method_not_allowed', message: 'Use POST.' }, { Allow: 'POST' });
