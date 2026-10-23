// Tells the editors who opted in that a story arrived. Only the title and church leave the database
// (never the submitter's name, email, phone or story text), and a failure never fails the submission.
import { getDb } from './db';
import { buildBatchNotice, buildSubmissionNotice, postEmailBatch } from './email';

export function notifyEditorAddresses(): string[] {
  const rows = getDb().prepare("SELECT email FROM users WHERE status = 'active' AND notify_submissions = 1 ORDER BY id").all() as { email: string }[];
  return rows.map((r) => r.email);
}

/** One email per opted-in active editor, sent as a single batch request. Returns counts only (addresses are never logged). */
export async function notifyEditorsOfSubmission(draft: { id: number; title: string; church: string; fromAgent?: boolean }, env = process.env): Promise<{ sent: number; failed: number }> {
  let to: string[];
  try {
    to = notifyEditorAddresses();
  } catch {
    return { sent: 0, failed: 0 };
  }
  if (!to.length) return { sent: 0, failed: 0 };
  const site = (env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
  const mail = buildSubmissionNotice(draft.title, draft.church, `${site}/admin/drafts/${draft.id}`, draft.fromAgent === true);
  // One batch request, one message per recipient (no BCC), so Resend's request rate limit isn't hit.
  return postEmailBatch(to.map((addr) => ({ to: addr, ...mail })), env);
}

/** One summary email per opted-in editor for a whole agent batch (titles and links only). Same opt-in and send path as above. */
export async function notifyEditorsOfBatch(items: { id: number; title: string }[], env = process.env): Promise<{ sent: number; failed: number }> {
  if (!items.length) return { sent: 0, failed: 0 };
  let to: string[];
  try {
    to = notifyEditorAddresses();
  } catch {
    return { sent: 0, failed: 0 };
  }
  if (!to.length) return { sent: 0, failed: 0 };
  const site = (env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
  const mail = buildBatchNotice(items, site);
  return postEmailBatch(to.map((addr) => ({ to: addr, ...mail })), env);
}
