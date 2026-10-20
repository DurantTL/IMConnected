// Tells the editors who opted in that a story arrived. Only the title and church leave the database
// (never the submitter's name, email, phone or story text), and a failure never fails the submission.
import { getDb } from './db';
import { buildSubmissionNotice, postEmail } from './email';

export function notifyEditorAddresses(): string[] {
  const rows = getDb().prepare("SELECT email FROM users WHERE status = 'active' AND notify_submissions = 1 ORDER BY id").all() as { email: string }[];
  return rows.map((r) => r.email);
}

/** One email per opted-in active editor. Returns counts only (addresses are never logged). */
export async function notifyEditorsOfSubmission(draft: { id: number; title: string; church: string }, env = process.env): Promise<{ sent: number; failed: number }> {
  let to: string[];
  try {
    to = notifyEditorAddresses();
  } catch {
    return { sent: 0, failed: 0 };
  }
  if (!to.length) return { sent: 0, failed: 0 };
  const site = (env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
  const mail = buildSubmissionNotice(draft.title, draft.church, `${site}/admin/drafts/${draft.id}`);
  const results = await Promise.all(to.map((addr) => postEmail({ to: addr, ...mail }, env)));
  const sent = results.filter((r) => r.sent).length;
  return { sent, failed: results.length - sent };
}
