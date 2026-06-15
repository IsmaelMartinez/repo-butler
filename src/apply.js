// Governance apply: opens PRs on target repos to remediate standards-gap findings.
// Manual-dispatch only — never on cron. Reads findings from the data branch,
// validates shape, generates templated config files, and opens PRs.

import { REPO_NAME_PATTERN } from './safety.js';
import { hasActiveCopilotReviewRuleset } from './github.js';
// Re-export for backwards compat with existing onboard.js import.
// Canonical home is safety.js (the security boundary).
export { REPO_NAME_PATTERN };

const TEMPLATES = {
  'code-scanning': {
    path: '.github/workflows/codeql-analysis.yml',
    content: (eco) => {
      const lang = eco === 'Go' ? 'go' : eco === 'Python' ? 'python' : 'javascript-typescript';
      return `name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 3 * * 0'

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: ${lang}
      - uses: github/codeql-action/analyze@v3
`;
    },
  },
  'dependabot-actions': {
    path: '.github/dependabot.yml',
    content: (eco) => {
      const ecosystems = [];
      if (eco === 'JavaScript') {
        ecosystems.push({ manager: 'npm', directory: '/' });
      } else if (eco === 'Go') {
        ecosystems.push({ manager: 'gomod', directory: '/' });
      }
      ecosystems.push({ manager: 'github-actions', directory: '/' });

      const updates = ecosystems.map(e => `  - package-ecosystem: "${e.manager}"
    directory: "${e.directory}"
    schedule:
      interval: "weekly"`).join('\n');

      return `version: 2
updates:
${updates}
`;
    },
  },
  'issue-form-templates': {
    // A single file in .github/ISSUE_TEMPLATE/ is enough to satisfy the
    // detector (observe.js flips hasIssueTemplate true once the directory has
    // ≥1 entry). The content is deliberately ecosystem-agnostic — a generic
    // bug-report form any repo can use as-is and tailor later.
    path: '.github/ISSUE_TEMPLATE/bug_report.yml',
    content: () => `name: Bug Report
description: Report a problem to help us improve
labels: ["bug"]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: Describe the bug and what you expected to happen instead.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      description: How can we reproduce the problem?
    validations:
      required: false
  - type: input
    id: version
    attributes:
      label: Version
      description: Which version or commit are you running?
    validations:
      required: false
`,
  },
  'dependabot-auto-merge': {
    // A single ecosystem-agnostic workflow that auto-merges non-major Dependabot
    // PRs. Uses --squash (matching the proven exemplar): `gh pr merge --auto`
    // with NO method flag errors ("you must specify a merge method") on any repo
    // that has more than one merge method enabled — the GitHub default — so an
    // explicit method is required, not optional. Takes effect only once "Allow
    // auto-merge" is enabled in repo settings and branch protection requires
    // status checks — documented as a PR prerequisite.
    path: '.github/workflows/dependabot-auto-merge.yml',
    content: () => `name: Dependabot auto-merge

on: pull_request

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    runs-on: ubuntu-latest
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    steps:
      - name: Fetch Dependabot metadata
        id: metadata
        uses: dependabot/fetch-metadata@v3
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}

      - name: Enable auto-merge on non-major updates
        if: steps.metadata.outputs.update-type != 'version-update:semver-major'
        env:
          PR_URL: \${{ github.event.pull_request.html_url }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: gh pr merge --auto --squash "$PR_URL"
`,
  },
  'codeowners': {
    // Route review of every path to the repo owner. The owner is the GitHub
    // login the apply run targets, so `* @<owner>` is valid and correct for a
    // single-maintainer estate — derived from the owner, not hardcoded, so the
    // standard stays adoptable by other owners. Guard owner before writing: a
    // missing owner would produce a malformed `* @undefined` rule, and this is a
    // cross-repo write boundary (ADR-005), so fail loud rather than ship it.
    path: '.github/CODEOWNERS',
    content: (_eco, owner) => {
      if (!owner) throw new Error('codeowners template requires an owner');
      return `* @${owner}\n`;
    },
  },
  'security-md': {
    // A generic, ecosystem-agnostic security policy that points reporters at
    // GitHub's private vulnerability reporting. No repo-specific contact, so it
    // applies as-is to any repo and can be tailored later.
    path: '.github/SECURITY.md',
    content: () => `# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately rather than opening a public issue.

Use GitHub's private vulnerability reporting on this repository: open the
**Security** tab and choose **Report a vulnerability**. This creates a private
advisory visible only to the maintainers.

We aim to acknowledge reports within a few days and will keep you updated as we
investigate and prepare a fix.

## Supported Versions

Security fixes are applied to the latest released version. Older versions are not
guaranteed to receive updates.
`,
  },
};

