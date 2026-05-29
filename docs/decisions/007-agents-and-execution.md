# ADR-007: Agents and Execution

Date: 2026-05-28

Amended: 2026-05-30 — expanded the stage-4 (lift to hosted) and stage-5 (selective auto-merge) bullets into full design subsections plus a defer decision.

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

### Stage 4 design — lift to a hosted agent

The hosted runtime is an ephemeral, scheduled GitHub Actions job that mirrors the existing `apply.yml`, not a long-running daemon or webhook listener. A persistent service would require self-hosted infrastructure and break the zero-infra moat that ADR-002 and the landscape evaluation both protect; an ephemeral Actions job keeps the runtime inside GitHub-native primitives. It authenticates with the same least-privilege GitHub App token `apply.yml` already mints through `actions/create-github-app-token`, scoped to the repository owner and granting only `contents: write` and `pull-requests: write` — never organisation administration.

The single genuine trust delta this stage introduces is removing the human at dispatch time: the scheduled job runs without an operator pressing the button. That directly relaxes the first ADR-005 gate (workflow_dispatch-only) and leans the whole model on the third gate (`require_approval`). The resolution is to keep `require_approval` as an always-on master switch and to add a per-finding-class promotion allow-list, reusing the configuration surface already established by the `apply-cap` block — a finding class graduates onto the scheduled path only by an explicit, reviewed config entry, and removing that entry reverts it. The existing blast-radius controls (`capPerTool` and the batch size) are unchanged, so the maximum number of PRs a hosted run can open is bounded exactly as it is today. PR review is retained throughout this stage; nothing merges itself.

### Stage 5 design — selective auto-merge

Auto-merge is bounded to the deterministic template tools only — the keys that `apply.js` can generate as a static file (`code-scanning`, `dependabot-actions`, and now `issue-form-templates`) — and explicitly excludes policy-drift findings, tier-uplift findings, and anything whose executor is `agent` or `manual`. Eligibility is an opt-in, per-class allow-list that defaults to empty; auto-merge is never global. Two independent kill switches disable it: restoring `require_approval` to true re-imposes the human gate, and disabling the scheduled workflow stops the runtime entirely.

Reversibility is a precondition, not an afterthought. A class is only auto-mergeable when its PR has required CI green, the merge is a squash (so a revert is a single clean commit), and the resulting merge SHA is recorded in the apply result for audit and rollback. Implementation will need a merge method on the GitHub client, which does not exist today: the two candidates are the REST `pulls/{n}/merge` endpoint with the squash strategy, or the GraphQL `enablePullRequestAutoMerge` mutation, which merges only once required checks pass and so maps more naturally onto the CI-green precondition. That choice belongs to the implementation PR, not this design.

### Decision: land this design now, defer the implementation

This amendment is recorded now so the gates and controls for stages 4 and 5 are settled before any hosted-agent or auto-merge code is written, as ADR-005 and ADR-007 both require. The implementation of both stages is deferred. The portfolio currently sits at 14 Gold with zero open governance findings, so `apply.js`'s `executor === 'template'` actionable filter returns empty on every run — building a no-human-at-dispatch runtime and an auto-merge path now would be building consumers for an empty queue, with no human-reviewed apply track record to justify removing the human or the review.

The unblock condition is deliberately falsifiable: a sustained track record of human-reviewed `governance-apply` PRs (on the order of several merged across several weeks with no rollbacks), reached only after a finding-generating direction first puts real work through the manual apply path. Templatizing `issue-form-templates` is the first such direction; until that track record exists, stages 4 and 5 remain design-only.

## Consequences

Local-first architecture maintains human oversight while agent judgement remains unproven, aligning with the never-auto-merge rule and ADR-006 without requiring new infrastructure. The portable remediation-plan contract decouples decision logic from the runtime, allowing logic hardened locally to transfer to a hosted agent without a rewrite.

Every stage inherits the five gates of ADR-005, with the never-auto-merge rule holding through stage four and auto-merge in stage five being per finding-class and opt-in rather than global. This staged path reaches full automation more slowly than jumping straight to a hosted agent, but each stage is reversible and de-risks the next.
