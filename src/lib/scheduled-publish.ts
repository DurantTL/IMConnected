// Scheduled publishing (issue #124). A person chooses a time on the draft's Review and publish tab; the server only
// carries that decision out later. Nothing here ever decides to publish by itself, and the AI agent can only suggest a
// time (drafts.suggested_publish_at): it can never schedule.
//
// How it runs: src/lib/schedule-start.ts (imported by the server entry, like backup-start.ts) starts ONE unref'd timer that
// wakes every SCHEDULE_CHECK_MS (default one minute). Each wake is one cheap indexed query; a due draft is taken with an
// atomic claim (drafts.publish_claimed_at), so two processes on the same data never publish the same draft, and a claim
// older than CLAIM_STALE_MS is treated as abandoned. The publish itself is `publishDraftItem`, the code behind the Publish
// button: one transaction, one `draft.publish` audit entry (actor = the person who scheduled, detail.scheduled = true), the
// submitter email of issue #121, cache invalidation. A failure leaves the draft scheduled, records an error code (never a
// message or secret) and audits it; after MAX_FAILURES failed attempts the scheduler stops until an editor reschedules.
//
// Draft revisions: publish_at is NOT part of the editorial whitelist in draft-revisions.ts. Scheduling is an action, not
// editorial state: restoring an older revision must never silently schedule, unschedule or reschedule a publish.
import { getDb } from './db';
import { audit } from './auth/audit';
import { ERRORS, type ErrorCode } from './messages';
import { getDraft, isEditable, takeVersion, tx, fail, type OpResult } from './drafts';
import { publishDraftItem } from './bulk-actions';

export const SCHEDULE_ZONE = 'America/Chicago';
export const MAX_FAILURES = 3;
export const CLAIM_STALE_MS = 5 * 60_000;
const MAX_AHEAD_MS = 366 * 24 * 3600_000;

// ---------- America/Chicago time ----------

const partsOf = (ms: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) };
};

/** "2026-11-02T08:30" (a datetime-local value, Central Time) to ms, or null when it is malformed or does not exist (the spring-forward gap). */
export function chicagoLocalToMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Find the UTC instant whose Chicago wall clock reads this time; two passes settle the daylight-saving offset.
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = partsOf(guess);
    guess -= Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - wall;
  }
  const back = partsOf(guess);
  return back.y === y && back.mo === mo && back.d === d && back.h === h && back.mi === mi ? guess : null;
}

/** A well-formed Central Time that does not exist (the hour skipped when the clocks spring forward). */
export function isChicagoGap(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  // A day that is not on the calendar (Feb 30) or an hour/minute out of range is malformed, not a gap.
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59) return false;
  return chicagoLocalToMs(value) === null;
}

