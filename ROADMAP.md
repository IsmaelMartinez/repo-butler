# Repo Butler — Roadmap

**Last Updated:** 2026-03-30
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

**External tool metric consumption** — Auto-discover SonarCloud (`.sonarcloud.properties`) or CodeClimate (`.codeclimate.yml`) configurations and pull maintainability grades into the health matrix. Read Renovate's Dependency Dashboard issue to extract pending update counts. All opt-in, following the triage bot auto-discovery pattern. Phase 6 schemas lay the groundwork for structured consumption of these external signals. Also evaluate `ossf/scorecard` as a security health signal — its 0-10 score across 18 dimensions could feed into or complement the health tier model rather than the butler computing its own security metrics.

**Contributor funnel** — Flag first-time contributors (PR authors whose first-ever merged PR in the repo falls within the observation window). Compute contributor confidence ratio (contributors / stargazers) as a lightweight sustainability indicator.

**Sparkline mini-charts** — Add tiny inline trend lines in the portfolio table rows (26-week activity sparkline per repo) instead of just a number. Implementable with pure SVG, no library.

**Campaign view** — Group improvement ideas and setup PRs into named campaigns on the portfolio dashboard: "License Compliance: 14/19 repos done, 5 need action." Transforms the dashboard from a status display into an active task tracker.

**Skills and documentation review** — Review the research at `docs/research/2026-04-02-skills-and-documentation-landscape.md` and evaluate: distributing per-repo governance findings as Claude Code skills via the onboarding workflow, adding YAML frontmatter to ADRs for machine-parseability, establishing a documentation taxonomy (ADRs, specs, plans, research) consistent across both repo-butler and the triage bot, and pointing CLAUDE.md to relevant ADRs per area ("documentation as system prompt"). The butler's unique skill opportunity is cross-repo findings, not generic documentation — the ETH Zurich study found auto-generated context files reduced task success. Also evaluate the cross-org CLAUDE.md propagation gap as a natural extension of the onboarding workflow.

### Phase 5 — Portfolio Governance Engine

Replaces the original CARE phase with a broader portfolio governance model. See [ADR-002](docs/decisions/002-portfolio-governance-boundary.md) for the full rationale on why this replaces the generic IDEATE/PROPOSE approach.

The core insight: repo-butler's unique value is the cross-repo view. It sees which tools are configured where, what changed when, and which repos are out of alignment. The IDEATE/PROPOSE phases should generate proposals that only make sense with this portfolio context, not generic per-repo improvement ideas (which the triage bot does better with deeper context).

**Portfolio policy definition** — Add a `standards` section to `.github/roadmap.yml` where the maintainer declares what every repo should have. Standards are scope-aware: universal standards apply to all repos (community health files, branch protection, language-agnostic code review tools, Dependabot for GitHub Actions), while ecosystem-specific standards filter by language (npm Renovate only for JavaScript repos, golangci-lint only for Go). Individual repos can be excluded. Without explicit standards, the butler infers conservatively from majority adoption — but only for universal tools, never for ecosystem-specific ones.

**Standards propagation** — Detect when a tool or configuration is adopted in some repos but not all, respecting scope. Generate proposals only for repos where the tool is applicable. Examples: CodeRabbit configured in 5 repos but missing from 14 (universal, applies to all). Issue form templates in 3 repos but 16 using old markdown format (universal). A Go linter workflow adopted in 2 Go repos but missing from 3 others (ecosystem-specific, only targets Go repos).

**Policy drift detection** — Detect when repos that should be aligned have diverged. Examples: 18 repos use MIT but one switched to Apache-2.0. A CI workflow template was updated in the base repo but downstream repos run the old version. A shared CONTRIBUTING.md was revised but copies in other repos are stale.

**Health tier uplift proposals** — Generate concrete proposals to help repos reach the next tier. "repo-x is Silver. To reach Gold: needs a release, CONTRIBUTING.md, and Dependabot. Here are PRs for the latter two."

**Rewrite IDEATE prompt** — Replace the generic "generate improvement ideas" prompt with a governance-focused prompt that receives full portfolio context (tool configs across repos, adoption rates, drift data) and produces standards propagation and drift correction proposals.

