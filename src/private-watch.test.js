import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summariseAlerts, buildPrivateFindings, runPrivateWatch } from './private-watch.js';

describe('summariseAlerts', () => {
  const sev = a => a.severity;
  const name = a => a.pkg;

  it('counts by severity and collects sorted unique package names', () => {
    const s = summariseAlerts([
      { severity: 'high', pkg: 'pillow' },
      { severity: 'high', pkg: 'pillow' },
      { severity: 'medium', pkg: 'setuptools' },
    ], sev, name);

    assert.equal(s.total, 3);
    assert.deepEqual(s.bySeverity, { high: 2, medium: 1 });
    assert.deepEqual(s.packages, ['pillow', 'setuptools']);
  });

  it('lower-cases severities so GitHub casing variance cannot split a bucket', () => {
    const s = summariseAlerts([{ severity: 'HIGH' }, { severity: 'high' }], sev);
    assert.deepEqual(s.bySeverity, { high: 2 });
  });

  it('buckets a missing severity as unknown rather than dropping the alert', () => {
    const s = summariseAlerts([{ pkg: 'x' }], sev, name);
    assert.equal(s.total, 1);
    assert.deepEqual(s.bySeverity, { unknown: 1 });
  });

  it('returns an empty summary for non-array input', () => {
    for (const input of [null, undefined, {}, 'nope']) {
      assert.deepEqual(summariseAlerts(input, sev), { total: 0, bySeverity: {}, packages: [] });
    }
  });
});

describe('buildPrivateFindings', () => {
  const s = (bySeverity, packages = [], total = null) => ({
    total: total ?? Object.values(bySeverity).reduce((a, b) => a + b, 0),
    bySeverity,
    packages,
  });

  it('reports dependabot criticals and highs with the affected packages', () => {
    const f = buildPrivateFindings('secret-repo', {
      dependabot: s({ high: 16, medium: 4 }, ['gitpython', 'pillow']),
      codeScanning: null,
      secretScanning: null,
    });

    assert.equal(f.length, 1);
    assert.equal(f[0].type, 'open-vulnerability');
    assert.equal(f[0].repo, 'secret-repo');
    assert.equal(f[0].source, 'dependabot');
    assert.equal(f[0].severity, 'high');
    assert.equal(f[0].private, true, 'must be tagged private for the notifier');
    assert.match(f[0].detail, /16 high/);
    assert.match(f[0].detail, /gitpython, pillow/);
  });

  it('escalates severity to critical when any critical is present', () => {
    const f = buildPrivateFindings('r', {
      dependabot: s({ critical: 1, high: 2 }), codeScanning: null, secretScanning: null,
    });
    assert.equal(f[0].severity, 'critical');
    assert.match(f[0].detail, /1 critical, 2 high/);
  });

  it('stays silent on medium and low only — acute findings only', () => {
    const f = buildPrivateFindings('r', {
      dependabot: s({ medium: 9, low: 30 }), codeScanning: null, secretScanning: null,
    });
    assert.deepEqual(f, [], 'medium/low alone must not open a tracking issue');
  });

  it('treats any secret-scanning hit as critical regardless of count', () => {
    const f = buildPrivateFindings('r', {
      dependabot: null, codeScanning: null, secretScanning: { total: 1, bySeverity: {}, packages: [] },
    });
    assert.equal(f.length, 1);
    assert.equal(f[0].source, 'secret-scanning');
    assert.equal(f[0].severity, 'critical');
  });

  it('reports dependabot and code-scanning as separate findings', () => {
    const f = buildPrivateFindings('r', {
      dependabot: s({ high: 1 }),
      codeScanning: s({ critical: 2 }, ['js/sql-injection']),
      secretScanning: null,
    });
    assert.deepEqual(f.map(x => x.source), ['dependabot', 'code-scanning']);
  });

  it('returns nothing for a clean repo, and for one whose scanners are unreadable', () => {
    assert.deepEqual(buildPrivateFindings('r', {
      dependabot: s({}), codeScanning: s({}), secretScanning: { total: 0 },
    }), []);
    assert.deepEqual(buildPrivateFindings('r', {
      dependabot: null, codeScanning: null, secretScanning: null,
    }), []);
  });

  it('truncates a long package list rather than emitting an unbounded body', () => {
    const packages = Array.from({ length: 20 }, (_, i) => `pkg-${String(i).padStart(2, '0')}`);
    const f = buildPrivateFindings('r', {
      dependabot: s({ high: 20 }, packages), codeScanning: null, secretScanning: null,
    });
    assert.match(f[0].detail, /\+8 more/);
  });
});

