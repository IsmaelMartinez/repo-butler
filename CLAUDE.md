# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                           # Run all tests (node --test src/**/*.test.js)
node --test src/observe.test.js    # Run a single test file
npm start                          # Run full pipeline (all phases)
npm run observe                    # Run observe phase only
npm run report                     # Run report phase only
INPUT_DRY_RUN=true npm start       # Dry run (no writes to GitHub)
```

The CI workflow also runs a secret-leak lint check that greps source files for hardcoded API keys (sk-, AIza, ghp_, ghs_). This excludes safety.js and *.test.js.

## Code review before merging

Never merge a PR before AI code review bots (CodeRabbit, Gemini Code Assist) have completed their review. Wait up to 20 minutes for reviews to finish. After the review completes, address every inline comment before merging — either apply the fix, explain why not, and reply to each comment individually via the GitHub API. Use the /address-pr-comments skill for this workflow.

## Architecture

This is a GitHub Action (runs on the `node24` runtime, ES modules, zero npm dependencies) that runs a six-phase pipeline plus a continuous monitor:

```
OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE → REPORT   (+ MONITOR)
```

`src/index.js` is a thin dispatcher: it parses the requested phase(s) from `--phase=` arg or `INPUT_PHASE` env var, builds the shared `context` object, validates the LLM provider, then loops over the selected phases calling the matching `runX(context)` wrapper. Each phase module exports both its core function (e.g. `observe`, `assess`, `update`, …) and a `runX` wrapper that handles surrounding orchestration — snapshot persistence, triage-bot ingestion, governance detection, council deliberation, and storing results back on `context` for downstream phases. Index keeps only the truly cross-cutting concerns: provider wiring, the auto-onboard pass, and the GITHUB_OUTPUT summary. The `all` phase runs the wrappers sequentially. `monitor` is a separate phase that detects new events between scheduled runs and feeds them into the council.

`src/governance.js` runs after OBSERVE (when portfolio data is available) and produces three finding types — standards gaps, policy drift, and tier-uplift proposals — which are fed into the IDEATE prompt and persisted to the data branch for the MCP `get_governance_findings` tool.

`src/council.js` is an agent-council deliberation layer. Five personas (Product, Development, Stability, Maintainability, Security) vote on ideated proposals (`reviewProposals`) and monitor events (`triageEvents`), producing approved / watchlisted / dismissed decisions.

`src/monitor.js` detects new events (PRs opened, issues filed, CI failures) between daily runs and hands them to the council for triage. Scheduled separately via `.github/workflows/monitor.yml`.

`src/onboard.js` opens onboarding PRs (adds `CLAUDE.md`) on any active portfolio repo missing the marker. Runs at the end of the main pipeline when not in dry-run mode.

`src/github.js` is the custom API client used by every module. It provides `request()`, `paginate()`, `getFileContent()`, and `listDir()`. Rate limiting is handled internally with exponential backoff on 429/403. All other modules import `createClient(token)` from here.

`src/observe.js` gathers data via GitHub REST API. It runs ~13 API calls in parallel via `Promise.all`, including community health profile, Dependabot alerts, code scanning alerts, secret scanning alerts, CI pass rate, and computes derived metrics (bus factor, time-to-close median). `observePortfolio()` classifies all repos by activity level. Repo discovery tries `/installation/repositories` (GitHub App token), falling back to `/user/repos` (PAT), then to the public-only `/users/{owner}/repos` and `/orgs/{owner}/repos`. Private repos returned by the privileged endpoints are intentionally filtered out before classification — reports deploy to a public GitHub Pages site, so surfacing private repo names/metadata would be an information leak.

The report module is split into five files. `src/report.js` is the entry point that orchestrates the REPORT phase. `src/report-shared.js` has shared constants, `computeHealthTier(r, options)` (supports `releaseExempt` option and the security trifecta: Dependabot + code scanning + secret scanning), and `isReleaseExempt()`. `src/report-portfolio.js` has `fetchPortfolioDetails()`, `generatePortfolioReport()`, and `buildCampaignSection()`. `src/report-repo.js` has `generateRepoReport()` and per-repo chart data fetchers. `src/report-styles.js` has the CSS template.

`src/store.js` persists JSON snapshots to a `repo-butler-data` orphan branch using the Git Data API (blobs → trees → commits → ref updates). Weekly portfolio snapshots are stored for trend analysis (max 12 weeks).

`src/safety.js` is the security boundary for all external inputs and outputs. Output validators: context-aware URL allowlist (core hosts always, docs hosts in roadmap context only), @mention blocking, API key detection, XSS prevention, length limits. Input validators: `sanitizeForPrompt()` strips injection patterns from user-controlled data before LLM ingestion, `validateBotUrl()` prevents SSRF via host allowlist (requires `TRIAGE_BOT_ALLOWED_HOSTS` for butler.json URLs), `validateTriageBotTrends()` validates triage bot response shape before prompt injection, `detectEcosystem()` requires 2-of-3 signals for repo classification. All prompt-building functions (`buildIdeatePrompt`, `buildAssessPrompt`, `buildUpdatePrompt`) wrap external data in `BEGIN/END REPOSITORY DATA` delimiters with a defence preamble. Every phase that writes to GitHub must pass output through these validators.

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

- Three scheduled workflows: `self-test.yml` (daily 02:00 UTC, runs `observe,assess,update,report`, ~13 min), `weekly-ideate.yml` (Mondays 06:00 UTC, runs `observe,ideate` dry-run for council + governance findings), `monitor.yml` (every 6h, runs the monitor phase). Trigger the main one manually with `gh workflow run "Repo Butler" --ref main`.
- Report caching uses a SHA-256 hash of the snapshot summary. Adding new fields to the summary object will trigger regeneration.
- Per-repo reports get a full dashboard (charts, health section) for repos with 10+ commits, or a lightweight card for quieter ones.
- The per-repo `repoSnapshot` in report.js is assembled inline — when adding new observation data, remember to populate it both in observe.js (for the OBSERVE→REPORT pipeline) and in the inline repoSnapshot construction in report.js (for the portfolio→per-repo path).

## MCP server

`src/mcp.js` is a zero-dependency MCP server over stdio. It reads data from the `repo-butler-data` branch via `git show`. The readline listener only starts when run directly (`node src/mcp.js`), not when imported for testing. Tools: `get_health_tier`, `get_campaign_status`, `query_portfolio`, `get_snapshot_diff`, `get_governance_findings`, `trigger_refresh`, `get_monitor_events`, `get_watchlist`, `get_council_personas`. The `trigger_refresh` tool uses `gh` CLI to dispatch the workflow. Campaign definitions live in `CAMPAIGN_DEFS` (`src/report-shared.js`); both the MCP `get_campaign_status` tool and the portfolio dashboard's `buildCampaignSection()` map over the same array, so adding a new campaign in one place picks up in both.
