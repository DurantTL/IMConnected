// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// Pages are prerendered to static HTML at build time.
// Only /api/submit runs on the server (it opts out with `prerender = false`).
export default defineConfig({
  site: process.env.SITE_URL || 'https://stories.imadventist.org',
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  trailingSlash: 'ignore',
  security: {
    // /api/submit does its own Origin check against SITE_URL so it works behind
    // a reverse proxy (where the internal request URL is http://, not https://).
    checkOrigin: false,
  },
});
