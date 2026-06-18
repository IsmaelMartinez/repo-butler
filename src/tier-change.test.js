import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectTierChanges } from './tier-change.js';

describe('detectTierChanges', () => {
  it('first run (no prior state) baselines current tiers and emits nothing', () => {
    const current = { a: 'gold', b: 'silver' };
    const r = detectTierChanges(current, null);
    assert.equal(r.isFirstRun, true);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.nextState, { a: 'gold', b: 'silver' });
  });

  it('treats undefined prior state the same as a first run', () => {
    const r = detectTierChanges({ a: 'gold' }, undefined);
    assert.equal(r.isFirstRun, true);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.nextState, { a: 'gold' });
  });

  it('emits nothing when tiers are unchanged', () => {
    const state = { a: 'gold', b: 'silver' };
    const r = detectTierChanges({ a: 'gold', b: 'silver' }, state);
    assert.equal(r.isFirstRun, false);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.nextState, { a: 'gold', b: 'silver' });
  });

  it('detects a single tier change with previous and new tier', () => {
    const r = detectTierChanges({ a: 'silver', b: 'silver' }, { a: 'gold', b: 'silver' });
    assert.deepEqual(r.changes, [{ repo: 'a', previousTier: 'gold', newTier: 'silver' }]);
    assert.deepEqual(r.nextState, { a: 'silver', b: 'silver' });
  });

  it('detects multiple simultaneous tier changes', () => {
    const r = detectTierChanges(
      { a: 'silver', b: 'gold', c: 'bronze' },
      { a: 'gold', b: 'silver', c: 'bronze' },
    );
    assert.deepEqual(
      r.changes.sort((x, y) => x.repo.localeCompare(y.repo)),
      [
        { repo: 'a', previousTier: 'gold', newTier: 'silver' },
        { repo: 'b', previousTier: 'silver', newTier: 'gold' },
      ],
    );
  });

  it('emits transitions to and from the none tier', () => {
    const up = detectTierChanges({ a: 'bronze' }, { a: 'none' });
    assert.deepEqual(up.changes, [{ repo: 'a', previousTier: 'none', newTier: 'bronze' }]);

    const down = detectTierChanges({ a: 'none' }, { a: 'bronze' });
    assert.deepEqual(down.changes, [{ repo: 'a', previousTier: 'bronze', newTier: 'none' }]);
  });

  it('baselines a newly-added repo without emitting a transition', () => {
    const r = detectTierChanges({ a: 'gold', b: 'silver' }, { a: 'gold' });
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.nextState, { a: 'gold', b: 'silver' });
  });

  it('prunes a repo that left the portfolio from the next state', () => {
    const r = detectTierChanges({ a: 'gold' }, { a: 'gold', b: 'silver' });
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.nextState, { a: 'gold' });
  });

  it('dedups across same-week re-runs once nextState is persisted', () => {
    const state = { a: 'gold' };
    const first = detectTierChanges({ a: 'silver' }, state);
    assert.deepEqual(first.changes, [{ repo: 'a', previousTier: 'gold', newTier: 'silver' }]);
    // Simulate the caller persisting nextState, then re-running on the same data.
    const second = detectTierChanges({ a: 'silver' }, first.nextState);
    assert.deepEqual(second.changes, []);
  });

  it('does not re-emit a reused repo name from a stale baseline (pruning)', () => {
    // `b` was silver, then left the portfolio: it is pruned from nextState.
    const left = detectTierChanges({ a: 'gold' }, { a: 'gold', b: 'silver' });
    assert.deepEqual(left.nextState, { a: 'gold' });
    // `b` is later reused at the same tier it once held. With the orphan pruned
    // it reads as a newcomer and is baselined silently, not suppressed.
    const reused = detectTierChanges({ a: 'gold', b: 'silver' }, left.nextState);
    assert.deepEqual(reused.changes, []);
    assert.deepEqual(reused.nextState, { a: 'gold', b: 'silver' });
  });

  it('ignores entries whose tier is not a known tier value', () => {
    const r = detectTierChanges({ a: 'gold', b: 'unknown', c: null }, { a: 'silver' });
    // `a` changed; `b`/`c` are not tiers, so they neither diff nor baseline.
    assert.deepEqual(r.changes, [{ repo: 'a', previousTier: 'silver', newTier: 'gold' }]);
    assert.deepEqual(r.nextState, { a: 'gold' });
  });

  it('handles an empty portfolio against a prior state (all orphaned)', () => {
    const r = detectTierChanges({}, { a: 'gold' });
    assert.equal(r.isFirstRun, false);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.nextState, {});
  });

  it('does not mutate the inputs', () => {
    const current = { a: 'silver' };
    const state = { a: 'gold' };
    detectTierChanges(current, state);
    assert.deepEqual(current, { a: 'silver' });
    assert.deepEqual(state, { a: 'gold' });
  });
});
