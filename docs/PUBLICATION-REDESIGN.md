# IMConnected publication design

Issue #77 applies the supplied IMConnected branding and the colors read from the owner's newsletter draft. The draft is reference data only; its newsletter content is not part of the repository or test fixtures. Issue #76 supplies the related [multiple-section workflow](MULTIPLE-SECTIONS.md).

## Brand and color

The header, footer and editor use one local IMConnected wordmark. The artwork was prepared from the conference's existing public IMConnected artwork: an image-generation crop removed its unrelated generated subtitle and retained the cyan IM / white Connected lettering on charcoal. The resulting opaque asset was encoded as a 34 KB WebP at `public/images/brand/imconnected-wordmark.webp`. It makes no third-party image request. `BrandMark.astro` supplies the accessible name once inside each brand link.

The newsletter palette is shared by public and editor screens:

| Role | Color |
| --- | --- |
| Primary teal | `#087E8B` |
| Dark navy | `#0B3954` |
| Pale aqua | `#E0F5F7` |
| Mint accent | `#2DD4BF` |
| Newsletter background | `#ECEAE5` |
| Content background | `#F8F7F5` |

Small links and category labels use navy on light backgrounds to meet text contrast requirements; primary teal remains available for buttons and larger accents. Mint outlines show keyboard focus on navy headers. The publication keeps these colors under either operating-system color preference.

## Typography

