# Reopen a published story for an agent update

`POST /api/agent/stories/reopen` lets the communication director's AI agent propose additions to a **currently public** story, announcement or event. It copies the current published version into the linked draft and sets it to **In review**. The live story, photos, feeds and search stay unchanged until an editor reviews and publishes the update. This endpoint never publishes, unpublishes or rejects anything.

Use the existing `AGENT_API_TOKEN` bearer token, different from `PUBLISH_TOKEN`. The route is machine-to-machine, has no browser CORS grant or cookie authentication, and shares the existing 60 requests/hour agent limit (counted per server process, shared with every `/api/agent/*` route). JSON is limited to 40 MiB, which is about 30 MB of image bytes after base64 (`photoBudget.maxImageBytesPerRequest` in `GET /api/agent/sections`). Alt text is cut to 300 characters. The agent can read back only its own `source: agent` drafts through `GET /api/agent/stories/<id>` (whitelisted fields, never contacts, notes, paths or uploads); `POST .../reopen` itself is POST-only.

## Request

```http
POST /api/agent/stories/reopen
Authorization: Bearer <AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "slug": "2026-10-22-synthetic-community-gathering",
  "requestId": "synthetic-gathering-photos-v1",
  "note": "Additional synthetic photos for editorial review.",
  "photos": [
    {
      "data": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=",
      "alt": "Synthetic additional photo placeholder."
    }
  ]
}
```

