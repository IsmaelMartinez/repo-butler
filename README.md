# Repo Butler

A continuous roadmap planner agent that runs on a schedule, analyses the state of GitHub repositories, generates HTML health dashboards, and proposes improvements as issues.

**Live dashboards:** [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/)

## Usage

Add Repo Butler to any repository with a simple workflow file:

```yaml
name: Repo Butler
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:
    inputs:
      phase:
        description: 'Phase to run (observe, assess, update, ideate, propose, report, or all)'
        default: 'report'
permissions:
  contents: write
  issues: write
  pull-requests: write
  pages: write
  id-token: write
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: IsmaelMartinez/repo-butler@v1
        with:
          github-token: ${{ github.token }}
          phase: ${{ github.event.inputs.phase || 'report' }}
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
```

The only required input is `github-token`. The `gemini-api-key` is needed for LLM-powered phases (assess, ideate, update) but not for observe or report.

### Action inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | yes | `${{ github.token }}` | GitHub token with `contents`, `issues`, `pull-requests`, and `pages` write access |
| `phase` | no | `all` | Which phase to run: observe, assess, update, ideate, propose, report, or all |
| `config-path` | no | `.github/roadmap.yml` | Path to the roadmap config file |
| `gemini-api-key` | no | — | Gemini API key (free tier: 10 RPM, 250 RPD) |
| `claude-api-key` | no | — | Claude API key (for deep reasoning in ideate phase) |
| `dry-run` | no | `false` | If true, log what would happen but do not create issues or PRs |

## Configuration

Create a `.github/roadmap.yml` in your repository to customise Repo Butler's behaviour:

```yaml
roadmap:
  path: ROADMAP.md

schedule:
  assess: daily
  ideate: weekly

providers:
  default: gemini

context: |
  Describe your project, its goals, and what kind of ideas would be useful.

limits:
  max_issues_per_run: 3
  require_approval: true
```

The `context` field tells the LLM about your project so it can generate relevant improvement ideas. The `providers.default` field selects the LLM provider (`gemini` for Gemini Flash free tier, `claude` for Claude Sonnet). Setting `require_approval: true` means proposed issues are created with a `needs-approval` label for human review before any action is taken.

The `schedule` section controls how often each phase runs. Setting `assess: daily` and `ideate: weekly` means the butler checks project health every day but only generates new ideas once a week, keeping noise low.

## How it works

Repo Butler follows a six-phase loop: **OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE → REPORT**

- **OBSERVE** gathers project state via the GitHub API (issues, PRs, releases, labels, workflows, roadmap content) and classifies all portfolio repos by activity level. No LLM needed.
- **ASSESS** diffs the current snapshot against the previous run, computes weekly trends (growing/shrinking/stable), and optionally summarises changes with Gemini Flash.
- **UPDATE** generates an updated roadmap document, validates it through a safety layer, and opens a PR.
- **IDEATE** generates improvement ideas using an LLM (Claude for deeper reasoning, Gemini Flash as default).
- **PROPOSE** safety-filters ideas (URL allowlist, @mention blocking, secret detection), then creates GitHub issues capped at `max_issues_per_run`, sorted by priority, labelled for human review.
- **REPORT** generates HTML dashboards for every active repo in the portfolio, deployed to GitHub Pages.

## Reports

The portfolio page (`index.html`) is the landing page with a stacked weekly commit heatmap, a health matrix table (commits, CI, license, status), and distribution charts for language, status, and commit totals. Repo names link to individual per-repo reports.

Per-repo pages (`{repo-name}.html`) are generated for every active, non-fork, non-test repo. Repos with 10 or more commits in the last 6 months get full charts covering PR merge velocity (12 months), issues opened vs closed (12 months), release cadence, PR author distribution, open issues by label, and weekly trend lines when history is available. Repos with less activity get a lightweight summary card.

Reports regenerate daily at 2am UTC and are deployed to GitHub Pages automatically. Caching skips regeneration when the snapshot hash hasn't changed, reducing quiet-day runs from ~15 minutes to seconds.

## Triage bot integration

