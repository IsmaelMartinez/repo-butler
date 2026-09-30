import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reportCacheHit } from './report.js';

describe('report module', () => {
  it('exports report and runReport', async () => {
    const mod = await import('./report.js');
    assert.equal(typeof mod.report, 'function');
    assert.equal(typeof mod.runReport, 'function');
  });
});

describe('report cache invalidation includes report.js', () => {
  it('templateFiles array includes src/report.js', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/report.js', 'utf8');
    assert.ok(src.includes("'src/report.js'"), 'templateFiles should include src/report.js');
    // Every report module must be in the template hash.
    for (const f of ['src/report.js', 'src/report-portfolio.js', 'src/report-portfolio-data.js', 'src/report-repo.js', 'src/report-styles.js', 'src/report-shared.js']) {
      assert.ok(src.includes(`'${f}'`), `templateFiles should include ${f}`);
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
