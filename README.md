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
        description: 'Phase to run (observe, assess, update, governance, ideate, propose, report, or all)'
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
| `phase` | no | `all` | Which phase to run: observe, assess, update, governance, ideate, propose, report, or all |
| `config-path` | no | `.github/roadmap.yml` | Path to the roadmap config file |
| `gemini-api-key` | no | — | Gemini API key (free tier: 10 RPM, 250 RPD) |
| `claude-api-key` | no | — | Claude API key (for deep reasoning in ideate phase) |
| `dry-run` | no | `false` | If true, log what would happen but do not create issues or PRs |

## Configuration

Create a `.github/roadmap.yml` in your repository to customise Repo Butler's behaviour:

```yaml
roadmap:
  path: ROADMAP.md
  compact_after_days: 60

providers:
  default: gemini

context: |
  Describe your project, its goals, and what kind of ideas would be useful.

limits:
  max_issues_per_run: 3
  require_approval: true
```

The `context` field tells the LLM about your project so it can generate relevant improvement ideas. The `providers.default` field selects the model for ASSESS and UPDATE (`gemini` for Gemini Flash free tier, `claude` for Claude). IDEATE and MONITOR use `providers.deep` if set, otherwise Claude when a Claude key is supplied, otherwise the default provider; this repository's own workflows supply no Claude key, so every phase here runs on Gemini.

`require_approval: true` (the default) holds PROPOSE in dry-run: it logs the issues it would file and creates none, and setting it to `false` lets it file up to `max_issues_per_run`. Governance Apply reads the same key as its master switch the other way round, acting only when it is the boolean `true`, so `false` halts every apply write.

