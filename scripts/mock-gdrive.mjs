// Local stand-in for the parts of Google's OAuth token endpoint and Drive v3 API that the nightly backups use,
// so nothing in a test ever reaches real Google.
// Usage: node scripts/mock-gdrive.mjs
//   then set GDRIVE_API_URL=http://localhost:4013 and GOOGLE_OAUTH_TOKEN_URL=http://localhost:4013/token
//   (MOCK_GDRIVE_PORT changes the port).
//
// Endpoints (the same paths as Google):
//   POST /token                              JWT bearer grant. The assertion's RS256 signature is verified against the
//                                            PEM public key in MOCK_GDRIVE_PUBLIC_KEY_FILE when that is set.
//   POST /upload/drive/v3/files?uploadType=resumable   opens an upload session (answers a Location header)
//   PUT  /upload/drive/v3/files?upload_id=...          receives the bytes (hashed, not kept unless MOCK_GDRIVE_STORE is set)
//   GET  /drive/v3/files?q='<folder>' in parents ...   lists a folder (pageSize and pageToken are honoured)
//   DELETE /drive/v3/files/<id>
// Control endpoints, no auth (test use):
//   GET /__state                  JSON: files, counters, tokens issued, last upload sizes
//   GET /__fail?uploads=N         the next N upload PUTs answer 503
//   GET /__seed?name=..&folder=..&owned=0|1&size=N    adds a file to the folder (owned=0 mimics a file someone else made)
//   GET /__reset                  forget everything
// Every request is printed as one JSON line WITHOUT any credential (paths and statuses only).
import { createServer } from 'node:http';
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.MOCK_GDRIVE_PORT || 4013);
const BASE = `http://localhost:${PORT}`;
const PUBKEY = process.env.MOCK_GDRIVE_PUBLIC_KEY_FILE ? createPublicKey(fs.readFileSync(process.env.MOCK_GDRIVE_PUBLIC_KEY_FILE)) : null;
const STORE = process.env.MOCK_GDRIVE_STORE ? path.resolve(process.env.MOCK_GDRIVE_STORE) : null;
if (STORE) fs.mkdirSync(STORE, { recursive: true });

let files; // id -> { id, name, parents, size, sha256, owned, created }
let sessions; // upload_id -> { name, parents, size }
let tokens; // issued access tokens
let counters;
let failUploads;
let lastUploads;
function reset() {
  files = new Map(); sessions = new Map(); tokens = new Set();
  counters = { tokenRequests: 0, uploadsStarted: 0, uploadsDone: 0, uploadsFailed: 0, deletes: 0, lists: 0 };
  failUploads = 0; lastUploads = [];
}
reset();

const log = (o) => console.log(JSON.stringify(o));
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
};
const apiError = (res, status, message) => send(res, status, { error: { code: status, message } });
const authed = (req) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && tokens.has(m[1]);
};
let counter = 0;
const newId = () => `mock${(++counter).toString().padStart(4, '0')}${randomBytes(8).toString('hex')}`;

