// Backup building blocks shared by the server (src/lib/backup.ts), scripts/restore-backup.mjs and the tests.
// Plain JS on purpose, like db-core.mjs, so scripts can import it without a build step, and it lives in
// src/lib/db because the Docker image copies that folder next to scripts/.
//
// What is in here: file naming and the retention rule, secret redaction, the SQLite snapshot, a minimal
// streamed tar writer and reader (no dependency), and the media archive built from them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from './db-core.mjs';

// ---------- names and retention ----------

export const DB_SUFFIX = '.db';
export const MEDIA_SUFFIX = '.media.tar.gz';
export const BACKUP_NAME = /^imconnected-(\d{4}-\d{2}-\d{2})(\.db|\.media\.tar\.gz)$/;
export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;

/** YYYY-MM-DD in UTC. */
export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** imconnected-YYYY-MM-DD.db or .media.tar.gz */
export const backupFileName = (day, kind) => `imconnected-${day}${kind === 'db' ? DB_SUFFIX : MEDIA_SUFFIX}`;

/** { day, kind } for a name we create, else null. The date must be a real calendar date. */
export function parseBackupName(name) {
  const m = BACKUP_NAME.exec(String(name));
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1]) return null;
  return { day: m[1], kind: m[2] === DB_SUFFIX ? 'db' : 'media' };
}

const isSunday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay() === 0;

/**
 * Which days to keep: the 7 newest days that have a backup, plus the 4 newest Sundays (UTC) that have one.
 * Days after `today` (a clock gone wrong) are neither kept for their own sake nor ever deleted by the caller:
 * the plan only reports them in `ignored`.
 */
export function retentionPlan(days, today = utcDay()) {
  const all = [...new Set(days)].sort().reverse();
  const ignored = all.filter((d) => d > today);
  const usable = all.filter((d) => d <= today);
  const keep = new Set(usable.slice(0, KEEP_DAILY));
  for (const d of usable.filter(isSunday).slice(0, KEEP_WEEKLY)) keep.add(d);
  return { keep, ignored: new Set(ignored) };
}

/** Of the entries ({ name, ... }) whose names match our pattern, the ones retention would delete. */
export function expiredEntries(entries, today = utcDay()) {
  const named = entries.map((e) => ({ e, p: parseBackupName(e.name) })).filter((x) => x.p);
  const { keep, ignored } = retentionPlan(named.map((x) => x.p.day), today);
  if (keep.size === 0) return []; // never delete everything
  return named.filter((x) => !keep.has(x.p.day) && !ignored.has(x.p.day)).map((x) => x.e);
}

// ---------- secrets ----------

/**
 * Remove anything that looks like a credential from a message before it is logged or stored: the given secret
 * strings, PEM private keys, JWTs, Google access tokens and Bearer values.
 */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && String(s).length >= 8) out = out.split(String(s)).join('[redacted]');
  out = out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g, '[redacted]')
    .replace(/ya29\.[\w.-]+/g, '[redacted]')
    .replace(/Bearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 400);
}

// ---------- SQLite snapshot ----------

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Runs in a worker thread so the server's event loop is never held: VACUUM INTO and the integrity check of a big
// database can take seconds. Inline (eval) code on purpose: the server bundles this module, so there is no
// stable file path to hand to a Worker.
const SNAPSHOT_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const emit = process.emitWarning;
process.emitWarning = function (w, ...a) { const t = typeof a[0] === 'string' ? a[0] : a[0] && a[0].type; if (t === 'ExperimentalWarning') return; return emit.call(process, w, ...a); };
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emit;
try {
  const db = new DatabaseSync(workerData.source);
  try { db.exec('PRAGMA busy_timeout = 5000;'); db.exec('VACUUM INTO ' + workerData.quoted + ';'); } finally { db.close(); }
  const copy = new DatabaseSync(workerData.dest);
  try {
    const rows = copy.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('the database snapshot failed its integrity check');
  } finally { copy.close(); }
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
}
`;

/**
 * A consistent copy of the database at `dest` via VACUUM INTO (one read transaction, so committed data only), on its
 * own connection inside a worker thread: WAL readers do not block writers, a failure cannot disturb the server's
 * shared handle, and the request thread is not stalled however large the database is. The copy is then checked with
 * PRAGMA quick_check (also in the worker), made private (0600) and its size returned.
 */
export async function snapshotDatabase(dataDir, dest) {
  const source = path.join(dataDir, 'imconnected.db');
  if (!fs.existsSync(source)) throw new Error('the database file does not exist');
  fs.rmSync(dest, { force: true });
  const result = await new Promise((resolve, reject) => {
    const w = new Worker(SNAPSHOT_WORKER, { eval: true, workerData: { source, dest, quoted: sqlQuote(dest) } });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => reject(new Error(`the snapshot worker stopped (${code})`)));
  });
  if (!result?.ok) throw new Error(result?.error || 'the database snapshot failed');
  fs.chmodSync(dest, 0o600);
  return fs.statSync(dest).size;
}

// ---------- tar (ustar + pax path records) ----------

const BLOCK = 512;
const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`);
}

