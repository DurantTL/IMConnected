# IMConnected Studio photo compatibility

IMConnected Studio (`imconnected.html` in the `imsda/utilities` repo, hosted at
`https://tools.imsda.org/imconnected.html`) builds the newsletter email. Its
authenticated `GET /api/stories` import fills story cards with teasers and photos.

The owner explicitly authorized the compatibility update to `imconnected.html`
in utilities and tools-public. Keep those two self-contained files identical;
no other secondary-repository files are part of this change.

## 1. "Import from IMConnected" button

Studio reads **`GET <site>/api/stories?limit=50`**, not the public
`/stories.json`. Both read the live database without a build. The authenticated
API additionally lists waiting drafts and supplies the allowed browser CORS policy.

- **Auth and CORS** are the same as for publishing: `Authorization: Bearer
  <PUBLISH_TOKEN>` (the value Studio already holds for "Publish to IMConnected"),
  `credentials: 'omit'`, `redirect: 'error'`, from an origin listed in
  `PUBLISH_ORIGINS` (default `https://tools.imsda.org`). The browser's preflight
  (`OPTIONS`, asking for the `Authorization` header) is answered for those
  origins only; any other origin gets no CORS headers. No token or a wrong one is
  `401`; an unset or short `PUBLISH_TOKEN` on the server is `503`.
- **Query:** `limit` (1-100, default 50) and an optional `section` key (`news`,
  `features`, `columns`, `youth`, `kids`; `/api/publish` lists them too).
- **Response:** `{ ok: true, version: 1, site, generated, stories: [...], drafts: [...] }`.
  - `stories`: live stories, newest first. Each item is exactly an item of
    `/stories.json` (`id`, `url`, `title`, `dek`, `section`, `sectionLabel`,
    `area`, `areaLabel`, `column`, `author`, `authorTitle`, `church`, `date`,
    `image`, `imageAlt`, `photoCredit`, `photos`, `photoAlts`, `photoLayout`, optional
    `photoFocus`, `featured`) plus
    `status: "published"` and `source`. It includes stories published since the
    last site build, and leaves out unpublished ones.
  - `drafts`: the 20 newest drafts waiting for an editor (`status` `new` or
    `in_review`), in the same shape with the draft's numeric `id`, `status` and
    `source` (`form`, `editor`, `studio` or `agent`) and no `url`. Show them as "not
    published yet" and don't link them. `image` is present only when the draft's
    lead photo is a file the site serves publicly (uploads are not public). Typed open announcements may also carry the scoped `draftFlyer` descriptor described below.
  - Submitter names, emails, phone numbers, the AI agent's notes and source links
    are never included.
- Links (`url`) are always on the site's own origin. Images are on the site's
  origin, or `https://stories.imadventist.org` photo addresses an editor kept.
- Show the stories newest first with a checkbox each; filter by `sectionLabel`.
- For each checked ordinary story, add one Story block. Typed announcements/events instead use the flyer cards described below:

