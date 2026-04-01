# Skill: repo-butler-consumer

## What is Repo Butler?

Repo Butler is a portfolio health agent that monitors all repos under the `IsmaelMartinez` GitHub account. It runs daily as a GitHub Action, observes each repo's health signals via the GitHub API, and produces HTML dashboards, health tier classifications, and governance proposals.

It does not modify your repo directly — it reports on what it observes and suggests improvements. Think of it as a health check-up for your entire portfolio.

Portfolio dashboard: `https://ismaelmartinez.github.io/repo-butler/`
Weekly digest: `https://ismaelmartinez.github.io/repo-butler/digest.html`
Per-repo report: `https://ismaelmartinez.github.io/repo-butler/{repo-name}.html`
Source: `https://github.com/IsmaelMartinez/repo-butler`

---

## What it provides

The per-repo report at `https://ismaelmartinez.github.io/repo-butler/{repo-name}.html` gives you a dashboard with commit activity charts, PR cycle time, issue velocity, contributor stats, an SBOM dependency inventory, and a health tier classification with a pass/fail checklist.

The portfolio dashboard at the root URL shows all repos side by side with a health table (stars, issues, commits, CI pass rate, community health, vulnerability alerts, dependencies, contributors, tier), compliance campaigns, distribution charts, and a dependency inventory with license concern analysis.

The weekly digest at `/digest.html` is a narrative summary of the most active repos, vulnerability alerts, CI concerns, and dormant repos.

---

## Querying via MCP

If you have Claude Code, you can query repo-butler's data directly using the MCP server:

```bash
claude mcp add repo-butler node /path/to/repo-butler/src/mcp.js
```

Available tools:

`get_health_tier` — Pass a repo name, get back its tier (Gold/Silver/Bronze/None) and a checklist of which checks pass and fail. Example: "What tier is teams-for-linux?"

`get_campaign_status` — Get compliance status for all campaigns across the portfolio. Shows which repos are compliant and which aren't for each campaign (community health, vulnerability free, CI reliability, license, issue templates).

`query_portfolio` — Filter repos by tier. Example: "Show me all Bronze repos."

`get_snapshot_diff` — Compare the current observation against the previous one. Shows what changed since the last pipeline run (issues opened/closed, PRs merged, releases).

`get_governance_findings` — Get the latest governance findings: standards gaps, policy drift, and tier uplift opportunities.

`trigger_refresh` — Trigger a fresh report regeneration. Runs the GitHub Actions workflow asynchronously (~7 minutes). Use after making health improvements to see updated results. Pass `phase: "report"` for dashboards only or `phase: "all"` for the full pipeline.

---

## Health Tiers

Each repo is classified into a tier based on objective criteria. The per-repo report shows a checklist of every check with pass/fail status.

### Gold (all Silver checks + all Gold checks pass)

Gold requires two or more CI workflows, fewer than 10 open issues, a release within the last 90 days, community health above 80%, Dependabot or Renovate configured, and zero critical or high vulnerability alerts.

### Silver (all Silver checks pass)

Silver requires a license file, at least one CI workflow, community health above 50%, and a push within the last 6 months.

### Bronze (at least one Bronze check passes)

Bronze requires either some commit history or a push within the last year.

### How to improve your tier

The per-repo report shows exactly which checks fail. Common fixes:

Missing license — create a `LICENSE` file at the repo root. MIT is the simplest for open-source projects.

No CI workflows — add a `.github/workflows/ci.yml` that runs tests or linting on push and PR.

Low community health — add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates (`.github/ISSUE_TEMPLATE/`), and a PR template (`.github/pull_request_template.md`). Check your repo's Insights > Community page to see exactly which files are missing.

No Dependabot — create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

Add entries for your language ecosystem (`npm`, `gomod`, `pip`) as needed.

No recent release — create one with `gh release create v1.x.x --generate-notes`.

Too many open issues — triage: close stale issues, label blocked ones, resolve what you can.

---

## Campaigns

The portfolio dashboard tracks five compliance campaigns. Each campaign measures a specific standard across all active repos. Your repo appears in a campaign's non-compliant list when it fails the check.

Community Health — community health score >= 80%. Fix by adding community health files (see above).

Vulnerability Free — no critical/high Dependabot alerts. Fix by updating affected dependencies or dismissing alerts with a reason under the Security tab.

CI Reliability — CI pass rate >= 90%. Fix by investigating failing workflows (flaky tests, expired secrets, outdated pinned actions).

License Compliance — a license must be configured. Fix by adding a LICENSE file.

Issue Templates — issue form templates must exist. Fix by creating `.github/ISSUE_TEMPLATE/bug_report.yml` with YAML form syntax.

---

## Governance Findings

The governance engine detects three types of portfolio-level issues.

Standards gaps mean a tool or practice adopted in most repos is missing from yours. The finding tells you which standard and what the adoption rate is (e.g., "issue-form-templates: 14/19 repos compliant"). Adopting the standard brings your repo in line with the rest of the portfolio.

Policy drift means your repo has diverged from the portfolio majority on a key attribute — a different license than the majority, CI pass rate significantly below the portfolio median, or community health that dropped well below the norm. Check whether the drift is intentional or accidental.

Tier uplift means the butler has identified that your repo is close to the next tier with 3 or fewer checks failing. The finding lists exactly which checks need fixing.

---

## License Concerns

The dependency inventory flags copyleft dependencies in repos with permissive licenses (MIT, Apache-2.0, BSD). The dashboard groups concerns by license type and explains the obligation:

GPL-2.0/3.0 requires derivative works to adopt the GPL license. AGPL-3.0 extends this to SaaS usage — even serving the software triggers source disclosure. LGPL-2.1/3.0 is weaker: linking the library is fine but modifications to the library itself must be shared. MPL-2.0 is file-level: only modified files must remain MPL-2.0.

Check whether a flagged dependency is direct (you import it) or transitive (pulled in by something else). Transitive dependencies may have different practical obligations.

---

## How to reference this from your repo

Add this to your repo's `CLAUDE.md`:

```markdown
## Repo Butler

This repo is monitored by [Repo Butler](https://github.com/IsmaelMartinez/repo-butler).

- Dashboard: https://ismaelmartinez.github.io/repo-butler/{repo-name}.html
- Portfolio: https://ismaelmartinez.github.io/repo-butler/
- Consumer guide: https://github.com/IsmaelMartinez/repo-butler/blob/main/docs/fix-guide.md

When working on health improvements, check the per-repo report for the current tier checklist and fix failing checks using the consumer guide.
```
