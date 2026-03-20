# Repo Butler

A continuous roadmap planner agent that runs on a schedule, analyses the state of GitHub repositories, generates HTML health dashboards, and proposes improvements as issues.

**Live dashboards:** [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/)

## How it works

Repo Butler follows a six-phase loop: **OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE → REPORT**

- **OBSERVE** gathers project state via the GitHub API (issues, PRs, releases, labels, workflows, roadmap content) and classifies all portfolio repos by activity level. No LLM needed.
- **ASSESS** diffs the current snapshot against the previous run, identifying new/resolved issues, merged PRs, and new releases. Optionally summarises changes with Gemini Flash.
- **UPDATE** generates an updated roadmap document and opens a PR.
- **IDEATE** generates improvement ideas using an LLM (Claude for deeper reasoning, Gemini Flash as default).
- **PROPOSE** creates GitHub issues from the best ideas, capped at `max_issues_per_run`, sorted by priority, labelled for human review.
- **REPORT** generates HTML dashboards for every active repo in the portfolio, deployed to GitHub Pages.

## Reports

The REPORT phase generates two types of pages:

The portfolio page (`index.html`) is the landing page with a stacked weekly commit heatmap, a health matrix table (commits, CI, license, status), and distribution charts for language, status, and commit totals. Repo names link to individual per-repo reports.

Per-repo pages (`{repo-name}.html`) are generated for every active, non-fork, non-test repo. Repos with 10 or more commits in the last 6 months get full charts covering PR merge velocity (12 months), issues opened vs closed (12 months), release cadence, PR author distribution, and open issues by label. Repos with less activity get a lightweight summary card showing key metrics without hitting the search API.

Reports regenerate daily at 2am UTC and are deployed to GitHub Pages automatically.

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
# Generate reports
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/repo REPORT_OUTPUT_DIR=reports node src/index.js --phase=report

# Observe only (no reports, no LLM)
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/repo node src/index.js --phase=observe
```

## Architecture

Zero external dependencies. Uses Node 22's built-in `fetch` for all API calls. The GitHub API client handles rate limiting with automatic retry and backoff. Search API calls are throttled to stay under secondary rate limits.

```
src/
├── index.js          # Entry point, phase router
├── observe.js        # OBSERVE: GitHub API data gathering + portfolio classification
├── assess.js         # ASSESS: snapshot diffing + LLM summarisation
├── update.js         # UPDATE: roadmap PR generation
├── ideate.js         # IDEATE: LLM idea generation with structured parsing
├── propose.js        # PROPOSE: GitHub issue creation with approval gate
├── report.js         # REPORT: HTML dashboard generation for all portfolio repos
├── store.js          # Snapshot persistence on a data branch via Git Data API
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
- Free to run. GitHub Actions is unlimited for public repos, Gemini Flash free tier for LLM calls.
- Self-dogfooding. This repo uses itself as its own planner.

## License

MIT
