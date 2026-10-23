-- Retry receipts for POST /api/agent/stories/batch: a hash of the batch requestId, a hash of the request content,
-- and the per-item outcome (index, ok, draft id, status, error code, refusal reason). Never story text, contacts or tokens.
CREATE TABLE agent_batches (
  request_hash TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  results TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
