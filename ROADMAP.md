# Repo Butler — Roadmap

**Last Updated:** 2026-08-02
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

Governance is a first-class phase with five deterministic finding types, each carrying a remediation plan (an executor hint plus a change spec). Findings reach the dashboard, the MCP server and the apply path. Consumers are served by a zero-dependency MCP server (`src/mcp.js`), JSON Schema 2020-12 data contracts in `schemas/v1/`, an A2A AgentCard and an AsyncAPI 3.0 spec — the latter two discovery-only, with no live transport.

### Shipped log

**2026-03** — foundations. The full seven-phase pipeline, richer observation (community profile, Dependabot alerts, CI pass rate, bus factor), richer reports (PR triage, staleness, blocked-issue context, heatmaps, SVG badges, SBOM), the tiered health model replacing the numeric score, structured issue specs with Jaccard duplicate detection, the Phase 6 JSON Schema data contracts, and the Phase 7 MCP server (#18–#60). Full details in git history.

**2026-04** — hardening and the portfolio view. The security trifecta (three scanners, `release_exempt`), GitHub App token for vulnerability access, graded license-concern severity, bug-only Gold tier, auto-onboarding PRs, the Node runtime fix, the dashboard narrative restructure, private-repo discovery via `/installation/repositories`, the multi-agent Code Health Sprint and its follow-ups, and the portfolio hardening sweep (#63–#157). Full details in git history.

**2026-05** — governance, agents and the UPDATE rebuild. The Phase 5 governance engine (standards gaps, policy drift, tier uplift) with its dashboard and cross-repo apply path, ADR-007 Track A stage 3 and Track B stages 1–2 (remediation plans plus executor routing), the butler skills consolidation and Reginald uplift, the landscape evaluation concluding that no external tool gets embedded, and the UPDATE phase's graduation off dry-run after section-edit mode replaced full-document reproduction (#175–#244). Full details in git history.

Section-edit mode (PR #231, May 2026) is worth calling out separately, as the mechanism this document depends on: the LLM receives the roadmap as read-only context and emits a JSON array of append operations, which the code applies deterministically. It can add content but never delete or rewrite. Three models had previously proved unable to reproduce the document verbatim, and four safety guards correctly caught every bad edit — which meant no PR was ever created. Run time dropped from ~40s to ~6s.

Roadmap PR noise reduction shipped 2026-06-12 (PR #263), skipping PRs when the only change is the date.

Roadmap scheduled-action and reference-append refinements shipped 2026-06-13 (PRs #265, #266).

ADR-007 stage 5 auto-merge was armed class by class through mid-June: security-md 2026-06-16 (PR #278), codeowners 2026-06-16 (PR #282), and code-scanning 2026-06-17 (PR #284), joining dependabot-actions. A CI reliability fix for false-positive cache-hit failures landed alongside (PR #280), with documentation repointed at Copilot for ADR-009 go-live (PR #279).

AsyncAPI event-driven core shipped 2026-06-18 (PR #286). Implemented the pure, GitHub-free tier-change detection core (`src/tier-change.js`) that diffs computed health tiers against the last-emitted state.

Calm & adaptive portfolio dashboard shipped 2026-06-19 (PR #288). Reframed the front page around a state-driven status hero, a week-over-week Gold trend, and a "Since the last run" delta strip, with large reference tables collapsing for repos that meet the Gold standard. This gave `detectTierChanges` its first live consumer on the pull side.

Scene-of-the-day comic briefing skill shipped 2026-06-20 (PR #291).

Cross-repo PROPOSE safety machinery shipped 2026-06-22 to 2026-06-23 (PRs #298–#303). G3 cross-reference autolink neutralisation and the G4 deterministic finding-anchoring gate, then the gate wired into the write path behind empty allow-lists (#300), a per-target two-axis volume cap (#301), a closed-issue look-back in `findDuplicates` (#302), and the council quality filter demoting weakly-grounded cross-repo ideas to the watchlist (#303).

Cross-repo issue format shipped 2026-06-24 (PR #304). A deterministic body composed from the anchoring finding's statistic rather than LLM free text, a distinct `portfolio-nudge` label, an onboarding-marker precondition that falls back to the host backlog, and a host-side umbrella tracking issue back-linked by bare URL.

Cross-repo PROPOSE graduated its first class 2026-07-21 (PR #326). `standards-gap` became the first enabled cross-repo class, with `github-issue-triage-bot` the first enabled target.

Dependabot and monitor workflow optimisations shipped 2026-07-25 (PRs #342, #343), skipping monitor jobs on Dependabot events and suppressing nudges on deterministically-failing PRs. A configuration update marked a wound-down generator release-exempt (PR #344).

Deterministic-failure SHA verification corrected 2026-07-26 (PR #345). A moved head SHA is now treated as evidence *of* failure rather than against it.

Dependency sweep 2026-07-26 (PRs #328, #329). Actions majors bumped across all nine workflows. Portfolio-wide, 20 of 22 open Dependabot PRs merged (oldest 34 days); 7 needed a root-cause fix. The survivor is a `typescript` 6→7 bump, blocked on `typescript-eslint` TS 7 support (upstream #10940).

Roadmap restructured and the shipped log compacted 2026-07-27 (PR #349). The document is now organised around what has been built and what is in flight, with older work rolled up to one line per month. `compactShippedLog` closes the gap that let it reach the 60,000-character `validateRoadmap` ceiling with 272 characters to spare: UPDATE appends to `## Implemented` on every run, but `compactRoadmap` only ever reached struck-through `###` subsections — so the one part of the document that grew was the one part compaction could not touch. Undated paragraphs pass through untouched, which is what keeps the evergreen prose and the hand-written month summaries safe. 60,000 → 21,224 characters.

Roadmap append spacing fixed 2026-07-27 (PR #352). Appended entries landed flush against the following `---`, which CommonMark reads as a setext heading underline, so the last entry in a section rendered as an `<h2>` and the horizontal rule vanished. Live since at least #330 and invisible in a diff — it showed only in the rendered file.

Private-repo security watch shipped 2026-07-27 (PR #348). repo-butler is itself public, so it has three world-readable sinks rather than one: the Pages dashboard, the data branch, and the Actions run logs. `src/private-watch.js` is a standalone pass outside the pipeline that reads each private repo's alerts and delivers acute findings — critical or high, plus any secret-scanning hit — to one tracking issue on that private repo, rewritten in place and closed when the repo comes clean. An earlier attempt feeding private repos through the governance detectors with per-finding redaction was abandoned after review found 14 disclosure paths, because `context.repoDetails` and `context.governanceFindings` are shared across phases in one process and reach the report, the IDEATE prompt and the PROPOSE soak ledger without passing any filter. Redaction applied to a shared carrier is a convention, and conventions lose. A mutation-verified guard in `src/governance.test.js` fails if a detector call is widened to include private repos. The deliberate limitation stands: per-repo tuning lives in `.github/roadmap.yml` in a public repo, so the config surface cannot hold a secret, which is why private repos get watching only and not full governance.

G7 Gold-ratchet tier-regression detector shipped 2026-07-29 (PR #354). Detects that a repo's health tier fell since the previous weekly portfolio snapshot, diffed via the shared `detectTierChanges` core against `readLatestPortfolioWeekly({ beforeWeek })` so the finding persists for its whole week across the four-times-daily runs. Routes to `executor: 'manual'` — the route back up a tier lives in the companion tier-uplift finding.

G12 stale-butler-PR audit shipped 2026-07-29 (PR #355). The mirror of the Dependabot audit aimed at the butler itself: it detects `repo-butler/*` PRs the butler opened on target repos and nobody landed. It reads a new five-state `gh.prCiState` (`green|red|pending|none|unknown`) rather than `prCiGreen`, because that helper is a merge-authorisation guard collapsing red, pending, no-CI-at-all and API errors into one `false`. It reports persistence rather than attempting blame attribution. `roadmap-update` PRs are excluded by construction, since UPDATE force-pushes a fresh head every run, so their CI is always in flight and their age never resets. It shares one open-PR sweep with the Dependabot audit.

ADR-013 content-transformation trust model and the G6 trimmer shipped 2026-07-29 (PR #356). `src/trimmer.js` is the deciding core for transitive-vulnerability remediation: given a parsed npm lockfile, a manifest and an alert it returns either a parent-scoped `overrides` change or an explicit refusal with a reason. It is pure and has no caller in the write path, so it changes nothing until wired deliberately. It is the first capability that would transform file content the butler did not author, breaking the ADR-005 invariant that every cross-repo write is a fixed string. Its scope is narrower than "fix transitive vulns": `reachable-by-update` is a refusal, because Dependabot was found to be stalled rather than incapable, and only the `0.x`-capped shape genuinely needs an override. The range fence is a release-line test, not a major-line one, because inside `0.x` every minor is its own breaking line.

G13 stalled-alert detector and ADR-014 shipped 2026-07-29 (PRs #357, #358). It reports an open Dependabot alert at or above `medium` severity — deliberately below the critical/high bar of the open-vulnerability finding — older than 14 days, with no open Dependabot PR addressing that package, and classifies why it is stuck. ADR-014 records that the rescan-forcing half of the original proposal is impossible: the spike closed four routes and `dependabot/dependabot-core#6098` is closed as not planned. Detection is what replaced the rescan rather than a consolation prize. It fails closed, so an unreadable manifest yields `classification: 'unknown'` and the finding is still emitted, and PR matching errs toward silence, since grouped Dependabot PRs do not name their contents. The motivating case sat open thirty-five days on a repo where every existing signal reported health.

MCP release exemption fixed 2026-08-01 (PR #359). `src/mcp.js` never loaded `.github/roadmap.yml`, so every tier it computed dropped the `release_exempt` list and reported two deliberately-exempt repos a tier below what the rest of the pipeline read — a phantom regression in the 2026-07-30 briefing. `loadConfigSync` is the synchronous twin of `loadConfig` that `callTool`'s synchronous dispatch needs, and it is deliberately silent on a missing config because a stray log on stdout would corrupt the JSON-RPC frames. A source-level test asserts every `computeHealthTier` call in the file goes through `tierOptions()`, so a new call site cannot silently omit the exemption.

G8 MCP staleness guard shipped 2026-08-02 (PR #361). Two changes with one cause: the server *re-derived* what it could *report*. `weekTier()` now reads the `computed.tier` that `store.js` wrote into each weekly snapshot instead of recomputing it, because `computeHealthTier` measures release and push age against `Date.now()` — so re-deriving an archived week re-scored it with today's clock and historical Gold counts decayed purely as the snapshots aged, which is not a trend. And every tool answering from the data branch now carries a `staleness` envelope: the age of the data served, how far the checkout is behind `origin/main`, and a warnings array that is empty when both are healthy. It is attached in `callTool` rather than per-handler so a new tool cannot ship without one, and the opt-out set is pinned by a test to the two tools that read nothing from the branch. Reporting rather than fetching is deliberate — a read-only tool should not perform a network write on the caller's repository as a side effect of being asked a question — and an unreadable probe warns rather than staying silent, since "could not check" and "checked, it is fine" must not look alike. Three defects motivated it inside a week: the missing fetch that produced a briefing claiming 12 Gold against a true 7, the release exemption above, and the clock-drift recompute.

UPDATE prompt merged-PR context shipped 2026-08-02 (PR #362). The section-edit prompt is now given the titles and numbers of recently merged PRs rather than only a 90-day count, which is what its own instructions had always told the model to reason about. Entry generation no longer depends on the assessment prose happening to name the work. This entry is itself the first output of that change. It does not, on its own, stop entries being lost: a separate defect in the refresh path rebuilds the document from the default branch on every tick and overwrites the open PR, so each tick discards the previous tick's entry.

Roadmap refresh baseline fixed 2026-08-02 (PR #364). When a roadmap PR was already open, UPDATE rebuilt the document from the default branch and pushed that over the PR, so each of the day's four ticks discarded the previous tick's entry. The refresh now reads the roadmap from the open PR's head ref and builds on that, falling back to the default-branch copy when the branch read fails. `update()` gained a `context.gh` test seam — nothing in the pipeline sets it — because the only function that writes `ROADMAP.md` had no test at all, and the helper-level tests all passed with the defect restored; only an end-to-end test of the refresh wiring fails.

---

## Next Up

Active work. Everything here is unfinished; shipped items move to the log above.

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

### Live skills are still bound to a working tree (#350)

The MCP half of this shipped as G8 (see the log above). The skills half has not. `scripts/install-skills.sh` symlinks `skills/<name>` into the local registry, which is the right design — a merge takes effect with no copy step — but it binds the running skill to that checkout's *working tree*. So the live skill is whatever the checkout currently is: an unpulled `main`, a feature branch, or an uncommitted edit. PR #291's comic uplift kept rendering the old version after merge for exactly this reason, and writing to the registry path turns out to edit the repo itself.

What the MCP half suggests for this one is that the fix is a staleness signal rather than an installer: something that reports how far the linked checkout is behind, and says so at the point of use. `computeStaleness` in `src/mcp.js` is the shape to reuse — a skill could surface the same `commits_behind_main` reading in its output rather than rendering confidently from an unknown revision.

### ~~UPDATE loses what it records~~ SHIPPED

Both halves have now shipped, and the first diagnosis was wrong in a way worth keeping on the record.

The visible symptom was that #354, #355 and #356 never reached the shipped log and had to be backfilled by hand on 2026-08-01. The first explanation was that the prompt never carried merged PR titles — only a 90-day count — so entry generation depended on the assessment prose happening to name the work. That was a real defect and shipped as #362, but it was not the cause. Reading #353's commit history showed the LLM had written a correct entry on *every* tick: #354, then #355, then #356, then #357/#358, each one replacing the last.

The actual cause was that a refresh rebuilt the document from the default branch. `snapshot.roadmap` is what OBSERVE read from `main`, and using it as the baseline meant each tick appended its entry to `main`'s copy and pushed that over the open PR, discarding the previous tick's work. Entries were never re-offered either, because ASSESS computes `new_merged_prs` against the previous snapshot, so a PR that was new last tick is not new this tick — lost meant lost. Fixed by reading the roadmap from the open PR's head ref before compaction and using that as the baseline, falling back to the snapshot when the branch copy is unreadable.

The lesson is the one this codebase keeps relearning: a plausible cause that explains the symptom is not the same as the cause. The prompt gap was real, visible in a diff, and would have been accepted as the explanation if the commit history of the failing PR had not been read.

### Dashboard round-two follow-ons

The calm & adaptive front page shipped, but two pieces were deliberately deferred: reframing the per-repo page on the same arc, and a compose-by-repo rollup. Neither is started.

---

## Future

Ideas for later evaluation, not commitments.

**External tool metric consumption** — Auto-discover SonarCloud (`.sonarcloud.properties`) or CodeClimate (`.codeclimate.yml`) configuration and pull maintainability grades into the health matrix; read Renovate's Dependency Dashboard issue for pending update counts. All opt-in, following the triage bot auto-discovery pattern. Also evaluate `ossf/scorecard` as a security signal that could feed or complement the health tier model rather than the butler computing its own metrics.

**Skills and documentation review** — Evaluate the research at `docs/research/2026-04-02-skills-and-documentation-landscape.md`: distributing per-repo governance findings as Claude Code skills via the onboarding workflow, YAML frontmatter on ADRs for machine-parseability, and a documentation taxonomy consistent across the butler and the triage bot. The butler's unique skill opportunity is cross-repo findings, not generic documentation — the ETH Zurich study found auto-generated context files reduced task success.

**Phase 8 — triage bot contract** — PAUSED 2026-05-03; archival under consideration since 2026-05-25. The integration ships no signal in practice: only 2 of the portfolio repos carry `.github/butler.json`, `TRIAGE_BOT_INGEST_SECRET` is unset, and the `/ingest` path is a no-op. If the bot is archived, the butler's touchpoints are `src/triage-bot.js`, `validateTriageBotTrends` in `safety.js`, and this entry. The A2A AgentCard half of Phase 8 has shipped and is discovery-only.

**Phase 9 — live event emission** — The AsyncAPI 3.0 spec at `docs/asyncapi.yml` defines two channels (`healthTierChanged`, `governanceProposalOpened`) over GitHub `repository_dispatch`, validated by a structural smoke test in CI. Live emission is parked rather than scheduled: no workflow subscribes to `repository_dispatch` today and the one prospective subscriber is being retired, so a push transport would emit into the void. Per ADR-003's ordering, the event layer waits until a consumer exists to justify push over pull. See [ADR-008](docs/decisions/008-event-emission.md).

**Phase 10 — agents and execution** — Feature-complete as of 2026-06-15; retained here for the design record. Execution splits by the nature of the finding, per [ADR-007](docs/decisions/007-agents-and-execution.md). Track A covers templatable findings and reached full automation by relaxing ADR-005's gates incrementally and per finding-class (manual dispatch → schedule, dry-run → live, with `require_approval` retained as the master switch). Track B covers reasoning findings and is agent-driven, evolving local-first: the butler emits a structured remediation plan per finding as a portable contract, the `repo-butler-apply` skill consumes it locally and opens PRs for human review, and the hardened logic then lifts into a hosted agent consuming the same contract. Decoupling the decision logic from the runtime is what lets the local stage transfer to the cloud without a rewrite. Selective per-class auto-merge is the destination and is live for four template classes.

## What NOT to build

Cross-platform identity resolution (GitHub + Slack + Discord) — that's Orbit/Common Room territory. File-level code ownership analysis — requires git cloning, which breaks the API-only architecture. Natural-language data querying — cool, but requires a database. Grafana dashboards — the static HTML approach is the right constraint. Anything requiring self-hosted infrastructure — the zero-cost, zero-dependency positioning is the moat. Per-repo code improvement suggestions — that's the triage bot's domain (see ADR-002).

## Relationship to Other Tools

The butler consumes, it doesn't compete. Renovate handles dependency updates — the butler installs Renovate across the portfolio. Dependabot handles security alerts — the butler reads them and propagates Dependabot config to repos that lack it. The triage bot handles per-issue intelligence and per-repo improvement proposals — the butler reads its trends, configures it on new repos, and focuses on portfolio-level governance. SonarCloud handles code quality — the butler reads its scores. GitHub's community health profile defines the checklist — the butler runs through it across every repo and fixes the gaps.

The boundary is clear: the triage bot goes deep on one repo, the butler goes broad across the portfolio. The triage bot says "issue #47 is a duplicate of #12." The butler says "you adopted CodeRabbit in 5 repos — here are the 14 that should have it too."

## Landscape — Multi-Repo Tools

Evaluated 2026-05-28; the full catalogue of eleven tools, with per-tool verdicts, lives in [the landscape evaluation](docs/research/2026-05-28-multi-repo-tooling-landscape.md) and is not duplicated here.

Headline conclusion: embed no external tool into the Action runtime. The zero-dependency, API-only, zero-infra moat rules out clone-based CLIs (`multi-gitter`, `git-xargs`, `turbolift`) and self-hosted Probot apps (`safe-settings`, `allstar`). Community-health-file propagation extends `apply.js` natively rather than adopting `repo-file-sync-action`; `multi-gitter` is retained as a documented manual escape-hatch for complex migrations `apply.js` cannot template; `ossf/scorecard` is deferred as a future OBSERVE signal. Worth learning from rather than adopting: `octoherd`'s per-repo function model, `safe-settings`' config hierarchy, and GitHub's own org-level Rulesets and Custom Properties for targeting — see the [Well-Architected Framework](https://wellarchitected.github.com) for the first-party governance guidance.