How often each phase runs is decided by the workflows that invoke the action, not by this file; [`docs/architecture.md`](docs/architecture.md#workflow-choreography) describes this repository's own schedule.

The UPDATE phase only ever *appends* to your roadmap — it can add entries but never delete or rewrite them — so without compaction the document would grow forever and eventually fail the 60,000-character safety check. `roadmap.compact_after_days` sets how much full detail to keep: completed `~~SHIPPED~~` subsections older than that are trimmed to a one-line pointer, and older dated entries in the free-prose `## Implemented` section are rolled up to one line per month. The prose always stays in git history. Undated paragraphs are never touched, so evergreen descriptions survive — if you want a paragraph kept verbatim, leave a full `YYYY-MM-DD` date out of it.

## How it works

Repo Butler runs a seven-phase pipeline, OBSERVE → ASSESS → UPDATE → GOVERNANCE → IDEATE → PROPOSE → REPORT, plus a MONITOR phase that triages events between runs. Separately, Governance Apply opens remediation PRs on portfolio repos (on manual dispatch, and on a weekly scheduled run for the finding classes allow-listed in `apply-schedule`), and an onboarding pass adds the Repo Butler section to repos' `CLAUDE.md`. [`docs/architecture.md`](docs/architecture.md) is the canonical description of what each phase does, which workflow runs it and when, and what it writes.

## Reports

The portfolio page (`index.html`) is the landing page with a stacked weekly commit heatmap, a health matrix table (commits, CI, license, status), and distribution charts for language, status, and commit totals. Repo names link to individual per-repo reports.

Per-repo pages (`{repo-name}.html`) are generated for every active, non-fork, non-test repo. Repos with 10 or more commits in the last 6 months get full charts covering PR merge velocity (12 months), issues opened vs closed (12 months), release cadence, PR author distribution, open issues by label, and weekly trend lines when history is available. Repos with less activity get a lightweight summary card.

Reports regenerate four times a day during UK waking hours (07:00, 11:00, 16:00, 20:00 UTC) and are deployed to GitHub Pages automatically. Scheduled and push runs always regenerate; the snapshot-hash cache lets a manual dispatch skip regeneration when nothing has changed, and per-repo enrichment is cached separately until a repo's last push or open-issue count moves (currently inert: the cache file exceeds the 1 MB read limit, #449).

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

Zero external dependencies. Runs on the GitHub Actions `node24` runtime and uses Node's built-in `fetch` for all API calls. The GitHub API client handles rate limiting with automatic retry and backoff, and the code prefers list endpoints over the Search API, whose secondary rate limit is far tighter. A safety layer validates all LLM output before publishing.

```
src/
├── index.js              # Entry point, phase router
├── observe.js            # OBSERVE: GitHub API data gathering + portfolio classification
├── assess.js             # ASSESS: snapshot diffing, trend computation, LLM summarisation
├── update.js             # UPDATE: roadmap PR generation with safety validation
├── governance.js         # GOVERNANCE: deterministic detectors for all eight finding types
├── dependabot-audit.js   # Stale Dependabot PR detector (called by governance)
├── butler-pr-audit.js    # Stale-butler-pr detector: the butler's own PRs nobody landed (called by governance)
├── stalled-alert.js      # Stalled-alert detector: open Dependabot alerts with no PR driving them (called by governance)
├── trimmer.js            # Parent-scoped npm override decider for transitive vulns (ADR-013; no caller in the write path yet)
├── lockfile-update.js    # Lockfile refresh apply tool for reachable-by-update alerts (ADR-015)
├── private-watch.js      # Private-repo security watch — standalone pass, never enters the governance pipeline
├── private-notify.js     # Tracking-issue delivery for private-watch findings
├── tier-change.js        # Shared tier-diff core behind G7 regression detection and trend reporting
├── staleness.js          # Behind-main probe shared by the MCP staleness envelope and the skills check
├── skill-staleness.js    # Whether the installed skill matches the checkout it is symlinked to
├── ideate.js             # IDEATE: LLM idea generation with structured parsing
├── propose.js            # PROPOSE: GitHub issue creation with safety filtering + approval gate
├── report.js             # REPORT: entry point, orchestrates report generation
├── report-shared.js      # Shared constants, computeHealthTier(), helpers
├── report-portfolio.js   # Portfolio reports, campaigns, dependency inventory
├── report-repo.js        # Per-repo charts, health sections, data fetchers
├── report-styles.js      # CSS template
├── apply.js              # Governance Apply: remediation PRs and settings writes (manual dispatch + weekly allow-listed schedule)
├── apply-templates.js    # Pure TEMPLATES map of remediation-PR file templates used by apply.js
├── council.js            # Agent-council deliberation on proposals and events
├── monitor.js            # Continuous event monitoring between daily runs
├── onboard.js            # Onboarding PRs adding the Repo Butler section to a repo's CLAUDE.md
├── mcp.js                # MCP server: JSON-RPC 2.0 over stdio for AI agents
├── agent-card.js         # A2A AgentCard generator (served at .well-known/agent-card.json)
├── safety.js             # Output validators: URLs, @mentions, secrets, XSS, lengths
├── store.js              # Snapshot + weekly history + hash persistence via Git Data API
├── config.js             # YAML config loader with defaults
├── github.js             # GitHub REST API client with rate limit handling
├── libyear.js            # Dependency freshness (libyear metric via npm/PyPI/crates.io)
└── providers/
    ├── base.js           # LLM provider interface
    ├── gemini.js         # Gemini Flash (free tier, API key via header)
    └── claude.js         # Claude (Anthropic Messages API)
schemas/v1/               # JSON Schema definitions for all data structures
docs/
├── architecture.md       # Visual pipeline diagram + data flow
├── consumer-guide.md     # Repo-owner guide for the per-repo dashboards
├── skill.md              # Claude Code skill for AI agent consumption
├── decisions/            # Architecture Decision Records (ADR-001 through ADR-015)
├── research/             # Research notes for open roadmap items
└── superpowers/          # Implementation plans, kept as a record once executed
```

### Private repository support

The portfolio observer prefers the `/installation/repositories` endpoint (GitHub App tokens), falling back to `/user/repos` (PATs), then to the public-only `/users/{owner}/repos` endpoint. Private repos only appear when the token can see them — a default `GITHUB_TOKEN` cannot list repos across an owner's portfolio, so the workflow should use a GitHub App token (`actions/create-github-app-token`) installed on every repo that should be included.

## Claude Code skills

Two skills ship from `skills/` for use inside Claude Code: `repo-butler` (read-side, briefing/debrief modes) and `repo-butler-apply` (write-side, confirm-gated governance dispatch). Install them into your local skill registry with:

```bash
./scripts/install-skills.sh
```

The script symlinks both skills into `$HOME/.claude/skills/`, cleans up dead symlinks from earlier `butler-briefing`/`butler-debrief`/`butler-apply` layouts, and is idempotent. Pass `--uninstall` to remove the symlinks, or `--skills-dir DIR` to target a custom location. Restart your Claude Code session afterwards so the new skills appear in the registry.

Because these are symlinks, the skill that runs is whatever is in **that checkout's working tree** — not whatever is on `main`. Merging a PR does not change what runs until you pull, an experiment on a feature branch becomes the live skill while you have it checked out, and editing the file through the registry path edits the repository itself.

`scripts/check-skills.js` reports that state instead of leaving you to guess ([#350](https://github.com/IsmaelMartinez/repo-butler/issues/350)):

```bash
node scripts/check-skills.js              # human-readable report
node scripts/check-skills.js --headline   # one line, what the skills render
node scripts/check-skills.js --json       # full reading
```

It names how far the checkout is behind `origin/main`, which branch it is on, how many uncommitted changes under `skills/` are live, and where each registry entry actually points — a copy or a link into a *different* checkout both mean a merge can never reach the running skill. It exits 0 when there is nothing to report and 1 when there is. Like the MCP staleness envelope it reports rather than fetches, and it distinguishes "could not check" from "checked, it is fine": a checkout that has not fetched since `origin/main` moved is reported as exactly that, never as zero commits behind. Both skills run it themselves and surface the reading — the briefing as an almanac line in the frame, the apply skill as a caveat on every confirmation prompt.

Both skills source their portfolio data via the repo-butler MCP server below — no local clone of the data branch is required. Install the MCP server first (next section) and the skills will work from any working directory. Optional config at `~/.config/repo-butler/config.sh` recognises `REPO_BUTLER_PROJECTS_DIRS` (newline-separated parent dirs to scan for local working state) — defaults to `$HOME/projects/github` and `$HOME/projects/gitlab`.

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

Once connected, the AI gets twelve tools: `get_health_tier` (tier + checklist for any repo), `get_campaign_status` (portfolio compliance), `query_portfolio` (filter by tier), `get_snapshot_diff` (what changed since last run), `get_weekly_trend` (up to 12 weeks of per-repo or portfolio-wide history), `get_governance_findings` (every finding type, with autofix-not-driven and tier-regression counts), `get_open_governance_prs` (outstanding `repo-butler/apply-*` PRs across the portfolio), `list_stale_dependabot_prs` (stale dependency PRs by minimum age), `trigger_refresh` (dispatch the workflow via `gh` CLI), `get_monitor_events` (events captured between daily runs), `get_watchlist` (council-watchlisted proposals), and `get_council_personas` (the five reviewer personas). It also exposes three resources: the latest snapshot, portfolio health summary, and campaign status.

## A2A Agent Card

For A2A-protocol-aware agents, the butler publishes an AgentCard at [`ismaelmartinez.github.io/repo-butler/.well-known/agent-card.json`](https://ismaelmartinez.github.io/repo-butler/.well-known/agent-card.json). It declares the butler's skills (portfolio-health, governance-findings, campaign-status, snapshot-diff, monitor-events, council-triage) for capability discovery. The card is discovery-only — the live programmatic interface is the MCP server above.

## Design principles

- Zero dependencies. No `npm install` needed.
- Generic. Any repo can use it by adding a config file and a workflow.
- Conservative. PROPOSE files at most three issues per run, and none while `require_approval` is true. Pull requests on other repos come only from Governance Apply, which is capped per run and, when it runs unattended, limited to allow-listed finding classes, and from the onboarding pass, which backs off for thirty days after a declined PR.
- Safe. All LLM output validated before publishing — URL allowlist, @mention blocking, secret detection, XSS prevention.
- Free to run. GitHub Actions is unlimited for public repos, Gemini Flash free tier for LLM calls.
- Self-dogfooding. This repo uses itself as its own planner.

## Security

To report a vulnerability, see [`SECURITY.md`](SECURITY.md). It also documents the trust model — GitHub App token scope, untrusted-data boundaries, the `repo-butler-data` branch treatment, and cross-repo write gates.

## License

MIT
