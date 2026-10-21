import type { APIRoute } from 'astro';
import { unpublishLive, validSlug } from '../../../../lib/story-publish';
import { EditorError } from '../../../../lib/messages';
import { readFormLimited, redirectTo } from '../../../../lib/draft-http';
import { audit } from '../../../../lib/auth/audit';
import { clientIp } from '../../../../lib/request';

export const prerender = false;

// "Unpublish": the story's row stops being live in one transaction (with its draft, which returns to in review) and the
// page cache is cleared, so it is gone from the pages, feeds, search and /api/stories on the next request.
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = locals.user!;
  const back = '/admin/published';
  const form = await readFormLimited(request, 8 * 1024);
  const slugValue = form && form !== 'too_big' ? form.get('slug') : null;
  const slug = typeof slugValue === 'string' ? slugValue : '';
  if (!validSlug(slug)) return redirectTo(back, { e: 'slug_bad' });
  try {
    const out = unpublishLive(slug, user.id);
    if (!out) return redirectTo(back, { e: 'story_missing' });
    try {
      audit('draft.unpublish', { userId: user.id, target: `story:${slug}`, detail: { slug }, ip: clientIp(request, clientAddress) });
    } catch {
      /* the audit entry is a convenience */
    }
    return redirectTo(back, { n: 'unpublished' });
  } catch (err) {
    if (err instanceof EditorError) return redirectTo(back, { e: err.code });
    console.error('[drafts] unpublish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(back, { e: 'unpublish_failed' });
  }
};
