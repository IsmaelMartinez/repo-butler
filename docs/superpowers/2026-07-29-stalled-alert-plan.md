# Plan: the stalled-alert watcher (G13), and what stays parked

Date: 2026-07-29

Supersedes the rescan-nudging proposal in
[the autonomous garden plan](2026-07-25-autonomous-garden-plan.md) lines 47/59.
Rests on [ADR-014](../decisions/014-no-programmatic-dependabot-rescan.md) and the
[spike](2026-07-29-dependabot-rescan-spike.md) that produced it.

## The property being added

G7 notices a repo losing tier. G12 notices the butler's own PR failing to land.
Both instance the same missing property: *something acts, and nothing checks
afterwards whether it worked.* G13 completes the set by watching the third actor —
**Dependabot** — because the spike found a live alert that had been open
thirty-five days while every existing signal reported the repository healthy.

The alert is invisible today for two independent reasons, and both must be fixed
or the finding will not fire. It is `medium` severity, and `detectOpenVulnerabilities`
only considers critical/high. And nothing anywhere correlates an alert with the
presence or absence of a Dependabot pull request.

## G13 — the `stalled-alert` finding

Detection only. No writes. ADR-014 is the authority and it authorises no new write.

**Trigger.** An open Dependabot alert, at or above a configurable severity floor,
older than a threshold, with **no open Dependabot pull request addressing that
package**. All three conditions are needed: without the severity floor it is a
duplicate of the alert list, without the age threshold it fires on alerts
Dependabot is about to fix anyway, and without the PR check it fires on alerts
that are already being remediated.

**Matching an alert to a PR.** Dependabot branches are structured —
`dependabot/npm_and_yarn/docs-site/postcss-8.5.23`,
`dependabot/github_actions/main/actions/checkout-7`,
`dependabot/npm_and_yarn/docs-site/minor-and-patch-479fbeca4e`. The package name
is present for single-package PRs. **Grouped PRs do not name their contents**
(`minor-and-patch-<hash>`), so branch matching cannot be authoritative, and this
is the single most likely source of false positives. Treat a grouped Dependabot
PR touching the same ecosystem and directory as "possibly addressing this alert"
and suppress the finding, erring toward silence — a false negative here costs a
delayed report, a false positive costs trust in every row of the table.

**Classification, via the trimmer, read-only.** Fetch the manifest and lockfile
the alert names, hand them to `planOverride`, and record the verdict.
`reachable-by-update` means a lockfile refresh clears it and nobody has run one —
the thirty-five-day case, and the one an operator can act on immediately.
`direct-dependency` means bump it normally. `disjoint-ranges` / `out-of-scope`
mean it genuinely needs a human decision. An `override` verdict is reported as a
classification only and **never acted on** (ADR-013 governs that jump).

**Fail closed on unreadable input.** `getFileContent` returns `null`
indistinguishably for absent, 404, rate-limited and over-1 MB, and real lockfiles
exceed 1 MB — the `teams-for-linux` docs-site lockfile is 787 KB, which is close.
An unreadable manifest or lockfile yields `classification: 'unknown'` and a
finding that still reports the staleness. It must never yield a guess, and must
never suppress the finding — the alert is stale whether or not we can explain it.

**Finding shape**, mirroring the existing per-repo state findings:

```js
{ type: 'stalled-alert', repo, alerts: [{ number, package, ecosystem, manifestPath,
  severity, ageDays, classification, detail }], priority }
```

`executor: 'manual'`, off cross-repo PROPOSE, and `computeHealthTier` untouched —
the same lane every per-repo state finding already occupies.

### Verifier — the loopable goal

```bash
cd <repo-butler> && bash scripts/verify-g13.sh
```

It must fail **now**, before the work exists, and fail closed when inputs are
missing. Three gates, each closing a way the previous goals nearly passed
vacuously:

1. **ADR-014 exists and carries its argument** — not just a file with the right
   name. Grep for the declined-issue evidence, since that is the load-bearing
   fact; a stub would otherwise satisfy `test -f`.
2. **A floor of named `stalled-alert` tests actually run.** `node --test
   --test-name-pattern` exits 0 and reports `pass 1` when the target file is
   absent and zero tests match, so an exit code alone declares the goal already
   met. This trap has now caught two goals; the floor is mandatory.
3. **The real-data fixture is exercised.** A committed capture of
   `teams-for-linux` alert #153 plus the relevant lockfile subgraph, asserting
   the classification comes out `reachable-by-update`. Fabricated fixtures prove
   the logic; this proves it reads the real payload.

**Loop shape:** run the verifier, advance G13 on failure, re-run, stop on pass. A
blocker report is a legitimate terminal state.

### Acceptance, and it is meetable today

Unlike G6 — whose canary needed an open critical/high alert that does not
exist — G13 has a live target right now: `teams-for-linux` #153, open since
2026-06-24, `reachable-by-update`. If G13 ships and does not surface it, G13 is
wrong. That is a real acceptance test rather than a deferred one, and it is the
main reason to build this next.

Note the ordering risk: **someone may fix that alert before G13 ships**, which
would remove the live target. The committed fixture is what makes the goal
survive that, so capture it early rather than at the end.

## Deliberately parked

**A templated lockfile-refresh workflow.** The butler cannot run `npm install` —
it is API-only. It *could* template a workflow into a target repo that runs
`npm update --package-lock-only` and opens a PR, with the npm work happening in
the target's own CI. This is genuinely ADR-005-shaped, since the butler would
write a fixed string and never transform content. It is parked because it grants
a target repository's CI the standing ability to modify its own lockfile, which
is a larger grant than any current write, and because G13's findings are the
evidence needed to know whether it is worth making. Its own ADR, after a soak.

**Everything the spike ruled out** stays ruled out: no rescan trigger, no commit
pushing, no ADR-012 setting toggling. ADR-014 records why, so this does not get
rediscovered.

## Still unbuilt from the original plan

G8 (MCP staleness guard), G9 (independent notetaker), G11 (CI hygiene). None is
blocked by this.