If your repo has a [github-issue-triage-bot](https://github.com/IsmaelMartinez/github-issue-triage-bot) deployed, Repo Butler auto-discovers it and integrates. The bot is found from `.github/butler.json` in the target repo (the same config file the triage bot reads) or from the `TRIAGE_BOT_URL` environment variable.

When the bot is available, the OBSERVE phase POSTs snapshot metrics to the bot's `/ingest` endpoint (requires `TRIAGE_BOT_INGEST_SECRET`), the ASSESS phase fetches synthesis findings from `/report/trends`, and per-repo report footers link to the live triage dashboard.

When the bot is not available, nothing changes — no errors, no warnings, no degraded behaviour.

## Quick start

1. Add a `.github/roadmap.yml` to your repo (see [Configuration](#configuration) above).
2. Add the workflow from the [Usage](#usage) section.
3. Trigger manually: `gh workflow run "Repo Butler" --ref main`

The butler will observe your repo, generate a health dashboard, and (if LLM keys are configured) propose improvements as GitHub issues.

## Running locally

```bash
# Copy .env.example to .env.local, fill in your values, then:
npm run report    # Generate reports
npm run observe   # Observe only
npm run all       # Full pipeline (needs GEMINI_API_KEY)
```

## Architecture

Zero external dependencies. Runs on the GitHub Actions `node24` runtime and uses Node's built-in `fetch` for all API calls. The GitHub API client handles rate limiting with automatic retry and backoff. Search API calls are throttled to stay under secondary rate limits. A safety layer validates all LLM output before publishing.

```
src/
├── index.js              # Entry point, phase router
├── observe.js            # OBSERVE: GitHub API data gathering + portfolio classification
├── assess.js             # ASSESS: snapshot diffing, trend computation, LLM summarisation
├── update.js             # UPDATE: roadmap PR generation with safety validation
├── ideate.js             # IDEATE: LLM idea generation with structured parsing
├── propose.js            # PROPOSE: GitHub issue creation with safety filtering + approval gate
├── report.js             # REPORT: entry point, orchestrates report generation
├── report-shared.js      # Shared constants, computeHealthTier(), helpers
├── report-portfolio.js   # Portfolio reports, campaigns, dependency inventory
├── report-repo.js        # Per-repo charts, health sections, data fetchers
├── report-styles.js      # CSS template
├── governance.js         # Standards-gap, policy-drift, tier-uplift detection
├── council.js            # Agent-council deliberation on proposals and events
├── monitor.js            # Continuous event monitoring between daily runs
├── onboard.js            # Auto-onboarding PRs (CLAUDE.md marker) for new repos
├── mcp.js                # MCP server: JSON-RPC 2.0 over stdio for AI agents
├── agent-card.js         # A2A AgentCard generator (served at /.well-known/agent-card.json)
├── safety.js             # Output validators: URLs, @mentions, secrets, XSS, lengths
├── triage-bot.js         # Optional triage bot integration (auto-discovered)
├── store.js              # Snapshot + weekly history + hash persistence via Git Data API
├── config.js             # YAML config loader with defaults
├── github.js             # GitHub REST API client with rate limit handling
├── libyear.js            # Dependency freshness (libyear metric via npm registry)
└── providers/
    ├── base.js           # LLM provider interface
    ├── gemini.js         # Gemini Flash (free tier, API key via header)
    └── claude.js         # Claude (Anthropic Messages API)
schemas/v1/               # JSON Schema definitions for all data structures
docs/
├── skill.md              # Claude Code skill for AI agent consumption
└── decisions/            # Architecture Decision Records (ADR-001 through ADR-003)
```

### Private repository support

The portfolio observer prefers the `/installation/repositories` endpoint (GitHub App tokens), falling back to `/user/repos` (PATs), then to the public-only `/users/{owner}/repos` endpoint. Private repos only appear when the token can see them — a default `GITHUB_TOKEN` cannot list repos across an owner's portfolio, so the workflow should use a GitHub App token (`actions/create-github-app-token`) installed on every repo that should be included.

## MCP Server (AI agent access)

Repo Butler includes an MCP (Model Context Protocol) server that lets AI agents query portfolio health data directly. Any MCP-compatible client (Claude Code, Claude Desktop, Cursor, VS Code) can connect.

```bash
# Add to Claude Code
claude mcp add repo-butler node src/mcp.js

# Or add to Claude Desktop (~/.claude/claude_desktop_config.json)
{
  "mcpServers": {
    "repo-butler": {
      "command": "node",
      "args": ["/path/to/repo-butler/src/mcp.js"]
    }
  }
}
```

Once connected, the AI gets nine tools: `get_health_tier` (tier + checklist for any repo), `get_campaign_status` (portfolio compliance), `query_portfolio` (filter by tier/language), `get_snapshot_diff` (what changed since last run), `get_governance_findings` (standards gaps, policy drift, tier-uplift proposals), `trigger_refresh` (dispatch the workflow via `gh` CLI), `get_monitor_events` (events captured between daily runs), `get_watchlist` (council-watchlisted proposals), and `get_council_personas` (the five reviewer personas). It also exposes three resources: the latest snapshot, portfolio health summary, and campaign status.

## A2A Agent Card

For A2A-protocol-aware agents, the butler publishes an AgentCard at [`ismaelmartinez.github.io/repo-butler/.well-known/agent-card.json`](https://ismaelmartinez.github.io/repo-butler/.well-known/agent-card.json). It declares the butler's skills (portfolio-health, governance-findings, campaign-status, snapshot-diff, monitor-events, council-triage) for capability discovery. The card is discovery-only — the live programmatic interface is the MCP server above.

## Design principles

- Zero dependencies. No `npm install` needed.
- Generic. Any repo can use it by adding a config file and a workflow.
- Conservative. Max 3 issues per run, `require_approval` gate enforced, dry-run by default.
- Safe. All LLM output validated before publishing — URL allowlist, @mention blocking, secret detection, XSS prevention.
- Free to run. GitHub Actions is unlimited for public repos, Gemini Flash free tier for LLM calls.
- Self-dogfooding. This repo uses itself as its own planner.

## License

MIT
