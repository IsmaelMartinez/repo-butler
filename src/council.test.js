import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('council module', () => {
  it('exports PERSONAS, VERDICTS, deliberate, reviewProposals, triageEvents', async () => {
    const mod = await import('./council.js');
    assert.equal(typeof mod.PERSONAS, 'object');
    assert.equal(typeof mod.VERDICTS, 'object');
    assert.equal(typeof mod.deliberate, 'function');
    assert.equal(typeof mod.reviewProposals, 'function');
    assert.equal(typeof mod.triageEvents, 'function');
  });
});

describe('PERSONAS', () => {
  it('has all five specialist agents', async () => {
    const { PERSONAS } = await import('./council.js');
    const keys = Object.keys(PERSONAS);
    assert.deepEqual(keys.sort(), ['development', 'maintainability', 'product', 'security', 'stability']);
  });

  it('each persona has required fields', async () => {
    const { PERSONAS } = await import('./council.js');
    for (const [key, persona] of Object.entries(PERSONAS)) {
      assert.ok(persona.name, `${key} has name`);
      assert.ok(persona.role, `${key} has role`);
      assert.ok(persona.focus, `${key} has focus`);
      assert.ok(persona.system, `${key} has system prompt`);
    }
  });
});

describe('VERDICTS', () => {
  it('has act, watch, dismiss', async () => {
    const { VERDICTS } = await import('./council.js');
    assert.equal(VERDICTS.ACT, 'act');
    assert.equal(VERDICTS.WATCH, 'watch');
    assert.equal(VERDICTS.DISMISS, 'dismiss');
  });
});

describe('deliberate', () => {
  it('returns empty verdicts when no provider', async () => {
    const { deliberate } = await import('./council.js');
    const result = await deliberate({ provider: null }, [{ title: 'test' }]);
    assert.deepEqual(result.verdicts, []);
    assert.equal(result.mode, 'skipped');
  });

  it('returns empty verdicts for empty items', async () => {
    const { deliberate } = await import('./council.js');
    const fakeProvider = { generate: async () => '' };
    const result = await deliberate({ provider: fakeProvider }, []);
    assert.deepEqual(result.verdicts, []);
  });

  it('runs quick deliberation with mock provider', async () => {
    const { deliberate } = await import('./council.js');
    const mockResponse = [
      '---VERDICT---',
      'ITEM: 1',
      'PRODUCT: Good user value.',
      'DEVELOPMENT: Low complexity.',
      'STABILITY: No risk.',
      'MAINTAINABILITY: Clean design.',
      'SECURITY: No concerns.',
      'VERDICT: act',
      'CONFIDENCE: high',
      'PRIORITY: medium',
      'SUMMARY: All agents agree this is worth doing.',
      'ACTION: Create a GitHub issue.',
      '---END---',
    ].join('\n');

    const fakeProvider = { generate: async () => mockResponse };
    const items = [{ type: 'proposal', title: 'Add feature X', severity: 'medium' }];
    const result = await deliberate({ provider: fakeProvider }, items, { mode: 'quick' });

    assert.equal(result.verdicts.length, 1);
    assert.equal(result.verdicts[0].verdict, 'act');
    assert.equal(result.verdicts[0].confidence, 'high');
    assert.equal(result.verdicts[0].item_index, 0);
  });

  it('handles multiple items in quick mode', async () => {
    const { deliberate } = await import('./council.js');
    const mockResponse = [
      '---VERDICT---',
      'ITEM: 1',
      'PRODUCT: Important.',
      'DEVELOPMENT: Simple.',
      'STABILITY: Safe.',
      'MAINTAINABILITY: Good.',
      'SECURITY: Fine.',
      'VERDICT: act',
      'CONFIDENCE: high',
      'PRIORITY: high',
      'SUMMARY: Do it.',
      'ACTION: Create issue.',
      '---END---',
      '',
      '---VERDICT---',
      'ITEM: 2',
      'PRODUCT: Low value.',
      'DEVELOPMENT: Complex.',
      'STABILITY: Risky.',
      'MAINTAINABILITY: Adds debt.',
      'SECURITY: None.',
      'VERDICT: dismiss',
      'CONFIDENCE: medium',
      'PRIORITY: low',
      'SUMMARY: Not worth it.',
      'ACTION: none',
      '---END---',
    ].join('\n');

    const fakeProvider = { generate: async () => mockResponse };
    const items = [
      { type: 'proposal', title: 'Feature A' },
      { type: 'proposal', title: 'Feature B' },
    ];
    const result = await deliberate({ provider: fakeProvider }, items, { mode: 'quick' });

    assert.equal(result.verdicts.length, 2);
    assert.equal(result.verdicts[0].verdict, 'act');
    assert.equal(result.verdicts[1].verdict, 'dismiss');
  });
});

