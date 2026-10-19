import type { APIRoute } from 'astro';
import { createDraftFromStory, getDraftBySlug, isEditable, reloadDraftFromStory } from '../../../../lib/drafts';
import { loadStory, validSlug } from '../../../../lib/draft-publish';
import { PublishError } from '../../../../lib/publish';
import { audit } from '../../../../lib/auth/audit';
import { clientIp } from '../../../../lib/request';
import { githubOrNull, redirectTo } from '../../../../lib/draft-http';

export const prerender = false;

// "Edit" on a published story: load its current .md from the base branch into an editor draft linked to
// the slug (reusing the draft that already has this slug, so there is one draft per story).
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const user = locals.user!;
  const ip = clientIp(request, clientAddress);
  const back = '/admin/published';
  let slug = '';
  try {
    const v = (await request.formData()).get('slug');
    slug = typeof v === 'string' ? v : '';
  } catch {
    /* handled below */
  }
  if (!validSlug(slug)) return redirectTo(back, { e: 'That story address is not valid.' });

  const existing = getDraftBySlug(slug);
  if (existing && isEditable(existing)) return redirectTo(`/admin/drafts/${existing.id}`);

  const cfg = githubOrNull();
  if (!cfg) return redirectTo(back, { e: 'Editing live stories is not set up on this server.' });
  try {
    const story = await loadStory(cfg, slug);
    if (!story) return redirectTo(back, { e: 'That story was not found on the live branch.' });
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
    if (err instanceof PublishError) return redirectTo(back, { e: err.message });
    console.error('[drafts] load story failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(back, { e: 'We could not load that story right now. Please try again.' });
  }
};