Cross-repo PR creation uses a GitHub App (preferred over fine-grained PATs for auto-expiring 1-hour tokens, no manual rotation, and audit trail under the app's identity). Install the app on target repos and use `actions/create-github-app-token` in the workflow. Governance proposals should be opt-in via config and always respect `require_approval` (proposals only, never auto-merge).

**Auto-onboarding via GitHub App** — When the App is installed on a repo, the `installation` webhook triggers the butler to open a welcome PR that adds the consumer guide reference to the repo's CLAUDE.md and configures the MCP server connection. This is the first cross-repo PR use case and serves as the onboarding mechanism for the agent ecosystem. Every repo gets the skill automatically on App installation.

Security prerequisites (from architecture review): ~~bot URL validation~~, ~~ecosystem detection allowlists~~, ~~PR deduplication~~, ~~URL allowlist splitting in safety.js~~, ~~contributor name sanitisation~~, GitHub App for cross-repo auth. Five of six shipped in PRs #63 and #65 (329 tests). Also shipped: LLM prompt injection defence, triage bot response schema validation, governance detection engine.

**Landscape evaluation** — Before building custom cross-repo enforcement, evaluate existing tools for the execution layer. File-based standards propagation (community health files, CI templates) can use `repo-file-sync-action` or `actions-template-sync`. Repo settings propagation (branch protection, labels, teams) can leverage `github/safe-settings` or GitHub org rulesets. Bulk remediation of governance findings can be handled by `multi-gitter` or `git-xargs` as the execution mechanism — the butler detects what needs to change, these tools apply it. See the Landscape section for details.

### ~~Phase 6 — Data Contracts + AI Skill~~ SHIPPED

Shipped 2026-03-29 (PR #59). Six JSON Schema 2020-12 definitions in `schemas/v1/` covering snapshot, portfolio, health tiers, config, weekly trends, and enriched portfolio details. Claude Code skill at `docs/skill.md` with 11 eval tests. Schema validation tests in CI. Weekly portfolio snapshots enriched with health tier computation fields. ADR-003 documenting standards choices. 208 tests.

### ~~Phase 7 — MCP Server~~ SHIPPED

Shipped 2026-03-30 (PR #60). Zero-dependency MCP server at `src/mcp.js` (JSON-RPC 2.0 over stdio). Three resources (latest snapshot, portfolio health, campaign status) and four tools (`get_health_tier`, `get_campaign_status`, `query_portfolio`, `get_snapshot_diff`). 15 MCP-specific tests. Connect with `claude mcp add repo-butler node src/mcp.js`. 223 tests.

### Phase 8 — A2A Agent Card + Triage Bot Contract

A2A v0.3 Agent Card published at `/.well-known/agent.json` for capability discovery by other agents. A formalised integration contract with the triage bot, defining typed event schemas for the signals the butler consumes (issue intelligence, per-repo health summaries).

**Agent Card** — Declares the butler's capabilities (portfolio observation, governance proposals, health tier classification), authentication requirements, and the MCP server endpoint from Phase 7. Follows the A2A v0.3 spec.

**Triage bot contract** — Replace the current implicit auto-discovery with an explicit typed contract. Define `TriageBotEvent` schemas for health summaries and issue signals. Both sides validate against the schema, preventing silent breakage when the triage bot changes its output format.

**Security prerequisites** — ~~Bot URL validation~~, ~~ecosystem detection allowlists~~, ~~PR deduplication~~, ~~URL allowlist splitting~~, ~~LLM prompt injection defence~~, ~~triage bot response validation~~ (all shipped in PR #63). Remaining: GitHub App for cross-repo auth, contributor name sanitisation for CODEOWNERS.

### Phase 9 — AsyncAPI Events

AsyncAPI 3.0 spec describing the event-driven interface for consumers that want push rather than pull. Health-change events and governance-proposal events are published via GitHub `repository_dispatch`, allowing external systems to react without polling the snapshot branch.

**Health-change channel** — Emitted when a repo's health tier changes (Bronze → Silver, etc.). Payload matches the Phase 6 `health-tiers` schema.

**Governance-proposal channel** — Emitted when the butler opens a cross-repo PR or creates a governance issue. Payload includes the proposal type, affected repos, and campaign membership.

**Spec file** — `docs/asyncapi.yml` validated against the AsyncAPI 3.0 schema in CI. Documents message shapes, channel bindings, and the `repository_dispatch` event type used as the transport.

### Phase 10 — Agents and Execution (revised 2026-04-02)

Rather than building a phased agent swarm, agent behaviors are defined via CLAUDE.md files created as needed. The butler's MCP server (Phase 7) is the integration surface — any Claude Code agent can call it. Agents that need cross-portfolio context (enriching synthesis briefings, executing governance proposals, monitoring health across both systems) live here. Agents that do per-repo deep intelligence (triage review, ADR revision, research synthesis) live in the triage bot repo, where the data is.

For the execution layer — propagating configs, installing tools, applying migrations across repos — evaluate existing bulk change tools before building custom solutions. `multi-gitter` and `git-xargs` can run scripts and open PRs across repos. `repo-file-sync-action` can keep files in sync declaratively. `github/safe-settings` can manage repo settings via policy-as-code. `octoherd`'s composable script model is worth studying. The butler's unique contribution is deciding what needs to change (governance findings from Phase 5); the execution of that change should use existing tools where possible. See the Landscape section for details.

## What NOT to build

Cross-platform identity resolution (GitHub + Slack + Discord) — that's Orbit/Common Room territory. File-level code ownership analysis — requires git cloning which breaks the API-only architecture. Natural-language data querying — cool but requires a database. Grafana dashboards — the static HTML approach is the right constraint. Anything that requires self-hosted infrastructure — the zero-cost, zero-dependency positioning is the moat. Per-repo code improvement suggestions — that's the triage bot's domain (see ADR-002).

## Relationship to Other Tools

The butler consumes, it doesn't compete. Renovate handles dependency updates — the butler installs Renovate across the portfolio. Dependabot handles security alerts — the butler reads them and propagates Dependabot config to repos that lack it. The triage bot handles per-issue intelligence and per-repo improvement proposals — the butler reads its trends, configures it on new repos, and focuses on portfolio-level governance. SonarCloud handles code quality — the butler reads its scores. GitHub's community health profile defines the checklist — the butler runs through it across every repo and fixes the gaps.

The boundary is clear: the triage bot goes deep on one repo, the butler goes broad across the portfolio. The triage bot says "issue #47 is a duplicate of #12." The butler says "you adopted CodeRabbit in 5 repos — here are the 14 that should have it too."

## Landscape — Multi-Repo Tools to Evaluate

The butler's unique value is the observe-assess-report loop. The enforcement and remediation side (opening cross-repo PRs, syncing configs, propagating settings) overlaps with mature existing tools. Before building custom solutions in future phases, evaluate whether to use these tools directly, integrate with them, or learn from their approach.

**Bulk change tools** — Clone N repos, run a script in each, open PRs with results. Imperative (you trigger them) rather than continuously observing.

- [multi-gitter](https://github.com/lindell/multi-gitter) — Go CLI, supports GitHub/GitLab/Gitea/Bitbucket, dry-run mode. Evaluate as execution layer for governance proposals from Phase 5 and as alternative to custom agents in Phase 10.
- [git-xargs](https://github.com/gruntwork-io/git-xargs) — Go CLI by Gruntwork, parallel execution with detailed summary reports. Similar to multi-gitter.
- [turbolift](https://github.com/Skyscanner/turbolift) — Go CLI by Skyscanner, more manual workflow (edit repos.txt, run commands, create PRs as separate steps). Good for large-scale migrations.
- [octoherd](https://github.com/octoherd/octoherd) — JavaScript framework, you write a JS function that receives an Octokit instance per repo. Pre-built composable scripts ecosystem. Evaluate as a model for Phase 10's agent design.

**Config sync tools** — Keep files or repository settings in sync declaratively, typically via a GitHub App or Action.

- [github/safe-settings](https://github.com/github/safe-settings) — GitHub App (Probot-based), policy-as-code for repo settings with three-tier hierarchy (org-wide, sub-org, per-repo overrides). Manages branch protections, rulesets, teams, collaborators, labels, environments, custom properties. Evaluate for Phase 5's settings propagation.
- [repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action) — GitHub Action, syncs files/directories from source to target repos by opening PRs when files drift. Configure via sync.yml. Evaluate for Phase 5's community health file propagation (CONTRIBUTING.md, issue templates, PR templates, CI workflow templates).
- [actions-template-sync](https://github.com/AndreasAugustin/actions-template-sync) — GitHub Action, syncs downstream repos with template repository changes. Evaluate for CI workflow template propagation.

**Security and governance enforcement** — Continuously audit repositories against policies and report violations or auto-remediate.

- [ossf/allstar](https://github.com/ossf/allstar) — GitHub App by OpenSSF, continuously checks repo settings against security policies (branch protection, SECURITY.md, outside collaborators). Can file issues, fix settings, or log violations. YAML config in a `.allstar` org repo. Closest existing tool to the butler's observe-and-enforce model, but narrowly focused on security.
- [ossf/scorecard](https://github.com/ossf/scorecard) — Produces a 0-10 security health score across ~18 dimensions (dependency pinning, signed releases, SAST, fuzzing, CI tests). Runs as a GitHub Action. Evaluate as a security signal the butler could ingest into health tier computation.
- [todogroup/repolinter](https://github.com/todogroup/repolinter) — **Archived**. Rule-based repo linting (LICENSE, README, CONTRIBUTING presence) by the TODO Group / Linux Foundation. Worth studying the rule definition approach.

**GitHub native governance** — First-party features that cover some of what custom tooling would build.

- **Organization Rulesets** define branch/tag protection rules at the org level, targeting repos by name pattern, custom properties, or manual selection. Available on Team plans (expanded mid-2025). Rules are additive (repo-level can only be more restrictive). Evaluate before building branch protection propagation in Phase 5.
- **Custom Properties** tag repos with structured metadata (risk level, team, compliance framework) and dynamically target rulesets. Evaluate as an alternative to the butler's own repo classification for governance targeting.
- The [Well-Architected Framework](https://wellarchitected.github.com) provides governance guidance covering rulesets, custom properties, audit log streaming, and CODEOWNERS patterns.