On 2026-10-25 the owner chose Source Sans 3 (weights 400 to 700, loaded from Google Fonts in `Base.astro`, `--sans` in `global.css`) to replace Inter; Source Serif 4 is unchanged. Because it reads smaller at the same size, public text has a floor: nothing under 13px, bylines and dates at least 14px, card summaries at least 16px on a phone, and the letter-spaced uppercase labels that remain (kickers, eyebrows) at 13px with tracking of 0.08em at most. The floor is the last block of `global.css` (issue #160); the admin keeps its own `--adm-*` tokens.

## Homepage and article layout

The full-width event stage gives the flyer and invitation room above the news. A larger lead story, latest-story rail, strong sans-serif headlines and warm content surfaces establish the publication hierarchy. Article headlines and photography occupy a wider frame while the serif reading column stays around 66 characters wide. Article metadata adds estimated reading time and a jump to the story body. Primary and additional section links remain available.

[Northwest Adventists](https://nwadventists.com/) informed the dominant-media hierarchy, [Adventist Record](https://record.adventistchurch.com/) the lead-story/teaser balance, and [Adventist Review](https://adventistreview.org/articles/a-bogus-doctrine) the article hierarchy and reading column. These are layout references; no reference-site photography, article copy or implementation was copied. The automatic slider is the owner's requested addition, rather than a claim about the reference sites' behavior.

## Homepage recency

The hero, the latest rail, the Features, Youth and Kids blocks and the Across the Conference areas draw only from stories dated within the last 90 days (`HOMEPAGE_RECENT_DAYS`, one constant in `src/lib/public-stories.ts`, counted by the America/Chicago day) plus any story marked featured regardless of date, so a featured older story can still lead the hero. A block with fewer stories than it has room for shows fewer instead of reaching into the archive, and an empty news area keeps its invitation to share a story. The event spotlight, section pages, search and feeds are unchanged and still cover every published story. The window moves with the calendar rather than with a publish, so the cached home page can keep a story for up to one cache TTL (10 minutes) plus the Cloudflare/browser window (about 6 minutes) past its 90th day; this is accepted. `scripts/test-homepage-recent.mjs` covers the boundary.

### From the archive rail

Below the story blocks and above the submit call to action, "From the archive" (eyebrow, heading, the line "Stories from past issues of IMConnected" and a link to `/issues/`) shows four stories older than the recency window; phones show three (the fourth is hidden in CSS). `archiveRail()` in `src/lib/archive-rail.ts` is a pure function: it drops stories already shown higher on the page (for example an old featured story in the hero), sorts the rest by id, shuffles them with a generator seeded by the America/Chicago day (`conferenceDay()`), then prefers stories with a photo and takes one per section before repeating a section. The same day therefore gives every reader the same four and the page cache stays valid; the set changes at the Chicago midnight (plus the cache window). Owner decision: any story with an announcement or event is excluded, so an expired event is never re-posted as if current; only ordinary stories qualify. The rail also excludes everything above it, including the event spotlight (which keeps old-dated upcoming and undated events). Fewer than two qualifying stories hides the block. Cards are the ordinary grid cards, so each shows its original date and a placeholder when it has no photo. The archive link is the single constant `ARCHIVE_LINK` (`/news/` for now; the issues browser switches it to `/issues/`), and `archive-rail.ts` marks where "Issue #N" goes once newsletter-issue data exists. `scripts/test-archive-rail.mjs` unit-tests the selection with an injectable day; `test-homepage-recent.mjs`, `test-design-review.mjs` (row alignment and axe at five widths) cover the rendered block.

## Home page density (issue #161)

- Header bands on the public pages: at 390px the tagline bar, masthead and conference band together are 123px (30 + 66 + 27); at 1280px the masthead is 92px. Controls keep 44px targets.
- The intro's counts line and "Latest issue" line share one meta line (`.home-intro-meta`) and wrap on a phone (intro 183px at 390px). From 861px the tagline note takes a right-hand column.
- One spacing scale between home blocks, set by `--home-gap` on `.magazine-home`: 32px on a phone, 56px from 621px. Each block carries its own top space, so a hidden, reordered or empty block leaves no gap.
- Home eyebrows keep their words and read as sentence-case labels at 14px with no tracking in the muted ink colour. The featured panel has one kicker, "Featured story · <section label>"; "Read the story" and similar links are sentence case at 15px.
- Under 620px each section rail keeps its first card whole; the others are compact rows (title, byline and date, a 96px thumbnail on the right, no summary) that are one link at least 44px tall.
- The decorative numbers beside the "From around our conference" list are gone (the list is still an `<ol>`). Stories without a photo are text only (issue #162).

## Section and area pages (issue #162)

`SectionList.astro` shows, on page 1 of `/<section>/` and `/<section>/<area>/`, the newest story as a **lead** (`StoryCard` `variant="feature"`, an `h2`): from 1024px the photo takes 7/12 and the text 5/12; below that, and on a phone, the photo comes first at full width. A lead without a photo is text on a tone step across the full width. On page 1 a visually hidden `h2` ("More stories in <label>") comes before the rows, which stay `h3`, so heading navigation does not nest them under the lead. Pages 2 and above have no lead and a plain list whose stories are `h2`.

The stories after the lead use `variant="row"`. Under 768px each is a compact row: title (serif, 19px), then byline and date, with a 104px square thumbnail on the right when there is a photo; no kicker and no summary shown on a phone. Rows are separated by space (24px) only, no rule. From 768px the rows become a calm grid (2 columns at 768px, 3 from 1024px) with no outline or shadow: a text-only story is a tone-step block, a photo story is its photo above the text, and summaries are clamped to three lines (full text kept in the DOM).

A story without a photo is **text only everywhere `StoryCard` is used** (home rails, archive, `/issues/`); the navy placeholder tile and its CSS are gone. The kicker (`kickerMode`) is the area only on a section page; a story listed there through `additionalSections` shows its primary "Section / Area" (or the section alone), so an area name never reads like an area of the page's section, nothing on an area page, and "Section / Area" elsewhere. The tiny "IMConnected" eyebrow above the page `h1` is gone. The area filters (`.chips`) and the pager are tone-step pills at least 44px tall with 8px or more between them; the current one keeps `aria-current`. Tests: `scripts/test-public-pages.mjs` (lead on page 1 only, no placeholder, no kicker on area pages) and `scripts/test-design-review.mjs`.

## Event spotlight behavior

Only published upcoming Events appear, at most six, ordered by the conference's America/Chicago calendar day. The lead flyer stays uncropped. Announcements retain their own board and editor queue.

- Two or more events advance every seven seconds and wrap to the first event. Manual Previous/Next (which wrap, so they are never disabled), numbered choices, keyboard arrows and native scrolling remain available.
- The pause/play toggle is an icon-only button in the heading controls beside the arrows (before the event links in the Tab order); its label changes between "Pause automatic advance" and "Resume automatic advance". Pause persists until Resume is explicitly selected. A finger on the track pauses rotation only while it is down; a horizontal swipe counts as the reader taking over and stops automatic advance until Resume is pressed, while vertical page scrolling does not. Only keyboard focus (not a tap) holds rotation. Hover, focus inside the spotlight, an offscreen spotlight and hidden tabs suspend automatic movement; leaving those conditions can resume it unless the reader paused.
- Reduced motion disables automatic movement and makes manual jumps instant. Turning reduced motion off does not restart a rotation the preference stopped.
- Automatic changes never move keyboard focus or make repeated live-region announcements. Manual/paused position feedback remains available. Returning through the browser's page lifecycle reschedules rotation only when eligible.
- With one event, the event remains readable without automatic controls. With no upcoming events, the stage is absent. Without JavaScript, all event cards and links remain readable through native scrolling.

The public navigation editor, module-library favorites, crop zoom/pan, original-image links and human publication rules remain part of the existing workflows. See [community navigation](COMMUNITY-NAVIGATION.md).

## Review screenshots

These screenshots contain only synthetic stories, made-up people and generated local illustrations. They show the new implementation rather than live production content.

![Publication homepage on desktop](design/publication-home-desktop.png)

![Publication homepage on a phone](design/publication-home-mobile.png)

![Article on desktop](design/publication-article-desktop.png)

![Article on a phone](design/publication-article-mobile.png)

![Branded phone editor with multiple-section controls](design/publication-editor-mobile.png)

## Verification

Build before running the browser checks. Playwright and axe remain external test tools, with the environment overrides documented in [the design review](DESIGN_REVIEW.md).

```bash
npm run build
AXE_JS=/path/to/axe.min.js node scripts/test-publication-redesign.mjs
AXE_JS=/path/to/axe.min.js node scripts/test-design-review.mjs
AXE_JS=/path/to/axe.min.js node scripts/test-story-builder-ui.mjs
SCRATCH=/tmp/imc-publication-photos node scripts/test-photo-layouts.mjs
SCRATCH=/tmp/imc-publication-pages node scripts/test-public-pages.mjs
```

Checks run for this change: `npm run build` and every `scripts/test-*.mjs` suite with the environment overrides above (`PLAYWRIGHT_ROOT`, `CHROMIUM_PATH`, `AXE_JS`). The redesign suite covers axe on the homepage, the editor under an emulated dark colour scheme and the editor list pages, plus keyboard focus-ring contrast and screenshots. The public-page suite skips four historical markup comparisons because no baseline was supplied, which is intentional for this redesign. `test-studio-announcements.mjs` times out waiting for the Studio import menu, identically on `main`.

The dedicated redesign suite requires axe and checks the palette/wordmark, automatic/manual event navigation, pause persistence, hover/focus/visibility, reduced motion, no-JavaScript reading, touch, single/empty event states, article/category links, phone editor settings and WCAG A/AA scans. Page lifecycle/hidden-tab cases dispatch synthetic browser events; they do not prove a real browser's back-forward cache behavior. Tests use temporary local SQLite databases and generated media. Production services and real publication are not exercised. Historical byte-for-byte public markup comparisons are inapplicable to this intentional redesign and are reported as skipped by the public-page suite.
