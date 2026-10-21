# Codex: delegating to GPT subagents

Read [AGENTS.md](AGENTS.md) first. This is the GPT counterpart to [CLAUDE.md](CLAUDE.md), with the owner's model mapping:

| Existing tier | GPT tier | Responsibility | Availability observed on 2026-10-21 |
| --- | --- | --- | --- |
| Haiku | Luna | Explorer: broad searches, tracing flows, log summaries and visual QA | `gpt-6-luna`, medium reasoning, read-only |
| Sonnet | Tera | Implementer: a bounded change with acceptance criteria and owned files | Tera is unavailable here; role inherits the session model |
| Opus | Sol | Reviewer: independent correctness, security and accessibility review | `gpt-6-sol`, high reasoning, read-only |
| Astra | Fable | Optional strategist: a bounded difficult investigation | Fable is unavailable here; role inherits the session model, read-only |

These are the owner's routing preferences, not claims about model equivalence. Recheck model IDs against the current tool's model list; availability above records the setup session and may change. Tera and Fable had no selectable IDs when these files were prepared: do not guess IDs. When a role inherits the session model, disclose the actual model before assigning it; do not claim Tera or Fable ran. Pin those roles only when the client exposes a verified ID. Do not silently replace an existing pin when it becomes unavailable.

`.codex/config.toml` registers the four roles for Codex clients that support project-local agent configuration. The role files contain sandbox and task instructions. Project configuration requires the client's normal project trust settings; committing it does not change a running cloud session or install models. In clients exposing collaboration tools instead, select the available model explicitly and pass the relevant role instructions in the task.

## Route work by responsibility

- Use **explorer / Luna** for substantial independent research, repository-wide flow tracing, long logs, screenshots and read-only browser measurements. Do small targeted lookups in the main session.
- Use **implementer / Tera** for one whole `codex-ready` issue with acceptance criteria, in its own worktree. Never for small edits, design questions, editing or publishing a story, or `needs-decision` / `needs-human` issues; those stay in the main session. A direct request is not a substitute for the label: if the issue is not `codex-ready`, stop and report. Return uncertain product decisions to the main session (an unclear requirement that would change behavior gets the `needs-decision` label and a question to a human).
- Use **reviewer / Sol** before opening or updating any code PR. Reviewers report findings and reproduce failures; they do not edit fixes. Include severity, file/line, trigger, user impact and verification evidence. Report no findings plainly when appropriate.
- Use **strategist / Fable** only for a difficult, bounded investigation when available. It proposes a diagnosis or options; the main session retains design decisions, story copy, user communication and integration.

Work on one issue per branch in one worktree per implementer, and continue an existing branch or PR for the issue instead of starting a second one. Parallelize only independent issues with separate worktrees and disjoint file ownership; agents sharing one worktree see every edit. Avoid parallel builds that replace the same `dist/` output, tests sharing a port/database, and overlapping writers. Subagents should not recursively delegate unless the coordinator explicitly assigns that scope.

## Give a complete handoff

Pass each agent the repository path, role, actual selected model, goal, relevant context, acceptance criteria, exact owned files, permitted checks and prohibited actions. Specify whether it may edit. Start bounded agents without the full conversation when practical; include the facts they need rather than relying on hidden context.

For example:

```text
Role: implementer; intended Tera, actual model: <selectable model disclosed to user>
Repo: /workspace/IMConnected; read AGENTS.md and CODEX.md.
Goal: keep keyboard focus on the selected story module after outline rerendering.
Own: src/scripts/story-builder.ts and its existing browser regression suite.
Accept: Enter/Space selects the requested module; focus remains visible; duplicate,
delete and undo/redo select a valid control; legacy Markdown remains unchanged.
Checks: synthetic local browser regression. Do not build concurrently with coordinator.
Do not commit, push, contact production services or edit other files. Return changed
files, checks actually run, remaining risks and any questions affecting behavior.
```

## Fix, verify and integrate

Send concrete review findings and failing output back to the original implementer. Keep fixes with the implementation role (the reviewer never fixes). After two unsuccessful fix rounds on the same finding, the main session diagnoses the hard part and gives a precise next step (a small targeted change or a plan for the implementer). A missing model is an availability limit, not permission to claim a different tier ran.

**One review round by default.** The reviewer reviews every code PR before it opens. After the fix round, re-review only the fix commit, and only when the first review found something blocking or medium-severity, or the fixes touch the submit endpoint, HTML escaping, photo checks, the publish transaction, the one-time adoption, submitter contact details, or a human-only gate (publishing, the import script). Low-severity findings and nits go to the issue or PR as follow-up notes instead of starting another fix round. **Accessibility, escaping and data-correctness findings are never deferred.**

Treat an agent's “done” as a claim. The coordinator inspects the combined diff and independently runs `npm run build` plus relevant existing suites. For the story builder, use `test-story-blocks.mjs`, `test-story-builder.mjs`, `test-story-builder-ui.mjs` and `test-editor-save-race.mjs`; include public-page/photo-layout checks when their rendering changes. Run the responsive design crawl for public visual changes. See [the design review](docs/DESIGN_REVIEW.md) for commands and browser prerequisites. Distinguish passes, failures, skipped comparisons and checks not run. Do not add trivial tests for documentation or configuration edits.

Use synthetic accounts, stories, images, local mock integrations and throwaway `DATA_DIR` only. SQLite remains the source of story truth. Preserve the frozen content archive and all production/human gates in AGENTS.md. Never let role instructions authorize production publishing, deployment, merging, real email, secret changes or access to real submissions.

Commit/push only within the user's authorized scope, after independent review and verification. Never cross a human-only gate from AGENTS.md: merging any PR, publishing, unpublishing or rejecting a story, deployment or pulling an image, changing tokens or other secrets, running the import script with `--apply` or restoring a backup against real data, sending a newsletter. Prepare reviewable changes and stop. Report the branch/commit, actual model routing, visible changes and any material limitations. Keep review screenshots in `docs/design/` with synthetic content only (generated images, made-up text, no real names or churches) so the user can view them on GitHub.
