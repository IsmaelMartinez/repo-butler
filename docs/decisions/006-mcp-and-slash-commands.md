# ADR-006: MCP and Slash Command Automation Strategy

Date: 2026-05-02
Status: Accepted

## Context

The butler is operated by a single maintainer (Ismael) across 13+ portfolio repos. Two paths existed for user-facing automation: build a TUI or web admin UI, or expose data via MCP and wrap actions as Claude Code slash commands. The latter dogfoods the same AI-agent ecosystem the butler targets and inherits Claude Code's session model — including history, permission prompts, and tool gating — for free.

Building a bespoke admin surface would have meant designing authentication, session handling, and a UI framework choice, all for a tool that ultimately exists to feed AI agents. The MCP-plus-slash-commands path treats the AI agent harness as the user interface and reuses the infrastructure already present on the maintainer's workstation.

## Decision

Expose all read paths via MCP — currently nine tools (`get_health_tier`, `query_portfolio`, `get_governance_findings`, `get_campaign_status`, `get_snapshot_diff`, `get_monitor_events`, `get_watchlist`, `get_council_personas`, `trigger_refresh`) with three more planned — and wrap routine actions as slash commands installed under `~/.claude/skills/`. The current set includes `butler-briefing` and `butler-debrief`, with `butler-apply` and `butler-weekly-review` planned.

The MCP server reads from the `repo-butler-data` branch via `git show` so queries cost no GitHub API budget. `trigger_refresh` is the one mutation tool and dispatches the workflow via the `gh` CLI, keeping the mutation surface intentionally narrow.

## Consequences

The butler ships with a usable AI-agent surface from day one. Other portfolio maintainers adopting the butler get the same automation by adding the MCP server to their Claude Code config — a one-line install. There is no admin UI to maintain, no auth layer to secure, and no session state to manage outside of what Claude Code already provides.

The downside is a hard dependency on Claude Code as the user surface. Non-Claude users would need to wrap the MCP server themselves or use the dashboard. We accept this trade — the dashboard remains the universal read interface for anyone who does not run Claude Code, and the MCP server is a standard JSON-RPC protocol that any sufficiently motivated consumer can drive directly.
