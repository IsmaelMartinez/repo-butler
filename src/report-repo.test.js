import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildActionItems, computeContributorStats } from './report-repo.js';

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

describe('ci_workflows rendering is tri-state', () => {
  const baseSnapshot = () => ({
    repository: 'owner/test', meta: { stars: 5, forks: 1, watchers: 2 },
    issues: { open: [] }, releases: [{ tag: 'v1', published_at: new Date().toISOString() }],
    community_profile: { health_percentage: 90, files: { readme: true, license: true } },
    dependabot_alerts: { count: 0, critical: 0, high: 0, medium: 0, low: 0, max_severity: null },
    code_scanning_alerts: null, secret_scanning_alerts: { count: 0 },
    ci_pass_rate: { pass_rate: 0.98, total_runs: 100, passed: 98, failed: 2 },
    pushed_at: new Date().toISOString(), license: 'MIT', sbom: null,
    summary: { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 10, human_prs: 8, bot_prs: 2, releases: 1, latest_release: 'v1', ci_workflows: null, bus_factor: 2, time_to_close_median: { median_days: 3, sample_size: 10 } },
  });
  const render = async (snapshot) => {
    const { generateRepoReport } = await import('./report-repo.js');
    return generateRepoReport(snapshot, [{ month: 'Jan', count: 5 }], [{ month: 'Jan', opened: 2, closed: 3 }], [{ author: 'dev', count: 8, firstTime: false }], { direction: 'stable', weeks: [] }, [], null, [], null, null, {});
  };

  it('never states "0 workflows" for a repo whose workflow listing was not read', async () => {
    // The dashboard was asserting a fact nobody observed: an unread listing and
    // a repo with genuinely no CI both rendered as "0 workflows", and that
    // string was shown as the REASON for the tier the repo had just been given.
    const html = await render(baseSnapshot());
    assert.ok(!html.includes('0 workflows'), 'must not claim zero workflows on an unknown');
    assert.ok(html.includes('unavailable'), 'renders the same vocabulary open_bugs uses');
  });

  it('still shows a real count when the listing was read', async () => {
    const snap = baseSnapshot();
    snap.summary.ci_workflows = 4;
    const html = await render(snap);
    assert.ok(html.includes('4 workflows'));
  });

  it('shows a genuine zero as zero — an observed absence is still a fact', async () => {
    const snap = baseSnapshot();
    snap.summary.ci_workflows = 0;
    const html = await render(snap);
    assert.ok(html.includes('0 workflows'));
  });

  it('renders an unreadable scanner as unavailable in the tier table, never "undefined" (#452)', async () => {
    const snap = baseSnapshot();
    snap.summary.ci_workflows = 4;
    snap.dependabot_alerts = { unreadable: true };
    const html = await render(snap);
    assert.ok(!html.includes('undefined vuln'), 'no count exists to show');
    assert.ok(html.includes('Dependabot unavailable'));
    assert.ok(html.includes('vuln unavailable'));
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