describe('reviewProposals', () => {
  it('sorts ideas into approved/watchlist/dismissed', async () => {
    const { reviewProposals } = await import('./council.js');

    const mockResponse = [
      '---VERDICT---',
      'ITEM: 1',
      'VERDICT: act',
      'CONFIDENCE: high',
      'PRIORITY: high',
      'SUMMARY: Approved.',
      'ACTION: Create issue.',
      '---END---',
      '---VERDICT---',
      'ITEM: 2',
      'VERDICT: watch',
      'CONFIDENCE: medium',
      'PRIORITY: medium',
      'SUMMARY: Needs more data.',
      'ACTION: none',
      '---END---',
      '---VERDICT---',
      'ITEM: 3',
      'VERDICT: dismiss',
      'CONFIDENCE: high',
      'PRIORITY: low',
      'SUMMARY: Not needed.',
      'ACTION: none',
      '---END---',
    ].join('\n');

    const fakeProvider = { generate: async () => mockResponse };
    const ideas = [
      { title: 'Idea A', priority: 'high', labels: [], body: 'body A' },
      { title: 'Idea B', priority: 'medium', labels: [], body: 'body B' },
      { title: 'Idea C', priority: 'low', labels: [], body: 'body C' },
    ];

    const result = await reviewProposals({ provider: fakeProvider, config: {} }, ideas);

    assert.equal(result.approved.length, 1);
    assert.equal(result.approved[0].title, 'Idea A');
    assert.equal(result.approved[0].council_verdict, 'act');

    assert.equal(result.watchlist.length, 1);
    assert.equal(result.watchlist[0].title, 'Idea B');

    assert.equal(result.dismissed.length, 1);
    assert.equal(result.dismissed[0].title, 'Idea C');
  });

  it('returns empty categories for no ideas', async () => {
    const { reviewProposals } = await import('./council.js');
    const result = await reviewProposals({ provider: null }, []);
    assert.deepEqual(result.approved, []);
    assert.deepEqual(result.watchlist, []);
    assert.deepEqual(result.dismissed, []);
  });
});

describe('triageEvents', () => {
  it('categorises monitor events by council verdict', async () => {
    const { triageEvents } = await import('./council.js');

    const mockResponse = [
      '---VERDICT---',
      'ITEM: 1',
      'VERDICT: act',
      'CONFIDENCE: high',
      'PRIORITY: critical',
      'SUMMARY: Security threat.',
      'ACTION: Patch immediately.',
      '---END---',
      '---VERDICT---',
      'ITEM: 2',
      'VERDICT: dismiss',
      'CONFIDENCE: high',
      'PRIORITY: low',
      'SUMMARY: Normal churn.',
      'ACTION: none',
      '---END---',
    ].join('\n');

    const fakeProvider = { generate: async () => mockResponse };
    const events = [
      { type: 'security_alert', severity: 'critical', title: 'CVE found' },
      { type: 'new_issue', severity: 'info', title: 'Minor question' },
    ];

    const result = await triageEvents({ provider: fakeProvider, config: {} }, events);

    assert.equal(result.actionable.length, 1);
    assert.equal(result.actionable[0].title, 'CVE found');
    assert.equal(result.dismissed.length, 1);
  });
});

