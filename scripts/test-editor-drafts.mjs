#!/usr/bin/env node
// End-to-end check of the drafts inbox and story editor against a RUNNING built server and a throwaway data
// folder. Publishing writes to the database: there is no GitHub token, no mock and no network here. Synthetic data only.
//   DATA_DIR=/tmp/x AUTH_SECRET=<32+ chars> SITE_URL=http://localhost:4390 PORT=4390 TRUST_PROXY=true \
//     PUBLISH_TOKEN=<32+ made-up chars> node dist/server/entry.mjs > server.log &
//   DATA_DIR=/tmp/x SITE_URL=http://localhost:4390 PUBLISH_TOKEN=<same> SERVER_LOG=server.log SHOTS=/tmp/shots node scripts/test-editor-drafts.mjs
// Run from the repo root. Playwright (Chromium) is optional: PLAYWRIGHT_ROOT (default /opt/node-tools) and
// CHROMIUM_PATH (default /opt/pw-browsers/chromium). The signed-in editors are inserted straight into the database.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const BASE = (process.env.SITE_URL || 'http://localhost:4390').replace(/\/+$/, '');
if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to the throwaway data folder the server uses.');
const DATA_DIR = path.resolve(process.env.DATA_DIR);
const DB_FILE = path.join(DATA_DIR, 'imconnected.db');
const PUBLISH_TOKEN = process.env.PUBLISH_TOKEN || '';
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : '';
const SERVER_LOG = process.env.SERVER_LOG ? path.resolve(process.env.SERVER_LOG) : '';

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};
const q = (sql, ...args) => {
  const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000');
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};
const run = (sql, ...args) => {
  const db = new DatabaseSync(DB_FILE); db.exec('PRAGMA busy_timeout = 5000');
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
};

// ---- synthetic images (valid, tiny) ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(r, g, b, size = 48) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_A = png(200, 90, 40);
const PNG_B = png(40, 120, 200);

// ---- editors (signed in by inserting a session; the sign-in flows have their own tests) ----
await fetch(BASE + '/admin/login'); // makes the server open the database and apply migrations
const mkUser = (email, name) => {
  const now = Date.now();
  const id = Number(run("INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, 'editor', 'active', ?, ?)", email, name, now, now).lastInsertRowid);
  const token = randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed) VALUES (?, ?, ?, ?, ?, 1)', createHash('sha256').update(token).digest('hex'), id, now, now, now + 3600_000);
  return { id, name, token };
};
const E1 = mkUser('editor-one@example.test', 'Test Editor');
const E2 = mkUser('editor-two@example.test', 'Second Editor');

class Client {
  constructor(user) { this.cookie = user ? `__Host-imc_session=${user.token}` : ''; }
  async req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (method !== 'GET' && h.Origin === undefined) h.Origin = BASE;
    if (h.Origin === null) delete h.Origin;
    const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    const loc = res.headers.get('location');
    return { status: res.status, loc, params: loc ? new URL(loc, BASE).searchParams : new URLSearchParams(), buf, text: buf.toString('utf8'), headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  form(u, fields, files = []) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    for (const f of files) fd.append(f.name ?? 'photos', new Blob([f.bytes]), f.filename);
    return this.req('POST', u, fd);
  }
  async json(u, fields) { const r = await this.form(u, fields); try { r.data = JSON.parse(r.text); } catch { r.data = {}; } return r; }
}
const c1 = new Client(E1);
const c2 = new Client(E2);
const anon = new Client(null);

