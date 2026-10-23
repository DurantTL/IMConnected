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
let server, server2, db, checks = 0;
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
  for (const slug of ['synthetic-patch-loc', 'synthetic-patch-clear', 'synthetic-patch-links', 'synthetic-patch-remove']) seed(slug, { kind: announcement });
  seed('synthetic-patch-plain');
  seed('synthetic-noarea');
  exec("UPDATE stories SET area='',rev=rev+1 WHERE slug='synthetic-noarea'");
  seed('synthetic-patch-misc', { count: 2 });
  exec("UPDATE story_photos SET caption = CASE position WHEN 0 THEN 'Original lead caption' ELSE 'Original gallery caption' END WHERE story_id = (SELECT id FROM stories WHERE slug = 'synthetic-patch-misc')");
  // Issue #98: stories that already sit in a (synthetic) newsletter issue, and ones without.
  exec("INSERT INTO newsletter_issues(number,date,title,created_at,updated_at) VALUES(5,'2026-08-10','Synthetic Summer',1,1)");
  for (const slug of ['synthetic-issue-keep', 'synthetic-issue-clear', 'synthetic-issue-conflict']) { seed(slug); exec('UPDATE stories SET newsletter_issue=5,newsletter_position=2,rev=rev+1 WHERE slug=?', slug); }
  for (const slug of ['synthetic-issue-set', 'synthetic-issue-bad']) seed(slug);
  // Issue #117: stories that already carry key points, and ones without.
  for (const slug of ['synthetic-kp-keep', 'synthetic-kp-clear', 'synthetic-kp-null']) { seed(slug); exec('UPDATE stories SET key_points=?,rev=rev+1 WHERE slug=?', JSON.stringify(['Synthetic point one.', 'Synthetic point two.']), slug); }
  for (const slug of ['synthetic-kp-set', 'synthetic-kp-bad']) seed(slug);
  for (const slug of ['synthetic-patch-youth', 'synthetic-patch-features', 'synthetic-patch-areabad', 'synthetic-patch-samesec', 'synthetic-patch-columns']) seed(slug);
  const expandedBody = '\n  ' + '&lt;'.repeat(6000) + '\n';
  exec('UPDATE stories SET body=?,author=?,rev=rev+1 WHERE slug=?', expandedBody, 'A'.repeat(150), 'synthetic-escaped');
  for (const status of ['new', 'in_review', 'rejected']) seed(`synthetic-${status.replace('_', '-')}`, { linked: true, status });
  seed('synthetic-form-linked', { linked: true, status: 'in_review', source: 'form' });
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
  async function call(value, { token = TOKEN, method = 'POST', text, endpoint = '/api/agent/stories/reopen', base = BASE } = {}) {
    const res = await fetch(base + endpoint, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Origin: 'https://untrusted.example.invalid' }, ...(method === 'POST' ? { body: text ?? JSON.stringify(value) } : {}) });
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
  const formLinked = await call(request('synthetic-form-linked'));
  check('a refused reopen of a non-agent linked draft gives the reason but no draft id', formLinked.status === 409 && formLinked.data.reason === 'in_review' && formLinked.data.id === null && !/send a note/i.test(formLinked.data.message) && !formLinked.raw.includes('@'));
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
  // The agent rate window is 60 per hour per process, and the checks above use most of it: this block runs against a second
  // copy of the built server on the same synthetic storage, with a fresh window.
  const BASE2 = 'http://localhost:4858';
  server2 = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: ROOT, env: { ...process.env,
    HOST: '127.0.0.1', PORT: '4858', DATA_DIR: scratch, SITE_URL: BASE2, AGENT_API_TOKEN: TOKEN,
    AUTH_SECRET: 'synthetic-reopen-auth-' + 'x'.repeat(40), PUBLISH_TOKEN: 'synthetic-publish-' + 'p'.repeat(40),
    RESEND_API_KEY: '', EMAIL_API_URL: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready2 = false;
  server2.stdout.on('data', (d) => logs.push(String(d))); server2.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 100; i++) { try { await fetch(BASE2 + '/admin/login'); ready2 = true; break; } catch { await delay(100); } }
  check('second server starts', ready2);
  const call81 = (value, opts = {}) => call(value, { ...opts, base: BASE2 });
  // ---- issue 81: announcement patches, crops, author title / credit / featured, markers, section-only change ----
  const annOf = (slug) => { const v = draftFor(slug).announcement; return v === null ? null : JSON.parse(v); };
  const reopenReq = (slug, extra) => request(slug, { requestId: `issue81-${slug}`, ...extra });
  const rowsBefore81 = JSON.stringify(rows('SELECT * FROM stories ORDER BY id')), photosBefore81 = JSON.stringify(rows('SELECT * FROM story_photos ORDER BY id'));
  let r81 = await call81(reopenReq('synthetic-patch-loc', { changes: { announcement: { location: 'Synthetic Gym', videoUrl: 'https://evil.invalid/v' } } }));
  check('reopen: an invalid merged announcement is 400 bad_announcement and creates no draft', r81.status === 400 && r81.data.error === 'bad_announcement' && !draftFor('synthetic-patch-loc'));
  r81 = await call81(reopenReq('synthetic-patch-loc', { changes: { announcement: { links: [1, 2, 3, 4].map((n) => ({ label: 'L' + n, url: 'https://example.invalid/' + n })) } } }));
  check('reopen: four links in a patch is refused', r81.status === 400 && r81.data.error === 'bad_announcement' && !draftFor('synthetic-patch-loc'));
  r81 = await call81(reopenReq('synthetic-patch-plain', { changes: { announcement: { location: 'Synthetic Gym' } } }));
  check('reopen: a patch with no kind on a story without an announcement is 400 bad_announcement', r81.status === 400 && r81.data.error === 'bad_announcement' && !draftFor('synthetic-patch-plain'));
  r81 = await call81(reopenReq('synthetic-patch-plain', { changes: { announcement: 'soon' } }));
  check('reopen: a non-object announcement is refused', r81.status === 400 && r81.data.error === 'bad_announcement');
  r81 = await call81(reopenReq('synthetic-patch-loc', { changes: { announcement: { location: 'Synthetic Gym' } } }));
  check('reopen: { location } alone changes only the location (kind, date, links and video kept)', r81.status === 201 && JSON.stringify(annOf('synthetic-patch-loc')) === JSON.stringify({ ...announcement, location: 'Synthetic Gym', videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }), JSON.stringify(annOf('synthetic-patch-loc')));
  check('...title, body and the other fields are untouched', draftFor('synthetic-patch-loc').title === 'Synthetic published title' && draftFor('synthetic-patch-loc').body === body && draftFor('synthetic-patch-loc').author_title === 'Director' && draftFor('synthetic-patch-loc').photo_credit === 'Synthetic credit' && draftFor('synthetic-patch-loc').featured === 1);
  r81 = await call81(reopenReq('synthetic-patch-clear', { changes: { announcement: { eventDate: '' } } }));
  check('reopen: "" clears just that optional field', r81.status === 201 && annOf('synthetic-patch-clear').eventDate === undefined && annOf('synthetic-patch-clear').location === 'Synthetic Hall' && annOf('synthetic-patch-clear').links.length === 1 && !!annOf('synthetic-patch-clear').videoUrl && annOf('synthetic-patch-clear').kind === 'event');
  r81 = await call81(reopenReq('synthetic-patch-links', { changes: { announcement: { links: [{ label: 'Map', url: 'https://example.invalid/map' }] } } }));
  check('reopen: links present replaces the whole list', r81.status === 201 && JSON.stringify(annOf('synthetic-patch-links').links) === JSON.stringify([{ label: 'Map', url: 'https://example.invalid/map' }]) && annOf('synthetic-patch-links').location === 'Synthetic Hall');
  r81 = await call81(reopenReq('synthetic-patch-remove', { changes: { announcement: null } }));
  check('reopen: null removes the announcement', r81.status === 201 && annOf('synthetic-patch-remove') === null);
  r81 = await call81(reopenReq('synthetic-patch-plain', { changes: { announcement: { kind: 'event', location: 'Synthetic Hall' } } }));
  check('reopen: a patch with kind adds an announcement to a story without one', r81.status === 201 && JSON.stringify(annOf('synthetic-patch-plain')) === JSON.stringify({ kind: 'event', location: 'Synthetic Hall', links: [] }));

  for (const [name, change] of [['focalX 101', { focalX: 101 }], ['zoom 4', { zoom: 4 }], ['zoom 0', { zoom: 0 }], ['focalY text', { focalY: '50' }]]) {
    const r = await call81(reopenReq('synthetic-patch-misc', { photos: [{ data: PHOTO, ...change }] }));
    check(`reopen: an appended photo crop out of range is 400 bad_photo_crop (${name}) and creates no draft`, r.status === 400 && r.data.error === 'bad_photo_crop' && !draftFor('synthetic-patch-misc'));
  }
  for (const [name, change, code] of [['fit "stretch"', { fit: 'stretch' }, 'bad_photo_fit'], ['fitFill "red"', { fitFill: 'red' }, 'bad_photo_fit_fill'], ['fit null', { fit: null }, 'bad_photo_fit']]) {
    const r = await call81(reopenReq('synthetic-patch-misc', { photos: [{ data: PHOTO, ...change }] }));
    check(`reopen: an appended photo with ${name} is 400 ${code} and creates no draft`, r.status === 400 && r.data.error === code && !draftFor('synthetic-patch-misc'));
  }
  r81 = await call81(reopenReq('synthetic-patch-misc', { changes: { featured: 'yes' } }));
  check('reopen: a non-boolean featured is 400 bad_field', r81.status === 400 && r81.data.error === 'bad_field' && !draftFor('synthetic-patch-misc'));
  r81 = await call81(reopenReq('synthetic-patch-misc', { changes: { authorTitle: 'x'.repeat(121) } }));
  check('reopen: authorTitle over 120 is 400', r81.status === 400 && r81.data.error === 'author_title_too_long');
  r81 = await call81(reopenReq('synthetic-patch-misc', { changes: { body: 'Intro.\n\n{{photo 4}}\n\nEnd.' }, photos: [{ data: PHOTO }] }));
  check('reopen: a marker past existing + appended photos is 400 bad_photo_marker naming it, no draft', r81.status === 400 && r81.data.error === 'bad_photo_marker' && r81.data.message.includes('{{photo 4}}') && !draftFor('synthetic-patch-misc'));
  r81 = await call81(reopenReq('synthetic-patch-misc', { changes: { body: 'Intro.\n\n{{photo 3}}\n\nEnd.' } }));
  check('reopen: ...and also without any appended photos', r81.status === 400 && r81.data.error === 'bad_photo_marker');
  r81 = await call81(reopenReq('synthetic-patch-misc', { changes: { authorTitle: 'Pastor <b>Synthetic</b>', photoCredit: '', featured: false, body: 'Intro.\n\n{{photo 4}}\n\n```\n{{photo 9}}\n```' }, photos: [{ data: PHOTO, alt: 'Cropped', caption: 'Appended <b>caption</b>', focalX: 10, focalY: 90, zoom: 2.5, fit: 'contain', fitFill: 'paper' }, { data: PHOTO, alt: 'Plain' }] }));
  const misc = draftFor('synthetic-patch-misc'), miscPhotos = misc ? draftPhotos(misc.id) : [];
  check('reopen: valid marker, fenced markers, crops and author fields are accepted', r81.status === 201 && !!misc && misc.status === 'in_review', r81.raw.slice(0, 200));
  check('reopen: authorTitle stored as typed ("<" kept, like author), photoCredit cleared by "", featured turned off, omitted fields kept', misc.author_title === 'Pastor <b>Synthetic</b>' && misc.photo_credit === '' && misc.featured === 0 && misc.title === 'Synthetic published title' && misc.author === 'Synthetic Author');
  check('reopen: appended photos keep their crops (defaults 50 / 50 / 1 when omitted); the originals keep theirs', miscPhotos.length === 4 && miscPhotos[0].focal_x === 23 && miscPhotos[1].zoom === 1.8 && miscPhotos[2].focal_x === 10 && miscPhotos[2].focal_y === 90 && miscPhotos[2].zoom === 2.5 && miscPhotos[3].focal_x === 50 && miscPhotos[3].focal_y === 50 && miscPhotos[3].zoom === 1);
  check('reopen: existing photos keep their captions, an appended photo stores its caption as plain text, an omitted one is empty (issue #84)', JSON.stringify(miscPhotos.map((x) => x.caption)) === JSON.stringify(['Original lead caption', 'Original gallery caption', 'Appended <b>caption</b>', '']), JSON.stringify(miscPhotos.map((x) => x.caption)));
  const miscRead = await call81({}, { method: 'GET', endpoint: `/api/agent/stories/${misc.id}` });
  check('reopen: an appended photo stores fit and fitFill, an omitted one is cover / blur, copied originals keep theirs (issue #82)', JSON.stringify(miscPhotos.map((x) => [x.fit, x.fit_fill])) === JSON.stringify([['cover', 'blur'], ['cover', 'blur'], ['contain', 'paper'], ['cover', 'blur']]), JSON.stringify(miscPhotos.map((x) => [x.fit, x.fit_fill])));
  check('reopen: read-back returns the captions', JSON.stringify(miscRead.data.draft.photos.map((x) => x.caption)) === JSON.stringify(['Original lead caption', 'Original gallery caption', 'Appended <b>caption</b>', '']));
  check('reopen: read-back returns fit and fitFill', miscRead.data.draft.photos[2].fit === 'contain' && miscRead.data.draft.photos[2].fitFill === 'paper');
  check('reopen: read-back shows authorTitle, photoCredit, featured and the crops', miscRead.status === 200 && miscRead.data.draft.authorTitle === 'Pastor <b>Synthetic</b>' && miscRead.data.draft.photoCredit === '' && miscRead.data.draft.featured === false && miscRead.data.draft.photos[2].zoom === 2.5);

  const youth = await call81(reopenReq('synthetic-patch-youth', { changes: { section: 'youth' } }));
  check('reopen: a section-only change uses the new section\'s default (first) area', youth.status === 201 && draftFor('synthetic-patch-youth').section === 'youth' && draftFor('synthetic-patch-youth').area === 'youth');
  const oldKey = await call81(reopenReq('synthetic-patch-columns', { changes: { section: 'columns' } }));
  check('reopen: changes.section "columns" (retired, issue #136) is read as features', oldKey.status === 201 && draftFor('synthetic-patch-columns').section === 'features' && draftFor('synthetic-patch-columns').area === '', JSON.stringify(oldKey.data).slice(0, 200));
  const features = await call81(reopenReq('synthetic-patch-features', { changes: { section: 'features' } }));
  check('reopen: a section-only change to a section without areas gives no area', features.status === 201 && draftFor('synthetic-patch-features').section === 'features' && draftFor('synthetic-patch-features').area === '');
  const badArea = await call81(reopenReq('synthetic-patch-areabad', { changes: { section: 'youth', area: 'conference' } }));
  check('reopen: an explicit area that does not fit the new section is still 400 bad_area', badArea.status === 400 && badArea.data.error === 'bad_area' && !draftFor('synthetic-patch-areabad'));
  const sameArea = await call81(reopenReq('synthetic-patch-samesec', { changes: { section: 'news' } }));
  check('reopen: re-sending the current section keeps the current area', sameArea.status === 201 && draftFor('synthetic-patch-samesec').area === 'conference');
  const noArea = await call(reopenReq('synthetic-noarea', { changes: { section: 'news' } }));
  check('reopen: re-sending the current section keeps an empty area exactly (no default applied)', noArea.status === 201 && draftFor('synthetic-noarea').area === '');
  const retryYouth = await call81(reopenReq('synthetic-patch-youth', { changes: { section: 'youth' } }));
  check('reopen: an identical retry of a section-only change replays', retryYouth.status === 200 && retryYouth.data.status === 'replayed');
  const issueOf = (slug) => { const d = draftFor(slug); return d && { n: d.newsletter_issue, p: d.newsletter_position }; };
  let ri = await call81(reopenReq('synthetic-issue-keep', { changes: { dek: 'Synthetic updated summary.' } }));
  check('reopen: a story\'s newsletter issue and position carry into the draft when changes omit it', ri.status === 201 && JSON.stringify(issueOf('synthetic-issue-keep')) === JSON.stringify({ n: 5, p: 2 }), ri.raw.slice(0, 200));
  ri = await call81(reopenReq('synthetic-issue-set', { changes: { newsletterIssue: { number: 6, date: '2026-08-17', title: 'Synthetic Late Summer', position: 4 } } }));
  check('reopen: changes.newsletterIssue with a new number creates the issue and sets the draft', ri.status === 201 && JSON.stringify(issueOf('synthetic-issue-set')) === JSON.stringify({ n: 6, p: 4 }) && row('SELECT date,title FROM newsletter_issues WHERE number=6').date === '2026-08-17', ri.raw.slice(0, 200));
  const readIssue = await call81({}, { method: 'GET', endpoint: `/api/agent/stories/${draftFor('synthetic-issue-set').id}` });
  check('reopen: read-back shows newsletterIssue {number, date, title, position}', JSON.stringify(readIssue.data.draft.newsletterIssue) === JSON.stringify({ number: 6, date: '2026-08-17', title: 'Synthetic Late Summer', position: 4 }));
  ri = await call81(reopenReq('synthetic-issue-clear', { changes: { newsletterIssue: null } }));
  check('reopen: changes.newsletterIssue null clears issue and position on the draft (the live story keeps them)', ri.status === 201 && JSON.stringify(issueOf('synthetic-issue-clear')) === JSON.stringify({ n: null, p: null }) && row("SELECT newsletter_issue n FROM stories WHERE slug='synthetic-issue-clear'").n === 5);
  const kpOf = (slug) => JSON.parse(draftFor(slug).key_points);
  ri = await call81(reopenReq('synthetic-kp-keep', { changes: { dek: 'Synthetic kp summary.' } }));
  check('reopen: a story key points carry into the draft when changes omit them', ri.status === 201 && JSON.stringify(kpOf('synthetic-kp-keep')) === JSON.stringify(['Synthetic point one.', 'Synthetic point two.']), ri.raw.slice(0, 200));
  ri = await call81(reopenReq('synthetic-kp-set', { changes: { keyPoints: ['  Set by reopen  ', '', '<b>Plain</b> text'] } }));
  check('reopen: changes.keyPoints sets the draft (trimmed, empties dropped, raw text)', ri.status === 201 && JSON.stringify(kpOf('synthetic-kp-set')) === JSON.stringify(['Set by reopen', '<b>Plain</b> text']), ri.raw.slice(0, 200));
  const readKp = await call81({}, { method: 'GET', endpoint: `/api/agent/stories/${draftFor('synthetic-kp-set').id}` });
  check('reopen: read-back returns keyPoints', JSON.stringify(readKp.data.draft?.keyPoints) === JSON.stringify(['Set by reopen', '<b>Plain</b> text']), readKp.raw.slice(0, 200));
  for (const [slug, value] of [['synthetic-kp-clear', []], ['synthetic-kp-null', null]]) {
    ri = await call81(reopenReq(slug, { changes: { keyPoints: value } }));
    check('reopen: changes.keyPoints ' + JSON.stringify(value) + ' clears the draft (the live story keeps them)', ri.status === 201 && kpOf(slug).length === 0 && JSON.parse(row('SELECT key_points k FROM stories WHERE slug=?', slug).k).length === 2, ri.raw.slice(0, 200));
  }
  ri = await call81(reopenReq('synthetic-kp-bad', { changes: { keyPoints: ['a', 'b', 'c', 'd'] } }));
  check('reopen: four key points is 400 bad_key_points and creates nothing', ri.status === 400 && ri.data.error === 'bad_key_points' && !draftFor('synthetic-kp-bad'), ri.raw.slice(0, 200));
  ri = await call81(reopenReq('synthetic-issue-conflict', { changes: { newsletterIssue: { number: 5, date: '2026-08-11' } } }));
  check('reopen: a conflicting issue date is 400 newsletter_issue_conflict naming the stored date, and no draft is created', ri.status === 400 && ri.data.error === 'newsletter_issue_conflict' && ri.data.message.includes('2026-08-10') && !draftFor('synthetic-issue-conflict') && row('SELECT date FROM newsletter_issues WHERE number=5').date === '2026-08-10');
  ri = await call81(reopenReq('synthetic-issue-bad', { changes: { newsletterIssue: { number: 7, date: '2999-01-01' } } }));
  check('reopen: a malformed (future-dated) issue is 400 bad_newsletter_issue and creates nothing', ri.status === 400 && ri.data.error === 'bad_newsletter_issue' && !draftFor('synthetic-issue-bad') && !row('SELECT 1 x FROM newsletter_issues WHERE number=7'));
  const caps81 = await call81({}, { method: 'GET', endpoint: '/api/agent/sections' });
  check('capabilities advertise the reopen change fields and the section-only rule', caps81.status === 200 && caps81.data.reopen.changesFields.includes('authorTitle') && caps81.data.reopen.changesFields.includes('featured') && /default area/.test(caps81.data.reopen.sectionOnly));
  check('none of these reopens wrote a live story row', JSON.stringify(rows('SELECT * FROM stories ORDER BY id')) === rowsBefore81 && JSON.stringify(rows('SELECT * FROM story_photos ORDER BY id')) === photosBefore81);
  check('no photo upload leaked from the refused requests (only drafts that exist have files)', files().every((f) => !f.includes('areabad')));
  const idGet = await call({}, { method: 'GET', endpoint: `/api/agent/stories/${row('SELECT id FROM drafts WHERE slug=?', 'synthetic-agent-story').id}` });
  check('GET /api/agent/stories/<id> is the read-back route while stories/reopen stays POST-only', idGet.status === 200 && idGet.data.draft.slug === 'synthetic-agent-story' && idGet.data.draft.status === 'in_review' && idGet.data.draft.editorTouched === true && !('agent_note' in idGet.data.draft) && !idGet.raw.includes('Synthetic agent update note') && !idGet.raw.includes('/uploads/'));
  let limited;
  for (let i = 0; i < 65; i++) { limited = await call({}, { method: 'GET', endpoint: '/api/agent/sections' }); if (limited.status === 429) break; }
  const reopenLimited = await call(request('synthetic-agent-story'));
  check('reopen shares the existing agent token rate window', limited.status === 429 && reopenLimited.status === 429 && reopenLimited.headers.get('retry-after') === '3600');
  check('logs never expose token, note, contacts or upload paths', !logs.join('').includes(TOKEN) && !logs.join('').includes('private-synthetic') && !logs.join('').includes('Synthetic agent update note') && !logs.join('').includes('/uploads/'));
  console.log(`\n${checks} agent reopen checks passed.`);
} finally {
  if (server2) { server2.kill(); await Promise.race([new Promise((r) => server2.once('exit', r)), delay(3000)]); }
  if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
  db?.close(); fs.rmSync(scratch, { recursive: true, force: true });
}
