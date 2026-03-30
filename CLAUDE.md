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

This is a GitHub Action (Node 22, ES modules, zero npm dependencies) that runs a six-phase pipeline:

```
OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE → REPORT
```

`src/index.js` routes phases via `--phase=` arg or `INPUT_PHASE` env var. Each phase is an independent module that receives a shared `context` object and returns results that feed into subsequent phases. The `all` phase runs them sequentially.

`src/github.js` is the custom API client used by every module. It provides `request()`, `paginate()`, `getFileContent()`, and `listDir()`. Rate limiting is handled internally with exponential backoff on 429/403. All other modules import `createClient(token)` from here.

`src/observe.js` gathers data via GitHub REST API. It runs ~11 API calls in parallel via `Promise.all`, including community health profile, Dependabot alerts, CI pass rate, and computes derived metrics (bus factor, time-to-close median). `observePortfolio()` classifies all repos by activity level.

The report module is split into five files. `src/report.js` is the entry point that orchestrates the REPORT phase. `src/report-shared.js` has shared constants and `computeHealthTier()`. `src/report-portfolio.js` has `fetchPortfolioDetails()`, `generatePortfolioReport()`, and `buildCampaignSection()`. `src/report-repo.js` has `generateRepoReport()` and per-repo chart data fetchers. `src/report-styles.js` has the CSS template.

`src/store.js` persists JSON snapshots to a `repo-butler-data` orphan branch using the Git Data API (blobs → trees → commits → ref updates). Weekly portfolio snapshots are stored for trend analysis (max 12 weeks).

`src/safety.js` is the security boundary for all external inputs and outputs. Output validators: context-aware URL allowlist (core hosts always, docs hosts in roadmap context only), @mention blocking, API key detection, XSS prevention, length limits. Input validators: `sanitizeForPrompt()` strips injection patterns from user-controlled data before LLM ingestion, `validateBotUrl()` prevents SSRF via host allowlist (requires `TRIAGE_BOT_ALLOWED_HOSTS` for butler.json URLs), `validateTriageBotTrends()` validates triage bot response shape before prompt injection, `detectEcosystem()` requires 2-of-3 signals for repo classification. All prompt-building functions (`buildIdeatePrompt`, `buildAssessPrompt`, `buildUpdatePrompt`) wrap external data in `BEGIN/END REPOSITORY DATA` delimiters with a defence preamble. Every phase that writes to GitHub must pass output through these validators.

`src/assess.js` diffs snapshots and computes trends. `computeTrends()` produces a direction signal (growing/shrinking/stable) from weekly historical data.

`src/providers/` contains LLM provider implementations (Gemini Flash, Claude Sonnet) with a shared base interface (`async generate(prompt)`). Providers are validated before use with a simple "respond with OK" test.

`src/mcp.js` is a zero-dependency MCP server (JSON-RPC 2.0 over stdio) that exposes portfolio health data to AI agents. Run with `claude mcp add repo-butler node src/mcp.js`. Only starts the readline listener when run directly, not when imported for tests.

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

- The workflow runs daily at 2am UTC and takes ~13 minutes. Trigger manually with `gh workflow run "Repo Butler" --ref main`.
- Report caching uses a SHA-256 hash of the snapshot summary. Adding new fields to the summary object will trigger regeneration.
- Per-repo reports get a full dashboard (charts, health section) for repos with 10+ commits, or a lightweight card for quieter ones.
- The per-repo `repoSnapshot` in report.js is assembled inline — when adding new observation data, remember to populate it both in observe.js (for the OBSERVE→REPORT pipeline) and in the inline repoSnapshot construction in report.js (for the portfolio→per-repo path).

## MCP server

`src/mcp.js` is a zero-dependency MCP server over stdio. It reads data from the `repo-butler-data` branch via `git show`. The readline listener only starts when run directly (`node src/mcp.js`), not when imported for testing. Tools use `computeHealthTier()` from `report-shared.js`. Campaign logic mirrors `buildCampaignSection()` in `report-portfolio.js` — keep them aligned when adding new campaigns.
