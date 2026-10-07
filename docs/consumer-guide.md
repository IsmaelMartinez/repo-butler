# Skill: repo-butler-consumer

## What is Repo Butler?

Repo Butler is a portfolio health agent that monitors all repos under the `IsmaelMartinez` GitHub account. It runs four times a day as a GitHub Action, observes each repo's health signals via the GitHub API, and produces HTML dashboards, health tier classifications, and governance findings.

Most of what it does is report, but it can change your repo. File changes always arrive as a pull request, never a direct push, and come in three kinds: an onboarding PR that adds the Repo Butler section to your `CLAUDE.md`, remediation PRs from its Governance Apply path for gaps such as a missing `SECURITY.md`, `CODEOWNERS`, Dependabot config or CodeQL workflow, and a stale-lockfile refresh for security alerts. A weekly scheduled run opens those remediation PRs for a small allow-listed set of finding classes, and for a few of the lowest-risk templates it merges its own PR once CI is green. Closing one of its PRs unmerged is read as a decline: it will not re-open that PR for thirty days. The same path can also switch on two repository settings, the Copilot code review ruleset and GitHub's Dependabot security updates. [`docs/architecture.md`](architecture.md#workflow-choreography) has the full detail.

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

`get_weekly_trend` — Up to twelve weeks of health metrics (open issues, CI pass rate, community health, tier) for one repo, or portfolio-wide when no repo is given.

