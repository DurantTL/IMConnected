import type { APIRoute } from 'astro';
import {
  addUploadedPhotos, changePhoto, getDraft, isEditable, listPhotos, photoCount, rejectDraft, restoreDraft, retireUploads,
  saveAuditDue, saveDraft, writeUpload, removeUploadFiles, type OpResult,
} from '../../../../../lib/drafts';
import { readDraftFields, intParam } from '../../../../../lib/draft-form';
import { publishDraft } from '../../../../../lib/story-publish';
import { EditorError, ERRORS, type ErrorCode } from '../../../../../lib/messages';
import { LIMITS } from '../../../../../lib/limits';
import { sniffImage } from '../../../../../lib/submission';
import { renderStoryBlocksSafe } from '../../../../../lib/story-block-render';
import { escapeHtml, restrictPreviewImages } from '../../../../../lib/markdown';
import { renderMediaMarkdown, INLINE_MEDIA_CSS } from '../../../../../lib/story-media-render';
import { audit } from '../../../../../lib/auth/audit';
import { clientIp } from '../../../../../lib/request';
import { jsonResponse, readFormLimited, redirectTo, siteUrl } from '../../../../../lib/draft-http';

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
  const isJson = action === 'save' || action === 'preview';
  const refuse = (code: ErrorCode, status = 400) => (isJson ? jsonResponse(status, { ok: false, error: ERRORS[code] }) : redirectTo(page, { e: code }));

  const maxBytes = action === 'photos' ? (LIMITS.maxPhotos * LIMITS.maxPhotoMB + 2) * 1024 * 1024 : 400 * 1024;
  const form = await readFormLimited(request, maxBytes);
  if (form === 'too_big') return refuse('too_big', 413);
  if (!form) return refuse('form_unreadable');
  const version = intParam(form.get('version'));

  if (action === 'preview') {
    // Closed drafts have disabled form fields. Preview their saved story and photo
    // focus, while editable drafts continue to preview unsaved form changes.
    let fields: ReturnType<typeof readDraftFields>['fields'] = draft;
    let focus: ReturnType<typeof readDraftFields>['photoFocus'] = new Map();
    if (isEditable(draft)) {
      try {
        const parsed = readDraftFields(form);
        fields = parsed.fields;
        focus = parsed.photoFocus;
      } catch (err) {
        return jsonResponse(400, { ok: false, error: (err as Error).message });
      }
    }
    const draftPhotos = listPhotos(draft.id);
    let html = fields.storyBlocks?.length ? await renderStoryBlocksSafe(fields.storyBlocks, { resolvePhoto: (photoId) => {
      const photo = draftPhotos.find((p) => p.id === photoId);
      if (!photo) return undefined;
      const point = { ...photo, ...focus.get(photoId) };
      return { url: photo.path ? `/api/admin/photos/${photo.id}` : photo.url ?? '', alt: photo.alt, focalX: point.focalX, focalY: point.focalY, zoom: point.zoom };
    } }) : (await renderMediaMarkdown(fields.body, draftPhotos.map((photo) => ({ src: photo.path ? `/api/admin/photos/${photo.id}` : photo.url ?? '', alt: photo.alt, ...photo, ...focus.get(photo.id) })), true)).html;
    const ownHosts = [new URL(request.url).hostname];
    try { ownHosts.push(new URL(siteUrl()).hostname); } catch { /* a malformed SITE_URL must not break the preview: the request host alone is used */ }
    html = restrictPreviewImages(html, ownHosts);
    const byline = [fields.author, fields.authorTitle, fields.church].filter(Boolean).map(escapeHtml).join(' · ');
    const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(fields.title || 'Untitled story')} — private preview</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:"><style>body{font:17px/1.6 Georgia,serif;margin:0;padding:16px;color:#1b1b1b;background:#fff;overflow-wrap:anywhere}h1{font-size:1.7rem;line-height:1.2;margin:.2em 0}.dek{font-size:1.1rem;color:#444}.by{font:600 .85rem system-ui,sans-serif;color:#555}img{max-width:100%;height:auto}blockquote{margin:1em 0;padding-left:1em;border-left:4px solid #bbb;color:#333}a{color:#0b5cad}</style></head><body><article><h1>${escapeHtml(fields.title || 'Untitled')}</h1>${fields.dek ? `<p class="dek">${escapeHtml(fields.dek)}</p>` : ''}${byline ? `<p class="by">${byline}</p>` : ''}${html || '<p><em>Nothing to preview yet.</em></p>'}</article></body></html>`;
    return jsonResponse(200, { ok: true, doc: doc.replace('</head>', `<style>${INLINE_MEDIA_CSS}</style></head>`) });
  }

  if (action === 'save') {
    if (version === null) return refuse('stale_page');
    let parsed;
    try {
      parsed = readDraftFields(form);
    } catch (err) {
      return jsonResponse(400, { ok: false, error: (err as Error).message });
    }
    const r = saveDraft(draft.id, version, parsed.fields, parsed.photoAlts, user.id, parsed.layout, parsed.photoFocus);
    if (!r.ok) return jsonResponse(r.reason === 'conflict' ? 409 : r.reason === 'locked' ? 423 : 400, { ok: false, conflict: r.reason === 'conflict', error: r.message });
    if (saveAuditDue(user.id, draft.id)) audit('draft.save', { userId: user.id, target: `draft:${draft.id}`, ip });
    return jsonResponse(200, { ok: true, updatedAt: r.updatedAt, savedBy: user.name, savedAt: r.updatedAt });
  }

  // The remaining actions are plain form posts and answer with a redirect back to the editor.
  if (version === null) return refuse('stale_page');
  const done = (r: OpResult, code: string) => (r.ok ? redirectTo(page, { n: code }) : redirectTo(page, { e: r.code }));

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
    if (!isEditable(draft)) return refuse('photos_closed');
    const op = String(form.get('op') ?? '');
    if (op === 'upload') {
      const files = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
      if (!files.length) return refuse('upload_none');
      if (photoCount(draft.id) + files.length > LIMITS.maxPhotos) return refuse('photo_limit');
      const stored: { rel: string; ext: string }[] = [];
      let problem: ErrorCode | null = null;
      for (const f of files) {
        if (f.size > LIMITS.maxPhotoMB * 1024 * 1024) { problem = 'photo_big'; break; }
        const bytes = new Uint8Array(await f.arrayBuffer());
        const ext = sniffImage(bytes);
        if (!ext) { problem = 'photo_type'; break; }
        stored.push({ rel: writeUpload(draft.id, bytes, ext), ext });
      }
      if (problem) {
        removeUploadFiles(stored.map((s) => s.rel));
        return refuse(problem);
      }
      return done(addUploadedPhotos(draft.id, version, user.id, stored), 'uploaded');
    }
    const m = /^(up|down|lead|delete):(\d{1,12})$/.exec(op);
    if (!m) return refuse('photo_op');
    if (!listPhotos(draft.id).some((p) => p.id === Number(m[2]))) return refuse('photo_gone');
    return done(changePhoto(draft.id, version, user.id, m[1] as 'up' | 'down' | 'lead' | 'delete', Number(m[2])), 'photos');
  }

  // ---- publish ----
  if (!isEditable(draft)) return refuse('not_publishable');
  if (version !== draft.updatedAt) return refuse('conflict');
  if (publishing.has(draft.id)) return refuse('already_publishing');
  publishing.add(draft.id);
  try {
    // One transaction: the draft row (version check, slug) and the story, its photos and its search entry. Nothing is
    // half-written if it fails, and the story is live on the very next request.
    const out = await publishDraft(draft, listPhotos(draft.id), version, user.id);
    // Housekeeping after the story is recorded: a failure here must never read as "not published".
    try {
      audit('draft.publish', { userId: user.id, target: `draft:${draft.id}`, detail: { slug: out.slug }, ip });
      retireUploads(draft.id, out.uploaded);
    } catch (err) {
      console.error('[drafts] published; cleanup afterwards failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    }
    return redirectTo(page, { n: 'published' });
  } catch (err) {
    if (err instanceof EditorError) return redirectTo(page, { e: err.code });
    console.error('[drafts] publish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(page, { e: 'publish_failed' });
  } finally {
    publishing.delete(draft.id);
  }
};
