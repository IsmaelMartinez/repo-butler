import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSparklineSVG, buildCampaignSection, buildGovernanceSection, buildAutofixNudge } from './report.js';
import { REPO_CACHE_SCHEMA_VERSION } from './report-shared.js';

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

describe('portfolio table ci cell is tri-state', () => {
  const mkPortfolio = () => ({ repos: [
    { name: 'a', stars: 5, forks: 1, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
  ]});
  const mkDetails = ci => ({ a: { commits: 20, weekly: [1, 2], license: 'MIT', ci, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: null, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } });

  it('does not flag an unread workflow listing as "none" in danger red', async () => {
    // This cell had the loudest wrong answer of any render site: `|| 0` made an
    // unread listing render as "none" in DANGER RED — the table asserting the
    // repo has no CI at all, on the strength of one failed request.
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const html = generatePortfolioReport('test', mkPortfolio(), mkDetails(null), null, null, {});
    assert.ok(!html.includes('>none<'), 'must not claim the repo has no CI');
    assert.ok(html.includes('Workflow listing could not be read'), 'says why it is unknown');
  });

  it('still shows an observed zero as "none" — that is a real fact', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const html = generatePortfolioReport('test', mkPortfolio(), mkDetails(0), null, null, {});
    assert.ok(html.includes('>none<'));
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

  it('surfaces the autofix not-driven nudge near the top when governance findings have it', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const owner = 'test';
    const portfolio = { repos: [
      { name: 'a', stars: 5, forks: 1, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const details = { a: { commits: 20, weekly: [1,2], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const governanceFindings = [
      { type: 'open-vulnerability', repo: 'a', sources: ['dependabot'], autofixEnabled: false, priority: 'high', critical: 1, high: 0, secretScanning: 0, remediation: { executor: 'manual' } },
    ];
    const html = generatePortfolioReport(owner, portfolio, details, null, null, {}, governanceFindings);
    assert.ok(html.includes('Dependabot autofix off'), 'nudge is present when a not-driven finding exists');
    assert.ok(html.indexOf('Dependabot autofix off') < html.indexOf('Open Vulnerabilities'), 'nudge appears above the buried per-row table');
  });

  it('omits the autofix not-driven nudge when no finding is not-driven', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const owner = 'test';
    const portfolio = { repos: [
      { name: 'a', stars: 5, forks: 1, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const details = { a: { commits: 20, weekly: [1,2], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const governanceFindings = [
      { type: 'open-vulnerability', repo: 'a', sources: ['dependabot'], autofixEnabled: true, priority: 'medium', critical: 1, high: 0, secretScanning: 0, remediation: { executor: 'manual' } },
    ];
    const html = generatePortfolioReport(owner, portfolio, details, null, null, {}, governanceFindings);
    assert.ok(!html.includes('Dependabot autofix off'), 'nudge is absent when no finding is not-driven');
  });

  it('forwards priorAutofixNotDrivenCount into the nudge as a trend badge', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const owner = 'test';
    const portfolio = { repos: [
      { name: 'a', stars: 5, forks: 1, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const details = { a: { commits: 20, weekly: [1,2], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const governanceFindings = [
      { type: 'open-vulnerability', repo: 'a', sources: ['dependabot'], autofixEnabled: false, priority: 'high', critical: 1, high: 0, secretScanning: 0, remediation: { executor: 'manual' } },
    ];
    const html = generatePortfolioReport(owner, portfolio, details, null, null, {}, governanceFindings, null, 0);
    assert.ok(html.includes('status-trend down'), 'the 9th param reaches buildAutofixNudge as priorCount (0 → 1 is a regression)');
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

describe('fetchPortfolioDetails incremental cache', () => {
  it('uses cached details when pushed_at and open_issues_count match (but refreshes the volatile autofix + copilot-review + osv-scanner reads)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // On a cache hit, only the three volatile reads should run: the autofix GET
    // (ADR-012 Phase 3), the copilot ruleset-list paginate (ADR-009), and the
    // workflows-DIRECTORY listing that re-derives hasOsvScanner. The first two
    // are settings that flip without a push; the third is re-read for a
    // different reason — the verdict is tri-state, and an unknown cached on one
    // failed read would otherwise be served until the repo's next push, which on
    // a quiet repo is never. Every push-invariant field still comes from cache.
    // This mock's ruleset list is empty, so hasActiveCopilotReviewRuleset never needs
    // a per-ruleset detail GET here — with active rulesets present it would also
    // issue /rulesets/{id} GETs, which is expected and not a full re-fetch. No
    // getFileContent / other network calls should occur either way.
    const requestPaths = [];
    const paginatePaths = [];
    let getFileContentCalled = false;
    const gh = {
      request: (path) => {
        requestPaths.push(path);
        if (path.endsWith('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
        if (path.includes('-scanning/alerts') || path.includes('/dependabot/alerts')) return Promise.resolve([]);
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
    assert.deepEqual(requestPaths, [
      '/repos/owner/cached-repo/automated-security-fixes',
      '/repos/owner/cached-repo/contents/.github/workflows',
      '/repos/owner/cached-repo/dependabot/alerts?state=open&per_page=100',
      '/repos/owner/cached-repo/code-scanning/alerts?state=open&per_page=100',
      '/repos/owner/cached-repo/secret-scanning/alerts?state=open&per_page=100',
    ], 'only the volatile reads run on a cache hit: autofix, the osv-scanner contents listing and the three alert summaries');
    assert.deepEqual(paginatePaths, ['/repos/owner/cached-repo/rulesets'], 'only the copilot ruleset list paginate runs on a cache hit');
    assert.equal(getFileContentCalled, false, 'no getFileContent on a cache hit');
    assert.equal(details['cached-repo'].commits, 42, 'should use cached commits');
    assert.deepEqual(details['cached-repo'].autofix, { enabled: true, paused: false }, 'refreshes the stale autofix state from the live GET');
    assert.equal(details['cached-repo'].hasCopilotReview, false, 'refreshes the stale copilot-review state from the live read');
    assert.ok(details._cachedRepos.includes('cached-repo'), 'should mark as cached');
  });

  // Cache-hit re-derivation of the two templated-workflow flags. Neither
  // hasOsvScanner nor hasAutoMergeWorkflow is ever served from the cache entry —
  // both are recomputed from ONE live contents listing on every cache hit. The
  // reason is the tri-state: a single failed read writes `null`, and a cached
  // `null` would be served until the repo's next push, which on a quiet repo is
  // never. Governance skips unknowns, so the standard would silently never apply
  // to exactly the repos nobody touches — the ones most likely to be missing it.
  // One extra call buys a verdict that is always current, for both flags.
  const cachedWorkflowsGh = (contentsResponse) => ({
    request: (path) => {
      if (path.endsWith('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
      if (path.includes('/contents/.github/workflows')) return contentsResponse();
      return Promise.resolve({});
    },
    paginate: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(null),
  });
  const cachedWorkflowsRepos = [
    { name: 'cached-repo', pushed_at: '2026-04-01T00:00:00Z', open_issues: 5, archived: false, fork: false, stars: 10 },
  ];
  const cachedWorkflowsCache = (details) => ({
    repos: {
      'cached-repo': {
        schemaVersion: REPO_CACHE_SCHEMA_VERSION,
        pushed_at: '2026-04-01T00:00:00Z',
        open_issues_count: 5,
        details: { commits: 42, hasCopilotReview: false, ...details },
      },
    },
  });

  // #449: repo-cache.json outgrew the Contents API's 1 MB inline ceiling, so
  // the store read returned null and this function never saw a hit. End to end
  // from the store read, a cache that arrives through the blob fallback must
  // produce a hit exactly as an inline one does.
  it('hits the cache when repo-cache.json arrives through the over-1 MB blob path', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const { createStore } = await import('./store.js');
    const sha = 'c1eee2546c92c6407e1107f6f88062808dc1553a';
    const encoded = Buffer.from(JSON.stringify(cachedWorkflowsCache({ commits: 42, ci: 2 }))).toString('base64');
    const dataGh = {
      request: async (path) => {
        if (path === '/repos/owner/repo-butler/contents/snapshots/repo-cache.json') return { encoding: 'none', content: '', sha };
        if (path === `/repos/owner/repo-butler/git/blobs/${sha}`) return { sha, encoding: 'base64', content: encoded };
        throw new Error(`unexpected request ${path}`);
      },
    };
    const cache = await createStore({ owner: 'owner', repo: 'repo-butler', token: 't', gh: dataGh }).readRepoCache();
    const gh = cachedWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache });
    assert.ok(details._cachedRepos.includes('cached-repo'), 'the large-file cache must produce a hit');
    assert.equal(details['cached-repo'].commits, 42, 'push-invariant fields come from the cache');
    assert.equal(details['cached-repo'].ci, 2, 'the ci last-known value is available again');
  });

  // Security alerts change without a push (a new advisory, a scheduled CodeQL
  // run, a manual dismissal) and feed the Gold "zero critical/high" check and
  // governance's open-vulnerability detector, so the cache-hit path must read
  // them live. Serving the cached counts would hold a repo at Gold after a new
  // high landed, for as long as the repo stayed quiet.
  const securityGh = ({ dependabot, codeScanning, secretScanning }) => ({
    request: (path) => {
      if (path.endsWith('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
      if (path.includes('/contents/.github/workflows')) return Promise.resolve([{ name: 'ci.yml' }]);
      if (path.includes('/dependabot/alerts')) return dependabot();
      if (path.includes('/code-scanning/alerts')) return codeScanning();
      if (path.includes('/secret-scanning/alerts')) return secretScanning();
      return Promise.resolve({});
    },
    paginate: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(null),
  });
  const zeroSummary = { count: 0, critical: 0, high: 0, medium: 0, low: 0, max_severity: null };
  const cleanCachedDetails = {
    ci: 2, license: 'MIT', communityHealth: 100, open_bugs: 0, released_at: new Date().toISOString(),
    vulns: zeroSummary, codeScanning: zeroSummary, secretScanning: { count: 0 },
  };
  const reject500 = () => Promise.reject(Object.assign(new Error('500'), { status: 500 }));

  it('reads security alerts live on a cache hit, so a new high drops the Gold check', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const { computeHealthTier } = await import('./report-shared.js');
    const gh = securityGh({
      dependabot: () => Promise.resolve([{ security_vulnerability: { severity: 'high' } }]),
      codeScanning: () => Promise.resolve([{ rule: { security_severity_level: 'critical' } }]),
      secretScanning: () => Promise.resolve([{ number: 1 }]),
    });
    const cache = cachedWorkflowsCache(cleanCachedDetails);
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache });
    const d = details['cached-repo'];
    assert.ok(details._cachedRepos.includes('cached-repo'), 'still a cache hit');
    assert.equal(d.vulns.max_severity, 'high', 'dependabot summary comes from the live read');
    assert.equal(d.codeScanning.max_severity, 'critical', 'code-scanning summary comes from the live read');
    assert.equal(d.secretScanning.count, 1, 'secret-scanning count comes from the live read');
    const check = computeHealthTier({ ...d, pushed_at: cachedWorkflowsRepos[0].pushed_at })
      .checks.find(c => c.name === 'Zero critical/high security findings');
    assert.equal(check.passed, false, 'the tier must see the live high, not the cached zero');
    assert.equal(cache.repos['cached-repo'].details.vulns, zeroSummary, 'the cache object is never mutated');
  });

  it('reports an unreadable live alert read as unknown (null), as the miss path does, never the cached counts', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = securityGh({ dependabot: reject500, codeScanning: reject500, secretScanning: reject500 });
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ ...cleanCachedDetails, vulns: { ...zeroSummary, count: 3, low: 3 } }),
    });
    const d = details['cached-repo'];
    assert.equal(d.vulns, null, 'an unreadable dependabot read is unknown, not the cached summary');
    assert.equal(d.codeScanning, null);
    assert.equal(d.secretScanning, null);
  });

  // The dependabot.yml config-only fallback exists for a token without alert
  // scope (403). It reports count 0, which passes the Gold check, so applying
  // it to a transient 500 would turn "could not read" into "no alerts".
  it('reads a non-array secret-scanning response as unknown, not as zero alerts', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = securityGh({
      dependabot: () => Promise.resolve([]),
      codeScanning: () => Promise.resolve([]),
      secretScanning: () => Promise.resolve({ message: 'unexpected shape' }),
    });
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache: cachedWorkflowsCache(cleanCachedDetails) });
    assert.equal(details['cached-repo'].secretScanning, null);
  });

  it('keeps the config-only dependabot fallback to a 403; any other failure is unknown', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const withDependabotYml = (dependabot) => ({
      ...securityGh({ dependabot, codeScanning: reject500, secretScanning: reject500 }),
      getFileContent: () => Promise.resolve('version: 2\n'),
    });
    const cache = () => cachedWorkflowsCache(cleanCachedDetails);
    const forbidden = () => Promise.reject(Object.assign(new Error('403'), { status: 403 }));

    const on500 = await fetchPortfolioDetails(withDependabotYml(reject500), 'owner', cachedWorkflowsRepos, { cache: cache() });
    assert.equal(on500['cached-repo'].vulns, null, 'a 500 is unknown, never a config-only zero');

    const on403 = await fetchPortfolioDetails(withDependabotYml(forbidden), 'owner', cachedWorkflowsRepos, { cache: cache() });
    assert.equal(on403['cached-repo'].vulns?.config_only, true, 'a 403 with dependabot.yml present is config-only');
  });

  it('treats an EMPTY cached details object as never-fetched, not as a cache hit', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // report.js persists `{ ...(repoDetails?.[name] || {}) }` for every active
    // repo, so one skipped past PORTFOLIO_DETAIL_LIMIT is cached as `{}` under a
    // current schema version. Taking the cache-hit branch would spread the
    // live-refreshed fields onto that and hand governance a NON-EMPTY details
    // object carrying no license, no codeowners and no security policy —
    // defeating hasRepoDetails, which exists to reject exactly that entry, and
    // making the repo a remediation-PR target on every allow-listed standard at
    // once. It must fall through to a full fetch instead.
    const gh = cachedWorkflowsGh(() => Promise.resolve([{ name: 'osv-scanner.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: {
        repos: {
          'cached-repo': {
            schemaVersion: REPO_CACHE_SCHEMA_VERSION,
            pushed_at: '2026-04-01T00:00:00Z',
            open_issues_count: 5,
            details: {},
          },
        },
      },
    });
    const d = details['cached-repo'];
    assert.ok(Object.keys(d).length > 4, 'must be a full fetch, not four refreshed keys spread onto {}');
    assert.ok('license' in d, 'a full fetch populates license; the cache-hit branch cannot');
  });

  it('re-derives a cached unknown hasOsvScanner into a real verdict without waiting for a push', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // The whole point of the cache-hit re-read. Last run's contents read failed
    // and cached `null`; this run's succeeds and finds the file. Serving the
    // cached value would strand the repo as unknown indefinitely.
    const gh = cachedWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }, { name: 'osv-scanner.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ hasOsvScanner: null }),
    });
    assert.equal(details['cached-repo'].hasOsvScanner, true, 'a cached unknown must be re-derived, never served');
  });

  it('keeps a known cached hasOsvScanner when the live re-read fails for a reason other than 404', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // The re-read exists to stop an unknown becoming permanent, not to let a
    // transient one erase a fact. An unknown live read is strictly less
    // information than the cached verdict: without the fallback one 500 on the
    // contents API turns a cached `false` — a real, actionable gap — into
    // `null`, governance skips the repo as unknown, and the run reports no gap
    // at all. The rejection is shaped exactly like github.js's: the status in
    // the message and as `err.status`, no richer and no poorer than the client.
    const gh = cachedWorkflowsGh(() => Promise.reject(
      Object.assign(new Error('GitHub API GET /repos/owner/cached-repo/contents/.github/workflows: 500 Internal Server Error'), { status: 500 })
    ));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ hasOsvScanner: false }),
    });
    assert.equal(details['cached-repo'].hasOsvScanner, false, 'a transient unknown must not overwrite a known cached verdict');
  });

  it('re-derives a cached hasAutoMergeWorkflow live rather than serving the cached verdict', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // The stale-compliant case, and the one that motivated moving this verdict
    // off the registration listing. The cache says the auto-merge workflow is
    // present; the default branch says otherwise — an apply PR that registered
    // the workflow and was then closed unmerged, or a file since deleted. Under
    // a pushed_at cache key a deletion does bump pushed_at, but a PR closed
    // unmerged does not, so serving `true` would hide the gap indefinitely on a
    // quiet repo. The live contents listing is the only verdict.
    const gh = cachedWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ hasAutoMergeWorkflow: true }),
    });
    assert.equal(details['cached-repo'].hasAutoMergeWorkflow, false, 'the cached verdict must be re-derived from the live listing, never served');
  });

  it('keeps a known cached hasAutoMergeWorkflow when the live re-read fails for a reason other than 404', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // Same asymmetry as hasOsvScanner, with a sharper edge: dependabot-auto-merge
    // is BOTH templatable and on the apply-schedule allow-list, so what happens
    // to this field on a bad read decides whether an unattended scheduled run
    // opens a PR. An unknown live read is strictly less information than the
    // cached verdict, so the cached `true` stands rather than decaying to null.
    // The rejection is shaped exactly like github.js's (message plus numeric
    // `err.status`), because a mock richer than the real client would make
    // this test evidence of nothing.
    const gh = cachedWorkflowsGh(() => Promise.reject(
      Object.assign(new Error('GitHub API GET /repos/owner/cached-repo/contents/.github/workflows: 500 Internal Server Error'), { status: 500 })
    ));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ hasAutoMergeWorkflow: true }),
    });
    assert.equal(details['cached-repo'].hasAutoMergeWorkflow, true, 'a transient unknown must not overwrite a known cached verdict');
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

  // Every field of a full fetch comes from its own endpoint, and each mock
  // below answers with a value no other field could produce, so wiring a
  // result to the wrong field — the failure a positional destructure invites —
  // changes this object and fails the deepEqual.
  it('maps every full-fetch result onto its own details field', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = {
      request: (path) => {
        const p = path.replace('/repos/owner/map-repo', '');
        if (p === '/automated-security-fixes') return Promise.resolve({ enabled: true, paused: true });
        if (p === '/rulesets/5') return Promise.resolve({ rules: [{ type: 'copilot_code_review' }] });
        if (p === '/contents/.github/workflows') return Promise.resolve([{ name: 'osv-scanner.yml' }]);
        if (p === '/contents') return Promise.resolve([{ name: 'CODEOWNERS' }]);
        if (p === '/actions/workflows') {
          return Promise.resolve({ total_count: 2, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }, { name: 'Lint', path: '.github/workflows/lint.yml' }] });
        }
        if (p === '/community/profile') return Promise.resolve({ health_percentage: 61, files: { issue_template: {} } });
        if (p.startsWith('/dependabot/alerts')) return Promise.resolve([{ security_vulnerability: { severity: 'high' } }]);
        if (p.startsWith('/code-scanning/alerts')) return Promise.resolve([{ rule: { security_severity_level: 'low' } }, { rule: { security_severity_level: 'medium' } }]);
        if (p.startsWith('/secret-scanning/alerts')) return Promise.resolve([{}, {}, {}]);
        if (p.startsWith('/actions/runs')) {
          return Promise.resolve({ workflow_runs: [{ conclusion: 'success' }, { conclusion: 'success' }, { conclusion: 'success' }, { conclusion: 'failure' }] });
        }
        if (p === '/dependency-graph/sbom') return Promise.resolve({ sbom: { packages: [] } });
        if (p === '/traffic/views') return Promise.resolve({ count: 9, uniques: 2 });
        if (p === '/traffic/clones') return Promise.resolve({ count: 5, uniques: 1 });
        if (p === '/stats/participation') return Promise.resolve({ owner: [3, 4] });
        if (path === '/search/commits') return Promise.resolve({ total_count: 7 });
        if (p === '') return Promise.resolve({ license: { spdx_id: 'Apache-2.0' }, allow_auto_merge: true });
        return Promise.reject(new Error(`unexpected request ${path}`));
      },
      paginate: (path) => {
        const p = path.replace('/repos/owner/map-repo', '');
        if (p === '/issues') return Promise.resolve([{ labels: [{ name: 'bug' }] }, { labels: [] }, { labels: [], pull_request: {} }]);
        if (p === '/releases') return Promise.resolve([{ draft: true, published_at: '2026-03-01T00:00:00Z' }, { draft: false, prerelease: false, published_at: '2026-02-01T00:00:00Z' }]);
        if (p === '/pulls') return Promise.resolve([{}, {}, {}, {}]);
        if (p === '/rulesets') return Promise.resolve([{ id: 5, enforcement: 'active' }]);
        return Promise.reject(new Error(`unexpected paginate ${path}`));
      },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [{ name: 'map-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 2, archived: false, fork: false, stars: 1 }];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.deepEqual(details['map-repo'], {
      commits: 7,
      weekly: [3, 4],
      license: 'Apache-2.0',
      ci: 2,
      communityHealth: 61,
      vulns: { count: 1, critical: 0, high: 1, medium: 0, low: 0, max_severity: 'high' },
      ciPassRate: 0.75,
      open_issues: 2,
      open_bugs: 1,
      open_prs: 4,
      sbom: { count: 0, packages: [] },
      released_at: '2026-02-01T00:00:00Z',
      hasIssueTemplate: true,
      hasAutoMergeWorkflow: false,
      hasReleaseWorkflow: false,
      hasOsvScanner: true,
      allowAutoMerge: true,
      hasCodeowners: true,
      hasSecurityPolicy: false,
      hasCopilotReview: true,
      autofix: { enabled: true, paused: true },
      libyear: null,
      codeScanning: { count: 2, critical: 0, high: 0, medium: 1, low: 1, max_severity: 'medium' },
      secretScanning: { count: 3 },
      traffic: { views_14d: { count: 9, uniques: 2 }, clones_14d: { count: 5, uniques: 1 } },
    });
  });

  it('derives hasAutoMergeWorkflow from the default-branch contents listing, and allowAutoMerge from repo settings', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = {
      // Order matters: the bare /repos/{owner}/{repo} path is a prefix of the
      // /actions/workflows path, so match the more-specific subpaths first.
      request: (path) => {
        if (path.includes('/contents/.github/workflows')) {
          return Promise.resolve([{ name: 'ci.yml' }, { name: 'dependabot-auto-merge.yml' }]);
        }
        // The workflows REGISTRATION listing deliberately does NOT carry the
        // auto-merge workflow here. The verdict below is `true` regardless, and
        // that is the assertion: presence comes from the file on the default
        // branch, never from what GitHub has registered. See the tri-state block
        // further down for why the listing cannot be trusted.
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
        if (path.includes('/contents/.github/workflows')) return Promise.resolve([{ name: 'ci.yml' }]);
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

  it('keeps the last known ci count when the workflows request errors, rather than reporting zero', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const { REPO_CACHE_SCHEMA_VERSION } = await import('./report-shared.js');
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
      { name: 'err-ci', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // A stale cache entry (pushed_at differs, so this is NOT a cache hit and the
    // full fetch runs) still holds the last count that was actually observed.
    const cache = {
      repos: {
        'err-ci': {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-01-01T00:00:00Z',
          open_issues_count: 0,
          details: { ci: 9 },
        },
      },
    };
    // ci feeds computeHealthTier's "Has CI workflows (2+)" gold check. Failing to
    // 0 demoted a healthy repo on one 500 and then filed a G7 tier-regression
    // finding about the demotion.
    const withCache = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.equal(withCache['err-ci'].ci, 9);

    // With nothing ever observed, the honest answer is unknown — not zero, which
    // is an assertion of non-compliance, and not a count, which would award gold
    // on no evidence.
    const noCache = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(noCache['err-ci'].ci, null);

    // A cache entry from a SUPERSEDED schema version must not be read either.
    // The version bump is the one mechanism that invalidates details whose
    // meaning has changed, and this value is written straight back into the
    // fresh entry under the new pushed_at — so an ungated read would launder a
    // pre-bump count into something indistinguishable from a fresh observation.
    const staleSchema = {
      repos: {
        'err-ci': {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION - 1,
          pushed_at: '2026-01-01T00:00:00Z',
          open_issues_count: 0,
          details: { ci: 9 },
        },
      },
    };
    const oldSchema = await fetchPortfolioDetails(gh, 'owner', repos, { cache: staleSchema });
    assert.equal(oldSchema['err-ci'].ci, null);
  });

  it('keeps the last known hasCopilotReview on the FULL-FETCH path, not just the cache hit', async () => {
    // The path a repo takes the moment it PUSHES. Applying the fallback only to
    // the cache-hit branch leaves this one persisting a raw null, and governance
    // drops a null repo from BOTH sides of the adoption figures — so a repo with
    // a genuine gap silently leaves the standard for the week and the dashboard
    // is indistinguishable from full adoption.
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const { REPO_CACHE_SCHEMA_VERSION } = await import('./report-shared.js');
    const gh = {
      request: (path) => {
        if (path.includes('/rulesets')) return Promise.reject(new Error('403'));
        if (path.includes('/actions/workflows')) return Promise.resolve({ total_count: 2, workflows: [] });
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: (path) => (path.includes('/rulesets') ? Promise.reject(new Error('403')) : Promise.resolve([])),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'pushed', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // pushed_at differs from the cache, so this is NOT a cache hit — the full
    // fetch runs, and the ruleset read fails.
    const cache = {
      repos: {
        pushed: {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-01-01T00:00:00Z',
          open_issues_count: 0,
          details: { hasCopilotReview: false },
        },
      },
    };
    const withCache = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.equal(withCache.pushed.hasCopilotReview, false, 'a known false must survive an unreadable live scan');

    // Nothing ever observed → honestly unknown.
    const noCache = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(noCache.pushed.hasCopilotReview, null);

    // A cache entry from a SUPERSEDED schema version must not be read. The old
    // code absorbed every unreadable scan into `false`, so a pre-bump `false`
    // may be a phantom; resolving today's honest null to it would report a
    // code-review-bot gap for a compliant repo — and it could never clear,
    // because the apply path now fail-closed-skips rather than correcting it.
    const staleSchema = {
      repos: {
        pushed: {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION - 1,
          pushed_at: '2026-01-01T00:00:00Z',
          open_issues_count: 0,
          details: { hasCopilotReview: false },
        },
      },
    };
    const oldSchema = await fetchPortfolioDetails(gh, 'owner', repos, { cache: staleSchema });
    assert.equal(oldSchema.pushed.hasCopilotReview, null);
  });

  it('re-reads a cached ci of null on a cache hit, so an unknown cannot become permanent', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const { REPO_CACHE_SCHEMA_VERSION } = await import('./report-shared.js');
    let workflowCalls = 0;
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          workflowCalls++;
          return Promise.resolve({ total_count: 6, workflows: [] });
        }
        if (path.includes('/rulesets')) return Promise.resolve([]);
        if (path.includes('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
        if (path.includes('/contents/.github/workflows')) return Promise.resolve([]);
        return Promise.resolve({});
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'quiet', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // A genuine cache HIT (schema, pushed_at and issue count all match) whose
    // stored ci is unknown. Without the conditional re-read this null would be
    // served until the repo's next push — indefinitely on a quiet repo — so the
    // repo would score bronze and drop out of the ci-workflows denominator on
    // every run thereafter.
    const cache = {
      repos: {
        quiet: {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-04-10T00:00:00Z',
          open_issues_count: 0,
          details: { ci: null, license: 'MIT' },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.equal(details.quiet.ci, 6, 'the unknown must be refreshed, not served');
    assert.equal(workflowCalls, 1, 'and refreshed with exactly one extra call');
    // The rest of the cached entry is still served from cache.
    assert.equal(details.quiet.license, 'MIT');
  });

  it('does not spend a call re-reading a ci that is already known on a cache hit', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const { REPO_CACHE_SCHEMA_VERSION } = await import('./report-shared.js');
    let workflowCalls = 0;
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          workflowCalls++;
          return Promise.resolve({ total_count: 6, workflows: [] });
        }
        if (path.includes('/rulesets')) return Promise.resolve([]);
        if (path.includes('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
        if (path.includes('/contents/.github/workflows')) return Promise.resolve([]);
        return Promise.resolve({});
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'quiet', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const cache = {
      repos: {
        quiet: {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-04-10T00:00:00Z',
          open_issues_count: 0,
          details: { ci: 3, license: 'MIT' },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.equal(details.quiet.ci, 3);
    // ci is push-invariant, so refreshing a KNOWN count would buy nothing for a
    // call per repo per run. Only the unknown is worth spending on.
    assert.equal(workflowCalls, 0);
  });

  // --- hasOsvScanner (osv-scanner standard) ---
  //
  // hasOsvScanner is TRI-STATE and comes from ONE read: GET
  // /contents/.github/workflows, the directory listing on the DEFAULT BRANCH.
  // Only `false` opens a remediation PR, so every uncertain read must land on
  // null. Fail-toward-present is specifically wrong here: this details object is
  // persisted under a pushed_at cache key, so one transient `true` would be
  // served until the repo's next push — indefinitely on a quiet repo.
  //
  // The workflows REGISTRATION listing (GET /actions/workflows) is deliberately
  // NOT consulted, which is why the mock below serves a healthy, active,
  // registered scanner by DEFAULT: no assertion here can be quietly reading it,
  // because it always says "compliant" while the verdicts vary. It lists every
  // workflow GitHub has ever registered, including from branches that never
  // merged, and the templated workflow triggers `on: pull_request` so it
  // self-registers while the apply PR introducing it is still open.
  //
  // `contentsResponse` is a thunk so a test can hand back a rejection as easily
  // as a payload; every other path keeps the benign stubs the surrounding tests
  // use. `workflowsResponse` is overridable only so two tests can prove the
  // listing is ignored.
  //
  // The registration listing as it looks on a healthy repo: complete (total_count
  // matches the page) and carrying an osv-scanner entry in the given state.
  const osvRegistered = (state = 'active') => () => Promise.resolve({
    total_count: 2,
    workflows: [
      { name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
      { name: 'OSV-Scanner', path: '.github/workflows/osv-scanner.yml', state },
    ],
  });
  const makeWorkflowsGh = (contentsResponse, workflowsResponse = osvRegistered()) => ({
    request: (path) => {
      if (path.includes('/contents/.github/workflows')) return contentsResponse();
      if (path.includes('/actions/workflows')) return workflowsResponse();
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
  const osvRepos = [
    { name: 'osv-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
  ];

  // A directory listing containing the templated file.
  const contentsWithScanner = () => Promise.resolve([{ name: 'ci.yml' }, { name: 'osv-scanner.yml' }]);

  it('reports hasOsvScanner true when the templated file is on the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = makeWorkflowsGh(contentsWithScanner);
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, true);
  });

  it('reports hasOsvScanner false when the scanner file is absent from the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = makeWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, false);
  });

  it('reports hasOsvScanner false when the workflows directory 404s (no workflows at all)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // A 404 on the contents listing is a genuine answer, not a failure: the repo
    // has no .github/workflows directory, so the scanner is definitively absent
    // and the standard is a real gap worth a remediation PR.
    // The error is EXACTLY what github.js throws — the code in the message and
    // as a numeric `err.status` (#438; github.test.js pins that the real client
    // sets it). A mock more capable than the real client turns a green test
    // into evidence of nothing.
    const notFound = () => Promise.reject(
      Object.assign(new Error('GitHub API GET /repos/owner/osv-repo/contents/.github/workflows: 404 Not Found'), { status: 404 })
    );
    const gh = makeWorkflowsGh(notFound);
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, false);
  });

  it('reports hasOsvScanner null when the contents read fails for any reason other than 404', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // Rate limit, 403, network blip: we do not know what is on the default
    // branch. Unknown is honest; governance skips unknowns, and `false` here
    // would open an apply PR on every repo the failure touched. The body
    // mentions ": 404" on purpose: only `err.status` may mean absence (#438).
    const serverError = () => Promise.reject(
      Object.assign(new Error('GitHub API GET /repos/owner/osv-repo/contents/.github/workflows: 500 {"message":"upstream said: 404"}'), { status: 500 })
    );
    const gh = makeWorkflowsGh(serverError);
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, null);
  });

  it('still reports hasOsvScanner true when the scanner has been auto-disabled for inactivity', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // The enabled state is deliberately NOT part of this standard, and this is
    // the case that decided it. GitHub auto-disables schedule-triggered
    // workflows after 60 days of repository inactivity, and this template IS
    // schedule-triggered — so on any quiet repo the scanner flips to
    // `disabled_inactivity` through nobody's decision. Counting that as a gap
    // routes the repo into the templated apply path, whose contents PUT sends no
    // `sha`; the file is already there, GitHub answers 422, and the same
    // unfixable finding retries on every run forever. Writing a file cannot
    // re-enable a workflow — that needs a settings executor, not this standard.
    const gh = makeWorkflowsGh(contentsWithScanner, osvRegistered('disabled_inactivity'));
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, true);
  });

  it('reports hasOsvScanner false for a workflow registered from a branch that never merged', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // The phantom / self-registration case, and the reason the listing cannot be
    // the presence signal. GitHub lists every workflow it has ever registered,
    // including from unmerged branches — and the templated workflow triggers
    // `on: pull_request`, so it registers itself while the apply PR that
    // introduces it is still open. Trusting the listing would report the repo
    // compliant before that PR merged, and permanently if it were closed unmerged.
    const gh = makeWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]), osvRegistered());
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, false);
  });

  it('does not satisfy hasOsvScanner from a file that merely mentions osv-scanner', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // Detection is an EXACT filename match, unlike the deliberately broad
    // hasReleaseWorkflow. A near-miss name and a workflow whose display name
    // mentions the scanner are both gaps: the standard is satisfied only by the
    // file the apply template writes, and a looser match would leave the
    // template unable to converge on the repo's own variant.
    const gh = makeWorkflowsGh(
      () => Promise.resolve([
        { name: 'nightly.yml' },
        { name: 'my-osv-scanner.yml' },
        { name: 'osv-scanner.yaml' },
      ]),
      () => Promise.resolve({
        total_count: 1,
        workflows: [{ name: 'Run osv-scanner nightly', path: '.github/workflows/nightly.yml', state: 'active' }],
      }),
    );
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, false);
  });

  // --- hasAutoMergeWorkflow (dependabot-auto-merge standard) ---
  //
  // Same shape as hasOsvScanner, from the same single read, and for the same
  // two reasons — but the stakes are higher, so it gets its own coverage rather
  // than riding on the scanner's.
  //
  // It is TRI-STATE and comes from GET /contents/.github/workflows, the
  // directory listing on the DEFAULT BRANCH. The workflows REGISTRATION listing
  // (GET /actions/workflows) is deliberately not consulted: GitHub lists every
  // workflow it has ever registered, including from branches that never merged.
  // Verified on this repository — `release-recovery.yml` is listed `active`
  // while existing on no branch. An apply PR opened and then closed unmerged
  // therefore left the repo reading compliant forever, so its gap never
  // reappeared and no further PR was ever offered.
  //
  // And `false` is not the safe default for an unreadable read.
  // dependabot-auto-merge is both templatable and on the apply-schedule
  // allow-list, so a `false` manufactured from one transient API error opens a
  // remediation PR on an unattended scheduled run. Unknown is reported instead,
  // and governance skips unknowns. Fail-toward-present would be wrong too: this
  // details object is persisted under a pushed_at cache key, so one transient
  // `true` would be served until the repo's next push.
  //
  // The registration listing below therefore carries the auto-merge workflow,
  // active and complete, in every case except the clean-absence one: it always
  // says "compliant" while the verdicts vary, so no assertion here can be
  // quietly reading it.
  const amRegistered = () => Promise.resolve({
    total_count: 2,
    workflows: [
      { name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
      { name: 'Dependabot auto-merge', path: '.github/workflows/dependabot-auto-merge.yml', state: 'active' },
    ],
  });
  const amRepos = [
    { name: 'am-tri', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
  ];

  it('reports hasAutoMergeWorkflow true when the templated file is on the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const gh = makeWorkflowsGh(
      () => Promise.resolve([{ name: 'ci.yml' }, { name: 'dependabot-auto-merge.yml' }]),
      amRegistered,
    );
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, true);
  });

  it('reports hasAutoMergeWorkflow false when the file is absent from the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // Clean absence: nothing registered, nothing on the branch. A real gap, and
    // the only verdict that may open a remediation PR.
    const gh = makeWorkflowsGh(
      () => Promise.resolve([{ name: 'ci.yml' }]),
      () => Promise.resolve({ total_count: 1, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }),
    );
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, false);
  });

  it('reports hasAutoMergeWorkflow false for a workflow REGISTERED but absent from the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // The phantom case — the regression this whole change exists to prevent.
    // The registration listing says the auto-merge workflow is there and active;
    // the default branch does not have the file. That is precisely what an apply
    // PR opened and then closed unmerged leaves behind, and reading the listing
    // reported the repo compliant from then on, permanently. The contents
    // listing is the only thing that can tell the difference.
    const gh = makeWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]), amRegistered);
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, false, 'a registered-but-unmerged workflow is a gap, not compliance');
  });

  it('reports hasAutoMergeWorkflow false when the workflows directory 404s (no workflows at all)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // A 404 on the contents listing is a genuine answer, not a failure: there is
    // no .github/workflows directory, so the workflow is definitively absent and
    // this is a real gap. The error is EXACTLY what github.js throws — the code
    // in the message and as a numeric `err.status`, which the `.catch` keys on.
    const gh = makeWorkflowsGh(
      () => Promise.reject(Object.assign(new Error('GitHub API GET /repos/owner/am-tri/contents/.github/workflows: 404 Not Found'), { status: 404 })),
      amRegistered,
    );
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, false);
  });

  it('reports hasAutoMergeWorkflow null when the contents read fails for any reason other than 404', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    // Rate limit, 403, network blip: we do not know what is on the default
    // branch. `false` here would open an apply PR on every repo the failure
    // touched, unattended, on the apply schedule. Unknown is honest, and
    // governance excludes unknowns from both compliance arrays. The body
    // mentions ": 404" on purpose: only `err.status` may mean absence (#438).
    const gh = makeWorkflowsGh(
      () => Promise.reject(Object.assign(new Error('GitHub API GET /repos/owner/am-tri/contents/.github/workflows: 500 {"message":"upstream said: 404"}'), { status: 500 })),
      amRegistered,
    );
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, null);
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

  it('renders a Stale Butler PRs table, escaping everything and leaking no title', () => {
    // A finding type with no block here silently inflates the "Governance (N)"
    // header and then vanishes from the page, which would defeat G12 entirely.
    const findings = [{
      type: 'stale-butler-pr',
      repo: 'repo-a',
      stalePRs: [
        { number: 21, age: 40, state: 'awaiting-human', branch: 'repo-butler/onboard', verified: true, draft: false, title: '<script>alert(1)</script>' },
        { number: 22, age: 15, state: 'blocked-persistent', branch: 'repo-butler/apply-codeowners', verified: false, draft: true, title: 'untrusted' },
      ],
      priority: 'medium',
      remediation: { executor: 'manual' },
    }];
    const html = buildGovernanceSection(findings);

    assert.ok(html.includes('Stale Butler PRs'), 'should have a stale butler PR heading');
    assert.ok(html.includes('href="repo-a.html"'), 'should link the repo');
    assert.ok(html.includes('#21') && html.includes('#22'), 'should list both PRs');
    assert.ok(html.includes('40d'), 'should show the oldest age');
    assert.ok(html.includes('awaiting merge'), 'should use the human-readable state label');
    assert.ok(html.includes('draft'), 'a parked PR reads wrongly as merely ignored otherwise');
    assert.ok(html.includes('unverified'), 'should flag the PR whose identity did not corroborate');

    // The dashboard is world-readable and PR titles are attacker-controlled:
    // anyone can open a `repo-butler/*` branch on a portfolio repo.
    assert.ok(!html.includes('<script>alert(1)</script>'), 'a PR title must never render');
    assert.ok(!html.includes('repo-butler/onboard'), 'a branch name must never render');
  });

  it('renders a Stalled Alerts table for stalled-alert findings, escaping the detail', () => {
    // Same reason as the Stale Butler PRs block above: a finding type with no
    // block here inflates the "Governance (N)" header and then vanishes.
    const findings = [{
      type: 'stalled-alert',
      repo: 'repo-a',
      alerts: [
        { number: 153, package: 'http-proxy-middleware', ecosystem: 'npm', manifestPath: 'docs-site/package-lock.json', severity: 'medium', ageDays: 35, classification: 'reachable-by-update', detail: '<script>alert(1)</script>' },
        { number: 160, package: 'wee-lib', ecosystem: 'npm', manifestPath: 'package-lock.json', severity: 'high', ageDays: 20, classification: 'unknown', detail: 'lockfile unreadable' },
      ],
      priority: 'medium',
      remediation: { executor: 'manual' },
    }];
    const html = buildGovernanceSection(findings);

    assert.ok(html.includes('Stalled Alerts'), 'should have a stalled alerts heading');
    assert.ok(html.includes('href="repo-a.html"'), 'should link the repo');
    assert.ok(html.includes('http-proxy-middleware'), 'should name the package');
    assert.ok(html.includes('35d'), 'should show the oldest age');
    assert.ok(html.includes('reachable-by-update'), 'the classification is the actionable part');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'a detail string built from lockfile contents must be escaped');
  });

  it('renders a Tier Regressions table for tier-regression findings', () => {
    const findings = [
      { type: 'tier-regression', repo: 'repo-a', previousTier: 'gold', currentTier: 'silver', priorWeek: '2026-W26', priority: 'high', remediation: { executor: 'manual' } },
    ];
    const html = buildGovernanceSection(findings);
    assert.ok(html.includes('Tier Regressions'), 'should have a tier regressions heading');
    assert.ok(html.includes('href="repo-a.html"'), 'should link the regressed repo');
    assert.ok(html.includes('Gold'), 'should show the lost tier');
    assert.ok(html.includes('Silver'), 'should show the current tier');
    assert.ok(html.includes('2026-W26'), 'should show the baseline week');
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

describe('buildAutofixNudge (ADR-012 Phase 3 not-driven callout)', () => {
  it('renders nothing when there are no findings', () => {
    assert.equal(buildAutofixNudge(null), '');
    assert.equal(buildAutofixNudge(undefined), '');
    assert.equal(buildAutofixNudge([]), '');
  });

  it('renders nothing when no finding has autofixEnabled === false', () => {
    const findings = [
      { type: 'open-vulnerability', repo: 'inflight', sources: ['dependabot'], autofixEnabled: true },
      { type: 'open-vulnerability', repo: 'unknownstate', sources: ['dependabot'], autofixEnabled: null },
      { type: 'open-vulnerability', repo: 'codeonly', sources: ['code-scanning'] },
      { type: 'standards-gap', tool: 'license' },
    ];
    assert.equal(buildAutofixNudge(findings), '');
  });

  it('renders a singular-noun callout for exactly one not-driven repo', () => {
    const findings = [
      { type: 'open-vulnerability', repo: 'notdriven', sources: ['dependabot'], autofixEnabled: false },
      { type: 'open-vulnerability', repo: 'inflight', sources: ['dependabot'], autofixEnabled: true },
    ];
    const html = buildAutofixNudge(findings);
    assert.ok(html.includes('1 repo has'), 'uses singular noun for count 1');
    assert.ok(html.includes('Dependabot autofix off'));
    assert.ok(html.includes('dependabot-security'), 'points at the apply action that fixes it');
  });

  it('renders a plural-noun callout counting only dependabot-sourced not-driven findings', () => {
    const findings = [
      { type: 'open-vulnerability', repo: 'notdriven-a', sources: ['dependabot'], autofixEnabled: false },
      { type: 'open-vulnerability', repo: 'notdriven-b', sources: ['dependabot'], autofixEnabled: false },
      { type: 'open-vulnerability', repo: 'inflight', sources: ['dependabot'], autofixEnabled: true },
      { type: 'open-vulnerability', repo: 'unknownstate', sources: ['dependabot'], autofixEnabled: null },
      { type: 'open-vulnerability', repo: 'codeonly', sources: ['code-scanning'] },
      { type: 'standards-gap', tool: 'license' },
    ];
    const html = buildAutofixNudge(findings);
    assert.ok(html.includes('2 repos have'), 'uses plural noun and counts only the not-driven repos');
  });

  const TWO_NOT_DRIVEN = [
    { type: 'open-vulnerability', repo: 'notdriven-a', sources: ['dependabot'], autofixEnabled: false },
    { type: 'open-vulnerability', repo: 'notdriven-b', sources: ['dependabot'], autofixEnabled: false },
  ];

  it('renders no trend badge when priorCount is not supplied (first run / no prior snapshot)', () => {
    const html = buildAutofixNudge(TWO_NOT_DRIVEN);
    assert.ok(!html.includes('status-trend'), 'no prior count means nothing to compare against');
  });

  it('renders no trend badge when the count is unchanged from the prior snapshot', () => {
    const html = buildAutofixNudge(TWO_NOT_DRIVEN, 2);
    assert.ok(!html.includes('status-trend'), 'an unchanged count stays calm, matching buildStatusHero');
  });

  it('renders a red "down"-classed badge with an up arrow when the count rose (a regression)', () => {
    const html = buildAutofixNudge(TWO_NOT_DRIVEN, 1);
    assert.ok(html.includes('status-trend down'), 'a rising not-driven count is a regression, styled red');
    assert.ok(html.includes('▲'), 'arrow reflects the actual increase');
    assert.ok(html.includes('+1'));
  });

  it('renders a green "up"-classed badge with a down arrow when the count fell (an improvement)', () => {
    const html = buildAutofixNudge(TWO_NOT_DRIVEN, 5);
    assert.ok(html.includes('status-trend up'), 'a falling not-driven count is progress, styled green');
    assert.ok(html.includes('▼'), 'arrow reflects the actual decrease');
    // No leading minus sign — mirrors buildStatusHero's Math.abs handling.
    assert.ok(html.includes('>▼ 3<'), 'magnitude only, no double-negative sign');
    assert.ok(!html.includes('-3'));
  });

  it('renders nothing (including no trend) when the current count is 0, even with a prior count', () => {
    const findings = [{ type: 'open-vulnerability', repo: 'inflight', sources: ['dependabot'], autofixEnabled: true }];
    assert.equal(buildAutofixNudge(findings, 3), '');
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

describe('fetchPortfolioDetails open_bugs (tri-state, cache miss)', () => {
  const repos = [{ name: 'fresh', pushed_at: '2026-04-01T00:00:00Z', open_issues: 7, archived: false, fork: false, stars: 1 }];
  const mkGh = (issuesResponder) => ({
    request: () => Promise.resolve({}),
    paginate: (path) => (path === '/repos/owner/fresh/issues' ? issuesResponder() : Promise.resolve([])),
    getFileContent: () => Promise.resolve(null),
  });

  it('counts actionable bugs only: excludes PRs, blocked bugs and non-bugs', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const issues = [
      { number: 1, labels: [{ name: 'bug' }] },
      { number: 2, labels: [{ name: 'Type: Bug' }, { name: 'blocked' }] },
      { number: 3, labels: [{ name: 'bug' }], pull_request: {} },
      { number: 4, labels: [{ name: 'enhancement' }] },
    ];
    const details = await fetchPortfolioDetails(mkGh(() => Promise.resolve(issues)), 'owner', repos, {});
    assert.equal(details.fresh.open_issues, 3, 'PRs are filtered out of the issue total');
    assert.equal(details.fresh.open_bugs, 1, 'blocked bugs and PRs do not count as actionable bugs');
  });

  it('reports open_bugs as null (unknown, never 0) when the issue listing fails', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const details = await fetchPortfolioDetails(mkGh(() => Promise.reject(new Error('500'))), 'owner', repos, {});
    assert.equal(details.fresh.open_bugs, null);
    assert.equal(details.fresh.open_issues, 7, 'falls back to the repo listing count');
  });
});
