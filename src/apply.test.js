import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings, generateTemplate, applyGovernanceFindings, capPerTool, selectNudgeTargets, nudgeStaleDependabotPRs } from './apply.js';

describe('validateFindings', () => {
  it('filters to standards-gap findings with tool and nonCompliant', () => {
    const input = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'] },
      { type: 'policy-drift', tool: 'x', nonCompliant: ['repo-b'] },
      { type: 'standards-gap', nonCompliant: ['repo-c'] }, // missing tool
      { type: 'standards-gap', tool: 'dependabot-actions' }, // missing nonCompliant
      null,
      'string',
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-d'] },
    ];
    const result = validateFindings(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].tool, 'code-scanning');
    assert.equal(result[1].tool, 'dependabot-actions');
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(validateFindings(null), []);
    assert.deepEqual(validateFindings('hello'), []);
    assert.deepEqual(validateFindings({}), []);
  });
});

describe('capPerTool', () => {
  const pairs = (tool, n) => Array.from({ length: n }, (_, i) => ({ repo: `${tool}-${i}`, tool }));

  it('applies the per-tool override when present', () => {
    const kept = capPerTool(pairs('code-scanning', 8), { 'code-scanning': 6 }, 5);
    assert.equal(kept.length, 6);
  });

  it('falls back to the global cap for an unlisted tool', () => {
    const kept = capPerTool(pairs('dependabot-actions', 8), { 'code-scanning': 6 }, 5);
    assert.equal(kept.length, 5);
  });

  it('caps each tool independently and preserves order', () => {
    const mixed = [...pairs('a', 3), ...pairs('b', 3)];
    const kept = capPerTool(mixed, { a: 1, b: 2 }, 5);
    assert.equal(kept.filter(p => p.tool === 'a').length, 1);
    assert.equal(kept.filter(p => p.tool === 'b').length, 2);
    assert.equal(kept[0].repo, 'a-0', 'order preserved');
  });

  it('treats a missing applyCap map as all-global', () => {
    assert.equal(capPerTool(pairs('x', 9), undefined, 4).length, 4);
  });

  it('coerces a stringified numeric cap', () => {
    assert.equal(capPerTool(pairs('code-scanning', 8), { 'code-scanning': '6' }, 5).length, 6);
  });

  it('falls back to the global cap for a malformed cap value', () => {
    assert.equal(capPerTool(pairs('code-scanning', 8), { 'code-scanning': 'invalid' }, 5).length, 5);
    assert.equal(capPerTool(pairs('code-scanning', 8), { 'code-scanning': 0 }, 5).length, 5);
    assert.equal(capPerTool(pairs('code-scanning', 8), { 'code-scanning': -3 }, 5).length, 5);
  });
});

