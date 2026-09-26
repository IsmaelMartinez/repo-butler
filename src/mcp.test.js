// MCP server tests — verify JSON-RPC protocol handling and tool/resource responses.
// Tests the message handler directly without spawning a subprocess.

import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Every tool answers from a fixture data branch and a stubbed `gh`, never from
// whatever this checkout's repo-butler-data ref and gh login happen to hold.
// Tests that depended on those accepted "data or error" and so mostly
// exercised the error path; these assert exact answers instead. The fixture is
// a trimmed copy of the real snapshot shapes with fake repo names.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/mcp-data-branch.json', import.meta.url), 'utf8'));
// Five hours after the fixture's data commit, so the envelope is warning-free
// and every recomputed tier is pinned rather than decaying with the calendar.
const FIXTURE_NOW = Date.parse('2026-09-26T12:00:00Z');
const DATA_REF = 'origin/repo-butler-data';

// Answers the git argv mcp.js issues, from the fixture, with runGit's contract:
// trimmed stdout, or null on any failure. `refs` lists which data-branch refs
// exist. An argv it does not recognise throws, so a new git call cannot slip
// past the fake unnoticed.
function fixtureGit({ refs = [DATA_REF], files = FIXTURE.files, remoteUrl = 'git@github.com:example-owner/repo-butler.git' } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === 'remote' && args[1] === 'get-url') return remoteUrl;
    if (cmd === 'log') return refs.includes(args.at(-1)) ? FIXTURE.committed_at : null;
    if (cmd === 'show') {
      const spec = args[1];
      const ref = spec.slice(0, spec.indexOf(':'));
      const content = files[spec.slice(spec.indexOf(':') + 1)];
      if (!refs.includes(ref) || content === undefined) return null;
      return JSON.stringify(content, null, 2);
    }
    if (cmd === 'ls-tree' && args[1] === '--name-only') {
      if (!refs.includes(args[2])) return null;
      const dir = args[3];
      return Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/')).join('\n');
    }
    throw new Error(`fixtureGit: unexpected git ${args.join(' ')}`);
  };
  git.calls = calls;
  return git;
}

// Answers `gh pr list --repo owner/<repo>` from `prsByRepo`; a repo mapped to
// an Error throws it, as execFileSync would.
function fixtureGh(prsByRepo = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') {
      const repo = args[args.indexOf('--repo') + 1].split('/')[1];
      const answer = prsByRepo[repo] ?? [];
      if (answer instanceof Error) throw answer;
      return JSON.stringify(answer);
    }
    if (args[0] === 'workflow' && args[1] === 'run') return '';
    throw new Error(`fixtureGh: unexpected gh ${args.join(' ')}`);
  };
  gh.calls = calls;
  return gh;
}

const mcp = await import('./mcp.js');
mcp.setIo({ git: fixtureGit(), gh: fixtureGh(), commitsBehindMain: () => 0 });

// Swap the I/O for one test and put the file-wide fixture back afterwards.
async function withIo(overrides, fn) {
  const restore = mcp.setIo(overrides);
  try { return await fn(); } finally { restore(); }
}

// Capture stdout writes to verify JSON-RPC responses.
let responses = [];
const originalWrite = process.stdout.write;

function captureResponses() {
  responses = [];
  process.stdout.write = (data) => {
    try { responses.push(JSON.parse(data.toString().trim())); } catch { /* non-JSON output */ }
    return true;
  };
}

function restoreStdout() {
  process.stdout.write = originalWrite;
}

const { handleMessage, TOOLS, RESOURCES, callTool } = mcp;

