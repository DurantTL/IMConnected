-- Keep the primary section/area contract and add cross-section discovery without duplicating stories.
ALTER TABLE stories ADD COLUMN additional_sections TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(additional_sections) AND json_type(additional_sections) = 'array' AND length(additional_sections) <= 256);
ALTER TABLE drafts ADD COLUMN additional_sections TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(additional_sections) AND json_type(additional_sections) = 'array' AND length(additional_sections) <= 256);
