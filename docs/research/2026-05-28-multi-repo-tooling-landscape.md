# Multi-Repo Tooling Landscape — Evaluation

Date: 2026-05-28

## Context

The repo-butler roadmap identifies approximately twelve multi-repo tools for evaluation before developing custom cross-repo enforcement capabilities. Previous research from April 2026 focused on AI instruction files rather than these specific governance and execution tools, leaving this area unevaluated. This document addresses that gap by analyzing the identified tools to determine their relevance to the project. For each tool, the analysis provides a clear verdict on whether to adopt it, extend repo-butler in-house, learn from its design, use it as a manual escape-hatch, ingest it as a signal, or skip it entirely.

## Evaluation criteria

Every tool is evaluated against repo-butler's strict architectural constraints, which mandate zero npm dependencies, an API-only approach without git cloning, execution as a GitHub Action on the node24 runtime, and the publication of reports to GitHub Pages without self-hosted infrastructure. These requirements define the hard boundaries for embedding a tool within the system. Tools that violate these constraints may still offer valuable insights for learning despite their incompatibility.

## Verdicts

### Bulk change tools (clone N repos, run a script, open PRs)

| Tool | Verdict | Rationale |
|------|---------|-----------|
| [multi-gitter](https://github.com/lindell/multi-gitter) | Keep as manual escape-hatch | Go CLI that clones repos and runs a script you write, then opens PRs. Embedding it breaks the API-only constraint and adds a binary dependency, so it stays out of the Action. But it is the sanctioned manual tool for complex multi-file migrations that `apply.js` cannot express as a single templated file. Actively maintained (v0.63.1, May 2026), Apache-2.0. |
| [git-xargs](https://github.com/gruntwork-io/git-xargs) | Skip | Same clone-and-script model as multi-gitter but less capable and less actively maintained. Redundant. |
| [turbolift](https://github.com/Skyscanner/turbolift) | Skip | Manual multi-step workflow (edit repos.txt, run commands, create PRs as separate steps). Only earns its keep on very large migrations; multi-gitter covers the same need with less ceremony. |
| [octoherd](https://github.com/octoherd/octoherd) | Learn-from | JavaScript framework where you write an async function receiving an Octokit instance per repo. This is exactly the shape of repo-butler's own `src/github.js` client plus `applyToRepo()` in `src/apply.js` — adopting it would reimplement what already exists. Maintenance signals are unclear (no recent releases). |

### Config sync tools (keep files or settings in sync declaratively)

| Tool | Verdict | Rationale |
|------|---------|-----------|
| [github/safe-settings](https://github.com/github/safe-settings) | Learn-from (skip as tool) | Self-hosted Probot GitHub App requiring deployment infrastructure (Lambda/Docker), which violates the zero-infra moat. Its three-tier config hierarchy (org-wide → sub-org → per-repo override) is a good model for evolving the `standards` scoping in `.github/roadmap.yml`. |
| [repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action) | Extend in-house instead | The closest direct fit: a GitHub Action that opens PRs on target repos when files drift, configured via `sync.yml`. Adopting it would add a CI Action dependency and a second propagation path alongside `apply.js`. The decision (below) is to extend `apply.js`'s template set natively instead, while learning from its drift-detection model. MIT. |
| [actions-template-sync](https://github.com/AndreasAugustin/actions-template-sync) | Skip | Niche template-repository sync; the community-health-file propagation it would cover is handled by the `apply.js` extension. |

### Security and governance enforcement

| Tool | Verdict | Rationale |
|------|---------|-----------|
| [ossf/allstar](https://github.com/ossf/allstar) | Learn-from (skip as tool) | Self-hosted Probot App, security-settings focused. Overlaps the detection `src/governance.js` already performs, and the self-host requirement violates the zero-infra moat. Worth learning from its policy-violation-issue model. |
| [ossf/scorecard](https://github.com/ossf/scorecard) | Ingest as signal (deferred) | Runs as a GitHub Action and produces a 0–10 security health score across roughly eighteen dimensions. This is a future OBSERVE input that could feed the health-tier model, not an execution-layer tool. Tracked as a separate feature, not part of this work. |
| [todogroup/repolinter](https://github.com/todogroup/repolinter) | Skip (archived) | Archived upstream. Only its rule-definition approach is worth learning from. |

### GitHub-native governance

| Feature | Verdict | Rationale |
|---------|---------|-----------|
| Organization Rulesets | Conditional / learn-from | Org-level branch/tag protection targeting repos by pattern or custom property. Team-plan gated. Evaluate before building any branch-protection propagation. |
| Custom Properties | Learn-from | Structured repo metadata (risk level, team, compliance) usable to target rulesets. Could replace the butler's own repo classification for governance targeting; evaluate later. |

## Actionable conclusions

1. Embed no tool into the Action runtime. The combination of zero-dependency, API-only, and zero-infrastructure constraints rules out the clone-based CLIs (multi-gitter, git-xargs, turbolift) and the self-hosted Probot apps (safe-settings, allstar). None can run inside the existing GitHub Action without breaking a core constraint.
2. Extend `apply.js` natively for community-health-file propagation. Add CONTRIBUTING.md, issue templates, PR templates, and CI workflow templates to the existing TEMPLATES map rather than adopting `repo-file-sync-action`. This keeps the moat intact and reuses the ADR-005 five-gate safety model already wrapping cross-repo writes.
3. Keep multi-gitter as the documented manual escape-hatch. For complex multi-file migrations the butler cannot express as a single templated file, multi-gitter is the sanctioned tool the maintainer runs by hand, outside the Action.
4. Defer ossf/scorecard as a future OBSERVE signal. Its security score is a candidate input to the health tier, evaluated separately from the execution layer.
5. The genuine learn-from sources are octoherd (the per-repo Octokit execution model, already mirrored in-house), safe-settings (the org/sub-org/repo config hierarchy for `roadmap.yml`), and GitHub custom properties (governance targeting).

## Relationship to the execution-layer design

This evaluation feeds [ADR-007](../decisions/007-agents-and-execution.md), which defines how findings become action. Conclusion 2 (extend `apply.js` natively) is the Track A template-propagation mechanism described there; the deferred and learn-from items inform later stages rather than the current execution path.
