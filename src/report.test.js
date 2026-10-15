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
// for the whole portfolio. One repo's bad read degrades that repo to the
// lightweight card and caches nothing for it; a 401, or every fresh repo
// failing, is an outage and still fails the phase.
describe('report — unreadable chart data (#501)', () => {
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

  const ok = body => ({ ok: true, status: 200, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) });
  const fail = (status, text = 'ZZBODYZZ') => ({ ok: false, status, headers: new Map(), json: async () => ({}), text: async () => text });
  // `bad` maps a repo name to the response its /pulls listing gets.
  function serve(bad) {
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      const m = u.hostname === 'api.github.com' && u.pathname.match(/^\/repos\/o\/([^/]+)\/pulls$/);
      if (m && bad[m[1]]) return bad[m[1]]();
      if (u.hostname === 'api.github.com' && /\/(pulls|issues|releases)$/.test(u.pathname)) return ok([]);
      return ok({});
    };
  }
  function makeContext(names) {
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
      portfolio: { repos: names.map(name => ({ name, pushed_at: now, archived: false, fork: false })) },
      repoDetails: Object.fromEntries(names.map(n => [n, { commits: 20 }])),
    };
    return { context, cacheWrites };
  }
  async function run(context) {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { await report(context); return { lines }; } catch (err) { return { lines, err }; } finally { console.log = orig; }
  }

  it('degrades only the unreadable repo: light card written, portfolio still written, only the good repo cached', async () => {
    serve({ 'repo-a': () => ok({ message: 'ZZBODYZZ' }) });
    const { context, cacheWrites } = makeContext(['repo-a', 'repo-b']);
    const { lines, err } = await run(context);
    assert.equal(err, undefined);
    assert.ok((await readFile(join(outDir, 'repo-a.html'), 'utf8')).length > 0);
    assert.ok((await readFile(join(outDir, 'repo-b.html'), 'utf8')).length > 0);
    await readFile(join(outDir, 'index.html'), 'utf8');
    assert.equal(cacheWrites.length, 1);
    assert.deepEqual(Object.keys(cacheWrites[0].repos), ['repo-b'], 'the good repo is cached, the degraded one is not');
    assert.ok(cacheWrites[0].repos['repo-b'].chartData, 'with its chart data');
    assert.ok(lines.some(l => l.includes('chart data unreadable for repo-a') && l.includes('status 200')), lines.join('\n'));
    assert.ok(lines.some(l => l.includes('1 of 2 fresh repo(s) degraded')), lines.join('\n'));
    assert.ok(!lines.some(l => l.includes('ZZBODYZZ')), 'the response body never reaches the log');
  });

  it('fails the phase when EVERY fresh repo degrades (a systemic outage, not one bad page)', async () => {
    serve({ 'repo-a': () => fail(500), 'repo-b': () => ok({}) });
    const { context, cacheWrites } = makeContext(['repo-a', 'repo-b']);
    const { err } = await run(context);
    assert.ok(err, 'REPORT must fail');
    assert.match(err.message, /all 2 fresh repo\(s\)/);
    assert.equal(await readFile(join(outDir, 'index.html'), 'utf8').catch(() => null), null, 'no degraded dashboard is published');
    assert.deepEqual(cacheWrites, []);
  });

  it('fails the phase on a 401 at the first repo instead of degrading it', async () => {
    serve({ 'repo-a': () => fail(401, 'Bad credentials') });
    const { context } = makeContext(['repo-a', 'repo-b']);
    const { err, lines } = await run(context);
    assert.equal(err?.status, 401);
    assert.ok(!lines.some(l => l.includes('writing lightweight card')), lines.join('\n'));
  });

  it('still fails the phase on an error the API did not answer (no status), so a fault is never masked', async () => {
    serve({ 'repo-a': () => { throw new TypeError('fetch failed'); } });
    const { context } = makeContext(['repo-a', 'repo-b']);
    const { err } = await run(context);
    assert.match(err?.message ?? '', /fetch failed/);
  });
});
