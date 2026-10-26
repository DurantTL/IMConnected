# Photo layouts, the story editor and modules

## Story photo layouts and the photo viewer

Issue #35. A story's `photoLayout` (`src/lib/photo-layouts.ts`) is one of IMConnected Studio's story layouts, so a story published from a newsletter looks like the email. An editor picks it in the draft editor, Studio sends it to `POST /api/publish`, the AI agent may send it, and it is stored in `stories.photo_layout` / `drafts.photo_layout` (migration 016) and shown in `/stories.json`. Per-photo captions (issue #84) are separate from alt text: alt describes the picture for screen readers, the caption is visible text under the photo (up to 300 characters, plain text, escaped), and the single "Photo: credit" line under the group is unchanged. On the public submit form (issue #122) each chosen photo gets its own optional caption and alt text fields (`caption_0`..`caption_5`, `alt_0`..`alt_5`); without JavaScript the single caption field captions the first photo. Editors type it next to the alt text; Studio's photo `caption` and the agent's photo `caption` set it too; it shows in every layout, inline `{{photo N}}` and the click-to-enlarge viewer.

| `photoLayout` | On the story page (lead photo first, then the others) |
| --- | --- |
| `one` (default) | The lead photo above the text, the other photos in a row under it. Every story that has not chosen another layout. |
| `twoUp` | The first two photos side by side above the text. Others go in the row under the text. |
| `heroGrid` | One wide photo, then the next two side by side. Photos 4 and up go in the row under the text. |
| `mosaic` | All photos in rows of two; an odd last photo is full width. |
| `stack` | All photos one under another, full width. |
| `carousel` (issue #85) | One photo at a time in a scroll-snap strip with Previous/Next buttons and a polite "3 of 7" counter (`src/scripts/photo-carousel.ts`). Never autoplays; no smooth scrolling with reduced motion. Without JavaScript it is a horizontally scrollable strip with a visible scrollbar. Every photo stays a link to its full image. |
| `threeUp` (issue #85) | An even three-column grid (two columns under 650px, one under 400px), all photos, 3:2. With exactly two photos it is a pair. |

A layout above the text is a single grid in `src/components/StoryPhotos.astro` (plain CSS grid in `src/styles/global.css`; wide photos are 16:9, pairs are 3:2, cropped to fit, so nothing moves while images load; pairs stay side by side at phone width). The lead photo is `loading="eager"`, the rest `lazy`, all `decoding="async"`. **Fewer photos than a layout needs degrade:** with one photo every layout is the plain look, and `heroGrid` with two photos is the hero plus one wide photo. No photo is ever dropped from the page: anything a layout has no place for stays in the row under the text. `planPhotos()` decides which photo goes where.

**Click to enlarge** (`src/scripts/photo-viewer.ts`, no dependency): every story photo is an ordinary link to the full image, so it works without JavaScript. With JavaScript, a click opens a native `<dialog>` (modal, `aria-modal`, labelled with the photo's alt text) with Previous, Next and Close buttons, arrow keys, Home and End, Esc, swipe left and right, a focus trap and focus returned to the photo that was opened. The script also makes the lead photo of a "One hero" story a link when it runs, so every photo behaves the same (the page's HTML is not changed for those stories).

Tests: `SCRATCH=/tmp/imc-photo-layouts node scripts/test-photo-layouts.mjs` after `npm run build` (the layout planner; migration 016 on a database with data; Studio's `photoLayout` validation, default and republish; the markup of every layout with 1, 2, 3, 4 and 6 photos; `/stories.json` and `GET /api/stories`; the agent API; the dashboard picker, save validation, publish and edit; and, with Playwright, no horizontal scroll at 390, 768 and 1280 px, the viewer with keyboard and touch, the no-JavaScript links). Add `SHOTS=<folder>` for screenshots of every layout and photo count at those widths, and `AXE_JS=<path to axe.min.js>` for an axe scan (axe-core is not a dependency of this repo).

## Modular story editor and image focus

Stories can belong to multiple sections: choose a primary Section/Category and check Additional sections in Story settings. A News → Camp story can also appear in Youth & Pathfinders without duplicating its article. See [multiple sections and API contracts](MULTIPLE-SECTIONS.md).

The [publication redesign guide](PUBLICATION-REDESIGN.md) shows the IMConnected wordmark, newsletter colors, automatically advancing event spotlight, article layouts and current synthetic screenshots.

Image uploads and flyers accept JPEG, PNG, WebP and AVIF. See [image formats and agent/Studio compatibility](IMAGE-FORMATS.md) for request examples, original-byte handling and email considerations.

The home page shows recent stories only: those dated within the last 90 days (`HOMEPAGE_RECENT_DAYS` in `src/lib/public-stories.ts`, counted by America/Chicago day) plus any story marked featured, whatever its date. Older stories stay on their section pages, in search and in the feeds. A "From the archive" block near the foot of the page gives older stories a small, labelled place: four stories older than that window (three on phones), never one already shown above, picked by a shuffle seeded with the America/Chicago day (same four for everyone that day, photos first, spread across sections, no JavaScript), ordinary stories only (announcements and events are never re-posted from the archive), hidden when fewer than two qualify (`src/lib/archive-rail.ts`).

The [community navigation guide](COMMUNITY-NAVIGATION.md) covers the homepage event rail, administrator website-menu settings, separate Stories/Announcements/Events queues and customizable module quick access.

See the [design review and screenshots](DESIGN_REVIEW.md) for the magazine layout and dedicated editor workspace. The editor is a two-column page: the story canvas and one sidebar with the tabs Modules, Module, Settings, Publish and History; inactive panels leave the keyboard tab order, while their fields remain included in saves. A sticky toolbar keeps Save and private Preview available.

The editor at `/admin/drafts/<id>` supports Markdown and a modular story workspace. Choose **Use modules** to preserve existing Markdown inside paragraph modules, then add paragraphs, headings, quotes, lists, inline story images, buttons/links, and dividers. The outline has drag reordering and labelled Move up/Move down controls. Modules can be duplicated, deleted, undone and redone before leaving the page. Text modules support Markdown formatting; raw HTML remains inert. Click a module in the private preview to select its settings. Desktop and Phone change only the preview width, and previewing never publishes.

On desktop, the module library/outline sits beside the story canvas and selected-module settings. Search the library to find a module, or insert a **News story**, **Event recap** or **Announcement** starter layout. Starters insert empty modules after the selected one, preserve existing content, obey the 60-module limit and undo in one step. Canvas modules support pointer selection and Enter/Space while keeping their heading and list semantics. Phones have explicit Build/Preview views and a compact Save/Review bar. Published and rejected drafts preview their stored content while editing controls remain unavailable.

The public story search has visible query/section labels, automatic section filtering, Clear search and no-match recovery. The address and Back/Forward retain the active criteria. Feedback names the query, section and returned count; at the 20-result cap it asks readers to refine the search rather than claiming that every match is shown.

Upload images under Photos, then select them in an Image module. **Adjust image focus** shows the original image with a draggable focal marker and a crop preview. Drag the crop itself to pan, or use its arrow keys (Shift moves ten percentage points). The Zoom slider and +/− buttons scale from 100% to 300%; Reset crop restores 100% and centered focus. The original marker, labelled focus sliders and Center focus button remain available. Saving retains the crop; publishing applies it to inline images, cards and cropped story photos. The preview uses a 16:9 frame; other photo slots retain their own proportions and crop around the same focus. The full original remains available in the photo viewer. Images used inline are omitted from the separate story photo group to avoid duplicates. Deleting a photo also removes modules that reference it.

Migration **017** adds `story_blocks` JSON to drafts/stories and `focal_x`/`focal_y` to their photo rows. Existing stories default to no modules and centered focus (50/50). Missing module/focus fields from an older editor preserve the current values. A Markdown projection remains in `body` for search and older consumers. Published modules contain public photo URLs, never private draft photo IDs; reopening a published story remaps images to its editable photo rows. Studio replacing a closed story clears old modules so it cannot accidentally publish stale layout content. Existing Studio and agent API payloads remain supported; this first module editor does not add a form-response, payment, or conditional-field engine.

Migration **018** adds `zoom` to draft and published photo rows (default 1, range 1–3). Older forms that omit zoom preserve a saved crop.

**Fit whole photo** (issue #82, migration **027**): the same panel has a Fit whole photo checkbox and a fill choice (blurred copy of the photo, page color or navy `#0B3954`). The entire image is shown inside its frame (`object-fit: contain`) instead of cropped; zoom and pan are turned off while it is on (the 1–3 zoom stays for cropping in). `draft_photos` and `story_photos` get `fit` (`cover` default | `contain`) and `fit_fill` (`blur` default | `paper` | `navy`). The blur is decorative (a CSS background on the frame, no element, never a second link) and the click-to-enlarge link still opens the original. Older forms that omit the fields preserve the stored values; Studio `POST /api/publish` accepts optional `fit`/`fitFill` per photo with the same rule; the agent API accepts `fit`/`fitFill` per new photo on create, update and reopen (`400 bad_photo_fit` / `bad_photo_fit_fill`; `null` is not accepted, omit the key for the default) and returns them on read-back. Crops change display metadata only: no photo is resampled or overwritten, and existing Studio and agent API requests remain supported.

Studio compatibility (#45) extends each published photo with optional numeric `focalX`/`focalY` (0–100) and `zoom` (1–3). Missing values preserve an unchanged photo's latest crop inside the publish transaction; explicit defaults reset it and new photos start centered at 100%. Studio imports retain all permitted lead/gallery photos, layout and crop metadata, while imported teaser cards stay protected from republishing. See [the Studio contract and checks](STUDIO-IMPORT.md).

`/stories.json` adds optional `storyBlocks` and `photoFocus` without changing version 1. Module IDs are stable strings, and image modules contain `url`, `alt`, `focalX`, `focalY` and optional `zoom` (1–3, default 1). Focus arrays follow the lead image then gallery images and use the same crop fields. Draft modules/private uploads are excluded from the Studio story list. New consumers may use these additive fields; existing consumers can keep using the original story fields.

Focused validation (synthetic local data only):

```bash
node scripts/test-story-blocks.mjs
node scripts/test-story-builder.mjs
# After npm run build, with Playwright installed outside the checkout:
# Playwright resolves normally; PLAYWRIGHT_ROOT, CHROMIUM_PATH, CHROMIUM_NO_SANDBOX=1 (root in a container) and AXE_JS override:
node scripts/test-story-builder-ui.mjs
```

The editor and public design take the content-outline, labelled-action, mobile-reflow and private-preview ideas from [IMSDA Events design review #1114](https://github.com/DurantTL/IMSDA-Events/issues/1114), retaining IMConnected's existing routes and editorial permissions.


## Announcements and event media

Video modules and announcement `videoUrl` links open a responsive popup player when readers press Play. Paste a normal HTTPS YouTube/Vimeo link; no iframe code is needed. The popup supports keyboard closing, returns focus and stops playback on close. Studio's **Add block → Video** provides the same web export and an explicit popup preview; email retains ordinary watch links and standalone WordPress export uses a native Embed block. See [video and announcement setup](AGENT-ANNOUNCEMENTS.md).

The public `/announcements/` page lists published announcements/events, with type filters and full-aspect flyer cards. Choose Announcement or Event in Story settings to add a full-height flyer (first photo), optional date/location, up to three labelled link buttons and a YouTube/Vimeo video. The module library includes Flyer and Video for placement within any story. Readers explicitly load video players; private preview stays link-only. See [the agent request examples and editor workflow](AGENT-ANNOUNCEMENTS.md). Migration019 stores additive typed metadata in the existing SQLite database; older form, agent and Studio clients preserve it when omitted.

The public `/issues/` page lists the IMConnected newsletter issues that have at least one live story, newest first, with the issue number, the day it was sent, its optional title, the story count and the first three stories. `/issues/<n>/` shows one issue's live stories in newsletter order (`newsletterIssue.position`, then date order for stories without a position), with links to the previous and next listed issue; unknown or empty issues are a 404. A story's "Originally published in IMConnected Issue #N" line links there. Test: `scripts/test-issues-browser.mjs`.

