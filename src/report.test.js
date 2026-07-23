import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateHealthBadge, buildActionItems, computeHealthTier, computeContributorStats, generateSparklineSVG, buildCampaignSection, buildGovernanceSection, reportCacheHit } from './report.js';
import { isReleaseExempt, isBugIssue, isFeatureIssue, REPO_CACHE_SCHEMA_VERSION, CAMPAIGN_DEFS, REPO_EXCLUSION_PATTERNS, buildRepoSnapshot, jsStr, deployedLink } from './report-shared.js';

describe('jsStr', () => {
  it('quotes and escapes strings for inline <script> embedding', () => {
    assert.equal(jsStr('v1.2.3'), '"v1.2.3"');
    assert.equal(jsStr(`v1'+alert(1)+'`), '"v1\'+alert(1)+\'"');
  });

  it('neutralises script-element breakout sequences', () => {
    const out = jsStr('</script><script>alert(1)</script>');
    assert.ok(!out.includes('</script>'));
    assert.ok(!out.includes('<'));
    assert.ok(!out.includes('>'));
  });

  it('escapes quotes, backslashes, and newlines', () => {
    assert.equal(jsStr('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  });
});

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
    const svg = generateHealthBadge('my-repo', 'gold');
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('</svg>'));
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  });

  it('contains the tier name for gold', () => {
    const svg = generateHealthBadge('repo', 'gold');
    assert.ok(svg.includes('Gold'));
    assert.ok(svg.includes('#ffd700'));
  });

  it('contains the tier name for silver', () => {
    const svg = generateHealthBadge('repo', 'silver');
    assert.ok(svg.includes('Silver'));
    assert.ok(svg.includes('#c0c0c0'));
  });

  it('contains the tier name for bronze', () => {
    const svg = generateHealthBadge('repo', 'bronze');
    assert.ok(svg.includes('Bronze'));
    assert.ok(svg.includes('#cd7f32'));
  });

  it('shows Unranked for none tier', () => {
    const svg = generateHealthBadge('repo', 'none');
    assert.ok(svg.includes('Unranked'));
    assert.ok(svg.includes('#6e7681'));
  });

  it('contains the label text', () => {
    const svg = generateHealthBadge('test-repo', 'silver');
    assert.ok(svg.includes('health'));
  });

  it('escapes HTML in repo name', () => {
    const svg = generateHealthBadge('<script>xss</script>', 'gold');
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
  });
});

