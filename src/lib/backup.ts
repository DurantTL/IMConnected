// Nightly backups (epic #25, issue #30): the scheduler, the run bookkeeping in `backup_runs`, the status the
// admin page shows and the "no backup for 48 hours" email. The work itself (snapshot, archive, Drive) is in
// src/lib/db/backup-*.mjs and gdrive.mjs.
//
// How it runs: getDb() calls ensureBackupScheduler() on every use (one boolean check after the first). When both
// Google settings are present it starts ONE unref'd timer that wakes every few minutes; each wake is cheap (a clock
// check and, once a day is due, one database claim). Backups are disabled, with a status line saying why, when
// either setting is missing. A run is claimed with a database transaction (one row per attempt with a heartbeat), so
// a restart does not repeat a finished backup and only one process works at a time. The snapshot is synchronous and
// quick; the archive and uploads are streams, so requests are never held up for long.
import { getDb } from './db';
import { dataDir } from './db/db-core.mjs';
import { driveConfig, createDriveClient, type DriveClient } from './db/gdrive.mjs';
import { performBackup, listLocal } from './db/backup-run.mjs';
import { utcDay, redact } from './db/backup-core.mjs';
import { buildBackupAlert, postEmailBatch } from './email';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const ALERT_AFTER_MS = 48 * HOUR;
const ALERT_EVERY_MS = 24 * HOUR;
const STALE_MS = 10 * MIN; // a running row whose heartbeat is older than this was interrupted

/** BACKUP_HOUR: the UTC hour (0-23) after which today's backup is due. Default 9 = early morning US Central. */
export function backupHour(env = process.env): number {
  const raw = (env.BACKUP_HOUR ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 && n <= 23 ? n : 9;
}

// Internal timings; the env overrides exist so the end-to-end test does not have to wait minutes.
const num = (v: string | undefined, def: number, min: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
};
const checkMs = (env = process.env) => num(env.BACKUP_CHECK_MS, 5 * MIN, 100);
const retryMs = (env = process.env) => num(env.BACKUP_RETRY_MS, 30 * MIN, 0);
const attemptDelayMs = (env = process.env) => num(env.BACKUP_ATTEMPT_DELAY_MS, 5000, 0);

// ---------- state ----------

interface RunRow {
  id: number; day: string; started_at: number; heartbeat_at: number; finished_at: number | null; ok: number;
  db_bytes: number | null; media_bytes: number | null; uploads: number; attempts: number; error: string | null;
}

let timer: ReturnType<typeof setInterval> | undefined;
let firstTick: ReturnType<typeof setTimeout> | undefined;
let running = false;
let client: { key: string; drive: DriveClient } | undefined;

function secretsOf(env = process.env): string[] {
  const cfg = driveConfig(env);
  return [env.GDRIVE_SERVICE_ACCOUNT_JSON ?? '', cfg.key?.private_key ?? ''].filter(Boolean);
}

function driveFor(env = process.env): DriveClient {
  const cfg = driveConfig(env);
  const key = [env.GDRIVE_SERVICE_ACCOUNT_JSON, env.GDRIVE_FOLDER_ID, cfg.scope, cfg.apiUrl, cfg.tokenUrl].join('|');
  if (!client || client.key !== key) client = { key, drive: createDriveClient(cfg) }; // keeps its cached access token
  return client.drive;
}

/** Claim today's run: null when it is already done, one is in progress, or the last failure is too recent to retry. */
function claimRun(day: string, now: number, env = process.env): number | null {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE backup_runs SET finished_at = ?, error = 'interrupted (the server stopped during the backup)' WHERE finished_at IS NULL AND heartbeat_at < ?").run(now, now - STALE_MS);
    const done = db.prepare('SELECT 1 FROM backup_runs WHERE day = ? AND ok = 1').get(day);
    const busy = db.prepare('SELECT 1 FROM backup_runs WHERE finished_at IS NULL').get();
    const last = db.prepare('SELECT finished_at FROM backup_runs WHERE day = ? ORDER BY id DESC LIMIT 1').get(day) as { finished_at: number | null } | undefined;
    if (done || busy || (last?.finished_at != null && now - last.finished_at < retryMs(env))) {
      db.exec('COMMIT');
      return null;
    }
    const id = Number(db.prepare('INSERT INTO backup_runs (day, started_at, heartbeat_at) VALUES (?, ?, ?)').run(day, now, now).lastInsertRowid);
    db.exec('COMMIT');
    return id;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Run one backup now (claims the day first). Never throws. */
async function runClaimed(id: number, now: number, env = process.env): Promise<void> {
  const db = getDb();
  const beat = setInterval(() => {
    try { db.prepare('UPDATE backup_runs SET heartbeat_at = ? WHERE id = ?').run(Date.now(), id); } catch { /* next beat */ }
  }, MIN);
  beat.unref?.();
  const secrets = secretsOf(env);
  try {
    const out = await performBackup({ dataDir: dataDir(), drive: driveFor(env), now, attemptDelayMs: attemptDelayMs(env), secrets });
    const note = out.warnings.length ? redact(out.warnings.join('; '), secrets) : null;
    db.prepare('UPDATE backup_runs SET finished_at = ?, ok = 1, db_bytes = ?, media_bytes = ?, uploads = ?, attempts = ?, error = ? WHERE id = ?')
      .run(Date.now(), out.dbBytes, out.mediaBytes, out.uploads, out.attempts, note, id);
    console.log(`[backup] ok: ${out.day}, database ${out.dbBytes} bytes, media ${out.mediaBytes} bytes, ${out.uploads} files uploaded${note ? ` (note: ${note})` : ''}`);
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), secrets) || 'the backup failed';
    const p = (err as { partial?: { dbBytes: number | null; mediaBytes: number | null; uploads: number; attempts: number } }).partial;
    try {
      db.prepare('UPDATE backup_runs SET finished_at = ?, ok = 0, db_bytes = ?, media_bytes = ?, uploads = ?, attempts = ?, error = ? WHERE id = ?')
        .run(Date.now(), p?.dbBytes ?? null, p?.mediaBytes ?? null, p?.uploads ?? 0, p?.attempts ?? 0, message, id);
    } catch { /* the log line below still reports it */ }
    console.error(`[backup] failed: ${message}`);
  } finally {
    clearInterval(beat);
  }
}