function verifyAssertion(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return 'malformed assertion';
  let head, claims;
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return 'malformed assertion'; }
  if (head.alg !== 'RS256') return 'alg must be RS256';
  if (!claims.iss || !claims.scope || claims.aud !== `${BASE}/token`) return `bad claims (aud=${claims.aud})`;
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000) || claims.exp - claims.iat > 3600) return 'bad times';
  if (PUBKEY) {
    const v = createVerify('RSA-SHA256');
    v.update(`${parts[0]}.${parts[1]}`);
    if (!v.verify(PUBKEY, Buffer.from(parts[2], 'base64url'))) return 'bad signature';
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const route = `${req.method} ${url.pathname}`;
  try {
    // ---- control ----
    if (url.pathname === '/__reset') { reset(); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__fail') { failUploads = Number(url.searchParams.get('uploads') || 0); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__seed') {
      const id = newId();
      files.set(id, { id, name: url.searchParams.get('name'), parents: [url.searchParams.get('folder')], size: Number(url.searchParams.get('size') || 1), sha256: 'seed', owned: url.searchParams.get('owned') !== '0', created: Date.now() });
      return send(res, 200, { id });
    }
    if (url.pathname === '/__state') {
      return send(res, 200, { files: [...files.values()], counters, tokens: [...tokens], lastUploads, pendingFailures: failUploads });
    }

    // ---- OAuth ----
    if (route === 'POST /token') {
      let raw = '';
      for await (const c of req) raw += c;
      const form = new URLSearchParams(raw);
      counters.tokenRequests++;
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') { log({ route, status: 400 }); return send(res, 400, { error: 'unsupported_grant_type' }); }
      const bad = verifyAssertion(form.get('assertion'));
      if (bad) { log({ route, status: 400, reason: bad }); return send(res, 400, { error: 'invalid_grant', error_description: bad }); }
      const token = `mock-access-${randomBytes(12).toString('hex')}`;
      tokens.add(token);
      log({ route, status: 200 });
      return send(res, 200, { access_token: token, expires_in: Number(process.env.MOCK_GDRIVE_TOKEN_TTL || 3599), token_type: 'Bearer' });
    }

    // ---- upload: open a session ----
    if (route === 'POST /upload/drive/v3/files') {
      let raw = '';
      for await (const c of req) raw += c;
      if (!authed(req)) { log({ route, status: 401 }); return apiError(res, 401, 'Invalid Credentials'); }
      if (url.searchParams.get('uploadType') !== 'resumable') return apiError(res, 400, 'only resumable uploads are mocked');
      let meta;
      try { meta = JSON.parse(raw); } catch { return apiError(res, 400, 'bad metadata'); }
      if (!meta.name || !Array.isArray(meta.parents) || meta.parents.length !== 1) return apiError(res, 400, 'name and one parent are required');
      const uploadId = randomBytes(10).toString('hex');
      sessions.set(uploadId, { name: meta.name, parents: meta.parents, size: Number(req.headers['x-upload-content-length'] || -1) });
      counters.uploadsStarted++;
      log({ route, status: 200 });
      return send(res, 200, undefined, { Location: `${BASE}/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}` });
    }

    // ---- upload: the bytes ----
    if (route === 'PUT /upload/drive/v3/files') {
      const s = sessions.get(url.searchParams.get('upload_id'));
      const hash = createHash('sha256');
      let got = 0;
      let out = null;
      if (STORE && s) out = fs.createWriteStream(path.join(STORE, `${Date.now()}-${path.basename(s.name)}`));
      for await (const c of req) { hash.update(c); got += c.length; out?.write(c); }
      out?.end();
      if (!s) return apiError(res, 404, 'Unknown upload session');
      if (failUploads > 0) { failUploads--; counters.uploadsFailed++; log({ route, status: 503 }); return apiError(res, 503, 'Backend Error (mock failure)'); }
      if (s.size >= 0 && got !== s.size) { counters.uploadsFailed++; return apiError(res, 400, `size mismatch: promised ${s.size}, got ${got}`); }
      const id = newId();
      files.set(id, { id, name: s.name, parents: s.parents, size: got, sha256: hash.digest('hex'), owned: true, created: Date.now() });
      sessions.delete(url.searchParams.get('upload_id'));
      counters.uploadsDone++;
      lastUploads.push({ name: s.name, size: got, sha256: files.get(id).sha256 });
      log({ route, status: 200, name: s.name, size: got });
      return send(res, 200, { id, name: s.name, size: String(got) });
    }

    // ---- list ----
    if (route === 'GET /drive/v3/files') {
      if (!authed(req)) { log({ route, status: 401 }); return apiError(res, 401, 'Invalid Credentials'); }
      const m = /^'([^']+)' in parents and trashed = false$/.exec(url.searchParams.get('q') || '');
      if (!m) return apiError(res, 400, 'Invalid Value (q)');
      counters.lists++;
      const all = [...files.values()].filter((f) => f.parents.includes(m[1])).sort((a, b) => a.created - b.created);
      const size = Math.min(Number(url.searchParams.get('pageSize') || 100), Number(process.env.MOCK_GDRIVE_MAX_PAGE || 100));
      const start = Number(url.searchParams.get('pageToken') || 0);
      const page = all.slice(start, start + size);
      log({ route, status: 200, count: page.length });
      return send(res, 200, {
        files: page.map((f) => ({ id: f.id, name: f.name, size: String(f.size), ownedByMe: f.owned })),
        ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
      });
    }

    // ---- delete ----
    const del = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && del) {
      if (!authed(req)) { log({ route: 'DELETE /drive/v3/files/:id', status: 401 }); return apiError(res, 401, 'Invalid Credentials'); }
      const f = files.get(del[1]);
      if (!f) return apiError(res, 404, 'File not found');
      if (!f.owned) { log({ route: 'DELETE /drive/v3/files/:id', status: 403 }); return apiError(res, 403, 'The user does not have sufficient permissions for this file.'); }
      files.delete(del[1]);
      counters.deletes++;
      log({ route: 'DELETE /drive/v3/files/:id', status: 204, name: f.name });
      res.writeHead(204);
      return res.end();
    }

    return apiError(res, 404, 'Not found');
  } catch (err) {
    log({ route, error: String(err?.message || err) });
    if (!res.headersSent) apiError(res, 500, 'mock error');
  }
}).listen(PORT, () => console.log(`mock Google Drive on ${BASE} (token endpoint ${BASE}/token)`));
