# IMConnected

A story magazine for the Iowa-Missouri Conference of Seventh-day Adventists. The design follows the layout of a union magazine site: News, Features, Columns, Youth & Pathfinders and Kids sections, plus a public **Submit a Story** form. Each submission becomes a GitHub pull request, and merging the pull request publishes the story.

- **Astro 7**: every page is prerendered to static HTML, so the site is fast and works well for search engines. The server code is `/api/submit`, `/api/publish`, `/api/confirm`, and the editor dashboard (`/admin*` and `/api/admin/*`).
- **Stories are Markdown files** in `src/content/stories/`. Accounts, sessions, drafts and the audit log for the editor dashboard live in a small SQLite file (see Editor dashboard); stories never do.
- **Docker image**: on every push to `main`, an image is built and pushed to `ghcr.io/<owner>/imconnected`.
- **Pagefind** builds a site search index at build time, so search needs no server.
- **Pages CMS** (optional) gives editors a web form for stories, so they don't have to edit files on GitHub.

## How a submission flows

```
Church member ──► /submit form ──► /api/submit (in the container)
                                         │  validates input, checks photos are real images, escapes HTML,
                                         │  applies spam traps and a rate limit
                                         ▼
                           GitHub: new branch + commit + pull request
                           (story .md + photos, labeled "story-submission")
                                         │  optional Discord ping
                                         ▼
        Editor reviews and edits on the PR branch (GitHub or Pages CMS)
                                         │
                       Merge = publish   │   Close = reject
                                         ▼
          GitHub Action builds a new image ──► server pulls it ──► story is live
```

On a pull request, the Action also runs a test build. If a submission's frontmatter is broken, the PR shows a red ❌ before you merge.

## Setup

### 1. Create the repo

```bash
git remote add origin git@github.com:DurantTL/imconnected.git
git push -u origin main
```

> **Make the repo private.** Pull request descriptions contain the submitter's email address and phone number. The Docker image can still be public.

In the repo, create a label named **`story-submission`** (Issues → Labels).

### 2. Create a token for the submit form

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token:

- **Repository access:** only this repo
- **Permissions:** *Contents*: Read and write, *Pull requests*: Read and write

### 3. Image builds

The Action at `.github/workflows/docker.yml` builds the image and pushes it to GHCR. There's nothing to configure. To set the canonical URL, add a repository **variable** `SITE_URL` (Settings → Secrets and variables → Actions → Variables). Otherwise it defaults to `https://stories.imadventist.org`.

If the GHCR package is private, run `docker login ghcr.io` on the server first, using a token with `read:packages`.

### 4. Run it on the server

```bash
cp .env.example .env      # fill in GITHUB_TOKEN, GITHUB_REPO, SITE_URL, etc.
docker compose up -d
```

The container listens on port **4321**. Put it behind your reverse proxy (Nginx Proxy Manager, Cloudflare Tunnel, Traefik…). Set `TRUST_PROXY=true` so the rate limiter sees real visitor IPs.

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
- **`/stories.json`**: for the IMConnected Studio newsletter builder. Every story has `id`, `url`, `title`, `section`, `sectionLabel`, `author`, `date` (YYYY-MM-DD), `photos` and `featured`. `dek`, `area`, `areaLabel`, `column`, `authorTitle`, `church`, `image`, `imageAlt` and `photoCredit` appear only when the story has them. `FeedItem` in `src/lib/feed.ts` is the definitive list. All links and photo addresses are absolute, so they work inside an email.

For a newsletter tool on another domain to fetch `/stories.json` directly in the browser, your reverse proxy has to add `Access-Control-Allow-Origin: https://tools.imsda.org` to that path. The site's container doesn't set the header itself. See `docs/STUDIO-IMPORT.md` for the newsletter builder plan.

## Publishing from IMConnected Studio

The communication director builds each newsletter in IMConnected Studio. Clicking **Publish to IMConnected** sends the ticked stories to `POST /api/publish`, which commits them straight to `main` with no pull request. Studio then uses the returned story URLs in the email's "Read full story" buttons. Submitted-by-the-public stories still go through pull requests as above.

**Setup**

1. Generate a secret of 32+ random characters (`openssl rand -hex 32`) and set it as `PUBLISH_TOKEN` in the server's `.env`. Enter the same value in Studio. Without a token of at least 32 characters, every call returns 503.
2. Set `PUBLISH_ORIGINS` to the browser origins allowed to call the API (default `https://tools.imsda.org`).
3. The existing `GITHUB_TOKEN` is reused. It needs **Contents: Read and write**, and it must be allowed to push to `main` (not blocked by branch protection).

**API** (JSON, `Authorization: Bearer <PUBLISH_TOKEN>`)

- `GET /api/publish` returns `{ok, site, sections}` for a connection test and the section list.
- `POST /api/publish` takes `{newsletter:{name,issueDate}, stories:[{ref,title,section,area,author,dek,body,quote,attribution,photos:[{url,alt,caption}]}]}` (1-12 stories, up to 6 photos each, 40 MB total). Photos are `https://` links (stored as-is, never downloaded) or `data:` JPG/PNG/WebP images (committed under `public/images/stories/<slug>/`).
- Slugs are `<issueDate>-<title>`, so publishing the same issue again updates its stories (`status: "updated"`) instead of duplicating them. If any story is invalid the response is `400` with a `ref` and nothing is written.
- Publishing the same newsletter again overwrites those stories on the site, including any edits made to them on GitHub and their `featured` setting.
- All text goes through the same escaping as the submit form. Never HTML.

