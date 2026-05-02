# ADR-004: Governance Phase Split from IDEATE

Date: 2026-05-02
Status: Accepted

## Context

Before PR #165, governance detection (standards-gap, policy-drift, tier-uplift, dependabot-stale) ran inside `runIdeate`, which meant `governance.json` only refreshed on the weekly council run (Mondays 06:00 UTC). The dashboard, the MCP `get_governance_findings` tool, and the manual `governance:apply` workflow all read that file and were therefore stale most of the week.

The Governance Apply workflow specifically suffered from this coupling. An admin would trigger remediation but the underlying findings were up to seven days old, so they could open PRs against problems that had already been fixed in the intervening days. The detection logic itself is pure deterministic JavaScript with no LLM call, so there was no cost reason to keep it gated behind the weekly cadence — it was simply a structural artefact of having grown organically out of the IDEATE phase.

## Decision

Split governance detection into a first-class GOVERNANCE phase that runs between UPDATE and IDEATE in the main pipeline. Because detection is pure deterministic JavaScript with no LLM cost, the daily pipeline runs it four times per day at no incremental token spend.

The weekly IDEATE run delegates to the same `runGovernance` wrapper via an idempotency guard. If findings were populated by an earlier phase in the same turn, detection is skipped and the council reads the fresh findings the daily pipeline produced. This keeps a single source of truth for the detection logic and avoids re-running it twice on Mondays.

## Consequences

`governance.json` now reflects current portfolio state on every daily run instead of weekly. The apply workflow can act on fresh data, eliminating the stale-findings failure mode. Weekly-ideate cost is unchanged because governance detection has no LLM call, and `runIdeate` becomes simpler now that it is no longer responsible for orchestrating detection.

The arrangement is asymmetric: governance is implicit in `weekly-ideate.yml`'s `INPUT_PHASE` rather than explicit, because IDEATE delegates to it internally. This is documented in a comment in `weekly-ideate.yml` so the implicit dependency does not surprise anyone reading the workflow file in isolation.
