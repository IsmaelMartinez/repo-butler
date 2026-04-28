import { describe, it, beforeEach, afterEach, mock } from 'node:test';
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

describe('detectSecurityAlerts (via monitor)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockResponse(body) {
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => body,
    };
  }
  function failingResponse() {
    return {
      ok: false,
      status: 404,
      headers: new Map(),
      text: async () => 'Not Found',
      json: async () => ({}),
    };
  }

  it('SCANNERS table covers dependabot, code_scanning, and secret_scanning', async () => {
    const { SCANNERS } = await import('./monitor.js');
    const sources = SCANNERS.map(s => s.source).sort();
    assert.deepEqual(sources, ['code_scanning', 'dependabot', 'secret_scanning']);
    // Each entry must declare the four fields the loop relies on.
    for (const s of SCANNERS) {
      assert.equal(typeof s.source, 'string');
      assert.equal(typeof s.path, 'string');
      assert.equal(typeof s.knownField, 'string');
      assert.equal(typeof s.buildEvent, 'function');
    }
  });

  it('emits an event per scanner success path with the right source/severity/title', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/dependabot/alerts')) {
        return mockResponse([{
          number: 1,
          security_vulnerability: { severity: 'high' },
          security_advisory: { summary: 'CVE-2026-0001' },
          dependency: { package: { name: 'left-pad' } },
          html_url: 'https://example/da/1',
          created_at: '2026-04-28T00:00:00Z',
        }]);
      }
      if (u.includes('/code-scanning/alerts')) {
        return mockResponse([{
          number: 2,
          rule: { security_severity_level: 'medium', description: 'SQL injection', id: 'js/sql-injection' },
          html_url: 'https://example/cs/2',
          created_at: '2026-04-28T00:00:00Z',
        }]);
      }
      if (u.includes('/secret-scanning/alerts')) {
        return mockResponse([{
          number: 3,
          secret_type_display_name: 'AWS Access Key',
          secret_type: 'aws_access_key_id',
          html_url: 'https://example/ss/3',
          created_at: '2026-04-28T00:00:00Z',
        }]);
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const { monitor } = await import('./monitor.js');
    const result = await monitor({
      owner: 'alice', repo: 'repo', token: 'fake',
      store: { readJSON: async () => null, writeJSON: async () => {} },
    });

    const security = result.events.filter(e => e.type === 'security_alert');
    assert.equal(security.length, 3);

    const da = security.find(e => e.source === 'dependabot');
    assert.equal(da.severity, 'high');
    assert.equal(da.title, 'Dependabot: CVE-2026-0001');
    assert.equal(da.package, 'left-pad');
    assert.equal(da.number, 1);

    const cs = security.find(e => e.source === 'code_scanning');
    assert.equal(cs.severity, 'medium');
    assert.equal(cs.title, 'Code scanning: SQL injection');
    assert.equal(cs.rule, 'js/sql-injection');

    const ss = security.find(e => e.source === 'secret_scanning');
    assert.equal(ss.severity, 'critical');
    assert.equal(ss.title, 'Secret exposed: AWS Access Key');
  });

  it('skips alerts whose number is in the known-set for that scanner', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/dependabot/alerts')) {
        return mockResponse([
          { number: 1, security_vulnerability: { severity: 'high' }, html_url: 'x', created_at: 'x' },
          { number: 2, security_vulnerability: { severity: 'low' }, html_url: 'x', created_at: 'x' },
        ]);
      }
      // Make the other scanners return nothing so they don't pollute the result.
      if (u.includes('/code-scanning/alerts') || u.includes('/secret-scanning/alerts')) {
        return failingResponse();
      }
      throw new Error(`Unexpected URL: ${u}`);
    });

    const { monitor } = await import('./monitor.js');
    const result = await monitor({
      owner: 'alice', repo: 'repo', token: 'fake',
      store: {
        readJSON: async () => ({
          timestamp: '2026-04-27T00:00:00Z',
          known_dependabot_alerts: [1],
        }),
        writeJSON: async () => {},
      },
    });

    const security = result.events.filter(e => e.type === 'security_alert');
    assert.equal(security.length, 1);
    assert.equal(security[0].number, 2);
  });

  it('logs a "not available" note naming the scanner and error when a fetch throws', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/dependabot/alerts')) {
        // Throwing from fetch surfaces err.message into the catch in detectSecurityAlerts.
        throw new Error('boom-da');
      }
      if (u.includes('/code-scanning/alerts')) throw new Error('boom-cs');
      if (u.includes('/secret-scanning/alerts')) throw new Error('boom-ss');
      throw new Error(`Unexpected URL: ${u}`);
    });

    const logs = [];
    const logSpy = mock.method(console, 'log', (msg) => { logs.push(String(msg)); });

    try {
      const { monitor } = await import('./monitor.js');
      await monitor({
        owner: 'alice', repo: 'repo', token: 'fake',
        store: { readJSON: async () => null, writeJSON: async () => {} },
      });
    } finally {
      logSpy.mock.restore();
    }

    const findNote = (source) => logs.find(l =>
      l.includes(`Note: ${source} alerts not available for alice/repo`)
    );

    const da = findNote('dependabot');
    const cs = findNote('code_scanning');
    const ss = findNote('secret_scanning');

    assert.ok(da, 'expected a dependabot not-available note');
    assert.ok(da.includes('boom-da'), 'dependabot note should include the error message');
    assert.ok(cs, 'expected a code_scanning not-available note');
    assert.ok(cs.includes('boom-cs'), 'code_scanning note should include the error message');
    assert.ok(ss, 'expected a secret_scanning not-available note');
    assert.ok(ss.includes('boom-ss'), 'secret_scanning note should include the error message');
  });

  it('swallows scanner errors and continues with the remaining scanners', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/dependabot/alerts')) return failingResponse();
      if (u.includes('/code-scanning/alerts')) {
        return mockResponse([{
          number: 9, rule: { security_severity_level: 'high', description: 'XSS', id: 'js/xss' },
          html_url: 'x', created_at: 'x',
        }]);
      }
      if (u.includes('/secret-scanning/alerts')) return failingResponse();
      throw new Error(`Unexpected URL: ${u}`);
    });

    const { monitor } = await import('./monitor.js');
    const result = await monitor({
      owner: 'alice', repo: 'repo', token: 'fake',
      store: { readJSON: async () => null, writeJSON: async () => {} },
    });

    const security = result.events.filter(e => e.type === 'security_alert');
    assert.equal(security.length, 1);
    assert.equal(security[0].source, 'code_scanning');
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
