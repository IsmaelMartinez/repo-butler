# Issue Classification for Health Tiers

Date: 2026-04-06

## Problem

The Gold tier check "Fewer than 20 open issues" treats all issues equally. A project with 15 feature requests is thriving — people want things from it. A project with 15 bug reports is in trouble. The current check penalises healthy, in-demand repos.

## Design

### Classification rules

Issues are classified by their labels into three buckets: bugs, features, and other. The classification uses a case-insensitive match against common label names.

Bug labels: `bug`, `defect`, `bugfix`, `bug-fix`, `type: bug`, `type:bug`, `kind/bug`. An issue is a bug if any of its labels match.

Feature labels: `enhancement`, `feature`, `feature-request`, `feature request`, `type: feature`, `type:feature`, `kind/feature`. An issue is a feature if any of its labels match (and it's not already classified as a bug).

Other: everything else (unlabeled issues, questions, documentation, chores). These do not count toward the bug threshold.

### Tier logic change

The Gold check changes from `Fewer than 20 open issues` to `Fewer than 10 open bugs`. Only issues classified as bugs count. Feature requests and unlabeled issues are excluded.

The check name in `computeHealthTier` becomes `{ name: 'Fewer than 10 open bugs', passed: (r.open_bugs || 0) < 10, required_for: 'gold' }`.

The input object to `computeHealthTier` gains an `open_bugs` field alongside the existing `open_issues`.

### Data collection changes

In `observe.js`, `buildSummary` already has access to the full `openIssues` array with labels. Add `open_bugs` and `open_features` counts to the summary by classifying each issue's labels.

In `report-portfolio.js`, `fetchPortfolioDetails` already paginates open issues per repo (line ~207). The current code just counts them: `.then(issues => issues.filter(i => !i.pull_request).length)`. Change this to also fetch labels and compute `open_bugs`: `.then(issues => { const filtered = issues.filter(i => !i.pull_request); return { total: filtered.length, bugs: filtered.filter(i => isBugLabel(i)).length }; })`.

The `open_issues` field in portfolio details and weekly snapshots stays as-is for backward compatibility. A new `open_bugs` field is added alongside it.

### Classification helper

A shared `isBugIssue(issue)` function in `report-shared.js` checks if any of the issue's labels match the bug patterns. Similarly `isFeatureIssue(issue)` for feature classification. Both use case-insensitive matching.

For the portfolio path where we only have label name arrays (not full issue objects), the helper accepts either an issue object with `.labels` or a plain array of label strings.

### Report changes

The per-repo report's Open Issues card gains a breakdown: "5 open (2 bugs, 3 features)". The portfolio table's Issues column shows the bug count with a tooltip for the total. The health tier checklist shows the new check name.

### Store/snapshot changes

The weekly portfolio snapshot gains `open_bugs` alongside `open_issues`. The `open_issues` field is preserved for trend continuity.

## Testing

Tests for the classification helper: bug label matches, feature label matches, case insensitivity, unlabeled issues return false, mixed labels where bug takes precedence. Tests for `computeHealthTier`: 9 open bugs passes Gold, 10 open bugs fails Gold, open_issues count no longer affects the tier check. Tests for `buildSummary`: verify open_bugs and open_features counts.
