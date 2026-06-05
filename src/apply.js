// Governance apply: opens PRs on target repos to remediate standards-gap findings.
// Manual-dispatch only — never on cron. Reads findings from the data branch,
// validates shape, generates templated config files, and opens PRs.

import { REPO_NAME_PATTERN } from './safety.js';
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
    // PRs. No --squash: each repo uses its own default merge method (the exemplar
    // hardcodes --squash, which assumes squash merges are enabled). Takes effect
    // only once "Allow auto-merge" is enabled in repo settings and branch
    // protection requires status checks — documented as a PR prerequisite.
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
        run: gh pr merge --auto "$PR_URL"
`,
  },
};

// Tool-specific notes appended to the PR body. Used to document manual
// prerequisites the butler cannot perform itself.
const TOOL_PR_NOTES = {
  'dependabot-auto-merge': 'Prerequisites: this workflow only takes effect once **Allow auto-merge** is enabled in repo settings and branch protection requires status checks. The butler does not flip these settings (Phase 2).',
};

export function generateTemplate(tool, ecosystem) {
  const tmpl = TEMPLATES[tool];
  if (!tmpl) return null;
  return { path: tmpl.path, content: tmpl.content(ecosystem || '') };
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

export async function applyGovernanceFindings(gh, owner, findings, config, options = {}) {
  const { dryRun, maxPerRun = 5, tools } = options;

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
  const filtered = tools ? actionable.filter(f => tools.includes(f.tool)) : actionable;
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

  // Deduplication: check for existing open PR
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

  // Get default branch
  const repoMeta = await gh.request(`/repos/${owner}/${repo}`);
  const defaultBranch = repoMeta.default_branch || 'main';

  // Generate template
  const template = generateTemplate(tool, ecosystem);
  if (!template) {
    return { repo, tool, status: 'skipped', reason: 'no template' };
  }

  // Create branch from HEAD of default branch
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

  // Write template file via Contents API
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
  const { dryRun, maxPerRun = 5 } = options;

  // Gate 3: require_approval master switch.
  if (!config?.limits?.require_approval) {
    console.error('nudge: config.limits.require_approval is not true — refusing to run');
    return { status: 'refused', reason: 'require_approval not set' };
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