describe('computeHealthTier', () => {
  const now = new Date().toISOString();
  const ninetyOneDaysAgo = new Date(Date.now() - 91 * 86400000).toISOString();
  const sevenMonthsAgo = new Date(Date.now() - 210 * 86400000).toISOString();
  const thirteenMonthsAgo = new Date(Date.now() - 400 * 86400000).toISOString();

  it('assigns gold tier when all criteria are met', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier, checks } = computeHealthTier(r);
    assert.equal(tier, 'gold');
    assert.ok(checks.every(c => c.passed), 'all checks should pass for gold');
  });

  it('ignores the Dependabot autofix state — an open high alert still drops the tier (ADR-012 Phase 3)', () => {
    // "In flight" is a governance annotation, NOT a tier reprieve: whether or not
    // autofix is opening bump PRs, the alert is still open, so the Gold security
    // check must fail identically with autofix on, off, or unknown.
    const base = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: { count: 1, high: 1, max_severity: 'high' }, commits: 50,
    };
    const withOn = computeHealthTier({ ...base, autofix: { enabled: true, paused: false } });
    const withOff = computeHealthTier({ ...base, autofix: { enabled: false, paused: false } });
    const withNone = computeHealthTier(base);
    assert.notEqual(withNone.tier, 'gold', 'an open high alert blocks gold');
    assert.equal(withOn.tier, withNone.tier, 'autofix ON must not change the tier');
    assert.equal(withOff.tier, withNone.tier, 'autofix OFF must not change the tier');
    const secCheck = c => c.name.toLowerCase().includes('security');
    assert.deepEqual(
      withOn.checks.filter(secCheck).map(c => c.passed),
      withNone.checks.filter(secCheck).map(c => c.passed),
      'the security check outcome is identical regardless of autofix state',
    );
  });

  it('assigns silver when gold criteria fail but silver pass', () => {
    const r = {
      ci: 1, license: 'MIT', open_issues: 15, pushed_at: now,
      communityHealth: 60, vulns: null, commits: 10,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('assigns bronze when only basic activity exists', () => {
    const r = {
      ci: 0, license: 'None', open_issues: 0, pushed_at: sevenMonthsAgo,
      communityHealth: 20, vulns: null, commits: 5,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('assigns none when repo is completely inactive', () => {
    const r = {
      ci: 0, license: 'None', open_issues: 0, pushed_at: thirteenMonthsAgo,
      communityHealth: null, vulns: null, commits: 0,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'none');
  });

  it('returns checks array with name, passed, and required_for', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 10,
    };
    const { checks } = computeHealthTier(r);
    assert.ok(checks.length > 0, 'should have checks');
    for (const c of checks) {
      assert.ok('name' in c, 'check should have name');
      assert.ok('passed' in c, 'check should have passed');
      assert.ok('required_for' in c, 'check should have required_for');
      assert.ok(['gold', 'silver', 'bronze'].includes(c.required_for));
    }
  });

  it('fails gold when community health is below 80 but above 50', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 60, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails gold when critical vulnerabilities exist', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 1, max_severity: 'critical' }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails gold when high vulnerabilities exist', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 1, max_severity: 'high' }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold allows medium/low vulnerabilities', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 2, max_severity: 'medium' }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'gold');
  });

  it('fails gold when open bugs >= 10', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 25, open_bugs: 10, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold passes with many open issues if few are bugs', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 50, open_bugs: 3, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'gold');
  });

  it('falls back to open_issues when open_bugs is not set', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 20, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails gold when released_at > 90 days ago', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: ninetyOneDaysAgo,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails gold when pushed_at is recent but released_at is missing', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: null,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('fails silver when no license', () => {
    const r = {
      ci: 1, license: 'None', open_issues: 0, pushed_at: now,
      communityHealth: 60, vulns: null, commits: 10,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('fails silver when community health below 50', () => {
    const r = {
      ci: 1, license: 'MIT', open_issues: 0, pushed_at: now,
      communityHealth: 30, vulns: null, commits: 10,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('fails silver when pushed_at > 180 days ago', () => {
    const r = {
      ci: 1, license: 'MIT', open_issues: 0, pushed_at: sevenMonthsAgo,
      communityHealth: 60, vulns: null, commits: 10,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('bronze with commits but old push date within a year', () => {
    const elevenMonthsAgo = new Date(Date.now() - 330 * 86400000).toISOString();
    const r = {
      ci: 0, license: 'None', open_issues: 0, pushed_at: elevenMonthsAgo,
      communityHealth: null, vulns: null, commits: 3,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'bronze');
  });

  it('gold requires at least one security scanner configured', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: null, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold requires CI workflows >= 2', () => {
    const r = {
      ci: 1, license: 'MIT', open_issues: 0, pushed_at: now, released_at: now,
      communityHealth: 90, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold passes security check with only code scanning configured (no dependabot)', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: { count: 0, max_severity: null }, secretScanning: null, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'gold');
  });

  it('gold passes security check with only secret scanning configured', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: null, secretScanning: { count: 0 }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'gold');
  });

  it('gold fails security check when no scanner is configured', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: null, secretScanning: null, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold fails when code scanning has critical findings', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: { count: 1, max_severity: 'critical' }, secretScanning: null, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold fails when secret scanning has open alerts', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: now,
      communityHealth: 85, vulns: null, codeScanning: null, secretScanning: { count: 1 }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
  });

  it('gold passes release check when releaseExempt option is true', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: null,
      communityHealth: 85, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r, { releaseExempt: true });
    assert.equal(tier, 'gold');
  });

  it('gold still fails release check when releaseExempt is false (default)', () => {
    const r = {
      ci: 2, license: 'MIT', open_issues: 5, pushed_at: now, released_at: null,
      communityHealth: 85, vulns: { count: 0, max_severity: null }, commits: 50,
    };
    const { tier } = computeHealthTier(r);
    assert.equal(tier, 'silver');
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

describe('computeContributorStats', () => {
  it('computes total unique human contributors', () => {
    const prAuthors = [
      { author: 'alice', count: 5, firstTime: false },
      { author: 'bob', count: 2, firstTime: true },
      { author: 'dependabot[bot]', count: 10, firstTime: false },
    ];
    const stats = computeContributorStats(prAuthors, 100);
    assert.equal(stats.total, 2, 'should count only human authors');
  });

  it('identifies first-time contributors', () => {
    const prAuthors = [
      { author: 'alice', count: 5, firstTime: false },
      { author: 'bob', count: 1, firstTime: true },
      { author: 'carol', count: 1, firstTime: true },
    ];
    const stats = computeContributorStats(prAuthors, 50);
    assert.equal(stats.firstTimers.length, 2);
    assert.equal(stats.firstTimers[0].author, 'bob');
    assert.equal(stats.firstTimers[1].author, 'carol');
  });

  it('excludes bots from first-time contributors', () => {
    const prAuthors = [
      { author: 'renovate[bot]', count: 3, firstTime: true },
      { author: 'alice', count: 1, firstTime: true },
    ];
    const stats = computeContributorStats(prAuthors, 10);
    assert.equal(stats.firstTimers.length, 1);
    assert.equal(stats.firstTimers[0].author, 'alice');
  });

  it('computes contributor confidence ratio as percentage', () => {
    const prAuthors = [
      { author: 'alice', count: 3, firstTime: false },
      { author: 'bob', count: 1, firstTime: false },
    ];
    const stats = computeContributorStats(prAuthors, 40);
    assert.equal(stats.ratio, 5.0, '2/40 = 5%');
  });

  it('returns 0 ratio when stargazers is 0', () => {
    const prAuthors = [
      { author: 'alice', count: 3, firstTime: false },
    ];
    const stats = computeContributorStats(prAuthors, 0);
    assert.equal(stats.ratio, 0);
  });

  it('handles empty prAuthors array', () => {
    const stats = computeContributorStats([], 100);
    assert.equal(stats.total, 0);
    assert.equal(stats.firstTimers.length, 0);
    assert.equal(stats.ratio, 0);
  });

  it('rounds ratio to one decimal place', () => {
    const prAuthors = [
      { author: 'alice', count: 1, firstTime: false },
      { author: 'bob', count: 1, firstTime: false },
      { author: 'carol', count: 1, firstTime: false },
    ];
    const stats = computeContributorStats(prAuthors, 7);
    assert.equal(stats.ratio, 42.9, '3/7 ≈ 42.857 rounds to 42.9');
  });
});

describe('buildCampaignSection', () => {
  const makeRepo = (name, overrides = {}) => ({
    name, archived: false, fork: false, pushed_at: new Date().toISOString(),
    stars: 1, forks: 0, open_issues: 0, ...overrides,
  });

  it('returns empty string when no eligible repos', () => {
    const html = buildCampaignSection([], {});
    assert.equal(html, '');
  });

  it('returns empty string when all repos are archived or forks', () => {
    const repos = [
      makeRepo('archived-one', { archived: true }),
      makeRepo('forked-one', { fork: true }),
    ];
    const details = {
      'archived-one': { communityHealth: 90, vulns: null, ciPassRate: 0.95, license: 'MIT', hasIssueTemplate: true },
      'forked-one': { communityHealth: 90, vulns: null, ciPassRate: 0.95, license: 'MIT', hasIssueTemplate: true },
    };
    const html = buildCampaignSection(repos, details);
    assert.equal(html, '');
  });

  it('detects all five campaigns', () => {
    const repos = [makeRepo('alpha'), makeRepo('beta')];
    const details = {
      alpha: { communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, license: 'MIT', hasIssueTemplate: true },
      beta: { communityHealth: 50, vulns: { count: 1, max_severity: 'critical' }, ciPassRate: 0.7, license: 'None', hasIssueTemplate: false },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('Community Health'), 'should have community health campaign');
    assert.ok(html.includes('Vulnerability Free'), 'should have vulnerability campaign');
    assert.ok(html.includes('CI Reliability'), 'should have CI campaign');
    assert.ok(html.includes('License Compliance'), 'should have license campaign');
    assert.ok(html.includes('Issue Templates'), 'should have issue templates campaign');
  });

  it('shows correct progress ratio for community health', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c')];
    const details = {
      a: { communityHealth: 90, vulns: null, ciPassRate: null, license: 'None', hasIssueTemplate: false },
      b: { communityHealth: 80, vulns: null, ciPassRate: null, license: 'None', hasIssueTemplate: false },
      c: { communityHealth: 50, vulns: null, ciPassRate: null, license: 'None', hasIssueTemplate: false },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('2/3'), 'should show 2 out of 3 compliant for community health');
  });

  it('lists non-compliant repos with links', () => {
    const repos = [makeRepo('good'), makeRepo('bad')];
    const details = {
      good: { communityHealth: 90, vulns: null, ciPassRate: null, license: 'MIT', hasIssueTemplate: false },
      bad: { communityHealth: 30, vulns: null, ciPassRate: null, license: 'None', hasIssueTemplate: false },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('bad.html'), 'should link to non-compliant repo report');
  });

  it('shows all repos compliant when 100%', () => {
    const repos = [makeRepo('perfect')];
    const details = {
      perfect: { communityHealth: 95, vulns: { count: 0, max_severity: null }, ciPassRate: 0.99, license: 'MIT', hasIssueTemplate: true },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('All repos compliant'), 'should show all compliant message');
  });

  it('excludes shadow and test-repo repos', () => {
    const repos = [makeRepo('real'), makeRepo('my-shadow'), makeRepo('test-repo-1')];
    const details = {
      real: { communityHealth: 90, vulns: null, ciPassRate: null, license: 'MIT', hasIssueTemplate: false },
      'my-shadow': { communityHealth: 90, vulns: null, ciPassRate: null, license: 'MIT', hasIssueTemplate: false },
      'test-repo-1': { communityHealth: 90, vulns: null, ciPassRate: null, license: 'MIT', hasIssueTemplate: false },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('1/1'), 'should only count the real repo');
    assert.ok(!html.includes('my-shadow'), 'should not mention shadow repo');
    assert.ok(!html.includes('test-repo-1'), 'should not mention test-repo');
  });

  it('excludes repos from campaign when data is unavailable (null)', () => {
    const repos = [makeRepo('no-dependabot')];
    const details = {
      'no-dependabot': { communityHealth: null, vulns: null, ciPassRate: null, license: 'None', hasIssueTemplate: false },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('data unavailable'), 'should note excluded repos');
    // License and issue templates still count (no applicable filter) => 0/1
    assert.ok(html.includes('0/1'), 'license and templates should still show 0/1');
  });

  it('only counts repos with available data in campaign denominator', () => {
    const repos = [makeRepo('has-data'), makeRepo('no-data')];
    const details = {
      'has-data': { communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, license: 'MIT', hasIssueTemplate: true },
      'no-data': { communityHealth: null, vulns: null, ciPassRate: null, license: 'None', hasIssueTemplate: false },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('1/1'), 'vuln/CI/community campaigns should show 1/1 for the repo with data');
    assert.ok(html.includes('data unavailable'), 'should note excluded repo');
  });

  it('generates valid HTML structure with campaign-grid', () => {
    const repos = [makeRepo('repo1')];
    const details = {
      repo1: { communityHealth: 50, vulns: null, ciPassRate: 0.5, license: 'MIT', hasIssueTemplate: false },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('Improvement Campaigns'), 'should have section heading');
    assert.ok(html.includes('campaign-grid'), 'should have campaign grid');
    assert.ok(html.includes('campaign-card'), 'should have campaign cards');
    assert.ok(html.includes('campaign-bar'), 'should have progress bars');
  });

  it('includes repos without details in denominator as non-compliant', () => {
    const repos = [makeRepo('with-data'), makeRepo('no-data')];
    const details = {
      'with-data': { communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, license: 'MIT', hasIssueTemplate: true },
    };
    const html = buildCampaignSection(repos, details);
    assert.ok(html.includes('1/2'), 'should count both repos in total');
    assert.ok(html.includes('no-data'), 'should list repo without details as non-compliant');
  });

  it('wraps non-compliant campaign repos in details element', () => {
    const repos = [makeRepo('good'), makeRepo('bad')];
    const details = {
      good: { communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, license: 'MIT', hasIssueTemplate: true },
      bad: { communityHealth: 40, vulns: null, ciPassRate: 0.5, license: 'None', hasIssueTemplate: false },
    };
    const html = buildCampaignSection(repos, details);
    const detailsCount = (html.match(/<details>/g) || []).length;
    assert.ok(detailsCount > 0, 'non-compliant repos should be in details elements');
  });
});

describe('CAMPAIGN_DEFS shared definitions', () => {
  it('exposes exactly the five expected campaigns', () => {
    assert.equal(CAMPAIGN_DEFS.length, 5);
    assert.deepEqual(
      CAMPAIGN_DEFS.map(c => c.name),
      ['Community Health', 'Vulnerability Free', 'CI Reliability', 'License Compliance', 'Issue Templates'],
    );
    for (const c of CAMPAIGN_DEFS) {
      assert.equal(typeof c.name, 'string');
      assert.equal(typeof c.description, 'string');
      assert.equal(typeof c.test, 'function');
      // applicable is optional (License + Issue Templates rely on the default).
      if (c.applicable !== undefined) assert.equal(typeof c.applicable, 'function');
    }
  });

  it('MCP get_campaign_status and buildCampaignSection agree on counts for the same fake portfolio', () => {
    // Fake portfolio: a healthy repo, a partially-compliant repo, a non-compliant
    // repo, and an excluded shadow repo (must be filtered identically by both).
    const data = {
      alpha: { communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.99, license: 'MIT', hasIssueTemplate: true },
      beta:  { communityHealth: 70, vulns: { count: 1, max_severity: 'high' }, ciPassRate: 0.85, license: 'Apache-2.0', hasIssueTemplate: false },
      gamma: { communityHealth: null, vulns: null, ciPassRate: null, license: 'None', hasIssueTemplate: false },
      'my-shadow': { communityHealth: 95, vulns: { count: 0, max_severity: null }, ciPassRate: 1, license: 'MIT', hasIssueTemplate: true },
    };

    // Mirror what mcp.js computeCampaigns does:
    const mcpRepos = Object.keys(data)
      .filter(name => !REPO_EXCLUSION_PATTERNS.some(p => name.includes(p)))
      .map(name => ({ name }));
    const mcpResult = CAMPAIGN_DEFS.map(c => {
      const pool = c.applicable ? mcpRepos.filter(r => c.applicable(r, data)) : mcpRepos;
      const compliant = pool.filter(r => c.test(r, data));
      return { name: c.name, total: pool.length, compliant: compliant.length };
    });

    // Build the dashboard HTML for the same portfolio and parse the per-campaign
    // ratios (rendered as `${count}/${total}` inside campaign-ratio spans).
    const dashRepos = Object.keys(data).map(name => ({
      name, archived: false, fork: false, pushed_at: new Date().toISOString(),
      stars: 1, forks: 0, open_issues: 0,
    }));
    const html = buildCampaignSection(dashRepos, data);
    const ratioMatches = [...html.matchAll(/<h3>([^<]+)<\/h3><span class="campaign-ratio">(\d+)\/(\d+)<\/span>/g)];
    const dashResult = ratioMatches.map(m => ({
      name: m[1], compliant: Number(m[2]), total: Number(m[3]),
    }));

    assert.deepEqual(dashResult, mcpResult,
      'MCP computeCampaigns and dashboard buildCampaignSection must report identical {compliant,total} per campaign');
  });
});

describe('generateSparklineSVG', () => {
  it('returns a valid SVG polyline for normal weekly data', () => {
    const data = [0, 2, 5, 3, 1, 4, 7, 2, 0, 3, 6, 8, 4, 1, 0, 2, 5, 3, 7, 9, 4, 2, 1, 3, 6, 5];
    const svg = generateSparklineSVG(data);
    assert.ok(svg.startsWith('<svg'), 'should be an SVG element');
    assert.ok(svg.includes('</svg>'), 'should close the SVG');
    assert.ok(svg.includes('polyline'), 'should contain a polyline');
    assert.ok(svg.includes('currentColor'), 'stroke uses currentColor (themed via .spark)');
    assert.ok(svg.includes('class="spark"'), 'svg carries the spark class for theming');
    assert.ok(svg.includes('width="80"'), 'should be 80px wide');
    assert.ok(svg.includes('height="20"'), 'should be 20px tall');
  });

  it('returns empty string for null data', () => {
    assert.equal(generateSparklineSVG(null), '');
  });

  it('returns empty string for empty array', () => {
    assert.equal(generateSparklineSVG([]), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(generateSparklineSVG(undefined), '');
  });

  it('returns a dot for single data point', () => {
    const svg = generateSparklineSVG([5]);
    assert.ok(svg.includes('<circle'), 'single point should render as a circle');
    assert.ok(svg.includes('currentColor'), 'stroke uses currentColor (themed via .spark)');
    assert.ok(svg.includes('class="spark"'), 'svg carries the spark class for theming');
  });

  it('returns a flat line for all zeros', () => {
    const data = [0, 0, 0, 0, 0, 0];
    const svg = generateSparklineSVG(data);
    assert.ok(svg.includes('<line'), 'all zeros should render as a flat line');
    assert.ok(svg.includes('currentColor'), 'stroke uses currentColor (themed via .spark)');
    assert.ok(svg.includes('class="spark"'), 'svg carries the spark class for theming');
    assert.ok(svg.includes('opacity="0.4"'), 'flat line should be muted');
  });
});

describe('isReleaseExempt', () => {
  it('returns true for a repo listed in release_exempt', () => {
    assert.equal(isReleaseExempt('sound3fy', { release_exempt: 'sound3fy,other-repo' }), true);
  });

  it('returns false for a repo not listed in release_exempt', () => {
    assert.equal(isReleaseExempt('repo-butler', { release_exempt: 'sound3fy' }), false);
  });

  it('returns false when release_exempt is empty string', () => {
    assert.equal(isReleaseExempt('sound3fy', { release_exempt: '' }), false);
  });

  it('returns false when release_exempt key is missing', () => {
    assert.equal(isReleaseExempt('sound3fy', {}), false);
  });

  it('handles whitespace around repo names in comma-separated list', () => {
    assert.equal(isReleaseExempt('sound3fy', { release_exempt: ' sound3fy , other-repo ' }), true);
  });
});

describe('isBugIssue', () => {
  it('returns true for bug label', () => {
    assert.equal(isBugIssue(['bug']), true);
  });

  it('returns true for case-insensitive match', () => {
    assert.equal(isBugIssue(['Bug']), true);
    assert.equal(isBugIssue(['BUG']), true);
  });

  it('returns true for variant bug labels', () => {
    assert.equal(isBugIssue(['defect']), true);
    assert.equal(isBugIssue(['type: bug']), true);
    assert.equal(isBugIssue(['kind/bug']), true);
  });

  it('returns false for feature labels', () => {
    assert.equal(isBugIssue(['enhancement']), false);
    assert.equal(isBugIssue(['feature']), false);
  });

  it('returns false for empty labels', () => {
    assert.equal(isBugIssue([]), false);
  });

  it('returns true when bug is among multiple labels', () => {
    assert.equal(isBugIssue(['priority: high', 'bug', 'frontend']), true);
  });
});

describe('isFeatureIssue', () => {
  it('returns true for enhancement label', () => {
    assert.equal(isFeatureIssue(['enhancement']), true);
  });

  it('returns true for feature-request label', () => {
    assert.equal(isFeatureIssue(['feature-request']), true);
  });

  it('returns false for bug labels', () => {
    assert.equal(isFeatureIssue(['bug']), false);
  });

  it('returns false when both bug and enhancement are present (bug takes precedence)', () => {
    assert.equal(isFeatureIssue(['bug', 'enhancement']), false);
  });

  it('returns false for unlabeled issues', () => {
    assert.equal(isFeatureIssue([]), false);
  });
});

describe('CSS includes collapsible styles', () => {
  it('has details and summary styling', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('details'), 'CSS should style details elements');
    assert.ok(CSS.includes('summary'), 'CSS should style summary elements');
  });
});

describe('CSS utility colour classes', () => {
  it('defines .muted, .text-success, .text-warning, .text-danger and .text-sm with the expected values', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('.muted{color:var(--muted)}'), 'CSS should define .muted');
    assert.ok(CSS.includes('.text-success{color:var(--color-success)}'), 'CSS should define .text-success');
    assert.ok(CSS.includes('.text-warning{color:var(--color-warning)}'), 'CSS should define .text-warning');
    assert.ok(CSS.includes('.text-danger{color:var(--color-danger)}'), 'CSS should define .text-danger');
    assert.ok(CSS.includes('.text-sm{font-size:0.75rem}'), 'CSS should define .text-sm');
  });

  it('defines :root design tokens for success/warning/danger colours', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('--color-success:#566a4c'), 'CSS should define the moss success token (Mistglen light)');
    assert.ok(CSS.includes('--color-warning:#9a7536'), 'CSS should define the whisky warning token');
    assert.ok(CSS.includes('--color-danger:#9e463c'), 'CSS should define the rust danger token');
    assert.ok(CSS.includes('@media(prefers-color-scheme:dark)'), 'CSS should carry the dark (Bothy) theme');
    assert.ok(CSS.includes('--color-danger:#dd7060'), 'dark theme should redefine danger lighter for legibility');
  });
});

describe('htmlPage shell template', () => {
  it('produces a full HTML document with head, body, CSS, and Chart.js CDN', async () => {
    const { htmlPage, CSS } = await import('./report-styles.js');
    const html = htmlPage({ title: 'Test Title', body: '<h1>Hello</h1>' });
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'starts with DOCTYPE');
    assert.ok(html.endsWith('</body></html>'), 'ends with closing body/html');
    assert.ok(html.includes('<title>Test Title</title>'), 'embeds title verbatim');
    assert.ok(html.includes(CSS), 'embeds shared CSS');
    assert.ok(html.includes('cdn.jsdelivr.net/npm/chart.js'), 'loads Chart.js from CDN');
    // Head must come before body.
    assert.ok(html.indexOf('</head>') < html.indexOf('<body>'), 'head precedes body');
    // Body content is interpolated unescaped.
    assert.ok(html.includes('<h1>Hello</h1>'), 'body interpolated verbatim');
  });

  it('omits the chart-defaults script when no charts are provided', async () => {
    const { htmlPage } = await import('./report-styles.js');
    const html = htmlPage({ title: 'No Charts', body: '<p>plain</p>' });
    assert.ok(!html.includes('Chart.defaults'), 'no defaults block when charts absent');
  });

  it('injects Chart.defaults and per-page chart code before </body>', async () => {
    const { htmlPage } = await import('./report-styles.js');
    const charts = "new Chart(document.getElementById('x'),{});";
    const html = htmlPage({ title: 'Charted', body: '<canvas id="x"></canvas>', charts });
    assert.ok(html.includes("Chart.defaults.color=__gv('--muted')"), 'sets default colour from the theme var');
    assert.ok(html.includes("Chart.defaults.borderColor=__gv('--sep')"), 'sets default grid colour from the theme var');
    assert.ok(html.includes(charts), 'injects per-page chart code verbatim');
    // Defaults must appear once, not twice.
    const matches = html.match(/Chart\.defaults\.color/g) || [];
    assert.equal(matches.length, 1, 'Chart.defaults block appears exactly once');
    // Charts script must be inside body (before </body>).
    assert.ok(html.indexOf(charts) < html.indexOf('</body>'), 'charts script before </body>');
  });
});

describe('Coorie theme (Mistglen light / Bothy dark)', () => {
  it('htmlPage wires the theme toggle, persistence script and color-scheme meta', async () => {
    const { htmlPage } = await import('./report-styles.js');
    const html = htmlPage({ title: 'T', body: '<p>x</p>' });
    assert.ok(html.includes('name="color-scheme" content="light dark"'), 'declares light+dark colour-scheme');
    assert.ok(html.includes("localStorage.getItem('rb-theme')"), 'restores a persisted theme before paint');
    assert.ok(html.includes('class="theme-toggle"'), 'renders the light/dark toggle');
    assert.ok(html.includes('function rbToggleTheme()'), 'includes the toggle handler');
  });

  it('CSS carries the photo hero, tweed texture, glen-hills and spark theming', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('url("assets/glencoe.jpg")'), 'hero references the self-hosted Glencoe photo');
    assert.ok(CSS.includes('url("assets/fabric.jpg")'), 'page uses the tweed texture');
    assert.ok(CSS.includes('--hills:url("assets/hills-light.svg")'), 'light theme glen-hills');
    assert.ok(CSS.includes('url("assets/hills-dark.svg")'), 'dark theme glen-hills');
    assert.ok(CSS.includes('.spark{color:var(--accent-line)}'), 'sparkline themed via currentColor');
    assert.ok(CSS.includes('background-image:var(--hero-overlay)'), 'hero overlay is theme-driven');
  });

  it('per-repo report links its charts to the runtime theme palette', async () => {
    const { generateRepoReport } = await import('./report-repo.js');
    const snapshot = {
      repository: 'owner/test', meta: { stars: 5, forks: 1, watchers: 2 },
      issues: { open: [] }, releases: [{ tag: 'v1', published_at: new Date().toISOString() }],
      community_profile: { health_percentage: 90, files: { readme: true, license: true } },
      dependabot_alerts: { count: 0, max_severity: null }, code_scanning_alerts: null, secret_scanning_alerts: { count: 0 },
      ci_pass_rate: { pass_rate: 0.98, total_runs: 100, passed: 98, failed: 2 },
      pushed_at: new Date().toISOString(), license: 'MIT', sbom: null,
      summary: { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 5, human_prs: 5, bot_prs: 0, releases: 1, latest_release: 'v1', ci_workflows: 4, bus_factor: 2, time_to_close_median: null },
    };
    const trends = { direction: 'stable', weeks: [{ week: 'W1', open_issues: 3, merged_prs: 2 }, { week: 'W2', open_issues: 2, merged_prs: 3 }] };
    const html = generateRepoReport(snapshot, [{ month: 'Jan', count: 5 }], [{ month: 'Jan', opened: 2, closed: 3 }], [{ author: 'dev', count: 5 }], trends, [], null, [], null, null, {});
    assert.ok(html.includes('var __C='), 'defines the runtime chart palette from CSS vars');
    assert.ok(html.includes('borderColor:__C.danger'), 'chart datasets use the themed palette, not fixed hexes');
    assert.ok(!/borderColor:'#[0-9a-f]{6}'/.test(html), 'no hard-coded chart border hexes');
  });
});

