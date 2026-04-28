import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSnapshotHash, createStore } from './store.js';

// Minimal fake gh client for exercising prune behaviour through the public
// writePortfolioWeekly entry point. Records putFile/deleteFile calls so tests
// can assert which files were pruned and the commit message used.
function makeFakeGh({ existing = [], deleteThrows = false } = {}) {
  const files = new Set(existing);
  const calls = { put: [], delete: [] };
  return {
    files,
    calls,
    request: async (path) => {
      if (path.includes(`/branches/repo-butler-data`)) return { name: 'repo-butler-data' };
      throw new Error(`unexpected request ${path}`);
    },
    getFileContent: async () => null,
    putFile: async (_o, _r, path) => { calls.put.push(path); files.add(path.split('/').pop()); },
    listDir: async () => Array.from(files),
    deleteFile: async (_o, _r, path, opts) => {
      calls.delete.push({ path, message: opts.message });
      if (deleteThrows) throw new Error('boom');
    },
  };
}

const PORTFOLIO = {
  repos: [{ name: 'a', archived: false, fork: false, stars: 0, pushed_at: '2026-01-01T00:00:00Z', open_issues: 0 }],
};
const REPO_DETAILS = { a: { commits: 1, license: 'MIT', ci: 1, communityHealth: 80, vulns: null, ciPassRate: 1, released_at: '2026-01-01T00:00:00Z' } };

