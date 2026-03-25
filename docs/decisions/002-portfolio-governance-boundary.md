# ADR-002: Portfolio Governance vs Per-Repo Intelligence

Date: 2026-03-25
Status: Accepted
Supersedes: Partially updates ADR-001 (refines the IDEATE/PROPOSE boundary)

## Context

ADR-001 established that repo-butler owns "batch idea generation and issue creation" via the IDEATE/PROPOSE phases, while the triage bot owns per-issue intelligence. In practice, this boundary has proven unclear. The IDEATE prompt asks an LLM to generate improvement ideas for a single repo — the same kind of suggestions (fix this bug, add this feature, refactor this module) that the triage bot produces with far richer context thanks to its vector store, webhook pipeline, and synthesis engine.

Meanwhile, repo-butler has developed a unique capability that no other tool in the ecosystem provides: a cross-repo portfolio view. It knows which repos have Dependabot and which don't, which repos adopted CodeRabbit and which are missing it, which repos have issue templates and which need them, how community health scores compare across the portfolio, and what changed where over time.

This cross-repo visibility enables a category of proposals that the triage bot cannot make, because it only sees one repo at a time. When you add a security scanning tool to 3 repos, only something with the portfolio view can notice the other 16 repos should have it too. When you update your CONTRIBUTING template, only the butler can detect that 8 repos are now out of date. When a new compliance requirement means every repo needs a specific workflow, the butler is the one that knows which repos are non-compliant.

The original CARE phase (deferred from Phase 2) was heading in this direction but was too narrowly defined — hardcoded checks for specific tools rather than a general policy drift detection engine. This ADR reframes the boundary to make repo-butler's proposal capability genuinely distinct from the triage bot's.

## Decision

Redraw the IDEATE/PROPOSE boundary around portfolio governance. Repo-butler proposes changes that arise from cross-repo comparison, standards propagation, and policy drift detection. The triage bot proposes changes that arise from deep per-repo analysis of issues, code patterns, and documentation.

### Repo-butler's proposal domain: portfolio governance

The butler should generate proposals in these categories, all of which require the portfolio-wide view to detect:

Standards propagation — when a tool, configuration, or practice is adopted in some repos but not all. For example: Dependabot was configured in 5 repos but 14 are missing it. CodeRabbit review is enabled in 8 repos but 11 don't have it. Issue form templates exist in 3 repos but the other 16 still use the old markdown format. A `.github/CODEOWNERS` file was added to 2 repos — the rest could benefit.

Policy drift detection — when repos that should be aligned have diverged. For example: 18 repos use MIT but one switched to Apache-2.0 without explanation. The CI workflow template was updated in the base repo but 6 downstream repos run the old version. A shared CONTRIBUTING.md was revised but copies in other repos are stale.

Compliance campaigns — when a new requirement needs to be applied across the portfolio. For example: a new security policy requires all repos to have signed commits enforced. A dependency was flagged with a critical CVE and it appears in the SBOM of 7 repos. A new regulatory requirement means every repo needs a specific license header.

Health tier uplift — when the butler can see exactly what a repo needs to reach the next tier. For example: "repo-x is Silver. To reach Gold it needs: a release in the last 90 days, community health above 80% (missing CONTRIBUTING.md), and Dependabot configured. Here are PRs for the latter two."

Trend-based alerts — when portfolio-level trends suggest a systemic issue. For example: 4 repos have had issue velocity imbalance for 3+ months — the portfolio is accumulating backlog faster than it's clearing it. CI pass rates dropped below 80% in 3 repos this month — something changed.

### Triage bot's proposal domain: per-repo intelligence

The triage bot should continue to own proposals that require deep per-repo context: suggesting code changes based on issue patterns, detecting duplicate issues via semantic similarity, flagging ADR drift against the actual codebase, recommending issue prioritisation based on reaction counts and comment velocity, and generating enhancement research reports. These all depend on the vector store, webhook-driven real-time data, and per-repo document embeddings that the butler doesn't have.

### Scope-aware propagation

