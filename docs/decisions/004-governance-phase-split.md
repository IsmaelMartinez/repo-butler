# ADR-004: Governance Phase Split from IDEATE

Date: 2026-05-02
Status: Accepted

## Context

Before PR #165, governance detection (standards-gap, policy-drift, tier-uplift, dependabot-stale) ran inside `runIdeate`, which meant `governance.json` only refreshed on the weekly council run (Mondays 06:00 UTC). The dashboard, the MCP `get_governance_findings` tool, and the manual `governance:apply` workflow all read that file and were therefore stale most of the week.

The Governance Apply workflow specifically suffered from this coupling. An admin would trigger remediation but the underlying findings were up to seven days old, so they could open PRs against problems that had already been fixed in the intervening days. The detection logic itself is pure deterministic JavaScript with no LLM call, so there was no cost reason to keep it gated behind the weekly cadence — it was simply a structural artefact of having grown organically out of the IDEATE phase.

## Decision

Promote governance detection to a first-class GOVERNANCE phase that runs between UPDATE and IDEATE in the main pipeline. Because detection is pure deterministic JavaScript with no LLM cost, the daily pipeline runs it four times per day at no incremental token spend.

`runIdeate` still calls `runGovernance(context)` at the top of its body — the call was deliberately left in place rather than removed. This serves two purposes: it preserves the weekly-ideate workflow's existing `INPUT_PHASE: observe,ideate` shape (no workflow changes required), and it acts as a safety net for any future workflow that runs IDEATE without explicitly listing GOVERNANCE first. The idempotency guard inside `runGovernance` makes the call a no-op when findings were already populated in the same turn (the typical daily-pipeline path), so there is no cost to the redundant call. This keeps a single source of truth for the detection logic and avoids re-running it twice on Mondays.

## Consequences

`governance.json` now reflects current portfolio state on every daily run instead of weekly. The apply workflow can act on fresh data, eliminating the stale-findings failure mode. Weekly-ideate cost is unchanged because governance detection has no LLM call. `runIdeate` retains the `runGovernance` call as a delegation rather than as the orchestration site — the inline detection logic moved to `runGovernance` and `runIdeate` is now a thin caller.

The arrangement is asymmetric: governance is implicit in `weekly-ideate.yml`'s `INPUT_PHASE` rather than explicit, because IDEATE delegates to it internally. This is documented in a comment in `weekly-ideate.yml` so the implicit dependency does not surprise anyone reading the workflow file in isolation.
