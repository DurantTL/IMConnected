// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { fileURLToPath } from 'node:url';

// Nightly backups must start when the server starts, not on the first request that needs the database. The Node
// adapter's server entry is the one module the standalone server always loads, so this plugin adds an import of
// src/lib/backup-start.ts to it (that module only sets an unref'd timer, and only when Google Drive is configured). The same plugin adds
// src/lib/schedule-start.ts, which starts the scheduled-publish timer (issue #124).
const backupStart = fileURLToPath(new URL('./src/lib/backup-start.ts', import.meta.url));
const scheduleStart = fileURLToPath(new URL('./src/lib/schedule-start.ts', import.meta.url));
const backupStartPlugin = {
  name: 'backup-start',
  enforce: /** @type {const} */ ('post'),
  transform(/** @type {string} */ code, /** @type {string} */ id) {
    if (/@astrojs[\\/]node[\\/]dist[\\/]server\.js$/.test(id.split('?')[0])) return { code: `${code}\nimport ${JSON.stringify(backupStart)};\nimport ${JSON.stringify(scheduleStart)};\n`, map: null };
  },
};

// Most pages are prerendered to static HTML at build time. The server-rendered ones opt out with `prerender = false`:
// the story, section, area and home pages and the feeds (epic #25), /api/*, /media/*, /admin* and /api/admin/*.
export default defineConfig({
  site: process.env.SITE_URL || 'https://stories.imadventist.org',
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  trailingSlash: 'ignore',
  vite: { plugins: [backupStartPlugin] },
  security: {
    // /api/submit does its own Origin check against SITE_URL (and /api/publish uses a bearer token + PUBLISH_ORIGINS) so it works behind
    // a reverse proxy (where the internal request URL is http://, not https://).
    checkOrigin: false,
  },
});
