import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrends, appendTriageBotContext } from './assess.js';
import { isoWeekKey } from './store.js';

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

describe('isoWeekKey', () => {
  it('returns correct week for a mid-year date', () => {
    assert.equal(isoWeekKey(new Date('2026-03-20T00:00:00Z')), '2026-W12');
  });

  it('handles Jan 1 that belongs to previous year week 53', () => {
    // Jan 1, 2016 is a Friday — ISO week belongs to 2015-W53
    assert.equal(isoWeekKey(new Date('2016-01-01T00:00:00Z')), '2015-W53');
  });

  it('handles Dec 31 that belongs to next year week 1', () => {
    // Dec 31, 2018 is a Monday — ISO week belongs to 2019-W01
    assert.equal(isoWeekKey(new Date('2018-12-31T00:00:00Z')), '2019-W01');
  });

  it('handles Dec 28 in a year with 53 weeks', () => {
    // Dec 28, 2026 is a Monday — should be 2026-W53
    assert.equal(isoWeekKey(new Date('2026-12-28T00:00:00Z')), '2026-W53');
  });
});

describe('appendTriageBotContext', () => {
  it('appends triage summary when data is available', () => {
    const parts = [];
    const trends = {
      triage: [
        { week: '2026-03-09', total: 6, promoted: 3, rate: 0.5 },
        { week: '2026-03-16', total: 5, promoted: 2, rate: 0.4 },
      ],
      agents: [
        { week: '2026-03-16', total: 2, approved: 1, rejected: 1, pending: 0, complete: 0 },
      ],
      synthesis: [{ week: '2026-03-16', briefings: 1, findings: 3 }],
      response_time: [{ week: '2026-03-16', avg_seconds: 12.5 }],
    };
    appendTriageBotContext(parts, trends);
    const text = parts.join('\n');
    assert.ok(text.includes('Triage bot:'));
    assert.ok(text.includes('11 sessions'));
    assert.ok(text.includes('45% promotion')); // 5 promoted out of 11 = 45%
    assert.ok(text.includes('Enhancement research:'));
    assert.ok(text.includes('Synthesis engine:'));
    assert.ok(text.includes('12.5s'));
  });

  it('does nothing when trends is null', () => {
    const parts = [];
    appendTriageBotContext(parts, null);
    assert.equal(parts.length, 0);
  });

  it('handles empty trends data gracefully', () => {
    const parts = [];
    appendTriageBotContext(parts, { triage: [], agents: [], synthesis: [], response_time: [] });
    const text = parts.join('\n');
    assert.ok(text.includes('Triage Bot Intelligence'));
    assert.ok(!text.includes('Enhancement research:'));
    assert.ok(!text.includes('Synthesis engine:'));
  });
});
