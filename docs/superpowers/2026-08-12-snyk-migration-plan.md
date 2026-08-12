# Snyk removal and SCA migration — plan of record

Date: 2026-08-12
Status: proposed (one emergency step already applied, recorded below)

## Why this exists

Snyk's free tier began rejecting scans across the portfolio on 2026-08-10. The
rejection is a quota error, not a vulnerability finding, and it reaches GitHub
as a red commit status on pull requests. This document records what was actually
measured, corrects two plausible-but-wrong diagnoses, and sets out the migration.

## What was measured

Snyk is integrated as a **GitHub App posting a commit status** with the context
`security/snyk (IsmaelMartinez)`. It is not a GitHub Actions workflow. Every
workflow file in the portfolio — 90 files across 18 repos — was downloaded and
grepped case-insensitively for `snyk`, and there are zero matches. No
`snyk/actions/*`, no `snyk-cli`, no `npm exec snyk`.

This distinction matters more than it first appears, because it invalidates the
obvious investigation route. `gh run list` returns no Snyk runs and
`gh run view --log-failed` can never show a Snyk error, since there is no run to
read. The integration is only visible through commit statuses on pull request
head SHAs. A sweep of default-branch head commits also finds nothing, because
the App posts on PR heads and not on `main`.

The portfolio is 19 active repos, 18 of which contain workflow files at all — the
90 figure above covers those 18. Snyk reaches three of the 19:
`teams-for-linux`, `betis-escocia`, `bonnie-wee-plot`. The other 16 have no Snyk
integration of any kind.

The verbatim failure status, from `teams-for-linux` PR #2839:

```json
{"context":"security/snyk (IsmaelMartinez)",
 "created_at":"2026-08-11T20:07:05Z",
 "description":"You have used your limit of private tests",
 "state":"error"}
```

The preceding status on the same SHA reads `Snyk is running 1 test` with state
`pending`, so the test was dispatched and refused on quota rather than completing
with findings. Every Snyk failure examined was a quota error; none was a
vulnerability.

Onset is datable to within three minutes. On `bonnie-wee-plot`, PR #525 passed at
`2026-08-10T08:24:29Z` with "1 security test has passed", and PR #527 errored at
`2026-08-10T08:27:13Z` with "You have used your limit of private tests". The most
recent error observed was `2026-08-12T07:15:03Z`, so the condition is ongoing.

## Two corrections worth keeping

The first is about blast radius. The red crosses appear on all three integrated
repos, which reads as portfolio-wide breakage, but Snyk was a **required status
check on only one repo**. `betis-escocia`'s `merge-rules` ruleset listed
`Tests (Required)`, `CodeQL` and `security/snyk (IsmaelMartinez)`.
`teams-for-linux` requires only `repo-butler/copilot-code-review`, and
`bonnie-wee-plot` requires only `Build`. On two of the three repos Snyk failing
was noise that never stopped a merge.

The second correction is about the word "private". Snyk's documentation states
that test limits "apply to private repositories only", and all three affected
repos are public — which invites the conclusion that this is a misconfiguration
to be fixed rather than a tool to be replaced. It is not. A local CLI run
reproduces the same error and reveals why:

```
Organization:      ismaelmartinez
Project name:      repo-butler
Open source:       no
...
You have reached your monthly limit of 200 private tests for your ismaelmartinez org.
```

`Open source: no` is the operative line. The public-repo exemption applies to
projects Snyk recognises through its SCM integration. Scans invoked against a
filesystem path carry no link to a public repository and are billed as private
tests. The free tier allows 200 of those per month, and 100 Snyk Code tests;
`snyk code test` now returns `403 Forbidden` outright, so the Code allowance is
gone as well. This is a structural mismatch between how the scans are invoked and
how the free tier is scoped, not a token or settings error.

## What was not caused by Snyk

CI failures elsewhere in the portfolio are unrelated and must not be attributed
to this. `betis-escocia` (3 of 20 runs), `bonnie-wee-plot` (5 of 20) and
`wifisentinel` (1 of 20) fail on the TypeScript 7 toolchain wall —
`typescript-eslint does not support TS 7.0`, `TS5102: Option 'baseUrl' has been
removed`, and an `ERESOLVE` peer conflict. `lounge-tv` (3 of 20) fails its
channel validator on dead stream URLs, which is the workflow working correctly.
`github-issue-triage-bot` (2 of 20) fails on an HTTP 404 synthesis step and a Go
build. None of these logs contain the string `snyk`.

Governance data confirms the portfolio is otherwise healthy: zero open
vulnerabilities, zero tier regressions, and one stalled Dependabot alert on
`teams-for-linux` that predates all of this.

## Step already applied

`betis-escocia`'s `merge-rules` ruleset had `security/snyk (IsmaelMartinez)`
removed from its required status checks. This was the only place Snyk blocked a
merge, and it was blocking on a quota error rather than a finding. The remaining
five rules (deletion, pull_request, non_fast_forward, required_linear_history,
copilot_code_review) and the other two required checks are untouched and verified
in place.

