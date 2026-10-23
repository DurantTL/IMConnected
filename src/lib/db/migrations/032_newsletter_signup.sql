-- Issue #116: optional newsletter signup link kept with the version-checked website navigation.
ALTER TABLE site_navigation ADD COLUMN newsletter_signup TEXT NOT NULL DEFAULT '' CHECK(length(newsletter_signup)<=2048);
