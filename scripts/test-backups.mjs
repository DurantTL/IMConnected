#!/usr/bin/env node
// End-to-end check of the nightly backups to Google Drive (issue 30, epic 25), against a local mock of Google
// (scripts/mock-gdrive.mjs: never real Google), a local mock of the Resend API and the BUILT server.
//   npm run build
//   SCRATCH=/tmp/claude-0/.../scratchpad/backups-test node scripts/test-backups.mjs     # from the repo root
// SCRATCH is created fresh (an existing folder is removed first, after a throwaway-path check) and deleted at
// the end unless KEEP=1. Ports: PORT (4541, the site), MOCK_GDRIVE_PORT (4513), MOCK_EMAIL_PORT (4514).
// Synthetic data only; the RSA key is generated here and is worth nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(pathToFileURL(path.join(ROOT, 'src/lib/db/backup-core.mjs')));
const gdrive = await import(pathToFileURL(path.join(ROOT, 'src/lib/db/gdrive.mjs')));
const runner = await import(pathToFileURL(path.join(ROOT, 'src/lib/db/backup-run.mjs')));
const { DatabaseSync, openDatabase, runMigrations, readMigrationsFromDir } = await import(pathToFileURL(path.join(ROOT, 'src/lib/db/db-core.mjs')));

if (!process.env.SCRATCH) throw new Error('Set SCRATCH to a throwaway folder.');
const SCRATCH = path.resolve(process.env.SCRATCH);
// Refuse to wipe anything that is not clearly a throwaway folder (the Docker image's DATA_DIR is /data).
function assertThrowaway(dir) {
  const real = path.resolve(dir);
  const roots = [os.tmpdir(), '/tmp'].map((r) => path.resolve(r) + path.sep);
  if (real === '/data' || real.startsWith('/data' + path.sep) || !roots.some((r) => real.startsWith(r) && real.length > r.length)) {
    throw new Error(`Refusing to delete ${real}: point this at a throwaway folder under ${os.tmpdir()}.`);
  }
}
const rmrf = (p) => { assertThrowaway(p); fs.rmSync(p, { recursive: true, force: true }); };
assertThrowaway(SCRATCH);
rmrf(SCRATCH);
fs.mkdirSync(SCRATCH, { recursive: true });

const PORT = Number(process.env.PORT || 4541);
const GPORT = Number(process.env.MOCK_GDRIVE_PORT || 4513);
const MPORT = Number(process.env.MOCK_EMAIL_PORT || 4514);
const BASE = `http://localhost:${PORT}`;
const G = `http://localhost:${GPORT}`;
const FOLDER = 'folder-for-tests-0123456789';

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const shaFile = (f) => sha(fs.readFileSync(f));
const gstate = async () => (await fetch(`${G}/__state`)).json();
const gget = (p) => fetch(`${G}${p}`).then((r) => r.text());
async function until(fn, ms = 20000, step = 100) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}
const q = (file, sql, ...args) => { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const run = (file, sql, ...args) => { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 5000'); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

// ---- a throwaway service-account key (worthless) ----
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyJson = { type: 'service_account', project_id: 'synthetic-test-project', client_email: 'backup-bot@synthetic-test-project.iam.example.test', private_key: PRIVATE_PEM, token_uri: `${G}/token` };
const KEY_B64 = Buffer.from(JSON.stringify(keyJson)).toString('base64');
const PEM_BODY_LINES = PRIVATE_PEM.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'));
const pubFile = path.join(SCRATCH, 'mock-public.pem');
fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));

// ---- processes ----
const children = [];
const spawnLogged = (cmd, args, env, onLine, cwd = ROOT) => {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sink = (d) => String(d).split('\n').filter(Boolean).forEach(onLine);
  child.stdout.on('data', sink);
  child.stderr.on('data', sink);
  children.push(child);
  return child;
};
const stopAll = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(); process.exit(130); });

const mails = [];
spawnLogged('node', ['scripts/mock-email.mjs'], { MOCK_EMAIL_PORT: String(MPORT) }, (l) => { if (l.startsWith('{')) { try { mails.push(JSON.parse(l)); } catch { /* ignore */ } } });
const gdriveProc = spawnLogged('node', ['scripts/mock-gdrive.mjs'], { MOCK_GDRIVE_PORT: String(GPORT), MOCK_GDRIVE_PUBLIC_KEY_FILE: pubFile, MOCK_GDRIVE_MAX_PAGE: '3' }, () => {});
await until(async () => { try { await fetch(`${G}/__state`); return true; } catch { return false; } }, 10000);

