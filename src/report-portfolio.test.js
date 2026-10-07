import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSparklineSVG, buildCampaignSection, buildGovernanceSection, buildAutofixNudge } from './report-portfolio.js';

describe('generateDigestReport', () => {
  it('produces HTML containing digest structure', async () => {
    const { generateDigestReport } = await import('./report-portfolio.js');
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
    const { generateDigestReport } = await import('./report-portfolio.js');
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
    const { generateDigestReport } = await import('./report-portfolio.js');
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
    const { generateDigestReport } = await import('./report-portfolio.js');
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
    const { generateDigestReport } = await import('./report-portfolio.js');
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
    const { generateDigestReport } = await import('./report-portfolio.js');
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
    const html = generatePortfolioReport({ owner: 'test', portfolio: mkPortfolio(), details: mkDetails(null), config: {} });
    assert.ok(!html.includes('>none<'), 'must not claim the repo has no CI');
    assert.ok(html.includes('Workflow listing could not be read'), 'says why it is unknown');
  });

  it('still shows an observed zero as "none" — that is a real fact', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const html = generatePortfolioReport({ owner: 'test', portfolio: mkPortfolio(), details: mkDetails(0), config: {} });
    assert.ok(html.includes('>none<'));
  });

  it('renders an unreadable Dependabot read as unavailable, never as a count (#452)', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const details = mkDetails(2);
    details.a.vulns = { unreadable: true };
    const html = generatePortfolioReport({ owner: 'test', portfolio: mkPortfolio(), details, config: {} });
    assert.ok(!html.includes('>undefined<'), 'no count exists to show');
    assert.ok(html.includes('Dependabot alerts could not be read'), 'says why it is unknown');
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
    const html = generatePortfolioReport({ owner, portfolio, details, config: {} });
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
    const html = generatePortfolioReport({ owner, portfolio, details, config: {}, governanceFindings });
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
    const html = generatePortfolioReport({ owner, portfolio, details, config: {}, governanceFindings });
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
    const html = generatePortfolioReport({ owner, portfolio, details, config: {}, governanceFindings, priorAutofixNotDrivenCount: 0 });
    assert.ok(html.includes('status-trend down'), 'the 9th param reaches buildAutofixNudge as priorCount (0 → 1 is a regression)');
  });

  it('has simplified health table with 6 columns and full view toggle', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [
      { name: 'b', stars: 1, forks: 0, open_issues: 2, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'Go' },
    ]};
    const details = { b: { commits: 15, weekly: [3], license: 'MIT', ci: 3, communityHealth: 85, vulns: { count: 0, max_severity: null }, ciPassRate: 0.92, open_issues: 2, open_bugs: 1, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
    assert.ok(html.includes('Next Step'), 'simplified table should have Next Step column');
    assert.ok(html.includes('Show all columns'), 'should have toggle for full table');
  });

  it('wraps commit activity in collapsible details', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [
      { name: 'c', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const details = { c: { commits: 10, weekly: [1,1,1], license: 'MIT', ci: 2, communityHealth: 80, vulns: { count: 0, max_severity: null }, ciPassRate: 1.0, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
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
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
    assert.ok(html.includes('status-ok'), 'all-gold portfolio renders the healthy tone');
    assert.ok(html.includes('All in good order'), 'healthy headline in the butler voice');
    assert.ok(html.includes('no open security alerts'), 'shows a clean security posture');
    assert.ok(html.includes('<details><summary>All repos'), 'all-gold collapses the repo table');
  });

  it('shows the settling-in line when there is no prior snapshot to diff', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
    assert.ok(html.includes('Since the last run'), 'has the since-the-last-run section');
    assert.ok(html.includes('Still settling in'), 'first run with no prior shows the settling-in line');
  });

  it('surfaces an upward tier move and gold trend against a prior snapshot', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    const prior = { repos: { a: { computed: { tier: 'silver' } } } };
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {}, priorPortfolio: prior });
    assert.ok(html.includes('since-item since-up'), 'an upward tier move renders as an up item');
    assert.ok(html.includes('since-arrow'), 'renders the tier-move arrow');
    assert.ok(html.includes('status-trend up'), 'shows an upward gold trend in the hero');
  });

  it('reports a cleared security alert as an upward delta item', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    const prior = { repos: { a: { computed: { tier: 'gold' }, vulns: { count: 1, high: 1, max_severity: 'high' } } } };
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {}, priorPortfolio: prior });
    assert.ok(html.includes('cleared its security alerts'), 'a resolved alert shows as a delta item');
  });

  it('raises the critical banner and crit voice when a repo has high alerts', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [{ name: 'risky', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' }] };
    const details = { risky: { commits: 10, weekly: [1], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 2, critical: 1, high: 1, max_severity: 'critical' }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
    assert.ok(html.includes('alert-banner alert-critical'), 'critical state renders the banner');
    assert.ok(html.includes('This rather wants your attention'), 'critical headline in the butler voice');
    assert.ok(html.includes('status-crit'), 'hero renders in the critical tone');
    assert.ok(html.includes('2 security alerts'), 'counts the critical/high alerts');
  });

  it('opens the repo table and reads as attention when a repo is below Gold', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [{ name: 'b', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' }] };
    const details = { b: { commits: 5, weekly: [1], license: 'None', ci: 0, communityHealth: 20, vulns: null, ciPassRate: null, open_issues: 0, open_bugs: 0, released_at: null, codeScanning: null, secretScanning: null } };
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
    assert.ok(html.includes('<details open><summary>All repos'), 'a below-gold portfolio opens the repo table');
    assert.ok(html.includes('A few things for your eye'), 'below-gold but un-alerted reads as attention');
  });

  it('shows a repo once in the delta when it both moves tier and clears alerts', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = goldPortfolio();
    // Prior: silver AND at-risk; current: gold AND clean → one move, not two rows.
    const prior = { repos: { a: { computed: { tier: 'silver' }, vulns: { count: 1, high: 1, max_severity: 'high' } } } };
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {}, priorPortfolio: prior });
    assert.ok(html.includes('since-item since-up'), 'renders the tier move');
    assert.ok(!html.includes('cleared its security alerts'), 'does not also render a separate security row');
  });

  it('formats a downward gold trend without a double negative', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const portfolio = { repos: [{ name: 'b', stars: 0, forks: 0, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' }] };
    const details = { b: { commits: 5, weekly: [1], license: 'None', ci: 0, communityHealth: 20, vulns: null, ciPassRate: null, open_issues: 0, open_bugs: 0, released_at: null, codeScanning: null, secretScanning: null } };
    const prior = { repos: { b: { computed: { tier: 'gold' } } } };
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {}, priorPortfolio: prior });
    assert.ok(html.includes('status-trend down'), 'renders a downward trend');
    assert.ok(html.includes('▼ 100pp'), 'shows the magnitude without a sign');
    assert.ok(!html.includes('-100pp'), 'no double-negative rendering');
  });
});

