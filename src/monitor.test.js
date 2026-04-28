import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('monitor module', () => {
  it('exports monitor, filterBySeverity, groupByType, summariseEvents, loadCursor, saveCursor', async () => {
    const mod = await import('./monitor.js');
    assert.equal(typeof mod.monitor, 'function');
    assert.equal(typeof mod.filterBySeverity, 'function');
    assert.equal(typeof mod.groupByType, 'function');
    assert.equal(typeof mod.summariseEvents, 'function');
    assert.equal(typeof mod.loadCursor, 'function');
    assert.equal(typeof mod.saveCursor, 'function');
  });

  it('exports EVENT_TYPES constants', async () => {
    const { EVENT_TYPES } = await import('./monitor.js');
    assert.equal(EVENT_TYPES.NEW_ISSUE, 'new_issue');
    assert.equal(EVENT_TYPES.NEW_PR, 'new_pr');
    assert.equal(EVENT_TYPES.SECURITY_ALERT, 'security_alert');
    assert.equal(EVENT_TYPES.CI_FAILURE, 'ci_failure');
    assert.equal(EVENT_TYPES.STALE_ISSUE, 'stale_issue');
    assert.equal(EVENT_TYPES.RELEASE, 'release');
  });
});

describe('filterBySeverity', () => {
  it('filters events at or above the given severity', async () => {
    const { filterBySeverity } = await import('./monitor.js');
    const events = [
      { severity: 'critical', title: 'a' },
      { severity: 'high', title: 'b' },
      { severity: 'medium', title: 'c' },
      { severity: 'low', title: 'd' },
      { severity: 'info', title: 'e' },
    ];

    const high = filterBySeverity(events, 'high');
    assert.equal(high.length, 2);
    assert.equal(high[0].title, 'a');
    assert.equal(high[1].title, 'b');
  });

  it('returns all events when threshold is info', async () => {
    const { filterBySeverity } = await import('./monitor.js');
    const events = [
      { severity: 'critical', title: 'a' },
      { severity: 'info', title: 'b' },
    ];
    assert.equal(filterBySeverity(events, 'info').length, 2);
  });

  it('returns empty array for empty input', async () => {
    const { filterBySeverity } = await import('./monitor.js');
    assert.deepEqual(filterBySeverity([], 'low'), []);
  });
});

describe('groupByType', () => {
  it('groups events by their type field', async () => {
    const { groupByType, EVENT_TYPES } = await import('./monitor.js');
    const events = [
      { type: EVENT_TYPES.NEW_ISSUE, title: 'issue 1' },
      { type: EVENT_TYPES.NEW_ISSUE, title: 'issue 2' },
      { type: EVENT_TYPES.CI_FAILURE, title: 'ci fail' },
      { type: EVENT_TYPES.SECURITY_ALERT, title: 'vuln' },
    ];

    const groups = groupByType(events);
    assert.equal(groups[EVENT_TYPES.NEW_ISSUE].length, 2);
    assert.equal(groups[EVENT_TYPES.CI_FAILURE].length, 1);
    assert.equal(groups[EVENT_TYPES.SECURITY_ALERT].length, 1);
  });

  it('returns empty object for no events', async () => {
    const { groupByType } = await import('./monitor.js');
    assert.deepEqual(groupByType([]), {});
  });
});

describe('summariseEvents', () => {
  it('produces a readable summary string', async () => {
    const { summariseEvents, EVENT_TYPES } = await import('./monitor.js');
    const events = [
      { type: EVENT_TYPES.NEW_ISSUE, severity: 'high', title: 'Bug found' },
      { type: EVENT_TYPES.SECURITY_ALERT, severity: 'critical', title: 'CVE-2026-1234' },
    ];

    const summary = summariseEvents(events);
    assert.ok(summary.includes('new_issue (1):'));
    assert.ok(summary.includes('[high] Bug found'));
    assert.ok(summary.includes('security_alert (1):'));
    assert.ok(summary.includes('[critical] CVE-2026-1234'));
  });

  it('truncates groups with more than 10 items', async () => {
    const { summariseEvents, EVENT_TYPES } = await import('./monitor.js');
    const events = Array.from({ length: 15 }, (_, i) => ({
      type: EVENT_TYPES.NEW_ISSUE,
      severity: 'info',
      title: `Issue ${i}`,
    }));

    const summary = summariseEvents(events);
    assert.ok(summary.includes('... and 5 more'));
  });
});

describe('cursor persistence', () => {
  it('round-trips through a store with readJSON/writeJSON', async () => {
    const { loadCursor, saveCursor } = await import('./monitor.js');
    const persisted = {};
    const store = {
      readJSON: async (path) => persisted[path] ?? null,
      writeJSON: async (path, value) => { persisted[path] = value; },
    };

    assert.equal(await loadCursor(store), null, 'first run has no cursor');

    const cursor = {
      timestamp: '2026-04-28T07:00:00Z',
      repository: 'owner/repo',
      known_issue_numbers: [1, 2, 3],
      known_pr_numbers: [10],
      known_dependabot_alerts: [],
      known_code_scanning_alerts: [],
      known_secret_scanning_alerts: [],
      known_release_tags: ['v1.0.0'],
      last_event_count: 4,
    };
    await saveCursor(store, cursor);
    assert.deepEqual(await loadCursor(store), cursor, 'round-trip preserves cursor shape');
  });

  it('returns null when store lacks readJSON', async () => {
    const { loadCursor } = await import('./monitor.js');
    assert.equal(await loadCursor(null), null);
    assert.equal(await loadCursor({}), null);
  });

  it('saveCursor no-ops when store lacks writeJSON', async () => {
    const { saveCursor } = await import('./monitor.js');
    await saveCursor(null, { timestamp: 'x' });
    await saveCursor({}, { timestamp: 'x' });
  });
});
