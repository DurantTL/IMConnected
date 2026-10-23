import type { APIRoute } from 'astro';
import { agentAuth, agentJson } from '../../../../lib/agent-api';
import { AGENT_LIMITS, agentRateLimited, takeBatchStories } from '../../../../lib/agent';
import { batchPayloadHash, countResults, findBatchReceipt, parseEnvelope, processBatchItems, storeBatchReceipt } from '../../../../lib/agent-batch';
import { readLimited } from '../../../../lib/bearer';
import { notifyEditorsOfBatch } from '../../../../lib/notify';
import { audit } from '../../../../lib/auth/audit';
import { clientIp } from '../../../../lib/request';

// POST /api/agent/stories/batch: up to 20 stories in one request, each written independently exactly like
// POST /api/agent/stories (drafts only; nothing here publishes). Bearer AGENT_API_TOKEN, no CORS, nothing under /api/admin.
// Everything after the body is read is synchronous, so two identical batches in one process cannot interleave.
// `stories/batch` is a static route and takes precedence over the dynamic `stories/[id]`.
export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const denied = agentAuth(request);
  if (denied) return denied;
  // One request: one call against the shared 60/hour limit.
  if (agentRateLimited()) return agentJson(429, { ok: false, error: 'rate_limited', message: 'Too many requests. The limit is 60 per hour.' }, { 'Retry-After': '3600' });

  const text = await readLimited(request, AGENT_LIMITS.maxBodyBytes);
  if (text === null) return agentJson(400, { ok: false, error: 'too_large', message: 'The request is larger than 40 MB.' });
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return agentJson(400, { ok: false, error: 'invalid_json', message: 'The request body is not valid JSON.' });
  }
  const env = parseEnvelope(input);
  if ('error' in env) return agentJson(400, { ok: false, error: env.error, message: env.message });

  const payloadHash = batchPayloadHash(env.stories);
  try {
    const receipt = findBatchReceipt(env.requestId, payloadHash);
    if (receipt === 'reused') return agentJson(409, { ok: false, error: 'request_id_reused', reason: 'request_id_reused', message: 'This batch requestId was already used for a different request. Use a new requestId, or retry the identical body.' });
    // An identical retry: the original results, nothing written, nobody emailed, no audit entry, no item budget used.
    if (receipt) return agentJson(200, { ok: true, replayed: true, results: receipt.results });
  } catch {
    return agentJson(503, { ok: false, error: 'unavailable', message: 'The batch could not be processed right now. Please try again in a few minutes.' });
  }

  // The hourly story ceiling is checked for the whole batch before anything is written.
  const budget = takeBatchStories(env.stories.length);
  if (!budget.ok) {
    return agentJson(429, { ok: false, error: 'rate_limited', reason: 'batch_stories_per_hour', message: 'This batch would go over the hourly limit of stories sent in batches. Nothing was written. Retry after the delay, or send fewer stories.' }, { 'Retry-After': String(budget.retryAfter) });
  }

  const out = processBatchItems(env.stories);
  const counts = countResults(out.results);
  const ip = clientIp(request, clientAddress);
  for (const w of out.written) {
    console.log(`[agent] draft #${w.id} ${w.status}`);
    try {
      audit('agent.story', { target: `draft:${w.id}`, detail: { result: w.status, batch: true }, ip });
    } catch {
      /* the audit entry is a convenience */
    }
  }
  try {
    audit('agent.batch', { detail: { ...counts, items: env.stories.length }, ip });
  } catch {
    /* ignore */
  }
  console.log(`[agent] batch: ${counts.created} created, ${counts.updated} updated, ${counts.replayed} replayed, ${counts.failed} failed`);
  if (!out.transient) {
    try {
      storeBatchReceipt(env.requestId, payloadHash, out.results);
    } catch {
      console.warn('[agent] batch receipt could not be stored');
    }
  }
  if (out.created.length) {
    // In the background: nothing here can fail or slow the response. One summary email for the whole batch.
    void notifyEditorsOfBatch(out.created)
      .then((n) => console.log(`[agent] batch: editor notifications sent ${n.sent}, failed ${n.failed}`))
      .catch(() => console.warn('[agent] batch: editor notifications failed'));
  }
  return agentJson(200, { ok: true, results: out.results });
};

export const ALL: APIRoute = () => agentJson(405, { ok: false, error: 'method_not_allowed', message: 'Use POST.' }, { Allow: 'POST' });
