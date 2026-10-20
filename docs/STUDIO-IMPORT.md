# Plan: import IMConnected stories into IMConnected Studio

IMConnected Studio (`imconnected.html` in the `imsda/utilities` repo, hosted at
`https://tools.imsda.org/imconnected.html`) builds the newsletter email. Today
every story is retyped there. The site now has an authenticated story list,
`GET /api/stories`, so the builder can fill story blocks from it.

The utilities repo marks `imconnected.html` as managed by someone else, so this
repo doesn't change it. This page is the hand-off for whoever maintains Studio.
(The button is already merged there; this page records what the site gives it.)

## 1. "Import from IMConnected" button

Studio reads **`GET <site>/api/stories?limit=50`**, not the public
`/stories.json`. The public feed is only the last build and needs a CORS header
added by the reverse proxy; the API needs neither.

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
    `image`, `imageAlt`, `photoCredit`, `photos`, `photoAlts`, `featured`) plus
    `status: "published"` and `source`. It includes stories published since the
    last site build, and leaves out unpublished ones.
  - `drafts`: the 20 newest drafts waiting for an editor (`status` `new` or
    `in_review`), in the same shape with the draft's numeric `id`, `status` and
    `source` (`form`, `editor`, `studio` or `agent`) and no `url`. Show them as "not
    published yet" and don't link them. `image` is present only when the draft's
    lead photo is a file the site serves publicly (uploads are editors-only).
  - Submitter names, emails, phone numbers, the AI agent's notes and source links
    are never included.
- Links (`url`) are always on the site's own origin. Images are on the site's
  origin, or `https://stories.imadventist.org` photo addresses an editor kept.
- Show the stories newest first with a checkbox each; filter by `sectionLabel`.
- For each checked story, add one Story block:

| Studio story field | From the API item |
|---|---|
| `tag` | `areaLabel` if present, otherwise `sectionLabel`, in capitals (e.g. `CHURCHES`, `FEATURES`) |
| `title` | `title` |
| `body` | `dek` (if empty, leave the body for the editor to write) |
| `link` | `url` |
| `buttonLabel` | `Read full story` (Studio's default) |
| `photos[0].url` / `alt` | `image` / `imageAlt` |
| `photos[0].caption` | `photoCredit`, as "Photo: …", if present |

- Don't copy the story body. The email should send readers to the site.
- Keep the existing draft format and `localStorage` keys unchanged (a rule in
  the utilities repo).
- The public `/stories.json` and `/rss.xml` stay as they are for feed readers.

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
