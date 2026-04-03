import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the module to test that it loads without errors.
// Full integration tests require a GitHub token.
describe('observe module', () => {
  it('exports observe and observePortfolio', async () => {
    const mod = await import('./observe.js');
    assert.equal(typeof mod.observe, 'function');
    assert.equal(typeof mod.observePortfolio, 'function');
  });

  it('exports computeBusFactor and computeTimeToCloseMedian', async () => {
    const mod = await import('./observe.js');
    assert.equal(typeof mod.computeBusFactor, 'function');
    assert.equal(typeof mod.computeTimeToCloseMedian, 'function');
  });
});

describe('computeBusFactor', () => {
  it('returns 1 for a single author', async () => {
    const { computeBusFactor } = await import('./observe.js');
    const prs = Array.from({ length: 10 }, () => ({ author: 'alice' }));
    assert.equal(computeBusFactor(prs), 1);
  });

  it('returns 1 for two authors split 50/50', async () => {
    const { computeBusFactor } = await import('./observe.js');
    const prs = [
      ...Array.from({ length: 5 }, () => ({ author: 'alice' })),
      ...Array.from({ length: 5 }, () => ({ author: 'bob' })),
    ];
    assert.equal(computeBusFactor(prs), 1);
  });

  it('returns 2 when two authors are needed to cover >= 50%', async () => {
    const { computeBusFactor } = await import('./observe.js');
    const prs = [
      ...Array.from({ length: 3 }, () => ({ author: 'alice' })),
      ...Array.from({ length: 3 }, () => ({ author: 'bob' })),
      ...Array.from({ length: 3 }, () => ({ author: 'charlie' })),
    ];
    assert.equal(computeBusFactor(prs), 2);
  });

  it('returns 1 for a heavily skewed distribution', async () => {
    const { computeBusFactor } = await import('./observe.js');
    const prs = [
      ...Array.from({ length: 8 }, () => ({ author: 'alice' })),
      { author: 'bob' },
      { author: 'charlie' },
    ];
    assert.equal(computeBusFactor(prs), 1);
  });

  it('returns 0 when all authors are bots', async () => {
    const { computeBusFactor } = await import('./observe.js');
    const prs = Array.from({ length: 10 }, () => ({ author: 'dependabot[bot]' }));
    assert.equal(computeBusFactor(prs), 0);
  });

  it('returns null when fewer than 5 human PRs', async () => {
    const { computeBusFactor } = await import('./observe.js');
    const prs = [
      ...Array.from({ length: 3 }, () => ({ author: 'alice' })),
      ...Array.from({ length: 2 }, () => ({ author: 'github-actions[bot]' })),
    ];
    assert.equal(computeBusFactor(prs), null);
  });

  it('filters bots and computes bus factor from human PRs only', async () => {
    const { computeBusFactor } = await import('./observe.js');
    const prs = [
      ...Array.from({ length: 8 }, () => ({ author: 'alice' })),
      ...Array.from({ length: 5 }, () => ({ author: 'bob' })),
      ...Array.from({ length: 10 }, () => ({ author: 'dependabot[bot]' })),
      ...Array.from({ length: 3 }, () => ({ author: 'app/github-actions' })),
    ];
    assert.equal(computeBusFactor(prs), 1);
  });

  it('returns null for an empty array', async () => {
    const { computeBusFactor } = await import('./observe.js');
    assert.equal(computeBusFactor([]), null);
  });
});