describe('buildPortfolioAttentionSection', () => {
  it('shows all-clear when no actions needed', async () => {
    const { buildPortfolioAttentionSection } = await import('./report-portfolio.js');
    const repos = [{ name: 'a' }];
    const details = { a: { vulns: { count: 0, max_severity: null }, codeScanning: null, secretScanning: null, ciPassRate: 0.95, open_bugs: 0 } };
    const html = buildPortfolioAttentionSection(repos, details, 'owner', {});
    assert.ok(html.includes('All clear'), 'should show all-clear message');
  });

  it('aggregates action items across repos', async () => {
    const { buildPortfolioAttentionSection } = await import('./report-portfolio.js');
    const repos = [{ name: 'a' }, { name: 'b' }];
    const details = {
      a: { vulns: { count: 2, critical: 1, high: 1, medium: 0, low: 0, max_severity: 'critical' }, codeScanning: null, secretScanning: null, ciPassRate: 0.95, open_bugs: 0 },
      b: { vulns: { count: 0, max_severity: null }, codeScanning: null, secretScanning: null, ciPassRate: 0.5, open_bugs: 0 },
    };
    const html = buildPortfolioAttentionSection(repos, details, 'owner', {});
    assert.ok(html.includes('Needs your attention'), 'should have attention heading');
    assert.ok(html.includes('a.html'), 'should link to repo a');
    assert.ok(html.includes('b.html'), 'should link to repo b');
  });
});

describe('generatePortfolioReport restructure', () => {
  it('has the status hero with tier mix instead of vanity stats', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const owner = 'test';
    const portfolio = { repos: [
      { name: 'a', stars: 5, forks: 1, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const details = { a: { commits: 20, weekly: [1,2], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const html = generatePortfolioReport(owner, portfolio, details, null, null, {});
    assert.ok(html.includes('class="status-hero'), 'should have the status hero');
    assert.ok(html.includes('1 Gold'), 'should show the tier mix in the hero');
    assert.ok(!html.includes('id="langChart"'), 'should not have language doughnut chart');
    assert.ok(!html.includes('id="statusChart"'), 'should not have status doughnut chart');
    assert.ok(!html.includes('id="commitChart"'), 'should not have commit totals chart');
  });

  it('has simplified health table with 6 columns and full view toggle', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [
      { name: 'b', stars: 1, forks: 0, open_issues: 2, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'Go' },
    ]};
    const details = { b: { commits: 15, weekly: [3], license: 'MIT', ci: 3, communityHealth: 85, vulns: { count: 0, max_severity: null }, ciPassRate: 0.92, open_issues: 2, open_bugs: 1, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('Next Step'), 'simplified table should have Next Step column');
    assert.ok(html.includes('Show all columns'), 'should have toggle for full table');
  });

  it('wraps commit activity in collapsible details', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [
      { name: 'c', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const details = { c: { commits: 10, weekly: [1,1,1], license: 'MIT', ci: 2, communityHealth: 80, vulns: { count: 0, max_severity: null }, ciPassRate: 1.0, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    // The commit activity chart should be inside a <details> element
    const detailsIdx = html.indexOf('<details');
    const weeklyChartIdx = html.indexOf('id="weeklyChart"');
    assert.ok(detailsIdx >= 0 && weeklyChartIdx > detailsIdx, 'weekly chart should be inside a details element');
  });
});

describe('calm dashboard hero, delta strip, and butler voice', () => {
  const goldPortfolio = () => ({
    portfolio: { repos: [{ name: 'a', stars: 1, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' }] },
    details: { a: { commits: 20, weekly: [1, 2], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } },
  });

  it('reads an all-gold portfolio as healthy in the butler voice with a clean vuln posture', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('status-ok'), 'all-gold portfolio renders the healthy tone');
    assert.ok(html.includes('All in good order'), 'healthy headline in the butler voice');
    assert.ok(html.includes('no open security alerts'), 'shows a clean security posture');
    assert.ok(html.includes('<details><summary>All repos'), 'all-gold collapses the repo table');
  });

  it('shows the settling-in line when there is no prior snapshot to diff', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('Since the last run'), 'has the since-the-last-run section');
    assert.ok(html.includes('Still settling in'), 'first run with no prior shows the settling-in line');
  });

  it('surfaces an upward tier move and gold trend against a prior snapshot', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    const prior = { repos: { a: { computed: { tier: 'silver' } } } };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {}, null, prior);
    assert.ok(html.includes('since-item since-up'), 'an upward tier move renders as an up item');
    assert.ok(html.includes('since-arrow'), 'renders the tier-move arrow');
    assert.ok(html.includes('status-trend up'), 'shows an upward gold trend in the hero');
  });

  it('reports a cleared security alert as an upward delta item', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    const prior = { repos: { a: { computed: { tier: 'gold' }, vulns: { count: 1, high: 1, max_severity: 'high' } } } };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {}, null, prior);
    assert.ok(html.includes('cleared its security alerts'), 'a resolved alert shows as a delta item');
  });

  it('raises the critical banner and crit voice when a repo has high alerts', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [{ name: 'risky', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' }] };
    const details = { risky: { commits: 10, weekly: [1], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 2, critical: 1, high: 1, max_severity: 'critical' }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('alert-banner alert-critical'), 'critical state renders the banner');
    assert.ok(html.includes('This rather wants your attention'), 'critical headline in the butler voice');
    assert.ok(html.includes('status-crit'), 'hero renders in the critical tone');
    assert.ok(html.includes('2 security alerts'), 'counts the critical/high alerts');
  });

  it('opens the repo table and reads as attention when a repo is below Gold', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [{ name: 'b', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' }] };
    const details = { b: { commits: 5, weekly: [1], license: 'None', ci: 0, communityHealth: 20, vulns: null, ciPassRate: null, open_issues: 0, open_bugs: 0, released_at: null, codeScanning: null, secretScanning: null } };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('<details open><summary>All repos'), 'a below-gold portfolio opens the repo table');
    assert.ok(html.includes('A few things for your eye'), 'below-gold but un-alerted reads as attention');
  });

  it('shows a repo once in the delta when it both moves tier and clears alerts', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    // Prior: silver AND at-risk; current: gold AND clean → one move, not two rows.
    const prior = { repos: { a: { computed: { tier: 'silver' }, vulns: { count: 1, high: 1, max_severity: 'high' } } } };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {}, null, prior);
    assert.ok(html.includes('since-item since-up'), 'renders the tier move');
    assert.ok(!html.includes('cleared its security alerts'), 'does not also render a separate security row');
  });

  it('formats a downward gold trend without a double negative', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [{ name: 'b', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' }] };
    const details = { b: { commits: 5, weekly: [1], license: 'None', ci: 0, communityHealth: 20, vulns: null, ciPassRate: null, open_issues: 0, open_bugs: 0, released_at: null, codeScanning: null, secretScanning: null } };
    const prior = { repos: { b: { computed: { tier: 'gold' } } } };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {}, null, prior);
    assert.ok(html.includes('status-trend down'), 'renders a downward trend');
    assert.ok(html.includes('▼ 100pp'), 'shows the magnitude without a sign');
    assert.ok(!html.includes('-100pp'), 'no double-negative rendering');
  });
});

