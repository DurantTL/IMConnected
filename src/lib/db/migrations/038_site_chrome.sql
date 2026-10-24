-- Issue #156: editable header and footer text, links and visibility (one row, version-checked).
-- No row means the built-in defaults in src/lib/site-chrome.ts.
CREATE TABLE site_chrome (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL CHECK(version>0),
  config TEXT NOT NULL CHECK(json_valid(config) AND length(config)<=30000),
  updated_at INTEGER NOT NULL
) STRICT;