| Studio story field | From the API item |
|---|---|
| `tag` | `areaLabel` if present, otherwise `sectionLabel`, in capitals (e.g. `CHURCHES`, `FEATURES`) |
| `title` | `title` |
| `body` | `dek`, otherwise the API's safe `excerpt` |
| `link` | `url` |
| `buttonLabel` | `Read full story` (Studio's default) |
| `photos[0].url` / `alt` | `image` / `imageAlt` |
| `photos[0].caption` | `photoCredit`, as "Photo: …", if present |
| `photos[1…].url` / `alt` | `photos` / `photoAlts`, in order |
| `photos[i].focalX`, `focalY`, `zoom` | Aligned `photoFocus[i]`; defaults 50/50/1 |
| `layout` | `photoLayout` |

- Don't copy the story body. The email should send readers to the site.
- Retain `importedFrom`: imported live stories and waiting drafts cannot be sent
  through Studio's publish action. In particular, a teaser must not replace a full article.
- Import up to six permitted photos. Apply crop metadata before filtering unsafe
  addresses so the remaining photos keep their correct focus. WordPress copies
  resolve the same stable photo ID and unchanged source URL after each upload,
  preserving edits/reorders/deletions made while a copy is in flight.
- Keep the existing draft format and `localStorage` keys unchanged (a rule in
  the utilities repo).
- The public `/stories.json` and `/rss.xml` stay as they are for feed readers.

## Studio-native publishing

`POST /api/publish` accepts optional `focalX`/`focalY` (finite JSON numbers 0–100)
and `zoom` (1–3) on each photo. Invalid present values, including null/strings,
are rejected. The publish transaction re-reads the latest photo rows and inherits
omitted values only for the same photo identity (content path/hash or normalized
HTTPS URL). New photos default to 50/50/1. For duplicate identities, matching
prefers the same prior position and then an unmatched occurrence. Explicit defaults
reset the crop. Live photos and closed Studio draft photos use the same effective
values; an editor's open draft remains intact. Original bytes are unchanged.

Studio keeps document schema/storage keys unchanged. Old drafts acquire centered
100% zoom through normalization. The per-photo Zoom range persists and affects
cropped email/web slots. Natural-height slots and WordPress block exports retain
the original framing. Email clients supporting object-fit receive the full crop;
the width/margin fallback preserves proportions, but needs measured image dimensions
for vertical pan. Preview/export is not a guarantee that every email client renders
identical CSS.

Validation uses `test-story-builder.mjs` for server transactions and
`STUDIO_HTML=../tools-public/imconnected.html node scripts/test-studio-client.mjs`
with Playwright configured for the real import/publish UI, persistence and copy races.

## 2. Match the IMConnected template to the site's colors

The site and the IMConnected email template currently use different colors.
For the IMConnected template only (Church, School and Ministry templates keep
theirs):

| Role | Studio today | Site (`src/styles/global.css`) |
|---|---|---|
| Primary | `#087E8B` | `#1f3a5f` (navy, `--brand`) |
| Dark | `#0B3954` | `#1b1f24` (`--ink`) |
| Light | `#E0F5F7` | `#f6ead9` (`--accent-soft`) |
| Accent | `#2DD4BF` | `#b8742a` (amber, `--accent`) |
| Email background | `#ECEAE5` | `#f2efe8` (`--surface-2`) |
| Content background | `#F8F7F5` | `#fbfaf7` (`--bg`) |
| Card border | `#D8E8EB` | `#e3dfd6` (`--line`) |

Headings already use Georgia, which is the site's fallback for Source Serif 4,
so fonts need no change. Check contrast of white button text on the navy and
amber before switching.

## Not planned

- Sending the newsletter stays in FluentCRM or Mailchimp, done by a person.
- The IMSDA Events email system is for event and account mail and isn't used
  for the newsletter.

## Announcement-style import and website export

The API's `announcement` object selects a Studio `eventList` card with an Events or Announcements heading. It retains kind, event date, location, all three labelled actions and a supported YouTube/Vimeo URL. Email and website HTML render full-aspect flyers and safe action/video links; WordPress block export includes those same links. The published story address remains an additional Read announcement action. Announcement cards import the actual lead flyer only; a rejected lead is never replaced with a gallery image. The IMConnected board/detail templates already use the same full-aspect lead-flyer rule.

An open announcement's uploaded lead flyer can be included through `draftFlyer: { draftId, photoId, key, alt }` in the authenticated list. The descriptor is not an image URL. The client constructs `/api/studio-draft-flyer?draftId=…&photoId=…&key=…` on its configured site and fetches it with the Studio bearer token. The server rechecks open status, typed announcement, current lead and stable media identity, then serves sniffed original bytes with no-store and CORS. This does not extend `/api/studio-photo`, the public media routes, ordinary draft uploads or the AI agent's permissions.

Studio uses stable event IDs plus unchanged source checks before private transfer and after asynchronous copies. WordPress is preferred; a bounded resized local data URI is retained only when the actual browser-storage write succeeds. Send Check warns about local images and unpublished drafts, and reports missing/failed flyers. Manual Browse/URL replacement clears transfer flags; reloading an interrupted transfer shows a recoverable error instead of an endless pending state. Never save the descriptor, bearer token or private API URL in an exported newsletter.

Synthetic checks:

```bash
node scripts/test-studio-draft-flyer.mjs
STUDIO_HTML=../utilities/imconnected.html node scripts/test-studio-announcements.mjs
STUDIO_HTML=../tools-public/imconnected.html node scripts/test-studio-client.mjs
```

Set the Playwright/Chromium environment variables documented in `docs/DESIGN_REVIEW.md` when those tools are installed outside the repository. Deploy the matching `imconnected.html` changes in both Studio repositories.
