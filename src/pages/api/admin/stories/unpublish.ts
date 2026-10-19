import type { APIRoute } from 'astro';
import { markUnpublished } from '../../../../lib/drafts';
import { unpublishStory, validSlug } from '../../../../lib/draft-publish';
import { PublishError } from '../../../../lib/publish';
import { audit } from '../../../../lib/auth/audit';
import { clientIp } from '../../../../lib/request';
import { githubOrNull, redirectTo } from '../../../../lib/draft-http';

export const prerender = false;

// "Unpublish": commits `draft: true` to the story's file. The draft (if any) returns to in review.
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = locals.user!;
  const back = '/admin/published';
  let slug = '';
  try {
    const v = (await request.formData()).get('slug');
    slug = typeof v === 'string' ? v : '';
  } catch {
    /* handled below */
  }
  if (!validSlug(slug)) return redirectTo(back, { e: 'That story address is not valid.' });
  const cfg = githubOrNull();
  if (!cfg) return redirectTo(back, { e: 'Unpublishing is not set up on this server.' });
  try {
    const out = await unpublishStory(cfg, slug, user.name);
    if (!out) return redirectTo(back, { e: 'That story was not found on the live branch.' });
    markUnpublished(slug, user.id);
    audit('draft.unpublish', { userId: user.id, target: `story:${slug}`, detail: { slug, commit: out.sha }, ip: clientIp(request, clientAddress) });
    return redirectTo(back, { n: 'unpublished' });
  } catch (err) {
    if (err instanceof PublishError) return redirectTo(back, { e: err.message });
    console.error('[drafts] unpublish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(back, { e: 'We could not unpublish right now. Please try again in a few minutes.' });
  }
};
