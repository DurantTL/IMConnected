// Starts the scheduled-publish timer when the server starts, so a quiet site still publishes on time (issue #124). Imported by
// the server entry (see the "backup-start" plugin in astro.config.mjs), never by the middleware, so public requests are
// untouched and a build or prerender never loads it. The timer is unref'd and the first check waits SCHEDULE_START_DELAY_MS
// (default 20 s) so startup work (migrations, the one-time adoption) settles first. Never throws.
import { ensureScheduler } from './scheduled-publish';

try {
  const n = Number(process.env.SCHEDULE_START_DELAY_MS);
  const delay = Number.isFinite(n) && n >= 0 ? n : 20_000;
  const t = setTimeout(() => {
    try { ensureScheduler(); } catch (err) { console.error('[schedule] could not start:', err instanceof Error ? err.message : err); }
  }, delay);
  t.unref?.();
} catch { /* the site never depends on the scheduler starting */ }
