# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                           # Run all tests (find src -name '*.test.js' -print0 | xargs -0 node --test --test-concurrency=1)
node --test src/observe.test.js    # Run a single test file
npm start                          # Run full pipeline (all phases)
npm run observe                    # Run observe phase only
npm run report                     # Run report phase only
INPUT_DRY_RUN=true npm start       # Dry run (no issue/PR/roadmap writes; snapshots still persist)
```

The CI workflow also runs a secret-leak lint check that greps source files for hardcoded API keys (sk-, AIza, ghp_, ghs_). This excludes safety.js and *.test.js.

`--test-concurrency=1` is deliberate: Node's test runner isolates each file in its own child process, and under the default concurrency the largest file (report.test.js, 2000+ lines) intermittently lost its trailing suites over the IPC channel — a full run would silently report ~50 fewer tests with no failure surfaced apart from a stray count mismatch. Serializing removed the flake in repeated local runs at a ~2.5s cost.

## Code review before merging

Never merge a PR before the AI code review bot has completed its review. GitHub Copilot code review is the portfolio standard (ADR-009) — wait for the GitHub Copilot review (any review/check whose name contains `copilot`). Legacy review bots (e.g. Gemini Code Assist, CodeRabbit) are deprecated and no longer active here; do not wait on them. Wait up to 20 minutes for the review to finish. After the review completes, address every inline comment before merging — either apply the fix, or explain why not and reply to each comment individually via the GitHub API. Use the /address-pr-comments skill for this workflow.

## Architecture

This is a GitHub Action (runs on the `node24` runtime, ES modules, zero npm dependencies) that runs a seven-phase pipeline plus a continuous monitor:

```
OBSERVE → ASSESS → UPDATE → GOVERNANCE → IDEATE → PROPOSE → REPORT   (+ MONITOR)
```

`src/index.js` is a thin dispatcher: it parses the requested phase(s) from `--phase=` arg or `INPUT_PHASE` env var, builds the shared `context` object, validates the LLM provider, then loops over the selected phases calling the matching `runX(context)` wrapper. Each phase module exports both its core function (e.g. `observe`, `assess`, `update`, …) and a `runX` wrapper that handles surrounding orchestration — snapshot persistence, governance detection, council deliberation, and storing results back on `context` for downstream phases. Index keeps only the truly cross-cutting concerns: provider wiring, the auto-onboard pass, and the GITHUB_OUTPUT summary. The `all` phase runs the wrappers sequentially. `monitor` is a separate phase that detects new events between scheduled runs and feeds them into the council.

`src/governance.js` runs as a first-class GOVERNANCE phase between UPDATE and IDEATE, producing six finding types — standards gaps, policy drift, tier-uplift proposals, tier regressions (the G7 Gold ratchet: a repo's tier fell since the previous weekly portfolio snapshot, diffed via the shared `detectTierChanges` core against `readLatestPortfolioWeekly({ beforeWeek })` so the finding persists for its week across the 4×/day runs), open-vulnerability findings (repos with open critical/high Dependabot/code-scanning alerts, or any secret-scanning hit), and stale-Dependabot-PR audits — which are persisted to the data branch for the MCP `get_governance_findings` tool, the dashboard, and the `governance:apply` workflow. `open-vulnerability` and `tier-regression` are per-repo *state* findings (like `dependabot-stale`): they route to `executor: 'manual'` and are never wired to the templated-PR path or cross-repo PROPOSE (ADR-002/ADR-011 lane boundary — resolving a specific alert or a lost tier is per-repo work, not a cross-repo statistic; the route back up a tier lives in the companion tier-uplift finding). Detection is pure deterministic JS (no LLM cost), so the daily pipeline runs it 4×/day to keep findings fresh; the weekly IDEATE run picks up the same fresh findings via `runGovernance`'s idempotency guard inside `runIdeate`.

A dependabot-sourced `open-vulnerability` finding also carries `autofixEnabled` (ADR-012 Phase 3): `true`/`false`/`null` for whether GitHub's Dependabot automated security fixes are actively opening the bump PRs — distinguishing "remediation in flight" from "not being driven to resolution". Detection stays PURE: the `{ enabled, paused }` state is fetched in the OBSERVE/portfolio-details layer (`getAutomatedSecurityFixesState` in `observe.js` + `report-portfolio.js`, mirroring how `hasActiveCopilotReviewRuleset` feeds code-review-bot detection) and threaded into `details[repo].autofix`; `detectOpenVulnerabilities` only reads it. `autofixEnabled` is derived `enabled && !paused` (paused → `false`; unreadable/absent → `null`). When it is `true` and Dependabot is the *only* source, a `high` finding is downgraded to `medium` (remediation is in flight); `max_severity` is never changed and multi-source findings keep their priority. The health-tier logic (`report-shared.computeHealthTier`) is UNCHANGED — an open alert still drops the tier; "in flight" is a governance annotation, not a tier reprieve.

`src/dependabot-audit.js` is the stale Dependabot PR detector called by GOVERNANCE; it flags long-open dependency update PRs so they surface as findings.

`src/apply.js` is the Governance Apply phase: it opens remediation PRs on target repos for actionable governance findings (manual dispatch only, dry-run by default, max 5 PRs per run). It also carries two PR-less settings-write classes: `applyCopilotReviewRulesets` (ADR-009, enables the Copilot review ruleset) and `applyDependabotSecurityUpdates` (ADR-012, enables GitHub's Dependabot automated security fixes on `dependabot`-sourced `open-vulnerability` repos). ADR-012 is the tighter of the two — it delegates autonomous PR generation to GitHub, so unlike the Copilot class it is **manual-dispatch only and OFF the apply-schedule allow-list by construction** (`applyDependabotSecurityUpdates` unconditionally skips when `scheduled`, and `index.js` never dispatches it on a scheduled run), auto-merge-ineligible by construction (no `TEMPLATES` entry), and its LIVE idempotency guard skips a repo that is enabled **or paused** (a paused flag is a deliberate human/GitHub state on an un-name-guardable setting). `removeDependabotSecurityUpdates` is the reversibility affordance (DELETE — reverts the setting, not already-opened PRs). Going live is the maintainer's deliberate `dry-run=false tools=dependabot-security` dispatch. The reversal has its own operator entry point: `disableDependabotSecurityUpdates` (dispatched via `tools=dependabot-security-off`) wraps `removeDependabotSecurityUpdates` over the same dependabot-sourced target selection behind the identical ADR-012 fences (require_approval, dry-run fail-closed, manual-dispatch only / OFF the schedule by construction, per-run cap, repo-name validation) — it is an EXPLICIT dispatch only (never fires on a blank `tools` run) so a rollback never rides an enable/apply run. The DELETE reverts the *setting* only, not any bump PR GitHub already opened. `applyDependabotSecurityUpdates`'s dry-run preview flags a *stale snapshot* when a finding's `autofixEnabled` said ON but the LIVE read disagrees (the live read always wins the write decision).

`src/council.js` is an agent-council deliberation layer. Five personas (Product, Development, Stability, Maintainability, Security) vote on ideated proposals (`reviewProposals`) and monitor events (`triageEvents`), producing approved / watchlisted / dismissed decisions.

`src/monitor.js` detects new events (PRs opened, issues filed, CI failures) between daily runs and hands them to the council for triage. Scheduled separately via `.github/workflows/monitor.yml`.

`src/onboard.js` opens onboarding PRs (adds `CLAUDE.md`) on any active portfolio repo missing the marker. Runs at the end of the main pipeline when not in dry-run mode.

`src/github.js` is the custom API client used by every module. It provides `request()`, `paginate()`, `getFileContent()`, and `listDir()`. Rate limiting is handled internally with exponential backoff on 429/403. All other modules import `createClient(token)` from here.

`src/observe.js` gathers data via GitHub REST API. It runs ~13 API calls in parallel via `Promise.all`, including community health profile, Dependabot alerts, code scanning alerts, secret scanning alerts, CI pass rate, and computes derived metrics (bus factor, time-to-close median). `observePortfolio()` classifies all repos by activity level. Repo discovery tries `/installation/repositories` (GitHub App token), falling back to `/user/repos` (PAT), then to the public-only `/users/{owner}/repos` and `/orgs/{owner}/repos`. Private repos returned by the privileged endpoints are returned separately as `portfolio.privateRepos` and are never mixed into `portfolio.repos` — see private-repo monitoring below.

## Private-repo monitoring (PRIVATE WATCH)

**repo-butler is itself a public repo, so it has three world-readable sinks, not one:** the GitHub Pages dashboard, the `repo-butler-data` snapshot branch, and the Actions run logs. A private repo name reaching any of them is a permanent disclosure. Treat all three as equally public.

`src/private-watch.js` is a standalone pass (called from `index.js` after `runPhases`, alongside the auto-onboard pass) that reads each private repo's Dependabot / code-scanning / secret-scanning alerts and delivers acute findings — critical or high, plus any secret-scanning hit — to **one tracking issue on that private repo itself** via `src/private-notify.js`. The issue is rewritten in place each run and closed when the repo comes clean. Dry-run by default.

**Private repos deliberately do NOT enter the GOVERNANCE pipeline.** An earlier attempt (PR #347, abandoned) fed `[...portfolio.repos, ...portfolio.privateRepos]` into the governance detectors and tagged the resulting findings `private: true`. An adversarial review found **14 live disclosure paths**, because `context.repoDetails` and `context.governanceFindings` are shared across phases in one process and reach `buildGovernanceSection` → `reports/index.html`, the IDEATE LLM prompt, and PROPOSE's `snapshots/propose-soak.json` — none of which pass through any filter. The decisive lesson: **redaction applied to a shared carrier is a convention, and conventions lose.** Worse, `detectStandardsGaps` emits one finding per standard carrying `nonCompliant`/`compliant` **arrays** of repo names, so a finding "about" a public standard silently contained the private name — per-finding tagging could never have caught it. `src/governance.test.js` has a mutation-verified guard ("private repos must never enter the governance pipeline") that fails if any of the five detector calls is widened to include `privateRepos`.

**Logging rule, and it is hard:** no log line anywhere may contain a private repo name, because Actions logs are public. `private-watch.js` counts and never names, and its alert fetchers deliberately do NOT reuse `observe.js`'s equivalents, whose catch blocks log `${owner}/${repo}` on 403/404. For the API layer, `createClient(token, { redactPaths: true })` rewrites the repo segment to `<redacted>` in the rate-limit retry log and in **all three** throw sites in `github.js` (403-permission, generic `!res.ok`, retries-exhausted), and suppresses the response body — GitHub error bodies echo the requested path back. Redaction is opt-in per client so the 13 public repos keep fully debuggable logs; `private-watch.js` is the only caller that enables it.

**Known limitation, by design:** any per-repo tuning for a private repo (`standards-exclude`, `release_exempt`, `policy-drift-exempt` in `.github/roadmap.yml`) would require writing its name into a file committed to this public repo. That is why private repos get security *watching* only, not full governance — the config surface cannot hold a secret.

The report module is split into five files. `src/report.js` is the entry point that orchestrates the REPORT phase. `src/report-shared.js` has shared constants, `computeHealthTier(r, options)` (supports `releaseExempt` option and the security trifecta: Dependabot + code scanning + secret scanning), and `isReleaseExempt()`. `src/report-portfolio.js` has `fetchPortfolioDetails()`, `generatePortfolioReport()`, and `buildCampaignSection()`. `src/report-repo.js` has `generateRepoReport()` and per-repo chart data fetchers. `src/report-styles.js` has the CSS template.

`src/store.js` persists JSON snapshots to a `repo-butler-data` orphan branch using the Git Data API (blobs → trees → commits → ref updates). Weekly portfolio snapshots are stored for trend analysis (max 12 weeks).

`src/safety.js` is the security boundary for all external inputs and outputs. Output validators: context-aware URL allowlist (core hosts always, docs hosts in roadmap context only), @mention blocking, API key / private key / token detection, XSS prevention, length limits, `sanitizeLabels()` for LLM-suggested issue labels, `redactErrorForLog()` to keep adversary-supplied substrings out of CI logs. Input validators: `sanitizeForPrompt()` strips injection patterns from user-controlled data before LLM ingestion, `detectEcosystem()` requires 2-of-3 signals for repo classification, `REPO_NAME_PATTERN` / `validateGitHubUsername()` gate identifiers interpolated into cross-repo writes. All prompt-building functions (`buildIdeatePrompt`, `buildAssessPrompt`, `buildUpdatePrompt`) wrap external data in `BEGIN/END REPOSITORY DATA` delimiters with a defence preamble. Every phase that writes to GitHub must pass output through these validators — including composed strings (PROPOSE validates the final assembled issue body, not just the LLM's `body` field).

`src/assess.js` diffs snapshots and computes trends. `computeTrends()` produces a direction signal (growing/shrinking/stable) from weekly historical data.

`src/providers/` contains LLM provider implementations (Gemini Flash, Claude Sonnet) with a shared base interface (`async generate(prompt)`). Providers are validated before use with a simple "respond with OK" test.

`src/mcp.js` is a zero-dependency MCP server (JSON-RPC 2.0 over stdio) that exposes portfolio health data to AI agents. Run with `claude mcp add repo-butler node src/mcp.js`. Only starts the readline listener when run directly, not when imported for tests.

`src/agent-card.js` builds an A2A AgentCard for capability discovery. The REPORT phase writes it to `reports/.well-known/agent-card.json` so Pages serves it at `ismaelmartinez.github.io/repo-butler/.well-known/agent-card.json`. Discovery-only — no live A2A transport yet; agents still consume the butler via MCP.

`schemas/v1/` contains JSON Schema 2020-12 definitions for all data structures. `docs/skill.md` is a Claude Code skill teaching AI agents how to work with repo-butler.

## Project conventions

- Zero dependencies. Do not add npm packages. Uses Node 22 built-in fetch, crypto, fs/promises.
- Tests use node:test and node:assert/strict, colocated as *.test.js alongside implementation.
- All LLM output goes through src/safety.js validation before publishing.
- Snapshots persist on the `repo-butler-data` orphan branch via Git Data API.
- Reports deploy to GitHub Pages at ismaelmartinez.github.io/repo-butler/.
- Config lives in `.github/roadmap.yml` with defaults in `src/config.js`. The YAML parser is hand-rolled (no dependency) and handles only flat + one-level-nested keys.

## GitHub API patterns

- Use the list/paginate endpoints (5000 req/hr) instead of the search API (30 req/min secondary limit) wherever possible. The report module's chart data fetchers were specifically refactored away from search for this reason.
- The community profile API does not detect YAML form-based issue templates — always fall back to checking .github/ISSUE_TEMPLATE/ directory contents.
- GitHub's open_issues_count includes PRs. Always filter with `!i.pull_request` when counting actual issues.
- Dependabot alerts require `vulnerability_alerts: read` scope on the token. The default GITHUB_TOKEN lacks this — return null, not zero, when unavailable.
- New API fetchers in observe.js should follow the existing pattern: try/catch, return null on failure, add to the Promise.all in `observe()`.

## Report generation

- Scheduled and dispatch workflows: `self-test.yml` (cron `0 7,11,16,20 * * *`, runs `observe,assess,update,governance,report`, ~13 min), `weekly-ideate.yml` (Mondays 06:00 UTC, runs `observe,ideate,propose` dry-run — council deliberation plus the G10 cross-repo PROPOSE soak; dry-run means PROPOSE files no issues — its only writes are the idempotent host-label ensure and an append of each run's routing records to the rolling `snapshots/propose-soak.json` ledger on the data branch, max 26 entries; reads governance findings refreshed by the daily pipeline), `monitor.yml` (every 6h, runs the monitor phase), `apply.yml` (manual-dispatch governance remediation, dry-run by default, max 5 PRs/run), `onboard.yml` (workflow_dispatch + GitHub App webhook on installation). Trigger the main one manually with `gh workflow run "Repo Butler" --ref main`.
- Report caching uses a SHA-256 hash of the snapshot summary. Adding new fields to the summary object will trigger regeneration.
- Per-repo reports get a full dashboard (charts, health section) for repos with 10+ commits, or a lightweight card for quieter ones. Both render paths surface the Dependabot autofix tri-state (ADR-012 Phase 3: in flight / not driven / unknown) via `dependabotAutofixState()` in `report-repo.js` — the full dashboard shows it as a small line under the Health Tier badge (`buildDependabotAutofixLine`, not a criteria-table row, since autofix never changes the tier per ADR-012), and the lightweight card shows it as a `buildDependabotAutofixCard` stat card. Both read `summary.automated_security_fixes_active` (full path, via `buildRepoSnapshot`) or derive it inline from `details.autofix` (lightweight path), matching the portfolio governance column's autofix cell (`report-portfolio.js buildGovernanceSection`).
- The portfolio dashboard also surfaces the not-driven autofix signal at the top level, not just per-row: `buildAutofixNudge()` (`report-portfolio.js`) renders a quiet callout near `buildCriticalBanner` counting dependabot-sourced `open-vulnerability` findings with `autofixEnabled === false`, and renders nothing when that count is 0 (calm-by-design, matching `buildSinceLastSection`). The filter predicate (`isAutofixNotDriven`, `report-shared.js`) is the single source of truth shared with the MCP `get_governance_findings` summary's `autofixNotDriven` count (`mcp.js`), so the two never drift. Presentation only — governance.js detection stays pure and `computeHealthTier` is untouched (ADR-012).
- The autofix nudge also carries a week-over-week trend badge (▲/▼ + delta), the same presentation-only extension of ADR-012 Phase 3. Governance findings aren't part of the portfolio-weekly snapshot `buildSinceLastSection` diffs against, so there's a parallel history stream just for them: `store.writeGovernanceWeekly()`/`readLatestGovernanceWeekly()` mirror `writePortfolioWeekly`/`readLatestPortfolioWeekly`'s `isoWeekKey`-bucketed-and-pruned pattern, but write to `snapshots/governance-weekly/` (separate from `snapshots/governance.json`, which always holds only the single latest run's findings with no history to diff). `runGovernance` (`governance.js`) reads the prior weekly snapshot *before* writing this run's — same read-before-write ordering as `readLatestPortfolioWeekly` in `report.js` — reduces it with the pure, independently-testable `priorAutofixNotDrivenCount()` helper, and stashes the result on `context.priorAutofixNotDrivenCount` for the REPORT phase to read later in the same pipeline run (the same same-process `context` threading `context.governanceFindings` already relies on — a standalone `report`-only dispatch simply sees `null` and renders no trend badge). `buildAutofixNudge(findings, priorCount)` renders the badge; because a *rising* not-driven count is a regression (unlike the Gold-tier trend, where up is progress), the arrow direction is literal but the `status-trend up`/`down` CSS class is inverted — fewer not-driven repos gets the green "up" class.
- The per-repo `repoSnapshot` in report.js is assembled inline — when adding new observation data, remember to populate it both in observe.js (for the OBSERVE→REPORT pipeline) and in the inline repoSnapshot construction in report.js (for the portfolio→per-repo path).
- **Cache-refresh convention**: a repo-settings toggle that can flip without a push or an open-issue-count change (Dependabot autofix, the Copilot review ruleset) can't be tied to `fetchPortfolioDetails`'s cache key (`pushed_at` + `open_issues_count`), so a schema-version bump alone would only recompute it once and then let it go stale again on every subsequent cache hit. Instead, such fields get a live read on *every* cache hit: the cache-hit branch in `fetchPortfolioDetails` (`report-portfolio.js`) re-fetches just that field (`getAutomatedSecurityFixesState`, `hasActiveCopilotReviewRuleset`) and merges it into a *copy* of the cached details (`{ ...cached.details, autofix, hasCopilotReview }`) — the cache object itself is never mutated. When adding a new settings-toggle field that governance/reporting depends on, follow this pattern rather than bumping `REPO_CACHE_SCHEMA_VERSION`.

## MCP server

`src/mcp.js` is a zero-dependency MCP server over stdio. It reads data from the `repo-butler-data` branch via `git show`. The readline listener only starts when run directly (`node src/mcp.js`), not when imported for testing. Tools: `get_health_tier`, `get_campaign_status`, `query_portfolio`, `get_snapshot_diff`, `get_governance_findings`, `trigger_refresh`, `get_monitor_events`, `get_watchlist`, `get_council_personas`. The `trigger_refresh` tool uses `gh` CLI to dispatch the workflow. Campaign definitions live in `CAMPAIGN_DEFS` (`src/report-shared.js`); both the MCP `get_campaign_status` tool and the portfolio dashboard's `buildCampaignSection()` map over the same array, so adding a new campaign in one place picks up in both.

## Further reading

- `docs/architecture.md` — visual pipeline diagram + data flow
- `SECURITY.md` — trust model and reporting
- `docs/decisions/` — ADRs