describe('MCP server', async () => {
  const mod = mcp;
  const unwrapWeeklyRepos = mod.unwrapWeeklyRepos;
  const computeAutofixNotDrivenTrend = mod.computeAutofixNotDrivenTrend;
  const computeOpenVulnerabilitiesTrend = mod.computeOpenVulnerabilitiesTrend;
  const computeTierRegressionsTrend = mod.computeTierRegressionsTrend;
  const WEEKLY_FILE_PATTERN = mod.WEEKLY_FILE_PATTERN;

  before(() => mock.timers.enable({ apis: ['Date'], now: FIXTURE_NOW }));
  after(() => mock.timers.reset());
  beforeEach(() => captureResponses());

  describe('unwrapWeeklyRepos', () => {
    it('unwraps the v1 envelope to a flat repo map', () => {
      const flat = unwrapWeeklyRepos({ schema_version: 'v1', repos: { a: { id: 1 }, b: { id: 2 } } });
      assert.deepEqual(Object.keys(flat), ['a', 'b']);
      assert.equal(flat.a.id, 1);
    });

    it('passes a legacy flat map through unchanged', () => {
      const flat = unwrapWeeklyRepos({ a: { id: 1 }, b: { id: 2 } });
      assert.deepEqual(Object.keys(flat), ['a', 'b']);
    });

    it('does not unwrap a legacy flat map containing a repo named "repos"', () => {
      const flat = unwrapWeeklyRepos({ repos: { id: 1 }, b: { id: 2 } });
      assert.deepEqual(Object.keys(flat), ['repos', 'b']);
    });

    it('returns an empty object for null/undefined', () => {
      assert.deepEqual(unwrapWeeklyRepos(null), {});
      assert.deepEqual(unwrapWeeklyRepos(undefined), {});
    });
  });

  describe('computeAutofixNotDrivenTrend', () => {
    it('returns null when there is no prior weekly snapshot', () => {
      assert.equal(computeAutofixNotDrivenTrend(2, null), null);
      assert.equal(computeAutofixNotDrivenTrend(2, undefined), null);
    });

    it('returns null when the prior snapshot has no findings array', () => {
      assert.equal(computeAutofixNotDrivenTrend(2, { week: '2026-W29' }), null);
    });

    it('reports "improving" when the current count is lower than the prior one', () => {
      const prior = {
        findings: [
          { type: 'open-vulnerability', repo: 'a', autofixEnabled: false },
          { type: 'open-vulnerability', repo: 'b', autofixEnabled: false },
        ],
      };
      const trend = computeAutofixNotDrivenTrend(1, prior);
      assert.deepEqual(trend, { current: 1, previous: 2, delta: -1, direction: 'improving' });
    });

    it('reports "worsening" when the current count is higher than the prior one', () => {
      const prior = { findings: [{ type: 'open-vulnerability', repo: 'a', autofixEnabled: false }] };
      const trend = computeAutofixNotDrivenTrend(3, prior);
      assert.deepEqual(trend, { current: 3, previous: 1, delta: 2, direction: 'worsening' });
    });

    it('reports "unchanged" when the counts match, including 0 vs 0', () => {
      assert.deepEqual(
        computeAutofixNotDrivenTrend(0, { findings: [] }),
        { current: 0, previous: 0, delta: 0, direction: 'unchanged' }
      );
    });

    it('only counts dependabot-sourced not-driven findings in the prior snapshot', () => {
      const prior = {
        findings: [
          { type: 'open-vulnerability', repo: 'a', autofixEnabled: false },
          { type: 'open-vulnerability', repo: 'b', autofixEnabled: true },
          { type: 'open-vulnerability', repo: 'c', autofixEnabled: null },
          { type: 'standards-gap', tool: 'license' },
        ],
      };
      const trend = computeAutofixNotDrivenTrend(1, prior);
      assert.equal(trend.previous, 1);
      assert.equal(trend.direction, 'unchanged');
    });
  });

  describe('computeOpenVulnerabilitiesTrend', () => {
    it('returns null when there is no prior weekly snapshot', () => {
      assert.equal(computeOpenVulnerabilitiesTrend(3, null), null);
    });

    it('counts only open-vulnerability findings, regardless of source or autofix state', () => {
      const prior = {
        findings: [
          { type: 'open-vulnerability', repo: 'a', autofixEnabled: false },
          { type: 'open-vulnerability', repo: 'b', autofixEnabled: true },
          { type: 'open-vulnerability', repo: 'c' },
          { type: 'standards-gap', tool: 'license' },
          { type: 'tier-uplift', repo: 'd' },
        ],
      };
      const trend = computeOpenVulnerabilitiesTrend(1, prior);
      assert.deepEqual(trend, { current: 1, previous: 3, delta: -2, direction: 'improving' });
    });

    it('reports "worsening" when the open-vulnerability count rises', () => {
      const prior = { findings: [{ type: 'open-vulnerability', repo: 'a' }] };
      const trend = computeOpenVulnerabilitiesTrend(4, prior);
      assert.deepEqual(trend, { current: 4, previous: 1, delta: 3, direction: 'worsening' });
    });
  });

  describe('computeTierRegressionsTrend', () => {
    it('returns null when there is no prior weekly snapshot', () => {
      assert.equal(computeTierRegressionsTrend(2, null), null);
    });

    it('counts only tier-regression findings', () => {
      const prior = {
        findings: [
          { type: 'tier-regression', repo: 'a', previousTier: 'gold', currentTier: 'silver' },
          { type: 'tier-regression', repo: 'b', previousTier: 'silver', currentTier: 'bronze' },
          { type: 'tier-uplift', repo: 'c' },
          { type: 'standards-gap', tool: 'license' },
        ],
      };
      const trend = computeTierRegressionsTrend(1, prior);
      assert.deepEqual(trend, { current: 1, previous: 2, delta: -1, direction: 'improving' });
    });

    it('reports "worsening" when the tier-regression count rises', () => {
      const prior = { findings: [{ type: 'tier-regression', repo: 'a' }] };
      const trend = computeTierRegressionsTrend(3, prior);
      assert.deepEqual(trend, { current: 3, previous: 1, delta: 2, direction: 'worsening' });
    });

    it('reports "unchanged" when the counts match, including 0 vs 0', () => {
      assert.deepEqual(
        computeTierRegressionsTrend(0, { findings: [] }),
        { current: 0, previous: 0, delta: 0, direction: 'unchanged' }
      );
    });
  });

  describe('WEEKLY_FILE_PATTERN', () => {
    it('matches ISO-week filenames store.js writes for both weekly streams', () => {
      assert.ok(WEEKLY_FILE_PATTERN.test('2026-W18.json'));
      assert.ok(WEEKLY_FILE_PATTERN.test('2025-W01.json'));
    });

    it('rejects non-week JSON files so a stray file cannot be read as a weekly snapshot', () => {
      assert.equal(WEEKLY_FILE_PATTERN.test('governance.json'), false);
      assert.equal(WEEKLY_FILE_PATTERN.test('init.json'), false);
      assert.equal(WEEKLY_FILE_PATTERN.test('2026-W18.json.bak'), false);
      assert.equal(WEEKLY_FILE_PATTERN.test('notes/2026-W18.json'), false);
    });
  });

  describe('protocol', () => {
    it('responds to initialize with server info and capabilities', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.1' } },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.equal(r.jsonrpc, '2.0');
      assert.equal(r.id, 1);
      assert.equal(r.result.serverInfo.name, 'repo-butler');
      assert.equal(r.result.protocolVersion, '2024-11-05');
      assert.ok(r.result.capabilities.resources);
      assert.ok(r.result.capabilities.tools);
    });

    it('responds to ping', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].id, 2);
      assert.deepEqual(responses[0].result, {});
    });

    it('ignores notifications (no id)', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      restoreStdout();

      assert.equal(responses.length, 0, 'notifications must not receive a response');
    });

    it('returns error for unknown method', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'unknown/method' }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, -32601);
    });

    it('returns parse error for invalid JSON', () => {
      handleMessage('not valid json');
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, -32700);
    });
  });

  describe('resources', () => {
    it('lists available resources', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'resources/list' }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const resources = responses[0].result.resources;
      assert.ok(Array.isArray(resources));
      assert.ok(resources.length >= 3);
      assert.ok(resources.some(r => r.uri === 'repo-butler://snapshot/latest'));
      assert.ok(resources.some(r => r.uri === 'repo-butler://portfolio/health'));
      assert.ok(resources.some(r => r.uri === 'repo-butler://portfolio/campaigns'));
    });

    it('returns error for unknown resource URI', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 11, method: 'resources/read',
        params: { uri: 'repo-butler://unknown' },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.ok(responses[0].error);
    });

    it('returns error when uri is missing', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 12, method: 'resources/read', params: {},
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, -32602);
    });
  });

  describe('tools', () => {
    it('lists available tools with input schemas', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list' }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const tools = responses[0].result.tools;
      assert.ok(Array.isArray(tools));
      assert.equal(tools.length, 12);

      const names = tools.map(t => t.name);
      assert.ok(names.includes('get_health_tier'));
      assert.ok(names.includes('get_campaign_status'));
      assert.ok(names.includes('query_portfolio'));
      assert.ok(names.includes('get_snapshot_diff'));
      assert.ok(names.includes('get_governance_findings'));
      assert.ok(names.includes('trigger_refresh'));
      assert.ok(names.includes('get_monitor_events'));
      assert.ok(names.includes('get_watchlist'));
      assert.ok(names.includes('get_council_personas'));
      assert.ok(names.includes('get_weekly_trend'));
      assert.ok(names.includes('get_open_governance_prs'));
      assert.ok(names.includes('list_stale_dependabot_prs'));

      // Every tool must have an inputSchema.
      for (const tool of tools) {
        assert.ok(tool.inputSchema, `${tool.name} should have inputSchema`);
        assert.equal(tool.inputSchema.type, 'object');
      }
    });

    it('returns error for unknown tool', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 21, method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.ok(responses[0].error);
    });

    it('returns error when tool name is missing', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 22, method: 'tools/call', params: {},
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, -32602);
    });

    // Through the JSON-RPC layer once, so the tools/call envelope is covered;
    // the rest call callTool directly.
    it('get_health_tier returns the tier, checks and next-tier gap for a known repo', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 23, method: 'tools/call',
        params: { name: 'get_health_tier', arguments: { repo: 'beta' } },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const data = JSON.parse(responses[0].result.content[0].text);
      assert.equal(data.repo, 'beta');
      assert.equal(data.tier, 'silver');
      assert.equal(data.week, '2026-W39', 'reads the latest real week, not the stray notes.json');
      assert.equal(data.checks.length, 11);
      assert.equal(data.next_tier, 'gold');
      assert.deepEqual(data.needed_for_next, [
        'Release in the last 90 days',
        'Community health above 80%',
        'Zero critical/high security findings',
      ]);
    });

    it('get_health_tier names the available repos when the repo is unknown', () => {
      restoreStdout();
      const result = callTool('get_health_tier', { repo: 'nope' });
      assert.equal(result.error, "Repo 'nope' not found. Available: alpha, beta, gamma-test-repo");
    });

    it('get_campaign_status excludes test repos and scores each campaign', () => {
      restoreStdout();
      const result = callTool('get_campaign_status', {});
      assert.equal(result.week, '2026-W39');
      const byName = Object.fromEntries(result.campaigns.map(c => [c.name, c]));
      assert.deepEqual(Object.keys(byName), ['Community Health', 'Vulnerability Free', 'CI Reliability', 'License Compliance', 'Issue Templates']);
      // gamma-test-repo matches REPO_EXCLUSION_PATTERNS, so the pool is alpha + beta.
      assert.deepEqual(byName['Community Health'], {
        name: 'Community Health', description: byName['Community Health'].description,
        total: 2, compliant: 1, percentage: 50, non_compliant: ['beta'],
      });
      assert.deepEqual(byName['Vulnerability Free'].non_compliant, ['beta']);
      assert.equal(byName['CI Reliability'].percentage, 50);
      assert.equal(byName['License Compliance'].percentage, 100);
      assert.deepEqual(byName['Issue Templates'].non_compliant, ['beta']);
    });

    it('query_portfolio returns every repo with its tier, and filters by tier', () => {
      restoreStdout();
      const all = callTool('query_portfolio', {});
      assert.equal(all.week, '2026-W39');
      assert.equal(all.count, 3);
      // The v1 envelope keys must not leak through as pseudo-repos.
      assert.deepEqual(all.repos.map(r => [r.name, r.tier]), [['alpha', 'gold'], ['beta', 'silver'], ['gamma-test-repo', 'bronze']]);

      const silver = callTool('query_portfolio', { tier: 'silver' });
      assert.equal(silver.count, 1);
      assert.equal(silver.repos[0].name, 'beta');
    });

    it('get_snapshot_diff compares the latest snapshot against the previous one', () => {
      restoreStdout();
      const result = callTool('get_snapshot_diff', {});
      assert.equal(result.current_timestamp, '2026-09-26T06:44:53.206Z');
      assert.equal(result.previous_timestamp, '2026-09-25T20:40:11.000Z');
      assert.deepEqual(result.changes.open_issues, { was: 5, now: 3, delta: -2 });
      assert.deepEqual(result.changes.merged_prs, { was: 7, now: 10, delta: 3 });
      assert.deepEqual(result.changes.releases, { was: 2, now: 2, delta: 0 });
      assert.deepEqual(result.changes.community_health, { was: 90, now: 100 });
    });

    it('get_snapshot_diff reports a first run when there is no previous snapshot', async () => {
      restoreStdout();
      const files = { ...FIXTURE.files };
      delete files['snapshots/previous.json'];
      const result = await withIo({ git: fixtureGit({ files }) }, () => callTool('get_snapshot_diff', {}));
      assert.equal(result.message, 'No previous snapshot to compare against (first run?)');
    });

    it('get_governance_findings summarises the findings with week-over-week trends', () => {
      restoreStdout();
      const { findings, summary } = callTool('get_governance_findings', {});
      assert.equal(findings.length, 7);
      assert.equal(summary.total, 7);
      assert.equal(summary.gaps, 1);
      assert.equal(summary.tierRegressions, 1, 'summary counts tier-regression findings (G7)');
      assert.equal(summary.staleButlerPRs, 0);
      assert.equal(summary.stalledAlerts, 1, 'summary counts stalled-alert findings (G13)');
      assert.equal(summary.openVulnerabilities, 2);
      assert.equal(summary.autofixInFlight, 1);
      assert.equal(summary.autofixNotDriven, 1);
      assert.deepEqual(summary.byExecutor, { template: 1, settings: 0, agent: 0, manual: 5 });
      // The prior week is the second-newest real weekly file (W38), never the
      // stray init.json, which would otherwise sort last and shift it to W39.
      assert.deepEqual(summary.autofixNotDrivenTrend,
        { current: 1, previous: 2, delta: -1, direction: 'improving', previousWeek: '2026-W38' });
      assert.deepEqual(summary.openVulnerabilitiesTrend,
        { current: 2, previous: 2, delta: 0, direction: 'unchanged', previousWeek: '2026-W38' });
      assert.deepEqual(summary.tierRegressionsTrend,
        { current: 1, previous: 0, delta: 1, direction: 'worsening', previousWeek: '2026-W38' });
    });

    it('get_governance_findings reports no trend when there is no prior weekly file', async () => {
      restoreStdout();
      const files = { ...FIXTURE.files };
      delete files['snapshots/governance-weekly/2026-W38.json'];
      const { summary } = await withIo({ git: fixtureGit({ files }) }, () => callTool('get_governance_findings', {}));
      assert.equal(summary.autofixNotDrivenTrend, null);
      assert.equal(summary.openVulnerabilitiesTrend, null);
      assert.equal(summary.tierRegressionsTrend, null);
    });

    it('get_monitor_events projects the monitor cursor', () => {
      restoreStdout();
      const result = callTool('get_monitor_events', { min_severity: 'high' });
      assert.equal(result.last_run, '2026-09-26T06:44:53.206Z');
      assert.equal(result.total_events, 3);
      assert.equal(result.known_issues, 2);
      assert.equal(result.known_prs, 1);
      assert.equal(result.known_security_alerts, 3);
      assert.equal(result.filter, 'high');
    });

    it('get_watchlist projects each item including its target and hold-back reason', () => {
      restoreStdout();
      const result = callTool('get_watchlist', {});
      assert.equal(result.total, 1);
      assert.deepEqual(result.items[0], {
        title: 'Resolve stale Dependabot PRs', type: 'proposal', severity: 'medium',
        targetRepo: 'beta', held_back_reason: 'cross-repo bar not cleared',
        added_at: '2026-09-07T11:47:12.269Z', review_count: 0,
        council_summary: 'Watch until the statistic holds for a second week.',
      });
    });

    it('get_weekly_trend aggregates every real week, oldest first', () => {
      restoreStdout();
      const result = callTool('get_weekly_trend', {});
      assert.equal(result.weeks, 3);
      assert.deepEqual(result.series.map(r => r.week), ['2026-W37', '2026-W38', '2026-W39']);
      const w39 = result.series[2];
      assert.equal(w39.repos, 3);
      assert.equal(w39.total_open_issues, 8);
      assert.deepEqual(w39.tier_distribution, { gold: 1, silver: 1, bronze: 1, none: 0 });
      // W37 predates `computed`, so its only repo is recomputed: a May release
      // is past the 90-day window today, hence silver.
      assert.deepEqual(result.series[0].tier_distribution, { gold: 0, silver: 1, bronze: 0, none: 0 });
    });

    it('get_weekly_trend follows a renamed repo back through history by id', () => {
      restoreStdout();
      const result = callTool('get_weekly_trend', { repo: 'alpha', weeks: 4 });
      assert.equal(result.repo, 'alpha');
      assert.deepEqual(result.series, [
        { week: '2026-W37', open_issues: 4, ci_pass_rate: 0.8, community_health: 100, tier: 'silver' },
        // Stored gold is read, not recomputed from the same May release.
        { week: '2026-W38', open_issues: 2, ci_pass_rate: 0.9, community_health: 100, tier: 'gold' },
        { week: '2026-W39', open_issues: 1, ci_pass_rate: 0.95, community_health: 100, tier: 'gold' },
      ]);
    });

    it('get_weekly_trend rejects invalid repo names', () => {
      restoreStdout();
      const result = callTool('get_weekly_trend', { repo: '../etc/passwd' });
      assert.match(result.error, /Invalid repo name/);
    });

    it('get_weekly_trend clamps weeks to the 1–12 range', () => {
      restoreStdout();
      assert.equal(callTool('get_weekly_trend', { weeks: 9999 }).weeks, 3, '9999 clamps to 12, which is every week here');
      assert.deepEqual(callTool('get_weekly_trend', { weeks: 0 }).series.map(r => r.week), ['2026-W39'], '0 clamps to 1');
    });

    it('get_open_governance_prs lists only repo-butler/apply-* PRs across the portfolio', async () => {
      restoreStdout();
      const gh = fixtureGh({
        alpha: [
          { number: 12, url: 'https://github.com/example-owner/alpha/pull/12', headRefName: 'repo-butler/apply-security-md', createdAt: '2026-09-20T00:00:00Z' },
          { number: 13, url: 'https://github.com/example-owner/alpha/pull/13', headRefName: 'dependabot/npm/x', createdAt: '2026-09-21T00:00:00Z' },
        ],
      });
      const result = await withIo({ gh }, () => callTool('get_open_governance_prs', {}));
      assert.deepEqual(gh.calls.map(a => a[a.indexOf('--repo') + 1]),
        ['example-owner/alpha', 'example-owner/beta', 'example-owner/gamma-test-repo'],
        'owner comes from the origin remote, repos from the latest weekly snapshot');
      assert.equal(result.owner, 'example-owner');
      assert.equal(result.count, 1);
      assert.deepEqual(result.prs, [{
        repo: 'alpha', pr_number: 12, pr_url: 'https://github.com/example-owner/alpha/pull/12',
        tool: 'security-md', opened_at: '2026-09-20T00:00:00Z',
      }]);
      assert.equal(result.warnings, undefined, 'a clean run carries no warnings');
    });

    // "No PRs" must stay distinguishable from "could not look".
    it('get_open_governance_prs warns once and stops when gh is not installed', async () => {
      restoreStdout();
      const missing = Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' });
      const gh = fixtureGh({ alpha: missing, beta: missing });
      const result = await withIo({ gh }, () => callTool('get_open_governance_prs', {}));
      assert.equal(gh.calls.length, 1, 'no point retrying every repo without gh');
      assert.deepEqual(result.warnings, [{ kind: 'gh_unavailable', message: 'gh CLI not found in PATH' }]);
      assert.equal(result.count, 0);
    });

    it('get_open_governance_prs reports a per-repo failure and carries on', async () => {
      restoreStdout();
      const gh = fixtureGh({ beta: new Error('HTTP 404: Not Found\nmore detail') });
      const result = await withIo({ gh }, () => callTool('get_open_governance_prs', {}));
      assert.equal(gh.calls.length, 3);
      assert.deepEqual(result.warnings, [{ kind: 'repo_query_failed', repo: 'beta', message: 'HTTP 404: Not Found' }]);
    });

    it('get_open_governance_prs errors when the owner cannot be read from the remote', async () => {
      restoreStdout();
      const result = await withIo({ git: fixtureGit({ remoteUrl: null }) }, () => callTool('get_open_governance_prs', {}));
      assert.equal(result.error, 'Could not determine repo owner from git remote.');
    });

    it('list_stale_dependabot_prs projects valid stale PRs, oldest first', () => {
      restoreStdout();
      const result = callTool('list_stale_dependabot_prs', {});
      assert.equal(result.min_age_days, 30);
      // PR 9 is too young; the traversal-shaped number and the invalid repo are dropped.
      assert.deepEqual(result.prs, [
        { repo: 'alpha', pr_number: 8, pr_url: 'https://github.com/example-owner/alpha/pull/8', age_days: 90, title: 'bump b' },
        { repo: 'alpha', pr_number: 7, pr_url: 'https://github.com/example-owner/alpha/pull/7', age_days: 45, title: 'bump a' },
      ]);
    });

    it('list_stale_dependabot_prs honours a custom min_age_days', () => {
      restoreStdout();
      const result = callTool('list_stale_dependabot_prs', { min_age_days: 60 });
      assert.equal(result.min_age_days, 60);
      assert.deepEqual(result.prs.map(p => p.pr_number), [8]);
    });

    it('trigger_refresh dispatches the workflow on the remote repo through gh', async () => {
      restoreStdout();
      const gh = fixtureGh();
      const result = await withIo({ gh }, () => callTool('trigger_refresh', { phase: 'report' }));
      assert.equal(result.status, 'triggered');
      assert.deepEqual(gh.calls, [['workflow', 'run', 'Repo Butler', '--repo', 'example-owner/repo-butler', '--ref', 'main',
        '-f', 'phase=report', '-f', 'dry-run=false', '-f', 'force-report=true']]);
    });
  });

  describe('dispatch', () => {
    it('every TOOLS entry has a handler function', () => {
      restoreStdout();
      assert.ok(TOOLS.length > 0);
      for (const tool of TOOLS) {
        assert.equal(typeof tool.handler, 'function', `${tool.name} must expose a handler function`);
      }
    });

    it('callTool returns null for an unknown tool name', () => {
      restoreStdout();
      assert.equal(callTool('unknown_tool', {}), null);
    });

    it('callTool dispatches to the matching handler with the right args', () => {
      restoreStdout();
      const result = callTool('get_council_personas', {});
      assert.ok(result, 'expected a result from get_council_personas');
      assert.ok(Array.isArray(result.personas));
      assert.ok(result.personas.some(p => p.name === 'Security'));
    });

    it('get_council_personas matches the PERSONAS source from council.js', async () => {
      restoreStdout();
      const { PERSONAS } = await import('./council.js');
      const result = callTool('get_council_personas', {});
      const expected = Object.values(PERSONAS).map(({ name, role, focus }) => ({ name, role, focus }));
      assert.deepEqual(result.personas, expected,
        'persona projection must match PERSONAS exactly and not leak the internal `system` field');
    });
  });
});

