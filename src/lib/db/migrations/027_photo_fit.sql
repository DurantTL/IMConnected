-- "Fit whole photo": show the entire image inside its frame (object-fit: contain) over a fill instead of cropping.
-- The 1-3 zoom stays for cropping in; existing rows keep the crop behaviour (cover; the fill is unused until fit is contain).
ALTER TABLE draft_photos ADD COLUMN fit TEXT NOT NULL DEFAULT 'cover' CHECK (fit IN ('cover','contain'));
ALTER TABLE draft_photos ADD COLUMN fit_fill TEXT NOT NULL DEFAULT 'blur' CHECK (fit_fill IN ('blur','paper','navy'));
ALTER TABLE story_photos ADD COLUMN fit TEXT NOT NULL DEFAULT 'cover' CHECK (fit IN ('cover','contain'));
ALTER TABLE story_photos ADD COLUMN fit_fill TEXT NOT NULL DEFAULT 'blur' CHECK (fit_fill IN ('blur','paper','navy'));
