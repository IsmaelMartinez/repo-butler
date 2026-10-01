# Plan: making the event and A2A discovery surfaces real

Date: 2026-10-01
Status: PROPOSED — prepared for #427, where the owner chose to keep `docs/asyncapi.yml` and the A2A agent card and to prepare their missing implementation as a future improvement. Nothing here is scheduled; every phase is default-closed and gated as stated.

Rests on [ADR-008](../decisions/008-event-emission.md) (event emission, "implementation gated") and [ADR-003](../decisions/003-interoperability-layer.md) (interoperability layer). Facts below were read from `origin/main` at `079fd9d3` on 2026-09-30; external claims cite their source.

## Where things stand

`docs/asyncapi.yml` declares AsyncAPI 3.0.0 and two channels: `healthTierChanged` (`{repo, previousTier, newTier}`) and `governanceProposalOpened` (`{type, repo, remediation.executor}`), both `send` operations, with a header comment saying there is no live transport. Nothing emits either: `src` contains no `repository_dispatch` call, and no workflow in the owner's repos subscribes to one, which is why ROADMAP parks Phase 9. `src/asyncapi.test.js` only smoke-checks the file's structure.

The spec has drifted. Its own comment says emission needs tier-change detection that does not exist, but `src/tier-change.js` (`detectTierChanges`) shipped and already backs the G7 regression detector and the dashboard. Its finding-type enum lists four types where `schemas/v1/governance-finding.v1.schema.json` has eight, and its executor enum lacks `settings`.