**Timing:** a story is live about 3-5 minutes after publishing, once the image builds and xCloud deploys. The URL returned by the API works from then on.

**Testing locally:** run `node scripts/mock-github.mjs` and the server with `GITHUB_API_URL=http://localhost:4010`, `GITHUB_TOKEN=x`, `GITHUB_REPO=mock/repo`, a made-up `PUBLISH_TOKEN`, then `curl` the endpoint. Commits land in `.mock-prs/direct/<commit>/`. Never point tests at the real site.

## Reviewing submissions

1. Open the repo's **Pull requests** tab and filter by the `story-submission` label.
2. The PR description shows who sent the story, their contact info, the section, word count and an editor checklist.
3. Edit the story on the PR branch: ✏️ on the file in "Files changed", Pages CMS, or locally.
   - Add a `dek` (summary), fix the headline and set `featured: true` to put it at the top of the home page.
   - Submitted text is plain text with HTML escaped. Add Markdown formatting (headings, quotes, links) during review.
4. **Merge** to publish, or **Close** to decline.

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

To test the submit form without a real repo:

```bash
node scripts/mock-github.mjs &                  # fake GitHub API on :4010
GITHUB_TOKEN=x GITHUB_REPO=test/test GITHUB_API_URL=http://localhost:4010 npm start
# submissions are written to ./.mock-prs/<branch>/
```

## Editor dashboard

Editors sign in at `/admin` with email + password and a required second factor (invite-only; passkeys, Google and Microsoft arrive over the epic in issue #7). The pages are server-rendered, `noindex`, and never cached.

- **Data volume.** Accounts, sessions and the audit log are in `imconnected.db` inside `DATA_DIR` (`/data` in Docker, `./data` in development). The compose file mounts the named volume `imconnected-data` there. Add that volume to your backups; stories themselves are safe in git. Migrations in `src/lib/db/migrations/` apply automatically, once each, the first time `/admin` is used. If the database can't be opened, only `/admin` answers 503 (and logs a line); the public pages and `/api/submit` keep working. `node scripts/migrate.mjs` applies them by hand. A bind mount instead of the named volume must be owned by uid 1000 (the `node` user).
- **First admin.** Run once on the server (the email and name are yours; the output is a 24-hour, single-use invite link at `/admin/invite/<token>`):

  ```bash
  docker compose exec imconnected node scripts/create-admin.mjs you@example.org "Your Name"
  ```

  Only a hash of the invite token is stored, so the link can't be shown again. Run the command again to get a fresh one.
- **Local testing.** `DATA_DIR=/tmp/imc-data npm start`, then `DATA_DIR=/tmp/imc-data node scripts/create-admin.mjs test@example.com "Test Admin"`. Session cookies are always `Secure`, so local sign-in needs Chrome or Firefox on `localhost` (they accept Secure cookies there). Use synthetic data and delete the folder afterwards.

### Sign-in, 2FA and recovery codes

- **`AUTH_SECRET`** (32+ random characters, in `.env`) is required. It encrypts stored authenticator secrets (AES-256-GCM) and keys the recovery-code hashes. Without it every `/admin` URL answers 503. Don't change it once editors have enrolled, or their authenticators stop working and they need new invites.
- **Accepting an invite.** The link opens "set your password" (12-256 characters, not the email address, not a common password; hashed with scrypt, N=2^15). The editor then scans a QR code (or types the key) into an authenticator app, confirms with one code, and gets **10 single-use recovery codes**, shown once; only keyed hashes are stored.
- **Signing in** is two steps: `/admin/login` (email + password), then `/admin/2fa` (6-digit code, or a recovery code). A session that hasn't finished both can only reach the 2FA pages and sign-out. Each step issues a new session id.
- **Errors and limits.** An unknown email, a wrong password and a disabled account all show "Email or password is incorrect." and cost the same time. 10 failures per IP or 5 per account in 15 minutes lock sign-in for that IP or account (the same message either way). Recovery-code use, failures, password changes and session revocations are in the audit log.
- **My account** (`/admin/account`): change password (needs the current password plus a fresh code; signs out every other session), generate new recovery codes (old ones stop working), and see or sign out active sessions.
- **Lost authenticator and recovery codes?** An administrator has to re-invite the editor (a later issue adds that screen; until then run `scripts/create-admin.mjs` for an admin, and ask the maintainer to delete the editor's `totp_credentials` row).

## Security and spam notes

- Story text has HTML escaped and link syntax neutralized, because Astro renders raw HTML in `.md` files.
- Photos are checked by file signature (JPG, PNG or WebP only), up to 6 photos at 10 MB each. The browser shrinks photos to a 2000 px long edge before upload, which keeps the repo small.
- Spam protection: a hidden honeypot field, a minimum time to fill out the form, an Origin check, a per-IP hourly limit (`SUBMIT_RATE_LIMIT`), Cloudflare Turnstile, email domain checks and a confirmation email (see below).
- Submitter email addresses appear only in the PR description. They are never logged.
- The GitHub token never reaches the browser and can only touch this one repo.
- Photos are stored in git. Over a few years that's fine. If the repo eventually gets large, move `public/images` to object storage (R2/S3) and store URLs instead.