const allServerLog = []; // every line any site process printed
let server;
let serverLog = [];
async function startServer(dataDir, env = {}) {
  serverLog = [];
  server = spawn('node', ['dist/server/entry.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production', SITE_URL: BASE, TRUST_PROXY: 'true',
      AUTH_SECRET: 'backups-test-auth-secret-0123456789abcdef',
      RESEND_API_KEY: 'test-key', EMAIL_FROM: 'IMConnected <noreply@example.test>', EMAIL_API_URL: `http://localhost:${MPORT}/emails`,
      GDRIVE_API_URL: G, GOOGLE_OAUTH_TOKEN_URL: `${G}/token`,
      GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '',
      ...env,
    },
  });
  const sink = (d) => { const lines = String(d).split('\n').filter(Boolean); serverLog.push(...lines); allServerLog.push(...lines); };
  server.stdout.on('data', sink);
  server.stderr.on('data', sink);
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/admin/login', { redirect: 'manual' }); return; } catch { await sleep(250); } }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill();
  await done;
  server = undefined;
}
const get = async (url, cookie) => {
  const res = await fetch(BASE + url, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  return { status: res.status, text: await res.text(), loc: res.headers.get('location') };
};

// ======================================================================================================
// Part 1: pure pieces (names, retention, tar, snapshot, secrets)
// ======================================================================================================
{
  check('backup names: only imconnected-YYYY-MM-DD.db / .media.tar.gz with a real date match',
    core.parseBackupName('imconnected-2026-10-21.db')?.kind === 'db' && core.parseBackupName('imconnected-2026-10-21.media.tar.gz')?.kind === 'media' &&
    ['imconnected-2026-13-45.db', 'imconnected-2026-02-30.db', 'imconnected-2026-10-21.db.bak', 'x.db', 'imconnected-2026-10-21.sql', '../imconnected-2026-10-21.db', 'imconnected-2026-10-21.media.tar.gz.tmp'].every((n) => core.parseBackupName(n) === null));
  check('file names use the UTC date', core.backupFileName(core.utcDay(Date.UTC(2026, 9, 21, 23, 59)), 'db') === 'imconnected-2026-10-21.db' && core.utcDay(Date.UTC(2026, 9, 22, 0, 0, 1)) === '2026-10-22');

  // retention: 7 newest days + 4 newest Sundays, worked out here independently
  const today = '2026-10-21'; // a Wednesday
  const days = [];
  for (let i = 0; i < 60; i++) days.push(new Date(Date.UTC(2026, 9, 21) - i * 86400000).toISOString().slice(0, 10));
  const sundays = days.filter((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 0).slice(0, 4);
  const expectKeep = new Set([...days.slice(0, 7), ...sundays]);
  const plan = core.retentionPlan(days, today);
  check('retention keeps the 7 newest days and the 4 newest Sundays (10 days here: Oct 18 is both)', plan.keep.size === expectKeep.size && [...expectKeep].every((d) => plan.keep.has(d)) && plan.keep.size === 10, [...plan.keep].sort().join());
  const entries = days.flatMap((d) => [{ name: `imconnected-${d}.db` }, { name: `imconnected-${d}.media.tar.gz` }]).concat([{ name: 'notes.txt' }, { name: 'imconnected-2026-10-21.db.old' }]);
  const gone = core.expiredEntries(entries, today);
  check('retention expires both files of every other day and never an oddly named file', gone.length === (60 - expectKeep.size) * 2 && gone.every((e) => !expectKeep.has(core.parseBackupName(e.name).day)));
  check('retention never deletes everything and ignores future-dated files', core.expiredEntries([], today).length === 0 &&
    core.expiredEntries([{ name: 'imconnected-2030-01-01.db' }], today).length === 0);

  // redaction
  const red = core.redact(`oops ${KEY_B64} and ${PRIVATE_PEM} and eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2ln and ya29.a0AfH6SMBxyz and Bearer abc.def-ghi`, [KEY_B64]);
  check('redact() removes the key, a PEM, a JWT, a Google token and a Bearer value', !red.includes(KEY_B64) && !red.includes('PRIVATE KEY') && !red.includes('eyJ') && !red.includes('ya29') && !red.includes('abc.def'), red);

  // snapshot consistency: an uncommitted write on another connection is not in it
  const sd = path.join(SCRATCH, 'snap-data');
  const sdb = openDatabase(sd);
  runMigrations(sdb, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  const now0 = Date.now();
  sdb.prepare("INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (1, 'a@example.test', 'A', 'admin', 'active', ?, ?)").run(now0, now0);
  sdb.exec('BEGIN IMMEDIATE');
  sdb.prepare("INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (2, 'b@example.test', 'B', 'editor', 'active', ?, ?)").run(now0, now0);
  const snapFile = path.join(SCRATCH, 'snap.db');
  const t0 = Date.now();
  const bytes = core.snapshotDatabase(sd, snapFile);
  const snapMs = Date.now() - t0;
  sdb.exec('COMMIT');
  sdb.close();
  const snapUsers = q(snapFile, 'SELECT COUNT(*) n FROM users')[0].n;
  check('snapshot (VACUUM INTO on its own connection) is consistent: committed rows yes, an open transaction no', Number(snapUsers) === 1 && bytes > 0 && q(snapFile, 'PRAGMA integrity_check')[0].integrity_check === 'ok');
  check('snapshot of a small database is quick (event loop blocked well under a second)', snapMs < 1000, `${snapMs} ms`);
  let threw = false;
  try { core.snapshotDatabase(path.join(SCRATCH, 'nowhere'), path.join(SCRATCH, 'x.db')); } catch { threw = true; }
  check('snapshot of a missing database fails loudly', threw);

  // tar round trip
  const td = path.join(SCRATCH, 'tar-data');
  const longSeg = 'a'.repeat(120);
  const tree = {
    ['media/stories/one/' + sha('1') + '.jpg']: randomBytes(3000),
    ['media/stories/two/' + longSeg + '/' + 'b'.repeat(90) + '.png']: randomBytes(10),
    'media/zero.webp': Buffer.alloc(0),
    'media/exact512.jpg': randomBytes(512),
    'uploads/draft-3/photo.jpg': randomBytes(70000),
    'uploads/draft-3/ünïcode-名前.jpg': randomBytes(40),
    ['media/' + 'c'.repeat(100) + '/' + 'd'.repeat(100) + '/' + 'e'.repeat(100) + '.jpg']: randomBytes(33),
  };
  for (const [rel, buf] of Object.entries(tree)) { fs.mkdirSync(path.dirname(path.join(td, rel)), { recursive: true }); fs.writeFileSync(path.join(td, rel), buf); }
  fs.mkdirSync(path.join(td, 'media/empty-dir'), { recursive: true });
  fs.writeFileSync(path.join(td, 'media/.build-marker'), 'marker');
  fs.writeFileSync(path.join(SCRATCH, 'outside-secret.txt'), 'must not be archived');
  fs.symlinkSync(path.join(SCRATCH, 'outside-secret.txt'), path.join(td, 'media/link.jpg'));
  fs.writeFileSync(path.join(td, 'imconnected.db'), 'not part of the media archive');
  const arch = path.join(SCRATCH, 'media.tar.gz');
  await core.createMediaArchive(td, arch);
  const out = path.join(SCRATCH, 'tar-out');
  fs.mkdirSync(out);
  const res = await core.extractMediaArchive(arch, out);
  const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? [path.relative(base, path.join(d, e.name)) + '/', ...walk(path.join(d, e.name), base)] : [path.relative(base, path.join(d, e.name))]);
  const got = walk(out).sort();
  check('tar.gz round trip returns every file byte for byte (long names, empty file, 512-byte file, unicode)',
    Object.entries(tree).every(([rel, buf]) => fs.existsSync(path.join(out, rel)) && fs.readFileSync(path.join(out, rel)).equals(buf)) && res.files === Object.keys(tree).length, JSON.stringify(res));
  check('archive holds media/ and uploads/ only: no symlink, no build marker, no database, empty folder kept',
    !got.includes('media/link.jpg') && !got.includes('media/.build-marker') && !got.includes('imconnected.db') && got.includes('media/empty-dir/'), got.join());
  // the system tar agrees that it is a valid archive
  const sys = spawnSync('tar', ['-tzf', arch], { encoding: 'utf8' });
  check('the system tar can list the archive', sys.status === 0 && sys.stdout.includes('uploads/draft-3/photo.jpg'), sys.stderr);

  // hostile archives are refused
  const evilHeader = (name, type = '0', size = 0) => {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(0x20, 148, 156); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const zlib = await import('node:zlib');
  const evil = async (label, name, type) => {
    const f = path.join(SCRATCH, `evil-${label}.tar.gz`);
    fs.writeFileSync(f, zlib.gzipSync(Buffer.concat([evilHeader(name, type, 0), Buffer.alloc(1024)])));
    const dest = path.join(SCRATCH, `evil-out-${label}`);
    fs.mkdirSync(dest);
    let err = null;
    try { await core.extractMediaArchive(f, dest); } catch (e) { err = e; }
    return { err, dest };
  };
  const e1 = await evil('dotdot', 'media/../../escaped.txt', '0');
  const e2 = await evil('abs', '/tmp/escaped.txt', '0');
  const e3 = await evil('symlink', 'media/link', '2');
  const e4 = await evil('top', 'etc/passwd', '0');
  check('an archive with ../, an absolute path, a symlink entry or a path outside media/ uploads/ is refused',
    [e1, e2, e3, e4].every((e) => e.err instanceof Error) && !fs.existsSync(path.join(SCRATCH, 'escaped.txt')) && fs.readdirSync(e1.dest).length === 0, [e1, e2, e3, e4].map((e) => e.err?.message).join(' | '));
  const cut = path.join(SCRATCH, 'cut.tar.gz');
  fs.writeFileSync(cut, fs.readFileSync(arch).subarray(0, Math.floor(fs.statSync(arch).size / 2)));
  let cutErr = false;
  try { await core.extractMediaArchive(cut, path.join(SCRATCH, 'cut-out')); } catch { cutErr = true; }
  check('a truncated archive is refused', cutErr);

  // streaming: a 64 MB file is archived without holding it in memory
  const bd = path.join(SCRATCH, 'big-data');
  fs.mkdirSync(path.join(bd, 'media'), { recursive: true });
  const fd = fs.openSync(path.join(bd, 'media/big.jpg'), 'w');
  for (let i = 0; i < 64; i++) fs.writeSync(fd, randomBytes(1 << 20));
  fs.closeSync(fd);
  const base = process.memoryUsage();
  let peak = 0;
  const sampler = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.external - base.heapUsed - base.external); }, 10);
  const bigSize = await core.createMediaArchive(bd, path.join(SCRATCH, 'big.tar.gz'));
  clearInterval(sampler);
  check('a 64 MB media file is archived as a stream (extra memory stayed under 24 MB)', bigSize > 60e6 && peak < 24e6, `${Math.round(peak / 1e6)} MB extra, archive ${bigSize} bytes`);
  rmrf(bd);
}