describe('generateRepoReport restructure', () => {
  it('has trends before activity history and no health grid', async () => {
    const { generateRepoReport } = await import('./report-repo.js');
    const snapshot = {
      repository: 'owner/test', meta: { stars: 5, forks: 1, watchers: 2 },
      issues: { open: [] }, releases: [{ tag: 'v1', published_at: new Date().toISOString() }],
      community_profile: { health_percentage: 90, files: { readme: true, license: true, contributing: true, code_of_conduct: true, issue_template: true, pull_request_template: true } },
      dependabot_alerts: { count: 0, critical: 0, high: 0, medium: 0, low: 0, max_severity: null },
      code_scanning_alerts: null, secret_scanning_alerts: { count: 0 },
      ci_pass_rate: { pass_rate: 0.98, total_runs: 100, passed: 98, failed: 2 },
      pushed_at: new Date().toISOString(), license: 'MIT', sbom: null,
      summary: { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 10, human_prs: 8, bot_prs: 2, releases: 1, latest_release: 'v1', ci_workflows: 4, bus_factor: 2, time_to_close_median: { median_days: 3, sample_size: 10 } },
    };
    const prActivity = [{ month: 'Jan', count: 5 }];
    const issueActivity = [{ month: 'Jan', opened: 2, closed: 3 }];
    const prAuthors = [{ author: 'dev', count: 8, firstTime: false }];
    const trends = { direction: 'stable', weeks: [{ week: 'W1', open_issues: 3, merged_prs: 2 }, { week: 'W2', open_issues: 2, merged_prs: 3 }] };

    const html = generateRepoReport(snapshot, prActivity, issueActivity, prAuthors, trends, [], null, [], null, null, {});

    // Trends before Activity History
    const trendsPos = html.indexOf('Trends');
    const activityPos = html.indexOf('Activity History');
    assert.ok(trendsPos > 0, 'should have Trends section');
    assert.ok(activityPos > 0, 'should have Activity History section');
    assert.ok(trendsPos < activityPos, 'Trends should come before Activity History');

    // Collapsible sections
    assert.ok(html.includes('<details'), 'should use details elements');

    // No doughnut charts
    assert.ok(!html.includes('id="authorChart"'), 'no author doughnut');
    assert.ok(!html.includes('id="labelChart"'), 'no label chart');

    // No separate health grid
    assert.ok(!html.includes('Repository Health'), 'health grid merged into tier');

    // Health tier has Detail column
    assert.ok(html.includes('Detail'), 'tier table should have Detail column');

    // Stars in subtitle, not in a card
    assert.ok(html.includes('5 stars'), 'stars should be in subtitle');
  });

  it('renders assessment narrative when provided and escapes HTML', async () => {
    const { generateRepoReport } = await import('./report-repo.js');
    const snapshot = {
      repository: 'owner/test', meta: { stars: 5, forks: 1, watchers: 2 },
      issues: { open: [] }, releases: [],
      community_profile: null, dependabot_alerts: null,
      code_scanning_alerts: null, secret_scanning_alerts: null, ci_pass_rate: null,
      pushed_at: new Date().toISOString(), license: 'MIT', sbom: null,
      summary: { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 0, human_prs: 0, bot_prs: 0, releases: 0, latest_release: 'none', ci_workflows: 0, bus_factor: 0, time_to_close_median: null },
    };
    const assessment = 'First paragraph with <script>alert(1)</script>.\n\nSecond paragraph on the roadmap.';
    const html = generateRepoReport(snapshot, [], [], [], null, [], null, [], null, null, {}, assessment);

    assert.ok(html.includes('<h2>Assessment</h2>'), 'renders Assessment heading');
    assert.ok(html.includes('First paragraph with &lt;script&gt;'), 'escapes HTML in narrative');
    assert.ok(!html.includes('<script>alert(1)'), 'no unescaped script tag');
    assert.ok(html.includes('Second paragraph on the roadmap.'), 'renders second paragraph');
  });

  it('omits Assessment section when no narrative is provided', async () => {
    const { generateRepoReport } = await import('./report-repo.js');
    const snapshot = {
      repository: 'owner/test', meta: { stars: 0, forks: 0, watchers: 0 },
      issues: { open: [] }, releases: [],
      community_profile: null, dependabot_alerts: null,
      code_scanning_alerts: null, secret_scanning_alerts: null, ci_pass_rate: null,
      pushed_at: new Date().toISOString(), license: 'MIT', sbom: null,
      summary: { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 0, human_prs: 0, bot_prs: 0, releases: 0, latest_release: 'none', ci_workflows: 0, bus_factor: 0, time_to_close_median: null },
    };
    const html = generateRepoReport(snapshot, [], [], [], null, [], null, [], null, null, {});
    assert.ok(!html.includes('<h2>Assessment</h2>'), 'no Assessment heading when narrative is null');
  });
});

