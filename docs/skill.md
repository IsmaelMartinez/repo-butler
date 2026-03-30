# Skill: repo-butler

## What it is

Repo Butler is a zero-dependency GitHub Action (Node 22, ES modules) that runs a six-phase pipeline against a GitHub repository. It observes project health via REST API, generates LLM-assisted assessments, rewrites a living roadmap, proposes GitHub issues, and deploys HTML dashboards to GitHub Pages. Its unique value is the portfolio-wide cross-repo view: it sees which tools are configured where, which repos are out of alignment, and can propose governance corrections across an entire org.

Live reports: `https://ismaelmartinez.github.io/repo-butler/`
Data branch: `repo-butler-data` (orphan branch, JSON snapshots)
Config repo: `IsmaelMartinez/repo-butler`

---

## Six-Phase Pipeline

Entry point: `src/index.js`. Phase selected via `INPUT_PHASE` env var or `--phase=` CLI arg. Default is `all`.

`OBSERVE` — Calls ~11 GitHub REST endpoints in parallel (`Promise.all`). Produces a `snapshot` object and a `portfolio` classification of all owner repos. No LLM. Optionally POSTs to triage bot `/ingest`.

`ASSESS` — Diffs current snapshot against previous (from `repo-butler-data` branch). Computes `computeTrends()` direction (`growing`/`shrinking`/`stable`) from up to 12 weekly snapshots. Optionally reads triage bot `/report/trends`. Uses default LLM provider (Gemini Flash).

`UPDATE` — Rewrites `ROADMAP.md` and opens a PR. All LLM-generated content passes through `src/safety.js` validators before publication.

`IDEATE` — Generates improvement proposals. Uses deep LLM provider (Claude Sonnet if configured, else falls back to default). Input is snapshot + portfolio context + triage bot intelligence. Output: structured specs with `current_state`, `proposed_state`, `affected_files`, `scope`, `signal_rationale`.

`PROPOSE` — Creates GitHub issues from IDEATE output. Applies Jaccard similarity duplicate detection (threshold 0.6, title word comparison normalized to lowercase). Capped at `config.limits.max_issues_per_run` (default 3). Labels: `roadmap-proposal`, `agent-generated`.

`REPORT` — Generates per-repo HTML dashboards and a portfolio landing page. Deploys to GitHub Pages. Caches by SHA-256 hash of `snapshot.summary`. Full chart dashboard for repos with 10+ commits; lightweight card for quieter repos. Source: `src/report.js`.

---

## Snapshot Data Model

The `snapshot` object returned by `observe()` in `src/observe.js`:

```js
{
  timestamp: ISO string,
  repository: "owner/repo",
  meta: {
    description, language, stars, forks, watchers,
    open_issues_count, default_branch, license,  // license is SPDX ID string
    topics, created_at, pushed_at, archived
  },
  issues: {
    open: [{ number, title, author, labels, reactions, comments, created_at, updated_at, assignees, milestone }],
    recently_closed: [{ number, title, author, labels, closed_at, created_at }]
  },
  pull_requests: {
    recently_merged: [{ number, title, author, labels, merged_at }]
  },
  labels: [{ name, description, color }],
  milestones: [{ title, state, open_issues, closed_issues, due_on }],
  releases: [{ tag, name, published_at, prerelease, draft }],
  workflows: [{ name, path, state }],
  roadmap: { path, content } | null,
  package: { version, dependencies: string[], devDependencies: string[] } | null,
  community_profile: {
    health_percentage: number,
    files: { readme, license, contributing, code_of_conduct, issue_template, pull_request_template }
    // all boolean fields
  } | null,
  dependabot_alerts: {
    count, critical, high, medium, low, max_severity: string | null
  } | null,  // null means token lacks vulnerability_alerts:read scope
  ci_pass_rate: { pass_rate: 0-1 | null, total_runs, passed, failed },
  summary: { /* see below */ }
}
```

`snapshot.summary` is the key derived object used for caching, reporting, and LLM prompts:

```js
summary: {
  repo: "N stars, M forks",
  open_issues: number,
  blocked_issues: number,
  awaiting_feedback: number,
  recently_closed: number,
  recently_merged_prs: number,
  bot_prs: number,
  human_prs: number,
  unique_contributors: number,
  releases: number,
  latest_release: "tag" | "none",
  top_open_labels: string[],
  high_reaction_issues: string[],
  stale_awaiting_feedback: string[],
  community_health: number | null,
  dependabot_alert_count: number | null,
  dependabot_max_severity: string | null,
  ci_pass_rate: 0-1 | null,
  bus_factor: number | null,
  time_to_close_median: { median_days, sample_size } | null
}
```

### Portfolio observation

`observePortfolio()` returns:

