CREATE TABLE editor_layouts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  blocks TEXT NOT NULL CHECK(json_valid(blocks) AND length(blocks)<=400000),
  created_at INTEGER NOT NULL
);
CREATE INDEX editor_layouts_owner ON editor_layouts(user_id,id);
