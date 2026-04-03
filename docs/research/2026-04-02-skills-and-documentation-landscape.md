# Skills, Agent Instructions, and Documentation Patterns — Research

Date: 2026-04-02

## Context

Research into three questions: how should AI agent skills and instruction files work across a portfolio, how do CLAUDE.md and CONTRIBUTING.md relate, and what documentation patterns should both repo-butler and the triage bot follow. Motivated by exploring whether repo-butler could distribute skills to help contributors (human and AI) work more effectively.

## AI Instruction File Landscape

The instruction file space is fragmented across 10+ formats. Each AI coding tool reads its own file:

- `CLAUDE.md` (Claude Code)
- `.cursorrules` (Cursor)
- `AGENTS.md` (Codex)
- `GEMINI.md` (Gemini CLI)
- `.github/copilot-instructions.md` (Copilot)
- `.windsurfrules` (Windsurf)
- `.junie/guidelines.md` (JetBrains Junie)
- `.kiro/steering/` (Kiro)
- `.clinerules` (Roo Code)
- `.aider.conf.yml` (Aider)

AGENTS.md (github.com/agents-md/agents.md) is trying to be vendor-neutral. Next.js symlinks CLAUDE.md to AGENTS.md. However AGENTS.md is backed by OpenAI (Codex reads it natively) so some see it as just another vendor format. The format is converging around project overview, build/test commands, architecture, conventions, and constraints — regardless of which file it lives in.

Major projects with CLAUDE.md or AGENTS.md: Next.js, React, Deno, Svelte, Vercel CLI, Remix. Supabase uses `.github/copilot-instructions.md` with path-scoped instruction files in `.github/instructions/` — the most sophisticated setup found.

The skills ecosystem has exploded. Over 1,060 skills catalogued in `awesome-agent-skills` (13.8k stars), with official skills from Anthropic, Vercel, Stripe, Cloudflare, Microsoft (132 Azure skills), and others. Format converging on SKILL.md in a directory. Cross-platform format converters exist (`prpm` handles 13 formats, `agent-skill-creator` targets 14+ tools).

## Auto-Generation: Caution Warranted

An ETH Zurich study (February 2026, cited by `ai-context-kit`) found that auto-generated context files actually reduced task success compared to providing nothing. Human-written ones only improved accuracy by 4%, while inference costs jumped 20%+ from wasted tokens. This suggests most instruction files are more noise than signal.

Tools that auto-generate CLAUDE.md from codebase analysis: ClaudeForge (334 stars, quality scoring 0-100), Caliber (415 stars, syncs across platforms as code evolves), Tacit (extracts knowledge from PR comments and CI failures with provenance links), claude-reflect (871 stars, captures session corrections and syncs to CLAUDE.md).

The implication: auto-generating descriptions of code structure is harmful or neutral. What helps is hand-written wisdom about non-obvious conventions and gotchas. The butler could uniquely generate cross-repo findings (facts from observation) rather than documentation (descriptions of code).

## Cross-Repo Propagation Gap

Nobody has built a GitHub Action that propagates CLAUDE.md across an organization. This maps directly to repo-butler's onboarding workflow (`src/onboard.js`). GitHub's `.github` special repository provides one-level inheritance for community health files (CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue templates) but not for agent instruction files.

