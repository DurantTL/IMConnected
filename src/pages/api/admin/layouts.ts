import type { APIRoute } from 'astro';
import { listEditorLayouts, saveEditorLayout, deleteEditorLayout } from '../../../lib/editor-layouts';
import { jsonResponse, readFormLimited } from '../../../lib/draft-http';
import { intParam } from '../../../lib/draft-form';
import { parseStoryBlocks } from '../../../lib/story-blocks';
export const prerender = false;
export const GET: APIRoute = ({ locals }) => {
  try { return jsonResponse(200, { ok: true, layouts: listEditorLayouts(locals.user!.id) }); } catch { return jsonResponse(503, { ok: false, error: 'Saved layouts are unavailable.' }); }
};
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await readFormLimited(request, 400 * 1024);
  if (form === 'too_big') return jsonResponse(413, { ok: false, error: 'Layout is too large.' });
  if (!form) return jsonResponse(400, { ok: false, error: 'Layout could not be read.' });
  try {
    if (form.get('op') === 'delete') {
      const id = intParam(form.get('id'));
      if (id === null || !deleteEditorLayout(locals.user!.id, id)) return jsonResponse(404, { ok: false, error: 'Layout not found.' });
      return jsonResponse(200, { ok: true });
    }
    if (form.get('op') !== 'save') return jsonResponse(400, { ok: false, error: 'Choose save or delete.' });
    const id = saveEditorLayout(locals.user!.id, form.get('name'), parseStoryBlocks(form.get('blocks')));
    return jsonResponse(201, { ok: true, id });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && String(err.code).includes('SQLITE')) return jsonResponse(503, { ok: false, error: 'Saved layouts are unavailable.' });
    return jsonResponse(400, { ok: false, error: err instanceof Error ? err.message : 'Check the layout.' }); }
};
export const ALL: APIRoute = () => jsonResponse(405, { ok: false, error: 'Use GET or POST.' });
