import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotToEvents } from './triage-bot.js';

describe('snapshotToEvents', () => {
  it('creates a butler_observation event from a snapshot', () => {
    const snapshot = {
      summary: {
        open_issues: 17,
        blocked_issues: 6,
        awaiting_feedback: 8,
        recently_merged_prs: 176,
        latest_release: 'v2.7.12',
      },
    };

    const events = snapshotToEvents(snapshot, 'IsmaelMartinez/teams-for-linux');

    assert.equal(events.length, 1);
    assert.equal(events[0].repo, 'IsmaelMartinez/teams-for-linux');
    assert.equal(events[0].event_type, 'butler_observation');
    assert.ok(events[0].summary.includes('17 open issues'));
    assert.ok(events[0].summary.includes('176 merged PRs'));
    assert.equal(events[0].metadata.source, 'repo-butler');
    assert.equal(events[0].metadata.open_issues, 17);
    assert.equal(events[0].metadata.latest_release, 'v2.7.12');
    assert.deepEqual(events[0].areas, ['metrics', 'observation']);
  });

  it('handles empty snapshot gracefully', () => {
    const events = snapshotToEvents({}, 'owner/repo');
    assert.equal(events.length, 1);
    assert.ok(events[0].summary.includes('0 open issues'));
    assert.equal(events[0].metadata.source, 'repo-butler');
  });

  it('handles null summary', () => {
    const events = snapshotToEvents({ summary: null }, 'owner/repo');
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.open_issues, undefined);
  });
});