const draftRow = (id) => q('SELECT * FROM drafts WHERE id = ?', id)[0];
const version = (id) => draftRow(id).updated_at;
const idOf = (r) => Number(/\/admin\/drafts\/(\d+)/.exec(r.loc || '')?.[1]);
const story = (slug) => q('SELECT * FROM stories WHERE slug = ?', slug)[0];
const storyPhotos = (slug) => q('SELECT p.* FROM story_photos p JOIN stories s ON s.id = p.story_id WHERE s.slug = ? ORDER BY p.position', slug);
const storyCount = () => q('SELECT COUNT(*) n FROM stories')[0].n;
const mediaFile = (rel) => path.join(DATA_DIR, 'media', rel);
const mediaFiles = () => { const out = []; const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name))); }; walk(path.join(DATA_DIR, 'media')); return out.sort(); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const getPub = (p) => anon.get(p); // what a visitor sees
const searchHits = async (term) => { const r = await anon.get('/api/search?q=' + encodeURIComponent(term)); try { return JSON.parse(r.text).results.map((x) => x.slug); } catch { return []; } };
const studioList = async () => { if (!PUBLISH_TOKEN) return null; const res = await fetch(BASE + '/api/stories?limit=100', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` } }); return (await res.json()).stories.map((x) => x.id); };
/** Is the story live on every public surface right now? */
async function liveEverywhere(slug, titleText, section) {
  const page = await getPub(`/stories/${slug}/`);
  const sec = await getPub(`/${section}/`);
  const home = await getPub('/');
  const json = await getPub('/stories.json');
  const rss = await getPub('/rss.xml');
  const find = await searchHits(titleText);
  const studio = await studioList();
  return { page: page.status === 200, section: sec.text.includes(`/stories/${slug}/`), home: home.text.includes(`/stories/${slug}/`), json: json.text.includes(`/stories/${slug}/`), rss: rss.text.includes(`/stories/${slug}/`), search: find.includes(slug), studio: studio === null ? true : studio.includes(slug) };
}
const allTrue = (o) => Object.values(o).every(Boolean);
const noneTrue = (o) => Object.entries(o).filter(([k]) => k !== 'page').every(([, v]) => !v);
const baseFields = (over = {}) => ({ title: 'Volunteers Needed for Camp Meeting', dek: 'Cooks, drivers and greeters are welcome.', section: 'news', area: 'churches', column: '', author: 'Pat Example', authorTitle: 'Communication Volunteer', church: 'Example Hills Church', date: '2026-10-19', photoCredit: 'Sam Sample', featured: '1', body: 'Camp meeting is **coming up** and we need help.\n\n> Many hands make light work.\n\n- Cooks\n- Drivers', ...over });

// ================= no code path calls GitHub =================
{
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(ts|astro|mjs|cjs|js)$/.test(e.name) && !/test-/.test(e.name)) { const t = fs.readFileSync(f, 'utf8'); for (const w of ['api.github.com', 'GITHUB_', 'commitToBase', 'openPullRequest', 'githubConfigFromEnv', 'X-GitHub-Api-Version']) if (t.includes(w)) hits.push(`${f}: ${w}`); } } };
  walk('src'); walk('scripts');
  check('no source file in src/ or scripts/ (apart from the tests) can call the GitHub API: no client, no token, no commit helper', hits.length === 0 && !fs.existsSync('src/lib/github.ts') && !fs.existsSync('scripts/mock-github.mjs'), hits.join(' | '));
}

// ================= guards =================
{
  let r = await anon.form('/api/admin/drafts/new', {});
  check('creating a draft without a session is 401', r.status === 401, String(r.status));
  r = await c1.req('POST', '/api/admin/drafts/new', new URLSearchParams(), { Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' });
  check('creating a draft from a foreign Origin is 403', r.status === 403, String(r.status));
  r = await c1.req('POST', '/api/admin/drafts/new', new URLSearchParams(), { Origin: null, 'Content-Type': 'application/x-www-form-urlencoded' });
  check('creating a draft without an Origin header is 403', r.status === 403, String(r.status));
  r = await anon.get('/api/admin/photos/1');
  check('photos are not served without a session (401)', r.status === 401, String(r.status));
  r = await anon.get('/admin');
  check('the inbox redirects to login without a session', r.status === 302 && r.loc === '/admin/login');
  check('no draft was created by the refused requests', q('SELECT COUNT(*) n FROM drafts')[0].n === 0);
}

// ================= rejected-draft retention (before the first inbox visit: cleanup runs once per day per process) =================
let agedId, freshId, agedFile, freshFile;
{
  const mk = async () => { const r = await c1.form('/api/admin/drafts/new', {}); const id = idOf(r);
    await c1.form(`/api/admin/drafts/${id}/photos`, { version: version(id), op: 'upload' }, [{ bytes: PNG_A, filename: 'a.png' }]);
    await c1.form(`/api/admin/drafts/${id}/reject`, { version: version(id), note: 'Synthetic reject' });
    const rel = q('SELECT path FROM draft_photos WHERE draft_id = ?', id)[0].path;
    return [id, path.join(DATA_DIR, 'uploads', rel)]; };
  [agedId, agedFile] = await mk();
  [freshId, freshFile] = await mk();
  check('uploads are stored under DATA_DIR/uploads/<draft>/ with a random name', agedFile.startsWith(path.join(DATA_DIR, 'uploads', String(agedId)) + path.sep) && /\/[0-9a-f]{32}\.png$/.test(agedFile) && fs.existsSync(agedFile), agedFile);
  run('UPDATE drafts SET rejected_at = ? WHERE id = ?', Date.now() - 31 * 86400_000, agedId);
  run('UPDATE drafts SET rejected_at = ? WHERE id = ?', Date.now() - 29 * 86400_000, freshId);
}

// ================= inbox, new story =================
{
  const r = await c1.get('/admin');
  check('inbox loads for a signed-in editor (no-store, noindex)', r.status === 200 && /no-store/.test(r.headers.get('cache-control')) && /noindex/.test(r.headers.get('x-robots-tag')) && r.text.includes('New story'));
  check('daily cleanup deleted photos of a draft rejected 31 days ago, and kept 29-day-old ones',
    !fs.existsSync(agedFile) && q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', agedId)[0].n === 0 && fs.existsSync(freshFile) && q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', freshId)[0].n === 1);
  check('...and the rejected draft itself stays', draftRow(agedId).status === 'rejected');
}

// ================= create, edit, two photos, publish =================
let A, slugA;
{
  let r = await c1.form('/api/admin/drafts/new', {});
  A = idOf(r);
  check('"New story" creates an editor draft and opens it', r.status === 303 && A > 0 && draftRow(A).source === 'editor' && draftRow(A).status === 'in_review');
  r = await c1.get(`/admin/drafts/${A}`);
  check('the editor page loads (no-store, noindex)', r.status === 200 && /no-store/.test(r.headers.get('cache-control')) && /noindex/.test(r.headers.get('x-robots-tag')));
  check('the editor offers the fields, toolbar, preview and photos', ['name="title"', 'name="dek"', 'name="section"', 'name="area"', 'name="column"', 'name="author"', 'name="authorTitle"', 'name="church"', 'name="date"', 'name="featured"', 'data-md="bold"', 'data-md="italic"', 'data-md="heading"', 'data-md="quote"', 'data-md="link"', 'data-md="list"', 'id="preview"', 'sandbox'].every((s) => r.text.includes(s)));
  check('no submitter panel on a draft written in the editor', !r.text.includes('Submitter'));

  r = await c1.json(`/api/admin/drafts/${A}/save`, { version: version(A), ...baseFields() });
  check('save stores the fields and reports who saved', r.status === 200 && r.data.ok && r.data.savedBy === 'Test Editor' && draftRow(A).title === 'Volunteers Needed for Camp Meeting' && draftRow(A).area === 'churches');

  // photos
  const up = await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: 'upload' }, [{ bytes: PNG_A, filename: 'first.png' }, { bytes: PNG_B, filename: 'second.png' }]);
  check('uploading two photos works', up.status === 303 && up.params.get('n') === 'uploaded' && q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', A)[0].n === 2, up.loc);
  let photos = q('SELECT * FROM draft_photos WHERE draft_id = ? ORDER BY position', A);
  const [p1, p2] = photos;
  const served = await c1.get(`/api/admin/photos/${p1.id}`);
  check('an uploaded photo is served to editors with the right type, no-store and nosniff', served.status === 200 && served.headers.get('content-type') === 'image/png' && /no-store/.test(served.headers.get('cache-control')) && served.headers.get('x-content-type-options') === 'nosniff' && Buffer.compare(served.buf, PNG_A) === 0);
  check('...but not to anyone signed out', (await anon.get(`/api/admin/photos/${p1.id}`)).status === 401);
  check('...and uploads are not reachable as public files', (await anon.get(`/uploads/${A}/x.png`)).status === 404 && !fs.existsSync(path.join('public', 'uploads')) && !fs.existsSync(path.join('dist', 'client', 'uploads')));

  // reorder, lead, alt/caption
  await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: `down:${p1.id}` });
  photos = q('SELECT id FROM draft_photos WHERE draft_id = ? ORDER BY position', A);
  check('"down" moves a photo', photos[0].id === p2.id && photos[1].id === p1.id);
  await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: `lead:${p1.id}` });
  photos = q('SELECT id FROM draft_photos WHERE draft_id = ? ORDER BY position', A);
  check('"make lead" puts a photo first', photos[0].id === p1.id && photos[1].id === p2.id);
  await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: `up:${p2.id}` });
  await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: `down:${p2.id}` });
  // a third photo, deleted again (file removed from disk)
  await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: 'upload' }, [{ bytes: PNG_B, filename: 'third.png' }]);
  const third = q('SELECT * FROM draft_photos WHERE draft_id = ? ORDER BY position', A)[2];
  const thirdFile = path.join(DATA_DIR, 'uploads', third.path);
  await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: `delete:${third.id}` });
  check('"delete" removes the photo row and its file', q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', A)[0].n === 2 && !fs.existsSync(thirdFile));
  r = await c1.json(`/api/admin/drafts/${A}/save`, { version: version(A), ...baseFields(), [`photo_${p1.id}_alt`]: 'Volunteers sorting boxes', [`photo_${p2.id}_alt`]: 'A full kitchen'});
  check('alt text is saved with the draft', r.data.ok && q('SELECT alt FROM draft_photos WHERE id = ?', p1.id)[0].alt === 'Volunteers sorting boxes');

  // upload limits
  r = await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: 'upload' }, [{ bytes: Buffer.from('not an image, just text pretending to be one'), filename: 'x.png' }]);
  check('a file that is not a JPG/PNG/WebP is refused (sniffed, not trusted by name)', r.params.get('e') === 'photo_type' && q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', A)[0].n === 2, r.loc);
  const big = Buffer.concat([PNG_A, Buffer.alloc(10 * 1024 * 1024)]);
  r = await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: 'upload' }, [{ bytes: big, filename: 'big.png' }]);
  check('a photo over 10 MB is refused', r.params.get('e') === 'photo_big', r.loc);
  r = await c1.form(`/api/admin/drafts/${A}/photos`, { version: version(A), op: 'upload' }, Array.from({ length: 5 }, (_, i) => ({ bytes: PNG_A, filename: `m${i}.png` })));
  check('more than 6 photos in total is refused (and nothing is stored)', r.params.get('e') === 'photo_limit' && q('SELECT COUNT(*) n FROM draft_photos WHERE draft_id = ?', A)[0].n === 2, r.loc);
  check('no stray files are left in the draft upload folder', fs.readdirSync(path.join(DATA_DIR, 'uploads', String(A))).length === 2);

  // publish
  r = await c1.get(`/admin/drafts/${A}`);
  check('the editor shows both photos with controls', (r.text.match(/class="ed-photo"/g) || []).length === 2 && r.text.includes('Make lead'));
  const storiesBefore = storyCount();
  const mediaBefore = mediaFiles();
  r = await c1.form(`/api/admin/drafts/${A}/publish`, { version: version(A) });
  check('publish redirects back with the published notice', r.status === 303 && r.params.get('n') === 'published', r.loc);
  const row = draftRow(A);
  slugA = row.slug;
  check('the draft is published with its slug and the database marker (no commit)', row.status === 'published' && slugA === '2026-10-19-volunteers-needed-for-camp-meeting' && row.published_commit === 'db' && !!row.published_at && row.published_by === E1.id);
  const st = story(slugA);
  check('exactly one story row was added, live, from the editor, linked to the draft and the editor', storyCount() === storiesBefore + 1 && st.status === 'live' && st.source === 'editor' && st.draft_id === A && st.published_by === E1.id && st.draft === 0 && st.edited_at > 0, JSON.stringify(st).slice(0, 300));
  check('the story fields are what the editor entered', st.title === 'Volunteers Needed for Camp Meeting' && st.section === 'news' && st.area === 'churches' && st.author === 'Pat Example' && st.author_title === 'Communication Volunteer' && st.church === 'Example Hills Church' && st.date === '2026-10-19' && st.photo_credit === 'Sam Sample' && st.featured === 1 && st.image_alt === 'Volunteers sorting boxes' && JSON.stringify(JSON.parse(st.photo_alts)) === JSON.stringify(['A full kitchen']), JSON.stringify(st).slice(0, 400));
  const sp = storyPhotos(slugA);
  const want1 = `stories/${slugA}/${sha256(PNG_A)}.png`, want2 = `stories/${slugA}/${sha256(PNG_B)}.png`;
  check('both photos are rows at stories/<slug>/<sha256>.png, lead first, with the alt texts', sp.length === 2 && sp[0].path === want1 && sp[0].kind === 'lead' && sp[0].alt === 'Volunteers sorting boxes' && sp[1].path === want2 && sp[1].kind === 'gallery' && sp[1].alt === 'A full kitchen' && sp[0].sha256 === sha256(PNG_A), JSON.stringify(sp));
  check('...the photo files are byte-identical to the uploads and nothing else was written', Buffer.compare(fs.readFileSync(mediaFile(want1)), PNG_A) === 0 && Buffer.compare(fs.readFileSync(mediaFile(want2)), PNG_B) === 0 && mediaFiles().length === mediaBefore.length + 2);
  check('the story keeps its Markdown', st.body.includes('**coming up**') && st.body.includes('> Many hands make light work.') && st.body.includes('- Cooks'));
  check('the uploaded files are deleted after publishing (the photos are in the media folder)', !fs.existsSync(path.join(DATA_DIR, 'uploads', String(A))));
  const retired = q('SELECT url, path FROM draft_photos WHERE draft_id = ? ORDER BY position', A);
  check('...and the draft keeps its photos as site images', retired.length === 2 && retired.every((x) => x.path === null && x.url.startsWith(`/media/stories/${slugA}/`)), JSON.stringify(retired));
  // live on the very next request, everywhere, with its photos
  const live = await liveEverywhere(slugA, 'Volunteers Needed', 'news');
  check('the very next request shows it: story page, section page, home page, /stories.json, /rss.xml, search and /api/stories', allTrue(live), JSON.stringify(live));
  const pageA = (await getPub(`/stories/${slugA}/`)).text;
  const photoRes = await anon.get(`/media/${want1}`);
  check('...with its photos (/media links on the page, served as image/png)', pageA.includes(`/media/${want1}`) && pageA.includes(`/media/${want2}`) && photoRes.status === 200 && photoRes.headers.get('content-type') === 'image/png' && Buffer.compare(photoRes.buf, PNG_A) === 0);
  check('...and /stories.json lists the photo and the title', (await getPub('/stories.json')).text.includes(`/media/${want1}`));
  r = await c1.get(`/admin/drafts/${A}?n=published`);
  check('the editor says "It\'s live now" and links the story', r.text.includes('It&#39;s live now') || r.text.includes("It's live now"));
  check('...with the link to the story', r.text.includes(`${BASE}/stories/${slugA}/`));
  check('the notice no longer promises a 3–5 minute wait', !r.text.includes('3–5 minutes'));
  check('the publish is audited with the slug (and no commit)', q("SELECT detail FROM audit_log WHERE action = 'draft.publish' AND target = ?", `draft:${A}`).some((x) => JSON.parse(x.detail).slug === slugA && !('commit' in JSON.parse(x.detail))));
  r = await c1.json(`/api/admin/drafts/${A}/save`, { version: version(A), ...baseFields() });
  check('a published draft is read-only (save refused with 423)', r.status === 423, String(r.status));
}

// ================= edit the published story and publish again to the same slug =================
{
  const mediaBefore = mediaFiles();
  const before = story(slugA);
  let r = await c1.form('/api/admin/stories/edit', { slug: slugA });
  const id = idOf(r);
  check('"Edit" loads the live story into the same draft (one draft per story)', r.status === 303 && id === A && q('SELECT COUNT(*) n FROM drafts WHERE slug = ?', slugA)[0].n === 1 && draftRow(A).status === 'in_review');
  const d = draftRow(A);
  check('...with the fields read back from the database', d.title === 'Volunteers Needed for Camp Meeting' && d.author === 'Pat Example' && d.author_title === 'Communication Volunteer' && d.church === 'Example Hills Church' && d.date === '2026-10-19' && d.featured === 1 && d.photo_credit === 'Sam Sample' && d.body.startsWith('Camp meeting is **coming up**'), JSON.stringify(d).slice(0, 300));
  const ph = q('SELECT url, path, alt FROM draft_photos WHERE draft_id = ? ORDER BY position', A);
  check('...and its two photos kept as site images with every alt text restored', ph.length === 2 && ph[0].url === `/media/stories/${slugA}/${sha256(PNG_A)}.png` && ph[0].path === null && ph[0].alt === 'Volunteers sorting boxes' && ph[1].alt === 'A full kitchen', JSON.stringify(ph));
  r = await c1.get('/admin/published');
  check('the Published tab lists the story with Edit and Unpublish', r.status === 200 && r.text.includes('Volunteers Needed for Camp Meeting') && r.text.includes('Unpublish') && r.text.includes('>Edit<'));
  r = await c1.json(`/api/admin/drafts/${A}/save`, { version: version(A), ...baseFields({ dek: 'Updated: sign up this Sabbath.', body: 'Camp meeting is **almost here**. Please sign up.' }) });
  check('the loaded draft saves', r.data.ok);
  check('(editing a draft does not change the live story)', story(slugA).dek === before.dek && (await getPub(`/stories/${slugA}/`)).text.includes('coming up'));
  r = await c1.form(`/api/admin/drafts/${A}/publish`, { version: version(A) });
  check('publishing again overwrites the same slug', r.params.get('n') === 'published' && draftRow(A).slug === slugA && draftRow(A).status === 'published' && q('SELECT COUNT(*) n FROM stories WHERE slug = ?', slugA)[0].n === 1, r.loc);
  const st = story(slugA);
  check('...with the new text and the old photos (no new files, same rows)', st.dek === 'Updated: sign up this Sabbath.' && st.body.includes('**almost here**') && storyPhotos(slugA).length === 2 && storyPhotos(slugA)[0].path === `stories/${slugA}/${sha256(PNG_A)}.png` && mediaFiles().length === mediaBefore.length && st.image === `/media/stories/${slugA}/${sha256(PNG_A)}.png`, JSON.stringify(st).slice(0, 300));
  const page = (await getPub(`/stories/${slugA}/`)).text;
  check('...and the new text is on the page at once', page.includes('almost here') && page.includes('Updated: sign up this Sabbath.') && !page.includes('coming up'));
}

// ================= unpublish =================
{
  let r = await c1.form('/api/admin/stories/unpublish', { slug: slugA });
  check('unpublish reports the notice', r.params.get('n') === 'unpublished', r.loc);
  const st = story(slugA);
  check('...the row stays (unpublished, not deleted) with its photos', st.status === 'unpublished' && storyPhotos(slugA).length === 2 && fs.existsSync(mediaFile(`stories/${slugA}/${sha256(PNG_A)}.png`)));
  const gone = await liveEverywhere(slugA, 'Volunteers Needed', 'news');
  check('it is gone everywhere at once: 404 page, section, home, /stories.json, /rss.xml, search, /api/stories', (await getPub(`/stories/${slugA}/`)).status === 404 && noneTrue(gone) && gone.studio === (PUBLISH_TOKEN === '' ? true : false), JSON.stringify(gone));
  check('the draft goes back to in review, keeping its slug', draftRow(A).status === 'in_review' && draftRow(A).slug === slugA && draftRow(A).unpublished_at > 0);
  check('the unpublish is audited', q("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.unpublish' AND target = ?", `story:${slugA}`)[0].n === 1);
  r = await c1.form('/api/admin/stories/unpublish', { slug: '../../etc/passwd' });
  check('a bad story address is refused', r.params.get('e') === 'slug_bad');
  r = await c1.form('/api/admin/stories/unpublish', { slug: 'no-such-story' });
  check('an unknown story is reported', r.params.get('e') === 'story_missing');
  // publishing again brings it back, with no hold, no deploy
  r = await c1.form(`/api/admin/drafts/${A}/publish`, { version: version(A) });
  check('publishing the unpublished draft again makes it live at once (no waiting for a deploy)', r.params.get('n') === 'published' && story(slugA).status === 'live' && (await getPub(`/stories/${slugA}/`)).status === 200 && allTrue(await liveEverywhere(slugA, 'Volunteers Needed', 'news')), r.loc);
}

// ================= reject and restore =================
{
  let r = await c1.form('/api/admin/drafts/new', {});
  const id = idOf(r);
  await c1.json(`/api/admin/drafts/${id}/save`, { version: version(id), ...baseFields({ title: 'A Draft To Reject' }) });
  r = await c1.form(`/api/admin/drafts/${id}/reject`, { version: version(id), note: 'Not a fit for this issue (synthetic).' });
  check('reject sets the status and keeps the internal note', r.params.get('n') === 'rejected' && draftRow(id).status === 'rejected' && draftRow(id).reject_note.startsWith('Not a fit') && draftRow(id).rejected_at > 0);
  r = await c1.get(`/admin/drafts/${id}`);
  check('a rejected draft shows its note and a Restore button, and its fields are locked', r.text.includes('Not a fit for this issue') && r.text.includes('Restore to In review') && /<fieldset[^>]*disabled/.test(r.text));
  r = await c1.json(`/api/admin/drafts/${id}/save`, { version: version(id), ...baseFields() });
  check('saving a rejected draft is refused', r.status === 423);
  r = await c1.form(`/api/admin/drafts/${id}/publish`, { version: version(id) });
  check('publishing a rejected draft is refused', r.params.get('e') === 'not_publishable');
  r = await c1.get('/admin?status=rejected');
  check('the inbox filter shows rejected drafts', r.text.includes('A Draft To Reject') && !(await c1.get('/admin')).text.includes('A Draft To Reject'));
  r = await c1.form(`/api/admin/drafts/${id}/restore`, { version: version(id) });
  check('restore returns the draft to in review', r.params.get('n') === 'restored' && draftRow(id).status === 'in_review' && draftRow(id).rejected_at === null);
  r = await c1.get('/admin?section=youth');
  check('the section filter hides drafts from other sections', !r.text.includes('A Draft To Reject'));
  r = await c1.get('/admin?section=news');
  check('...and shows the matching section', r.text.includes('A Draft To Reject'));
}

// ================= stored XSS: hostile text in every field and the body =================
const XSS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "'><iframe src=javascript:alert(1)>", '</textarea><script>alert(2)</script>'];
let H, slugH;
{
  let r = await c1.form('/api/admin/drafts/new', {});
  H = idOf(r);
  const hostile = baseFields({
    title: XSS[0], dek: XSS[1], section: 'columns', area: '', column: XSS[2], author: XSS[3], authorTitle: XSS[0], church: XSS[1], photoCredit: XSS[2],
    body: `${XSS[0]}\n\n${XSS[1]}\n\n${XSS[4]}\n\n<a href="javascript:alert(1)">raw anchor</a> and <b onmouseover=alert(1)>bold</b>\n\n\`\`\`\n<script>alert('in a fence')</script>\n\`\`\`\n\n[bad link](javascript:alert(1))\n\n![bad image](data:text/html,x)\n\n[ok link](https://example.test/page)`,
  });
  r = await c1.json(`/api/admin/drafts/${H}/save`, { version: version(H), ...hostile });
  check('hostile text is accepted as text', r.data.ok, JSON.stringify(r.data));
  // Astro writes < and > as they are inside a quoted attribute value, which is inert there; look at everything else.
  const page = (await c1.get(`/admin/drafts/${H}`)).text.replace(/="[^"]*"/g, '=""');
  const bad = ['<script>alert(1)', '<script>alert(2)', '<img src=x onerror', '<svg onload', '<iframe src=javascript', '<a href="javascript', '<b onmouseover'];
  check('the editor page never contains raw markup from any field or the body', bad.every((s) => !page.includes(s)), bad.filter((s) => page.includes(s)).join(' | '));
  check('...it shows the text escaped instead', page.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && page.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const scripts = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1].trim()).filter(Boolean);
  check('the only scripts on the page are our own bundle (no inline script holds user text)', scripts.every((s) => !s.includes('alert(')), scripts.join('|').slice(0, 200));
  const pv = await c1.json(`/api/admin/drafts/${H}/preview`, { ...hostile });
  const doc = pv.data.doc || '';
  check('the preview renders', pv.status === 200 && pv.data.ok && doc.includes('<article>'));
  check('the preview holds no live markup from user text', bad.every((s) => !doc.includes(s)) && !/<script\b/i.test(doc.replace(/<meta[^>]*>/g, '')) && !/\bon[a-z]+\s*=\s*alert/i.test(doc.replace(/&lt;[^]*?&gt;/g, '')), bad.filter((s) => doc.includes(s)).join(' | ') + (/<script\b/i.test(doc) ? ' <script> present' : ''));
  check('...and unsafe link targets are replaced', !/href="javascript/i.test(doc) && !/src="data:/i.test(doc) && doc.includes('href="https://example.test/page"'));
  check('...Markdown the editor types is rendered (blockquote, bold, link)', (await c1.json(`/api/admin/drafts/${H}/preview`, { title: 'T', body: '> q\n\n**b** [l](https://example.test/)' })).data.doc.match(/<blockquote>[\s\S]*<strong>b<\/strong>[\s\S]*<a href="https:\/\/example.test\/"/));
  check('...with a CSP that forbids scripts', /Content-Security-Policy" content="default-src 'none'/.test(doc));

  // publish: the javascript: link is refused until it is removed
  const storiesBefore = storyCount();
  r = await c1.form(`/api/admin/drafts/${H}/publish`, { version: version(H) });
  check('publishing is refused while a link uses javascript:', r.params.get('e') === 'link_unsafe' && storyCount() === storiesBefore && draftRow(H).slug === null, r.loc);
  const safeBody = hostile.body.replace('[bad link](javascript:alert(1))', '').replace('![bad image](data:text/html,x)', '');
  await c1.json(`/api/admin/drafts/${H}/save`, { version: version(H), ...hostile, body: safeBody });
  r = await c1.form(`/api/admin/drafts/${H}/publish`, { version: version(H) });
  check('after removing it, the hostile story publishes', r.params.get('n') === 'published' && storyCount() === storiesBefore + 1, r.loc);
  slugH = draftRow(H).slug;
  const hs = story(slugH);
  check('the stored body has no raw HTML anywhere (no "<" followed by a tag)', !/<[a-zA-Z\/!?]/.test(hs.body), (hs.body.match(/<[a-zA-Z\/!?].{0,40}/) || [''])[0]);
  check('...the body is escaped (&lt;script&gt;), even inside a code fence', hs.body.includes('&lt;script>alert(1)&lt;/script>') && hs.body.includes("&lt;script>alert('in a fence')&lt;/script>"), hs.body.slice(0, 300));
  check('...the column field is stored (columns section)', hs.section === 'columns' && hs.story_column === XSS[2]);
  const anonText = (await getPub('/stories.json')).text;
  const hostilePages = [`/stories/${slugH}/`, '/', '/columns/', '/stories.json', '/rss.xml'];
  const pageBad = [];
  for (const u of hostilePages) {
    if (u === '/stories.json') continue; // JSON text, not markup: its strings are checked below
    // Astro leaves < and > as they are inside a quoted attribute value (e.g. og:title), which is inert there.
    const t = (await getPub(u)).text.replace(/="[^"]*"/g, '=""');
    for (const m of ['<script>alert', '<img src=x onerror', '<svg onload', '<iframe src=javascript', '<a href="javascript', '<b onmouseover']) if (t.includes(m)) pageBad.push(`${u}: ${m}`);
  }
  check('the public story page, section page, home page and feeds show hostile text as text, never as markup', pageBad.length === 0, pageBad.join(' | '));
  check('...in /stories.json the hostile text is only a JSON string', (() => { try { return JSON.parse((anonText)).stories.some((x) => x.title === XSS[0]); } catch { return false; } })());
  check('...the story page has the escaped title', (await getPub(`/stories/${slugH}/`)).text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // the title survives a round trip through the database
  r = await c1.form('/api/admin/stories/edit', { slug: slugH });
  check('a story with escaped characters loads back into the editor intact', draftRow(H).title === XSS[0] && draftRow(H).story_column === XSS[2] && draftRow(H).status === 'in_review', JSON.stringify([r.loc, draftRow(H).title, draftRow(H).story_column, draftRow(H).status]));
  await c1.form('/api/admin/stories/unpublish', { slug: slugH });
}

