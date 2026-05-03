# Repo Butler — Roadmap

**Last Updated:** 2026-04-29
**Status:** All phases implemented, reports live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/). Portfolio at 10 Gold + 3 Silver (13 repos); the Silver tier holds `teams-for-linux` (>10 open bugs), `betis-escocia`, and `ai-model-advisor` (both blocked by a critical vuln). Private repos now included via the installation-scoped discovery endpoint.

---

## Vision

Repo Butler is evolving from a reporting tool into a genuine butler — one that not only tells you what your repos need but takes care of it. The positioning is deliberate: don't replicate what Renovate, Dependabot, SonarCloud, or the triage bot already do well. Instead, consume their data, present a unified view, and open PRs to install the tools that are missing. The butler orchestrates; the specialist tools execute.

The competitive landscape confirms this is a unique niche. Implementation agents (Copilot Coding Agent, Sweep, Devin) take known issues and write code. Planning tools (CodeRabbit Issue Planner) produce implementation plans. Project intelligence platforms (Linear AI, OSSInsight, GrimoireLab) either require infrastructure or are SaaS. No tool does the full loop of observe → assess → propose → act across an entire portfolio from a zero-dependency GitHub Action.

## Architecture

```text
OBSERVE → ASSESS → UPDATE → GOVERNANCE → IDEATE → PROPOSE → REPORT
```

1. **OBSERVE** — Gather project state via GitHub API. Portfolio-level classification. Consume data from installed tools. No LLM needed.
2. **ASSESS** — Diff snapshots, compute trends, detect health gaps. Optionally summarise with Gemini Flash.
3. **UPDATE** — Generate an updated roadmap document and open a PR. Safety-validated.
4. **GOVERNANCE** — Run deterministic detectors over the portfolio (standards gaps, policy drift, tier-uplift, stale Dependabot PRs). No LLM cost; runs 4×/day on the daily pipeline.
5. **IDEATE** — Generate improvement ideas informed by triage bot intelligence, health signals, and fresh governance findings.
6. **PROPOSE** — Create GitHub issues from ideas, safety-filtered, capped and labelled.
7. **REPORT** — Generate HTML dashboards for every portfolio repo, deploy to GitHub Pages.

See [ADR-001](docs/decisions/001-repo-butler-vs-triage-bot.md) for the boundary between this project and the triage bot.

## Implemented

All six original phases are working end-to-end with real Gemini API calls validated. The system runs daily at 2am UTC via GitHub Actions cron, generating fresh reports and deploying them to GitHub Pages.

Observing covers open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, and package.json parsing. Portfolio observation classifies all repos by activity level (active, dormant, archive candidate, fork, test).

Assessing persists snapshots on a `repo-butler-data` orphan branch via the Git Data API, computes diffs between runs, and tracks weekly snapshot history for trend analysis. The `computeTrends` function produces a direction signal (growing/shrinking/stable) from up to 12 weeks of data.

Reporting generates per-repo HTML dashboards for every active portfolio repo, with full charts for active repos and lightweight cards for quieter ones. Report caching skips regeneration when the snapshot hash hasn't changed. Multi-repo trend charts store lightweight weekly snapshots per portfolio repo. A safety layer validates all LLM output before publishing. Triage bot integration is optional and auto-discovered. The ASSESS and IDEATE prompts include triage bot intelligence when available.

Phase 1 (Richer Observation) shipped 2026-03-22 via PR #18. Added community health profile, Dependabot vulnerability alerts, CI pass rate, bus factor, and time-to-close median. Portfolio table gained Community, Vulns, and CI% columns. Per-repo reports gained a Repository Health section with five cards. Follow-up fixes: YAML issue template detection (PR #22), search API replaced with list endpoints halving runtime from 26 to 13 minutes (PR #23), open issue counts exclude PRs (PR #24).

