import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('report module', () => {
  it('exports report and generateDigestReport', async () => {
    const mod = await import('./report.js');
    assert.equal(typeof mod.report, 'function');
    assert.equal(typeof mod.generateDigestReport, 'function');
  });
});

describe('generateDigestReport', () => {
  it('produces HTML containing digest structure', async () => {
    const { generateDigestReport } = await import('./report.js');
    const repos = [
      { name: 'alpha', description: 'Test repo', language: 'JavaScript', stars: 10, forks: 2, open_issues: 3, pushed_at: new Date().toISOString(), archived: false, fork: false },
      { name: 'beta', description: 'Another repo', language: 'Go', stars: 5, forks: 1, open_issues: 12, pushed_at: new Date().toISOString(), archived: false, fork: false },
    ];
    const repoDetails = {
      alpha: { commits: 50, weekly: [0, 1, 3, 0, 2, 5], license: 'MIT', ci: 2, communityHealth: 80, vulns: null, ciPassRate: 0.95, open_issues: 3 },
      beta: { commits: 120, weekly: [2, 4, 1, 3, 5, 8], license: 'Apache-2.0', ci: 1, communityHealth: 60, vulns: { count: 2, max_severity: 'high' }, ciPassRate: 0.65, open_issues: 12 },
    };

    const html = generateDigestReport('testowner', repos, repoDetails);

    assert.ok(html.includes('<!DOCTYPE html>'), 'should be valid HTML');
    assert.ok(html.includes('Weekly Digest'), 'should have digest title');
    assert.ok(html.includes('@testowner'), 'should include owner');
    assert.ok(html.includes('index.html'), 'should link to portfolio');
    assert.ok(html.includes('This Week at a Glance'), 'should have summary card');
    assert.ok(html.includes('Most Active Repos'), 'should have activity card');
    assert.ok(html.includes('beta'), 'should mention active repo');
  });

  it('shows vulnerability card when vulns exist', async () => {
    const { generateDigestReport } = await import('./report.js');
    const repos = [
      { name: 'vuln-repo', stars: 1, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false },
    ];
    const repoDetails = {
      'vuln-repo': { commits: 10, weekly: [1], vulns: { count: 3, max_severity: 'critical' }, ciPassRate: 0.9, open_issues: 0 },
    };

    const html = generateDigestReport('owner', repos, repoDetails);
    assert.ok(html.includes('Vulnerability Alerts'), 'should have vulnerability card');
    assert.ok(html.includes('critical'), 'should show severity');
  });

  it('shows CI concerns card when pass rate is low', async () => {
    const { generateDigestReport } = await import('./report.js');
    const repos = [
      { name: 'ci-repo', stars: 1, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false },
    ];
    const repoDetails = {
      'ci-repo': { commits: 20, weekly: [2], vulns: null, ciPassRate: 0.55, open_issues: 0 },
    };

    const html = generateDigestReport('owner', repos, repoDetails);
    assert.ok(html.includes('CI Pass Rate Concerns'), 'should have CI card');
    assert.ok(html.includes('55%'), 'should show pass rate');
  });

  it('shows dormant repos card', async () => {
    const { generateDigestReport } = await import('./report.js');
    const sevenMonthsAgo = new Date(Date.now() - 210 * 86400000).toISOString();
    const repos = [
      { name: 'old-repo', stars: 1, forks: 0, open_issues: 0, pushed_at: sevenMonthsAgo, archived: false, fork: false },
    ];
    const repoDetails = {};

    const html = generateDigestReport('owner', repos, repoDetails);
    assert.ok(html.includes('Dormant Repos'), 'should have dormant card');
    assert.ok(html.includes('old-repo'), 'should mention dormant repo');
  });

  it('excludes archived and fork repos', async () => {
    const { generateDigestReport } = await import('./report.js');
    const repos = [
      { name: 'archived-repo', stars: 1, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: true, fork: false },
      { name: 'forked-repo', stars: 1, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: true },
      { name: 'real-repo', stars: 1, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false },
    ];
    const repoDetails = {
      'real-repo': { commits: 5, weekly: [1], vulns: null, ciPassRate: 0.99, open_issues: 0 },
    };

    const html = generateDigestReport('owner', repos, repoDetails);
    assert.ok(html.includes('real-repo'), 'should include real repo');
    assert.ok(!html.includes('archived-repo'), 'should exclude archived');
    assert.ok(!html.includes('forked-repo'), 'should exclude forks');
  });
});
