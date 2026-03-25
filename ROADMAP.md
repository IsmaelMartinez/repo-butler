# Repo Butler — Roadmap

**Last Updated:** 2026-03-23
**Status:** All phases implemented, reports live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/)

---

## Vision

Repo Butler is evolving from a reporting tool into a genuine butler — one that not only tells you what your repos need but takes care of it. The positioning is deliberate: don't replicate what Renovate, Dependabot, SonarCloud, or the triage bot already do well. Instead, consume their data, present a unified view, and open PRs to install the tools that are missing. The butler orchestrates; the specialist tools execute.

The competitive landscape confirms this is a unique niche. Implementation agents (Copilot Coding Agent, Sweep, Devin) take known issues and write code. Planning tools (CodeRabbit Issue Planner) produce implementation plans. Project intelligence platforms (Linear AI, OSSInsight, GrimoireLab) either require infrastructure or are SaaS. No tool does the full loop of observe → assess → propose → act across an entire portfolio from a zero-dependency GitHub Action.

## Architecture

```text
OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE → REPORT
```

1. **OBSERVE** — Gather project state via GitHub API. Portfolio-level classification. Consume data from installed tools. No LLM needed.
2. **ASSESS** — Diff snapshots, compute trends, detect health gaps. Optionally summarise with Gemini Flash.
3. **UPDATE** — Generate an updated roadmap document and open a PR. Safety-validated.
4. **IDEATE** — Generate improvement ideas informed by triage bot intelligence and health signals.
5. **PROPOSE** — Create GitHub issues from ideas, safety-filtered, capped and labelled.
6. **REPORT** — Generate HTML dashboards for every portfolio repo, deploy to GitHub Pages.

See [ADR-001](docs/decisions/001-repo-butler-vs-triage-bot.md) for the boundary between this project and the triage bot.

## Implemented

All six original phases are working end-to-end with real Gemini API calls validated. The system runs daily at 2am UTC via GitHub Actions cron, generating fresh reports and deploying them to GitHub Pages.

Observing covers open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, and package.json parsing. Portfolio observation classifies all repos by activity level (active, dormant, archive candidate, fork, test).

Assessing persists snapshots on a `repo-butler-data` orphan branch via the Git Data API, computes diffs between runs, and tracks weekly snapshot history for trend analysis. The `computeTrends` function produces a direction signal (growing/shrinking/stable) from up to 12 weeks of data.

Reporting generates per-repo HTML dashboards for every active portfolio repo, with full charts for active repos and lightweight cards for quieter ones. Report caching skips regeneration when the snapshot hash hasn't changed. Multi-repo trend charts store lightweight weekly snapshots per portfolio repo. A safety layer validates all LLM output before publishing. Triage bot integration is optional and auto-discovered. The ASSESS and IDEATE prompts include triage bot intelligence when available.

Phase 1 (Richer Observation) shipped 2026-03-22 via PR #18. Added community health profile, Dependabot vulnerability alerts, CI pass rate, bus factor, and time-to-close median. Portfolio table gained Community, Vulns, and CI% columns. Per-repo reports gained a Repository Health section with five cards. Follow-up fixes: YAML issue template detection (PR #22), search API replaced with list endpoints halving runtime from 26 to 13 minutes (PR #23), open issue counts exclude PRs (PR #24).

