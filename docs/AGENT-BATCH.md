# Agent API: bulk submit

`POST /api/agent/stories/batch` lets the AI agent send up to 20 stories in one request. It is the same
machine-to-machine API as `POST /api/agent/stories`: bearer `AGENT_API_TOKEN`, no CORS, nothing under `/api/admin`.
**Every story lands as a draft for a person to review. The batch cannot publish, unpublish or reject anything.**
(`GET /api/agent/stories/batch` is `405`; the static route wins over `stories/[id]`.)

## Request

```json
{
  "requestId": "backfill-2026-10-a-0001",
  "stories": [
    {
      "title": "Example Club Hosts Fall Campout",
      "dek": "A synthetic summary.",
      "body": "Synthetic body text.\n\nSecond paragraph.",
      "section": "youth",
      "area": "pathfinders",
      "church": "Example Hills Church",
      "sourceUrl": "https://www.facebook.com/example-page/posts/1001",
      "requestId": "post-1001-v1"
    },
    { "sourceUrl": "https://www.facebook.com/example-page/posts/1000", "title": "Corrected title only" }
  ]
}
```

Each item is exactly the object `POST /api/agent/stories` takes: the same validation, escaping, photo signature
checks, `{{photo N}}` marker check, announcement patches, and omission rules (an update changes only the keys it sends).
`requestId` at the top is the **batch** id and is required (8-128 letters, digits, `_`, `-`). An item may carry its own
`requestId` too.

## Response

```json
{
  "ok": true,
  "results": [
    { "index": 0, "ok": true, "id": 31, "status": "created" },
    { "index": 1, "ok": true, "id": 12, "status": "updated" },
    { "index": 2, "ok": false, "error": "bad_section", "message": "That section does not exist. ..." },
    { "index": 3, "ok": false, "error": "already_reviewed", "reason": "in_review", "id": 9, "message": "..." }
  ]
}
```

- `200` means the envelope was fine; look at each result. Results are in request order, `index` is the position in `stories`.
- `status`: `created`, `updated`, or `replayed` (the item's own `requestId` was already answered, nothing changed).
- A failed item has `error` (the same codes as the single endpoint: `bad_section`, `photo_not_image`, `title_required`, `bad_photo_marker`, ... and `invalid_json` for an item that is not an object) and `message`. `unavailable` means a temporary failure: retry.
- `already_reviewed` carries a `reason` and the draft `id`: `published` (use `POST /api/agent/stories/reopen` with the slug), `in_review` or `editor_editing` (a person has the draft; the agent cannot change it), `rejected`. `request_id_reused` on an item means that item's own `requestId` was used with different content.
- One bad item never blocks the others. Each item commits in its own transaction; photos written for an item that fails are removed.

### Whole-request errors (nothing is written)

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_json`, `bad_request_id`, `stories_invalid`, `stories_empty`, `too_many_stories`, `too_large` | Bad JSON or body, a missing or malformed batch `requestId`, `stories` not a list, empty, over 20, or the request over 40 MB |
| 401 / 503 | `unauthorized` / `not_configured` | As for every agent route |
| 409 | `request_id_reused` | This batch `requestId` was already used with a different body |
| 429 | `rate_limited` | Over 60 calls per hour (shared by all agent routes), or `reason: "batch_stories_per_hour"`: the batch would exceed the story ceiling. `Retry-After` says when. |

## Limits

- Each batch request is **one** call against the shared 60/hour limit.
- Separate ceiling: **300 stories per hour per server process**, counting every story in every batch that was attempted. If a batch would go over the remaining budget, the **whole batch** is rejected with `429` and `Retry-After` and nothing is written (no partial batch). An identical replay of an already answered batch uses no budget. `AGENT_BATCH_ITEMS_PER_HOUR` overrides the 300; it exists for tests and operations, leave it unset normally.
- Both counters are per process: a restart resets them.
- The 40 MiB body limit applies to the **whole** request, so all photos in a batch share one budget. `GET /api/agent/sections` reports `batch.maxBatchStories` (20), `batch.maxStoriesPerHour` (300) and `photoBudget` (`maxImageBytesPerRequest` is about 30 MB of image bytes per request). Photo-heavy batches must be split.

## Retry safety

The batch `requestId` is stored only as a SHA-256, with a hash of the batch content and the per-item outcome
(index, ok, draft id, status, error code, refusal reason). No story text, contact details or tokens are stored.

- Retry the **identical body** with the **same** `requestId` after a timeout: you get `200` with `"replayed": true` and the original per-item results (statuses as first answered). Nothing is written, no email is sent, no audit entry is added.
- The same `requestId` with a different body is `409 request_id_reused`. Use a new id for a new batch.
- The receipt is written after all items have committed. If the server crashes mid-batch, there is no receipt and the retry re-processes the items. That is safe because each item is idempotent: set a **`sourceUrl`** (a second send updates the same untouched draft) and, better, a per-item **`requestId`** (an identical item is answered `replayed`). Agents should set both on every item.
- A batch where an item failed with a temporary `unavailable` stores no receipt, so a retry tries again.
- For failed items (a corrected story), put them in a **new** batch with a new `requestId`; do not edit the body of an answered batch.

## What editors see

One summary email per batch that created at least one draft ("13 new drafts from the AI agent"), to the editors who
opted in under My account. It holds escaped titles and dashboard links only, no contact details. There are no per-item
emails from the batch. The audit log gets an `agent.story` entry per created or updated item (as the single endpoint
does) and one `agent.batch` entry with counts (`created`, `updated`, `replayed`, `failed`, `items`), no titles.

## Backfill recipe

1. `GET /api/agent/sections` for valid sections and areas, `photoBudget`, `batch` limits.
2. Build one object per Facebook post with `sourceUrl` (the post link), a per-item `requestId` (for example `post-<id>-v1`), and the story fields.
3. Group items into batches of up to 20, **and** so that the sum of the decoded photo sizes in a batch stays under `maxImageBytesPerRequest` (base64 adds a third; keep the whole JSON under 40 MiB). Put photo-heavy stories in small batches, or alone.
4. Send each batch with its own batch `requestId` (for example `backfill-2026-10-<n>`), one at a time. Stay under 300 stories per hour and 60 calls per hour; on `429` wait for `Retry-After`.
5. Read `results`. For `created` / `updated` / `replayed`, keep the `id`. For `already_reviewed`, do nothing more for that item (see `reason`; `published` can go through reopen). For a 400-style item error, fix the story and send it in a later batch.
6. After a timeout or network error, resend the same body with the same `requestId`.

Editors review and publish the drafts in `/admin`; nothing here publishes.
