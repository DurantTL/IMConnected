# Plan: import IMConnected stories into IMConnected Studio

IMConnected Studio (`imconnected.html` in the `imsda/utilities` repo, hosted at
`https://tools.imsda.org/imconnected.html`) builds the newsletter email. Today
every story is retyped there. This site now publishes `/stories.json`, so the
builder can fill story blocks from it.

The utilities repo marks `imconnected.html` as managed by someone else, so this
repo doesn't change it. This page is the hand-off for whoever maintains Studio.

## 1. "Import from IMConnected" button

- Fetch `https://stories.imadventist.org/stories.json` (the address should be a
  setting). If the browser blocks the request because the header from the
  README's "Story feeds" section is missing, offer a box to paste the JSON
  instead.
- Show the stories newest first with a checkbox each; filter by `sectionLabel`.
- For each checked story, add one Story block:

| Studio story field | From `/stories.json` |
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
