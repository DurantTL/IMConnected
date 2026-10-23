import { storyBlockPhotos } from '../../../../../lib/story-blocks';
import { renderAnnouncementDetails } from '../../../../../lib/announcement-render';
import { renderInlinePhoto } from '../../../../../lib/story-media-render';
import type { APIRoute } from 'astro';
import {
  addUploadedPhotos, changePhoto, replacePhotoFile, getDraft, isEditable, listPhotos, photoCount, restoreDraft,
  saveAuditDue, saveDraft, writeUpload, removeUploadFiles, type OpResult,
} from '../../../../../lib/drafts';
import { readDraftFields, intParam } from '../../../../../lib/draft-form';
import { publishDraftItem, rejectDraftItem } from '../../../../../lib/bulk-actions';
import { chicagoLocalToMs, isChicagoGap, scheduleDraft, unscheduleDraft } from '../../../../../lib/scheduled-publish';
import { ERRORS, type ErrorCode } from '../../../../../lib/messages';
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

const ACTIONS = new Set(['save', 'preview', 'photos', 'publish', 'reject', 'restore', 'schedule', 'unschedule']);

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
    let previewAlts = new Map<number, string>();
    let previewCaptions = new Map<number, string>();
    if (isEditable(draft)) {
      try {
        const parsed = readDraftFields(form);
        fields = parsed.fields;
        focus = parsed.photoFocus;
        previewAlts = parsed.photoAlts;
        previewCaptions = parsed.photoCaptions;
      } catch (err) {
        return jsonResponse(400, { ok: false, error: (err as Error).message });
      }
    }
    const draftPhotos = listPhotos(draft.id);
    const bulletin = fields.announcement === undefined ? draft.announcement : fields.announcement;
    let usedPreviewPhotos = new Set<number>();
    let html: string;
    if (fields.storyBlocks?.length) html = await renderStoryBlocksSafe(fields.storyBlocks, { preview: true, flyerPhotoId: bulletin ? draftPhotos[0]?.id : undefined, resolvePhoto: (photoId) => {
      const photo = draftPhotos.find((p) => p.id === photoId);
      if (!photo) return undefined;
      const point = { ...photo, ...focus.get(photoId) };
      return { url: photo.path ? `/api/admin/photos/${photo.id}` : photo.url ?? '', alt: previewAlts.get(photo.id) ?? photo.alt, caption: previewCaptions.get(photo.id) ?? photo.caption, focalX: point.focalX, focalY: point.focalY, zoom: point.zoom, fit: point.fit, fitFill: point.fitFill };
    } });
    else {
      const rendered = await renderMediaMarkdown(fields.body, draftPhotos.map((photo) => ({ ...photo, src: photo.path ? `/api/admin/photos/${photo.id}` : photo.url ?? '', alt: previewAlts.get(photo.id) ?? photo.alt, caption: previewCaptions.get(photo.id) ?? photo.caption, ...focus.get(photo.id) })), true, bulletin ? 0 : undefined);
      html = rendered.html; usedPreviewPhotos = rendered.used;
    }
    if (bulletin) {
      const first = draftPhotos[0];
      const hasFirst = fields.storyBlocks?.length ? storyBlockPhotos(fields.storyBlocks).some((p) => p.photoId === first?.id) : usedPreviewPhotos.has(0);
      if (first && !hasFirst) html = renderInlinePhoto({ src: first.path ? `/api/admin/photos/${first.id}` : first.url ?? '', alt: previewAlts.get(first.id) ?? first.alt, caption: previewCaptions.get(first.id) ?? first.caption }, true, true) + html;
      html = await renderAnnouncementDetails(bulletin, true) + html;
    }
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
    const r = saveDraft(draft.id, version, parsed.fields, parsed.photoAlts, user.id, parsed.layout, parsed.photoFocus, parsed.photoCaptions);
    if (!r.ok) return jsonResponse(r.reason === 'conflict' ? 409 : r.reason === 'locked' ? 423 : 400, { ok: false, conflict: r.reason === 'conflict', error: r.message });
    if (saveAuditDue(user.id, draft.id)) audit('draft.save', { userId: user.id, target: `draft:${draft.id}`, ip });
    return jsonResponse(200, { ok: true, updatedAt: r.updatedAt, savedBy: user.name, savedAt: r.updatedAt });
  }

  // The remaining actions are plain form posts and answer with a redirect back to the editor.
  if (version === null) return refuse('stale_page');
  const done = (r: OpResult, code: string) => (r.ok ? redirectTo(page, { n: code }) : redirectTo(page, { e: r.code }));

  if (action === 'reject') {
    const note = String(form.get('note') ?? '').slice(0, 500).trim();
    return done(rejectDraftItem(draft.id, version, user.id, note, ip), 'rejected');
  }

  // Scheduled publishing (issue #124): a person's version-checked action; the server only carries it out later. The time is
  // entered in America/Chicago, or taken from the AI agent's suggestion by an explicit click ("use_suggestion").
  if (action === 'schedule') {
    if (!isEditable(draft)) return refuse('closed');
    const fromSuggestion = String(form.get('use_suggestion') ?? '') === '1';
    if (fromSuggestion && draft.suggestedPublishAt === null) return refuse('schedule_none');
    const typed = String(form.get('publish_at') ?? '');
    if (!fromSuggestion && isChicagoGap(typed)) return refuse('schedule_gap');
    const at = fromSuggestion ? draft.suggestedPublishAt : chicagoLocalToMs(typed);
    return done(scheduleDraft(draft.id, version, user.id, at, ip, fromSuggestion ? 'suggestion' : 'chosen'), 'scheduled');
  }
  if (action === 'unschedule') return done(unscheduleDraft(draft.id, version, user.id, ip), 'unscheduled');

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
    const m = /^(up|down|lead|delete|move|replace):(\d{1,12})$/.exec(op);
    if (!m) return refuse('photo_op');
    const photoId = Number(m[2]);
    if (!listPhotos(draft.id).some((p) => p.id === photoId)) return refuse('photo_gone');
    if (m[1] === 'replace') {
      const file = form.get(`replacement_${photoId}`);
      if (!(file instanceof File) || file.size === 0) return refuse('upload_none');
      if (file.size > LIMITS.maxPhotoMB * 1024 * 1024) return refuse('photo_big');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = sniffImage(bytes);
      if (!ext) return refuse('photo_type');
      const rel = writeUpload(draft.id, bytes, ext);
      const r = replacePhotoFile(draft.id, version, user.id, photoId, { rel, ext }, { ip });
      return r.ok ? redirectTo(page, { n: 'photo_replaced', photo: String(photoId) }) : done(r, 'photo_replaced');
    }
    // The audit entry, revision and version bump are written inside the lib transaction; this only builds the redirect.
    const moved = (r: OpResult, fallback: string, notice = 'photo_moved') => {
      const focus = m[1];
      if (!r.ok) return done(r, fallback);
      if (r.noop) return redirectTo(page, { n: 'photo_unchanged', photo: String(photoId), focus });
      const now = listPhotos(draft.id);
      return redirectTo(page, { n: r.warning ? 'photos_markers' : notice, pos: String(now.findIndex((p) => p.id === photoId) + 1), of: String(now.length), photo: String(photoId), focus });
    };
    if (m[1] === 'move') {
      const to = intParam(form.get('to'));
      if (to === null || to < 1) return refuse('photo_op');
      return moved(changePhoto(draft.id, version, user.id, 'move', photoId, to, { ip }), 'photos');
    }
    if (m[1] === 'delete') {
      const r = changePhoto(draft.id, version, user.id, 'delete', photoId, undefined, { ip });
      return r.ok && r.warning ? redirectTo(page, { n: 'photos_markers' }) : done(r, 'photos');
    }
    return moved(changePhoto(draft.id, version, user.id, m[1] as 'up' | 'down' | 'lead', photoId, undefined, { ip }), 'photos', 'photos');
  }

  // ---- publish ----
  const out = await publishDraftItem(draft.id, version ?? -1, user.id, ip);
  return out.ok ? redirectTo(page, { n: 'published' }) : redirectTo(page, { e: out.code });
};
