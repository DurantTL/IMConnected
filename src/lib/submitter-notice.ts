// The one "your story is published" email to a public-form submitter whose address was confirmed (issue #121).
// Sent only after the publish transaction has committed; a failure never undoes or blocks publishing. The address
// is read here and handed to the email service only: it is never logged, audited or stored anywhere new.
import { getDb } from './db';
import { buildPublishedEmail, postEmail } from './email';
import { audit } from './auth/audit';

/**
 * Called after the publish transaction committed, only when that publish was the draft's first (the transaction records
 * the first publish for every draft in drafts.submitter_notified_at, serialised by BEGIN IMMEDIATE, so two publishes
 * can never both see "first"). Sends the one email when the draft qualifies: public form, confirmed address, email
 * configured. Writes `draft.submitter_notify_claimed` before sending (so a crash leaves a visible claim without a result),
 * then `draft.submitter_notified` or `draft.submitter_notify_failed`. Never throws and never logs the address.
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
    const row = getDb()
      .prepare("SELECT submitter_email FROM drafts WHERE id = ? AND source = 'form' AND email_verified = 1 AND submitter_email IS NOT NULL AND submitter_email <> ''")
      .get(draftId) as { submitter_email: string } | undefined;
    to = row?.submitter_email ?? null;
  } catch {
    console.error(`[drafts] submitter notice for draft ${draftId} could not be checked`);
    return 'skipped';
  }
  if (!to) return 'skipped';
  const note = (action: string, detail: Record<string, unknown>) => {
    try {
      audit(action, { userId: opts.userId ?? null, target: `draft:${draftId}`, detail, ip: opts.ip ?? null });
    } catch {
      /* the audit entry is a convenience */
    }
  };
  note('draft.submitter_notify_claimed', { slug });
  const site = (env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
  const res = await postEmail({ to, ...buildPublishedEmail(title, `${site}/stories/${slug}/`) }, env);
  if (res.sent) note('draft.submitter_notified', { slug });
  else {
    note('draft.submitter_notify_failed', { slug, reason: res.reason });
    console.error(`[drafts] submitter notice for draft ${draftId} was not sent: ${res.reason}`);
  }
  return res.sent ? 'sent' : 'failed';
}