describe('generateTemplate', () => {
  it('generates code-scanning template for JavaScript ecosystem', () => {
    const result = generateTemplate('code-scanning', 'JavaScript');
    assert.equal(result.path, '.github/workflows/codeql-analysis.yml');
    assert.ok(result.content.includes('languages: javascript-typescript'));
    assert.ok(result.content.includes('github/codeql-action/init@v3'));
    assert.ok(result.content.includes('github/codeql-action/analyze@v3'));
  });

  it('generates code-scanning template for Go ecosystem', () => {
    const result = generateTemplate('code-scanning', 'Go');
    assert.equal(result.path, '.github/workflows/codeql-analysis.yml');
    assert.ok(result.content.includes('languages: go'));
  });

  it('generates code-scanning template with default language for unknown ecosystem', () => {
    const result = generateTemplate('code-scanning', 'Rust');
    assert.ok(result.content.includes('languages: javascript-typescript'));
  });

  it('generates dependabot template for JavaScript', () => {
    const result = generateTemplate('dependabot-actions', 'JavaScript');
    assert.equal(result.path, '.github/dependabot.yml');
    assert.ok(result.content.includes('package-ecosystem: "npm"'));
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
    assert.ok(result.content.includes('interval: "weekly"'));
  });

  it('generates dependabot template for Go', () => {
    const result = generateTemplate('dependabot-actions', 'Go');
    assert.ok(result.content.includes('package-ecosystem: "gomod"'));
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
  });

  it('generates dependabot template for bare (no package manager)', () => {
    const result = generateTemplate('dependabot-actions', '');
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
    assert.ok(!result.content.includes('package-ecosystem: "npm"'));
    assert.ok(!result.content.includes('package-ecosystem: "gomod"'));
  });

  it('generates a generic issue-form template (ecosystem-agnostic)', () => {
    const result = generateTemplate('issue-form-templates', 'JavaScript');
    assert.equal(result.path, '.github/ISSUE_TEMPLATE/bug_report.yml');
    assert.ok(result.content.includes('name: Bug Report'));
    assert.ok(result.content.includes('type: textarea'));
    // Identical regardless of ecosystem — a generic form, not language-keyed.
    assert.equal(generateTemplate('issue-form-templates', 'Go').content, result.content);
  });

  it('generates a dependabot-auto-merge workflow (ecosystem-agnostic, explicit --squash)', () => {
    const result = generateTemplate('dependabot-auto-merge', 'JavaScript');
    assert.equal(result.path, '.github/workflows/dependabot-auto-merge.yml');
    assert.ok(result.content.includes('dependabot/fetch-metadata@v3'));
    assert.ok(result.content.includes("version-update:semver-major"));
    // gh pr merge --auto needs an explicit method: it errors ("you must specify a
    // merge method") on repos with more than one merge method enabled (the default).
    assert.ok(result.content.includes('gh pr merge --auto --squash'));
    // Identical regardless of ecosystem — a single generic workflow.
    assert.equal(generateTemplate('dependabot-auto-merge', 'Go').content, result.content);
  });

  it('returns null for unknown tool', () => {
    assert.equal(generateTemplate('secret-scanning', 'JavaScript'), null);
  });

  it('dependabot-actions tool name (governance emits this) resolves a template', () => {
    const result = generateTemplate('dependabot-actions', 'JavaScript');
    assert.notEqual(result, null);
    assert.equal(result.path, '.github/dependabot.yml');
    assert.ok(result.content.includes('package-ecosystem: "npm"'));
  });
});