To reverse it, re-add the context to ruleset `7682156` on that repo — the
required checks before the change were exactly
`Tests (Required)` (integration_id 15368), `CodeQL`, and
`security/snyk (IsmaelMartinez)`, in that order. Recording them here rather than
pointing at a scratch file, since a rollback note that outlives its backup is
worse than none.

PR #470 on that repo remains blocked afterwards, correctly, on a genuine
`Tests (Required)` failure.

## Remaining removal work

The one step that cannot be done through the API is uninstalling the Snyk GitHub
App; `user/installations` returns 403 for this token, so it needs a maintainer
action at `github.com/settings/installations`. Until it happens, Snyk keeps
posting red error statuses on pull requests in the three integrated repos. They
are now cosmetic everywhere, but they are misleading.

The remaining artefacts are inert and can be cleared in ordinary pull requests.
`teams-for-linux` carries a Snyk badge at `README.md` line 8 which now renders
"Snyk security — monitored" rather than a vulnerability count, advertising
oversight that is not happening. `ismaelmartinez.me.uk` has a `.snyk` policy file
and a matching comment at `scripts/screenshot-games.js` lines 27–28.
`betis-escocia` has two `.gitignore` lines for the Snyk IDE extension's
auto-generated rules. `bonnie-wee-plot` holds an orphaned `SNYK_TOKEN` repository
secret that no workflow consumes, plus a stale ADR
(`docs/adrs/020-vercel-deployment-security.md`) still describing a
`.github/workflows/snyk.yml` that PR #282 already deleted; that ADR wants a
superseding note rather than quiet deletion.

The `.snyk` file needs care. It is not merely configuration — it records four
accepted Snyk Code findings on `scripts/screenshot-games.js`, a developer-only
loopback screenshot harness that is never shipped or imported, covering path
traversal and cleartext-HTTP findings judged acceptable in that context. That
reasoning should survive into whatever replaces it, as a suppression entry or an
exclusion from the SAST scan path.

## Replacement

Snyk was providing dependency scanning and, on one repo, SAST. Nothing in the
portfolio uses its container or IaC scanning.

For dependency scanning the replacement is **OSV-Scanner**. It is Apache-2.0,
requires no account and no token, and the OSV.dev FAQ answers the rate-limit
question with "No. Currently there is not a limit on the API." That was verified
directly: an unauthenticated query returns real advisory data, and
`google/osv-scanner-action` is at v2.5.0 published 2026-08-07, unarchived, pushed
2026-08-11. Its lockfile coverage spans all four npm formats plus Python, Go and
the rest of the portfolio's ecosystems, and it emits SARIF into the GitHub
Security tab.

The pull-request reusable workflow diffs against the base branch and fails only
on newly introduced vulnerabilities, so it will not retroactively redden a
currently green build:

```yaml
name: OSV-Scanner PR Scan
on:
  pull_request:
    branches: [main]
permissions:
  actions: read
  security-events: write
  contents: read
jobs:
  scan-pr:
    uses: "google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@v2.5.0"
```

That variant alone is not sufficient, and shipping only it would quietly lose
coverage. Snyk tested the whole lockfile on every run; the PR variant tests only
the diff. A vulnerability already sitting in a lockfile is then reported by
nothing — no PR touches it, so the diff is empty, and Dependabot never raised it
(the pnpm auto-installed-peer case is exactly this shape). The scheduled
`osv-scanner-reusable.yml` must land alongside the PR one to cover the standing
backlog.

Both must pin the reusable workflow by commit SHA rather than the `v2.5.0` tag
shown above, because these jobs are granted `security-events: write` and a
mutable third-party tag is a write-capable supply-chain surface. The
`branches: [main]` filter also needs checking per repo before use — any repo
whose default branch is not `main` would silently never run it.

For SAST, CodeQL already covers this and costs nothing on public repositories. It
runs on fourteen repos today. The remaining four — `pr-agent`,
`flatpak-builder-lint`, `skills` and `com.github.IsmaelMartinez.teams_for_linux` —
are **not** a gap to close: all four are upstream forks, and `eligibleRepos` in
`governance.js` filters `!r.fork` by design, so governance deliberately excludes
them. Their security ownership sits upstream. The Flathub manifest repo is the
clearest case: `/languages` returns `{}`, so a CodeQL workflow there would fail
with "no source code was seen during the build" in perpetuity on a repo that
contains no code. Leave them alone.

Snyk Code was only ever meaningfully used on `ismaelmartinez.me.uk`, whose sole
finding set is the one the `.snyk` file suppresses.

Dependabot alerts and security updates stay exactly as they are. They are the
only free source of automated fix PRs, and the existing G12/G13 governance
machinery already reasons about their behaviour.

## The SARIF upload is a tier decision, not a display choice

This is the trap in the whole migration and it must be settled before
OSV-Scanner lands anywhere. Uploading SARIF into the GitHub Security tab is not
a neutral reporting convenience here, because repo-butler reads that same
surface to score itself.

`computeHealthTier` in `report-shared.js` sets `codeScanningOk` false when
`r.codeScanning.max_severity` is `critical` or `high`, which fails the
"Zero critical/high security findings" gold check. `detectOpenVulnerabilities`
in `governance.js` reads the same field and emits `high`-priority
`open-vulnerability` findings. Today every repo's code-scanning signal comes from
CodeQL, which reports SAST findings only — no repo has ever had SCA advisories in
that channel.

