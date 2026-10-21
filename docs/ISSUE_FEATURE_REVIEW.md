# Feature review: IMConnected #3–#38

Review range requested by the owner: **#3 through #38, inclusive**. This is a source/history inventory and the first implementation batch, not a claim that every issue is complete or that its current acceptance criteria have been read.

## Evidence and access

The GitHub connector was not exposed in this session. GitHub HTML returned 404 for IMConnected's issue list and issue #36; the existing authenticated CLI returned `Forbidden` for both GraphQL issue listing and the REST issues endpoint. Native Git access works. Consequently, live issue bodies, labels, comments and open/closed states remain unverified. The owner supplied #38's title directly: **“Search can switch to a partly built index right after an upgrade.”** No issue was edited or closed.

The public [IMSDA Events design review #1114](https://github.com/DurantTL/IMSDA-Events/issues/1114) was readable. Its transferable direction is task-focused panels, content outlines, composed private previews, labelled actions, responsive layouts, clear query scope and recovery. Its event routes, navigation decisions and registration/payment features are not IMConnected requirements.

The subsequent access diagnosis found an environment network restriction: even an unauthenticated public request to `api.github.com` fails at the proxy CONNECT step with 403. The environment's package-manager preset permits GitHub downloads but omits that API host. An additive `api.github.com` rule was saved to the environment draft for review/publication. This establishes a network blocker, not the identity or permissions of the authenticated GitHub account. Native Git fetching and pushing still work. Retry the API after the environment change applies, then check the connected account and repository permissions if necessary.

## Coverage from this checkout

“Present” means implementation evidence exists in this branch. It does not mean the corresponding live issue's full criteria have been verified. Pull requests and issues share GitHub's number sequence; merge numbers are not evidence of feature-issue requirements.

| Number(s) | Local evidence | Source-level status / follow-up |
| --- | --- | --- |
| #3–#6 | Local merges include PR #4 (Studio publishing) and PR #6 (submission protections). The actual issue metadata is unavailable. | Existing publishing/submission features can be inspected, but requirements for issues in this range are unverified. |
| #7 | `AGENTS.md` identifies the editor-dashboard epic; `/admin`, session/2FA middleware, account management, drafts and associated suites exist. | Dashboard foundation present. Current issue criteria and any remaining sign-in-provider scope need the issue text. |
| #8 | Commits `13fa9b9` and `ccaab4d` explicitly reference #8: SQLite foundation, admin shell, sessions and bootstrap. | Foundation present; preserve session, role and synthetic-data gates. |
| #9–#24 | Auth, passkeys, accounts, drafts, submissions, agent intake and Studio listing exist. Local PR merges include #15–#20 and #22–#24. | Do not infer issue IDs/titles from those PR numbers. Acceptance criteria for issues in this range are unavailable. |
| #25 | README/AGENTS identify the stories-in-the-database epic, migrations 011–015 and the five delivery stages. | SQLite source of truth, server reads, search, publishing and backups are present. |
| #26 | Commit `6a40457`, migration 011, `story-store.ts`, adoption/import code and store/import suites. | Story/photo storage present; the later architecture supersedes the original git mirror. |
| #27 | `test-public-pages.mjs` explicitly identifies issue 27; home/section/story pages and feeds use `public-stories.ts`. | Database-backed public rendering present. Historical byte comparisons are skipped; pre-redesign markup is intentionally different (see `DESIGN_REVIEW.md`). |
| #28 | `test-search.mjs` explicitly identifies issue 28; `/api/search`, FTS5 and search suites exist. | Server search present. This batch improves the visitor search interface and interaction. |
| #29 | Commit `9f4f530`, `story-publish.ts`, migration 015 and publish/live-edit suites. | Transactional database publishing present; no git-publish path. |
| #30 | Commit `bf5fcd7`, migration 014, backup scheduler/worker/restore code and mock-backed backup suite. | Backup implementation present. Real service configuration and live restore remain owner actions. |
| #31–#34 | Local merges are PR numbers for database stages, FTS search and Studio photo/excerpt delivery. | These do not establish issue titles or requirements for this range. |
| #35 | README/AGENTS and commits explicitly identify story photo layouts and click-to-enlarge; migration 016 and photo-layout/viewer suite. | Layouts/viewer present; retain the owner decision of no per-photo captions. |
| #36 | Updated AGENTS explicitly keeps `{{photo N}}` Markdown markers as planned issue #36, coexisting with the separate image-module workflow. | Inline image modules are present, but they do not complete the planned marker feature. This batch improves module selection and arrangement. |
| #37 | Local #37 is a backup PR merge, which does not establish feature-issue requirements. | Live issue content needed before assigning requirement-level completion. |
| #38 | Owner-supplied title: “Search can switch to a partly built index right after an upgrade.” Reproduced an HTTP 200 `ok: true` empty result for a unique tail match with only 50 of 121 stored stories indexed. | Implemented and tested in `6834424` on `codex/imconnected-canvas-search`, pending merge. Initial completeness gate and background catch-up cover missing/stale rows, restart, locks and failed rows without making unpublished/draft-only gaps block readiness. |

## First implementation batch

These changes follow the owner's direct request for a builder-like story editor and visible redesign. They do not depend on guessed issue titles.

| Work | Result | Verification |
| --- | --- | --- |
| Editor workspace | Library/outline at the left, composed private canvas in the center and selected-module settings at the right on desktop; explicit phone views. | Existing browser workflow plus layout, visibility and keyboard checks. |
| Module discovery | Searchable module library with result feedback and a clear path back from no matches. | Filter, no-result and reset browser checks. |
| Starter layouts | Named groups of the existing supported module types, inserted without replacing the story; unique IDs, limits and undo/redo preserved. | Insertion, ID, history and persistence checks. |
| Canvas selection | Visible selected-module state and keyboard editing affordances in the private preview, with scripts still disabled. | Pointer/keyboard selection and sandbox regression checks. |
| Story discovery | Visible search labels, section scope, reset and no-match recovery, request ordering and URL/history support. | Search browser regressions and responsive checks. |
| Upgrade search readiness (#38) | Search must not report successful results from an initial index that is only partly built. | Populated upgrade fixture larger than the repair batch, including a unique match beyond its first batch, plus existing failure/lock/restart checks. |

The module schema and SQLite migrations remain unchanged in this batch. Existing Markdown stories remain editable. All screenshots and browser fixtures use synthetic content.

## Refreshed Git baseline

At the owner's request, all three selected repositories were fetched again. IMConnected's new baseline is `main` at `d218010`, which incorporates the original redesign through `750be27` and follow-up fixes through `244a83a`: escaping, own-photo restrictions, text limits, live-edit/unescaping round trips, no-JavaScript saves, accessible control names and browser-test portability. The in-progress batch was preserved, reapplied on `codex/imconnected-canvas-search` and reconciled with those fixes. The selected utilities and tools-public `imconnected.html` files match their fetched selected branches.

## Remaining issue review

Read the current bodies/comments for #3–#38 when GitHub issue access is available, reconcile each criterion against this map and the tested branch, then prioritize the remaining bounded changes. The owner-provided #38 title supplies a concrete failure to fix; its full discussion and other unavailable issue requirements remain unverified. The source inventory also cannot establish the intended scope of missing authentication-provider work. Do not mark an issue complete solely because a similarly named capability exists.

This review does not authorize production publishing, deployment, merging, real messages or secret changes. The owner already authorized code changes and pushing the review branch.

## Delivery and completion tracking

| Delivery | Git state | Completion treatment |
| --- | --- | --- |
| Original magazine/editor redesign, modules and follow-up safety fixes | Already merged through PR #41; `main` at `d218010` when re-fetched. | Keep the merged implementation; do not open a duplicate redesign PR. |
| Canvas, library/starters, discovery and #38 readiness fix | `codex/imconnected-canvas-search`, `6834424`, pushed. | Review as one PR against `main`; #38 remains pending until merged and its live criteria are reconciled. |
| Image zoom and pan | `codex/imconnected-image-crop`, stacked on the canvas/search branch. | Separate PR for the owner's crop request. Migration 018; saved non-destructive 100–300% zoom, crop dragging/keyboard/reset, public display and reopen/feed preservation. |
| Agent API | Present on `main`; unchanged draft-only API contract. | Regression-tested against the final crop build: 201 local synthetic checks passed. No production token or endpoint used. |
| `{{photo N}}` Markdown markers (#36) | Still planned. | Image modules do not complete this feature. |
| Other issues #3–#38 | Source evidence above; live issue criteria/state unavailable. | Reconcile and mark finished only after API access and criterion-level verification. No issue was closed in this session. |

Independent review used Sol; the API explorer used Luna. The main session implemented and integrated the crop request. Tera and Fable were unavailable and were not claimed as used. Crop verification and screenshots are recorded in [the design review](DESIGN_REVIEW.md).
