# OSV-Scanner as a portfolio standard — implementation plan

Date: 2026-08-12
Status: proposed, pending review
Predecessor: [2026-08-12-snyk-migration-plan.md](2026-08-12-snyk-migration-plan.md) (merged, `5cf5f34c`)

## Goal

Install OSV-Scanner on every eligible repo in the portfolio, as a governance
standard rather than a per-repo rollout, so that dependency scanning survives the
removal of Snyk and so that any repo joining the portfolio later gets it without
anyone remembering to act.

Done means: the `osv-scanner` standard is declared and detected; a non-compliant
repo produces a `standards-gap` finding routed to the `template` executor; a
dispatch of `apply.yml` opens a correct PR on that repo; the workflow it installs
passes on a repo with dependencies and on a repo with none; and no repo's health
tier moves as a result.

## Non-goals

Promotion onto `apply-schedule` or `apply-automerge`. Both stay off. This class
starts manual-dispatch-only and earns promotion later on the usual ADR-007
per-class track record, exactly as `release-cadence` did.

Uninstalling the Snyk App, revoking the token, or clearing the inert artefacts.
Those belong to the predecessor plan and are sequenced after this one.

Any change to `computeHealthTier` or to the meaning of an existing standard.

## Phase 1 — the standard

Eight edits. The count matters: an earlier draft said five and would have
produced a standard that detects a gap and then never opens a PR, because
`buildRemediationPlan` routes on `TEMPLATABLE_TOOLS` in `governance.js`, which is
a separate list from `TEMPLATES` in `apply.js`. A tool missing from the former
falls through to `executor: 'manual'` silently.

1. `.github/roadmap.yml` — add `osv-scanner: universal` under `standards:`.
2. `src/governance.js` — `STANDARD_DETECTORS['osv-scanner']`, reading
   `(_repo, details) => !!details?.hasOsvScanner`.
3. `src/governance.js` — add `'osv-scanner'` to `TEMPLATABLE_TOOLS`.
4. `src/governance.js` — `STANDARD_TARGET_FILES['osv-scanner'] =
   ['.github/workflows/osv-scanner.yml']`.
5. `src/report-portfolio.js` — populate `hasOsvScanner` inside the existing
   `actions/workflows` request block, beside `hasAutoMergeWorkflow`, and add it
   to the `details[r.name]` object literal.
6. `src/report-shared.js` — bump `REPO_CACHE_SCHEMA_VERSION` from 6 to 7.
7. `src/apply.js` — `TEMPLATES['osv-scanner']` with path
   `.github/workflows/osv-scanner.yml` and the content in Phase 2. The entry
   carries a comment naming *why* two lines are load-bearing: `upload-sarif:
   false` because `computeHealthTier` and `detectOpenVulnerabilities` both read
   `codeScanning.max_severity`, so uploading SCA advisories drops repos off Gold
   with no new vulnerability; and `security-events: write` because the call
   fails validation without it — the rule being "add the permission, never
   enable the upload". Every other `TEMPLATES` entry already carries a why
   comment, and a golden test pins the string without explaining it.
8. `.github/roadmap.yml` — a temporary `standards-exclude: osv-scanner:` entry
   listing every repo except the canary. This is the targeting mechanism, and
   without it Phases 3 and 4 cannot be executed as written.

### Targeting: the apply path has no repo selector

This is the single most important operational fact in the plan and it was
missing from the first draft. `apply.yml` exposes only `dry-run`, `tools` and
`max-apply-per-run`; `index.js` forwards only those; `apply.js` expands a
finding's `nonCompliant` array wholesale into pairs; and `capPerTool` keeps the
first N **in portfolio order**. That order comes from
`/installation/repositories`, which is fetched with no sort — so a dispatch with
`max-apply-per-run: 1` opens its PR on whichever repo GitHub happens to list
first, not on the one the operator intended.

The only existing per-repo lever sits one stage upstream: `standards-exclude`,
already in production use for `release-cadence: sound3fy`. `detectStandardsGaps`
filters on it before `nonCompliant` is built, so excluding the other thirteen
repos is what aims a dispatch at one.

The sequencing is easy to trip over: `runApply` reads *stored* findings from the
data branch, so an edit to the exclusion list only takes effect after the next
GOVERNANCE run rewrites `snapshots/governance.json`. Edit, wait for a governance
run, then dispatch.

One further consequence worth knowing during Phase 4: `applyToRepo`'s
open-PR idempotency skip runs *after* `capPerTool`, so a repo with an already-open
apply PR still consumes a cap slot. Batches only advance when PRs merge and the
repo drops out of `nonCompliant`.

