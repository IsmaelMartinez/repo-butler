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

Seven edits. The count matters: an earlier draft said five and would have
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
   `.github/workflows/osv-scanner.yml` and the content in Phase 2.

Detection must **fail toward present**: on a truncated workflow list
(`total_count` greater than the returned array) or on a request error,
`hasOsvScanner` is `true`. This mirrors `hasReleaseWorkflow`, which already
documents the reason — the field gates a cross-repo write, so a transient API
failure must never manufacture a remediation PR on 14 repos at once.

Detection matches on the workflow **path** `.github/workflows/osv-scanner.yml`,
not on the display name, and not on a substring of either. A name-based match
would be satisfied by an unrelated workflow that merely mentions the scanner, and
a substring match on path risks matching a repo's own hand-rolled variant that
this template would then never be able to satisfy.

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

permissions:
  contents: read
  actions: read

jobs:
  scan-pr:
    if: github.event_name == 'pull_request'
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@06b2ab4348248b456ee06c9e953637f55e03504f # v2.5.0
    with:
      upload-sarif: false
      fail-on-vuln: true

  scan-scheduled:
    if: github.event_name == 'schedule'
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@06b2ab4348248b456ee06c9e953637f55e03504f # v2.5.0
    with:
      upload-sarif: false
      fail-on-vuln: false
```

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

Dispatch `apply.yml` for `osv-scanner` against exactly one repo, review the PR by
hand, merge it, and then confirm the workflow actually runs.

`repo-butler` itself is the canary. It is the strongest test available because it
is zero-dependency by project convention, so it exercises the no-manifest path
permanently rather than incidentally — and if the "nothing to scan" case is going
to fail a job, it will fail here.

Three things to confirm before going wider, each of which would otherwise repeat
identically across 14 repos:

The workflow parses and the job starts at all. The omitted
`security-events: write` does not error, given a reusable workflow's permissions
are capped by its caller and the upload step is skipped — this is the single
least-certain line in the template. And a no-manifest repo reports success rather
than failure.

### Acceptance criteria

A green `OSV-Scanner` check on a pull request in `repo-butler`, and a green
scheduled run or a successful `workflow_dispatch` equivalent. If the permissions
line does error, the fix is to add `security-events: write` to the template's
`permissions` block and re-run Phase 2's golden test — not to enable the upload.

## Phase 4 — rollout

Dispatch the remaining eligible repos in batches under the per-run cap, then
review, merge and verify each PR one at a time.

`teams-for-linux`, `betis-escocia` and `bonnie-wee-plot` go in the first batch:
they are the three losing Snyk coverage, so their gap is real rather than
notional.

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

The `security-events` permission question is genuinely unresolved and is the most
likely cause of a Phase 3 failure.

A repo with an unparseable or very large lockfile may fail the scan for reasons
unrelated to vulnerabilities. This is handled per-repo in Phase 4, not
pre-emptively.

`REPO_CACHE_SCHEMA_VERSION` is a portfolio-wide cache invalidation. The next run
after Phase 1 re-derives details for every repo, which is slower and makes more
API calls than a cached run. This is expected, one-off, and the mechanism the
repo already documents for exactly this situation.