// ---------- the alert ----------

export function adminAddresses(): string[] {
  return (getDb().prepare("SELECT email FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id").all() as { email: string }[]).map((r) => r.email);
}

/** Email the active admins when no backup succeeded for 48 hours (counted from the first configured start when none ever has), at most once a day. */
export async function maybeAlert(now = Date.now(), env = process.env): Promise<boolean> {
  const db = getDb();
  const state = db.prepare('SELECT configured_since, last_alert_at FROM backup_state WHERE id = 1').get() as { configured_since: number | null; last_alert_at: number | null };
  const lastOk = (db.prepare('SELECT MAX(finished_at) AS t FROM backup_runs WHERE ok = 1').get() as { t: number | null }).t;
  const since = lastOk ?? state.configured_since ?? now;
  if (now - since < ALERT_AFTER_MS) return false;
  if (state.last_alert_at != null && now - state.last_alert_at < ALERT_EVERY_MS) return false;
  const to = adminAddresses();
  if (!to.length) return false;
  // Claim the day's alert first so two processes cannot both send it.
  const claimed = db.prepare('UPDATE backup_state SET last_alert_at = ? WHERE id = 1 AND (last_alert_at IS NULL OR last_alert_at <= ?)').run(now, now - ALERT_EVERY_MS);
  if (Number(claimed.changes) !== 1) return false;
  const lastErr = (db.prepare('SELECT error FROM backup_runs WHERE ok = 0 AND error IS NOT NULL ORDER BY id DESC LIMIT 1').get() as { error: string } | undefined)?.error ?? null;
  const site = (env.SITE_URL || 'https://stories.imadventist.org').replace(/\/+$/, '');
  const mail = buildBackupAlert(lastOk === null ? null : Math.floor((now - lastOk) / HOUR), lastErr, `${site}/admin/backups`);
  const res = await postEmailBatch(to.map((addr) => ({ to: addr, ...mail })), env);
  console.log(`[backup] no successful backup for 48 hours; alert emailed to ${res.sent} admin(s), ${res.failed} failed`);
  return true;
}

