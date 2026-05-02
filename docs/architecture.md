# Architecture

This document maps the moving parts of Repo Butler: the seven-phase core pipeline, the four scheduled workflows that run it, two on-demand workflows for cross-repo operations, the data branch that persists everything, and the AI-agent surface (MCP + A2A) that consumes it.

## The seven-phase pipeline

```
OBSERVE → ASSESS → UPDATE → GOVERNANCE → IDEATE → PROPOSE → REPORT   (+ MONITOR)
```

`src/index.js` is a thin dispatcher: it parses the requested phase(s) from `--phase=` or `INPUT_PHASE`, builds a shared `context` object, validates the LLM provider, then loops over the selected phases calling each module's `runX(context)` wrapper. Each phase reads from and writes to `context` so downstream phases see upstream state.

OBSERVE gathers project state via the GitHub API and classifies portfolio repos by activity. ASSESS diffs snapshots and computes weekly trends. UPDATE generates an updated roadmap document and opens a PR. GOVERNANCE runs deterministic detectors over the portfolio (no LLM cost) and persists findings. IDEATE generates improvement ideas using an LLM, feeding off the fresh governance findings, then runs the agent council for multi-perspective deliberation. PROPOSE safety-filters the approved ideas and opens GitHub issues. REPORT generates HTML dashboards and the A2A AgentCard for GitHub Pages. MONITOR is a parallel phase that detects events between scheduled runs.

## Workflow choreography

Four scheduled workflows and two on-demand workflows interleave to keep the portfolio observed, governed, and remediated.

```
                          REPO BUTLER PIPELINES
                          =====================

  ┌─────────────────────────────────────────────────────────────────┐
  │                    DAILY PIPELINE  (self-test.yml)              │
  │                    cron: 07,11,16,20 UTC + push                 │
  │                                                                 │
  │  OBSERVE → ASSESS → UPDATE → GOVERNANCE → REPORT → (Pages)      │
  │     │        │        │          │           │                  │
  │     ▼        ▼        ▼          ▼           ▼                  │
  │  snapshot  trends  roadmap   findings    HTML +                 │
  │  (data br) diff    PR        (data br)   agent-card             │
  │                                                                 │
  │  Then: AUTO-ONBOARD → opens CLAUDE.md PRs on missing repos      │
  └─────────────────────────────────────────────────────────────────┘
                                  │
                                  │  governance.json (4×/day)
                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                  WEEKLY IDEATE  (weekly-ideate.yml)             │
  │                  cron: Mon 06:00 UTC                            │
  │                                                                 │
  │  OBSERVE → IDEATE ─→ runGovernance (idempotent — uses fresh    │
  │              │         findings from the daily run)             │
  │              ▼                                                  │
  │           COUNCIL  (Product / Dev / Stability /                │
  │              │      Maintainability / Security)                 │
  │              ▼                                                  │
  │          approved / watchlisted / dismissed → PROPOSE           │
  │              │                                                  │
  │              ▼                                                  │
  │          GitHub issues (capped at max_issues_per_run)           │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │                    MONITOR  (monitor.yml)                       │
  │                    cron: every 6h                               │
  │                                                                 │
  │  Detect events between daily runs (PRs, issues, CI failures)    │
  │     │                                                           │
  │     ▼                                                           │
  │  COUNCIL triage → monitor-events.json (data br) → MCP tool      │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │              GOVERNANCE APPLY  (apply.yml)                      │
  │              workflow_dispatch only — never on cron             │
  │                                                                 │
  │  read governance.json → filter actionable (TEMPLATES) →         │
  │     batch (3/run, max 5 PRs) → open PRs on target repos         │
  │                                                                 │
  │  Templates: code-scanning (CodeQL), dependabot                  │
  │  Branches:  repo-butler/apply-{tool} on each target             │
  │  Labels:    governance-apply (added via separate API call)      │
  └─────────────────────────────────────────────────────────────────┘
```

The split between the daily and weekly cadence matters for cost. Governance detection is pure deterministic JS — no LLM calls — so the daily pipeline runs it 4×/day and `governance.json` always reflects the current portfolio state. The expensive LLM work (IDEATE prompt + five-persona council deliberation) only fires once a week. When the weekly run executes, `runIdeate` calls `runGovernance` which is idempotent: if findings are already present in context (or written to the data branch the same morning), detection is skipped and the council reads the fresh findings the daily pipeline produced.

