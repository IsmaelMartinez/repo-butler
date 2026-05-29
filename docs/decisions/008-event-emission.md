# ADR-008: Live Event Emission (Phase 9 transport)

Date: 2026-05-30

Status: Accepted (design); implementation gated behind this record

## Context

The AsyncAPI 3.0 spec (`docs/asyncapi.yml`) and the A2A agent card are both discovery-only: they describe two event channels — `healthTierChanged` and `governanceProposalOpened`, transported as GitHub `repository_dispatch` events — without anything actually emitting them. Phase 9 calls for making that transport live, and the roadmap records it as blocked on "tier-change detection that does not exist yet."

The detection mechanism is the small part. The decisions that actually gate the work are where the event is dispatched, how emission is turned on safely, and how the payload contract is versioned. `repository_dispatch` is a new outbound write and a new trust surface (it can trigger downstream automation in subscribers), so per ADR-005 and ADR-007 those decisions are settled here before any producer code is written, rather than discovered during implementation.

## Decision

The dispatch topology is self-dispatch: the butler emits `repository_dispatch` to its own repository, not to the portfolio repos it governs. This keeps the channels repo-scoped, reuses the workflow's existing token with no new cross-repo scope, and — the load-bearing consequence — means emission is not a cross-repo write to any portfolio repo, so it does not expand ADR-005's five-gate write surface at all. Subscribers react by listening for the event in their own automation (`on: repository_dispatch`) or by watching the butler repository; the butler does not reach into their repos to deliver it.

Emission is opt-in and fails silent. It is enabled only when an explicit `INPUT_EMIT_EVENTS` flag is set (default off) and is additionally gated by the existing `dryRun`, mirroring `apply.js`'s silent-by-default posture. The first run with emission enabled is a baseline-only no-op: it records the current per-repo tiers as the baseline and emits nothing, so turning the feature on can never fire a flood of events from a one-time comparison against stale history.

Tier-change detection diffs each repo's computed tier in the current run against the previous weekly portfolio snapshot. Because `writePortfolioWeekly` overwrites the current ISO-week file up to four times a day, the prior-tier lookup must select the newest snapshot whose week key is not the current week — otherwise the diff compares the run against itself and silently never fires. That selection rule is the one correctness-critical piece and must be covered by a fixture test.

The payload contract gets an explicit event-schema version tag, and the tier values are frozen to the `health-tier.v1` enum (`gold`, `silver`, `bronze`, `none`). The inline `previousTier`/`newTier` transition view in `docs/asyncapi.yml` is reconciled against `health-tier.v1.schema.json` at the same time; dedicated event schemas that `$ref` the shared enums are a follow-on, not a blocker. The version tag is what lets the inline event shape evolve later without breaking subscribers that already depend on it.

Scope is the `healthTierChanged` channel first. The `governanceProposalOpened` channel — emitted from `apply.js` when a cross-repo PR is opened — is deferred to a later increment; it adds surface to the manual-dispatch and dry-run machinery for little near-term signal while the portfolio sits at zero findings.

## Consequences

Implementation can proceed as small, independently reviewable PRs: the pure diff logic (tier diffing plus the newest-non-current snapshot selection) is fully unit-testable with no GitHub calls, and only then does a `dispatch()` method on the GitHub client and the report-phase wiring land behind the default-off flag. Until the flag is explicitly enabled the behaviour is byte-identical to today.

Because the topology is self-dispatch, the flag defaults off, and `dryRun` gates it, this introduces no new cross-repo trust surface and no behaviour change for any portfolio repo — which is what keeps it outside the ADR-005 write model rather than another consumer of it. The contract version tag accepts a small amount of up-front ceremony in exchange for being able to change the event shape after subscribers exist.
