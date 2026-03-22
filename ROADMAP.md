# Repo Butler — Roadmap

**Last Updated:** 2026-03-22
**Status:** All phases implemented, reports live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/)

---

## Architecture

```
OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE → REPORT
```

1. **OBSERVE** — Gather project state via GitHub API. Portfolio-level repo classification. No LLM needed.
2. **ASSESS** — Diff current snapshot against previous run, compute weekly trends. Optionally summarise with Gemini Flash.
3. **UPDATE** — Generate an updated roadmap document and open a PR. Safety-validated before publishing.
4. **IDEATE** — Generate improvement ideas. Claude for deeper reasoning, Gemini Flash as default.
5. **PROPOSE** — Create GitHub issues from ideas, safety-filtered, capped and labelled for human review.
6. **REPORT** — Generate HTML dashboards for every portfolio repo, deploy to GitHub Pages.

See [ADR-001](docs/decisions/001-repo-butler-vs-triage-bot.md) for the boundary between this project and the triage bot.

## Implemented

All six phases are working end-to-end with real Gemini API calls validated. The system runs daily at 2am UTC via GitHub Actions cron, generating fresh reports and deploying them to GitHub Pages.

Observing covers open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, and package.json parsing. Portfolio observation classifies all repos by activity level (active, dormant, archive candidate, fork, test).

Assessing persists snapshots on a `repo-butler-data` orphan branch via the Git Data API, computes diffs between runs, and tracks weekly snapshot history for trend analysis. The `computeTrends` function produces a direction signal (growing/shrinking/stable) from up to 12 weeks of data.

Reporting generates per-repo HTML dashboards for every active portfolio repo, with full charts for active repos and lightweight cards for quieter ones. The portfolio landing page shows a stacked weekly commit heatmap, health matrix, and distribution charts. Report caching skips regeneration when the snapshot hash hasn't changed, reducing quiet-day crons from ~15 minutes to seconds.

A safety layer validates all LLM output before publishing. Roadmap content is checked for length, markdown structure, URL allowlist, and blocked patterns. Ideas are individually filtered — bad ones are dropped, good ones pass through. Provider validation fails fast on invalid API keys.

Triage bot integration is optional and auto-discovered. If `.github/butler.json` exists in the target repo with a `bot_url`, the OBSERVE phase POSTs snapshot metrics to `/ingest` and the ASSESS phase fetches synthesis findings from `/report/trends`. Per-repo report footers link to the live triage dashboard when available. A missing or unreachable bot never blocks the pipeline.

The ASSESS and IDEATE LLM prompts include triage bot intelligence when available: triage session counts and weighted promotion rates, agent session outcomes, synthesis findings, and response times. This data is injected via `appendTriageBotContext`, a shared helper that produces a structured context section for any LLM prompt.

The GitHub API client handles rate limiting with automatic retry/backoff. Branch protection is enabled on main. CI runs 58 tests and secret-leak checks on every PR.

## Next Up

### 1. Consumer packaging

Bundle with `ncc` so other people can `uses: IsmaelMartinez/repo-butler@v1` without checking out the source. Currently the `action.yml` points at raw `src/index.js` which requires the consumer to have Node 22 and all source files in the action's directory.

### 2. Multi-repo trend charts

Currently only the main observed repo gets trend charts (weekly open issues / merged PRs). Extend to store and display weekly history for all portfolio repos, not just the primary target.

## Future

These are ideas, not commitments. They'll be evaluated as the system matures.

Multi-repo cross-referencing would identify patterns across repos, such as the same dependency being outdated everywhere or similar issue themes appearing in unrelated projects. Configurable report themes would let other users customise the dashboard appearance. Weekly digest notifications (email or Slack) would push the report summary rather than requiring a visit to the Pages site. Community health scoring would add metrics like response time, contributor onboarding friction, and documentation coverage.
