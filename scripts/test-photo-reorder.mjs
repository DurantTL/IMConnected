#!/usr/bin/env node
// Issue 87: drag to reorder photos and replace a photo without losing its details. Runs the BUILT server against a throwaway
// DATA_DIR with synthetic data only.
//   * reorder by the Up/Down/Make lead buttons and by dragging the handle (Playwright); each is version-checked, audited and
//     one revision entry; {{photo N}} markers follow their photos (code and escaped examples stay literal); modules follow photo IDs
//   * Replace keeps the slot id, position, alt, caption and crop, gets a new media_key, keeps markers/modules pointing at the slot,
//     removes the old upload only after commit, rejects bad types/oversize/stale versions without leaking a file
//   * the photo list is axe clean, touch targets are 44px, and nothing scrolls sideways at 320px
//
//   npm run build
//   [PLAYWRIGHT_ROOT=..] [CHROMIUM_PATH=..] [CHROMIUM_NO_SANDBOX=1] [AXE_JS=..] PORT=4811 node scripts/test-photo-reorder.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightRequire = process.env.PLAYWRIGHT_ROOT ? createRequire(path.join(process.env.PLAYWRIGHT_ROOT, 'package.json')) : createRequire(import.meta.url);
const { chromium } = (() => {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { return playwrightRequire(spec); } catch { /* next */ } }
  throw new Error('Playwright was not found. Install it or set PLAYWRIGHT_ROOT.');
})();
const launchOptions = () => ({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--disable-dev-shm-usage', '--disable-gpu', ...(process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
const PORT = Number(process.env.PORT || 4811);
const BASE = `http://localhost:${PORT}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-photo-reorder-'));
const serverLog = [];
let browser, db, checks = 0;
const check = (label, condition, extra = '') => { assert.ok(condition, `${label} ${extra}`); checks++; console.log(`PASS ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  cwd: ROOT,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), DATA_DIR: scratch, SITE_URL: BASE, AUTH_SECRET: 'synthetic-photo-reorder-' + 'x'.repeat(32), RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', PUBLISH_TOKEN: '', AGENT_API_TOKEN: '', TURNSTILE_SECRET_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

const crcTable = Array.from({ length: 256 }, (_, v) => { for (let i = 0; i < 8; i++) v = v & 1 ? 0xedb88320 ^ v >>> 1 : v >>> 1; return v >>> 0; });
const chunk = (type, bytes) => { const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff; for (const b of data) crc = crcTable[(crc ^ b) & 255] ^ crc >>> 8; const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([size, data, sum]); };
const png = (rgb) => {
  const w = 64, h = 40, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = rgb[c];
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const COLORS = [[200, 40, 40], [40, 160, 60], [40, 70, 200], [220, 200, 40]];

try {
  let ready = false;
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error('server exited: ' + serverLog.join('')); try { if ((await fetch(BASE + '/admin/login')).status === 200) { ready = true; break; } } catch {} await sleep(100); }
  check('built server starts', ready);
  db = new DatabaseSync(path.join(scratch, 'imconnected.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const now = Date.now();
  const userId = Number(db.prepare("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES ('reorder-synthetic@example.invalid','Synthetic Editor','editor','active',?,?)").run(now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)').run(createHash('sha256').update(token).digest('hex'), userId, now, now, now + 3600_000);
  const post = (url, form, origin = BASE) => fetch(BASE + url, { method: 'POST', headers: { Origin: origin, Cookie: `__Host-imc_session=${token}` }, body: form, redirect: 'manual' });
  const formOf = (obj) => { const f = new FormData(); for (const [k, v] of Object.entries(obj)) f.set(k, String(v)); return f; };

  const newDraft = async () => { const r = await post('/api/admin/drafts/new', new FormData()); return Number(r.headers.get('location').split('/').pop()); };
  const draft = (id) => db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  const photos = (id) => db.prepare('SELECT * FROM draft_photos WHERE draft_id=? ORDER BY position').all(id);
  const revisions = (id) => db.prepare('SELECT COUNT(*) c FROM draft_revisions WHERE draft_id=?').get(id).c;
  const audits = (action) => db.prepare('SELECT COUNT(*) c FROM audit_log WHERE action=?').get(action).c;
  const uploadFiles = (id) => { const dir = path.join(scratch, 'uploads', String(id)); return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; };
  const photoOp = (id, op, extra = {}, version = draft(id).updated_at) => { const f = formOf({ version, op, ...extra }); return post(`/api/admin/drafts/${id}/photos`, f); };
  const BODY = 'Intro paragraph.\n\n{{photo 2}}\n\n{{photo 3 wide}}\n\n```\n{{photo 1}}\n```\n\nInline `{{photo 3}}` is only an example.\n\n\\{{photo 2}}\n';

  const id = await newDraft();
  const upload = new FormData(); upload.set('version', String(draft(id).updated_at)); upload.set('op', 'upload');
  COLORS.slice(0, 3).forEach((c, i) => upload.append('photos', new Blob([png(c)], { type: 'image/png' }), `p${i}.png`));
  check('three synthetic photos upload', (await post(`/api/admin/drafts/${id}/photos`, upload)).status === 303 && photos(id).length === 3);
  let [a, b, c] = photos(id);
  const saveForm = (extra = {}) => formOf({ version: draft(id).updated_at, title: 'Synthetic reorder story', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: BODY, photoLayout: 'one',
    [`photo_${a.id}_alt`]: 'Alt A', [`photo_${b.id}_alt`]: 'Alt B', [`photo_${c.id}_alt`]: 'Alt C', [`photo_${a.id}_caption`]: 'Caption A', [`photo_${b.id}_caption`]: 'Caption B', [`photo_${c.id}_caption`]: 'Caption C',
    [`photo_${b.id}_focalX`]: 20, [`photo_${b.id}_focalY`]: 70, [`photo_${b.id}_zoom`]: 1.8, [`photo_${b.id}_fit`]: 'contain', [`photo_${b.id}_fitFill`]: 'navy', ...extra });
  const saved = await post(`/api/admin/drafts/${id}/save`, saveForm());
  check('story text, alt, captions and crop save', saved.status === 200 && draft(id).body === BODY && photos(id)[1].zoom === 1.8);

  // ---- buttons: move B down (keeps markers on their photos) ----
  const revs0 = revisions(id), auditsMove0 = audits('draft.photo_move');
  const down = await photoOp(id, `down:${b.id}`);
  check('Down is a redirect with the new position announced', down.status === 303 && /n=photos&pos=3&of=3/.test(down.headers.get('location')), down.headers.get('location'));
  check('order is A, C, B', photos(id).map((p) => p.id).join() === [a.id, c.id, b.id].join());
  check('markers follow their photos: B 2->3, C 3->2; the code block, inline code and escaped marker stay literal',
    draft(id).body === BODY.replace('{{photo 2}}\n\n{{photo 3 wide}}', '{{photo 3}}\n\n{{photo 2 wide}}'), JSON.stringify(draft(id).body));
  check('the reorder is one revision entry and one audit entry', revisions(id) === revs0 + 1 && audits('draft.photo_move') === auditsMove0 + 1);
  check('alt, caption and crop did not move off their photo', (() => { const r = photos(id).find((p) => p.id === b.id); return r.alt === 'Alt B' && r.caption === 'Caption B' && r.zoom === 1.8 && r.focal_x === 20 && r.fit === 'contain' && r.fit_fill === 'navy'; })());

  // ---- version conflict ----
  const stale = draft(id).updated_at - 5;
  const before = JSON.stringify([photos(id).map((p) => p.id), draft(id).body, revisions(id)]);
  const conflict = await photoOp(id, `move:${a.id}`, { to: 3 }, stale);
  check('a stale version is refused with the conflict message and nothing changes', /e=conflict/.test(conflict.headers.get('location')) && JSON.stringify([photos(id).map((p) => p.id), draft(id).body, revisions(id)]) === before);
  check('a cross-origin photo move is refused and changes nothing', (await post(`/api/admin/drafts/${id}/photos`, formOf({ version: draft(id).updated_at, op: `move:${a.id}`, to: 3 }), 'https://evil.invalid')).status === 403 && photos(id)[0].id === a.id);
  check('an unknown position is refused', /e=photo_op/.test((await photoOp(id, `move:${a.id}`, { to: 'x' })).headers.get('location')));

  // ---- move to the end and the start; gallery ranges that stop being continuous are marked for review ----
  await photoOp(id, `move:${a.id}`, { to: 3 }); // order C, B, A
  check('move:<id> to 3 puts the photo last', photos(id).map((p) => p.id).join() === [c.id, b.id, a.id].join());
  await photoOp(id, `move:${a.id}`, { to: 1 }); // order A, C, B
  check('move:<id> to 1 makes it the lead and the body is back to the A, C, B state', photos(id).map((p) => p.id).join() === [a.id, c.id, b.id].join() && draft(id).body.includes('{{photo 3}}\n\n{{photo 2 wide}}'));
  await photoOp(id, `lead:${b.id}`); // B, A, C
  check('Make lead keeps markers on the same photos (B now 1, C 3, A 2)', draft(id).body.includes('{{photo 1}}\n\n{{photo 3 wide}}'), draft(id).body);
  await photoOp(id, `move:${b.id}`, { to: 2 }); // A, B, C (original order)
  check('back to the original order restores the original body', photos(id).map((p) => p.id).join() === [a.id, b.id, c.id].join() && draft(id).body === BODY);

  // ---- replace ----
  [a, b, c] = photos(id);
  const filesBefore = uploadFiles(id), keyB = b.media_key, oldB = b.path;
  const revs1 = revisions(id), auditRep0 = audits('draft.photo_replace');
  const rep = formOf({ version: draft(id).updated_at, op: `replace:${b.id}` });
  rep.set(`replacement_${b.id}`, new Blob([png(COLORS[3])], { type: 'image/png' }), 'new.png');
  const repRes = await post(`/api/admin/drafts/${id}/photos`, rep);
  const nb = photos(id)[1];
  check('Replace redirects with the replaced notice', repRes.status === 303 && /n=photo_replaced/.test(repRes.headers.get('location')));
  check('the slot keeps its id and position, alt, caption and crop', nb.id === b.id && nb.alt === 'Alt B' && nb.caption === 'Caption B' && nb.zoom === 1.8 && nb.focal_x === 20 && nb.focal_y === 70 && nb.fit === 'contain' && nb.fit_fill === 'navy');
  check('it gets a new media_key and a new file; the old upload file is gone after commit', nb.media_key !== keyB && nb.path !== oldB && fs.existsSync(path.join(scratch, 'uploads', nb.path)) && !fs.existsSync(path.join(scratch, 'uploads', oldB)) && uploadFiles(id).length === filesBefore.length);
  check('markers still point at the slot (body untouched)', draft(id).body === BODY);
  check('replace is one revision entry and one audit entry; the revision holds the OLD media_key', revisions(id) === revs1 + 1 && audits('draft.photo_replace') === auditRep0 + 1 && JSON.parse(db.prepare('SELECT payload FROM draft_revisions WHERE draft_id=? ORDER BY id DESC LIMIT 1').get(id).payload).photos.some((p) => p.key === keyB));
  const served = await fetch(`${BASE}/api/admin/photos/${b.id}`, { headers: { Cookie: `__Host-imc_session=${token}` } });
  check('the editor serves the new bytes for the slot', served.status === 200 && Buffer.from(await served.arrayBuffer()).equals(png(COLORS[3])));

  // ---- replace refusals leak nothing ----
  const files1 = uploadFiles(id), revs2 = revisions(id), stateB = JSON.stringify(photos(id));
  const badType = formOf({ version: draft(id).updated_at, op: `replace:${b.id}` }); badType.set(`replacement_${b.id}`, new Blob(['not an image'], { type: 'image/png' }), 'x.png');
  check('a non-image is refused (photo_type)', /e=photo_type/.test((await post(`/api/admin/drafts/${id}/photos`, badType)).headers.get('location')));
  const none = formOf({ version: draft(id).updated_at, op: `replace:${b.id}` });
  check('no file is refused (upload_none)', /e=upload_none/.test((await post(`/api/admin/drafts/${id}/photos`, none)).headers.get('location')));
  const staleRep = formOf({ version: draft(id).updated_at - 5, op: `replace:${b.id}` }); staleRep.set(`replacement_${b.id}`, new Blob([png(COLORS[0])], { type: 'image/png' }), 'y.png');
  check('a stale version is refused and the new file is removed again', /e=conflict/.test((await post(`/api/admin/drafts/${id}/photos`, staleRep)).headers.get('location')) && JSON.stringify(uploadFiles(id)) === JSON.stringify(files1));
  const big = formOf({ version: draft(id).updated_at, op: `replace:${b.id}` }); big.set(`replacement_${b.id}`, new Blob([Buffer.alloc(10 * 1024 * 1024 + 1, 1)], { type: 'image/png' }), 'big.png');
  check('an oversize replacement is refused (photo_big) and leaves no file', /e=photo_big/.test((await post(`/api/admin/drafts/${id}/photos`, big)).headers.get('location')) && JSON.stringify(uploadFiles(id)) === JSON.stringify(files1));
  const otherId = await newDraft();
  const other = new FormData(); other.set('version', String(draft(otherId).updated_at)); other.set('op', 'upload'); other.set('photos', new Blob([png(COLORS[0])], { type: 'image/png' }), 'o.png');
  await post(`/api/admin/drafts/${otherId}/photos`, other);
  const foreign = photos(otherId)[0], foreignFiles = uploadFiles(otherId), foreignKey = foreign.media_key;
  const wrongSlot = formOf({ version: draft(id).updated_at, op: `replace:${foreign.id}` }); wrongSlot.set(`replacement_${foreign.id}`, new Blob([png(COLORS[3])], { type: 'image/png' }), 'z.png');
  check('a photo that belongs to ANOTHER draft is refused (photo_gone) and that draft is untouched', /e=photo_gone/.test((await post(`/api/admin/drafts/${id}/photos`, wrongSlot)).headers.get('location')) && photos(otherId)[0].media_key === foreignKey && JSON.stringify(uploadFiles(otherId)) === JSON.stringify(foreignFiles) && JSON.stringify(uploadFiles(id)) === JSON.stringify(files1));
  check('refusals changed no photo, revision or file', JSON.stringify(photos(id)) === stateB && revisions(id) === revs2 && JSON.stringify(uploadFiles(id)) === JSON.stringify(files1));

  // ---- no-op moves do not bump the version or audit ----
  const v0 = draft(id).updated_at, rv0 = revisions(id), au0 = audits('draft.photo_move');
  const noop = await photoOp(id, `up:${photos(id)[0].id}`);
  check('moving the first photo up is a no-op: no version bump, revision or audit entry', noop.status === 303 && /n=photo_unchanged/.test(noop.headers.get('location')) && draft(id).updated_at === v0 && revisions(id) === rv0 && audits('draft.photo_move') === au0);
  check('a no-op with a stale version is still refused', /e=conflict/.test((await photoOp(id, `up:${photos(id)[0].id}`, {}, v0 - 5)).headers.get('location')));

  // ---- galleries, out-of-range markers and delete (own 4-photo draft) ----
  const gid = await newDraft();
  const gup = new FormData(); gup.set('version', String(draft(gid).updated_at)); gup.set('op', 'upload');
  COLORS.forEach((col, i) => gup.append('photos', new Blob([png(col)], { type: 'image/png' }), `g${i}.png`));
  await post(`/api/admin/drafts/${gid}/photos`, gup);
  let [g1, g2, g3, g4] = photos(gid);
  const GBODY = 'Top.\n\n{{gallery 2-4 columns=3}}\n\n{{photo 6}}\n\n{{photo 4 left}}\n';
  const gsave = () => post(`/api/admin/drafts/${gid}/save`, formOf({ version: draft(gid).updated_at, title: 'Synthetic gallery story', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: GBODY, photoLayout: 'one' }));
  await gsave();
  const swap = await photoOp(gid, `down:${g2.id}`); // order g1 g3 g2 g4: the gallery set {2,3,4} is still continuous
  check('a reorder inside a gallery keeps the range and gives no warning', draft(gid).body === GBODY.replace('{{photo 4 left}}', '{{photo 4 left}}') && !/photos_markers/.test(swap.headers.get('location')), draft(gid).body);
  const lead = await photoOp(gid, `lead:${g3.id}`); // g3 g1 g2 g4: gallery members now at 3,1,4 -> keep 3-4
  check('Make lead on a gallery member shrinks the range to the photos still together, and says so', draft(gid).body === 'Top.\n\n{{gallery 3-4 columns=3}}\n\n{{photo 6}}\n\n{{photo 4 left}}\n' && /n=photos_markers/.test(lead.headers.get('location')), draft(gid).body + lead.headers.get('location'));
  check('a marker for a photo that does not exist is kept exactly as written (out of range, not erased)', draft(gid).body.includes('{{photo 6}}'));
  await photoOp(gid, `move:${g3.id}`, { to: 4 }); // g1 g2 g4 g3: gallery members g2,g4 sit at 2,3
  check('a gallery whose photos stay together follows them when other photos move (and a marker follows its photo)', draft(gid).body.includes('{{gallery 2-3 columns=3}}') && draft(gid).body.includes('{{photo 3 left}}'), draft(gid).body);
  await photoOp(gid, `move:${g4.id}`, { to: 1 }); // g4 g1 g2 g3: g4 at 1, g2 at 3: no longer together
  check('a gallery that cannot be kept becomes {{gallery missing}}', draft(gid).body.includes('{{gallery missing}}'), draft(gid).body);
  // delete: later markers shift onto the right photos; the deleted photo's marker is missing
  await gsave();
  [g1, g2, g3, g4] = photos(gid);
  const delBody = 'A\n\n{{photo 2}}\n\n{{photo 3}}\n\n{{photo 4}}\n\n```\n{{photo 3}}\n```\n';
  await post(`/api/admin/drafts/${gid}/save`, formOf({ version: draft(gid).updated_at, title: 'Synthetic gallery story', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: delBody, photoLayout: 'one' }));
  const delRes = await photoOp(gid, `delete:${g3.id}`);
  check('deleting a photo marks its marker missing and shifts later markers onto the same photos; code stays literal', draft(gid).body === 'A\n\n{{photo 2}}\n\n{{photo missing}}\n\n{{photo 3}}\n\n```\n{{photo 3}}\n```\n' && /n=photos_markers/.test(delRes.headers.get('location')), draft(gid).body);

  // ---- restore across a replace keeps the slot ----
  const rid = await newDraft();
  const rup = new FormData(); rup.set('version', String(draft(rid).updated_at)); rup.set('op', 'upload');
  COLORS.slice(0, 3).forEach((col, i) => rup.append('photos', new Blob([png(col)], { type: 'image/png' }), `r${i}.png`));
  await post(`/api/admin/drafts/${rid}/photos`, rup);
  const [r1, r2, r3] = photos(rid);
  const RBODY = 'Top.\n\n{{photo 2}}\n\n{{photo 3 wide}}\n';
  await post(`/api/admin/drafts/${rid}/save`, formOf({ version: draft(rid).updated_at, title: 'Synthetic restore story', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: RBODY, photoLayout: 'one', [`photo_${r2.id}_alt`]: 'Alt R2', [`photo_${r2.id}_zoom`]: 2 }));
  const restoreTo = db.prepare('SELECT MAX(id) m FROM draft_revisions WHERE draft_id=?').get(rid).m; // the state before the save, with all three photos
  await post(`/api/admin/drafts/${rid}/save`, formOf({ version: draft(rid).updated_at, title: 'Synthetic restore story', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: RBODY + '\nMore.\n', photoLayout: 'one', [`photo_${r2.id}_alt`]: 'Alt R2', [`photo_${r2.id}_zoom`]: 2 }));
  const rev = formOf({ version: draft(rid).updated_at, op: `replace:${r2.id}` }); rev.set(`replacement_${r2.id}`, new Blob([png(COLORS[3])], { type: 'image/png' }), 'rr.png');
  await post(`/api/admin/drafts/${rid}/photos`, rev);
  const withKeys = db.prepare('SELECT id FROM draft_revisions WHERE draft_id=? ORDER BY id DESC LIMIT 1').get(rid).id; // taken by the replace: still names r2's old key
  const newKey = photos(rid)[1].media_key, rFiles = uploadFiles(rid);
  const restored = await post(`/api/admin/drafts/${rid}/revisions`, formOf({ version: draft(rid).updated_at, revisionId: withKeys }));
  const rj = await restored.json();
  check('restoring a revision taken before a Replace succeeds, reports replacedKept and NO missing-media warning', restored.status === 200 && rj.ok && rj.replacedKept === true && rj.warnings.length === 0, JSON.stringify(rj));
  check('the slot keeps its place, id, new file and key; markers and metadata survive; no file is resurrected', photos(rid).map((p) => p.id).join() === [r1.id, r2.id, r3.id].join() && photos(rid)[1].media_key === newKey && draft(rid).body.includes('{{photo 2}}') && !draft(rid).body.includes('missing') && photos(rid)[1].alt === 'Alt R2' && photos(rid)[1].zoom === 2 && JSON.stringify(uploadFiles(rid)) === JSON.stringify(rFiles));
  void restoreTo;
  // two replaces of the same slot: a revision from before both still finds the slot
  const beforeBoth = db.prepare('SELECT MAX(id) m FROM draft_revisions WHERE draft_id=?').get(rid).m;
  for (const col of [COLORS[0], COLORS[2]]) {
    const again = formOf({ version: draft(rid).updated_at, op: `replace:${r1.id}` }); again.set(`replacement_${r1.id}`, new Blob([png(col)], { type: 'image/png' }), 'again.png');
    await post(`/api/admin/drafts/${rid}/photos`, again);
  }
  const lineage = db.prepare('SELECT old_key, new_key FROM draft_photo_key_aliases WHERE draft_id=?').all(rid);
  const slot1Key = photos(rid)[0].media_key;
  check('two replaces of one slot leave every older key pointing at the newest key', lineage.filter((l) => l.new_key === slot1Key).length === 2, JSON.stringify(lineage));
  const twice = await (await post(`/api/admin/drafts/${rid}/revisions`, formOf({ version: draft(rid).updated_at, revisionId: beforeBoth + 1 }))).json();
  check('restoring across two replaces keeps the slot, its place and the newest file', twice.ok && photos(rid)[0].id === r1.id && photos(rid)[0].media_key === slot1Key && photos(rid).length === 3 && twice.replacedKept === true && twice.warnings.length === 0, JSON.stringify(twice));
  // restore after the replaced photo was deleted: genuinely missing, nothing resurrected, no "newer file" claim
  const did = await newDraft();
  const dup = new FormData(); dup.set('version', String(draft(did).updated_at)); dup.set('op', 'upload');
  COLORS.slice(0, 2).forEach((col, i) => dup.append('photos', new Blob([png(col)], { type: 'image/png' }), `d${i}.png`));
  await post(`/api/admin/drafts/${did}/photos`, dup);
  const [d1, d2] = photos(did);
  await post(`/api/admin/drafts/${did}/save`, formOf({ version: draft(did).updated_at, title: 'Synthetic deleted slot', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: 'Top.\n\n{{photo 2}}\n', photoLayout: 'one' }));
  const drep = formOf({ version: draft(did).updated_at, op: `replace:${d2.id}` }); drep.set(`replacement_${d2.id}`, new Blob([png(COLORS[3])], { type: 'image/png' }), 'd.png');
  await post(`/api/admin/drafts/${did}/photos`, drep);
  const withOld = db.prepare('SELECT MAX(id) m FROM draft_revisions WHERE draft_id=?').get(did).m;
  await photoOp(did, `delete:${d2.id}`);
  check('deleting a photo drops its lineage rows', db.prepare('SELECT COUNT(*) c FROM draft_photo_key_aliases WHERE draft_id=?').get(did).c === 0);
  const filesAfterDelete = uploadFiles(did);
  const afterDelete = await (await post(`/api/admin/drafts/${did}/revisions`, formOf({ version: draft(did).updated_at, revisionId: withOld }))).json();
  check('restoring after the replaced photo was deleted reports missing media, not a kept file, and resurrects nothing', afterDelete.ok && afterDelete.warnings.length === 1 && afterDelete.replacedKept === false && photos(did).length === 1 && photos(did)[0].id === d1.id && draft(did).body.includes('{{photo missing}}') && JSON.stringify(uploadFiles(did)) === JSON.stringify(filesAfterDelete), JSON.stringify(afterDelete));
  const html = await (await fetch(`${BASE}/admin/drafts/${id}?n=photo_moved&pos=1&of=3&photo=${a.id}&focus=up`, { headers: { Cookie: `__Host-imc_session=${token}` } })).text();
  check('without JavaScript the server still renders the move notice as role=status', /<p class="admin-ok"[^>]*role="status"[^>]*>Photo moved to position 1 of 3\./.test(html) || /<p[^>]*role="status"[^>]*class="admin-ok"[^>]*>Photo moved to position 1 of 3\./.test(html), html.match(/<p[^>]*admin-ok[^>]*>[^<]*/)?.[0] ?? 'no notice');

  // ---- module story: the image module follows the slot through reorder and replace ----
  const mid = await newDraft();
  const up2 = new FormData(); up2.set('version', String(draft(mid).updated_at)); up2.set('op', 'upload');
  COLORS.slice(0, 2).forEach((col, i) => up2.append('photos', new Blob([png(col)], { type: 'image/png' }), `m${i}.png`));
  await post(`/api/admin/drafts/${mid}/photos`, up2);
  const [m1, m2] = photos(mid);
  const blocks = [{ id: 'blk-a', type: 'text', text: 'Synthetic text.' }, { id: 'blk-b', type: 'image', photoId: m2.id, alt: 'Module alt' }];
  const mSave = await post(`/api/admin/drafts/${mid}/save`, formOf({ version: draft(mid).updated_at, title: 'Synthetic module story', author: 'Synthetic Editor', section: 'news', area: 'conference', date: new Date().toISOString().slice(0, 10), body: 'Synthetic text.', photoLayout: 'one', storyBlocks: JSON.stringify(blocks) }));
  check('a module story with an image module saves', mSave.status === 200 && JSON.parse(draft(mid).story_blocks).some((x) => x.photoId === m2.id), await mSave.clone().text());
  const bodyBefore = draft(mid).body;
  await photoOp(mid, `lead:${m2.id}`);
  const rep2 = formOf({ version: draft(mid).updated_at, op: `replace:${m2.id}` }); rep2.set(`replacement_${m2.id}`, new Blob([png(COLORS[3])], { type: 'image/png' }), 'm.png');
  await post(`/api/admin/drafts/${mid}/photos`, rep2);
  check('image module still points at the same slot after reorder and replace; module story body unchanged', JSON.parse(draft(mid).story_blocks).find((x) => x.type === 'image').photoId === m2.id && photos(mid)[0].id === m2.id && draft(mid).body === bodyBefore && photos(mid)[0].media_key !== m2.media_key);
  check('no other draft was touched', draft(otherId).body === '' && photos(otherId).length === 1 && photos(otherId)[0].media_key === foreignKey && m1.id !== undefined);

  // ---- browser: drag, buttons, announcement, axe, touch targets, 320px ----
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: '__Host-imc_session', value: token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${BASE}/admin/drafts/${id}`);
  await page.locator('[data-studio-tab="photos"]').click();
  const handles = page.locator('[data-photo-handle]');
  check('JavaScript reveals a Drag handle on every photo; Up and Down stay as the keyboard path', await handles.count() === 3 && await page.getByRole('button', { name: 'Move photo 1 down' }).isVisible());
  const orderNow = () => photos(id).map((p) => p.id);
  const expectOrder = async (want) => { for (let i = 0; i < 60; i++) { if (orderNow().join() === want.join()) return true; await sleep(100); } return false; };
  // drag photo 1 (A) below photo 3
  await page.setViewportSize({ width: 1280, height: 3200 }); const boxA = await handles.nth(0).boundingBox();
  const lastCard = await page.locator('[data-photo-item]').nth(2).boundingBox();
  const dragRev0 = revisions(id), dragAudit0 = audits('draft.photo_move');
  // Escape cancels a drag
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxA.x + boxA.width / 2, lastCard.y + lastCard.height - 4, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await sleep(500);
  check('Escape cancels a drag: nothing saved, no indicator left', revisions(id) === dragRev0 && audits('draft.photo_move') === dragAudit0 && await page.locator('.drop-after, .drop-before, .is-dragging').count() === 0);
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2 + 40, { steps: 4 });
  await page.mouse.move(boxA.x + boxA.width / 2, lastCard.y + lastCard.height - 4, { steps: 8 });
  check('while dragging, the drop position is shown', await page.locator('.drop-after').count() === 1);
  await page.mouse.up();
  check('dropping saves the new order (B, C, A) through the version-checked form', await expectOrder([b.id, c.id, a.id]));
  await page.waitForURL(/n=photo_moved/);
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.querySelector('#photo-reorder-live')?.textContent === 'Photo moved to position 3 of 3.');
  check('the position is announced by a live region filled after load (it is not in the page at load)', await page.locator('#photo-reorder-live').getAttribute('data-announce') === 'Photo moved to position 3 of 3.' && await page.locator('.admin-ok[role=status]').count() === 0);
  check('after the reload the Photos tab is open and focus is on a control of the moved photo', await page.locator('[data-studio-tab="photos"]').getAttribute('aria-selected') === 'true' && await page.evaluate((pid) => !!document.activeElement?.closest(`li[data-photo-item="${pid}"]`) && document.activeElement.matches('button'), String(a.id)));
  check('markers followed the dragged photo (A was 1, now 3; B 2 -> 1, C 3 -> 2; the code examples stay literal)', draft(id).body.includes('{{photo 1}}\n\n{{photo 2 wide}}') && draft(id).body.includes('```\n{{photo 1}}\n```') && draft(id).body.includes('`{{photo 3}}`'), draft(id).body);
  check('the drag recorded exactly one revision and one audit entry', revisions(id) === dragRev0 + 1 && audits('draft.photo_move') === dragAudit0 + 1);
  // buttons by click
  await page.locator('[data-studio-tab="photos"]').click();
  await page.getByRole('button', { name: 'Move photo 3 up' }).click();
  check('the Up button reorders (B, A, C)', await expectOrder([b.id, a.id, c.id]));
  await page.waitForURL(/pos=2&of=3/); await page.waitForLoadState('load');
  // a no-op drop (back where it started) does nothing
  await page.locator('[data-studio-tab="photos"]').click();
  await page.setViewportSize({ width: 1280, height: 3200 });
  const h0 = await handles.nth(0).boundingBox();
  const revs3 = revisions(id), noopAudit0 = audits('draft.photo_move'), noopUrl = page.url(), noopVersion = draft(id).updated_at;
  await page.mouse.move(h0.x + 10, h0.y + 10); await page.mouse.down(); await page.mouse.move(h0.x + 10, h0.y + 14, { steps: 2 }); await page.mouse.up();
  await sleep(400);
  check('dropping a photo where it was changes nothing: no request, version, revision or audit entry', page.url() === noopUrl && draft(id).updated_at === noopVersion && audits('draft.photo_move') === noopAudit0 && revisions(id) === revs3, JSON.stringify([revs3, revisions(id), orderNow(), page.url(), h0]));

  // touch drag: a real touch pointer (CDP) on the handle
  {
    const touchContext = await browser.newContext({ viewport: { width: 1280, height: 3200 }, hasTouch: true });
    await touchContext.addCookies([{ name: '__Host-imc_session', value: token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const tp = await touchContext.newPage();
    await tp.goto(`${BASE}/admin/drafts/${id}#photos`);
    await tp.locator('[data-studio-tab="photos"]').click();
    const before = orderNow(), tRev = revisions(id), tAudit = audits('draft.photo_move');
    const hb = await tp.locator('[data-photo-handle]').nth(0).boundingBox(), lb = await tp.locator('[data-photo-item]').nth(2).boundingBox();
    const cdp = await touchContext.newCDPSession(tp);
    const x = hb.x + hb.width / 2, y0 = hb.y + hb.height / 2, y1 = lb.y + lb.height - 4;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (y1 - y0) * i / 8 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check('a touch drag from the handle moves the first photo to the end (one revision, one audit entry)', await expectOrder([before[1], before[2], before[0]]) && revisions(id) === tRev + 1 && audits('draft.photo_move') === tAudit + 1);
    await touchContext.close();
    // put it back: A, B, C -> use the buttons
    await page.goto(`${BASE}/admin/drafts/${id}`);
    await page.locator('[data-studio-tab="photos"]').click();
    for (const name of ['Move photo 3 up', 'Move photo 2 up']) {
      const was = page.url();
      await page.getByRole('button', { name }).click();
      await page.waitForURL((u) => u.href !== was);
      await page.waitForLoadState('load');
    }
  }
  // other chosen files do not ride along with a move or a replace
  {
    await page.goto(`${BASE}/admin/drafts/${id}`);
    await page.locator('[data-studio-tab="photos"]').click();
    const idle = photos(id);
    const decoy = path.join(scratch, 'decoy-file-name.png'); fs.writeFileSync(decoy, png(COLORS[0]));
    await page.locator('.ph-replace summary').nth(2).click();
    await page.locator(`input[name="replacement_${idle[2].id}"]`).setInputFiles(decoy);
    // A later listener on the same event sees what the page's own filter left in the form data (Playwright cannot read multipart bodies).
    await page.evaluate(() => { const f = document.querySelector('#photo-form'); for (const [n, v] of [['op', 'move:999999'], ['to', '1']]) { const i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v; i.dataset.reorder = n; f.append(i); } });
    await page.evaluate(() => { document.querySelector('#photo-form').addEventListener('formdata', (e) => { sessionStorage.setItem('sentKeys', [...e.formData.entries()].map(([k, v]) => k + (v instanceof File ? ':file=' + v.name : '')).join(',')); }); });
    await Promise.all([page.waitForURL(/photo=/), page.getByRole('button', { name: 'Move photo 3 up' }).click()]);
    await page.waitForLoadState('load');
    const sent = [await page.evaluate(() => sessionStorage.getItem('sentKeys') ?? '')];
    check('a file chosen for another photo is not uploaded with a move', sent[0].split(',').filter((k) => k === 'op').length === 1 && !sent[0].split(',').includes('to') && !sent[0].includes('decoy-file-name') && !sent[0].includes('replacement_') && !sent[0].includes(':file='), String(sent.length) + ' ' + sent.map((x) => x.slice(0, 400)).join('|'));
  }

  // replace through the browser
  await page.locator('[data-studio-tab="photos"]').click();
  await page.locator('.ph-replace summary').first().click();
  const pngPath = path.join(scratch, 'browser-new.png'); fs.writeFileSync(pngPath, png(COLORS[2]));
  const slot0 = photos(id)[0], key0 = slot0.media_key;
  await page.locator(`input[name="replacement_${slot0.id}"]`).setInputFiles(pngPath);
  await page.getByRole('button', { name: 'Replace photo 1 with the chosen file' }).click();
  await page.waitForURL(/n=photo_replaced/);
  check('the browser Replace keeps the slot and gives it a new media_key', photos(id)[0].id === slot0.id && photos(id)[0].media_key !== key0 && photos(id)[0].alt === slot0.alt);
  await page.waitForFunction(() => /^Photo replaced\./.test(document.querySelector('#photo-reorder-live')?.textContent ?? ''));
  check('the replaced notice is announced through the live region and focus returns to that photo\'s Replace control', await page.evaluate((pid) => document.activeElement?.matches('.ph-replace summary') && !!document.activeElement.closest(`li[data-photo-item="${pid}"]`), String(slot0.id)));

  // restore across a replace through the revision history UI
  {
    await page.goto(`${BASE}/admin/drafts/${rid}#history`);
    await page.waitForFunction((rev) => [...document.getElementById('draft-revision-choice').options].some((o) => o.value === String(rev)), withKeys);
    await page.locator('#draft-revision-choice').selectOption(String(withKeys));
    await page.locator('#restore-draft-revision').click();
    await page.waitForURL(/revision_restored=1&photo_replaced_kept=1/);
    check('restoring across a replace shows the replaced notice (status) and NOT the missing-media alert', await page.locator('#revision-replaced-kept[role=status]').isVisible() && await page.locator('#revision-missing-media').count() === 0 && !/missing_media/.test(page.url()));
  }
  await page.goto(`${BASE}/admin/drafts/${id}`);
  await page.locator('[data-studio-tab="photos"]').click();
  // focus stays on the control that was used; at an edge it moves to the other direction
  for (const [name, prefix] of [['Move photo 1 down', 'down:'], ['Move photo 2 down', 'up:']]) {
    const was = page.url();
    const movedId = (await page.getByRole('button', { name }).getAttribute('value')).split(':')[1];
    await page.getByRole('button', { name }).click();
    await page.waitForURL((u) => u.href !== was);
    await page.waitForFunction(() => document.activeElement?.matches('button[value^="up:"], button[value^="down:"]'));
    check(`after "${name}" focus is on the moved photo's ${prefix === 'down:' ? 'same Down' : 'other (Up), because Down is now disabled'} button`, await page.evaluate(([x, idv]) => document.activeElement.value.startsWith(x) && !!document.activeElement.closest(`li[data-photo-item="${idv}"]`), [prefix, movedId]));
    await page.waitForFunction(() => (document.querySelector('#photo-reorder-live')?.textContent ?? '').trim() !== '');
    check(`after "${name}" the move is announced once: the live region holds the message and the visible notice no longer has role=status`, await page.evaluate(() => { const live = document.querySelector('#photo-reorder-live').textContent.trim(); const notice = [...document.querySelectorAll('.admin-ok')].find((n) => n.textContent.trim() === live); return !!live && !!notice && !notice.hasAttribute('role'); }));
  }

  // accessibility, touch targets, sideways scroll
  await page.locator('[data-studio-tab="photos"]').click();
  const axePath = process.env.AXE_JS || (() => { try { return playwrightRequire.resolve('axe-core/axe.min.js'); } catch { return ''; } })();
  check('axe is available (set AXE_JS)', !!axePath && fs.existsSync(axePath));
  await page.addScriptTag({ path: axePath });
  await page.locator('.ph-replace summary').first().click();
  const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('#photos'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })));
  check('the photo list has no axe violations', violations.length === 0, JSON.stringify(violations));
  const small = await page.evaluate(() => [...document.querySelectorAll('#photos .ed-photo .ops button, #photos .ed-photo .ops summary, #photos [data-photo-handle]')].map((el) => { const r = el.getBoundingClientRect(); return { t: el.textContent.trim().slice(0, 20), w: r.width, h: r.height }; }).filter((x) => x.w > 0 && (x.h < 43.5 || x.w < 43.5)));
  check('every reorder and replace control is at least 44px', small.length === 0, JSON.stringify(small));
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${BASE}/admin/drafts/${id}`);
    await page.locator('[data-studio-tab="photos"]').click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`no horizontal scroll at ${width}px`, overflow <= 0, String(overflow));
  }
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n'));
  console.log(`\n${checks} photo reorder/replace checks passed.`);
} catch (error) {
  console.error(error);
  console.error(serverLog.join('').slice(-8000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  db?.close();
  if (server.exitCode === null) { const done = new Promise((r) => server.once('exit', r)); server.kill('SIGTERM'); await Promise.race([done, sleep(3000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
  fs.rmSync(scratch, { recursive: true, force: true });
}
