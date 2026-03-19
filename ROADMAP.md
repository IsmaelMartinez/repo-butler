# Repo Butler — Roadmap

**Last Updated:** 2026-03-19
**Status:** Initial scaffold — OBSERVE phase implemented

---

## Architecture

The agent follows a five-phase loop:

```
OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE
```

1. **OBSERVE** — Gather project state via GitHub API. No LLM needed. Pure data collection.
2. **ASSESS** — Evaluate what changed since last run. Uses Gemini Flash (free tier).
3. **UPDATE** — Rewrite/update the roadmap document. Create a PR for review.
4. **IDEATE** — Generate improvement ideas. Uses Claude for deeper reasoning.
5. **PROPOSE** — Create GitHub issues for the best ideas, labelled for human review.

## Current State

### Implemented

- OBSERVE phase: open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, package.json parsing
- Portfolio-level observation: classify all repos by activity (active, maintained, dormant, archive-candidate, fork)
- Summary generation: label distribution, blocked/stale issue detection, contributor analysis, reaction-based prioritisation
- Self-dogfooding: `.github/roadmap.yml` config and daily workflow
- GitHub Action definition (`action.yml`)

### Next Up

- ASSESS phase: diff current snapshot against previous, identify what changed
- Snapshot persistence: store observation results for diff comparison
- OBSERVE for portfolio: wire `observePortfolio` into the main flow
- Tests for the observe module

### Future

- UPDATE phase: generate roadmap PR from assessment
- IDEATE phase: LLM-powered improvement ideas (Gemini Flash default, Claude optional)
- PROPOSE phase: create GitHub issues from best ideas
- Provider abstraction for LLM calls (Gemini, Claude)
- Consumer workflow template for other repos
