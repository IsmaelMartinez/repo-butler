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

Snyk reaches three repos: `teams-for-linux`, `betis-escocia`, `bonnie-wee-plot`.
The other sixteen have no Snyk integration of any kind.

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
in place. A full pre-change copy of the ruleset was taken so the check can be
restored with a single `PUT` if this decision is reversed.

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

The pull-request reusable workflow is the one that protects build health, because
it diffs against the base branch and fails only on newly introduced
vulnerabilities — it will not retroactively redden a currently green portfolio:

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

For SAST, CodeQL already covers this and costs nothing on public repositories. It
runs on thirteen repos today; `pr-agent`, `flatpak-builder-lint`, `skills` and
`com.github.IsmaelMartinez.teams_for_linux` have no code scanning at all and are
the gap. Snyk Code was only ever meaningfully used on `ismaelmartinez.me.uk`,
whose sole finding set is the one the `.snyk` file suppresses.

Dependabot alerts and security updates stay exactly as they are. They are the
only free source of automated fix PRs, and the existing G12/G13 governance
machinery already reasons about their behaviour.

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

The emergency unblock is done. The Snyk App uninstall is the next step and is a
maintainer action. OSV-Scanner should land on the three previously-Snyk-covered
repos first, since those are the ones losing coverage, and can then spread to the
rest of the portfolio where Dependabot is currently the only dependency signal.
CodeQL should be extended to the four repos that lack code scanning. The inert
artefacts can be cleared at any point, independently, in ordinary pull requests.

Nothing here should be merged without review, and the Snyk App should not be
uninstalled until OSV-Scanner is landed on `teams-for-linux`, `betis-escocia` and
`bonnie-wee-plot`, so that dependency coverage never drops to nothing.

## Local Claude Code profile

This is outside the repositories but is where the quota is actually being
consumed. `~/.claude-home/settings.json` sets `SNYK_TOKEN` and registers
`snyk_secure_at_inception.py` on both `PostToolUse` (Edit|Write) and `Stop`. When
a scan cannot complete, that hook returns `{"decision": "block"}`, so an
exhausted quota blocks the Stop event on every session. The Snyk MCP server and
the `snyk-fix`, `snyk-batch-fix` and `secure-dependency-health-check` skills are
also wired in, and `CLAUDE.md` line 43 names Snyk as a gate that must be green
before a PR is marked ready.

Because each `snyk test` here runs against a filesystem path, every one is billed
as a private test — this hook is the most likely consumer of the 200-test
allowance. Disabling the two hooks is what stops the session blocking; the
`CLAUDE.md` gate line needs rewording to name the replacement tools. The work
profile at `~/.claude-work` carries a separate `SNYK_TOKEN` and is deliberately
out of scope here.
