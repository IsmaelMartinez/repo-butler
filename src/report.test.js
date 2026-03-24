import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateHealthBadge, buildActionItems } from './report.js';

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

  it('shows repos with most open issues card', async () => {
    const { generateDigestReport } = await import('./report.js');
    const repos = [
      { name: 'issue-heavy', stars: 1, forks: 0, open_issues: 15, pushed_at: new Date().toISOString(), archived: false, fork: false },
    ];
    const repoDetails = {
      'issue-heavy': { commits: 10, weekly: [1], vulns: null, ciPassRate: 0.9, open_issues: 15 },
    };

    const html = generateDigestReport('owner', repos, repoDetails);
    assert.ok(html.includes('Repos With Most Open Issues'), 'should have issues card');
    assert.ok(html.includes('issue-heavy'), 'should mention repo');
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

describe('generateHealthBadge', () => {
  it('returns a valid SVG string', () => {
    const svg = generateHealthBadge('my-repo', 4, 6);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('</svg>'));
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  });

  it('contains the score text', () => {
    const svg = generateHealthBadge('test-repo', 3, 6);
    assert.ok(svg.includes('3/6'));
  });

  it('contains the label text', () => {
    const svg = generateHealthBadge('test-repo', 5, 6);
    assert.ok(svg.includes('health'));
  });

  it('uses green color for high scores', () => {
    const svg = generateHealthBadge('repo', 5, 6);
    assert.ok(svg.includes('#4c1'));
  });

  it('uses yellow color for mid scores', () => {
    const svg = generateHealthBadge('repo', 3, 6);
    assert.ok(svg.includes('#dfb317'));
  });

  it('uses red color for low scores', () => {
    const svg = generateHealthBadge('repo', 1, 6);
    assert.ok(svg.includes('#e05d44'));
  });

  it('uses green color at exact threshold', () => {
    const svg = generateHealthBadge('repo', 4, 6);
    assert.ok(svg.includes('#4c1'));
  });

  it('uses red color at yellow boundary (score 2 is red)', () => {
    const svg = generateHealthBadge('repo', 2, 6);
    assert.ok(svg.includes('#e05d44'));
  });

  it('escapes HTML in repo name', () => {
    const svg = generateHealthBadge('<script>xss</script>', 4, 6);
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
  });

  it('handles zero score', () => {
    const svg = generateHealthBadge('repo', 0, 6);
    assert.ok(svg.includes('0/6'));
    assert.ok(svg.includes('#e05d44'));
  });

  it('handles perfect score', () => {
    const svg = generateHealthBadge('repo', 6, 6);
    assert.ok(svg.includes('6/6'));
    assert.ok(svg.includes('#4c1'));
  });
});

describe('buildActionItems', () => {
  const baseSnapshot = {
    repository: 'owner/repo',
    issues: { open: [] },
    dependabot_alerts: null,
    ci_pass_rate: null,
    summary: {},
  };

  it('returns empty array when no actionable data', () => {
    const items = buildActionItems(baseSnapshot, []);
    assert.deepEqual(items, []);
  });

  it('detects merge-ready PRs (not draft, not bot, no review requested)', () => {
    const openPRs = [
      { number: 10, title: 'Fix typo', author: 'alice', age_days: 3, draft: false, bot: false, labels: [], review_requested: false },
      { number: 11, title: 'Draft PR', author: 'bob', age_days: 5, draft: true, bot: false, labels: [], review_requested: false },
    ];
    const items = buildActionItems(baseSnapshot, openPRs);
    const mergeItem = items.find(i => i.priority === 1);
    assert.ok(mergeItem, 'should have a merge-ready action');
    assert.ok(mergeItem.text.includes('#10'), 'should reference merge-ready PR');
    assert.ok(!mergeItem.text.includes('#11'), 'should not include draft PR');
    assert.equal(mergeItem.effort, 'quick win');
    assert.equal(mergeItem.impact, 'high');
  });

  it('ignores PRs with age_days 0 for merge-ready', () => {
    const openPRs = [
      { number: 10, title: 'Just opened', author: 'alice', age_days: 0, draft: false, bot: false, labels: [], review_requested: false },
    ];
    const items = buildActionItems(baseSnapshot, openPRs);
    assert.ok(!items.some(i => i.priority === 1), 'brand-new PRs should not be flagged');
  });

  it('detects critical and high vulnerability alerts', () => {
    const snapshot = {
      ...baseSnapshot,
      dependabot_alerts: { count: 3, critical: 1, high: 2, medium: 0, low: 0, max_severity: 'critical' },
    };
    const items = buildActionItems(snapshot, []);
    const vulnItem = items.find(i => i.priority === 2);
    assert.ok(vulnItem, 'should have a vulnerability action');
    assert.ok(vulnItem.text.includes('1 critical'));
    assert.ok(vulnItem.text.includes('2 high'));
    assert.equal(vulnItem.effort, 'moderate');
    assert.equal(vulnItem.impact, 'high');
  });

  it('ignores medium/low-only vulnerability alerts', () => {
    const snapshot = {
      ...baseSnapshot,
      dependabot_alerts: { count: 2, critical: 0, high: 0, medium: 1, low: 1, max_severity: 'medium' },
    };
    const items = buildActionItems(snapshot, []);
    assert.ok(!items.some(i => i.priority === 2), 'should not flag medium/low vulns');
  });

  it('detects PRs awaiting review for more than 7 days', () => {
    const openPRs = [
      { number: 20, title: 'Feature', author: 'carol', age_days: 14, draft: false, bot: false, labels: [], review_requested: true },
      { number: 21, title: 'Quick fix', author: 'dave', age_days: 3, draft: false, bot: false, labels: [], review_requested: true },
    ];
    const items = buildActionItems(baseSnapshot, openPRs);
    const reviewItem = items.find(i => i.priority === 3);
    assert.ok(reviewItem, 'should have a needs-review action');
    assert.ok(reviewItem.text.includes('#20'), 'should reference old review PR');
    assert.ok(!reviewItem.text.includes('#21'), 'should not include recent PR');
  });

  it('detects stale awaiting-feedback issues older than 30 days', () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    const snapshot = {
      ...baseSnapshot,
      issues: {
        open: [
          { number: 100, title: 'Stale issue', labels: ['awaiting-feedback'], updated_at: fortyDaysAgo, created_at: fortyDaysAgo, comments: 0 },
          { number: 101, title: 'Recent issue', labels: ['awaiting-feedback'], updated_at: tenDaysAgo, created_at: tenDaysAgo, comments: 1 },
          { number: 102, title: 'Not feedback', labels: ['bug'], updated_at: fortyDaysAgo, created_at: fortyDaysAgo, comments: 0 },
        ],
      },
    };
    const items = buildActionItems(snapshot, []);
    const staleItem = items.find(i => i.priority === 4);
    assert.ok(staleItem, 'should have a stale-feedback action');
    assert.ok(staleItem.text.includes('#100'), 'should reference stale feedback issue');
    assert.ok(!staleItem.text.includes('#101'), 'should not include recent feedback issue');
    assert.ok(!staleItem.text.includes('#102'), 'should not include non-feedback issue');
  });

  it('detects low CI pass rate', () => {
    const snapshot = {
      ...baseSnapshot,
      ci_pass_rate: { pass_rate: 0.55, total_runs: 20, passed: 11, failed: 9 },
    };
    const items = buildActionItems(snapshot, []);
    const ciItem = items.find(i => i.priority === 5);
    assert.ok(ciItem, 'should have a CI action');
    assert.ok(ciItem.text.includes('55%'));
    assert.equal(ciItem.effort, 'moderate');
  });

  it('does not flag CI when pass rate is healthy', () => {
    const snapshot = {
      ...baseSnapshot,
      ci_pass_rate: { pass_rate: 0.95, total_runs: 100, passed: 95, failed: 5 },
    };
    const items = buildActionItems(snapshot, []);
    assert.ok(!items.some(i => i.priority === 5), 'should not flag healthy CI');
  });

  it('detects draft PRs as needing author rework', () => {
    const openPRs = [
      { number: 30, title: 'WIP feature', author: 'eve', age_days: 10, draft: true, bot: false, labels: [], review_requested: false },
      { number: 31, title: 'Bot draft', author: 'dependabot[bot]', age_days: 5, draft: true, bot: true, labels: [], review_requested: false },
    ];
    const items = buildActionItems(baseSnapshot, openPRs);
    const draftItem = items.find(i => i.priority === 6);
    assert.ok(draftItem, 'should have a draft-PR action');
    assert.ok(draftItem.text.includes('#30'), 'should reference human draft PR');
    assert.ok(!draftItem.text.includes('#31'), 'should not include bot draft PR');
  });

  it('returns items sorted by priority', () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    const snapshot = {
      ...baseSnapshot,
      dependabot_alerts: { count: 1, critical: 1, high: 0, medium: 0, low: 0, max_severity: 'critical' },
      ci_pass_rate: { pass_rate: 0.5, total_runs: 10, passed: 5, failed: 5 },
      issues: {
        open: [
          { number: 50, title: 'Old feedback', labels: ['awaiting-feedback'], updated_at: fortyDaysAgo, created_at: fortyDaysAgo, comments: 0 },
        ],
      },
    };
    const openPRs = [
      { number: 40, title: 'Ready PR', author: 'alice', age_days: 2, draft: false, bot: false, labels: [], review_requested: false },
      { number: 41, title: 'Review PR', author: 'bob', age_days: 10, draft: false, bot: false, labels: [], review_requested: true },
    ];
    const items = buildActionItems(snapshot, openPRs);
    assert.ok(items.length >= 4, 'should detect multiple action types');
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i].priority >= items[i - 1].priority, 'items should be in priority order');
    }
  });

  it('handles null openPRs gracefully', () => {
    const items = buildActionItems(baseSnapshot, null);
    assert.deepEqual(items, []);
  });

  it('limits stale feedback issue references to 5', () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    const issues = Array.from({ length: 8 }, (_, i) => ({
      number: 200 + i, title: `Issue ${i}`, labels: ['awaiting-feedback'],
      updated_at: fortyDaysAgo, created_at: fortyDaysAgo, comments: 0,
    }));
    const snapshot = { ...baseSnapshot, issues: { open: issues } };
    const items = buildActionItems(snapshot, []);
    const staleItem = items.find(i => i.priority === 4);
    assert.ok(staleItem.text.includes('and 3 more'), 'should indicate remaining issues');
  });
});
