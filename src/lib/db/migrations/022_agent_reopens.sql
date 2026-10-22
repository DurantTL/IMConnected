-- Retry receipts contain hashes and editorial row identities only, never request bodies or tokens.
CREATE TABLE agent_reopens (
  request_hash TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
