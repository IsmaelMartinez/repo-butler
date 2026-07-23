# Repo Butler — Roadmap

**Last Updated:** 2026-07-23
**Status:** All phases implemented, reports live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/). Portfolio at 14 Gold (14 repos) as of W22; `teams-for-linux` re-graduated to Gold at 9 open bugs. Zero portfolio vulnerabilities. UPDATE phase live with section-edit mode (Gemini 3.5 Flash). Private repos included via the installation-scoped discovery endpoint. ADR-007 Track B stages 1–2 shipped: every governance finding carries a remediation plan (executor hint + change spec) and the apply phase plus the repo-butler-apply skill route findings by that executor.

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

License concern severity shipped 2026-04-04 (PR #84). Replaced blanket red flags for all copyleft with a two-level system: high concern (AGPL, shown in red) and low risk (GPL, LGPL, MPL — collapsed grey summary). Non-commercial projects using permissive licenses are not meaningfully affected by weak copyleft dependencies.

Auto-onboarding shipped 2026-04-04 (PR #85). The pipeline now automatically checks all active portfolio repos after the report phase and opens onboarding PRs for any repo missing the CLAUDE.md consumer guide. Skipped during dry runs.

Bug-only Gold tier shipped 2026-04-06 (PR #90). Gold tier check changed from "Fewer than 20 open issues" to "Fewer than 10 open bugs", classifying issues by label (`bug`/`defect`/`bugfix`). Feature requests and unlabelled issues no longer penalise health.

Node runtime compatibility fixed 2026-04-05 (PRs #87–#88). Resolved `'using: node22' is not supported` errors on some runners by switching `action.yml` to node20, then node24, ensuring compatibility across all GitHub Actions runner versions.

Dashboard narrative restructure spec added 2026-04-07 (PR #91). Multi-persona review identified the dashboards as data dumps lacking narrative flow. The restructure shipped across PRs #93–#100, reframing both portfolio and per-repo pages around a situation-problem-action arc.

Private repo discovery fixed 2026-04-14. `observePortfolio()` now tries `/installation/repositories` (GitHub App token) and `/user/repos` (PAT) before falling back to the public-only `/users/{owner}/repos` endpoint, so private repos such as `value-punter` appear in the portfolio when the workflow token can see them. Portfolio entries now carry `private` and `visibility` fields.

The GitHub API client handles rate limiting with automatic retry/backoff. Branch protection is enabled on main. CI runs 711 tests and secret-leak checks on every PR.


Section-edit mode shipped 2026-05-26 (PR #231). Upgraded the core LLM update mechanism so the model emits structured JSON operations rather than rewriting full documents, reducing token consumption, eliminating truncation errors, and guaranteeing deterministic application of roadmap updates.

GitHub ID bridging mechanism shipped 2026-05-27 (PR #235). Upgraded the core repository metadata model to bridge repository renames using stable GitHub IDs, securing data integrity and preventing historical data loss when external GitHub repositories are renamed.

Roadmap PR noise reduction shipped 2026-06-12 (PR #263). Refined the automated update workflow to skip opening pull requests when changes are limited solely to date-only updates, significantly reducing automated volume and noise during routine maintenance runs.

Roadmap scheduled action and reference append optimizations shipped 2026-06-13 (PRs #265 and #266). Refined the core roadmap update mechanisms to optimize scheduled actions and reference appending logic, ensuring cleaner maintenance cycles and robust long-term planning alignment.

Automated security markdown merges enabled 2026-06-16 (PR #278). Implemented ADR-007 stage 5 auto-merge capabilities for security-related markdown files, streamlining repository governance and automating routine maintenance tasks.

CI pipeline reliability fix shipped 2026-06-16 (PR #280). Resolved false-positive failures on cache hits to guarantee stable CI runs. Documentation updated to reflect the go-live of ADR-009 and direct users to Copilot (PR #279).

Automated ADR-007 stage 5 merge capabilities for code owners shipped 2026-06-16 (PR #282), automating the merge process for security-related markdown files and streamlining repository governance.

Automated ADR-007 stage 5 merge capabilities for code scanning alerts shipped 2026-06-17 (PR #284), enabling auto-merge for code-scanning alerts to streamline repository governance and optimize automated security workflows.

AsyncAPI event-driven interface core shipped 2026-06-18 (PR #286). Implemented Phase 9 of ADR-008, introducing the pure, GitHub-free tier-change detection core (`src/tier-change.js`) to diff computed repository health tiers against the last-emitted state and prepare single-transition event payloads.

Calm & adaptive portfolio dashboard (round two) shipped 2026-06-19 (PR #288). Reframed the main front page around a state-driven status hero, a week-over-week Gold trend, and a "Since the last run" delta strip highlighting tier and security posture changes, while big reference tables collapse gracefully for repos meeting the Gold standard.

Scene-of-the-day comic briefing skill shipped 2026-06-20 (PR #291). Enhanced the core briefing functionality and user experience by introducing a daily comic feature to the repo-butler briefing output.

Cross-repo PROPOSE safety gates shipped 2026-06-22 (PRs #298 and #299). Hardened multi-repository routing boundaries and security logic by implementing G3 and G4 safety gates, which enforce deterministic routing and reject cross-reference autolinks in cross-repo issue bodies to prevent accidental data leakage or erratic routing across repository boundaries.

Cross-repo routing gates G5 through G8 shipped 2026-06-23 (PRs #300–#303). This final dense block of foundational feature gates integrated cross-repo routing into the write path (#300), implemented volume capping with a per-target two-axis limit (#301), added duplicate detection look-backs over closed issues (#302), and introduced a cross-repo quality filter with confidence/priority gates (#303) to safely handle multi-repository environments.

Cross-repo PROPOSE capabilities graduated 2026-07-21 (PR #326). Graduated `standards-gap` as the first cross-repository PROPOSE class, consolidating and maturing the multi-repository orchestration architecture to handle standardized workflow capabilities seamlessly across target repositories.

Cross-repo PROPOSE capabilities graduated 2026-07-21 (PR #326). Graduated `standards-gap` as the first cross-repository PROPOSE class, consolidating and maturing the multi-repository orchestration architecture to handle standardized workflow capabilities seamlessly across target repositories.

Dependabot autofix dashboard widgets and Copilot-review cache optimization shipped 2026-07-23 (PR #337). This update surfaces active Dependabot autofixes directly on per-repository dashboards to enhance security automation visibility, while optimizing overall pipeline performance by refreshing the GitHub Copilot Review cache during runs.
---

## Roadmap

### ~~Phase 1 — Richer Observation (consume, don't replicate)~~ SHIPPED

Shipped 2026-03-22 (#18). Full detail in git history.

### ~~Phase 2 — Richer Reports~~ SHIPPED

Shipped 2026-03-24 (PRs #23–#37). All 10 items complete: release cadence bug fix, open PR triage view, issue staleness detection, blocked issue context, calendar heatmap, PR cycle time, issue velocity imbalance alert, narrative weekly digest, embeddable SVG health badges, SBOM dependency inventory, and AI agent actionability score. 105 tests.

### ~~Phase 3 — Tiered Health Model~~ SHIPPED

Shipped 2026-03-24 (PR #39). Replaced the numeric health score with Gold/Silver/Bronze tiers. Each tier has explicit pass/fail criteria shown as a checklist on per-repo reports. Portfolio table shows tier badges. SVG badges updated with tier names. 119 tests.

### ~~Phase 4 — Structured Issue Specs~~ SHIPPED

Shipped 2026-03-24 (PRs #41–#42). IDEATE now requests structured specs (current/proposed state, affected files, scope, signal rationale). PROPOSE builds rich markdown issue bodies and uses Jaccard similarity duplicate detection (threshold 0.6) before creating issues. Backward compatible with old-format LLM output. 27 new tests across ideate.test.js and propose.test.js.

### ~~Consumer Packaging~~ SHIPPED

Shipped 2026-03-24. Full detail in git history.

---

## Next Up

### ~~AI code review agent — replace Gemini, standardise across the portfolio~~ SHIPPED

Deadline-driven: Gemini Code Assist's consumer GitHub reviews cease 2026-07-17 (new installs blocked from 2026-06-18), and it is the last AI review bot still posting on repo-butler, so `/address-pr-comments` and the wait-for-bots step will soon find nothing. Pick one free replacement and apply it across most repos. Free-for-public-repo options (verified 2026-06): CodeRabbit Pro is free forever for public repos with the full feature set and is already configured here (restoring it may be a re-install); GitHub Copilot code review is free for public repos (the 2026-06-01 Actions-minutes/AI-credit billing hits private repos only) and is GitHub-native with zero added infrastructure. Qodo Merge's free tier caps at 75 reviews/org/month — too small for ~14 repos — and PR-Agent self-host is free software but needs a paid LLM key plus infra, against the zero-infra moat. Lean CodeRabbit Pro or Copilot review, pending a Copilot-licence check.

Then add the functionality here: a `code-review-bot` governance standard plus a templatable apply config (a `.coderabbit.yaml`, or enabling Copilot review) so Governance Apply propagates the chosen agent to any repo missing it — the same pattern as code-scanning, dependabot-actions, and dependabot-auto-merge — turning portfolio-wide review coverage into a measured campaign rather than a manual rollout.

Progress (2026-06-13): Copilot code review chosen as the standard, and both halves now shipped. Detection: a `code-review-bot` governance standard checks each eligible repo for an active `copilot_code_review` repository ruleset (`details.hasCopilotReview`, derived in `fetchPortfolioDetails` via the shared `hasActiveCopilotReviewRuleset` helper), surfacing missing coverage as a standards-gap finding on the dashboard and MCP. Auto-enable: because Copilot review is a repository ruleset rather than a committed file, it cannot ride the templated file-PR path, so it routes to a new `settings` executor and a PR-less ruleset write — the trust model for which is set out in [ADR-009](docs/decisions/009-settings-level-writes.md) (Accepted 2026-06-13 after a five-persona council review). The apply path (`applyCopilotReviewRulesets`) rides the same five ADR-005 gates plus three writes-without-a-PR gates: additive/idempotent with a distinctively-named ruleset and a live pre-write detection check, scope-minimised to the single Copilot rule on the default branch (cannot block merges or restrict access), and a name-guarded `removeCopilotReviewRuleset` rollback affordance. v1 is manual-dispatch only (`apply.yml`, `tools=code-review-bot`), dry-run by default, and absent from the `apply-schedule` allow-list. Going live additionally requires granting the GitHub App `administration: write` (broader than the PR path's token) and is the maintainer's deliberate step; scheduled promotion waits on the codeowners/security-md track record per ADR-007's stage-4 gate.

Progress (2026-06-15): SHIPPED and LIVE. PR #271 (detection) and PR #272 (ADR-009 auto-enable) merged, the maintainer granted the GitHub App `administration: write` scope and approved it on the installation, and two manual `apply.yml` dispatches (`tools=code-review-bot`, dry-run off) created the `repo-butler/copilot-code-review` ruleset across all 13 non-compliant repos — a five-repo canary followed by a sweep of the remaining eight at `max-apply-per-run=15`, with the live idempotency guard skipping the already-enabled five (0 errors, independently verified 13/13 via the rulesets API). The `code-review-bot` standards-gap finding is now clear: zero non-compliant repos, so Copilot code review covers the portfolio ahead of Gemini Code Assist's 2026-07-17 sunset. v1 stays manual-dispatch only and absent from the `apply-schedule` allow-list; promoting it onto the no-human scheduled apply is the remaining ADR-007 stage-4 step, now backed by this clean track record.

Progress (2026-07-13): scheduled promotion shipped. `code-review-bot` joined the `apply-schedule` allow-list — the last held-back class, completing the ADR-007 stage-4 rollout — backed by the clean 13/13 manual rollout of 2026-06-15 (the settings write's one live execution; the intervening weekly scheduled runs were clean but skipped this class, so they prove the harness, not the write). The same change wires the `copilotReview` result into the scheduled run summary so a PR-less settings write always leaves an audit line. ADR-009 carries the gate analysis ("Scheduled promotion (2026-07-13)" note); the class remains auto-merge-ineligible by construction.

### ~~Dashboard Narrative Restructure~~ SHIPPED

Shipped 2026-04-08 (#93, #100). Full detail in git history.

### ~~Astro Integration + Dynamic Dashboards~~ SHIPPED

Shipped 2026-04-14. Full detail in git history.

### Dashboard packaging — round two (calm & adaptive)

The portfolio dashboard's structure had drifted back toward a data dump as Governance, Campaigns, and the dependency inventory were bolted on after the 2026-04 narrative restructure. Round two reframes the front page around a calm, adaptive arc that leads with the answer and progressively discloses the rest. A state-driven status hero opens the page — a health headline in the butler's voice, the tier mix, the portfolio's vulnerability posture, and a week-over-week Gold trend — coloured by an overall state (healthy / attention / critical) derived from open critical-high alerts, sub-Gold repos, and high-priority findings. Directly beneath it a "Since the last run" delta strip surfaces what actually changed — tier moves and security posture changes — diffed against the previous portfolio-weekly snapshot via the pure `detectTierChanges` core, which finally gains a live consumer in the pull surface the maintainer actually reads. The big reference tables collapse and open themselves only when a repo sits below Gold; a critical security banner raises itself only when something has an open critical/high alert; and the tool brochure is demoted to an "About Repo Butler" disclosure at the foot of the page. Implemented in `src/report-portfolio.js` (status hero, delta strip, adaptive disclosure), `src/report-styles.js` (calm styling), `src/store.js` (`readLatestPortfolioWeekly`), and `src/report.js` (wiring the prior snapshot in). Per-repo page reframe and a compose-by-repo rollup are deferred follow-ons.

### Scheduled pipeline wiring

All seven main pipeline phases are now wired to triggers: OBSERVE, ASSESS, UPDATE (live since 2026-05-26), GOVERNANCE, and REPORT run daily via `self-test.yml`, and IDEATE and PROPOSE run weekly via `weekly-ideate.yml` (dry-run — PROPOSE files no issues; its only writes are the idempotent host-label ensure and each run's routing-record append to the rolling `snapshots/propose-soak.json` ledger on the data branch for the G10 graduation review). Alongside the main pipeline, MONITOR runs every 6h via `monitor.yml`. `.github/roadmap.yml:6-8` declares `schedule: { assess: daily, ideate: weekly }` — both now match reality. The 2026-04-14 incident where `snapshots/latest.json` had been frozen since 2026-04-03 (because `self-test.yml` defaulted to `phase=report` with no OBSERVE) exposed this gap; the fix landed as commit `9795952` on main. UPDATE has since graduated off dry-run (2026-05-26, see below); the soak still running is the month-long G10 dry-run PROPOSE soak.

~~**Wire ASSESS into the daily schedule**~~ — SHIPPED. `self-test.yml` now defaults to `observe,assess,update,report`, so the daily run diffs snapshots, calls the LLM for a narrative, proposes a ROADMAP.md update in dry-run mode, and computes weekly trends. The per-repo report for the butler repo now renders an Assessment section from `context.assessment.assessment` alongside the trend direction from `context.trends`. `schedule.assess: daily` in roadmap.yml is no longer aspirational.

~~**Weekly IDEATE workflow (dry-run first)**~~ — SHIPPED. `.github/workflows/weekly-ideate.yml` initially ran `observe,ideate` every Monday at 06:00 UTC with `dry-run: true` — no issue or PR writes; governance findings still persist to the `repo-butler-data` branch for the MCP `get_governance_findings` tool — with graduation to `observe,ideate,propose` deferred until the council output was trusted. Acceptance (pending): governance findings refresh weekly; `get_governance_findings` returns data <7 days old; `schedule.ideate: weekly` matches reality. (Since graduated: the workflow now runs `observe,ideate,propose` dry-run as the G10 soak — see "Cross-repo PROPOSE destinations" below.)

~~**UPDATE in dry-run mode on the daily schedule**~~ — SHIPPED. `self-test.yml` now defaults to `observe,assess,update,report`. `src/update.js` gates writes behind `dryRun`, so daily CI logs what it *would* change without touching the file.

~~**Graduate UPDATE off dry-run**~~ — SHIPPED 2026-05-26. First attempt reverted 2026-05-03 (PR #175 → PR #176 exposed destructive rewrites). Re-graduated via PRs #222–#231 after switching to section-edit mode: the LLM now emits JSON append ops instead of reproducing the full document, eliminating the class of bugs that plagued the full-document approach across three models (Gemini 2.5, Claude Sonnet 4, Gemini 3.5). PR #223 flipped `INPUT_DRY_RUN` to false; PR #231 shipped section-edit mode; PRs #232 and #233 were the first successfully generated and merged roadmap updates.

~~**UPDATE prompt rebuild + section-edit mode**~~ — SHIPPED 2026-05-26. The full-document reproduction approach (PRs #179, #187, #188) proved fundamentally unsuitable: three models (Gemini 2.5 Flash, Claude Sonnet 4, Gemini 3.5 Flash) all consistently deleted or rewrote paragraphs despite explicit verbatim instructions, and four safety guards (length 80%, strikethrough count, PR-reference count, validateRoadmap) correctly caught every bad edit but meant no PR was ever created. PR #231 replaced it with section-edit mode: the LLM receives the roadmap as read-only context and emits a JSON array of `{"action": "append", "section": "...", "text": "..."}` ops; the code applies them deterministically and updates the date without LLM involvement. The LLM can only add content, never delete or rewrite. Run time dropped from ~40s to ~6s, and the first two generated PRs (#232, #233) merged cleanly. Gemini bumped from 2.5 to 3.5 Flash in PR #230. The legacy guards remain defined but inactive, with `validateRoadmap` as the active defence-in-depth.

~~**Deliberately out of scope: PROPOSE on a schedule.** PROPOSE creates real GitHub issues (`src/propose.js:172-246`) and has spam-risk blast radius. It stays manual-only until IDEATE has been producing trustworthy council-approved proposals for at least a month. When it graduates, it belongs on `weekly-ideate.yml` (not daily), behind the existing `require_approval: true` flag in roadmap.yml so every issue needs a human label-flip to leave draft status.~~ — SUPERSEDED as predicted: PROPOSE now runs on `weekly-ideate.yml` in dry-run as the ADR-011 G10 soak (no issues filed; a live write still requires the allow-lists populated, `require_approval: false`, and `INPUT_DRY_RUN: false`). See "Cross-repo PROPOSE destinations" below.

### Cross-repo PROPOSE destinations — PROPOSED (ADR-010, ADR-011)

IDEATE already ideates portfolio-wide (`buildIdeatePrompt` switches to a governance-advisor persona when findings exist), but PROPOSE files every resulting issue into the host repo's own tracker (`src/propose.js:177`, `:266`), so cross-repo proposals never reach the repos they concern. [ADR-010](docs/decisions/010-cross-repo-proposal-destinations.md) proposes a `targetRepo` destination on PROPOSE for governance-class proposals — reusing the existing per-`(owner, repo)` dedup and `validateIssueBody` checks — gated by an adaptation of the ADR-005 five-gate model (default-empty `propose-targets` allow-list, dry-run fail-closed, `require_approval`, per-repo cap, `REPO_NAME_PATTERN` validation). [ADR-011](docs/decisions/011-portfolio-informed-generic-proposals.md) proposes extending that to a new portfolio-informed-generic class: small generic improvements (e.g. description-gap, topics-gap) justified by a cross-repo statistic, with the butler/triage-bot boundary sharpened to the source of justification (a portfolio statistic the butler computes) rather than the subject, enforced by a deterministic finding-anchoring gate plus two tightenings (a two-axis cap and cross-reference autolink neutralisation). Both stay inside the ADR-002 lane (per-repo code ideas remain ceded to the triage bot), ship default-closed, and graduate per-class only after a clean month-long IDEATE soak.

The phased plan (G1–G11 across six default-closed phases) builds these in dependency order: G1 (this set of ADRs), then the dormant `targetRepo` field, deterministic safety and admissibility gates, routing behind empty allow-lists, the council quality filter and issue format, the soak-then-graduate write phase, and the optional net-new deterministic classes. Status: G1 (ADRs, #296), G2 (dormant `targetRepo` field, #297), G3 (cross-reference autolink neutralisation in `safety.js`, #298), G4 (the deterministic `resolveCrossRepoDestination` finding-anchoring gate, #299), G5 (the gate wired into `propose()` behind empty `propose-targets`/`propose-classes` allow-lists, #300), G6 (the per-target two-axis volume cap, #301), G7 (closed-issue look-back in `findDuplicates`, #302), and G8 (the council quality filter — a statistic-grounding rule in the deliberation prompts plus a deterministic confidence/priority gate that holds weak cross-repo ideas back to the watchlist, defence-in-depth and never the boundary, #303) have all shipped, as has G9 (the cross-repo issue *format* — a deterministic body composed from the anchoring finding's statistic rather than the LLM's free text, the distinct `portfolio-nudge` label, an onboarding-marker precondition that falls back to the host backlog when a target is not onboarded, and a single host-side umbrella tracking issue that each cross-repo body back-links to via a bare allowlisted URL, #304); the full G1–G9 machinery is now on `main`. The dormant program has begun its observation soak: the weekly `weekly-ideate.yml` run now executes `propose` in dry-run (`observe,ideate,propose`), so the soak log records every idea's resolved destination and which cross-repo nudges would route elsewhere versus fall back to the host. The cross-repo allow-lists (`propose-targets`/`propose-classes`) stayed empty throughout the soak, so nothing crossed and no issues were filed (the only write PROPOSE makes in dry-run is the idempotent host-label ensure, a no-op once the proposal/agent labels exist); the G10 graduation below has since populated them with the first class/target pair, while the run itself stays dry-run. The remaining goals stay parked behind that soak: G10 graduates exactly one class via a separate reviewed PR after a clean month — standards-gap first, the class carrying the soak's sustained gate-admitted evidence (ADR-011 originally slated tier-uplift, whose first admitted candidate arrived only on the final soak run; the deviation and its evidence are recorded in ADR-010's "G10 graduation" note) — and G11 adds optional net-new deterministic classes (description-gap, topics-gap). No routing is wired live and no cross-repo write graduates until a class clears its month-long IDEATE soak.

### ~~Code Health Sprint — multi-agent simplification review~~ SHIPPED

Shipped 2026-04-28 (#127, #146, #126, #128, #130, #129, #132, #133, #134, #131, #135, #137, #141, #142, #136, #138, #139, #143, #140, #144, #145). Full detail in git history.

### ~~Code Health Sprint — deferred follow-ups~~ SHIPPED

All four follow-ups shipped across PRs #149–#152: parseIdeas BODY-then-stop (#149), monitor scanner logging (#150), CSS custom properties (#151), prs_merged_days config wiring (#152).

### ~~Portfolio Hardening Sweep — 2026-04-29~~ SHIPPED

Shipped 2026-05-01 (#157). Full detail in git history.

### ~~Cross-repo PR automation (follow-up)~~ SHIPPED

Shipped 2026-05-01. Full detail in git history.

### ~~`dependabot:rebase` — act on stale Dependabot PRs~~ SHIPPED

The Governance Apply phase now actively addresses stale Dependabot PR findings by posting a single `@dependabot rebase` comment on the oldest stale PR per repository, rather than merely flagging them as dashboard findings. This new `nudgeStaleDependabotPRs` action operates as a sequential canary that processes the most-stale PRs first, capped at a default of five per run. It strictly adheres to all five existing ADR-005 gates, including workflow_dispatch-only execution, dry-run fail-closed behaviour, and a seven-day deduplication mechanism to prevent double-commenting. Because this functionality is implemented as a new action type within the existing apply phase without relaxing the trust model, no ADR amendment was required. Operators can preview both actions in dry-run mode with a blank `tools` input or scope a nudge-only run by specifying `tools=dependabot-rebase`.

### ~~Dependabot auto-merge standard~~ SHIPPED

A new universal governance standard checks every eligible repo for a `.github/workflows/dependabot-auto-merge.yml` workflow that enables auto-merge on non-major Dependabot PRs. Detection reuses the existing portfolio `/actions/workflows` fetcher (no new API calls) to set `hasAutoMergeWorkflow` per repo, and the standard routes through the templatable apply path, so `governance:apply` can open a remediation PR that drops in an ecosystem-agnostic workflow built on `dependabot/fetch-metadata@v3` and `gh pr merge --auto` (no `--squash`, so each repo keeps its own default merge method). The detector also reads the repo's `allow_auto_merge` setting as an advisory (`allowAutoMerge` / per-finding `repoAutoMerge`) since the workflow only takes effect once Allow auto-merge is enabled and branch protection requires status checks; the remediation PR documents these prerequisites. Phase 2 — having the butler flip the `allow_auto_merge` repo setting and configure branch protection itself, plus the corresponding ADR-005 amendment — is deliberately deferred.

### Release cadence standard — self-healing gold-tier releases

Born from the 2026-07 portfolio-wide release drift: the whole early-April manual release batch crossed the 90-day gold boundary at once in week 27, dropping the portfolio from 14/14 gold to 5/14 in a single week, with eight repos failing exactly one check ("Release in the last 90 days"). The weekly IDEATE run diagnosed it and proposed the fix ("Establish Automated Release Cadence to Correct Portfolio-Wide Release Drift", 2026-07-06 soak ledger) but, being in the G10 dry-run soak, could not file it — so the fix landed as a reviewed change instead. A new universal `release-cadence` governance standard detects release automation machinery (any workflow whose name or path mentions "release", reusing the existing `/actions/workflows` fetcher — no new API calls, so hand-rolled publish pipelines count as compliant), and a new templatable apply class remediates gaps with a scheduled patch-release workflow: on the 1st and 15th it cuts a patch release with generated notes when the latest release is at least 60 days old AND unreleased commits exist (worst-case staleness ~75 days, inside the 90-day tier window). Fail-safe by construction — it skips repos with no published release (the first release stays a human decision), non-semver tags, or nothing new to release, and it only reads git history plus `gh release create`, never building or publishing artifacts, so it cannot go red on heterogeneous repos. `sound3fy` is excluded via `standards-exclude` to mirror its `release_exempt` status. Ships manual-dispatch only (`apply.yml`, dry-run by default), absent from `apply-schedule` and `apply-automerge` per the ADR-007 one-class-at-a-time promotion ladder; release RECENCY itself remains the tier-uplift finding's job, so the two compose — the standard installs the machinery, the machinery keeps the gold check passing.

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

~~**Cross-repo PR creation**~~ — SHIPPED. `src/apply.js` + `.github/workflows/apply.yml`. Uses the GitHub App token (`actions/create-github-app-token`) for cross-repo writes, dispatch-only, dry-run fail-closed, `require_approval` gated, batch-capped at 5 PRs per run. See ADR-005 for the layered-gate rationale.

~~**Auto-onboarding**~~ — SHIPPED (PR #85). The pipeline automatically checks all active portfolio repos after the report phase and opens onboarding PRs for any repo missing the CLAUDE.md consumer guide. No webhook needed — runs on every daily pipeline execution.

Security prerequisites (from architecture review): ~~bot URL validation~~, ~~ecosystem detection allowlists~~, ~~PR deduplication~~, ~~URL allowlist splitting in safety.js~~, ~~contributor name sanitisation~~, GitHub App for cross-repo auth. Five of six shipped in PRs #63 and #65 (329 tests). Also shipped: LLM prompt injection defence, triage bot response schema validation, governance detection engine.

~~**Landscape evaluation**~~ — EVALUATED 2026-05-28 ([docs/research/2026-05-28-multi-repo-tooling-landscape.md](docs/research/2026-05-28-multi-repo-tooling-landscape.md)). Conclusion: embed no external tool into the Action — the zero-dependency, API-only, zero-infra moat rules out clone-based CLIs (`multi-gitter`, `git-xargs`) and self-hosted Probot apps (`safe-settings`, `allstar`). Community-health-file propagation extends `apply.js` natively rather than adopting `repo-file-sync-action`; `multi-gitter` is kept as a manual escape-hatch; `ossf/scorecard` is deferred as a future OBSERVE signal. See [ADR-007](docs/decisions/007-agents-and-execution.md) and the Landscape section.

---

## Future

These are ideas for later evaluation, not commitments.

~~**Libyear dependency freshness**~~ — SHIPPED. Implemented via SBOM data plus npm registry lookups. Shows cumulative dependency age per repo in the portfolio table and per-repo reports.

**External tool metric consumption** — Auto-discover SonarCloud (`.sonarcloud.properties`) or CodeClimate (`.codeclimate.yml`) configurations and pull maintainability grades into the health matrix. Read Renovate's Dependency Dashboard issue to extract pending update counts. All opt-in, following the triage bot auto-discovery pattern. Phase 6 schemas lay the groundwork for structured consumption of these external signals. Also evaluate `ossf/scorecard` as a security health signal — its 0-10 score across 18 dimensions could feed into or complement the health tier model rather than the butler computing its own security metrics.

~~**Deployed-page link surfacing**~~ — SHIPPED. `observe.js` captures the GitHub `homepage` field (single-repo `meta.homepage` and portfolio paths); `report-shared.js`'s `deployedLink()` renders a compact live-site link in the portfolio table (both views) and per-repo subtitles when set. The owner-set URL is validated by a new `safeDeployedUrl()` in `safety.js` (http/https only, all other schemes rejected) and HTML-escaped before reaching the public page — not routed through the LLM host allowlist, since a deployed page lives on any custom domain. Discovery-only.

~~**Contributor funnel**~~ — SHIPPED. `fetchPRAuthors` at `src/report-repo.js:49` marks authors via `pr.author_association === 'FIRST_TIME_CONTRIBUTOR'`. `computeContributorStats` at `src/report-repo.js:147` computes total, first-timers, and contributor confidence ratio (unique contributors / stargazers × 100). Rendered on per-repo reports as three cards: Unique Contributors (90d), First-Time Contributors, Contributor Confidence.

~~**Sparkline mini-charts**~~ — SHIPPED. `generateSparklineSVG` at `src/report-portfolio.js:282` renders per-repo weekly activity inline in the portfolio table rows. Pure SVG, no library.

~~**Campaign view**~~ — SHIPPED. `buildCampaignSection` at `src/report-portfolio.js:318` groups Community Health, Vulnerability Free, CI Reliability, License Compliance, and Issue Templates adoption into progress cards with non-compliant repo lists.

**Skills and documentation review** — Review the research at `docs/research/2026-04-02-skills-and-documentation-landscape.md` and evaluate: distributing per-repo governance findings as Claude Code skills via the onboarding workflow, adding YAML frontmatter to ADRs for machine-parseability, establishing a documentation taxonomy (ADRs, specs, plans, research) consistent across both repo-butler and the triage bot, and pointing CLAUDE.md to relevant ADRs per area ("documentation as system prompt"). The butler's unique skill opportunity is cross-repo findings, not generic documentation — the ETH Zurich study found auto-generated context files reduced task success. Also evaluate the cross-org CLAUDE.md propagation gap as a natural extension of the onboarding workflow.

~~**Butler skills consolidation**~~ — SHIPPED 2026-05-06 across four PRs. Closes both predecessor entries — "Distributable butler skills" and "Butler-briefing/debrief refresh or retirement". End state: two skills shipped from `skills/` in this repo — `repo-butler` (read-side, briefing/debrief modes via positional arg) and `repo-butler-apply` (write-side, confirm-gated). PR #182 hygiene + portability, PR #184 merged briefing+debrief into `repo-butler`, PR #183 renamed apply → `repo-butler-apply`, PR #186 the Reginald uplift: dropped the stick-figure for two ASCII silhouettes (bowler+moustache+bow tie for read; silver tray with mood-varying contents for apply), mixed whisky into the closings, added streak awareness, household-member metaphors, recurring grievances, giving-up lore for stale findings, disapproving `*ahem*` for unreviewed merges, and reserved extremis signals (mourning frame, fortnight-rate-limited Burns half-line) — all under a hard line/word budget (≤250 lines body, ≤30 persona, ≤8 closings per mode). Distribution polish (settings-key for project dirs, MCP-first data fetcher, install.sh) is deferred to a separate PR.

### ~~Phase 6 — Data Contracts + AI Skill~~ SHIPPED

Shipped 2026-03-29 (PR #59). Six JSON Schema 2020-12 definitions in `schemas/v1/` covering snapshot, portfolio, health tiers, config, weekly trends, and enriched portfolio details. Claude Code skill at `docs/skill.md` with 11 eval tests. Schema validation tests in CI. Weekly portfolio snapshots enriched with health tier computation fields. ADR-003 documenting standards choices. 208 tests.

### ~~Phase 7 — MCP Server~~ SHIPPED

Shipped 2026-03-30 (#60). Full detail in git history.

### Phase 8 — A2A Agent Card + Triage Bot Contract

A2A v0.3 Agent Card published at `/.well-known/agent.json` for capability discovery by other agents. A formalised integration contract with the triage bot, defining typed event schemas for the signals the butler consumes (issue intelligence, per-repo health summaries).

~~**Agent Card**~~ — SHIPPED. `src/agent-card.js` builds an A2A AgentCard and the REPORT phase writes it to `reports/.well-known/agent-card.json` so it deploys to Pages at `ismaelmartinez.github.io/repo-butler/.well-known/agent-card.json`. Declares six skills (portfolio-health, governance-findings, campaign-status, snapshot-diff, monitor-events, council-triage), capability flags, provider, and documentation URL. The card is discovery-only for now — the butler's primary programmatic interface remains the MCP server from Phase 7. `supportedInterfaces` stays empty until an A2A transport is actually exposed.

**Triage bot contract** — PAUSED 2026-05-03; archival under consideration as of 2026-05-25. The integration is shipping no signal in practice: only 2 of 14 portfolio repos carry `.github/butler.json`, `TRIAGE_BOT_INGEST_SECRET` is unset, and the `/ingest` path is a no-op. The `/teams-for-linux-issue-review` Claude Code skill handles issue triage more effectively than the bot's RAG-based approach. If the triage bot is archived, the butler codebase has these touchpoints: `src/triage-bot.js`, `validateTriageBotTrends` in safety.js, and this roadmap entry.

**Security prerequisites** — ~~Bot URL validation~~, ~~ecosystem detection allowlists~~, ~~PR deduplication~~, ~~URL allowlist splitting~~, ~~LLM prompt injection defence~~, ~~triage bot response validation~~ (all shipped in PR #63). Remaining: GitHub App for cross-repo auth, contributor name sanitisation for CODEOWNERS.

### Phase 9 — AsyncAPI Events

AsyncAPI 3.0 spec describing the event-driven interface for consumers that want push rather than pull. Health-change events and governance-proposal events are published via GitHub `repository_dispatch`, allowing external systems to react without polling the snapshot branch.

**Health-change channel** — Emitted when a repo's health tier changes (Bronze → Silver, etc.). Payload matches the Phase 6 `health-tiers` schema.

**Governance-proposal channel** — Emitted when the butler opens a cross-repo PR or creates a governance issue. Payload includes the proposal type, affected repos, and campaign membership.

**Spec file** — ~~`docs/asyncapi.yml` validated against the AsyncAPI 3.0 schema in CI.~~ Shipped: the AsyncAPI 3.0 spec lives at `docs/asyncapi.yml` as a discovery-only contract — like the A2A Agent Card, it describes the interface without a live transport. It defines the two channels (`healthTierChanged`, `governanceProposalOpened`), each with a `send` operation, whose payloads reference the Phase 6 schemas (`health-tier.v1.schema.json`, `governance-finding.v1.schema.json`) and document the GitHub `repository_dispatch` event types (`repo-butler.health-tier-changed`, `repo-butler.governance-proposal-opened`) used as the transport. It is validated by a structural smoke test in CI (`src/asyncapi.test.js`); full AsyncAPI-schema validation is a dev-time step, since the zero-dependency runtime has no AsyncAPI validator. Live `repository_dispatch` emission is deferred, and is being built in small steps per [ADR-008](docs/decisions/008-event-emission.md): the pure, GitHub-free tier-change detection core landed first (`src/tier-change.js` — diffs each repo's computed tier against a prior state, emits each transition once). That core now has a live consumer on the pull side: the dashboard's "Since the last run" delta strip (Dashboard packaging — round two) diffs each run against the previous portfolio-weekly snapshot via the same `detectTierChanges`, so tier moves surface where the maintainer actually reads them. Live `repository_dispatch` emission (the `dispatch()` client method and report-phase wiring behind a default-off `INPUT_EMIT_EVENTS` flag) is parked rather than scheduled: no workflow subscribes to `repository_dispatch` today and the triage bot — the one prospective subscriber — is being retired, so a push transport would emit into the void. Per ADR-003's own ordering, the event layer waits until a consumer exists to justify push over pull.

### Phase 10 — Agents and Execution (revised 2026-05-28)

Execution splits into two tracks by the nature of the finding, evolving step by step toward full automation. See [ADR-007](docs/decisions/007-agents-and-execution.md) for the full design and the [landscape evaluation](docs/research/2026-05-28-multi-repo-tooling-landscape.md) for why no external execution tool is embedded.

~~**Track B stages 1–2**~~ — SHIPPED 2026-05-28 to 2026-05-29 across PRs #239, #240 and #241. Stage 1 introduced deterministic remediation plans with executor hints and change specs (no LLM, persisted alongside the findings, exposed via the MCP `get_governance_findings` `byExecutor` summary and a JSON schema), and a follow-up reconciled the dependabot template key so `dependabot-actions` findings became actionable in the apply phase. Stage 2 enabled the `repo-butler-apply` skill to route findings by executor, dispatching template findings to the cloud Governance Apply workflow, drafting local review PRs for agent findings, and listing manual findings for the owner. A follow-on increment established the executor hint as the authoritative actionability signal in `apply.js` (only `template` findings auto-apply) and surfaced a per-executor breakdown on the governance dashboard. Both remaining stages have now shipped: stage 4 (scheduled no-human apply) graduated to live 2026-06-15, and stage 5 (selective per-class auto-merge) shipped default-closed the same day (both below). Phase 10 is feature-complete.

~~**Track A stage 3**~~ — SHIPPED 2026-05-29. Adds a per-tool override for the Governance Apply per-run PR cap via a new `apply-cap` block in `roadmap.yml` mapping a tool name to its maximum PRs per run. Tools not listed fall back to the global default of five, so an unlisted or new tool cannot exceed the global default without an explicit reviewed config entry. This is the conservative reading of "relax gates per finding-class": only the per-run cap is made per-tool — every other ADR-005 gate (require_approval, dry-run fail-closed, no cron trigger, batch size, repo-name validation) stays global and unchanged, so the trust model is untouched and no ADR amendment was needed. With no `apply-cap` configured, behaviour is identical to before.

~~**Stage 4 — scheduled apply, live**~~ — SHIPPED 2026-06-15. The no-human-at-dispatch apply path (`apply-scheduled.yml`, merged dormant 2026-06-06) graduated to live: its weekly cron run now writes (`INPUT_DRY_RUN=false`), acting on the seven template/nudge classes in the `apply-schedule` allow-list (`code-scanning`, `dependabot-actions`, `issue-form-templates`, `dependabot-auto-merge`, `codeowners`, `security-md`, `dependabot-rebase`). ADR-007's falsifiable unblock condition — several human-reviewed `governance-apply` PRs merged across several weeks with no rollbacks — was met by 19 such PRs merged 2026-05-11 to 2026-06-08, none rolled back. Every PR still gets human review and merge; nothing auto-merges (that is stage 5). All five ADR-005 gates hold (`require_approval` master switch, per-run cap, batching, repo-name validation), a manual `workflow_dispatch` stays dry-run by default, and the settings-write `code-review-bot` class stays off the schedule per ADR-009. With zero open findings today the flip is forward-looking — the first live cron opens nothing until a new gap appears. See [ADR-007](docs/decisions/007-agents-and-execution.md) update 2026-06-15.

~~**Stage 5 — selective auto-merge, default-closed**~~ — SHIPPED 2026-06-15. The final Phase 10 stage and the one deliberately-sanctioned autonomous merge in the project: the butler squash-merges its OWN green templated `governance-apply` PRs — never human-authored PRs, never global (distinct from the maintainer's standing never-merge rule). It is opt-in per class via an `apply-automerge` allow-list (default empty), bounded to the deterministic template tools (settings/nudge/policy-drift/tier-uplift/agent/manual classes are ineligible by construction), and fires only when required CI is green and the PR is mergeable. Merging is a squash (one clean revert commit), the merge SHA is recorded, and it runs in a reconcile pass on a later scheduled run — never at PR-open time. Implementation adds `mergePR` + `prCiGreen` to `src/github.js`, `autoMergeGovernancePRs` to `src/apply.js`, the `apply-automerge` config/schema key, and the reconcile + run-summary wiring; the REST `pulls/{n}/merge` path was chosen over GraphQL (no new transport, no per-repo prerequisite). Kill switches: empty the allow-list, set `require_approval` false (halts all apply), or disable the scheduled workflow — `require_approval=true` is the master operating switch, correcting the earlier stage-5 design wording. v1 ships with `apply-automerge` empty, so nothing auto-merges until a class is promoted in a separate reviewed change. ADR-005 + ADR-006 amended, ADR-007 stage 5 flipped to shipped. See [ADR-007](docs/decisions/007-agents-and-execution.md) update 2026-06-15.

Track A covers templatable findings (a `dependabot.yml`, enabling a scanner), which are already cloud-capable via `src/apply.js`. They reach full automation by relaxing ADR-005's gates incrementally and per finding-class (manual dispatch → schedule, dry-run → live, `require_approval` retained as the master switch). No agent is involved and every promotion is reversible.

Track B covers reasoning findings (a repo-tailored CONTRIBUTING.md, a CI fix, a tier uplift needing code) and is agent-driven, evolving local-first: the butler first emits a structured remediation plan per finding — an `executor` hint plus a change spec — as a portable contract; the `repo-butler-apply` skill then consumes it locally, opens PRs and lets a human review, which is where agent judgement is hardened; Track A's gates relax in parallel; the hardened logic then lifts into a hosted Actions agent consuming the same contract, behind ADR-005 gates; and selective per-class auto-merge is the destination. Decoupling the decision logic from the runtime is what makes the local stage transfer to the cloud without a rewrite.

Agent behaviours remain defined via CLAUDE.md files and the MCP server (Phase 7) stays the integration surface. Earlier guidance to adopt `multi-gitter`, `git-xargs`, or `safe-settings` as the execution layer is superseded by the landscape evaluation: no external tool is embedded, because the zero-dependency, API-only, zero-infra moat rules out clone-based CLIs and self-hosted apps. `multi-gitter` is retained only as a documented manual escape-hatch for complex migrations `apply.js` cannot template.

## What NOT to build

Cross-platform identity resolution (GitHub + Slack + Discord) — that's Orbit/Common Room territory. File-level code ownership analysis — requires git cloning which breaks the API-only architecture. Natural-language data querying — cool but requires a database. Grafana dashboards — the static HTML approach is the right constraint. Anything that requires self-hosted infrastructure — the zero-cost, zero-dependency positioning is the moat. Per-repo code improvement suggestions — that's the triage bot's domain (see ADR-002).

## Relationship to Other Tools

The butler consumes, it doesn't compete. Renovate handles dependency updates — the butler installs Renovate across the portfolio. Dependabot handles security alerts — the butler reads them and propagates Dependabot config to repos that lack it. The triage bot handles per-issue intelligence and per-repo improvement proposals — the butler reads its trends, configures it on new repos, and focuses on portfolio-level governance. SonarCloud handles code quality — the butler reads its scores. GitHub's community health profile defines the checklist — the butler runs through it across every repo and fixes the gaps.

The boundary is clear: the triage bot goes deep on one repo, the butler goes broad across the portfolio. The triage bot says "issue #47 is a duplicate of #12." The butler says "you adopted CodeRabbit in 5 repos — here are the 14 that should have it too."

## Landscape — Multi-Repo Tools to Evaluate

The butler's unique value is the observe-assess-report loop. The enforcement and remediation side (opening cross-repo PRs, syncing configs, propagating settings) overlaps with mature existing tools. Before building custom solutions in future phases, evaluate whether to use these tools directly, integrate with them, or learn from their approach.

**Evaluation outcome (2026-05-28)** — see the [full landscape evaluation](docs/research/2026-05-28-multi-repo-tooling-landscape.md). Headline verdicts: embed no tool into the Action runtime (the moat rules out clone-based CLIs and self-hosted Probot apps); extend `apply.js` natively for community-health-file propagation rather than adopting `repo-file-sync-action`; keep `multi-gitter` as the manual escape-hatch for complex migrations; defer `ossf/scorecard` as a future OBSERVE signal; learn from `octoherd` (per-repo model), `safe-settings` (config hierarchy), and GitHub custom properties (targeting). The catalogue below remains as reference.

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
