import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { filterNpmDeps, computeDepAge, aggregateLibyear, computeLibyearWithTimeout } from './libyear.js';

describe('filterNpmDeps', () => {
  it('filters to only npm packages with purl and version', () => {
    const packages = [
      { name: 'express', version: '4.18.2', purl: 'pkg:npm/express@4.18.2', license: 'MIT' },
      { name: 'lodash', version: '4.17.21', purl: 'pkg:npm/lodash@4.17.21', license: 'MIT' },
      { name: 'some-go-pkg', version: '1.0.0', purl: 'pkg:golang/example.com/pkg@1.0.0', license: 'MIT' },
      { name: 'no-version-pkg', version: null, purl: 'pkg:npm/no-version-pkg', license: 'MIT' },
      { name: 'no-purl', version: '1.0.0', purl: null, license: 'MIT' },
    ];
    const result = filterNpmDeps(packages);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'express');
    assert.equal(result[0].currentVersion, '4.18.2');
    assert.equal(result[1].name, 'lodash');
    assert.equal(result[1].currentVersion, '4.17.21');
  });

  it('handles scoped npm packages', () => {
    const packages = [
      { name: '@babel/core', version: '7.23.0', purl: 'pkg:npm/%40babel/core@7.23.0', license: 'MIT' },
      { name: '@types/node', version: '20.8.0', purl: 'pkg:npm/%40types/node@20.8.0', license: 'MIT' },
    ];
    const result = filterNpmDeps(packages);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, '@babel/core');
    assert.equal(result[0].currentVersion, '7.23.0');
    assert.equal(result[1].name, '@types/node');
    assert.equal(result[1].currentVersion, '20.8.0');
  });

  it('returns empty array for null/empty input', () => {
    assert.deepEqual(filterNpmDeps(null), []);
    assert.deepEqual(filterNpmDeps([]), []);
  });

  it('returns empty array when no npm packages present', () => {
    const packages = [
      { name: 'go-pkg', version: '1.0.0', purl: 'pkg:golang/example.com@1.0.0', license: 'MIT' },
    ];
    assert.deepEqual(filterNpmDeps(packages), []);
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
    const result = await computeLibyearWithTimeout(packages, 50);
    assert.equal(result, null);
  });

  it('returns null for non-npm packages', async () => {
    const packages = [
      { name: 'go-pkg', version: '1.0.0', purl: 'pkg:golang/example.com@1.0.0' },
    ];
    const result = await computeLibyearWithTimeout(packages, 5000);
    assert.equal(result, null);
  });
});
