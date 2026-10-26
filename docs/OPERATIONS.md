# Operating IMConnected

How to deploy, update, configure, back up and restore the site. Only a person does any of this on the real server. For an overview of the project, see the [README](../README.md).

## Setup

### The repository

```bash
git remote add origin git@github.com:DurantTL/imconnected.git
git push -u origin main
```

> The repository holds code only. Contact details live in the database, never in git, so the repo may be public or private.

### Image builds

The Action at `.github/workflows/docker.yml` builds the image and pushes it to GHCR once a day (07:43 UTC), and only when `main` has changed since the last image, so a day of merges ships together. To ship right away (for example after the last merge of a batch), open **Actions → Build & publish image → Run workflow** on `main`. There's nothing to configure. (GitHub may delay scheduled runs at busy times, and on a public repository it pauses scheduled workflows after 60 days without any repository activity; a manual run or any push turns it back on.) To set the canonical URL, add a repository **variable** `SITE_URL` (Settings → Secrets and variables → Actions → Variables). Otherwise it defaults to `https://stories.imadventist.org`.

If the GHCR package is private, run `docker login ghcr.io` on the server first, using a token with `read:packages`.

### Run it on the server

```bash
cp .env.example .env      # fill in SITE_URL, AUTH_SECRET, etc.
docker compose up -d
```

The container listens on port **4321**. Put it behind your reverse proxy (Nginx Proxy Manager, Cloudflare Tunnel, Traefik…). Set `TRUST_PROXY` so the rate limiters see real visitor IPs: `cloudflare` when the site is behind Cloudflare's proxy (it trusts `CF-Connecting-IP`), `true` for a single reverse proxy such as xCloud's nginx (it trusts the last `X-Forwarded-For` entry, the one your proxy added). If it is unset behind a proxy, every visitor shares the proxy's IP, so the submit, publish and sign-in rate limits and lockouts are shared by everyone. Never set either value when the app is reachable directly, because visitors could then forge their IP. That includes `cloudflare` mode when your server can also be reached by its own IP address: anyone hitting the server directly can send a fake `CF-Connecting-IP`. Use `cloudflare` only if direct traffic is blocked: firewall the server to Cloudflare's IP ranges, use a Cloudflare Tunnel, or have nginx set the real IP from Cloudflare's ranges (`set_real_ip_from`).

**Updating after a merge:** the server never builds the site; it only pulls the finished image. Once a day (or when someone runs **Actions → Build & publish image → Run workflow** on `main`), the Action builds and publishes the image, then moves the **`deploy`** branch to that commit. A change merged today goes live after the next daily run, or right away if you run the workflow by hand. Point your host's git auto-deploy (xCloud) at the `deploy` branch, not `main`, with this deploy command:

```bash
docker compose pull && docker compose up -d
```

Watching `main` instead would start the deploy about two minutes before the new image exists, and the server would pull the previous version. To update by hand, run the same command. If the Action's `deploy` job fails, the server stays on the previous version until the next daily run (which rebuilds, because `deploy` is still behind `main`); re-run the newest "Build & publish image" run from the Actions tab (older runs skip publishing on purpose).

The site address defaults to `https://stories.imadventist.org`. If you set `SITE_URL` anywhere (the server's `.env` or the repository variable), it overrides that default, so keep both on the current domain.

### Bringing in stories that are in git (one time)

The first start of this version on a server whose database has not adopted the build yet imports the stories built into the image automatically (see [Stories in the database](STORAGE.md)). To bring in Markdown stories that someone committed by hand later, use `scripts/import-git-stories.mjs` (see [Stories in the database](STORAGE.md)). Pages CMS (`.pages.yml`) edits the frozen archive, which the site no longer reads, so it can no longer publish anything.

### Story feeds

The site serves the 50 newest published stories from the live database in two formats:

- **`/rss.xml`**: RSS 2.0 for feed readers and services that import RSS.
- **`/stories.json`**: for the IMConnected Studio newsletter builder. Every story has `id`, `url`, `title`, `section`, `sectionLabel`, `author`, `date` (YYYY-MM-DD), `photos`, `photoAlts` (alt text for each photo in `photos`, same order; entries may be empty), `photoLayout` and `featured`. `keyPoints` (issue #117: up to three plain-text lines, `[]` when none; escape them yourself; `version` stays 1), `photoCaptions` (visible captions for each photo in `photos`, same order; entries may be empty) and `imageCaption` (the lead photo's, only when it has one) were added by issue #84 (plain text, up to 300 characters: escape it yourself; `version` stays 1). `photoLayout` (added by issue #35, so `version` stays 1) says how the story page arranges the photos: `one`, `twoUp`, `heroGrid`, `mosaic`, `stack`, `carousel` or `threeUp` (the first five are the names of IMConnected Studio's story layouts; `carousel` and `threeUp` are site-only for now, not Studio's names); `one` is the original look (lead photo, the others in a row under the text) and is what every story has unless an editor or Studio chose another, so a consumer that ignores the field is unaffected. `dek`, `area`, `areaLabel`, `column`, `authorTitle`, `church`, `image`, `imageAlt` and `photoCredit` appear only when the story has them. `FeedItem` in `src/lib/feed.ts` is the definitive list. All links and photo addresses are absolute, so they work inside an email.

`/stories.json` is the public feed of live stories. IMConnected Studio's "Import from IMConnected" button reads the authenticated, CORS-enabled `GET /api/stories` (see [Story list for Studio](STUDIO-API.md#story-list-for-studio)), which additionally includes drafts still waiting for an editor, so no proxy header is needed. Both lists read the database and reflect story changes without a build. See [STUDIO-IMPORT.md](STUDIO-IMPORT.md) for the newsletter builder plan.

### Nightly backups to Google Drive

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


## Upgrading an older server to database publishing (one time)

This applies only to a server that still runs a version from before stories moved into the database (epic #25). A server already on database publishing skips it.

Do this once, on the server that still publishes through git (steps 1 to 3 of epic #25):

1. **Stop publishing on the old server first.** Nobody uses the dashboard's Publish or Unpublish, and Studio does not publish, from now until the new version is live and checked. An unpublish or publish made on the old version after the new image was built is not in that image, and the one-time adoption can only settle what it can see.
2. **Back up first.** Download `/data/imconnected.db` from the backups page (or use last night's Google Drive backup) and keep the `media` folder with it. After this change the database and `DATA_DIR/media` are the only copy of the stories.
3. **Merge** the change and **wait for the image** to finish building (the Action's "Build & publish image" run).
4. **Deploy** it (`docker compose pull && docker compose up -d`, or the `deploy` branch as usual).
5. **Check the server log** (`docker compose logs imconnected`) for `[stories] adopting the build: ...` followed by `the database is now the source of truth; the build is not read for content any more`. If you see `could not be adopted` lines instead, the site is still served from the table (nothing is lost); the next restart tries again, and the log names the story that failed.
6. **Look for hand-committed stories.** If anyone committed story files to git after the image was built, run `scripts/import-git-stories.mjs` as a dry run (see [Stories in the database](STORAGE.md)), then with `--apply` if it lists anything.
7. **Clean up.** `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH`, `GITHUB_PR_LABEL` and `SUBMISSIONS_TO` can now be removed from `.env`.

The Docker health check requests `/`, which reads the database, so a database outage shows the container as unhealthy on purpose; its 90-second start period covers the first start on a brand new database, where the first request waits (up to 60 s) for the adoption.

