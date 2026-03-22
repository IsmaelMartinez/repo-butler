# Phase 1: Richer Observation — Implementation Plan

Date: 2026-03-23
Status: Ready to implement

## Overview

Enrich the OBSERVE phase with five new data sources. All read-only, zero new dependencies, no refactoring needed.

## Build Sequence

### Phase 1a — Observe side

Add three new fetcher functions to `src/observe.js`, following the existing `fetchWorkflows` pattern (try/catch, return null on failure).

`fetchCommunityProfile(gh, owner, repo)` — calls `/repos/{owner}/{repo}/community/profile`. Returns `{ health_percentage, files: { readme, license, contributing, code_of_conduct, issue_template, pull_request_template } }` as booleans. No auth needed for public repos.

`fetchDependabotAlerts(gh, owner, repo)` — calls `/repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100`. Returns `{ count, critical, high, medium, low, max_severity }`. Returns null on 403 (token lacks `vulnerability_alerts: read`) or 404 (Dependabot not enabled). Log a note, not an error.

`fetchCIPassRate(gh, owner, repo)` — calls `/repos/{owner}/{repo}/actions/runs?status=completed&per_page=100`. Computes `success / (success + failure + cancelled + timed_out)`, excluding skipped. Returns `{ pass_rate, total_runs, passed, failed }`.

Add all three to the `Promise.all` in `observe()`. Add to snapshot as `community_profile`, `dependabot_alerts`, `ci_pass_rate`.

Add two exported pure functions for testability:

`computeBusFactor(mergedPRs)` — from PR author distribution, sort human authors by count descending, find minimum covering 50% of total. Return null if fewer than 5 human PRs (statistically unreliable). Return 0 if all PRs are bots.

`computeTimeToCloseMedian(closedIssues)` — from closed issues (last 90 days), compute median `(closed_at - created_at)` in days. Return `{ median_days, sample_size }`. This is a proxy for response time — the true "first comment" metric needs per-issue comment fetching which belongs in Phase 4.

Call both from `buildSummary()`, add `bus_factor` and `time_to_close_median_days` to the summary object.

### Phase 1b — Report side

In `fetchPortfolioDetails()` in `src/report.js`, add community health, vuln count, and CI pass rate to the per-repo `Promise.all`. Store in `details[r.name]`. Duplicate the API call logic inline (don't import the private fetchers from observe.js).

Update the portfolio table in `generatePortfolioReport()`:

```
Repo | Lang | Stars | Issues | Commits | CI | License | Community | Vulns | CI% | Status | Health
```

"Community" — health percentage, green >= 80, yellow >= 50, red < 50, grey if unavailable. "Vulns" — count colour-coded by max severity. "CI%" — pass rate percentage.

Update `healthScore` to add 1 point for community health >= 50, and 1 point for no critical/high vulns.

In `generateRepoReport()`, add a "Repository Health" section showing the community profile checklist (present/absent icons for each file), Dependabot alert breakdown, CI pass rate bar, bus factor number, and time-to-close median.

### Tests

Add to `src/observe.test.js`:
- `computeBusFactor` with fixtures: single author (returns 1), two authors 50/50 (returns 2), heavily skewed (returns 1), all bots (returns 0), fewer than 5 PRs (returns null)
- `computeTimeToCloseMedian` with fixtures: empty array (returns null), single issue (returns that value), odd/even arrays (correct median), sample_size matches input length

## Key Constraints

No changes to `index.js`, `assess.js`, `github.js`, or `store.js`. Snapshot backward compatible — old snapshots just have undefined for new keys. Dependabot alerts may be unavailable if token lacks scope — always null-safe.

## Architecture Decisions from Review

The architecture review confirmed: keep the existing `Promise.all` pattern in observe.js (don't refactor), don't split report.js yet (534 lines is manageable), no changes to the phase router in index.js. The code pattern review confirmed: github.js factory pattern works for cross-repo ops (CARE phase), store.js single-repo binding is correct, no circular dependencies exist.

## Security Findings for Future CARE Phase

The security review flagged issues to address before CARE ships (not blocking for Phase 1):
- `bot_url` from butler.json should only receive the ingest secret if it matches the env-var-configured URL
- Ecosystem detection must use a hardcoded allowlist, never interpolate filenames into YAML
- CARE PRs need deduplication (check for existing open PRs before creating new ones)
- URL allowlist in safety.js should be split: strict for LLM output, relaxed for template content
- Cross-repo PAT should be separate from the self-repo GITHUB_TOKEN
- Contributor names for CODEOWNERS must match `[a-zA-Z0-9-]+` before writing
