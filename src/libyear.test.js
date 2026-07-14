import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { filterSupportedDeps, computeDepAge, aggregateLibyear, computeLibyearWithTimeout } from './libyear.js';

describe('filterSupportedDeps', () => {
  it('filters to only supported packages with purl and version', () => {
    const packages = [
      { name: 'express', version: '4.18.2', purl: 'pkg:npm/express@4.18.2', license: 'MIT' },
      { name: 'lodash', version: '4.17.21', purl: 'pkg:npm/lodash@4.17.21', license: 'MIT' },
      { name: 'some-go-pkg', version: '1.0.0', purl: 'pkg:golang/example.com/pkg@1.0.0', license: 'MIT' },
      { name: 'no-version-pkg', version: null, purl: 'pkg:npm/no-version-pkg', license: 'MIT' },
      { name: 'no-purl', version: '1.0.0', purl: null, license: 'MIT' },
    ];
    const result = filterSupportedDeps(packages);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'express');
    assert.equal(result[0].currentVersion, '4.18.2');
    assert.equal(result[0].registry, 'npm');
    assert.equal(result[1].name, 'lodash');
    assert.equal(result[1].currentVersion, '4.17.21');
  });

  it('handles scoped npm packages', () => {
    const packages = [
      { name: '@babel/core', version: '7.23.0', purl: 'pkg:npm/%40babel/core@7.23.0', license: 'MIT' },
      { name: '@types/node', version: '20.8.0', purl: 'pkg:npm/%40types/node@20.8.0', license: 'MIT' },
    ];
    const result = filterSupportedDeps(packages);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, '@babel/core');
    assert.equal(result[0].currentVersion, '7.23.0');
    assert.equal(result[1].name, '@types/node');
    assert.equal(result[1].currentVersion, '20.8.0');
  });

  it('recognises PyPI and crates.io purls with their registries', () => {
    const packages = [
      { name: 'django', version: '4.2.0', purl: 'pkg:pypi/django@4.2.0', license: 'BSD-3-Clause' },
      { name: 'serde', version: '1.0.190', purl: 'pkg:cargo/serde@1.0.190', license: 'MIT' },
    ];
    const result = filterSupportedDeps(packages);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { registry: 'pypi', name: 'django', currentVersion: '4.2.0' });
    assert.deepEqual(result[1], { registry: 'cargo', name: 'serde', currentVersion: '1.0.190' });
  });

  it('returns empty array for null/empty input', () => {
    assert.deepEqual(filterSupportedDeps(null), []);
    assert.deepEqual(filterSupportedDeps([]), []);
  });

  it('returns empty array when no supported packages present', () => {
    const packages = [
      { name: 'go-pkg', version: '1.0.0', purl: 'pkg:golang/example.com@1.0.0', license: 'MIT' },
      { name: 'gem-pkg', version: '1.0.0', purl: 'pkg:gem/rails@1.0.0', license: 'MIT' },
    ];
    assert.deepEqual(filterSupportedDeps(packages), []);
  });
});

describe('computeDepAge', () => {
  it('computes age in years between two dates', () => {
    const current = new Date('2023-01-01T00:00:00Z');
    const latest = new Date('2024-01-01T00:00:00Z');
    const years = computeDepAge(current, latest);
    // 365 days / 365.25 = ~0.9993
    assert.ok(years > 0.99 && years < 1.01, `expected ~1 year, got ${years}`);
  });

  it('returns 0 when current is newer than or equal to latest', () => {
    const current = new Date('2024-06-01T00:00:00Z');
    const latest = new Date('2024-01-01T00:00:00Z');
    assert.equal(computeDepAge(current, latest), 0);
  });

  it('returns 0 when dates are identical', () => {
    const date = new Date('2024-01-15T00:00:00Z');
    assert.equal(computeDepAge(date, date), 0);
  });

  it('computes fractional years correctly', () => {
    const current = new Date('2024-01-01T00:00:00Z');
    const latest = new Date('2024-07-01T00:00:00Z');
    const years = computeDepAge(current, latest);
    // ~182 days / 365.25 = ~0.498
    assert.ok(years > 0.49 && years < 0.51, `expected ~0.5 years, got ${years}`);
  });

  it('handles multi-year gaps', () => {
    const current = new Date('2020-01-01T00:00:00Z');
    const latest = new Date('2025-01-01T00:00:00Z');
    const years = computeDepAge(current, latest);
    assert.ok(years > 4.98 && years < 5.02, `expected ~5 years, got ${years}`);
  });
});