- `slug` is the existing public story's slug, the part after `/stories/` in its address. This works for all public stories, including material originally published by a human or Studio. Hidden/draft-only, unpublished and nonexistent stories return 404.
- `requestId` is required: 8–128 ASCII letters, digits, underscores or hyphens. Choose a unique value for this proposed update. Keep it and the **exact JSON request body** for retries. The server stores only hashes, a draft ID and timestamp in its receipt.
- `photos` is an optional list of **new images to append**. Omission or `[]` adds none. Each photo may carry `focalX`, `focalY` (0 to 100, default 50) and `zoom` (1 to 3, default 1), stored as the editor stores them; anything else is `400 bad_photo_crop`. Per-photo `fit` and `caption` are planned (issues #82 and #84) and are not accepted yet. Existing photos remain in order, with their original alt text, focal position and zoom. The existing lead flyer is retained. There may be at most six photos in total. Photos use the same signature-validated JPG/PNG/WebP/AVIF data URLs as initial submissions, up to 10 MiB each; remote URLs, SVG, PDF and raw HTML are rejected. The server never downloads an image URL.
- `note` optionally replaces the private agent note for the editors; omission preserves it. It is not returned in the response, logged or added to public content.
- `changes` is optional. Omitted editorial fields keep their current **published** values. Supported keys are `title`, `dek`, `body`, `section`, `area`, `author`, `authorTitle`, `church`, `date`, `photoCredit`, `photoLayout`, `featured`, `announcement` and `additionalSections`. Other keys are rejected. Use the same field limits, Markdown escaping, section/area, layout and announcement validation as `POST /api/agent/stories`.
- **`announcement` is a patch.** An object is merged into the story's current announcement: only the keys you send change. `""` clears an optional text field (`eventDate`, `location`, `videoUrl`); `links` present replaces the whole list; omitted keys keep their values; `announcement: null` removes it (the story becomes an ordinary story). `kind` is required only when the story has no announcement yet. The merged result is validated with the usual announcement rules, so a patch that would leave an invalid announcement is `400 bad_announcement` and nothing is created.
- **`authorTitle`, `photoCredit` and `featured`** are saved on the draft only (an editor still reviews and publishes). `authorTitle` and `photoCredit` are one-line text of at most 120 characters (the publish step keeps 120), `""` clears them; `featured` must be `true` or `false` (`400 bad_field` otherwise). Omitted = the published value is kept.
- **Section-only changes.** `changes.section` without `changes.area` moves the story to the new section's default area: its first listed area (for example `youth` for the Youth section), or no area when the section has none (Features, Kids). An area that is still valid for the section (re-sending the current section) is kept. An explicit `area` that does not belong to the section is still `400 bad_area`. This differs on purpose from `POST /api/agent/stories` (update by `sourceUrl`), where a section change that leaves the stored area invalid is `400 bad_area` until the request also sends `area`.
- **`{{photo N}}` markers.** A standalone `{{photo N}}` line in `changes.body` places photo N (1 = the lead) inline. After the request the story has its existing photos plus the appended ones; a marker past that count is `400 bad_photo_marker` naming it. Markers in code fences, indented code, code spans, quotes or lists, escaped (`\{{photo 9}}`) or in the middle of a sentence stay literal text and are not checked.

For example, an event was published with the wrong place. Send only the location; the date, buttons, video and flyer stay as published:

```json
{
  "slug": "2026-10-22-synthetic-community-gathering",
  "requestId": "synthetic-gathering-location-v3",
  "changes": { "announcement": { "location": "Synthetic Community Center, Room 4" } }
}
```

To propose a new event date, location and registration link in one request (the `links` list is replaced as a whole):

```json
{
  "slug": "2026-10-22-synthetic-community-gathering",
  "requestId": "synthetic-gathering-details-v2",
  "changes": {
    "announcement": {
      "kind": "event",
      "eventDate": "2026-12-02",
      "location": "Synthetic Hall",
      "links": [{ "label": "Registration details", "url": "https://example.invalid/register" }],
      "videoUrl": "https://www.youtube.com/watch?v=abcdefghijk"
    }
  }
}
```

`changes.body` replaces the Markdown body on a Markdown story. A story built with editor modules returns `409 module_body_conflict` if `body` is included: omit it to retain the modules and their photo references, or ask an editor to revise those modules. New photos become available in Photo studio; for a module story, the editor chooses their placement before publishing. The agent cannot create or replace modules, remove/reorder existing images or replace the flyer through this endpoint.

## Responses and safe retries

First acceptance:

```json
{
  "ok": true,
  "id": 12,
  "status": "reopened",
  "requiresReview": true,
  "url": "https://<your-site>/admin/drafts/12"
}
```

This is HTTP 201. An identical retry returns HTTP 200 with the same ID and `status: "replayed"`; it does not append photos, reset editor work, create another audit entry or send another notification. This remains true after an editor changes or publishes that draft. A replay receipt acknowledges the earlier request; it does not describe the draft's current status or reapply it.

| Status | Error | Action |
| --- | --- | --- |
| 400 | `bad_slug`, `bad_request_id`, `bad_field`, `bad_announcement`, `bad_photo_crop`, `bad_photo_marker`, `bad_area`, `author_title_too_long`, `photo_credit_too_long`, existing photo/content validation codes | Fix the request. |
| 401 | `unauthorized` | Check the agent bearer token. |
| 404 | `story_not_found` | Use a currently public story slug. |
| 409 | `already_reviewed` | A draft for this story already exists and is not published; no draft is overwritten. The response also has `reason`, `id` and a `message`: `in_review`, `rejected`, `editor_editing` (status new but an editor touched it) or `open_draft_exists` (new and untouched). |
| 409 | `request_id_reused` | That ID was used with different JSON; retry the original body or use a new ID for a distinct update. `reason` repeats the code. |
| 409 | `module_body_conflict` | Omit `body` to preserve editor modules. `reason` repeats the code. |
| 429 | `rate_limited` | Wait for `Retry-After` (shared agent rate window). |
| 503 | `not_configured`, `unavailable` | Check configuration, or retry the identical body/ID after a transient failure. |

Every 409 carries `message` saying what to do next; for `already_reviewed`, `id` is the draft's id only when that draft came from the agent, otherwise `null`. A published story that was later unpublished is refused with `reason: "published"` but a message saying it cannot be reopened. The create/update route (`POST /api/agent/stories`) answers its own refusals the same way with `reason` `published`, `in_review`, `editor_editing` or `rejected`; for `published` its message points here, naming the slug.

Concurrent identical requests are serialized into one accepted mutation and replay receipts. A different request cannot overwrite the resulting In review draft, even if no editor has opened it yet. After the editor publishes it, another distinct update can reopen the latest published version with a new requestId. The original `POST /api/agent/stories` remains idempotent by sourceUrl for untouched new submissions; it does not reopen published material automatically.

Each accepted reopen records an `agent.reopen` audit entry with the draft ID and result only. Editor notifications are best effort and use the existing opt-in submission-notification path. Existing linked drafts keep their source and private submission details; a new linked draft has source `agent`. Those private details are never sent to the agent. Files, draft rows, receipt and audit are handled atomically; superseded uploads are removed only after commit, and failed requests remove newly written files.

Synthetic verification after building: `node scripts/test-agent-reopen.mjs`. The suite uses a disposable SQLite database and local server only.