// Tool-specific notes appended to the PR body. Used to document manual
// prerequisites the butler cannot perform itself.
const TOOL_PR_NOTES = {
  'dependabot-auto-merge': 'Prerequisites: this workflow only takes effect once **Allow auto-merge** is enabled in repo settings and branch protection requires status checks. The butler does not flip these settings (Phase 2).',
};

export function generateTemplate(tool, ecosystem, owner) {
  const tmpl = TEMPLATES[tool];
  if (!tmpl) return null;
  return { path: tmpl.path, content: tmpl.content(ecosystem || '', owner) };
}

export function validateFindings(findings) {
  if (!Array.isArray(findings)) {
    console.warn('validateFindings: findings is not an array');
    return [];
  }

  const valid = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') {
      console.warn('validateFindings: skipping non-object finding');
      continue;
    }
    if (f.type !== 'standards-gap') continue;
    if (!f.tool || typeof f.tool !== 'string') {
      console.warn(`validateFindings: skipping finding with missing/invalid tool`);
      continue;
    }
    if (!Array.isArray(f.nonCompliant)) {
      console.warn(`validateFindings: skipping finding with missing nonCompliant array (tool=${f.tool})`);
      continue;
    }
    valid.push(f);
  }
  return valid;
}

// Cap (repo, tool) pairs per tool: each tool keeps at most its own cap, which is
// the `apply-cap` override for that tool when set, else the global default. Order
// is preserved so the kept pairs match the input ordering. Pure function.
export function capPerTool(pairs, applyCap, globalCap) {
  // Coerce a configured cap to a positive integer; fall back to the global cap
  // for anything malformed (a non-numeric YAML typo, null, negative, zero), so a
  // bad config entry can never silently defer every PR for a tool.
  const toCap = (raw, fallback) => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  const globalEffective = toCap(globalCap, 5);
  const kept = [];
  const countByTool = {};
  for (const p of pairs) {
    const cap = toCap(applyCap?.[p.tool], globalEffective);
    const used = countByTool[p.tool] || 0;
    if (used < cap) {
      kept.push(p);
      countByTool[p.tool] = used + 1;
    }
  }
  return kept;
}

// A finding class is promoted onto the scheduled path when its `apply-schedule`
// value is boolean true. The hand-rolled YAML parser yields a real boolean for an
// unquoted `true`, but tolerate a quoted `'true'` string too — `capPerTool`
// already coerces stringy config values, so a quoting slip should not silently
// fail to promote a class (it errs strict, never loose). Pure function.
export function isScheduleAllowed(scheduleAllow, tool) {
  const v = scheduleAllow?.[tool];
  return v === true || v === 'true';
}