describe('aggregateLibyear', () => {
  it('aggregates multiple deps with correct total, count, and oldest', () => {
    const deps = [
      { name: 'express', current: '4.17.0', latest: '4.18.2', years: 1.5 },
      { name: 'lodash', current: '4.15.0', latest: '4.17.21', years: 3.2 },
      { name: 'chalk', current: '5.2.0', latest: '5.3.0', years: 0.3 },
    ];
    const result = aggregateLibyear(deps);
    assert.equal(result.total_libyear, 5);
    assert.equal(result.dependency_count, 3);
    assert.equal(result.oldest.name, 'lodash');
    assert.equal(result.oldest.years, 3.2);
    assert.equal(result.deps.length, 3);
  });

  it('handles single dependency', () => {
    const deps = [
      { name: 'express', current: '4.17.0', latest: '4.18.2', years: 0.8 },
    ];
    const result = aggregateLibyear(deps);
    assert.equal(result.total_libyear, 0.8);
    assert.equal(result.dependency_count, 1);
    assert.equal(result.oldest.name, 'express');
  });

  it('sums to zero when all deps are up to date', () => {
    const deps = [
      { name: 'express', current: '4.18.2', latest: '4.18.2', years: 0 },
      { name: 'lodash', current: '4.17.21', latest: '4.17.21', years: 0 },
    ];
    const result = aggregateLibyear(deps);
    assert.equal(result.total_libyear, 0);
    assert.equal(result.dependency_count, 2);
  });

  it('returns null for empty or null input', () => {
    assert.equal(aggregateLibyear([]), null);
    assert.equal(aggregateLibyear(null), null);
  });
});

