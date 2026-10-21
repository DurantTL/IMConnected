#!/usr/bin/env node
// Restore a nightly backup into an EMPTY data folder.
// Usage: node scripts/restore-backup.mjs <database file> [media archive.tar.gz] [--force]
//   Docker: docker compose run --rm imconnected node scripts/restore-backup.mjs /data/backups/imconnected-2026-10-21.db /data/backups/imconnected-2026-10-21.media.tar.gz
// The data folder is DATA_DIR (the Docker image sets /data). STOP the site first: restoring under a running
// server would mix two databases.
//
// The folder must be empty (a leftover backups/ folder does not count: backups are kept, never touched). With a live
// database in it the script refuses. --force first moves everything except backups/ into a new
// restore-aside-<timestamp>/ folder inside the data folder, so nothing is ever deleted; delete that by hand later.
// The database is checked before anything moves (integrity, expected tables, no migration this code does not know).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, dataDir, readMigrationsFromDir } from '../src/lib/db/db-core.mjs';
import { extractMediaArchive } from '../src/lib/db/backup-core.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const paths = args.filter((a) => !a.startsWith('--'));
if (paths.length < 1 || paths.length > 2 || args.some((a) => a.startsWith('--') && a !== '--force')) {
  console.error('Usage: node scripts/restore-backup.mjs <database file> [media archive.tar.gz] [--force]');
  process.exit(2);
}
const die = (msg) => { console.error(`Restore stopped: ${msg}`); process.exit(1); };

const dbSrc = path.resolve(paths[0]);
const mediaSrc = paths[1] ? path.resolve(paths[1]) : null;
const DATA = dataDir();
const KEEP = 'backups'; // never moved, never counted

if (!fs.existsSync(dbSrc) || !fs.statSync(dbSrc).isFile()) die(`the database file ${dbSrc} does not exist.`);
if (mediaSrc && (!fs.existsSync(mediaSrc) || !fs.statSync(mediaSrc).isFile())) die(`the media archive ${mediaSrc} does not exist.`);

// ---- check the backup before touching anything ----
{
  let db;
  try {
    db = new DatabaseSync(dbSrc, { readOnly: true });
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') die('the database file failed its integrity check.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ['schema_migrations', 'users', 'drafts', 'stories']) if (!tables.has(t)) die(`this does not look like an IMConnected database (no ${t} table).`);
    const known = new Set(readMigrationsFromDir(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/db/migrations')).map((m) => m.name));
    const unknown = db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name).filter((n) => !known.has(n));
    if (unknown.length) die(`the backup has migrations this version of the site does not know (${unknown.join(', ')}). Restore with the newer image.`);
  } catch (err) {
    if (err?.code === 'ERR_SQLITE_ERROR') die(`the database file could not be read (${err.message}).`);
    throw err;
  } finally {
    db?.close();
  }
}

// ---- the target folder ----
const inside = (p, root) => p === root || p.startsWith(root + path.sep);
const keepDir = path.join(DATA, KEEP);
for (const src of [dbSrc, mediaSrc].filter(Boolean)) {
  if (inside(src, DATA) && !inside(src, keepDir)) die(`${src} is inside the data folder. Copy the backup files somewhere else (or into ${keepDir}) first.`);
}
fs.mkdirSync(DATA, { recursive: true });
const existing = fs.readdirSync(DATA).filter((n) => n !== KEEP);
let aside = null;
if (existing.length) {
  if (!force) die(`the data folder ${DATA} is not empty (${existing.slice(0, 5).join(', ')}${existing.length > 5 ? ', ...' : ''}). Restore only works into an empty folder. Use a new empty volume, or add --force to move the current data aside first.`);
  aside = path.join(DATA, `restore-aside-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(aside, { mode: 0o700 });
  for (const n of existing) fs.renameSync(path.join(DATA, n), path.join(aside, n));
  console.log(`Moved the current data aside to ${aside} (delete it by hand when you are sure).`);
}

// ---- restore ----
const staging = path.join(DATA, '.restore-staging');
try {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { mode: 0o700 });
  const tmpDb = path.join(staging, 'imconnected.db');
  fs.copyFileSync(dbSrc, tmpDb);
  let counts = null;
  if (mediaSrc) counts = await extractMediaArchive(mediaSrc, staging);
  // Move into place only once everything was read successfully.
  fs.renameSync(tmpDb, path.join(DATA, 'imconnected.db'));
  for (const top of ['media', 'uploads']) if (fs.existsSync(path.join(staging, top))) fs.renameSync(path.join(staging, top), path.join(DATA, top));
  fs.rmSync(staging, { recursive: true, force: true });

  // The server runs as a normal user; when this script runs as root, give the files to the folder's owner.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const { uid, gid } = fs.statSync(DATA);
    const chown = (p) => {
      fs.lchownSync(p, uid, gid);
      if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) chown(path.join(p, n));
    };
    for (const n of ['imconnected.db', 'media', 'uploads']) if (fs.existsSync(path.join(DATA, n))) chown(path.join(DATA, n));
  }

  const db = new DatabaseSync(path.join(DATA, 'imconnected.db'), { readOnly: true });
  const n = (sql) => Number(db.prepare(sql).get().n);
  const summary = { stories: n('SELECT COUNT(*) n FROM stories'), drafts: n('SELECT COUNT(*) n FROM drafts'), accounts: n('SELECT COUNT(*) n FROM users'), auditEntries: n('SELECT COUNT(*) n FROM audit_log') };
  db.close();
  console.log(`Restored into ${DATA}: ${summary.stories} stories, ${summary.drafts} drafts, ${summary.accounts} accounts, ${summary.auditEntries} audit entries${counts ? `, ${counts.files} photo files` : ' (no media archive given: photos were not restored)'}.`);
  console.log('Start the site again. Pending migrations (if the site is newer than the backup) apply on start.');
} catch (err) {
  fs.rmSync(staging, { recursive: true, force: true });
  console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
  if (aside) {
    // Put the previous data back so the folder is as it was.
    try {
      for (const n of ['imconnected.db', 'media', 'uploads']) fs.rmSync(path.join(DATA, n), { recursive: true, force: true });
      for (const n of fs.readdirSync(aside)) fs.renameSync(path.join(aside, n), path.join(DATA, n));
      fs.rmdirSync(aside);
      console.error('Your previous data was put back.');
    } catch {
      console.error(`Your previous data is safe in ${aside}.`);
    }
  }
  process.exit(1);
}
