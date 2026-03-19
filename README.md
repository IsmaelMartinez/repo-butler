# Repo Butler

A continuous roadmap planner agent that runs on a schedule, analyses the state of GitHub repositories, maintains a living roadmap, and proposes improvements as issues.

## How it works

Repo Butler follows a five-phase loop: **OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE**

- **OBSERVE** gathers project state via the GitHub API (issues, PRs, releases, labels, roadmap content). No LLM needed.
- **ASSESS** evaluates what changed since the last run using Gemini Flash (free tier).
- **UPDATE** rewrites the roadmap document and opens a PR.
- **IDEATE** generates improvement ideas using an LLM.
- **PROPOSE** creates GitHub issues for the best ideas, labelled for human review.

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
name: Roadmap Planner
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: IsmaelMartinez/repo-butler@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Running locally

```bash
GITHUB_TOKEN=your_token GITHUB_REPOSITORY=owner/repo node src/index.js --phase=observe
```

## Design principles

- Generic, not project-specific. Any repo can use it via config.
- Conservative by default — max 3 issues per run, proposals need human approval.
- Free to run — GitHub Actions is unlimited for public repos, Gemini Flash free tier for LLM calls.
- Self-dogfooding — this repo uses itself as its own planner.

## Status

Currently only the OBSERVE phase is implemented. See [ROADMAP.md](ROADMAP.md) for what's next.

## License

MIT
