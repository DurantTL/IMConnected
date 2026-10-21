// One backup run: snapshot the database, archive media and uploads, upload both to Drive, then apply retention
// on Drive and on disk. Pure of any bookkeeping (src/lib/backup.ts records the run in the database); it never
// logs, so no secret can reach a log from here.
import fs from 'node:fs';
import path from 'node:path';
import { snapshotDatabase, createMediaArchive, backupFileName, parseBackupName, expiredEntries, utcDay, redact } from './backup-core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const backupsDir = (dataDir) => path.join(dataDir, 'backups');

/** Delete local backups that retention no longer keeps. Only files with our names are ever touched. */
export function pruneLocal(dataDir, today) {
  const dir = backupsDir(dataDir);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const e of expiredEntries(names.map((name) => ({ name })), today)) {
    if (!parseBackupName(e.name)) continue;
    fs.rmSync(path.join(dir, e.name), { force: true });
    removed.push(e.name);
  }
  return removed;
}

/** Local backup files ({ name, bytes }) newest first, for the status page. */
export function listLocal(dataDir) {
  const dir = backupsDir(dataDir);
  try {
    return fs.readdirSync(dir)
      .filter((n) => parseBackupName(n))
      .map((name) => ({ name, bytes: fs.statSync(path.join(dir, name)).size }))
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  } catch {
    return [];
  }
}

/**
 * Take one backup for the UTC day of `now`. `drive` is a client from createDriveClient (null skips Drive: tests of
 * the local half only). On success returns { day, dbBytes, mediaBytes, uploads, attempts, warnings }. On failure
 * throws an Error (message free of secrets) with `.partial = { dbBytes, mediaBytes, uploads, attempts }`.
 */
export async function performBackup({ dataDir, drive, now = Date.now(), maxAttempts = 3, attemptDelayMs = 5000, secrets = [] }) {
  const day = utcDay(now);
  const partial = { dbBytes: null, mediaBytes: null, uploads: 0, attempts: 0 };
  const warnings = [];
  const dir = backupsDir(dataDir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const n of fs.readdirSync(dir)) if (n.startsWith('.tmp-')) fs.rmSync(path.join(dir, n), { force: true });

    const dbName = backupFileName(day, 'db');
    const mediaName = backupFileName(day, 'media');
    const dbFile = path.join(dir, dbName);
    const mediaFile = path.join(dir, mediaName);

    // 1. Database first, then the files: a photo written after the snapshot is harmless (an unreferenced file),
    //    a row that points at a missing photo would not be.
    const dbTmp = path.join(dir, `.tmp-${dbName}`);
    partial.dbBytes = snapshotDatabase(dataDir, dbTmp);
    fs.renameSync(dbTmp, dbFile);
    const mediaTmp = path.join(dir, `.tmp-${mediaName}`);
    partial.mediaBytes = await createMediaArchive(dataDir, mediaTmp);
    fs.renameSync(mediaTmp, mediaFile);

    // 2. Drive.
    if (drive) {
      const before = (await drive.listFolder()).filter((f) => f.owned && parseBackupName(f.name));
      for (const [file, name, type] of [[dbFile, dbName, 'application/vnd.sqlite3'], [mediaFile, mediaName, 'application/gzip']]) {
        let sent = null;
        let last = null;
        for (let attempt = 1; attempt <= maxAttempts && !sent; attempt++) {
          partial.attempts++;
          try {
            sent = await drive.uploadFile(file, name, type);
          } catch (err) {
            last = err;
            if (attempt < maxAttempts) await sleep(attemptDelayMs * attempt);
          }
        }
        if (!sent) throw new Error(`Uploading ${name} failed after ${maxAttempts} tries: ${last instanceof Error ? last.message : last}`);
        partial.uploads++;
        // A same-day re-run replaces the earlier copy of the same name.
        for (const old of before.filter((f) => f.name === name && f.id !== sent.id)) {
          try { await drive.deleteFile(old.id); } catch (err) { warnings.push(`could not remove an older copy of ${name}: ${err instanceof Error ? err.message : err}`); }
        }
      }
      // 3. Retention on Drive: only files this account created whose names match the pattern.
      try {
        const now2 = (await drive.listFolder()).filter((f) => f.owned && parseBackupName(f.name));
        for (const f of expiredEntries(now2, day)) {
          try { await drive.deleteFile(f.id); } catch (err) { warnings.push(`could not delete ${f.name} from Drive: ${err instanceof Error ? err.message : err}`); }
        }
      } catch (err) {
        warnings.push(`Drive cleanup skipped: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 4. Retention on disk.
    try { pruneLocal(dataDir, day); } catch (err) { warnings.push(`local cleanup failed: ${err instanceof Error ? err.message : err}`); }
    return { day, dbBytes: partial.dbBytes, mediaBytes: partial.mediaBytes, uploads: partial.uploads, attempts: partial.attempts, warnings: warnings.map((w) => redact(w, secrets)) };
  } catch (err) {
    const e = new Error(redact(err instanceof Error ? err.message : String(err), secrets));
    e.partial = partial;
    throw e;
  }
}