export async function applyGovernanceFindings(gh, owner, findings, config, options = {}) {
  const { dryRun, maxPerRun = 5, tools, scheduled } = options;

  // Require approval gate
  if (!config?.limits?.require_approval) {
    console.error('apply: config.limits.require_approval is not true — refusing to run');
    return { status: 'refused', reason: 'require_approval not set' };
  }

  // Build (repo, tool) pairs from validated findings.
  // The remediation.executor hint (ADR-007) is the authoritative actionability
  // signal: only `template` findings are opened as templated PRs here. A finding
  // with no remediation (a pre-contract snapshot) falls back to the prior
  // TEMPLATES-only behaviour, so this never regresses older data; an explicit
  // `agent`/`manual` executor is excluded even if its tool has a template.
  const validated = validateFindings(findings);
  const actionable = validated.filter(
    f => TEMPLATES[f.tool] && (f.remediation?.executor ?? 'template') === 'template'
  );

  // Stage 4 (ADR-007): the scheduled, no-human-at-dispatch path is default-closed.
  // A finding class runs on it only when explicitly promoted via an
  // `apply-schedule: { <tool>: true }` config entry. This is the per-finding-class
  // relaxation of ADR-005 gate 1 (workflow_dispatch-only) — opt-in and reversible.
  // Manual dispatch (`scheduled` falsy) is byte-identical to before: the full
  // actionable set, ignoring `apply-schedule` entirely.
  const scheduleAllow = config?.['apply-schedule'] || {};
  const scheduleGated = scheduled
    ? actionable.filter(f => isScheduleAllowed(scheduleAllow, f.tool))
    : actionable;
  if (scheduled) {
    const excluded = actionable.length - scheduleGated.length;
    if (excluded > 0) {
      console.log(`apply [scheduled]: ${excluded} actionable finding(s) excluded — tool not on the apply-schedule allow-list`);
    }
  }

  const filtered = tools ? scheduleGated.filter(f => tools.includes(f.tool)) : scheduleGated;
  const pairs = [];
  for (const f of filtered) {
    for (const repo of f.nonCompliant) {
      if (!REPO_NAME_PATTERN.test(repo)) {
        console.warn(`apply: skipping repo with invalid name: ${repo}`);
        continue;
      }
      pairs.push({ repo, tool: f.tool, ecosystem: f.repoEcosystems?.[repo] || null });
    }
  }

  // Per-tool cap (ADR-007 stage 3): each tool's blast radius is bounded
  // independently. A tool's cap is its `apply-cap` config override if present,
  // else the global maxPerRun — so an unlisted tool can never exceed the global
  // default without an explicit, reviewed config entry. This replaces the single
  // global slice; every other ADR-005 gate is unchanged.
  const applyCap = config?.['apply-cap'] || {};
  const capped = capPerTool(pairs, applyCap, maxPerRun);
  const deferred = pairs.length - capped.length;

  // Dry-run fail-closed: only literal false disables dry-run
  if (dryRun !== false) {
    console.log(`apply [DRY RUN]: would open PRs for ${capped.length} (repo, tool) pairs`);
    for (const p of capped) {
      console.log(`  - ${owner}/${p.repo}: ${p.tool}`);
    }
    if (deferred > 0) {
      console.log(`  ... ${deferred} more deferred to next run (per-tool cap)`);
    }
    return { status: 'dry-run', pairs: capped };
  }

  if (deferred > 0) {
    console.log(`apply: per-tool cap deferred ${deferred} (repo, tool) pair(s) to next run`);
  }

  const results = [];
  const BATCH_SIZE = 3;

  for (let i = 0; i < capped.length; i += BATCH_SIZE) {
    const batch = capped.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(pair => applyToRepo(gh, owner, pair.repo, pair.tool, pair.ecosystem).catch(err => {
        console.error(`apply: error on ${pair.repo}/${pair.tool}: ${err.message}`);
        return { repo: pair.repo, tool: pair.tool, status: 'error', error: err.message };
      }))
    );
    results.push(...batchResults);
  }

  const created = results.filter(r => r.status === 'created').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;
  console.log(`apply: done — ${created} PRs created, ${skipped} skipped, ${errors} errors`);

  return { status: 'completed', results, summary: { created, skipped, errors } };
}

