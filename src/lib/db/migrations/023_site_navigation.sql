CREATE TABLE site_navigation (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL CHECK(version>0),
  items TEXT NOT NULL CHECK(json_valid(items) AND length(items)<=30000),
  updated_at INTEGER NOT NULL
) STRICT;