describe('computeTimeToCloseMedian', () => {
  it('returns null for an empty array', async () => {
    const { computeTimeToCloseMedian } = await import('./observe.js');
    assert.equal(computeTimeToCloseMedian([]), null);
  });

  it('returns null for null input', async () => {
    const { computeTimeToCloseMedian } = await import('./observe.js');
    assert.equal(computeTimeToCloseMedian(null), null);
  });

  it('returns null for undefined input', async () => {
    const { computeTimeToCloseMedian } = await import('./observe.js');
    assert.equal(computeTimeToCloseMedian(undefined), null);
  });

  it('returns correct median for a single issue', async () => {
    const { computeTimeToCloseMedian } = await import('./observe.js');
    const issues = [
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-06T00:00:00Z' },
    ];
    assert.deepEqual(computeTimeToCloseMedian(issues), { median_days: 5, sample_size: 1 });
  });

  it('returns correct median for an odd number of issues', async () => {
    const { computeTimeToCloseMedian } = await import('./observe.js');
    const issues = [
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-03T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-06T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-11T00:00:00Z' },
    ];
    assert.deepEqual(computeTimeToCloseMedian(issues), { median_days: 5, sample_size: 3 });
  });

  it('returns correct median for an even number of issues', async () => {
    const { computeTimeToCloseMedian } = await import('./observe.js');
    const issues = [
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-02T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-04T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-08T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-12T00:00:00Z' },
    ];
    assert.deepEqual(computeTimeToCloseMedian(issues), { median_days: 5, sample_size: 4 });
  });

  it('reports sample_size matching input length', async () => {
    const { computeTimeToCloseMedian } = await import('./observe.js');
    const issues = [
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-02T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-03T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-04T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-05T00:00:00Z' },
      { created_at: '2025-01-01T00:00:00Z', closed_at: '2025-01-06T00:00:00Z' },
    ];
    const result = computeTimeToCloseMedian(issues);
    assert.equal(result.sample_size, 5);
  });
});

describe('fetchCodeScanningAlerts', () => {
  it('returns structured alert counts on success', async () => {
    const { fetchCodeScanningAlerts } = await import('./observe.js');
    const gh = {
      request: async () => [
        { rule: { security_severity_level: 'critical' } },
        { rule: { security_severity_level: 'high' } },
        { rule: { security_severity_level: 'high' } },
        { rule: { security_severity_level: 'medium' } },
        { rule: { security_severity_level: 'low' } },
      ],
    };
    const result = await fetchCodeScanningAlerts(gh, 'owner', 'repo');
    assert.deepEqual(result, { count: 5, critical: 1, high: 2, medium: 1, low: 1, max_severity: 'critical' });
  });

  it('returns null for empty alert list with null max_severity', async () => {
    const { fetchCodeScanningAlerts } = await import('./observe.js');
    const gh = { request: async () => [] };
    const result = await fetchCodeScanningAlerts(gh, 'owner', 'repo');
    assert.deepEqual(result, { count: 0, critical: 0, high: 0, medium: 0, low: 0, max_severity: null });
  });

  it('returns null on 403', async () => {
    const { fetchCodeScanningAlerts } = await import('./observe.js');
    const gh = { request: async () => { throw new Error('403 Forbidden'); } };
    const result = await fetchCodeScanningAlerts(gh, 'owner', 'repo');
    assert.equal(result, null);
  });

  it('returns null on 404', async () => {
    const { fetchCodeScanningAlerts } = await import('./observe.js');
    const gh = { request: async () => { throw new Error('404 Not Found'); } };
    const result = await fetchCodeScanningAlerts(gh, 'owner', 'repo');
    assert.equal(result, null);
  });
});

describe('fetchSecretScanningAlerts', () => {
  it('returns structured alert count on success', async () => {
    const { fetchSecretScanningAlerts } = await import('./observe.js');
    const gh = {
      request: async () => [
        { number: 1 },
        { number: 2 },
        { number: 3 },
      ],
    };
    const result = await fetchSecretScanningAlerts(gh, 'owner', 'repo');
    assert.deepEqual(result, { count: 3 });
  });

  it('returns count of 0 for empty list', async () => {
    const { fetchSecretScanningAlerts } = await import('./observe.js');
    const gh = { request: async () => [] };
    const result = await fetchSecretScanningAlerts(gh, 'owner', 'repo');
    assert.deepEqual(result, { count: 0 });
  });

  it('returns null on 403', async () => {
    const { fetchSecretScanningAlerts } = await import('./observe.js');
    const gh = { request: async () => { throw new Error('403 Forbidden'); } };
    const result = await fetchSecretScanningAlerts(gh, 'owner', 'repo');
    assert.equal(result, null);
  });

  it('returns null on 404', async () => {
    const { fetchSecretScanningAlerts } = await import('./observe.js');
    const gh = { request: async () => { throw new Error('404 Not Found'); } };
    const result = await fetchSecretScanningAlerts(gh, 'owner', 'repo');
    assert.equal(result, null);
  });
});