// ================= conflicts =================
{
  let r = await c1.form('/api/admin/drafts/new', {});
  const id = idOf(r);
  await c1.json(`/api/admin/drafts/${id}/save`, { version: version(id), ...baseFields({ title: 'Conflict Story' }) });
  const seen = version(id); // both editors open the draft at this version
  r = await c1.json(`/api/admin/drafts/${id}/save`, { version: seen, ...baseFields({ title: 'Conflict Story (one)' }) });
  check('the first save wins', r.data.ok && version(id) > seen);
  r = await c2.json(`/api/admin/drafts/${id}/save`, { version: seen, ...baseFields({ title: 'Conflict Story (two)' }) });
  check('the second, stale save is rejected with 409 and "Reload"', r.status === 409 && r.data.conflict === true && /Reload/.test(r.data.error) && draftRow(id).title === 'Conflict Story (one)', JSON.stringify(r.data));
  r = await c2.form(`/api/admin/drafts/${id}/photos`, { version: seen, op: 'upload' }, [{ bytes: PNG_A, filename: 'late.png' }]);
  check('a stale photo upload is rejected and leaves no file behind', r.params.get('e') === 'conflict' && !fs.existsSync(path.join(DATA_DIR, 'uploads', String(id))) || fs.readdirSync(path.join(DATA_DIR, 'uploads', String(id))).length === 0, r.loc);
  r = await c2.form(`/api/admin/drafts/${id}/publish`, { version: seen });
  check('a stale publish is rejected', r.params.get('e') === 'conflict' && draftRow(id).status === 'in_review');
  r = await c2.form(`/api/admin/drafts/${id}/reject`, { version: seen, note: '' });
  check('a stale reject is rejected', r.params.get('e') === 'conflict' && draftRow(id).status === 'in_review');
  r = await c2.json(`/api/admin/drafts/${id}/save`, { version: version(id), ...baseFields({ title: 'Conflict Story (two, reloaded)' }) });
  check('after reloading, the second editor can save', r.data.ok);
  const page = (await c1.get(`/admin/drafts/${id}`)).text;
  check('the page shows who saved last', page.includes('by Second Editor'));
  const n = (await c1.json(`/api/admin/drafts/${id}/save`, { version: 'abc', ...baseFields() }));
  check('a bad version is refused', n.status === 400);
}