describe('runPrivateWatch', () => {
  let logs;
  let originalLog;

  beforeEach(() => {
    logs = [];
    originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
  });
  afterEach(() => { console.log = originalLog; });

  const ctx = (privateRepos, extra = {}) => ({
    owner: 'alice',
    token: 'fake',
    dryRun: true,
    portfolio: { repos: [{ name: 'public-repo' }], privateRepos },
    ...extra,
  });

  it('is a no-op with no private repos and makes no API calls', async () => {
    globalThis.fetch = mock.fn(async () => { throw new Error('should not be called'); });
    const result = await runPrivateWatch(ctx([]));
    assert.deepEqual(result, { repos: 0, withFindings: 0, notified: 0, closed: 0, unreadable: 0 });
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });

  it('tolerates a portfolio with no privateRepos field at all', async () => {
    const result = await runPrivateWatch({ owner: 'a', token: 't', portfolio: { repos: [] } });
    assert.equal(result.repos, 0);
  });

  // The canary guard. Actions logs on this public repo are world-readable, so a
  // private repo name appearing in ANY log line is a disclosure. Asserting on
  // captured stdout catches a future `console.log` that interpolates a name,
  // which no amount of reading the diff reliably would.
  it('never writes a private repo name to any log line', async () => {
    const CANARY = 'ZZLEAKCANARYZZ';
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ([
        { security_advisory: { severity: 'high' }, dependency: { package: { name: 'pillow' } } },
      ]),
    }));

    await runPrivateWatch(ctx([{ name: CANARY }]));

    const all = logs.join('\n');
    assert.ok(logs.length > 0, 'expected at least one log line, or this guard proves nothing');
    assert.ok(!all.includes(CANARY), `private repo name leaked into logs:\n${all}`);
  });

  it('still logs no name when every scanner errors', async () => {
    const CANARY = 'ZZLEAKCANARYZZ';
    globalThis.fetch = mock.fn(async () => ({
      ok: false, status: 403, headers: new Map(),
      // GitHub error bodies echo the path back — the redacting client must drop it.
      text: async () => `{"message":"Must have admin rights to /repos/alice/${CANARY}/dependabot/alerts"}`,
      json: async () => ({}),
    }));

    const result = await runPrivateWatch(ctx([{ name: CANARY }]));

    assert.equal(result.unreadable, 1, 'all-null scanners must count as unreadable, not clean');
    assert.ok(!logs.join('\n').includes(CANARY), 'private repo name leaked via an error path');
  });

  it('counts a repo with acute findings and reports it as notified in dry run', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      const body = u.includes('dependabot')
        ? [{ security_advisory: { severity: 'critical' }, dependency: { package: { name: 'pillow' } } }]
        : [];
      return { ok: true, status: 200, headers: new Map(), json: async () => body };
    });

    const result = await runPrivateWatch(ctx([{ name: 'priv' }]));

    assert.equal(result.repos, 1);
    assert.equal(result.withFindings, 1);
    assert.equal(result.notified, 1, 'dry run reports what it would notify');
    assert.match(logs.join('\n'), /1 private repo\(s\) checked, 1 with acute findings/);
  });

  it('reports zero findings for a clean private repo', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true, status: 200, headers: new Map(), json: async () => [],
    }));

    const result = await runPrivateWatch(ctx([{ name: 'priv' }]));

    assert.equal(result.withFindings, 0);
    assert.equal(result.unreadable, 0, 'an empty array is readable-and-clean, not unreadable');
  });

  it('writes nothing when dryRun is true', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET' });
      return { ok: true, status: 200, headers: new Map(), json: async () => ([
        { security_advisory: { severity: 'high' }, dependency: { package: { name: 'p' } } },
      ]) };
    });

    await runPrivateWatch(ctx([{ name: 'priv' }], { dryRun: true }));

    assert.equal(calls.filter(c => c.method === 'POST' || c.method === 'PATCH').length, 0);
  });
});
