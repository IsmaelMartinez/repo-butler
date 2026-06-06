# ADR-005: Cross-Repo Write Trust Model

Date: 2026-05-02
Status: Accepted

Amended: 2026-06-06 — Gate 1 (workflow_dispatch-only) is relaxed per finding-class for tools on the `apply-schedule` allow-list, per [ADR-007](007-agents-and-execution.md) stage 4. The relaxation is opt-in (default-closed: the allow-list is empty by default), reversible (removing a tool's entry reverts that class to dispatch-only), and leans on gate 3 (`require_approval`) as the always-on master switch. The lost dispatch-time accountability moment is replaced by an explicit per-run notification (a workflow run summary). Gates 2, 4, and 5 and the blast-radius cap are unchanged, so a scheduled run's worst case is bounded exactly as a dispatched run's. See the Amendment section below.

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

The relaxation is contained. The same `applyGovernanceFindings` entry point serves both paths; the scheduled path simply filters the actionable set down to allow-listed classes before the existing gates run, so manual dispatch is byte-identical to before. Gate 3 (`require_approval`) stays the always-on master switch and gate it on first. Gates 2 (dry-run fail-closed), 4 (per-run cap and batching), and 5 (repo-name validation and dedup) are untouched, so a scheduled run can open no more PRs, and no less safely, than a dispatched one. The accountability moment a deliberate dispatch provided — a human present with the trigger, time, and inputs visible in the Actions UI — is replaced by a per-run notification: the scheduled workflow writes a run summary recording what it did. The scheduled workflow additionally ships dry-run by default, so promoting a class onto the allow-list still opens nothing until the soak graduates to live in a separate reviewed change.