// The MCP server recomputes health tiers from the weekly snapshot rather than
// reading a stored tier, so it must apply the same `release_exempt` list the
// dashboard, store.js and the governance detectors apply. It previously did
// not: mcp.js never loaded roadmap.yml, so an exempt repo whose release aged
// past 90 days was reported Silver while the rest of the pipeline called it
// Gold — a phantom tier regression that also skewed the weekly trend's
// tier_distribution.
describe('MCP release-exempt handling', () => {
  const mcpSource = readFileSync(new URL('./mcp.js', import.meta.url), 'utf8');

  // The floor exists so this cannot pass vacuously by matching nothing — not as
  // a target. It dropped from 5 to 4 in G8, when projectWeekRow and the
  // portfolio aggregate loop were consolidated into the single weekTier helper.
  // If it drops again, check the call sites really did merge rather than lose
  // their options argument.
  it('passes tier options to every computeHealthTier call site', () => {
    const calls = [...mcpSource.matchAll(/computeHealthTier\(([^)]*)/g)].map(m => m[1]);
    assert.ok(calls.length >= 4, `expected the known tier call sites, found ${calls.length}`);
    for (const args of calls) {
      assert.match(args, /,\s*tierOptions\(/,
        `computeHealthTier called without tierOptions(...): "computeHealthTier(${args})"`);
    }
  });

  it('resolves the release exemption from the real roadmap.yml', async () => {
    const { loadConfigSync } = await import('./config.js');
    const { isReleaseExempt } = await import('./report-shared.js');
    // fileURLToPath, not .pathname: the latter percent-encodes (a checkout
    // under a directory with a space yields `%20`, which existsSync misses)
    // and on Windows leaves a leading slash before the drive letter. Either
    // way loadConfigSync would silently return DEFAULTS and this test would
    // fail on the assertion below rather than on the real cause.
    const config = loadConfigSync(fileURLToPath(new URL('../.github/roadmap.yml', import.meta.url)));

    assert.ok(config.release_exempt, 'roadmap.yml must declare release_exempt for this wiring to matter');
    const exempt = config.release_exempt.split(',').map(s => s.trim()).filter(Boolean);
    for (const repo of exempt) {
      assert.equal(isReleaseExempt(repo, config), true, `${repo} should read as release-exempt`);
    }
    assert.equal(isReleaseExempt('repo-butler', config), false);
  });

  it('exempts a stale-release repo from the gold release check', async () => {
    const { computeHealthTier, isReleaseExempt } = await import('./report-shared.js');
    const config = { release_exempt: 'quiet-repo' };
    // Everything gold-worthy except a release well past the 90-day window.
    const data = {
      ci: 3, license: 'MIT', open_bugs: 0, communityHealth: 100,
      vulns: { max_severity: null }, codeScanning: { max_severity: null },
      secretScanning: { count: 0 },
      released_at: '2024-01-01T00:00:00Z',
      pushed_at: new Date().toISOString(),
    };

    const exempt = computeHealthTier(data, { releaseExempt: isReleaseExempt('quiet-repo', config) });
    const notExempt = computeHealthTier(data, { releaseExempt: isReleaseExempt('other-repo', config) });

    assert.equal(exempt.tier, 'gold', 'an exempt repo keeps gold despite a stale release');
    assert.equal(notExempt.tier, 'silver', 'a non-exempt repo drops to silver — the bug this guards');
  });
});

// G8 — the server answers from a local checkout and never fetches, so both the
// data it reads and the code doing the reading can be arbitrarily stale without
// the answer looking any different. Two failures came from exactly that: a
// briefing claiming 12 Gold against a true 7, and a weekly trend whose
// historical Gold counts decayed as the snapshots aged.
describe('MCP staleness guard', async () => {
  const { computeStaleness, TOOLS, callTool } = await import('./mcp.js');
  const HOUR = 3600000;
  const NOW = Date.parse('2026-08-01T12:00:00Z');
  const iso = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

  describe('computeStaleness', () => {
    it('warns about nothing when the data is recent and the checkout is current', () => {
      const s = computeStaleness(iso(3), 0, NOW);
      assert.deepEqual(s.warnings, [], 'a healthy setup must produce no warning at all');
      assert.equal(s.data_age_hours, 3);
      assert.equal(s.commits_behind_main, 0);
    });

    it('warns once the data crosses the 48h threshold', () => {
      assert.deepEqual(computeStaleness(iso(47), 0, NOW).warnings, [], '47h is still inside the window');
      // Pin the boundary itself, not just a value either side of it: with 47
      // and 60 alone, flipping `>=` to `>` survives untouched.
      assert.equal(computeStaleness(iso(48), 0, NOW).warnings.length, 1,
        'exactly 48h must warn — the threshold is inclusive');
      const stale = computeStaleness(iso(60), 0, NOW);
      assert.equal(stale.warnings.length, 1);
      assert.match(stale.warnings[0], /60h old/);
      assert.equal(stale.data_age_hours, 60);
    });

    it('warns when the checkout is behind origin/main, naming the distance', () => {
      const s = computeStaleness(iso(1), 106, NOW);
      assert.equal(s.warnings.length, 1);
      assert.match(s.warnings[0], /106 commit\(s\) behind origin\/main/);
    });

    it('reports both problems at once rather than stopping at the first', () => {
      const s = computeStaleness(iso(120), 12, NOW);
      assert.equal(s.warnings.length, 2, 'stale data and stale code are independent failures');
    });

    // "We could not check" and "we checked and it is fine" must not look the
    // same to a caller — an unreadable probe is itself a reason to distrust.
    it('warns rather than staying silent when a probe could not be read', () => {
      const s = computeStaleness(null, null, NOW);
      assert.equal(s.behind_main_state, 'unknown');
      assert.equal(s.warnings.length, 2);
      assert.equal(s.data_age_hours, null);
      assert.equal(s.data_committed_at, null);
      assert.ok(s.warnings.every(w => /Could not/.test(w)));
    });

    it('treats an unparseable timestamp as unreadable, not as age zero', () => {
      const s = computeStaleness('not-a-date', 0, NOW);
      assert.equal(s.data_age_hours, null);
      assert.equal(s.data_committed_at, null);
      assert.match(s.warnings[0], /Could not read the age/);
    });

    it('never reports negative age when the data commit is clock-skewed ahead', () => {
      assert.equal(computeStaleness(iso(-5), 0, NOW).data_age_hours, 0);
    });

    // Elapsed hours, floored — not rounded to the nearest hour. Rounding fires
    // the warning up to 30 minutes early, so the age reported and the age
    // compared against the threshold would disagree.
    it('floors the age rather than rounding it', () => {
      const halfPast = new Date(NOW - 47.5 * HOUR).toISOString();
      const s = computeStaleness(halfPast, 0, NOW);
      assert.equal(s.data_age_hours, 47, '47.5h is 47 elapsed whole hours, not 48');
      assert.deepEqual(s.warnings, [], 'and must not trip the 48h threshold early');
      assert.equal(computeStaleness(new Date(NOW - 3.9 * HOUR).toISOString(), 0, NOW).data_age_hours, 3);
    });
  });

  describe('envelope attachment', () => {
    // Attached in callTool rather than per-handler so a new tool cannot ship
    // without one. This asserts the exact opt-out set, so widening it is a
    // deliberate edit to this list and not a silent omission.
    it('attaches staleness to every tool that reads the data branch', () => {
      const optedOut = TOOLS.filter(t => t.readsDataBranch === false).map(t => t.name).sort();
      assert.deepEqual(optedOut, ['get_council_personas', 'trigger_refresh'],
        'only tools reading nothing from the data branch may opt out');
      assert.ok(TOOLS.length - optedOut.length >= 10, 'the rest must carry the envelope');
    });

    // The flag is an internal routing detail. TOOLS is the source for the
    // tools/list JSON-RPC response, so anything on it reaches clients.
    it('does not leak the readsDataBranch flag into the tools/list response', () => {
      restoreStdout();
      captureResponses();
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }));
      restoreStdout();
      const listed = responses.find(r => r.id === 99)?.result?.tools;
      assert.ok(Array.isArray(listed) && listed.length > 0, 'tools/list must return tools');
      for (const t of listed) {
        assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name'],
          `tool "${t.name}" exposes internal fields: ${Object.keys(t).join(', ')}`);
      }
    });

    it('does not attach staleness to a tool that reads nothing from the branch', () => {
      const result = callTool('get_council_personas', {});
      assert.ok(result.personas, 'sanity: the handler still ran');
      assert.equal(result.staleness, undefined);
    });

    it('attaches the envelope read from the data branch to a data-branch tool', () => {
      mock.timers.enable({ apis: ['Date'], now: FIXTURE_NOW });
      try {
        const result = callTool('get_health_tier', { repo: 'alpha' });
        assert.equal(result.tier, 'gold');
        assert.deepEqual(result.staleness, {
          data_committed_at: FIXTURE.committed_at,
          data_age_hours: 5,
          commits_behind_main: 0,
          behind_main_state: 'measured',
          warnings: [],
        });
      } finally {
        mock.timers.reset();
      }
    });

    // An error is exactly when the caller most wants to know the checkout
    // might be the cause, so the envelope rides along with it.
    it('annotates an error result too', () => {
      const result = callTool('get_health_tier', { repo: 'definitely-not-a-repo' });
      assert.match(result.error, /not found/, 'sanity: this repo does not exist');
      assert.ok(result.staleness, 'an error still needs its staleness context');
    });
  });

  // The data branch is read from origin/repo-butler-data first and the bare
  // local ref second, and a checkout with neither must say it could not check
  // rather than look like a healthy empty answer.
  describe('data-branch reads', () => {
    it('falls back to the local ref when origin/repo-butler-data is absent', async () => {
      const git = fixtureGit({ refs: ['repo-butler-data'] });
      const result = await withIo({ git }, () => callTool('get_health_tier', { repo: 'alpha' }));
      assert.equal(result.week, '2026-W39');
      assert.equal(result.staleness.data_committed_at, FIXTURE.committed_at);
      assert.ok(git.calls.some(a => a[0] === 'show' && a[1].startsWith('origin/repo-butler-data:')),
        'sanity: the origin ref was tried first');
    });

    it('says it could not check when there is no data branch at all', async () => {
      const result = await withIo({ git: fixtureGit({ refs: [] }), commitsBehindMain: () => null },
        () => callTool('get_health_tier', { repo: 'alpha' }));
      assert.equal(result.error, 'No portfolio data available');
      assert.equal(result.staleness.data_age_hours, null);
      assert.equal(result.staleness.behind_main_state, 'unknown');
      assert.equal(result.staleness.warnings.length, 2);
      assert.ok(result.staleness.warnings.every(w => /Could not/.test(w)));
    });

    it('surfaces an unfetched checkout from the behind-main probe', async () => {
      const result = await withIo({ commitsBehindMain: () => 'unfetched' },
        () => callTool('get_watchlist', {}));
      assert.equal(result.staleness.behind_main_state, 'unfetched');
      assert.equal(result.staleness.commits_behind_main, null);
    });

    it('does not retry an empty origin listing on the local ref', async () => {
      const files = Object.fromEntries(Object.entries(FIXTURE.files).filter(([p]) => !p.includes('-weekly/')));
      const git = fixtureGit({ refs: [DATA_REF, 'repo-butler-data'], files });
      const result = await withIo({ git }, () => callTool('get_weekly_trend', {}));
      assert.equal(result.error, 'No portfolio-weekly snapshots available.');
      assert.equal(git.calls.filter(a => a[0] === 'ls-tree').length, 1,
        'an origin ref that answered with nothing is an answer, not a failure');
    });
  });
});

