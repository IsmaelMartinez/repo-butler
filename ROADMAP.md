# Repo Butler — Roadmap

**Last Updated:** 2026-09-30
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

**2026-08** — 1 entry (#359). Full details in git history.

G8 MCP staleness guard shipped 2026-08-02 (PR #361). Two changes with one cause: the server *re-derived* what it could *report*. `weekTier()` now reads the `computed.tier` that `store.js` wrote into each weekly snapshot instead of recomputing it, because `computeHealthTier` measures release and push age against `Date.now()` — so re-deriving an archived week re-scored it with today's clock and historical Gold counts decayed purely as the snapshots aged, which is not a trend. And every tool answering from the data branch now carries a `staleness` envelope: the age of the data served, how far the checkout is behind `origin/main`, and a warnings array that is empty when both are healthy. It is attached in `callTool` rather than per-handler so a new tool cannot ship without one, and the opt-out set is pinned by a test to the two tools that read nothing from the branch. Reporting rather than fetching is deliberate — a read-only tool should not perform a network write on the caller's repository as a side effect of being asked a question — and an unreadable probe warns rather than staying silent, since "could not check" and "checked, it is fine" must not look alike. Three defects motivated it inside a week: the missing fetch that produced a briefing claiming 12 Gold against a true 7, the release exemption above, and the clock-drift recompute.

UPDATE prompt merged-PR context shipped 2026-08-02 (PR #362). The section-edit prompt is now given the titles and numbers of recently merged PRs rather than only a 90-day count, which is what its own instructions had always told the model to reason about. Entry generation no longer depends on the assessment prose happening to name the work. This entry is itself the first output of that change. It does not, on its own, stop entries being lost: a separate defect in the refresh path rebuilds the document from the default branch on every tick and overwrites the open PR, so each tick discards the previous tick's entry.

Roadmap refresh baseline fixed 2026-08-02 (PR #364). When a roadmap PR was already open, UPDATE rebuilt the document from the default branch and pushed that over the PR, so each of the day's four ticks discarded the previous tick's entry. The refresh now reads the roadmap from the open PR's head ref and builds on that, falling back to the default-branch copy when the branch read fails. `update()` gained a `context.gh` test seam — nothing in the pipeline sets it — because the only function that writes `ROADMAP.md` had no test at all, and the helper-level tests all passed with the defect restored; only an end-to-end test of the refresh wiring fails.

Skill staleness signal shipped 2026-08-02 (PR #365), closing the second half of #350. The installed skills are symlinks into a checkout's working tree, so the live skill is whatever that checkout currently is — an unpulled `main`, a feature branch, or an uncommitted edit — and nothing reported the discrepancy, which is why PR #291's comic uplift kept rendering the old version for days after it merged. The behind-main probe moved out of `src/mcp.js` into `src/staleness.js` so both surfaces share one classification rather than growing a second hand-rolled copy that could report a reassuring zero; `src/skill-staleness.js` and the `scripts/check-skills.js` CLI answer the skills' version of the question, and both skills now run it and surface the reading — the briefing as an almanac line in the frame, the apply skill as a caveat prepended to every confirmation prompt. Two findings were worth the measuring. Node collapses `..` lexically, so handing the registry path straight to `node` never traverses the symlink and looks for the script beside the registry instead — the skill must `cd -P` first. And a checkout old enough to lack `scripts/check-skills.js` predates this very check, so empty output is a positive staleness signal rather than a failed one. The apply-side reading is deliberately not a new gate: refusing to act on a stale revision is the owner's call, and a skill that refuses is one more thing to work around.

Skill staleness alerts and refresh-build stability shipped 2026-08-02 (PRs #364, #365). Fixes a critical workflow logic issue by ensuring roadmap refresh builds construct their baseline from the active pull request branch rather than defaulting to main, preventing subsequent ticks from overwriting unmerged entries. Additionally, introduces a feedback mechanism that alerts users when a running skill diverges from the version on the main branch, resolving the working-tree staleness gap (#350).

Routine dependency update shipped 2026-08-06 (PR #367), updating minor and patch dependencies across the codebase to ensure ongoing stability and security.

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

Portfolio report data and rendering logic decoupled 2026-09-30 (PR #456). Improves codebase maintainability and simplifies future reporting feature extensions by splitting the monolithic `report-portfolio.js` into separate data extraction and rendering components.

Dead export cleanup and code simplification shipped 2026-09-30 (PR #458). Reduces technical debt and improves internal codebase maintainability by sweeping away dead exports and unused code references, resolving issue #422.

---

## Next Up

Active work. Everything here is unfinished; shipped items move to the log above.

### Simplification pass — wave 3 in progress (tracking issue #429)

A 2026-09-26 audit of code, docs, tests and CI was turned into three waves of small, independently reviewed PRs. Waves 1 and 2 are merged. Wave 3 is sequential: #420 is done, and #421 (splitting `report-portfolio.js` into data and rendering) is next, then #422 (the dead-export sweep). A CLAUDE.md restructure goes last. Six owner decisions, #423–#428, are open and gate their own code, and #423 must be settled before the G10 `require_approval` flip. Issue #429 is the single source of truth: its "Resume here" block carries the next step and the working rules, and its checklist is ticked as each PR merges.

### Cross-repo PROPOSE — finishing the G10 graduation (ADR-010, ADR-011)

The G1–G9 machinery is on `main` and the month-long dry-run soak is complete. G10 graduated the first class/target pair on 2026-07-21 (`standards-gap`, targeting `github-issue-triage-bot`) — chosen over the originally-slated tier-uplift because the soak evidence anchored there, a deviation recorded in ADR-010's "G10 graduation" note.

Two of the three flips remain, each its own reviewed change: `require_approval: false` in `.github/roadmap.yml`, and `INPUT_DRY_RUN: false` in `weekly-ideate.yml`. Until both land, the weekly run still files nothing — its only writes are the idempotent host-label ensure and the routing-record append to `snapshots/propose-soak.json`. G11 (optional net-new deterministic classes: description-gap, topics-gap) stays parked behind that.

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

**Phase 10 — agents and execution** — Feature-complete as of 2026-06-15; retained here for the design record. Execution splits by the nature of the finding, per [ADR-007](docs/decisions/007-agents-and-execution.md). Track A covers templatable findings and reached full automation by relaxing ADR-005's gates incrementally and per finding-class (manual dispatch → schedule, dry-run → live, with `require_approval` retained as the master switch). Track B covers reasoning findings and is agent-driven, evolving local-first: the butler emits a structured remediation plan per finding as a portable contract, the `repo-butler-apply` skill consumes it locally and opens PRs for human review, and the hardened logic then lifts into a hosted agent consuming the same contract. Decoupling the decision logic from the runtime is what lets the local stage transfer to the cloud without a rewrite. Selective per-class auto-merge is the destination and is live for four template classes.

## What NOT to build

Cross-platform identity resolution (GitHub + Slack + Discord) — that's Orbit/Common Room territory. File-level code ownership analysis — requires git cloning, which breaks the API-only architecture. Natural-language data querying — cool, but requires a database. Grafana dashboards — the static HTML approach is the right constraint. Anything requiring self-hosted infrastructure — the zero-cost, zero-dependency positioning is the moat. Per-repo code improvement suggestions — that's the triage bot's domain (see ADR-002).

## Relationship to Other Tools

The butler consumes, it doesn't compete. Renovate handles dependency updates — the butler installs Renovate across the portfolio. Dependabot handles security alerts — the butler reads them and propagates Dependabot config to repos that lack it. The triage bot handles per-issue intelligence and per-repo improvement proposals — the butler reads its trends, configures it on new repos, and focuses on portfolio-level governance. SonarCloud handles code quality — the butler reads its scores. GitHub's community health profile defines the checklist — the butler runs through it across every repo and fixes the gaps.

The boundary is clear: the triage bot goes deep on one repo, the butler goes broad across the portfolio. The triage bot says "issue #47 is a duplicate of #12." The butler says "you adopted CodeRabbit in 5 repos — here are the 14 that should have it too."

## Landscape — Multi-Repo Tools

Evaluated 2026-05-28; the full catalogue of eleven tools, with per-tool verdicts, lives in [the landscape evaluation](docs/research/2026-05-28-multi-repo-tooling-landscape.md) and is not duplicated here.

Headline conclusion: embed no external tool into the Action runtime. The zero-dependency, API-only, zero-infra moat rules out clone-based CLIs (`multi-gitter`, `git-xargs`, `turbolift`) and self-hosted Probot apps (`safe-settings`, `allstar`). Community-health-file propagation extends `apply.js` natively rather than adopting `repo-file-sync-action`; `multi-gitter` is retained as a documented manual escape-hatch for complex migrations `apply.js` cannot template; `ossf/scorecard` is deferred as a future OBSERVE signal. Worth learning from rather than adopting: `octoherd`'s per-repo function model, `safe-settings`' config hierarchy, and GitHub's own org-level Rulesets and Custom Properties for targeting — see the [Well-Architected Framework](https://wellarchitected.github.com) for the first-party governance guidance.
