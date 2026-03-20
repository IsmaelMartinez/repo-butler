# ADR-001: Repo Butler and Triage Bot Boundary

Date: 2026-03-20
Status: Accepted

## Context

Two projects analyse GitHub repositories and advise the maintainer: repo-butler (this repo) and github-issue-triage-bot. Both emerged from the same need — reducing the cognitive load of maintaining teams-for-linux and a growing portfolio of repos — but they approach the problem from opposite directions.

The triage bot is reactive and deep. It runs as a Go service on Google Cloud Run, processes GitHub webhooks in real time, maintains a vector store of project documentation via pgvector, and produces per-issue triage analysis with safety-gated output through shadow repos. It has evolved into a "repository strategist" with a synthesis engine that detects issue clusters, ADR drift, and upstream dependency impacts, producing weekly briefings.

Repo-butler is proactive and broad. It runs as a Node.js GitHub Action on a daily cron, gathers portfolio-wide data via the REST API, generates HTML health dashboards deployed to GitHub Pages, and has phases for LLM-powered assessment, roadmap generation, idea generation, and issue proposals. It requires zero infrastructure beyond GitHub Actions and has zero dependencies.

The question is where each capability belongs, what overlaps need resolving, and how the two systems should exchange data.

## Decision

Keep both projects as separate codebases with clear boundaries. Integrate via data exchange (API calls between the two), not code consolidation.

### Repo-butler owns

Portfolio-level observation, HTML report generation for GitHub Pages, snapshot diffing and change detection, the IDEATE/PROPOSE phases (batch idea generation and issue creation), and LLM-powered roadmap rewriting. These are lightweight, stateless operations that fit the "cron job on GitHub Actions" model and don't need a database or real-time processing.

### Triage bot owns

Real-time issue triage via webhooks, vector search with pgvector, the enhancement research agent, the synthesis engine (issue clusters, ADR drift, upstream impact analysis), safety validators, the event journal, auto-ingest of document changes, and the live operational dashboard. These all depend on persistent state, low-latency webhook processing, or database queries.

### Integration points

The OBSERVE phase should POST collected data to the triage bot's `/ingest` endpoint (authenticated via `INGEST_SECRET`). This enriches the event journal with portfolio-wide data that the triage bot currently scrapes separately, eliminating duplicate API calls.

The ASSESS and IDEATE phases should read the triage bot's synthesis findings via the `/report/trends` endpoint. If the synthesis engine has flagged an issue cluster or ADR drift, repo-butler should incorporate that into its assessment rather than independently rediscovering the same pattern.

Per-repo HTML reports should link to the triage bot's live dashboard (`/dashboard`) for repos where the bot is installed, providing a "live view" alongside the static report.

### What not to do

Don't merge the codebases. Go on Cloud Run and Node.js on GitHub Actions are different execution models for good reasons. Don't move report generation to the triage bot — it would add unnecessary complexity and require GitHub Pages deployment from a server. Don't move the triage pipeline to repo-butler — it needs webhooks and a database. Don't unify the dashboards — the live operational dashboard and the static portfolio health reports serve different audiences.

## Consequences

The two projects remain independently deployable and testable. Repo-butler stays zero-dependency and infrastructure-free. The triage bot stays focused on deep per-repo intelligence. Data flows from repo-butler to the triage bot (OBSERVE → /ingest) and from the triage bot to repo-butler (/report/trends → ASSESS/IDEATE). The integration is optional — both projects work standalone without the other.
