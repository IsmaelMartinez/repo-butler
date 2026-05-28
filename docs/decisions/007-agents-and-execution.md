# ADR-007: Agents and Execution

Date: 2026-05-28

Status: Accepted

## Context

The current execution path relies on a butler that detects governance findings and triggers `apply.js` to write static templated config files via the GitHub Contents API. This process is strictly manual and gated by the five gates of [ADR-005](005-cross-repo-write-trust-model.md), while the operator interface is limited to the MCP `trigger_refresh` tool and the read tools and slash commands committed to in [ADR-006](006-mcp-and-slash-commands.md).

The maintainer aims to evolve the execution layer toward full automation because many findings, such as repo-tailored CONTRIBUTING.md files, CI fixes, or tier uplifts requiring code changes, cannot be expressed as static files and need agent reasoning. The open questions concern where the agent runs and how to avoid discarding early work when transitioning from a local runtime to a hosted one.

## Decision

Split execution into two tracks by the nature of the finding, and evolve the agent track local-first through a portable contract.

Track A covers templatable findings — those expressible as a static file the butler can write deterministically, such as a `dependabot.yml` or enabling a scanner. This track is already cloud-capable through `apply.js`. It reaches full automation not by adding an agent but by relaxing ADR-005's gates incrementally and per finding-class: manual dispatch graduates to a schedule, dry-run graduates to live, and `require_approval` is retained as the master switch. This builds on ADR-005 rather than overriding it. The five gates remain; what changes over time is which finding classes are promoted onto the lower-friction path, and every promotion is reversible.

Track B covers reasoning findings — those needing judgement that a static template cannot encode. This track is agent-driven and evolves in five stages:

1. Portable contract. The butler emits a structured remediation plan per finding: an `executor` hint (`template` | `agent` | `manual`) plus a change spec (target files, intent, rationale, acceptance criteria). This is deterministic, costs no LLM, and is persisted alongside `governance.json`. It is the contract both runtimes consume.
2. Local hardening. The `repo-butler-apply` skill consumes the plan; for `agent` findings it makes the change in a local checkout and opens a PR for human review. This stays zero-infrastructure and human-in-the-loop, consistent with ADR-006, and is where the agent's prompts and judgement are hardened.
3. Relax Track A, in parallel and independent of Track B, as finding classes earn trust.
4. Lift to hosted. The hardened stage-2 logic moves into a hosted coding agent (Claude or Copilot in Actions) consuming the same remediation-plan contract, behind the ADR-005 gates, with PR review retained.
5. Selective auto-merge. The destination is auto-merge for the highest-trust, lowest-risk finding classes only — opt-in per class, never global.

The load-bearing principle is that the decision logic (the remediation plan) is decoupled from the runtime (local skill versus hosted agent). This is what makes local-first a hardening stage rather than throwaway work: the same contract drives both runtimes, so logic proven locally lifts into the cloud without a rewrite.

## Consequences

Local-first architecture maintains human oversight while agent judgment remains unproven, aligning with the never-auto-merge rule and ADR-006 without requiring new infrastructure. The portable remediation-plan contract decouples decision logic from the runtime, allowing logic hardened locally to transfer to a hosted agent without a rewrite.

Every stage inherits the five gates of ADR-005, with the never-auto-merge rule holding through stage four and auto-merge in stage five being per finding-class and opt-in rather than global. This staged path reaches full automation more slowly than jumping straight to a hosted agent, but each stage is reversible and de-risks the next.