// ======================================================================================================
// Part 2: the Drive client and one backup run against the mock (retention across 40 days)
// ======================================================================================================
{
  const cfg = gdrive.driveConfig({ GDRIVE_SERVICE_ACCOUNT_JSON: KEY_B64, GDRIVE_FOLDER_ID: FOLDER, GDRIVE_API_URL: G, GOOGLE_OAUTH_TOKEN_URL: `${G}/token` });
  check('config: key + folder present -> configured, drive.file scope by default', cfg.configured && cfg.scope === gdrive.SCOPE_FILE && cfg.apiUrl === G);
  const off1 = gdrive.driveConfig({ GDRIVE_FOLDER_ID: FOLDER });
  const off2 = gdrive.driveConfig({ GDRIVE_SERVICE_ACCOUNT_JSON: KEY_B64 });
  const off3 = gdrive.driveConfig({ GDRIVE_SERVICE_ACCOUNT_JSON: 'not base64 json', GDRIVE_FOLDER_ID: 'x' });
  check('config: either setting missing (or malformed) -> not configured, naming what is missing',
    !off1.configured && off1.missing.join() === 'GDRIVE_SERVICE_ACCOUNT_JSON' && !off2.configured && off2.missing.join() === 'GDRIVE_FOLDER_ID' && !off3.configured && off3.problems.length === 2);
  check('config: GDRIVE_SCOPE=drive selects the full scope, anything else stays drive.file',
    gdrive.driveConfig({ GDRIVE_SERVICE_ACCOUNT_JSON: KEY_B64, GDRIVE_FOLDER_ID: FOLDER, GDRIVE_SCOPE: 'drive' }).scope === gdrive.SCOPE_FULL &&
    gdrive.driveConfig({ GDRIVE_SERVICE_ACCOUNT_JSON: KEY_B64, GDRIVE_FOLDER_ID: FOLDER, GDRIVE_SCOPE: 'everything' }).scope === gdrive.SCOPE_FILE);

  // a wrong key is rejected by the mock's signature check, and the error leaks nothing
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const badCfg = gdrive.driveConfig({ GDRIVE_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify({ ...keyJson, private_key: other })).toString('base64'), GDRIVE_FOLDER_ID: FOLDER, GDRIVE_API_URL: G, GOOGLE_OAUTH_TOKEN_URL: `${G}/token` });
  let badMsg = '';
  try { await gdrive.createDriveClient(badCfg).listFolder(); } catch (e) { badMsg = e.message; }
  check('a JWT signed with the wrong key is refused, and the message holds no key or token', /sign-in failed/.test(badMsg) && !badMsg.includes('PRIVATE') && !badMsg.includes('eyJ'), badMsg);

  const drive = gdrive.createDriveClient(cfg);
  const tok1 = await drive.accessToken();
  const tok2 = await drive.accessToken();
  check('the access token is cached until it expires (one token request for two uses)', tok1 === tok2 && (await gstate()).counters.tokenRequests === 2 /* 1 bad + 1 good */);
  const clock = { t: Date.now() };
  const drive2 = gdrive.createDriveClient(cfg, { now: () => clock.t });
  const a = await drive2.accessToken();
  clock.t += 3560 * 1000; // inside the last minute of the 3599 s token
  const b = await drive2.accessToken();
  check('...and fetched again once it is about to expire', a !== b);

  // 40 days of backups on a database with a little data, one run per day at noon UTC
  const dd = path.join(SCRATCH, 'drive-data');
  const ddb = openDatabase(dd);
  runMigrations(ddb, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  ddb.close();
  fs.mkdirSync(path.join(dd, 'media/stories/s'), { recursive: true });
  fs.writeFileSync(path.join(dd, 'media/stories/s/p.jpg'), randomBytes(2048));
  await fetch(`${G}/__reset`);
  // Foreign files in the folder: one with a matching name that this account did not create, one with another name.
  await gget(`/__seed?name=imconnected-2020-01-01.db&folder=${FOLDER}&owned=0`);
  await gget(`/__seed?name=holiday-photos.zip&folder=${FOLDER}&owned=1`);
  await gget(`/__seed?name=imconnected-2020-01-02.db&folder=other-folder-id-123456&owned=1`);
  const START = Date.UTC(2026, 8, 12, 12); // 2026-09-12
  const N = 40;
  let lastResult;
  const warnings = [];
  for (let i = 0; i < N; i++) {
    lastResult = await runner.performBackup({ dataDir: dd, drive: gdrive.createDriveClient(cfg), now: START + i * 86400000, attemptDelayMs: 10, secrets: [KEY_B64] });
    warnings.push(...lastResult.warnings);
  }
  const lastDay = core.utcDay(START + (N - 1) * 86400000);
  const allDays = Array.from({ length: N }, (_, i) => core.utcDay(START + i * 86400000)).reverse();
  const keepDays = new Set([...allDays.slice(0, 7), ...allDays.filter((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 0).slice(0, 4)]);
  const expectNames = [...keepDays].flatMap((d) => [core.backupFileName(d, 'db'), core.backupFileName(d, 'media')]).sort();
  const st = await gstate();
  const driveBackups = st.files.filter((f) => /^imconnected-\d{4}-\d{2}-\d{2}\.(db|media\.tar\.gz)$/.test(f.name) && f.parents[0] === FOLDER && f.owned).map((f) => f.name).sort();
  check(`Drive retention after ${N} nightly runs keeps exactly the 7 newest days + 4 newest Sundays (${keepDays.size} days, ${expectNames.length} files)`, JSON.stringify(driveBackups) === JSON.stringify(expectNames), `${driveBackups.length} files; missing ${expectNames.filter((n) => !driveBackups.includes(n))}; extra ${driveBackups.filter((n) => !expectNames.includes(n))}`);
  check('Drive cleanup left foreign files alone (matching name not created by the account, other name, other folder)',
    st.files.some((f) => f.name === 'imconnected-2020-01-01.db' && !f.owned) && st.files.some((f) => f.name === 'holiday-photos.zip') && st.files.some((f) => f.name === 'imconnected-2020-01-02.db' && f.parents[0] !== FOLDER) && warnings.length === 0, warnings.join(' | '));
  check('the account never tried to delete a file it did not create (the mock answers 403 to that)', warnings.every((w) => !/403|permissions/.test(w)));
  const localNames = fs.readdirSync(path.join(dd, 'backups')).sort();
  check('local retention keeps the same set in DATA_DIR/backups (and leaves no temp files)', JSON.stringify(localNames) === JSON.stringify(expectNames), `extra ${localNames.filter((n) => !expectNames.includes(n))} missing ${expectNames.filter((n) => !localNames.includes(n))}`);
  const lastDb = st.files.find((f) => f.name === core.backupFileName(lastDay, 'db'));
  const lastMedia = st.files.find((f) => f.name === core.backupFileName(lastDay, 'media'));
  check('uploaded bytes equal the local files (sizes and sha256) for both files',
    lastDb?.sha256 === shaFile(path.join(dd, 'backups', core.backupFileName(lastDay, 'db'))) && lastMedia?.sha256 === shaFile(path.join(dd, 'backups', core.backupFileName(lastDay, 'media'))) && lastDb.size > 0 && lastMedia.size > 0);
  check('listing followed more than one page of results (mock page size 3) (lists > N), and each run signed in once', st.counters.lists > N && st.counters.tokenRequests >= N);
  // a same-day re-run replaces the day's copies instead of adding duplicates
  await runner.performBackup({ dataDir: dd, drive: gdrive.createDriveClient(cfg), now: START + (N - 1) * 86400000 + 3600e3, attemptDelayMs: 10 });
  const again = (await gstate()).files.filter((f) => f.name === core.backupFileName(lastDay, 'db'));
  check('running the same day again replaces the earlier copy (one file per name)', again.length === 1);

  // a failing upload is retried inside one run, and a run that fails throws with a clean message
  await gget('/__fail?uploads=1');
  const r1 = await runner.performBackup({ dataDir: dd, drive: gdrive.createDriveClient(cfg), now: START + N * 86400000, attemptDelayMs: 10, secrets: [KEY_B64] });
  check('one failed upload is retried within the run and the run succeeds (3 tries for 2 files)', r1.uploads === 2 && r1.attempts === 3, JSON.stringify(r1));
  await gget('/__fail?uploads=50');
  let failure = null;
  try { await runner.performBackup({ dataDir: dd, drive: gdrive.createDriveClient(cfg), now: START + (N + 1) * 86400000, attemptDelayMs: 10, secrets: [KEY_B64] }); } catch (e) { failure = e; }
  await gget('/__fail?uploads=0');
  check('when every try fails the run throws a message naming the file and HTTP status, with the partial counts',
    failure && /after 3 tries/.test(failure.message) && /503/.test(failure.message) && failure.partial.uploads === 0 && failure.partial.attempts === 3 && failure.partial.dbBytes > 0, failure?.message);
  check('the error message holds no key material', failure && !failure.message.includes(KEY_B64) && !PEM_BODY_LINES.some((l) => failure.message.includes(l)));
  rmrf(dd);
}

// ======================================================================================================
// Part 3: the built server
// ======================================================================================================
const DATA = path.join(SCRATCH, 'site-data');
const DB = path.join(DATA, 'imconnected.db');
const ADMIN = { id: 1, email: 'alice.admin@example.test', name: 'Alice Admin', token: randomBytes(24).toString('base64url') };
const EDITOR = { id: 2, email: 'eddie.editor@example.test', name: 'Eddie Editor', token: randomBytes(24).toString('base64url') };
const cookieOf = (u) => `__Host-imc_session=${u.token}`;
const SEED = { slugs: ['zz-backup-story-one', 'zz-backup-story-two'], files: {} };
{
  const db = openDatabase(DATA);
  runMigrations(db, readMigrationsFromDir(path.join(ROOT, 'src/lib/db/migrations')));
  const now = Date.now();
  const user = (u, role) => {
    db.prepare("INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").run(u.id, u.email, u.name, role, now, now);
    db.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, mfa_passed, fresh_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(sha(u.token), u.id, now, now, now + 6 * 86400000, now);
  };
  user(ADMIN, 'admin');
  user(EDITOR, 'editor');
  SEED.slugs.forEach((slug, i) => {
    const bytes = randomBytes(1500 + i);
    const rel = `stories/${slug}/${sha(bytes)}.jpg`;
    fs.mkdirSync(path.join(DATA, 'media', path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'media', rel), bytes);
    SEED.files[`media/${rel}`] = sha(bytes);
    const sid = Number(db.prepare("INSERT INTO stories (slug, title, section, author, date, body, source, published_at, updated_at) VALUES (?, ?, 'news', 'Synthetic Author', '2026-10-01', ?, 'editor', ?, ?)").run(slug, `Synthetic backup story ${i + 1}`, `Body of synthetic story ${i + 1}.`, now, now).lastInsertRowid);
    db.prepare("INSERT INTO story_photos (story_id, position, kind, path, alt, sha256, bytes) VALUES (?, 0, 'lead', ?, 'synthetic photo', ?, ?)").run(sid, rel, sha(bytes), bytes.length);
  });
  [3, 4, 5].forEach((id, i) => {
    db.prepare("INSERT INTO drafts (id, status, source, title, section, body, submitter_name, created_at, updated_at) VALUES (?, 'new', 'form', ?, 'news', 'A synthetic draft body.', 'Synthetic Person', ?, ?)").run(id, `Synthetic draft ${id}`, now, now);
    if (i < 2) {
      const bytes = randomBytes(900 + id);
      const rel = `draft-${id}/photo.jpg`;
      fs.mkdirSync(path.join(DATA, 'uploads', `draft-${id}`), { recursive: true });
      fs.writeFileSync(path.join(DATA, 'uploads', rel), bytes);
      SEED.files[`uploads/${rel}`] = sha(bytes);
      db.prepare("INSERT INTO draft_photos (draft_id, path, ext, alt, position, created_at) VALUES (?, ?, 'jpg', 'draft photo', 0, ?)").run(id, rel, now);
    }
  });
  for (let i = 0; i < 4; i++) db.prepare("INSERT INTO audit_log (at, user_id, action, target) VALUES (?, ?, 'seed.entry', ?)").run(now - i * 1000, ADMIN.id, `seed:${i}`);
  db.close();
}
const SITE_ENV = {
  GDRIVE_SERVICE_ACCOUNT_JSON: KEY_B64, GDRIVE_FOLDER_ID: FOLDER,
  BACKUP_HOUR: '0', BACKUP_CHECK_MS: '300', BACKUP_RETRY_MS: '3000', BACKUP_ATTEMPT_DELAY_MS: '50',
};
const today = core.utcDay();
const runs = () => q(DB, 'SELECT * FROM backup_runs ORDER BY id');
const adminMails = () => mails.filter((m) => Array.isArray(m.to) && /backups need attention/.test(m.subject || ''));

try {
  await fetch(`${G}/__reset`);

  // ---- 3a. not configured: disabled, with a clear admin status, and nothing happens ----
  await startServer(DATA, { GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: FOLDER });
  await get('/admin/login');
  await sleep(1500);
  const off = await get('/admin/backups', cookieOf(ADMIN));
  check('without GDRIVE_SERVICE_ACCOUNT_JSON the admin page says backups are off and names the missing setting',
    off.status === 200 && /Backups are off/.test(off.text) && /GDRIVE_SERVICE_ACCOUNT_JSON/.test(off.text) && !/Backups are on/.test(off.text), off.text.slice(0, 300));
  check('...and nothing was backed up (no run recorded, no backups folder, no Drive traffic)', runs().length === 0 && !fs.existsSync(path.join(DATA, 'backups')) && (await gstate()).counters.tokenRequests === 0);
  await stopServer();
  await startServer(DATA, { GDRIVE_SERVICE_ACCOUNT_JSON: KEY_B64, GDRIVE_FOLDER_ID: '' });
  await sleep(1200);
  const off2 = await get('/admin/backups', cookieOf(ADMIN));
  check('without GDRIVE_FOLDER_ID backups are off too, naming GDRIVE_FOLDER_ID', /Backups are off/.test(off2.text) && /GDRIVE_FOLDER_ID/.test(off2.text) && runs().length === 0 && !fs.existsSync(path.join(DATA, 'backups')));
  await stopServer();

  // ---- 3b. configured: every upload fails first -> failure is recorded and reported, then a retry succeeds ----
  await gget('/__fail?uploads=100');
  await startServer(DATA, SITE_ENV);
  await get('/admin/login');
  const failed = await until(() => runs().find((r) => r.finished_at && r.ok === 0));
  check('a backup whose uploads all fail is recorded as failed, with the error and the partial sizes', !!failed && /after 3 tries/.test(failed.error) && /503/.test(failed.error) && failed.attempts === 3 && failed.db_bytes > 0 && failed.media_bytes > 0 && failed.uploads === 0, JSON.stringify(failed));
  check('...and reported in the server log', serverLog.some((l) => l.startsWith('[backup] failed:') && /503/.test(l)));
  const pageFail = await get('/admin/backups', cookieOf(ADMIN));
  check('...and on the admin page (last error shown, no success yet)', pageFail.status === 200 && /after 3 tries/.test(pageFail.text) && /None yet/.test(pageFail.text), pageFail.text.slice(0, 200));
  check('a failed attempt is not repeated until the retry delay has passed (at most one new row per 3 s)', runs().filter((r) => r.finished_at).length <= 3);

  // Now Google works again, except for the first upload try: retried within the run.
  await gget('/__fail?uploads=1');
  const okRun = await until(() => runs().find((r) => r.ok === 1), 30000);
  check('the day is retried after the failure and then succeeds (the first try of the next run fails and is retried inside it)', !!okRun && okRun.day === today && okRun.uploads === 2 && okRun.attempts === 3 && !okRun.error, JSON.stringify(okRun));
  check('...recorded with sizes that match the local files',
    okRun && okRun.db_bytes === fs.statSync(path.join(DATA, 'backups', core.backupFileName(today, 'db'))).size && okRun.media_bytes === fs.statSync(path.join(DATA, 'backups', core.backupFileName(today, 'media'))).size);
  const gs = await gstate();
  const upDb = gs.files.find((f) => f.name === core.backupFileName(today, 'db'));
  const upMedia = gs.files.find((f) => f.name === core.backupFileName(today, 'media'));
  check('Drive has both files in the folder, byte-identical to the local copies', upDb?.parents[0] === FOLDER && upMedia?.parents[0] === FOLDER &&
    upDb.sha256 === shaFile(path.join(DATA, 'backups', core.backupFileName(today, 'db'))) && upMedia.sha256 === shaFile(path.join(DATA, 'backups', core.backupFileName(today, 'media'))));
  check('one access token served the whole time (cached)', gs.counters.tokenRequests === 1, String(gs.counters.tokenRequests));

  // ---- status page ----
  const page = await get('/admin/backups', cookieOf(ADMIN));
  check('admins see "Backups are on", the last success time and the files on the server', page.status === 200 && /Backups are on/.test(page.text) && /id="backup-last-ok"[^>]*>[^<]*UTC/.test(page.text) && page.text.includes(core.backupFileName(today, 'db')), page.text.slice(0, 300));
  const ed = await get('/admin/backups', cookieOf(EDITOR));
  const anon = await get('/admin/backups');
  check('editors get 403 and signed-out visitors are sent to the login page', ed.status === 403 && !/Backups are on/.test(ed.text) && anon.status === 302 && /\/admin\/login/.test(anon.loc || ''), `${ed.status} ${anon.status}`);
  const editorsPage = await get('/admin/editors', cookieOf(ADMIN));
  const editorsPageEd = await get('/admin/editors', cookieOf(EDITOR));
  check('the Editors page links to Backups for admins only', /href="\/admin\/backups"/.test(editorsPage.text) && !/href="\/admin\/backups"/.test(editorsPageEd.text));
  check('no alert email while backups are fine', adminMails().length === 0);

  // ---- secrets never reach the log, the database, the page or the mail ----
  const tokensSeen = (await gstate()).tokens;
  const dbText = JSON.stringify(runs());
  const leaks = (text) => [KEY_B64, ...PEM_BODY_LINES, ...tokensSeen, 'eyJ', 'BEGIN PRIVATE KEY'].filter((s) => s && text.includes(s));
  check('the server log never contains the key, a JWT or an access token', leaks(allServerLog.join('\n')).length === 0, leaks(allServerLog.join('\n')).join());
  check('backup_runs, the status page and the mails never contain them either', leaks(dbText).length === 0 && leaks(page.text).length === 0 && leaks(JSON.stringify(mails)).length === 0);
  check('the mock saw tokens (the check above is not vacuous)', tokensSeen.length >= 1 && allServerLog.some((l) => l.startsWith('[backup] ok:')), allServerLog.filter((l) => l.includes('[backup]')).join(' / '));

  // ---- a restart does not repeat a backup that already succeeded ----
  const before = (await gstate()).counters.uploadsDone;
  await stopServer();
  await startServer(DATA, SITE_ENV);
  await get('/admin/login');
  await sleep(2500);
  check('after a restart, today\'s finished backup is not repeated (one ok row, no new upload)', runs().filter((r) => r.ok === 1).length === 1 && (await gstate()).counters.uploadsDone === before);
  await stopServer();

  // ---- 3c. the 48 hour alert ----
  const longAgo = Date.now() - 49 * 3600e3;
  run(DB, 'UPDATE backup_runs SET finished_at = ? WHERE ok = 1', longAgo);
  run(DB, 'UPDATE backup_state SET last_alert_at = NULL');
  mails.length = 0;
  await startServer(DATA, SITE_ENV);
  await get('/admin/login');
  await until(() => adminMails().length >= 1, 10000);
  await sleep(2000);
  const alerts = adminMails();
  check('no success for 49 hours -> the admins (and only the admins) are emailed once', alerts.length === 1 && alerts[0].to.length === 1 && alerts[0].to[0] === ADMIN.email && !alerts.some((m) => m.to.includes(EDITOR.email)), JSON.stringify(mails.map((m) => [m.to, m.subject])));
  check('the alert has the hours, a link to /admin/backups and no secret', /49 hours/.test(alerts[0].text) && alerts[0].text.includes(`${BASE}/admin/backups`) && leaks(JSON.stringify(alerts)).length === 0, alerts[0].text);
  const pageOver = await get('/admin/backups', cookieOf(ADMIN));
  check('the page then says no successful backup in 48 hours', /No successful backup in the last 48 hours/.test(pageOver.text));
  await sleep(1500);
  check('...and it is not sent again within the day, however often the scheduler wakes', adminMails().length === 1);
  await stopServer();
  run(DB, 'UPDATE backup_state SET last_alert_at = ?', Date.now() - 25 * 3600e3);
  await startServer(DATA, SITE_ENV);
  await get('/admin/login');
  await until(() => adminMails().length >= 2, 10000);
  check('a day later it is sent again while still overdue', adminMails().length === 2);
  await stopServer();
  run(DB, 'UPDATE backup_runs SET finished_at = ? WHERE ok = 1', Date.now() - 3600e3);
  run(DB, 'UPDATE backup_state SET last_alert_at = NULL');
  mails.length = 0;
  await startServer(DATA, SITE_ENV);
  await get('/admin/login');
  await sleep(1500);
  check('a success within 48 hours sends no alert', adminMails().length === 0);
  await stopServer();
  run(DB, 'UPDATE backup_runs SET finished_at = ? WHERE ok = 1', Date.now() - 3600e3);

  // ---- 3d. restore ----
  const BK = path.join(DATA, 'backups');
  const dbFile = path.join(BK, core.backupFileName(today, 'db'));
  const mediaFile = path.join(BK, core.backupFileName(today, 'media'));
  const restore = (dataDir, ...args) => spawnSync('node', ['scripts/restore-backup.mjs', ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
  const R = path.join(SCRATCH, 'restored');
  fs.mkdirSync(R);
  const dump = (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const out = {};
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
        out[name] = sha(db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).sort().join('\n'));
      }
      return out;
    } finally { db.close(); }
  };
  const treeHashes = (dir) => {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name !== '.build-marker') out[path.relative(dir, p)] = shaFile(p); } };
    for (const top of ['media', 'uploads']) if (fs.existsSync(path.join(dir, top))) walk(path.join(dir, top));
    return out;
  };

  // refusals first: a corrupt database, a hostile archive, a non-empty folder
  const junk = path.join(SCRATCH, 'junk.db');
  fs.writeFileSync(junk, randomBytes(4096));
  const rj = restore(R, junk);
  check('a file that is not an IMConnected database is refused before anything is touched', rj.status === 1 && fs.readdirSync(R).length === 0, rj.stderr);
  const rEvil = restore(R, dbFile, path.join(SCRATCH, 'evil-dotdot.tar.gz'));
  check('a hostile media archive makes the restore fail and leaves the folder empty (no half-restored database)', rEvil.status === 1 && fs.readdirSync(R).length === 0 && !fs.existsSync(path.join(R, '.restore-staging')), `${rEvil.status} ${rEvil.stderr} ${fs.readdirSync(R)}`);
  fs.mkdirSync(path.join(R, 'backups'));
  fs.writeFileSync(path.join(R, 'backups', 'keep-me.txt'), 'old backup stays');

  const r1 = restore(R, dbFile, mediaFile);
  check('restore into an empty data folder succeeds (a leftover backups/ folder does not count as data)', r1.status === 0 && /Restored into/.test(r1.stdout), r1.stdout + r1.stderr);
  check('...and says what it restored, counts only (no names or addresses)', /\d+ stories, \d+ drafts, \d+ accounts/.test(r1.stdout) && !/example\.test|Synthetic/.test(r1.stdout), r1.stdout);
  const want = dump(dbFile);
  const have = dump(path.join(R, 'imconnected.db'));
  check('every table of the restored database equals the backup (stories, photos, drafts, accounts, sessions, audit log, FTS...)', JSON.stringify(want) === JSON.stringify(have) && Object.keys(have).length > 15, Object.keys(want).filter((k) => want[k] !== have[k]).join());
  const rdb = path.join(R, 'imconnected.db');
  const n = (sql) => Number(q(rdb, sql)[0].n);
  check('the seeded rows are all back: 2 stories + 2 story photos, 3 drafts + 2 draft photos, 2 accounts, 4+ audit rows',
    n("SELECT COUNT(*) n FROM stories WHERE slug LIKE 'zz-backup-%'") === 2 && n('SELECT COUNT(*) n FROM story_photos WHERE story_id IN (SELECT id FROM stories WHERE slug LIKE \'zz-backup-%\')') === 2 &&
    n('SELECT COUNT(*) n FROM drafts WHERE id IN (3,4,5)') === 3 && n('SELECT COUNT(*) n FROM draft_photos WHERE draft_id IN (3,4,5)') === 2 &&
    n('SELECT COUNT(*) n FROM users WHERE id IN (1,2)') === 2 && n("SELECT COUNT(*) n FROM audit_log WHERE action = 'seed.entry'") === 4);
  const restoredFiles = treeHashes(R);
  const liveFiles = treeHashes(DATA);
  check('every photo file (published and draft uploads) is back, byte for byte (and nothing that was not on disk)', Object.entries(SEED.files).every(([rel, h]) => restoredFiles[rel] === h) && Object.entries(restoredFiles).every(([rel, h]) => liveFiles[rel] === h), JSON.stringify(Object.keys(restoredFiles)));
  check('the backups/ folder next to it was left alone', fs.readFileSync(path.join(R, 'backups', 'keep-me.txt'), 'utf8') === 'old backup stays');

  const dbBefore = shaFile(rdb);
  const r2 = restore(R, dbFile, mediaFile);
  check('a second restore into the now non-empty folder is refused, and nothing changed', r2.status === 1 && /not empty/.test(r2.stderr) && shaFile(rdb) === dbBefore && !fs.readdirSync(R).some((f) => f.startsWith('restore-aside')), r2.stderr);

  // the server starts on the restored folder
  await startServer(R, { GDRIVE_SERVICE_ACCOUNT_JSON: '', GDRIVE_FOLDER_ID: '' });
  const home = await get('/');
  const slugOne = SEED.slugs[0];
  const photoRel = Object.keys(SEED.files).find((k) => k.includes(slugOne));
  const mediaRes = await fetch(`${BASE}/${photoRel}`);
  const mediaBuf = Buffer.from(await mediaRes.arrayBuffer());
  const restoredAdminPage = await get('/admin/backups', cookieOf(ADMIN));
  check('the server starts on the restored folder: home page, a restored photo via /media, and the restored admin session works',
    home.status === 200 && mediaRes.status === 200 && sha(mediaBuf) === SEED.files[photoRel] && restoredAdminPage.status === 200, `${home.status} ${mediaRes.status} ${restoredAdminPage.status}`);
  const draftsPage = await get('/admin', cookieOf(ADMIN));
  check('...and the restored drafts list shows the synthetic drafts', draftsPage.status === 200 && /Synthetic draft 3/.test(draftsPage.text));
  await stopServer();

  const dbBeforeForce = shaFile(rdb);
  const r3 = restore(R, dbFile, mediaFile, '--force');
  const asideDir = fs.readdirSync(R).find((f) => f.startsWith('restore-aside-'));
  const asideDb = asideDir && path.join(R, asideDir, 'imconnected.db');
  check('--force moves the old data aside (nothing deleted) and restores again', r3.status === 0 && !!asideDir && fs.existsSync(asideDb) && fs.existsSync(path.join(R, asideDir, 'media')) && JSON.stringify(dump(rdb)) === JSON.stringify(want), r3.stdout + r3.stderr);
  check('...the moved-aside database is the one that was there (same bytes as before the restore) and backups/ stayed', asideDb && shaFile(asideDb) === dbBeforeForce && fs.existsSync(path.join(R, 'backups', 'keep-me.txt')));

  // missing arguments / files
  const rBad = restore(path.join(SCRATCH, 'empty-two'), path.join(SCRATCH, 'does-not-exist.db'));
  check('a missing backup file is a clear error', rBad.status === 1 && /does not exist/.test(rBad.stderr));
} finally {
  await stopServer().catch(() => {});
  stopAll();
  if (!process.env.KEEP) rmrf(SCRATCH);
}

console.log(fails === 0 ? '\nAll backup checks passed.' : `\n${fails} backup check(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
