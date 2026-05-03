# ADR-005: Cross-Repo Write Trust Model

Date: 2026-05-02
Status: Accepted

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