// #477: a repo whose only Gold blocker is an unread scanner is Unconfirmed on
// every dashboard surface, and nothing on the page reads an unread scanner as
// clean, cleared or a demotion.
describe('provisional tier on the dashboard', () => {
  const now = new Date().toISOString();
  const repo = name => ({ name, stars: 0, forks: 0, open_issues: 0, pushed_at: now, archived: false, fork: false, language: 'JS' });
  const goldDetails = () => ({ commits: 20, weekly: [1, 2], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: now, codeScanning: null, secretScanning: { count: 0 } });
  const fixture = () => ({
    portfolio: { repos: [repo('g'), repo('p')] },
    details: { g: goldDetails(), p: { ...goldDetails(), codeScanning: { unreadable: true } } },
  });
  const render = async (extra = {}) => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    return generatePortfolioReport({ owner: 'owner', ...fixture(), config: {}, ...extra });
  };

  it('shows Unconfirmed, never Silver, in the tables and the tier mix', async () => {
    const html = await render();
    assert.ok(html.includes('<span class="tier-badge tier-unconfirmed"'), 'an Unconfirmed tier cell');
    // Class attributes, not bare names: the inlined stylesheet defines them all.
    assert.ok(!html.includes('class="tier-badge tier-silver"'), 'the provisional repo is never drawn as Silver');
    assert.ok(html.includes('1 Unconfirmed'), 'the tier mix names it apart');
  });

  it('computes Gold % over confirmed repos and never names an unread scanner as clean', async () => {
    const html = await render();
    assert.ok(html.includes('100% Gold'), 'the provisional repo is out of the Gold % cohort');
    assert.ok(!html.includes('no open security alerts'), 'an unread scanner is not a clean posture');
    assert.ok(html.includes('alerts unread for 1 repo'));
  });

  it('keeps the trend on one cohort, so a repo going unread is not a Gold dip', async () => {
    const prior = { repos: { g: { computed: { tier: 'gold' } }, p: { computed: { tier: 'gold' } } } };
    const html = await render({ priorPortfolio: prior });
    assert.ok(!html.includes('class="status-trend'), 'no trend: the shared cohort was all Gold both times');
  });

  it('emits no tier move to or from provisional and no "cleared" from an unread read', async () => {
    const prior = { repos: { g: { computed: { tier: 'gold' } }, p: { computed: { tier: 'gold' }, vulns: { count: 1, high: 1, max_severity: 'high' } } } };
    const html = await render({ priorPortfolio: prior });
    assert.ok(!html.includes('class="since-arrow"'), 'no Gold → Silver move for a repo that only went unread');
    assert.ok(!html.includes('cleared its security alerts'), 'a high that went unread was not cleared');

    const back = { repos: { g: { computed: { tier: 'gold' } }, p: { computed: { tier: 'silver', provisional: true } } } };
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const recovered = generatePortfolioReport({ owner: 'owner', portfolio: fixture().portfolio, details: { g: goldDetails(), p: goldDetails() }, config: {}, priorPortfolio: back });
    assert.ok(!recovered.includes('class="since-arrow"'), 'no Silver → Gold move when the read recovers');
    assert.ok(!recovered.includes('class="status-trend'), 'and no Gold % rise: the recovered repo is out of the cohort');
  });

  it('names the unread scanner as the next step rather than an unobserved check', async () => {
    const html = await render();
    assert.ok(html.includes('code scanning unread'));
    assert.ok(!html.includes('Zero critical/high security findings'));
  });

  it('does not force the repo tables open for a provisional repo', async () => {
    const html = await render();
    assert.ok(html.includes('<details><summary>All repos'));
  });

  it('never says all clear while a scanner is unread', async () => {
    const { buildPortfolioAttentionSection } = await import('./report-portfolio.js');
    const { portfolio, details } = fixture();
    const html = buildPortfolioAttentionSection(portfolio.repos, details, 'owner', {});
    assert.ok(!html.includes('All clear'));
    assert.ok(html.includes('could not read the security alerts for 1 repo'));
  });

  it('the digest says alerts were unread rather than reading as an all-clear', async () => {
    const { generateDigestReport } = await import('./report-portfolio.js');
    const { portfolio, details } = fixture();
    const html = generateDigestReport('owner', portfolio.repos, details);
    assert.ok(html.includes('Security alerts were unread for 1 repo'));
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
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
    assert.ok(html.includes('class="hero-intro"'), 'should render hero intro block');
    assert.ok(html.includes('seven-phase pipeline'), 'intro should mention the seven-phase pipeline');
    assert.ok(html.includes('https://github.com/IsmaelMartinez/repo-butler'), 'intro should link to the source repo');
  });

  it('portfolio dashboard shows the collapsible About section with all seven phases', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = minimalPortfolio();
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
    assert.ok(html.includes('About — How it works'), 'should have About summary');
    assert.ok(html.includes('class="about-phases"'), 'should render the phase list');
    for (const phase of ['OBSERVE', 'ASSESS', 'UPDATE', 'GOVERNANCE', 'IDEATE', 'PROPOSE', 'REPORT']) {
      assert.ok(html.includes(`<strong>${phase}</strong>`), `About section should list the ${phase} phase`);
    }
  });

  it('portfolio dashboard renders the site footer with all documentation links', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const { portfolio, details } = minimalPortfolio();
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
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
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
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
    const html = generatePortfolioReport({ owner: 'owner', portfolio, details, config: {} });
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