Adding a `repos` input to `apply.yml` — following the pattern `onboard.yml`
already uses — would be cleaner than the exclusion-list dance. It is deliberately
**not** taken here: it changes the apply path itself, which every other standard
shares, and that deserves its own reviewed PR rather than riding along with a new
standard. The exclusion list is ugly but touches nothing shared.

Detection is **tri-state** — `true` / `false` / `null` — and only `false` opens a
remediation PR. An earlier draft used the usual `!!` coercion with a
fail-toward-present fallback, and review showed both halves were wrong.

Fail-toward-present is right for `hasReleaseWorkflow` but wrong here, because
this details object is persisted in a `pushed_at`-keyed cache: a `true` written
during one transient API failure would be served until the repo's next push,
which on a quiet repo is indefinitely. The repo would be reported compliant
while running no scanner at all. `null` is honest, and unlike `true` it cannot be
mistaken for evidence — governance skips unknowns rather than counting them
either way.

Detection also cannot use the workflows **registration listing**, which was the
first draft's source. That listing returns every workflow GitHub has ever
registered, including from branches never merged — verified on this repo, where
`release-recovery.yml` is listed `active` while existing on no branch. The gap is
reachable by construction, because the templated workflow triggers
`on: pull_request` and so registers itself when it runs on the apply PR that
introduces it: the repo would read as compliant before that PR merged, and
permanently if it were closed unmerged. Presence is therefore read from the
contents API on the default branch, matching the exact filename.

An intermediate draft also read the listing's `state` field, so that a workflow
switched off from the Actions UI would not count as compliant. That was removed
after review, and the reason generalises.

GitHub auto-disables schedule-triggered workflows after 60 days of repository
inactivity, and this template is schedule-triggered — so on any quiet repo the
scanner eventually flips to `disabled_inactivity` through nobody's decision.
Treating that as a standards gap routes the repo into the templated apply path,
whose contents PUT supplies no `sha`; the file already exists, so GitHub answers
422 and the same unfixable finding retries on every run forever.

The principle worth keeping: **a standard must only detect conditions its own
remediation can fix.** This standard's remediation is a file write, and writing
a file cannot re-enable a workflow. Enablement is a settings concern needing a
settings executor; conflating it with a file-presence standard manufactures a
finding whose fix provably cannot succeed. Detecting less is correct here.

### Acceptance criteria

`npm test` passes with new tests covering: the detector returning false when the
field is absent and true when present; `buildRemediationPlan` returning
`executor: 'template'` and the correct `targetFiles` for an `osv-scanner`
finding; `hasOsvScanner` failing toward present on both the truncation and the
error path; and `isAutoMergeAllowed` returning false for `osv-scanner` given the
empty allow-list, which pins the default-closed property.

## Phase 2 — the workflow template

The content `TEMPLATES['osv-scanner']` writes. Verified against the action's own
source rather than its documentation, because a wrong input name would no-op
identically on every repo.

```yaml
name: OSV-Scanner

on:
  pull_request:
  schedule:
    - cron: '0 4 * * 1'

# security-events: write is REQUIRED even though the SARIF upload is disabled.
# Both called workflows declare it as a job-level permissions block, and GitHub
# validates the caller's grant against that declaration before any step runs.
# `upload-sarif: false` gates two STEPS; it cannot make a JOB's permission
# request conditional. Granting less fails the run at validation time on every
# repo. Granting it does NOT cause an upload — the upload step stays gated.
permissions:
  contents: read
  actions: read
  security-events: write

jobs:
  scan-pr:
    # The fork guard is not optional. On a pull_request from a fork GitHub caps
    # GITHUB_TOKEN at read-only regardless of the permissions key, so the static
    # security-events: write request fails validation and the job never starts.
    # Without this, every external contributor's PR gets a failing check.
    if: >-
      github.event_name == 'pull_request' &&
      github.event.pull_request.head.repo.full_name == github.repository
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@8deb546fdb875b9996d27d4950be7312dac076a1 # v2.5.0
    with:
      upload-sarif: false
      fail-on-vuln: true

  scan-scheduled:
    if: github.event_name == 'schedule'
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@8deb546fdb875b9996d27d4950be7312dac076a1 # v2.5.0
    with:
      upload-sarif: false
      fail-on-vuln: true
```

