// The one "your story is published" email to a public-form submitter whose address was confirmed (issue #121).
// Sent only after the publish transaction has committed; a failure never undoes or blocks publishing. The address
// is read here and handed to the email service only: it is never logged, audited or stored anywhere new.
import { getDb } from './db';
import { buildPublishedEmail, postEmail } from './email';
import { audit } from './auth/audit';

/**
 * Claims the single notification for a draft with one conditional UPDATE (so a retry, a republish or a concurrent
 * publish cannot claim it twice), then sends it. When email sending is not configured nothing is claimed or sent.
 * Never throws and never logs the address.
 */
export async function notifySubmitterOfPublication(
  draftId: number,
  slug: string,
  title: string,
  opts: { userId?: number | null; ip?: string | null } = {},
  env = process.env,
): Promise<'sent' | 'failed' | 'skipped'> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return 'skipped';
  let to: string | null = null;
  try {
    const db = getDb();
    const claim = db
      .prepare("UPDATE drafts SET submitter_notified_at = ? WHERE id = ? AND source = 'form' AND email_verified = 1 AND submitter_email IS NOT NULL AND submitter_email <> '' AND submitter_notified_at IS NULL")
      .run(Date.now(), draftId);
    if (Number(claim.changes) !== 1) return 'skipped';
    to = (db.prepare('SELECT submitter_email FROM drafts WHERE id = ?').get(draftId) as { submitter_email: string } | undefined)?.submitter_email ?? null;
  } catch {
    console.error(`[drafts] submitter notice for draft ${draftId} could not be claimed`);
    return 'skipped';
  }
  let ok = false;
  let reason = 'no address';
  if (to) {
    const site = (env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
    const res = await postEmail({ to, ...buildPublishedEmail(title, `${site}/stories/${slug}/`) }, env);
    ok = res.sent;
    reason = res.sent ? '' : res.reason;
  }
  try {
    audit(ok ? 'draft.submitter_notified' : 'draft.submitter_notify_failed', { userId: opts.userId ?? null, target: `draft:${draftId}`, detail: ok ? { slug } : { slug, reason }, ip: opts.ip ?? null });
  } catch {
    /* the audit entry is a convenience */
  }
  if (!ok) console.error(`[drafts] submitter notice for draft ${draftId} was not sent: ${reason}`);
  return ok ? 'sent' : 'failed';
}