describe('computeSnapshotHash', () => {
  it('returns a consistent 64-char hex string', () => {
    const snapshot = { summary: { open_issues: 5, releases: 2 } };
    const hash = computeSnapshotHash(snapshot);
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
    // Same input produces same output.
    assert.equal(computeSnapshotHash(snapshot), hash);
  });

  it('produces different hashes for different summaries', () => {
    const a = computeSnapshotHash({ summary: { open_issues: 5 } });
    const b = computeSnapshotHash({ summary: { open_issues: 6 } });
    assert.notEqual(a, b);
  });

  it('handles null summary gracefully', () => {
    const hash = computeSnapshotHash({ summary: null });
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('handles missing summary gracefully', () => {
    const hash = computeSnapshotHash({});
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
    // Missing summary should produce the same hash as null summary.
    assert.equal(hash, computeSnapshotHash({ summary: null }));
  });

  it('handles null snapshot gracefully', () => {
    const hash = computeSnapshotHash(null);
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
  });

  it('ignores fields outside summary', () => {
    const a = computeSnapshotHash({ summary: { open_issues: 5 }, timestamp: '2026-01-01' });
    const b = computeSnapshotHash({ summary: { open_issues: 5 }, timestamp: '2026-03-20' });
    assert.equal(a, b);
  });

  it('produces different hashes when templateVersion differs', () => {
    const snapshot = { summary: { open_issues: 5 } };
    const a = computeSnapshotHash({ ...snapshot, _templateVersion: 'abc123' });
    const b = computeSnapshotHash({ ...snapshot, _templateVersion: 'def456' });
    assert.notEqual(a, b);
  });

  it('is backward compatible when no templateVersion provided', () => {
    const snapshot = { summary: { open_issues: 5 } };
    const withoutVersion = computeSnapshotHash(snapshot);
    const withEmptyVersion = computeSnapshotHash({ ...snapshot, _templateVersion: '' });
    assert.equal(withoutVersion, withEmptyVersion);
  });

  it('produces different hashes when dateBucket differs', () => {
    const snapshot = { summary: { open_issues: 5 } };
    const a = computeSnapshotHash({ ...snapshot, _dateBucket: '2026-04-08' });
    const b = computeSnapshotHash({ ...snapshot, _dateBucket: '2026-04-09' });
    assert.notEqual(a, b);
  });
});

describe('enrichPortfolioSummary', () => {
  it('adds computed tier data to a gold-level repo', async () => {
    const { enrichPortfolioSummary } = await import('./store.js');
    const summary = {
      open_issues: 0, open_bugs: 0, commits_6mo: 100, stars: 5, license: 'MIT',
      communityHealth: 90, ciPassRate: 0.98, vulns: { count: 0, max_severity: null },
      codeScanning: null, secretScanning: { count: 0 }, ci: 4,
      released_at: new Date().toISOString(), pushed_at: new Date().toISOString(),
    };
    const result = enrichPortfolioSummary(summary, 'test-repo', {});
    assert.ok(result.computed, 'should have computed field');
    assert.equal(result.computed.tier, 'gold');
    assert.ok(Array.isArray(result.computed.checks));
    assert.equal(result.computed.next_step, null);
  });

  it('shows next_step for non-gold repo', async () => {
    const { enrichPortfolioSummary } = await import('./store.js');
    const summary = {
      open_issues: 0, open_bugs: 0, commits_6mo: 10, stars: 0, license: null,
      communityHealth: 40, ciPassRate: null, vulns: null, codeScanning: null,
      secretScanning: null, ci: 0, released_at: null, pushed_at: new Date().toISOString(),
    };
    const result = enrichPortfolioSummary(summary, 'test-repo', {});
    assert.ok(result.computed.tier !== 'gold');
    assert.ok(result.computed.next_step !== null);
  });
});

describe('buildPortfolioSnapshot', () => {
  it('includes schema_version and computed tiers', async () => {
    const { buildPortfolioSnapshot } = await import('./store.js');
    const repos = [{ name: 'a', archived: false, fork: false, stars: 1, pushed_at: new Date().toISOString(), open_issues: 0 }];
    const details = { a: { open_issues: 0, open_bugs: 0, commits: 10, license: 'MIT', ci: 2, communityHealth: 80, vulns: null, ciPassRate: 0.9, released_at: new Date().toISOString() } };
    const snapshot = buildPortfolioSnapshot(repos, details, {});
    assert.equal(snapshot.schema_version, 'v1');
    assert.ok(snapshot.repos.a, 'should have repo a');
    assert.ok(snapshot.repos.a.computed, 'repo should have computed field');
    assert.ok(snapshot.repos.a.computed.tier);
  });

  it('skips archived and fork repos', async () => {
    const { buildPortfolioSnapshot } = await import('./store.js');
    const repos = [
      { name: 'active', archived: false, fork: false, stars: 0, pushed_at: new Date().toISOString(), open_issues: 0 },
      { name: 'archived', archived: true, fork: false, stars: 0, pushed_at: new Date().toISOString(), open_issues: 0 },
      { name: 'forked', archived: false, fork: true, stars: 0, pushed_at: new Date().toISOString(), open_issues: 0 },
    ];
    const details = { active: { commits: 5 }, archived: { commits: 1 }, forked: { commits: 1 } };
    const snapshot = buildPortfolioSnapshot(repos, details, {});
    assert.ok(snapshot.repos.active);
    assert.equal(snapshot.repos.archived, undefined);
    assert.equal(snapshot.repos.forked, undefined);
  });

  it('passes traffic through from details to the snapshot', async () => {
    const { buildPortfolioSnapshot } = await import('./store.js');
    const repos = [{ name: 'a', archived: false, fork: false, stars: 4500, pushed_at: new Date().toISOString(), open_issues: 0 }];
    const traffic = {
      views_14d: { count: 1234, uniques: 567 },
      clones_14d: { count: 89, uniques: 45 },
    };
    const details = { a: { commits: 10, license: 'MIT', ci: 2, communityHealth: 80, vulns: null, ciPassRate: 0.9, released_at: new Date().toISOString(), traffic } };
    const snapshot = buildPortfolioSnapshot(repos, details, {});
    assert.deepEqual(snapshot.repos.a.traffic, traffic);
  });

  it('stores null traffic when details omit it', async () => {
    const { buildPortfolioSnapshot } = await import('./store.js');
    const repos = [{ name: 'a', archived: false, fork: false, stars: 0, pushed_at: new Date().toISOString(), open_issues: 0 }];
    const details = { a: { commits: 1, license: 'MIT', ci: 1, communityHealth: 80, vulns: null, ciPassRate: 1, released_at: new Date().toISOString() } };
    const snapshot = buildPortfolioSnapshot(repos, details, {});
    assert.equal(snapshot.repos.a.traffic, null);
  });
});

describe('fetchTraffic', () => {
  it('returns normalised 14-day counts when both endpoints succeed', async () => {
    const { fetchTraffic } = await import('./report-portfolio.js');
    const calls = [];
    const fakeGh = {
      request: async (path) => {
        calls.push(path);
        if (path.endsWith('/traffic/views')) return { count: 200, uniques: 90, views: [] };
        if (path.endsWith('/traffic/clones')) return { count: 30, uniques: 12, clones: [] };
        throw new Error(`unexpected path ${path}`);
      },
    };
    const result = await fetchTraffic(fakeGh, 'owner', 'repo');
    assert.equal(calls.length, 2);
    assert.deepEqual(result, {
      views_14d: { count: 200, uniques: 90 },
      clones_14d: { count: 30, uniques: 12 },
    });
  });

  it('returns null when both endpoints fail (e.g. 403 from missing scope)', async () => {
    const { fetchTraffic } = await import('./report-portfolio.js');
    const fakeGh = {
      request: async () => { throw new Error('403 Forbidden'); },
    };
    const result = await fetchTraffic(fakeGh, 'owner', 'repo');
    assert.equal(result, null);
  });

  it('returns a partial object when only one endpoint fails', async () => {
    const { fetchTraffic } = await import('./report-portfolio.js');
    const fakeGh = {
      request: async (path) => {
        if (path.endsWith('/traffic/views')) return { count: 5, uniques: 3 };
        throw new Error('404 Not Found');
      },
    };
    const result = await fetchTraffic(fakeGh, 'owner', 'repo');
    assert.deepEqual(result, {
      views_14d: { count: 5, uniques: 3 },
      clones_14d: null,
    });
  });

  it('coerces missing count/uniques to 0 rather than undefined', async () => {
    const { fetchTraffic } = await import('./report-portfolio.js');
    const fakeGh = {
      request: async (path) => {
        if (path.endsWith('/traffic/views')) return {};
        if (path.endsWith('/traffic/clones')) return { count: 1 };
        return null;
      },
    };
    const result = await fetchTraffic(fakeGh, 'owner', 'repo');
    assert.deepEqual(result, {
      views_14d: { count: 0, uniques: 0 },
      clones_14d: { count: 1, uniques: 0 },
    });
  });
});

describe('enrichPortfolioSummary', () => {
  it('adds computed tier data to a gold-level repo', async () => {
    const { enrichPortfolioSummary } = await import('./store.js');
    const summary = {
      open_issues: 0, open_bugs: 0, commits_6mo: 100, stars: 5, license: 'MIT',
      communityHealth: 90, ciPassRate: 0.98, vulns: { count: 0, max_severity: null },
      codeScanning: null, secretScanning: { count: 0 }, ci: 4,
      released_at: new Date().toISOString(), pushed_at: new Date().toISOString(),
    };
    const result = enrichPortfolioSummary(summary, 'test-repo', {});
    assert.ok(result.computed, 'should have computed field');
    assert.equal(result.computed.tier, 'gold');
    assert.ok(Array.isArray(result.computed.checks));
    assert.equal(result.computed.next_step, null);
  });

  it('shows next_step for non-gold repo', async () => {
    const { enrichPortfolioSummary } = await import('./store.js');
    const summary = {
      open_issues: 0, open_bugs: 0, commits_6mo: 10, stars: 0, license: null,
      communityHealth: 40, ciPassRate: null, vulns: null, codeScanning: null,
      secretScanning: null, ci: 0, released_at: null, pushed_at: new Date().toISOString(),
    };
    const result = enrichPortfolioSummary(summary, 'test-repo', {});
    assert.ok(result.computed.tier !== 'gold');
    assert.ok(result.computed.next_step !== null);
  });
});

describe('buildPortfolioSnapshot', () => {
  it('includes schema_version and computed tiers', async () => {
    const { buildPortfolioSnapshot } = await import('./store.js');
    const repos = [{ name: 'a', archived: false, fork: false, stars: 1, pushed_at: new Date().toISOString(), open_issues: 0 }];
    const details = { a: { open_issues: 0, open_bugs: 0, commits: 10, license: 'MIT', ci: 2, communityHealth: 80, vulns: null, ciPassRate: 0.9, released_at: new Date().toISOString() } };
    const snapshot = buildPortfolioSnapshot(repos, details, {});
    assert.equal(snapshot.schema_version, 'v1');
    assert.ok(snapshot.repos.a, 'should have repo a');
    assert.ok(snapshot.repos.a.computed, 'repo should have computed field');
    assert.ok(snapshot.repos.a.computed.tier);
  });

  it('skips archived and fork repos', async () => {
    const { buildPortfolioSnapshot } = await import('./store.js');
    const repos = [
      { name: 'active', archived: false, fork: false, stars: 0, pushed_at: new Date().toISOString(), open_issues: 0 },
      { name: 'archived', archived: true, fork: false, stars: 0, pushed_at: new Date().toISOString(), open_issues: 0 },
      { name: 'forked', archived: false, fork: true, stars: 0, pushed_at: new Date().toISOString(), open_issues: 0 },
    ];
    const details = { active: { commits: 5 }, archived: { commits: 1 }, forked: { commits: 1 } };
    const snapshot = buildPortfolioSnapshot(repos, details, {});
    assert.ok(snapshot.repos.active);
    assert.equal(snapshot.repos.archived, undefined);
    assert.equal(snapshot.repos.forked, undefined);
  });
});

describe('pruneDir (via writePortfolioWeekly)', () => {
  it('only deletes the oldest files beyond MAX_WEEKLY_SNAPSHOTS', async () => {
    // 14 existing weekly files (sorted lexicographically by ISO week key); after
    // adding the new week, MAX is 12, so the 3 oldest should be pruned.
    const existing = Array.from({ length: 14 }, (_, i) => `2025-W${String(i + 1).padStart(2, '0')}.json`);
    const gh = makeFakeGh({ existing });
    const store = createStore({ owner: 'o', repo: 'r', token: 't', gh });

    await store.writePortfolioWeekly(PORTFOLIO, REPO_DETAILS, {});

    // 15 files now exist (14 existing + 1 new); 12 retained → 3 deleted, the 3 oldest by name.
    assert.equal(gh.calls.delete.length, 3);
    const deletedNames = gh.calls.delete.map(c => c.path.split('/').pop()).sort();
    assert.deepEqual(deletedNames, ['2025-W01.json', '2025-W02.json', '2025-W03.json']);
  });

  it('uses the supplied messagePrefix in the commit message', async () => {
    const existing = Array.from({ length: 12 }, (_, i) => `2025-W${String(i + 1).padStart(2, '0')}.json`);
    const gh = makeFakeGh({ existing });
    const store = createStore({ owner: 'o', repo: 'r', token: 't', gh });

    await store.writePortfolioWeekly(PORTFOLIO, REPO_DETAILS, {});

    assert.equal(gh.calls.delete.length, 1);
    assert.match(gh.calls.delete[0].message, /^chore: prune old portfolio snapshot /);
  });

  it('does not prune when file count is at or below the cap', async () => {
    // 11 existing + 1 new = 12, exactly at the cap, so no deletes.
    const existing = Array.from({ length: 11 }, (_, i) => `2025-W${String(i + 1).padStart(2, '0')}.json`);
    const gh = makeFakeGh({ existing });
    const store = createStore({ owner: 'o', repo: 'r', token: 't', gh });

    await store.writePortfolioWeekly(PORTFOLIO, REPO_DETAILS, {});

    assert.equal(gh.calls.delete.length, 0);
  });

  it('swallows delete errors so pruning never propagates failure', async () => {
    const existing = Array.from({ length: 14 }, (_, i) => `2025-W${String(i + 1).padStart(2, '0')}.json`);
    const gh = makeFakeGh({ existing, deleteThrows: true });
    const store = createStore({ owner: 'o', repo: 'r', token: 't', gh });

    // Should not throw despite every delete throwing.
    await store.writePortfolioWeekly(PORTFOLIO, REPO_DETAILS, {});
    assert.equal(gh.calls.delete.length, 3);
  });
});