// G8, second half — a weekly snapshot is a record, not an input to re-derive
// from. computeHealthTier measures release and push age against Date.now(), so
// recomputing an archived week re-scores it with today's clock and historical
// Gold counts decay purely as the snapshots age.
describe('MCP historical tiers are read, not recomputed', async () => {
  const { weekTier } = await import('./mcp.js');

  // Gold-worthy on every check except a release far outside the 90-day window,
  // so a recompute today necessarily returns silver. The stored value is what
  // the week actually was.
  const archived = (storedTier) => ({
    ci: 3, license: 'MIT', open_bugs: 0, communityHealth: 100,
    vulns: { max_severity: null }, codeScanning: { max_severity: null },
    secretScanning: { count: 0 },
    released_at: '2024-01-01T00:00:00Z',
    pushed_at: new Date().toISOString(),
    computed: { tier: storedTier },
  });

  it('returns the stored tier even when a recompute today would disagree', () => {
    assert.equal(weekTier(archived('gold'), 'some-repo'), 'gold',
      'the week recorded gold; today\'s clock must not retroactively demote it');
  });

  it('does not invent a tier the snapshot never recorded', () => {
    assert.equal(weekTier(archived('bronze'), 'some-repo'), 'bronze');
  });

  it('falls back to recomputing for snapshots written before computed existed', () => {
    const legacy = { ...archived('gold') };
    delete legacy.computed;
    assert.equal(weekTier(legacy, 'some-repo'), 'silver',
      'with nothing stored there is no record to read, so the recompute stands');
  });

  it('falls back when computed exists but carries no tier', () => {
    const partial = { ...archived('gold'), computed: { checks: [] } };
    assert.equal(weekTier(partial, 'some-repo'), 'silver');
  });
});

