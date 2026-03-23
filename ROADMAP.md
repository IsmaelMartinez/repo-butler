# Repo Butler — Roadmap

**Last Updated:** 2026-03-23
**Status:** All phases implemented, reports live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/)

---

## Vision

Repo Butler is evolving from a reporting tool into a genuine butler — one that not only tells you what your repos need but takes care of it. The positioning is deliberate: don't replicate what Renovate, Dependabot, SonarCloud, or the triage bot already do well. Instead, consume their data, present a unified view, and open PRs to install the tools that are missing. The butler orchestrates; the specialist tools execute.

The competitive landscape confirms this is a unique niche. Implementation agents (Copilot Coding Agent, Sweep, Devin) take known issues and write code. Planning tools (CodeRabbit Issue Planner) produce implementation plans. Project intelligence platforms (Linear AI, OSSInsight, GrimoireLab) either require infrastructure or are SaaS. No tool does the full loop of observe → assess → propose → act across an entire portfolio from a zero-dependency GitHub Action.

## Architecture

```text
OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE → CARE → REPORT
```

1. **OBSERVE** — Gather project state via GitHub API. Portfolio-level classification. Consume data from installed tools. No LLM needed.
2. **ASSESS** — Diff snapshots, compute trends, detect health gaps. Optionally summarise with Gemini Flash.
3. **UPDATE** — Generate an updated roadmap document and open a PR. Safety-validated.
4. **IDEATE** — Generate improvement ideas informed by triage bot intelligence and health signals.
5. **PROPOSE** — Create GitHub issues from ideas, safety-filtered, capped and labelled.
6. **CARE** — Open setup PRs to install missing tools and fix health gaps. Deterministic, not LLM-generated.
7. **REPORT** — Generate HTML dashboards for every portfolio repo, deploy to GitHub Pages.

See [ADR-001](docs/decisions/001-repo-butler-vs-triage-bot.md) for the boundary between this project and the triage bot.

## Implemented

All six original phases are working end-to-end with real Gemini API calls validated. The system runs daily at 2am UTC via GitHub Actions cron, generating fresh reports and deploying them to GitHub Pages.

Observing covers open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, and package.json parsing. Portfolio observation classifies all repos by activity level (active, dormant, archive candidate, fork, test).

Assessing persists snapshots on a `repo-butler-data` orphan branch via the Git Data API, computes diffs between runs, and tracks weekly snapshot history for trend analysis. The `computeTrends` function produces a direction signal (growing/shrinking/stable) from up to 12 weeks of data.

Reporting generates per-repo HTML dashboards for every active portfolio repo, with full charts for active repos and lightweight cards for quieter ones. Report caching skips regeneration when the snapshot hash hasn't changed. Multi-repo trend charts store lightweight weekly snapshots per portfolio repo. A safety layer validates all LLM output before publishing. Triage bot integration is optional and auto-discovered. The ASSESS and IDEATE prompts include triage bot intelligence when available.

Phase 1 (Richer Observation) shipped 2026-03-22 via PR #18. Added community health profile, Dependabot vulnerability alerts, CI pass rate, bus factor, and time-to-close median to both the OBSERVE phase and the REPORT phase. Portfolio table gained Community, Vulns, and CI% columns. Per-repo reports gained a Repository Health section with five cards. 74 tests, 18 merged PRs.

The GitHub API client handles rate limiting with automatic retry/backoff. Branch protection is enabled on main. CI runs 74 tests and secret-leak checks on every PR.

---

## Roadmap

### ~~Phase 1 — Richer Observation (consume, don't replicate)~~ SHIPPED

