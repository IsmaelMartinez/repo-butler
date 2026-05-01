# Cross-Repo PR Automation Design

Scoped as two independent modules that share the governance findings pipeline: `dependabot:audit` (detection) and `governance:apply` (remediation). Both can be implemented in parallel — they communicate only through the persisted `governance.json` on the data branch.

## Architecture

```
Daily pipeline (existing):
  OBSERVE → governance detection → [+ dependabot-audit] → persist findings → IDEATE/REPORT

On-demand (new):
  apply workflow → read findings from data branch → validate shape
    → filter actionable → generate template per (standard, ecosystem, repo)
    → open branch + PR on each target repo (batched, max 5/run)
    → record which PRs were opened (deduplication)
```

Detection runs daily as part of the existing governance block. Apply is manual-dispatch only — never on cron. The two systems are decoupled: detection writes findings to the data branch, apply reads them. This means apply can be triggered hours or days after detection without re-running the full pipeline.

## Module 1: `src/dependabot-audit.js`

A single exported function `auditDependabot(gh, owner, repos, details)` that detects stale unmerged Dependabot PRs (>30 days old) and returns findings in the standard governance shape.

### What it checks

Stale unmerged Dependabot PRs only. Missing config is already covered by the existing `dependabot-actions` detector in `STANDARD_DETECTORS` — no duplication.

### Finding shape

```js
{
  type: 'dependabot-stale',
  repo: 'bonnie-wee-plot',
  stalePRs: [{ number: 287, title: 'Bump eslint from 8 to 9', age: 45 }],
  priority: 'medium',  // >60d → 'high'
}
```

### Integration point

Called in `runIdeate` (src/ideate.js) right after the existing three governance detectors. Findings append to `context.governanceFindings`, so they persist to the data branch, feed into the IDEATE prompt, render in the governance dashboard, and are exposed via `get_governance_findings` MCP tool — all free.

### Cache bypass

Stale PRs age without changing `pushed_at`, so the existing `fetchPortfolioDetails` cache (keyed on `pushed_at` + `open_issues_count`) would incorrectly skip the audit. The `auditDependabot` function runs independently of the cache gate — it always makes fresh API calls regardless of whether the repo's details were served from cache. This means it is called outside `fetchPortfolioDetails`, directly in `runIdeate` after portfolio details are resolved.

### API cost

One paginated `/pulls?state=open&per_page=100` call per active repo, filtered client-side for `user.login === 'dependabot[bot]'` and `created_at` older than 30 days. Batched in `Promise.all`. At 13 repos this adds 13 requests to the daily run (~364 → ~377 total, well within the 5000/hr budget).

## Module 2: `src/apply.js`

A single exported function `applyGovernanceFindings(gh, owner, findings, config)` plus a `runApply(context)` dispatcher entry for `--phase=apply`.

### Flow

1. `runApply(context)` reads findings from data branch via `store.readGovernanceFindings()`
2. Validates finding shape (see "Shape validation" below) — fails fast if expected fields are missing
3. Filters to actionable findings: only `type: 'standards-gap'` where a template exists in `TEMPLATES`
4. Skips repos that already have an open PR from a previous apply run (deduplication via open PR with head branch `repo-butler/apply-{tool}`)
5. Respects `config.limits.require_approval` — refuses to run if false
6. Honours `INPUT_DRY_RUN` with fail-closed semantics: any value other than literal `'false'` is treated as dry-run. In dry-run mode, logs what would be opened without creating anything
7. Enforces a hard cap of 5 PRs per run (configurable via `config.limits.max_apply_per_run`, default 5). If more are actionable, processes the first 5 and logs the remainder as deferred
8. For each actionable (repo, tool) pair: creates branch, writes templated file, opens PR

### Shape validation

On reading `governance.json`, apply asserts each finding has the expected fields (`type`, and for `standards-gap`: `tool`, `nonCompliant` as an array). Findings that fail validation are logged with a warning and skipped — apply does not produce PRs from malformed data.

### Per-repo PR creation (same pattern as onboard.js)

1. Validate repo name against `^[a-zA-Z0-9._-]+$` (see "Security: template injection")
2. Determine default branch
3. Generate file content via template lookup (see "Template generation")
4. Create branch `repo-butler/apply-{tool}` from HEAD of default branch
5. Write file(s) to that branch via Contents API
6. Open PR with title `chore: add {tool} configuration`, body explaining the governance finding, labelled `governance-apply`
7. Log the PR URL

### Concurrency

Repos processed sequentially in batches of 3 to avoid GitHub's secondary rate limit (30 content-creation requests/minute). Each batch awaits `Promise.all` of its 3 repos before starting the next. At 5 write operations per repo and a cap of 5 repos per run, this means max 15 writes in 2 sequential batches — well under the limit.

### What apply does NOT do

It never merges. It never enables auto-merge. It opens the PR and stops.

## Template generation

Templates are defined as a data map (not a switch) inside `src/apply.js`:

```js
const TEMPLATES = {
  'code-scanning': { path: '.github/workflows/codeql-analysis.yml', content: (eco) => ... },
  'dependabot':    { path: '.github/dependabot.yml', content: (eco) => ... },
};
```

Each entry maps a standard tool name to `{ path, content(ecosystem) }`. The `content` function returns the file string, parameterised by ecosystem. Adding a new template is a single object-property addition — no control-flow modification needed.

### Supported templates at launch

`code-scanning` — `.github/workflows/codeql-analysis.yml`. Parameterised by ecosystem: JavaScript → `language: javascript`, Go → `language: go`, Python → `language: python`. Falls back to `language: javascript` if ambiguous. Same workflow structure already deployed across the portfolio (CodeQL v3 action, weekly + push to default branch).