/** The value for a datetime-local input, in Central Time. */
export function msToChicagoInput(ms: number): string {
  const p = partsOf(ms);
  const z = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${z(p.y, 4)}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

/** "Mon, Nov 2, 2026, 8:30 AM CST" (always Central Time, CDT or CST as it applies, never the viewer's own zone). */
export function fmtChicago(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_ZONE, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
}

// ---------- a person's actions ----------

function checkTime(ms: number | null, now: number): ErrorCode | null {
  if (ms === null || !Number.isFinite(ms)) return 'schedule_bad';
  if (ms <= now) return 'schedule_past';
  if (ms > now + MAX_AHEAD_MS) return 'schedule_far';
  return null;
}

/**
 * Schedule an open draft. Version-checked like every dashboard action (the version moves forward, so a second tab with the
 * old page is refused), audited in the same transaction. Rescheduling resets the failure count and any earlier error.
 */
export function scheduleDraft(id: number, expected: number, userId: number, publishAt: number | null, ip: string, source: 'chosen' | 'suggestion' = 'chosen', now = Date.now()): OpResult {
  const bad = checkTime(publishAt, now);
  if (bad) return fail('invalid', bad);
  return tx((): OpResult => {
    const cur = getDraft(id);
    if (!cur) return fail('invalid', 'draft_gone');
    if (!isEditable(cur)) return fail('locked', 'closed');
    if (cur.studioOverwroteAt !== null) return fail('invalid', 'schedule_studio_overwrote');
    const v = takeVersion(id, expected, userId);
    if (v === null) return fail('conflict', 'conflict');
    getDb().prepare('UPDATE drafts SET publish_at = ?, publish_at_by = ?, publish_claimed_at = NULL, publish_fail_count = 0, publish_error = NULL, publish_error_at = NULL WHERE id = ?').run(publishAt, userId, id);
    audit('draft.schedule', { userId, target: `draft:${id}`, detail: { publishAt: new Date(publishAt!).toISOString(), rescheduled: cur.publishAt !== null, from: source }, ip });
    return { ok: true, updatedAt: v };
  });
}

/** Remove a schedule. Not scheduled = nothing changes (no version bump, no audit entry). */
export function unscheduleDraft(id: number, expected: number, userId: number, ip: string): OpResult {
  return tx((): OpResult => {
    const cur = getDraft(id);
    if (!cur) return fail('invalid', 'draft_gone');
    if (!isEditable(cur)) return fail('locked', 'closed');
    if (cur.publishAt === null) return { ok: true, updatedAt: cur.updatedAt, noop: true };
    const v = takeVersion(id, expected, userId);
    if (v === null) return fail('conflict', 'conflict');
    getDb().prepare('UPDATE drafts SET publish_at = NULL, publish_at_by = NULL, publish_claimed_at = NULL, publish_fail_count = 0, publish_error = NULL, publish_error_at = NULL WHERE id = ?').run(id);
    audit('draft.unschedule', { userId, target: `draft:${id}`, detail: { was: new Date(cur.publishAt).toISOString() }, ip });
    return { ok: true, updatedAt: v };
  });
}

// ---------- the scheduler ----------

const DUE_SQL = `publish_at IS NOT NULL AND publish_at <= ? AND status IN ('new', 'in_review') AND publish_fail_count < ${MAX_FAILURES} AND (publish_claimed_at IS NULL OR publish_claimed_at < ?)`;

/** Failures that are no use retrying: the scheduler stops at once (the failure count jumps to the limit) until an editor reschedules. */
export const STOP_AT_ONCE: ReadonlySet<string> = new Set(['schedule_owner_inactive', 'schedule_studio_overwrote']);

/** Three tries, then an editor must look: every failed attempt is counted, whatever the reason (except the stop-at-once codes, which end it immediately). */
function recordFailure(id: number, userId: number | null, code: ErrorCode, now: number): void {
  try {
    tx(() => {
      const r = getDb().prepare(`UPDATE drafts SET publish_claimed_at = NULL, publish_fail_count = ${STOP_AT_ONCE.has(code) ? MAX_FAILURES : 'publish_fail_count + 1'}, publish_error = ?, publish_error_at = ? WHERE id = ? AND publish_at IS NOT NULL AND status IN ('new', 'in_review')`).run(code, now, id);
      if (Number(r.changes) === 1) audit('draft.schedule_failed', { userId, target: `draft:${id}`, detail: { code }, ip: 'scheduler' });
    });
  } catch (err) {
    console.error('[schedule] could not record a failed scheduled publish', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
  }
}

export interface DueResult { published: number; failed: number }

/** Publish every due scheduled draft once. Safe to call from several processes at once: each draft is claimed atomically. */
export async function runDueScheduledPublishes(now = Date.now()): Promise<DueResult> {
  const db = getDb();
  const out: DueResult = { published: 0, failed: 0 };
  const due = db.prepare(`SELECT id FROM drafts WHERE ${DUE_SQL} ORDER BY publish_at, id LIMIT 20`).all(now, now - CLAIM_STALE_MS) as { id: number }[];
  for (const { id } of due) {
    // The claim: only one process changes publish_claimed_at from NULL (or a stale value) for a still-due draft.
    const at = Date.now(); // per draft, not the batch start: a long run must not stamp a stale claim time
    const claim = db.prepare(`UPDATE drafts SET publish_claimed_at = ? WHERE id = ? AND ${DUE_SQL}`).run(at, id, at, at - CLAIM_STALE_MS);
    if (Number(claim.changes) !== 1) continue;
    let code: ErrorCode = 'publish_failed';
    let by: number | null = null;
    let ok = false;
    let uncounted = false;
    try {
      // An edit after scheduling keeps the schedule, so publish the version that is current at this moment. A save landing
      // between the read and the publish is a version conflict: read again (a few times) rather than count it as a failure.
      for (let attempt = 0; attempt < 3; attempt++) {
        uncounted = false;
        const draft = getDraft(id);
        if (!draft || !isEditable(draft)) { code = 'not_publishable'; break; }
        // Unscheduled or rescheduled to later while we were working: never publish early. Not a failure.
        if (draft.publishAt === null || draft.publishAt > Date.now()) { uncounted = true; break; }
        by = draft.publishAtBy;
        if (draft.studioOverwroteAt !== null) { code = 'schedule_studio_overwrote'; break; } // belt and braces: Studio's live version must never be overwritten
        // A schedule runs only while the person who set it can still sign in.
        const owner = by === null ? undefined : (db.prepare('SELECT status FROM users WHERE id = ?').get(by) as { status: string } | undefined);
        if (!owner || owner.status !== 'active') { code = 'schedule_owner_inactive'; break; }
        if (attempt === 0) await testDelay(); // tests only: widens the window between the checks above and the publish
        const r = await publishDraftItem(id, draft.updatedAt, by!, 'scheduler', { scheduled: { now: Date.now() } });
        if (r.ok) { ok = true; break; }
        code = r.code;
        if (r.code === 'schedule_not_due') { uncounted = true; break; }
        if (r.code === 'conflict' || r.code === 'already_publishing') { uncounted = true; if (r.code === 'already_publishing') break; continue; }
        break;
      }
    } catch (err) {
      uncounted = false;
      console.error('[schedule] scheduled publish threw', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
    if (ok) out.published++;
    else if (uncounted) {
      // Lost a race with an editor's save or another publish: not a failure. Release the claim; the next check tries again.
      db.prepare('UPDATE drafts SET publish_claimed_at = NULL WHERE id = ? AND publish_at IS NOT NULL').run(id);
    } else {
      out.failed++;
      recordFailure(id, by, code, Date.now());
    }
  }
  return out;
}

/** SCHEDULE_TEST_PUBLISH_DELAY_MS: a test-only pause between the scheduler's checks and the publish. Never read in production. */
async function testDelay(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  const n = Number(process.env.SCHEDULE_TEST_PUBLISH_DELAY_MS);
  if (Number.isFinite(n) && n > 0) await new Promise((r) => setTimeout(r, Math.min(n, 10_000)));
}

export const errorTextFor = (code: string | null): string => (code && Object.hasOwn(ERRORS, code) ? ERRORS[code as ErrorCode] : ERRORS.publish_failed);

const checkMs = (env = process.env) => {
  const n = Number(env.SCHEDULE_CHECK_MS);
  return Number.isFinite(n) && n >= 50 ? n : 60_000;
};

let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await runDueScheduledPublishes();
  } catch (err) {
    console.error('[schedule] check failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
  } finally {
    busy = false;
  }
}

/** Starts the one unref'd timer (idempotent). Called by schedule-start.ts at server start; never during a build. */
export function ensureScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), checkMs());
  timer.unref?.();
  const first = setTimeout(() => void tick(), Math.min(5000, checkMs()));
  first.unref?.();
}