// ---------- the scheduler ----------

/** One scheduler wake: record the clock start, alert if overdue, and run today's backup when it is due and not done. */
export async function backupTick(now = Date.now(), env = process.env): Promise<void> {
  const cfg = driveConfig(env);
  if (!cfg.configured || running) return;
  running = true;
  try {
    const db = getDb();
    db.prepare('UPDATE backup_state SET configured_since = ? WHERE id = 1 AND configured_since IS NULL').run(now);
    try { await maybeAlert(now, env); } catch (err) { console.error('[backup] alert failed:', redact(err instanceof Error ? err.message : err, secretsOf(env))); }
    if (new Date(now).getUTCHours() < backupHour(env)) return;
    const id = claimRun(utcDay(now), now, env);
    if (id !== null) await runClaimed(id, now, env);
  } catch (err) {
    console.error('[backup] check failed:', redact(err instanceof Error ? err.message : err, secretsOf(env)));
  } finally {
    running = false;
  }
}

let started = false;

/** Called from getDb(). Starts the timer once if backups are configured; otherwise clears the 48 hour clock. Never throws. */
export function ensureBackupScheduler(): void {
  if (started) return;
  started = true;
  try {
    if (!driveConfig().configured) {
      getDb().prepare('UPDATE backup_state SET configured_since = NULL WHERE id = 1').run();
      return;
    }
    const every = checkMs();
    firstTick = setTimeout(() => void backupTick(), Math.min(10_000, every));
    firstTick.unref?.();
    timer = setInterval(() => void backupTick(), every);
    timer.unref?.();
  } catch (err) {
    started = false; // try again on the next database use (e.g. the table is not there yet)
    console.error('[backup] could not start the scheduler:', err instanceof Error ? err.message : err);
  }
}

// ---------- status for /admin/backups ----------

export interface BackupStatus {
  configured: boolean;
  missing: string[];
  problems: string[];
  scope: string;
  hourUtc: number;
  lastOk: RunRow | null;
  lastRun: RunRow | null;
  recent: RunRow[];
  local: { name: string; bytes: number }[];
  overdue: boolean;
  lastAlertAt: number | null;
  nextDue: number | null;
}

export function getBackupStatus(now = Date.now(), env = process.env): BackupStatus {
  const db = getDb();
  const cfg = driveConfig(env);
  const lastOk = (db.prepare('SELECT * FROM backup_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as RunRow | undefined) ?? null;
  const lastRun = (db.prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1').get() as RunRow | undefined) ?? null;
  const recent = db.prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 10').all() as unknown as RunRow[];
  const state = db.prepare('SELECT configured_since, last_alert_at FROM backup_state WHERE id = 1').get() as { configured_since: number | null; last_alert_at: number | null };
  const since = lastOk?.finished_at ?? state.configured_since;
  const hour = backupHour(env);
  const d = new Date(now);
  const todayDue = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour);
  const doneToday = lastOk?.day === utcDay(now);
  const nextDue = !cfg.configured ? null : doneToday ? todayDue + 24 * HOUR : Math.max(now, todayDue);
  return {
    configured: cfg.configured,
    missing: cfg.missing,
    problems: cfg.problems,
    scope: cfg.scope,
    hourUtc: hour,
    lastOk,
    lastRun,
    recent,
    local: listLocal(dataDir()).slice(0, 30),
    overdue: cfg.configured && since != null && now - since >= ALERT_AFTER_MS,
    lastAlertAt: state.last_alert_at,
    nextDue,
  };
}
