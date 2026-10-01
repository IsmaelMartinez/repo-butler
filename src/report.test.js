import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reportCacheHit, TEMPLATE_FILES } from './report.js';

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

describe('badgeTiers (#452)', () => {
  const now = new Date().toISOString();
  const repo = name => ({ name, pushed_at: now, fork: false });
  const gold = {
    ci: 2, license: 'MIT', open_bugs: 0, communityHealth: 90, released_at: now, commits: 10,
    vulns: { count: 0, max_severity: null }, codeScanning: { count: 0, max_severity: null }, secretScanning: { count: 0 },
  };

  it('publishes a provisional tier as unconfirmed and leaves it out of the portfolio average', async () => {
    const { badgeTiers } = await import('./report-shared.js');
    // Two provisional repos scored Silver would round the average down to Silver.
    const { repos, portfolio } = badgeTiers([repo('a'), repo('b'), repo('c')], {
      a: gold,
      b: { ...gold, codeScanning: { unreadable: true } },
      c: { ...gold, secretScanning: { unreadable: true } },
    }, {});
    assert.deepEqual(repos, [{ name: 'a', tier: 'gold' }, { name: 'b', tier: 'unconfirmed' }, { name: 'c', tier: 'unconfirmed' }]);
    assert.equal(portfolio, 'gold', 'the unread repo does not drag the portfolio badge down');
  });

  it('keeps a real tier when the unread scanner did not decide it', async () => {
    const { badgeTiers } = await import('./report-shared.js');
    const { repos } = badgeTiers([repo('c')], { c: { ...gold, license: 'None', vulns: { unreadable: true } } }, {});
    assert.deepEqual(repos, [{ name: 'c', tier: 'bronze' }]);
  });
});
