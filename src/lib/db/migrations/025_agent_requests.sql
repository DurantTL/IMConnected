-- Retry receipts for POST /api/agent/stories: hashes and the draft identity only, never request bodies or tokens.
-- Same idea as agent_reopens (022); `result` is what the first request answered ('created' or 'updated').
CREATE TABLE agent_requests (
  request_hash TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