describe('dashboard inspiration polish', () => {
  // Canonical doc URLs that should appear in every page footer so visitors
  // can navigate to the architecture, security model, ADRs, and source.
  const FOOTER_LINKS = [
    'https://github.com/IsmaelMartinez/repo-butler',
    'https://github.com/IsmaelMartinez/repo-butler/blob/main/docs/architecture.md',
    'https://github.com/IsmaelMartinez/repo-butler/blob/main/SECURITY.md',
    'https://github.com/IsmaelMartinez/repo-butler/tree/main/docs/decisions',
  ];

  function minimalPortfolio() {
    const portfolio = { repos: [
      { name: 'a', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const details = { a: { commits: 5, weekly: [1], license: 'MIT', ci: 1, communityHealth: 80, vulns: { count: 0, max_severity: null }, ciPassRate: 1.0, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    return { portfolio, details };
  }

  function minimalRepoSnapshot() {
    return {
      repository: 'owner/test', meta: { stars: 0, forks: 0, watchers: 0 },
      issues: { open: [] }, releases: [],
      community_profile: null, dependabot_alerts: null,
      code_scanning_alerts: null, secret_scanning_alerts: null, ci_pass_rate: null,
      pushed_at: new Date().toISOString(), license: 'MIT', sbom: null,
      summary: { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 0, human_prs: 0, bot_prs: 0, releases: 0, latest_release: 'none', ci_workflows: 0, bus_factor: 0, time_to_close_median: null },
    };
  }

  it('portfolio dashboard shows the hero intro with a link to the source repo', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = minimalPortfolio();
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('class="hero-intro"'), 'should render hero intro block');
    assert.ok(html.includes('seven-phase pipeline'), 'intro should mention the seven-phase pipeline');
    assert.ok(html.includes('https://github.com/IsmaelMartinez/repo-butler'), 'intro should link to the source repo');
  });

  it('portfolio dashboard shows the collapsible About section with all seven phases', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = minimalPortfolio();
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('About — How it works'), 'should have About summary');
    assert.ok(html.includes('class="about-phases"'), 'should render the phase list');
    for (const phase of ['OBSERVE', 'ASSESS', 'UPDATE', 'GOVERNANCE', 'IDEATE', 'PROPOSE', 'REPORT']) {
      assert.ok(html.includes(`<strong>${phase}</strong>`), `About section should list the ${phase} phase`);
    }
  });

  it('portfolio dashboard renders the site footer with all documentation links', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = minimalPortfolio();
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('class="site-footer"'), 'should render the site footer');
    for (const link of FOOTER_LINKS) {
      assert.ok(html.includes(link), `footer should link to ${link}`);
    }
    assert.ok(html.includes('Built with zero dependencies, Node 24, on GitHub Actions'), 'footer should include the tagline');
  });

  it('per-repo report renders the site footer with all documentation links', async () => {
    const { generateRepoReport } = await import('./report-repo.js');
    const html = generateRepoReport(minimalRepoSnapshot(), [], [], [], null, [], null, [], null, null, {});
    assert.ok(html.includes('class="site-footer"'), 'per-repo report should render the site footer');
    for (const link of FOOTER_LINKS) {
      assert.ok(html.includes(link), `per-repo footer should link to ${link}`);
    }
  });

  it('light per-repo report renders the site footer with all documentation links', async () => {
    const { generateLightRepoReport } = await import('./report-repo.js');
    const repo = { name: 'quiet', description: 'A quiet repo', stars: 0, forks: 0, open_issues: 0, language: 'JS', pushed_at: new Date().toISOString() };
    const html = generateLightRepoReport('owner', repo, { commits: 1, ci: 0, license: 'MIT' });
    assert.ok(html.includes('class="site-footer"'), 'light report should render the site footer');
    for (const link of FOOTER_LINKS) {
      assert.ok(html.includes(link), `light report footer should link to ${link}`);
    }
    // Routed through htmlPage, so light cards get the theme toggle + persistence too.
    assert.ok(html.includes('class="theme-toggle"'), 'light report should carry the theme toggle');
    assert.ok(html.includes("localStorage.getItem('rb-theme')"), 'light report should restore the persisted theme');
  });

  it('weekly digest renders the site footer with all documentation links', async () => {
    const { generateDigestReport } = await import('./report-portfolio.js');
    const repos = [{ name: 'a', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' }];
    const repoDetails = { a: { commits: 5, weekly: [1], vulns: null, ciPassRate: 1.0, open_issues: 0 } };
    const html = generateDigestReport('owner', repos, repoDetails);
    assert.ok(html.includes('class="site-footer"'), 'digest should render the site footer');
    for (const link of FOOTER_LINKS) {
      assert.ok(html.includes(link), `digest footer should link to ${link}`);
    }
  });
});

describe('Dependabot autofix indicator on the per-repo report (ADR-012 Phase 4)', () => {
  it('buildDependabotAutofixCard renders the three tri-state values with matching colours', async () => {
    const { buildDependabotAutofixCard } = await import('./report-repo.js');
    assert.match(buildDependabotAutofixCard(true), /color:var\(--color-success\)">In flight</);
    assert.match(buildDependabotAutofixCard(false), /color:var\(--color-danger\)">Not driven</);
    assert.match(buildDependabotAutofixCard(null), /color:var\(--muted\)">Unknown</);
  });

  it('full-dashboard Health Tier section shows in flight / not driven / unknown', async () => {
    const { generateRepoReport } = await import('./report-repo.js');
    const base = {
      repository: 'owner/test', meta: { stars: 0, forks: 0, watchers: 0 },
      issues: { open: [] }, releases: [],
      community_profile: null, dependabot_alerts: null,
      code_scanning_alerts: null, secret_scanning_alerts: null, ci_pass_rate: null,
      pushed_at: new Date().toISOString(), license: 'MIT', sbom: null,
    };
    const summaryBase = { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 0, human_prs: 0, bot_prs: 0, releases: 0, latest_release: 'none', ci_workflows: 0, bus_factor: 0, time_to_close_median: null };

    const inFlight = { ...base, summary: { ...summaryBase, automated_security_fixes_active: true } };
    const notDriven = { ...base, summary: { ...summaryBase, automated_security_fixes_active: false } };
    const unknown = { ...base, summary: { ...summaryBase, automated_security_fixes_active: null } };

    const htmlOn = generateRepoReport(inFlight, [], [], [], null, [], null, [], null, null, {});
    const htmlOff = generateRepoReport(notDriven, [], [], [], null, [], null, [], null, null, {});
    const htmlUnknown = generateRepoReport(unknown, [], [], [], null, [], null, [], null, null, {});

    assert.ok(htmlOn.includes('Dependabot autofix: <span style="color:var(--color-success)">in flight</span>'), 'shows in-flight state');
    assert.ok(htmlOff.includes('Dependabot autofix: <span style="color:var(--color-danger)">not driven</span>'), 'shows not-driven state');
    assert.ok(htmlUnknown.includes('Dependabot autofix: <span style="color:var(--muted)">unknown</span>'), 'shows unknown state');
  });

  it('lightweight per-repo card shows a Dependabot Autofix card for all states', async () => {
    const { generateLightRepoReport } = await import('./report-repo.js');
    const repo = { name: 'quiet', description: '', stars: 0, forks: 0, open_issues: 0, language: 'JS', pushed_at: new Date().toISOString() };

    const htmlOn = generateLightRepoReport('owner', repo, { commits: 1, ci: 0, license: 'MIT', autofix: { enabled: true, paused: false } });
    const htmlOff = generateLightRepoReport('owner', repo, { commits: 1, ci: 0, license: 'MIT', autofix: { enabled: false, paused: false } });
    const htmlPaused = generateLightRepoReport('owner', repo, { commits: 1, ci: 0, license: 'MIT', autofix: { enabled: true, paused: true } });
    const htmlUnknown = generateLightRepoReport('owner', repo, { commits: 1, ci: 0, license: 'MIT', autofix: null });

    assert.ok(htmlOn.includes('<h3>Dependabot Autofix</h3>'), 'renders the autofix card');
    assert.ok(htmlOn.includes('In flight'), 'in-flight state shown when enabled and not paused');
    assert.ok(htmlOff.includes('Not driven'), 'not-driven state shown when disabled');
    assert.ok(htmlPaused.includes('Not driven'), 'paused autofix also reads as not driven');
    assert.ok(htmlUnknown.includes('Unknown'), 'unknown state shown when autofix data is absent');
  });
});

describe('report cache invalidation includes report.js', () => {
  it('templateFiles array includes src/report.js', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/report.js', 'utf8');
    assert.ok(src.includes("'src/report.js'"), 'templateFiles should include src/report.js');
    // All five report files must be in the template hash.
    for (const f of ['src/report.js', 'src/report-portfolio.js', 'src/report-repo.js', 'src/report-styles.js', 'src/report-shared.js']) {
      assert.ok(src.includes(`'${f}'`), `templateFiles should include ${f}`);
    }
  });
});

describe('fetchPortfolioDetails incremental cache', () => {
  it('uses cached details when pushed_at and open_issues_count match (but refreshes the volatile autofix + copilot-review settings)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // On a cache hit, only the autofix GET and the copilot ruleset-list paginate
    // should run (ADR-012 Phase 3 / ADR-009): both settings can flip without a
    // push, so they're refreshed while every push-invariant field comes from
    // cache. This mock's ruleset list is empty, so hasActiveCopilotReviewRuleset
    // never needs a per-ruleset detail GET here — with active rulesets present
    // it would also issue /rulesets/{id} GETs, which is expected and not a full
    // re-fetch. No getFileContent / other network calls should occur either way.
    const requestPaths = [];
    const paginatePaths = [];
    let getFileContentCalled = false;
    const gh = {
      request: (path) => {
        requestPaths.push(path);
        if (path.endsWith('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
        return Promise.resolve({});
      },
      paginate: (path) => { paginatePaths.push(path); return Promise.resolve([]); },
      getFileContent: () => { getFileContentCalled = true; return Promise.resolve(null); },
    };
    const repos = [
      { name: 'cached-repo', pushed_at: '2026-04-01T00:00:00Z', open_issues: 5, archived: false, fork: false, stars: 10 },
    ];
    const cache = {
      repos: {
        'cached-repo': {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-04-01T00:00:00Z',
          open_issues_count: 5,
          // hasCopilotReview stale-true; the ruleset list mock below returns no
          // active rulesets, so the live read should flip it to false.
          details: { commits: 42, weekly: [1, 2], license: 'MIT', ci: 1, communityHealth: 80, vulns: null, ciPassRate: 0.95, open_issues: 5, open_bugs: 0, open_prs: 0, libyear: null, codeScanning: null, secretScanning: null, traffic: null, hasIssueTemplate: true, released_at: null, autofix: null, hasCopilotReview: true },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.deepEqual(requestPaths, ['/repos/owner/cached-repo/automated-security-fixes'], 'only the autofix GET runs on a cache hit');
    assert.deepEqual(paginatePaths, ['/repos/owner/cached-repo/rulesets'], 'only the copilot ruleset list paginate runs on a cache hit');
    assert.equal(getFileContentCalled, false, 'no getFileContent on a cache hit');
    assert.equal(details['cached-repo'].commits, 42, 'should use cached commits');
    assert.deepEqual(details['cached-repo'].autofix, { enabled: true, paused: false }, 'refreshes the stale autofix state from the live GET');
    assert.equal(details['cached-repo'].hasCopilotReview, false, 'refreshes the stale copilot-review state from the live read');
    assert.ok(details._cachedRepos.includes('cached-repo'), 'should mark as cached');
  });

  it('fetches fresh data when pushed_at differs', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    let apiCallCount = 0;
    const gh = {
      request: () => { apiCallCount++; return Promise.resolve({ total_count: 10, license: { spdx_id: 'MIT' }, health_percentage: 80, workflow_runs: [], files: {} }); },
      paginate: () => { apiCallCount++; return Promise.resolve([]); },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'changed-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 5, archived: false, fork: false, stars: 10 },
    ];
    const cache = {
      repos: {
        'changed-repo': {
          pushed_at: '2026-04-01T00:00:00Z', // Different!
          open_issues_count: 5,
          details: { commits: 42 },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.ok(apiCallCount > 0, 'should call API for changed repo');
    assert.ok(!details._cachedRepos.includes('changed-repo'), 'should not mark as cached');
  });

  it('invalidates cache when schemaVersion is missing or stale', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    let apiCallCount = 0;
    const gh = {
      request: () => { apiCallCount++; return Promise.resolve({ total_count: 10, license: { spdx_id: 'MIT' }, health_percentage: 80, workflow_runs: [], files: {} }); },
      paginate: () => { apiCallCount++; return Promise.resolve([]); },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'old-cache', pushed_at: '2026-04-01T00:00:00Z', open_issues: 5, archived: false, fork: false, stars: 10 },
    ];
    const cache = {
      repos: {
        'old-cache': {
          pushed_at: '2026-04-01T00:00:00Z',
          open_issues_count: 5,
          details: { commits: 42, released_at: null },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.ok(apiCallCount > 0, 'should re-fetch when schemaVersion is missing');
    assert.ok(!details._cachedRepos.includes('old-cache'), 'should not mark stale-schema entry as cached');
  });

  it('skips draft releases when picking latest released_at', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = {
      request: (path) => {
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        return Promise.resolve({ total_count: 0, license: { spdx_id: 'MIT' }, workflow_runs: [] });
      },
      paginate: (path) => {
        if (path.includes('/releases')) {
          return Promise.resolve([
            { tag_name: 'v2.8.1', draft: true, published_at: null },
            { tag_name: 'v2.8.0', draft: false, published_at: '2026-04-15T10:00:00Z' },
          ]);
        }
        return Promise.resolve([]);
      },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'has-draft', pushed_at: '2026-04-20T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['has-draft'].released_at, '2026-04-15T10:00:00Z', 'should pick first non-draft release');
  });

  it('works without cache (backward compatible)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    let apiCallCount = 0;
    const gh = {
      request: () => { apiCallCount++; return Promise.resolve({ total_count: 10, license: { spdx_id: 'MIT' }, health_percentage: 80, workflow_runs: [], files: {} }); },
      paginate: () => { apiCallCount++; return Promise.resolve([]); },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'fresh-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 2, archived: false, fork: false, stars: 3 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.ok(apiCallCount > 0, 'should call API without cache');
    assert.deepEqual(details._cachedRepos, [], 'no repos should be cached');
  });

  it('derives hasAutoMergeWorkflow and allowAutoMerge from the reused fetchers', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = {
      // Order matters: the bare /repos/{owner}/{repo} path is a prefix of the
      // /actions/workflows path, so match the more-specific subpaths first.
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          return Promise.resolve({ total_count: 1, workflows: [{ name: 'Dependabot auto-merge', path: '.github/workflows/dependabot-auto-merge.yml' }] });
        }
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        // Bare /repos/{owner}/{repo} — matched last.
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: true });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'am-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['am-repo'].hasAutoMergeWorkflow, true);
    assert.equal(details['am-repo'].allowAutoMerge, true);
  });

  it('reports hasAutoMergeWorkflow false when the workflow is absent and allow_auto_merge off', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          return Promise.resolve({ total_count: 1, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }] });
        }
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'no-am', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['no-am'].hasAutoMergeWorkflow, false);
    assert.equal(details['no-am'].allowAutoMerge, false);
    // No workflow named or pathed "release" in this fixture either.
    assert.equal(details['no-am'].hasReleaseWorkflow, false);
  });

  it('derives hasReleaseWorkflow from a release-named workflow (name OR path match)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const makeGh = (workflows) => ({
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          return Promise.resolve({ total_count: workflows.length, workflows });
        }
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    });
    const repos = [
      { name: 'rel-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // Path match: the templated .github/workflows/release.yml.
    let details = await fetchPortfolioDetails(makeGh([{ name: 'Scheduled release', path: '.github/workflows/release.yml' }]), 'owner', repos);
    assert.equal(details['rel-repo'].hasReleaseWorkflow, true);
    // Name match: a hand-rolled publish pipeline whose PATH doesn't say release —
    // it must still count so a working pipeline never gets a redundant apply PR.
    details = await fetchPortfolioDetails(makeGh([{ name: 'Build & Release', path: '.github/workflows/build.yml' }]), 'owner', repos);
    assert.equal(details['rel-repo'].hasReleaseWorkflow, true);
  });

  it('fails hasReleaseWorkflow toward present when the workflows page is truncated', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          // 101 workflows on the repo, only one (non-release) returned on this
          // page — the release workflow may be on a later page, so the detector
          // must not report a gap from incomplete data.
          return Promise.resolve({ total_count: 101, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }] });
        }
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'many-wf', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['many-wf'].hasReleaseWorkflow, true);
  });

  it('fails hasReleaseWorkflow toward present when the workflows request errors', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) return Promise.reject(new Error('rate limited'));
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'err-wf', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // A transient API failure is incomplete data: the write-gating signal must
    // not manufacture a release-cadence gap (and a remediation PR) from it.
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['err-wf'].hasReleaseWorkflow, true);
  });

  it('surfaces hasCopilotReview through fetchPortfolioDetails (active Copilot ruleset → true)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // The shared detection helper lists rulesets via gh.paginate and reads each
    // detail via gh.request; helper-internal cases live in github.test.js. This
    // only checks the field is threaded through onto the per-repo details object.
    const gh = {
      paginate: (path) => path.endsWith('/rulesets')
        ? Promise.resolve([{ id: 7, enforcement: 'active' }])
        : Promise.resolve([]),
      request: (path) => {
        if (path.match(/\/rulesets\/\d+$/)) return Promise.resolve({ id: 7, rules: [{ type: 'copilot_code_review' }] });
        if (path.includes('/actions/workflows')) return Promise.resolve({ total_count: 0, workflows: [] });
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'cr-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['cr-repo'].hasCopilotReview, true);
  });

  it('threads the Dependabot autofix state onto details (ADR-012 Phase 3)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const mk = (autofixResponse) => ({
      paginate: () => Promise.resolve([]),
      request: (path) => {
        if (path.endsWith('/automated-security-fixes')) return autofixResponse();
        if (path.includes('/actions/workflows')) return Promise.resolve({ total_count: 0, workflows: [] });
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        if (path.match(/\/rulesets/)) return Promise.resolve({});
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      getFileContent: () => Promise.resolve(null),
    });
    const repos = [{ name: 'af-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 }];

    const on = await fetchPortfolioDetails(mk(() => Promise.resolve({ enabled: true, paused: false })), 'owner', repos);
    assert.deepEqual(on['af-repo'].autofix, { enabled: true, paused: false });

    // Unavailable endpoint → getAutomatedSecurityFixesState returns null → details.autofix null.
    const off = await fetchPortfolioDetails(mk(() => Promise.reject(new Error('404'))), 'owner', repos);
    assert.equal(off['af-repo'].autofix, null);
  });
});

