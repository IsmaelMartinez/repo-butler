# Repo Butler — Roadmap

**Last Updated:** 2024-05-15
**Current version:** 0.1.0
**Status:** All six original phases implemented, reports live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/). Portfolio at 10 Gold + 3 Silver (13 repos); the Silver tier holds `teams-for-linux` (>10 open bugs), `betis-escocia`, and `ai-model-advisor` (no longer blocked by critical vulns as of 2026-W18). Private repos now included via the installation-scoped discovery endpoint.

---

## Vision

Repo Butler is evolving from a reporting tool into a genuine butler — one that not only tells you what your repos need but takes care of it. The positioning is deliberate: don't replicate what Renovate, Dependabot, SonarCloud, or the triage bot already do well. Instead, consume their data, present a unified view, and open PRs to install the tools that are missing. The butler orchestrates; the specialist tools execute.

The competitive landscape confirms this is a unique niche. Implementation agents (Copilot Coding Agent, Sweep, Devin) take known issues and write code. Planning tools (CodeRabbit Issue Planner) produce implementation plans. Project intelligence platforms (Linear AI, OSSInsight, GrimoireLab) either require infrastructure or are SaaS. No tool does the full loop of observe → assess → propose → act across an entire portfolio from a zero-dependency GitHub Action.

## Architecture

```text
OBSERVE → ASSESS → UPDATE → GOVERNANCE → IDEATE → PROPOSE → REPORT
```

1.  **OBSERVE** — Gather project state via GitHub API. Portfolio-level classification. Consume data from installed tools. No LLM needed.
2.  **ASSESS** — Diff snapshots, compute trends, detect health gaps. Optionally summarise with Gemini Flash.
3.  **UPDATE** — Generate an updated roadmap document and open a PR. Safety-validated.
4.  **GOVERNANCE** — Run deterministic detectors over the portfolio (standards gaps, policy drift, tier-uplift, stale Dependabot PRs). No LLM cost; runs 4×/day on the daily pipeline.
5.  **IDEATE** — Generate improvement ideas informed by triage bot intelligence, health signals, and fresh governance findings.
6.  **PROPOSE** — Create GitHub issues from ideas, safety-filtered, capped and labelled.
7.  **REPORT** — Generate HTML dashboards for every portfolio repo, deploy to GitHub Pages.

See [ADR-001](docs/decisions/001-repo-butler-vs-triage-bot.md) for the boundary between this project and the triage bot.

## Implemented

All six original phases are working end-to-end with real Gemini API calls validated. The system runs daily at 2am UTC via GitHub Actions cron, generating fresh reports and deploying them to GitHub Pages.

Observing covers open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, and package.json parsing. Portfolio observation classifies all repos by activity level (active, dormant, archive candidate, fork, test).

Assessing persists snapshots on a `repo-butler-data` orphan branch via the Git Data API, computes diffs between runs, and tracks weekly snapshot history for trend analysis. The `computeTrends` function produces a direction signal (growing/shrinking/stable) from up to 12 weeks of data.

Reporting generates per-repo HTML dashboards for every active portfolio repo, with full charts for active repos and lightweight cards for quieter ones. Report caching skips regeneration when the snapshot hash hasn't changed. Multi-repo trend charts store lightweight weekly snapshots per portfolio repo. A safety layer validates all LLM output before publishing. Triage bot integration is optional and auto-discovered. The ASSESS and IDEATE prompts include triage bot intelligence when available.

Phase 1 (Richer Observation) shipped 2026-03-22 via PR #18. Added community health profile, Dependabot vulnerability alerts, CI pass rate, bus factor, and time-to-close median. Portfolio table gained Community, Vulns, and CI% columns. Per-repo reports gained a Repository Health section with five cards. Follow-up fixes: YAML issue template detection (PR #22), search API replaced with list endpoints halving runtime from 26 to 13 minutes (PR #23), open issue counts exclude PRs (PR #24).

Phase 2 (Richer Reports) in progress since 2026-03-23. Open PR triage view (PR #26), issue staleness detection (PR #27), blocked issue context with upstream classification (PR #28). 74 tests, 28 merged PRs.

Security trifecta shipped 2026-04-04 (PR #8