Phase 2 (Richer Reports) in progress since 2026-03-23. Open PR triage view (PR #26), issue staleness detection (PR #27), blocked issue context with upstream classification (PR #28). 74 tests, 28 merged PRs.

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

### ~~Phase 2 — Richer Reports~~ SHIPPED

Shipped 2026-03-24 (PRs #23–#37). All 10 items complete: release cadence bug fix, open PR triage view, issue staleness detection, blocked issue context, calendar heatmap, PR cycle time, issue velocity imbalance alert, narrative weekly digest, embeddable SVG health badges, SBOM dependency inventory, and AI agent actionability score. 105 tests.

### ~~Phase 3 — Tiered Health Model~~ SHIPPED

Shipped 2026-03-24 (PR #39). Replaced the numeric health score with Gold/Silver/Bronze tiers. Each tier has explicit pass/fail criteria shown as a checklist on per-repo reports. Portfolio table shows tier badges. SVG badges updated with tier names. 119 tests.

### ~~Phase 4 — Structured Issue Specs~~ SHIPPED

Shipped 2026-03-24 (PRs #41–#42). IDEATE now requests structured specs (current/proposed state, affected files, scope, signal rationale). PROPOSE builds rich markdown issue bodies and uses Jaccard similarity duplicate detection (threshold 0.6) before creating issues. Backward compatible with old-format LLM output. 27 new tests across ideate.test.js and propose.test.js.

### ~~Consumer Packaging~~ SHIPPED

Shipped 2026-03-24. No `ncc` bundling needed — the project has zero npm dependencies, so GitHub Actions' native `node22` runtime runs `src/index.js` directly. The `action.yml` already declares `using: 'node22'` and `main: 'src/index.js'`, which is all that's required. Consumers reference the action as `uses: IsmaelMartinez/repo-butler@v1`. Dependabot is configured for the `github-actions` ecosystem to keep workflow dependencies current. README includes Usage, Quick Start, and Configuration sections for consumers.

---

## Future

These are ideas for later evaluation, not commitments.

**Libyear dependency freshness** — Using SBOM data plus npm/PyPI registry lookups, compute the cumulative age of each repo's dependencies versus their latest versions. A single number per repo answering "how stale are the dependencies?"

**External tool metric consumption** — Auto-discover SonarCloud (`.sonarcloud.properties`) or CodeClimate (`.codeclimate.yml`) configurations and pull maintainability grades into the health matrix. Read Renovate's Dependency Dashboard issue to extract pending update counts. All opt-in, following the triage bot auto-discovery pattern.

**Contributor funnel** — Flag first-time contributors (PR authors whose first-ever merged PR in the repo falls within the observation window). Compute contributor confidence ratio (contributors / stargazers) as a lightweight sustainability indicator.

**Sparkline mini-charts** — Add tiny inline trend lines in the portfolio table rows (26-week activity sparkline per repo) instead of just a number. Implementable with pure SVG, no library.

**Campaign view** — Group improvement ideas and setup PRs into named campaigns on the portfolio dashboard: "License Compliance: 14/19 repos done, 5 need action." Transforms the dashboard from a status display into an active task tracker.

### Phase 5 — Portfolio Governance Engine

Replaces the original CARE phase with a broader portfolio governance model. See [ADR-002](docs/decisions/002-portfolio-governance-boundary.md) for the full rationale on why this replaces the generic IDEATE/PROPOSE approach.

The core insight: repo-butler's unique value is the cross-repo view. It sees which tools are configured where, what changed when, and which repos are out of alignment. The IDEATE/PROPOSE phases should generate proposals that only make sense with this portfolio context, not generic per-repo improvement ideas (which the triage bot does better with deeper context).

**Portfolio policy definition** — Add a `standards` section to `.github/roadmap.yml` where the maintainer declares what every repo should have. Standards are scope-aware: universal standards apply to all repos (community health files, branch protection, language-agnostic code review tools, Dependabot for GitHub Actions), while ecosystem-specific standards filter by language (npm Renovate only for JavaScript repos, golangci-lint only for Go). Individual repos can be excluded. Without explicit standards, the butler infers conservatively from majority adoption — but only for universal tools, never for ecosystem-specific ones.

**Standards propagation** — Detect when a tool or configuration is adopted in some repos but not all, respecting scope. Generate proposals only for repos where the tool is applicable. Examples: CodeRabbit configured in 5 repos but missing from 14 (universal, applies to all). Issue form templates in 3 repos but 16 using old markdown format (universal). A Go linter workflow adopted in 2 Go repos but missing from 3 others (ecosystem-specific, only targets Go repos).

**Policy drift detection** — Detect when repos that should be aligned have diverged. Examples: 18 repos use MIT but one switched to Apache-2.0. A CI workflow template was updated in the base repo but downstream repos run the old version. A shared CONTRIBUTING.md was revised but copies in other repos are stale.

**Health tier uplift proposals** — Generate concrete proposals to help repos reach the next tier. "repo-x is Silver. To reach Gold: needs a release, CONTRIBUTING.md, and Dependabot. Here are PRs for the latter two."

**Rewrite IDEATE prompt** — Replace the generic "generate improvement ideas" prompt with a governance-focused prompt that receives full portfolio context (tool configs across repos, adoption rates, drift data) and produces standards propagation and drift correction proposals.

Cross-repo PR creation requires either a fine-grained PAT with `contents: write` and `pull_requests: write` scoped to the target repos, or a GitHub App. Governance proposals should be opt-in via config and always respect `require_approval` (proposals only, never auto-merge).

Security prerequisites (from architecture review): bot URL validation, ecosystem detection allowlists, PR deduplication, URL allowlist splitting in safety.js, separate cross-repo PAT, contributor name sanitization for CODEOWNERS.

## What NOT to build

Cross-platform identity resolution (GitHub + Slack + Discord) — that's Orbit/Common Room territory. File-level code ownership analysis — requires git cloning which breaks the API-only architecture. Natural-language data querying — cool but requires a database. Grafana dashboards — the static HTML approach is the right constraint. Anything that requires self-hosted infrastructure — the zero-cost, zero-dependency positioning is the moat. Per-repo code improvement suggestions — that's the triage bot's domain (see ADR-002).

## Relationship to Other Tools

The butler consumes, it doesn't compete. Renovate handles dependency updates — the butler installs Renovate across the portfolio. Dependabot handles security alerts — the butler reads them and propagates Dependabot config to repos that lack it. The triage bot handles per-issue intelligence and per-repo improvement proposals — the butler reads its trends, configures it on new repos, and focuses on portfolio-level governance. SonarCloud handles code quality — the butler reads its scores. GitHub's community health profile defines the checklist — the butler runs through it across every repo and fixes the gaps.

The boundary is clear: the triage bot goes deep on one repo, the butler goes broad across the portfolio. The triage bot says "issue #47 is a duplicate of #12." The butler says "you adopted CodeRabbit in 5 repos — here are the 14 that should have it too."
