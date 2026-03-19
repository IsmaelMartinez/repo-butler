# Repo Butler — Roadmap

**Last Updated:** 2026-03-19
**Status:** All five phases implemented, tested against teams-for-linux

---

## Architecture

The agent follows a five-phase loop:

```
OBSERVE → ASSESS → UPDATE → IDEATE → PROPOSE
```

1. **OBSERVE** — Gather project state via GitHub API. No LLM needed.
2. **ASSESS** — Diff current snapshot against previous run. Optionally summarise with Gemini Flash.
3. **UPDATE** — Generate an updated roadmap document and open a PR. Uses Gemini Flash.
4. **IDEATE** — Generate improvement ideas. Uses Claude for deeper reasoning (falls back to Gemini).
5. **PROPOSE** — Create GitHub issues from ideas, capped and labelled for human review.

## Current State

### Implemented

- **OBSERVE**: open/closed issues, merged PRs, labels, milestones, releases, workflows, repo metadata, roadmap content, package.json parsing, portfolio-level repo classification
- **ASSESS**: snapshot persistence via GitHub Contents API on a data branch, diff computation (new/resolved issues, merged PRs, new releases, label changes), LLM-powered change summarisation
- **UPDATE**: generates updated roadmap from observation + assessment data, creates a PR on a feature branch
- **IDEATE**: structured idea generation with priority/labels/body, parsed from LLM output
- **PROPOSE**: creates GitHub issues from ideas, respects `max_issues_per_run`, ensures labels exist, sorts by priority
- **Providers**: Gemini Flash (free tier REST API) and Claude (Anthropic Messages API), both zero-dependency
- **Store**: snapshot persistence on a `repo-butler-data` orphan branch via Git Data API
- **Self-dogfooding**: `.github/roadmap.yml` config and daily workflow with manual dispatch

### Next Up

- End-to-end test with a Gemini API key (OBSERVE and ASSESS work without one)
- Consumer documentation for using this on other repos
- Tests for core modules (observe, assess, store, idea parsing)
- Rate limiting / retry logic for the GitHub and LLM APIs
- Richer portfolio observation: CI status, README presence, open issue details per repo

### Future

- Electron release watcher (monitor Electron releases for fixes to blocked issues)
- Multi-repo mode (observe several repos in a single run, cross-reference)
- Configurable assessment templates per project type
- Weekly digest email/notification option