describe('applyGovernanceFindings', () => {
  let calls;
  let mockGh;

  beforeEach(() => {
    calls = [];
    mockGh = {
      request: async (path, opts) => {
        calls.push({ type: 'request', path, opts });
        if (path.includes('/pulls') && opts?.method === 'POST') {
          return { number: 1, html_url: `https://github.com/owner/repo/pull/1` };
        }
        if (path.includes('/repos/') && !path.includes('/git/') && !path.includes('/contents/') && !path.includes('/pulls')) {
          return { default_branch: 'main' };
        }
        if (path.includes('/git/ref/')) {
          return { object: { sha: 'abc123' } };
        }
        if (path.includes('/git/refs') && opts?.method === 'POST') {
          return {};
        }
        if (path.includes('/contents/')) {
          return { sha: 'file123' };
        }
        return {};
      },
      paginate: async (path, opts) => {
        calls.push({ type: 'paginate', path, opts });
        return [];
      },
    };
  });

  const baseFindings = [
    { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
  ];
  const baseConfig = { limits: { require_approval: true } };

  it('skips repos with invalid names', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['valid-repo', 'bad repo!', '../evil'], repoEcosystems: { 'valid-repo': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    // Only valid-repo should have been processed
    const prCalls = calls.filter(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.equal(prCalls.length, 1);
    assert.ok(prCalls[0].path.includes('valid-repo'));
  });

  it('dry-run mode makes no API calls', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(calls.length, 0);
  });

  it('dry-run fail-closed: empty string is still dry-run', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, baseConfig, { dryRun: '' });
    assert.equal(result.status, 'dry-run');
    assert.equal(calls.length, 0);
  });

  it('dry-run fail-closed: undefined is still dry-run', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, baseConfig, {});
    assert.equal(result.status, 'dry-run');
    assert.equal(calls.length, 0);
  });

  it('refuses to run when require_approval is false', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, { limits: { require_approval: false } }, { dryRun: false });
    assert.equal(result.status, 'refused');
    assert.equal(calls.length, 0);
  });

  it('refuses to run when config.limits is missing', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, {}, { dryRun: false });
    assert.equal(result.status, 'refused');
    assert.equal(calls.length, 0);
  });

  it('treats a dependabot-auto-merge standards-gap as actionable (produces a pair)', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-auto-merge', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].repo, 'repo-a');
    assert.equal(result.pairs[0].tool, 'dependabot-auto-merge');
  });

  it('documents the auto-merge prerequisite in the opened PR body', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-auto-merge', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    const prCall = calls.find(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.ok(prCall, 'a PR should have been opened');
    assert.ok(prCall.opts.body.body.includes('Allow auto-merge'), 'PR body should carry the auto-merge prerequisite note');
    assert.ok(prCall.opts.body.body.includes('Phase 2'), 'PR body should note repo-settings management is deferred');
  });

  it('enforces batch cap', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'], repoEcosystems: { r1: 'JavaScript', r2: 'JavaScript', r3: 'JavaScript', r4: 'JavaScript', r5: 'JavaScript', r6: 'JavaScript', r7: 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false, maxPerRun: 3 });
    assert.equal(result.status, 'completed');
    const prCalls = calls.filter(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.equal(prCalls.length, 3);
  });

  it('honours a per-tool apply-cap override above the global cap', async () => {
    const repos = Array.from({ length: 8 }, (_, i) => `r${i + 1}`);
    const ecos = Object.fromEntries(repos.map(r => [r, 'JavaScript']));
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: repos, repoEcosystems: ecos },
    ];
    const config = { limits: { require_approval: true }, 'apply-cap': { 'code-scanning': 7 } };
    // global maxPerRun is 5, but the override lifts code-scanning to 7
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, config, { dryRun: true, maxPerRun: 5 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 7);
  });

  it('falls back to the global cap for a tool with no override (backstop holds)', async () => {
    const repos = Array.from({ length: 8 }, (_, i) => `r${i + 1}`);
    const ecos = Object.fromEntries(repos.map(r => [r, 'JavaScript']));
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: repos, repoEcosystems: ecos },
    ];
    // apply-cap only overrides code-scanning; dependabot-actions uses global 5
    const config = { limits: { require_approval: true }, 'apply-cap': { 'code-scanning': 7 } };
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, config, { dryRun: true, maxPerRun: 5 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 5);
  });

  it('caps two tools independently in one run', async () => {
    const csRepos = ['c1', 'c2', 'c3', 'c4'];
    const daRepos = ['d1', 'd2', 'd3', 'd4'];
    const ecos = Object.fromEntries([...csRepos, ...daRepos].map(r => [r, 'JavaScript']));
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: csRepos, repoEcosystems: ecos },
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: daRepos, repoEcosystems: ecos },
    ];
    const config = { limits: { require_approval: true }, 'apply-cap': { 'code-scanning': 3, 'dependabot-actions': 2 } };
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, config, { dryRun: true, maxPerRun: 5 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.filter(p => p.tool === 'code-scanning').length, 3);
    assert.equal(result.pairs.filter(p => p.tool === 'dependabot-actions').length, 2);
  });

  it('default behaviour is unchanged when no apply-cap is configured', async () => {
    const repos = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    const ecos = Object.fromEntries(repos.map(r => [r, 'JavaScript']));
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: repos, repoEcosystems: ecos },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true, maxPerRun: 5 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 5);
  });

  it('skips repos with existing open PR (dedup)', async () => {
    const deduplicatingGh = {
      ...mockGh,
      paginate: async (path, opts) => {
        calls.push({ type: 'paginate', path, opts });
        // Simulate existing PR for repo-a
        if (path.includes('repo-a')) {
          return [{ number: 42, html_url: 'https://github.com/owner/repo-a/pull/42' }];
        }
        return [];
      },
    };
    const result = await applyGovernanceFindings(deduplicatingGh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.equal(result.results[0].status, 'skipped');
    assert.equal(result.results[0].reason, 'PR already open');
  });

  it('handles per-repo error without aborting batch', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['fail-repo', 'ok-repo'], repoEcosystems: { 'fail-repo': 'JavaScript', 'ok-repo': 'JavaScript' } },
    ];
    let callCount = 0;
    const errorGh = {
      request: async (path, opts) => {
        calls.push({ type: 'request', path, opts });
        // Fail on the first repo's metadata lookup
        if (path === '/repos/owner/fail-repo' && !opts?.method) {
          throw new Error('403 Forbidden');
        }
        if (path.includes('/pulls') && opts?.method === 'POST') {
          return { number: 1, html_url: 'https://github.com/owner/ok-repo/pull/1' };
        }
        if (path.includes('/repos/') && !path.includes('/git/') && !path.includes('/contents/') && !path.includes('/pulls')) {
          return { default_branch: 'main' };
        }
        if (path.includes('/git/ref/')) {
          return { object: { sha: 'abc123' } };
        }
        if (path.includes('/git/refs') && opts?.method === 'POST') {
          return {};
        }
        if (path.includes('/contents/')) {
          return { sha: 'file123' };
        }
        return {};
      },
      paginate: async (path, opts) => {
        calls.push({ type: 'paginate', path, opts });
        return [];
      },
    };

    const result = await applyGovernanceFindings(errorGh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].status, 'error');
    assert.equal(result.results[1].status, 'created');
    assert.deepEqual(result.summary, { created: 1, skipped: 0, errors: 1 });
  });

  it('filters findings by tools option', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-b'], repoEcosystems: { 'repo-b': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false, tools: ['dependabot-actions'] });
    assert.equal(result.status, 'completed');
    const prCalls = calls.filter(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.equal(prCalls.length, 1);
    assert.ok(prCalls[0].path.includes('repo-b'));
  });

  it('treats a dependabot-actions finding as actionable (not filtered out)', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-b'], repoEcosystems: { 'repo-b': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true, tools: ['dependabot-actions'] });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].repo, 'repo-b');
    assert.equal(result.pairs[0].tool, 'dependabot-actions');
  });

  it('excludes findings whose remediation.executor is not template', async () => {
    const findings = [
      // templatable tool but explicitly routed to an agent — must NOT be auto-applied
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' }, remediation: { executor: 'agent' } },
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-b'], repoEcosystems: { 'repo-b': 'JavaScript' }, remediation: { executor: 'template' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'only the template finding is actionable');
    assert.equal(result.pairs[0].repo, 'repo-b');
    assert.equal(result.pairs[0].tool, 'dependabot-actions');
  });

  it('falls back to actionable when a finding has no remediation (pre-contract snapshot)', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'absent remediation falls back to TEMPLATES-only behaviour');
  });

  it('now actions an issue-form-templates finding routed to template', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'issue-form-templates', nonCompliant: ['repo-c'], remediation: { executor: 'template' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'issue-form-templates is now an actionable template tool');
    assert.equal(result.pairs[0].tool, 'issue-form-templates');
  });
});

