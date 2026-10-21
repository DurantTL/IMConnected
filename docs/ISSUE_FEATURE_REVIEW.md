# Feature review: IMConnected #3–#38

The owner requested review, implementation PRs and reconciliation of completed issues in this range. GitHub's live issue bodies and comments are now readable. This audit distinguishes merged features, unmerged PRs and unfinished requirements.

## GitHub access restored

The initial environment blocked `api.github.com` at the proxy CONNECT step, even for an unauthenticated public repository. Its package-manager preset permitted GitHub downloads but omitted the API host. An additive allowlist rule was saved; subsequent runtime checks returned HTTP 200 and authenticated as **DurantTL**. GitHub confirms admin/push/triage access to IMConnected and push/triage access to both selected imsda repositories. No account reconnect or credential replacement was needed. Native Git and the API now both work.

All 20 actual issues in #3–#38 were read, including comments where present; gaps in the number sequence are pull requests, not missing feature issues. Earlier source-only guesses have been replaced by the live criteria below.

## Completed issues

These twelve issues were closed with an individual evidence comment after checking their bodies, merged PRs and current source. Changes on the unmerged design branches were not used to justify completion.

| Issue | Merged delivery | Verification / reconciliation |
| --- | --- | --- |
| [#3 Studio publish API](https://github.com/DurantTL/IMConnected/issues/3) | PR #4, updated by PR #39 | 92 current submission/Studio checks. The approved #25 architecture supersedes the original Git Data API/commit criteria: database publish returns `commit: null`. |
| [#8 Database/admin foundation](https://github.com/DurantTL/IMConnected/issues/8) | PR #15 | 80 authentication checks cover startup, migrations, bootstrap and middleware. |
| [#9 Password, TOTP and recovery](https://github.com/DurantTL/IMConnected/issues/9) | PR #16 | 80 authentication checks, including the follow-up invite/session/rate-limit cases. |
| [#10 Passkeys](https://github.com/DurantTL/IMConnected/issues/10) | PR #17 | 54 real-browser virtual-authenticator checks; reset, expiry, replay, counters and last-factor protections included. |
| [#12 Accounts and audit](https://github.com/DurantTL/IMConnected/issues/12) | PR #22 | 145 account checks, including browser, roles, fresh-factor/last-admin gates and privacy. |
| [#13 Drafts/editor](https://github.com/DurantTL/IMConnected/issues/13) | PR #19, updated by PRs #39/#41 | 183 draft checks and the pending-save publish regression. The approved database architecture replaces the older file-publishing model. |
| [#14 Submissions/Studio inbox](https://github.com/DurantTL/IMConnected/issues/14) | PR #20, updated by PR #39 | 92 submission/Studio checks; obsolete GitHub submission/direct-to-main criteria superseded by #25. |
| [#21 Agent intake and Studio list](https://github.com/DurantTL/IMConnected/issues/21) | PRs #23/#33/#39 | 201 current synthetic checks. Agent remains draft-only; no production token or endpoint used. |
| [#26 Story/photo storage and media](https://github.com/DurantTL/IMConnected/issues/26) | PR #31 | Merged PR records successful populated migration, store/media, restart and traversal suites; source rechecked. Temporary mirroring was superseded by step 4 as planned. The rebuild-based store suite was not rerun during this audit. |
| [#28 SQLite search](https://github.com/DurantTL/IMConnected/issues/28) | PR #34 | Safe FTS query/snippets, visibility, rate limits and immediate publishing covered by current search checks. Migration 013 replaces the original proposed number 012. Separate upgrade follow-up #38 remains open. |
| [#29 Database publishing](https://github.com/DurantTL/IMConnected/issues/29) | PR #39 | 183 draft, 92 submission/Studio and 37 public-page checks, plus search tests. Preserves transactional writes, conflicts, immediate visibility and no GitHub publish path. |
| [#35 Photo layouts/viewer](https://github.com/DurantTL/IMConnected/issues/35) | PR #40, retained by PR #41 | 94 layout/viewer checks with 75 screenshots at 390/768/1280px and axe. The owner's later magazine redesign explicitly supersedes the original pixel-identical-old-pages criterion. #36 remains separate. |

Current checks ran against the final crop build; closure evidence was also checked against merged `main` at `d218010` so unmerged additions were not mistaken for already delivered features. Four historical public markup comparison groups were explicitly skipped after the intentional redesign; they are not counted as passes.

## Open issues and remaining work

| Issue | Why it stays open |
| --- | --- |
| [#5 Submission protections](https://github.com/DurantTL/IMConnected/issues/5) | Turnstile/email/confirmation implementation is merged, but the issue's specific provider test-key documentation and pass/fail/outage coverage still need reconciliation. |
| [#7 Editor epic](https://github.com/DurantTL/IMConnected/issues/7) | Depends on unfinished Google/Microsoft sign-in (#11). |
| [#11 Google/Microsoft OAuth](https://github.com/DurantTL/IMConnected/issues/11) | Provider flows, migration, buttons/config, account linking and mock OIDC tests are absent from merged main. It is not currently labelled `codex-ready`. |
| [#25 Database epic](https://github.com/DurantTL/IMConnected/issues/25) | Keep open while #27/#30 acceptance and operational backup readiness are reconciled. |
| [#27 Public database rendering](https://github.com/DurantTL/IMConnected/issues/27) | Implementation is merged and functional tests pass. Historical visual comparisons were superseded by the redesign, but the issue's cached/uncached latency measurements remain unrecorded in this audit. |
| [#30 Backups](https://github.com/DurantTL/IMConnected/issues/30) | Implementation is merged. The first current backup run failed its memory threshold (26 MB versus 24 MB for a 64 MiB archive); all checks passed on an isolated rerun. Keep open for the intermittent threshold investigation. Backup code is unchanged from main and streams with backpressure. Real off-server configuration/restore remain human actions. |
| [#36 Inline Markdown photos/galleries](https://github.com/DurantTL/IMConnected/issues/36) | Still unimplemented. `{{photo N}}` and `{{gallery …}}` markers must coexist with modules; existing image modules do not satisfy this issue. |
| [#38 Upgrade search readiness](https://github.com/DurantTL/IMConnected/issues/38) | Fix is reviewed/tested in PR #42, not merged. Ten consecutive search-suite runs passed, 104 checks each. The original archive-fallback criterion is superseded by current AGENTS.md's database-only/no-fallback rule: incomplete initial search returns `ok: false`. The earlier full browser/axe run passed; optional axe checks were not enabled for the ten repeats. |

## Review branches

- [PR #42: story canvas and upgrade search readiness](https://github.com/DurantTL/IMConnected/pull/42), `codex/imconnected-canvas-search` (`6834424`) against `main`. Desktop library/outline, composed canvas and inspector; searchable module library; empty News story/Event recap/Announcement starters; private canvas selection with native semantics; phone Build/Preview; stored closed-draft previews; visitor search and initial index completeness.
- `codex/imconnected-image-crop` stacks on the canvas/search branch. Separate PR for non-destructive 100–300% zoom, drag/keyboard panning and reset, migration 018, old-form preservation, public crops, reopen/import/adoption/feed metadata and original image retention. See [design notes and screenshots](DESIGN_REVIEW.md).

The original magazine/editor redesign is already merged through PR #41; no duplicate redesign PR is needed. The selected utilities and tools-public `imconnected.html` files matched their fetched selected branches and were left unchanged.

Independent audits/reviews used Sol and Luna; the main session implemented/integrated the crop work. Tera and Fable were unavailable and were not claimed as used. All new sample data/screenshots are synthetic. No production publishing, merge, deployment, real email or secret change was performed.
