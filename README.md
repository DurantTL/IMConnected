# IMConnected

A story magazine for the Iowa-Missouri Conference of Seventh-day Adventists. The design follows the layout of a union magazine site: News, Features, Columns, Youth & Pathfinders and Kids sections, plus a public **Submit a Story** form. Each submission lands as a draft in the editor dashboard at `/admin`, where an editor edits and publishes it.

- **Astro 7**: every page is prerendered to static HTML, so the site is fast and works well for search engines. The server code is `/api/submit`, `/api/publish`, `/api/confirm`, `/api/stories` and `/api/studio-photo` (for Studio), `/media/*` (photos from the data folder), and the editor dashboard (`/admin*` and `/api/admin/*`).
- **Stories are Markdown files** in `src/content/stories/`. Accounts, sessions, drafts and the audit log for the editor dashboard live in a small SQLite file (see Editor dashboard). Git is still the source of truth for stories; until step 4 of epic #25 the same SQLite file only holds a mirror of them (see Stories in the database).
- **Docker image**: on every push to `main`, an image is built and pushed to `ghcr.io/<owner>/imconnected`.
- **Pagefind** builds a site search index at build time, so search needs no server.
- **Pages CMS** (optional) gives editors a web form for stories, so they don't have to edit files on GitHub.

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
                      Publish = a commit to main (story .md + photos)
                                         ▼
          GitHub Action builds a new image ──► server pulls it ──► story is live
```

Submissions no longer create pull requests: they appear under `/admin`. If the dashboard database can't be opened, `/api/submit` answers 503 ("Submissions are temporarily unavailable. Please email us your story.") instead of losing the story. Setting `SUBMISSIONS_TO=github` brings back the old behavior (a pull request per submission, merged by a person) for one release; it will be removed in a follow-up.

## Setup

### 1. Create the repo

```bash
git remote add origin git@github.com:DurantTL/imconnected.git
git push -u origin main
```

> **Make the repo private** if you ever use `SUBMISSIONS_TO=github`: pull request descriptions then contain the submitter's email address and phone number. With the default dashboard flow, contact details live only in the database. The Docker image can still be public.

Only if you use `SUBMISSIONS_TO=github`, also create a label named **`story-submission`** (Issues → Labels).

### 2. Create a token for publishing

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token:

- **Repository access:** only this repo
- **Permissions:** *Contents*: Read and write (publishing from `/admin` and Studio commits to `main`). *Pull requests*: Read and write is needed only for `SUBMISSIONS_TO=github`.

### 3. Image builds

The Action at `.github/workflows/docker.yml` builds the image and pushes it to GHCR. There's nothing to configure. To set the canonical URL, add a repository **variable** `SITE_URL` (Settings → Secrets and variables → Actions → Variables). Otherwise it defaults to `https://stories.imadventist.org`.

If the GHCR package is private, run `docker login ghcr.io` on the server first, using a token with `read:packages`.

### 4. Run it on the server

```bash
cp .env.example .env      # fill in GITHUB_TOKEN, GITHUB_REPO, SITE_URL, etc.
docker compose up -d
```

The container listens on port **4321**. Put it behind your reverse proxy (Nginx Proxy Manager, Cloudflare Tunnel, Traefik…). Set `TRUST_PROXY` so the rate limiters see real visitor IPs: `cloudflare` when the site is behind Cloudflare's proxy (it trusts `CF-Connecting-IP`), `true` for a single reverse proxy such as xCloud's nginx (it trusts the last `X-Forwarded-For` entry, the one your proxy added). If it is unset behind a proxy, every visitor shares the proxy's IP, so the submit, publish and sign-in rate limits and lockouts are shared by everyone. Never set either value when the app is reachable directly, because visitors could then forge their IP. That includes `cloudflare` mode when your server can also be reached by its own IP address: anyone hitting the server directly can send a fake `CF-Connecting-IP`. Use `cloudflare` only if direct traffic is blocked: firewall the server to Cloudflare's IP ranges, use a Cloudflare Tunnel, or have nginx set the real IP from Cloudflare's ranges (`set_real_ip_from`).