Tools in this space: `dotagents` (664 stars, single `.agents` directory with symlinks to each tool's format), `Caliber` (generates and maintains agent context across platforms). Neither operates at the organization/portfolio level.

## CLAUDE.md vs CONTRIBUTING.md

The emerging pattern is complementary, not overlapping. Svelte's AGENTS.md opens with "Read and follow CONTRIBUTING.md as well." Next.js and Deno similarly structure their agent files as supplements to existing human docs.

CONTRIBUTING.md is a social contract — it tells a human contributor the project's expectations around PRs, commit messages, code review, and community norms. It answers "what does this project expect from me as a person?"

CLAUDE.md is a technical brief — it tells an AI agent where things are, what commands to run, what patterns to follow, and what gotchas to avoid. It answers "how do I work effectively in this codebase without breaking things?"

A human contributor reads both. An AI agent reads both but gets most value from CLAUDE.md. They reference each other but don't duplicate.

## Documentation Tiers

Repo-butler already has four documentation tiers without explicitly designing for it: `CONTRIBUTING.md` (human contributor guide), `CLAUDE.md` (AI contributor guide), `docs/skill.md` (AI consumer skill — data models, MCP tools), and `docs/consumer-guide.md` (human consumer guide — how to read reports, fix health tier issues). Most projects have at most two of these.

The 2x2 matrix:

|  | Human audience | AI agent audience |
|---|---|---|
| Contributor (working on this project) | CONTRIBUTING.md | CLAUDE.md |
| Consumer (using this project's output) | docs/consumer-guide.md | docs/skill.md |

## Contribution Workflow Stages

Typical stages: fork/clone, environment setup, branch, develop, test locally, submit PR, code review, CI checks, merge, release. These are already encoded in existing files across ecosystems: `devcontainer.json` (setup), `package.json` scripts (build/test), CI workflows (test/deploy), branch protection rules (merge). No universal machine-readable manifest exists for "here's how to build, test, lint, and deploy this project."

Closest candidates: Nx's `project.json` (most complete per-project capability manifest but ecosystem-specific), devfile.yaml (CNCF sandbox, defines components and lifecycle commands with inheritance), Taskfile.yml / Justfile (language-agnostic task definitions). None is widely adopted as a cross-ecosystem standard.

For AI agents, CLAUDE.md serves as the de facto "contribution lifecycle manifest" — it contains build commands, test commands, and conventions. The problem is it's unstructured prose rather than machine-parseable metadata.

## Established Documentation Patterns

### ADR patterns

Michael Nygard's original format (2011): Status, Context, Decision, Consequences. Intentionally minimal. Key principle: immutability (create new ADR that supersedes, don't edit). MADR v4.0.0 extends with YAML frontmatter (status, date, decision-makers), Decision Drivers, explicit Pros/Cons, optional Confirmation section. adr-tools CLI defaults to `doc/adr/` with sequential numbering. Backstage uses Nygard format at `docs/architecture-decisions/`.

### RFC vs ADR distinction

An RFC proposes a change not yet decided (forward-looking, invites discussion). An ADR records a decision already made (backward-looking, captures reasoning). Rust RFCs are the gold standard template. Kubernetes KEPs serve both purposes — proposals that evolve into living records. Go uses a lighter approach: GitHub issue first, escalate to design doc only when needed.

### Diataxis framework

Four documentation quadrants: tutorials (learning-oriented), how-to guides (task-oriented), reference (information-oriented), explanation (understanding-oriented). Django is the canonical implementation. Kubernetes follows implicitly. Key warning: don't mix modes — a tutorial that explains theory loses learners, a reference page that teaches loses experienced users.

### Docs-as-code

Google's core principle: change documentation in the same commit as the code. Dead docs are "actively harmful." "Minimum viable documentation" — a small set of fresh, accurate docs beats a large assembly in disrepair.

### Plan/spec lifecycle

Three patterns: immutable snapshot (Rust RFCs — frozen once merged), living document (Kubernetes KEPs — updated through lifecycle with Implementation History), archive on completion (mark as implemented, stop maintaining). Ember RFCs use explicit stage tracking (exploring, accepted, ready-for-release, released, recommended).

## Cross-Project Documentation Audit

### Repo-butler structure
- 3 ADRs in `docs/decisions/` (001-003, Nygard-style)
- 1 plan in `docs/plans/` (naming: `phase1-richer-observation.md`, no date prefix)
- 1 spec in `docs/superpowers/specs/` (naming: `2026-03-29-interoperability-layer-design.md`)
- 6 JSON schemas in `schemas/v1/`
- No YAML frontmatter, no ADR index, no research directory (until this doc)

### Triage bot structure
- 13 ADRs in `docs/adr/` (001-013, with index README)
- 7 decisions in `docs/decisions/` (000-006, lighter format)
- 16 plans in `docs/plans/` (dated prefix, 8+ superseded)
- 1 research doc in `docs/research/`
- Validation records in `docs/validation/`

### Key inconsistencies
- Two different decision record systems in triage bot (adr vs decisions) with no documented distinction
- Repo-butler's `docs/decisions/` contains ADR-format documents but uses the name the triage bot uses for lighter decisions
- Plan naming inconsistent: triage bot uses dated prefixes, repo-butler's plan doesn't
- Superseded plans accumulate in triage bot (8+ of 16 are superseded) — no archive pattern
- Neither project uses YAML frontmatter for machine-parseable metadata

## Recommendations

1. The butler's unique skill opportunity is distributing cross-repo findings, not generating documentation. "Your repo is Silver tier, missing SECURITY.md" is a finding only the portfolio view can produce.

2. CLAUDE.md should point agents to relevant ADRs for the area they're working on — "documentation as system prompt."

3. A documentation taxonomy would help both projects: ADRs for decisions made, specs for proposed changes, plans for implementation steps, research for exploration.

4. Consider MADR-style YAML frontmatter on ADRs for machine-parseability.

5. Archive superseded plans rather than accumulating them.

6. Add a SECURITY.md to repo-butler (the triage bot has one).

7. The cross-org CLAUDE.md propagation gap is a natural extension of the onboarding workflow.