// ================= submitter contact details =================
const SUB = { name: 'Taylor Synthetic', email: 'taylor.synthetic@example.test', phone: '555-0142-SYN', church: 'Placeholder Valley Church' };
let S;
{
  S = Number(run("INSERT INTO drafts (status, source, title, dek, section, area, author, church, date, body, submitter_name, submitter_email, submitter_phone, submitter_church, email_verified, created_at, updated_at) VALUES ('new','form',?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
    'Youth Day of Service', 'Teens cleaned up a park.', 'youth', 'youth', SUB.name, SUB.church, '2026-10-18', 'A group of teens spent Saturday cleaning a park and sharing lunch with neighbors, a simple act of service for the community.', SUB.name, SUB.email, SUB.phone, SUB.church, Date.now(), Date.now()).lastInsertRowid);
  run('INSERT INTO draft_photos (draft_id, url, alt, position, created_at) VALUES (?, ?, ?, 0, ?)', S, 'https://example.test/synthetic.jpg', 'Teens with trash bags', Date.now());
  let r = await c1.get('/admin');
  check('the inbox shows the source, church, verified badge and photo count', r.text.includes('Youth Day of Service') && r.text.includes('Submit form') && r.text.includes('Email verified') && r.text.includes('Placeholder Valley Church') && r.text.includes('1 photo'));
  r = await c1.get(`/admin/drafts/${S}`);
  check('the submitter panel shows name, mailto email, phone, church and verified status to a signed-in editor',
    r.text.includes('Submitter') && r.text.includes(`href="mailto:${SUB.email}"`) && r.text.includes(SUB.phone) && r.text.includes(SUB.church) && r.text.includes('Taylor Synthetic') && r.text.includes('Verified'));
  r = await anon.get(`/admin/drafts/${S}`);
  check('...and nothing to a signed-out visitor', r.status === 302 && !r.text.includes(SUB.email));
  check('opening a new draft does not change it (GET has no side effects)', draftRow(S).status === 'new');
  r = await c1.json(`/api/admin/drafts/${S}/save`, { version: version(S), ...baseFields({ title: 'Youth Day of Service', section: 'youth', area: 'youth', author: SUB.name, church: SUB.church, body: 'A group of teens spent Saturday cleaning a park and sharing lunch with neighbors.', featured: '0' }) });
  check('the first save moves a new draft to in review', r.data.ok && draftRow(S).status === 'in_review');
  r = await c1.form(`/api/admin/drafts/${S}/publish`, { version: version(S) });
  check('a submitted draft publishes', r.params.get('n') === 'published', r.loc);
  const slugS = draftRow(S).slug;
  const ss = story(slugS);
  const dump = JSON.stringify([ss, storyPhotos(slugS)]) + (await getPub(`/stories/${slugS}/`)).text + (await getPub('/stories.json')).text + (await getPub('/rss.xml')).text + JSON.stringify(await (await anon.get('/api/search?q=youth')).text);
  check('the submitter email and phone are not in the story row or on any public page or feed', !dump.includes(SUB.email) && !dump.includes('taylor.synthetic') && !dump.includes(SUB.phone) && !dump.includes('555-0142') );
  check('...a photo already on the web keeps its https link (a remote photo row, never downloaded)', ss.image === 'https://example.test/synthetic.jpg' && storyPhotos(slugS)[0].url === 'https://example.test/synthetic.jpg' && storyPhotos(slugS)[0].path === null);
  if (PUBLISH_TOKEN) {
    const res = await (await fetch(BASE + '/api/stories?limit=100', { headers: { Authorization: `Bearer ${PUBLISH_TOKEN}` } })).text();
    check('...nor in /api/stories', !res.includes(SUB.email) && !res.includes(SUB.phone));
  }
}


