# Repo Butler

A continuous roadmap planner agent that runs on a schedule, analyses the state of GitHub repositories, generates HTML health dashboards, and proposes improvements as issues.

**Live dashboards:** [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/)

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

Add a `.github/roadmap.yml` to your repo:

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

Add a workflow:

```yaml
name: Repo Butler
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:
    inputs:
      phase:
        description: 'Phase to run (observe, report, assess, all)'
        default: 'report'
permissions:
  contents: write
  pages: write
  id-token: write
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Run Repo Butler
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          INPUT_PHASE: ${{ github.event.inputs.phase || 'report' }}
          REPORT_OUTPUT_DIR: reports
        run: node src/index.js
      - uses: actions/upload-pages-artifact@v3
        with:
          path: reports
  deploy:
    needs: run
    runs-on: ubuntu-latest
    environment:
      name: github-pages
    steps:
      - uses: actions/deploy-pages@v4
```

## Running locally

```bash
# Copy .env.example to .env.local, fill in your values, then:
npm run report    # Generate reports
npm run observe   # Observe only
npm run all       # Full pipeline (needs GEMINI_API_KEY)
```

## Architecture

Zero external dependencies. Uses Node 22's built-in `fetch` for all API calls. The GitHub API client handles rate limiting with automatic retry and backoff. Search API calls are throttled to stay under secondary rate limits. A safety layer validates all LLM output before publishing.

```
src/
├── index.js          # Entry point, phase router
├── observe.js        # OBSERVE: GitHub API data gathering + portfolio classification
├── assess.js         # ASSESS: snapshot diffing, trend computation, LLM summarisation
├── update.js         # UPDATE: roadmap PR generation with safety validation
├── ideate.js         # IDEATE: LLM idea generation with structured parsing
├── propose.js        # PROPOSE: GitHub issue creation with safety filtering + approval gate
├── report.js         # REPORT: HTML dashboard generation with caching
├── safety.js         # Output validators: URLs, @mentions, secrets, XSS, lengths
├── triage-bot.js     # Optional triage bot integration (auto-discovered)
├── store.js          # Snapshot + weekly history + hash persistence via Git Data API
├── config.js         # YAML config loader with defaults
├── github.js         # GitHub REST API client with rate limit handling
└── providers/
    ├── base.js       # LLM provider interface
    ├── gemini.js     # Gemini Flash (free tier, API key via header)
    └── claude.js     # Claude (Anthropic Messages API)
```

## Design principles

- Zero dependencies. No `npm install` needed.
- Generic. Any repo can use it by adding a config file and a workflow.
- Conservative. Max 3 issues per run, `require_approval` gate enforced, dry-run by default.
- Safe. All LLM output validated before publishing — URL allowlist, @mention blocking, secret detection, XSS prevention.
- Free to run. GitHub Actions is unlimited for public repos, Gemini Flash free tier for LLM calls.
- Self-dogfooding. This repo uses itself as its own planner.

## License

MIT
