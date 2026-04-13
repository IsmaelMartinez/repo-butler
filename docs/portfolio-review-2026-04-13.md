# Portfolio Review — 2026-04-13

Data sources: W15 portfolio snapshot (April 10), GitHub API metadata (April 13),
repo-butler-data branch history (W12–W15).

## Portfolio Overview

| Metric                       | Value   |
|------------------------------|---------|
| Total repos                  | 22      |
| Active (non-archived)        | 17      |
| Tracked in portfolio         | 13      |
| All gold tier                | 13 / 13 |
| Repos with open vulns        | 2       |
| Repos missing code scanning  | 8       |

## Per-Repo Status

### teams-for-linux — GOLD

| Metric        | W13  | W14  | W15  | Live   |
|---------------|------|------|------|--------|
| Stars         | 4543 | —    | —    | 4 586  |
| Commits (6mo) | 338  | 349  | 352  | —      |
| CI pass rate  | —    | 91 % | 94 % | —      |
| Open bugs     | —    | —    | 9    | —      |
| Vulns         | 0    | 3    | 0    | —      |

Flagship repo. CI trending up, vulns resolved. 9 open bugs need triage.

### bonnie-wee-plot — GOLD

| Metric        | W13  | W14  | W15  | Live |
|---------------|------|------|------|------|
| Commits (6mo) | 372  | 376  | 387  | —    |
| CI pass rate  | —    | 83 % | 82 % | —    |
| Open items    | 0    | 0    | 0    | 4    |

Most active repo by commits. License is NOASSERTION — needs explicit LICENSE
file. CI declining.

### wifisentinel — GOLD

| Metric         | W14  | W15  | Live |
|----------------|------|------|------|
| Commits (6mo)  | 173  | 182  | —    |
| CI pass rate   | 88 % | 88 % | —    |
| Community hlth | —    | 100 % | —   |
| Open items     | 0    | 0    | 6    |

Perfect community health. Code scanning not configured. 6 new items since W15.

### ai-model-advisor — GOLD

| Metric        | W13  | W14  | W15  |
|---------------|------|------|------|
| Commits (6mo) | 147  | 156  | 156  |
| CI pass rate  | —    | 87 % | 82 % |
| Vulns         | 0    | 3    | 0    |

CI declining (87 % -> 82 %). Commit velocity plateaued. Code scanning missing.

### betis-escocia — GOLD

| Metric        | W13  | W14  | W15  | Live |
|---------------|------|------|------|------|
| Commits (6mo) | 147  | 157  | 159  | —    |
| CI pass rate  | —    | 82 % | 76 % | —    |
| Vulns         | 0    | 1    | 1    | —    |
| Open items    | 0    | 0    | 0    | 2    |

Worst CI in the portfolio (76 %, declining). 1 low-severity vuln unresolved
since W14.

### yourear — GOLD

| Metric        | W13 | W14  | W15  | Live |
|---------------|-----|------|------|------|
| Commits (6mo) | 37  | 42   | 44   | —    |
| CI pass rate  | —   | 90 % | 87 % | —    |

Lowest commit velocity. No code scanning or secret scanning. Consider archival
if activity continues to stall.

### ismaelmartinez.me.uk — GOLD

| Metric        | W13 | W14  | W15  | Live |
|---------------|-----|------|------|------|
| Commits (6mo) | 66  | 71   | 81   | —    |
| CI pass rate  | —   | 95 % | 83 % | —    |
| Vulns         | 0   | 1    | 1    | —    |
| Open items    | 1   | 0    | 1    | 4    |

CI regressed sharply (95 % -> 83 %). 1 low-severity vuln carried from W14.
Issue backlog growing (1 -> 4).

### votescot — GOLD

| Metric         | W14  | W15   |
|----------------|------|-------|
| Commits (6mo)  | 54   | 77    |
| CI pass rate   | 92 % | 89 %  |
| Community hlth | —    | 100 % |

New repo, growing fast (+23 commits in one week). Clean security posture.
Code scanning not yet configured.

### sound3fy — GOLD

| Metric         | W13 | W14  | W15   |
|----------------|-----|------|-------|
| Commits (6mo)  | 56  | 59   | 65    |
| CI pass rate   | —   | 96 % | 99 %  |
| Community hlth | —   | —    | 100 % |

Near-perfect CI (99 %). No code scanning or secret scanning configured.

### generator-atlassian-compass-event-catalog — GOLD

| Metric        | W13  | W14  | W15   |
|---------------|------|------|-------|
| Commits (6mo) | 162  | 165  | 170   |
| CI pass rate  | —    | 100 % | 100 % |

Perfect CI. All security scanning configured with zero findings. Last release
March 16 — consider cutting a new one.

### lounge-tv — GOLD

| Metric        | W14 | W15   |
|---------------|-----|-------|
| Commits (6mo) | 7   | 21    |
| CI pass rate  | 100 % | 100 % |

New, small, clean. Perfect CI. Code scanning not configured.

### github-issue-triage-bot — GOLD

| Metric         | W13  | W14  | W15   |
|----------------|------|------|-------|
| Commits (6mo)  | 180  | 202  | 202   |
| CI pass rate   | —    | 97 % | 98 %  |
| Community hlth | —    | —    | 100 % |

Activity plateaued. May be feature-complete. Code scanning missing.

### repo-butler — GOLD

| Metric        | W13  | W14  | W15   |
|---------------|------|------|-------|
| Commits (6mo) | 139  | 167  | 183   |
| CI pass rate  | —    | 98 % | 100 % |
| Open issues   | 0    | 0    | 0     |

Healthiest repo. 15 PRs merged in the last week. Recent features: Agent
Council, continuous monitoring, traffic capture, Astro prerequisites, incremental
report caching. Code scanning is the only gap.

## New / Untracked

- **value-punter** (Python, private) — created April 10, not yet in portfolio.
  Will appear on the next pipeline run.

## Archived Repos

| Repo                             | Stars | Open Issues |
|----------------------------------|-------|-------------|
| gridfs-storage-engine            | 8     | 3           |
| seagate-photos                   | 3     | 7           |
| logger-to-kibana                 | 0     | 14          |
| leapp-codeartifact-login-plugin  | 0     | 7           |
| local-brain                      | 0     | 1           |

## Priority Actions

| Pri  | Action                              | Repos                                    |
|------|-------------------------------------|------------------------------------------|
| P0   | Fix CI below 80 %                   | betis-escocia (76 %)                     |
| P1   | Investigate CI regressions          | ismaelmartinez.me.uk (95->83 %), ai-model-advisor (87->82 %) |
| P1   | Resolve open vulnerabilities        | betis-escocia, ismaelmartinez.me.uk      |
| P1   | Triage teams-for-linux bugs         | teams-for-linux (9 bugs)                 |
| P2   | Enable code scanning                | 8 repos                                  |
| P2   | Fix license (NOASSERTION)           | bonnie-wee-plot                          |
| P2   | Enable secret scanning              | yourear, sound3fy                        |
| P3   | Triage newly opened items           | wifisentinel (6), bonnie-wee-plot (4), ismaelmartinez.me.uk (4) |
