import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings, generateTemplate, applyGovernanceFindings } from './apply.js';

describe('validateFindings', () => {
  it('filters to standards-gap findings with tool and nonCompliant', () => {
    const input = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'] },
      { type: 'policy-drift', tool: 'x', nonCompliant: ['repo-b'] },
      { type: 'standards-gap', nonCompliant: ['repo-c'] }, // missing tool
      { type: 'standards-gap', tool: 'dependabot' }, // missing nonCompliant
      null,
      'string',
      { type: 'standards-gap', tool: 'dependabot', nonCompliant: ['repo-d'] },
    ];
    const result = validateFindings(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].tool, 'code-scanning');
    assert.equal(result[1].tool, 'dependabot');
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(validateFindings(null), []);
    assert.deepEqual(validateFindings('hello'), []);
    assert.deepEqual(validateFindings({}), []);
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
    const result = generateTemplate('dependabot', 'JavaScript');
    assert.equal(result.path, '.github/dependabot.yml');
    assert.ok(result.content.includes('package-ecosystem: "npm"'));
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
    assert.ok(result.content.includes('interval: "weekly"'));
  });

  it('generates dependabot template for Go', () => {
    const result = generateTemplate('dependabot', 'Go');
    assert.ok(result.content.includes('package-ecosystem: "gomod"'));
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
  });

  it('generates dependabot template for bare (no package manager)', () => {
    const result = generateTemplate('dependabot', '');
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
    assert.ok(!result.content.includes('package-ecosystem: "npm"'));
    assert.ok(!result.content.includes('package-ecosystem: "gomod"'));
  });

  it('returns null for unknown tool', () => {
    assert.equal(generateTemplate('secret-scanning', 'JavaScript'), null);
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
    { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], ecosystem: 'JavaScript' },
  ];
  const baseConfig = { limits: { require_approval: true } };

  it('skips repos with invalid names', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['valid-repo', 'bad repo!', '../evil'], ecosystem: 'JavaScript' },
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

  it('enforces batch cap', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'], ecosystem: 'JavaScript' },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false, maxPerRun: 3 });
    assert.equal(result.status, 'completed');
    const prCalls = calls.filter(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.equal(prCalls.length, 3);
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
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['fail-repo', 'ok-repo'], ecosystem: 'JavaScript' },
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
  });

  it('filters findings by tools option', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], ecosystem: 'JavaScript' },
      { type: 'standards-gap', tool: 'dependabot', nonCompliant: ['repo-b'], ecosystem: 'JavaScript' },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false, tools: ['dependabot'] });
    assert.equal(result.status, 'completed');
    const prCalls = calls.filter(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.equal(prCalls.length, 1);
    assert.ok(prCalls[0].path.includes('repo-b'));
  });
});
