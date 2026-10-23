#!/usr/bin/env node
// Built-server integration, synthetic live stories and throwaway storage only. No production or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
const ROOT = process.cwd(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-agent-reopen-'));
const BASE = 'http://localhost:4857', TOKEN = 'synthetic-agent-reopen-' + 'a'.repeat(40);
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=';
let server, db, checks = 0;
const logs = [];
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('PASS ' + name); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  db = openDatabase(scratch);
  runMigrations(db, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  db.prepare('INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?)').run('git_adopted_at', String(Date.now()), Date.now());
  const row = (sql, ...args) => db.prepare(sql).get(...args);
  const rows = (sql, ...args) => db.prepare(sql).all(...args);
  const exec = (sql, ...args) => db.prepare(sql).run(...args);
  const now = Date.now(), session = randomBytes(32).toString('base64url');
  const userId = Number(exec("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES('reopen-synthetic@example.invalid','Synthetic Editor','editor','active',?,?)", now, now).lastInsertRowid);
  exec('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)', createHash('sha256').update(session).digest('hex'), userId, now, now, now + 3600000);
  const announcement = { kind: 'event', eventDate: '2026-12-01', location: 'Synthetic Hall', links: [{ label: 'Register', url: 'https://example.invalid/register' }], videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' };
  const body = 'Synthetic published body with **formatting** and {{photo 1}}. This remains live until a person publishes the reviewed update.';
  function seed(slug, { linked = false, status = 'published', kind = null, modules = false, count = 1, live = 'live', draft = 0, source = 'agent' } = {}) {
    let id = null;
    if (linked) id = Number(exec("INSERT INTO drafts(status,source,slug,title,section,area,author,date,body,published_commit,published_at,created_at,updated_at,source_url,submitter_email) VALUES(?,?,?,'Old draft','news','conference','Synthetic Author','2026-10-22',?,'db',1,1,1,?,?)", status, source, slug, body, `https://example.invalid/source/${slug}`, 'private-synthetic@example.invalid').lastInsertRowid);
    const image = `/media/stories/${slug}/lead.png`;
    const photos = Array.from({ length: count - 1 }, (_, i) => `/media/stories/${slug}/gallery-${i}.png`);
    const blocks = modules ? [{ id: 'section', type: 'section', content: [[{ id: 'text', type: 'text', text: 'Synthetic modular body' }, { id: 'flyer', type: 'flyer', url: image, photoIndex: 0 }], [{ id: 'gallery', type: 'gallery', photos: [{ url: image, photoIndex: 0 }, { url: photos[0], photoIndex: 1 }] }]] }] : [];
    const storyId = Number(exec("INSERT INTO stories(slug,title,dek,section,area,author,author_title,church,date,image,image_alt,photo_credit,photos,photo_alts,body,status,source,draft_id,published_at,updated_at,photo_layout,announcement,story_blocks,draft,featured) VALUES(?,'Synthetic published title','Published summary','news','conference','Synthetic Author','Director','Synthetic Church','2026-10-22',?,'Original flyer','Synthetic credit',?,?,?, ?,?,?,1,1,'mosaic',?,?,?,1)", slug, image, JSON.stringify(photos), JSON.stringify(photos.map(() => 'Original gallery')), body, live, source, id, kind ? JSON.stringify(kind) : null, JSON.stringify(blocks), draft).lastInsertRowid);
    [image, ...photos].forEach((url, i) => exec('INSERT INTO story_photos(story_id,position,kind,url,alt,focal_x,focal_y,zoom) VALUES(?,?,?,?,?,?,?,?)', storyId, i, i ? 'gallery' : 'lead', url, i ? 'Original gallery' : 'Original flyer', 23, 78, 1.8));
    for (const url of [image, ...photos]) {
      const file = path.join(scratch, 'media', url.slice('/media/'.length));
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(PHOTO.split(',')[1], 'base64'));
    }
    return id;
  }
  seed('synthetic-agent-story', { linked: true });
  seed('synthetic-event', { kind: announcement, source: 'editor', linked: true });
  seed('synthetic-announcement', { kind: { ...announcement, kind: 'announcement' } });
  seed('synthetic-modules', { modules: true, count: 2 });
  seed('synthetic-full', { count: 6 });
  seed('synthetic-escaped');
  const expandedBody = '\n  ' + '&lt;'.repeat(6000) + '\n';
  exec('UPDATE stories SET body=?,author=?,rev=rev+1 WHERE slug=?', expandedBody, 'A'.repeat(150), 'synthetic-escaped');
  for (const status of ['new', 'in_review', 'rejected']) seed(`synthetic-${status.replace('_', '-')}`, { linked: true, status });
  seed('synthetic-unpublished', { live: 'unpublished' });
  seed('synthetic-draft-only', { draft: 1 });
  const rollbackId = seed('synthetic-rollback', { linked: true });
  fs.mkdirSync(path.join(scratch, 'uploads', String(rollbackId)), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'uploads', String(rollbackId), 'old.png'), 'retained original upload');
  exec('INSERT INTO draft_photos(draft_id,path,ext,alt,position,created_at) VALUES(?,?,?,?,0,1)', rollbackId, `${rollbackId}/old.png`, 'png', 'Old upload');
  const allLiveBefore = JSON.stringify(rows('SELECT * FROM stories ORDER BY id'));
  const allPhotoBefore = JSON.stringify(rows('SELECT * FROM story_photos ORDER BY id'));
  server = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: ROOT, env: { ...process.env,
    HOST: '127.0.0.1', PORT: '4857', DATA_DIR: scratch, SITE_URL: BASE, AGENT_API_TOKEN: TOKEN,
    AUTH_SECRET: 'synthetic-reopen-auth-' + 'x'.repeat(40), PUBLISH_TOKEN: 'synthetic-publish-' + 'p'.repeat(40),
    RESEND_API_KEY: '', EMAIL_API_URL: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => logs.push(String(d))); server.stderr.on('data', (d) => logs.push(String(d)));
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/admin/login'); ready = true; break; } catch { await delay(100); } }
  check('built server starts against a synthetic already-adopted database', ready);
  async function call(value, { token = TOKEN, method = 'POST', text, endpoint = '/api/agent/stories/reopen' } = {}) {
    const res = await fetch(BASE + endpoint, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Origin: 'https://untrusted.example.invalid' }, ...(method === 'POST' ? { body: text ?? JSON.stringify(value) } : {}) });
    const raw = await res.text(); let data; try { data = JSON.parse(raw); } catch {}
    return { status: res.status, data, raw, headers: res.headers };
  }
  const request = (slug, extra = {}) => ({ slug, requestId: `update-${slug}`, ...extra });
  const draftFor = (slug) => row('SELECT * FROM drafts WHERE slug=?', slug);
  const draftPhotos = (id) => rows('SELECT * FROM draft_photos WHERE draft_id=? ORDER BY position', id);
  const files = () => fs.readdirSync(path.join(scratch, 'uploads'), { recursive: true }).sort();
  for (const token of [null, 'wrong', 'synthetic-publish-' + 'p'.repeat(40)]) check('reopen rejects missing/wrong/Studio bearer', (await call(request('synthetic-agent-story'), { token })).status === 401);
  const pre = await call({}, { method: 'OPTIONS' });
  check('reopen remains POST-only and has no browser CORS grant', pre.status === 405 && !pre.headers.has('access-control-allow-origin') && pre.headers.get('allow') === 'POST');
  for (const [value, code] of [[{}, 'bad_slug'], [request('../bad-slug'), 'bad_slug'], [request('synthetic-agent-story', { requestId: 'short' }), 'bad_request_id'], [request('synthetic-agent-story', { changes: { published: true } }), 'bad_field'], [request('synthetic-agent-story', { publish: true }), 'bad_field'], [request('synthetic-agent-story', { changes: { title: null } }), 'bad_field'], [request('synthetic-agent-story', { photos: null }), 'photos_invalid']]) {
    const r = await call(value); check('invalid reopen request rejected: ' + code, r.status === 400 && r.data.error === code);
  }
  check('malformed JSON rejected', (await call({}, { text: '{' })).status === 400);
  for (const slug of ['synthetic-missing', 'synthetic-unpublished', 'synthetic-draft-only']) check('only current public stories can be reopened: ' + slug, (await call(request(slug))).status === 404);
  for (const status of ['new', 'in_review', 'rejected']) {
    const slug = `synthetic-${status.replace('_', '-')}`, before = JSON.stringify(draftFor(slug));
    const r = await call(request(slug)); check('protected linked draft remains untouched: ' + status, r.status === 409 && r.data.error === 'already_reviewed' && JSON.stringify(draftFor(slug)) === before);
    const expected = { new: 'open_draft_exists', in_review: 'in_review', rejected: 'rejected' }[status];
    check('409 carries reason, draft id and a next-step message: ' + status, r.data.reason === expected && r.data.id === draftFor(slug).id && typeof r.data.message === 'string' && r.data.message.length > 20);
  }
  exec('UPDATE drafts SET updated_by=? WHERE slug=?', userId, 'synthetic-new');
  const touchedNew = await call(request('synthetic-new'));
  check('a new draft an editor has touched is refused as editor_editing', touchedNew.status === 409 && touchedNew.data.reason === 'editor_editing' && /editor/i.test(touchedNew.data.message));
  exec('UPDATE drafts SET updated_by=NULL WHERE slug=?', 'synthetic-new');
  for (const photos of [[{ url: 'http://169.254.169.254/latest/' }], [{ data: 'data:image/svg+xml;base64,PHN2Zz4=' }]]) check('remote/nonimage photos cannot be appended', (await call(request('synthetic-agent-story', { photos }))).status === 400);
  const full = await call(request('synthetic-full', { photos: [{ data: PHOTO }] }));
  check('combined old and new photo limit is atomic', full.status === 400 && full.data.error === 'too_many_photos' && !draftFor('synthetic-full'));
  const bodyConflict = await call(request('synthetic-modules', { changes: { body: 'Replacement' } }));
  check('body replacement cannot silently discard editor modules', bodyConflict.status === 409 && bodyConflict.data.error === 'module_body_conflict' && bodyConflict.data.reason === 'module_body_conflict' && !!bodyConflict.data.message && !draftFor('synthetic-modules'));
  const payload = request('synthetic-agent-story', { photos: [{ data: PHOTO, alt: 'New synthetic photo' }], note: 'Synthetic agent update note' });
  const first = await call(payload), d = draftFor(payload.slug), pp = draftPhotos(d.id);
  check('published agent story reuses its linked draft and requires review', first.status === 201 && first.data.status === 'reopened' && first.data.requiresReview && first.data.id === d.id && d.status === 'in_review' && d.updated_by === null);
  check('sparse reopen preserves full live editorial fields and slug', d.title === 'Synthetic published title' && d.body === body && d.slug === payload.slug && d.author_title === 'Director' && d.photo_credit === 'Synthetic credit' && d.featured === 1 && d.photo_layout === 'mosaic');
  check('new photos append after original lead with alt and crop unchanged', pp.length === 2 && pp[0].url.endsWith('/lead.png') && pp[0].alt === 'Original flyer' && pp[0].focal_x === 23 && pp[0].focal_y === 78 && pp[0].zoom === 1.8 && pp[1].position === 1 && pp[1].alt === 'New synthetic photo' && fs.existsSync(path.join(scratch, 'uploads', pp[1].path)));
  check('agent note is private editorial metadata', d.agent_note === payload.note && !first.raw.includes(payload.note) && !first.raw.includes('private-synthetic'));
  const retry = await call(payload);
  check('identical retry returns receipt without duplicate photos or mutation', retry.status === 200 && retry.data.status === 'replayed' && retry.data.id === d.id && JSON.stringify(draftFor(payload.slug)) === JSON.stringify(d) && draftPhotos(d.id).length === 2);
  const reused = await call({ ...payload, photos: [] });
  check('requestId reuse with a changed payload conflicts', reused.status === 409 && reused.data.error === 'request_id_reused' && reused.data.reason === 'request_id_reused' && !!reused.data.message);
  check('a new request cannot overwrite the pending review', (await call({ ...payload, requestId: 'new-reopen-request' })).status === 409);
  const eventPayload = request('synthetic-event', { changes: { title: 'Updated event title' }, photos: [{ data: PHOTO, alt: 'New event photo' }], note: '<script>Synthetic event update note</script>' });
  const responses = await Promise.all([call(eventPayload), call(eventPayload)]);
  const event = draftFor('synthetic-event'), ep = draftPhotos(event.id);
  check('concurrent identical calls produce one mutation and one replay', responses.map((r) => r.status).sort().join() === '200,201' && ep.length === 2);
  check('event metadata and original flyer survive sparse updates', event.title === 'Updated event title' && JSON.stringify(JSON.parse(event.announcement)) === JSON.stringify(announcement) && ep[0].url.endsWith('/lead.png') && event.source === 'editor');
  const editorView = await fetch(BASE + `/admin/drafts/${event.id}`, { headers: { Cookie: `__Host-imc_session=${session}` } });
  const editorHtml = await editorView.text();
  check('editors see an escaped agent note on stories retaining their human source', editorView.status === 200 && editorHtml.includes('AI agent update') && editorHtml.includes('&lt;script&gt;Synthetic event update note&lt;/script&gt;') && !editorHtml.includes(eventPayload.note));
  const ann = await call(request('synthetic-announcement', { changes: { announcement: null, body: 'Updated <script>alert(1)</script> **safe Markdown**' } }));
  const ad = draftFor('synthetic-announcement');
  check('any public announcement can be reopened with explicit metadata clear and escaped body', ann.status === 201 && ad.announcement === null && ad.body.includes('&lt;script>') && !ad.body.includes('<script>') && ad.published_commit === 'db' && ad.status === 'in_review');
  const mod = await call(request('synthetic-modules', { photos: [{ data: PHOTO, alt: 'New module photo' }] }));
  const md = draftFor('synthetic-modules'), mp = draftPhotos(md.id), mb = JSON.parse(md.story_blocks);
  check('module structure survives and all nested photo references remap to draft-owned IDs', mod.status === 201 && mb[0].type === 'section' && mb[0].content[0][1].photoId === mp[0].id && mb[0].content[1][0].photos[1].photoId === mp[1].id && mp.length === 3);
  const escaped = await call(request('synthetic-escaped', { photos: [{ data: PHOTO }] }));
  const ed = draftFor('synthetic-escaped');
  check('sparse updates preserve inherited escaped body, whitespace and wider public field limits exactly', escaped.status === 201 && ed.body === expandedBody && ed.author === 'A'.repeat(150) && draftPhotos(ed.id).length === 2);
  const rollbackBefore = JSON.stringify(draftFor('synthetic-rollback')), fileBefore = JSON.stringify(files());
  db.exec("CREATE TRIGGER force_reopen_rollback BEFORE INSERT ON agent_reopens BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  const rollbackRequest = request('synthetic-rollback', { photos: [{ data: PHOTO }] });
  const failed = await call(rollbackRequest);
  check('late transaction failure rolls back draft, photo rows and new files', failed.status === 503 && JSON.stringify(draftFor('synthetic-rollback')) === rollbackBefore && JSON.stringify(files()) === fileBefore && draftPhotos(rollbackId)[0].path === `${rollbackId}/old.png`);
  db.exec('DROP TRIGGER force_reopen_rollback');
  const recovered = await call(rollbackRequest);
  check('same request can retry after rollback; superseded upload removed only after commit', recovered.status === 201 && !fs.existsSync(path.join(scratch, 'uploads', String(rollbackId), 'old.png')));
  exec("UPDATE drafts SET title='Editor work after reopen',updated_at=updated_at+1 WHERE id=?", d.id);
  check('receipt replay after editor work does not overwrite the editor', (await call(payload)).status === 200 && draftFor(payload.slug).title === 'Editor work after reopen');
  check('every live story row and public photo row is unchanged', JSON.stringify(rows('SELECT * FROM stories ORDER BY id')) === allLiveBefore && JSON.stringify(rows('SELECT * FROM story_photos ORDER BY id')) === allPhotoBefore);
  const audit = rows("SELECT target,detail,user_id FROM audit_log WHERE action='agent.reopen'");
  check('exactly one transactional audit per successful reopen, no request data', audit.length === 6 && audit.every((a) => /^draft:\d+$/.test(a.target) && a.detail === '{"result":"reopened"}' && a.user_id === null));
  const receipts = rows('SELECT * FROM agent_reopens');
  check('retry receipts contain only hashes and draft identities', receipts.length === 6 && receipts.every((r) => /^[a-f0-9]{64}$/.test(r.request_hash) && /^[a-f0-9]{64}$/.test(r.payload_hash)));
  const authGet = await call({}, { method: 'GET' });
  check('reopen has no GET and successful responses are no-store/no-CORS', authGet.status === 405 && first.headers.get('cache-control') === 'no-store' && !first.headers.has('access-control-allow-origin'));
  const publishForm = new FormData(); publishForm.set('version', String(draftFor('synthetic-event').updated_at));
  const published = await fetch(BASE + `/api/admin/drafts/${event.id}/publish`, { method: 'POST', redirect: 'manual', headers: { Origin: BASE, Cookie: `__Host-imc_session=${session}` }, body: publishForm });
  check('a synthetic human editor can publish the reopened event normally', published.status === 303 && published.headers.get('location').includes('n=published') && draftFor('synthetic-event').status === 'published' && row('SELECT title FROM stories WHERE slug=?', 'synthetic-event').title === 'Updated event title');
  const nextUpdate = await call(request('synthetic-event', { requestId: 'event-second-reviewed-update', photos: [{ data: PHOTO, alt: 'Second batch' }] }));
  check('after human publication, a new request reopens the latest public content', nextUpdate.status === 201 && draftFor('synthetic-event').id === event.id && draftPhotos(event.id).length === 3 && draftFor('synthetic-event').title === 'Updated event title');
  const afterSecond = JSON.stringify(draftFor('synthetic-event'));
  check('an older receipt cannot reapply photos after another publish/reopen cycle', (await call(eventPayload)).status === 200 && JSON.stringify(draftFor('synthetic-event')) === afterSecond && draftPhotos(event.id).length === 3);
  const capabilities = await call({}, { method: 'GET', endpoint: '/api/agent/sections' });
  check('existing capability discovery advertises the explicit reviewed-update API', capabilities.status === 200 && capabilities.data.reopen.endpoint === '/api/agent/stories/reopen');
  const idGet = await call({}, { method: 'GET', endpoint: `/api/agent/stories/${row('SELECT id FROM drafts WHERE slug=?', 'synthetic-agent-story').id}` });
  check('GET /api/agent/stories/<id> is the read-back route while stories/reopen stays POST-only', idGet.status === 200 && idGet.data.draft.slug === 'synthetic-agent-story' && idGet.data.draft.status === 'in_review' && idGet.data.draft.editorTouched === true && !('agent_note' in idGet.data.draft) && !idGet.raw.includes('Synthetic agent update note') && !idGet.raw.includes('/uploads/'));
  let limited;
  for (let i = 0; i < 65; i++) { limited = await call({}, { method: 'GET', endpoint: '/api/agent/sections' }); if (limited.status === 429) break; }
  const reopenLimited = await call(request('synthetic-agent-story'));
  check('reopen shares the existing agent token rate window', limited.status === 429 && reopenLimited.status === 429 && reopenLimited.headers.get('retry-after') === '3600');
  check('logs never expose token, note, contacts or upload paths', !logs.join('').includes(TOKEN) && !logs.join('').includes('private-synthetic') && !logs.join('').includes('Synthetic agent update note') && !logs.join('').includes('/uploads/'));
  console.log(`\n${checks} agent reopen checks passed.`);
} finally {
  if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
  db?.close(); fs.rmSync(scratch, { recursive: true, force: true });
}