// The behind-main probe must distinguish three states. Collapsing any two is
// how the guard would lie: `git rev-list --count HEAD..origin/main` alone
// returns 0 on a checkout that has never fetched, which is an affirmative
// all-clear for exactly the case the guard exists to catch.
describe('MCP behind-main probe distinguishes unfetched from up-to-date', async () => {
  const { computeStaleness } = await import('./mcp.js');
  const NOW = Date.parse('2026-08-01T12:00:00Z');
  const fresh = new Date(NOW - 3600000).toISOString();

  it('a measured 0 is a genuine all-clear', () => {
    const s = computeStaleness(fresh, 0, NOW);
    assert.equal(s.behind_main_state, 'measured');
    assert.equal(s.commits_behind_main, 0);
    assert.deepEqual(s.warnings, []);
  });

  it('an unfetched checkout warns and never reports a reassuring 0', () => {
    const s = computeStaleness(fresh, 'unfetched', NOW);
    assert.equal(s.behind_main_state, 'unfetched');
    assert.equal(s.commits_behind_main, null, 'a count we cannot make must not be rendered as 0');
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0], /has not fetched since origin\/main moved/);
  });

  it('an unreachable remote is unknown, distinct from both', () => {
    const s = computeStaleness(fresh, null, NOW);
    assert.equal(s.behind_main_state, 'unknown');
    assert.equal(s.commits_behind_main, null);
    assert.match(s.warnings[0], /Could not determine/);
  });

  // The three states must be mutually distinguishable from the envelope alone,
  // which is the property that makes "could not check" and "checked, it is
  // fine" impossible to confuse.
  it('renders the three states distinguishably', () => {
    const states = ['measured', 'unfetched', 'unknown'];
    const seen = [0, 'unfetched', null].map(v => computeStaleness(fresh, v, NOW).behind_main_state);
    assert.deepEqual(seen, states);
    const warned = [0, 'unfetched', null].map(v => computeStaleness(fresh, v, NOW).warnings.length);
    assert.deepEqual(warned, [0, 1, 1], 'only the genuine all-clear is silent');
  });
});

// classifyBehindMain's own suite moved to staleness.test.js when the probe was
// extracted for the skills half of #350. The staleness envelope this server
// wraps around it is still tested above.
