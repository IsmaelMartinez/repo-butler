# Interoperability Layer Design

Date: 2026-03-29
Status: Draft

## Problem

Repo-butler produces rich portfolio health data that only its own HTML reports consume. The triage bot integration is ad-hoc (untyped `/ingest` and `/report/trends` endpoints). No AI agent can query repo-butler's data without reading its source code. No human or machine can validate the data shape without running the pipeline. The project needs a formal interoperability layer that makes its data consumable by AI agents, humans, and automated tools.

## Goals

Make repo-butler's data structures, capabilities, and integration points formally described and machine-queryable. Support three consumer categories: AI coding assistants (Claude Code, Copilot, Cursor), autonomous agents (triage bot, governance engines, CI tools), and human developers configuring or extending the system. Do this without adding npm dependencies.

## Non-Goals

Building a REST API server (repo-butler is a GitHub Action, not a service). Replacing the triage bot integration with A2A immediately (formalise the contract first). Supporting real-time streaming (the daily cron model is the right constraint).

## Design Decisions from Spikes

Three spikes validated the approach and surfaced key findings.

The schema extraction spike produced five draft schemas from live data. Three (`Config`, `PortfolioRepo`, `PortfolioObservation`) are clean enough to publish. `RepositorySnapshot` needs manual curation because the live snapshot has empty arrays (repo-butler has zero open issues/releases) and three null-only fields (`dependabot_alerts`, `time_to_close_median`, `community_profile` on failure). Naming is consistently snake_case throughout snapshots.

The skill spike produced a ~1,950-word skill file that answers test questions about health tiers, Dependabot tracking, and the butler-vs-triage-bot boundary. The main gap is the undocumented field-name translation between snapshot data (snake_case: `community_profile.health_percentage`) and the health tier function input (camelCase: `communityHealth`). This mapping lives inline in `report.js:fetchPortfolioDetails()` and needs to be formalised.

The MCP server spike produced a 367-line zero-dependency server that handles the full JSON-RPC lifecycle over stdio. The protocol is simple enough that no npm packages are needed. One data gap: portfolio-weekly snapshots only store three fields per repo (`open_issues`, `commits_6mo`, `stars`), not the six fields needed for `computeHealthTier`. A production MCP server needs richer stored portfolio data or live API calls at query time.

## Architecture

The interoperability layer has four phases, each building on the previous. Each phase is independently shippable and valuable.

### Phase 1: Data Contracts + AI Skill

Formalise the data model as JSON Schema 2020-12 and create a Claude Code skill that teaches AI agents how to work with repo-butler.

**JSON Schemas** live in `schemas/v1/` at the repo root. Six schemas:

`repository-snapshot.v1.schema.json` describes the output of `observe()`. Curated from the spike's draft with manually added array item schemas (issues, PRs, releases, milestones) and non-null types for fields that are only null in the current live data. The `$id` uses `https://github.com/IsmaelMartinez/repo-butler/schemas/v1/repository-snapshot`.

`portfolio-observation.v1.schema.json` describes the output of `observePortfolio()` including the classification buckets.

`portfolio-details.v1.schema.json` describes the enriched per-repo object produced by `fetchPortfolioDetails()` in `report.js`. This is the schema that formalises the snake_case-to-camelCase mapping — it documents the camelCase field names that `computeHealthTier` expects (`communityHealth`, `vulns`, `ciPassRate`, `license`, `ci`, `commits`, `open_issues`, `released_at`, `pushed_at`). This schema didn't exist implicitly before; it was an undocumented inline object. Formalising it means any consumer can compute health tiers from portfolio data without reading `report.js`. Phase 1 only documents the existing shape — no code changes to `fetchPortfolioDetails()` are needed. If the shape drifts from the schema, the CI test catches it.

`weekly-trend.v1.schema.json` describes the weekly portfolio snapshots stored on the data branch.

`config.v1.schema.json` describes `.github/roadmap.yml`. This enables AI agents to generate valid configs and editors to provide autocomplete.

`health-tier.v1.schema.json` describes the output of `computeHealthTier()` — the tier name, the pass/fail checklist, and what's needed for the next tier.

**Claude Code skill** lives in the repo as `docs/skill.md` (or installed as a Claude Code skill). It references the schemas by path and covers the six-phase pipeline, the data model (by `$ref` to schemas rather than inline), the config format, health tiers, the governance model, integration points, and the butler-vs-triage-bot decision framework. Target length: ~2,000 words. The spike's draft is the starting point, with the evaluation's gaps addressed (enriched object shape, safety validator enumeration, store interface).

**Validation in CI.** Add a test in `src/schema.test.js` that performs structural assertions against the schemas — verifying that `observe()` output has every required key listed in the schema, with matching types. This is not full JSON Schema validation (which would require a dependency like `ajv`), but a lightweight shape-check that catches drift. The test reads the schema files and asserts the snapshot structure matches. Zero dependencies maintained.

**Enriched portfolio snapshots.** To close the data gap found in the MCP spike, extend the weekly portfolio snapshots to include the six fields needed for health tier computation (`license`, `communityHealth`, `ciPassRate`, `vulns`, `ci`, `released_at`). This is a change to `store.js` and `report.js` — the weekly snapshot writer already runs during the REPORT phase when all enriched data is available. The `portfolio-details.v1.schema.json` describes this enriched shape.

### Phase 2: MCP Server

A zero-dependency MCP server that exposes repo-butler's data as queryable resources and tools.

