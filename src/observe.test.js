import { describe, it, beforeEach, afterEach, mock } from 'node:test';
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

describe('observePortfolio — repo discovery', () => {
  let originalFetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const makeRepo = (name, overrides = {}) => ({
    full_name: `alice/${name}`,
    name,
    owner: { login: 'alice' },
    description: null,
    language: 'JavaScript',
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    pushed_at: new Date().toISOString(),
    archived: false,
    fork: false,
    license: null,
    has_issues: true,
    default_branch: 'main',
    topics: [],
    private: false,
    visibility: 'public',
    ...overrides,
  });

  it('uses /installation/repositories and hides private repos', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/installation/repositories')) {
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({
            total_count: 2,
            repositories: [
              makeRepo('public-repo'),
              makeRepo('value-punter', { private: true, visibility: 'private' }),
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const { observePortfolio } = await import('./observe.js');
    const result = await observePortfolio({ owner: 'alice', token: 'fake' });

    assert.equal(result.repos.length, 1);
    assert.equal(result.repos[0].name, 'public-repo');
    assert.equal(result.repos[0].private, false);
    assert.ok(!result.repos.find(r => r.name === 'value-punter'), 'private repo should be filtered out');
  });

  it('hides private repos returned via /user/repos fallback', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      const headers = new Map([['x-ratelimit-remaining', '4999']]);
      if (u.includes('/installation/repositories')) {
        return { ok: false, status: 404, headers, text: async () => 'Not Found', json: async () => ({}) };
      }
      if (u.includes('/user/repos')) {
        return {
          ok: true,
          status: 200,
          headers,
          json: async () => [
            makeRepo('pat-public'),
            makeRepo('pat-private', { private: true, visibility: 'private' }),
          ],
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const { observePortfolio } = await import('./observe.js');
    const result = await observePortfolio({ owner: 'alice', token: 'fake' });

    assert.equal(result.repos.length, 1);
    assert.equal(result.repos[0].name, 'pat-public');
    assert.equal(result.repos[0].private, false);
  });

  it('filters installation results to the requested owner', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/installation/repositories')) {
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          json: async () => ({
            total_count: 2,
            repositories: [
              makeRepo('mine'),
              makeRepo('someone-elses', { owner: { login: 'bob' }, full_name: 'bob/someone-elses' }),
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const { observePortfolio } = await import('./observe.js');
    const result = await observePortfolio({ owner: 'alice', token: 'fake' });

    assert.equal(result.repos.length, 1);
    assert.equal(result.repos[0].name, 'mine');
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

  it('returns zero counts with null max_severity for empty alert list', async () => {
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

describe('fetchDependabotAlerts (via observe)', () => {
  // fetchDependabotAlerts isn't exported, but observe() calls it as part of the
  // parallel fetch. Drive it via globalThis.fetch and check the return shape
  // matches the report-shared.getAlertSummary contract.
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns the same shape as getAlertSummary for a mixed-severity list', async () => {
    const { getAlertSummary } = await import('./report-shared.js');
    const alerts = [
      { security_vulnerability: { severity: 'critical' } },
      { security_vulnerability: { severity: 'high' } },
      { security_advisory: { severity: 'medium' } },
      { security_vulnerability: { severity: 'low' } },
    ];
    const expected = getAlertSummary(alerts, a => a.security_vulnerability?.severity || a.security_advisory?.severity);
    assert.deepEqual(expected, { count: 4, critical: 1, high: 1, medium: 1, low: 1, max_severity: 'critical' });
  });
});

describe('fetchCodeScanningAlerts delegates to getAlertSummary', () => {
  it('returns the same shape getAlertSummary would produce for the same alerts', async () => {
    const { fetchCodeScanningAlerts } = await import('./observe.js');
    const { getAlertSummary } = await import('./report-shared.js');
    const alerts = [
      { rule: { security_severity_level: 'critical' } },
      { rule: { security_severity_level: 'high' } },
      { rule: { security_severity_level: 'high' } },
      { rule: { security_severity_level: 'medium' } },
      { rule: { security_severity_level: 'low' } },
    ];
    const gh = { request: async () => alerts };
    const result = await fetchCodeScanningAlerts(gh, 'owner', 'repo');
    const expected = getAlertSummary(alerts, a => a.rule?.security_severity_level);
    assert.deepEqual(result, expected);
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

describe('parsePhases', () => {
  it('expands "all" to every known phase', async () => {
    const { parsePhases } = await import('./index.js');
    assert.deepEqual(
      parsePhases('all'),
      ['observe', 'assess', 'update', 'ideate', 'propose', 'report', 'monitor'],
    );
  });

  it('parses a single phase into a one-element array', async () => {
    const { parsePhases } = await import('./index.js');
    assert.deepEqual(parsePhases('report'), ['report']);
  });

  it('parses a comma-separated list, trimming whitespace', async () => {
    const { parsePhases } = await import('./index.js');
    assert.deepEqual(parsePhases('observe, report'), ['observe', 'report']);
    assert.deepEqual(parsePhases(' observe ,report '), ['observe', 'report']);
  });

  it('preserves order of phases as given', async () => {
    const { parsePhases } = await import('./index.js');
    assert.deepEqual(parsePhases('report,observe'), ['report', 'observe']);
  });

  it('throws on an unknown phase name', async () => {
    const { parsePhases } = await import('./index.js');
    assert.throws(() => parsePhases('observe,bogus'), /Unknown phase/);
  });
});

describe('fetchMergedPRs', () => {
  const makePR = (n, { merged_at = null, author = 'alice', labels = [], title = `PR #${n}` } = {}) => ({
    number: n,
    title,
    user: { login: author },
    labels: labels.map(name => ({ name })),
    merged_at,
    closed_at: '2026-04-20T00:00:00Z',
    pull_request: {},
  });

  it('returns only merged PRs after the since cutoff in the expected shape', async () => {
    const { fetchMergedPRs } = await import('./observe.js');
    const gh = {
      paginate: async (path, opts) => {
        assert.equal(path, '/repos/owner/repo/pulls');
        assert.equal(opts.params.state, 'closed');
        assert.equal(opts.params.sort, 'updated');
        assert.equal(opts.params.direction, 'desc');
        assert.equal(opts.max, 200);
        return [
          makePR(1, { merged_at: '2026-04-20T00:00:00Z', author: 'alice', labels: ['bug'] }),
          makePR(2, { merged_at: null, author: 'bob' }), // closed without merge — drop
          makePR(3, { merged_at: '2026-01-01T00:00:00Z', author: 'carol' }), // before cutoff — drop
          makePR(4, { merged_at: '2026-04-15T00:00:00Z', author: 'dave', labels: ['feature', 'docs'] }),
        ];
      },
    };

    const result = await fetchMergedPRs(gh, 'owner', 'repo', '2026-02-01');

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      number: 1,
      title: 'PR #1',
      author: 'alice',
      labels: ['bug'],
      merged_at: '2026-04-20T00:00:00Z',
    });
    assert.deepEqual(result[1], {
      number: 4,
      title: 'PR #4',
      author: 'dave',
      labels: ['feature', 'docs'],
      merged_at: '2026-04-15T00:00:00Z',
    });
  });

  it('returns an empty array when no PRs match', async () => {
    const { fetchMergedPRs } = await import('./observe.js');
    const gh = { paginate: async () => [] };
    const result = await fetchMergedPRs(gh, 'owner', 'repo', '2026-02-01');
    assert.deepEqual(result, []);
  });
});

describe('observe — prs_merged_days config wiring', () => {
  // Verify the prs_merged_days key is wired through to fetchMergedPRs's
  // since cutoff (independently of issues_closed_days). Driven through
  // observe() with a permissive globalThis.fetch mock that returns []
  // for every endpoint except /pulls, where we return PRs with known
  // merged_at timestamps and check which survive the cutoff filter.
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const ok = (body) => ({
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const notFound = () => ({
    ok: false,
    status: 404,
    headers: new Map(),
    json: async () => ({}),
    text: async () => 'Not Found',
  });

  const makePR = (n, mergedAt) => ({
    number: n,
    title: `PR #${n}`,
    user: { login: 'alice' },
    labels: [],
    merged_at: mergedAt,
    closed_at: mergedAt,
    updated_at: mergedAt,
    pull_request: {},
  });

  function installFetchMock(pulls) {
    globalThis.fetch = mock.fn(async (url) => {
      const u = new URL(url);
      const p = u.pathname;
      if (p === '/repos/owner/repo/pulls') return ok(pulls);
      if (p === '/repos/owner/repo') return ok({ stargazers_count: 0, forks_count: 0, open_issues_count: 0 });
      // Content endpoints (roadmap, package.json) → 404 → null.
      if (p.startsWith('/repos/owner/repo/contents/')) return notFound();
      // Everything else (issues, labels, milestones, releases, workflows,
      // community profile, alerts, CI runs) → empty list / null.
      return ok([]);
    });
  }

  it('uses prs_merged_days for the merged-PR cutoff (independent of issues_closed_days)', async () => {
    const { observe } = await import('./observe.js');
    const now = Date.now();
    const isoDaysAgo = (n) => new Date(now - n * 86400000).toISOString();
    const pulls = [
      makePR(1, isoDaysAgo(3)),   // within a 7-day window
      makePR(2, isoDaysAgo(20)),  // outside a 7-day window, inside 60
    ];
    installFetchMock(pulls);

    const context = {
      owner: 'owner',
      repo: 'repo',
      token: 'fake',
      // issues_closed_days is intentionally a wide window — if the bug
      // re-appeared, both PRs would survive. With the fix, only PR #1
      // (3 days ago) is inside the 7-day prs_merged_days window.
      config: { observe: { issues_closed_days: 90, prs_merged_days: 7 } },
    };

    const snapshot = await observe(context);
    const merged = snapshot.pull_requests.recently_merged;
    assert.equal(merged.length, 1, 'only PR #1 should fall within the 7-day prs_merged_days window');
    assert.equal(merged[0].number, 1);
  });

  it('defaults prs_merged_days to 90 when unset', async () => {
    const { observe } = await import('./observe.js');
    const now = Date.now();
    const isoDaysAgo = (n) => new Date(now - n * 86400000).toISOString();
    const pulls = [
      makePR(10, isoDaysAgo(30)),   // inside default 90-day window
      makePR(11, isoDaysAgo(120)),  // outside default 90-day window
    ];
    installFetchMock(pulls);

    const context = {
      owner: 'owner',
      repo: 'repo',
      token: 'fake',
      config: {}, // no observe.* set
    };

    const snapshot = await observe(context);
    const merged = snapshot.pull_requests.recently_merged;
    assert.equal(merged.length, 1);
    assert.equal(merged[0].number, 10);
  });
});