function header({ name, prefix = '', size, mtime, type, mode }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(mtime, 12), 136);
  h.fill(0x20, 148, 156);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** Header block(s) for an entry: a plain ustar header when the name fits, else a pax 'path' record first. */
function entryHeaders(relPath, size, mtime, type, mode) {
  const name = type === '5' ? relPath + '/' : relPath;
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100 && /^[\x20-\x7e]*$/.test(name)) return [header({ name, size, mtime, type, mode })];
  // Split at a slash into prefix (<=155) and name (<=100) when possible and plain ASCII.
  if (/^[\x20-\x7e]*$/.test(name)) {
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
      const pre = name.slice(0, i);
      const rest = name.slice(i + 1);
      if (pre.length <= 155 && rest.length > 0 && rest.length <= 100) return [header({ name: rest, prefix: pre, size, mtime, type, mode })];
    }
  }
  const rec = paxRecord('path', name);
  const pad = (BLOCK - (rec.length % BLOCK)) % BLOCK;
  return [
    header({ name: 'PaxHeader', size: rec.length, mtime, type: 'x', mode: 0o644 }),
    Buffer.concat([rec, Buffer.alloc(pad)]),
    header({ name: name.slice(0, 100), size, mtime, type, mode }),
  ];
}

/** Every regular file and directory under dataDir/<top> as '/'-joined relative paths, sorted. Symlinks are skipped. */
async function* walk(dataDir, rel) {
  const abs = path.join(dataDir, rel);
  let entries;
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  yield { rel, dir: true };
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) yield* walk(dataDir, childRel);
    else if (e.isFile() && !(rel === 'media' && e.name === '.build-marker')) yield { rel: childRel, dir: false };
  }
}

/** Read exactly `size` bytes of a file (zero-padded if it shrank meanwhile, cut if it grew), as chunks. */
async function* fileBytes(file, size) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(256 * 1024);
    let left = size;
    while (left > 0) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), null);
      if (bytesRead === 0) {
        while (left > 0) {
          const n = Math.min(buf.length, left);
          yield Buffer.alloc(n);
          left -= n;
        }
        break;
      }
      yield Buffer.from(buf.subarray(0, bytesRead));
      left -= bytesRead;
    }
  } finally {
    await fh.close();
  }
}

/** The tar stream of the given top-level folders of dataDir, produced chunk by chunk (never all in memory). */
const MAX_FILE = 8 * 1024 ** 3; // an octal size field holds less than 8 GiB

async function* tarStream(dataDir, tops, onSkip) {
  for (const top of tops) {
    for await (const item of walk(dataDir, top)) {
      const abs = path.join(dataDir, item.rel);
      let st;
      try {
        st = await fs.promises.stat(abs);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // removed while we were walking
        throw err;
      }
      const mtime = Math.max(0, Math.floor(st.mtimeMs / 1000));
      if (item.dir) {
        for (const h of entryHeaders(item.rel, 0, mtime, '5', 0o755)) yield h;
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size >= MAX_FILE) { onSkip?.(item.rel, st.size); continue; }
      for (const h of entryHeaders(item.rel, st.size, mtime, '0', 0o644)) yield h;
      yield* fileBytes(abs, st.size);
      const pad = (BLOCK - (st.size % BLOCK)) % BLOCK;
      if (pad) yield Buffer.alloc(pad);
    }
  }
  yield Buffer.alloc(BLOCK * 2);
}

/**
 * Write DATA_DIR/media and DATA_DIR/uploads (draft photos too) as a tar.gz at `dest`, streamed through gzip to the
 * file. Memory use stays at a few chunks whatever the size. Returns the size in bytes.
 */
export async function createMediaArchive(dataDir, dest, { onSkip } = {}) {
  fs.rmSync(dest, { force: true });
  await pipeline(Readable.from(tarStream(dataDir, ['media', 'uploads'], onSkip)), zlib.createGzip({ level: 6 }), fs.createWriteStream(dest, { mode: 0o600 }));
  return fs.statSync(dest).size;
}

// ---------- tar reader ----------

const TOP_FOLDERS = new Set(['media', 'uploads']);

/** The safe relative path inside destDir for an archive entry name, or an Error. Only media/ and uploads/ are accepted. */
function safeEntryPath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) throw new Error(`unsafe path in archive: ${JSON.stringify(name.slice(0, 80))}`);
  const parts = name.replace(/\/+$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..') || !TOP_FOLDERS.has(parts[0])) throw new Error(`unexpected path in archive: ${JSON.stringify(name.slice(0, 80))}`);
  return parts;
}

const readOctal = (buf) => {
  const s = buf.toString('latin1').replace(/\0.*$/s, '').trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error('the archive has a damaged header');
  return parseInt(s, 8);
};

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(buf.toString('latin1', i, sp));
    if (!Number.isInteger(len) || len <= 0 || i + len > buf.length) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export const MAX_EXTRACT_BYTES = 50 * 1024 ** 3;
export const MAX_EXTRACT_ENTRIES = 200_000;
const EXTRACT_MARGIN = 256 * 1024 ** 2; // free space left alone
const MAX_PAX = 64 * 1024;