`fail-on-vuln: true` on the scheduled job is the whole reporting channel, and an
earlier draft set it `false` — which left the weekly scan completely mute. That
was caught in review, not in testing, because a mute job is green. At this pinned
SHA the reusable workflow has exactly three outputs: the SARIF upload (gated on
`upload-sarif`), GitHub annotations (hard-coded off upstream via
`--gh-annotations=false`), and the process exit code (gated on `fail-on-vuln`).
With the upload deliberately disabled to protect the health tier, the exit code
is all that remains, so a red job *is* the report. `export-results` is not a
fourth option: at this SHA the scanner writes `results.json` while the export
step tests for `osv-results.json`, so it always yields nothing.

The cost is that a repo carrying a vulnerability backlog shows a failing weekly
run, which feeds `ciPassRate`. That is accepted deliberately — a scan nobody can
hear is worse than a noisy one — and the canary measures how noisy it actually
is before the rollout commits to it. Governance currently reports zero open
vulnerabilities portfolio-wide, but OSV's database is broader than Dependabot's,
so the real backlog is unmeasured until the first scan runs.

The pin is `8deb546f…`, which is the commit the `v2.5.0` **tag** points at. An
earlier draft pinned `06b2ab43…` because that SHA appears inside the reusable
workflow's own `uses:` lines labelled `# v2.5.0` — but that is the inner
composite-action pin, three commits behind the tag, and at that ref the reusable
workflows still call the scanner at `# v2.3.8`. The template would have run a
scanner three versions old under a v2.5.0 label, and no phase would have caught
it because the workflow is green either way. When pinning a reusable workflow,
resolve the tag itself (`gh api repos/OWNER/REPO/git/ref/tags/vX.Y.Z`); never
lift a SHA out of the file's own contents.

Fork PRs get no scan as a consequence of the guard. That is a real coverage gap
and the alternative — a hard-failing check on every external contribution, which
Phase 5 would then escalate to a merge block — is worse. The scheduled full-tree
scan still covers whatever those PRs merge.

Unlike every other entry in `TEMPLATES`, this content is **not** a function of
ecosystem. OSV-Scanner detects lockfiles itself and the reusable workflow takes
no language input, so the template ignores its `eco` argument. That is
deliberate and worth a comment in the source, since the surrounding entries all
branch on ecosystem and a reader will expect this one to as well.

The cron is fixed at `0 4 * * 1` for every repo. Fourteen repos waking a
scheduled scan in the same minute is acceptable — these are separate repositories
with separate runner allocations, not a shared quota — but it is the kind of
thing that looks like an oversight, so it is called out here as a choice.

### Acceptance criteria

A golden-file test pins the exact rendered template. The repo already keeps
`src/__golden__/`, so this follows the existing mechanism. The test must assert
the SHA pin is present and that `upload-sarif: false` appears in both jobs —
those two lines carry the supply-chain and tier-protection properties, and a
future edit that drops either should fail loudly rather than silently.

## Phase 3 — canary

`repo-butler` itself is the canary. It is the strongest test available because it
is zero-dependency by project convention, so it exercises the no-manifest path
permanently rather than incidentally — and if the "nothing to scan" case is going
to fail a job, it will fail here.

Aiming the dispatch at it takes three steps, in this order. Set
`standards-exclude: osv-scanner:` to every eligible repo except `repo-butler`.
Wait for a GOVERNANCE run to rewrite the stored findings, because `runApply`
reads them from the data branch rather than recomputing. Then dispatch `apply.yml`
with `tools: osv-scanner` and `dry-run: false`. Review the PR by hand, merge it,
and confirm the workflow runs.

Two things to confirm before going wider, each of which would otherwise repeat
identically across 14 repos: that the workflow parses and the job actually starts,
and that a no-manifest repo reports success rather than failure.

The permissions question is no longer among them — it is settled in the template
above rather than deferred to this phase. What this canary structurally *cannot*
test is the fork-PR path, because `repo-butler` receives no fork PRs. That has to
be confirmed separately on `teams-for-linux`, which does, and it must be
confirmed before Phase 5 turns a failing check into a merge block.

### Acceptance criteria

A green `OSV-Scanner` check on a pull request in `repo-butler`, and a green
scheduled run. Should any permissions error still appear, the fix is always to
adjust the `permissions` block and re-run Phase 2's golden test — never to enable
the SARIF upload.

The `standards-exclude` entry is reverted before Phase 4 begins. Forgetting to
revert it is the most likely way this plan stalls silently: governance would keep
reporting full compliance while thirteen repos have no scanner at all.

## Phase 4 — rollout

