# The Autonomous Garden — plan of record

Date: 2026-07-25
Status: EXECUTED the same day. Portfolio went 7 Gold / 6 Silver to 12 Gold / 1 Silver. Read the Outcome section next — several premises below were disproved by executing them, and are corrected in place rather than deleted.
Portfolio: IsmaelMartinez, 13 active repos
Baseline: origin/main @ 4c52c007 (PR #338); data branch head 50fe782d (2026-07-24)
Review: six adversarially-crosschecked investigators, one local-model claim audit (discarded, see Review trail), one third-party final check (Fable, APPROVE WITH CHANGES — all nine changes applied), then execution, which was by some distance the most effective reviewer of the three.

## Outcome

Twenty-three security advisories cleared across the portfolio. Eleven were fixed by hand in the first pass; twelve more surfaced when those merges triggered Dependabot rescans, and ten of those twelve were cleared by the portfolio's own armed `dependabot-auto-merge` standard without intervention. Zero open critical or high alerts across all thirteen repos, verified against the live GitHub API rather than the butler's snapshot.

Goal status at close of day:

- G0 — SHIPPED (repo-butler #343). The deterministic-failure guard landed roughly fifteen hours before the Sunday cron it was racing.
- G1 — COMPLETE. Eleven PRs merged across six repositories.
- G2 — OPEN, and the only remaining Gold blocker. teams-for-linux sits at 11 counted bugs against a strict `< 10` gate.
- G3 — RESOLVED, but not as written. See the correction below; the answer was `release_exempt` (repo-butler #344), not a release.
- G4 — 12 of 13. The one exception is G2, with a written reason, which the goal's own text admits as success.
- G5, G6 — DEFERRED and rescoped. See the correction below.
- G7, G8, G9 — NOT STARTED. G7 is the recommended next task.
- G10 — PARTIALLY DONE. Two of the three alleged drifts were themselves wrong and are withdrawn below.
- G11 — PARTIALLY SHIPPED (repo-butler #342 removed 15 of repo-butler's 16 CI failures). Its postcss item was wrong and is withdrawn.

One goal is missing from the original list and was discovered only by executing: nothing watches the butler's own remediation PRs. `github-issue-triage-bot` #169, opened by the apply phase on 2026-07-13, sat BLOCKED with failing CI for twelve days and nothing reported it. It merged today only because someone went looking. That is the same class of blindness as G7, and it belongs alongside it — see G12.

## Why this plan exists

The portfolio was 14/14 Gold on 24 June. On 25 July it is 7 Gold and 6 Silver. Nothing rotted and no repo was neglected. Between 18 and 24 July a wave of npm security advisories landed, and Dependabot structurally could not clear it: ten of the eleven open high-severity alerts are for transitive dependencies, and GitHub's automated security fixes only bump direct dependencies named in a manifest. Security updates are enabled and unpaused on all thirteen repos, so the machinery is on; it cannot reach these packages. Two repos with open high alerts have no Dependabot pull request at all.

The butler detects this condition precisely. ADR-012 Phase 3 wires an `autofixEnabled` tri-state onto every Dependabot-sourced `open-vulnerability` finding, and PRs #337 and #338 surface an "autofix not driven" signal on the dashboard. What the butler cannot do is act on it. Every cross-repo write is a fixed-string template, and `applyToRepo` (`apply.js:465`) never reads the file it overwrites — it branches from the default branch and PUTs a freshly generated body. A sweep of `src/`, `scripts/`, `skills/` and `docs/` for `overrides`, `resolutions`, `npm audit`, and `package-lock` turns up only a CSS comment and an unrelated ADR sentence. No capability transforms existing file content.

Meanwhile the findings needing judgement rather than a template route to `executor: 'agent'`, and that executor has no runtime. `governance.js:537` routes every `tier-uplift` finding to it, `apply.js:386` filters those out of the only remediation path that exists, and the only other references are display counters. The current `snapshots/governance.json` carries six tier-uplift findings, one per Silver repo — six descriptions of exactly how to reach Gold, all addressed to a component that was never built.

There is a second, quieter finding, and this plan is itself evidence for it. The briefing that opened this session was wrong: it reported twelve Gold when the truth was seven, and a five-day-stale pipeline when the pipeline had run 64 of 64 green and written the data branch the previous evening. The cause is that `src/mcp.js` reads snapshots via `git show origin/repo-butler-data:<path>` (`mcp.js:28`, falling back to the bare local ref at `:30`) and contains no `git fetch` anywhere, so it serves whatever commit that remote-tracking ref last pointed at — compounded by a working checkout 106 commits behind origin/main, predating the #293 fix for this exact envelope bug. The published dashboard was correct throughout, so this is developer-facing only, and it is a recurrence of drift recorded on 2026-06-21.

The honest postscript: four factual errors in this plan's own first draft traced to that same stale checkout — a bug count from W29, a count of tier-uplift findings from the pre-wave world, and two misquoted documentation drifts. They were caught by the third-party review reading the fresh tree. That is the best argument in this document for the two watcher goals below, and it is recorded rather than quietly corrected.

## CORRECTION, added after executing G1 the same day

Two of this plan's load-bearing claims turned out to be wrong, and both were only exposed by acting rather than by review. They are recorded here rather than quietly edited out, because the pattern matters more than the individual errors.

**Dependabot was stalled, not incapable.** The section above asserts that Dependabot "structurally could not clear" the wave because ten of eleven alerts were transitive. That is false. Merging the hand-written fixes triggered Dependabot rescans, and it then fixed transitive advisories by itself: teams-for-linux went from four open alerts to zero without any further help, as Dependabot opened security PRs for `brace-expansion`, `postcss`, `app-builder-lib`, `builder-util-runtime` and `dompurify`, and the armed `dependabot-auto-merge` standard merged all five within five minutes (PRs #2749–#2753). bonnie-wee-plot went from one alert to nine on rescan, and npm audit against the unmodified base proved all nine were pre-existing — only Dependabot's visibility changed. The eleven original alerts sat unfixed for four to seven days because nothing triggered a rescan, not because of a capability gap. Pushing to the default branch is what forces re-evaluation.

This substantially reduces G6's scope. The genuine exceptions are narrow and share one shape: a caret on a `0.x` version is minor-locked, so `^0.34.5` means `>=0.34.5 <0.35.0` and cannot reach a 0.35.x patch. Two cases out of roughly twenty-three met that description — `sharp`, which arrives only as an `optionalDependencies` entry of `next` at `^0.34.5` (and `next` 16.2.11 still declares that same range, so bumping the parent does not lift it), and `adm-zip` under `onnxruntime-node@^0.5.16` where no published release relaxes the pin. Those genuinely need a parent-scoped override. Everything else was reachable by `npm update --package-lock-only`.

So the highest-value automation is not the lockfile-transforming trimmer this plan proposed. It is far cheaper: detect an alert that has been open for N hours with no corresponding Dependabot PR, and force a rescan. G6 should be rewritten to cover only the `0.x`-capped case, and a new goal should cover rescan-nudging. The trimmer is still worth building — it is just a much smaller thing than described below.

**G11's postcss item is wrong and must not be actioned.** The CI section below reports bonnie-wee-plot's `overrides: {"postcss": "^8.5.10"}` as redundant with an identical direct devDependency, and G11 proposes removing it. A controlled experiment refutes this. The devDependency governs only the root's own postcss, while the override rewrites *transitive* pins, and `next` depends on postcss at exactly 8.4.31. Removing the override takes the tree from 916 to 917 packages by introducing a second, older, still-vulnerable `next/node_modules/postcss@8.4.31`. The override is load-bearing. The better candidate for the Dependabot-updater retry symptom is that the override's own resolution is stale — pinned such that it resolves to 8.5.13, which is itself below the 8.5.18 patch floor.

That item survived a six-investigator survey, adversarial crosschecks, a local-model pass and a third-party review, and would have shipped a vulnerability. It was caught only by the refusal gate written into the executing agent's brief: if removing the override changes the resolved version, stop and report. Gates that force a measurement beat reviews that read prose.

**G3's rationale was wrong too, and the error is worth generalising.** Having been told a release would be metric-gaming, this plan's author then argued the opposite — that cutting a release for `generator-atlassian-compass-event-catalog` was justified because it would ship the js-yaml security fix merged earlier that day. That is false. PRs #250 and #251 modified only `pnpm-lock.yaml`, and a lockfile never reaches consumers of a published package: the tarball ships only `dist/`, `package.json`, `README.md` and `LICENSE`, the 414-byte build imports its dependencies externally rather than inlining them, and the declared `js-yaml: ^4.1.1` range was unchanged since v0.5.0 and already floated to the patched 4.3.0. Verified empirically — a clean production install of the already-published v0.5.0 resolves `js-yaml@4.3.0`, `brace-expansion@5.0.8` and `js-yaml@3.15.0`, all patched. Consumers were never exposed, so v0.5.1 would have been dependency-identical and existed solely to reset a clock.

The package had also been deliberately wound down in c234fd4 (#217), with a README instructing users to pin the current version. The correct answer was `release_exempt`, which already existed at `report-shared.js:160` and had an existing precedent in `sound3fy`; it shipped as repo-butler #344.

The general rule, which applies to every published package in this portfolio: a lockfile-only dependency bump fixes the repository's own CI tree and its Dependabot alert state, but never changes what a consumer resolves. Only a `package.json` range change, a bundled or inlined build, or a shipped shrinkwrap reaches consumers. Any future "ship the security fix" argument must be checked against the package's `files` list, the actual tarball contents, and whether a declared range moved.

**On the replacement for G6, be honest about the uncertainty.** The correction above proposes rescan-nudging as the cheaper, higher-value automation. That recommendation rests on an assumption that has not been tested: there is no public API to force a Dependabot security scan on demand. What demonstrably worked today was pushing to the default branch, and a bot pushing commits to provoke scans would be a poor design. Before rescan-nudging becomes an implementation goal it needs a spike to find a legitimate mechanism. Given that this document has already been wrong three times in one day about dependency-management mechanics, that spike should precede any commitment.

## What is actually broken, with evidence

Six repos fail exactly one Gold check, "Zero critical/high security findings". Eleven open high-severity Dependabot alerts, zero critical, zero secret-scanning. Packages: `fast-uri`, `brace-expansion`, `svgo`, `postcss`, `js-yaml`, `adm-zip`, every one with a published patched version.

Two repos carry a second blocker. teams-for-linux sits at ten open bugs against a strict `open_bugs < 10` gate — one issue away, not five; the widely-quoted fourteen was the W29 figure. generator-atlassian-compass-event-catalog last released 2026-04-20, about 95 days against a 90-day threshold, with 28 unreleased commits and a working `release.yml`.

A near-miss worth recording: teams-for-linux also carries 27 open code-scanning alerts, but all 27 are medium and the gate trips only on critical or high, so they do not block Gold.

`votescot` leaving the portfolio between W29 and W30 is correct — archived 2026-07-17, dropped by the eligibility filter as designed.

Three facts make remediation harder than it looks, and each is why a specific gate exists below.

In `yourear`, `brace-expansion` has two alerts with disjoint ranges: `>=2.0.0 <2.1.2` patched at 2.1.2, and `>=3.0.0 <5.0.7` patched at 5.0.7. A single top-level override would force a 2.x consumer up three majors.

`teams-for-linux` carries alerts against two manifests, `package-lock.json` and `docs-site/package-lock.json`, so a repo-level fix is not well defined.

`bonnie-wee-plot` demonstrates the failure mode directly: its `overrides` contains `"postcss": "^8.5.10"` while its devDependencies contain `postcss` at the identical `^8.5.10`. That redundancy makes Dependabot's own updater error and retry six times in 25 minutes per scheduled run. A generator that skips a redundancy check would manufacture this bug at scale.

Against that, four of the six affected repos already carry a hand-written `overrides` block — `serialize-javascript`, `protobufjs` (nested under `@opentelemetry/otlp-transformer`), `follow-redirects`, and `esbuild`/`js-yaml`/`sharp`. This fix has been applied by hand for months. It is demonstrated recurring toil with an established in-house recipe, which argues for automating it and also for matching the recipe rather than inventing one.

`generator` needs different handling: pnpm@9.15.9, where the in-house finding is that pnpm overrides miss auto-installed peers. Its alert is a direct dependency, `js-yaml ^4.1.1` needing 4.3.0, so a semver-safe `^4` bump suffices and no override is required.

## The declining CI number is mostly a measurement artefact

Average CI pass rate fell four weeks running, 95.90% in W27 to 93.81% in W30, and this is only partly about CI. `fetchCIPassRate` counts the last hundred completed runs of every workflow — scheduled maintenance, Dependabot's own updater, CodeQL — and scores `cancelled` and `timed_out` as failures. A workflow's own `cancel-in-progress` policy therefore reads as unreliability.

Fifteen of repo-butler's sixteen recorded failures are one misconfiguration: the Monitor workflow fires five runs per Dependabot PR, concurrency cancels four, and the survivor dies because Dependabot-context runs get no Actions secrets for the App token. Adding `if: github.actor != 'dependabot[bot]'` removes fifteen of sixteen.

Almost nothing is genuinely flaky; it is deterministic rot. lounge-tv's IPTV link-checker has failed 15 of 15 lifetime runs and never once succeeded, probing thousands of remote streams for one to two hours before exit 143. github-issue-triage-bot has three independent defects: a job referencing a secret that does not exist, a job POSTing to a Cloud Run endpoint 404-ing for eight consecutive weeks, and an unpinned `govulncheck@latest` gate that goes red on its own as advisories publish. One true flake was found, a single `node:test` IPC crash that passed on the next five runs.

## An armed automation is about to do something useless

RESOLVED the same day by repo-butler #343, roughly fifteen hours before the cron described below would have fired. The section is kept as written because it records why the guard exists, and because the reasoning generalises: an armed automation whose action cannot possibly help is worse than no automation, since it manufactures weekly noise that trains you to ignore it.

This needs attention before the next scheduled run regardless of the rest of this plan.

The `dependabot-rebase` nudge is live on the weekly apply-schedule (`roadmap.yml:112`; `apply-scheduled.yml:62` resolves the cron path to `dry-run=false`). bonnie-wee-plot PR #429 is already 32 days old, past the 30-day threshold, and fails six of six runs deterministically as a `linting` major-version bump. Sunday's 05:00 UTC cron will post `@dependabot rebase`, regenerating an identical red run, and will repeat weekly forever. PR #436 crosses the same threshold within days.

The correct behaviour when a Dependabot PR's last several runs all failed identically with an unchanged head branch is to escalate, not nudge. That guard does not exist.

## The four machines

The trimmer is the transitive-vulnerability fixer — the only genuinely new capability and the only one that transforms existing file content, which makes it the riskiest. It closes the gap Dependabot cannot reach.

The roombas are the small recurring chores: guarding and improving the dependency-PR nudge, cutting a release when cadence lapses, and clearing the deterministic CI defects. Part of this exists already, and the work is as much about restraining it as extending it.

The contracted cleaners are the watchers: a Gold ratchet raising a finding when a tier drops, and a staleness guard so the tooling reports its own drift.

The notetaker is the independent checker — re-deriving headline numbers from the live API, diffing against the snapshot, recording a dated note. Its independence must be structural: it may not import the snapshot-reading helpers, because a checker sharing the producer's parsing code inherits the producer's bugs. Today's failure is the argument — every consumer of the stale snapshot agreed with every other, and the agreement was worthless because they shared a source.

## Two prohibitions that apply to every goal

No automation may dismiss a Dependabot alert. Dismissing sets `state` to `dismissed` and turns the security verifiers green without fixing anything; it is the obvious cheat path and it is forbidden outright.

No automation may edit issue labels inside the counted bug set. Because `open_bugs` subtracts anything labelled `blocked`, adding that label is indistinguishable from falsifying the metric, as is removing a bug-family label. Both are hard refusals with no override.

Every pull request opened under G1, G2, G3 or G11 requires per-repo maintainer approval before merge. No agent merges its own remediation. This matters structurally, because G1's acceptance is only reachable after merge, which would otherwise incentivise a verifier-loop agent to merge in order to go green.

## Order of execution

Goal numbers are stable identifiers, not an ordering. The intended order is G0 first, on a deadline; then the three watchers G7, G8 and G9 plus documentation G10, which are cheap, independent, and are the components whose absence caused the silent month; then remediation G1, G2, G3 converging on the G4 gate; then G5 and G6, the trimmer track; with G11 runnable throughout.

The earlier claim that G5 blocked G6 through G9 was wrong on this plan's own terms: G7 is a comparison of two existing files, G8 is MCP plumbing, and G9 is independent by design. None touches the executor. Blocking the cheap watchers behind the largest speculative piece inverted the value order.

### G0 — Guard the rebase nudge before Sunday's cron

Suppress the `@dependabot rebase` nudge for a PR whose last three or more CI runs all concluded `failure` with the same failing job set and an unchanged head branch; escalate instead.

Acceptance: a dry-run of the nudge path reports bonnie-wee-plot #429 as escalated rather than nudged, and a named unit test pins it.

```bash
cd <repo-butler> && node --test --test-name-pattern 'deterministic' src/apply.test.js
```

First because it is the only item with a deadline set by machinery already running. If it cannot land before Sunday, the interim mitigation is to remove `dependabot-rebase` from the `apply-schedule` allow-list for one week.

### G7 — The Gold ratchet

A deterministic detector emitting a `tier-regression` finding when a repo's tier is lower in the current weekly snapshot than in the previous one, surfaced through the dashboard and the MCP `get_governance_findings` summary.

Acceptance: named tests prove a fabricated gold-to-silver pair produces exactly one finding and an unchanged pair produces none, *and* a run against the real W29/W30 pair reports the six actual regressions.

```bash
cd <repo-butler> && node --test --test-name-pattern 'tier-regression' src/governance.test.js
```

The `--test-name-pattern` is load-bearing. A bare `node --test` passes today, with zero occurrences of `tier-regression` anywhere in `src/` — a verifier that is green before the work starts is worse than none in a loop-until-verified model. The real-data check matters equally: fabricated fixtures prove the comparison logic, not that it reads the production shape.

Prior art to build on rather than duplicate: `buildSinceLastSection` (`report-portfolio.js:899-928`, wired at `report.js:324-341`) already shows tier moves run-over-run on the dashboard. This goal adds a persistent finding channel, which is additive, but it should reuse that comparison rather than write a second one. Note the deliberate asymmetry with `tier-uplift`, which fires on opportunity; this fires on loss.

Progress (2026-07-28): implemented in PR #354. `detectTierRegressions` reuses `detectTierChanges` over two weekly-snapshot-shaped inputs; `runGovernance` builds the current side with `buildPortfolioSnapshot` and reads the baseline via `readLatestPortfolioWeekly({ beforeWeek })`, so a finding persists for the remainder of its week across the 4×/day runs instead of clearing one run after it fired. One acceptance deviation, recorded here as the plan requires: the named W29/W30 real-data pair no longer contains the six regressions — weekly files are overwritten intra-week and that pair healed to uplifts-only when the advisory wave cleared on 2026-07-25 — so the committed real-shape fixture is the W26/W27 release-drift pair, which still carries nine actual gold→silver regressions. The verifier command is unchanged and green (nine named tests).

### G8 — The staleness guard

Make the tooling report its own drift. The MCP server should fetch before reading, or failing that surface the age of the snapshot it read and whether its own code is behind the remote default branch, and warn rather than answer confidently when either exceeds a threshold.

Acceptance: pointed at a deliberately stale checkout and data ref, portfolio responses carry an explicit staleness warning and tier counts are either correct or withheld; pointed at a fresh one, no warning appears.

```bash
cd <repo-butler> && node --test --test-name-pattern 'staleness' src/mcp.test.js && \
  bash scripts/staleness-fixture-check.sh   # sets up stale + fresh refs, asserts warning present then absent
```

Scoped to the developer-facing path; the published dashboard was correct throughout. The root cause is small and precise: `mcp.js:28` shells out to `git show origin/repo-butler-data:<path>` with no fetch anywhere in the file. Build it rather than remember it, because this failure already recurred once and has now produced a materially wrong answer to a direct question — and four errors in this plan's first draft.

### G9 — The independent notetaker

A verification pass re-deriving the headline portfolio numbers from the live GitHub API, diffing them against the current snapshot, recording a dated note, and raising a finding on divergence beyond tolerance.

Scope is hard-capped to five numbers and may not grow without a further decision: active repo count, per-tier counts, total open critical/high alerts, total open bugs, and snapshot age. This is the marginal goal of the plan — it is a shadow implementation of observe and could accrete its own maintenance burden. The cap is what makes it worth keeping, and it is the first thing to cut if the plan is trimmed.

Acceptance: runs against the live portfolio, writes a note recording both derivations, exits non-zero on divergence; seeded with a deliberately wrong snapshot value it must detect it; and a test asserts the module imports no snapshot-reading helper.

```bash
cd <repo-butler> && node --test --test-name-pattern 'notetaker' src/notetaker.test.js && \
  node scripts/notetaker.js --check   # exit 0 = live API and snapshot agree
```

### G10 — Truth up the documentation

Two drifts, re-surveyed against origin/main after the first draft misquoted them from a stale checkout.

`CLAUDE.md:87` says `onboard.yml` fires on "workflow_dispatch + GitHub App webhook on installation"; `.github/workflows/onboard.yml:3-8` has only `workflow_dispatch`.

`ROADMAP.md` reads "Last Updated: 2026-07-22" and "Portfolio at 14 Gold (14 repos) as of W22; teams-for-linux re-graduated to Gold at 9 open bugs. Zero portfolio vulnerabilities." Every clause of that status line is now false: 13 active repos, 7 Gold, teams-for-linux at 10 bugs and Silver, eleven open high vulnerabilities.

A third alleged drift — that `CLAUDE.md` describes the propose allow-lists as empty — does not exist. The word "empty" does not appear in `CLAUDE.md` on main, and its line 87 describes the weekly-ideate soak accurately. The claim came from reading the stale copy and is withdrawn.

Acceptance: each remaining claim matches the file it describes, checked by re-reading against origin/main.

### G1 — Clear the advisory wave

Bring open critical and high Dependabot alerts across all thirteen active repos to zero, by parent-scoped `overrides` for the transitive cases and a semver-safe `^4` bump to js-yaml 4.3.0 for generator.

Acceptance: zero open alerts at critical or high severity portfolio-wide, with all thirteen repos provably queried.

```bash
#!/usr/bin/env bash
set -uo pipefail
OWNER=IsmaelMartinez
REPOS=(yourear sound3fy teams-for-linux ismaelmartinez.me.uk
       generator-atlassian-compass-event-catalog bonnie-wee-plot betis-escocia
       ai-model-advisor github-issue-triage-bot repo-butler wifisentinel
       lounge-tv delegate-local)
EXPECTED=13
total=0; ok=0; failed=()
for r in "${REPOS[@]}"; do
  # severity field mirrors src/observe.js:435 exactly
  n=$(gh api "repos/$OWNER/$r/dependabot/alerts?state=open&per_page=100" --paginate \
        --jq '[.[]|(.security_vulnerability.severity // .security_advisory.severity)
               |select(.=="critical" or .=="high")]|length' 2>/dev/null \
      | paste -sd+ - | bc 2>/dev/null)
  [[ "$n" =~ ^[0-9]+$ ]] || { failed+=("$r"); continue; }
  ok=$((ok+1)); total=$((total+n))
  [ "$n" -gt 0 ] && printf '  %-45s %s critical/high\n' "$r" "$n"
done
[ ${#failed[@]} -gt 0 ] && { echo "VERIFIER ERROR: query failed for: ${failed[*]}"; exit 2; }
[ "$ok" -ne "$EXPECTED" ] && { echo "VERIFIER ERROR: queried $ok of $EXPECTED repos"; exit 2; }
echo "repos_queried=$ok/$EXPECTED total_critical_high=$total"
[ "$total" -eq 0 ] && { echo "G1 PASS"; exit 0; } || { echo "G1 FAIL"; exit 1; }
```

Current output: eleven alerts, `G1 FAIL`, exit 1. Three defects in the first draft were found by running it rather than reading it — it summed a bare pipeline with no repo-count assertion, so it would have quietly verified twelve repos after the next archival; it treated a failed query as zero alerts, where the butler itself fails closed (`observe.js:437-441` returns null, failing the security check); and its "must print 0" was a comment, not an exit code. The severity expression now mirrors `observe.js:435`, since advisory severity is the max across vulnerabilities and the two can diverge.

Constraints. One repo at a time, sequentially, never a parallel fan-out. Each change must install cleanly and pass that repo's own test suite before its PR opens. Overrides parent-scoped; a blanket top-level entry is a defect. No override may duplicate a direct dependency at a compatible range. Where the parent cannot be determined, stop and report.

Reserve `wifisentinel` — its single `brace-expansion` alert, the same shape as its existing hand-applied `protobufjs` fix — as the G6 canary and do not fix it by hand. Otherwise clearing everything here leaves G6 with no live target until the next wave.

### G2 — teams-for-linux below ten open bugs

Acceptance: the butler's own `open_bugs` count is below ten, computed with the production predicate rather than an approximation.

```bash
gh api "repos/IsmaelMartinez/teams-for-linux/issues?state=open&per_page=100" --paginate | node -e "
const BUG=['bug','defect','bugfix','bug-fix','type: bug','type:bug','kind/bug'];
let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{
  const issues=JSON.parse(raw).filter(i=>!i.pull_request);
  const c=issues.filter(i=>{const n=(i.labels||[]).map(l=>typeof l==='string'?l:l.name).filter(Boolean);
    return n.some(x=>BUG.includes(x.toLowerCase())) && !n.some(x=>x.toLowerCase()==='blocked');});
  console.log('open_issues='+issues.length+' open_bugs='+c.length+' gate='+(c.length<10?'PASS':'FAIL'));
  process.exit(c.length<10?0:1);});"
```

Mirrors `open_bugs` (`observe.js:528`), `BUG_LABELS` (`report-shared.js:133`), `isBlocked` (`report-shared.js:144`), and the strict gate (`report-shared.js:338`). Current output: `open_issues=20 open_bugs=10 gate=FAIL`. The first draft used `--labels bug`, matching one of seven aliases and ignoring the `blocked` carve-out — it over-counted to twelve, and its error direction was perverse: a false red pressuring an agent to close more issues than the real gate requires, in direct tension with the honesty constraint below.

The action for this goal is to take no action. Issue #2457 carries the `Stale` label, last touched 2026-07-21, under `days-before-stale: 30` and `days-before-close: 5` on a daily 09:30 cron, so it self-closes around 2026-07-26 and drops the count to nine unaided. A second route exists: PR #2698, "chore(main): release 2.14.0", open and blocked since 2026-06-26, whose merge closes the already-fixed #2703. Six of the remaining bugs are real defects under active work and must not be touched. Two bug-labelled issues (#2454, #2687) are already excluded by the `blocked` carve-out, so ten is a triaged figure, not a raw one.

The honesty constraint overrides the metric. Closing a real defect to move a number is forbidden, as is relabelling. If honest triage leaves the count at or above ten, teams-for-linux stays Silver and this plan says so.

### G3 — generator release cadence

Cut a release on generator-atlassian-compass-event-catalog: 28 unreleased commits, a working `release.yml`, last release about 95 days old.

Acceptance: the latest release is under ninety days old.

```bash
p=$(gh release view --repo IsmaelMartinez/generator-atlassian-compass-event-catalog \
      --json publishedAt --jq '.publishedAt')
age=$(( ( $(date -u +%s) - $(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$p" +%s) ) / 86400 ))
echo "age_days=$age gate(<90)=$([ "$age" -lt 90 ] && echo PASS || echo FAIL)"
[ "$age" -lt 90 ]
```

The first draft printed the publish date and compared nothing, so it could not fail. Current output: `age_days=95 gate(<90)=FAIL`.

On the js-yaml alert, the first draft called Dependabot PR #249 the cheapest route. That is wrong: #249 bumps js-yaml 4.2.0 to 5.2.2, a major bump past the first-patched 4.3.0, and it is BLOCKED with its Tests check failing. The semver-safe fix is a `^4` bump to 4.3.0, and #249 should be closed in favour of it.

Recurrence: generator will drift past ninety days again. The `release-cadence` template exists in `TEMPLATABLE_TOOLS` (`governance.js:477`) but is deliberately off both the `apply-schedule` and `apply-automerge` allow-lists. The decision recorded here is to defer promoting it, with an explicit trigger — promote once two distinct repos have independently tripped the release-cadence standard within a single quarter. One repo drifting is a repo; two is a pattern worth automating.

### G4 — Whole portfolio at Gold, or a documented exemption

Acceptance: the current weekly snapshot shows every active repo at Gold, or any repo that is not carries a written, reviewed exemption recorded here.

```bash
git fetch origin repo-butler-data:refs/remotes/origin/repo-butler-data --quiet
git show "origin/repo-butler-data:snapshots/portfolio-weekly/$(date -u +%G-W%V).json" | node -e "
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  const p=JSON.parse(d), r=(p.schema_version&&p.repos)?p.repos:p;
  const bad=Object.entries(r).filter(([,v])=>v?.computed?.tier!=='gold').map(([n])=>n);
  console.log(bad.length?'NOT GOLD: '+bad.join(', '):'ALL GOLD ('+Object.keys(r).length+' repos)');
  process.exit(bad.length?1:0);});"
```

Note `%G-W%V`, not `%Y-W%V`. The butler writes week files with `isoWeekKey` (`store.js`), which Thursday-shifts before taking the year, making it the ISO week-based year — `%G`, not `%Y`. Both print `2026-W30` today and diverge at year boundaries, where `%Y-W%V` asks for `2027-W53` while the butler wrote `2026-W53`: a guaranteed false red once a year, at the moment nobody remembers why. The explicit fetch is load-bearing for the reason in the opening section.

One caveat on trust: the data branch is writable by the repo's own automation, so unlike the live-API verifiers this one is forgeable by an agent with push access. It is a convenience gate over G1 through G3, not an independent authority.

This goal is the sum of G1 through G3 and is stated separately because it is what the request asked for. Twelve of thirteen with a written reason is a success; twelve of thirteen with a fudged bug count is not.

### G5 — Content-transformation trust model, and the minimal harness

Reshaped after review. The original goal was a general-purpose `executor: 'agent'` runtime; that is now deferred, and G5 is the ADR plus only the harness G6 actually needs.

The reasoning is that the recurring toil has exactly one shape — npm transitive override bumps — and that shape is deterministic. Given a lockfile and an alert, the parent scope is computable by walking the dependency tree. No judgement, no LLM, no agent is required. And the six tier-uplift findings a general runtime would consume are thin: `governance.js:535-543` gives them empty `targetFiles` and acceptance criteria that are just check names, so a generic executor would have to re-derive everything anyway. Building the runtime now means building for a second consumer that does not exist.

What survives is the trust-model work, which is needed regardless of implementation shape. G6 will be the first capability that transforms existing file content in another repository, breaking the invariant that every cross-repo write is a fixed-string template whose target is never read. ADR-005 covered template writes and ADR-009 covered settings writes; content transformation is a third category needing the same treatment, including an explicit benign-worst-case analysis. ADR-012 is the model, not least because it is candid about how its own class fails that test.

Acceptance: an ADR exists at `docs/decisions/013-content-transformation-writes.md` covering the third write category, and the harness G6 needs is unit-tested.

```bash
cd <repo-butler> && test -f docs/decisions/013-content-transformation-writes.md && npm test
```

The general agent runtime is deferred until a second consumer is real. Should it be revived, its acceptance must include an end-to-end dry-run transcript against a live finding, not a passing suite — a green `npm test` proves nothing about a feature that does not exist yet, which is precisely how the first draft's G5 verifier passed before any work was done.

### G6 — The trimmer: transitive vulnerability remediation

A deterministic remediation lane in the existing apply architecture, not an agent. Given a repo with an open critical or high alert whose autofix is not driving, and a published patched version, compute the parent scope from the lockfile and produce a parent-scoped `overrides` change that clears the alert. It inherits the existing gates unchanged: dry-run fail-closed on anything but the literal `false` (`index.js:29`), the `require_approval` master switch (`apply.js:373`, noting the polarity is inverted relative to PROPOSE — for apply, `true` enables the system), `capPerTool` (`apply.js:337`), and manual dispatch only until soaked.

Acceptance: against the reserved `wifisentinel` canary, the trimmer produces a PR that installs cleanly and passes the repo's tests; after maintainer-approved merge and a polled rescan, the G1 verifier scoped to that repo returns zero.

Refusal conditions are part of the specification, each mapped to a verified fixture. Refuse when one package has disjoint vulnerable ranges it cannot scope to distinct parents (`yourear`/`brace-expansion`). Scope each fix to the manifest its alert names rather than assuming one per repo (`teams-for-linux`). Refuse to write an override duplicating a direct dependency at a compatible range (`bonnie-wee-plot`/`postcss`). Refuse on pnpm repositories where the vulnerable package is an auto-installed peer. Never emit a blanket top-level override, never widen a range on a package that is not the subject of an alert, and refuse rather than guess when the parent cannot be determined.

Tests use those three real cases as fixtures, because each would have broken a naive implementation.

It stays off the schedule and off auto-merge. Auto-merge is restricted by construction to classes with a `TEMPLATES` entry (`isAutoMergeAllowed`, `apply.js:1075`), which excludes content transformation; that restriction is correct and this plan does not relax it.

### G11 — CI hygiene

Clear the deterministic CI defects and fix the measurement that misreports them. Add `if: github.actor != 'dependabot[bot]'` to repo-butler's monitor job. Remove bonnie-wee-plot's redundant `postcss` override. Bump github-issue-triage-bot's Go dependencies and pin `govulncheck` to a version. Demote lounge-tv's never-successful link-checker to `workflow_dispatch` with a tracking issue filed first, and add `timeout-minutes`. Separately, stop counting concurrency-cancelled runs as failures in `fetchCIPassRate`, distinguishing concurrency cancellation from operator or timeout cancellation.

Acceptance: portfolio average CI pass rate above 95% in a subsequent weekly snapshot, and no workflow in the portfolio with zero lifetime successes still on a schedule.

The measurement change must be flagged in the snapshot schema notes, since it shifts historical comparability. Demotion applies only to a workflow that has never once passed — doing it to one that used to pass masks a regression rather than cleaning noise.

### G12 — Watch the butler's own remediation PRs

Added after execution, because this gap was invisible until someone went looking.

The apply phase opens remediation PRs on target repos and then forgets them. `github-issue-triage-bot` #169 was opened by the butler on 2026-07-13 to remediate a `release-cadence` standards gap. It sat BLOCKED for twelve days with a failing `test` check, and nothing surfaced it — not the dashboard, not the governance findings, not the MCP tools. The `standards-gap` finding stayed open the whole time, correctly reporting the gap, while the fix for that very gap sat rotting three feet away. The two facts were never connected.

Worse, the blocker had nothing to do with the PR. The repo's `test` job ran unpinned `go install golang.org/x/vuln/cmd/govulncheck@latest` as a required gate, so a newly-published Go advisory turned every PR in the repo red. All three open PRs were blocked identically. A watcher would have caught this in a day.

Acceptance: a finding is emitted when a PR on a `repo-butler/apply-*` branch, carrying the apply identity marker, has been open beyond a threshold with CI not green; surfaced through the dashboard and the MCP `get_governance_findings` summary. It should distinguish "blocked by its own content" from "blocked by a repo-wide CI failure", because the remedies differ entirely.

```bash
cd <repo-butler> && node --test --test-name-pattern 'stale-apply-pr' src/governance.test.js
```

Progress (2026-07-29): implemented as `src/butler-pr-audit.js`, verifier
`scripts/verify-g12.sh`. Six deviations from the spec above, each forced by
evidence found while building, and each recorded here rather than quietly
absorbed.

*Scope widened beyond `apply-*`.* The motivating PR (#169) merged on 2026-07-25,
but `lounge-tv` #21 — an **onboard** PR — had by then sat green, mergeable and
ignored for 16 days. Scoping to `apply-*` as written would have shipped a
detector that emitted nothing and repeated the very blindness it exists to fix,
so the locator is `repo-butler/*`. Roadmap PRs are then excluded again for a
different reason: UPDATE force-pushes a fresh head onto the same PR every run and
`self-test.yml` runs `update` immediately before `governance`, so their CI is
permanently in flight and their age never resets — including them would emit a
wrong "blocked" row about the butler's own repo four times a day.

*Trigger widened to include green-but-ignored.* "Open beyond a threshold with CI
not green" is silent on the failure mode actually present in the portfolio. A
green PR nobody merged also means the remediation never landed.

*Blame attribution dropped.* The spec asks to distinguish "blocked by its own
content" from "blocked by a repo-wide CI failure". The intended signal does not
carry that information: `prCiHistory.failing` holds workflow *run* names, and
most repos here run a single workflow called `CI`, so a sibling comparison would
report "overlap" almost always while costing several extra calls per PR. It
reports **persistence** instead — the identical failing set across three
attempts, via the existing `isDeterministicFailure` — which is the signal an
operator acts on ("a rebase will not fix this").

*`prCiGreen` deliberately not reused.* It is a merge-authorisation guard that
collapses red, pending, no-CI-at-all and API errors into a single `false`.
Reading that as "blocked" would permanently mislabel every repo carrying a
`ci-workflows` gap. A separate four-way `prCiState` was added beside it, leaving
the merge guard's conservative path untouched.

*Thresholds relaxed.* `apply-scheduled.yml` is a **weekly** cron, so the
originally-planned 7 days would fire on any apply PR that merely missed one run.
Apply 14d, onboard 30d.

*Identity recorded, not enforced.* Gating on the App's bot login would silently
blind the detector the moment the App were renamed — the exact failure mode this
goal exists to catch. The branch prefix locates; the marker corroborates into a
`verified` flag; an unmarked `repo-butler/*` branch is surfaced, not dropped.

Two pre-existing gaps in the shipped G7 work were found and fixed in the same
change: `tier-regression` was missing from `ideate.js`'s
`appendGovernanceContext` (so those findings never reached the IDEATE prompt) and
from `schema.test.js`'s `sampleFindings` (so its remediation plan was never
validated).

Worth recording about the verifier itself: `node --test` reports `pass 1` and
exits **0** when the named test file is absent and zero tests match. Exit code
alone would therefore have declared this goal already met before a line was
written. The test-count floor in `verify-g12.sh` is what makes it able to fail.

This is the same blindness as G7 seen from another angle. G7 notices a repo losing tier; G12 notices the butler's own action failing to land. Both are instances of a single missing property: the butler acts, and nothing checks afterwards whether the action worked. If only one thing is built from this document, build that property — G7 is the cheapest slice of it, G12 the second.

## What this plan deliberately does not do

It does not put the trimmer on a schedule, or auto-merge anything it produces.

It does not enable the ADR-012 settings write. That class is dormant pending an App-token canary and an explicit live dispatch, neither of which appears to have been performed. Adjacent, but the maintainer's call.

It does not touch the remaining two propose flips (`require_approval: false`, `INPUT_DRY_RUN: false`). That soak is mid-flight with its own evidence trail.

It does not build the general agent-executor runtime, deferred above pending a second real consumer.

It does not close real bugs to reach a number, dismiss alerts, edit labels, or count a repo as Gold on a metric it gamed.

## Execution model

Each goal is worked by a subagent against its verifier in a loop: run the verifier, and if it fails, attempt the goal, then re-run. The loop ends when the verifier passes or the agent reports a blocker it cannot clear, and a blocker report is a legitimate terminal state rather than a failure to conceal.

The verifiers are the contract; an agent's own report of completion carries no weight. Two properties are required of every verifier after this review: it must be capable of failing before the work is done, and it must fail closed when its inputs are unavailable. The first draft violated both, in G5 and G7 and in G1 respectively.

Where acceptance depends on a snapshot the daily pipeline regenerates, verification waits for the next pipeline run rather than trusting a locally computed substitute.

## Risks, stated plainly

The trimmer is the risky one. It writes into other repositories, transforms rather than templates, and a wrong override can break a build in a way a config file cannot. Every gate exists because a concrete case was found that would have broken a simpler design. It stays dry-run until it has produced correct output on the canary and been reviewed.

G2 may not be achievable honestly, and the plan accepts that rather than routing around it.

The advisory wave will recur. Eleven alerts in seven days is a rate, not an incident. That is the argument for G6 over doing G1 by hand every month.

## Review trail

The diagnosis was cross-checked by six parallel investigators, each adversarially re-verified, then by a local model, then by a third-party final reviewer reading the fresh tree.

The local-model pass is recorded as a failure. DeepSeek-R1-Distill-Qwen-32B via MLX was given ten claims with their evidence and a closed-form rubric with explicit priority-ordered rules, including one capping any claim that adds an unproven causal, absolute, or predictive word. It returned SUPPORTED for all ten, including several containing exactly those hedge words. It discriminated nothing and its output was discarded; the verdict was recorded as a miss against the delegation metrics. This matches the documented guidance that local models are strong summarisers and weak reasoners, and it is the honest answer to whether a cheap adversarial voice adds value here: on this task it did not.

The third-party review returned APPROVE WITH CHANGES with nine specific changes, all applied above. It caught four factual errors sourced from the stale local checkout, five verifiers that failed this plan's own contract, and a dependency claim that contradicted the plan's own goal descriptions. It also made the sharpest argument in the review — that the general agent runtime was speculative architecture for a deterministic problem — which reshaped G5 and G6.

The pattern worth carrying forward: the corrections came from execution and from reading the fresh source, not from review of prose. Four verifier defects were found by running the verifiers. Four factual errors were found by re-reading origin/main. The local model, which only read prose, found nothing.

Executing the plan then reviewed it harder than any of the three review layers had. Three load-bearing claims fell: that Dependabot could not fix transitive dependencies, that bonnie-wee-plot's postcss override was redundant, and that a release would ship generator's security fix. Each had survived six investigators, adversarial crosschecks, a local-model audit and a third-party final check. Each was refuted within minutes of someone actually running the thing.

Two mechanisms did the refuting, and both are worth building into how this portfolio is worked. The first is the refusal gate: an instruction of the form "if X changes when you do Y, stop and report" forces a measurement before an action, and it is what stopped the postcss change from shipping a vulnerability. Reviews that read prose cannot do this, because the defect is not visible in the prose — it is visible only in a package count. The second is asking an executing agent to verify a premise rather than carry it out. Every one of the three refutations came from an agent told to check whether the task was justified, not from one told to complete it. A brief that says "if the justification does not hold, report NO_ACTION_NEEDED" buys more correctness than another reviewer.

The uncomfortable corollary, recorded deliberately: the elaborate review apparatus at the top of this document — six investigators, crosschecks, a local model, a third-party final check — caught real problems but missed every one of the three biggest errors. The cheapest interventions won. Scale the gates, not the reviewers.
