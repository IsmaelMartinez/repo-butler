# ADR-003: Interoperability Layer — Standards and Phasing

Date: 2026-03-29
Status: Accepted

## Context

Repo-butler produces structured health data about a portfolio of GitHub repositories, but that data was only consumable through its own HTML reports. The triage bot integration used ad-hoc, untyped HTTP endpoints. No AI agent or external tool could query the butler's data without reading source code. As the project gains external consumers (via `uses: IsmaelMartinez/repo-butler@v1`) and the triage bot integration matures, a formal interoperability layer became necessary.

Three exploratory spikes validated the approach before committing to a design:

A schema extraction spike introspected live snapshot data from the `repo-butler-data` branch and generated draft JSON Schemas. It confirmed that the snapshot structure uses consistent snake_case naming (no contamination), but revealed that three fields are null-only in live data (`dependabot_alerts`, `time_to_close_median`, `community_profile` on failure) and array item schemas were empty because the repo has zero open issues and releases. These needed manual curation from source code rather than pure data inference.

A Claude Code skill spike produced a ~1,950-word skill file and self-evaluation. The skill answered test questions about health tiers, Dependabot tracking, and the butler-vs-triage-bot boundary. The evaluation revealed a critical undocumented interface: `computeHealthTier()` expects camelCase field names (`communityHealth`, `vulns`, `ciPassRate`) but the raw snapshot uses snake_case (`community_profile.health_percentage`, `dependabot_alerts`). The translation happens inline in `fetchPortfolioDetails()` with no formal schema. Any external consumer hitting this would be confused.

An MCP server spike produced a 367-line zero-dependency server handling the full JSON-RPC 2.0 lifecycle over stdio. It proved that MCP is feasible within the project's zero-dependency constraint — Node's built-in `readline` and `process.stdout` handle the protocol entirely. The spike revealed a data gap: weekly portfolio snapshots stored only three fields per repo (`open_issues`, `commits_6mo`, `stars`), insufficient for health tier computation which needs six more fields.

## Decision

Adopt a four-phase interoperability layer using established open standards, ordered by immediate value:

Phase 1 (Data Contracts + AI Skill) uses JSON Schema 2020-12 for data structure definitions and a Claude Code skill file for AI agent consumption. Six schemas define the snapshot, portfolio, enriched details, weekly trends, config, and health tier output. A structural validation test in CI ensures schemas stay in sync with code. Weekly portfolio snapshots are enriched with the fields needed for health tier computation. This phase was implemented and verified: 197 tests pass, schemas validate against live data, the skill correctly references the split module structure.

Phase 2 (MCP Server) will wrap the schemas into a queryable MCP server at `src/mcp.js`. The spike proved the protocol fits within the zero-dependency constraint at ~367 lines. Resources expose snapshot and portfolio data; tools expose health tier queries and campaign status.

Phase 3 (A2A Agent Card + Triage Bot Contract) will publish capability discovery metadata following the A2A v0.3 spec and formalise the triage bot's `/ingest` and `/report/trends` endpoints with typed schemas. The security prerequisites from the Phase 1 architecture review (bot URL validation, ecosystem allowlists, PR deduplication, URL allowlist splitting, GitHub App for cross-repo auth, contributor name sanitisation) must be addressed before enabling cross-agent communication.

Phase 4 (AsyncAPI Events) will define event contracts for health-change and governance-proposal notifications, implemented via GitHub `repository_dispatch` rather than a message broker.

### Why these standards

MCP was chosen as the primary machine interface because it has the broadest adoption among AI agent platforms (Claude, GPT, Gemini, Cursor, VS Code) and the spike proved it works within the zero-dependency constraint. A2A was chosen for agent-to-agent discovery because it complements MCP (Google explicitly positions them as complementary) and its Agent Card format provides capability advertising that MCP lacks. JSON Schema was chosen as the data contract format because it's embedded in both MCP tool definitions and OpenAPI specs, making it the natural foundation layer. AsyncAPI was chosen for event contracts because it's the Linux Foundation standard for event-driven architectures and maps cleanly to GitHub's `repository_dispatch` mechanism.

CACAO (security playbook orchestration) was evaluated and deferred — its focus on incident response automation doesn't match the portfolio governance use case today, though it could become relevant if the governance engine evolves to execute automated remediation.

### Why this ordering

Phase 1 delivers immediate value to the most common consumer (AI coding assistants working on the repo) and creates the foundation that all subsequent phases reference. Phase 2 makes the data machine-queryable without human intervention. Phase 3 adds discovery and formalises the existing triage bot integration. Phase 4 adds event-driven consumers, which only matter once there are enough consumers to justify push-based notification.

## Consequences

All data structures are now formally defined. The `portfolio-details` schema documents the previously undocumented camelCase mapping that `computeHealthTier` depends on — any consumer can now compute health tiers without reading `report-portfolio.js`. The enriched weekly snapshots store enough data for tier computation across the portfolio, closing the data gap that the MCP spike revealed.

The zero-dependency constraint is maintained throughout. The MCP server spike proved that JSON-RPC over stdio needs only Node built-ins. The schemas are static JSON files. The A2A Agent Card is a JSON document. No phase requires npm packages.

The phasing means each layer can be shipped, tested, and validated independently. If MCP adoption proves insufficient, the schemas and skill still provide value. If A2A doesn't gain traction, the MCP server still works. Each phase has its own PR with tests.
