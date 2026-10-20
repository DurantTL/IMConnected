import type { APIRoute } from 'astro';
import { markUnpublished, tx } from '../../../../lib/drafts';
import { unpublishStory, validSlug } from '../../../../lib/draft-publish';
import { holdStory, setHoldMarker, unpublishStory as hideStory } from '../../../../lib/story-store';
import { computeBuildMarker } from '../../../../lib/story-sync';
import { invalidateStories } from '../../../../lib/public-cache';
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
    // Straight after the commit, with no await in between: the draft's unpublished state, the hold (with the commit and
    // GitHub's time for it) and the table row change together or not at all. Without the hold a later publish could bring
    // the old text back, so if this fails the editor is told not to publish before the next deploy.
    try {
      tx(() => {
        markUnpublished(slug, user.id);
        holdStory(slug, out.sha, out.time ?? null);
        hideStory(slug);
      });
    } catch (err) {
      console.error('[stories] could not record the unpublish', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
      audit('draft.unpublish', { userId: user.id, target: `story:${slug}`, detail: { slug, commit: out.sha, recorded: false }, ip: clientIp(request, clientAddress) });
      return redirectTo(back, { e: 'unpublish_not_recorded' });
    }
    // The build marker (used only by local builds without a commit list) is filled in afterwards; a failure is harmless.
    try {
      setHoldMarker(slug, out.sha, await computeBuildMarker());
    } catch (err) {
      console.error('[stories] could not work out the build marker', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
    invalidateStories();
    audit('draft.unpublish', { userId: user.id, target: `story:${slug}`, detail: { slug, commit: out.sha }, ip: clientIp(request, clientAddress) });
    return redirectTo(back, { n: 'unpublished' });
  } catch (err) {
    if (err instanceof EditorError) return redirectTo(back, { e: err.code });
    console.error('[drafts] unpublish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(back, { e: 'unpublish_failed' });
  }
};