describe('bucketVerdicts', () => {
  it('routes each verdict type into its bucket', async () => {
    const { bucketVerdicts } = await import('./council.js');
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const verdicts = [
      { item_index: 0, verdict: 'act' },
      { item_index: 1, verdict: 'watch' },
      { item_index: 2, verdict: 'dismiss' },
    ];

    const result = bucketVerdicts(items, verdicts, (item) => item);

    assert.equal(result.act.length, 1);
    assert.equal(result.act[0].id, 'a');
    assert.equal(result.watch.length, 1);
    assert.equal(result.watch[0].id, 'b');
    assert.equal(result.dismiss.length, 1);
    assert.equal(result.dismiss[0].id, 'c');
  });

  it('passes both item and verdict to the enrich function', async () => {
    const { bucketVerdicts } = await import('./council.js');
    const items = [{ id: 'a' }];
    const verdicts = [{ item_index: 0, verdict: 'act', summary: 'do it' }];
    const calls = [];

    const result = bucketVerdicts(items, verdicts, (item, verdict) => {
      calls.push({ item, verdict });
      return { ...item, summary: verdict.summary };
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].item, { id: 'a' });
    assert.equal(calls[0].verdict.summary, 'do it');
    assert.equal(result.act[0].summary, 'do it');
  });

  it('skips verdicts with no matching item', async () => {
    const { bucketVerdicts } = await import('./council.js');
    const items = [{ id: 'a' }];
    const verdicts = [
      { item_index: 0, verdict: 'act' },
      { item_index: 5, verdict: 'act' },  // out of range
    ];

    const result = bucketVerdicts(items, verdicts, (item) => item);

    assert.equal(result.act.length, 1);
    assert.equal(result.act[0].id, 'a');
  });

  it('treats unknown verdict values as dismiss', async () => {
    const { bucketVerdicts } = await import('./council.js');
    const items = [{ id: 'a' }];
    const verdicts = [{ item_index: 0, verdict: 'unrecognised' }];

    const result = bucketVerdicts(items, verdicts, (item) => item);

    assert.equal(result.act.length, 0);
    assert.equal(result.watch.length, 0);
    assert.equal(result.dismiss.length, 1);
  });

  it('returns empty buckets for empty inputs', async () => {
    const { bucketVerdicts } = await import('./council.js');
    const result = bucketVerdicts([], [], () => null);
    assert.deepEqual(result, { act: [], watch: [], dismiss: [] });
  });
});

describe('mergeWatchlist', () => {
  it('deduplicates by title when merging', async () => {
    const { mergeWatchlist } = await import('./council.js');

    const existing = [{ title: 'Item A', added_at: '2026-01-01' }];
    const newItems = [
      { title: 'Item A' },  // duplicate
      { title: 'Item B' },  // new
    ];

    const merged = mergeWatchlist(existing, newItems);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].title, 'Item A');
    assert.equal(merged[1].title, 'Item B');
    assert.ok(merged[1].added_at); // should have timestamp
  });

  it('handles empty existing list', async () => {
    const { mergeWatchlist } = await import('./council.js');
    const merged = mergeWatchlist([], [{ title: 'New' }]);
    assert.equal(merged.length, 1);
  });
});

describe('watchlist persistence', () => {
  it('round-trips through a store with readJSON/writeJSON', async () => {
    const { loadWatchlist, saveWatchlist } = await import('./council.js');
    const persisted = {};
    const store = {
      readJSON: async (path) => persisted[path] ?? null,
      writeJSON: async (path, value) => { persisted[path] = value; },
    };

    assert.deepEqual(await loadWatchlist(store), [], 'first run is empty');

    const items = [{ title: 'Watch this', added_at: '2026-01-01', review_count: 0 }];
    await saveWatchlist(store, items);
    assert.deepEqual(await loadWatchlist(store), items, 'round-trip preserves items');
  });

  it('returns [] when store lacks readJSON', async () => {
    const { loadWatchlist } = await import('./council.js');
    assert.deepEqual(await loadWatchlist(null), []);
    assert.deepEqual(await loadWatchlist({}), []);
  });

  it('saveWatchlist no-ops when store lacks writeJSON', async () => {
    const { saveWatchlist } = await import('./council.js');
    await saveWatchlist(null, [{ title: 'x' }]);
    await saveWatchlist({}, [{ title: 'x' }]);
  });

  it('returns [] when persisted file is non-array (corrupted)', async () => {
    const { loadWatchlist } = await import('./council.js');
    const store = { readJSON: async () => ({ not: 'an array' }) };
    assert.deepEqual(await loadWatchlist(store), []);
  });
});
