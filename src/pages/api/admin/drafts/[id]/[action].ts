import type { APIRoute } from 'astro';
import {
  addUploadedPhotos, changePhoto, getDraft, isEditable, listPhotos, markPublished, photoCount, rejectDraft, restoreDraft, saveAuditDue, saveDraft, writeUpload,
  removeUploadFiles, type OpResult,
} from '../../../../../lib/drafts';
import { readDraftFields, intParam } from '../../../../../lib/draft-form';
import { publishDraft } from '../../../../../lib/draft-publish';
import { PublishError } from '../../../../../lib/publish';
import { LIMITS } from '../../../../../lib/limits';
import { sniffImage } from '../../../../../lib/submission';
import { renderMarkdownSafe, escapeHtml } from '../../../../../lib/markdown';
import { audit } from '../../../../../lib/auth/audit';
import { clientIp } from '../../../../../lib/request';
import { githubOrNull, jsonResponse, redirectTo } from '../../../../../lib/draft-http';

export const prerender = false;

// Every action is a POST: the middleware checks Origin and the session before this runs.
const publishing = new Set<number>();

const ACTIONS = new Set(['save', 'preview', 'photos', 'publish', 'reject', 'restore']);

export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
  const user = locals.user!;
  const ip = clientIp(request, clientAddress);
  const id = intParam(params.id);
  const action = params.action ?? '';
  const draft = id === null ? null : getDraft(id);
  if (!draft || !ACTIONS.has(action)) return jsonResponse(404, { ok: false, error: 'Not found.' });
  const page = `/admin/drafts/${draft.id}`;

  const declared = Number(request.headers.get('content-length') || 0);
  const maxBytes = action === 'photos' ? (LIMITS.maxPhotos * LIMITS.maxPhotoMB + 2) * 1024 * 1024 : 400 * 1024;
  if (declared > maxBytes) return action === 'save' || action === 'preview' ? jsonResponse(413, { ok: false, error: 'That is too much to save at once.' }) : redirectTo(page, { e: 'That is too much to send at once.' });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return action === 'save' || action === 'preview' ? jsonResponse(400, { ok: false, error: 'The form could not be read.' }) : redirectTo(page, { e: 'The form could not be read.' });
  }
  const version = intParam(form.get('version'));

  if (action === 'preview') {
    let fields;
    try {
      fields = readDraftFields(form).fields;
    } catch (err) {
      return jsonResponse(400, { ok: false, error: (err as Error).message });
    }
    const { html } = await renderMarkdownSafe(fields.body);
    const byline = [fields.author, fields.authorTitle, fields.church].filter(Boolean).map(escapeHtml).join(' · ');
    const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https:"><style>body{font:17px/1.6 Georgia,serif;margin:0;padding:16px;color:#1b1b1b;background:#fff;overflow-wrap:anywhere}h1{font-size:1.7rem;line-height:1.2;margin:.2em 0}.dek{font-size:1.1rem;color:#444}.by{font:600 .85rem system-ui,sans-serif;color:#555}img{max-width:100%;height:auto}blockquote{margin:1em 0;padding-left:1em;border-left:4px solid #bbb;color:#333}a{color:#0b5cad}</style></head><body><article><h1>${escapeHtml(fields.title || 'Untitled')}</h1>${fields.dek ? `<p class="dek">${escapeHtml(fields.dek)}</p>` : ''}${byline ? `<p class="by">${byline}</p>` : ''}${html || '<p><em>Nothing to preview yet.</em></p>'}</article></body></html>`;
    return jsonResponse(200, { ok: true, doc });
  }

  if (action === 'save') {
    if (version === null) return jsonResponse(400, { ok: false, error: 'The page is out of date. Reload it.' });
    let parsed;
    try {
      parsed = readDraftFields(form);
    } catch (err) {
      return jsonResponse(400, { ok: false, error: (err as Error).message });
    }
    const r = saveDraft(draft.id, version, parsed.fields, parsed.photoMeta, user.id);
    if (!r.ok) return jsonResponse(r.reason === 'conflict' ? 409 : r.reason === 'locked' ? 423 : 400, { ok: false, conflict: r.reason === 'conflict', error: r.message });
    if (saveAuditDue(user.id, draft.id)) audit('draft.save', { userId: user.id, target: `draft:${draft.id}`, ip });
    return jsonResponse(200, { ok: true, updatedAt: r.updatedAt, savedBy: user.name, savedAt: r.updatedAt });
  }

  // The remaining actions are plain form posts and answer with a redirect back to the editor.
  if (version === null) return redirectTo(page, { e: 'The page was out of date. Please try again.' });
  const done = (r: OpResult, code: string) => (r.ok ? redirectTo(page, { n: code }) : redirectTo(page, { e: r.message }));

  if (action === 'reject') {
    const note = String(form.get('note') ?? '').slice(0, 500).trim();
    const r = rejectDraft(draft.id, version, user.id, note);
    if (r.ok) audit('draft.reject', { userId: user.id, target: `draft:${draft.id}`, ip });
    return done(r, 'rejected');
  }

  if (action === 'restore') {
    const r = restoreDraft(draft.id, version, user.id);
    if (r.ok) audit('draft.restore', { userId: user.id, target: `draft:${draft.id}`, ip });
    return done(r, 'restored');
  }

  if (action === 'photos') {
    if (!isEditable(draft)) return redirectTo(page, { e: 'This draft is closed. Restore it to change photos.' });
    const op = String(form.get('op') ?? '');
    if (op === 'upload') {
      const files = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
      if (!files.length) return redirectTo(page, { e: 'Choose at least one photo to upload.' });
      if (photoCount(draft.id) + files.length > LIMITS.maxPhotos) return redirectTo(page, { e: `A story can have up to ${LIMITS.maxPhotos} photos.` });
      const stored: { rel: string; ext: string }[] = [];
      try {
        for (const f of files) {
          if (f.size > LIMITS.maxPhotoMB * 1024 * 1024) throw new Error(`A photo is larger than ${LIMITS.maxPhotoMB} MB.`);
          const bytes = new Uint8Array(await f.arrayBuffer());
          const ext = sniffImage(bytes);
          if (!ext) throw new Error('Photos must be JPG, PNG or WebP images.');
          stored.push({ rel: writeUpload(draft.id, bytes, ext), ext });
        }
      } catch (err) {
        removeUploadFiles(stored.map((s) => s.rel));
        return redirectTo(page, { e: (err as Error).message });
      }
      const r = addUploadedPhotos(draft.id, version, user.id, stored);
      return done(r, 'uploaded');
    }
    const m = /^(up|down|lead|delete):(\d{1,12})$/.exec(op);
    if (!m) return redirectTo(page, { e: 'That photo action is not known.' });
    if (!listPhotos(draft.id).some((p) => p.id === Number(m[2]))) return redirectTo(page, { e: 'That photo is no longer on this draft.' });
    return done(changePhoto(draft.id, version, user.id, m[1] as 'up' | 'down' | 'lead' | 'delete', Number(m[2])), 'photos');
  }

  // publish
  if (!isEditable(draft)) return redirectTo(page, { e: 'Only a new or in-review draft can be published.' });
  if (version !== draft.updatedAt) return redirectTo(page, { e: 'Someone else changed this draft. Reload to see their changes.' });
  const cfg = githubOrNull();
  if (!cfg) {
    console.error('[drafts] GITHUB_TOKEN / GITHUB_REPO not configured');
    return redirectTo(page, { e: 'Publishing is not set up on this server.' });
  }
  if (publishing.has(draft.id)) return redirectTo(page, { e: 'This draft is already being published.' });
  publishing.add(draft.id);
  try {
    const out = await publishDraft(cfg, draft, listPhotos(draft.id), user.name);
    markPublished(draft.id, { slug: out.slug, commit: out.sha, userId: user.id });
    audit('draft.publish', { userId: user.id, target: `draft:${draft.id}`, detail: { slug: out.slug, commit: out.sha }, ip });
    return redirectTo(page, { n: 'published' });
  } catch (err) {
    if (err instanceof PublishError) return redirectTo(page, { e: err.message });
    console.error('[drafts] publish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(page, { e: 'We could not publish right now. Please try again in a few minutes.' });
  } finally {
    publishing.delete(draft.id);
  }
};
