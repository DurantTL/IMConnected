# IMConnected

A story magazine for the Iowa-Missouri Conference of Seventh-day Adventists. The design follows the layout of a union magazine site: News, Features, Columns, Youth & Pathfinders and Kids sections, plus a public **Submit a Story** form. Each submission becomes a GitHub pull request, and merging the pull request publishes the story.

- **Astro 7**: every page is prerendered to static HTML, so the site is fast and works well for search engines. The only server code is `/api/submit`.
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

The Action at `.github/workflows/docker.yml` builds the image and pushes it to GHCR. There's nothing to configure. To set the canonical URL, add a repository **variable** `SITE_URL` (Settings → Secrets and variables → Actions → Variables). Otherwise it defaults to `https://stories.imsda.org`.

If the GHCR package is private, run `docker login ghcr.io` on the server first, using a token with `read:packages`.

### 4. Run it on the server

```bash
cp .env.example .env      # fill in GITHUB_TOKEN, GITHUB_REPO, SITE_URL, etc.
docker compose up -d
```

The container listens on port **4321**. Put it behind your reverse proxy (Nginx Proxy Manager, Cloudflare Tunnel, Traefik…). Set `TRUST_PROXY=true` so the rate limiter sees real visitor IPs.

**Updating after a merge:** run `docker compose pull && docker compose up -d`, or let an image auto-updater you already run on that host handle it.

### 5. (Optional) Editor-friendly CMS

Go to [app.pagescms.org](https://app.pagescms.org), sign in with GitHub and open this repo. `.pages.yml` already defines the story fields. Editors can switch to a submission branch to edit a pending story before merging.

### 6. Story feeds

Every build publishes the 50 newest published stories in two formats:

- **`/rss.xml`**: RSS 2.0 for feed readers and services that import RSS.
- **`/stories.json`**: for the IMConnected Studio newsletter builder. Each story has `title`, `dek`, `section`/`sectionLabel`, `area`/`areaLabel`, `author`, `church`, `date`, `url`, `image`, `imageAlt` and `photos`. All links and photo addresses are absolute, so they work inside an email.

For a newsletter tool on another domain to fetch `/stories.json` directly in the browser, your reverse proxy has to add `Access-Control-Allow-Origin: https://tools.imsda.org` to that path. The site's container doesn't set the header itself. See `docs/STUDIO-IMPORT.md` for the newsletter builder plan.

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

## Security and spam notes

- Story text has HTML escaped and link syntax neutralized, because Astro renders raw HTML in `.md` files.
- Photos are checked by file signature (JPG, PNG or WebP only), up to 6 photos at 10 MB each. The browser shrinks photos to a 2000 px long edge before upload, which keeps the repo small.
- Spam protection: a hidden honeypot field, a minimum time to fill out the form, an Origin check and a per-IP hourly limit (`SUBMIT_RATE_LIMIT`). If spam becomes a problem, Cloudflare Turnstile is the next thing to add.
- The GitHub token never reaches the browser and can only touch this one repo.
- Photos are stored in git. Over a few years that's fine. If the repo eventually gets large, move `public/images` to object storage (R2/S3) and store URLs instead.
