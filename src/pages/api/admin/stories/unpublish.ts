import type { APIRoute } from 'astro';
import { markUnpublished } from '../../../../lib/drafts';
import { unpublishStory, validSlug } from '../../../../lib/draft-publish';
import { EditorError } from '../../../../lib/messages';
import { githubOrNull, readFormLimited, redirectTo } from '../../../../lib/draft-http';
import { audit } from '../../../../lib/auth/audit';
import { clientIp } from '../../../../lib/request';

export const prerender = false;

// "Unpublish": commits `draft: true` to the story's file. The draft (if any) returns to in review.
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = locals.user!;
  const back = '/admin/published';
  const form = await readFormLimited(request, 8 * 1024);
  const slugValue = form && form !== 'too_big' ? form.get('slug') : null;
  const slug = typeof slugValue === 'string' ? slugValue : '';
  if (!validSlug(slug)) return redirectTo(back, { e: 'slug_bad' });
  const cfg = githubOrNull();
  if (!cfg) return redirectTo(back, { e: 'unpublish_no_github' });
  try {
    const out = await unpublishStory(cfg, slug, user.name);
    if (!out) return redirectTo(back, { e: 'story_missing' });
    markUnpublished(slug, user.id);
    audit('draft.unpublish', { userId: user.id, target: `story:${slug}`, detail: { slug, commit: out.sha }, ip: clientIp(request, clientAddress) });
    return redirectTo(back, { n: 'unpublished' });
  } catch (err) {
    if (err instanceof EditorError) return redirectTo(back, { e: err.code });
    console.error('[drafts] unpublish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(back, { e: 'unpublish_failed' });
  }
};