describe('computeLibyearWithTimeout', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns result for successful registry lookups', async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '4.19.0' },
        time: {
          '4.18.2': '2023-06-01T00:00:00Z',
          '4.19.0': '2024-06-01T00:00:00Z',
        },
      }),
    }));
    const packages = [
      { name: 'express', version: '4.18.2', purl: 'pkg:npm/express@4.18.2' },
    ];
    const result = await computeLibyearWithTimeout(packages, 5000);
    assert.ok(result);
    assert.equal(result.dependency_count, 1);
    assert.ok(result.total_libyear > 0.9 && result.total_libyear < 1.1);
    assert.equal(result.oldest.name, 'express');
  });

  it('resolves PyPI packages via the pypi.org JSON API', async () => {
    const seenUrls = [];
    globalThis.fetch = mock.fn(async (url, opts) => {
      seenUrls.push(url);
      assert.ok(opts.headers['User-Agent'].includes('repo-butler'));
      return {
        ok: true,
        json: async () => ({
          info: { version: '5.0.0' },
          releases: {
            '4.2.0': [{ upload_time_iso_8601: '2023-04-01T00:00:00Z' }],
            '5.0.0': [{ upload_time_iso_8601: '2024-04-01T00:00:00Z' }],
          },
        }),
      };
    });
    const packages = [
      { name: 'django', version: '4.2.0', purl: 'pkg:pypi/django@4.2.0' },
    ];
    const result = await computeLibyearWithTimeout(packages, 5000);
    assert.deepEqual(seenUrls, ['https://pypi.org/pypi/django/json']);
    assert.ok(result);
    assert.equal(result.dependency_count, 1);
    assert.equal(result.deps[0].latest, '5.0.0');
    assert.ok(result.total_libyear > 0.9 && result.total_libyear < 1.1);
  });

  it('resolves crates.io packages, preferring max_stable_version', async () => {
    const seenUrls = [];
    globalThis.fetch = mock.fn(async (url) => {
      seenUrls.push(url);
      return {
        ok: true,
        json: async () => ({
          crate: { max_stable_version: '1.0.200', newest_version: '2.0.0-beta.1' },
          versions: [
            { num: '2.0.0-beta.1', created_at: '2025-01-01T00:00:00Z' },
            { num: '1.0.200', created_at: '2024-06-01T00:00:00Z' },
            { num: '1.0.190', created_at: '2023-06-01T00:00:00Z' },
          ],
        }),
      };
    });
    const packages = [
      { name: 'serde', version: '1.0.190', purl: 'pkg:cargo/serde@1.0.190' },
    ];
    const result = await computeLibyearWithTimeout(packages, 5000);
    assert.deepEqual(seenUrls, ['https://crates.io/api/v1/crates/serde']);
    assert.ok(result);
    assert.equal(result.deps[0].latest, '1.0.200');
    assert.ok(result.total_libyear > 0.9 && result.total_libyear < 1.1);
  });

  it('mixes registries in one computation and skips undateable versions', async () => {
    globalThis.fetch = mock.fn(async (url) => ({
      ok: true,
      json: async () => {
        if (url.startsWith('https://registry.npmjs.org/')) {
          return {
            'dist-tags': { latest: '2.0.0' },
            time: { '1.0.0': '2023-01-01T00:00:00Z', '2.0.0': '2024-01-01T00:00:00Z' },
          };
        }
        // PyPI response whose current version has no uploaded files — undateable.
        return { info: { version: '3.0.0' }, releases: { '3.0.0': [{ upload_time_iso_8601: '2024-01-01T00:00:00Z' }], '2.9.0': [] } };
      },
    }));
    const packages = [
      { name: 'express', version: '1.0.0', purl: 'pkg:npm/express@1.0.0' },
      { name: 'flask', version: '2.9.0', purl: 'pkg:pypi/flask@2.9.0' },
    ];
    const result = await computeLibyearWithTimeout(packages, 5000);
    assert.ok(result);
    assert.equal(result.dependency_count, 1);
    assert.equal(result.deps[0].name, 'express');
  });

  it('returns null when timeout expires', async () => {
    // Mock fetch that respects AbortSignal (like real fetch does).
    globalThis.fetch = mock.fn((url, opts) => new Promise((_, reject) => {
      const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (opts?.signal?.aborted) { onAbort(); return; }
      opts?.signal?.addEventListener('abort', onAbort);
    }));
    const packages = [
      { name: 'slow-pkg', version: '1.0.0', purl: 'pkg:npm/slow-pkg@1.0.0' },
    ];
    // Short perFetchMs keeps the per-fetch abort timer within the outer
    // timeout window so the inner fetch settles before the test runner exits —
    // without it, the default 5000ms per-fetch timer would dominate suite runtime.
    const result = await computeLibyearWithTimeout(packages, 50, { perFetchMs: 30 });
    assert.equal(result, null);
  });

  it('returns null when only unsupported ecosystems are present', async () => {
    const packages = [
      { name: 'go-pkg', version: '1.0.0', purl: 'pkg:golang/example.com@1.0.0' },
    ];
    const result = await computeLibyearWithTimeout(packages, 5000);
    assert.equal(result, null);
  });

  it('skips remaining batches once overall timeout expires (PR #221 review)', async () => {
    // Verifies the loopBreakSignal added in response to Gemini's review on PR
    // #221: when the outer wall-clock budget fires, the batch loop must stop
    // issuing new fetches rather than continuing in the background until each
    // dep's per-fetch timer trips individually.
    let fetchCount = 0;
    globalThis.fetch = mock.fn(() => {
      fetchCount++;
      // Every fetch hangs until aborted by its per-fetch controller.
      return new Promise((_, reject) => {
        // Simulate real registry: slow response that respects abort signal.
        // Without the loop-break, all 20 deps (4 batches of 5) would be issued.
      });
    });
    const packages = Array.from({ length: 20 }, (_, i) => ({
      name: `pkg-${i}`,
      version: '1.0.0',
      purl: `pkg:npm/pkg-${i}@1.0.0`,
    }));
    // Outer budget 30ms, per-fetch 200ms. The first batch starts immediately
    // (5 fetches). At 30ms the outer race wins and aborts the loop. The first
    // batch's fetches keep running until their per-fetch timer (200ms) fires,
    // but no new batch is started.
    const result = await computeLibyearWithTimeout(packages, 30, { perFetchMs: 200 });
    // Give the per-fetch timers time to settle before asserting.
    await new Promise(r => setTimeout(r, 250));
    assert.equal(result, null);
    assert.equal(fetchCount, 5, `expected exactly 1 batch of 5 fetches before loop-break, got ${fetchCount}`);
  });

  it('per-fetch timeout abandons hung fetches without blocking siblings (issue #220)', async () => {
    // One package hangs forever; the other resolves immediately. With per-fetch
    // timeouts (replaces the old cascading abort), the slow fetch self-terminates
    // while the fast fetch returns data — partial results are preserved.
    globalThis.fetch = mock.fn((url, opts) => {
      if (url.includes('slow-pkg')) {
        return new Promise((_, reject) => {
          const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (opts?.signal?.aborted) { onAbort(); return; }
          opts?.signal?.addEventListener('abort', onAbort);
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '2.0.0' },
          time: { '1.0.0': '2023-01-01T00:00:00Z', '2.0.0': '2024-01-01T00:00:00Z' },
        }),
      });
    });
    const packages = [
      { name: 'slow-pkg', version: '1.0.0', purl: 'pkg:npm/slow-pkg@1.0.0' },
      { name: 'fast-pkg', version: '1.0.0', purl: 'pkg:npm/fast-pkg@1.0.0' },
    ];
    // Generous overall budget (5s); per-fetch timeout (50ms) is what aborts slow-pkg.
    const start = Date.now();
    const result = await computeLibyearWithTimeout(packages, 5000, { perFetchMs: 50 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `expected per-fetch timeout to fire fast, took ${elapsed}ms`);
    assert.ok(result, 'expected partial results, got null');
    assert.equal(result.dependency_count, 1);
    assert.equal(result.deps[0].name, 'fast-pkg');
  });

  it('builds registry URLs that preserve scope and slash without leftover encoding', async () => {
    const seenUrls = [];
    globalThis.fetch = mock.fn(async (url) => {
      seenUrls.push(url);
      return {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.0.0' },
          time: { '1.0.0': '2024-01-01T00:00:00Z' },
        }),
      };
    });
    const packages = [
      { name: '@babel/core', version: '1.0.0', purl: 'pkg:npm/%40babel/core@1.0.0' },
      // Adversarial: scoped name with characters that need encoding; the
      // legacy single-replace left %2F (the encoded slash) in the URL.
      { name: '@scope/weird name', version: '1.0.0', purl: 'pkg:npm/%40scope/weird%20name@1.0.0' },
    ];
    await computeLibyearWithTimeout(packages, 5000);
    assert.equal(seenUrls.length, 2);
    assert.equal(seenUrls[0], 'https://registry.npmjs.org/@babel/core');
    assert.equal(seenUrls[1], 'https://registry.npmjs.org/@scope/weird%20name');
    for (const u of seenUrls) {
      assert.ok(!u.includes('%40'), `URL still contains %40: ${u}`);
      assert.ok(!u.includes('%2F'), `URL still contains %2F: ${u}`);
    }
  });
});
