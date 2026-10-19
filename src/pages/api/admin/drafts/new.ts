import type { APIRoute } from 'astro';
import { createDraft } from '../../../../lib/drafts';
import { audit } from '../../../../lib/auth/audit';
import { clientIp } from '../../../../lib/request';
import { redirectTo } from '../../../../lib/draft-http';

export const prerender = false;

// "New story": an empty draft with source "editor". POST only (the middleware checks Origin).
export const POST: APIRoute = ({ locals, request, clientAddress }) => {
  const user = locals.user!;
  const id = createDraft({ source: 'editor', userId: user.id });
  audit('draft.create', { userId: user.id, target: `draft:${id}`, detail: { source: 'editor' }, ip: clientIp(request, clientAddress) });
  return redirectTo(`/admin/drafts/${id}`);
};
