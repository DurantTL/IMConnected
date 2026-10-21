# Magazine and editorial studio redesign

This change follows the content-outline, task-focused panels, labelled actions, mobile reflow and private-preview direction in [IMSDA Events #1114](https://github.com/DurantTL/IMSDA-Events/issues/1114). It keeps IMConnected's routes, editorial permissions, SQLite source of truth and human publishing action.

## What changed after the design review

The earlier pass left the existing page structure mostly intact: a large empty hero placeholder, lightly restyled navigation, and a long editor form with the module tools inserted halfway down. This revision changes those structures.

- The public site has a publication masthead, separate section-navigation band, typographic feature cover, numbered latest-story rail, topic directory and a redesigned conference board. Stories without photographs use an intentional text cover instead of a large empty picture placeholder.
- Article pages have a clearer breadcrumb/headline/byline hierarchy and a focused reading column. The footer has a stronger submission invitation. Existing story URLs, feeds, section routes and image focus remain supported.
- The editor starts with its content workspace. Metadata is in **Story settings**, image management is in **Photos**, and publishing is in **Review & publish**. A sticky toolbar keeps Save and private Preview available. Inactive panels are hidden and inert while their fields remain part of the saved form.
- Desktop editing uses an outline/module library, selected-module settings and reader preview. The outline and settings can scroll independently. Mobile has explicit task tabs and Write/Preview controls rather than offscreen panels that remain keyboard-focusable.
- Paragraph, heading, quote, list, image, button/link and divider modules support ordering, duplicate/delete and undo/redo. Existing Markdown is retained; empty new drafts begin with a paragraph module. Previewing does not publish.
- Photo editing shows a reader-crop preview beside the original image and focal marker. Dragging, arrows, Shift+arrows, labelled sliders and Center focus all update the stored point. Original image proportions are preserved in the focal pad so pointer coordinates match the image.
- Additive migration 017 stores modules and focal coordinates. Save/publish/live-edit round trips retain them, and the save queue flushes later edits before publishing or photo operations.

## Website

![Magazine homepage at desktop width](design/website-desktop.png)

![Magazine homepage at phone width](design/website-mobile.png)

## Story editor

These editor screenshots use a synthetic account, synthetic text and a generated landscape image. They contain no real account or submission details.

![Content workspace at desktop width](design/editor-desktop.png)

![Photo studio and focal-point control](design/photo-studio.png)

![Content workspace at phone width](design/editor-mobile.png)

## Validation

The production Astro build passed. The design crawl checked home, section, story, submission, search and sign-in screens at 360, 390, 768, 1024 and 1440 pixels: **30 responsive screens and 98 checks passed**, including keyboard navigation, overflow, script errors and axe WCAG A/AA checks. All four editor panels also passed axe WCAG A/AA checks.

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Module schema and safe rendering | 14 | 0 | 0 |
| SQLite module/focus round trips | Integration passed | 0 | 0 |
| Editor browser workflow | 25 | 0 | 0 |
| Pending-save publish regression | Integration passed | 0 | 0 |
| Existing editor suite | 159 | 0 | 0 |
| Submission suite | 92 | 0 | 0 |
| Public-page suite | 37 | 0 | 4 |
| Search suite, including Chromium | 76 | 0 | 0 |
| Story import suite | 18 | 0 | 0 |
| Photo layouts/viewer, including axe | 92 | 0 | 0 |

The four skipped public-page comparison groups require a historical build baseline; they are not counted as passes. Browser and integration tests use isolated local data and mock requests. Live WordPress, SSO, email, Google Drive, production publishing and every Gmail/Outlook rendering combination were not exercised. This is a modular story editor, not a form-response, payment or conditional-logic engine.

Reproduce the key checks after `npm ci` and `npm run build`:

```bash
node scripts/test-story-blocks.mjs
node scripts/test-story-builder.mjs
PLAYWRIGHT_ROOT=/workspace/.tools/browser CHROMIUM_PATH=/usr/bin/chromium node scripts/test-story-builder-ui.mjs
PLAYWRIGHT_ROOT=/workspace/.tools/browser CHROMIUM_PATH=/usr/bin/chromium node scripts/test-editor-save-race.mjs
PLAYWRIGHT_ROOT=/workspace/.tools/browser CHROMIUM_PATH=/usr/bin/chromium AXE_JS=/workspace/.tools/a11y/node_modules/axe-core/axe.min.js node scripts/test-design-review.mjs
```

Playwright, Chromium and axe paths can be overridden for another machine; no new application dependencies were added. This branch contains code changes only and has not been deployed or merged to the production branch.
