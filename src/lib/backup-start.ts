// Starts the nightly backup scheduler when the server starts, so a quiet site is still backed up. This module is
// imported by the server entry (see the "backup-start" plugin in astro.config.mjs), not by the middleware, so
// public requests are untouched. It does nothing, and never opens the database, when Google Drive is not configured.
// After BACKUP_START_DELAY_MS (default 30 s, so startup work settles first) it starts the same unref'd timer that
// getDb() would start; never throws, never keeps the process alive.
import { driveConfig } from './db/gdrive.mjs';
import { ensureBackupScheduler } from './backup';

try {
  if (driveConfig().configured) {
    const n = Number(process.env.BACKUP_START_DELAY_MS);
    const delay = Number.isFinite(n) && n >= 0 ? n : 30_000;
    const t = setTimeout(() => {
      try { ensureBackupScheduler(); } catch (err) { console.error('[backup] could not start:', err instanceof Error ? err.message : err); }
    }, delay);
    t.unref?.();
  }
} catch { /* the site never depends on backups */ }
