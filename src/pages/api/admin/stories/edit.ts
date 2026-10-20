import type { APIRoute } from 'astro';
import { createDraftFromStory, getDraftBySlug, isEditable, reloadDraftFromStory } from '../../../../lib/drafts';
import { loadStory, validSlug } from '../../../../lib/draft-publish';
import { EditorError } from '../../../../lib/messages';
import { githubOrNull, readFormLimited, redirectTo } from '../../../../lib/draft-http';
import { audit } from '../../../../lib/auth/audit';
import { clientIp } from '../../../../lib/request';

export const prerender = false;

// "Edit" on a published story: load its current .md from the base branch into an editor draft linked to
// the slug (reusing the draft that already has this slug, so there is one draft per story).
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = locals.user!;
  const ip = clientIp(request, clientAddress);
  const back = '/admin/published';
  const form = await readFormLimited(request, 8 * 1024);
  const slugValue = form && form !== 'too_big' ? form.get('slug') : null;
  const slug = typeof slugValue === 'string' ? slugValue : '';
  if (!validSlug(slug)) return redirectTo(back, { e: 'slug_bad' });

  const existing = getDraftBySlug(slug);
  if (existing && isEditable(existing)) return redirectTo(`/admin/drafts/${existing.id}`);

  const cfg = githubOrNull();
  if (!cfg) return redirectTo(back, { e: 'edit_no_github' });
  try {
    const story = await loadStory(cfg, slug);
    if (!story) return redirectTo(back, { e: 'story_missing' });
    let id: number;
    if (existing) {
      reloadDraftFromStory(existing.id, user.id, story.fields, story.photos);
      id = existing.id;
    } else {
      id = createDraftFromStory(user.id, slug, story.fields, story.photos);
    }
    audit('draft.create', { userId: user.id, target: `draft:${id}`, detail: { source: 'editor', slug }, ip });
    return redirectTo(`/admin/drafts/${id}`);
  } catch (err) {
    if (err instanceof EditorError) return redirectTo(back, { e: err.code });
    console.error('[drafts] load story failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(back, { e: 'load_failed' });
  }
};
