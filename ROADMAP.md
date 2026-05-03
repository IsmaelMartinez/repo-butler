# Repo Butler — Roadmap

**Last Updated:** 2024-07-20
**Status:** All six original phases implemented, reports live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/). Portfolio at 10 Gold + 3 Silver (13 repos); the Silver tier holds `teams-for-linux` (>10 open bugs), `betis-escocia`, and `ai-model-advisor` (both blocked by a critical vuln). Private repos now included via the installation-scoped discovery endpoint.

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

Security trifecta shipped 2026-04-04 (PR #82). Broadened security assessment from Dependabot-only to three GitHub security scanners: Dependabot alerts, code scanning (CodeQL/SAST), and secret scanning. Gold tier check changed from "Dependabot configured" to "any security scanner configured" with findings checked across all configured scanners. Added `release_exempt` config option for stable repos that don't need frequent releases. Added `getAlertSummary` shared helper for DRY severity computation across observe and portfolio paths.

GitHub App token for vulnerability access shipped 2026-04-04 (PR #83). Switched the main workflow from the default GITHUB_TOKEN to the GitHub App token, granting access to Dependabot alerts, code scanning alerts, and secret scanning alerts APIs across all portfolio repos.

Auto-onboarding shipped 2026-04-04 (PR #85). The pipeline now automatically checks all active portfolio repos after the report phase and opens onboarding PRs for any repo missing the CLAUDE.md consumer guide. Skipped during dry runs.

Bug-only Gold tier shipped 2026-04-06 (PR #90). Gold tier check changed from "Fewer than 20 open issues" to "Fewer than 10 open bugs", classifying issues by label (`bug`/`defect`/`bugfix`). Feature requests and unlabelled issues no longer penalise health.

Node runtime compatibility fixed 2026-04-05 (PRs #87–#88). Resolved `'using: node22' is not supported` errors on some runners by switching `action.yml` to node20, then node24, ensuring compatibility across all GitHub Actions runner versions.

Dashboard narrative restructure spec added 2026-04-07 (PR #91). Multi-persona review identified the dashboards as data dumps lacking narrative flow. Design spec at `docs/superpowers/specs/2026-04-07-dashboard-narrative-restructure-design.md` proposes restructuring both portfolio