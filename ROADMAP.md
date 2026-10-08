# Repo Butler — Roadmap

**Last Updated:** 2026-10-07
**Status:** Feature-complete across all seven pipeline phases plus the monitor. Reports are live at [ismaelmartinez.github.io/repo-butler](https://ismaelmartinez.github.io/repo-butler/), which is the authoritative source for current portfolio health — this document deliberately does not duplicate counts that go stale. The estate is 14 public repos plus 1 private. UPDATE runs live on the daily schedule in section-edit mode; GOVERNANCE, the scheduled apply path, per-class auto-merge and private-repo watching are all live; cross-repo PROPOSE is mid-graduation. GOVERNANCE now produces eight finding types, three of them watchers added in late July that check what the butler and its collaborators did rather than what the repos look like.

This document answers two questions: what has been built, and what is being built now. Older work is deliberately compressed to a single line per month — the shape of what landed and when, with the prose left in git history.

---

## Vision

Repo Butler is evolving from a reporting tool into a genuine butler — one that not only tells you what your repos need but takes care of it. The positioning is deliberate: don't replicate what Renovate, Dependabot, SonarCloud, or the triage bot already do well. Instead, consume their data, present a unified view, and open PRs to install the tools that are missing. The butler orchestrates; the specialist tools execute.

The competitive landscape confirms this is a unique niche. Implementation agents (Copilot Coding Agent, Sweep, Devin) take known issues and write code. Planning tools (CodeRabbit Issue Planner) produce implementation plans. Project intelligence platforms (Linear AI, OSSInsight, GrimoireLab) either require infrastructure or are SaaS. No tool does the full loop of observe → assess → propose → act across an entire portfolio from a zero-dependency GitHub Action.

## Architecture

```text
OBSERVE → ASSESS → UPDATE → GOVERNANCE → IDEATE → PROPOSE → REPORT   (+ MONITOR)
```

1. **OBSERVE** — Gather project state via GitHub API. Portfolio-level classification. Consume data from installed tools. No LLM needed.
2. **ASSESS** — Diff snapshots, compute trends, detect health gaps. Optionally summarise with Gemini Flash.
3. **UPDATE** — Append new entries to this roadmap and open a PR. Safety-validated, section-edit mode.
4. **GOVERNANCE** — Deterministic detectors over the portfolio (standards gaps, policy drift, tier uplift, open vulnerabilities, stale Dependabot PRs). No LLM cost; runs 4×/day.
5. **IDEATE** — Generate improvement ideas from health signals and fresh governance findings, deliberated by a five-persona council.
6. **PROPOSE** — Create GitHub issues from approved ideas, safety-filtered, capped and labelled.
7. **REPORT** — Generate HTML dashboards for every portfolio repo, deploy to GitHub Pages.

MONITOR runs separately every 6h, detecting new events between scheduled runs and feeding them to the council.

See [ADR-001](docs/decisions/001-repo-butler-vs-triage-bot.md) for the boundary between this project and the triage bot; `docs/architecture.md` for the data-flow diagram.

## Implemented

Every phase runs end-to-end against real GitHub and Gemini APIs. The daily pipeline (`self-test.yml`, 4×/day) runs OBSERVE → ASSESS → UPDATE → GOVERNANCE → REPORT; `weekly-ideate.yml` runs IDEATE and PROPOSE on Mondays; `monitor.yml` runs every 6h; `apply.yml` and `apply-scheduled.yml` carry governance remediation. Zero npm dependencies throughout.

Observation covers issues, PRs, labels, milestones, releases, workflows, repo metadata and package manifests, plus the community health profile and all three GitHub security scanners (Dependabot, code scanning, secret scanning). Derived metrics include bus factor, time-to-close median, CI pass rate and libyear dependency freshness. Snapshots persist to a `repo-butler-data` orphan branch via the Git Data API, with 12 weeks of weekly history for trend analysis.

Reporting generates per-repo dashboards — full charts for active repos, lightweight cards for quieter ones — behind a snapshot-hash cache. Health is expressed as Gold/Silver/Bronze tiers with explicit pass/fail checklists. A safety layer validates every piece of LLM output before it is published, and all prompt-building wraps external data in delimiters with an injection-defence preamble.

Governance is a first-class phase with eight deterministic finding types, each carrying a remediation plan (an executor hint plus a change spec). Findings reach the dashboard, the MCP server and the apply path. Consumers are served by a zero-dependency MCP server (`src/mcp.js`), JSON Schema 2020-12 data contracts in `schemas/v1/`, an A2A AgentCard and an AsyncAPI 3.0 spec — the latter two discovery-only, with no live transport.

### Shipped log

**2026-03** — foundations. The full seven-phase pipeline, richer observation (community profile, Dependabot alerts, CI pass rate, bus factor), richer reports (PR triage, staleness, blocked-issue context, heatmaps, SVG badges, SBOM), the tiered health model replacing the numeric score, structured issue specs with Jaccard duplicate detection, the Phase 6 JSON Schema data contracts, and the Phase 7 MCP server (#18–#60). Full details in git history.

**2026-04** — hardening and the portfolio view. The security trifecta (three scanners, `release_exempt`), GitHub App token for vulnerability access, graded license-concern severity, bug-only Gold tier, auto-onboarding PRs, the Node runtime fix, the dashboard narrative restructure, private-repo discovery via `/installation/repositories`, the multi-agent Code Health Sprint and its follow-ups, and the portfolio hardening sweep (#63–#157). Full details in git history.

**2026-05** — governance, agents and the UPDATE rebuild. The Phase 5 governance engine (standards gaps, policy drift, tier uplift) with its dashboard and cross-repo apply path, ADR-007 Track A stage 3 and Track B stages 1–2 (remediation plans plus executor routing), the butler skills consolidation and Reginald uplift, the landscape evaluation concluding that no external tool gets embedded, and the UPDATE phase's graduation off dry-run after section-edit mode replaced full-document reproduction (#175–#244). Full details in git history.

Section-edit mode (PR #231, May 2026) is worth calling out separately, as the mechanism this document depends on: the LLM receives the roadmap as read-only context and emits a JSON array of append operations, which the code applies deterministically. It can add content but never delete or rewrite. Three models had previously proved unable to reproduce the document verbatim, and four safety guards correctly caught every bad edit — which meant no PR was ever created. Run time dropped from ~40s to ~6s.

**2026-06** — 8 entries (#263, #265, #266, #278, #279, #280, #282, #284, #286, #288, #291, #298, #300, #301, #302, #303, #304). Full details in git history.

**2026-07** — 11 entries (#326, #328, #329, #330, #342, #343, #344, #345, #348, #349, #352, #354, #355, #356, #357, #358, #10940). Full details in git history.

**2026-08** — 7 entries (#291, #350, #359, #361, #362, #364, #365, #367). Full details in git history.

Roadmap update process reinforced 2026-08-11 (PR #368). Future updates leverage enhanced pipeline context and baseline branch resolution to ensure continuous, accurate capture of portfolio and repository milestones.

OSV-Scanner governance migration and Snyk deprecation planned 2026-08-12 (PRs #370, #371). Initiated a strategic transition of the project's security posture by planning the removal of the Snyk integration and adopting `osv-scanner` as a new portfolio-wide standard for open-source vulnerability scanning.

OSV-Scanner security migration initiated 2026-08-12 (PRs #370, #371, #372, #373). Established a strategic transition of the portfolio's security posture by planning the deprecation of Snyk integration, rolling out OSV-Scanner configuration, and targeting the scanner rollout specifically at the three repositories losing Snyk coverage to maintain uninterrupted dependency vulnerability scanning.

OSV-Scanner governance migration completed 2026-08-12 (PR #374). Cleared the rollout exclusion list for the new `osv-scanner` standard, completing the security posture transition and ensuring comprehensive vulnerability scanning across the portfolio.

OSV-Scanner governance migration completed 2026-08-12 (PRs #370, #371, #372, #373, #374). Established a strategic transition of the portfolio's security posture by deprecating the Snyk integration and rolling out OSV-Scanner as the new portfolio-wide standard, ensuring comprehensive and uninterrupted dependency vulnerability scanning.

Dependabot auto-merge governance fix shipped 2026-08-13 (PR #375). Refined repository governance automation by ensuring the presence of the dependabot-auto-merge configuration is read reliably from the default branch.

Transient failure reporting stability improvement shipped 2026-08-14 (PR #378). Prevents false positives in compliance monitoring by ensuring transient detection failures are no longer reported as non-compliance.

Copilot review ruleset detection made tri-state, shipped 2026-08-14 (PR #380). `hasActiveCopilotReviewRuleset` absorbed every failure into `false`, so a transient error became the strongest claim available — that a repo has no code-review bot. Governance reported a gap, and the apply guard that exists to prevent a duplicate ruleset read the same `false` as permission to write. It now returns `true`/`false`/`null`, and only an explicit `false` authorises the write.

Roadmap maintenance process simplified 2026-08-19 (PR #381). A non-code chore updated the project's roadmap to reflect future planning directions and document current progress as the repository enters a temporary maintenance phase following a highly productive period of feature development.

Automated dependency upkeep and maintenance group update shipped 2026-08-20 (PR #383), bundling minor and patch dependency updates to keep the repository secure and up-to-date with minimal manual overhead.

Roadmap test robustness and codebase deduplication shipped 2026-08-26 (PR #384). Improved test suite reliability by unpinning the clock in roadmap tests and resolved minor codebase health issues by ensuring the "Implemented" section is fully deduped.

Codebase hardening and configuration loading fixes shipped 2026-08-26 (PRs #385, #386, #387, #388). Hardened the `release-cadence` workflow template, resolved configuration loading bugs by ensuring block scalars are loaded instead of discarded, updated documentation by removing outdated triage-bot prose, and cleaned up unused exports to reduce technical debt.

Automated dependency maintenance group update shipped 2026-08-27 (PR #390), keeping the repository's minor and patch dependencies secure and up-to-date with minimal manual overhead.

Council watchlist persistence fix shipped 2026-08-28 (PR #389). Resolved a state preservation defect in the IDEATE phase by ensuring the council's watchlist is persisted rather than discarded across scheduled runs, maintaining backlog consistency.

Automated dependency upkeep group update shipped 2026-09-03 (PR #391), bundling minor and patch dependency updates to keep the repository secure and up-to-date with minimal manual overhead.

Roadmap citation integrity guard shipped 2026-09-09 (PR #396). Prevents the automated roadmap generator from citing unverified or self-referential pull requests, ensuring data integrity and keeping the self-planning loop reliable.

Automated dependency deployment workflow update shipped 2026-09-10 (PR #398). Maintains CI/CD pipeline health and ensures the project's documentation and live roadmap deployment workflows remain fully functional and secure by updating dependency actions.

Repo Butler v1.1.2 stable release deployed 2026-09-15 (v1.1.2). This release consolidates the stable, feature-complete state of the pipeline, including the section-edit roadmap update engine, cross-repo PROPOSE, and the completed OSV-Scanner security migration, ensuring reliable continuous planning on its daily schedule.

Automated lockfile update tool for reachable-by-update alerts shipped 2026-09-17 (PR #400). Following the ADR-015 design, this implements the `lockfile-update` apply tool specifically targeting `reachable-by-update` Dependabot alerts, allowing the butler to autonomously resolve targeted security vulnerabilities by updating lockfiles.

CI workflow alignments on Node 24 and lockfile dependency updates shipped 2026-09-26 (PR #405). Aligns the CI test run execution and lockfile updates with Node 24 to support modern npm-11 lockfile formats, preventing environment-specific blockages during scheduled planning cycles.

Governance configuration schema alignment and onboarding safeguards shipped 2026-09-27 (PRs #431, #432, #434, #436). Hardens the repository onboarding flow by skipping declined pull requests, refusing unreadable CLAUDE.md files, and strictly requiring boolean true values for approval gates. Additionally, prevents silent configuration drift by aligning the core configuration schema with system defaults and enforces stricter roadmap integrity by requiring merged-PR evidence for all shipped entries.

Model Context Protocol test fixture isolation shipped 2026-09-27 (PR #437). Decouples the MCP test suite from live, volatile GitHub branches by injecting an IO seam to run tests against predictable, local fixture data, improving CI/CD pipeline reliability and deterministic agent execution.

Executed plans and one-shot verification scripts archived 2026-09-27 (PR #445). Cleans up historical execution artifacts and past agent run files to keep the repository's codebase and documentation organized and free of clutter, resolving issue #419.

Core agent logic refactored for pure module extraction and shared predicates shipped 2026-09-27 (PRs #443, #444). Simplifies the decision-making runtime by extracting a pure `apply-templates` module and consolidating shared predicates across `autofix`, `actionable-bug`, and `campaign` behaviors, improving internal code health and maintainability.

Robust numeric error handling for scheduler resiliency shipped 2026-09-27 (PR #446). Replaces fragile error string parsing with robust validation of numeric error statuses (`err.status`) in the scheduler branch logic, preventing silent automation failures and hardening the agent's scheduled execution loop.

GitHub Contents API 1 MB ceiling workaround shipped 2026-09-27 (PR #451). Resolves a critical scalability issue for repositories with large cache files by switching to the Blob API to read the `repo-cache.json` snapshot database, ensuring reliable state tracking across larger portfolios.

Governance execution flow and audit logic simplified 2026-09-27 (PRs #448, #450). Reduces technical debt and optimizes the scheduled apply path by moving the `runApply` routine out of the main index and consolidating shared `eligibleRepos` and `listOpenPRs` predicates across the active governance audits.

Modular test suite architecture for report generation shipped 2026-09-28 (PR #453). Improves codebase maintainability and test readability by splitting the large, consolidated `report.test.js` file into modular, per-module test files, resolving technical debt and simplifying future test coverage expansion.

Roadmap and developer guidelines aligned with simplification pass tracking 2026-09-28 (PR #455). Points the project's living roadmap and developer guidelines to a central tracking issue to coordinate active architectural simplification and complexity reduction goals.

Portfolio report split into data and rendering 2026-09-30 (PR #456). `fetchPortfolioDetails` and the dependency-inventory analysis moved to `report-portfolio-data.js`, so GOVERNANCE no longer loads the dashboard renderer; its cache-hit refresh and fresh fetch now resolve their parallel reads by name rather than by position.

Dead-export sweep 2026-09-30 (PR #458). Thirteen exports nothing imported were made module-private, the unused `sanitizeContributorName` was deleted, and `report.js` stopped re-exporting other report modules.

Simplification-pass review follow-ups closed 2026-09-30 (PRs #465-#470). The report template-hash list is one exported constant checked against every `src/report*.js` file (#465); the npm refresh invocation's flags and environment are pinned by a test (#466); the CODEOWNERS owner must be a valid GitHub login before it is written to another repo (#467); templated-workflow detection derives its filenames from the templates (#468); the MCP/dashboard campaign parity test runs the real MCP computation (#469); and `observe()` resolves its fourteen fetches by name (#470).

Roadmap approval and proposal configuration split shipped 2026-10-01 (PR #471). Refines the agent's live planning safety gates by splitting the monolithic `require_approval` flag into two distinct control configurations: `apply_enabled` for governing direct automated remediation runs, and `propose_live` for managing automated roadmap proposal issues, resolving issue #423.

Private repository watcher archived-status safety check shipped 2026-10-01 (PR #474). Prevents automation noise and errors by ensuring the private repository watcher gracefully skips archived private repositories during scheduled discovery and monitoring loops.

Core scanning logic refined to differentiate unreadable scanners from disabled ones shipped 2026-10-02 (PR #472). This ensures more accurate state representation and error handling during repository observation by preventing transient read failures from being misclassified as disabled features, resolving issue #452.

Plan for making the event and A2A surfaces real drafted 2026-10-02 (PR #476). Keeps the AsyncAPI spec and A2A agent card and sets out a default-closed implementation gated on a named consumer.

Model Context Protocol capabilities enhanced with provisional tier flagging shipped 2026-10-07 (PR #482). Refines the project's LLM and MCP ecosystem integration by explicitly highlighting provisional tiers on the MCP surfaces.

Localized pixel-art comic mod with ASCII fallbacks shipped 2026-10-07 (PRs #479, #480). Introduces a localized, expressive visual branding experience tailored to active checkout sessions, complete with a robust ASCII fallback system.

Provisional tier communication and unread scanner telemetry hardened 2026-10-07 (PRs #484, #485, #486). Improves user expectation management and dashboard accuracy by explicitly labeling provisional tiers as "Unconfirmed" across dashboards, pages, and badges, and refines integration error handling by ensuring a Dependabot 403 rate-limit or permission error is correctly flagged as an unread scanner state rather than misleadingly reporting zero alerts.

Automated repository governance safeguards and update logic refined 2026-10-07 (PRs #488, #489). Introduces a proactive security flag to identify and prevent auto-merges lacking required status checks, and resolves a logic bug to ensure reference counts are accurately recorded anywhere in the "Implemented" log.

Onboarding refinement and agent standardization shipped 2026-10-07 (PR #491). Consolidates agent-related consumer instructions into a single, standardized `AGENTS.md` guide and explicitly prevents the creation of redundant `CLAUDE.md` files to polish the onboarding flow and reduce repository configuration clutter.

Agent instruction standardization and onboarding polish shipped 2026-10-07 (PR #492). Standardizes agentic guidelines by renaming and transitioning `CLAUDE.md` to `AGENTS.md` to align with modern agentic repository workflows and ensure seamless self-planning during scheduled runs.

---

## Next Up

Active work. Everything here is unfinished; shipped items move to the log above.

### Simplification pass — AGENTS.md restructure remaining (tracking issue #429)

A 2026-09-26 audit of code, docs, tests and CI was turned into three waves of small, independently reviewed PRs, and all three are merged, along with the follow-ups #440, #452/#477 and #481. What remains is the AGENTS.md (formerly CLAUDE.md) restructure, which documents the outcome of three owner decisions still on hold: #424 (reusable Action or own-portfolio tool) and the linked #425 and #426. #423, #427 and the #452 tier rule are settled, and #428 waits only on an App permission grant. Issue #429 is the single source of truth: its "Resume here" block carries the next step and the working rules, and its checklist is ticked as each PR merges.

### Cross-repo PROPOSE — finishing the G10 graduation (ADR-010, ADR-011)

The G1–G9 machinery is on `main` and the month-long dry-run soak is complete. G10 graduated the first class/target pair on 2026-07-21 (`standards-gap`, targeting `github-issue-triage-bot`) — chosen over the originally-slated tier-uplift because the soak evidence anchored there, a deviation recorded in ADR-010's "G10 graduation" note.

Two of the three flips remain, each its own reviewed change: `propose_live: true` in `.github/roadmap.yml` (PROPOSE only; it no longer touches apply), and `INPUT_DRY_RUN: false` in `weekly-ideate.yml`. Until both land, the weekly run still files nothing — its only writes are the idempotent host-label ensure and the routing-record append to `snapshots/propose-soak.json`. G11 (optional net-new deterministic classes: description-gap, topics-gap) stays parked behind that.

### Release cadence standard — promotion pending

Born from the 2026-07 portfolio-wide release drift, when the whole early-April manual release batch crossed the 90-day gold boundary at once and dropped the portfolio from 14/14 gold to 5/14 in a single week, eight repos failing exactly one check.

The `release-cadence` universal standard now detects release automation (any workflow whose name or path mentions "release", reusing the existing `/actions/workflows` fetcher — so hand-rolled publish pipelines count as compliant), and a templatable apply class remediates gaps with a scheduled patch-release workflow: on the 1st and 15th it cuts a patch release when the latest is at least 60 days old and unreleased commits exist, keeping worst-case staleness inside the 90-day tier window. Fail-safe by construction — it skips repos with no published release, non-semver tags, or nothing to release, and only reads git history plus `gh release create`.

It ships manual-dispatch only, absent from both `apply-schedule` and `apply-automerge`, per the ADR-007 one-class-at-a-time promotion ladder. Promotion waits on a track record. Release *recency* remains the tier-uplift finding's job, so the two compose: the standard installs the machinery, the machinery keeps the gold check passing.

### Roadmap maintenance — keeping this document small

This document hit the 60,000-character `validateRoadmap` ceiling on 2026-07-26 with 272 characters of headroom, because the UPDATE phase appends to `## Implemented` on every run while `compactRoadmap` only ever compacted struck-through `###` subsections. The growing section was the one the compactor could not reach.

`compactShippedLog` closes that gap: dated prose entries older than `compact_after_days` are rolled up in place to one machine-generated line per month, keeping every PR reference and dropping the prose to git history. Undated paragraphs — the evergreen capability description, and hand-written month summaries like the three above — are passed through untouched. Deferred and worth revisiting if the document grows again: `compactRoadmap` still skips struck subsections that carry no date at all, and shipped bullets nested inside active sections are never compacted because only `###` blocks are eligible.

### Dashboard round-two follow-ons

The calm & adaptive front page shipped, but two pieces were deliberately deferred: reframing the per-repo page on the same arc, and a compose-by-repo rollup. Neither is started.

---

## Future

Ideas for later evaluation, not commitments.

**External tool metric consumption** — Auto-discover SonarCloud (`.sonarcloud.properties`) or CodeClimate (`.codeclimate.yml`) configuration and pull maintainability grades into the health matrix; read Renovate's Dependency Dashboard issue for pending update counts. All opt-in. (The triage-bot auto-discovery pattern this used to point at was deleted with that integration in PR #252, so there is no longer a worked example in the tree to copy.) Also evaluate `ossf/scorecard` as a security signal that could feed or complement the health tier model rather than the butler computing its own metrics.

**Skills and documentation review** — Evaluate the research at `docs/research/2026-04-02-skills-and-documentation-landscape.md`: distributing per-repo governance findings as Claude Code skills via the onboarding workflow, YAML frontmatter on ADRs for machine-parseability, and a documentation taxonomy consistent across the butler and the triage bot. The butler's unique skill opportunity is cross-repo findings, not generic documentation — the ETH Zurich study found auto-generated context files reduced task success.

**Phase 8 — triage bot contract** — RETIRED, and the entry that described it was wrong on every check. The integration code was removed in PR #252 on 2026-05-31: `src/triage-bot.js` and `validateTriageBotTrends` no longer exist, so the "touchpoints if the bot is archived" it listed had already gone. The bot is not being archived either — `github-issue-triage-bot` is active and is the first enabled cross-repo PROPOSE target. What survived the code removal was the documentation, for three months, including a `SECURITY.md` paragraph describing an SSRF guard (`validateBotUrl`) with no implementation. The lane boundary in ADR-001/ADR-002 is untouched and still governs what the butler does not do; the A2A AgentCard half of Phase 8 shipped and is discovery-only.

**Phase 9 — live event emission** — The AsyncAPI 3.0 spec at `docs/asyncapi.yml` defines two channels (`healthTierChanged`, `governanceProposalOpened`) over GitHub `repository_dispatch`, validated by a structural smoke test in CI. Live emission is parked rather than scheduled: no workflow subscribes to `repository_dispatch` today, so a push transport would emit into the void. (The earlier rationale — that the one prospective subscriber was being retired — was wrong on its facts; the triage bot is active. What was retired is the HTTP integration, not the bot. The parking still holds on the absence of any subscriber.) Per ADR-003's ordering, the event layer waits until a consumer exists to justify push over pull. See [ADR-008](docs/decisions/008-event-emission.md).

**Phase 10 — agents and execution** — Feature-complete as of 2026-06-15; retained here for the design record. Execution splits by the nature of the finding, per [ADR-007](docs/decisions/007-agents-and-execution.md). Track A covers templatable findings and reached full automation by relaxing ADR-005's gates incrementally and per finding-class (manual dispatch → schedule, dry-run → live, with the apply master switch retained, now `apply_enabled`). Track B covers reasoning findings and is agent-driven, evolving local-first: the butler emits a structured remediation plan per finding as a portable contract, the `repo-butler-apply` skill consumes it locally and opens PRs for human review, and the hardened logic then lifts into a hosted agent consuming the same contract. Decoupling the decision logic from the runtime is what lets the local stage transfer to the cloud without a rewrite. Selective per-class auto-merge is the destination and is live for four template classes.

## What NOT to build

Cross-platform identity resolution (GitHub + Slack + Discord) — that's Orbit/Common Room territory. File-level code ownership analysis — requires git cloning, which breaks the API-only architecture. Natural-language data querying — cool, but requires a database. Grafana dashboards — the static HTML approach is the right constraint. Anything requiring self-hosted infrastructure — the zero-cost, zero-dependency positioning is the moat. Per-repo code improvement suggestions — that's the triage bot's domain (see ADR-002).

## Relationship to Other Tools

The butler consumes, it doesn't compete. Renovate handles dependency updates — the butler installs Renovate across the portfolio. Dependabot handles security alerts — the butler reads them and propagates Dependabot config to repos that lack it. The triage bot handles per-issue intelligence and per-repo improvement proposals — the butler reads its trends, configures it on new repos, and focuses on portfolio-level governance. SonarCloud handles code quality — the butler reads its scores. GitHub's community health profile defines the checklist — the butler runs through it across every repo and fixes the gaps.

The boundary is clear: the triage bot goes deep on one repo, the butler goes broad across the portfolio. The triage bot says "issue #47 is a duplicate of #12." The butler says "you adopted CodeRabbit in 5 repos — here are the 14 that should have it too."

## Landscape — Multi-Repo Tools

Evaluated 2026-05-28; the full catalogue of eleven tools, with per-tool verdicts, lives in [the landscape evaluation](docs/research/2026-05-28-multi-repo-tooling-landscape.md) and is not duplicated here.

Headline conclusion: embed no external tool into the Action runtime. The zero-dependency, API-only, zero-infra moat rules out clone-based CLIs (`multi-gitter`, `git-xargs`, `turbolift`) and self-hosted Probot apps (`safe-settings`, `allstar`). Community-health-file propagation extends `apply.js` natively rather than adopting `repo-file-sync-action`; `multi-gitter` is retained as a documented manual escape-hatch for complex migrations `apply.js` cannot template; `ossf/scorecard` is deferred as a future OBSERVE signal. Worth learning from rather than adopting: `octoherd`'s per-repo function model, `safe-settings`' config hierarchy, and GitHub's own org-level Rulesets and Custom Properties for targeting — see the [Well-Architected Framework](https://wellarchitected.github.com) for the first-party governance guidance.