The supporting workflows are simpler. `ci.yml` runs on push and PR — `npm test` plus a secret-leak grep. `codeql.yml` is the standard GitHub CodeQL workflow. `dependabot-auto-merge.yml` watches Dependabot PRs and auto-merges non-major bumps once CI is green. `onboard.yml` opens onboarding PRs (adding the `repo-butler` consumer guide section to `CLAUDE.md`) on any repo that lacks it; it runs on workflow dispatch and via the GitHub App installation webhook.

## Data flow

All persistent state lives on the `repo-butler-data` orphan branch, written via the Git Data API (blobs → trees → commits → ref updates). Reports deploy to GitHub Pages from the same workflow run.

```
repo-butler-data branch:
  snapshots/
    latest.json               ← OBSERVE writes (current snapshot)
    weekly/YYYY-Www.json      ← ASSESS appends (12-week rolling cap)
    portfolio-weekly/…json    ← OBSERVE writes (per-week portfolio shape)
    governance.json           ← GOVERNANCE writes (4×/day, can be empty array)
    monitor-cursor.json       ← MONITOR writes (last-seen event marker)
    monitor-events.json       ← MONITOR writes (council triage output)
    repo-cache.json           ← OBSERVE/REPORT cache (per-repo enrichment)
    hash.json                 ← REPORT cache key (snapshot summary SHA-256)
  reports/                    ← REPORT writes, deployed to GitHub Pages
    index.html                ← portfolio dashboard
    {repo}.html               ← per-repo dashboards
    .well-known/
      agent-card.json         ← A2A AgentCard for capability discovery
```

Cache invalidation matters. The report cache key is a SHA-256 of the snapshot summary — adding a new field to the summary triggers regeneration on the next run. Per-repo enrichment (`repo-cache.json`) is keyed on `pushed_at` + `open_issues_count`, so commits or new issues bust the cache. The Dependabot audit deliberately bypasses this cache because PR age advances without changing `pushed_at`.

## AI-agent surface

Two interfaces let external AI agents work with the butler.

```
┌──────────────────────────────────────────────────────────┐
│ MCP server (src/mcp.js) — JSON-RPC over stdio            │
│   tools: get_health_tier, get_campaign_status,           │
│          query_portfolio, get_snapshot_diff,             │
│          get_governance_findings, trigger_refresh,       │
│          get_monitor_events, get_watchlist,              │
│          get_council_personas                            │
│   reads from: repo-butler-data branch via `git show`     │
│                                                          │
│ A2A AgentCard — discovery only, no live transport        │
│   ismaelmartinez.github.io/repo-butler/.well-known/…     │
└──────────────────────────────────────────────────────────┘
```

The MCP server is zero-dependency, runs over stdio, and reads the data branch via `git show` — no live GitHub API calls when agents query. `trigger_refresh` is the one tool that mutates state, dispatching the workflow via the `gh` CLI. The A2A AgentCard is discovery-only: agents read it to learn what the butler can do, but the live programmatic interface is the MCP server.

## Module boundaries

`src/index.js` only handles cross-cutting concerns: provider wiring, the auto-onboard pass at the end of the daily run, and the `GITHUB_OUTPUT` summary. Each phase module owns its core function plus a `runX` wrapper that handles surrounding orchestration — snapshot persistence, triage-bot ingestion, governance detection, council deliberation. Adding a new phase means writing the module, exporting `runX`, and registering it in `PHASE_RUNNERS` and `PHASES` in `index.js`.

`src/safety.js` is the only file allowed to interpolate untrusted data into LLM prompts or GitHub-bound output. All other modules MUST route external data through it. New API fetchers go in `observe.js` following the existing try/catch + return-null pattern; new templates for `Governance Apply` go in the `TEMPLATES` map in `apply.js`; new MCP tools go in `mcp.js` alongside their data-branch read.

The custom GitHub client in `src/github.js` (`createClient(token)`) is used by every module that talks to GitHub — never construct your own `fetch` calls. It handles rate limiting with exponential backoff on 429/403 and provides `request()`, `paginate()`, `getFileContent()`, and `listDir()`.
