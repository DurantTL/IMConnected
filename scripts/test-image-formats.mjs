// Real synthetic WebP/AVIF fixtures, disposable database and built local server only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { IMAGE_TYPES, IMAGE_HEADER_BYTES, sniffImage } from '../src/lib/image-formats.mjs';
import { openDatabase, runMigrations, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-image-formats-'));
const base = 'http://localhost:4873', studioOrigin = 'https://tools.synthetic.invalid';
const agentToken = 'synthetic-formats-agent-' + 'a'.repeat(40), studioToken = 'synthetic-formats-studio-' + 's'.repeat(40);
const fixtures = Object.fromEntries(['webp', 'avif'].map((ext) => [ext, fs.readFileSync(new URL(`./fixtures/synthetic-photo.${ext}`, import.meta.url))]));
let server, db, checks = 0;
const logs = [], delay = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log('PASS ' + label); };
const ftyp = (major, compatible = [], extended = false) => {
  const header = extended ? 16 : 8, data = Buffer.alloc(header + 8 + compatible.length * 4);
  data.writeUInt32BE(extended ? 1 : data.length); data.write('ftyp', 4);
  if (extended) data.writeUInt32BE(data.length, 12);
  data.write(major, header); compatible.forEach((brand, i) => data.write(brand, header + 8 + i * 4));
  return data;
};
try {
  for (const [ext, bytes] of Object.entries(fixtures)) check('real fixture detected as ' + ext, sniffImage(bytes) === ext);
  for (const bytes of [ftyp('avif'), ftyp('avis'), ftyp('mif1', ['heic', 'avif']), ftyp('mif1', ['miaf', 'avis'], true)]) check('AVIF major/compatible and extended brands accepted', sniffImage(bytes) === 'avif');
  const wrongMinor = ftyp('mif1'); wrongMinor.write('avif', 12);
  const oversized = Buffer.alloc(IMAGE_HEADER_BYTES + 4); oversized.writeUInt32BE(oversized.length); oversized.write('ftypavif', 4);
  const misaligned = Buffer.concat([ftyp('avif'), Buffer.from([0])]); misaligned.writeUInt32BE(misaligned.length);
  const openEnded = ftyp('avif'); openEnded.writeUInt32BE(0);
  for (const bytes of [Buffer.alloc(0), fixtures.avif.subarray(0, 16), ftyp('heic'), ftyp('mp42', ['isom']), Buffer.concat([ftyp('mif1'), Buffer.from('avif')]), wrongMinor, oversized, misaligned, openEnded, Buffer.from('<svg>avif</svg>')]) check('malformed, unrelated or out-of-box AVIF brand rejected', sniffImage(bytes) === null);
  check('legacy JPEG and PNG signature compatibility retained', sniffImage(Buffer.from([255,216,255])) === 'jpg' && sniffImage(Buffer.from([137,80,78,71])) === 'png');

  db = openDatabase(scratch); runMigrations(db, readMigrationsFromDir(path.resolve('src/lib/db/migrations')));
  const run = (sql, ...args) => db.prepare(sql).run(...args), row = (sql, ...args) => db.prepare(sql).get(...args), rows = (sql, ...args) => db.prepare(sql).all(...args);
  const now = Date.now(), session = randomBytes(32).toString('base64url');
  run("INSERT INTO app_state(key,value,updated_at) VALUES('git_adopted_at','synthetic',?)", now);
  const userId = Number(run("INSERT INTO users(email,name,role,status,created_at,updated_at) VALUES('formats-editor@example.invalid','Synthetic Editor','editor','active',?,?)", now, now).lastInsertRowid);
  run('INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,mfa_passed) VALUES(?,?,?,?,?,1)', createHash('sha256').update(session).digest('hex'), userId, now, now, now + 3600000);
  server = spawn(process.execPath, ['--require', './scripts/test-dns-preload.cjs', 'dist/server/entry.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '4873', DATA_DIR: scratch, SITE_URL: base, AGENT_API_TOKEN: agentToken, PUBLISH_TOKEN: studioToken, PUBLISH_ORIGINS: studioOrigin, AUTH_SECRET: 'synthetic-formats-auth-' + 'x'.repeat(40), RESEND_API_KEY: '', GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '', DISCORD_WEBHOOK_URL: '', TURNSTILE_SECRET_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => logs.push(String(d))); server.stderr.on('data', (d) => logs.push(String(d)));
  let ready = false; for (let n = 0; n < 100; n++) { try { await fetch(base + '/admin/login'); ready = true; break; } catch { await delay(100); } }
  check('isolated built server starts', ready);
  const adminHeaders = { Origin: base, Cookie: `__Host-imc_session=${session}` };
  const studioHeaders = { Origin: studioOrigin, Authorization: 'Bearer ' + studioToken };
  const json = async (endpoint, payload, token = agentToken) => {
    const response = await fetch(base + endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Origin: token === studioToken ? studioOrigin : base }, body: JSON.stringify(payload) });
    return { response, data: await response.json() };
  };
  const sections = await (await fetch(base + '/api/agent/sections', { headers: { Authorization: 'Bearer ' + agentToken } })).json();
  check('agent capability discovery advertises both formats', sections.photoFormats.includes('webp') && sections.photoFormats.includes('avif') && sections.announcement.flyer.includes('AVIF'));
  for (const [ext, bytes] of Object.entries(fixtures)) {
    const mime = IMAGE_TYPES[ext], title = 'Synthetic ' + ext + ' event';
    // The bytes, not the declared MIME or filename, select the canonical format.
    const photo = { data: 'data:image/png;base64,' + bytes.toString('base64'), alt: 'Synthetic image fixture' };
    const created = await json('/api/agent/stories', { title, section: 'news', area: 'conference', author: 'Synthetic Author', body: 'A synthetic event description for the compatibility regression.', announcement: { kind: 'event', links: [] }, photos: [photo] });
    const draft = row('SELECT * FROM drafts WHERE title=?', title);
    check(ext + ' agent upload is sniffed, private and unpublished', created.response.status === 201 && draft?.status === 'new' && !row('SELECT 1 FROM stories WHERE title=?', title));
    const first = row('SELECT * FROM draft_photos WHERE draft_id=? ORDER BY position', draft.id);
    check(ext + ' agent original is stored without re-encoding', first.ext === ext && first.path.endsWith('.' + ext) && fs.readFileSync(path.join(scratch, 'uploads', first.path)).equals(bytes));
    let response = await fetch(base + `/api/admin/photos/${first.id}`, { headers: adminHeaders });
    check(ext + ' private editor preview has correct MIME and bytes', response.status === 200 && response.headers.get('content-type') === mime && Buffer.from(await response.arrayBuffer()).equals(bytes));
    response = await fetch(base + `/api/admin/photos/${first.id}`, { redirect: 'manual' });
    check(ext + ' anonymous users cannot retrieve draft images', response.status === 401);
    const list = await (await fetch(base + '/api/stories?limit=50', { headers: studioHeaders })).json();
    const descriptor = list.drafts.find((d) => d.id === draft.id).draftFlyer;
    const flyerUrl = `/api/studio-draft-flyer?draftId=${descriptor.draftId}&photoId=${descriptor.photoId}&key=${descriptor.key}`;
    response = await fetch(base + flyerUrl, { headers: studioHeaders });
    check(ext + ' scoped Studio flyer retains original MIME/bytes and CORS', response.status === 200 && response.headers.get('content-type') === mime && response.headers.get('access-control-allow-origin') === studioOrigin && Buffer.from(await response.arrayBuffer()).equals(bytes));
    response = await fetch(base + flyerUrl, { headers: { Authorization: 'Bearer ' + agentToken } });
    check(ext + ' agent token still cannot read a private flyer', response.status === 401);
    const upload = new FormData(); upload.set('version', String(draft.updated_at)); upload.set('op', 'upload'); upload.append('photos', new Blob([bytes], { type: 'text/plain' }), 'mislabelled.png');
    response = await fetch(base + `/api/admin/drafts/${draft.id}/photos`, { method: 'POST', headers: adminHeaders, body: upload, redirect: 'manual' });
    const uploaded = rows('SELECT * FROM draft_photos WHERE draft_id=? ORDER BY position', draft.id);
    check(ext + ' editor upload also detects bytes instead of MIME/filename', response.status === 303 && uploaded.length === 2 && uploaded.every((p) => p.ext === ext));
    const publish = new FormData(); publish.set('version', String(row('SELECT updated_at FROM drafts WHERE id=?', draft.id).updated_at));
    response = await fetch(base + `/api/admin/drafts/${draft.id}/publish`, { method: 'POST', headers: adminHeaders, body: publish, redirect: 'manual' });
    const live = row('SELECT * FROM stories WHERE draft_id=?', draft.id);
    check(ext + ' synthetic human publication accepts both uploaded images', response.status === 303 && response.headers.get('location').includes('n=published') && !!live && JSON.parse(live.photos).length === 1);
    response = await fetch(base + live.image);
    check(ext + ' public media serves exact bytes and correct MIME', response.status === 200 && response.headers.get('content-type') === mime && Buffer.from(await response.arrayBuffer()).equals(bytes));
    response = await fetch(base + '/api/studio-photo?src=' + encodeURIComponent(live.image), { headers: studioHeaders });
    check(ext + ' authenticated Studio public-photo copy serves exact bytes', response.status === 200 && response.headers.get('content-type') === mime && Buffer.from(await response.arrayBuffer()).equals(bytes));
    response = await fetch(base + '/stories/' + live.slug + '/');
    check(ext + ' published event page renders the flyer', response.status === 200 && (await response.text()).includes(live.image));
    const liveBefore = JSON.stringify(live);
    const reopened = await json('/api/agent/stories/reopen', { slug: live.slug, requestId: 'synthetic-format-reopen-' + ext, photos: [photo] });
    const reopenedPhotos = rows('SELECT * FROM draft_photos WHERE draft_id=? ORDER BY position', draft.id);
    check(ext + ' agent reopen appends without changing the published story', reopened.response.status === 201 && reopenedPhotos.length === 3 && reopenedPhotos[2].ext === ext && JSON.stringify(row('SELECT * FROM stories WHERE id=?', live.id)) === liveBefore);

    const form = new FormData();
    for (const [key, value] of Object.entries({ name: 'Synthetic Submitter', email: 'synthetic@formats-e2e-mail.com', church: 'Synthetic Community', title: 'Synthetic public ' + ext, section: 'news', area: 'conference', body: 'Synthetic public submission text. '.repeat(15), consent: 'yes', t: String(Date.now() - 10000) })) form.set(key, value);
    form.append('photos', new Blob([bytes], { type: mime }), 'synthetic.' + ext);
    response = await fetch(base + '/api/submit', { method: 'POST', headers: { Origin: base, Accept: 'application/json' }, body: form });
    const submitted = row('SELECT * FROM drafts WHERE title=?', 'Synthetic public ' + ext);
    check(ext + ' public submission accepts and retains the original', response.status === 200 && submitted && row('SELECT ext FROM draft_photos WHERE draft_id=?', submitted.id)?.ext === ext);
    const studio = await json('/api/publish', { newsletter: { name: 'Synthetic newsletter', issueDate: '2026-10-22' }, stories: [{ ref: ext, title: 'Synthetic Studio ' + ext, section: 'news', area: 'conference', author: 'Synthetic Author', body: 'Synthetic Studio content.', photos: [{ url: photo.data, alt: photo.alt }] }] }, studioToken);
    const studioLive = row('SELECT * FROM stories WHERE title=?', 'Synthetic Studio ' + ext);
    check(ext + ' Studio data-photo publish writes the canonical extension', studio.response.status === 200 && studioLive?.image.endsWith('.' + ext));
  }
  const countBefore = row('SELECT COUNT(*) n FROM drafts').n;
  const invalid = await json('/api/agent/stories', { title: 'Invalid synthetic AVIF', section: 'news', area: 'conference', body: 'Synthetic invalid photo, with a neutral padding sentence added.', photos: [{ data: 'data:image/avif;base64,' + ftyp('heic').toString('base64') }] });
  check('an AVIF MIME label cannot smuggle an unrelated format into drafts', invalid.response.status === 400 && invalid.data.error === 'photo_not_image' && row('SELECT COUNT(*) n FROM drafts').n === countBefore);
  for (const url of ['/media/%252e%252e/secret.avif', '/api/studio-photo?src=' + encodeURIComponent('/media/../uploads/secret.avif')]) {
    const response = await fetch(base + url, { headers: studioHeaders }); check('AVIF paths retain traversal protection', response.status === 404);
  }
  // Exercise the real standalone importer without touching the frozen archive.
  const archive = path.join(scratch, 'archive'), publicRoot = path.join(scratch, 'public'); fs.mkdirSync(archive);
  for (const [ext, bytes] of Object.entries(fixtures)) {
    const slug = 'synthetic-import-' + ext, relative = `images/stories/${slug}/photo.${ext}`;
    fs.mkdirSync(path.dirname(path.join(publicRoot, relative)), { recursive: true }); fs.writeFileSync(path.join(publicRoot, relative), bytes);
    fs.writeFileSync(path.join(archive, slug + '.md'), `---\ntitle: Synthetic import ${ext}\nsection: news\narea: conference\nauthor: Synthetic Author\ndate: 2026-10-22\nimage: /${relative}\n---\nSynthetic imported body.\n`);
  }
  const imported = spawnSync(process.execPath, ['scripts/import-git-stories.mjs', '--dir', archive, '--public', publicRoot, '--apply'], { env: { ...process.env, DATA_DIR: scratch }, encoding: 'utf8' });
  check('standalone importer accepts both real formats', imported.status === 0);
  for (const [ext, bytes] of Object.entries(fixtures)) {
    const saved = row('SELECT p.path FROM story_photos p JOIN stories s ON p.story_id=s.id WHERE s.slug=?', 'synthetic-import-' + ext);
    check(ext + ' archive import preserves canonical suffix and original bytes', saved.path.endsWith('.' + ext) && fs.readFileSync(path.join(scratch, 'media', saved.path)).equals(bytes));
  }
  console.log(`\n${checks} image format checks passed.`);
} finally {
  if (server) { server.kill(); await Promise.race([new Promise((r) => server.once('exit', r)), delay(3000)]); }
  db?.close(); fs.rmSync(scratch, { recursive: true, force: true });
}
