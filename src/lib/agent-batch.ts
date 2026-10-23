// Bulk submit for the AI agent (POST /api/agent/stories/batch). Every item goes through exactly the functions the
// single endpoint uses (parseAgentStory, upsertAgentDraft) and commits in its own transaction; this file only adds the
// envelope checks, the per-item result shape and the batch retry receipt.
import { createHash } from 'node:crypto';
import { AgentConflict, AgentError, AGENT_LIMITS, canonicalJson, parseAgentStory, refusalDetails, REQUEST_ID_RE, type RefusalReason } from './agent';
import { upsertAgentDraft } from './drafts';
import { getDb } from './db';

export interface BatchItemResult {
  index: number;
  ok: boolean;
  id?: number;
  status?: 'created' | 'updated' | 'replayed';
  error?: string;
  reason?: string;
  message?: string;
}

/** What the caller still has to do after the items committed: emails, audit rows and logs. */
export interface BatchOutcome {
  results: BatchItemResult[];
  /** Items that were written (created or updated), for the per-item audit entries. */
  written: { id: number; status: 'created' | 'updated' }[];
  /** Created items, for the one summary email. */
  created: { id: number; title: string }[];
  /** True when a transient failure happened, so no receipt is stored and a retry re-processes the items. */
  transient: boolean;
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const GENERIC = 'This item was refused in the original response. Fix it and send it in a new batch with a new requestId.';

export type Envelope = { requestId: string; stories: unknown[] } | { error: string; message: string };

/** Validates the outer object only. Items are validated one by one later, so one bad item never blocks the rest. */
export function parseEnvelope(input: unknown): Envelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'invalid_json', message: 'The request body must be a JSON object like {"requestId":"...","stories":[...]}.' };
  const o = input as Record<string, unknown>;
  if (typeof o.requestId !== 'string' || !REQUEST_ID_RE.test(o.requestId)) return { error: 'bad_request_id', message: 'A batch needs a requestId of 8–128 letters, digits, underscores or hyphens.' };
  if (!Array.isArray(o.stories)) return { error: 'stories_invalid', message: '"stories" must be a list of story objects.' };
  if (o.stories.length === 0) return { error: 'stories_empty', message: 'Send at least one story.' };
  if (o.stories.length > AGENT_LIMITS.batchMaxStories) return { error: 'too_many_stories', message: `Send at most ${AGENT_LIMITS.batchMaxStories} stories per batch.` };
  return { requestId: o.requestId, stories: o.stories };
}

export const batchPayloadHash = (stories: unknown[]) => sha(canonicalJson({ stories }));

/** The receipt of an earlier batch with this requestId: its stored results, or 'reused' when the content differs. */
export function findBatchReceipt(requestId: string, payloadHash: string): { results: BatchItemResult[] } | 'reused' | null {
  const row = getDb().prepare('SELECT payload_hash, results FROM agent_batches WHERE request_hash = ?').get(sha(requestId)) as { payload_hash: string; results: string } | undefined;
  if (!row) return null;
  if (row.payload_hash !== payloadHash) return 'reused';
  return { results: JSON.parse(row.results) as BatchItemResult[] };
}

/**
 * Ids, statuses and codes only. A refusal gets the fixed per-reason text with no slug interpolated (the live message
 * names the story's slug); every other failure gets a generic text, so a receipt never holds story-derived text.
 */
function forReceipt(r: BatchItemResult): BatchItemResult {
  const { message, ...rest } = r;
  if (r.ok) return rest;
  if (r.error === 'already_reviewed' && r.reason) return { ...rest, message: refusalDetails(r.reason as RefusalReason, null, null).message };
  return { ...rest, message: r.error === 'request_id_reused' ? message : GENERIC };
}

/** Each item: parse, then upsert in its own transaction (photos of a failed item are removed by upsertAgentDraft). */
export function processBatchItems(stories: unknown[]): BatchOutcome {
  const out: BatchOutcome = { results: [], written: [], created: [], transient: false };
  stories.forEach((raw, index) => {
    try {
      const story = parseAgentStory(raw);
      const r = upsertAgentDraft({ ...story });
      if (!r.ok) {
        out.results.push({ index, ok: false, error: 'already_reviewed', reason: r.reason, id: r.id ?? undefined, message: r.message });
      } else if (r.status === 'replayed') {
        out.results.push({ index, ok: true, id: r.id, status: 'replayed' });
      } else {
        out.results.push({ index, ok: true, id: r.id, status: r.status });
        out.written.push({ id: r.id, status: r.status });
        if (r.status === 'created') out.created.push({ id: r.id, title: story.title });
      }
    } catch (err) {
      if (err instanceof AgentConflict) out.results.push({ index, ok: false, error: err.code, ...err.details, message: String(err.details.message ?? err.message) });
      else if (err instanceof AgentError) out.results.push({ index, ok: false, error: err.code, message: err.message });
      else {
        console.error('[agent] batch item could not be saved', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
        out.transient = true;
        out.results.push({ index, ok: false, error: 'unavailable', message: 'This story could not be saved right now. Retry the batch in a few minutes.' });
      }
    }
  });
  return out;
}

/** Stored after every item has committed. A transient failure stores nothing, so the retry re-processes (items are idempotent). */
export function storeBatchReceipt(requestId: string, payloadHash: string, results: BatchItemResult[]): void {
  // Assumes one server process per DATA_DIR: the whole batch runs synchronously after the body is read, so OR IGNORE never has to arbitrate.
  getDb().prepare('INSERT OR IGNORE INTO agent_batches (request_hash, payload_hash, results, created_at) VALUES (?, ?, ?, ?)').run(sha(requestId), payloadHash, JSON.stringify(results.map(forReceipt)), Date.now());
}

export function countResults(results: BatchItemResult[]) {
  const c = { created: 0, updated: 0, replayed: 0, failed: 0 };
  for (const r of results) { if (!r.ok) c.failed++; else if (r.status) c[r.status]++; }
  return c;
}
