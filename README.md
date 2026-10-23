# IMConnected

A story magazine for the Iowa-Missouri Conference of Seventh-day Adventists. The design follows the layout of a union magazine site: News, Features, Columns, Youth & Pathfinders and Kids sections, plus a public **Submit a Story** form. Each submission lands as a draft in the editor dashboard at `/admin`, where an editor edits and publishes it.

- **Astro 7**: the story pages, section pages, home page, `/stories.json` and `/rss.xml` are rendered on the server from the database and kept in a small in-memory cache (see Stories in the database); the other pages are prerendered to static HTML. The other server code is `/api/submit`, `/api/publish`, `/api/confirm`, `/api/stories` and `/api/studio-photo` (for Studio), `/media/*` (photos from the data folder), and the editor dashboard (`/admin*` and `/api/admin/*`).
- **Stories live in the site's SQLite database** (epic #25). Publishing, editing and unpublishing in `/admin` (and Studio's publish button) write to it directly, so a story is live on the very next request: there is no commit, no build and no deploy. Photos are files in `DATA_DIR/media`. Accounts, sessions, drafts and the audit log live in the same file (see Editor dashboard). That file and the photos are now the only copy, so a nightly backup to Google Drive matters (see Setup, step 7). `src/content/stories/` and `public/images/stories/` are a frozen archive that the site only reads once, to adopt it (see Stories in the database).
- **Docker image**: on every push to `main` that changes code, an image is built and pushed to `ghcr.io/<owner>/imconnected`. Stories are not part of any commit, so publishing a story never builds an image.
- **Search** runs on the server: `GET /api/search` queries a SQLite FTS5 index of the stories table (see Stories in the database). After an upgrade or restart, search checks that every live, non-draft story has its current index row before returning successful results. While the initial index is incomplete, it reports temporary unavailability and fills the index in bounded background batches; a writer lock never makes a partly built index appear complete (issue #38).

## How a submission flows

```
Church member ──► /submit form ──► /api/submit (in the container)
                                         │  validates input, checks photos are real images, escapes HTML,
                                         │  applies spam traps, a rate limit, Turnstile and email checks
                                         ▼
                 Draft in the dashboard database (status "new", source "form"),
                 photos saved under DATA_DIR/uploads, no GitHub call
                     │                              │
   confirmation email to the submitter     email to each editor who opted in
   (sets the draft's "verified" badge)     (title, church and a link; no contact details)
                                         │  optional Discord ping
                                         ▼
        An editor opens it in /admin, edits it, then Publishes or Rejects (a person's decision)
                                         │
                      Publish = one database transaction (story, photos, search entry)
                                         ▼
                              the story is live on the next request
```

Submissions appear under `/admin`. If the dashboard database can't be opened, `/api/submit` answers 503 ("Submissions are temporarily unavailable. Please email us your story.") instead of losing the story. **The old pull-request path (`SUBMISSIONS_TO=github`) was removed in step 4**: a merged submission pull request would have added a Markdown file that the site no longer reads, so it could not keep working. Nothing in the app calls GitHub any more; `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH` and `GITHUB_PR_LABEL` are no longer read and can be deleted from `.env`.

## Story photo layouts and the photo viewer

Issue #35. A story's `photoLayout` (`src/lib/photo-layouts.ts`) is one of IMConnected Studio's story layouts, so a story published from a newsletter looks like the email. An editor picks it in the draft editor, Studio sends it to `POST /api/publish`, the AI agent may send it, and it is stored in `stories.photo_layout` / `drafts.photo_layout` (migration 016) and shown in `/stories.json`. Per-photo captions (issue #84) are separate from alt text: alt describes the picture for screen readers, the caption is visible text under the photo (up to 300 characters, plain text, escaped), and the single "Photo: credit" line under the group is unchanged. Editors type it next to the alt text; Studio's photo `caption` and the agent's photo `caption` set it too; it shows in every layout, inline `{{photo N}}` and the click-to-enlarge viewer.

| `photoLayout` | On the story page (lead photo first, then the others) |
| --- | --- |
| `one` (default) | **The original look, byte for byte:** the lead photo above the text, the other photos in a row under it. Every existing story. |
| `twoUp` | The first two photos side by side above the text. Others go in the row under the text. |
| `heroGrid` | One wide photo, then the next two side by side. Photos 4 and up go in the row under the text. |
| `mosaic` | All photos in rows of two; an odd last photo is full width. |
| `stack` | All photos one under another, full width. |

A layout above the text is a single grid in `src/components/StoryPhotos.astro` (plain CSS grid in `src/styles/global.css`; wide photos are 16:9, pairs are 3:2, cropped to fit, so nothing moves while images load; pairs stay side by side at phone width). The lead photo is `loading="eager"`, the rest `lazy`, all `decoding="async"`. **Fewer photos than a layout needs degrade:** with one photo every layout is the plain look, and `heroGrid` with two photos is the hero plus one wide photo. No photo is ever dropped from the page: anything a layout has no place for stays in the row under the text. `planPhotos()` decides which photo goes where.

**Click to enlarge** (`src/scripts/photo-viewer.ts`, no dependency): every story photo is an ordinary link to the full image, so it works without JavaScript. With JavaScript, a click opens a native `<dialog>` (modal, `aria-modal`, labelled with the photo's alt text) with Previous, Next and Close buttons, arrow keys, Home and End, Esc, swipe left and right, a focus trap and focus returned to the photo that was opened. The script also makes the lead photo of a "One hero" story a link when it runs, so every photo behaves the same (the page's HTML is not changed for those stories).

Tests: `SCRATCH=/tmp/imc-photo-layouts node scripts/test-photo-layouts.mjs` after `npm run build` (the layout planner; migration 016 on a database with data; Studio's `photoLayout` validation, default and republish; the markup of every layout with 1, 2, 3, 4 and 6 photos; `/stories.json` and `GET /api/stories`; the agent API; the dashboard picker, save validation, publish and edit; and, with Playwright, no horizontal scroll at 390, 768 and 1280 px, the viewer with keyboard and touch, the no-JavaScript links). Add `SHOTS=<folder>` for screenshots of every layout and photo count at those widths, and `AXE_JS=<path to axe.min.js>` for an axe scan (axe-core is not a dependency of this repo). Existing stories are compared with the pre-change pages by `scripts/test-public-pages.mjs` (`BASELINE_DIR`).

## Modular story editor and image focus

Stories can belong to multiple sections: choose a primary Section/Category and check Additional sections in Story settings. A News → Camp story can also appear in Youth & Pathfinders without duplicating its article. See [multiple sections and API contracts](docs/MULTIPLE-SECTIONS.md).

The [publication redesign guide](docs/PUBLICATION-REDESIGN.md) shows the IMConnected wordmark, newsletter colors, automatically advancing event spotlight, article layouts and current synthetic screenshots.

Image uploads and flyers accept JPEG, PNG, WebP and AVIF. See [image formats and agent/Studio compatibility](docs/IMAGE-FORMATS.md) for request examples, original-byte handling and email considerations.

The home page shows recent stories only: those dated within the last 90 days (`HOMEPAGE_RECENT_DAYS` in `src/lib/public-stories.ts`, counted by America/Chicago day) plus any story marked featured, whatever its date. Older stories stay on their section pages, in search and in the feeds. A "From the archive" block near the foot of the page gives older stories a small, labelled place: four stories older than that window (three on phones), never one already shown above, picked by a shuffle seeded with the America/Chicago day (same four for everyone that day, photos first, spread across sections, no JavaScript), ordinary stories only (announcements and events are never re-posted from the archive), hidden when fewer than two qualify (`src/lib/archive-rail.ts`).

The [community navigation guide](docs/COMMUNITY-NAVIGATION.md) covers the homepage event rail, administrator website-menu settings, separate Stories/Announcements/Events queues and customizable module quick access.

See the [design review and screenshots](docs/DESIGN_REVIEW.md) for the magazine layout and dedicated editor workspace. The editor separates **Content**, **Story settings**, **Photos**, and **Review & publish**; inactive panels leave the keyboard tab order, while their fields remain included in saves. A sticky toolbar keeps Save and private Preview available.

The editor at `/admin/drafts/<id>` supports Markdown and a modular story workspace. Choose **Use modules** to preserve existing Markdown inside paragraph modules, then add paragraphs, headings, quotes, lists, inline story images, buttons/links, and dividers. The outline has drag reordering and labelled Move up/Move down controls. Modules can be duplicated, deleted, undone and redone before leaving the page. Text modules support Markdown formatting; raw HTML remains inert. Click a module in the private preview to select its settings. Desktop and Phone change only the preview width, and previewing never publishes.

On desktop, the module library/outline sits beside the story canvas and selected-module settings. Search the library to find a module, or insert a **News story**, **Event recap** or **Announcement** starter layout. Starters insert empty modules after the selected one, preserve existing content, obey the 60-module limit and undo in one step. Canvas modules support pointer selection and Enter/Space while keeping their heading and list semantics. Phones have explicit Build/Preview views and a compact Save/Review bar. Published and rejected drafts preview their stored content while editing controls remain unavailable.

The public story search has visible query/section labels, automatic section filtering, Clear search and no-match recovery. The address and Back/Forward retain the active criteria. Feedback names the query, section and returned count; at the 20-result cap it asks readers to refine the search rather than claiming that every match is shown.

Upload images under Photos, then select them in an Image module. **Adjust image focus** shows the original image with a draggable focal marker and a crop preview. Drag the crop itself to pan, or use its arrow keys (Shift moves ten percentage points). The Zoom slider and +/− buttons scale from 100% to 300%; Reset crop restores 100% and centered focus. The original marker, labelled focus sliders and Center focus button remain available. Saving retains the crop; publishing applies it to inline images, cards and cropped story photos. The preview uses a 16:9 frame; other photo slots retain their own proportions and crop around the same focus. The full original remains available in the photo viewer. Images used inline are omitted from the separate story photo group to avoid duplicates. Deleting a photo also removes modules that reference it.

Migration **017** adds `story_blocks` JSON to drafts/stories and `focal_x`/`focal_y` to their photo rows. Existing stories default to no modules and centered focus (50/50). Missing module/focus fields from an older editor preserve the current values. A Markdown projection remains in `body` for search and older consumers. Published modules contain public photo URLs, never private draft photo IDs; reopening a published story remaps images to its editable photo rows. Studio replacing a closed story clears old modules so it cannot accidentally publish stale layout content. Existing Studio and agent API payloads remain supported; this first module editor does not add a form-response, payment, or conditional-field engine.

Migration **018** adds `zoom` to draft and published photo rows (default 1, range 1–3). Older forms that omit zoom preserve a saved crop.

**Fit whole photo** (issue #82, migration **027**): the same panel has a Fit whole photo checkbox and a fill choice (blurred copy of the photo, page color or navy `#0B3954`). The entire image is shown inside its frame (`object-fit: contain`) instead of cropped; zoom and pan are turned off while it is on (the 1–3 zoom stays for cropping in). `draft_photos` and `story_photos` get `fit` (`cover` default | `contain`) and `fit_fill` (`blur` default | `paper` | `navy`). The blur is decorative (a CSS background on the frame, no element, never a second link) and the click-to-enlarge link still opens the original. Older forms that omit the fields preserve the stored values; Studio `POST /api/publish` accepts optional `fit`/`fitFill` per photo with the same rule; the agent API only reads them back (write support is a follow-up). Crops change display metadata only: no photo is resampled or overwritten, and existing Studio and agent API requests remain supported.

Studio compatibility (#45) extends each published photo with optional numeric `focalX`/`focalY` (0–100) and `zoom` (1–3). Missing values preserve an unchanged photo's latest crop inside the publish transaction; explicit defaults reset it and new photos start centered at 100%. Studio imports retain all permitted lead/gallery photos, layout and crop metadata, while imported teaser cards stay protected from republishing. See [the Studio contract and checks](docs/STUDIO-IMPORT.md).

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

## Setup

### 1. Create the repo

```bash
git remote add origin git@github.com:DurantTL/imconnected.git
git push -u origin main
```

> The repository holds code only. Contact details live in the database, never in git, so the repo may be public or private.

### 2. (No publishing token)

Publishing no longer needs a GitHub token. There is nothing to create here.

### 3. Image builds

The Action at `.github/workflows/docker.yml` builds the image and pushes it to GHCR. There's nothing to configure. To set the canonical URL, add a repository **variable** `SITE_URL` (Settings → Secrets and variables → Actions → Variables). Otherwise it defaults to `https://stories.imadventist.org`.

If the GHCR package is private, run `docker login ghcr.io` on the server first, using a token with `read:packages`.

### 4. Run it on the server

```bash
cp .env.example .env      # fill in SITE_URL, AUTH_SECRET, etc.
docker compose up -d
```

The container listens on port **4321**. Put it behind your reverse proxy (Nginx Proxy Manager, Cloudflare Tunnel, Traefik…). Set `TRUST_PROXY` so the rate limiters see real visitor IPs: `cloudflare` when the site is behind Cloudflare's proxy (it trusts `CF-Connecting-IP`), `true` for a single reverse proxy such as xCloud's nginx (it trusts the last `X-Forwarded-For` entry, the one your proxy added). If it is unset behind a proxy, every visitor shares the proxy's IP, so the submit, publish and sign-in rate limits and lockouts are shared by everyone. Never set either value when the app is reachable directly, because visitors could then forge their IP. That includes `cloudflare` mode when your server can also be reached by its own IP address: anyone hitting the server directly can send a fake `CF-Connecting-IP`. Use `cloudflare` only if direct traffic is blocked: firewall the server to Cloudflare's IP ranges, use a Cloudflare Tunnel, or have nginx set the real IP from Cloudflare's ranges (`set_real_ip_from`).

**Updating after a merge:** the server never builds the site; it only pulls the finished image. After each merge to `main`, the Action builds and publishes the image, then moves the **`deploy`** branch to that commit. Point your host's git auto-deploy (xCloud) at the `deploy` branch, not `main`, with this deploy command:

```bash
docker compose pull && docker compose up -d
```

Watching `main` instead would start the deploy about two minutes before the new image exists, and the server would pull the previous version. To update by hand, run the same command. If the Action's `deploy` job fails, the server stays on the previous version until the next merge; re-run the newest "Build & publish image" run from the Actions tab (older runs skip publishing on purpose).

The site address defaults to `https://stories.imadventist.org`. If you set `SITE_URL` anywhere (the server's `.env` or the repository variable), it overrides that default, so keep both on the current domain.

### 5. Bringing in stories that are in git (one time)

The first start of this version on a server whose database has not adopted the build yet imports the stories built into the image automatically (see Stories in the database). To bring in Markdown stories that someone committed by hand later, use `scripts/import-git-stories.mjs` (see the same section). Pages CMS (`.pages.yml`) edits the frozen archive, which the site no longer reads, so it can no longer publish anything.

### 6. Story feeds

The site serves the 50 newest published stories from the live database in two formats:

- **`/rss.xml`**: RSS 2.0 for feed readers and services that import RSS.
- **`/stories.json`**: for the IMConnected Studio newsletter builder. Every story has `id`, `url`, `title`, `section`, `sectionLabel`, `author`, `date` (YYYY-MM-DD), `photos`, `photoAlts` (alt text for each photo in `photos`, same order; entries may be empty), `photoLayout` and `featured`. `photoCaptions` (visible captions for each photo in `photos`, same order; entries may be empty) and `imageCaption` (the lead photo's, only when it has one) were added by issue #84 (plain text, up to 300 characters: escape it yourself; `version` stays 1). `photoLayout` (added by issue #35, so `version` stays 1) says how the story page arranges the photos: `one`, `twoUp`, `heroGrid`, `mosaic` or `stack` (the same names as IMConnected Studio's story layouts); `one` is the original look (lead photo, the others in a row under the text) and is what every story has unless an editor or Studio chose another, so a consumer that ignores the field is unaffected. `dek`, `area`, `areaLabel`, `column`, `authorTitle`, `church`, `image`, `imageAlt` and `photoCredit` appear only when the story has them. `FeedItem` in `src/lib/feed.ts` is the definitive list. All links and photo addresses are absolute, so they work inside an email.

`/stories.json` is the public feed of live stories. IMConnected Studio's "Import from IMConnected" button reads the authenticated, CORS-enabled `GET /api/stories` (see "Story list for Studio" below), which additionally includes drafts still waiting for an editor, so no proxy header is needed. Both lists read the database and reflect story changes without a build. See `docs/STUDIO-IMPORT.md` for the newsletter builder plan.

### 7. Nightly backups to Google Drive

Epic #25 moves published stories into the database, so the data folder (`/data`, the Docker volume) becomes the only live copy of the stories, photos, drafts and editor accounts. The site backs itself up every night and uploads the copies to a Google Drive folder. (xCloud's own Google Drive backup only covers WordPress sites, so the site does the upload itself.) **Only the owner sets this up; nobody else should handle the Google key.**

What a night's backup is, and where it goes:

- `imconnected-YYYY-MM-DD.db`: a consistent snapshot of the SQLite database (`VACUUM INTO`): stories, drafts, accounts, sessions, the audit log, the backup history.
- `imconnected-YYYY-MM-DD.media.tar.gz`: the photos, `DATA_DIR/media` (published) and `DATA_DIR/uploads` (draft photos), streamed straight into a gzip file, never held in memory.
- Both go to `DATA_DIR/backups/` (UTC date in the name) and are uploaded to the Drive folder. **7 daily and 4 weekly (Sunday) copies** are kept in both places; older copies are deleted. On Drive it only deletes files this service account created whose names match `imconnected-YYYY-MM-DD.db` / `.media.tar.gz`.
- It runs once a day after `BACKUP_HOUR` (UTC, default `9` = early morning US Central). The scheduler starts with the server (about 30 seconds after start), so a quiet site is backed up too. A restart does not repeat a backup that already succeeded. A failed upload is retried 3 times, then again every 30 minutes until the day's backup succeeds, reusing the day's finished local files and only uploading again. A failure that retrying cannot fix (no permission, no storage quota, missing folder, bad key) is not retried that day; it shows on `/admin/backups`, and the 48-hour email covers it.
- **Backups are off until both `GDRIVE_SERVICE_ACCOUNT_JSON` and `GDRIVE_FOLDER_ID` are set.** While they are off, administrators see a notice at the top of the drafts page (`/admin`): "Backups to Google Drive are not set up". `/admin/backups` (administrators only; linked from Editors) shows whether backups are on, the last success, the last error with a hint for the common fixes, and the copies on the server. If no backup succeeds for 48 hours while backups are set up, every active **administrator** (not editors) gets one email a day until one does. No email is sent when backups are simply not set up.
- **The backups hold personal data**: submitter contact details, editor email addresses and password hashes. Keep the Shared Drive's membership to the owner and the service account only.

**Set it up (about 15 minutes, once):**

**A Shared Drive is required.** A service account has no Google storage of its own, so it cannot save files in a person's My Drive (Google answers 403 "Service Accounts do not have storage quota"). The backups go to a folder in a **Shared Drive**, which needs a Google Workspace account (the conference has one). Domain-wide delegation (the service account acting as a real user) also works, but is an advanced alternative that this site does not support out of the box.

1. Open <https://console.cloud.google.com/> signed in with a conference Google Workspace account and create a project (top bar, project picker, **New project**), e.g. `imconnected-backups`.
2. In that project, **APIs & Services, Library**, search for **Google Drive API** and click **Enable**.
3. **IAM & Admin, Service accounts, Create service account.** Name it `imconnected-backup`; skip the optional role and user-access steps. Copy the account's email (`imconnected-backup@<project>.iam.gserviceaccount.com`).
4. Open the new account, **Keys, Add key, Create new key, JSON, Create**. A `.json` file downloads. This is the secret; keep it off chat, email and git.
   - If the organisation blocks key creation ("Service account key creation is disabled"), a Workspace admin has to allow it for this project under **IAM & Admin, Organisation policies, Disable service account key creation**.
5. A Google Workspace administrator creates the Shared Drive: in Google Drive, **Shared drives, New**, e.g. `IMConnected backups`. Then **Manage members**, add the service account's email with the **Content manager** role (Contributor cannot delete old copies; Manager is more than it needs). Add nobody else except the owner: the backups contain personal data.
6. Inside the Shared Drive, create a folder (e.g. `nightly`). Open it in the browser: the folder ID is the end of the address, `https://drive.google.com/drive/folders/<FOLDER ID>`. (The Shared Drive's own ID works too, but a folder keeps the backups tidy.)
7. Turn the key file into one line of base64 and put both values in the server's `.env` (next to the other secrets), never in git:

   ```bash
   base64 -w0 imconnected-backups-*.json        # on a Mac: base64 -i imconnected-backups-*.json
   ```

   ```
   GDRIVE_SERVICE_ACCOUNT_JSON=<the base64 output, one line>
   GDRIVE_FOLDER_ID=<FOLDER ID>
   # BACKUP_HOUR=9
   ```

8. `docker compose up -d` to restart with the new `.env`, then delete the downloaded `.json` file. Open `/admin/backups` as an administrator: it should say "Backups are on". If the day's backup is already due it runs within a few minutes and the page shows the result; otherwise it runs after `BACKUP_HOUR`. Check the Shared Drive folder for the two files.

**If the first backup fails**, `/admin/backups` shows the error and, for the two usual causes, what to do: *storage quota* means the folder is in a person's My Drive (use a folder in a Shared Drive); *HTTP 404* means the service account is not a member of the Shared Drive (share it as Content manager) or the folder ID is wrong. These failures are not retried the same day, but the site remembers which settings failed (a fingerprint of the folder ID, the scope and the service account's email; never the key). Fix the cause, or change `GDRIVE_FOLDER_ID`, `GDRIVE_SCOPE` or the key in `.env`, and restart: when the settings differ from the failed attempt's, a new attempt starts within minutes. If you fixed the problem on Google's side only (for example by adding the service account to the Shared Drive) and the settings did not change, the next attempt is tomorrow; to try sooner, change the settings or ask a developer to clear the day's failed run.

**Which Google permission it asks for.** The site signs in with the full `drive` scope by default. The narrow `drive.file` scope (only files the account created itself) usually cannot see a Shared Drive or folder that was merely shared with the account, and Google then answers 404 for the folder. A service account has no files of its own, so the full scope only reaches what was shared with it; the site still only deletes files in that folder that the account created and whose names match the backup pattern. Set `GDRIVE_SCOPE=drive.file` in `.env` to opt in to the narrow scope. `/admin/backups` shows which one is in use.

**Restore** (a lost server, a new volume, a bad deploy). Only a person with access to the server does this.

1. Get the two files of the day you want: from `/data/backups/` on the server if they are still there, otherwise download `imconnected-YYYY-MM-DD.db` and `imconnected-YYYY-MM-DD.media.tar.gz` from the Drive folder and copy them to the server (into a folder outside the data volume, e.g. `/root/restore`).
2. Stop the site: `docker compose stop imconnected`.
3. Restore into an **empty** data folder (a new volume, or an emptied one), as the container's normal user so the files belong to it:

   ```bash
   docker compose run --rm -v /root/restore:/restore:ro imconnected \
     node scripts/restore-backup.mjs /restore/imconnected-2026-10-21.db /restore/imconnected-2026-10-21.media.tar.gz
   ```

   (To use the copies already in the volume, leave out `-v` and use `/data/backups/imconnected-2026-10-21.db ...`.) The script checks the database first, refuses a folder that already holds data (a leftover `backups/` folder does not count), and prints how many stories, drafts and accounts it restored. Add `--force` to restore over a folder that has data: it first moves everything except `backups/` into `restore-aside-<time>/` inside the data folder (nothing is deleted; remove that folder yourself later). The media archive is optional; without it the photos are not restored.
4. Start the site: `docker compose up -d`. Migrations newer than the backup apply on start. Sign in and check `/admin/backups`.

- **Tests.** `npm run build`, then `SCRATCH=/tmp/imc-backups node scripts/test-backups.mjs`. It starts `scripts/mock-gdrive.mjs` (a local stand-in for Google's token endpoint, resumable upload, files.list and files.delete; real Google is never contacted), the mock email API and the built server, with a throwaway RSA key. It covers both uploads, 40 days of retention on Drive and on disk (also in Shared Drive mode), a failed upload retried and reported, permanent failures not retried, the key and tokens never in logs, the 48-hour email, tar safety limits, a 200 MB snapshot that does not stall the event loop, a scheduler that starts with no request, a full restore into an empty folder (and the refusals), the admin notice and the admin-only status page. `GDRIVE_API_URL` and `GOOGLE_OAUTH_TOKEN_URL` point the site at the mock, like `EMAIL_API_URL`.

## Publishing from IMConnected Studio

The communication director builds each newsletter in IMConnected Studio. Clicking **Publish to IMConnected** sends the ticked stories to `POST /api/publish`, which writes them to the database (one transaction for the whole request, photos copied to `DATA_DIR/media`), so they are live on the very next request. Studio then uses the returned story URLs in the email's "Read full story" buttons. Studio publishes are also recorded in the dashboard (a published draft with source Studio, credited to "IMConnected Studio" through a `published_via_studio` flag that a later dashboard publish clears; publishing the same story again updates that row). If an editor's draft for the same story is still new or in review, Studio never touches its text, status or photos: the draft only gets the live markers, an audit entry `draft.studio_overwrote_live`, and a notice on the draft ("IMConnected Studio published over this story on <date>; your saved edits here are not live."; migration 006). A closed linked draft (published or rejected) is updated in place (a rejected draft's uploaded photos are replaced and their files deleted), so `/admin` shows the full history. If the database is unavailable the publish fails with a 502 and nothing is published (the stories and the dashboard records are one transaction).

**Setup**

1. Generate a secret of 32+ random characters (`openssl rand -hex 32`) and set it as `PUBLISH_TOKEN` in the server's `.env`. Enter the same value in Studio. Without a token of at least 32 characters, every call returns 503.
2. Set `PUBLISH_ORIGINS` to the browser origins allowed to call the API (default `https://tools.imsda.org`).

**API** (JSON, `Authorization: Bearer <PUBLISH_TOKEN>`)

- `GET /api/publish` returns `{ok, site, sections}` for a connection test and the section list.
- `POST /api/publish` takes `{newsletter:{name,issueDate}, stories:[{ref,title,section,area,author,dek,body,quote,attribution,photos:[{url,alt,caption}]}]}` (1-12 stories, up to 6 photos each, 40 MB total). Each photo's `alt` is published (the first as `imageAlt`, the rest as `photoAlts`). Optional `photoLayout` per story (`one`, `twoUp`, `heroGrid`, `mosaic` or `stack`; Studio sends the story block's `layout` unchanged) sets how the story page arranges the photos; it defaults to `one` when left out (or `null`), and any other value is a `400` that names the choices. A republish of an existing story takes the layout that request carries (default `one`), like every other field. Photos are `https://` links (stored as-is, never downloaded) or `data:` JPG/PNG/WebP/AVIF images (checked by file signature and copied to `DATA_DIR/media/stories/<slug>/<sha256>.<ext>`).
- Slugs are `<issueDate>-<title>`, so publishing the same issue again updates its stories (`status: "updated"`) instead of duplicating them. If any story is invalid the response is `400` with a `ref` and nothing is written.
- Publishing the same newsletter again overwrites those stories on the site, including any edits made to them in the dashboard and their `featured` setting.
- All text goes through the same escaping as the submit form. Never HTML.

**Timing:** a story is live on the very next request, in the story page, its section page, the home page, `/stories.json`, `/rss.xml`, search and `/api/stories`. The URL returned by the API works at once. The response still has a `commit` key, always `null` now (there is no commit), so older Studio builds that read it do not break.

**Testing locally:** run the server with a throwaway `DATA_DIR`, `AUTH_SECRET` and a made-up `PUBLISH_TOKEN`, then `curl` the endpoint. Never point tests at the real site.

### Story list for Studio

`GET /api/stories?limit=50&section=<key>` is what Studio's **Import from IMConnected** button reads. It uses the same bearer token and the same CORS rules as `/api/publish`: `Authorization: Bearer <PUBLISH_TOKEN>`, and only origins in `PUBLISH_ORIGINS` get CORS headers (the `OPTIONS` preflight included; other origins get none). 503 when `PUBLISH_TOKEN` is unset or short, 401 when wrong, 120 requests per IP per hour. `limit` is 1-100 (default 50); an unknown `section` is a 400.

```json
{ "ok": true, "version": 1, "site": "https://stories.imadventist.org/", "generated": "…",
  "stories": [ { "id": "…", "url": "…", "title": "…", "…": "every /stories.json field", "status": "published", "source": "site", "excerpt": "…" } ],
  "drafts":  [ { "id": 12, "status": "new", "source": "agent", "title": "…", "…": "the same fields, no url", "excerpt": "…" } ] }
```

- **`stories`** are the live stories, newest first, each with exactly the `/stories.json` fields (`feedItem` in `src/lib/feed.ts`) plus `status: "published"` and `source` (`site` for a story imported from git, otherwise the story's source: `form`, `studio`, `editor` or `agent`). Nothing is renamed, so `/stories.json` stays the public contract.
- **`excerpt`** (on every story and draft, Studio list only; `/stories.json` and `/rss.xml` are unchanged) is the body's first non-empty paragraph as plain text: Markdown headings, emphasis, blockquote markers and images removed, link text kept, HTML entities decoded (`&lt;` becomes `<`), whitespace collapsed, at most 400 characters cut at a word boundary with `…`. It is an empty string when there is no body. Studio treats it as text, never as HTML (`src/lib/excerpt.ts`).
- **How "live" is read.** Straight from the `stories` table (live, non-draft rows), never from the page cache, so a publish or unpublish, even one made by another process, shows on the next call. `/admin/published` reads the same rows. A draft that is being edited again keeps its live text, never its unpublished edits. If the table can't be read the answer is 503.
- **`drafts`** are the 20 newest `new` and `in_review` drafts (the same item shape, `id` is the draft id, no `url` because they aren't live), so Studio can show "not published yet". Only whitelisted fields are copied: a submitter's name, email, phone and church are never included, and neither are the agent's note or source link. A draft gets an `image` only when its lead photo is a file the site serves without a login (an `/images/...` or `/media/...` path); photos uploaded to a draft live outside `public/` and are only served to signed-in editors, so they are left out. Open announcements/events may additionally include a `draftFlyer` descriptor containing only `draftId`, `photoId`, stable `key` and `alt`; the new authenticated transfer below reads that lead flyer without making its upload public.

#### Photo bytes for Studio

`GET /api/studio-photo?src=<url>` returns a story photo so Studio can upload it to the WordPress media library (browsers can't read the static photo files, which have no CORS headers). Studio copies the permitted photos selected by the director, so the limit of 300 requests per IP per hour is ample. Same bearer token (`PUBLISH_TOKEN`) and CORS rules as `/api/stories` (503 unconfigured, 401 wrong token, `OPTIONS` preflight 204, other methods 405; 429 over the limit). `src` is one of the photo URLs `/api/stories` returns (`image` or an entry of `photos`): an absolute URL on the site's own origin (`SITE_URL`) or a root-relative path, and only `/media/stories/<slug>/<file>` (`DATA_DIR/media`, where every published photo is) or the older `/images/stories/<slug>/<file>` (the frozen archive in `dist/client`, else the story's own `/media` copy found through its photo list), with plain `[A-Za-z0-9._-]` names and a `.jpg`, `.jpeg`, `.png`, `.webp` or `.avif` extension. The file must be a regular file inside those folders (a symlink in the built `images/stories` folder is refused; for `/media` the real path must stay inside the media folder, same rule as `GET /media/*`) and its bytes must be a JPEG, PNG, WebP or AVIF no larger than the photo size limit. Refusals are `404 {"ok": false, "error": "Photo not found."}`. There is no "not built yet" case any more: a photo published to the database is served at once. A draft's uploaded photos are served only to signed-in editors and can't be reached here. The 200 carries the sniffed `Content-Type`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

#### Unpublished announcement flyers for Studio

`GET /api/studio-draft-flyer?draftId=<id>&photoId=<id>&key=<media_key>` uses the same Studio bearer authentication, CORS and 300/IP/hour limit as photo transfer. Its descriptor comes only from the authenticated Studio list. It serves only the current lead upload of an open (`new` / `in_review`) typed announcement/event. Closed drafts, ordinary drafts, gallery positions, changed identities, reused IDs, traversal, symlinks, unsupported/oversized bytes and missing files cannot be read. Successful bytes are `no-store`; this grants no public or AI-agent photo access and exposes no upload path or submitter contact details.

Studio imports typed announcements/events into its **Announcements & events** flyer cards, retaining date/location, three actions and a supported video link. The flyer stays at full aspect in email, website HTML and WordPress block export. Published cards retain their website link; draft cards remain labelled for human review. Imported cards cannot overwrite full website stories through Studio's publish flow.

For a private draft flyer, Studio fetches bytes with its session token and copies them to WordPress when connected. Otherwise it attempts a bounded local preview (existing image resizing, at most 1.5 MiB before base64, then an actual storage-quota check). Send Check flags local images until replaced with a public WordPress URL. Oversized/quota failures are explicit, never falsely reported as saved. Removal/replacement during download cancels attachment/upload; manual replacement clears transfer errors, and interrupted transfers become actionable errors on reload. Tokens and the private descriptor are not saved with the newsletter.

## Announcements and event media

Video modules and announcement `videoUrl` links open a responsive popup player when readers press Play. Paste a normal HTTPS YouTube/Vimeo link; no iframe code is needed. The popup supports keyboard closing, returns focus and stops playback on close. Studio's **Add block → Video** provides the same web export and an explicit popup preview; email retains ordinary watch links and standalone WordPress export uses a native Embed block. See [video and announcement setup](docs/AGENT-ANNOUNCEMENTS.md).

The public `/announcements/` page lists published announcements/events, with type filters and full-aspect flyer cards. Choose Announcement or Event in Story settings to add a full-height flyer (first photo), optional date/location, up to three labelled link buttons and a YouTube/Vimeo video. The module library includes Flyer and Video for placement within any story. Readers explicitly load video players; private preview stays link-only. See [the agent request examples and editor workflow](docs/AGENT-ANNOUNCEMENTS.md). Migration019 stores additive typed metadata in the existing SQLite database; older form, agent and Studio clients preserve it when omitted.

The public `/issues/` page lists the IMConnected newsletter issues that have at least one live story, newest first, with the issue number, the day it was sent, its optional title, the story count and the first three stories. `/issues/<n>/` shows one issue's live stories in newsletter order (`newsletterIssue.position`, then date order for stories without a position), with links to the previous and next listed issue; unknown or empty issues are a 404. A story's "Originally published in IMConnected Issue #N" line links there. Test: `scripts/test-issues-browser.mjs`.

## AI agent API

The communication director's AI agent finds stories on the conference's Facebook pages and writes them up. It sends them here; **they always land as drafts for a person to review and are never published by the agent.**

**Setup:** set `AGENT_API_TOKEN` in `.env` (32+ random characters, `openssl rand -hex 32`, a different value from `PUBLISH_TOKEN`). Unset or short, the API answers 503. It is machine-to-machine: no CORS headers, no cookies, and nothing under `/api/admin`. Rate limit: 60 requests per hour (`429` with `Retry-After`), counted **per server process** and shared by every `/api/agent/*` route including the read-backs, so a restart resets it and a second process has its own count.

```bash
# Which sections and areas are valid?
curl -s https://<your-site>/api/agent/sections -H "Authorization: Bearer <AGENT_API_TOKEN>"

# Send a story (up to 40 MB of JSON)
curl -s -X POST https://<your-site>/api/agent/stories \
  -H "Authorization: Bearer <AGENT_API_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "title": "<headline, up to 140 characters>",
    "dek": "<one-sentence summary, optional, up to 240>",
    "body": "<plain text or Markdown>",
    "section": "news", "area": "churches",
    "additionalSections": ["youth"],
    "newsletterIssue": { "number": 12, "date": "2026-09-14", "title": "<optional>", "position": 3 },
    "author": "<byline>", "church": "<optional>",
    "date": "2026-10-19",
    "sourceUrl": "https://www.facebook.com/<page>/posts/<id>",
    "note": "<optional note to the editors, e.g. why you picked it>",
    "photoLayout": "heroGrid",
    "photos": [ { "data": "data:image/jpeg;base64,<...>", "alt": "<describe the photo>" } ]
  }'
# 201 {"ok":true,"id":12,"status":"created","url":"https://<your-site>/admin/drafts/12"}
```

- **Fields.** `title` and `body` are required when a draft is created. `section` may be left out (the editor picks it); if sent it must exist, and `area` must belong to it. `date` is `YYYY-MM-DD` (default today). `body` is Markdown; every `<` is written as `&lt;` and control characters are removed from every text field, like a dashboard draft. `sourceUrl` must be an `http(s)` link. Up to 6 photos. Alt text is cut to 300 characters. Unknown keys are ignored.
- **`newsletterIssue`** (optional, issue #98): which IMConnected newsletter issue the story first appeared in, as `{ "number": 12, "date": "YYYY-MM-DD", "title": "<optional>", "position": 3 }`. `number` is 1 to 9999, `date` is the real day the issue was sent (not in the future), `title` is up to 200 characters and `position` (1 to 999, optional) is where the story sat in the issue. Accepted on create, update, each batch item and `changes.newsletterIssue` of a reopen. An unknown number creates the issue row in the same transaction as the draft; the same number with the same date (and the same title, when you send one) is reused. A different date, or a different non-empty title, is `400 newsletter_issue_conflict` naming the stored date and writes nothing: the agent never changes an existing issue (an administrator corrects it at `/admin/issues`). A malformed value is `400 bad_newsletter_issue`. The object sets issue and position together (no `position` means none); omitting the key keeps the stored issue, `null` clears the draft's issue and position. Read-back returns `newsletterIssue: {number, date, title, position}` or `null`. Creating an issue changes nothing public until a person publishes a story from it. **On the site:** a story with an issue shows "Originally published in IMConnected Issue #12 · September 14, 2026" under its byline (plain text until the issue page exists), and `/stories.json` gets an additive `newsletterIssue` object (`version` unchanged); editors set it on a draft's Story settings tab (select plus position), and administrators manage issues at `/admin/issues` (date and title edits are version-checked and audited as `issue.update`; an issue used by any draft or story cannot be deleted, `issue.delete`). Bulk edit does not touch it.
- **`photoLayout`** (optional): `one`, `twoUp`, `heroGrid`, `mosaic` or `stack`, how the story page arranges the photos once an editor publishes the draft (the editor can change it). A new draft without it gets `one`; an update that leaves it out keeps the draft's current layout; any other value is a `400` with code `bad_photo_layout`.
- **Photos are `data:` URLs only** (JPG, PNG, WebP or AVIF by file signature, 10 MB each). **Real budget:** base64 makes the JSON 4/3 the size of the images, so one request carries at most about 30 MB of image bytes (`floor(40 MiB * 3 / 4)` minus a 128 KiB allowance for the rest of the JSON), not 6 x 10 MB. `GET /api/agent/sections` reports `photoBudget` with `maxPhotos`, `maxPhotoBytes`, `maxRequestBytes`, `maxImageBytesPerRequest` and `jsonAllowanceBytes`, plus `photoLayouts` and `photoMimeTypes`. Keep the total under that budget by sending fewer or smaller (re-encoded) photos: an update with `photos` replaces the whole list, so it cannot append. The site never downloads a remote link (Facebook CDN links expire, and fetching them would be an SSRF risk), so a URL is a `400`. They are stored under `DATA_DIR/uploads`, served only to signed-in editors.
- **Idempotent by `sourceUrl`.** Posting the same `sourceUrl` again updates that draft, but only while it is still `new` and no editor has touched it. It never makes a second draft, and re-posts don't email the editors again.
- **Updates keep what you leave out.** On an update, every key you omit keeps its stored value (title, dek, body, section, area, additionalSections, author, church, date, note, photoLayout, announcement, photos). An explicit `""` or `null` clears an optional text field (`dek`, `author`, `church`, `note`, `area`; `section` too, which also needs `area` empty or valid). `title` and `body` can never be cleared (`400 title_required` / `body_required`); a create without them is the same 400. `photos` replaces the list only when the key is present (`[]` removes them all); `announcement: null` clears the event metadata. If `section` changes and `area` is omitted, the stored area is kept only if it is valid for the new section, otherwise `400 bad_area` (send `area`, or `""`). `photoLayout` and `date` cannot be cleared; `date: ""` means unchanged.
- **Announcement patches.** `announcement` on an update (and `changes.announcement` on reopen) is a partial merge into the stored announcement: only the keys sent change, `""` clears `eventDate`, `location` or `videoUrl`, `links` present replaces the whole list, `null` removes it, and `kind` is required only when there is no announcement yet. The merged result is validated as a whole (`400 bad_announcement`). Create takes the full object.
- **Photo crops, author title, credit, featured, markers.** Each photo may carry `focalX`/`focalY` (0 to 100, default 50) and `zoom` (1 to 3, default 1), stored like the editor's crop (`400 bad_photo_crop`; `fit` writes and `caption` are planned, issues #81 and #84, not accepted yet; read-back returns the stored `fit`/`fitFill`). `authorTitle` and `photoCredit` (one line, 120 characters, `""` clears) and `featured` (boolean, `400 bad_field` otherwise) are saved on create, update and reopen `changes`; omitted keeps the stored value. A standalone `{{photo N}}` line in the body (1 = lead) must point at a photo the draft will have after the request, else `400 bad_photo_marker`; the check is line-based (standalone marker lines outside fenced or indented code, backslash-escaped ones included); malformed markers are ignored by the renderer and not validated. On reopen a `changes.section` without `changes.area` uses the new section's first area (none for sections without areas); the update-by-`sourceUrl` path keeps its `400 bad_area`. Details: [docs/AGENT-REOPEN.md](docs/AGENT-REOPEN.md).
- **Retry protection (`requestId`).** Optional on create and update: 8-128 letters, digits, `_` or `-`. Only a SHA-256 of it and of the request content (key order does not matter) is stored, in the same transaction as the draft (migration 025, `agent_requests`). An identical retry answers `200 {"ok":true,"id":12,"status":"replayed","originalStatus":"created"}` and writes nothing, sends no email and adds no audit entry; the same `requestId` with different content is `409 request_id_reused`.
- **Read back.** `GET /api/agent/stories/<id>` or `GET /api/agent/stories?sourceUrl=<link>` returns `{"ok":true,"draft":{...}}` for drafts whose source is `agent` (anything else is `404 not_found`, exactly like a missing id; `?sourceUrl` missing is `400 source_url_required`). Fields: `id`, `status`, `createdAt`, `updatedAt`, `editorTouched` (a person has worked on it or it left `new`, so the agent can no longer overwrite it), `slug`, `url` (public address once published), `sourceUrl`, `title`, `dek`, `body`, `section`, `area`, `additionalSections`, `author`, `authorTitle`, `photoCredit`, `featured`, `church`, `date`, `photoLayout`, `announcement`, `hasModules` and `photos` (`position`, `alt`, `format`, `focalX`, `focalY`, `zoom`, `fit`, `fitFill`; no width/height, they are not stored). It shows the current state, including an editor's changes. It never includes submitter contact details, the agent's private note, editor or reject notes, revision history, upload paths or URLs, photo bytes or module JSON. It cannot publish or change anything.
- **Errors** are `{"ok":false,"error":"<code>","message":"..."}`. `400`: `title_required`, `body_required`, `title_too_long`, `dek_too_long`, `author_too_long`, `church_too_long`, `note_too_long`, `body_too_long`, `bad_section`, `bad_area`, `bad_date`, `bad_source_url`, `source_url_required` (GET), `bad_photo_layout`, `bad_additional_sections`, `bad_announcement`, `bad_field`, `bad_photo_crop`, `bad_photo_marker`, `author_title_too_long`, `photo_credit_too_long`, `bad_request_id`, `photos_invalid`, `photo_invalid`, `photo_remote_url`, `photo_too_large`, `photo_not_image`, `too_many_photos`, `invalid_json`, `too_large`. `401 unauthorized`. `404 not_found` (read-back of a missing or non-agent draft). `409`: `already_reviewed` and `request_id_reused`. `429 rate_limited` (with `Retry-After`). `503`: `not_configured` or `unavailable`.
- **Refusals (`409`).** Create/update answers `{"ok":false,"error":"already_reviewed","reason":"...","id":12,"message":"..."}` and changes nothing. `reason` is `published` (use `POST /api/agent/stories/reopen` with the slug in `message`), `in_review` (an editor is reviewing it), `editor_editing` (still `new` but an editor has touched it), `rejected`, or, from reopen only, `open_draft_exists` (a draft is already waiting). Messages for `in_review`, `editor_editing` and `rejected` say the agent cannot send more through the API. `published` points to reopen only while the story is live; if it was unpublished, the message says an editor must handle it. On reopen, `id` is `null` unless the linked draft came from the agent. `request_id_reused` and `module_body_conflict` (reopen) repeat their code as `reason` and also carry `message`. The `error` codes are unchanged.
- **In the dashboard** the draft has source `agent`: a "From AI agent" badge, the agent's note and a "View original post" link (http(s) only, `rel="noopener noreferrer"`) in the submitter panel, and a "Source: AI agent" filter in the inbox. The editors who have "Email me when a story is submitted" on get the usual email, which says it is from the AI agent. The audit log gets an `agent.story` entry (draft id only), and server logs carry only the draft id.
- **Updates after publication.** `POST /api/agent/stories/reopen` copies a current public story, announcement or event into an In review draft, retaining existing photos/modules and accepting partial changes plus appended photos. A required `requestId` prevents duplicate additions on retries (it is also optional on `POST /api/agent/stories`). Open/rejected drafts are protected; the live version stays unchanged until a person publishes the update. See [the complete reopen API, examples and error handling](docs/AGENT-REOPEN.md).
- **Bulk submit.** `POST /api/agent/stories/batch` with `{"requestId":"...","stories":[ ...up to 20 story objects... ]}` writes each story exactly like `POST /api/agent/stories` (same validation, sourceUrl idempotency, omission rules, per-item `requestId`), each in its own transaction, and answers `200 {"ok":true,"results":[{"index":0,"ok":true,"id":12,"status":"created"},{"index":1,"ok":false,"error":"already_reviewed","reason":"in_review","id":9,"message":"..."}]}` in request order. A bad item never blocks the others. The batch `requestId` is required; an identical retry returns the original results (`"replayed":true`) without writing, emailing or auditing, and the same id with a different body is `409 request_id_reused` (migration 026, `agent_batches`: hashes, ids, statuses and codes only). A malformed envelope (bad JSON, not an object, `stories` missing/empty/over 20, bad `requestId`, over 40 MB) is a single `400` with nothing written. A batch is one call against the 60/hour limit, plus a separate ceiling of 300 stories per hour per process (`AGENT_BATCH_ITEMS_PER_HOUR`, test/ops tuning only): a batch that would exceed it is rejected whole with `429` and `Retry-After`. Editors with the notification opt-in get one summary email per batch ("N new drafts from the AI agent"), and the audit log gets an `agent.story` entry per written item plus one `agent.batch` entry with counts. Drafts only: publishing stays a person's action. See [docs/AGENT-BATCH.md](docs/AGENT-BATCH.md) for a synthetic example and a backfill recipe.
- **What the agent can't do.** Publish, unpublish, reject, overwrite an open/rejected draft, or reach any `/api/admin` route. The explicit reopen API may propose changes to a published story previously edited by a person, but publishing those changes stays a person's action in `/admin`.
- **Tests.** `npm run build`, then `SCRATCH=/tmp/imc-agent node scripts/test-agent-api.mjs` starts the mock email API and several copies of the built server itself and checks the agent API, migration 010 on a database that already has drafts and photos, and `/api/stories`. Use made-up tokens; never call the real site.

## Upgrading to database publishing (one time)

Do this once, on the server that still publishes through git (steps 1 to 3 of epic #25):

1. **Stop publishing on the old server first.** Nobody uses the dashboard's Publish or Unpublish, and Studio does not publish, from now until the new version is live and checked. An unpublish or publish made on the old version after the new image was built is not in that image, and the one-time adoption can only settle what it can see.
2. **Back up first.** Download `/data/imconnected.db` from the backups page (or use last night's Google Drive backup) and keep the `media` folder with it. After this change the database and `DATA_DIR/media` are the only copy of the stories.
3. **Merge** the change and **wait for the image** to finish building (the Action's "Build & publish image" run).
4. **Deploy** it (`docker compose pull && docker compose up -d`, or the `deploy` branch as usual).
5. **Check the server log** (`docker compose logs imconnected`) for `[stories] adopting the build: ...` followed by `the database is now the source of truth; the build is not read for content any more`. If you see `could not be adopted` lines instead, the site is still served from the table (nothing is lost); the next restart tries again, and the log names the story that failed.
6. **Look for hand-committed stories.** If anyone committed story files to git after the image was built, run `scripts/import-git-stories.mjs` as a dry run (see Stories in the database), then with `--apply` if it lists anything.
7. **Clean up.** `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH`, `GITHUB_PR_LABEL` and `SUBMISSIONS_TO` can now be removed from `.env`.

The Docker health check requests `/`, which reads the database, so a database outage shows the container as unhealthy on purpose; its 90-second start period covers the first start on a brand new database, where the first request waits (up to 60 s) for the adoption.

## Stories in the database

Epic #25 moved published stories and their photos from git into the site's SQLite database. **Since step 4 the database is the source of truth**: nothing in the app calls GitHub, publishing needs no build or deploy, and a story is live on the very next request.

- **Tables** (migration `011_stories.sql`, STRICT; `015_stories_source_of_truth.sql` adds `stories.edited_at` and the `app_state` flags table): `stories` has every field of the content schema (`src/content.config.ts`) plus the body, `slug` (unique), `status` (`live` or `unpublished`), `source` (`git`, `form`, `studio`, `editor` or `agent`), `draft_id`, `published_at`, `updated_at`, `published_by` and `edited_at` (set when a person publishes, edits or unpublishes it in the dashboard or Studio; NULL for a story only ever imported from git); `story_photos` has one row per photo (position, path or url, alt text, sha256). Migration `016_photo_layout.sql` (issue #35) adds `photo_layout` to `stories` and `drafts` (`one` | `twoUp` | `heroGrid` | `mosaic` | `stack`, default `one`, a CHECK constraint; existing rows read `one`). `src/lib/story-store.ts` has the typed, synchronous access (`getStoryBySlug`, `listStories`, `writeStory`, `upsertStory`, `unpublishStory`, `storyExists` ...).
- **Publishing** (`src/lib/story-publish.ts`). Dashboard Publish, Publish changes, Unpublish, the edit-a-live-story flow and Studio's `POST /api/publish` all write to the tables, never to git. A publish checks the draft, copies its photos into `DATA_DIR/media/stories/<slug>/<sha256>.<ext>` (content-addressed, so a retry or an identical photo is a no-op), then runs **one transaction** that changes the draft row (version check, slug reservation, `published_commit` set to `db`) and the story, its photos and its search entry together, then clears the page cache. If anything fails before the commit, the transaction rolls back and the files this attempt created are deleted: nothing is half-written and the draft stays editable. The slug is chosen and written with no `await` in between, and the unique indexes on `stories.slug` and `drafts.slug` stop a second process, so two editors publishing the same title at once get different addresses (`-2`) and never the same one. A draft photo that is not one of the story's own photos (and not an `https://` link) is refused (`photo_link_bad`). The notice is "Published. It's live now." with a link; the story shows on its page, the section page, the home page, `/stories.json`, `/rss.xml`, search and `/api/stories` on the next request. Unpublishing flips the row to `unpublished` in the same kind of transaction (the row and photos stay, the draft returns to review) and is just as immediate. Every action keeps its audit entry (`draft.publish`, `draft.unpublish`, `draft.published_studio` ...). Browsers and Cloudflare may keep a page they already hold for up to about 6 minutes (`max-age=60` plus `stale-while-revalidate=300`).
- **One-time adoption of the build** (`src/lib/story-adopt.ts`, replaces the step 1 mirror). Existing servers still have their stories in git and mirrored into the table. The first start of this version on a database whose `app_state` has no `git_adopted_at` runs one last import of the built content collection (baked into the server bundle, so it works in the image), shaped exactly like the old mirror pass: a built story that is missing from the table or differs from its git-sourced row is imported (photos copied from the build into `DATA_DIR/media`), a story the dashboard unpublished (`drafts.unpublished_at`) or whose hold is still active stays unpublished, a git story that is no longer in the build is unpublished, and a row whose source is not `git`, or that a person changed through the dashboard or Studio since the upgrade (`edited_at` later than migration 015's `applied_at`), is never overwritten. Everything that decides a story is read inside its write transaction (the row must still be git-sourced and unchanged since the pass read it), so a person who publishes, edits or unpublishes while a pass is running is never overwritten or revived. When every story went through, one transaction sets `git_adopted_at` and marks any remaining `story_holds` rows released. From then on **the build is never read for content again**: a later start, even with an older image, finds the flag and does nothing, so a redeploy can never revert an edit. A pass in which a story fails is retried after about a minute (5 passes per process) and does not set the flag, so the next start tries again. On a brand new empty database the first public request or search waits (up to 60 s) for the adoption, so the site is never empty; on an existing database the pages serve the table straight away while the adoption runs in the background.
- **Holds are retired.** Step 2 added `story_holds` (migration 012) and the `/app/.build-commits` list because an unpublish was a git commit and the running build still held the old text. Unpublish is now a row flip, so there is nothing to hold. The table stays, renamed `story_holds_retired` by migration 015 and inert: only the adoption pass reads it (to settle unpublishes made just before the upgrade), nothing writes it, and the adoption releases what is left. `src/lib/story-holds.ts` and the commit-list step in `docker.yml` and the `Dockerfile` stay for the same one reason and can be removed, with a migration that drops `story_holds`, once every server has adopted. This release must be built by `docker.yml` (which writes `.build-commits`) so the first start can settle old holds exactly.
- **If the database can't be read**, public pages, `/stories.json` and `/rss.xml` answer `503` (`no-store`, a short "We'll be right back" page), `/api/stories` answers 503 and search says it is unavailable. They never show stale built content: an empty table is a real empty site, and a missing table is an outage, not an empty site.
- **Rolling back.** Do not run an image from before this change against a database that has adopted. An image from before migration 017 (story modules) can still read the database but does not know `story_blocks`: it shows and republishes only the Markdown `body`, so a modular story that is edited or republished there leaves its `story_blocks` stale (the modules no longer match the text the older image saved), and that has to be fixed by reopening the story in a current image. A guard stops the damage if someone does: migration 015 renames `story_holds` to `story_holds_retired` (the old code looks the old name up before it writes anything, so its mirror fails on every story) and adds `stories.rev`, which every write by the new code bumps, plus a trigger that, from the moment 015 is applied, refuses any `UPDATE` of a story that does not bump it. The old mirror's upsert and its "left the build" unpublish therefore cannot revert or unpublish rows (`test-story-store.mjs` replays that SQL against an adopted database and shows nothing changes). The old image also would not publish through the new tables, so restore a backup if you really must go back. Test scripts, and any future migration, that update `stories` by hand must set `rev = rev + 1`.
- **`GET /media/<path>`** serves the photos (jpg, png, webp and avif only) with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. Paths with `..`, encoded dots or slashes, backslashes or an absolute form return 404, and so does anything that is not an image inside `DATA_DIR/media`. Old `/images/stories/...` links (already in sent newsletters) keep working: the file in the frozen archive is served as before, and a photo that only exists in the database is redirected (301) to its `/media/` copy.
- **Public pages** (`src/lib/public-stories.ts`): the home page, story, section and area pages, `/stories.json` and `/rss.xml` are rendered on the server from the table with the same markup, URLs, SEO tags and feed shape as before. Rendered pages and feeds are kept in memory (at most 300, expiring after 10 minutes, only 200 responses) and cleared by `invalidateStories()`, which every publish, unpublish and store write calls. An unknown or unpublished story, section or area is a real 404 (`no-store`).
- **Importing stories committed by hand.** `scripts/import-git-stories.mjs` brings Markdown story files (and their `/images/...` photos) into the table. It prints what it would create, update or leave alone and changes nothing without `--apply`. A story that was changed in the dashboard or Studio since its last import (source not `git`, or `edited_at` set) is never overwritten unless you pass `--force`. Run it where the data lives, with the folder copied in:

  ```bash
  docker compose cp ./stories imconnected:/tmp/stories && docker compose cp ./public imconnected:/tmp/public
  docker compose exec imconnected node scripts/import-git-stories.mjs --dir /tmp/stories --public /tmp/public          # report only
  docker compose exec imconnected node scripts/import-git-stories.mjs --dir /tmp/stories --public /tmp/public --apply  # do it
  ```

  The server shows the changes within about 10 minutes (its page cache), or at once after `docker compose restart imconnected`; search picks new stories up within about a minute.
- **Tests.** `npm run build`, then `SCRATCH=/tmp/imc-story-store node scripts/test-story-store.mjs` (migrations 011, 012 and 015 on a database with data; the first-start adoption with identical fields and photos; the step-3 to step-4 transition with a newer build, active and released holds, a story edited in the database, and a later start with an OLDER build that changes nothing; a story that never adopts), `scripts/test-public-pages.mjs` (every page and both feeds against a baseline build from before step 2, a brand new database, instant unpublish and republish, cache invalidation, 404s, old image links, a partial adoption), `scripts/test-editor-drafts.mjs` (publishing, republishing, unpublishing, two editors at once, a database error part-way, with no GitHub token set), `scripts/test-editor-submissions.mjs` (Studio publishes to the database, 503 pages when the database can't be opened) and `scripts/test-import-git-stories.mjs`.
  - **Search (step 3).** `GET /api/search?q=&section=` searches the stories with SQLite FTS5 and replaces Pagefind (the build step, the dependency, the `data-pagefind-*` attributes and the hidden `/search-source/` pages are gone). It is server-rendered, public and returns JSON: `{ ok, total, results: [{ slug, url, title, section, date, author, church?, snippet }] }`, at most 20, best match first (title counts most). `/search` (still a static page) is a form that calls it and builds the results with DOM text nodes; it works at phone width.
    - **Index.** Migration `013_story_search.sql` adds the FTS5 table `stories_fts` (title, dek, author, church and the plain text of the body, accents folded, prefix matching) with the story's id as its rowid. SQL cannot turn Markdown into plain text, so the rows are written by code rather than triggers: publishing (`writeStory()` in `src/lib/story-store.ts`) re-indexes a story in the same transaction that saves it, so a story is searchable the moment it is in the table. As a safety net, each search first re-indexes any story whose index row is missing or whose `stamp` differs from `stories.updated_at` (stories from before migration 013, or written some other way). The index holds no status: every search joins `stories` and keeps only `status = 'live'` and `draft = 0`, which is exactly the set `public-stories.ts` shows (an unpublished story keeps its row with status `unpublished`), so a story unpublished in the dashboard is gone from the very next search with no index write. Search responses are never cached (`Cache-Control: no-store`), so there is nothing to invalidate.
    - **No fallback.** Search always uses the FTS5 index (step 4 removed the in-memory search over the build). On a brand new, still empty database the first search waits (up to 60 s) for the one-time adoption; if the index can't be read the answer is `ok: false` (the page shows the message), never a wrong "no matches". The response header `X-Search-Source` is `index`.
    - **The query.** Over 200 characters is a 400. Only runs of letters and digits are kept (so every quote, star, bracket, colon, minus, caret and `NEAR(` is dropped as punctuation), at most 8 words of at most 40 characters, each searched as a quoted prefix (`"word"*`) with all of them required; `AND`, `OR` and `NEAR` are just words. Nothing the visitor types is passed to FTS5 as syntax, and the query is never echoed back. A query with no word is a 400 with a short message; an unknown `section` is a 400.
    - **Snippets.** Cut from plain text, escaped (`& < > " '`) piece by piece, and only then wrapped in `<mark>`; the only markup in a result is `<mark>`/`</mark>`. All other fields are JSON strings, and the page sets them as text. Stored hostile text (`<script>`, `<img onerror>`) therefore shows as literal characters.
    - **Limits and errors.** 120 searches per IP per 10 minutes (429 with `Retry-After`, the same per-IP pattern as `/api/publish`). Every other outcome is 200 or 400; an internal failure is a 200 with `ok: false` and an error message (the page shows it, not "no matches"), never a 500.
    - **Tests.** `npm run build`, then `SCRATCH=/tmp/imc-search node scripts/test-search.mjs` (optional `SHOTS=<folder>` saves screenshots at 390, 768 and 1280px). It covers a fresh start (waiting for the adoption), body, title, dek, author and church hits, unpublished, held-at-adoption and draft stories, a just-published story, edits, accents and non-Latin text, hostile queries and hostile stored text, the rate limit, the page in Chromium, and an unreadable index.


## Reviewing submissions

1. Sign in at `/admin`. The **Drafts** link shows a count of new and in-review drafts, and the top of the inbox lists the 5 newest drafts and the 5 newest published stories.
2. Open a draft. The editor-only panel shows who sent the story, their contact details and whether they confirmed their email (a "verified" badge appears in the inbox too).
3. Edit it in the browser: headline, summary (`dek`), Markdown body, photos and alt text, and **Featured** to put it at the top of the home page. Submitted text is plain text with HTML escaped; add Markdown formatting (headings, quotes, links) during review.
4. **Publish** puts it on the live site at once ("Published. It's live now", with a link), or **Reject** declines it. Only a person does either.

Each editor can turn "Email me when a story is submitted" on or off under **My account** (on by default). The email holds only the story title and church, with a link to the draft.

## Writing stories directly

Write stories in the dashboard (**New story** in `/admin`). The Markdown format below is the archive format in `src/content/stories/` (frozen: the site does not read it, except once when adopting) and the format `scripts/import-git-stories.mjs` reads for a story committed by hand:

```md
---
title: "Headline"
dek: "One-sentence summary"
section: news            # news | features | columns | youth | kids
area: churches           # news: conference|churches|schools|camp · youth: youth|pathfinders|adventurers
column: "From the President"   # columns only
author: "Name"
authorTitle: "Title"     # optional
church: "Church name"    # optional
date: 2026-10-16
image: /images/stories/my-story/photo-1.jpg   # file lives in <public>/images/stories/... (the import script copies it)
imageAlt: "Caption"
photoCredit: "Photographer"
photos: []               # extra gallery images
photoAlts: []            # alt text for each of `photos`, same order (optional)
imageCaption: ""         # visible caption under the lead photo, plain text up to 300 characters (optional, default none)
photoCaptions: []        # visible caption for each of `photos`, same order (optional)
photoLayout: one         # one | twoUp | heroGrid | mosaic | stack (optional, default one): how the story page arranges the photos
storyBlocks: []          # optional structured modules; [] keeps the Markdown body below
announcement: null      # optional {kind: event|announcement, eventDate, location, links: [{label,url}], videoUrl}
photoFocus: []           # optional [{ focalX: 50, focalY: 50, zoom: 1, fit: cover, fitFill: blur }], lead then gallery; focus 0–100, zoom 1–3, fit cover|contain, fitFill blur|paper|navy
featured: false
draft: false             # true hides it
---

Story text in Markdown…
```

**Before launch:** the `sample-*.md` files and `welcome-to-imconnected.md` are imported with the rest of the archive. Unpublish the samples in `/admin/published` and edit the welcome story there (publishing a change to a story is the same as for any other).

## Customizing

| What | Where |
|---|---|
| Site name, tagline, contact email, sections and categories | `src/lib/site.ts` |
| Colors, fonts, spacing | `:root` tokens at the top of `src/styles/global.css` |
| Home page layout | `src/pages/index.astro` |
| Form fields and limits | `src/pages/submit/index.astro`, `src/lib/limits.ts`, `src/lib/submission.ts` |
| Story fields | `src/content.config.ts`, `src/lib/story-publish.ts`, `src/lib/story-store.ts`, `src/lib/feed.ts`, the migrations, the README example (`.pages.yml` belongs to the frozen archive) |

If you add a section or category, update `site.ts` and the `area` comment above.

## Local development

```bash
npm install
npm run dev                # http://localhost:4321
npm run build && npm start # production build + server
```

Publishing needs no GitHub: run the server with a throwaway `DATA_DIR` and `AUTH_SECRET` (`DATA_DIR=/tmp/imc-data npm start`), create an admin (below) and publish from `/admin`. Studio's `POST /api/publish` can be tried with `curl` and a made-up `PUBLISH_TOKEN`.

For the dashboard flow, run the server with a throwaway `DATA_DIR` and `AUTH_SECRET`, and `scripts/mock-email.mjs` (it also answers `/emails/batch`, and `GET /rate-limit-once` makes the next batch return 429) with `EMAIL_API_URL` to see the emails; `scripts/test-editor-submissions.mjs` does all of this for you.

## Editor dashboard

Editors sign in at `/admin` with email + password and a required second factor (invite-only; passkeys, Google and Microsoft arrive over the epic in issue #7). The pages are server-rendered, `noindex`, and never cached.

- **Data volume.** Accounts, sessions and the audit log are in `imconnected.db` inside `DATA_DIR` (`/data` in Docker, `./data` in development). The compose file mounts the named volume `imconnected-data` there. That volume is now the only copy of the stories and their photos (`media/`), so keep the nightly Google Drive backup running (Setup, step 7) and add the volume to your own backups. Migrations in `src/lib/db/migrations/` apply automatically, once each, when the database is first opened. If the database can't be read, `/admin`, submissions, Studio publishing, public pages and feeds report unavailability rather than use the frozen archive or accept a lost write; search reports `ok: false`. `node scripts/migrate.mjs` applies migrations by hand. A bind mount instead of the named volume must be owned by uid 1000 (the `node` user).
- **First admin.** Run once on the server (the email and name are yours; the output is a 24-hour, single-use invite link at `/admin/invite/<token>`):

  ```bash
  docker compose exec imconnected node scripts/create-admin.mjs you@example.org "Your Name"
  ```

  Only a hash of the invite token is stored, so the link can't be shown again. Run the command again to get a fresh one.
- **Local testing.** `DATA_DIR=/tmp/imc-data npm start`, then `DATA_DIR=/tmp/imc-data node scripts/create-admin.mjs test@example.com "Test Admin"`. Session cookies are always `Secure`, so local sign-in needs Chrome or Firefox on `localhost` (they accept Secure cookies there). Use synthetic data and delete the folder afterwards.

### Sign-in, 2FA and recovery codes

- **`AUTH_SECRET`** (32+ random characters, in `.env`) is required. It encrypts stored authenticator secrets (AES-256-GCM) and keys the recovery-code hashes. Without it every `/admin` URL answers 503. Don't change it once editors have enrolled, or their authenticators stop working and they need new invites.
- **Accepting an invite.** The link opens "set your password" (12-256 characters, not the email address, not a common password; hashed with scrypt, N=2^15). The editor then scans a QR code (or types the key) into an authenticator app, confirms with one code, and gets **10 single-use recovery codes**, shown once; only keyed hashes are stored.
- **Signing in** is two steps: `/admin/login` (email + password), then `/admin/2fa` (6-digit code, a recovery code, or a passkey). A session that hasn't finished both can only reach the 2FA pages and sign-out. Each step issues a new session id.
- **Passkeys (WebAuthn).** Uses `@simplewebauthn/server` and `@simplewebauthn/browser` (exact versions pinned; the browser part is bundled by Astro and served from this site, no CDN). The relying party comes from **`SITE_URL`**: RP ID = its hostname, expected origin = its origin, never the request. Without a valid `SITE_URL` (https, or `localhost`) passkey buttons are hidden and passkey endpoints answer 503. Don't change the `SITE_URL` hostname once editors have passkeys, or they stop working.
  - *Enrollment:* "Use a passkey instead of an authenticator app" on `/admin/2fa/setup`. A passkey counts as a confirmed second factor, and the first factor generates the 10 recovery codes.
  - *Sign in:* "Sign in with a passkey" on `/admin/login` (discoverable credential, user verification required) satisfies both factors and starts a full session. After a password, `/admin/2fa` also offers "Use a passkey" next to the code field.
  - *My account:* list, rename, add and remove passkeys. Adding or removing one needs a fresh authenticator or recovery code, or a passkey confirmation (leave the code empty). A user can't remove their last second factor (a confirmed authenticator app counts as another).
  - *Safety:* challenges are stored in `webauthn_challenges`, single use, valid 5 minutes. A signature counter that doesn't go forward (when either value is non-zero) is refused and audited. Passkey sign-in shares the password step's rate limits (10 failures per IP, 5 per account in 15 minutes). Registrations, removals, renames, sign-ins and failures are in the audit log.
- **Errors and limits.** An unknown email, a wrong password and a disabled account all show "Email or password is incorrect." and cost the same time. 10 failures per IP or 5 per account in 15 minutes lock sign-in for that IP or account (the same message either way). Recovery-code use, failures, password changes and session revocations are in the audit log.
- **My account** (`/admin/account`): change password (needs the current password plus a fresh code; signs out every other session), generate new recovery codes (old ones stop working), and see or sign out active sessions.
- **Lost authenticator and recovery codes?** A person runs `docker compose exec imconnected node scripts/reset-2fa.mjs editor@example.org` on the server, only after confirming the editor's identity out of band (for example by phone), and right before the editor signs in. In one transaction it deletes that user's authenticator, passkeys, recovery codes and sessions, and writes an `admin.reset_2fa` audit entry. The password stays; at the next sign-in the editor enrolls a new authenticator or passkey and gets new recovery codes. Administrators can do the same from **Editors** (below), without server access.

## Security and spam notes

- Story text has HTML escaped and link syntax neutralized, because Astro renders raw HTML in `.md` files.
- Photos are checked by file signature (JPG, PNG, WebP or AVIF only), up to 6 photos at 10 MB each. The public form shrinks large JPG/PNG photos to a 2000 px long edge before upload; WebP and AVIF originals are retained. The server stores the received bytes unchanged.
- Spam protection: a hidden honeypot field, a minimum time to fill out the form, an Origin check, a per-IP hourly limit (`SUBMIT_RATE_LIMIT`), Cloudflare Turnstile, email domain checks and a confirmation email (see below).
- Submitter email addresses and phone numbers live only in the dashboard database and the editor-only submitter panel (never in a pull request: there are none now). They are never logged, never in a story row, and and never in the editor notification emails.
- There is no GitHub token to protect: the app makes no GitHub call.
- Photos are files in `DATA_DIR/media` (on the data volume, included in the nightly backup). If that folder ever gets large, move it to object storage and store URLs in `story_photos.url` instead.

### Drafts inbox and story editor

- **`/admin`** is the drafts inbox (new and in-review drafts, newest first; filter by status and section; "New story" starts an editor draft). `/admin/drafts/<id>` is the editor: story fields, a Markdown body with a toolbar and a preview rendered on the server with the site's own Markdown processor, photos (upload, reorder, lead image, alt text, delete; the lead photo's alt text becomes `imageAlt`, the others go to `photoAlts`), a **Photo layout** picker (five cards with a small preview: One hero, Two up, Hero + grid, Mosaic, Stack; saved with the draft, an unknown value is refused), autosave every 20 seconds, and a submitter panel (name, email, phone, church, verified) for signed-in editors only. `/admin/published` lists live stories with Edit (loads the story's current text from the database into a draft linked to its slug) and Unpublish (takes it off the site at once; its row and photos stay).
- **Inline Markdown photos.** In Markdown mode, choose an uploaded story photo and **Insert photo**, or write `{{photo 2}}` on a line by itself (1 = lead photo). Preview warns about invalid positions. Published stories show the chosen photo at that point, with its saved zoom/pan and enlargement link, and omit that slot from the surrounding photo layout. Code examples and marker-like prose stay literal; excerpts/search omit marker syntax. Reordering photos changes what each position references. Use the gallery range picker or `{{gallery 1-3 columns=3}}` on its own line to place at least two photos together (2 or 3 columns; three columns reduce to two on phones). Reversed or unavailable ranges are skipped as a whole. Modules remain an alternative editing mode.
- **Publishing** checks the draft against the content schema and writes the story, its photos and its search entry in one database transaction (`src/lib/story-publish.ts`; see Stories in the database). No GitHub settings are involved. The story is live on the very next request, and the notice says so with a link. Publishing a draft that is linked to a live story overwrites the same slug. Administrators also see a reminder on the publish screen (and the dashboard home) when nightly backups are not set up, because the database is now the only copy; it never blocks publishing.
- **Safety.** Raw HTML is never stored: every `<` in the body is written as `&lt;` (also in code), and the pages render story text through the site's safe Markdown processor and escape every other field. Links must be http(s), mailto or tel. The preview is shown in a sandboxed frame with no scripts. Uploaded photos live in `DATA_DIR/uploads/<draft>/` under random names (type sniffed, never under `public/`) and are served only to signed-in editors by `/api/admin/photos/<id>`; a publish copies them to `DATA_DIR/media/stories/<slug>/<sha256>.<ext>` and then deletes the upload. Photos of rejected drafts are deleted 30 days after rejection (the cleanup runs when the inbox opens, at most once a day). Two editors saving the same draft: the later, stale save is refused ("reload to see changes"). Publishing is checked against the draft version inside the transaction, so a draft changed since the page was loaded is refused (`conflict`) and nothing is written. Submitter contact details are never logged, audited or published.
- **Editor accounts and the audit log (administrators).** `/admin/editors` lists everyone (name, email, role, status, two-step methods, last sign-in). An administrator can invite someone (name, email, role), re-send an invite (the old link stops working), change a role, disable or re-enable an account, and reset someone's two-step sign-in. Invites last 7 days; with Resend configured (`RESEND_API_KEY`, `EMAIL_FROM`) the email holds only the inviter's name, the site name and the link, otherwise the link is shown once with a copy button. Disabling signs the person out of every session at once. The last active administrator can be neither demoted nor disabled (checked inside a transaction). Resetting two-step sign-in shares its code with `scripts/reset-2fa.mjs` and forces enrollment at the next sign-in. Each of these needs a second factor proved in the last 10 minutes (sign-in 2FA counts; otherwise the form asks for an authenticator or recovery code, or a passkey). `/admin/audit` is a paginated log filterable by person and action. Editors see the list read-only, names only, and get 403 on the audit log and every account action. Audit entries older than 2 years and expired sessions, passkey challenges and invites are deleted at the first admin request after a start and then once a day. Tests: `npm run build`, then `DATA_DIR=/tmp/imc-accounts node scripts/test-editor-accounts.mjs` (it starts the built server and the mock email API itself).
- **Bulk publish/unpublish (issue #88).** The New/In review lists (stories, announcements, events) and `/admin/published` have a checkbox per item (named by its title), a "Select all on this page" checkbox (needs JavaScript) and a sticky bar with **Publish selected** or **Unpublish selected**. The checkboxes work without JavaScript: they are a normal form that posts to `/admin/bulk`, which first shows a confirmation page listing the escaped titles (never submitter details; administrators also see the backup reminder when backups are off) and does nothing until **Yes, publish/unpublish** is clicked. Each item then runs one at a time through the same code as the single buttons (`src/lib/bulk-actions.ts`: version check, validation, slug reservation, one transaction per story, `draft.publish` / `draft.unpublish` audit entry, cache invalidation), so one failure never rolls back the others. A draft is published only at the version the list showed (a hidden `v_<id>` field), so a draft someone changed after the list loaded fails with a version conflict instead of going live unseen. The result page lists every item as published/unpublished or failed with a plain reason, announces the outcome, and pre-selects the failed ones for another confirmed try (except version conflicts: open that draft to review what changed). At most 50 items per request (400 otherwise). Same permissions as the single actions: any signed-in editor or administrator, with the usual session, 2FA and Origin checks. Publishing and unpublishing stay a person's action; the agent API has no access. **Bulk reject and bulk edit (issue #89).** The draft lists also offer **Reject selected** (an optional shared reason, up to 500 characters, same rules and `draft.reject` audit entry as the single Reject; contact details never appear) and **Edit fields** on drafts and on `/admin/published`. Edit fields first shows a chooser; only the fields you tick change and everything else is kept as stored: primary section and category together, a category alone (checked against each item's own section, so a mismatch fails only that item with a plain reason), additional sections to add and/or remove (the primary is never kept as an extra, central order, see `docs/MULTIPLE-SECTIONS.md`; a section change does not turn the old primary into an extra), featured on/off, and the date. The confirmation page lists exactly the fields and values that will change. Drafts go through the editor's own version-checked save at the list's version (a New draft moves to In review and a draft revision is recorded); live stories go through `editLiveStory()` in `src/lib/story-publish.ts` and `writeStory` (one transaction per story, `rev` bumped, `edited_at` set, search entry rewritten, caches invalidated) and show on section pages, feeds and search at once. **A live story that has an open draft is refused** ("An open draft exists for this story. Edit it there") so the draft and the live story cannot drift apart. Audit: one `draft.bulk_edit` / `story.bulk_edit` entry per changed item listing only the field names (`section`, `area`, `column`, `additionalSections`, `featured`, `date`). Logic is in `src/lib/bulk-edit.ts`. Max 50 per request. A large bulk publish (many stories with photos) can take a while; if the browser shows a proxy timeout the server still finishes, and running it again is safe (items already published fail harmlessly as "not publishable"). Test: `scripts/test-bulk-actions.mjs` (starts its own server; `DATA_DIR`, `PORT`, optional `SHOTS`, `AXE_JS`).
- **Tests.** `scripts/test-editor-drafts.mjs` covers all of this against a running built server with no GitHub token set (see the header of the script for the commands).

### Submissions and Studio in the dashboard

- `/api/submit` makes no GitHub call and needs no GitHub settings (`SUBMISSIONS_TO` is no longer read). It keeps every check (Origin, honeypot, minimum fill time, rate limit, email checks, Turnstile, photo signatures) and then creates a `drafts` row (source `form`, status `new`) with its photos in `DATA_DIR/uploads`.
- **Confirmation links** sign the draft id (`d:<id>`). Confirming sets `email_verified` on the draft. Links from emails sent while submissions were pull requests (a bare PR number) are no longer honoured and answer "This link isn't valid."
- **Editor notifications** go through the same Resend settings as the confirmation email (`RESEND_API_KEY`, `EMAIL_FROM`): one email per active editor who has the setting on (a single request to Resend's batch endpoint, `EMAIL_API_URL` + `/batch`, one message per recipient and no BCC; a 429 is retried once after `retry-after`, at most 5 s), subject "New story submission: <title>", a link to `/admin/drafts/<id>`, and only the escaped title and church in the body. The emails and the Discord ping are sent in the background after the response, so the visitor never waits on them; a failure is logged (counts only) and never fails the submission. The optional Discord ping (`DISCORD_WEBHOOK_URL`) carries the title, church and dashboard link only, with Discord Markdown in the title and church escaped.
- **Tests.** `npm run build`, then `SCRATCH=/tmp/imc-e2e node scripts/test-editor-submissions.mjs` starts the mock email API and two copies of the built server itself (see the header) and checks all of the above, including Studio publishes to the database and the 503 behavior when the database can't be opened.

The visual **Gallery** module selects and reorders this draft’s photos with checkboxes and keyboard buttons, with two or three columns. Upload photos in Photo studio first. Descriptions follow each photo’s current alt text; crops follow Photo studio. A gallery needs at least two photos before publishing. Deleting a photo removes its gallery references without deleting other content. Duplicate and Undo preserve gallery order; reopening a published story remaps its photo references to the editable draft.

**Sections and columns (Story Builder v2).** Add a Section / columns module for a one- or two-column group. Select its child modules in the outline or canvas; insert after a child to keep new content in that column. Inspector buttons move children between columns or outside the section. Drag and Move up/down stay within the current column. Switching two columns to one concatenates their contents in reading order; duplication assigns new IDs throughout, and Undo restores the whole change. Phones stack columns in source order. Sections and their children share the existing 60-module and 20,000-character limits; sections cannot nest.

**Module formatting.** Select text in a paragraph or quote and use Bold, Italic or Link; keyboard activation returns focus and keeps the selected text. Formatting is an atomic Undo change and respects the overall text limit. Compatible text modules offer Left/Center/Right alignment; all modules offer Default/Compact/Normal/Relaxed spacing. These are fixed settings shared by private preview and public rendering; no arbitrary style input is accepted.

**My saved layouts.** Editors can save up to50 private, named structures from the module library, then insert them after selection. They preserve module types, columns and approved visual settings while leaving out all story text, links, descriptions and photo choices. Insertion adds fresh IDs and one Undo step; a structure containing sections stays outside any current section. Layouts persist in SQLite (migration020); only their owner can list or delete them. Fill in the new modules' content and photos before publishing.

**Saved revision history.** Open Review & publish → Saved revision history to restore one of the latest 20 previous saved states. History survives reloads and includes editorial fields, modules, announcement settings and photo order, descriptions and crops. Restore saves your current edits first, refuses stale versions and changes only the editable draft; publishing remains a separate action. It keeps current uploads and restores metadata only for photos whose stable identity still matches. Deleted files are never recovered or attached to replacement uploads; missing module references are removed, missing Markdown markers become inert and a visible warning asks you to review the photos or flyer. History stores no submitter contact details, source URL, internal agent notes or file paths. Migration 021 keeps it in the existing SQLite database and backups; it is available only to signed-in editors, and unchanged saves do not consume history entries.
