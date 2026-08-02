// MCP server tests — verify JSON-RPC protocol handling and tool/resource responses.
// Tests the message handler directly without spawning a subprocess.

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// Dynamic import to avoid top-level side effects.
let handleMessage, TOOLS, RESOURCES, callTool;

describe('MCP server', async () => {
  // Import once for all tests.
  const mod = await import('./mcp.js');
  handleMessage = mod.handleMessage;
  TOOLS = mod.TOOLS;
  RESOURCES = mod.RESOURCES;
  callTool = mod.callTool;
  const unwrapWeeklyRepos = mod.unwrapWeeklyRepos;
  const computeAutofixNotDrivenTrend = mod.computeAutofixNotDrivenTrend;
  const computeOpenVulnerabilitiesTrend = mod.computeOpenVulnerabilitiesTrend;
  const computeTierRegressionsTrend = mod.computeTierRegressionsTrend;
  const GOVERNANCE_WEEKLY_FILE_PATTERN = mod.GOVERNANCE_WEEKLY_FILE_PATTERN;

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

  describe('GOVERNANCE_WEEKLY_FILE_PATTERN', () => {
    it('matches ISO-week filenames written by store.js writeGovernanceWeekly', () => {
      assert.ok(GOVERNANCE_WEEKLY_FILE_PATTERN.test('2026-W18.json'));
      assert.ok(GOVERNANCE_WEEKLY_FILE_PATTERN.test('2025-W01.json'));
    });

    it('rejects non-week JSON files so a stray file cannot be read as a weekly snapshot', () => {
      assert.equal(GOVERNANCE_WEEKLY_FILE_PATTERN.test('governance.json'), false);
      assert.equal(GOVERNANCE_WEEKLY_FILE_PATTERN.test('init.json'), false);
      assert.equal(GOVERNANCE_WEEKLY_FILE_PATTERN.test('2026-W18.json.bak'), false);
      assert.equal(GOVERNANCE_WEEKLY_FILE_PATTERN.test('notes/2026-W18.json'), false);
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

    it('get_health_tier returns tier and checks for a known repo', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 23, method: 'tools/call',
        params: { name: 'get_health_tier', arguments: { repo: 'repo-butler' } },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      // Result will either have tier data or an error about no data — both are valid responses.
      const r = responses[0];
      assert.ok(r.result, 'should have a result');
      assert.ok(r.result.content, 'tool result should have content array');
      const data = JSON.parse(r.result.content[0].text);
      // If data is available, check structure. If not, it's an error message.
      if (data.tier) {
        assert.ok(['gold', 'silver', 'bronze', 'none'].includes(data.tier));
        assert.ok(Array.isArray(data.checks));
      }
    });

    it('get_campaign_status returns campaign array', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 24, method: 'tools/call',
        params: { name: 'get_campaign_status', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.ok(r.result?.content);
      const data = JSON.parse(r.result.content[0].text);
      if (data.campaigns) {
        assert.ok(Array.isArray(data.campaigns));
        for (const c of data.campaigns) {
          assert.ok(c.name);
          assert.ok(typeof c.percentage === 'number');
        }
      }
    });

    it('query_portfolio returns repos array', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 25, method: 'tools/call',
        params: { name: 'query_portfolio', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.ok(r.result?.content);
      const data = JSON.parse(r.result.content[0].text);
      if (data.repos) {
        assert.ok(Array.isArray(data.repos));
        // The v1 envelope keys must not leak through as pseudo-repos.
        const names = data.repos.map(r => r.name);
        assert.ok(!names.includes('schema_version'), 'schema_version leaked as a repo');
        assert.ok(!names.includes('repos'), 'repos envelope key leaked as a repo');
      }
    });

    it('get_snapshot_diff returns comparison or first-run message', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 26, method: 'tools/call',
        params: { name: 'get_snapshot_diff', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.ok(r.result?.content);
      const data = JSON.parse(r.result.content[0].text);
      assert.ok(data.changes || data.message || data.error);
    });

    it('get_governance_findings returns findings or empty message', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 27, method: 'tools/call',
        params: { name: 'get_governance_findings', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.ok(r.result?.content);
      const data = JSON.parse(r.result.content[0].text);
      assert.ok(Array.isArray(data.findings));
      if (data.summary) {
        assert.equal(typeof data.summary.tierRegressions, 'number',
          'summary counts tier-regression findings (G7)');
        assert.equal(typeof data.summary.stalledAlerts, 'number',
          'summary counts stalled-alert findings (G13)');
        // Either no prior governance-weekly snapshot exists yet (null) or a
        // fully-shaped trend object — never a bare number or partial object.
        for (const trend of [data.summary.autofixNotDrivenTrend, data.summary.openVulnerabilitiesTrend, data.summary.tierRegressionsTrend]) {
          if (trend !== null) {
            assert.equal(typeof trend.current, 'number');
            assert.equal(typeof trend.previous, 'number');
            assert.equal(typeof trend.delta, 'number');
            assert.ok(['improving', 'worsening', 'unchanged'].includes(trend.direction));
            assert.equal(typeof trend.previousWeek, 'string', 'previousWeek must be set alongside the trend');
          }
        }
      }
    });

    it('get_weekly_trend returns a series for an aggregate query', () => {
      restoreStdout();
      const result = callTool('get_weekly_trend', {});
      assert.ok(result, 'expected a result');
      // Either real data is available (series array) or a clear error payload.
      if (Array.isArray(result.series)) {
        assert.equal(typeof result.weeks, 'number');
        for (const row of result.series) {
          assert.ok(typeof row.week === 'string', 'each row must have a week label');
          assert.ok(row.tier_distribution, 'aggregate row must include tier_distribution');
          assert.ok(typeof row.repos === 'number');
        }
      } else {
        assert.ok(result.error, 'when no series, an error must be present');
      }
    });

    it('get_weekly_trend per-repo query returns repo-keyed series', () => {
      restoreStdout();
      const result = callTool('get_weekly_trend', { repo: 'repo-butler', weeks: 4 });
      assert.ok(result);
      if (Array.isArray(result.series)) {
        assert.equal(result.repo, 'repo-butler');
        for (const row of result.series) {
          assert.ok(typeof row.week === 'string');
          assert.ok(['gold', 'silver', 'bronze', 'none'].includes(row.tier));
        }
      } else {
        assert.ok(result.error);
      }
    });

    it('get_weekly_trend rejects invalid repo names', () => {
      restoreStdout();
      const result = callTool('get_weekly_trend', { repo: '../etc/passwd' });
      assert.ok(result?.error, 'expected an error for invalid repo name');
      assert.match(result.error, /Invalid repo name/);
    });

    it('get_weekly_trend clamps weeks beyond the 1–12 range', () => {
      restoreStdout();
      const result = callTool('get_weekly_trend', { weeks: 9999 });
      assert.ok(result);
      if (Array.isArray(result.series)) {
        // Should never exceed 12 weeks even when caller asks for more.
        assert.ok(result.series.length <= 12);
      } else {
        assert.ok(result.error);
      }
    });

    it('get_open_governance_prs returns a prs array', () => {
      restoreStdout();
      const result = callTool('get_open_governance_prs', {});
      assert.ok(result);
      // Either we get a prs array (possibly empty) or an error explaining why we couldn't list.
      if (Array.isArray(result.prs)) {
        for (const pr of result.prs) {
          assert.ok(typeof pr.repo === 'string');
          assert.ok(typeof pr.pr_number === 'number');
          assert.ok(typeof pr.pr_url === 'string');
          assert.ok('opened_at' in pr);
        }
      } else {
        assert.ok(result.error);
      }
    });

    it('list_stale_dependabot_prs returns a prs array projected from governance.json', () => {
      restoreStdout();
      const result = callTool('list_stale_dependabot_prs', {});
      assert.ok(result);
      if (Array.isArray(result.prs)) {
        assert.equal(result.min_age_days, 30);
        for (const pr of result.prs) {
          assert.ok(typeof pr.repo === 'string');
          assert.ok(typeof pr.pr_number === 'number');
          assert.ok(typeof pr.age_days === 'number');
          assert.ok(pr.age_days >= 30, 'age must respect min_age_days threshold');
        }
      } else {
        assert.ok(result.message || result.error);
      }
    });

    it('list_stale_dependabot_prs honours a custom min_age_days', () => {
      restoreStdout();
      const result = callTool('list_stale_dependabot_prs', { min_age_days: 60 });
      assert.ok(result);
      if (Array.isArray(result.prs)) {
        assert.equal(result.min_age_days, 60);
        for (const pr of result.prs) {
          assert.ok(pr.age_days >= 60);
        }
      } else {
        assert.ok(result.message || result.error);
      }
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

    it('attaches a well-formed envelope to a data-branch tool', () => {
      const result = callTool('get_health_tier', { repo: 'repo-butler' });
      assert.ok(result.staleness, 'a data-branch answer must say how old it is');
      assert.ok(Array.isArray(result.staleness.warnings));
      assert.ok('data_age_hours' in result.staleness);
      assert.ok('commits_behind_main' in result.staleness);
    });

    // An error is exactly when the caller most wants to know the checkout
    // might be the cause, so the envelope rides along with it.
    it('annotates an error result too', () => {
      const result = callTool('get_health_tier', { repo: 'definitely-not-a-repo' });
      assert.ok(result.error, 'sanity: this repo does not exist');
      assert.ok(result.staleness, 'an error still needs its staleness context');
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

// The deciding half of the behind-main probe. computeStaleness renders whatever
// it is handed; THIS is what must never hand it a reassuring 0 for a checkout
// that has not fetched. Kept pure (git reads injected) so that branch is
// testable without a fixture repo.
describe('classifyBehindMain', async () => {
  const { classifyBehindMain } = await import('./mcp.js');
  const SHA = 'a'.repeat(40);
  const present = () => true;
  const absent = () => false;
  const counts = (n) => () => String(n);

  it('counts against the real remote tip when we have that commit', () => {
    assert.equal(classifyBehindMain(`${SHA}\trefs/heads/main`, present, counts(7)), 7);
  });

  it('a genuine zero is preserved as a number, not conflated with unknown', () => {
    assert.strictEqual(classifyBehindMain(`${SHA}\trefs/heads/main`, present, counts(0)), 0);
  });

  // The defect this whole change exists to remove.
  it('reports unfetched — never 0 — when the remote tip is absent locally', () => {
    assert.equal(classifyBehindMain(`${SHA}\trefs/heads/main`, absent, counts(0)), 'unfetched',
      'a checkout that cannot see the remote tip must not report a count');
  });

  it('does not even attempt a count when the tip is absent', () => {
    let counted = false;
    classifyBehindMain(`${SHA}\trefs/heads/main`, absent, () => { counted = true; return '0'; });
    assert.equal(counted, false, 'counting against a commit we do not have is meaningless');
  });

  it('is unknown when the remote could not be reached', () => {
    assert.equal(classifyBehindMain(null, present, counts(0)), null);
    assert.equal(classifyBehindMain('', present, counts(0)), null);
  });

  it('is unknown when ls-remote returns something that is not a sha', () => {
    assert.equal(classifyBehindMain('fatal: could not read from remote', present, counts(0)), null);
    assert.equal(classifyBehindMain('deadbeef\trefs/heads/main', present, counts(0)), null,
      'a short or malformed sha must not be trusted');
  });

  it('is unknown when the count itself is unreadable', () => {
    assert.equal(classifyBehindMain(`${SHA}\trefs/heads/main`, present, () => null), null);
    assert.equal(classifyBehindMain(`${SHA}\trefs/heads/main`, present, () => 'not-a-number'), null);
  });
});