// ================= error codes, body size, stories that came from git =================
{
  let r = await c1.get('/admin/published?e=Call+555-0100+to+claim+your+prize');
  check('?e= text from a link is never shown; only known codes are', !r.text.includes('claim your prize') && !/role="alert"/.test(r.text.replace(/<script[\s\S]*?<\/script>/g, '')));
  r = await c1.get('/admin/published?e=story_missing');
  check('...a known code shows its fixed message', r.text.includes('That story was not found on the site.'));
  r = await c1.get('/admin/published?e=constructor');
  check('...and prototype-style names are ignored', !/role="alert"/.test(r.text));

  const id = idOf(await c1.form('/api/admin/drafts/new', {}));
  const huge = new ReadableStream({ start(ctl) { for (let i = 0; i < 12; i++) ctl.enqueue(new TextEncoder().encode('title=' + 'a'.repeat(50_000) + '&')); ctl.close(); } });
  const res = await fetch(`${BASE}/api/admin/drafts/${id}/save`, { method: 'POST', headers: { Cookie: c1.cookie, Origin: BASE, Connection: 'close', 'Content-Type': 'application/x-www-form-urlencoded' }, body: huge, duplex: 'half' });
  check('a body over the limit is refused (413) even without a Content-Length', res.status === 413, String(res.status));

  // stories that came from git (adopted or imported): raw HTML in the body, a gallery with alt texts, and an unknown section
  const insStory = (slug, f) => Number(run("INSERT INTO stories (slug, title, section, area, author, date, image, image_alt, photos, photo_alts, body, status, source, published_at, updated_at) VALUES (?, ?, ?, 'churches', 'Pat Example', '2026-10-01', ?, ?, ?, ?, ?, 'live', 'git', 1, 1)",
    slug, f.title, f.section ?? 'news', f.image ?? null, f.imageAlt ?? null, JSON.stringify(f.photos ?? []), JSON.stringify(f.photoAlts ?? []), f.body).lastInsertRowid);
  const gid = insStory('cms-html-story', { title: 'CMS Story', image: '/images/stories/cms/one.jpg', imageAlt: 'Lead alt text', photos: ['/images/stories/cms/two.jpg', '/images/stories/cms/three.jpg'], photoAlts: ['Second alt', 'Third alt'], body: 'Plain paragraph.\n\n<div class="note">Raw HTML from git</div>' });
  [['/images/stories/cms/one.jpg', 'lead', 'Lead alt text'], ['/images/stories/cms/two.jpg', 'gallery', 'Second alt'], ['/images/stories/cms/three.jpg', 'gallery', 'Third alt']].forEach(([u, k, alt], i) => run('INSERT INTO story_photos (story_id, position, kind, url, alt) VALUES (?, ?, ?, ?, ?)', gid, i, k, u, alt));
  insStory('odd-section-story', { title: 'Odd Section', section: 'nonsense', body: 'Body.' });
  r = await c1.form('/api/admin/stories/edit', { slug: 'cms-html-story' });
  const cid = idOf(r);
  check('a story that came from git loads into the editor', cid > 0 && draftRow(cid).title === 'CMS Story', r.loc);
  const alts = q('SELECT alt FROM draft_photos WHERE draft_id = ? ORDER BY position', cid).map((x) => x.alt);
  check('...with the lead alt (imageAlt) and every gallery alt (photoAlts) restored', JSON.stringify(alts) === JSON.stringify(['Lead alt text', 'Second alt', 'Third alt']), JSON.stringify(alts));
  r = await c1.get(`/admin/drafts/${cid}`);
  check('raw HTML in a loaded story gets a warning that it will show as plain text', r.text.includes('may hold raw HTML') && r.text.includes('&lt;div class='));
  r = await c1.get(`/admin/drafts/${A}`);
  check('...and a draft without "<" has no warning', !r.text.includes('may hold raw HTML'));
  const draftsBefore = q('SELECT COUNT(*) n FROM drafts')[0].n;
  r = await c1.form('/api/admin/stories/edit', { slug: 'odd-section-story' });
  check('a story with a section the editor does not know is refused, not given a default', r.params.get('e') === 'section_unknown' && q('SELECT COUNT(*) n FROM drafts')[0].n === draftsBefore, r.loc);
  r = await c1.form('/api/admin/stories/edit', { slug: 'no-such-story' });
  check('an unknown story to edit is reported', r.params.get('e') === 'story_missing');
  // publish the story back: every alt becomes imageAlt / photoAlts, the photos keep their rows
  await c1.json(`/api/admin/drafts/${cid}/save`, { version: version(cid), ...baseFields({ title: 'CMS Story', body: 'Plain paragraph.\n\n<div class="note">Raw HTML from git</div>', photoCredit: '' }) });
  r = await c1.form(`/api/admin/drafts/${cid}/publish`, { version: version(cid) });
  const cs = story('cms-html-story');
  check('republishing it writes imageAlt and photoAlts, keeps the three photos and turns raw HTML into text', r.params.get('n') === 'published' && cs.image_alt === 'Lead alt text' && cs.photo_alts === JSON.stringify(['Second alt', 'Third alt']) && cs.photos === JSON.stringify(['/images/stories/cms/two.jpg', '/images/stories/cms/three.jpg']) && storyPhotos('cms-html-story').length === 3 && cs.body.includes('&lt;div class="note">') && !/<[a-zA-Z\/!?]/.test(cs.body) && cs.source === 'editor', JSON.stringify(cs).slice(0, 500));
  const bogus = idOf(await c1.form('/api/admin/drafts/new', {}));
  await c1.json(`/api/admin/drafts/${bogus}/save`, { version: version(bogus), ...baseFields({ title: 'Bogus Photo Link' }) });
  run('INSERT INTO draft_photos (draft_id, url, alt, position, created_at) VALUES (?, ?, ?, 0, ?)', bogus, '/images/stories/not-mine/secret.jpg', 'x', Date.now());
  const nBefore = storyCount();
  r = await c1.form(`/api/admin/drafts/${bogus}/publish`, { version: version(bogus) });
  check('a draft photo pointing at a site path that is not one of the story\'s own photos is refused (photo_link_bad), nothing is written', r.params.get('e') === 'photo_link_bad' && draftRow(bogus).slug === null && storyCount() === nBefore && !story('2026-10-19-bogus-photo-link'), r.loc);
}

