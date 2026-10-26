# IMConnected

**Stories of faith in action across Iowa and Missouri.**

IMConnected is the online story magazine of the Iowa-Missouri Conference of Seventh-day Adventists, at [stories.imadventist.org](https://stories.imadventist.org). Church members send in stories, the conference's AI agent proposes more from its newsletter and social media, and editors review, polish and publish everything from one dashboard. Published stories feed the IMConnected newsletter, which is built in IMConnected Studio.

Every story is reviewed by a person. Nothing reaches the public site until an editor publishes it.

---

## What it does

### For readers
- **A magazine front page** with an event spotlight, a featured story, top stories, the latest newsletter issue, section rails and a "From the archive" shelf. Administrators can change the order of these blocks and hide any of them.
- **Sections:** News (Conference, Churches, Schools, Camp), Features, Youth & Pathfinders (Youth, Pathfinders, Adventurers) and Kids. A story can appear in more than one section.
- **Announcements and events** at `/announcements/`, shown as full-size flyers with the date, location, link buttons and an optional video.
- **Newsletter issues** at `/issues/`. Each IMConnected issue gets its own page, and a story links back to the issue it first appeared in.
- **Story pages** include:
  - photo layouts (one hero, two up, hero plus grid, mosaic, stack, carousel, three up);
  - captions and a full-screen photo viewer;
  - a "Key points" box;
  - **Listen to this story**, which uses the reader's own device voice;
  - a print-friendly layout.
- **Search** across every published story, plus **RSS** (`/rss.xml`) and a **JSON feed** (`/stories.json`).
- Built mobile first and for an older audience: large readable text, 44px tap targets, and keyboard access throughout.

### For church members
- **Submit a Story** at `/submit/`. The form takes a story, an announcement or an event, with up to six photos and a caption and description for each.
- Spam is filtered by Cloudflare Turnstile, hidden traps, a minimum fill time, an Origin check and rate limits. Submitters confirm their address by email, and a confirmed submitter receives a thank-you email when their story is published.

### For editors (`/admin`)
- **Inboxes** for Stories, Announcements and Events, with status cards, search, filters and bulk actions (publish, unpublish, reject, edit fields). Every bulk action shows a confirmation page first.
- **A two-column story editor:**
  - Markdown or drag-and-drop modules: paragraphs, headings, quotes, lists, images, galleries, flyers, video, buttons and one- or two-column sections.
  - Photo cropping, zoom and fit.
  - Autosave, a private preview and the last 20 saved versions.
  - Scheduled publishing.
- **Published list** by type and section, with editing of live stories.
- **Site settings for administrators:** the home page layout, the website menu, the header and footer, newsletter issues, editor accounts, backups and the audit log.
- **Invite-only accounts**, with two-step verification required for everyone. Editors sign in with:
  - a password, or Google or Microsoft 365 (the first step);
  - an authenticator app or passkey, or a recovery code when the device is lost (the second step).

  A passkey on its own also counts as both steps.

### For the newsletter and the AI agent
- **IMConnected Studio** publishes a finished newsletter's stories to the site in one step. It also imports the story list and copies photos to WordPress.
- **The AI agent API** lets the communication director's agent send stories, announcements and backfilled archive notices. Everything it sends becomes a draft that waits for a person.

---

## How a story reaches the site

```
 Church member ──► /submit ─────────┐   validated, photos checked, HTML escaped;
                                    │   editors emailed (title, church and link)
 AI agent ──► /api/agent/stories ───┼──► Draft in the dashboard
                                    │   ("new"; "in review" for a reopened story)
 Editor ──► "New story" in /admin ──┘         │
                                              ▼
                                      An editor reviews, edits, then Publishes or Rejects
                                              │   (always a person's decision)
 IMConnected Studio ──► /api/publish ─────────┤
                                              ▼
                     One database transaction: story + photos + search entry
                                              ▼
                     Live on the very next request: no build, no deploy
```

---

## How it is built

| Part | What it uses |
| --- | --- |
| Web framework | [Astro 7](https://astro.build) with the Node adapter. Story, section, issue and home pages and the feeds are rendered on the server and cached in memory. `/submit/`, `/search/` and `/confirm/` are static. |
| Data | One **SQLite** database (Node's built-in `node:sqlite`) in `DATA_DIR`, plus photo files in `DATA_DIR/media`. The database holds stories, drafts, accounts, sessions and the audit log. Schema changes are numbered migrations in `src/lib/db/migrations/`. |
| Search | SQLite FTS5 (`GET /api/search`). |
| Email | [Resend](https://resend.com), optional. It sends submission confirmations, editor notifications, invites, thank-you notes and the backup alert to administrators. |
| Backups | A nightly snapshot of the database and photos, uploaded to a Google Drive Shared Drive (7 daily and 4 weekly copies). |
| Deployment | A Docker image built by GitHub Actions once a day (or on demand) and pushed to GHCR. After publishing it, the workflow moves the `deploy` branch; the host watches that branch and pulls the new image. |

Publishing a story never touches git. The database and its photo folder are the only copy of the stories, which is why the nightly backup matters.

---

## Public and integration endpoints

| Endpoint | Who uses it | Access |
| --- | --- | --- |
| `GET /`, `/stories/<slug>/`, `/<section>/`, `/<section>/<area>/` (and their `/page/<n>/` pages), `/announcements/`, `/issues/`, `/issues/<n>/` | Readers | Public |
| `GET /rss.xml`, `GET /stories.json` | Feed readers, Studio | Public. `/stories.json` is a versioned contract: fields may be added but are never renamed. |
| `GET /api/search?q=&section=` | The search page | Public, 120 searches per IP every 10 minutes |
| `GET /api/navigation` | The header and footer on static pages | Public |
| `POST /api/submit`, `POST /api/confirm` | The submit form, confirmation links | Public, with spam checks |
| `GET /media/*`, `GET /images/stories/*` | Story photos (old `/images/stories/` links in sent newsletters still work) | Public |
| `GET`/`POST /api/publish`, `GET /api/stories`, `GET /api/studio-photo`, `GET /api/studio-draft-flyer` | IMConnected Studio | `Bearer PUBLISH_TOKEN`, with CORS for `PUBLISH_ORIGINS` |
| `GET /api/agent/sections`, `POST /api/agent/stories`, `POST /api/agent/stories/batch`, `POST /api/agent/stories/reopen`, `GET /api/agent/stories/<id>`, `GET /api/agent/stories?sourceUrl=` | The AI agent | `Bearer AGENT_API_TOKEN`, 60 calls per hour |
| `/admin*`, `/api/admin/*` | Editors | Session and two-step verification |

### The AI agent API at a glance

```bash
# 1. Read the valid sections, areas and limits (body minimum, photo budget, layouts)
curl -s https://stories.imadventist.org/api/agent/sections \
  -H "Authorization: Bearer $AGENT_API_TOKEN"

# 2. Send a story. It becomes a "new" draft for an editor to review.
curl -s -X POST https://stories.imadventist.org/api/agent/stories \
  -H "Authorization: Bearer $AGENT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{ "title": "…", "body": "…", "section": "news", "area": "churches",
        "sourceUrl": "https://…", "requestId": "issue12-item3",
        "newsletterIssue": { "number": 12, "date": "2026-09-14", "position": 3 } }'
# → 201 {"ok":true,"id":42,"status":"created","url":"…/admin/drafts/42"}
```

- **Drafts only.** The agent can create a draft, or update one no editor has touched yet. It cannot publish, unpublish, reject or reach the dashboard.
- **Limits:**

  | Field | Limit |
  | --- | --- |
  | Title | up to 140 characters |
  | Summary (`dek`) | up to 240 characters |
  | Body | **50 to 20,000 characters**, after trimming (`limits.bodyMin`) |
  | Photos | up to 6, sent as `data:` URLs (JPEG, PNG, WebP or AVIF), up to 10 MB each. The whole request is at most 40 MB of JSON, which leaves about 30 MB for photos after base64 (`photoBudget.maxImageBytesPerRequest`). |
- **Safe to retry.** Posting the same `sourceUrl` updates the same draft while no editor has touched it (after that it is refused with `409`), and a repeated `requestId` is acknowledged without writing anything twice.
- **Batch:** up to 20 stories per call (at most 300 stories an hour), and each one succeeds or fails on its own.
- **Reopen:** proposes changes to a story that is already published, as a new draft.

The full reference is in [docs/AGENT-API.md](docs/AGENT-API.md): every field, the error codes, read-back, batch, reopen and announcements.

---

## Running it

The full guide is [docs/OPERATIONS.md](docs/OPERATIONS.md). It covers the reverse proxy, updates, backups, restore and the one-time upgrade. In short:

```bash
cp .env.example .env          # fill in SITE_URL, AUTH_SECRET and the rest (below)
docker compose up -d          # listens on port 4321; put it behind your reverse proxy
docker compose exec imconnected node scripts/create-admin.mjs you@example.org "Your Name"
                              # prints a one-time invite link for the first administrator
```

**Updating.** Merges to `main` ship in the next daily image build (07:43 UTC). To ship sooner, run **Actions → Build & publish image** by hand. Point the server's auto-deploy at the `deploy` branch, with this deploy command:

```bash
docker compose pull && docker compose up -d
```

### Configuration (`.env`)

| Setting | Required? | Purpose |
| --- | --- | --- |
| `SITE_URL` | Yes | The public address, used for links, passkeys and sign-in redirects. |
| `AUTH_SECRET` | Yes | 32+ random characters. Encrypts authenticator secrets and signs sign-in flows. Never change it once editors have enrolled. |
| `TRUST_PROXY` | Behind a proxy | `true` for a single reverse proxy, `cloudflare` behind Cloudflare. See OPERATIONS before setting it. |
| `DATA_DIR` | No | Where the database and photos live (`/data` in Docker). |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_CONFIRM_SECRET` | For email | Confirmation, notification, invite and thank-you emails. |
| `TURNSTILE_SECRET_KEY` | Recommended | Cloudflare Turnstile spam check on the submit form. The public site key is the repository variable `PUBLIC_TURNSTILE_SITE_KEY`. |
| `SUBMIT_RATE_LIMIT`, `ALLOWED_ORIGINS`, `DISCORD_WEBHOOK_URL` | No | Submissions per IP per hour, extra form origins, an optional Discord ping. |
| `PUBLISH_TOKEN`, `PUBLISH_ORIGINS` | For Studio | Studio's shared secret and its allowed browser origins. |
| `AGENT_API_TOKEN` | For the agent | The AI agent's shared secret. Use a different value from `PUBLISH_TOKEN`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional | Google sign-in for editors ([setup](docs/SIGN-IN.md)). |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | Optional | Microsoft 365 sign-in, limited to the conference's own tenant ([setup](docs/SIGN-IN.md)). |
| `GDRIVE_SERVICE_ACCOUNT_JSON`, `GDRIVE_FOLDER_ID`, `BACKUP_HOUR` | Strongly recommended | Nightly backups to Google Drive ([setup](docs/OPERATIONS.md#nightly-backups-to-google-drive)). |

Each secret is a separate random value of at least 32 characters (`openssl rand -hex 32`). Secrets live only in the server's `.env`, never in git.

---

## Customizing

| What | Where |
| --- | --- |
| Home page block order and section rails | `/admin/homepage` (administrators) |
| Website menu and newsletter signup link | `/admin/navigation` (administrators) |
| Header and footer text and links | `/admin/header-footer` (administrators) |
| Newsletter issue dates and titles | `/admin/issues` (administrators) |
| Site name, tagline, sections and categories | `src/lib/site.ts` (the only place sections are defined) |
| Colors, fonts and spacing | `:root` tokens in `src/styles/global.css` |
| Submit form fields and limits | `src/pages/submit/index.astro`, `src/lib/limits.ts`, `src/lib/submission.ts` |
| Story fields | `src/content.config.ts`, plus the files listed in `AGENTS.md` that must stay in sync |

Design changes to the public pages follow the project's design rules in `.claude/skills/design-taste-frontend/IMCONNECTED.md`: polish, never a rebrand.

---

## Local development

Node 22.22 or later.

```bash
npm install
npm run dev                         # http://localhost:4321
npm run build && npm start          # production build and server
```

To try the dashboard, use a throwaway data folder with made-up secrets:

```bash
export DATA_DIR=/tmp/imc-data SITE_URL=http://localhost:4321
export AUTH_SECRET=$(openssl rand -hex 32)   # keep it for the whole session
npm start
node scripts/create-admin.mjs test@example.com "Test Admin"   # in a second shell with the same exports
```

Session cookies are always `Secure`, so sign in with Chrome or Firefox on `localhost`. Point `EMAIL_API_URL` at `scripts/mock-email.mjs` to see emails without sending any.

**Tests.** After `npm run build`, the end-to-end suites in `scripts/test-*.mjs` start the built server against a throwaway `DATA_DIR`. Each script's header lists its settings. The main ones are:
- `test-editor-submissions.mjs`, `test-editor-drafts.mjs`, `test-public-pages.mjs` and `test-story-store.mjs`, for submitting and publishing;
- `test-agent-api.mjs`, for the agent API;
- `test-editor-oauth.mjs`, for sign-in;
- `test-backups.mjs`, for backups.

Tests use mocks for email, Google Drive and sign-in providers, synthetic stories and made-up tokens. They never contact real services.

---

## Documentation

| Guide | Covers |
| --- | --- |
| [Operations](docs/OPERATIONS.md) | Deploying, updating, the reverse proxy, feeds, nightly backups and restore |
| [Editor guide](docs/EDITOR-GUIDE.md) | The dashboard, reviewing submissions, bulk actions, accounts and the audit log |
| [Sign-in](docs/SIGN-IN.md) | Passwords, two-step verification, passkeys, Google and Microsoft 365 setup, recovery |
| [Photos and modules](docs/PHOTOS-AND-MODULES.md) | Photo layouts, the viewer, cropping, the module editor, announcements and issues |
| [Stories in the database](docs/STORAGE.md) | Storage, publishing, search, the frozen archive and the import script |
| [AI agent API](docs/AGENT-API.md) · [batch](docs/AGENT-BATCH.md) · [reopen](docs/AGENT-REOPEN.md) · [announcements](docs/AGENT-ANNOUNCEMENTS.md) | Everything the AI agent can send |
| [Studio API](docs/STUDIO-API.md) · [Studio import](docs/STUDIO-IMPORT.md) | Publishing from and importing into IMConnected Studio |
| [Scheduled publishing](docs/SCHEDULED-PUBLISHING.md) · [Multiple sections](docs/MULTIPLE-SECTIONS.md) · [Image formats](docs/IMAGE-FORMATS.md) · [Listen](docs/LISTEN.md) | Single features in depth |
| [Community navigation](docs/COMMUNITY-NAVIGATION.md) · [Publication redesign](docs/PUBLICATION-REDESIGN.md) · [Design review](docs/DESIGN_REVIEW.md) | The public design and navigation |
| [Security](docs/SECURITY.md) | Escaping, photo checks, spam protection and the handling of personal data |
| `AGENTS.md` and `CLAUDE.md` | The rules for AI coding agents working in this repository |

---

## Ground rules

- **People decide.** Only a person publishes, unpublishes or rejects a story, merges a pull request, deploys, changes secrets or restores a backup. The AI agent and Studio integrations cannot get around this.
- **Personal data stays private.** Submitter emails and phone numbers live only in the database and the editor-only panel. They never appear in logs, story pages, feeds, notification emails or git.
- **No raw HTML from anyone.** All submitted and agent text is escaped. Captions and key points are plain text.
- **Synthetic data in development.** Tests, screenshots and sample stories never use real people or the production database.
