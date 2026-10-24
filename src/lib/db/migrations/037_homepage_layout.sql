-- Issue #155: the home page layout (ordered, show/hide blocks and section rails), version-checked like site_navigation.
CREATE TABLE homepage_layout (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL CHECK(version>0),
  blocks TEXT NOT NULL CHECK(json_valid(blocks) AND length(blocks)<=30000),
  updated_at INTEGER NOT NULL
) STRICT;
