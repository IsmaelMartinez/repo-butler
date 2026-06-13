# ADR-009: Settings-Level (PR-less) Cross-Repo Writes

Date: 2026-06-13
Status: Proposed

Amends [ADR-005](005-cross-repo-write-trust-model.md) (cross-repo write trust model) and extends [ADR-007](007-agents-and-execution.md) Track A (templatable findings). Proposed, not yet accepted: the `code-review-bot` standard ships detection-only (manual remediation) until this ADR is accepted and the auto-enable path is built behind the gates below.

## Context

Every cross-repo write the butler performs today is a pull request. ADR-005's five-gate trust model is built on that assumption: gate 4 caps the number of *PRs* per run, dedup keys off an existing-PR check, and the implicit safety net under all of it is that a PR carries a reviewable diff a human can read before it merges and can revert by closing or reverting the merge. "Open a PR a human reviews" is the unit of change.

Standardising GitHub Copilot code review across the portfolio breaks that assumption. Copilot automatic review is not a committed file — it is a `copilot_code_review` rule inside a repository ruleset, created through repository settings or the `POST /repos/{owner}/{repo}/rulesets` REST endpoint (the rule type is supported by the API, go-github, and the Terraform GitHub provider). There is no file to template into a PR, so propagating it the way the butler propagates `code-scanning` or `dependabot-auto-merge` is impossible. The only way to enable it programmatically is a settings-level write: a live API call that changes the repository's configuration the instant it returns.

A settings write has none of a PR's safety affordances. There is no diff to review before it takes effect, no thread to comment on, and reverting means issuing a second API call to delete the ruleset rather than closing an unmerged branch. The whole point of ADR-005 was that cross-repo writes are dangerous because a single fault fans out across the portfolio; a PR-less write removes the one mechanism — pre-merge human review — that bounded the damage of a write that slipped through the other gates. The detection side of the `code-review-bot` standard is therefore safe to ship immediately (it only reads rulesets), but the remediation side needs a trust model of its own before the butler is allowed to mutate settings unattended.

## Decision

Permit settings-level (PR-less) writes only for the bounded, additive case of enabling a `copilot_code_review` ruleset, and only under all five ADR-005 gates plus three writes-without-a-PR gates that stand in for the missing pre-merge review.

The five ADR-005 gates carry over unchanged. The settings-apply path is `workflow_dispatch`-only and dry-run fail-closed (any input other than the literal `'false'` only logs the ruleset it would create); it refuses to run unless `require_approval` is `true`; it is bounded by the same per-run cap so a fault touches at most a handful of repos before the batch limit halts it; and every repo name is validated against `^[a-zA-Z0-9._-]+$` before it is interpolated into an API path. Promotion onto any scheduled (no-human) path reuses the per-class `apply-schedule` allow-list from ADR-005's 2026-06-06 amendment, default-closed and reversible, so settings writes graduate to unattended operation exactly as file-PR writes do and never sooner.

Three additional gates replace what the absent PR used to provide.

The first is additive-and-idempotent writes. The butler creates one new, distinctively named ruleset (`repo-butler/copilot-code-review`) carrying only the `copilot_code_review` rule. It never edits or deletes a ruleset it did not create, so a maintainer's hand-tuned rulesets are untouchable by construction. Before writing, it runs the same detection this standard already added: if an active ruleset already requests Copilot review, the repo is compliant and skipped, so re-runs are no-ops and the write cannot clobber prior state.

The second is scope minimisation. The created ruleset targets only the default branch, sets enforcement to active, and contains nothing but the single Copilot rule. It deliberately carries no branch-protection, required-status-check, or push restriction, so the worst case of a wrongly-targeted ruleset is benign: Copilot gets asked to review pull requests. It cannot block a merge, lock a branch, or restrict a contributor — the failure modes that make settings writes frightening are excluded by what the ruleset is allowed to contain.

The third is an audit record that stands in for the PR. Because there is no PR to point at afterwards, every run — dry-run and live — writes a run summary listing the exact repos mutated and the exact ruleset JSON, and the distinctive ruleset name makes every butler-created ruleset trivially findable and deletable. The dry-run preview shows the precise payload before any live run, restoring the "see the change before it lands" moment that a PR diff normally provides.

A licence note, not a gate: the ruleset only causes reviews to be requested on accounts holding a Copilot plan (Pro/Pro+/Max, or Business/Enterprise), and on public repositories Copilot review consumes no Actions minutes. On a repo whose owner lacks a Copilot plan the ruleset is inert rather than harmful — it requests a reviewer that never arrives — which further bounds the blast radius.

## Consequences

The butler gains a second write modality — settings, not just files — without weakening the portfolio-scale trust model, because the new modality inherits all five existing gates and adds three that specifically answer "what protects us when there is no PR to review?" The answer is that the write is additive, idempotent, scope-minimised to a single benign rule, and fully audited, so the absence of a pre-merge diff costs less than it would for an arbitrary settings change.

The cost is that this carves a narrow, explicitly-bounded exception rather than a general "the butler may change repository settings" capability. Any future settings write beyond the Copilot ruleset (branch protection, required checks, repo flags) is out of scope here and would need its own analysis, because those carry the merge-blocking and access-restricting failure modes this ADR was careful to exclude. That narrowness is intentional: the moment settings writes can block merges or restrict access, the benign-worst-case argument that justifies the missing PR no longer holds.

Until this ADR is accepted, `code-review-bot` findings route to the `manual` executor: the butler surfaces which repos lack Copilot review and the maintainer enables the ruleset by hand, exactly as the detection-only standard does today.
