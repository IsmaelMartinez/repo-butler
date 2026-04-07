# Dashboard Narrative Restructure

Date: 2026-04-07

## Problem

The portfolio and per-repo dashboards are data dumps rather than decision tools. The portfolio page leads with vanity metrics (stars, total commits), buries the actionable health table below a decorative chart, and scatters action items across 14 separate repo pages. The per-repo page renders 16+ cards, 7 charts, and 4 tables with no progressive disclosure. A multi-persona review (portfolio owner, data analyst, UX specialist, narrative consultant) independently converged on the same diagnosis: the dashboards lack narrative flow and make no distinction between signal and noise.

## Design principles

Every dashboard should follow a situation-problem-action arc. A reader who stops at any point should have received value proportional to time spent. The first 3 seconds answer "how healthy am I?" The first 15 seconds show what needs attention. The first 30 seconds give trend context. Everything after that is investigation on demand.

## Portfolio page restructure

### Section 1: Portfolio Pulse (replaces vanity stat cards)

The current 4 stat cards (repos, stars, commits, open issues) are replaced with a tier distribution display: "14 Gold, 0 Silver, 0 Bronze" rendered prominently, alongside a one-line trend sentence derived from the previous week's snapshot ("2 repos upgraded since last week" or "stable — no tier changes"). A single portfolio health grade (percentage of repos at Gold) serves as the headline metric. Stars and total commits are removed from the top level entirely.

### Section 2: Attention Required (new)

A prioritised list of action items aggregated across all repos. This mirrors the per-repo "What To Do Next" section but at portfolio level. Items include: repos with critical/high vulnerabilities, repos that dropped tiers since last week, repos with CI pass rate below 80%, and repos with open bugs. Each item links to the relevant per-repo page. If this section is empty, display a congratulatory message and the reader can stop.

Sources: the existing `buildActionItems` function in report-repo.js already computes per-repo actions. The portfolio version iterates active repos, calls the same logic, and takes the top 10 by priority.

### Section 3: Portfolio Health Table (moved up, simplified)

The current 13-column table moves above the commit chart (currently below it). Default columns are reduced to 6: repo name (linked, with weekly sparkline), tier badge, open bugs, CI pass rate, vulnerability severity, and a "next step" column showing what's blocking the next tier (from the health tier checks). The full 13-column view is available behind an "Show all columns" toggle using a `<details>` element.

### Section 4: Campaigns (collapsed details)

Campaign cards stay but non-compliant repo lists collapse behind a click. Currently each card lists every offending repo inline, which is noisy when most campaigns share the same offenders.

### Section 5: Details (collapsible)

The 26-week commit activity chart, distribution doughnut charts, and dependency inventory all move into collapsible `<details>` sections. These are audit material, not weekly check-in material. The three distribution doughnut charts (language, status, commit totals) are removed entirely — they were unanimously identified as filler.

### Removed from portfolio page

The 3 distribution doughnut charts. The stars stat card. The commit totals bar chart at the bottom (restates the table). The open issues raw count card (replaced by the bug-aware attention section).

## Per-repo page restructure

### Top section (keep as-is)

Summary cards (stars, open issues, PRs merged, releases), "What To Do Next" action items table, and Health Tier checklist. These already tell a tight story.

### Section 4: Trends (moved up)

The trends section (open issues direction, weekly history) moves from last position to right after the health tier. It contextualises whether the current health snapshot is improving or degrading. The velocity imbalance alert banner merges into this section rather than floating standalone.

### Section 5: Health detail (merged and simplified)

The 9-card health grid (community profile, Dependabot, code scanning, secret scanning, CI pass rate, bus factor, time-to-close, dependencies, libyear) merges into the tier checklist. The checklist already shows pass/fail for each criterion; the detailed numbers become inline annotations on each check rather than separate cards. This eliminates the duplication between the tier criteria table and the health grid.

### Section 6: Open Work (merged)

PR triage table and issue triage (stale feedback, blocked issues) merge under one "Open Work" heading.

### Section 7: Activity History (collapsible)

Development velocity (cycle time, merged PRs chart, issues chart), release cadence chart, and commit activity heatmap group under a single collapsible "Activity History" section. Collapsed by default.

### Section 8: Community (collapsible)

Contributor stats, PR authors doughnut, and open issues by label group under "Community." Collapsed by default. The PR authors doughnut and issues-by-label chart are removed — they don't drive decisions for a solo maintainer.

### Removed from per-repo page

PR authors doughnut chart. Open issues by label chart. Stars/forks/watchers as a prominent summary card (move to subtitle text).

## Implementation approach

This is a presentation-only refactor. No changes to data collection (observe.js), tier logic (report-shared.js), store (store.js), or any other pipeline phase. The changes are entirely in `report-portfolio.js` and `report-repo.js`, with minor CSS additions in `report-styles.js` for collapsible sections.

The portfolio-level "Attention Required" section requires a new function that iterates repos and aggregates action items, but the per-repo action item logic already exists in `buildActionItems`.

## Testing

Existing tests for `generatePortfolioReport` and `generateRepoReport` verify HTML output structure. Tests should be updated to check for the new section ordering and the presence of `<details>` collapsible elements. The tier computation and data collection tests are unaffected.