Shipped 2026-03-22 (PR #18). Community health profile, Dependabot alerts, CI pass rate, bus factor, time-to-close median. Portfolio table + per-repo health cards.

**GitHub Community Health Profile** — Call `/repos/{owner}/{repo}/community/profile` (one unauthenticated call per public repo) to get a health percentage and presence/absence of README, CODE_OF_CONDUCT, CONTRIBUTING, issue templates, PR template, and LICENSE. Add to the portfolio health matrix as a "Community" column. The API returns structured data that directly maps to a gap checklist for the CARE phase.

**Dependabot Vulnerability Alerts** — Call `/repos/{owner}/{repo}/dependabot/alerts?state=open` to get open security alerts with severity (critical/high/medium/low), affected package, and patched version. Add a "Vulns" column to the health matrix, colour-coded by maximum severity. Requires `vulnerability_alerts: read` scope on the token for cross-repo access.

**CI Workflow Pass Rate** — Call `/repos/{owner}/{repo}/actions/runs?status=completed&per_page=100` and compute `success / (success + failure + cancelled + timed_out)`, excluding skipped runs. Display as a percentage in the health matrix and flag repos below 90% as having flaky CI.

**Time to First Response** — From existing issue data (already fetched), compute the median time between issue creation and the first comment by someone other than the author. This is a CHAOSS standard metric and a key community health signal.

**Bus Factor** — From existing PR author distribution data, compute the minimum number of contributors responsible for 50% of merged PRs. Flag repos where this number is 1-2 as single-maintainer risk.

### Phase 2 — Richer Reports

**Bug fix: release cadence chart** — The "Days between releases" chart shows negative values because the subtraction order is reversed. Fix the date calculation to produce positive intervals.

**Open PR triage view** — The single biggest gap identified from real-world usage. Add a section to per-repo reports showing all open PRs with age, CI status, review state, and actionability classification (merge candidate, needs CI fix, needs author rework, stale). Data available from `/repos/{owner}/{repo}/pulls?state=open`. This turns the report from a status dashboard into a triage tool. Three PRs on teams-for-linux were ready to merge with no review blockers — the report didn't surface this.

**Issue staleness detection** — Flag "awaiting user feedback" issues by how long they've been waiting. Issues stale for 30+ days should be highlighted prominently. Real-world example: teams-for-linux had an issue at 561 days stale that should have been auto-closed long ago. Could also surface a "reporter responsiveness" metric — percentage of issues where the reporter replied after the first maintainer response.

**Blocked issue context** — Show what issues are blocked on, not just that they're blocked. Distinguish "blocked: upstream" (Electron/Chromium issues the maintainer cannot fix) from "blocked: internal dependency" (work that depends on other issues being resolved). Five of six blocked issues on teams-for-linux were upstream — this changes how a maintainer prioritises their backlog.

**Calendar heatmap** — Add a GitHub-style calendar heatmap (pure CSS grid, no library) to per-repo pages using the weekly participation data already fetched. This is the single most recognisable visualisation in developer tooling.

**PR cycle time** — Display median time from PR open to merge alongside the PR count chart, with benchmark indicators (under 2 hours = elite, under 24 hours = good, over 48 hours = needs attention). Data available from the search API.

**Issue velocity imbalance alert** — When issues opened exceed issues closed for 3+ consecutive months, flag it prominently in the report as a backlog pressure warning. Data already collected.

**Narrative weekly digest** — A "story mode" recap page that presents changes card-by-card: "This week: 3 repos had new releases, teams-for-linux closed 12 issues, 2 repos dropped below Silver." Inspired by GitHub Wrapped and Stepsize's data storytelling. Could optionally be posted as a GitHub Discussion.

**Embeddable SVG health badge** — Generate a standalone SVG badge showing the repo's health tier that can be embedded in README files. Extends repo-butler's reach beyond the Pages site.

**SBOM-based dependency inventory** — Use GitHub's SBOM endpoint (`/repos/{owner}/{repo}/dependency-graph/sbom`) to get the full dependency graph per repo, then cross-reference across the portfolio. Surface "lodash is used in 7/19 repos" and flag dependency license conflicts. No external tool needed.

**AI agent actionability score** — Since repo-butler generates reports that AI agents consume, add a "what to do next" section with concrete actions ranked by effort/impact. Example output: "1. Merge #2193, #2319, #2331 — all CI green, no review blockers. 2. Investigate CI failures on #2329, #2357. 3. Close stale awaiting-feedback issues." This turns the report from a dashboard into a task list.

### Phase 3 — Tiered Health Model

Replace the green/yellow/red health dot with a structured maturity model inspired by Backstage Soundcheck and Port.io scorecards.

**Gold tier** — has CI workflows, a license, fewer than 10 open issues, a release in the last 90 days, community health profile above 80%, Dependabot or Renovate configured, zero critical/high vulnerability alerts. Gold repos are healthy and well-maintained.

**Silver tier** — has CI and a license, community health profile above 50%, some activity in the last 6 months. Silver repos are maintained but have gaps.

**Bronze tier** — has some activity. Bronze repos are alive but need attention.

Each tier shows pass/fail criteria as a checklist on the per-repo report, telling the maintainer exactly what to do next. The portfolio page shows tier badges instead of dots.

### Phase 4 — Structured Issue Specs

When the IDEATE/PROPOSE phases generate issues, format them with a "current state / proposed state" specification inspired by Copilot Workspace. Each issue includes which files are likely affected, what patterns exist, and a clear scope statement. This makes repo-butler's output directly consumable by implementation agents — Copilot Coding Agent, Sweep, or a human developer can pick up the issue and know exactly what to do.

Include a rationale section in each proposed issue explaining which signals triggered the suggestion (e.g., "this idea was triggered by 5 issues mentioning screen sharing in the last month with no matching roadmap coverage"). Inspired by Linear's triage intelligence transparency.

Check for existing similar issues before creating new ones (duplicate detection via title similarity) to prevent the butler from proposing work that already exists in the backlog.

### Consumer Packaging

Bundle with `ncc` so other people can `uses: IsmaelMartinez/repo-butler@v1` without checking out the source. Currently the `action.yml` points at raw `src/index.js` which requires the consumer to have Node 22 and all source files in the action's directory. This is a prerequisite for other people actually using the butler.

---

## Future

These are ideas for later evaluation, not commitments.

**Libyear dependency freshness** — Using SBOM data plus npm/PyPI registry lookups, compute the cumulative age of each repo's dependencies versus their latest versions. A single number per repo answering "how stale are the dependencies?"

**External tool metric consumption** — Auto-discover SonarCloud (`.sonarcloud.properties`) or CodeClimate (`.codeclimate.yml`) configurations and pull maintainability grades into the health matrix. Read Renovate's Dependency Dashboard issue to extract pending update counts. All opt-in, following the triage bot auto-discovery pattern.

**Contributor funnel** — Flag first-time contributors (PR authors whose first-ever merged PR in the repo falls within the observation window). Compute contributor confidence ratio (contributors / stargazers) as a lightweight sustainability indicator.

**Sparkline mini-charts** — Add tiny inline trend lines in the portfolio table rows (26-week activity sparkline per repo) instead of just a number. Implementable with pure SVG, no library.

**Campaign view** — Group improvement ideas and setup PRs into named campaigns on the portfolio dashboard: "License Compliance: 14/19 repos done, 5 need action." Transforms the dashboard from a status display into an active task tracker.

### Phase 5 — The CARE Phase (setup PRs for missing tools)

Deferred from the original Phase 2 position. Needs a design pass to make it generic and configurable rather than opinionated about specific tools. The current design hardcodes Dependabot over Renovate, MIT license, specific issue template formats, and a specific workflow (PRs from a PAT). A generic version would need configurable tool preferences, pluggable templates, and a rule engine for "what's missing" rather than hardcoded checks.

The core idea remains: detect what each repo is missing and open PRs to fix it. Every PR is deterministic (template-based, not LLM-generated), labelled `repo-butler` and `setup`, and never merged automatically. Targets include dependency management config, issue templates, CONTRIBUTING guide, CODEOWNERS, triage bot config, license files, and any other gap detected by the community health profile.

Cross-repo PR creation requires either a fine-grained PAT with `contents: write` and `pull_requests: write` scoped to the target repos, or a GitHub App. The CARE phase should be opt-in via config and always respect `require_approval` (PRs only, never auto-merge).

Security prerequisites (from architecture review): bot URL validation, ecosystem detection allowlists, PR deduplication, URL allowlist splitting in safety.js, separate cross-repo PAT, contributor name sanitisation for CODEOWNERS.

## What NOT to build

Cross-platform identity resolution (GitHub + Slack + Discord) — that's Orbit/Common Room territory. File-level code ownership analysis — requires git cloning which breaks the API-only architecture. Natural-language data querying — cool but requires a database. Grafana dashboards — the static HTML approach is the right constraint. Anything that requires self-hosted infrastructure — the zero-cost, zero-dependency positioning is the moat.

## Relationship to Other Tools

The butler consumes, it doesn't compete. Renovate handles dependency updates — the butler installs Renovate. Dependabot handles security alerts — the butler reads them and surfaces them in the dashboard. The triage bot handles per-issue intelligence — the butler reads its trends and configures it on new repos. SonarCloud handles code quality — the butler reads its scores. GitHub's community health profile defines the checklist — the butler runs through it and fixes the gaps.

The value is the unified view and the agency to act. No other tool sees the whole portfolio, understands what's missing, and opens PRs to fix it.