describe('selectNudgeTargets', () => {
  it('picks the single oldest stale PR per repo, most-stale first', () => {
    const findings = [
      { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [{ number: 1, title: 'bump x', age: 40 }, { number: 2, title: 'bump y', age: 70 }] },
      { type: 'dependabot-stale', repo: 'repo-b', stalePRs: [{ number: 3, title: 'bump z', age: 35 }] },
    ];
    const targets = selectNudgeTargets(findings, 5);
    assert.equal(targets.length, 2);
    // repo-a's oldest (70d, #2) comes before repo-b (35d), one per repo
    assert.deepEqual(targets.map(t => `${t.repo}#${t.number}`), ['repo-a#2', 'repo-b#3']);
  });

  it('caps to maxPerRun', () => {
    const findings = Array.from({ length: 8 }, (_, i) => ({
      type: 'dependabot-stale', repo: `repo-${i}`, stalePRs: [{ number: i + 1, title: 't', age: 31 + i }],
    }));
    const targets = selectNudgeTargets(findings, 3);
    assert.equal(targets.length, 3);
    // most-stale first: ages 38, 37, 36 → repo-7, repo-6, repo-5
    assert.deepEqual(targets.map(t => t.repo), ['repo-7', 'repo-6', 'repo-5']);
  });

  it('skips invalid repo names and non-dependabot-stale findings', () => {
    const findings = [
      { type: 'dependabot-stale', repo: '../evil', stalePRs: [{ number: 1, title: 't', age: 99 }] },
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-x'] },
      { type: 'dependabot-stale', repo: 'good-repo', stalePRs: [{ number: 5, title: 't', age: 33 }] },
    ];
    const targets = selectNudgeTargets(findings, 5);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].repo, 'good-repo');
  });

  it('ignores findings with empty or missing stalePRs', () => {
    const findings = [
      { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [] },
      { type: 'dependabot-stale', repo: 'repo-b' },
    ];
    assert.equal(selectNudgeTargets(findings, 5).length, 0);
  });

  it('tolerates null/malformed entries in stalePRs without throwing', () => {
    const findings = [
      { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [null, { title: 'no number', age: 50 }, { number: 9, title: 'ok', age: 40 }] },
      { type: 'dependabot-stale', repo: 'repo-b', stalePRs: [{ number: 2, title: 'bad age', age: 'old' }] },
    ];
    const targets = selectNudgeTargets(findings, 5);
    // repo-a keeps only the well-formed PR (#9); repo-b has no valid PR
    assert.deepEqual(targets.map(t => `${t.repo}#${t.number}`), ['repo-a#9']);
  });
});