function checksumOk(h) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  const stored = parseInt(h.toString('latin1', 148, 156).replace(/\0.*$/s, '').trim() || 'x', 8);
  return stored === sum;
}

/**
 * Unpack a .tar.gz made by createMediaArchive into destDir, streaming. Only regular files and directories under
 * media/ and uploads/ are accepted; links, other types and any path that is absolute or climbs out are refused,
 * every header checksum is verified, a pax header must be followed by exactly one entry, and the totals are capped:
 * bytes at the smaller of 50 GB and the free space of destDir minus a margin, entries at 200,000 (both can be
 * overridden with { maxBytes, maxEntries }). Returns { files, bytes }. On error the caller removes destDir.
 */
export async function extractMediaArchive(archive, destDir, { maxBytes, maxEntries = MAX_EXTRACT_ENTRIES } = {}) {
  const root = path.resolve(destDir);
  if (maxBytes === undefined) {
    let free = Infinity;
    try { const st = await fs.promises.statfs(root); free = Number(st.bavail) * Number(st.bsize); } catch { /* unknown: only the fixed cap */ }
    maxBytes = Math.max(0, Math.min(MAX_EXTRACT_BYTES, free - EXTRACT_MARGIN));
  }
  let files = 0;
  let entries = 0;
  let bytes = 0;
  let pending = Buffer.alloc(0);
  let state = 'header'; // header | data | pad | end
  let remaining = 0;
  let padLeft = 0;
  let sink = null; // open file handle for the current entry
  let collect = null; // chunks of a pax record
  let paxPath = null;
  let paxPending = false; // a pax header was read and its entry has not come yet

  const finishEntry = async () => {
    if (sink) { await sink.close(); sink = null; }
  };

  const startEntry = async (h) => {
    if (!checksumOk(h)) throw new Error('the archive has a damaged header');
    const typeflag = String.fromCharCode(h[156] || 0x30);
    const size = readOctal(h.subarray(124, 136));
    if (typeflag === 'x') {
      if (paxPending) throw new Error('the archive has two extended headers in a row');
      if (size > MAX_PAX) throw new Error('the archive has an oversized extended header');
      remaining = size;
      if (size > 0) { collect = []; paxPending = true; }
      return;
    }
    const base = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const name = paxPath ?? (prefix ? `${prefix}/${base}` : base);
    paxPath = null;
    paxPending = false;
    if (++entries > maxEntries) throw new Error(`the archive has more than ${maxEntries} entries`);
    if (typeflag === '5') {
      const parts = safeEntryPath(name);
      await fs.promises.mkdir(path.join(root, ...parts), { recursive: true });
      remaining = 0;
      return;
    }
    if (typeflag !== '0' && typeflag !== '\0') throw new Error(`the archive holds an entry type that is not allowed (${JSON.stringify(typeflag)})`);
    bytes += size;
    if (bytes > maxBytes) throw new Error(`the archive holds more data than fits (limit ${Math.floor(maxBytes / 1024 ** 2)} MB)`);
    const parts = safeEntryPath(name);
    const target = path.join(root, ...parts);
    if (!target.startsWith(root + path.sep)) throw new Error('unsafe path in archive');
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    sink = await fs.promises.open(target, 'wx', 0o644);
    files++;
    remaining = size;
  };

  let refused = null; // our own error, kept so a stream abort cannot hide it
  await pipeline(fs.createReadStream(archive), zlib.createGunzip(), async (source) => {
   try {
    for await (const chunk of source) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (state === 'end') { pending = Buffer.alloc(0); break; }
        if (state === 'header') {
          if (pending.length < BLOCK) break;
          const h = pending.subarray(0, BLOCK);
          pending = pending.subarray(BLOCK);
          if (h.every((b) => b === 0)) {
            if (paxPending) throw new Error('the archive ends right after an extended header');
            state = 'end';
            continue;
          }
          await startEntry(h);
          if (remaining > 0) { state = 'data'; padLeft = (BLOCK - (remaining % BLOCK)) % BLOCK; }
          else await finishEntry();
          continue;
        }
        if (state === 'data') {
          if (!pending.length) break;
          const n = Math.min(remaining, pending.length);
          const part = pending.subarray(0, n);
          pending = pending.subarray(n);
          if (collect) collect.push(Buffer.from(part));
          else if (sink) await sink.write(part);
          remaining -= n;
          if (remaining === 0) {
            if (collect) { paxPath = parsePax(Buffer.concat(collect)).path ?? null; collect = null; }
            else await finishEntry();
            state = 'pad';
          }
          continue;
        }
        if (state === 'pad') {
          const n = Math.min(padLeft, pending.length);
          pending = pending.subarray(n);
          padLeft -= n;
          if (padLeft > 0) break;
          state = 'header';
          continue;
        }
      }
    }
    if ((state !== 'end' && state !== 'header') || (state === 'header' && pending.length) || paxPending) throw new Error('the archive ends early (it may be damaged or cut short)');
   } catch (err) { refused = err; throw err; }
  }).catch((err) => { throw refused ?? err; }).finally(finishEntry);
  return { files, bytes };
}
