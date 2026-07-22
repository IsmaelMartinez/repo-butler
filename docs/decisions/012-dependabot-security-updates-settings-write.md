# ADR-012: Enabling Dependabot Security Updates — a Settings Write that Delegates Autonomy

Date: 2026-07-22

Status: Accepted

Extends [ADR-009](009-settings-level-writes.md) (settings-level, PR-less writes) and
answers the question ADR-009 explicitly left open: *each new settings-write finding
class needs its own review, because ADR-009's benign-worst-case argument was made for
one specific rule and does not automatically carry over.* This is the first class to
be admitted under that clause, and — unlike Copilot review — it does **not** cleanly
pass the benign-worst-case test, so it is fenced tighter than the ADR-009 class.

## Context

Phase 1 (PR #331) added the deterministic `open-vulnerability` governance finding: a
per-repo state finding that fires when a repo carries open critical/high Dependabot or
code-scanning alerts, or any secret-scanning hit. It routes to `executor: 'manual'`
(ADR-002/ADR-011 lane boundary — resolving a specific alert is per-repo work, not a
cross-repo statistic) and records which scanner(s) fired in `sources`.

For the `dependabot`-sourced subset there is a settings-level remediation GitHub offers
directly: **automated security fixes**. Enabling it
(`PUT /repos/{owner}/{repo}/automated-security-fixes`) makes GitHub itself open pull
requests that bump vulnerable dependencies to a patched version. The feature requires
vulnerability alerts to be enabled first
(`PUT /repos/{owner}/{repo}/vulnerability-alerts`); both writes need only
`administration: write`, which the App already holds (granted for the ADR-009 Copilot
rollout). `GET /repos/{owner}/{repo}/automated-security-fixes` returns
`{ enabled, paused }`.

Like the Copilot ruleset, this is a PR-less settings write — there is no file to
template into a reviewable PR — so it rides the ADR-009 pattern
(`applyCopilotReviewRulesets` is the shape). But that is where the resemblance ends.

## Why this class does NOT pass ADR-009's benign-worst-case test

ADR-009 admitted the Copilot ruleset because its worst case is *benign*: a
wrongly-targeted `copilot_code_review` rule merely asks a reviewer to look at a PR — it
cannot block a merge, lock a branch, or restrict a contributor. Enabling automated
security fixes is different in four concrete ways, and each one is a failure mode
ADR-009's argument does not cover:

1. **It delegates autonomous PR generation to a third party (GitHub).** The instant the
   flag flips, GitHub — not the butler — may open a *burst* of dependency-bump PRs on
   the target repo, one per outstanding advisory. This escapes the butler's per-run cap
   entirely: the cap bounds how many repos the butler *enables*, but not how many PRs
   GitHub then opens on each. The blast radius is no longer something the butler
   measures.

2. **A bump can break CI.** A security patch is still a version change; it can be a
   breaking major, or interact badly with a pinned peer. Unlike the Copilot rule (which
   changes nothing about what merges), an enabled auto-fix can land a red build on a
   repo the maintainer was not watching.

3. **The flag is un-name-guardable.** ADR-009's reversibility rests on a *distinctively
   named* object (`repo-butler/copilot-code-review`) the butler can recognise as its
   own and refuse to touch anything else. `automated-security-fixes` is a single boolean
   repo flag with no name and no owner attribution. The butler cannot tell "I enabled
   this" from "the maintainer enabled this" from "the maintainer deliberately *disabled*
   this". Re-enabling a flag a human turned off would silently override a deliberate
   human decision — precisely the failure the name-guard was built to prevent, and here
   there is no name to guard.

4. **Reversibility is partial.** `DELETE /repos/{owner}/{repo}/automated-security-fixes`
   turns the setting back off, but it does **not** close PRs GitHub already opened while
   it was on, and it does not undo any merge. The tested rollback path
   (`removeDependabotSecurityUpdates`) restores the *setting*, not the *state of the
   world*.

The moment a settings write can trigger autonomous change on a repo the way this one
can, ADR-009's "worst case is benign" argument no longer holds and — exactly as ADR-009
instructed — the gate analysis is redone here.

## Decision

Permit enabling Dependabot automated security fixes as a settings write, for the
`dependabot`-sourced `open-vulnerability` findings only, under the five ADR-005 gates
and the three ADR-009 writes-without-a-PR gates, **plus** additional fencing that
answers the four failure modes above. Concretely:

- **Manual-dispatch only, OFF the apply-schedule allow-list by construction.** The
  Copilot class is *promotable* onto the no-human scheduled path via
  `apply-schedule` (default-closed but allow-listable). This class is **never**
  allow-listable: `applyDependabotSecurityUpdates` skips unconditionally when
  `scheduled` is set, ignoring the allow-list entirely, and `index.js` never even
  dispatches it on a scheduled run. There is no config entry that turns it on for cron.
  This directly answers failure mode 1 — a no-human run must never trigger a PR burst.

- **Auto-merge-ineligible by construction.** `isAutoMergeAllowed` requires the tool to
  have a `TEMPLATES` entry; a settings write has none, so `dependabot-security` can
  never enter the `apply-automerge` path even if mistakenly listed. (This answers
  failure mode 2: the butler never merges the resulting bumps — a broken build stays
  visibly open for the maintainer.)

- **Dry-run fail-closed.** Only the literal `dry-run=false` acts; anything else previews
  the exact repo list and writes nothing. The preview is the audit record standing in
  for the absent PR diff.

- **`require_approval` master switch.** Refuses to run unless
  `config.limits.require_approval` is true — the system-wide kill switch, shared with
  every other apply action.

- **Per-run cap + repo-name validation + dedup.** `selectDependabotSecurityTargets`
  filters to `dependabot`-sourced findings, validates every repo against
  `REPO_NAME_PATTERN`, dedups, and caps at `maxPerRun`. This bounds how many repos the
  butler *enables* per run (not, per failure mode 1, how many PRs GitHub then opens).

- **LIVE idempotency that also respects human intent.** Immediately before writing, the
  apply path re-reads `{ enabled, paused }` from the live API (not the stale OBSERVE
  snapshot) and **skips if enabled OR paused**. Skipping on *enabled* is ordinary
  idempotency. Skipping on *paused* is the answer to failure mode 3: a paused repo is
  one a human — or GitHub, on an inactive repo — set deliberately, and since the flag is
  un-name-guardable, treating paused as hands-off is the only way to avoid overriding a
  deliberate decision. The butler never re-enables what is paused.

- **Reversibility via DELETE, with its limits documented.** `removeDependabotSecurityUpdates`
  issues `DELETE /repos/{owner}/{repo}/automated-security-fixes`. Per failure mode 4 this
  reverts the setting, not already-opened PRs; the ADR records that limit rather than
  pretending the rollback is total. Vulnerability alerts are intentionally left enabled
  (read-only surfacing is never harmful).

### Executor and lane

`open-vulnerability` stays `executor: 'manual'` (ADR-002/ADR-011): it is never wired to
the templated-PR path (`applyGovernanceFindings` filters on `executor === 'template'`)
or to cross-repo PROPOSE. `applyDependabotSecurityUpdates` is a sibling apply function
behind the same gate stack — the same relationship `applyCopilotReviewRulesets` and
`nudgeStaleDependabotPRs` have to the PR path — not a branch inside it.

### Token scope (falsifiable canary)

Both PUTs need `administration: write`, which the App already carries. The plan called
for a live canary — `PUT /repos/IsmaelMartinez/wifisentinel/automated-security-fixes`
returning 204 — to confirm the scope empirically before shipping. That canary must be
run with the **App token** in the Action environment (or by the maintainer): the
interactive development session reaches GitHub through an egress proxy whose allow-list
does not include the `automated-security-fixes` / `vulnerability-alerts` API paths, so
the probe returns a *proxy* 403 that neither confirms nor falsifies the App's scope. The
canary is therefore a maintainer/Action step, tracked alongside the deliberate live
enable below.

## Consequences

The butler gains its second settings-write finding class, admitted under the ADR-009
clause that each such class needs its own review — and the review found this one *does
not* inherit ADR-009's benign-worst-case licence, so it is fenced strictly tighter:
manual-dispatch only with no scheduled promotion path, auto-merge-ineligible by
construction, and idempotent against a human's paused-flag decision it cannot otherwise
detect.

The code ships dry-run-inert. Going live is two deliberate maintainer steps, exactly as
the Copilot go-live was: (1) run the App-token canary to confirm the write returns 204,
and (2) dispatch `Governance Apply` with `tools=dependabot-security dry-run=false`. Until
then the apply path previews exactly which `dependabot`-sourced repos it would enable and
writes nothing.

What this ADR does **not** authorise: enabling this class on the scheduled path (it is
un-schedulable by construction, and relaxing that would require redoing the failure-mode-1
analysis), auto-merging the resulting bump PRs, or extending the same treatment to any
settings write that can block merges or restrict access — those remain out of scope for
both ADR-009 and this ADR.

## Phase 3 addendum — detection consumes the enabled state (2026-07-22)

Phase 3 wires the `GET .../automated-security-fixes` read (`getAutomatedSecurityFixesState`,
already used by the LIVE apply idempotency guard above) into **detection**, so a
`dependabot`-sourced `open-vulnerability` finding can distinguish "remediation in flight"
(autofix ON — GitHub is opening the bump PRs) from "not being driven to resolution" (OFF).
Two changes, neither opening a new trust boundary:

- **The state is fetched read-only in the OBSERVE/portfolio-details layer** (`observe.js` +
  `report-portfolio.js`), threaded into `details[repo].autofix`, and read by the pure
  `detectOpenVulnerabilities` — detection gains no GitHub client. The finding carries
  `autofixEnabled` (`true`/`false`/`null`; paused → `false`, unreadable → `null`). When
  `true` and Dependabot is the only source, a `high` finding is downgraded to `medium`;
  `max_severity` is untouched and the health-tier drop stands (an open alert is still open —
  "in flight" is a governance annotation, not a tier reprieve). Because the read is inert
  (a `GET`, degrading to `null` on any error), it introduces **no new trust boundary** and
  needs no new ADR — this addendum is the cross-link.

- **The reversibility DELETE gains an operator entry point.** `disableDependabotSecurityUpdates`
  (`tools=dependabot-security-off`) wraps `removeDependabotSecurityUpdates` over the same
  dependabot-sourced target selection behind the *identical* fence stack as the enable path —
  `require_approval`, dry-run fail-closed, **manual-dispatch only / OFF the scheduled path by
  construction**, per-run cap, repo-name validation — and is an explicit dispatch only (never
  fires on a blank `tools` run). Reversal remains partial per failure mode 4: it reverts the
  setting only, not any bump PR GitHub already opened, and leaves vulnerability-alerts on.

The Phase 3 read shares the same egress-proxy caveat as the canary above: the interactive
session cannot reach the API path, so the live `GET` 200 confirmation remains a maintainer/
Action step. Detection degrades to `null` ("unknown, don't annotate") on any error, so a
proxy-blocked read is inert rather than misleading.
