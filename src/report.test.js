import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { report, reportCacheHit, TEMPLATE_FILES } from './report.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('report module', () => {
  // report.js is the REPORT entry point, not a barrel: callers import render
  // and fetch functions from the module that defines them (#422).
  it('exports its own entry points and re-exports no report sub-module', async () => {
    const mod = await import('./report.js');
    assert.deepEqual(Object.keys(mod).sort(), ['TEMPLATE_FILES', 'report', 'reportCacheHit', 'runReport']);
  });
});

describe('report cache invalidation covers every report module', () => {
  it('TEMPLATE_FILES lists every src/report*.js module on disk', async () => {
    const { readdir } = await import('node:fs/promises');
    // A report module missing from the template hash leaves cached HTML stale
    // after a presentation change in that module.
    const modules = (await readdir('src'))
      .filter(f => f.startsWith('report') && f.endsWith('.js') && !f.endsWith('.test.js'))
      .map(f => `src/${f}`);
    assert.ok(modules.includes('src/report.js'));
    for (const f of modules) {
      assert.ok(TEMPLATE_FILES.includes(f), `TEMPLATE_FILES should include ${f}`);
    }
  });
});

describe('reportCacheHit', () => {
  it('is true only when the REPORT phase cache-hit (guards the report_cached output / #216)', () => {
    // Cache-hit: report() returned { cached: true } → guard treats missing
    // index.html as a healthy skip.
    assert.equal(reportCacheHit({ reportResult: { cached: true } }), true);
  });

  it('is false for a regenerated report (so a real missing-output failure still errors)', () => {
    // A regenerated run returns a summary object without cached:true.
    assert.equal(reportCacheHit({ reportResult: { cached: false } }), false);
    assert.equal(reportCacheHit({ reportResult: { generated: 12 } }), false);
  });

  it('is false when REPORT did not run or context is empty (no false cache-hit signal)', () => {
    assert.equal(reportCacheHit({}), false);
    assert.equal(reportCacheHit({ reportResult: undefined }), false);
    assert.equal(reportCacheHit(undefined), false);
    // Defensive: a truthy-but-not-true cached value must not read as a cache-hit.
    assert.equal(reportCacheHit({ reportResult: { cached: 'true' } }), false);
  });
});

// #501: paginate now throws on a page that is not a list, where it used to end
// the listing with a partial (often empty) result. The per-repo chart fetchers
// had no catch of their own, so one malformed page would have failed REPORT
// for the whole portfolio. It must degrade that one repo to the lightweight
// card and cache nothing for it, so the next run refetches.
describe('report — a malformed list page on one repo (#501)', () => {
  let originalFetch, originalOutDir, outDir;
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalOutDir = process.env.REPORT_OUTPUT_DIR;
    outDir = await mkdtemp(join(tmpdir(), 'rb-report-501-'));
    process.env.REPORT_OUTPUT_DIR = outDir;
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalOutDir === undefined) delete process.env.REPORT_OUTPUT_DIR;
    else process.env.REPORT_OUTPUT_DIR = originalOutDir;
    await rm(outDir, { recursive: true, force: true });
  });

  it('writes a lightweight card for that repo, still writes the portfolio, and caches nothing for it', async () => {
    const json = body => ({ ok: true, status: 200, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) });
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.hostname === 'api.github.com' && u.pathname === '/repos/o/repo-a/pulls') return json({ message: 'ZZBODYZZ' });
      if (u.hostname === 'api.github.com' && /\/(pulls|issues|releases)$/.test(u.pathname)) return json([]);
      return json({});
    };
    const cacheWrites = [];
    const store = {
      readLastHash: async () => null,
      readRepoCache: async () => null,
      writeHash: async () => {},
      writeRepoCache: async (c) => { cacheWrites.push(c); },
      writePortfolioWeekly: async () => {},
      readLatestPortfolioWeekly: async () => null,
    };
    const now = new Date().toISOString();
    const context = {
      owner: 'o', token: 't', config: {}, store, snapshot: { repository: 'o/repo-a' }, forceReport: true,
      portfolio: { repos: [{ name: 'repo-a', pushed_at: now, archived: false, fork: false }] },
      repoDetails: { 'repo-a': { commits: 20 } },
    };
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { await report(context); } finally { console.log = orig; }

    const html = await readFile(join(outDir, 'repo-a.html'), 'utf8');
    assert.ok(html.length > 0);
    await readFile(join(outDir, 'index.html'), 'utf8');
    assert.ok(lines.some(l => l.includes('chart data unreadable for repo-a') && l.includes('status 200')), lines.join('\n'));
    assert.ok(!lines.some(l => l.includes('ZZBODYZZ')), 'the response body never reaches the log');
    assert.ok(cacheWrites.every(c => !c.repos['repo-a']), 'a degraded repo is not cached');
  });

  it('still fails the phase on an error the API did not answer (no status), so a fault is never masked', async () => {
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.hostname === 'api.github.com' && u.pathname === '/repos/o/repo-a/pulls') throw new TypeError('fetch failed');
      return { ok: true, status: 200, headers: new Map(), json: async () => [], text: async () => '[]' };
    };
    const store = {
      readLastHash: async () => null, readRepoCache: async () => null, writeHash: async () => {},
      writeRepoCache: async () => {}, writePortfolioWeekly: async () => {}, readLatestPortfolioWeekly: async () => null,
    };
    const context = {
      owner: 'o', token: 't', config: {}, store, snapshot: { repository: 'o/repo-a' }, forceReport: true,
      portfolio: { repos: [{ name: 'repo-a', pushed_at: new Date().toISOString(), archived: false, fork: false }] },
      repoDetails: { 'repo-a': { commits: 20 } },
    };
    const orig = console.log;
    console.log = () => {};
    try { await assert.rejects(report(context), /fetch failed/); } finally { console.log = orig; }
  });
});