async function applyToRepo(gh, owner, repo, tool, ecosystem) {
  const branchName = `repo-butler/apply-${tool}`;

  let existingPRs;
  try {
    existingPRs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
      params: { state: 'open', head: `${owner}:${branchName}`, per_page: 10 },
      max: 10,
    });
  } catch {
    existingPRs = [];
  }

  if (existingPRs.length > 0) {
    console.log(`apply: ${owner}/${repo} already has open PR for ${tool}, skipping`);
    return { repo, tool, status: 'skipped', reason: 'PR already open' };
  }

  const repoMeta = await gh.request(`/repos/${owner}/${repo}`);
  const defaultBranch = repoMeta.default_branch || 'main';

  const template = generateTemplate(tool, ecosystem, owner);
  if (!template) {
    return { repo, tool, status: 'skipped', reason: 'no template' };
  }

  const ref = await gh.request(`/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`);

  try {
    await gh.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branchName}`, sha: ref.object.sha },
    });
  } catch (err) {
    // 422 means the ref already exists — update it; rethrow anything else
    if (!err.message?.includes('422')) throw err;
    await gh.request(`/repos/${owner}/${repo}/git/refs/heads/${branchName}`, {
      method: 'PATCH',
      body: { sha: ref.object.sha, force: true },
    });
  }

  await gh.request(`/repos/${owner}/${repo}/contents/${template.path}`, {
    method: 'PUT',
    body: {
      message: `chore: add ${tool} configuration`,
      content: Buffer.from(template.content).toString('base64'),
      branch: branchName,
    },
  });

  // Open PR (labels must be added separately — the pulls API ignores them)
  const pr = await gh.request(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: {
      title: `chore: add ${tool} configuration`,
      head: branchName,
      base: defaultBranch,
      body: `## Governance: add ${tool}\n\nThis repo was identified as missing ${tool} configuration by the portfolio governance scan.\n\nThis PR adds the standard template. Review and merge when ready.${TOOL_PR_NOTES[tool] ? '\n\n> ' + TOOL_PR_NOTES[tool] : ''}\n\n---\n*Opened automatically by [Repo Butler](https://github.com/IsmaelMartinez/repo-butler)*`,
    },
  });

  // Add label via the issues endpoint (PRs are issues for labelling purposes)
  try {
    await gh.request(`/repos/${owner}/${repo}/issues/${pr.number}/labels`, {
      method: 'POST',
      body: { labels: ['governance-apply'] },
    });
  } catch {
    // Non-fatal: PR is open, label is cosmetic
  }

  console.log(`apply: ${owner}/${repo} — PR created: ${pr.html_url}`);
  return { repo, tool, status: 'created', pr: pr.html_url };
}

// --- Stale Dependabot PR nudge ----------------------------------------------
// A new cross-repo write action that rides the same five ADR-005 gates as the
// templated-PR path above (workflow_dispatch-only, dry-run fail-closed,
// require_approval, per-run cap, repo-name validation + dedup). It is a new
// action *type* behind the existing gate stack, not a relaxation of the trust
// model, so no ADR amendment is needed — only relaxing a gate would.
//
// For each `dependabot-stale` finding it nudges the single oldest stale PR per
// repo with one `@dependabot rebase` comment — a sequential canary (one PR per
// repo per run, most-stale first) per the maintainer's "rebase one at a time"
// preference. Rebasing refreshes the PR onto the latest base and re-runs CI,
// surfacing whether the dependency update is actually mergeable. No branch or
// file is written: the specialist tool (Dependabot) executes, the butler only
// orchestrates.
const NUDGE_BODY = '@dependabot rebase';
const NUDGE_DEDUP_DAYS = 7;

// From dependabot-stale findings, pick the single oldest stale PR per repo,
// validate the repo name, sort most-stale first, and cap. Pure function.
export function selectNudgeTargets(findings, maxPerRun = 5) {
  const cap = Number.isInteger(Number(maxPerRun)) && Number(maxPerRun) > 0 ? Number(maxPerRun) : 5;
  const targets = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || f.type !== 'dependabot-stale') continue;
    if (!f.repo || !REPO_NAME_PATTERN.test(f.repo)) {
      if (f.repo) console.warn(`nudge: skipping repo with invalid name: ${f.repo}`);
      continue;
    }
    if (!Array.isArray(f.stalePRs)) continue;
    // Findings are read from the persisted data branch, so guard against a
    // malformed entry (null, missing/non-numeric age, non-integer number)
    // before the reduce/sort — a bad element would otherwise throw or corrupt
    // the most-stale ordering with NaN comparisons.
    const validPRs = f.stalePRs.filter(
      pr => pr && Number.isInteger(pr.number) && typeof pr.age === 'number',
    );
    if (validPRs.length === 0) continue;
    const oldest = validPRs.reduce((a, b) => (b.age > a.age ? b : a));
    targets.push({ repo: f.repo, number: oldest.number, title: oldest.title, age: oldest.age });
  }
  targets.sort((a, b) => b.age - a.age);
  return targets.slice(0, cap);
}

// True if the PR already carries an `@dependabot rebase` comment newer than the
// dedup window, so consecutive dispatches do not double-comment. Fails open
// (returns false) if comments cannot be read — better to risk one duplicate
// nudge than to silently never nudge.
async function alreadyNudged(gh, owner, repo, number) {
  let comments;
  try {
    comments = await gh.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      params: { per_page: 100 },
      max: 100,
    });
  } catch {
    return false;
  }
  const cutoff = Date.now() - NUDGE_DEDUP_DAYS * 86400000;
  return Array.isArray(comments) && comments.some(
    c => c?.body?.trim() === NUDGE_BODY && c?.created_at && new Date(c.created_at).getTime() >= cutoff,
  );
}