`get_governance_findings` — The latest governance findings of every type (see [Governance Findings](#governance-findings) below), with summary counts and week-over-week trends.

`get_open_governance_prs` — The butler's outstanding `repo-butler/apply-*` remediation PRs across the portfolio.

`list_stale_dependabot_prs` — Dependabot PRs that have been open longer than a minimum age.

`trigger_refresh` — Trigger a fresh report regeneration. Runs the GitHub Actions workflow asynchronously (~7 minutes). Use after making health improvements to see updated results. Pass `phase: "report"` for dashboards only or `phase: "all"` for the full pipeline.

`get_monitor_events` — Events the monitor detected between pipeline runs (new issues and PRs, security alerts, CI failures), filterable by minimum severity.

`get_watchlist` — Proposals and events the agent council put on watch pending more evidence.

`get_council_personas` — The five council personas and the perspective each brings.

---

## Health Tiers

Each repo is classified into a tier based on objective criteria. The per-repo report shows a checklist of every check with pass/fail status.

### Gold (all Silver checks + all Gold checks pass)

Gold requires two or more CI workflows, fewer than 10 open bugs (open issues carrying a bug label such as `bug` or `type: bug`, not counting ones labelled blocked; when bug counts cannot be read the check falls back to fewer than 20 open issues), a release within the last 90 days (waived for repos marked release-exempt), community health of at least 80%, at least one security scanner whose alerts the butler can read (Dependabot alerts, code scanning, or secret scanning), and no critical or high Dependabot or code-scanning alerts and no open secret-scanning alerts.

### Silver (all Silver checks pass)

Silver requires a license file, at least one CI workflow, community health of at least 50%, and a push within the last 6 months.

### Bronze (at least one Bronze check passes)

Bronze requires either some commit history or a push within the last year.

### Provisional tiers

When a security scanner's alerts could not be read and that is the only thing between a repo and Gold, the repo's tier is provisional: it is held below Gold because Gold is never awarded without evidence, but nothing observed it fall short either. The dashboard, the per-repo page and the README badge show it as Unconfirmed, keep it out of the tier mix, Gold % and the portfolio badge, and never call its security posture clean while the scanner is unread. The MCP tools flag this as `tier_provisional: true`, count such repos as `tier_unknown` rather than in a tier, and `query_portfolio` accepts `tier: "provisional"` to list them. The next successful read settles the tier.

### How to improve your tier

The per-repo report shows exactly which checks fail. Common fixes:

Missing license — create a `LICENSE` file at the repo root. MIT is the simplest for open-source projects.

No CI workflows — add a `.github/workflows/ci.yml` that runs tests or linting on push and PR.

Low community health — add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates (`.github/ISSUE_TEMPLATE/`), and a PR template (`.github/pull_request_template.md`). Check your repo's Insights > Community page to see exactly which files are missing.

No security scanning — enable Dependabot alerts (and ideally code scanning and secret scanning) in the repo's Security settings, and add a `.github/dependabot.yml` so updates are proposed as PRs:

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

Too many open bugs — triage: close stale ones, label blocked ones, resolve what you can.

Open security findings — merge or rebase the pending Dependabot PRs, update the affected dependency, or dismiss an alert with a reason under the Security tab.

---

## Campaigns

The portfolio dashboard tracks five compliance campaigns. Each campaign measures a specific standard across all active repos. Your repo appears in a campaign's non-compliant list when it fails the check.

Community Health — community health score >= 80%. Fix by adding community health files (see above).

Vulnerability Free — no critical/high Dependabot alerts. Fix by updating affected dependencies or dismissing alerts with a reason under the Security tab.

CI Reliability — CI pass rate >= 90%. Fix by investigating failing workflows (flaky tests, expired secrets, outdated pinned actions).

License Compliance — a license must be configured. Fix by adding a LICENSE file.

Issue Templates — at least one issue template must exist. Fix by creating `.github/ISSUE_TEMPLATE/bug_report.yml` (a YAML issue form is the portfolio's preferred shape).

---

## Governance Findings

The governance engine produces eight types of finding. It runs four times a day and needs no LLM, so findings are always current.

Standards gaps mean a tool or practice adopted in most repos is missing from yours. The finding tells you which standard and what the adoption rate is (e.g., "issue-form-templates: 14/19 repos compliant"). Adopting the standard brings your repo in line with the rest of the portfolio.

Policy drift means your repo has diverged from the portfolio majority on a key attribute — a different license than the majority, CI pass rate significantly below the portfolio median, or community health that dropped well below the norm. Check whether the drift is intentional or accidental.

Tier uplift means the butler has identified that your repo is close to the next tier with 3 or fewer checks failing. The finding lists exactly which checks need fixing.

Tier regression means your repo's tier fell since the previous weekly snapshot. The companion tier-uplift finding names the checks that would bring it back.

Open vulnerability means the repo has an open critical or high Dependabot or code-scanning alert, or any secret-scanning alert. For Dependabot-sourced findings it also says whether GitHub's automated security fixes are switched on and driving the fix.

Stalled alert means a Dependabot alert of medium severity or above has been open for more than 14 days with no Dependabot PR addressing it, and the finding classifies why it is stuck (for example `reachable-by-update`, meaning a lockfile refresh alone would clear it).

Stale Dependabot PR means a dependency update PR has been open for more than 30 days without being merged.

Stale butler PR means a pull request the butler itself opened on your repo has not landed, with its CI state so you can tell a PR waiting on you from one that is blocked.

---

## License Concerns

The dependency inventory flags copyleft dependencies in repos with permissive licenses (MIT, Apache-2.0, BSD). The dashboard groups concerns by license type and explains the obligation:

GPL-2.0/3.0 requires derivative works to adopt the GPL license. AGPL-3.0 extends this to SaaS usage — even serving the software triggers source disclosure. LGPL-2.1/3.0 is weaker: linking the library is fine but modifications to the library itself must be shared. MPL-2.0 is file-level: only modified files must remain MPL-2.0.

Check whether a flagged dependency is direct (you import it) or transitive (pulled in by something else). Transitive dependencies may have different practical obligations.

---

## Portfolio conventions

These are conventions repo-butler reads as the single source of truth across the portfolio. Set them once per repo; the dashboards, agent card, and MCP responses all consume the same fields.

### Deployed-page URL

If your repo deploys a page (GitHub Pages, Vercel, Netlify, Cloudflare Pages, custom domain, anything else), set the GitHub repository `homepage` field to its canonical URL. The portfolio dashboard, per-repo dashboard, and agent card surface that URL directly. There is no fallback discovery — if `homepage` is unset, no link surfaces.

Set it via repo Settings → "Website" or via the API:

```bash
gh api -X PATCH repos/{owner}/{repo} -f homepage="https://example.com"
```

For GitHub Pages repos the canonical URL is the value returned by `gh api repos/{owner}/{repo}/pages --jq .html_url`.

---

## How to reference this from your repo

The onboarding PR adds a fuller version of this section for you. To add it by hand instead, put this in your repo's `CLAUDE.md`:

```markdown
## Repo Butler

This repo is monitored by [Repo Butler](https://github.com/IsmaelMartinez/repo-butler).

- Dashboard: https://ismaelmartinez.github.io/repo-butler/{repo-name}.html
- Portfolio: https://ismaelmartinez.github.io/repo-butler/
- Consumer guide: https://github.com/IsmaelMartinez/repo-butler/blob/main/docs/consumer-guide.md

When working on health improvements, check the per-repo report for the current tier checklist and fix failing checks using the consumer guide.

If this repo deploys a page, set its GitHub repository Homepage URL (the Website field in the repo's About section — not `package.json`'s `homepage`) to the canonical URL. That's how repo-butler surfaces the deployed link in dashboards and agent cards.
```