describe('buildGovernanceSection', () => {
  it('returns empty string for null or empty findings', () => {
    assert.equal(buildGovernanceSection(null), '');
    assert.equal(buildGovernanceSection([]), '');
    assert.equal(buildGovernanceSection(undefined), '');
  });

  it('renders standards gaps grouped by tool with adoption rate and non-compliant repo links', () => {
    const findings = [
      {
        type: 'standards-gap',
        tool: 'issue-form-templates',
        scope: { type: 'universal' },
        compliant: ['repo-a'],
        nonCompliant: ['repo-b', 'repo-c'],
        adoptionRate: 1 / 3,
        priority: 'high',
      },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('Standards Gaps'), 'should have standards gaps heading');
    assert.ok(html.includes('Issue form templates'), 'should use human-readable label');
    assert.ok(html.includes('33% adopted'), 'should show adoption percentage');
    assert.ok(html.includes('href="repo-b.html"'), 'should link non-compliant repos');
    assert.ok(html.includes('href="repo-c.html"'), 'should link non-compliant repos');
    assert.ok(html.includes('high'), 'should show priority');
  });

  it('renders open-vulnerability findings with repo link, source, and alert counts', () => {
    const findings = [
      { type: 'open-vulnerability', repo: 'repo-a', critical: 2, high: 1, secretScanning: 0, sources: ['dependabot'], priority: 'high', remediation: { executor: 'manual' } },
      { type: 'open-vulnerability', repo: 'repo-b', critical: 0, high: 1, secretScanning: 0, sources: ['dependabot'], priority: 'medium', remediation: { executor: 'manual' } },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('Open Vulnerabilities'), 'should have open vulnerabilities heading');
    assert.ok(html.includes('href="repo-a.html"'), 'should link the affected repo');
    assert.ok(html.includes('2 critical'), 'should show critical count');
    assert.ok(html.includes('dependabot'), 'should show the alert source');
    // High-priority (critical) row sorts before the medium row.
    assert.ok(html.indexOf('repo-a.html') < html.indexOf('repo-b.html'), 'critical repo sorts first');
  });

  it('surfaces the Dependabot autofix state on dependabot-sourced findings (ADR-012 Phase 3)', () => {
    const findings = [
      { type: 'open-vulnerability', repo: 'inflight', critical: 1, high: 0, secretScanning: 0, sources: ['dependabot'], priority: 'medium', autofixEnabled: true, remediation: { executor: 'manual' } },
      { type: 'open-vulnerability', repo: 'notdriven', critical: 1, high: 0, secretScanning: 0, sources: ['dependabot'], priority: 'high', autofixEnabled: false, remediation: { executor: 'manual' } },
      { type: 'open-vulnerability', repo: 'unknownstate', critical: 1, high: 0, secretScanning: 0, sources: ['dependabot'], priority: 'high', autofixEnabled: null, remediation: { executor: 'manual' } },
      { type: 'open-vulnerability', repo: 'codeonly', critical: 1, high: 0, secretScanning: 0, sources: ['code-scanning'], priority: 'high', remediation: { executor: 'manual' } },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('Dependabot autofix'), 'adds the autofix column header');
    assert.ok(html.includes('in flight'), 'shows in-flight state for autofixEnabled=true');
    assert.ok(html.includes('not driven'), 'shows not-driven state for autofixEnabled=false');
    assert.ok(html.includes('unknown'), 'shows unknown for autofixEnabled=null');
  });

  it('shows a per-executor remediation breakdown when findings carry executor hints', () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', scope: { type: 'universal' }, compliant: [], nonCompliant: ['repo-a'], adoptionRate: 0, priority: 'high', remediation: { executor: 'template' } },
      { type: 'standards-gap', tool: 'code-review-bot', scope: { type: 'universal' }, compliant: [], nonCompliant: ['repo-d'], adoptionRate: 0, priority: 'high', remediation: { executor: 'settings' } },
      { type: 'standards-gap', tool: 'contributing-guide', scope: { type: 'universal' }, compliant: [], nonCompliant: ['repo-b'], adoptionRate: 0, priority: 'high', remediation: { executor: 'agent' } },
      { type: 'policy-drift', category: 'license', repo: 'repo-c', expected: 'MIT', actual: 'GPL-3.0', priority: 'medium', remediation: { executor: 'manual' } },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('By remediation:'), 'should render the remediation breakdown line');
    assert.ok(html.includes('1 template'), 'should count template findings');
    assert.ok(html.includes('1 settings'), 'should count settings findings (ADR-009 ruleset writes)');
    assert.ok(html.includes('1 agent'), 'should count agent findings');
    assert.ok(html.includes('1 manual'), 'should count manual findings');
  });

  it('marks ecosystem-scoped standards with the language', () => {
    const findings = [
      {
        type: 'standards-gap',
        tool: 'ci-workflows',
        scope: { type: 'ecosystem', language: 'Go' },
        compliant: [],
        nonCompliant: ['go-svc'],
        adoptionRate: 0,
        priority: 'high',
      },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('Go only'), 'should mention ecosystem scope');
  });

  it('groups policy drift by category', () => {
    const findings = [
      { type: 'policy-drift', category: 'license', repo: 'repo-a', expected: 'MIT', actual: 'Apache-2.0', priority: 'medium' },
      { type: 'policy-drift', category: 'license', repo: 'repo-b', expected: 'MIT', actual: 'GPL-3.0', priority: 'medium' },
      { type: 'policy-drift', category: 'ci-reliability', repo: 'repo-c', expected: '90%', actual: '65%', priority: 'medium' },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('Policy Drift'), 'should have drift heading');
    assert.ok(html.includes('License'), 'should label license category');
    assert.ok(html.includes('CI reliability'), 'should label CI category');
    assert.ok(html.includes('repo-a'), 'should mention repo-a');
    assert.ok(html.includes('repo-b'), 'should mention repo-b');
    assert.ok(html.includes('repo-c'), 'should mention repo-c');
    assert.ok(html.includes('Apache-2.0'), 'should show actual value');
    assert.ok(html.includes('vs MIT'), 'should show expected value');
  });

  it('renders tier uplift proposals with failing checks and path', () => {
    const findings = [
      {
        type: 'tier-uplift',
        repo: 'silver-repo',
        currentTier: 'silver',
        targetTier: 'gold',
        failingChecks: [{ name: 'Recent release', required_for: 'gold' }],
        priority: 'high',
      },
      {
        type: 'tier-uplift',
        repo: 'bronze-repo',
        currentTier: 'bronze',
        targetTier: 'silver',
        failingChecks: [
          { name: 'CONTRIBUTING.md', required_for: 'silver' },
          { name: 'License', required_for: 'silver' },
        ],
        priority: 'medium',
      },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('Tier Uplift Opportunities'), 'should have uplift heading');
    assert.ok(html.includes('silver-repo'), 'should mention silver repo');
    assert.ok(html.includes('Recent release'), 'should list failing check');
    assert.ok(html.includes('CONTRIBUTING.md'), 'should list check for bronze repo');
  });

  it('sorts standards gaps by adoption rate ascending', () => {
    const findings = [
      { type: 'standards-gap', tool: 'license', scope: { type: 'universal' }, compliant: ['a', 'b', 'c'], nonCompliant: ['d'], adoptionRate: 0.75, priority: 'low' },
      { type: 'standards-gap', tool: 'issue-form-templates', scope: { type: 'universal' }, compliant: [], nonCompliant: ['a', 'b'], adoptionRate: 0, priority: 'high' },
    ];
    const html = buildGovernanceSection(findings);
    // issue-form-templates (0% adoption) should appear before license (75% adoption)
    const issueIdx = html.indexOf('Issue form templates');
    const licenseIdx = html.indexOf('License');
    assert.ok(issueIdx > -1 && licenseIdx > -1);
    assert.ok(issueIdx < licenseIdx, 'lower adoption should appear first');
  });

  it('prioritises silver→gold uplift over bronze→silver when both present', () => {
    const findings = [
      {
        type: 'tier-uplift',
        repo: 'bronze-repo',
        currentTier: 'bronze',
        targetTier: 'silver',
        failingChecks: [{ name: 'License', required_for: 'silver' }],
        priority: 'medium',
      },
      {
        type: 'tier-uplift',
        repo: 'silver-repo',
        currentTier: 'silver',
        targetTier: 'gold',
        failingChecks: [{ name: 'Recent release', required_for: 'gold' }],
        priority: 'high',
      },
    ];
    const html = buildGovernanceSection(findings);
    const silverIdx = html.indexOf('silver-repo');
    const bronzeIdx = html.indexOf('bronze-repo');
    assert.ok(silverIdx > -1 && bronzeIdx > -1);
    assert.ok(silverIdx < bronzeIdx, 'high priority uplift should appear first');
  });

  it('escapes HTML in repo names and actual/expected values', () => {
    const findings = [
      {
        type: 'policy-drift',
        category: 'license',
        repo: 'weird<name>',
        expected: 'MIT',
        actual: '<script>',
        priority: 'medium',
      },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(!html.includes('<script>'), 'should escape script tag in actual value');
    assert.ok(html.includes('&lt;script&gt;'), 'should escape as entities');
  });

  it('omits sections that have no findings of that type', () => {
    const findings = [
      { type: 'tier-uplift', repo: 'a', currentTier: 'silver', targetTier: 'gold', failingChecks: [{ name: 'Release' }], priority: 'high' },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('Tier Uplift Opportunities'));
    assert.ok(!html.includes('Standards Gaps'), 'should not render standards heading when no gaps');
    assert.ok(!html.includes('Policy Drift'), 'should not render drift heading when no drift');
  });

  it('opens with a top-level heading that carries the total finding count', () => {
    const findings = [
      { type: 'standards-gap', tool: 'license', scope: { type: 'universal' }, compliant: [], nonCompliant: ['a'], adoptionRate: 0, priority: 'high' },
      { type: 'tier-uplift', repo: 'a', currentTier: 'bronze', targetTier: 'silver', failingChecks: [{ name: 'License' }], priority: 'medium' },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.startsWith('<h2>Governance (2)</h2>'), 'should start with h2 carrying the count');
  });
});