export async function nudgeStaleDependabotPRs(gh, owner, findings, config, options = {}) {
  const { dryRun, maxPerRun = 5, scheduled } = options;

  // Gate 3: require_approval master switch.
  if (!config?.limits?.require_approval) {
    console.error('nudge: config.limits.require_approval is not true — refusing to run');
    return { status: 'refused', reason: 'require_approval not set' };
  }

  // Stage 4 (ADR-007): the nudge is a finding-class action like a templated PR,
  // so the same default-closed rule applies on the no-human scheduled path. It
  // runs on a scheduled dispatch only when promoted via
  // `apply-schedule: { dependabot-rebase: true }`. Manual dispatch is unaffected.
  if (scheduled && !isScheduleAllowed(config?.['apply-schedule'], 'dependabot-rebase')) {
    console.log('nudge [scheduled]: dependabot-rebase not on the apply-schedule allow-list — skipping');
    return { status: 'skipped-unscheduled', targets: [] };
  }

  // Gate 5 (repo-name validation) + gate 4 (per-run cap) applied here.
  const targets = selectNudgeTargets(findings, maxPerRun);

  // Gate 2: dry-run fail-closed — only literal false acts.
  if (dryRun !== false) {
    console.log(`nudge [DRY RUN]: would rebase ${targets.length} stale Dependabot PR(s)`);
    for (const t of targets) {
      console.log(`  - ${owner}/${t.repo}#${t.number} (${t.age}d): ${t.title}`);
    }
    return { status: 'dry-run', targets };
  }

  // Sequential canary: one PR at a time, never a parallel fan-out.
  const results = [];
  for (const t of targets) {
    try {
      if (await alreadyNudged(gh, owner, t.repo, t.number)) {
        console.log(`nudge: ${owner}/${t.repo}#${t.number} already nudged recently, skipping`);
        results.push({ repo: t.repo, number: t.number, status: 'skipped', reason: 'recent nudge' });
        continue;
      }
      await gh.request(`/repos/${owner}/${t.repo}/issues/${t.number}/comments`, {
        method: 'POST',
        body: { body: NUDGE_BODY },
      });
      console.log(`nudge: ${owner}/${t.repo}#${t.number} — rebase requested`);
      results.push({ repo: t.repo, number: t.number, status: 'nudged' });
    } catch (err) {
      console.error(`nudge: error on ${t.repo}#${t.number}: ${err.message}`);
      results.push({ repo: t.repo, number: t.number, status: 'error', error: err.message });
    }
  }

  const nudged = results.filter(r => r.status === 'nudged').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;
  console.log(`nudge: done — ${nudged} rebased, ${skipped} skipped, ${errors} errors`);
  return { status: 'completed', results, summary: { nudged, skipped, errors } };
}

// --- Copilot code review enablement (settings write, ADR-009) ----------------
// A PR-less settings write: enabling GitHub Copilot automatic code review is a
// `copilot_code_review` rule inside a repository ruleset, not a committed file,
// so it cannot ride the templated-PR path. This is a new action *type* behind the
// same five ADR-005 gates (require_approval, dry-run fail-closed, per-run cap,
// repo-name validation, workflow_dispatch-only) plus the three ADR-009 gates:
// additive/idempotent (one distinctively named ruleset, skip-if-already-enabled
// checked LIVE at apply time), scope-minimised (only the Copilot rule on the
// default branch — never blocks merges or restricts access), and a name-guarded
// revert path (removeCopilotReviewRuleset). Going live additionally requires the
// GitHub App to carry `administration: write` (broader than the PR path's token);
// until then the live write 403s and only the dry-run preview runs. See ADR-009.

export const COPILOT_RULESET_NAME = 'repo-butler/copilot-code-review';

// The exact ruleset payload — additive, scope-minimised to the default branch,
// carrying only the copilot_code_review rule. Pure. `~DEFAULT_BRANCH` is a
// GitHub-defined token (not a literal branch name) that targets each repo's own
// default branch, so the same payload is correct across the portfolio.
export function buildCopilotReviewRuleset() {
  return {
    name: COPILOT_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'copilot_code_review', parameters: { review_on_push: true, review_draft_pull_requests: false } },
    ],
  };
}