```js
{
  timestamp, owner,
  repos: [{ name, description, language, stars, forks, open_issues, pushed_at, archived, fork, license, has_issues, default_branch, topics }],
  classification: {
    active: string[],           // pushed < 6 months ago, not fork/archived
    maintained: string[],       // 6-12 months
    dormant: string[],          // 1-2 years
    archive_candidates: string[], // 2+ years
    forks: string[],
    archived: string[]
  }
}
```

---

## Health Tier System

Source: `computeHealthTier(r)` exported from `src/report-shared.js`.

Input object `r` uses camelCase fields assembled by `fetchPortfolioDetails()` (see field mapping below). Tiers are `'gold'`, `'silver'`, `'bronze'`, or `'none'`, evaluated top-down:

**Gold** — all silver checks pass AND all gold checks pass:
- `ci >= 2` (2+ CI workflows)
- `open_issues < 10`
- `released_at` within 90 days
- `communityHealth >= 80`
- `vulns != null` (Dependabot/Renovate configured)
- `vulns.max_severity` is not `'critical'` or `'high'`

**Silver** — all silver checks pass (gold may fail):
- `license` is truthy and not `'None'`
- `ci >= 1`
- `communityHealth >= 50`
- `pushed_at` within 180 days

**Bronze** — at least one bronze check passes (silver fails):
- `commits > 0` OR `pushed_at` within 365 days

**None** — none of the above.

Return value: `{ tier: 'gold'|'silver'|'bronze'|'none', checks: [{ name, passed, required_for }] }`.

---

## Field Mapping: snapshot → enriched portfolio object

`fetchPortfolioDetails()` in `src/report-portfolio.js` fetches additional data per repo and returns a `details` map keyed by repo name. The field names differ from the snapshot. `contributors` is added after `fetchPortfolioDetails()` returns, during the per-repo loop in `src/report.js`.

| Field on enriched object | Type | Source |
|---|---|---|
| `commits` | number | search/commits count (last 180 days) |
| `weekly` | number[] | `/stats/participation` owner slice (last 26 weeks) |
| `license` | string (SPDX) | repo metadata `.license.spdx_id` |
| `ci` | number | `/actions/workflows` `.total_count` |
| `communityHealth` | number\|null | `community_profile.health_percentage` (maps from snake_case) |
| `vulns` | `{ count, max_severity }`\|null | `/dependabot/alerts` (null if inaccessible) |
| `ciPassRate` | 0-1\|null | `/actions/runs` success ratio (maps from `ci_pass_rate.pass_rate`) |
| `open_issues` | number | paginated issues filtered `!pull_request` |
| `sbom` | `{ count, packages[] }`\|null | `/dependency-graph/sbom` |
| `released_at` | ISO string\|null | latest release `.published_at` |
| `hasIssueTemplate` | boolean | community profile + `.github/ISSUE_TEMPLATE/` fallback |
| `libyear` | number\|null | computed from `sbom.packages` against npm registry |
| `contributors` | number | unique human PR authors (last 90 days) |

`computeHealthTier(r)` reads `pushed_at` from the portfolio repo object (not from `details`), so callers must merge: `{ ...portfolioRepo, ...details[repoName] }`.

---

## Safety Validators

Source: `src/safety.js`. Every phase that writes to GitHub must pass LLM output through these before publishing. All return `{ valid: boolean, errors: string[] }`.

`validateIssueTitle(title)` — checks non-empty string, max 120 chars, no newlines, no blocked patterns (API keys, script injection).

`validateIssueBody(body)` — checks non-empty string, max 8000 chars, URL allowlist (`github.com`, `ismaelmartinez.github.io`), no `@mentions` (except `@repo-butler`, `@dependabot`, `@github-actions`), no blocked patterns.

`validateRoadmap(content)` — checks non-empty string, max 50000 chars, min 100 chars, must contain `#` (markdown heading), URL allowlist, no blocked patterns.

`validateIdeas(ideas)` — validates an array of idea objects; each idea runs `validateIssueTitle` + `validateIssueBody` + priority check (`'high'|'medium'|'low'`). Returns `{ valid, errors, filtered }` where `filtered` contains only ideas that passed.

`validateProvider(provider)` — async; sends `"Respond with exactly the word OK"` to the LLM and checks the response starts with `OK`. Used before running the full pipeline.

---

## Store Interface

Source: `src/store.js`. `createStore(context)` returns:

`readSnapshot()` / `readPreviousSnapshot()` — reads `snapshots/latest.json` or `snapshots/previous.json` from the `repo-butler-data` branch. Returns parsed JSON or null.

`writeSnapshot(snapshot)` — writes to `latest.json`, moves current to `previous.json`, and writes a weekly snapshot at `snapshots/weekly/YYYY-WNN.json`. Prunes old weekly files to keep max 12.

`readWeeklyHistory(weeks?)` — reads up to `weeks` (default 12) weekly snapshots sorted by ISO week key. Returns an array of full snapshot objects, each with `_week: "YYYY-WNN"` added. Nulls are filtered out. Weekly files are sorted alphabetically (ISO week strings sort chronologically), so the array is oldest-first.

