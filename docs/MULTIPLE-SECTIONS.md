# Stories in multiple sections

A story keeps one primary `section` and its existing `area`, with optional `additionalSections` for discovery elsewhere. For example:

```json
{
  "section": "news",
  "area": "camp",
  "additionalSections": ["youth"]
}
```

This story appears under News, News → Camp, and Youth & Pathfinders. It does not acquire a Youth area such as Pathfinders. The story has one canonical `/stories/<slug>/` address, one database row and one feed/search entry. Extra assignments do not duplicate it in all-story lists. Its public article links to the primary section/category and its additional sections.

## Editor

Open **Story settings**, choose the primary Section and Category, and check **Additional sections**. The primary section is checked and disabled in that list because it is already assigned above. Changing the primary selector moves that disabled state and retains the prior checked membership as an extra; uncheck it if it no longer applies. Save and human publication rules are unchanged. The saved assignments are part of revision history and survive reopening a published story.

The editor's Section filter matches both primary and extra memberships. Public section listings, section counts, Studio's published/draft Section filter and search's section filter use the same memberships. Area pages require the corresponding primary section, so a Camp category is never mistaken for a Youth subcategory.

Dashboard **bulk edit** (`/admin/bulk`, issue #89) changes only the ticked fields. Changing the primary section there does not turn the old primary into an extra (the editor's selector does); the new primary is dropped from the extras, and adding or removing extras follows the same normalization. A bulk-edited live story also updates its linked closed draft, so a later unpublish and publish keeps the edit.

## Agent and Studio contracts

`POST /api/agent/stories` accepts `additionalSections` beside the existing `section`/`area`. Explicit `POST /api/agent/stories/reopen` accepts it inside `changes`. The field is a list of the existing central section keys: `news`, `features`, `columns`, `youth`, `kids`.

- Omission preserves current extras when updating an existing draft/story through an older client. New stories default to no extras.
- An explicit `[]` clears extras. `null`, strings, unknown keys and non-string entries are rejected.
- Duplicates and the primary section are removed, and storage uses central section order. Section definitions still live only in `src/lib/site.ts`.
- The existing agent restrictions remain: submissions/reopened drafts require editorial review and the agent cannot publish or read private draft content.

Studio's existing `POST /api/publish` accepts this same field on each story. An older Studio republish that omits it retains the current published memberships. Closed linked drafts receive the effective published assignments; an open draft still holding an editor's work remains protected. This change does not add a multi-section control to the standalone newsletter builders.

`GET /api/agent/sections` advertises the field and semantics. Version-1 `/stories.json` and Studio list items add an `additionalSections` array; `section`, `sectionLabel`, `area` and `areaLabel` retain their existing meaning. RSS includes an extra `<category>` for each additional section. The public submission form remains a single initial section choice; editors can add assignments during review.

## Storage and import

Migration 024 adds bounded JSON arrays on existing `stories`/`drafts` tables, defaulting existing rows to `[]`. No content is duplicated or moved. The store, publication transaction and revisions normalize assignments before writing. The frozen Markdown archive remains frozen. During one-time adoption, omitted metadata preserves an existing row's assignments; an explicit empty list clears them. Inheritance is resolved under the story's write lock and the content hash represents the effective canonical memberships, so retries do not repeatedly rewrite inherited assignments.

The standalone importer supports optional front matter `additionalSections: [youth]`. Missing front matter preserves an existing row's extras; `additionalSections: []` explicitly clears them. Invalid lists are refused before writes. Follow the existing human approval/backup rules before applying an import to real data.

## Verification

After building, `node scripts/test-additional-sections.mjs` starts an isolated built server on localhost:4881 and uses synthetic data only. With the Playwright environment from `DESIGN_REVIEW.md`, it also exercises the actual editor checkboxes, saving, accessibility and phone layout. It checks migration defaults, invalid and duplicate inputs, omitted/empty assignments, human publication, public/area/search discovery, feeds, agent reopening, Studio compatibility, revision restore and archive import. `node scripts/test-section-adoption.mjs` separately exercises the real adoption/store code with only its database and built-content inputs redirected to synthetic fixtures, checking omitted/empty/replaced metadata and stable effective hashes without editing or rebuilding the archive. Production credentials, data, publications and external services are never used.

## Columns merged into Features (issue #136)

There is no `columns` section. Features covers longer stories, testimonies and regular voices; column names are retired (migration 036 emptied them and nothing reads or shows one; a `column` input is ignored). Clients that still send `section: "columns"` (or `"columns"` inside `additionalSections`, bulk edit lists, a restored revision or an archive file) are accepted and read as `features`. Migration 036 moved existing rows. `GET /api/agent/sections` no longer lists `columns`. `/columns/...` redirects (301) to `/features/...`.
