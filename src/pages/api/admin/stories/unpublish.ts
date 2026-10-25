import type { APIRoute } from 'astro';
import { validSlug } from '../../../../lib/story-publish';
import { unpublishStoryItem } from '../../../../lib/bulk-actions';
import { readFormLimited, redirectTo } from '../../../../lib/draft-http';
import { isLiveSectionPage, safeLiveBack } from '../../../../lib/admin-back';
import { clientIp } from '../../../../lib/request';

export const prerender = false;

// "Unpublish": the story's row stops being live in one transaction (with its draft, which returns to in review) and the
// page cache is cleared, so it is gone from the pages, feeds, search and /api/stories on the next request.
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = locals.user!;
  const form = await readFormLimited(request, 8 * 1024);
  // The list's own view (the Published list, or the live section of the Announcements or Events page), rebuilt from the
  // parsed filter, never the raw value.
  const back = safeLiveBack(form && form !== 'too_big' ? form.get('back') : null);
  const slugValue = form && form !== 'too_big' ? form.get('slug') : null;
  const slug = typeof slugValue === 'string' ? slugValue : '';
  // Back on the Announcements or Events page, land on its live section rather than the top of the page.
  const hash = isLiveSectionPage(back) ? 'live' as const : undefined;
  if (!validSlug(slug)) return redirectTo(back, { e: 'slug_bad', hash });
  const out = unpublishStoryItem(slug, user.id, clientIp(request, clientAddress));
  return out.ok ? redirectTo(back, { n: 'unpublished', hash }) : redirectTo(back, { e: out.code, hash });
};