**Updating after a merge:** the server never builds the site; it only pulls the finished image. After each merge to `main`, the Action builds and publishes the image, then moves the **`deploy`** branch to that commit. Point your host's git auto-deploy (xCloud) at the `deploy` branch, not `main`, with this deploy command:

```bash
docker compose pull && docker compose up -d
```

Watching `main` instead would start the deploy about two minutes before the new image exists, and the server would pull the previous version. To update by hand, run the same command. If the Action's `deploy` job fails, the server stays on the previous version until the next merge; re-run the newest "Build & publish image" run from the Actions tab (older runs skip publishing on purpose).

The site address defaults to `https://stories.imadventist.org`. If you set `SITE_URL` anywhere (the server's `.env` or the repository variable), it overrides that default, so keep both on the current domain.

### 5. (Optional) Editor-friendly CMS

Go to [app.pagescms.org](https://app.pagescms.org), sign in with GitHub and open this repo. `.pages.yml` already defines the story fields. Editors can switch to a submission branch to edit a pending story before merging.

### 6. Story feeds

Every build publishes the 50 newest published stories in two formats:

- **`/rss.xml`**: RSS 2.0 for feed readers and services that import RSS.
- **`/stories.json`**: for the IMConnected Studio newsletter builder. Every story has `id`, `url`, `title`, `section`, `sectionLabel`, `author`, `date` (YYYY-MM-DD), `photos`, `photoAlts` (alt text for each photo in `photos`, same order; entries may be empty) and `featured`. `dek`, `area`, `areaLabel`, `column`, `authorTitle`, `church`, `image`, `imageAlt` and `photoCredit` appear only when the story has them. `FeedItem` in `src/lib/feed.ts` is the definitive list. All links and photo addresses are absolute, so they work inside an email.

`/stories.json` is the public feed and is only the last build. IMConnected Studio's "Import from IMConnected" button doesn't use it: it reads the authenticated, CORS-enabled `GET /api/stories` (see "Story list for Studio" below), which also sees stories published since the last build and the drafts still waiting for an editor, so no proxy header is needed. See `docs/STUDIO-IMPORT.md` for the newsletter builder plan.

## Publishing from IMConnected Studio

The communication director builds each newsletter in IMConnected Studio. Clicking **Publish to IMConnected** sends the ticked stories to `POST /api/publish`, which commits them straight to `main` with no pull request. Studio then uses the returned story URLs in the email's "Read full story" buttons. Studio publishes are also recorded in the dashboard (a published draft with source Studio, credited to "IMConnected Studio" through a `published_via_studio` flag that a later dashboard publish clears; publishing the same story again updates that row). If an editor's draft for the same story is still new or in review, Studio never touches its text, status or photos: the draft only gets the live markers, an audit entry `draft.studio_overwrote_live`, and a notice on the draft ("IMConnected Studio published over this story on <date>; your saved edits here are not live."; migration 006). A closed linked draft (published or rejected) is updated in place (a rejected draft's uploaded photos are replaced and their files deleted), so `/admin` shows the full history. If the database is unavailable the publish still succeeds.

**Setup**

1. Generate a secret of 32+ random characters (`openssl rand -hex 32`) and set it as `PUBLISH_TOKEN` in the server's `.env`. Enter the same value in Studio. Without a token of at least 32 characters, every call returns 503.
2. Set `PUBLISH_ORIGINS` to the browser origins allowed to call the API (default `https://tools.imsda.org`).
3. The existing `GITHUB_TOKEN` is reused. It needs **Contents: Read and write**, and it must be allowed to push to `main` (not blocked by branch protection).

**API** (JSON, `Authorization: Bearer <PUBLISH_TOKEN>`)

- `GET /api/publish` returns `{ok, site, sections}` for a connection test and the section list.
- `POST /api/publish` takes `{newsletter:{name,issueDate}, stories:[{ref,title,section,area,author,dek,body,quote,attribution,photos:[{url,alt,caption}]}]}` (1-12 stories, up to 6 photos each, 40 MB total). Each photo's `alt` is published (the first as `imageAlt`, the rest as `photoAlts`). Photos are `https://` links (stored as-is, never downloaded) or `data:` JPG/PNG/WebP images (committed under `public/images/stories/<slug>/`).
- Slugs are `<issueDate>-<title>`, so publishing the same issue again updates its stories (`status: "updated"`) instead of duplicating them. If any story is invalid the response is `400` with a `ref` and nothing is written.
- Publishing the same newsletter again overwrites those stories on the site, including any edits made to them on GitHub and their `featured` setting.
- All text goes through the same escaping as the submit form. Never HTML.

**Timing:** a story is live about 3-5 minutes after publishing, once the image builds and xCloud deploys. The URL returned by the API works from then on.

**Testing locally:** run `node scripts/mock-github.mjs` and the server with `GITHUB_API_URL=http://localhost:4010`, `GITHUB_TOKEN=x`, `GITHUB_REPO=mock/repo`, a made-up `PUBLISH_TOKEN`, then `curl` the endpoint. Commits land in `.mock-prs/direct/<commit>/`. Never point tests at the real site.

### Story list for Studio

`GET /api/stories?limit=50&section=<key>` is what Studio's **Import from IMConnected** button reads. It uses the same bearer token and the same CORS rules as `/api/publish`: `Authorization: Bearer <PUBLISH_TOKEN>`, and only origins in `PUBLISH_ORIGINS` get CORS headers (the `OPTIONS` preflight included; other origins get none). 503 when `PUBLISH_TOKEN` is unset or short, 401 when wrong, 120 requests per IP per hour. `limit` is 1-100 (default 50); an unknown `section` is a 400.

```json
{ "ok": true, "version": 1, "site": "https://stories.imadventist.org/", "generated": "…",
  "stories": [ { "id": "…", "url": "…", "title": "…", "…": "every /stories.json field", "status": "published", "source": "site", "excerpt": "…" } ],
  "drafts":  [ { "id": 12, "status": "new", "source": "agent", "title": "…", "…": "the same fields, no url", "excerpt": "…" } ] }
```

- **`stories`** are the live stories, newest first, each with exactly the `/stories.json` fields (`feedItem` in `src/lib/feed.ts`) plus `status: "published"` and `source` (`site` for a story that came from git, otherwise the dashboard draft's source: `form`, `studio`, `editor` or `agent`). Nothing is renamed, so `/stories.json` stays the public contract.
- **`excerpt`** (on every story and draft, Studio list only; `/stories.json` and `/rss.xml` are unchanged) is the body's first non-empty paragraph as plain text: Markdown headings, emphasis, blockquote markers and images removed, link text kept, HTML entities decoded (`&lt;` becomes `<`), whitespace collapsed, at most 400 characters cut at a word boundary with `…`. It is an empty string when there is no body. Studio treats it as text, never as HTML (`src/lib/excerpt.ts`).
- **How "live" is read.** The built content collection is the base (the same data the site was built from), minus stories an editor unpublished, with the dashboard's `published` drafts laid over it. That's how `/admin/published` works too, and it means a story published a minute ago is in the list even though the site hasn't rebuilt yet. It needs no GitHub call, so it also works when GitHub is down. A draft that is being edited again keeps its live text (the built copy), never its unpublished edits. The one thing it can't see is a story committed straight to git by hand that hasn't been deployed yet.
- **`drafts`** are the 20 newest `new` and `in_review` drafts (the same item shape, `id` is the draft id, no `url` because they aren't live), so Studio can show "not published yet". Only whitelisted fields are copied: a submitter's name, email, phone and church are never included, and neither are the agent's note or source link. A draft gets an `image` only when its lead photo is a file the site serves without a login (an `/images/...` path); photos uploaded to a draft live outside `public/` and are only served to signed-in editors, so they are left out.

#### Photo bytes for Studio

`GET /api/studio-photo?src=<url>` returns a story photo so Studio can upload it to the WordPress media library (browsers can't read the static photo files, which have no CORS headers). Studio copies only the lead photo of the stories the director ticks, so the limit of 300 requests per IP per hour is ample. Same bearer token (`PUBLISH_TOKEN`) and CORS rules as `/api/stories` (503 unconfigured, 401 wrong token, `OPTIONS` preflight 204, other methods 405; 429 over the limit). `src` is one of the photo URLs `/api/stories` returns (`image` or an entry of `photos`): an absolute URL on the site's own origin (`SITE_URL`) or a root-relative path, and only `/images/stories/<slug>/<file>` (the built static copy in `dist/client`) or `/media/stories/<slug>/<file>` (`DATA_DIR/media`), with plain `[A-Za-z0-9._-]` names and a `.jpg`, `.jpeg`, `.png` or `.webp` extension. The file must be a regular file inside those folders (a symlink in the built `images/stories` folder is refused; for `/media` the real path must stay inside the media folder, same rule as `GET /media/*`) and its bytes must be a JPEG, PNG or WebP no larger than the photo size limit. Refusals are `404 {"ok": false, "error": "Photo not found."}`. One refusal is distinguishable: a well-formed `/images/stories/...` path whose file isn't in the build yet (a story published since the last build, whose photo is in git but not yet in the image) is `404` with `"code": "not_built"` and an error telling Studio to try again after the site updates (about 3-5 minutes). A draft's uploaded photos are served only to signed-in editors and can't be reached here. The 200 carries the sniffed `Content-Type`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## AI agent API

The communication director's AI agent finds stories on the conference's Facebook pages and writes them up. It sends them here; **they always land as drafts for a person to review and are never published by the agent.**

**Setup:** set `AGENT_API_TOKEN` in `.env` (32+ random characters, `openssl rand -hex 32`, a different value from `PUBLISH_TOKEN`). Unset or short, the API answers 503. It is machine-to-machine: no CORS headers, no cookies, and nothing under `/api/admin`. Rate limit: 60 requests per hour per token (`429` with `Retry-After`).

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
    "author": "<byline>", "church": "<optional>",
    "date": "2026-10-19",
    "sourceUrl": "https://www.facebook.com/<page>/posts/<id>",
    "note": "<optional note to the editors, e.g. why you picked it>",
    "photos": [ { "data": "data:image/jpeg;base64,<...>", "alt": "<describe the photo>" } ]
  }'
# 201 {"ok":true,"id":12,"status":"created","url":"https://<your-site>/admin/drafts/12"}
```

- **Fields.** `title` and `body` are required. `section` may be left out (the editor picks it); if sent it must exist, and `area` must belong to it. `date` is `YYYY-MM-DD` (default today). `body` is Markdown; every `<` is written as `&lt;` and control characters are removed from every text field, like a dashboard draft. `sourceUrl` must be an `http(s)` link. Up to 6 photos.
- **Photos are `data:` URLs only** (JPG, PNG or WebP by file signature, 10 MB each). The site never downloads a remote link (Facebook CDN links expire, and fetching them would be an SSRF risk), so a URL is a `400`. They are stored under `DATA_DIR/uploads`, served only to signed-in editors.
- **Idempotent by `sourceUrl`.** Posting the same `sourceUrl` again updates that draft (a re-post without `photos` keeps its photos; one with `photos` replaces them) but only while it is still `new` and no editor has touched it. After that it answers `409 {"ok":false,"error":"already_reviewed","id":12}` and changes nothing. It never makes a second draft. Re-posts don't email the editors again.
- **Errors** are `400 {"ok":false,"error":"<code>","message":"…"}` (for example `title_required`, `bad_section`, `bad_area`, `photo_remote_url`, `photo_too_large`, `photo_not_image`, `too_many_photos`, `bad_source_url`, `invalid_json`, `too_large`), `401` for a wrong or missing token, `429` over the limit.
- **In the dashboard** the draft has source `agent`: a "From AI agent" badge, the agent's note and a "View original post" link (http(s) only, `rel="noopener noreferrer"`) in the submitter panel, and a "Source: AI agent" filter in the inbox. The editors who have "Email me when a story is submitted" on get the usual email, which says it is from the AI agent. The audit log gets an `agent.story` entry (draft id only), and server logs carry only the draft id.
- **What the agent can't do.** Publish, reject, or change any draft an editor has touched, or reach any `/api/admin` route. Publishing stays a person's action in `/admin`.
- **Tests.** `npm run build`, then `SCRATCH=/tmp/imc-agent node scripts/test-agent-api.mjs` starts the mocks and four copies of the built server itself and checks the agent API, migration 010 on a database that already has drafts and photos, and `/api/stories`. Use made-up tokens; never call the real site.

## Stories in the database (in progress)

Epic #25 moves published stories and their photos from git into the site's SQLite database so that publishing no longer needs a build and deploy. **Step 1 (this change) only adds the tables; nothing changes for readers or editors yet, and git is still the source of truth.**

- **Tables** (migration `011_stories.sql`, STRICT): `stories` has every field of the content schema (`src/content.config.ts`) plus the body, `slug` (unique), `status` (`live` or `unpublished`), `source`, `draft_id`, `published_at`, `updated_at` and `published_by`; `story_photos` has one row per photo (position, path or url, alt text, sha256). `src/lib/story-store.ts` has typed, synchronous functions: `getStoryBySlug`, `listStories` (section, area, featured, paging), `listRecent`, `listBySection`, `listFeatured`, `countStories`, `upsertStory` and `unpublishStory`.
- **Mirror of the build.** `src/lib/story-sync.ts` imports every built story into `stories` (`source = 'git'`) and copies its photos from the build into `DATA_DIR/media/stories/<slug>/<sha256>.<ext>`. `getDb()` and `/media` call it on every use, which is a cheap check once it has finished, so it starts on the first database open or first `/media` request after a start. The stories come from the content collection that Astro bakes into the server bundle, so this works in the Docker image, where the Markdown files are not present. It runs in the background and never throws into a request. Photos are read with async streams and the sync yields between stories; all file reading and hashing for a story happens before its database write, and each story is written in its own short transaction, so the write lock is never held during file I/O. A photo is reused without being read only when its source path, its size (`story_photos.bytes`) and its media file are unchanged and the build marker (`DATA_DIR/media/.build-marker`, a hash of the built data chunk and of the path, size and mtime of exactly the built files the stories reference, wherever they live under `/images`) is the same as at the last fully successful pass; after a new build each size-matching photo is hashed read-only and copied only if its bytes changed, so a same-size replacement is picked up; an unchanged story isn't rewritten. If a story fails or the pass throws, it is retried after about a minute, at most 5 passes per process. Stories unpublished in the dashboard, or no longer in the build, are marked `unpublished`. This is temporary: step 4 makes the database the source of truth and removes the sync. `draft_id` and `published_by` on `stories` are plain columns (no foreign keys) that the code checks.
- **`GET /media/<path>`** serves those photos (jpg, png and webp only) with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. Paths with `..`, encoded dots or slashes, backslashes or an absolute form return 404, and so does anything that is not an image inside `DATA_DIR/media`.
- **Tests.** `npm run build`, then `SCRATCH=/tmp/imc-story-store node scripts/test-story-store.mjs` checks migration 011 on a database that already has drafts and accounts, that every built story is mirrored with identical fields, that photos are served with the right type and cache headers, that a second start changes nothing, and that traversal attempts return 404.

## Reviewing submissions

1. Sign in at `/admin`. The **Drafts** link shows a count of new and in-review drafts, and the top of the inbox lists the 5 newest drafts and the 5 newest published stories.
2. Open a draft. The editor-only panel shows who sent the story, their contact details and whether they confirmed their email (a "verified" badge appears in the inbox too).
3. Edit it in the browser: headline, summary (`dek`), Markdown body, photos and alt text, and **Featured** to put it at the top of the home page. Submitted text is plain text with HTML escaped; add Markdown formatting (headings, quotes, links) during review.
4. **Publish** commits it to `main`, or **Reject** declines it. Only a person does either.

Each editor can turn "Email me when a story is submitted" on or off under **My account** (on by default). The email holds only the story title and church, with a link to the draft.

## Writing stories directly

Add a file to `src/content/stories/`:

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
image: /images/stories/my-story/photo-1.jpg   # file lives in public/images/stories/...
imageAlt: "Caption"
photoCredit: "Photographer"
photos: []               # extra gallery images
photoAlts: []            # alt text for each of `photos`, same order (optional)
featured: false
draft: false             # true hides it
---

Story text in Markdown…
```

**Before launch:** delete the `sample-*.md` files and edit `welcome-to-imconnected.md`.

## Customizing

| What | Where |
|---|---|
| Site name, tagline, contact email, sections and categories | `src/lib/site.ts` |
| Colors, fonts, spacing | `:root` tokens at the top of `src/styles/global.css` |
| Home page layout | `src/pages/index.astro` |
| Form fields and limits | `src/pages/submit/index.astro`, `src/lib/limits.ts`, `src/lib/submission.ts` |
| CMS fields | `.pages.yml` (keep it in sync with `src/content.config.ts`) |

If you add a section or category, update `site.ts`, the `area` options in `.pages.yml`, and the `area` comment above.

## Local development

```bash
npm install
npm run dev                # http://localhost:4321  (search only works after a build)
npm run build && npm start # production build + server
```

To test the old pull-request path without a real repo (set `SUBMISSIONS_TO=github`; the default dashboard mode makes no GitHub call), and Studio publishes:

```bash
node scripts/mock-github.mjs &                  # fake GitHub API on :4010
SUBMISSIONS_TO=github GITHUB_TOKEN=x GITHUB_REPO=test/test GITHUB_API_URL=http://localhost:4010 npm start
# submissions are written to ./.mock-prs/<branch>/, publishes to ./.mock-prs/direct/<commit>/
```

For the dashboard flow, run the server with a throwaway `DATA_DIR` and `AUTH_SECRET`, and `scripts/mock-email.mjs` (it also answers `/emails/batch`, and `GET /rate-limit-once` makes the next batch return 429) with `EMAIL_API_URL` to see the emails; `scripts/test-editor-submissions.mjs` does all of this for you.

## Editor dashboard

Editors sign in at `/admin` with email + password and a required second factor (invite-only; passkeys, Google and Microsoft arrive over the epic in issue #7). The pages are server-rendered, `noindex`, and never cached.

- **Data volume.** Accounts, sessions and the audit log are in `imconnected.db` inside `DATA_DIR` (`/data` in Docker, `./data` in development). The compose file mounts the named volume `imconnected-data` there. Add that volume to your backups; stories themselves are safe in git. Migrations in `src/lib/db/migrations/` apply automatically, once each, the first time `/admin` is used. If the database can't be opened, `/admin` answers 503 (and logs a line) and `/api/submit` answers 503 with "Submissions are temporarily unavailable. Please email us your story."; the public pages keep working, and Studio publishes still go live. `node scripts/migrate.mjs` applies them by hand. A bind mount instead of the named volume must be owned by uid 1000 (the `node` user).
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
- Photos are checked by file signature (JPG, PNG or WebP only), up to 6 photos at 10 MB each. The browser shrinks photos to a 2000 px long edge before upload, which keeps the repo small.
- Spam protection: a hidden honeypot field, a minimum time to fill out the form, an Origin check, a per-IP hourly limit (`SUBMIT_RATE_LIMIT`), Cloudflare Turnstile, email domain checks and a confirmation email (see below).
- Submitter email addresses and phone numbers live only in the dashboard database and the editor-only submitter panel (and, with `SUBMISSIONS_TO=github`, in the pull request description). They are never logged, never in story files or commits, and never in the editor notification emails.
- The GitHub token never reaches the browser and can only touch this one repo.
- Photos are stored in git. Over a few years that's fine. If the repo eventually gets large, move `public/images` to object storage (R2/S3) and store URLs instead.

### Drafts inbox and story editor

- **`/admin`** is the drafts inbox (new and in-review drafts, newest first; filter by status and section; "New story" starts an editor draft). `/admin/drafts/<id>` is the editor: story fields, a Markdown body with a toolbar and a preview rendered on the server with the site's own Markdown processor, photos (upload, reorder, lead image, alt text, delete; the lead photo's alt text becomes `imageAlt`, the others go to `photoAlts`), autosave every 20 seconds, and a submitter panel (name, email, phone, church, verified) for signed-in editors only. `/admin/published` lists live stories with Edit (loads the current `.md` from `main` into a draft linked to its slug) and Unpublish (commits `draft: true`).
- **Publishing** checks the draft against the content schema, builds the same `.md` and photo files as `/api/publish` (shared code in `src/lib/storyfile.ts`), and commits to `main` with the message `Publish "<title>" (edited by <editor>)`. It needs `GITHUB_TOKEN` and `GITHUB_REPO` like the submit form. The story is live after the site rebuilds (about 3-5 minutes). Publishing a draft that is linked to a live story overwrites the same slug.
- **Safety.** Raw HTML is never committed: every `<` in the body is written as `&lt;` (also in code), and `<` and `>` in frontmatter text are written as the YAML escapes `\u003c` and `\u003e`. Links must be http(s), mailto or tel. The preview is shown in a sandboxed frame with no scripts. Uploaded photos live in `DATA_DIR/uploads/<draft>/` under random names (type sniffed, never under `public/`) and are served only to signed-in editors by `/api/admin/photos/<id>`. Photos of rejected drafts are deleted 30 days after rejection (the cleanup runs when the inbox opens, at most once a day). Two editors saving the same draft: the later, stale save is refused ("reload to see changes"). Publishing locks the draft and reserves the slug before the commit, so edits made while it runs are not lost silently; the editor is told if newer edits are not live yet. After a publish the uploaded files are deleted (the photos are in the repo). Submitter contact details are never logged, audited or committed.
- **Editor accounts and the audit log (administrators).** `/admin/editors` lists everyone (name, email, role, status, two-step methods, last sign-in). An administrator can invite someone (name, email, role), re-send an invite (the old link stops working), change a role, disable or re-enable an account, and reset someone's two-step sign-in. Invites last 7 days; with Resend configured (`RESEND_API_KEY`, `EMAIL_FROM`) the email holds only the inviter's name, the site name and the link, otherwise the link is shown once with a copy button. Disabling signs the person out of every session at once. The last active administrator can be neither demoted nor disabled (checked inside a transaction). Resetting two-step sign-in shares its code with `scripts/reset-2fa.mjs` and forces enrollment at the next sign-in. Each of these needs a second factor proved in the last 10 minutes (sign-in 2FA counts; otherwise the form asks for an authenticator or recovery code, or a passkey). `/admin/audit` is a paginated log filterable by person and action. Editors see the list read-only, names only, and get 403 on the audit log and every account action. Audit entries older than 2 years and expired sessions, passkey challenges and invites are deleted at the first admin request after a start and then once a day. Tests: `npm run build`, then `DATA_DIR=/tmp/imc-accounts node scripts/test-editor-accounts.mjs` (it starts the built server and the mock email API itself).
- **Tests.** With the mock GitHub API running, `scripts/test-editor-drafts.mjs` covers all of this (see the header of the script for the commands).

### Submissions and Studio in the dashboard

- **`SUBMISSIONS_TO`** is `dashboard` (the default) or `github` (the old pull-request path, kept for one release). In dashboard mode `/api/submit` needs no GitHub settings. It keeps every check (Origin, honeypot, minimum fill time, rate limit, email checks, Turnstile, photo signatures) and then creates a `drafts` row (source `form`, status `new`) with its photos in `DATA_DIR/uploads`.
- **Confirmation links** sign the draft id (`d:<id>`). Confirming sets `email_verified` on the draft. Links from emails sent while submissions were pull requests are still accepted (they label that PR) as long as `GITHUB_TOKEN` and `GITHUB_REPO` are set; otherwise they answer "This link isn't valid."
- **Editor notifications** go through the same Resend settings as the confirmation email (`RESEND_API_KEY`, `EMAIL_FROM`): one email per active editor who has the setting on (a single request to Resend's batch endpoint, `EMAIL_API_URL` + `/batch`, one message per recipient and no BCC; a 429 is retried once after `retry-after`, at most 5 s), subject "New story submission: <title>", a link to `/admin/drafts/<id>`, and only the escaped title and church in the body. The emails and the Discord ping are sent in the background after the response, so the visitor never waits on them; a failure is logged (counts only) and never fails the submission. The optional Discord ping (`DISCORD_WEBHOOK_URL`) carries the title, church and dashboard link only, with Discord Markdown in the title and church escaped.
- **Tests.** `npm run build`, then `SCRATCH=/tmp/imc-e2e node scripts/test-editor-submissions.mjs` starts the mocks and three copies of the built server itself (see the header) and checks all of the above, including Studio publishes and the database-unavailable behavior.