// From code-review-bot standards-gap findings, collect the non-compliant repos,
// validate names (gate 5), dedup, and cap (gate 4). Pure function.
export function selectCopilotReviewTargets(findings, maxPerRun = 5) {
  const cap = Number.isInteger(Number(maxPerRun)) && Number(maxPerRun) > 0 ? Number(maxPerRun) : 5;
  const repos = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || f.type !== 'standards-gap' || f.tool !== 'code-review-bot') continue;
    if (!Array.isArray(f.nonCompliant)) continue;
    for (const repo of f.nonCompliant) {
      if (!REPO_NAME_PATTERN.test(repo)) {
        console.warn(`copilot-review: skipping repo with invalid name: ${repo}`);
        continue;
      }
      if (!repos.includes(repo)) repos.push(repo);
    }
  }
  return repos.slice(0, cap);
}

export async function applyCopilotReviewRulesets(gh, owner, findings, config, options = {}) {
  const { dryRun, maxPerRun = 5, scheduled } = options;

  // Gate 3: require_approval master switch.
  if (!config?.limits?.require_approval) {
    console.error('copilot-review: config.limits.require_approval is not true — refusing to run');
    return { status: 'refused', reason: 'require_approval not set' };
  }

  // Stage 4 (ADR-007) / ADR-009: default-closed on the no-human scheduled path.
  // v1 ships with code-review-bot absent from the apply-schedule allow-list, so a
  // scheduled dispatch skips it until the track-record gate is met. Manual dispatch
  // is unaffected.
  if (scheduled && !isScheduleAllowed(config?.['apply-schedule'], 'code-review-bot')) {
    console.log('copilot-review [scheduled]: code-review-bot not on the apply-schedule allow-list — skipping');
    return { status: 'skipped-unscheduled', targets: [] };
  }

  // Gate 5 (repo-name validation) + gate 4 (per-run cap).
  const targets = selectCopilotReviewTargets(findings, maxPerRun);
  const ruleset = buildCopilotReviewRuleset();

  // Gate 2: dry-run fail-closed — only literal false acts. Preview the exact payload
  // (the audit/"see it before it lands" record that stands in for a PR diff).
  if (dryRun !== false) {
    console.log(`copilot-review [DRY RUN]: would create the "${COPILOT_RULESET_NAME}" ruleset on ${targets.length} repo(s)`);
    for (const repo of targets) console.log(`  - ${owner}/${repo}`);
    console.log(`  payload: ${JSON.stringify(ruleset)}`);
    return { status: 'dry-run', targets, ruleset };
  }

  // Sequential canary, one repo at a time — a new write type, so no parallel fan-out.
  const results = [];
  for (const repo of targets) {
    try {
      // Idempotency guard, LIVE at apply time (not the stale OBSERVE snapshot):
      // skip if an active Copilot-review ruleset already exists, so re-runs and
      // hand-enabled repos never get a duplicate.
      if (await hasActiveCopilotReviewRuleset(gh, owner, repo)) {
        console.log(`copilot-review: ${owner}/${repo} already has Copilot review, skipping`);
        results.push({ repo, status: 'skipped', reason: 'already enabled' });
        continue;
      }
      await gh.request(`/repos/${owner}/${repo}/rulesets`, { method: 'POST', body: ruleset });
      console.log(`copilot-review: ${owner}/${repo} — Copilot review ruleset created`);
      results.push({ repo, status: 'created' });
    } catch (err) {
      console.error(`copilot-review: error on ${repo}: ${err.message}`);
      results.push({ repo, status: 'error', error: err.message });
    }
  }

  const created = results.filter(r => r.status === 'created').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;
  console.log(`copilot-review: done — ${created} created, ${skipped} skipped, ${errors} errors`);
  return { status: 'completed', results, summary: { created, skipped, errors } };
}

