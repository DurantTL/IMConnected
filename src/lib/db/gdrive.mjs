// A small Google Drive v3 client for the nightly backups: a service-account JWT signed with node:crypto, the
// resumable upload, files.list inside one folder and files.delete. No Google library.
//
// Nothing here ever logs. Errors are thrown with messages that carry the HTTP status and Google's own short error
// text only (and callers pass them through redact() anyway). The key, the JWT and the access token never appear in
// a message.
//
// Scope: the full drive scope by default. drive.file (only files the account created itself) usually cannot see a
// folder or Shared Drive that was merely shared with the account, so Google answers 404 for the folder. A service
// account has no files of its own, so the full scope only reaches what was shared with it; deletes are still limited
// by the caller to the folder, the name pattern and files the account created. GDRIVE_SCOPE=drive.file opts in to the
// narrow scope (it works when the account created the folder itself).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createSign } from 'node:crypto';
import { redact } from './backup-core.mjs';

export const SCOPE_FILE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPE_FULL = 'https://www.googleapis.com/auth/drive';
const DEFAULT_API = 'https://www.googleapis.com';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_ID = /^[A-Za-z0-9_-]{10,100}$/;
const b64u = (v) => Buffer.from(v).toString('base64url');

/**
 * Read the Drive settings from the environment. Returns { configured, missing, problems, scope, apiUrl, tokenUrl,
 * key, folderId }. `key` is the parsed service-account JSON (never exposed by the status page). Backups are off
 * (configured false) unless both GDRIVE_SERVICE_ACCOUNT_JSON (base64) and GDRIVE_FOLDER_ID are set and usable.
 */
/** True for a failure that retrying will not fix: bad request, bad credentials, no permission or quota, missing folder. */
export function isPermanentDriveError(err) {
  const st = err?.status;
  if (st === 403) return !/rate ?limit|too many/i.test(String(err.message));
  return st === 400 || st === 401 || st === 404;
}

export function driveConfig(env = process.env) {
  const rawKey = (env.GDRIVE_SERVICE_ACCOUNT_JSON || '').trim();
  const rawFolder = (env.GDRIVE_FOLDER_ID || '').trim();
  const missing = [];
  const problems = [];
  if (!rawKey) missing.push('GDRIVE_SERVICE_ACCOUNT_JSON');
  if (!rawFolder) missing.push('GDRIVE_FOLDER_ID');
  let key = null;
  if (rawKey) {
    try {
      const parsed = JSON.parse(Buffer.from(rawKey, 'base64').toString('utf8'));
      if (typeof parsed?.client_email === 'string' && typeof parsed?.private_key === 'string' && parsed.private_key.includes('PRIVATE KEY')) key = { client_email: parsed.client_email, private_key: parsed.private_key };
      else problems.push('GDRIVE_SERVICE_ACCOUNT_JSON is not a service-account key (it needs client_email and private_key)');
    } catch {
      problems.push('GDRIVE_SERVICE_ACCOUNT_JSON is not base64 of a JSON key file');
    }
  }
  if (rawFolder && !FOLDER_ID.test(rawFolder)) problems.push('GDRIVE_FOLDER_ID does not look like a Drive folder id');
  const scope = env.GDRIVE_SCOPE === 'drive.file' || env.GDRIVE_SCOPE === SCOPE_FILE ? SCOPE_FILE : SCOPE_FULL;
  return {
    configured: missing.length === 0 && problems.length === 0,
    missing,
    problems,
    scope,
    apiUrl: (env.GDRIVE_API_URL || DEFAULT_API).replace(/\/+$/, ''),
    tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL,
    key,
    folderId: rawFolder,
  };
}

