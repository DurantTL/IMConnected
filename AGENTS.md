# AGENTS.md: IMConnected

Instructions for AI coding agents (Codex, Claude) working in this repo.

## Stack
- Astro 7 (`output: 'static'` + `@astrojs/node` standalone). Pages are prerendered, and only `src/pages/api/submit.ts`, `src/pages/api/publish.ts`, `src/pages/api/confirm.ts`, `/admin*` and `/api/admin/*` run on the server (`prerender = false`).
- Content: `src/content/stories/*.md`, with the schema in `src/content.config.ts`.
- Search: Pagefind runs after `astro build` (`npm run build`). Article bodies are marked `data-pagefind-body`.
- Editor dashboard: `/admin*` and `/api/admin/*` are server-rendered and guarded by `src/middleware.ts` (session, 2FA state, Origin check, no-store/noindex headers). The middleware must return immediately for every other path so public pages stay prerendered. See epic #7.
- Deploy: Docker image built by `.github/workflows/docker.yml` and pushed to GHCR.

## Rules
- Section and category definitions live only in `src/lib/site.ts`. If you change them, also update `.pages.yml`.
- When the content schema changes, keep `.pages.yml`, `src/lib/submission.ts` (frontmatter writer), `src/lib/feed.ts` (the `/stories.json` and `/rss.xml` feeds) and the README example in sync. Treat `/stories.json` fields as a public contract: add fields freely, but don't rename or remove one without bumping its `version`.
- Never render submitted text as raw HTML. `textToMarkdown()` in `src/lib/submission.ts` must keep escaping `< > & [ ]`.
- Submissions: `/api/submit` creates a `drafts` row (default `SUBMISSIONS_TO=dashboard`) and makes no GitHub call; `SUBMISSIONS_TO=github` is the old pull-request path, to be removed in a follow-up. If the database is down it answers 503 rather than lose the story. `/api/publish` (Studio) still commits straight to `main` and also records a `published` draft (source `studio`).
- Storage: published stories stay Markdown files in git (publishing is a commit to `main`). A small SQLite database (`node:sqlite`, in `DATA_DIR`, a Docker volume at `/data`) holds editor accounts, sessions, drafts and the audit log. Schema changes are new numbered files in `src/lib/db/migrations/`; never edit an applied one. Don't add another datastore.
- Before finishing, run `npm run build`. It must pass with no errors.
- To test submissions: `node scripts/mock-github.mjs` plus `GITHUB_API_URL=http://localhost:4010`.

## Issues and Claude Code
- `codex-ready` marks an issue with acceptance criteria that an agent may build. `needs-decision` and `needs-human` mark issues blocked on a person and are never `codex-ready`.
- If a requirement is unclear and the answer would change behavior, stop, add the `needs-decision` label, and write down the question.
- Claude Code's subagents live in `.claude/agents/`; its routing rules are in `CLAUDE.md`.

## Data and human gates
- Use synthetic data only in sample stories, tests, screenshots and commits. Submitter contact details (email, phone) live only in the database and the editor-only panel in `/admin` (and in the PR description when `SUBMISSIONS_TO=github`); never copy them into story files, issues, logs, prompts, commits, or the emails sent to editors.
- Agents never connect to the production database or create real accounts; test against a throwaway `DATA_DIR` with synthetic data and delete it.
- Only a person may publish or reject a draft in the dashboard (and merge or close a submission PR on the old `SUBMISSIONS_TO=github` path), merge any PR, deploy or pull a new image on the server, change the GitHub token or other secrets, or send a newsletter. Agents may prepare reviewable changes but must not cross those gates.
- The Studio "Publish to IMConnected" button (`/api/publish`) is a person's action. Agents must never call `/api/publish` against the real site, and must never use or ask for `PUBLISH_TOKEN`. Test it only against `scripts/mock-github.mjs` with a made-up token.
- Never log submitter email addresses or phone numbers (log the draft id or PR number instead). Editor notification emails carry only the escaped title and church plus a link. Agents must never send real email: test with `RESEND_API_KEY` unset, or point `EMAIL_API_URL` at a local mock of the Resend endpoint. Use only Cloudflare's documented Turnstile test keys, or `TURNSTILE_VERIFY_URL` pointing at a local mock.

## Editorial voice (for any sample or generated copy)
Warm but professional, faith-oriented without being overly formal, inverted-pyramid news style. Never invent names, events, quotes or facts about real people or churches.