describe('nudgeStaleDependabotPRs', () => {
  const baseConfig = { limits: { require_approval: true } };
  const baseFindings = [
    { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [{ number: 7, title: 'bump lodash', age: 45 }] },
  ];

  function mkGh(comments = []) {
    const calls = [];
    const gh = {
      request: async (path, opts) => { calls.push({ path, opts }); return {}; },
      paginate: async (path) => { calls.push({ path }); return comments; },
    };
    return { gh, calls };
  }

  it('refuses to run when require_approval is not set', async () => {
    const { gh, calls } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, { limits: {} }, { dryRun: false });
    assert.equal(result.status, 'refused');
    assert.equal(calls.length, 0);
  });

  it('dry-run makes no API calls and lists targets', async () => {
    const { gh, calls } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.targets.length, 1);
    assert.equal(calls.length, 0);
  });

  it('dry-run fail-closed: undefined dryRun stays dry-run', async () => {
    const { gh } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, {});
    assert.equal(result.status, 'dry-run');
  });

  it('posts a single @dependabot rebase comment when live', async () => {
    const { gh, calls } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.summary, { nudged: 1, skipped: 0, errors: 0 });
    const posted = calls.find(c => c.opts?.method === 'POST');
    assert.ok(posted.path.includes('/repos/owner/repo-a/issues/7/comments'));
    assert.equal(posted.opts.body.body, '@dependabot rebase');
  });

  it('skips a PR already nudged within the dedup window', async () => {
    const recent = new Date(Date.now() - 2 * 86400000).toISOString();
    const { gh, calls } = mkGh([{ body: '@dependabot rebase', created_at: recent }]);
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.results[0].status, 'skipped');
    assert.equal(result.results[0].reason, 'recent nudge');
    assert.equal(calls.filter(c => c.opts?.method === 'POST').length, 0);
  });

  it('re-nudges when the prior nudge is older than the dedup window', async () => {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const { gh } = mkGh([{ body: '@dependabot rebase', created_at: old }]);
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.results[0].status, 'nudged');
  });

  it('records a per-PR error without aborting the run', async () => {
    const calls = [];
    const gh = {
      request: async (path, opts) => { calls.push({ path, opts }); throw new Error('403 Forbidden'); },
      paginate: async () => [],
    };
    const findings = [
      { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [{ number: 7, title: 't', age: 45 }] },
      { type: 'dependabot-stale', repo: 'repo-b', stalePRs: [{ number: 9, title: 't', age: 40 }] },
    ];
    const result = await nudgeStaleDependabotPRs(gh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.equal(result.summary.errors, 2);
    assert.equal(result.results.length, 2);
  });
});