describe('assess module', () => {
  it('exports assess', async () => {
    const mod = await import('./assess.js');
    assert.equal(typeof mod.assess, 'function');
  });

  it('returns no-changes when snapshot matches previous', async () => {
    const { assess } = await import('./assess.js');
    const snapshot = {
      summary: {
        open_issues: 5, blocked_issues: 1, awaiting_feedback: 2,
        recently_closed: 10, recently_merged_prs: 20,
        bot_prs: 5, human_prs: 15, unique_contributors: 3,
        releases: 2, latest_release: 'v1.0.0',
        top_open_labels: [], high_reaction_issues: [],
        stale_awaiting_feedback: [],
      },
      issues: {
        open: [{ number: 1, title: 'test', labels: [] }],
        recently_closed: [],
      },
      pull_requests: { recently_merged: [] },
      releases: [{ tag: 'v1.0.0' }],
    };
    const previous = JSON.parse(JSON.stringify(snapshot));

    const result = await assess({ snapshot, previousSnapshot: previous });
    assert.equal(result.diff.hasChanges, false);
    assert.equal(result.assessment, 'No changes detected since the previous observation.');
  });

  it('detects new issues', async () => {
    const { assess } = await import('./assess.js');
    const previous = {
      issues: { open: [], recently_closed: [] },
      pull_requests: { recently_merged: [] },
      releases: [],
    };
    const snapshot = {
      summary: {
        open_issues: 1, blocked_issues: 0, awaiting_feedback: 0,
        recently_closed: 0, recently_merged_prs: 0,
        bot_prs: 0, human_prs: 0, unique_contributors: 0,
        releases: 0, latest_release: 'none',
        top_open_labels: [], high_reaction_issues: [],
        stale_awaiting_feedback: [],
      },
      issues: {
        open: [{ number: 42, title: 'New bug', labels: ['bug'] }],
        recently_closed: [],
      },
      pull_requests: { recently_merged: [] },
      releases: [],
    };

    const result = await assess({ snapshot, previousSnapshot: previous });
    assert.equal(result.diff.hasChanges, true);
    assert.equal(result.diff.new_issues.length, 1);
    assert.equal(result.diff.new_issues[0].number, 42);
  });
});

describe('config module', () => {
  it('returns defaults when file does not exist', async () => {
    const { loadConfig } = await import('./config.js');
    const config = await loadConfig('/nonexistent/path.yml');
    assert.equal(config.roadmap.path, 'ROADMAP.md');
    assert.equal(config.limits.max_issues_per_run, 3);
    assert.equal(config.limits.require_approval, true);
  });
});

describe('ideate module', () => {
  it('parses structured ideas from LLM output', async () => {
    // Test the idea parsing by importing and calling ideate with a mock provider.
    const { ideate } = await import('./ideate.js');
    const mockProvider = {
      generate: async () => `Here are some ideas:

---IDEA---
TITLE: Add automated dependency updates
PRIORITY: high
LABELS: automation, dependencies
BODY: The project should set up Dependabot or Renovate to keep dependencies current.

This would reduce manual maintenance burden.
---END---

---IDEA---
TITLE: Improve test coverage
PRIORITY: medium
LABELS: testing
BODY: Current test coverage is low. Add unit tests for core modules.
---END---`,
    };

    const result = await ideate({
      snapshot: {
        repository: 'test/repo',
        meta: { stars: 100 },
        summary: {
          open_issues: 5, blocked_issues: 1, awaiting_feedback: 2,
          recently_closed: 10, recently_merged_prs: 20,
          bot_prs: 5, human_prs: 15, unique_contributors: 3,
          releases: 2, latest_release: 'v1.0.0',
          top_open_labels: [], high_reaction_issues: [],
          stale_awaiting_feedback: [],
        },
        issues: { open: [] },
        roadmap: null,
      },
      provider: mockProvider,
      config: { limits: { max_issues_per_run: 3 } },
    });

    assert.equal(result.ideas.length, 2);
    assert.equal(result.ideas[0].title, 'Add automated dependency updates');
    assert.equal(result.ideas[0].priority, 'high');
    assert.deepEqual(result.ideas[0].labels, ['automation', 'dependencies']);
    assert.equal(result.ideas[1].title, 'Improve test coverage');
  });
});

describe('input validation', () => {
  it('accepts valid owner/repo format', async () => {
    const { validateRepoFormat } = await import('./index.js');
    assert.doesNotThrow(() => validateRepoFormat('owner/repo'));
  });

  it('throws for repo format without slash', async () => {
    const { validateRepoFormat } = await import('./index.js');
    assert.throws(
      () => validateRepoFormat('just-repo-name'),
      /must be in "owner\/repo" format/,
    );
  });
});
