# ADR-014: No Programmatic Dependabot Rescan — Detect and Explain Instead

Date: 2026-07-29

Status: Accepted

Supersedes the rescan-nudging proposal in
[the autonomous garden plan](../superpowers/2026-07-25-autonomous-garden-plan.md)
(lines 47 and 59). Evidence is in the companion spike,
[2026-07-29-dependabot-rescan-spike.md](../superpowers/2026-07-29-dependabot-rescan-spike.md).
Unlike [ADR-005](005-cross-repo-pr-gates.md), [ADR-009](009-settings-level-writes.md),
[ADR-012](012-dependabot-security-updates-settings-write.md) and
[ADR-013](013-content-transformation-writes.md), this ADR authorises **no new
write**. It records a capability the butler will not build, and what it does
instead.

## Context

The plan of record proposed that the highest-value remaining automation was to
detect a Dependabot alert sitting open with no corresponding pull request, and
then force a rescan. It flagged its own uncertainty: there might be no public API
for this, and the only thing observed to work was pushing a commit to the default
branch.

A negative result is worth an ADR precisely because it is invisible in the code.
Nothing in the repository will ever show that this was investigated, so without a
written decision the next person to read line 47 of the plan will simply try
again.

## Decision

**The butler will not attempt to trigger a Dependabot scan by any mechanism.**

This closes four routes explicitly, so none is rediscovered as a clever idea:

- **The internal web route.** `/{repo}/network/updates?update_config_id={ID}` is
  what the UI's "Check for updates" button calls. It is undocumented, absent from
  the REST API, and keyed by a per-repo config ID with no published way to fetch
  it. Depending on it means depending on something GitHub never promised to keep.
- **Pushing a commit to provoke a scan.** This demonstrably works and is
  precisely why it is dangerous: it makes the butler write to a repository for
  the side effect of the write rather than its content, which is unreviewable by
  construction. A diff whose purpose is to not matter cannot be assessed by a
  human reviewer.
- **Toggling the ADR-012 automated-security-fixes setting off and on.** The
  butler already has both `applyDependabotSecurityUpdates` and
  `removeDependabotSecurityUpdates`, so this is mechanically within reach. It is
  refused for the same reason as the commit push — the state change is not the
  point, the side effect is — and it additionally risks leaving a repository
  disabled if the run fails between the two halves.
- **Waiting for an official API.** `dependabot/dependabot-core#6098` requested
  exactly this and is **closed as not planned**. This is a declined feature, not
  a pending one.

**Instead, the butler detects the condition and explains it.** A new
`stalled-alert` governance finding reports that an alert has been open beyond a
threshold with no Dependabot pull request addressing it, and classifies *why* it
is stuck. Remediation stays with a human.

**The classification reuses `src/trimmer.js` read-only.** `planOverride` already
returns `reachable-by-update`, `direct-dependency`, `disjoint-ranges`,
`out-of-scope` or an override plan, which is a triage vocabulary for this exact
question. Two consequences follow, and both matter:

- G6's core gets its first caller **on the read path**, which is why this needs no
  new trust-model argument. ADR-013's gates govern *writing* a transformed
  manifest; nothing here writes anything, so none of them is engaged. ADR-013's
  "what the caller must guarantee" section still binds — in particular, the lock
  and manifest handed to `planOverride` must belong to the same project, and
  unreadable input must produce a refusal to classify rather than a guess.
- An `override` verdict is reported as a *classification*, never acted on. The
  finding says "a parent-scoped override would fix this"; it does not open the PR.
  Making that jump is ADR-013's business and requires its own deliberate wiring.

### Why detection is the right lane, not a consolation prize

The stalled alert found during the spike had been open thirty-five days in a repo
where Dependabot security updates were enabled, unpaused, and correctly
configured for the affected directory — and where the fix required no manifest
change at all, only a lockfile refresh. Every automated signal the butler already
had said this repository was healthy. The failure was not that the butler lacked
a write capability. It was that nothing was looking.

That is the same missing property G7 and G12 addressed from two other angles —
the butler acts, and nothing checks afterwards whether the action worked — except
here the actor is Dependabot rather than the butler.

## Consequences

Rescan-nudging is removed from the roadmap. The plan's claim that it is "cheaper
and higher-value than the trimmer" is withdrawn: it is not cheaper, because it
cannot be built.

The `stalled-alert` finding routes to `executor: 'manual'` like every other
per-repo state finding (`open-vulnerability`, `tier-regression`,
`dependabot-stale`, `stale-butler-pr`), and is off cross-repo PROPOSE by the
ADR-002/ADR-011 lane boundary — a specific unfixed alert in one repo is per-repo
work, not a portfolio statistic.

Detection is pure and deterministic, so it costs no LLM tokens and can run on the
existing 4×/day governance schedule. Its only new API cost is reading the
manifest and lockfile for repos that actually have a stalled alert, which is
bounded by how rare that is.

**What this ADR does not authorise:** opening any pull request in response to a
stalled alert; templating a lockfile-refresh workflow into a target repository
(a real option, deliberately parked, and needing its own ADR because it is a
cross-repo write that grants the target's CI the ability to modify its own
lockfile); acting on an `override` verdict; writing to any manifest or lockfile;
or any change to `computeHealthTier`, which stays untouched exactly as ADR-012
left it.
