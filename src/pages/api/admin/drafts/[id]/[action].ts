import type { APIRoute } from 'astro';
import {
  addUploadedPhotos, beginPublish, changePhoto, getDraft, isEditable, listPhotos, markPublished, photoCount, rejectDraft, releaseSlug, restoreDraft, retireUploads,
  saveAuditDue, saveDraft, writeUpload, removeUploadFiles, type OpResult,
} from '../../../../../lib/drafts';
import { readDraftFields, intParam } from '../../../../../lib/draft-form';
import { buildDraftFiles, publishMessage } from '../../../../../lib/draft-publish';
import { commitToBase } from '../../../../../lib/github';
import { EditorError, ERRORS, type ErrorCode } from '../../../../../lib/messages';
import { LIMITS } from '../../../../../lib/limits';
import { sniffImage } from '../../../../../lib/submission';
import { renderMarkdownSafe, escapeHtml } from '../../../../../lib/markdown';
import { audit } from '../../../../../lib/auth/audit';
import { clientIp } from '../../../../../lib/request';
import { githubOrNull, jsonResponse, readFormLimited, redirectTo } from '../../../../../lib/draft-http';

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
    if (version === null) return refuse('stale_page');
    let parsed;
    try {
      parsed = readDraftFields(form);
    } catch (err) {
      return jsonResponse(400, { ok: false, error: (err as Error).message });
    }
    const r = saveDraft(draft.id, version, parsed.fields, parsed.photoAlts, user.id);
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
  const cfg = githubOrNull();
  if (!cfg) {
    console.error('[drafts] GITHUB_TOKEN / GITHUB_REPO not configured');
    return refuse('no_github');
  }
  if (publishing.has(draft.id)) return refuse('already_publishing');
  publishing.add(draft.id);
  let reserved: string | null = null;
  try {
    const photos = listPhotos(draft.id);
    const built = await buildDraftFiles(cfg, draft, photos);
    // Lock the draft (saves from the page the editor is looking at now conflict instead of being lost)
    // and reserve the slug before anything reaches GitHub.
    const lock = beginPublish(draft.id, version, user.id, built.slug);
    if (!lock.ok) return redirectTo(page, { e: lock.code });
    if (!draft.slug) reserved = built.slug;

    const { sha } = await commitToBase(cfg, { files: built.files, message: publishMessage(built.title, user.name) });
    reserved = null; // the story is live from here on, whatever happens next

    try {
      const r = markPublished(draft.id, { slug: built.slug, commit: sha, userId: user.id, lockedAt: lock.updatedAt });
      audit('draft.publish', { userId: user.id, target: `draft:${draft.id}`, detail: { slug: built.slug, commit: sha, newerEditsNotLive: r.stale }, ip });
      retireUploads(draft.id, built.uploaded);
      return redirectTo(page, { n: r.stale ? 'published_stale' : 'published' });
    } catch (err) {
      console.error('[drafts] published but could not record it', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
      return redirectTo(page, { e: 'live_not_recorded' });
    }
  } catch (err) {
    if (err instanceof EditorError) return redirectTo(page, { e: err.code });
    console.error('[drafts] publish failed', err instanceof Error ? err.message.slice(0, 200) : 'unknown error');
    return redirectTo(page, { e: 'publish_failed' });
  } finally {
    if (reserved) releaseSlug(draft.id, reserved);
    publishing.delete(draft.id);
  }
};
