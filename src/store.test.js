import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSnapshotHash } from './store.js';

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
});