describe('deployedLink (dashboard deployed-page link)', () => {
  it('renders an anchor for a valid https homepage', () => {
    const out = deployedLink('https://demo.example/');
    assert.ok(out.includes('href="https://demo.example/"'), 'href is the normalised URL');
    assert.ok(out.includes('class="site-link"'));
    assert.ok(out.includes('↗'), 'uses the default glyph label');
  });

  it('gives the (icon-only) link an accessible name', () => {
    assert.ok(deployedLink('https://demo.example/').includes('aria-label="Live site"'),
      'icon-only link needs an aria-label for screen readers');
  });

  it('uses a caller-supplied label', () => {
    assert.ok(deployedLink('https://demo.example/', 'live site ↗').includes('>live site ↗</a>'));
  });

  it('returns empty string for an absent or unsafe homepage', () => {
    assert.equal(deployedLink(null), '');
    assert.equal(deployedLink(''), '');
    assert.equal(deployedLink('javascript:alert(1)'), '', 'must not emit a javascript: link');
    assert.equal(deployedLink('/relative'), '');
  });

  it('HTML-escapes the href (defence-in-depth on top of URL normalisation)', () => {
    // A query string with a double-quote would break out of the attribute if
    // not escaped; new URL() percent-encodes it, and escHtml is the backstop.
    const out = deployedLink('https://demo.example/?q="onmouseover');
    assert.ok(!out.includes('"onmouseover'), 'raw quote must not survive into the attribute');
  });
});

describe('generatePortfolioReport deployed-page link', () => {
  it('renders a live-site link in the table when a repo has a homepage', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [
      { name: 'withsite', stars: 1, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS', homepage: 'https://withsite.example/' },
      { name: 'nosite', stars: 1, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const mkDetails = () => ({ commits: 12, weekly: [1], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } });
    const details = { withsite: mkDetails(), nosite: mkDetails() };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    assert.ok(html.includes('href="https://withsite.example/"'), 'repo with a homepage gets a live-site link');
    assert.ok(html.includes('class="site-link"'));
    // Only the repo with a homepage gets a link. It appears once in the
    // simplified table and once in the full (toggle) table = 2 occurrences;
    // the homepage-less repo contributes none.
    const linkCount = (html.match(/class="site-link"/g) || []).length;
    assert.equal(linkCount, 2, 'the homepage repo links in both tables; the other repo gets none');
  });
});

describe('buildRepoSnapshot', () => {
  it('produces the full report.js inline shape when given per-repo fetch data', () => {
    const owner = 'octo';
    const r = { name: 'widget', stars: 7, forks: 1, pushed_at: '2026-04-01T00:00:00Z' };
    const meta = { stargazers_count: 7, forks_count: 1, subscribers_count: 3, default_branch: 'main', license: { spdx_id: 'MIT' }, homepage: 'https://widget.example/' };
    const communityProfile = { health_percentage: 85, files: { readme: true, license: true } };
    const releases = [
      { tag_name: 'v1.2.0', published_at: '2026-03-15T00:00:00Z', prerelease: false },
      { tag_name: 'v1.1.0', published_at: '2026-02-01T00:00:00Z', prerelease: false },
    ];
    const openIssues = [
      { number: 10, title: 'Bug: x', labels: [{ name: 'bug' }], reactions: { total_count: 2 }, comments: 1, created_at: '2026-03-01', updated_at: '2026-03-10' },
      { number: 11, title: 'Blocked', labels: [{ name: 'blocked' }], reactions: null, comments: 0, created_at: '2026-03-02', updated_at: '2026-03-11' },
      { number: 12, title: 'Feedback', labels: [{ name: 'awaiting-feedback' }], reactions: { total_count: 0 }, comments: 0, created_at: '2026-03-03', updated_at: '2026-03-12' },
    ];
    const prAuthors = [
      { author: 'alice', count: 3 },
      { author: 'dependabot[bot]', count: 5 },
    ];
    const details = {
      license: 'MIT', ci: 4, vulns: { count: 2, max_severity: 'high' },
      codeScanning: { count: 1, max_severity: 'medium' },
      secretScanning: { count: 0 },
      ciPassRate: 0.92, sbom: { count: 50, packages: [] },
      open_bugs: 1,
    };

    const snap = buildRepoSnapshot({
      owner, repo: r.name, details, meta, communityProfile, releases,
      openIssues, prAuthors, busFactor: 2, timeToCloseMedian: 4.5,
      pushedAt: r.pushed_at, stars: r.stars, forks: r.forks,
    });

    // Construct the expected output inline, mirroring the pre-refactor shape.
    const expected = {
      repository: 'octo/widget',
      meta: { stars: 7, forks: 1, watchers: 3, default_branch: 'main', homepage: 'https://widget.example/' },
      issues: {
        open: [
          { number: 10, title: 'Bug: x', labels: ['bug'], reactions: 2, comments: 1, created_at: '2026-03-01', updated_at: '2026-03-10' },
          { number: 11, title: 'Blocked', labels: ['blocked'], reactions: 0, comments: 0, created_at: '2026-03-02', updated_at: '2026-03-11' },
          { number: 12, title: 'Feedback', labels: ['awaiting-feedback'], reactions: 0, comments: 0, created_at: '2026-03-03', updated_at: '2026-03-12' },
        ],
      },
      releases: [
        { tag: 'v1.2.0', published_at: '2026-03-15T00:00:00Z', prerelease: false },
        { tag: 'v1.1.0', published_at: '2026-02-01T00:00:00Z', prerelease: false },
      ],
      pushed_at: '2026-04-01T00:00:00Z',
      license: 'MIT',
      community_profile: communityProfile,
      dependabot_alerts: { count: 2, max_severity: 'high' },
      code_scanning_alerts: { count: 1, max_severity: 'medium' },
      secret_scanning_alerts: { count: 0 },
      automated_security_fixes: null,
      ci_pass_rate: { pass_rate: 0.92, total_runs: 0, passed: 0, failed: 0 },
      sbom: { count: 50, packages: [] },
      summary: {
        open_issues: 3, open_bugs: 1, blocked_issues: 1, awaiting_feedback: 1,
        recently_merged_prs: 8, human_prs: 3, bot_prs: 5,
        releases: 2, latest_release: 'v1.2.0', ci_workflows: 4,
        bus_factor: 2, time_to_close_median: 4.5,
        automated_security_fixes_active: null,
      },
    };
    assert.deepEqual(snap, expected);
  });

  it('falls back to repo basics when meta is missing (report.js path)', () => {
    const snap = buildRepoSnapshot({
      owner: 'octo', repo: 'widget',
      details: { license: 'Apache-2.0', ci: 1 },
      meta: null, stars: 12, forks: 3, pushedAt: '2026-04-01T00:00:00Z',
    });
    assert.deepEqual(snap.meta, { stars: 12, forks: 3, homepage: null });
    assert.equal(snap.license, 'Apache-2.0');
    assert.equal(snap.pushed_at, '2026-04-01T00:00:00Z');
  });

  it('threads the Dependabot autofix state from details (ADR-012 Phase 3)', () => {
    // enabled + not paused → active true; state object passed through verbatim.
    const on = buildRepoSnapshot({ owner: 'o', repo: 'r', details: { autofix: { enabled: true, paused: false } } });
    assert.deepEqual(on.automated_security_fixes, { enabled: true, paused: false });
    assert.equal(on.summary.automated_security_fixes_active, true);

    // paused → not actively opening PRs → active false.
    const paused = buildRepoSnapshot({ owner: 'o', repo: 'r', details: { autofix: { enabled: true, paused: true } } });
    assert.equal(paused.summary.automated_security_fixes_active, false);

    // off → active false.
    const off = buildRepoSnapshot({ owner: 'o', repo: 'r', details: { autofix: { enabled: false, paused: false } } });
    assert.equal(off.summary.automated_security_fixes_active, false);

    // unreadable/absent → null (unknown), never annotated as false.
    const unknown = buildRepoSnapshot({ owner: 'o', repo: 'r', details: { autofix: null } });
    assert.equal(unknown.automated_security_fixes, null);
    assert.equal(unknown.summary.automated_security_fixes_active, null);
  });

  it('produces the minimal shape used by buildPortfolioAttentionSection', () => {
    const details = {
      vulns: { count: 1, max_severity: 'high' },
      codeScanning: null,
      secretScanning: { count: 0 },
      ciPassRate: 0.5,
    };
    const snap = buildRepoSnapshot({ owner: 'octo', repo: 'widget', details });

    assert.equal(snap.repository, 'octo/widget');
    assert.deepEqual(snap.dependabot_alerts, { count: 1, max_severity: 'high' });
    assert.equal(snap.code_scanning_alerts, null);
    assert.deepEqual(snap.secret_scanning_alerts, { count: 0 });
    assert.equal(snap.ci_pass_rate.pass_rate, 0.5);
    assert.deepEqual(snap.issues, { open: [] });
    // summary defaults are safe — every key present, neutral values.
    assert.equal(snap.summary.open_issues, 0);
    assert.equal(snap.summary.recently_merged_prs, 0);
    assert.equal(snap.summary.releases, 0);
    assert.equal(snap.summary.latest_release, 'none');
    assert.equal(snap.summary.ci_workflows, 0);

    // The snapshot must be consumable by buildActionItems.
    const items = buildActionItems(snap, []);
    // CI pass rate < 0.8 → priority 5 action; vulns critical=undefined,high=0 → no vuln action.
    // (Action items only fires on critical/high counts present in alert object.)
    assert.ok(items.some(i => i.priority === 5), 'low CI pass rate should trigger action');
  });

  it('falls back to meta.pushed_at when explicit pushedAt is omitted', () => {
    const snap = buildRepoSnapshot({
      owner: 'octo', repo: 'widget',
      meta: { stargazers_count: 1, forks_count: 0, pushed_at: '2026-04-01T00:00:00Z' },
    });
    assert.equal(snap.pushed_at, '2026-04-01T00:00:00Z');
  });

  it('explicit pushedAt wins over meta.pushed_at', () => {
    const snap = buildRepoSnapshot({
      owner: 'octo', repo: 'widget',
      pushedAt: '2026-04-15T00:00:00Z',
      meta: { stargazers_count: 1, forks_count: 0, pushed_at: '2026-04-01T00:00:00Z' },
    });
    assert.equal(snap.pushed_at, '2026-04-15T00:00:00Z');
  });

  it('defaults all optional inputs to neutral values', () => {
    const snap = buildRepoSnapshot({ owner: 'octo', repo: 'empty' });
    assert.equal(snap.repository, 'octo/empty');
    assert.deepEqual(snap.meta, { stars: 0, forks: 0, homepage: null });
    assert.deepEqual(snap.issues, { open: [] });
    assert.deepEqual(snap.releases, []);
    assert.equal(snap.pushed_at, null);
    assert.equal(snap.license, null);
    assert.equal(snap.community_profile, null);
    assert.equal(snap.dependabot_alerts, null);
    assert.equal(snap.code_scanning_alerts, null);
    assert.equal(snap.secret_scanning_alerts, null);
    assert.equal(snap.ci_pass_rate, null);
    assert.equal(snap.sbom, null);
    assert.equal(snap.summary.bus_factor, 0);
    assert.equal(snap.summary.time_to_close_median, null);
    assert.equal(snap.summary.open_bugs, null);
  });

  it('output is consumable by computeHealthTier via the snapshotToTierInput path', async () => {
    // Build a snapshot with strong-gold inputs.
    const recentISO = new Date(Date.now() - 30 * 86400000).toISOString();
    const snap = buildRepoSnapshot({
      owner: 'octo', repo: 'widget',
      details: {
        license: 'MIT', ci: 3, vulns: { count: 0, max_severity: null },
        codeScanning: { count: 0, max_severity: null },
        secretScanning: { count: 0 },
        ciPassRate: 0.99, open_bugs: 1,
      },
      meta: { stargazers_count: 1, forks_count: 0, subscribers_count: 0, default_branch: 'main', license: { spdx_id: 'MIT' } },
      communityProfile: { health_percentage: 90, files: { license: true } },
      releases: [{ tag_name: 'v1', published_at: recentISO, prerelease: false }],
      pushedAt: recentISO,
    });

    // Snapshot must contain every field snapshotToTierInput needs.
    assert.ok(snap.summary, 'has summary');
    assert.ok(snap.community_profile, 'has community_profile');
    assert.ok(snap.releases.length > 0, 'has releases');
    assert.equal(snap.releases[0].published_at, recentISO);
  });
});

describe('colorByThreshold', () => {
  it('returns the colour of the first matching range (typical 3-range case)', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: 80, color: 'amber' },
      { lt: Infinity, color: 'green' },
    ];
    assert.equal(colorByThreshold(10, ranges), 'red');
    assert.equal(colorByThreshold(60, ranges), 'amber');
    assert.equal(colorByThreshold(95, ranges), 'green');
  });

  it('falls into the first range for values below the lowest threshold', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: 80, color: 'amber' },
      { lt: Infinity, color: 'green' },
    ];
    assert.equal(colorByThreshold(0, ranges), 'red');
    assert.equal(colorByThreshold(-100, ranges), 'red');
  });

  it('falls into the final bucket for values above all thresholds', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: 80, color: 'amber' },
      { lt: Infinity, color: 'green' },
    ];
    assert.equal(colorByThreshold(1e9, ranges), 'green');
  });

  it('lt is strictly less-than at boundary values', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: 80, color: 'amber' },
      { lt: Infinity, color: 'green' },
    ];
    // 50 is NOT < 50, so it bumps to the next range
    assert.equal(colorByThreshold(50, ranges), 'amber');
    assert.equal(colorByThreshold(80, ranges), 'green');
    // 49.999 IS < 50
    assert.equal(colorByThreshold(49.999, ranges), 'red');
  });

  it('lte is less-than-or-equal at boundary values', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lte: 7, color: 'green' },
      { lte: 30, color: 'amber' },
      { lte: Infinity, color: 'red' },
    ];
    assert.equal(colorByThreshold(7, ranges), 'green');
    assert.equal(colorByThreshold(7.5, ranges), 'amber');
    assert.equal(colorByThreshold(30, ranges), 'amber');
    assert.equal(colorByThreshold(31, ranges), 'red');
  });

  it('returns the fallback for null/undefined input', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [
      { lt: 50, color: 'red' },
      { lt: Infinity, color: 'green' },
    ];
    assert.equal(colorByThreshold(null, ranges), '#6e7681');
    assert.equal(colorByThreshold(undefined, ranges), '#6e7681');
    assert.equal(colorByThreshold(null, ranges, 'grey'), 'grey');
  });

  it('handles a single-range case', async () => {
    const { colorByThreshold } = await import('./report-shared.js');
    const ranges = [{ lt: Infinity, color: 'only' }];
    assert.equal(colorByThreshold(0, ranges), 'only');
    assert.equal(colorByThreshold(1e9, ranges), 'only');
    assert.equal(colorByThreshold(null, ranges), '#6e7681');
  });
});

