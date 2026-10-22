# Reopen a published story for an agent update

`POST /api/agent/stories/reopen` lets the communication director's AI agent propose additions to a **currently public** story, announcement or event. It copies the current published version into the linked draft and sets it to **In review**. The live story, photos, feeds and search stay unchanged until an editor reviews and publishes the update. This endpoint never publishes, unpublishes or rejects anything.

Use the existing `AGENT_API_TOKEN` bearer token, different from `PUBLISH_TOKEN`. The route is machine-to-machine, has no browser CORS grant or cookie authentication, and shares the existing 60 requests/hour agent limit. JSON is limited to 40 MiB. No agent read access to private drafts or uploads is added.

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
- `photos` is an optional list of **new images to append**. Omission or `[]` adds none. Existing photos remain in order, with their original alt text, focal position and zoom. The existing lead flyer is retained. There may be at most six photos in total. Photos use the same signature-validated JPG/PNG/WebP/AVIF data URLs as initial submissions, up to 10 MiB each; remote URLs, SVG, PDF and raw HTML are rejected. The server never downloads an image URL.
- `note` optionally replaces the private agent note for the editors; omission preserves it. It is not returned in the response, logged or added to public content.
- `changes` is optional. Omitted editorial fields keep their current **published** values. Supported keys are `title`, `dek`, `body`, `section`, `area`, `author`, `church`, `date`, `photoLayout`, `announcement` and `additionalSections`. Other keys are rejected. Use the same field limits, Markdown escaping, section/area, layout and announcement validation as `POST /api/agent/stories`. Send a complete replacement announcement object, including the buttons/video to keep; `announcement: null` explicitly turns it into an ordinary story.

For example, to propose a new event date, location and registration link:

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
| 400 | `bad_slug`, `bad_request_id`, `bad_field`, existing photo/content validation codes | Fix the request. |
| 401 | `unauthorized` | Check the agent bearer token. |
| 404 | `story_not_found` | Use a currently public story slug. |
| 409 | `already_reviewed` | An open or rejected draft already exists; ask an editor to finish/review it. No draft is overwritten. |
| 409 | `request_id_reused` | That ID was used with different JSON; retry the original body or use a new ID for a distinct update. |
| 409 | `module_body_conflict` | Omit `body` to preserve editor modules. |
| 429 | `rate_limited` | Wait for `Retry-After` (shared agent rate window). |
| 503 | `not_configured`, `unavailable` | Check configuration, or retry the identical body/ID after a transient failure. |

Concurrent identical requests are serialized into one accepted mutation and replay receipts. A different request cannot overwrite the resulting In review draft, even if no editor has opened it yet. After the editor publishes it, another distinct update can reopen the latest published version with a new requestId. The original `POST /api/agent/stories` remains idempotent by sourceUrl for untouched new submissions; it does not reopen published material automatically.

Each accepted reopen records an `agent.reopen` audit entry with the draft ID and result only. Editor notifications are best effort and use the existing opt-in submission-notification path. Existing linked drafts keep their source and private submission details; a new linked draft has source `agent`. Those private details are never sent to the agent. Files, draft rows, receipt and audit are handled atomically; superseded uploads are removed only after commit, and failed requests remove newly written files.

Synthetic verification after building: `node scripts/test-agent-reopen.mjs`. The suite uses a disposable SQLite database and local server only.
