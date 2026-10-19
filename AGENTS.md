# AGENTS.md: IMConnected

Instructions for AI coding agents (Codex, Claude) working in this repo.

## Stack
- Astro 7 (`output: 'static'` + `@astrojs/node` standalone). Pages are prerendered, and only `src/pages/api/submit.ts` runs on the server (`prerender = false`).
- Content: `src/content/stories/*.md`, with the schema in `src/content.config.ts`.
- Search: Pagefind runs after `astro build` (`npm run build`). Article bodies are marked `data-pagefind-body`.
- Deploy: Docker image built by `.github/workflows/docker.yml` and pushed to GHCR.

## Rules
- Section and category definitions live only in `src/lib/site.ts`. If you change them, also update `.pages.yml`.
- When the content schema changes, keep `.pages.yml`, `src/lib/submission.ts` (frontmatter writer) and the README example in sync.
- Never render submitted text as raw HTML. `textToMarkdown()` in `src/lib/submission.ts` must keep escaping `< > & [ ]`.
- Don't add a database. Stories are files, and publishing is a merge.
- Before finishing, run `npm run build`. It must pass with no errors.
- To test submissions: `node scripts/mock-github.mjs` plus `GITHUB_API_URL=http://localhost:4010`.

## Issues and Claude Code
- `codex-ready` marks an issue with acceptance criteria that an agent may build. `needs-decision` and `needs-human` mark issues blocked on a person and are never `codex-ready`.
- If a requirement is unclear and the answer would change behavior, stop, add the `needs-decision` label, and write down the question.
- Claude Code's subagents live in `.claude/agents/`; its routing rules are in `CLAUDE.md`.

## Data and human gates
- Use synthetic data only in sample stories, tests, screenshots and commits. Submission PR descriptions hold the submitter's email and phone; never copy them into story files, issues, logs, prompts or commits.
- Only a person may merge (publish) or close (reject) a story submission, merge any PR, deploy or pull a new image on the server, change the GitHub token or other secrets, or send a newsletter. Agents may prepare reviewable changes but must not cross those gates.

## Editorial voice (for any sample or generated copy)
Warm but professional, faith-oriented without being overly formal, inverted-pyramid news style. Never invent names, events, quotes or facts about real people or churches.