// ================= two editors at once, slug reservation, nothing half-written =================
{
  const mk = async (title, body = 'A short story body for the concurrency test.') => { const id = idOf(await c1.form('/api/admin/drafts/new', {})); await c1.json(`/api/admin/drafts/${id}/save`, { version: version(id), ...baseFields({ title, body }) }); return id; };
  // two drafts with the same title and date, published at the same moment by two editors
  const T = await mk('Simultaneous Story');
  const U = await mk('Simultaneous Story');
  const [rT, rU] = await Promise.all([c1.form(`/api/admin/drafts/${T}/publish`, { version: version(T) }), c2.form(`/api/admin/drafts/${U}/publish`, { version: version(U) })]);
  const t = draftRow(T), u = draftRow(U);
  const won = [rT, rU].filter((x) => x.params.get('n') === 'published');
  const slugs = [t.slug, u.slug].filter(Boolean);
  check('two editors publishing the same title at once can never both win the same slug', new Set(slugs).size === slugs.length && won.length >= 1 && slugs.every((sl) => q('SELECT COUNT(*) n FROM stories WHERE slug = ?', sl)[0].n === 1), JSON.stringify([rT.loc, rU.loc, t.slug, u.slug]));
  check('...in practice both publish, one at -2 (each story has its own row and page)', t.status === 'published' && u.status === 'published' && [t.slug, u.slug].sort().join() === ['2026-10-19-simultaneous-story', '2026-10-19-simultaneous-story-2'].join() && (await Promise.all(slugs.map((sl) => getPub(`/stories/${sl}/`)))).every((x) => x.status === 200));
  // the same draft published twice at the same moment: one story
  const D = await mk('Double Click Story');
  const v = version(D);
  const both = await Promise.all([c1.form(`/api/admin/drafts/${D}/publish`, { version: v }), c1.form(`/api/admin/drafts/${D}/publish`, { version: v })]);
  check('the same draft published twice at once publishes once (the other is refused)', both.filter((x) => x.params.get('n') === 'published').length === 1 && both.filter((x) => ['conflict', 'already_publishing', 'not_publishable'].includes(x.params.get('e'))).length === 1 && q("SELECT COUNT(*) n FROM stories WHERE slug LIKE '2026-10-19-double-click-story%'")[0].n === 1, JSON.stringify(both.map((x) => x.loc)));
  // a slug taken by someone else between freshSlug and the write is refused, not taken over
  const V = await mk('Taken Address Story');
  run("INSERT INTO stories (slug, title, section, author, date, source, published_at, updated_at) VALUES ('2026-10-19-taken-address-story', 'Other story', 'news', 'a', '2026-10-19', 'git', 1, 1)");
  const rV = await c1.form(`/api/admin/drafts/${V}/publish`, { version: version(V) });
  check('a story that already has the address is never overwritten by a new draft (it gets -2)', rV.params.get('n') === 'published' && draftRow(V).slug === '2026-10-19-taken-address-story-2' && story('2026-10-19-taken-address-story').title === 'Other story', rV.loc);

  // a stale version from a page opened before another editor's change is refused and writes nothing
  const X = await mk('Stale Version Story');
  const seen = version(X);
  await c2.json(`/api/admin/drafts/${X}/save`, { version: version(X), ...baseFields({ title: 'Stale Version Story', body: 'Changed by editor two.' }) });
  const nX = storyCount();
  const rX = await c1.form(`/api/admin/drafts/${X}/publish`, { version: seen });
  check('publishing from a stale page is refused (conflict) and nothing is written', rX.params.get('e') === 'conflict' && draftRow(X).slug === null && draftRow(X).status === 'in_review' && storyCount() === nX, rX.loc);
  const rX2 = await c1.form(`/api/admin/drafts/${X}/publish`, { version: version(X) });
  check('...after reloading, it publishes the newer text', rX2.params.get('n') === 'published' && story(draftRow(X).slug).body === 'Changed by editor two.');

  // a database error part-way through leaves nothing half-written (a trigger makes the photo insert fail)
  const F = await mk('Database Fails Story');
  await c1.form(`/api/admin/drafts/${F}/photos`, { version: version(F), op: 'upload' }, [{ bytes: PNG_A, filename: 'keep.png' }, { bytes: PNG_B, filename: 'keep2.png' }]);
  await c1.json(`/api/admin/drafts/${F}/save`, { version: version(F), ...baseFields({ title: 'Database Fails Story', body: 'A short story body for the failure test.' }), [`photo_${q('SELECT id FROM draft_photos WHERE draft_id = ? ORDER BY position', F)[1].id}_alt`]: 'BOOM' });
  const fFiles = q('SELECT path FROM draft_photos WHERE draft_id = ?', F).map((x) => path.join(DATA_DIR, 'uploads', x.path));
  run("CREATE TRIGGER zz_fail_photo BEFORE INSERT ON story_photos WHEN NEW.alt = 'BOOM' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  const snap = () => JSON.stringify([q('SELECT * FROM stories ORDER BY id'), q('SELECT * FROM story_photos ORDER BY id'), q('SELECT rowid, * FROM stories_fts'), q('SELECT id, status, slug, published_commit, updated_at FROM drafts ORDER BY id')]);
  const beforeFail = snap();
  const filesBefore = mediaFiles();
  const rF = await c1.form(`/api/admin/drafts/${F}/publish`, { version: version(F) });
  check('a database error in the middle of a publish reports "could not publish"', rF.params.get('e') === 'publish_failed', rF.loc);
  check('...and nothing is half-written: no story, photo rows, search entry, slug or draft change, and no media file left behind', snap() === beforeFail && mediaFiles().join() === filesBefore.join(), 'state changed');
  check('...the draft is still editable with its uploaded photos on disk', draftRow(F).status === 'in_review' && draftRow(F).slug === null && fFiles.every((f) => fs.existsSync(f)));
  check('...and nothing is visible to visitors', (await getPub('/stories/2026-10-19-database-fails-story/')).status === 404);
  run('DROP TRIGGER zz_fail_photo');
  const rF2 = await c1.form(`/api/admin/drafts/${F}/publish`, { version: version(F) });
  check('...once the fault is gone, publishing works', rF2.params.get('n') === 'published' && story('2026-10-19-database-fails-story').status === 'live' && storyPhotos('2026-10-19-database-fails-story').length === 2, rF2.loc);

  // ?n= lookup
  let r = await c1.get('/admin/published?n=constructor');
  check('?n= with a prototype-style name or any other text shows nothing', !/class="admin-ok"/.test(r.text) && !(await c1.get('/admin/published?n=hello+there')).text.includes('hello there'));
  r = await c1.get(`/admin/drafts/${A}?n=constructor`);
  check('...also on the editor page', !/class="admin-ok"/.test(r.text));
  r = await c1.get(`/admin/drafts/${A}?n=published_stale`);
  check('...and the retired GitHub-era notices are gone', !/class="admin-ok"/.test(r.text));
}

// ================= backups reminder on the publish screen =================
{
  const adminE = mkUser('backup-admin@example.test', 'Backup Admin');
  run("UPDATE users SET role = 'admin' WHERE id = ?", adminE.id);
  const cAdmin = new Client(adminE);
  const open = idOf(await cAdmin.form('/api/admin/drafts/new', {}));
  const forAdmin = (await cAdmin.get(`/admin/drafts/${open}`)).text;
  const forEditor = (await c1.get(`/admin/drafts/${open}`)).text;
  check('administrators are reminded on the publish screen when backups are not set up (publishing is not blocked)', forAdmin.includes('id="backups-notice"') && forAdmin.includes('only in this server') && /id="publish-form"/.test(forAdmin), forAdmin.includes('backups-notice') ? 'notice present' : 'no notice');
  check('...ordinary editors do not see it', !forEditor.includes('id="backups-notice"'));
  check('...and the dashboard home shows it to administrators too', (await cAdmin.get('/admin')).text.includes('id="backups-notice"') && !(await c1.get('/admin')).text.includes('id="backups-notice"'));
}

// ================= audit log =================
{
  const rows = q('SELECT action, target, detail FROM audit_log WHERE action LIKE ? ORDER BY id', 'draft.%');
  const count = (a) => rows.filter((x) => x.action === a).length;
  check('create, publish, reject, restore and unpublish are audited', ['draft.create', 'draft.publish', 'draft.reject', 'draft.restore', 'draft.unpublish'].every((a) => count(a) >= 1), JSON.stringify(rows.map((x) => x.action)));
  const saves = rows.filter((x) => x.action === 'draft.save' && x.target === `draft:${A}`).length;
  check('saves are audited but throttled (many saves of one draft, one entry per 10 minutes)', saves === 1, String(saves));
  const all = JSON.stringify(q('SELECT * FROM audit_log'));
  check('the audit log holds no submitter email or phone', !all.includes(SUB.email) && !all.includes(SUB.phone) && !all.includes('taylor'));
}

// ================= logs and the built site =================
{
  if (SERVER_LOG) {
    const log = fs.readFileSync(SERVER_LOG, 'utf8');
    check('the server log holds no submitter email, phone or name', !log.includes(SUB.email) && !log.includes('555-0142') && !log.includes('taylor') && !log.includes('Taylor Synthetic'));
  } else console.log('SKIP  server log check (set SERVER_LOG)');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const built = fs.existsSync('dist') ? walk('dist').filter((f) => !/\.(png|jpe?g|webp|woff2?|wasm)$/.test(f)).some((f) => { const t = fs.readFileSync(f, 'latin1'); return t.includes(SUB.email) || t.includes('555-0142'); }) : false;
  check('the built site (dist/) holds no submitter email or phone', !built);
}

// ================= browser: phone width, inert content, toolbar, preview, autosave =================
let browser;
try {
  const { chromium } = createRequire((process.env.PLAYWRIGHT_ROOT || '/opt/node-tools') + '/package.json')('playwright');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox'] });
} catch (err) {
  console.log('SKIP  browser checks (Playwright/Chromium not available):', err.message.slice(0, 100));
}
if (browser) {
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await context.addCookies([{ name: '__Host-imc_session', value: E1.token, domain: new URL(BASE).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    const noOverflow = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };

    await page.goto(`${BASE}/admin`);
    check('390px: the inbox has no horizontal scroll', await noOverflow());
    await shot('inbox-390.png');

    // hostile draft in a real browser: the editor, the preview and the mobile tabs
    await page.goto(`${BASE}/admin/drafts/${H}`);
    await page.waitForSelector('#preview', { state: 'attached' });
    await page.waitForFunction(() => document.getElementById('preview').srcdoc.length > 50);
    check('390px: the editor has no horizontal scroll', await noOverflow());
    await page.click('.ed-tabs [data-view=preview]');
    await page.waitForTimeout(500);
    const sandbox = await page.getAttribute('#preview', 'sandbox');
    check('the preview frame is sandboxed with no permissions (no scripts, no same-origin)', sandbox === '');
    const frame = page.frameLocator('#preview');
    const frameText = (await frame.locator('body').innerText()).replace(/\s+/g, ' ');
    check('the preview shows the hostile text as text', frameText.includes('<script>alert(1)</script>') && frameText.includes('<img src=x onerror=alert(1)>'), frameText.slice(0, 200));
    check('...and no element was created from it', (await frame.locator('article script, article img, article svg, article iframe, article b').count()) === 0);
    await page.click('.ed-tabs [data-view=write]');
    const titleValue = await page.inputValue('input[name=title]');
    check('the title field holds the hostile text as a plain value', titleValue === XSS[0]);
    check('no script ran and no dialog opened (editor, preview, inbox)', dialogs.length === 0, dialogs.join('|'));

    // the working draft: toolbar, live preview, autosave
    const W = idOf(await c1.form('/api/admin/drafts/new', {}));
    await c1.json(`/api/admin/drafts/${W}/save`, { version: version(W), ...baseFields({ title: 'Phone Width Check', body: 'Short body.' }) });
    await c1.form(`/api/admin/drafts/${W}/photos`, { version: version(W), op: 'upload' }, [{ bytes: PNG_A, filename: 'a.png' }, { bytes: PNG_B, filename: 'b.png' }]);
    await c1.form(`/api/admin/drafts/${W}/photos`, { version: version(W), op: 'upload' }, [{ bytes: PNG_B, filename: 'c.png' }]);
    await page.goto(`${BASE}/admin/drafts/${W}`);
    await page.waitForSelector('.ed-photo img');
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    check('390px: uploaded photos load through the guarded route', true);
    check('390px: the editor with photos has no horizontal scroll', await noOverflow());
    const small = await page.evaluate(() => [...document.querySelectorAll('button, input[type=file], select, .ed-check')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 43 || r.width < 43) && !e.closest('[hidden]'); }).map((e) => e.outerHTML.slice(0, 60)));
    check('390px: buttons and fields are at least 44px tall (touch targets)', small.length === 0, small.slice(0, 3).join(' | '));
    await shot('editor-390.png');
    await page.fill('#f-body', 'Hello world');
    await page.evaluate(() => { const t = document.getElementById('f-body'); t.setSelectionRange(0, 5); });
    await page.click('[data-md=bold]');
    check('the Bold button wraps the selection', (await page.inputValue('#f-body')).startsWith('**Hello** world'));
    await page.click('[data-md=quote]');
    check('the Quote button prefixes the line', (await page.inputValue('#f-body')).startsWith('> **Hello** world'));
    await page.click('.ed-tabs [data-view=preview]');
    await page.waitForFunction(() => document.getElementById('preview').srcdoc.includes('<strong>Hello</strong>'));
    check('the live preview is rendered by the server (blockquote, strong)', (await page.getAttribute('#preview', 'srcdoc')).includes('<blockquote>'));
    await shot('editor-preview-390.png');
    await page.click('.ed-tabs [data-view=write]');
    await page.click('#save-btn');
    await page.waitForFunction(() => /Last saved \d/.test(document.getElementById('save-status').textContent));
    check('Save works and shows the time and name', /Test Editor/.test(await page.textContent('#save-status')) && draftRow(W).body.startsWith('> **Hello** world'), await page.textContent('#save-status'));
    // autosave after 20 s
    await page.fill('#f-body', 'Autosaved text from the browser.');
    await page.waitForFunction(() => /Saving|Last saved/.test(document.getElementById('save-status').textContent));
    await page.waitForTimeout(22000);
    check('autosave saved the change within about 20 seconds', draftRow(W).body === 'Autosaved text from the browser.');
    // a conflict seen by the browser
    await c2.json(`/api/admin/drafts/${W}/save`, { version: version(W), ...baseFields({ title: 'Changed By Someone Else', body: 'Other text' }) });
    await page.fill('#f-body', 'My text that will conflict.');
    await page.click('#save-btn');
    await page.waitForSelector('#conflict:not([hidden])');
    check('the browser shows "reload to see changes" on a stale save and does not overwrite', /Reload to see their changes/.test(await page.textContent('#conflict')) && draftRow(W).body === 'Other text');
    await shot('editor-conflict-390.png');
    // photo operation saves pending edits first, then reloads
    await page.goto(`${BASE}/admin/drafts/${W}`);
    await page.fill('input[name=title]', 'Title edited before a photo change');
    await page.locator('.ed-photo').nth(1).locator('button', { hasText: 'Make lead' }).click();
    await page.waitForURL(/n=photos/);
    check('a photo action first saves unsaved edits, then applies', draftRow(W).title === 'Title edited before a photo change' && q('SELECT id FROM draft_photos WHERE draft_id = ? ORDER BY position', W).length === 3);
    await page.goto(`${BASE}/admin/published`);
    check('390px: the Published tab has no horizontal scroll', await noOverflow());
    await shot('published-390.png');
    check('no dialogs or script errors through the whole browser run', dialogs.length === 0, dialogs.join('|'));
  } catch (err) {
    check('browser run completed without an exception', false, String(err && err.stack ? err.stack : err).slice(0, 600));
  } finally {
    await browser.close();
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
