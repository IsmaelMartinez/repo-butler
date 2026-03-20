# Repo Butler — Roadmap

**Last Updated:** 2026-03-20
**Status:** All six phases implemented, reports live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/)

---

## Architecture

```
OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE → REPORT
```

1. **OBSERVE** — Gather project state via GitHub API. Portfolio-level repo classification. No LLM needed.
2. **ASSESS** — Diff current snapshot against previous run. Optionally summarise with Gemini Flash.
3. **UPDATE** — Generate an updated roadmap document and open a PR.
4. **IDEATE** — Generate improvement ideas. Claude for deeper reasoning, Gemini Flash as default.
5. **PROPOSE** — Create GitHub issues from ideas, capped and labelled for human review.
6. **REPORT** — Generate HTML dashboards for every portfolio repo, deploy to GitHub Pages.

See [ADR-001](docs/decisions/001-repo-butler-vs-triage-bot.md) for the boundary between this project and the triage bot.

## Implemented

All six phases are working. The system runs daily at 2am UTC via GitHub Actions cron, generating fresh reports and deploying them to GitHub Pages.

Observing covers open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, and package.json parsing. Portfolio observation classifies all repos by activity level (active, dormant, archive candidate, fork, test).

Assessing persists snapshots on a `repo-butler-data` orphan branch via the Git Data API, then computes diffs between runs (new/resolved issues, merged PRs, new releases, label changes). LLM summarisation is optional.

Reporting generates per-repo HTML dashboards for every active portfolio repo. Repos with 10+ commits get full charts (PR velocity, issue trends, release cadence, contributors, labels). Repos with less activity get lightweight summary cards. The portfolio page is the landing page with a stacked weekly commit heatmap, health matrix, and distribution charts.

The GitHub API client handles rate limiting with automatic retry/backoff (reads `retry-after` and `x-ratelimit-reset` headers). Search API calls are throttled at 2.5s intervals. Branch protection is enabled on main — PRs required, force pushes blocked. CI runs tests and secret-leak checks on every PR.

## Next Up

### 1. End-to-end LLM phases

Test the ASSESS, UPDATE, IDEATE, and PROPOSE phases with a Gemini API key. OBSERVE and REPORT work without one, but the LLM-dependent phases have only been tested with mock providers. Add `GEMINI_API_KEY` as a repo secret and run a full `phase=all` dispatch. Validate that the assessment reads coherently, the roadmap PR is well-formed, the ideas are actionable, and the proposal respects `require_approval`.

### 2. Triage bot integration

Wire OBSERVE to POST collected data to the triage bot's `/ingest` endpoint, enriching its event journal. Wire ASSESS and IDEATE to read synthesis findings from the triage bot's `/report/trends` endpoint. Add live dashboard links to per-repo report pages for repos where the bot is installed. See [ADR-001](docs/decisions/001-repo-butler-vs-triage-bot.md) for the full integration design.

### 3. Historical trend charts

Store weekly snapshots (not just latest + previous) so the reports can show trends over 4-12 weeks. Currently the ASSESS phase can only compare "now vs last run" — with a history of snapshots it could show trajectory (is the backlog growing? is velocity increasing?).

### 4. Report caching

Skip report regeneration if the snapshot hash hasn't changed since the last run. The full report generation takes ~15 minutes due to search API throttling — caching would reduce daily cron duration to under a minute on quiet days.

## Future

These are ideas, not commitments. They'll be evaluated as the system matures.

Multi-repo cross-referencing would identify patterns across repos, such as the same dependency being outdated everywhere or similar issue themes appearing in unrelated projects. Configurable report themes would let other users customise the dashboard appearance. Weekly digest notifications (email or Slack) would push the report summary rather than requiring a visit to the Pages site. Community health scoring would add metrics like response time, contributor onboarding friction, and documentation coverage.
