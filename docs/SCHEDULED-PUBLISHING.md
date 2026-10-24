# Scheduled publishing and the agent's suggested time (issue #124)

Publishing stays a person's action. A person schedules a draft; the server only carries that decision out later. The AI agent can
only **suggest** a time; it can never schedule or publish.

## In the dashboard

On a draft's Publish tab (in the editor sidebar), under the Publish button, **Publish at a set time** takes a date and time. Times are always
America/Chicago (Central Time), shown and entered in that zone, whatever the viewer's own zone. A time that has passed, that is
more than a year away, or that does not exist (the spring-forward hour) is refused.

- Scheduling and unscheduling are version-checked (a stale page is a conflict) and audited as `draft.schedule` and
  `draft.unschedule` (detail: the time, whether it was a reschedule, and whether it came from the agent's suggestion).
- The draft shows "Scheduled for ..." and can be unscheduled, rescheduled, or published now.
- Editing a scheduled draft keeps its schedule. The scheduled publish uses the version that is current when it runs.
- Rejecting a draft, publishing it (by hand or from the schedule), **unpublishing its story** (single or bulk) and a **Studio publish
  over its story** all clear the schedule; the last two audit `draft.unschedule` with `reason` `unpublished` / `studio_publish`.
  Publishing also clears the agent's suggestion. A rejected draft, or one Studio has published over, cannot be scheduled.
- Times are shown with CDT or CST as it applies. A time that does not exist (the hour skipped when the clocks spring forward) is
  refused with its own message.
- The inbox shows each scheduled draft's time and has a **Scheduled** status filter.
- Draft revisions do **not** include the schedule (or the suggestion). Scheduling is an action, not editorial state, so restoring
  an older revision never schedules, unschedules or reschedules anything.

## The scheduler

`src/lib/schedule-start.ts` (imported by the server entry through the plugin in `astro.config.mjs`, like `backup-start.ts`; never
loaded by a build or prerender) starts one unref'd timer. Every minute (`SCHEDULE_CHECK_MS`, minimum 50 ms, for tests; first
check after `SCHEDULE_START_DELAY_MS`, default 20 s) it publishes due drafts through `publishDraftItem`, the code behind the
Publish button: one transaction, one `draft.publish` audit entry whose actor is the person who scheduled it and whose detail
has `scheduled: true`, the submitter email of issue #121, and cache invalidation.

- **Atomic claim:** a due draft is taken with `UPDATE ... SET publish_claimed_at` in a single statement, so two processes on the
  same data never publish it twice. A claim older than 5 minutes is treated as abandoned (a crashed process).
- **The owner must still be active:** a schedule runs only while the person who set it is an active user. Otherwise it fails at
  once with `schedule_owner_inactive` ("The person who scheduled this can no longer sign in; schedule it again"), with no retries.
  The scheduler likewise refuses at once (`schedule_studio_overwrote`) if Studio has published over the draft.
- **Not a failure:** losing a race with an editor's save or another publish (`conflict`, `already_publishing`) releases the claim
  and tries again on the next check without counting.
- **Failure:** the draft stays scheduled, shows "Scheduled publish failed" with the plain-language reason, and
  `publish_error` holds the stable error code only (never a message or secret). Each failed attempt is audited
  (`draft.schedule_failed`, detail `{ code }`). After 3 failures the scheduler stops until an editor reschedules (which resets the
  count). A save landing mid-publish (a version conflict) is re-read and retried without counting as a failure.
- Migration 035 adds `drafts.publish_at`, `publish_at_by`, `publish_claimed_at`, `publish_fail_count`, `publish_error`,
  `publish_error_at` and `suggested_publish_at`.

## AI agent: `suggestedPublishAt`

An ISO 8601 date-time **with an offset** (`Z` or `+/-hh:mm`), for example `"2026-11-02T08:00:00-06:00"`.

- Accepted on `POST /api/agent/stories` (create, and update of a new untouched draft), on every item of
  `POST /api/agent/stories/batch`, and in `changes` of `POST /api/agent/stories/reopen`.
- Omitted keeps the stored suggestion; `null` clears it.
- Anything else (no offset, a date only, text, an impossible day, a time in the past or more than a year away) is
  `400 bad_publish_at`. In a batch only that item fails. The format is checked first; the "future, within a year" rule is checked
  only when a NEW request is written, after any `requestId` receipt lookup. So an identical retry of an accepted create, update,
  batch item, batch or reopen is acknowledged (`replayed`) even if the suggested time has since passed.
- Stored as `suggested_publish_at` (ms). Read-back (`GET /api/agent/stories/<id>`) returns `suggestedPublishAt` as an ISO UTC string
  or `null`. `GET /api/agent/sections` documents the field.
- The editor shows "AI agent suggests publishing at ..." with a **Schedule for this time** button. Clicking it is the person's
  version-checked action; nothing is scheduled until then.
