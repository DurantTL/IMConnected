# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The commits this image is built from (docker.yml writes the real list; a local build gets an empty file). Only the
# one-time adoption of the built stories reads it (src/lib/story-adopt.ts); remove it with the story_holds cleanup.
RUN touch .build-commits
# Canonical URL baked into pages (og:url, canonical, sitemap). Override with --build-arg.
ARG SITE_URL=https://stories.imadventist.org
ENV SITE_URL=$SITE_URL
# Public Cloudflare Turnstile site key, baked into the prerendered /submit/ page. Empty turns the widget off.
ARG PUBLIC_TURNSTILE_SITE_KEY=
ENV PUBLIC_TURNSTILE_SITE_KEY=$PUBLIC_TURNSTILE_SITE_KEY
RUN npm run build

# ---------- runtime deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/.build-commits ./.build-commits
COPY package.json ./
# create-admin.mjs, import-git-stories.mjs and the migrations they apply (run with `docker compose exec`);
# site.ts is the sections list the import script validates against.
COPY scripts ./scripts
COPY src/lib/db ./src/lib/db
COPY src/lib/site.ts ./src/lib/site.ts
# SQLite database lives on a volume at /data
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
VOLUME /data
USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4321/ >/dev/null || exit 1
CMD ["node", "dist/server/entry.mjs"]