// Find the butler's Copilot-review ruleset on a repo by its distinctive name.
// Returns the ruleset id, or null if absent / on error. Paginated.
export async function findButlerCopilotRuleset(gh, owner, repo) {
  let rulesets;
  try {
    rulesets = await gh.paginate(`/repos/${owner}/${repo}/rulesets`, { max: 200 });
  } catch {
    return null;
  }
  if (!Array.isArray(rulesets)) return null;
  const match = rulesets.find(rs => rs?.name === COPILOT_RULESET_NAME);
  return match ? match.id : null;
}

// Reversibility affordance (ADR-009): delete the butler's Copilot-review ruleset
// on a repo. Name-guarded twice — by the find above and by re-asserting the name
// from the ruleset detail at the delete boundary — so it can NEVER remove a
// maintainer's hand-created ruleset (ADR-005: each layer assumes the previous may
// have failed).
export async function removeCopilotReviewRuleset(gh, owner, repo) {
  try {
    const id = await findButlerCopilotRuleset(gh, owner, repo);
    if (id == null) return { repo, status: 'skipped', reason: 'no butler ruleset' };
    const detail = await gh.request(`/repos/${owner}/${repo}/rulesets/${id}`);
    if (detail?.name !== COPILOT_RULESET_NAME) {
      return { repo, status: 'skipped', reason: 'name mismatch — refusing to delete' };
    }
    await gh.request(`/repos/${owner}/${repo}/rulesets/${id}`, { method: 'DELETE' });
    console.log(`copilot-review: ${owner}/${repo} — Copilot review ruleset removed`);
    return { repo, status: 'removed' };
  } catch (err) {
    // Return a structured per-repo error rather than throwing, so a bulk rollback
    // across repos isolates one failure and continues (mirrors the apply path).
    console.error(`copilot-review: error removing ruleset on ${repo}: ${err.message}`);
    return { repo, status: 'error', error: err.message };
  }
}

// --- Selective auto-merge (ADR-007 stage 5) ----------------------------------
// The ONE deliberately-sanctioned autonomous merge in the project: the butler
// squash-merges its OWN templated governance-apply PRs — never human-authored
// PRs, never globally. (Distinct from the maintainer's standing "never merge
// autonomously" rule, which governs the assistant's handling of the maintainer's
// own PRs and is untouched.) It is opt-in per class via the `apply-automerge`
// allow-list (default empty), bounded to the deterministic template tools, and
// fires only when required CI is green. Merge happens in a RECONCILE pass on a
// later run, not at PR-open time: a freshly-opened apply PR has no CI result yet,
// so this finds already-open apply PRs whose CI has since gone green and
// squash-merges them (single clean revert commit). The merge SHA is recorded for
// audit/rollback.
//
// Gate model (ADR-005 + ADR-007 stage 5): require_approval=true is the master
// operating switch the whole apply system needs (false makes every apply action
// refuse, auto-merge included — so false is the system-wide kill switch). The
// auto-merge-specific kill switches are emptying the `apply-automerge` allow-list
// and disabling the scheduled workflow. (This corrects ADR-007's stage-5 wording,
// which framed require_approval=true as the kill switch; that is backwards and
// inconsistent with the open path — see the ADR-005 amendment.)

// A class is auto-merge eligible only when it is BOTH a deterministic template
// tool (a static-file generator in TEMPLATES) AND opt-in via apply-automerge.
// This excludes settings writes (code-review-bot), the nudge (dependabot-rebase),
// and every policy-drift / tier-uplift / agent / manual finding by construction.
// Tolerates a quoted 'true' like isScheduleAllowed. Pure function.
export function isAutoMergeAllowed(automergeAllow, tool) {
  const v = automergeAllow?.[tool];
  return (v === true || v === 'true') && Boolean(TEMPLATES[tool]);
}

