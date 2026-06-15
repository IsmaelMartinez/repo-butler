# ADR-005: Cross-Repo Write Trust Model

Date: 2026-05-02
Status: Accepted

Amended: 2026-06-06 — Gate 1 (workflow_dispatch-only) is relaxed per finding-class for tools on the `apply-schedule` allow-list, per [ADR-007](007-agents-and-execution.md) stage 4. The relaxation is opt-in (default-closed: the allow-list is empty by default), reversible (removing a tool's entry reverts that class to dispatch-only), and leans on gate 3 (`require_approval`) as the always-on master switch. The lost dispatch-time accountability moment is replaced by an explicit per-run notification (a workflow run summary). Gates 2, 4, and 5 and the blast-radius cap are unchanged, so a scheduled run's worst case is bounded exactly as a dispatched run's. See the Amendment section below.

Amended: 2026-06-15 — [ADR-007](007-agents-and-execution.md) stage 5 adds selective auto-merge of the butler's own templated apply PRs, which removes the human *review* gate (a larger trust delta than stage 4's dispatch relaxation). It is governed per finding-class by an `apply-automerge` allow-list (default empty, never global), bounded to the deterministic template tools, and layers three additional preconditions on top of the five gates: required CI green, a squash merge (single clean revert commit), and the merge SHA recorded for audit/rollback. This amendment also corrects the kill-switch wording carried in ADR-007's stage-5 design: `require_approval=true` is the master operating switch the whole apply system needs (false makes every apply action refuse, auto-merge included), so it cannot be the auto-merge kill switch. The auto-merge-specific kill switches are emptying `apply-automerge` and disabling the scheduled workflow; setting `require_approval=false` is the broader switch that halts all apply activity. See the second Amendment section below.

## Context

The Governance Apply workflow opens PRs on every active portfolio repo via a GitHub App token. A bug in the filter logic, a malicious repo name, or an accidental dispatch with the wrong inputs could blast PRs across 13+ repos in seconds. The blast radius is high enough that defense-in-depth was non-negotiable — no single check is sufficient when the worst-case outcome is dozens of unwanted PRs landing across the entire portfolio simultaneously.

Single-repo write tooling can rely on the assumption that a mistake affects one repo and is easy to revert. Cross-repo write tooling cannot. Each layer of defence has to assume the previous layer might have failed silently.

## Decision

Layer five independent gates, each defending against a different failure mode.

The first gate is workflow trigger restriction: the apply workflow is `workflow_dispatch` only and never runs on cron. Cron-triggered remediation is the canonical "ran while nobody was watching" failure mode and is excluded by construction.

The second gate is dry-run fail-closed semantics. Any value other than the literal string `'false'` is treated as dry-run, including empty strings, undefined, and even `'true'`. The default behaviour when the input is malformed or missing is to take no destructive action.

The third gate is a `require_approval` config setting that refuses to run when not set to `true`. This protects against the workflow being dispatched against a portfolio whose owner has not explicitly opted into automated remediation.

The fourth gate is a hard cap of 5 PRs per run, configurable via input but always enforced. PRs are batched 3 concurrent at a time to stay under GitHub's 30-req/min secondary rate limit, which adds incidental protection against runaway dispatch loops.

The fifth gate is input sanitisation: repo names are validated against the strict regex `^[a-zA-Z0-9._-]+$` before any template interpolation, plus deduplication via an existing-PR check on the head branch so re-dispatches do not pile up duplicate PRs on the same problem.

## Consequences

Each layer defends against a different failure mode — a cron mistake, an env var typo, config drift in a downstream consumer, a filter bug, a malicious repo name, or a repeat dispatch by an impatient operator. No single failure can cause unbounded damage because a second independent check stands between any one fault and the GitHub API.

The cost is operational friction: running apply requires explicit dispatch with explicit `dry-run=false`, plus prior configuration of `require_approval`. This friction is a feature, not a bug. The workflow is designed for the maintainer to run deliberately when they have time to monitor the resulting PRs, not for hands-off automated remediation.

## Amendment (2026-06-06): per-class relaxation of gate 1

Gate 1 originally excluded cron entirely: the apply workflow was `workflow_dispatch` only. ADR-007 stage 4 introduces a scheduled apply path that necessarily runs without a human at dispatch, which is the one failure mode gate 1 guarded against. Rather than dropping gate 1 wholesale, it is relaxed per finding-class through a new `apply-schedule` allow-list in `roadmap.yml`: a finding class runs on the scheduled path only when explicitly promoted with a `tool-name: true` entry, and removing the entry reverts it to dispatch-only. The allow-list is empty by default, so the scheduled workflow opens nothing until a class is deliberately added.

The relaxation is contained. The same `applyGovernanceFindings` entry point serves both paths; the scheduled path simply filters the actionable set down to allow-listed classes before the existing gates run, so manual dispatch is byte-identical to before. Gate 3 (`require_approval`) stays the always-on master switch and is checked first. Gates 2 (dry-run fail-closed), 4 (per-run cap and batching), and 5 (repo-name validation and dedup) are untouched, so a scheduled run can open no more PRs, and no less safely, than a dispatched one. The accountability moment a deliberate dispatch provided — a human present with the trigger, time, and inputs visible in the Actions UI — is replaced by a per-run notification: the scheduled workflow writes a run summary recording what it did. The scheduled workflow additionally ships dry-run by default, so promoting a class onto the allow-list still opens nothing until the soak graduates to live in a separate reviewed change.

## Amendment (2026-06-15): selective auto-merge (gate 3 review-step relaxation)

ADR-007 stage 5 lets the butler squash-merge its own templated `governance-apply` PRs without a human at the merge — the one deliberately-sanctioned autonomous merge in the project, never for human-authored PRs and never global. (This is distinct from the maintainer's standing "never merge autonomously" rule, which governs the assistant's handling of the maintainer's own PRs and is untouched.) It removes the human *review* step that every prior stage preserved, so it carries the largest trust delta of any stage and is fenced accordingly.

Eligibility is opt-in per finding-class via an `apply-automerge` allow-list in `roadmap.yml` (default empty, never global) and is bounded twice over: a class auto-merges only if it is both on the allow-list and a deterministic template tool (a static-file generator). Settings writes (`code-review-bot`), the `dependabot-rebase` nudge, and every policy-drift, tier-uplift, agent, or manual finding are ineligible by construction. On top of the five gates, three stage-5 preconditions hold for each merge: the PR's required CI must be verifiably green (read via the check-runs and combined-status APIs; any pending, failed, or absent signal blocks the merge), the merge is a squash so a revert is one clean commit, and the resulting merge SHA is recorded in the apply result for audit and rollback. Merging happens in a reconcile pass on a later scheduled run — never at PR-open time, when no CI result exists yet — so "CI green" is an explicit code-verified precondition rather than a per-repo "Allow auto-merge" setting, which keeps the GitHub client REST-only (the merge uses `PUT /pulls/{n}/merge` with the head SHA as a guard).

The kill switches: empty `apply-automerge` (per-class, the primary control), or set `require_approval=false` (halts all apply activity, auto-merge included), or disable the scheduled workflow (stops the runtime). Note the correction to ADR-007's stage-5 design wording: that text framed restoring `require_approval` to true as the kill switch, but `require_approval=true` is the master operating switch the whole apply system requires — false makes every apply action refuse, so it cannot be the enable state for auto-merge. `require_approval=true` is therefore required for auto-merge to run, exactly as for opening PRs, and the empty allow-list is what keeps it default-closed.
