// Newsletter issues (issue #98, migration 028). A story or draft may record the IMConnected newsletter issue it first appeared in
// (`newsletterIssue`: the issue number plus its position in that issue). The issue itself (its date, the day it was sent, and an
// optional title) lives once in `newsletter_issues`. No contact details are stored here.
import { getDb } from './db';
import { audit } from './auth/audit';
import { clean, validDate } from './storyfile';
import { conferenceDay } from './event-spotlight';
import { invalidateStories } from './public-cache';

export const ISSUE_MAX = 9999;
export const POSITION_MAX = 999;

/** A story's or draft's issue reference. `date` and `title` are filled in when it is read back (joined from newsletter_issues). */
export interface NewsletterRef { number: number; position: number | null; date?: string; title?: string }

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const validIssueNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ISSUE_MAX;
export const validPosition = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= POSITION_MAX;
/** A real calendar day that is not in the future (the America/Chicago day, like the site's other dates). */
export const validIssueDate = (v: unknown): v is string => validDate(v) && v <= conferenceDay();

type Row = Record<string, unknown>;

/** The reference stored on a draft or story row (columns newsletter_issue, newsletter_position, plus the joined issue_date / issue_title). */
export function refFromRow(r: Row): NewsletterRef | null {
  if (r.newsletter_issue === null || r.newsletter_issue === undefined) return null;
  return {
    number: Number(r.newsletter_issue),
    position: r.newsletter_position === null || r.newsletter_position === undefined ? null : Number(r.newsletter_position),
    ...(typeof r.issue_date === 'string' ? { date: r.issue_date, title: typeof r.issue_title === 'string' ? r.issue_title : '' } : {}),
  };
}

/** Only what is stored per story/draft (the issue's own date and title are not part of an editorial snapshot). Null for anything malformed. */
export function normalizeRef(v: unknown): NewsletterRef | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!validIssueNumber(o.number)) return null;
  return { number: o.number, position: validPosition(o.position) ? o.position : null };
}

export interface NewsletterIssue { number: number; date: string; title: string; createdAt: number; updatedAt: number }

const toIssue = (r: Row): NewsletterIssue => ({ number: Number(r.number), date: String(r.date), title: String(r.title), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });

export function getIssue(number: number): NewsletterIssue | null {
  const r = getDb().prepare('SELECT * FROM newsletter_issues WHERE number = ?').get(number) as Row | undefined;
  return r ? toIssue(r) : null;
}
export const issueExists = (number: number) => !!getDb().prepare('SELECT 1 FROM newsletter_issues WHERE number = ?').get(number);

/** Newest issue number first. */
export function listIssues(): NewsletterIssue[] {
  return (getDb().prepare('SELECT * FROM newsletter_issues ORDER BY number DESC').all() as Row[]).map(toIssue);
}

/** Issues with how many stories and OPEN (new or in review) drafts reference each (admin page). */
export function listIssuesWithCounts(): (NewsletterIssue & { stories: number; drafts: number })[] {
  const rows = getDb().prepare(`SELECT i.*,
      (SELECT COUNT(*) FROM stories s WHERE s.newsletter_issue = i.number) AS story_count,
      (SELECT COUNT(*) FROM drafts d WHERE d.newsletter_issue = i.number AND d.status IN ('new', 'in_review')) AS draft_count
    FROM newsletter_issues i ORDER BY i.number DESC`).all() as Row[];
  return rows.map((r) => ({ ...toIssue(r), stories: Number(r.story_count), drafts: Number(r.draft_count) }));
}

export type IssueResolution = { ok: true; ref: NewsletterRef } | { ok: false; code: 'newsletter_issue_conflict'; message: string };

/**
 * The agent's `{ number, date, title?, position? }` against the stored issues. Call INSIDE the transaction that writes the draft:
 * an unknown number creates the issue row there (so a failed draft write leaves no issue behind); a known number is reused only
 * when the date matches and a non-empty title matches too. An existing issue is never changed.
 */