Not every tool belongs in every repo. Standards propagation must account for three scopes:

Universal standards apply regardless of language or repo type. These are safe to propagate across the entire portfolio: community health files (CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue templates, PR templates), branch protection settings, code review tools that work on any language (CodeRabbit, Gemini Code Assist), Dependabot for the `github-actions` ecosystem (every repo uses Actions), license consistency, and security policies.

Ecosystem-specific standards only apply to repos that match a language or framework. A Renovate config for npm only applies to repos with a `package.json`. A Go linter workflow only applies to Go repos. A Python type-checking CI step only applies to Python repos. The butler already knows each repo's primary language from the GitHub API — propagation must filter by language before proposing ecosystem-specific tools.

Opt-out exceptions allow individual repos to be excluded from specific standards. An archived repo shouldn't receive proposals. A fork that's intentionally minimal shouldn't get the full compliance treatment. A repo might have a deliberate reason for using a different license. The policy definition should support per-repo overrides.

The portfolio policy definition in `.github/roadmap.yml` should model this explicitly. A `standards` section declares rules with scope:

```yaml
standards:
  - tool: issue-form-templates
    scope: universal
  - tool: contributing-guide
    scope: universal
  - tool: dependabot-actions
    scope: universal
  - tool: renovate-npm
    scope: { language: JavaScript }
  - tool: golangci-lint
    scope: { language: Go }
  - tool: coderabbit
    scope: universal
    exclude: [archived-repo, experimental-fork]
```

Without explicit standards, the butler infers them conservatively. It only proposes universal tools (community health, branch protection, code review) based on majority adoption. It never auto-infers ecosystem-specific tooling — that requires explicit configuration to avoid proposing a Go linter for a Python repo.

### What changes in the codebase

The current IDEATE prompt asks for generic improvement ideas for a single repo. It should be rewritten to focus on portfolio governance proposals. The input to IDEATE should include not just the current repo's snapshot but the full portfolio context: which tools are configured where, what configurations exist across repos, and what changed since the last run. The PROPOSE phase's duplicate detection remains valuable but should check for existing similar PRs (not just issues) since governance proposals often manifest as PRs.

The CARE phase concept is absorbed into this new model. Instead of a separate phase with hardcoded templates, the IDEATE phase detects what's missing or drifted, and PROPOSE creates the issues or PRs. The "configurable tool preferences" and "rule engine" that CARE needed become the scope-aware portfolio policy definition described above.

### Integration with the triage bot

The data flow established in ADR-001 remains: OBSERVE sends data to the triage bot via `/ingest`, and ASSESS/IDEATE read synthesis findings from `/report/trends`. The new addition is that when the butler detects a governance gap, it can inform the triage bot so the bot's per-repo analysis knows about the gap. For example, if the butler detects that a repo is missing Dependabot, the triage bot shouldn't independently suggest adding it — the butler already has a PR for that.

## Consequences

Repo-butler's IDEATE/PROPOSE becomes focused and differentiated. It stops trying to be a generic idea generator (which the triage bot does better) and becomes a portfolio governance engine (which nothing else does). The CARE phase is no longer a separate future phase but the natural output of governance-aware IDEATE/PROPOSE.

This means the current generic IDEATE prompt and the structured issue spec format from Phase 4 need to be adapted. The structured specs still apply — proposals should still have current state, proposed state, affected files, and rationale — but the rationale now references cross-repo data ("this tool is configured in 14/19 repos") rather than single-repo signals.

The portfolio policy definition in `.github/roadmap.yml` becomes a key configuration surface. Without it, the butler can still detect drift by comparing repos to each other. With it, the maintainer can declare explicit standards ("every repo must have Dependabot, MIT license, and issue form templates") and the butler enforces compliance.

The v1 release for external consumers (Scenario 1 from the packaging discussion) becomes less relevant. The butler's value is the portfolio view, which requires running from a central repo against many repos. Individual repo owners get more value from the triage bot. The butler's consumer story is: "install it in your portfolio's meta-repo and point it at all your repos."