export async function autoMergeGovernancePRs(gh, owner, findings, config, options = {}) {
  const { dryRun, maxPerRun = 5 } = options;

  // Master operating gate / system-wide kill switch (see header). Refuse unless
  // require_approval is true, exactly like every other apply action.
  if (!config?.limits?.require_approval) {
    console.error('automerge: config.limits.require_approval is not true — refusing to run');
    return { status: 'refused', reason: 'require_approval not set' };
  }

  const automergeAllow = config?.['apply-automerge'] || {};

  // Candidate (repo, tool) pairs from standards-gap findings whose tool is
  // auto-merge eligible (template ∩ allow-list) and whose executor is template.
  // A repo with an open apply PR is still listed nonCompliant until the PR merges
  // (observe detects the file on the default branch, which the PR has not yet
  // landed), so the nonCompliant lists are the correct candidate set.
  const validated = validateFindings(findings);
  const eligible = validated.filter(
    f => isAutoMergeAllowed(automergeAllow, f.tool)
      && (f.remediation?.executor ?? 'template') === 'template'
  );
  const candidates = [];
  for (const f of eligible) {
    for (const repo of f.nonCompliant) {
      if (!REPO_NAME_PATTERN.test(repo)) {
        console.warn(`automerge: skipping repo with invalid name: ${repo}`);
        continue;
      }
      candidates.push({ repo, tool: f.tool });
    }
  }

  // Same per-tool + global blast-radius cap as the open path (ADR-007 stage 3).
  const applyCap = config?.['apply-cap'] || {};
  const capped = capPerTool(candidates, applyCap, maxPerRun);

  if (capped.length === 0) {
    console.log('automerge: nothing eligible (empty apply-automerge allow-list or no candidate findings)');
    return { status: 'completed', results: [], summary: { merged: 0, skipped: 0, errors: 0 } };
  }

  const results = [];
  for (const { repo, tool } of capped) {
    try {
      const branchName = `repo-butler/apply-${tool}`;
      const prs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
        params: { state: 'open', head: `${owner}:${branchName}`, per_page: 10 },
        max: 10,
      }).catch(() => []);
      // Re-assert the head branch client-side, not just via the API `head:` filter:
      // this is a merge (write) path, so confirm the PR is actually on the butler's
      // `repo-butler/apply-<tool>` branch before merging, rather than trusting the
      // server-side filter to have returned only matching PRs.
      const pr = Array.isArray(prs) ? prs.find(p => p && p.number && p.head?.ref === branchName) : null;
      if (!pr) {
        results.push({ repo, tool, status: 'skipped', reason: 'no open apply PR' });
        continue;
      }

      // Preconditions: CI verifiably green AND GitHub reports the PR mergeable.
      // `mergeable` can be null while GitHub computes it — treated as not-ready
      // and skipped (not an error); it will be ready on a later reconcile pass.
      const headSha = pr.head?.sha;
      const ciGreen = headSha ? await gh.prCiGreen(owner, repo, headSha) : false;
      const detail = await gh.request(`/repos/${owner}/${repo}/pulls/${pr.number}`).catch(() => null);
      const mergeable = detail?.mergeable === true;
      if (!ciGreen || !mergeable) {
        results.push({ repo, tool, number: pr.number, status: 'skipped', reason: !ciGreen ? 'CI not green' : 'not mergeable' });
        continue;
      }

      // Dry-run fail-closed: report the merge set, perform no write.
      if (dryRun !== false) {
        results.push({ repo, tool, number: pr.number, status: 'would-merge', sha: headSha });
        continue;
      }

      const merge = await gh.mergePR(owner, repo, pr.number, { method: 'squash', sha: headSha });
      if (merge?.merged) {
        console.log(`automerge: ${owner}/${repo}#${pr.number} (${tool}) — squash-merged ${merge.sha}`);
        results.push({ repo, tool, number: pr.number, status: 'merged', mergeSha: merge.sha });
      } else {
        results.push({ repo, tool, number: pr.number, status: 'error', error: 'merge not confirmed' });
      }
    } catch (err) {
      console.error(`automerge: error on ${repo}/${tool}: ${err.message}`);
      results.push({ repo, tool, status: 'error', error: err.message });
    }
  }

  if (dryRun !== false) {
    const wouldMerge = results.filter(r => r.status === 'would-merge');
    console.log(`automerge [DRY RUN]: would squash-merge ${wouldMerge.length} green allow-listed PR(s)`);
    for (const r of wouldMerge) console.log(`  - ${owner}/${r.repo}#${r.number} (${r.tool})`);
    return {
      status: 'dry-run',
      results,
      summary: { merged: 0, skipped: results.filter(r => r.status === 'skipped').length, errors: 0, wouldMerge: wouldMerge.length },
    };
  }

  const merged = results.filter(r => r.status === 'merged').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;
  console.log(`automerge: done — ${merged} merged, ${skipped} skipped, ${errors} errors`);
  return { status: 'completed', results, summary: { merged, skipped, errors } };
}