export function resolveIssueInput(input: { number: number; date: string; title: string; position: number | null }): IssueResolution {
  const db = getDb();
  const cur = getIssue(input.number);
  if (!cur) {
    const now = Date.now();
    db.prepare('INSERT INTO newsletter_issues (number, date, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(input.number, input.date, input.title, now, now);
    return { ok: true, ref: { number: input.number, position: input.position } };
  }
  if (cur.date !== input.date) return { ok: false, code: 'newsletter_issue_conflict', message: `Issue #${cur.number} is already recorded with the date ${cur.date}, not ${input.date}. Nothing was changed; an administrator can correct the issue.` };
  if (input.title && input.title !== cur.title) return { ok: false, code: 'newsletter_issue_conflict', message: `Issue #${cur.number} is already recorded with the date ${cur.date} and ${cur.title ? 'a different title' : 'no title'}. Nothing was changed; an administrator can correct the issue.` };
  return { ok: true, ref: { number: input.number, position: input.position } };
}

export type IssueEditResult = { ok: true; updatedAt: number } | { ok: false; reason: 'gone' | 'conflict' | 'invalid' | 'in_use'; message: string };

function inIssueTx<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Administrator edit of an issue's date and title, version-checked (`expected` = the updatedAt the form was loaded with) and audited. */
export function updateIssue(number: number, expected: number, f: { date: string; title: string }, userId: number): IssueEditResult {
  const date = f.date.trim();
  const title = clean(f.title).replace(/\s+/g, ' ').trim();
  if (!validIssueDate(date)) return { ok: false, reason: 'invalid', message: 'The date must be a real day that is not in the future, like 2026-09-14.' };
  if (title.length > 200) return { ok: false, reason: 'invalid', message: 'The title is longer than 200 characters.' };
  const result = inIssueTx((): IssueEditResult => {
    const cur = getIssue(number);
    if (!cur) return { ok: false, reason: 'gone', message: 'That issue no longer exists.' };
    if (cur.updatedAt !== expected) return { ok: false, reason: 'conflict', message: 'Someone else changed this issue. Reload and try again.' };
    const next = Math.max(Date.now(), expected + 1);
    getDb().prepare('UPDATE newsletter_issues SET date = ?, title = ?, updated_at = ? WHERE number = ?').run(date, title, next, number);
    audit('issue.update', { userId, target: `issue:${number}`, detail: { dateChanged: cur.date !== date, titleChanged: cur.title !== title } });
    return { ok: true, updatedAt: next };
  });
  // Story pages, listings, /stories.json and the /issues/ pages show the issue's date and title (issues #98, #99).
  if (result.ok) invalidateStories();
  return result;
}

/** Delete an issue only when no draft and no story references it. Audited. */
export function deleteIssue(number: number, expected: number, userId: number): IssueEditResult {
  const result = inIssueTx((): IssueEditResult => {
    const db = getDb();
    const cur = getIssue(number);
    if (!cur) return { ok: false, reason: 'gone', message: 'That issue no longer exists.' };
    if (cur.updatedAt !== expected) return { ok: false, reason: 'conflict', message: 'Someone else changed this issue. Reload and try again.' };
    const used = Number((db.prepare('SELECT (SELECT COUNT(*) FROM stories WHERE newsletter_issue = ?) + (SELECT COUNT(*) FROM drafts WHERE newsletter_issue = ?) AS n').get(number, number) as { n: number }).n);
    if (used > 0) return { ok: false, reason: 'in_use', message: `Issue #${number} is still used by ${used} ${used === 1 ? 'story or draft' : 'stories and drafts'}, so it cannot be deleted.` };
    db.prepare('DELETE FROM newsletter_issues WHERE number = ?').run(number);
    audit('issue.delete', { userId, target: `issue:${number}` });
    return { ok: true, updatedAt: expected };
  });
  if (result.ok) invalidateStories();
  return result;
}

