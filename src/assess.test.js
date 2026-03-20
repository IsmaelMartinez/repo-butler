import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrends } from './assess.js';

describe('computeTrends', () => {
  it('returns stable with empty weeks for empty array', () => {
    const result = computeTrends([]);
    assert.deepEqual(result.weeks, []);
    assert.equal(result.direction, 'stable');
  });

  it('returns stable with empty weeks for null input', () => {
    const result = computeTrends(null);
    assert.deepEqual(result.weeks, []);
    assert.equal(result.direction, 'stable');
  });

  it('returns stable direction for a single week', () => {
    const snapshots = [{
      _week: '2026-W10',
      summary: { open_issues: 5, recently_merged_prs: 3 },
      releases: [{ tag: 'v1.0.0' }],
    }];
    const result = computeTrends(snapshots);
    assert.equal(result.weeks.length, 1);
    assert.equal(result.direction, 'stable');
    assert.equal(result.weeks[0].week, '2026-W10');
    assert.equal(result.weeks[0].open_issues, 5);
    assert.equal(result.weeks[0].merged_prs, 3);
    assert.equal(result.weeks[0].releases, 1);
  });

  it('detects growing direction when open issues increase', () => {
    const snapshots = [
      { _week: '2026-W08', summary: { open_issues: 3, recently_merged_prs: 2 }, releases: [] },
      { _week: '2026-W09', summary: { open_issues: 5, recently_merged_prs: 4 }, releases: [] },
      { _week: '2026-W10', summary: { open_issues: 8, recently_merged_prs: 1 }, releases: [{ tag: 'v1.1' }] },
    ];
    const result = computeTrends(snapshots);
    assert.equal(result.weeks.length, 3);
    assert.equal(result.direction, 'growing');
    assert.equal(result.weeks[0].open_issues, 3);
    assert.equal(result.weeks[2].open_issues, 8);
  });

  it('detects shrinking direction when open issues decrease', () => {
    const snapshots = [
      { _week: '2026-W05', summary: { open_issues: 20, recently_merged_prs: 10 }, releases: [] },
      { _week: '2026-W06', summary: { open_issues: 15, recently_merged_prs: 12 }, releases: [] },
      { _week: '2026-W07', summary: { open_issues: 10, recently_merged_prs: 8 }, releases: [] },
    ];
    const result = computeTrends(snapshots);
    assert.equal(result.direction, 'shrinking');
  });

  it('detects stable direction when open issues stay the same', () => {
    const snapshots = [
      { _week: '2026-W01', summary: { open_issues: 7, recently_merged_prs: 3 }, releases: [] },
      { _week: '2026-W02', summary: { open_issues: 10, recently_merged_prs: 5 }, releases: [] },
      { _week: '2026-W03', summary: { open_issues: 7, recently_merged_prs: 2 }, releases: [] },
    ];
    const result = computeTrends(snapshots);
    assert.equal(result.direction, 'stable');
  });

  it('handles missing summary fields gracefully', () => {
    const snapshots = [
      { _week: '2026-W01', summary: {} },
      { _week: '2026-W02', summary: { open_issues: 5 } },
    ];
    const result = computeTrends(snapshots);
    assert.equal(result.weeks.length, 2);
    assert.equal(result.weeks[0].open_issues, 0);
    assert.equal(result.weeks[0].merged_prs, 0);
    assert.equal(result.weeks[0].releases, 0);
    assert.equal(result.direction, 'growing');
  });
});
