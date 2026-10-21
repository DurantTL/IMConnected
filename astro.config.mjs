// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// Most pages are prerendered to static HTML at build time. The server-rendered ones opt out with `prerender = false`:
// the story, section, area and home pages and the feeds (epic #25), /api/*, /media/*, /admin* and /api/admin/*.
export default defineConfig({
  site: process.env.SITE_URL || 'https://stories.imadventist.org',
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  trailingSlash: 'ignore',
  security: {
    // /api/submit does its own Origin check against SITE_URL (and /api/publish uses a bearer token + PUBLISH_ORIGINS) so it works behind
    // a reverse proxy (where the internal request URL is http://, not https://).
    checkOrigin: false,
  },
});