Revert the `standards-exclude` entry so all eligible repos are back in scope, wait
for a GOVERNANCE run, then dispatch in batches under the per-run cap and review,
merge and verify each PR one at a time.

Batch order cannot be chosen directly — `capPerTool` takes the first N in
portfolio order. To front-load `teams-for-linux`, `betis-escocia` and
`bonnie-wee-plot`, which are the three actually losing Snyk coverage, keep the
other repos on the exclusion list for the first batch and drop them in
afterwards. Alternatively accept whatever order the portfolio list yields, which
is fine for correctness and only affects which repo is covered first. State which
route is being taken rather than assuming the named order will happen.

Stop and escalate rather than continue if any repo's PR fails CI for a reason
that is not obviously local to that repo, if the scan surfaces a large number of
findings on a repo previously reported clean, or if any repo's health tier moves.
Small, obviously-local problems — a lockfile the scanner cannot parse, a repo
needing an `osv-scanner.toml` suppression — are fixed in place and noted.

The four forks and the private repo need no handling; `eligibleRepos` excludes
them by construction.

### Acceptance criteria

Every eligible repo carries `.github/workflows/osv-scanner.yml` on its default
branch, the next GOVERNANCE run reports zero `osv-scanner` standards-gap
findings, and the portfolio's Gold count is unchanged from before Phase 1.

## Phase 5 — restore the blocking gate

Add the OSV-Scanner PR check to `betis-escocia`'s `merge-rules` ruleset
`required_status_checks`, alongside `Tests (Required)` and `CodeQL`.

This closes the hole opened on 2026-08-12 when `security/snyk (IsmaelMartinez)`
was removed. Until it is done the portfolio has no merge-blocking dependency
check anywhere, and nothing about that state looks broken, which is exactly why
it is a numbered phase rather than a footnote.

The check can only be added once it has reported at least once on that repo, as
GitHub matches required checks by name against observed check runs.

### Acceptance criteria

`gh api repos/IsmaelMartinez/betis-escocia/rulesets/7682156` lists the
OSV-Scanner check among its required contexts, and a PR with a newly introduced
vulnerable dependency is blocked from merging.

## Risks

The template is applied identically to every repo, so a defect in it is a
portfolio-wide defect. Phase 3 exists solely to bound that, and Phase 4 is
sequenced one repo at a time rather than fanned out for the same reason.

The `security-events` permission question is resolved in the template rather than
deferred: the grant is required for the call to validate at all, and the fork
guard exists because a fork PR cannot receive it. Both were caught in review
before any repo was touched; unedited, the original template would have failed on
every repo before running a step.

A repo with an unparseable or very large lockfile may fail the scan for reasons
unrelated to vulnerabilities. This is handled per-repo in Phase 4, not
pre-emptively.

`REPO_CACHE_SCHEMA_VERSION` is a portfolio-wide cache invalidation. The next run
after Phase 1 re-derives details for every repo, which is slower and makes more
API calls than a cached run. This is expected, one-off, and the mechanism the
repo already documents for exactly this situation.

## Fixed here: the fifteen-repo ceiling

Originally recorded below as a precondition to live with. It is fixed in this
change instead, because the same remedy the tri-state detection needed also
closes it: `detectStandardsGaps` now drops repos with no `details` entry from
`applicable`, so a repo nobody fetched is unknown rather than non-compliant. The
cap itself moves from a bare `15` to a named `PORTFOLIO_DETAIL_LIMIT = 40`, and
truncation now logs a warning instead of happening silently — "no findings" and
"never looked" must not read alike.

The original description follows, since it explains why it mattered.

## Precondition: the fifteen-repo ceiling

`fetchPortfolioDetails` populates `details` for `activeRepos.slice(0, 15)` only,
while `detectStandardsGaps` iterates the unsliced eligible list. A repo past that
index has no `details` entry, so every detector reading `details?.x` returns
false and the repo is reported non-compliant on **every** standard — and
`apply.js` treats that as a genuine PR target.

This is a pre-existing defect affecting all twelve current standards, not
something this plan introduces. It matters here because this plan's headline
promise is that a repo joining later gets the scanner without anyone
remembering to act, and the portfolio currently sits at exactly 14 active
non-fork repos. There is one slot of headroom.

So the promise holds to fifteen repos and then inverts: the sixteenth repo is
silently reported non-compliant on everything. Raising or removing that slice is
its own change and should be sequenced ahead of the portfolio growing, not
bundled here. Recorded so it is a known precondition rather than a surprise.
