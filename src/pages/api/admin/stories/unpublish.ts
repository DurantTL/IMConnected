import type { APIRoute } from 'astro';
import { validSlug } from '../../../../lib/story-publish';
import { unpublishStoryItem } from '../../../../lib/bulk-actions';
import { readFormLimited, redirectTo } from '../../../../lib/draft-http';
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
  const out = unpublishStoryItem(slug, user.id, clientIp(request, clientAddress));
  return out.ok ? redirectTo(back, { n: 'unpublished' }) : redirectTo(back, { e: out.code });
};