`dependabot` — `.github/dependabot.yml`. JavaScript → `npm` + `github-actions`, Go → `gomod` + `github-actions`, bare → `github-actions` only. Weekly interval.

`secret-scanning` — no template. Secret scanning is a repo *settings* toggle, not a file. Apply logs a note and moves on. The finding still surfaces in the dashboard for manual action.

### Ecosystem detection

Reuses `detectEcosystem(repo)` from safety.js. Portfolio details carry `language` from the GitHub API as a fallback.

### Extensibility

Adding a new template: one new property in `TEMPLATES` + a new entry in `STANDARD_DETECTORS`. If governance detects a gap for a tool that has a template, apply picks it up automatically.

## Security

### Template injection via repo name

Repo names are interpolated into generated YAML files (workflow names, comments). A malicious repo name containing YAML metacharacters or newlines could inject workflow steps. Defence: before any template interpolation, validate the repo name against `^[a-zA-Z0-9._-]+$`. Reject (skip with warning) any repo that fails this check. This is applied in step 1 of the per-repo flow, before `generateTemplate` is ever called.

### Dry-run fail-closed

The `INPUT_DRY_RUN` check treats any value other than the literal string `'false'` as dry-run mode. An empty string, `undefined`, `'true'`, or any other value all result in dry-run. This prevents accidental PR creation from workflow dispatch edge cases.

### Batch cap as circuit breaker

A hard cap of 5 PRs per run (configurable) prevents a filtering bug from blasting PRs across the entire portfolio in seconds. To override, pass an explicit `max-apply-per-run` workflow input — the cap is always enforced, just adjustable.

### Label-based approval hardening

The `approved` label triggers the existing auto-merge workflow. Risk: anyone with write/triage access to a target repo can add the label themselves. Mitigation: the auto-merge workflow must check that the label was added by the repo owner (the `github.actor` who triggered the label event). If the actor is not in a configured approver list (default: the GitHub App installation owner), the workflow exits without merging. This is a one-line conditional in the existing `dependabot-auto-merge.yml` workflow.

## Workflow: `.github/workflows/apply.yml`

Manual dispatch only, mirrors onboard.yml:

```yaml
on:
  workflow_dispatch:
    inputs:
      dry-run:
        description: 'Dry run (log only, no PRs)'
        default: 'true'
      tools:
        description: 'Comma-separated tools to apply (blank = all actionable)'
        required: false
      max-apply-per-run:
        description: 'Max PRs to open (default 5)'
        required: false
        default: '5'
```

Generates App token with `owner` scope (same as onboard/monitor/self-test), runs `node src/index.js --phase=apply`. The `tools` input lets you scope a run to a single standard for incremental rollout.

## Config

No new config keys required. Existing keys govern behaviour:

- `standards` in roadmap.yml — defines what's expected
- `standards-exclude` — exempts repos per standard
- `limits.require_approval: true` — gates the apply phase (refuses to run if false)
- Apply phase is opt-in by being manual-dispatch only (never cron)

Optional new key (low-priority): `limits.max_apply_per_run` (default 5) to override the batch cap without editing the workflow input.

## Error handling

- Single repo failure (403, PR exists, etc.): log and continue. Collect results, print summary at end.
- App token lacks permissions on a repo: GitHub returns 403 — caught, logged, skipped.
- Deduplication: before creating a PR, check for open PR with head branch `repo-butler/apply-{tool}`. If exists, skip.
- Shape validation failure on a finding: log warning, skip that finding, continue processing others.
- Batch cap exceeded: process first N, log the remainder as "deferred to next run".

## Approval flow

PRs opened by apply carry the `governance-apply` label. They sit in the target repo's PR queue as normal PRs. To approve: add the `approved` label, which triggers the auto-merge workflow. The auto-merge workflow validates the label-adder is the repo owner before proceeding. Until approval, no merge happens.

## Testing

### `src/dependabot-audit.test.js`

- Returns empty for repos with no stale Dependabot PRs
- Returns `dependabot-stale` finding for repos with PRs >30d old
- Sets priority to `high` when PR is >60d old
- Skips archived/forked repos
- Handles API errors gracefully (returns empty, no throw)

Mock: stub `gh.paginate` with canned PR arrays and controlled `created_at` dates.

### `src/apply.test.js`

- Dry-run mode: logs intended PRs, makes no API calls
- Dry-run fail-closed: empty/undefined `INPUT_DRY_RUN` treated as dry-run
- Skips findings with no matching template (e.g. secret-scanning)
- Skips repos with existing open `repo-butler/apply-{tool}` branch
- Skips repos with invalid names (fails `^[a-zA-Z0-9._-]+$` check)
- Refuses to run when `require_approval` is false
- Generates correct template per ecosystem (code-scanning JS vs Go, dependabot JS vs Go)
- Handles per-repo errors without aborting the batch
- Enforces batch cap (only first N repos processed, remainder logged)
- Validates finding shape on read (malformed findings skipped with warning)

Mock: stub `gh.request` and `gh.paginate` to capture calls and assert endpoints/bodies.

### No integration tests

Apply touches other repos and needs a real App token. The dry-run default + manual dispatch is the integration test. No sandbox org or mock server needed.

## Parallel implementation

The two modules share no code except the governance findings shape (a plain array of objects with a documented contract). They can be built in separate worktrees by independent agents:

- Agent 1: `src/dependabot-audit.js` + test + integration into `runIdeate` (cache-bypass aware)
- Agent 2: `src/apply.js` + test + `runApply` dispatcher entry + `apply.yml` workflow + auto-merge hardening

Neither blocks the other. After both merge, the daily pipeline produces findings that include stale-PR data, and the manual apply workflow can remediate standards gaps.
