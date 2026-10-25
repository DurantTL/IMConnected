# IMConnected settings for design-taste-frontend

Read this before `SKILL.md`. Where the two disagree, this file wins. It was set by the site's owner
for polishing stories.imadventist.org and is the whole design setup: this one skill plus these rules.
Do not install `ui-ux-pro-max` or any other design skill alongside it.

The skill itself is vendored unchanged from https://github.com/Leonxlnx/taste-skill
(`skills/taste-skill`, commit `12af471`, MIT, see `LICENSE`). To update it, copy the upstream folder
over this one and keep this file and the pointer at the top of `SKILL.md`.

## What this is

stories.imadventist.org is a magazine-style news site for church members of every age, not a landing
page. The work is **polish, not a rebrand**: restraint beats experimentation.

- Always follow `SKILL.md` "Special cases → Redesign, restyle or review of an existing page" in its
  **restyle** form: record the before, audit it, then fix **layout, spacing and hierarchy** in that
  order. Never run `scripts/draw.mjs` and never deal a direction, palette, type system or blueprint.
- Scope: the public reading pages (home, section and area pages, story pages, `/issues/`, `/search/`,
  `/submit/`). The `/admin` dashboard is out of scope unless the owner asks.

## Dials

The skill's current version has no numeric dials, so the owner's settings are written out here.

| Dial | Setting | What it means here |
| --- | --- | --- |
| Design variance | **Low** | Keep the existing grid, components and editorial order. Change proportion, spacing and emphasis inside them. No new layout devices, no asymmetry for its own sake, no section that looks unlike the rest of the site. |
| Motion intensity | **Low** | State feedback only (focus, press, the existing carousel). No scroll entrances, no scroll scenes, no signature move, no parallax. Every transition has a `prefers-reduced-motion` fallback. |
| Visual density | **Medium** | A news front page shows several stories per screen. Tighten slack space, never squeeze reading text. Gaps between home page blocks stay in the site's own spacing scale (roughly 48-96px on desktop, 32-56px on a phone), not the skill's 120-240px. |

## Identity that stays

- Navy and the existing colour tokens in `src/styles/global.css` `:root`; the current type system
  (faces, weights, scale) and the editorial hierarchy (lead story, secondary stories, lists, section
  rails, the archive).
- Reference points: Adventist Record and Adventist Review. Measured, not imitated: use them to judge
  proportion and calm, never copy their layouts, logos, colours or wording.

## Hard rules (in addition to the skill's house rules)

- No AI-slop defaults: no Inter, no purple or any gradients, no generic card grids, no glassmorphism.
- Mobile first: build and check at 360 and 390px before 768, 1024 and 1280px.
- Readability for an older audience: running text at least 17px on a phone, leading 1.5 or more, at
  most about 75 characters a line, body contrast at least 4.5:1 (aim for 7:1), no light grey running
  text.
- Tap targets at least 44 x 44 CSS px with at least 8px between neighbours.
- Never hover as the primary interaction: anything a hover reveals is visible or reachable by tap and
  keyboard too; focus is always visible.
- Never write, change or invent copy, story content, names or pictures. Screenshots and tests use
  synthetic stories in a throwaway `DATA_DIR`.

## Skill rules that do not apply here

| Skill rule | Here |
| --- | --- |
| Step 9 motion layer and the inspector's `still-page` floor | Off (motion low). |
| Picture floor (`few-pictures`, `no-real-pictures`, `no-footage`, `no-poster`), `scripts/assets.mjs`, bundled photographs, drawn stand-ins | Off. A news site shows only its own story photos. Never search, download or add found pictures. |
| "No eyebrows" / tiny labels | A story's section name above its headline is editorial navigation (a kicker), not ornament, and stays. It must be readable (at least 13px, real contrast); letter-spaced caps are allowed only if they already exist and pass contrast. |
| Two-line headline rule | Applies to headings the design sets (page and block titles), not to story titles, which wrap freely and are never truncated. |
| Large display type (8vw headlines, 4:1 ratios) | Off. Keep the current type scale; adjust a step only to fix hierarchy. |
| "No card grids" | Story teasers are the content. Keep them, but give each block a clear hierarchy (one lead, then smaller items or a list) rather than rows of identical boxes. |
| Copy deck, idea sentence, live thing, inventory | Off: the content is the stories. |

## The gate before anything ships

1. `node .claude/skills/design-taste-frontend/scripts/lint.mjs src/` and
   `CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node .claude/skills/design-taste-frontend/scripts/inspect.mjs <url> --widths 1280,768,390,360 --allow still-page,few-pictures,no-real-pictures,no-footage,no-poster`
   against the built server (`npm run build`, then `node dist/server/entry.mjs` with a throwaway
   `DATA_DIR` of synthetic stories). Fix every FAIL that the table above does not switch off.
2. Vercel's web-design-guidelines audit as the pre-ship check: fetch
   https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md fresh and
   review the changed files against it (accessibility, focus states, touch targets). It is a check,
   not a second design skill.
3. The repo's own checks (`npm run build`, the end-to-end suites in `CLAUDE.md`) and the reviewer.
4. Send the owner a preview (before and after screenshots at phone and desktop width) for visual
   review. Nothing goes live on the skill's say-so alone; a person merges and deploys.
