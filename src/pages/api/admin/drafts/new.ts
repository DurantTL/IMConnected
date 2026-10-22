import type { APIRoute } from 'astro';
import { createDraft } from '../../../../lib/drafts';
import { audit } from '../../../../lib/auth/audit';
import { clientIp } from '../../../../lib/request';
import { redirectTo, readFormLimited, jsonResponse } from '../../../../lib/draft-http';

export const prerender = false;

// "New story": an empty draft with source "editor". POST only (the middleware checks Origin).
export const POST: APIRoute = async ({ locals, request, clientAddress }) => {
  const user = locals.user!;
  const form = request.body ? await readFormLimited(request, 4096) : new FormData();
  if (!form || form === 'too_big') return jsonResponse(400, { error: 'The new-draft form is unreadable or too large.' });
  const kind = form.get('kind') ?? 'story';
  if (!['story', 'announcement', 'event'].includes(String(kind))) return jsonResponse(400, { error: 'Choose a story, announcement or event.' });
  const id = createDraft({ source: 'editor', userId: user.id, ...(kind === 'announcement' || kind === 'event' ? { fields: { announcement: { kind, links: [] } } } : {}) });
  audit('draft.create', { userId: user.id, target: `draft:${id}`, detail: { source: 'editor', kind }, ip: clientIp(request, clientAddress) });
  return redirectTo(`/admin/drafts/${id}`);
};