**Entry point:** `src/mcp.js`, runnable as `node src/mcp.js`. Communicates via stdio (JSON-RPC 2.0 over newline-delimited JSON). The spike's 367-line prototype is the starting point.

**Resources:**
- `repo-butler://snapshot/latest` — the full latest snapshot JSON
- `repo-butler://portfolio/health` — portfolio health summary with tier per repo
- `repo-butler://portfolio/campaigns` — campaign compliance status
- `repo-butler://trends/{repo}` — weekly trend data for a specific repo

**Tools:**
- `get_health_tier(repo)` — returns tier, checklist, and what's needed for next tier
- `get_campaign_status()` — returns compliance percentages per campaign
- `query_portfolio(filter)` — filter repos by tier, language, activity level
- `get_snapshot_diff()` — diff current vs previous snapshot (what changed since last run)

**Registration:** Users add the server with `claude mcp add repo-butler node src/mcp.js` (for Claude Code) or configure it in `claude_desktop_config.json` for Claude Desktop. Document this in the README.

**Schema validation.** Tool inputs and outputs reference the JSON Schemas from Phase 1. The `tools/list` response includes `inputSchema` for each tool, derived from the schema files.

### Phase 3: A2A Agent Card + Triage Bot Contract

Publish an A2A Agent Card that advertises repo-butler's capabilities for agent-to-agent discovery.

**Agent Card** at `a2a/agent-card.json`, following the A2A v0.3 spec:

```json
{
  "name": "repo-butler",
  "description": "Portfolio health observatory for GitHub repositories",
  "url": "https://github.com/IsmaelMartinez/repo-butler",
  "version": "1.0.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "portfolio-health",
      "name": "Portfolio Health Assessment",
      "description": "Observe and assess health of all repos in a GitHub owner's portfolio",
      "inputModes": ["application/json"],
      "outputModes": ["application/json"]
    },
    {
      "id": "health-tier",
      "name": "Health Tier Classification",
      "description": "Classify a repository as Gold/Silver/Bronze based on health criteria",
      "inputModes": ["application/json"],
      "outputModes": ["application/json"]
    },
    {
      "id": "governance-proposals",
      "name": "Portfolio Governance Proposals",
      "description": "Generate standards propagation and policy drift proposals across a portfolio",
      "inputModes": ["application/json"],
      "outputModes": ["application/json"]
    }
  ],
  "authentication": {
    "schemes": ["apiKey"],
    "credentials": "GitHub personal access token or GITHUB_TOKEN"
  }
}
```

**Triage bot contract formalisation.** Replace the ad-hoc `/ingest` and `/report/trends` integration with a formally described contract. Define the event schema for `butler_observation` events (already partially structured in `snapshotToEvents`). Define the trends response schema. Both reference the JSON Schemas from Phase 1. This doesn't change the HTTP endpoints — it adds schema validation and documentation to what already exists.

**Security prerequisites.** Before enabling cross-agent communication, address the six security items from the Phase 1 architecture review: bot URL validation against env var, ecosystem detection allowlist, PR deduplication, URL allowlist splitting in safety.js, separate cross-repo PAT, contributor name sanitisation.

### Phase 4: AsyncAPI for Events

Define the webhook/event contract for tools that want to react to health changes.

**AsyncAPI 3.0 spec** at `asyncapi/repo-butler.asyncapi.yaml` describing two channels:

`health-change` — published when a repo's health tier changes between runs. Payload includes the repo name, previous tier, new tier, and the checklist diff.

`governance-proposal` — published when IDEATE generates a governance proposal. Payload includes the proposal type (standards propagation, policy drift, compliance campaign), affected repos, and the structured spec.

These events don't require a message broker — they're GitHub webhook payloads or repository dispatch events that downstream Actions can subscribe to. The AsyncAPI spec documents the contract; the implementation uses `repository_dispatch` or workflow outputs.

## File Structure

```
schemas/
  v1/
    repository-snapshot.v1.schema.json
    portfolio-observation.v1.schema.json
    portfolio-details.v1.schema.json
    weekly-trend.v1.schema.json
    config.v1.schema.json
    health-tier.v1.schema.json
docs/
  skill.md                    # Claude Code skill
a2a/
  agent-card.json             # A2A Agent Card (Phase 3)
asyncapi/
  repo-butler.asyncapi.yaml   # AsyncAPI spec (Phase 4)
src/
  mcp.js                      # MCP server (Phase 2)
  schema.test.js              # Schema validation tests (Phase 1)
```

## Execution Order

Phase 1 is the foundation — schemas and skill. Everything else references them. Phase 2 (MCP) makes the data machine-queryable. Phase 3 (A2A + triage bot contract) enables agent discovery and formalises the existing integration. Phase 4 (AsyncAPI) adds event-driven consumers. Each phase is a separate PR with its own tests.

## What This Enables

After all four phases, repo-butler's data is consumable by any AI agent (via MCP), discoverable by any A2A-compatible agent (via Agent Card), validatable by any JSON Schema tool (via schemas), understandable by any AI coding assistant (via the skill), and subscribable by any event-driven tool (via AsyncAPI). The zero-dependency constraint is maintained throughout — the MCP server uses Node built-ins, the schemas are static JSON files, and the A2A Agent Card is a JSON document.

The triage bot integration becomes a formally described contract rather than ad-hoc HTTP calls. New consumers can integrate without reading source code. The skill means an AI agent can reason about the portfolio governance model and help maintain it. The schemas mean data producers and consumers can validate compatibility at CI time rather than discovering mismatches at runtime.
