// Logs the "test-only OAuth overrides under NODE_ENV=production" warning once when the server starts. Imported by the
// server entry (see the "backup-start" plugin in astro.config.mjs); never loaded by a build or prerender, never touches the database.
import { warnIfOverridden } from './oauth';

try {
  warnIfOverridden();
} catch { /* a warning must never stop the server */ }
