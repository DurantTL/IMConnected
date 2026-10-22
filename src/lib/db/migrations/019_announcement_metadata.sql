-- NULL retains an ordinary story; typed bulletin data stays with the story/draft.
ALTER TABLE drafts ADD COLUMN announcement TEXT CHECK (announcement IS NULL OR json_valid(announcement));
ALTER TABLE stories ADD COLUMN announcement TEXT CHECK (announcement IS NULL OR json_valid(announcement));
