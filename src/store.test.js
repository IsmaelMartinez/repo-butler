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
});