So the moment OSV-Scanner uploads SARIF for pre-existing transitive npm
advisories, `teams-for-linux`, `betis-escocia` and `bonnie-wee-plot` drop off
Gold on the public dashboard and the governance banner flips to `attention` —
without a single new vulnerability being introduced. The claim above that the PR
variant "will not retroactively redden a currently green portfolio" is true of
build status and false of the health tier, which is the signal actually watched.
Getting this wrong reproduces precisely the metric damage this migration exists
to stop.

Three ways out, and the choice is the maintainer's. Land OSV-Scanner without the
SARIF upload and let it fail the job instead, keeping the code-scanning channel
CodeQL-only and the tier logic untouched. Or upload SARIF and accept a one-off
tier dip while the backlog is worked down, which is honest but noisy. Or upload
only `critical` findings and gate the rest at job level. The first is the
conservative default and the one that preserves the existing meaning of the
tier; nothing should ship until this is decided, because it is far easier to
choose now than to unpick a portfolio-wide tier drop afterwards.

Optionally, `actions/dependency-review-action` with `fail-on-severity: high` adds
PR-time gating and licence checks, free on public repos.

## What is genuinely lost

Reachability analysis for npm. Snyk's differentiator was reporting whether a
vulnerable function is actually called, which is what makes a large transitive
dependency tree triageable. OSV-Scanner's call analysis covers Go, Rust and Java
but not JavaScript. Semgrep's cross-file dataflow is a paid-platform feature and
its Community Edition is explicit that it "will miss many true positives".
Socket.dev's reachability sits on a paid tier. There is no free npm reachability
option in 2026.

The practical consequence is more manual triage: severity floors do the filtering
instead, via `fail-on-severity: high` and `--severity CRITICAL,HIGH`, with
`osv-scanner.toml` suppressions carrying a written reason. Snyk's curated
minimum-fix-version advice is also lost; `src/trimmer.js` is already an in-house
partial answer to that gap.

One capability worth noting as an addition rather than a replacement: neither
Snyk nor OSV-Scanner detects supply-chain attacks — install scripts, typosquats,
obfuscated code. Socket.dev does, and offers a complimentary upgrade for
open-source projects, at the cost of reintroducing one vendor account. That is a
judgement call, not a requirement of this migration.

## Sequence

The emergency unblock is done. Decide the SARIF question above before anything
else, because it determines how OSV-Scanner is configured everywhere.

Then land OSV-Scanner — both the PR and scheduled variants — on the three
previously-Snyk-covered repos first, since those are the ones losing coverage,
and spread from there to the rest of the portfolio where Dependabot is currently
the only dependency signal. Leave the four forks alone.

**`betis-escocia` must then get its blocking gate back.** Removing the Snyk
required check was the right emergency action, but it leaves the portfolio's only
merge-blocking dependency check retired rather than replaced. Until the
OSV-Scanner check is added to that ruleset's `required_status_checks`, a PR
introducing a critical advisory merges green on `Tests (Required)` and `CodeQL`
alone, and the repo ends this migration with weaker protection than it had on
2026-08-09. This step is not optional and it is easy to forget, because nothing
will be visibly broken in the meantime.

Only once those three repos have replacement coverage should the Snyk App be
uninstalled, so dependency coverage never drops to nothing. The inert artefacts
can be cleared at any point, independently, in ordinary pull requests.

Nothing here should be merged without review.

## Local Claude Code profile

This is outside the repositories but is where the quota is actually being
consumed. `~/.claude-home/settings.json` sets `SNYK_TOKEN` and registers
`snyk_secure_at_inception.py` on both `PostToolUse` (Edit|Write) and `Stop`. When
a scan cannot complete, that hook returns `{"decision": "block"}`, so an
exhausted quota blocks the Stop event on every session. The Snyk MCP server and
the `snyk-fix`, `snyk-batch-fix` and `secure-dependency-health-check` skills are
also wired in. The global user instructions at `~/.claude-home/CLAUDE.md` — not
this repository's `CLAUDE.md`, which never mentions Snyk — name Snyk as a gate
that must be green before a PR is marked ready.

Because each `snyk test` here runs against a filesystem path, every one is billed
as a private test — this hook is the most likely consumer of the 200-test
allowance. Disabling the two hooks is what stops the session blocking; that
global gate line needs rewording to name the replacement tools.

Decommissioning is not complete when the hooks come out. The `SNYK_TOKEN` in
that file is a live credential sitting in plaintext, and it should be revoked at
Snyk rather than merely left unused — a token that outlives the integration it
served is a credential nobody is watching. The Snyk MCP server registration and
the three Snyk skills should come out at the same time, or a later session will
happily re-authenticate against a vendor the portfolio has formally dropped. The
orphaned `SNYK_TOKEN` repository secret on `bonnie-wee-plot` belongs to the same
sweep. The work
profile at `~/.claude-work` carries a separate `SNYK_TOKEN` and is deliberately
out of scope here.
