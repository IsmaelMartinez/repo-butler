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

## Implemented

All six phases are working. The system runs daily at 2am UTC via GitHub Actions cron, generating fresh reports and deploying them to GitHub Pages.

Observing covers open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, and package.json parsing. Portfolio observation classifies all repos by activity level (active, dormant, archive candidate, fork, test).

Assessing persists snapshots on a `repo-butler-data` orphan branch via the Git Data API, then computes diffs between runs (new/resolved issues, merged PRs, new releases, label changes). LLM summarisation is optional.

Reporting generates per-repo HTML dashboards for every active portfolio repo. Repos with 10+ commits get full charts (PR velocity, issue trends, release cadence, contributors, labels). Repos with less activity get lightweight summary cards. The portfolio page is the landing page with a stacked weekly commit heatmap, health matrix, and distribution charts.

The GitHub API client handles rate limiting with automatic retry/backoff (reads `retry-after` and `x-ratelimit-reset` headers). Search API calls are throttled at 2.5s intervals. Branch protection is enabled on main — PRs required, force pushes blocked. CI runs tests and secret-leak checks on every PR.

## Next Up

- End-to-end test of ASSESS/UPDATE/IDEATE/PROPOSE with a Gemini API key
- Historical trend charts (compare this week's snapshot against 4 weeks ago, not just the previous run)
- Report caching (skip regeneration if snapshot hasn't changed)
- Consumer documentation and action.yml packaging for use in other repos

## Future

- Multi-repo cross-referencing (identify patterns across repos, e.g. the same dependency being outdated everywhere)
- Electron release watcher (monitor releases for fixes relevant to blocked issues)
- Configurable report themes and sections
- Weekly digest notifications (email or Slack)
- Community health scoring (response time, contributor onboarding, documentation coverage)