ADR-008 specifies self-dispatch, an `INPUT_EMIT_EVENTS` flag off by default and also gated by dry-run, a dedicated last-emitted state file written with compare-and-swap (which conflicts with `putFile`'s 409 auto-retry in `src/github.js`), and `healthTierChanged` first with `governanceProposalOpened` deferred.

`src/agent-card.js` builds the A2A card that REPORT writes to `reports/.well-known/agent-card.json` (served live from Pages; tests in `src/agent-card.test.js`). Against A2A 1.0.0 (<https://a2a-protocol.org/latest/specification/>, normative proto at <https://raw.githubusercontent.com/a2aproject/A2A/v1.0.0/specification/a2a.proto>) it has four gaps: `stateTransitionHistory` is not a 1.0 capability; `supportedInterfaces` is required and the card's is empty, so it advertises a server nobody can reach; the governance skill text describes four of the eight finding types; and well-known discovery expects the card at the domain root, where Pages returns 404, so only direct configuration finds it. ADR-003 targeted A2A 0.3; the card is a 0.3/1.0 hybrid.

The working agent interface today is `src/mcp.js`: JSON-RPC over stdio, reading the data branch with `git show`, with exactly one mutation (`trigger_refresh`).

## What emitting events would really mean

ADR-008 says subscribers can listen with `on: repository_dispatch` in their own automation. That is not how the event works: a dispatch sent to repo-butler only triggers workflows in repo-butler, from the default branch (<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch>), and as a webhook only a GitHub App with Contents read can subscribe (<https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository_dispatch>). So with self-dispatch the only possible consumers are a workflow inside this repo or an App subscribed to it. Fanning out to the portfolio repos instead would be a cross-repo write, which ADR-008 deliberately avoided and this plan keeps out.

`healthTierChanged` should be emitted from `runGovernance`, not REPORT as ADR-008 says: REPORT returns early on a cache hit keyed on the butler's own snapshot plus the date, so a tier change elsewhere could go unemitted until the next day, while GOVERNANCE runs on all four daily ticks and already builds the current weekly tiers. The emitter reads its state through `store.readJSONChecked` and emits nothing when the state is unreadable (the watchlist's fail-closed rule), drops `ci === null` entries on both sides as the regression detector does, runs `detectTierChanges`, and on first run writes a baseline and emits nothing. The payload keeps the spec shape plus `eventVersion: 1` (4 of GitHub's 10 permitted `client_payload` keys; <https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event>), with event type `repo-butler.health-tier-changed`. Every value is enum-frozen or `REPO_NAME_PATTERN`-checked at the boundary, so no LLM text or free-form string ever enters a payload — the event equivalent of ADR-005's fixed-string rule.

`governanceProposalOpened` stays deferred. It would fire after a successful PR creation in apply and lockfile-update; carrying the PR number would be a spec change.

Constraints that bind both channels: events are built from `portfolio.repos` only, never `privateRepos`, because a dispatched payload becomes `github.event` in a public Actions log — a fourth world-readable sink — and this needs a mutation-verified guard like the governance private-repo test. Emission requires `INPUT_EMIT_EVENTS === 'true'` exactly and not dry-run; with the flag off, behaviour is byte-identical (no state read, no write). Whether the App token needs Contents: write to call `/dispatches` is unverified and is the first thing Phase E2 confirms. No `repository_dispatch`-triggered workflow here may mint the App token or perform a cross-repo write, enforced by a test. `self-test.yml` has no `concurrency:` group, so ADR-008's overlapping-run race is real.

## What a real A2A transport needs

Any A2A transport is a live HTTPS endpoint speaking JSON-RPC 2.0 with the 1.0 method names (`SendMessage`, `GetTask`, …) and an `A2A-Version` header; `SendMessage` may answer with a plain message rather than a task, which suits read-only queries. GitHub Pages is static and cannot answer a POST, so the Pages card can never list a working interface by itself. Four options were weighed:

- **Local HTTP wrapper around `callTool`.** A `node:http` server on 127.0.0.1 serving its own localhost card with a `JSONRPC` interface. "Read-only" is not enough to make it credential-free: `get_open_governance_prs` shells out to `gh pr list` across the portfolio and handles authentication failures, so the wrapper exposes an explicit allow-list of tools that read only the local data-branch checkout (excluding both `trigger_refresh` and `get_open_governance_prs`). With that allow-list it is zero-dependency, needs no credentials, and inherits the staleness envelope. Its value exists only if some A2A-only client exists; anything that speaks MCP gains nothing.
- **Hosted read-only serverless endpoint.** Needs no secret, since everything it serves is already public, and is the only option that makes the Pages card list a real interface. It adds an external account, deploy pipeline, runtime and a public endpoint with abuse and quota exposure.
- **`workflow_dispatch` as the task engine.** Still needs an HTTPS front door holding a token that can dispatch workflows; anonymous exposure puts a write credential behind a public endpoint. Rejected for anything public; locally, `trigger_refresh` already covers it.
- **Discovery-only but honest.** A2A-1.0-valid fields and an explicit, documented deviation for the empty `supportedInterfaces`.

For a zero-dependency, own-portfolio tool the order is: honest discovery now, the local wrapper only once a named A2A client exists, and a hosted endpoint only if #424 decides "reusable Action" or real external demand appears. #424 affects only the hosted option, whether emission can be offered as an Action input (blocked anyway by `action.yml`'s hyphenated-input bug), and per-consumer cards. Phases E0–E3 and A1 do not depend on it.

## Phases

Each phase is one reviewable PR, default-closed, tests first with mutation checks.

**E0 — contract honesty (docs and tests only; small).** Amend ADR-008: correct the subscriber claim, move wiring to GOVERNANCE, record that `tier-change.js` shipped, status "deferred pending a named consumer". Mark `governanceProposalOpened` deferred in the spec, sync its enums to the schema, add `eventVersion`, fix the stale comment; optionally move to AsyncAPI 3.1.0, which is non-breaking (<https://www.asyncapi.com/blog/release-notes-3.1.0>). On the card: drop `stateTransitionHistory`, describe all eight finding types, describe `council-triage` as the persisted council results rather than live deliberation, and state the A2A 1.0 target and the empty-interfaces deviation. Acceptance: a test fails if the spec's enums diverge from the schemas, and the card test asserts capability keys are a subset of A2A 1.0's.

**E1 — pure emit planner (small).** `src/tier-emit.js`: from current weekly tiers and a `readJSONChecked` result, return `{ action: baseline | emit | skip-unreadable, events, nextState }`, applying the `ci === null` filter, name validation and the payload builder. No caller yet. Fixture tests for first run, same-week dedup, orphan pruning, null `ci` on either side, unreadable or unparseable state, out-of-enum values and the private-repo guard.

**E2 — transport behind the flag (medium).** `gh.dispatch(owner, repo, eventType, payload)`; a `putFile` mode that surfaces a 409 instead of retrying (or a compare-and-swap via the Git Data API); wire into `runGovernance` behind the flag and not dry-run; log counts only; confirm the App permission. Acceptance with a fake client: flag off means zero extra calls, dry run means no dispatch and no state write, a 409 means no dispatch, and a dispatch failure is logged and never aborts the governance write.

**E3 — first consumer before go-live (small).** A workflow here on `repository_dispatch: types: [repo-butler.health-tier-changed]` with minimal permissions doing something in-repo only (a job summary, or a comment on one tracking issue), plus a CI test that fails if any dispatch-triggered workflow mints the App token or touches another repo. Going live is a separate reviewed PR setting the flag in `self-test.yml`.

**E4 — `governanceProposalOpened` (deferred; small to medium).** Only if E3's consumer proves useful and findings volume is above zero.

**A1 — local A2A wrapper (gated on a named A2A client; medium).** `src/a2a.js` on loopback, `SendMessage` routed to `callTool` over the data-branch-only allow-list above, A2A error mapping, `A2A-Version` check, its own localhost card, started by hand like `mcp.js`. Before building it, define how each AgentSkill and `SendMessage` payload maps to an allowed tool and arguments. Not every advertised skill maps today: the card's `council-triage` skill promises deliberation, but MCP exposes only `get_council_personas` and `get_watchlist`, and neither runs `reviewProposals` or `triageEvents`. So the card either narrows that skill to the persisted results (the watchlist and personas) or a callable implementation is added; narrowing is the default, since live deliberation needs an LLM key the wrapper must not hold. Tests spin it up on an ephemeral port: card shape, one round trip per mapped skill, `trigger_refresh` and `get_open_governance_prs` unreachable, loopback-only binding, JSON-RPC errors for unknown methods.

**A2 — hosted read-only endpoint (gated on #424 or external demand; large).** Needs its own ADR, since it adds a public surface and an external platform; it would give the Pages card its first real interface.

## What we would not do

Dispatch events into portfolio repos; let a private repo name, LLM text or advisory prose into a payload; wire emission into REPORT; emit a transition scored on `ci: null`; enable emission by default or on the weekly or apply workflows; expose `trigger_refresh` or any mutation over A2A; put a write-capable token behind a public endpoint or use `workflow_dispatch` as an anonymous task engine; try to host A2A on Pages or invent a static binding; add npm dependencies (an A2A SDK or AsyncAPI validator); implement streaming or push notifications; write the card into another repo to fix root-domain discovery.

## Risks and open questions

Emitting into the void is the main risk: E2 without E3 is exactly what ROADMAP parks. Duplicate dispatches re-triggering automation are why the compare-and-swap exists. A2A has already moved incompatibly from 0.3 to 1.0 under this card, and the AsyncAPI test is structural only until E0's enum guard lands. Downward tier moves are already surfaced as `tier-regression` findings, so the event's genuinely new signal is upward moves and push delivery.

Open for the owner: who the first consumer is (an in-repo workflow, a GitHub App, or something outside GitHub — without one, E2 should not go live); at-most-once delivery (claim state, then dispatch; recommended) or at-least-once (dispatch, then write); whether a `concurrency:` group on `self-test.yml` is an acceptable simpler substitute for, or complement to, the `putFile` change; whether to emit both directions or only upward moves; and whether direct-configuration discovery of the subpath card is acceptable permanently.

Rough size: E0–E3 is four small PRs, about two to three days. A1 is one to two days once justified. A2 is a separate project.