describe('getLibyearColor delegates to colorByThreshold', () => {
  it('preserves original colour mapping', async () => {
    const { getLibyearColor } = await import('./report-shared.js');
    assert.equal(getLibyearColor(null), '#6e7681');
    assert.equal(getLibyearColor(undefined), '#6e7681');
    assert.equal(getLibyearColor(0), 'var(--color-success)');
    assert.equal(getLibyearColor(4.99), 'var(--color-success)');
    assert.equal(getLibyearColor(5), 'var(--color-warning)');     // boundary: >= GREEN bumps to YELLOW
    assert.equal(getLibyearColor(19.99), 'var(--color-warning)');
    assert.equal(getLibyearColor(20), 'var(--color-danger)');     // boundary: >= YELLOW bumps to RED
    assert.equal(getLibyearColor(100), 'var(--color-danger)');
  });
});

describe('portfolio report colour regressions', () => {
  it('renders expected colours for known threshold inputs', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const recentISO = new Date().toISOString();
    const portfolio = { repos: [
      // Healthy repo: should render COLOR_SUCCESS for issues, PRs, CI%, vulns.
      { name: 'healthy', stars: 1, forks: 0, open_issues: 0, pushed_at: recentISO, archived: false, fork: false, language: 'JS' },
      // Unhealthy repo: many issues + many PRs + low CI%.
      { name: 'troubled', stars: 1, forks: 0, open_issues: 50, pushed_at: recentISO, archived: false, fork: false, language: 'JS' },
    ]};
    const details = {
      healthy: {
        commits: 20, weekly: [1,2], license: 'MIT', ci: 2, communityHealth: 95,
        vulns: { count: 0, max_severity: null }, ciPassRate: 0.95,
        open_issues: 0, open_bugs: 0, open_prs: 0, released_at: recentISO,
        codeScanning: null, secretScanning: { count: 0 },
      },
      troubled: {
        commits: 20, weekly: [1,2], license: 'MIT', ci: 2, communityHealth: 30,
        vulns: { count: 5, max_severity: 'high' }, ciPassRate: 0.5,
        open_issues: 50, open_bugs: 30, open_prs: 12, released_at: recentISO,
        codeScanning: null, secretScanning: { count: 0 },
      },
    };
    const html = generatePortfolioReport('owner', portfolio, details, null, null, {});
    // Confirm the success/warning/danger CSS custom-property tokens are present in the rendered HTML.
    assert.ok(html.includes('var(--color-success)'), 'should include success green token');
    assert.ok(html.includes('var(--color-warning)'), 'should include warning amber token');
    assert.ok(html.includes('var(--color-danger)'), 'should include danger red token');
    // Open issues for troubled (50) should render with danger red.
    assert.match(html, /color:var\(--color-danger\)">50</, 'troubled repo open_issues 50 → danger');
    // Open PRs for troubled (12) should render with danger red.
    assert.match(html, /color:var\(--color-danger\)">12</, 'troubled repo open_prs 12 → danger');
    // CI 50% (rounded) should render with danger red.
    assert.match(html, /color:var\(--color-danger\)">50%</, 'troubled repo CI 50% → danger');
    // Healthy repo CI 95% should render with success green.
    assert.match(html, /color:var\(--color-success\)">95%</, 'healthy repo CI 95% → success');
    // Healthy repo issues 0 → success green; PRs 0 → success green.
    assert.match(html, /color:var\(--color-success\)">0</, 'healthy repo zero issues/PRs → success');
  });
});

describe('per-repo report colour regressions', () => {
  it('buildHealthSection renders danger red for low CI pass rate, bus factor 1 and slow time-to-close', async () => {
    const { buildHealthSection } = await import('./report-repo.js');
    const snapshot = {
      community_profile: { health_percentage: 90, files: { readme: true, license: true, contributing: true, code_of_conduct: true, issue_template: true, pull_request_template: true } },
      dependabot_alerts: { count: 0, critical: 0, high: 0, medium: 0, low: 0, max_severity: null },
      code_scanning_alerts: null, secret_scanning_alerts: { count: 0 },
      ci_pass_rate: { pass_rate: 0.6, total_runs: 100, passed: 60, failed: 40 },
      sbom: null,
      summary: { bus_factor: 1, time_to_close_median: { median_days: 60, sample_size: 10 } },
    };
    const html = buildHealthSection(snapshot);
    // CI 60% rendered with danger red.
    assert.match(html, /color:var\(--color-danger\)">60%</, 'CI 60% → danger');
    // Bus factor 1 rendered with danger red.
    assert.match(html, /color:var\(--color-danger\)">1</, 'bus factor 1 → danger');
    // TTC 60d rendered with danger red.
    assert.match(html, /color:var\(--color-danger\)">60d</, 'ttc 60d → danger');
  });

  it('buildHealthSection renders success green for healthy thresholds', async () => {
    const { buildHealthSection } = await import('./report-repo.js');
    const snapshot = {
      community_profile: null, dependabot_alerts: null,
      code_scanning_alerts: null, secret_scanning_alerts: null,
      // CI 95% → success.
      ci_pass_rate: { pass_rate: 0.95, total_runs: 100, passed: 95, failed: 5 },
      sbom: null,
      // bus_factor 5 → success; ttc 5d → success.
      summary: { bus_factor: 5, time_to_close_median: { median_days: 5, sample_size: 10 } },
    };
    const html = buildHealthSection(snapshot);
    assert.match(html, /color:var\(--color-success\)">95%</, 'CI 95% → success');
    assert.match(html, /color:var\(--color-success\)">5</, 'bus factor 5 → success');
    assert.match(html, /color:var\(--color-success\)">5d</, 'ttc 5d → success');
  });
});

describe('buildStatCard', () => {
  it('renders a typical card with value, colour and label', async () => {
    const { buildStatCard } = await import('./report-repo.js');
    const html = buildStatCard({
      title: 'Bus Factor',
      value: 4,
      color: '#7ee787',
      label: 'distinct contributors',
      available: true,
    });
    assert.strictEqual(
      html,
      '<div class="card"><h3>Bus Factor</h3>\n<div class="stat" style="color:#7ee787">4</div>\n<div class="stat-label">distinct contributors</div></div>',
    );
  });

  it('renders an em-dash placeholder and "unavailable" label when available=false', async () => {
    const { buildStatCard } = await import('./report-repo.js');
    const html = buildStatCard({
      title: 'CI Pass Rate',
      value: '95%',
      color: '#7ee787',
      label: 'from workflow runs',
      available: false,
    });
    // Value, colour and label are all overridden by the unavailable branch.
    assert.match(html, /<h3>CI Pass Rate<\/h3>/);
    assert.match(html, /style="color:var\(--muted\)">—</);
    assert.match(html, /<div class="stat-label">unavailable<\/div>/);
    assert.ok(!html.includes('95%'), 'value should not appear when unavailable');
    assert.ok(!html.includes('from workflow runs'), 'label should not appear when unavailable');
  });

  it('defaults available to true when omitted', async () => {
    const { buildStatCard } = await import('./report-repo.js');
    const html = buildStatCard({
      title: 'Code Scanning',
      value: 0,
      color: '#7ee787',
      label: 'No open alerts',
    });
    assert.match(html, /style="color:#7ee787">0</);
    assert.match(html, /<div class="stat-label">No open alerts<\/div>/);
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
