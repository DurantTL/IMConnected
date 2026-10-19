# IMConnected

A story magazine for the Iowa-Missouri Conference of Seventh-day Adventists. The design follows the layout of a union magazine site: News, Features, Columns, Youth & Pathfinders and Kids sections, plus a public **Submit a Story** form. Each submission becomes a GitHub pull request, and merging the pull request publishes the story.

- **Astro 7**: every page is prerendered to static HTML, so the site is fast and works well for search engines. The only server code is `/api/submit`, `/api/publish` and `/api/confirm`.
- **Stories are Markdown files** in `src/content/stories/`. There's no database.
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

## Spam protection: Turnstile, email checks and confirmation

**Cloudflare Turnstile.**
1. In the Cloudflare dashboard open Turnstile and add a widget for the site's hostname (managed mode).
2. Set the **secret key** as `TURNSTILE_SECRET_KEY` in the server's `.env`. With it unset the check is skipped (local dev); in production the server logs one warning at startup.
3. Set the **site key** as a repository **variable** `PUBLIC_TURNSTILE_SITE_KEY` (Settings → Secrets and variables → Actions → Variables), not in `.env`. It is public and baked into the prerendered `/submit/` page at build time, so rebuild the image after changing it. When it is empty the widget isn't shown.
4. Setting `TURNSTILE_SECRET_KEY` without building the image with `PUBLIC_TURNSTILE_SITE_KEY` blocks every submission, because the form then has no widget to produce a token. Set both, or neither.
5. If Cloudflare can't be reached the form answers 503 ("Please try again in a minute"); it fails closed.

For local testing use Cloudflare's documented test keys: site key `1x00000000000000000000AA` (always passes) with secret `1x0000000000000000000000000000000AA`, and secret `2x0000000000000000000000000000000AA` (always fails). `TURNSTILE_VERIFY_URL` can point at a local stand-in if the network is blocked.

**Email domain checks** run before anything reaches GitHub. Domains on `src/lib/disposable-domains.txt` (and their subdomains) are refused, as are domains with no MX, A or AAAA record. A DNS timeout or server failure lets the submission through, so a DNS hiccup never loses a story. Add a line to the text file to block another domain.

**Confirmation email** (sent through Resend's HTTP API; no SDK).
1. Create a Resend account, add the sending domain and add the DNS records Resend shows until the domain reads **Verified**.
2. In `.env` set `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `IMConnected <stories@imadventist.org>`), optionally `EMAIL_REPLY_TO` (default `communication@imsda.org`), and `EMAIL_CONFIRM_SECRET` (`openssl rand -hex 32`, 32+ characters).
3. Without `RESEND_API_KEY` or a long enough secret, nothing is sent and the PR body says so.

Every submission PR is labelled `email-unverified` and its description has an **Email status** row (`confirmation sent`, or `not sent: <reason>`). The PR is created right away either way. When the submitter presses **Confirm** on the link in the email (valid 14 days; the button, not the link itself, confirms, so mail scanners can't do it), the label changes to `email-verified`. Editors can filter the PR list by these labels; an unverified story may still be good, so it is a signal, not a gate. The email address is never logged.

**Testing the email flow locally:** run the mock GitHub API (`node scripts/mock-github.mjs`), the mock Resend endpoint (`node scripts/mock-email.mjs`, port 4011, prints each message as one JSON line; `GET /fail-on` makes it answer 500, `GET /fail-off` restores it), and start the app with `EMAIL_API_URL=http://localhost:4011/emails`, `RESEND_API_KEY=test`, `EMAIL_FROM=test@example.com`, a made-up `EMAIL_CONFIRM_SECRET`. Never send real email from a test.

## Security and spam notes

- Story text has HTML escaped and link syntax neutralized, because Astro renders raw HTML in `.md` files.
- Photos are checked by file signature (JPG, PNG or WebP only), up to 6 photos at 10 MB each. The browser shrinks photos to a 2000 px long edge before upload, which keeps the repo small.
- Spam protection: a hidden honeypot field, a minimum time to fill out the form, an Origin check, a per-IP hourly limit (`SUBMIT_RATE_LIMIT`), Cloudflare Turnstile, email domain checks and a confirmation email (see below).
- Submitter email addresses appear only in the PR description. They are never logged.
- The GitHub token never reaches the browser and can only touch this one repo.
- Photos are stored in git. Over a few years that's fine. If the repo eventually gets large, move `public/images` to object storage (R2/S3) and store URLs instead.