Phase 2 (Richer Reports) in progress since 2026-03-23. Open PR triage view (PR #26), issue staleness detection (PR #27), blocked issue context with upstream classification (PR #28). 74 tests, 28 merged PRs.

Security trifecta shipped 2026-04-04 (PR #82). Broadened security assessment from Dependabot-only to three GitHub security scanners: Dependabot alerts, code scanning (CodeQL/SAST), and secret scanning. Gold tier check changed from "Dependabot configured" to "any security scanner configured" with findings checked across all configured scanners. Added `release_exempt` config option for stable repos that don't need frequent releases. Added `getAlertSummary` shared helper for DRY severity computation across observe and portfolio paths.

GitHub App token for vulnerability access shipped 2026-04-04 (PR #83). Switched the main workflow from the default GITHUB_TOKEN to the GitHub App token, granting access to Dependabot alerts, code scanning alerts, and secret scanning alerts APIs across all portfolio repos.

License concern severity tuned 2026-04-04 (PR #84). Replaced blanket red flags for all copyleft with a two-level system: high concern (AGPL, shown in red) and low risk (GPL, LGPL, MPL — collapsed grey summary). Non-commercial projects using permissive licenses are not meaningfully affected by weak copyleft dependencies.

Auto-onboarding shipped 2026-04-04 (PR #85). The pipeline now automatically checks all active portfolio repos after the report phase and opens onboarding PRs for any repo missing the CLAUDE.md consumer guide. Skipped during dry runs.

Bug-only Gold tier shipped 2026-04-06 (PR #90). Gold tier check changed from "Fewer than 20 open issues" to "Fewer than 10 open bugs", classifying issues by label (`bug`/`defect`/`bugfix`). Feature requests and unlabelled issues no longer penalise health.

Node runtime compatibility fixed 2026-04-05 (PRs #87–#88). Resolved `'using: node22' is not supported` errors on some runners by switching `action.yml` to node20, then node24, ensuring compatibility across all GitHub Actions runner versions.

Dashboard narrative restructure spec added 2026-04-07 (PR #91). Multi-persona review identified the dashboards as data dumps lacking narrative flow. Design spec at `docs/superpowers/specs/2026-04-07-dashboard-narrative-restructure-design.md` proposes restructuring both portfolio and per-repo pages around a situation-problem-action arc.

Private repo discovery fixed 2026-04-14. `observePortfolio()` now tries `/installation/repositories` (GitHub App token) and `/user/repos` (PAT) before falling back to the public-only `/users/{owner}/repos` endpoint, so private repos such as `value-punter` appear in the portfolio when the workflow token can see them. Portfolio entries now carry `private` and `visibility` fields.

The GitHub API client handles rate limiting with automatic retry/backoff. Branch protection is enabled on main. CI runs 434 tests and secret-leak checks on every PR.

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

## Next Up

### ~~Dashboard Narrative Restructure~~ SHIPPED

Shipped 2026-04-08 (PRs #93–#100). Restructured both portfolio and per-repo dashboards from data dumps into narrative decision tools following a situation-problem-action arc. Portfolio page: tier distribution pulse, attention required section, simplified health table (Repo, Tier, Issues, PRs, CI%, Vulns, Next Step) with full view behind toggle, collapsible charts and dependency inventory, doughnut charts removed. Per-repo page: health grid merged into tier checklist with inline annotations, trends moved up, Open Work section, collapsible Activity History and Community. Also fixed PRs Merged (90d) data consistency, added issues:read to the GitHub App, and added open PRs column.

### ~~Astro Integration + Dynamic Dashboards~~ SHIPPED

Shipped 2026-04-14. The presentation layer now lives in the personal website (ismaelmartinez.me.uk) as Astro components that consume snapshot JSON from the `repo-butler-data` branch at build time and hydrate interactive islands for live metrics (open PRs, issues) from the GitHub API on page load. Repo-butler remains the data collection layer (zero-dependency GitHub Action producing JSON snapshots). The GitHub Pages reports stay as a standalone fallback.

Research at `docs/research/2026-04-08-dynamic-dashboard-research.md`.

~~Immediate prerequisites: fix report cache invalidation (include template file hashes in cache key so presentation changes auto-deploy), parallelise libyear computation (~30s saving), and implement incremental report generation (skip unchanged repos, cut API calls by ~80%).~~ All three prerequisites shipped 2026-04-13. Cache key now includes `src/report.js` itself. Libyear runs all repos in parallel (was sequential batches of 4). Per-repo detail + chart data cache on the `repo-butler-data` branch skips both `fetchPortfolioDetails` API calls and per-repo chart fetches for unchanged repos (by `pushed_at` + `open_issues_count` comparison).

### Scheduled pipeline wiring

Five of the six main pipeline phases are now wired to triggers: OBSERVE, ASSESS, UPDATE (dry-run), and REPORT run daily via `self-test.yml`, and IDEATE runs weekly via `weekly-ideate.yml` (dry-run). Only PROPOSE remains manual-only. Alongside the main pipeline, MONITOR runs every 6h via `monitor.yml`. `.github/roadmap.yml:6-8` declares `schedule: { assess: daily, ideate: weekly }` — both now match reality. The 2026-04-14 incident where `snapshots/latest.json` had been frozen since 2026-04-03 (because `self-test.yml` defaulted to `phase=report` with no OBSERVE) exposed this gap; the fix landed as commit `9795952` on main. The remaining work is a two-week soak test on UPDATE and IDEATE before graduating either off dry-run.

~~**Wire ASSESS into the daily schedule**~~ — SHIPPED. `self-test.yml` now defaults to `observe,assess,update,report`, so the daily run diffs snapshots, calls the LLM for a narrative, proposes a ROADMAP.md update in dry-run mode, and computes weekly trends. The per-repo report for the butler repo now renders an Assessment section from `context.assessment.assessment` alongside the trend direction from `context.trends`. `schedule.assess: daily` in roadmap.yml is no longer aspirational.

~~**Weekly IDEATE workflow (dry-run first)**~~ — SHIPPED. `.github/workflows/weekly-ideate.yml` runs `observe,ideate` every Monday at 06:00 UTC with `dry-run: true`. No issue or PR writes; governance findings still persist to the `repo-butler-data` branch for the MCP `get_governance_findings` tool. Graduate to `observe,ideate,propose` later once the council output is trusted. Acceptance (pending): governance findings refresh weekly; `get_governance_findings` returns data <7 days old; `schedule.ideate: weekly` matches reality.

~~**UPDATE in dry-run mode on the daily schedule**~~ — SHIPPED. `self-test.yml` now defaults to `observe,assess,update,report`. `src/update.js:33` gates writes behind `dryRun`, so daily CI logs what it *would* change without touching the file. After two weeks of clean soak-test output, UPDATE can graduate to writing PRs by flipping the workflow default to `dry-run: false`. Acceptance: daily CI logs show a proposed ROADMAP.md diff on every run.

**Deliberately out of scope: PROPOSE on a schedule.** PROPOSE creates real GitHub issues (`src/propose.js:172-246`) and has spam-risk blast radius. It stays manual-only until IDEATE has been producing trustworthy council-approved proposals for at least a month. When it graduates, it belongs on `weekly-ideate.yml` (not daily), behind the existing `require_approval: true` flag in roadmap.yml so every issue needs a human label-flip to leave draft status.

### ~~Code Health Sprint — multi-agent simplification review~~ SHIPPED

Shipped 2026-04-28 across PRs #127–#146 (twenty PRs in total, plus the precursor #126 release-tier draft-filter fix). Originated from a four-team subagent review of the whole codebase (~12.5k LOC, 22 source files) that surfaced two correctness bugs and roughly twenty mechanical dedupe opportunities.

Tier 0 (correctness): #127 fixed broken monitor cursor and council watchlist persistence — `loadCursor` was returning `null` unconditionally and `saveCursor` was guarding on a `store.writeFile` method that the store had never exposed, so the every-6h monitor was reporting every open issue/PR/alert as new on every run and the council was re-triaging the same backlog forever. Same root cause for the watchlist. Fixed by adding `readJSON`/`writeJSON` to the store factory and routing both callers through it.

Tier 1 (structural): #128 unified the duplicate campaign definitions between `mcp.js` and `report-portfolio.js` into a shared `CAMPAIGN_DEFS` constant. #130 extracted `buildRepoSnapshot` to replace three drift-prone construction sites that all feed `computeHealthTier`. #129 added `gh.putFile`/`deleteFile` and an optional `{ ref }` to `getFileContent`/`listDir` so `store.js` could drop its hand-rolled `/contents/{path}` blocks and route through the github client. #132 reshaped `src/index.js` from 286 LOC of mixed concerns into a 159-LOC thin dispatcher, with each phase exporting its own `runX(context)` wrapper.

Tier 2 (pattern dedup): #133 collapsed the severity-tally bodies in `observe.js` and the three near-identical scanner blocks in `monitor.js` via the existing `getAlertSummary` helper, extended additively to expose per-severity counts. #134 added a `colorByThreshold` helper used at nine sites across the report files. #131 merged the two LLM providers via a shared `fetchJson` helper in `providers/base.js`. #135 extracted `wrapPrompt` so the `PROMPT_DEFENCE` + `DATA_BOUNDARY_START` scaffolding lives in one place — defence-in-depth as much as simplification.

Tier 3 (local cleanups): #137 collapsed the `mcp.js` 9-arm `callTool` switch by attaching handlers to each tool entry. #141 replaced the hardcoded persona list in `mcp.js` with `import { PERSONAS } from './council.js'`. #142 extracted `bucketVerdicts` for `triageEvents`/`reviewProposals`. #136 extracted `detectMetricDrift` for the CI and community-health drift detectors in `governance.js`. #138 switched `observe.js fetchMergedPRs` from the search API to `gh.paginate('/pulls', { state: closed })`. #139 extracted `pruneDir` for the weekly snapshot rotation. #143 replaced the `parseIdeas` regex pyramid with a field-loop parser. #140 extracted `htmlPage` for the report shell. #144 extracted `buildStatCard` for the repeated repo-health card fragments. #146 promoted `.muted`/`.text-success`/`.text-warning`/`.text-danger` utility classes for the literal-colour inline styles. #145 added `runGitOnDataBranch` (the data-branch reads in `mcp.js` previously hand-rolled the origin/-prefixed → bare ref fallback in two places).

Side outcomes from the sprint: a latent CI bug surfaced and was fixed inside #131 (the `npm test` glob `src/**/*.test.js` only matched the providers subdirectory once subdirectory test files appeared, so CI was silently running 15 tests instead of 496). The `repo-butler-data` per-repo cache schema was bumped to invalidate stale entries when `released_at` shape changed (#126 precursor). Items deliberately left untouched: `config.js` hand-rolled YAML parser (well-scoped to CLAUDE.md's flat + one-level-nested contract), `libyear.js` cohesion (single-purpose, single caller), and any further file splitting (the 5-file report split is intentional).

### ~~Code Health Sprint — deferred follow-ups~~ SHIPPED

All four follow-ups shipped across PRs #149–#152: parseIdeas BODY-then-stop (#149), monitor scanner logging (#150), CSS custom properties (#151), prs_merged_days config wiring (#152).

### ~~Portfolio Hardening Sweep — 2026-04-29~~ SHIPPED

Shipped 2026-05-01. Code-scanning rollout (13/13 repos, security alerts zeroed across portfolio via 10 fix PRs), Dependabot config audit (all repos now have npm + github-actions, 4 PRs merged), and licence policy update (policy-drift-exempt config added in PR #157 whitelisting teams-for-linux GPL-3.0 and bonnie-wee-plot Community Allotment Licence). Zero open vulnerabilities across the portfolio as of snapshot 2026-W18.

### Cross-repo PR automation (follow-up)

The sweep above does by hand what should be automated. The remaining gap, also called out under Phase 5, is:

`governance:apply` — A new pipeline phase or workflow that reads governance findings from `repo-butler-data` and opens templated PRs across affected repos. Standards-gap findings (e.g. "code-scanning enabled on 4/13 repos") should produce one PR per non-compliant repo using a shared workflow template. Requires the GitHub App cross-repo token already noted in Phase 5. Always opt-in via config, always behind `require_approval`, never auto-merge.

`dependabot:audit` — Lightweight monitor pass: which repos lack `.github/dependabot.yml`, which have stale unmerged Dependabot PRs (>30d). Surface in the Governance dashboard section.

### Phase 5 — Portfolio Governance Engine

Replaces the original CARE phase with a broader portfolio governance model. See [ADR-002](docs/decisions/002-portfolio-governance-boundary.md) for the full rationale on why this replaces the generic IDEATE/PROPOSE approach.

The core insight: repo-butler's unique value is the cross-repo view. It sees which tools are configured where, what changed when, and which repos are out of alignment. The IDEATE/PROPOSE phases should generate proposals that only make sense with this portfolio context, not generic per-repo improvement ideas (which the triage bot does better with deeper context).

Detection engine shipped (`src/governance.js`). The pipeline runs `detectStandardsGaps`, `detectPolicyDrift`, and `generateUpliftProposals` after OBSERVE, persists the merged findings to the data branch via `store.writeGovernanceFindings`, feeds them into IDEATE's governance-focused prompt, and exposes them via the MCP `get_governance_findings` tool.

~~**Portfolio policy definition**~~ — SHIPPED. `.github/roadmap.yml` accepts a flat `standards` section; `config.js` transforms it into structured scope/exclusion data for governance.

~~**Standards propagation**~~ — SHIPPED. `detectStandardsGaps` at `src/governance.js:71` checks each applicable repo against built-in detectors (issue-form-templates, contributing-guide, license, dependabot-actions, ci-workflows, code-scanning, secret-scanning), filtered by scope and exclusions.

~~**Policy drift detection**~~ — SHIPPED. `detectPolicyDrift` at `src/governance.js:122` flags license divergence from the ≥80% majority, and CI/community health scores >20pp below the portfolio median.

~~**Health tier uplift proposals**~~ — SHIPPED. `generateUpliftProposals` at `src/governance.js:211` proposes tier uplift when ≤3 checks fail for the next tier, listing exactly which checks to close.

~~**Rewrite IDEATE prompt**~~ — SHIPPED. `buildIdeatePrompt` at `src/ideate.js:34` switches to a portfolio governance advisor persona when governance findings are present and includes full findings via `appendGovernanceContext`.

~~**Governance findings dashboard**~~ — SHIPPED. `buildGovernanceSection` at `src/report-portfolio.js:421` renders a Governance section on the portfolio report with three tables: Standards Gaps (by tool, sorted by adoption rate), Policy Drift (by category), and Tier Uplift Opportunities (silver→gold prioritised, listing remaining checks per repo).

**Cross-repo PR creation** — The remaining gap. Uses a GitHub App (preferred over fine-grained PATs for auto-expiring 1-hour tokens, no manual rotation, and audit trail under the app's identity). Install the app on target repos and use `actions/create-github-app-token` in the workflow. Governance proposals should be opt-in via config and always respect `require_approval` (proposals only, never auto-merge).

~~**Auto-onboarding**~~ — SHIPPED (PR #85). The pipeline automatically checks all active portfolio repos after the report phase and opens onboarding PRs for any repo missing the CLAUDE.md consumer guide. No webhook needed — runs on every daily pipeline execution.

Security prerequisites (from architecture review): ~~bot URL validation~~, ~~ecosystem detection allowlists~~, ~~PR deduplication~~, ~~URL allowlist splitting in safety.js~~, ~~contributor name sanitisation~~, GitHub App for cross-repo auth. Five of six shipped in PRs #63 and #65 (329 tests). Also shipped: LLM prompt injection defence, triage bot response schema validation, governance detection engine.

**Landscape evaluation** — Before building custom cross-repo enforcement, evaluate existing tools for the execution layer. File-based standards propagation (community health files, CI templates) can use `repo-file-sync-action` or `actions-template-sync`. Repo settings propagation (branch protection, labels, teams) can leverage `github/safe-settings` or GitHub org rulesets. Bulk remediation of governance findings can be handled by `multi-gitter` or `git-xargs` as the execution mechanism — the butler detects what needs to change, these tools apply it. See the Landscape section for details.

---

## Future

These are ideas for later evaluation, not commitments.

~~**Libyear dependency freshness**~~ — SHIPPED. Implemented via SBOM data plus npm registry lookups. Shows cumulative dependency age per repo in the portfolio table and per-repo reports.

**External tool metric consumption** — Auto-discover SonarCloud (`.sonarcloud.properties`) or CodeClimate (`.codeclimate.yml`) configurations and pull maintainability grades into the health matrix. Read Renovate's Dependency Dashboard issue to extract pending update counts. All opt-in, following the triage bot auto-discovery pattern. Phase 6 schemas lay the groundwork for structured consumption of these external signals. Also evaluate `ossf/scorecard` as a security health signal — its 0-10 score across 18 dimensions could feed into or complement the health tier model rather than the butler computing its own security metrics.

~~**Contributor funnel**~~ — SHIPPED. `fetchPRAuthors` at `src/report-repo.js:49` marks authors via `pr.author_association === 'FIRST_TIME_CONTRIBUTOR'`. `computeContributorStats` at `src/report-repo.js:147` computes total, first-timers, and contributor confidence ratio (unique contributors / stargazers × 100). Rendered on per-repo reports as three cards: Unique Contributors (90d), First-Time Contributors, Contributor Confidence.

~~**Sparkline mini-charts**~~ — SHIPPED. `generateSparklineSVG` at `src/report-portfolio.js:282` renders per-repo weekly activity inline in the portfolio table rows. Pure SVG, no library.

~~**Campaign view**~~ — SHIPPED. `buildCampaignSection` at `src/report-portfolio.js:318` groups Community Health, Vulnerability Free, CI Reliability, License Compliance, and Issue Templates adoption into progress cards with non-compliant repo lists.

**Skills and documentation review** — Review the research at `docs/research/2026-04-02-skills-and-documentation-landscape.md` and evaluate: distributing per-repo governance findings as Claude Code skills via the onboarding workflow, adding YAML frontmatter to ADRs for machine-parseability, establishing a documentation taxonomy (ADRs, specs, plans, research) consistent across both repo-butler and the triage bot, and pointing CLAUDE.md to relevant ADRs per area ("documentation as system prompt"). The butler's unique skill opportunity is cross-repo findings, not generic documentation — the ETH Zurich study found auto-generated context files reduced task success. Also evaluate the cross-org CLAUDE.md propagation gap as a natural extension of the onboarding workflow.

**Distributable butler skills** — The butler-briefing and butler-debrief skills (`skills/`) currently have hardcoded paths (`~/projects/github/*/`, `IsmaelMartinez/`) and GitHub-specific repo lists. To distribute them as part of repo-butler for other users: read the owner name from `.github/roadmap.yml` config or environment variables, discover project directories dynamically (scan common locations or accept a config path), use the MCP server or snapshot data for repo lists instead of hardcoded names, and make the GitLab MR scanning conditional on `glab` availability. The debrief skill's `~/.claude/history.jsonl` scanning is already generic. Research at `docs/research/2026-04-10-reginald-session-reports.md`.

**Butler-briefing/debrief refresh or retirement** — Now that `butler-apply` and `butler-weekly-review` exist with clearer single-purpose framings, the original butler-briefing and butler-debrief skills feel less useful in practice. Two concrete problems: the names are too similar to each other (which confuses recall — which one runs at session start, which at session end?), and butler-briefing's portfolio-summary panel overlaps with butler-weekly-review's snapshot/tier sections enough that having both is friction. Decide between three options: rename for clarity (e.g. `butler-morning` and `butler-evening` to make the temporal split obvious), redesign one or both to differentiate them more strongly from the governance-oriented weekly-review, or retire one in favour of a single consolidated `butler-status` skill that subsumes briefing + debrief behind a `--time` argument. Tied to the Distributable butler skills entry above — whatever survives this should also be path-genericised in the same pass.

### ~~Phase 6 — Data Contracts + AI Skill~~ SHIPPED

Shipped 2026-03-29 (PR #59). Six JSON Schema 2020-12 definitions in `schemas/v1/` covering snapshot, portfolio, health tiers, config, weekly trends, and enriched portfolio details. Claude Code skill at `docs/skill.md` with 11 eval tests. Schema validation tests in CI. Weekly portfolio snapshots enriched with health tier computation fields. ADR-003 documenting standards choices. 208 tests.

### ~~Phase 7 — MCP Server~~ SHIPPED

Shipped 2026-03-30 (PR #60). Zero-dependency MCP server at `src/mcp.js` (JSON-RPC 2.0 over stdio). Three resources (latest snapshot, portfolio health, campaign status) and four tools on launch: `get_health_tier`, `get_campaign_status`, `query_portfolio`, `get_snapshot_diff`. Later expanded to nine tools: `get_governance_findings`, `trigger_refresh`, `get_monitor_events`, `get_watchlist`, `get_council_personas`. Connect with `claude mcp add repo-butler node src/mcp.js`.

### Phase 8 — A2A Agent Card + Triage Bot Contract

A2A v0.3 Agent Card published at `/.well-known/agent.json` for capability discovery by other agents. A formalised integration contract with the triage bot, defining typed event schemas for the signals the butler consumes (issue intelligence, per-repo health summaries).

~~**Agent Card**~~ — SHIPPED. `src/agent-card.js` builds an A2A AgentCard and the REPORT phase writes it to `reports/.well-known/agent-card.json` so it deploys to Pages at `ismaelmartinez.github.io/repo-butler/.well-known/agent-card.json`. Declares six skills (portfolio-health, governance-findings, campaign-status, snapshot-diff, monitor-events, council-triage), capability flags, provider, and documentation URL. The card is discovery-only for now — the butler's primary programmatic interface remains the MCP server from Phase 7. `supportedInterfaces` stays empty until an A2A transport is actually exposed.

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