`writePortfolioWeekly(portfolio, repoDetails)` / `readRepoWeeklyHistory(repoName, weeks?)` — lightweight per-repo trend data stored in `snapshots/portfolio-weekly/`. Each file is a map of `repoName → { open_issues, commits_6mo, stars }`. Same 12-week cap applies.

`readLastHash()` / `writeHash(hash)` — reads/writes `snapshots/hash.txt` for REPORT phase cache invalidation. Hash is SHA-256 of `snapshot.summary`.

---

## Config Format

File: `.github/roadmap.yml`. Loaded by `src/config.js:loadConfig()`. YAML parser is hand-rolled — supports flat keys and one level of nesting only. Defaults in `src/config.js` `DEFAULTS` object. Key fields:

```yaml
providers:
  default: gemini       # LLM for ASSESS/UPDATE (gemini | claude)
  deep: claude          # LLM for IDEATE (falls back to default)

limits:
  max_issues_per_run: 3
  require_approval: true

observe:
  issues_closed_days: 90
  prs_merged_days: 90
```

---

## How to Run

```bash
export GITHUB_TOKEN=ghp_...
export GEMINI_API_KEY=...      # for assess/update/ideate
export CLAUDE_API_KEY=...      # optional, for deep ideate

npm start                      # all phases
INPUT_DRY_RUN=true npm start   # no writes to GitHub
INPUT_PHASE=observe npm start  # single phase
```

As a GitHub Action:

```yaml
- uses: IsmaelMartinez/repo-butler@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
    phase: all
    dry-run: false
```

---

## Portfolio Governance Model

Source: `docs/decisions/002-portfolio-governance-boundary.md`

Proposals are categorized as standards propagation (tool in some repos but not all), policy drift detection (repos that diverged from a template), compliance campaigns (new requirement across portfolio), or health tier uplift (concrete steps to reach the next tier). Without an explicit `standards:` section in config, butler infers conservatively — only proposes universal tools (community health files, branch protection, Dependabot for Actions) based on majority adoption. Never auto-infers ecosystem-specific tooling. Archived repos are excluded.

---

## Decision Framework: repo-butler vs triage bot

Source: `docs/decisions/001-repo-butler-vs-triage-bot.md`

Use repo-butler for cross-repo portfolio questions: "Which repos are missing Dependabot?", "Which repos are below Silver tier?", "Create a campaign to propagate CONTRIBUTING.md to all repos."

Use the triage bot for deep per-repo intelligence: "Is issue #47 a duplicate of #12?", "Summarize the ADR history.", "What issues are waiting longest for a response?"

The boundary is: triage bot goes deep on one repo (webhook-driven, vector search, real-time). Repo-butler goes broad across the portfolio (REST API, daily cron, zero infrastructure). Data flows both ways: repo-butler OBSERVE POSTs to `{bot_url}/ingest`; triage bot `/report/trends` feeds into repo-butler ASSESS/IDEATE.

---

## Key Files

- `src/index.js` — phase routing, context assembly, output
- `src/observe.js` — snapshot shape, `buildSummary()`, `classifyRepos()`, `computeBusFactor()`, `computeTimeToCloseMedian()`
- `src/report-shared.js` — `computeHealthTier()`, constants, shared helpers
- `src/report-portfolio.js` — `fetchPortfolioDetails()`, `buildCampaignSection()`, `generatePortfolioReport()`
- `src/report-repo.js` — `generateRepoReport()`, per-repo chart data fetchers
- `src/report.js` — entry point, orchestrates portfolio and per-repo report generation
- `src/assess.js` — `computeTrends()`, snapshot diffing
- `src/store.js` — `createStore()`, `readSnapshot()`, `writeSnapshot()`, `readWeeklyHistory()`, `writePortfolioWeekly()`
- `src/safety.js` — `validateIssueTitle()`, `validateIssueBody()`, `validateRoadmap()`, `validateIdeas()`, `validateProvider()`
- `src/config.js` — `loadConfig()`, `DEFAULTS`
- `src/github.js` — `createClient()`, `request()`, `paginate()`, `getFileContent()`, `listDir()`
- `src/triage-bot.js` — `createTriageBotClient()`, auto-discovery via `.github/butler.json`
- `src/providers/gemini.js`, `src/providers/claude.js` — LLM providers, interface: `async generate(prompt)`
- `schemas/v1/` — JSON Schema definitions for all data structures (snapshot, portfolio, config, health tiers)
- `docs/decisions/001-repo-butler-vs-triage-bot.md` — system boundary ADR
- `docs/decisions/002-portfolio-governance-boundary.md` — governance model ADR
- `docs/decisions/003-interoperability-layer.md` — interoperability standards and phasing ADR