/** The signed JWT for the token endpoint (RS256 over base64url(header).base64url(claims)). */
export function signJwt({ client_email, private_key }, scope, audience, nowSec) {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: client_email, scope, aud: audience, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${signer.sign(private_key).toString('base64url')}`;
}

/** Google's short error text from a failed response body, never the whole body. */
async function failure(what, res) {
  let detail = '';
  try {
    const j = JSON.parse(await res.text());
    detail = j?.error?.message || j?.error_description || (typeof j?.error === 'string' ? j.error : '') || '';
  } catch { /* not JSON */ }
  const err = new Error(redact(`${what} failed (HTTP ${res.status}${detail ? `: ${detail}` : ''})`));
  err.status = res.status;
  return err;
}

const netError = (what, err) => {
  const cause = err?.cause?.code || err?.code;
  return new Error(redact(err?.name === 'TimeoutError' ? `${what} timed out` : `${what} could not reach the server${cause ? ` (${cause})` : ''}`));
};

/** A client bound to one configuration. The access token is cached until shortly before it expires. */
export function createDriveClient(cfg, { now = () => Date.now() } = {}) {
  if (!cfg.configured || !cfg.key) throw new Error('Google Drive backups are not configured');
  let token = null; // { value, expiresAt }

  async function accessToken(force = false) {
    if (!force && token && token.expiresAt - 60_000 > now()) return token.value;
    const jwt = signJwt(cfg.key, cfg.scope, cfg.tokenUrl, Math.floor(now() / 1000));
    let res;
    try {
      res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw netError('Google sign-in', err);
    }
    if (!res.ok) throw await failure('Google sign-in', res);
    const j = await res.json().catch(() => null);
    if (!j || typeof j.access_token !== 'string') throw new Error('Google sign-in failed (no access token in the answer)');
    token = { value: j.access_token, expiresAt: now() + Math.max(60, Number(j.expires_in) || 3600) * 1000 };
    return token.value;
  }

  /** An authorized JSON call; one retry with a fresh token on 401. */
  async function api(what, method, url, { json, timeout = 30_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const bearer = await accessToken(attempt > 0);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${bearer}`, ...(json ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) },
          body: json ? JSON.stringify(json) : undefined,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        throw netError(what, err);
      }
      if (res.status === 401 && attempt === 0) { token = null; await res.arrayBuffer().catch(() => {}); continue; }
      return res;
    }
  }

  /** Files in the folder: { id, name, size, owned } (not trashed), following pages. */
  async function listFolder() {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: `'${cfg.folderId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,size,ownedByMe,lastModifyingUser(me))',
        pageSize: '100',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        corpora: 'allDrives',
        ...(pageToken ? { pageToken } : {}),
      });
      const res = await api('Listing the Drive folder', 'GET', `${cfg.apiUrl}/drive/v3/files?${params}`);
      if (!res.ok) throw await failure('Listing the Drive folder', res);
      const j = await res.json().catch(() => null);
      if (!j || !Array.isArray(j.files)) throw new Error('Listing the Drive folder failed (unexpected answer)');
      for (const f of j.files) {
        if (typeof f?.id !== 'string' || typeof f?.name !== 'string') continue;
        // "Created by this account": owned by it in My Drive, or last modified by it in a Shared Drive.
        out.push({ id: f.id, name: f.name, size: Number(f.size) || 0, owned: f.ownedByMe === true || f.lastModifyingUser?.me === true });
      }
      pageToken = typeof j.nextPageToken === 'string' ? j.nextPageToken : '';
    } while (pageToken);
    return out;
  }

  async function deleteFile(id) {
    if (!/^[A-Za-z0-9_-]{6,200}$/.test(id)) throw new Error('refusing to delete an odd file id');
    const res = await api('Deleting a Drive file', 'DELETE', `${cfg.apiUrl}/drive/v3/files/${id}?supportsAllDrives=true`);
    await res.arrayBuffer().catch(() => {});
    if (!res.ok && res.status !== 404) throw await failure('Deleting a Drive file', res);
  }

  /** PUT the file's bytes to the resumable session URL, streamed from disk (never held in memory). */
  function putStream(location, file, size, contentType, timeout) {
    return new Promise((resolve, reject) => {
      const url = new URL(location);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, { method: 'PUT', headers: { 'Content-Length': String(size), 'Content-Type': contentType }, timeout }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (body.length < 4000) body += d; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      req.on('error', reject);
      const input = fs.createReadStream(file);
      input.on('error', (e) => req.destroy(e));
      input.pipe(req);
    });
  }

  /**
   * Upload a local file into the folder with a resumable upload: one request opens the session, a second streams the
   * bytes. Returns { id, name, size }. A failure throws; the caller decides whether to retry the whole upload.
   */
  async function uploadFile(file, name, contentType) {
    const size = fs.statSync(file).size;
    const params = new URLSearchParams({ uploadType: 'resumable', supportsAllDrives: 'true', fields: 'id,name,size' });
    let init;
    try {
      init = await fetch(`${cfg.apiUrl}/upload/drive/v3/files?${params}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': contentType,
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify({ name, parents: [cfg.folderId] }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw netError('Starting the Drive upload', err);
    }
    if (init.status === 401) token = null;
    if (!init.ok) throw await failure('Starting the Drive upload', init);
    await init.arrayBuffer().catch(() => {});
    const location = init.headers.get('location');
    if (!location) throw new Error('Starting the Drive upload failed (no upload address in the answer)');
    let parsed;
    try { parsed = new URL(location); } catch { throw new Error('Starting the Drive upload failed (bad upload address)'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Starting the Drive upload failed (bad upload address)');
    // Allow 20 minutes plus a generous floor of 1 MB/s-equivalent time for big archives.
    const timeout = 20 * 60_000 + Math.ceil(size / 1_000_000) * 1000;
    let put;
    try {
      put = await putStream(location, file, size, contentType, timeout);
    } catch (err) {
      throw netError('The Drive upload', err);
    }
    if (put.status < 200 || put.status >= 300) {
      let detail = '';
      try { detail = JSON.parse(put.body)?.error?.message || ''; } catch { /* not JSON */ }
      const e = new Error(redact(`The Drive upload failed (HTTP ${put.status}${detail ? `: ${detail}` : ''})`));
      e.status = put.status;
      throw e;
    }
    let j = null;
    try { j = JSON.parse(put.body); } catch { /* ignore */ }
    if (!j?.id) throw new Error('The Drive upload failed (no file id in the answer)');
    return { id: String(j.id), name, size };
  }

  return { listFolder, deleteFile, uploadFile, accessToken };
}
