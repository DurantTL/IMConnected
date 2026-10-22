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

## Homepage and article layout

The full-width event stage gives the flyer and invitation room above the news. A larger lead story, latest-story rail, strong sans-serif headlines and warm content surfaces establish the publication hierarchy. Article headlines and photography occupy a wider frame while the serif reading column stays around 66 characters wide. Article metadata adds estimated reading time and a jump to the story body. Primary and additional section links remain available.

[Northwest Adventists](https://nwadventists.com/) informed the dominant-media hierarchy, [Adventist Record](https://record.adventistchurch.com/) the lead-story/teaser balance, and [Adventist Review](https://adventistreview.org/articles/a-bogus-doctrine) the article hierarchy and reading column. These are layout references; no reference-site photography, article copy or implementation was copied. The automatic slider is the owner's requested addition, rather than a claim about the reference sites' behavior.

## Event spotlight behavior

Only published upcoming Events appear, at most six, ordered by the conference's America/Chicago calendar day. The lead flyer stays uncropped. Announcements retain their own board and editor queue.

- Two or more events advance every seven seconds and wrap to the first event. Manual Previous/Next, numbered choices, keyboard arrows and native scrolling remain available.
- Pause persists until Resume is explicitly selected. Touching the track also pauses rotation. Hover, focus inside the spotlight, an offscreen spotlight and hidden tabs suspend automatic movement; leaving those conditions can resume it unless the reader paused.
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

Verified results: production build; **34 dedicated redesign checks**, **104 responsive checks across 30 screens**, **172 editor browser checks**, **94 photo-layout/viewer checks**, and **37 public-page checks** passed. Editor and public WCAG A/AA axe checks were enabled. Four historical public-page groups were skipped because no historical markup baseline was supplied; these are not counted as passes. Independent Sol review and targeted re-reviews found no remaining findings. Luna researched references and ran the responsive crawl; the coordinator built and independently ran the redesign, editor, photo and public-page suites. Tera and Fable were unavailable; implementation used the inherited session model.

The dedicated redesign suite requires axe and checks the palette/wordmark, automatic/manual event navigation, pause persistence, hover/focus/visibility, reduced motion, no-JavaScript reading, touch, single/empty event states, article/category links, phone editor settings and WCAG A/AA scans. Page lifecycle/hidden-tab cases dispatch synthetic browser events; they do not prove a real browser's back-forward cache behavior. Tests use temporary local SQLite databases and generated media. Production services and real publication are not exercised. Historical byte-for-byte public markup comparisons are inapplicable to this intentional redesign and are reported as skipped by the public-page suite.
