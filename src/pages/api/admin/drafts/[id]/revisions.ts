import type { APIRoute } from 'astro';
import { getDraft, isEditable, restoreDraftRevision } from '../../../../../lib/drafts';
import { listDraftRevisions } from '../../../../../lib/draft-revisions';
import { intParam } from '../../../../../lib/draft-form';
import { jsonResponse, readFormLimited } from '../../../../../lib/draft-http';
export const prerender = false;
export const GET: APIRoute = ({ params }) => {
  try {
    const id = intParam(params.id), draft = id === null ? null : getDraft(id);
    if (!draft) return jsonResponse(404, { ok: false, error: 'Draft not found.' });
    if (!isEditable(draft)) return jsonResponse(423, { ok: false, error: 'This draft is closed.' });
    return jsonResponse(200, { ok: true, revisions: listDraftRevisions(draft.id) });
  } catch { return jsonResponse(503, { ok: false, error: 'Revision history is unavailable.' }); }
};
export const POST: APIRoute = async ({ params, locals, request }) => {
  const id = intParam(params.id);
  if (id === null) return jsonResponse(404, { ok: false, error: 'Draft not found.' });
  const form = await readFormLimited(request, 8192);
  if (form === 'too_big') return jsonResponse(413, { ok: false, error: 'Request is too large.' });
  if (!form) return jsonResponse(400, { ok: false, error: 'Revision request could not be read.' });
  const version = intParam(form.get('version')), revisionId = intParam(form.get('revisionId'));
  if (version === null || revisionId === null) return jsonResponse(400, { ok: false, error: 'Choose a revision and reload if this page is out of date.' });
  try {
    const result = restoreDraftRevision(id, version, revisionId, locals.user!.id);
    if (!result.ok) return jsonResponse(result.reason === 'conflict' ? 409 : result.reason === 'locked' ? 423 : 404, { ok: false, conflict: result.reason === 'conflict', error: result.message });
    return jsonResponse(200, result);
  } catch { return jsonResponse(503, { ok: false, error: 'The revision could not be restored. Please try again.' }); }
};
export const ALL: APIRoute = () => jsonResponse(405, { ok: false, error: 'Use GET or POST.' });
