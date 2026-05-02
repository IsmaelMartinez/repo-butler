// MCP (Model Context Protocol) server for repo-butler.
// Exposes portfolio health data as resources and tools via JSON-RPC 2.0 over stdio.
// Zero dependencies — uses Node built-in readline and child_process.
//
// Usage:
//   claude mcp add repo-butler node src/mcp.js
//   echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node src/mcp.js

import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeHealthTier, REPO_EXCLUSION_PATTERNS, CAMPAIGN_DEFS, nextTier } from './report-shared.js';
import { PERSONAS } from './council.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = '2024-11-05';

// --- Data loading ---

// Run a git subcommand against the repo-butler-data branch, trying the
// origin/-prefixed ref first and falling back to the bare local ref. The
// caller supplies argsFor(ref) which builds the full git argv given a ref
// name. Returns stdout, or throws if neither ref works.
function runGitOnDataBranch(argsFor) {
  const opts = { encoding: 'utf8', cwd: join(__dirname, '..'), timeout: 5000 };
  try {
    return execFileSync('git', argsFor('origin/repo-butler-data'), opts);
  } catch {
    return execFileSync('git', argsFor('repo-butler-data'), opts);
  }
}

function loadFromDataBranch(path) {
  try {
    return runGitOnDataBranch(ref => ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function loadSnapshot() {
  const raw = loadFromDataBranch('snapshots/latest.json');
  return raw ? JSON.parse(raw) : null;
}

function loadPortfolioWeekly() {
  // Find the latest weekly file by listing the directory.
  try {
    const listing = runGitOnDataBranch(ref => ['ls-tree', '--name-only', ref, 'snapshots/portfolio-weekly/']).trim();
    if (!listing) return null;
    const files = listing.split('\n').filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    const latest = files[files.length - 1];
    const raw = loadFromDataBranch(latest);
    return raw ? { week: latest.match(/(\d{4}-W\d{2})/)?.[1], data: JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

// List portfolio-weekly files (basenames like "2026-W18.json"), sorted oldest→newest.
function listPortfolioWeeklyFiles() {
  try {
    const listing = runGitOnDataBranch(ref => ['ls-tree', '--name-only', ref, 'snapshots/portfolio-weekly/']).trim();
    if (!listing) return [];
    return listing.split('\n')
      .map(p => p.replace(/^snapshots\/portfolio-weekly\//, ''))
      .filter(f => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

// Normalize a parsed weekly snapshot to a flat { repoName: data } map.
// Supports both v1 envelope ({ schema_version, repos }) and legacy flat format.
function unwrapWeeklyRepos(parsed) {
  if (!parsed) return {};
  if (parsed.repos && typeof parsed.repos === 'object') return parsed.repos;
  // Legacy flat shape — keys are repo names directly.
  return parsed;
}


// --- Resource definitions ---

const RESOURCES = [
  {
    uri: 'repo-butler://snapshot/latest',
    name: 'Latest Snapshot',
    description: 'Full observation snapshot from the most recent pipeline run',
    mimeType: 'application/json',
  },
  {
    uri: 'repo-butler://portfolio/health',
    name: 'Portfolio Health',
    description: 'Health tier classification for every portfolio repo',
    mimeType: 'application/json',
  },
  {
    uri: 'repo-butler://portfolio/campaigns',
    name: 'Campaign Status',
    description: 'Compliance status for each improvement campaign',
    mimeType: 'application/json',
  },
];

function readResource(uri) {
  if (uri === 'repo-butler://snapshot/latest') {
    const snapshot = loadSnapshot();
    if (!snapshot) return null;
    return JSON.stringify(snapshot, null, 2);
  }

  if (uri === 'repo-butler://portfolio/health') {
    return JSON.stringify(computePortfolioHealth(), null, 2);
  }

  if (uri === 'repo-butler://portfolio/campaigns') {
    return JSON.stringify(computeCampaigns(), null, 2);
  }

  return null;
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'get_health_tier',
    description: 'Get the health tier (Gold/Silver/Bronze/None) for a specific repo, with a pass/fail checklist showing what\'s needed for the next tier.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name (without owner prefix)' },
      },
      required: ['repo'],
    },
    handler: (args) => toolGetHealthTier(args.repo),
  },
  {
    name: 'get_campaign_status',
    description: 'Get compliance status for all improvement campaigns across the portfolio.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => toolGetCampaignStatus(),
  },
  {
    name: 'query_portfolio',
    description: 'Query portfolio repos by filter criteria. Returns matching repos with their health data.',
    inputSchema: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['gold', 'silver', 'bronze', 'none'], description: 'Filter by health tier' },
      },
    },
    handler: (args) => toolQueryPortfolio(args),
  },
  {
    name: 'get_snapshot_diff',
    description: 'Compare current snapshot against the previous one. Shows what changed since the last pipeline run.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => toolGetSnapshotDiff(),
  },
  {
    name: 'get_governance_findings',
    description: 'Get portfolio governance findings: standards gaps, policy drift, and tier uplift opportunities from the latest pipeline run.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => toolGetGovernanceFindings(),
  },
  {
    name: 'trigger_refresh',
    description: 'Trigger a fresh report regeneration via the GitHub Actions workflow. The report runs asynchronously and takes ~7 minutes. Returns a status message with a link to the Actions page.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['report', 'all', 'monitor'], default: 'report', description: 'Pipeline phase to run. "report" regenerates dashboards only, "all" runs the full pipeline, "monitor" runs continuous event detection.' },
      },
    },
    handler: (args) => toolTriggerRefresh(args?.phase || 'report'),
  },
  {
    name: 'get_monitor_events',
    description: 'Get the latest monitor events — new threats, issues, PRs, security alerts, and CI failures detected since the last monitor run.',
    inputSchema: {
      type: 'object',
      properties: {
        min_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], default: 'low', description: 'Minimum severity threshold for events.' },
      },
    },
    handler: (args) => toolGetMonitorEvents(args?.min_severity || 'low'),
  },
  {
    name: 'get_watchlist',
    description: 'Get items the agent council placed on the watchlist for later re-evaluation. These are events or proposals that need more evidence before action.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => toolGetWatchlist(),
  },
  {
    name: 'get_council_personas',
    description: 'Get the agent council personas and their roles. Useful for understanding which perspectives evaluate events and proposals.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => toolGetCouncilPersonas(),
  },
  {
    name: 'get_weekly_trend',
    description: 'Get a weekly time-series of health metrics (open issues, CI pass rate, community health, tier) for a single repo, or aggregate metrics across the whole portfolio when no repo is specified.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name (without owner). Omit or pass null for portfolio-wide aggregate.' },
        weeks: { type: 'number', description: 'Number of recent weeks to include (1–12, default 12).' },
      },
    },
    handler: (args) => toolGetWeeklyTrend(args?.repo ?? null, args?.weeks),
  },
  {
    name: 'get_open_governance_prs',
    description: 'List outstanding repo-butler/apply-* governance PRs across the active portfolio. Reads the latest weekly snapshot for the repo list, then queries the gh CLI for open PRs on that branch prefix per repo.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => toolGetOpenGovernancePrs(),
  },
  {
    name: 'list_stale_dependabot_prs',
    description: 'List stale Dependabot PRs detected by the dependabot-stale governance audit. Projects findings from snapshots/governance.json filtered by minimum age in days.',
    inputSchema: {
      type: 'object',
      properties: {
        min_age_days: { type: 'number', description: 'Minimum PR age in days (1–365, default 30).' },
      },
    },
    handler: (args) => toolListStaleDependabotPrs(args?.min_age_days),
  },
];

function callTool(name, args = {}) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return null;
  return tool.handler(args || {});
}

// --- Tool implementations ---

function toolGetHealthTier(repoName) {
  const weekly = loadPortfolioWeekly();
  if (!weekly?.data) return { error: 'No portfolio data available' };

  const repoData = weekly.data[repoName];
  if (!repoData) {
    const available = Object.keys(weekly.data).join(', ');
    return { error: `Repo '${repoName}' not found. Available: ${available}` };
  }

  const { tier, checks } = computeHealthTier(repoData);
  const failing = checks.filter(c => !c.passed);
  const next = nextTier(tier);
  const needed = next ? failing.filter(c => c.required_for === next || (next === 'gold' && c.required_for === 'silver')) : [];

  return {
    repo: repoName,
    tier,
    week: weekly.week,
    checks,
    next_tier: next,
    needed_for_next: needed.map(c => c.name),
  };
}

function toolGetCampaignStatus() {
  return computeCampaigns();
}

function toolQueryPortfolio(filters) {
  const weekly = loadPortfolioWeekly();
  if (!weekly?.data) return { error: 'No portfolio data available' };

  let repos = Object.entries(weekly.data).map(([name, data]) => {
    const { tier } = computeHealthTier(data);
    return { name, tier, ...data };
  });

  if (filters.tier) {
    repos = repos.filter(r => r.tier === filters.tier);
  }

  return { week: weekly.week, count: repos.length, repos };
}

function toolGetSnapshotDiff() {
  const currentRaw = loadFromDataBranch('snapshots/latest.json');
  const previousRaw = loadFromDataBranch('snapshots/previous.json');

  if (!currentRaw) return { error: 'No current snapshot available' };
  if (!previousRaw) return { message: 'No previous snapshot to compare against (first run?)' };

  const current = JSON.parse(currentRaw);
  const previous = JSON.parse(previousRaw);

  const cs = current.summary || {};
  const ps = previous.summary || {};

  return {
    current_timestamp: current.timestamp,
    previous_timestamp: previous.timestamp,
    changes: {
      open_issues: { was: ps.open_issues, now: cs.open_issues, delta: (cs.open_issues || 0) - (ps.open_issues || 0) },
      merged_prs: { was: ps.recently_merged_prs, now: cs.recently_merged_prs, delta: (cs.recently_merged_prs || 0) - (ps.recently_merged_prs || 0) },
      releases: { was: ps.releases, now: cs.releases, delta: (cs.releases || 0) - (ps.releases || 0) },
      community_health: { was: ps.community_health, now: cs.community_health },
      ci_pass_rate: { was: ps.ci_pass_rate, now: cs.ci_pass_rate },
      bus_factor: { was: ps.bus_factor, now: cs.bus_factor },
    },
  };
}

function toolGetGovernanceFindings() {
  const raw = loadFromDataBranch('snapshots/governance.json');
  if (!raw) return { findings: [], message: 'No governance findings available — run the full pipeline first' };
  try {
    const findings = JSON.parse(raw);
    return {
      findings,
      summary: {
        total: findings.length,
        gaps: findings.filter(f => f.type === 'standards-gap').length,
        drift: findings.filter(f => f.type === 'policy-drift').length,
        uplift: findings.filter(f => f.type === 'tier-uplift').length,
      },
    };
  } catch {
    return { findings: [], error: 'Failed to parse governance findings' };
  }
}

function getRepoSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8', cwd: join(__dirname, '..'), timeout: 5000,
    }).trim();
    const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function toolTriggerRefresh(phase) {
  const validPhases = ['report', 'all', 'monitor'];
  if (!validPhases.includes(phase)) {
    return { error: `Invalid phase "${phase}". Use "report", "all", or "monitor".` };
  }

  const repo = getRepoSlug();
  if (!repo) {
    return { error: 'Could not determine repository from git remote.' };
  }

  try {
    const output = execFileSync('gh', [
      'workflow', 'run', 'Repo Butler',
      '--repo', repo,
      '--ref', 'main',
      '-f', `phase=${phase}`,
      '-f', 'dry-run=false',
      '-f', 'force-report=true',
    ], { encoding: 'utf8', cwd: join(__dirname, '..'), timeout: 10000 });

    return {
      status: 'triggered',
      phase,
      message: `Report regeneration triggered (phase: ${phase}). Takes ~7 minutes. Check status at https://github.com/${repo}/actions`,
      output: output.trim() || undefined,
    };
  } catch (err) {
    return {
      error: `Failed to trigger refresh: ${err.message?.slice(0, 200)}`,
      hint: 'Ensure the gh CLI is installed and authenticated.',
    };
  }
}

function toolGetMonitorEvents(minSeverity) {
  const raw = loadFromDataBranch('snapshots/monitor-cursor.json');
  if (!raw) return { events: [], message: 'No monitor data available — run the monitor phase first.' };

  try {
    const cursor = JSON.parse(raw);
    const SEVERITY = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const threshold = SEVERITY[minSeverity] || 0;

    return {
      last_run: cursor.timestamp,
      repository: cursor.repository,
      total_events: cursor.last_event_count || 0,
      known_issues: cursor.known_issue_numbers?.length || 0,
      known_prs: cursor.known_pr_numbers?.length || 0,
      known_security_alerts: (cursor.known_dependabot_alerts?.length || 0)
        + (cursor.known_code_scanning_alerts?.length || 0)
        + (cursor.known_secret_scanning_alerts?.length || 0),
      filter: minSeverity,
    };
  } catch {
    return { events: [], error: 'Failed to parse monitor data.' };
  }
}

function toolGetWatchlist() {
  const raw = loadFromDataBranch('snapshots/watchlist.json');
  if (!raw) return { items: [], message: 'No watchlist items — council has not placed any items on watch.' };

  try {
    const items = JSON.parse(raw);
    return {
      total: items.length,
      items: items.map(i => ({
        title: i.title,
        type: i.type,
        severity: i.severity,
        added_at: i.added_at,
        review_count: i.review_count || 0,
        council_summary: i.council_summary,
      })),
    };
  } catch {
    return { items: [], error: 'Failed to parse watchlist.' };
  }
}

function toolGetCouncilPersonas() {
  return {
    description: 'The agent council evaluates events and proposals from five specialist perspectives before deciding to act, watch, or dismiss.',
    personas: Object.values(PERSONAS).map(({ name, role, focus }) => ({ name, role, focus })),
    verdicts: ['act (take action now)', 'watch (re-evaluate later)', 'dismiss (no action needed)'],
    modes: ['quick (single LLM call, all perspectives)', 'full (separate call per agent + synthesis)'],
  };
}

// --- Input validators ---

// GitHub repo names: alphanumerics, dots, hyphens, underscores; 1–100 chars.
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function isValidRepoName(name) {
  return typeof name === 'string' && REPO_NAME_RE.test(name);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// --- New read-only tools ---

function projectWeekRow(week, data) {
  if (!data) return null;
  const { tier } = computeHealthTier(data);
  return {
    week,
    open_issues: data.open_issues ?? null,
    ci_pass_rate: data.ciPassRate ?? null,
    community_health: data.communityHealth ?? null,
    tier,
  };
}

function toolGetWeeklyTrend(repoName, weeksArg) {
  const weeks = clampInt(weeksArg, 12, 1, 12);

  if (repoName !== null && repoName !== undefined && !isValidRepoName(repoName)) {
    return { error: 'Invalid repo name. Must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}.' };
  }

  const files = listPortfolioWeeklyFiles();
  if (files.length === 0) return { error: 'No portfolio-weekly snapshots available.' };

  const selected = files.slice(-weeks);
  const parsed = selected.map(file => {
    const week = file.match(/(\d{4}-W\d{2})/)?.[1] ?? file.replace(/\.json$/, '');
    const raw = loadFromDataBranch(`snapshots/portfolio-weekly/${file}`);
    if (!raw) return null;
    try {
      return { week, repos: unwrapWeeklyRepos(JSON.parse(raw)) };
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (parsed.length === 0) return { error: 'Could not parse any weekly snapshots.' };

  // Per-repo time-series.
  if (repoName) {
    const series = parsed
      .map(({ week, repos }) => projectWeekRow(week, repos[repoName]))
      .filter(Boolean);
    return { repo: repoName, weeks: series.length, series };
  }

  // Portfolio-wide aggregate per week.
  const aggregate = parsed.map(({ week, repos }) => {
    const entries = Object.values(repos);
    const tierCounts = { gold: 0, silver: 0, bronze: 0, none: 0 };
    let totalOpenIssues = 0;
    let ciSum = 0, ciCount = 0;
    let chSum = 0, chCount = 0;
    for (const data of entries) {
      const { tier } = computeHealthTier(data);
      if (tierCounts[tier] !== undefined) tierCounts[tier]++;
      if (typeof data.open_issues === 'number') totalOpenIssues += data.open_issues;
      if (typeof data.ciPassRate === 'number') { ciSum += data.ciPassRate; ciCount++; }
      if (typeof data.communityHealth === 'number') { chSum += data.communityHealth; chCount++; }
    }
    return {
      week,
      repos: entries.length,
      total_open_issues: totalOpenIssues,
      avg_ci_pass_rate: ciCount > 0 ? ciSum / ciCount : null,
      avg_community_health: chCount > 0 ? chSum / chCount : null,
      tier_distribution: tierCounts,
    };
  });

  return { weeks: aggregate.length, series: aggregate };
}

function toolGetOpenGovernancePrs() {
  const weekly = loadPortfolioWeekly();
  if (!weekly?.data) return { prs: [], error: 'No portfolio data available.' };

  const owner = getRepoSlug()?.split('/')[0];
  if (!owner) return { prs: [], error: 'Could not determine repo owner from git remote.' };

  const repos = Object.keys(unwrapWeeklyRepos(weekly.data)).filter(isValidRepoName);

  const prs = [];
  const warnings = [];
  let ghMissing = false;

  for (const repo of repos) {
    if (ghMissing) break; // gh isn't installed — no point retrying every repo

    try {
      // gh's --head is exact-match, not prefix-match. List ALL open PRs and
      // filter client-side for our prefix. Modest per-repo cost; the pre-filter
      // approach silently returned empty for every repo.
      const output = execFileSync('gh', [
        'pr', 'list',
        '--repo', `${owner}/${repo}`,
        '--state', 'open',
        '--json', 'number,url,headRefName,createdAt',
        '--limit', '50',
      ], { encoding: 'utf8', cwd: join(__dirname, '..'), timeout: 10000 });

      const list = JSON.parse(output || '[]');
      for (const pr of list) {
        if (typeof pr.headRefName !== 'string' || !pr.headRefName.startsWith('repo-butler/apply-')) continue;
        const tool = pr.headRefName.replace(/^repo-butler\/apply-/, '').split('/')[0] || null;
        prs.push({
          repo,
          pr_number: pr.number,
          pr_url: pr.url,
          tool,
          opened_at: pr.createdAt,
        });
      }
    } catch (err) {
      // Distinguish "gh not installed" (single global warning) from per-repo
      // failures (auth, missing repo, rate limit). Surface both — silently
      // returning empty made "no PRs" indistinguishable from "infra broken".
      if (err.code === 'ENOENT') {
        warnings.push({ kind: 'gh_unavailable', message: 'gh CLI not found in PATH' });
        ghMissing = true;
      } else {
        warnings.push({ kind: 'repo_query_failed', repo, message: err.message?.split('\n')[0] || 'unknown error' });
      }
    }
  }

  return warnings.length > 0
    ? { owner, count: prs.length, prs, warnings }
    : { owner, count: prs.length, prs };
}

function toolListStaleDependabotPrs(minAgeArg) {
  const minAgeDays = clampInt(minAgeArg, 30, 1, 365);

  const raw = loadFromDataBranch('snapshots/governance.json');
  if (!raw) return { min_age_days: minAgeDays, count: 0, prs: [], message: 'No governance findings available — run the governance phase first.' };

  let findings;
  try {
    findings = JSON.parse(raw);
  } catch {
    return { min_age_days: minAgeDays, count: 0, prs: [], error: 'Failed to parse governance findings.' };
  }

  const owner = getRepoSlug()?.split('/')[0] || null;
  const prs = [];

  for (const finding of findings) {
    if (finding?.type !== 'dependabot-stale') continue;
    const repo = finding.repo;
    if (!isValidRepoName(repo)) continue;
    for (const pr of finding.stalePRs || []) {
      const age = Number(pr.age);
      if (!Number.isFinite(age) || age < minAgeDays) continue;
      // pr.number comes from a data-branch JSON file; validate before
      // interpolating into a URL to prevent path traversal (e.g. "1/../settings").
      const prNumber = Number(pr.number);
      if (!Number.isInteger(prNumber) || prNumber < 1) continue;
      prs.push({
        repo,
        pr_number: prNumber,
        pr_url: owner ? `https://github.com/${owner}/${repo}/pull/${prNumber}` : null,
        age_days: age,
        title: pr.title ?? null,
      });
    }
  }

  prs.sort((a, b) => b.age_days - a.age_days);

  return { min_age_days: minAgeDays, count: prs.length, prs };
}

// --- Portfolio computation helpers ---

function computePortfolioHealth() {
  const weekly = loadPortfolioWeekly();
  if (!weekly?.data) return { error: 'No portfolio data available' };

  const repos = Object.entries(weekly.data).map(([name, data]) => {
    const { tier, checks } = computeHealthTier(data);
    return { name, tier, checks };
  });

  const tiers = { gold: 0, silver: 0, bronze: 0, none: 0 };
  for (const r of repos) tiers[r.tier]++;

  return { week: weekly.week, total: repos.length, tiers, repos };
}

function computeCampaigns() {
  const weekly = loadPortfolioWeekly();
  if (!weekly?.data) return { error: 'No portfolio data available' };

  // Filter out exclusion patterns (shadow, test-repo) to match dashboard logic.
  const details = weekly.data;
  const repos = Object.keys(details)
    .filter(name => !REPO_EXCLUSION_PATTERNS.some(p => name.includes(p)))
    .map(name => ({ name }));

  return {
    week: weekly.week,
    campaigns: CAMPAIGN_DEFS.map(c => {
      const pool = c.applicable ? repos.filter(r => c.applicable(r, details)) : repos;
      const { compliant, nonCompliant } = pool.reduce((acc, r) => {
        if (c.test(r, details)) acc.compliant.push(r);
        else acc.nonCompliant.push(r);
        return acc;
      }, { compliant: [], nonCompliant: [] });
      return {
        name: c.name,
        description: c.description,
        total: pool.length,
        compliant: compliant.length,
        percentage: pool.length > 0 ? Math.round((compliant.length / pool.length) * 100) : 0,
        non_compliant: nonCompliant.map(r => r.name),
      };
    }),
  };
}

// --- JSON-RPC transport ---

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    respondError(null, -32700, 'Parse error');
    return;
  }

  // Notifications (no id) get no response.
  if (msg.id === undefined || msg.id === null) return;

  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { resources: {}, tools: {} },
        serverInfo: { name: 'repo-butler', version: '1.0.0' },
      });
      break;

    case 'ping':
      respond(id, {});
      break;

    case 'resources/list':
      respond(id, { resources: RESOURCES });
      break;

    case 'resources/read': {
      const uri = params?.uri;
      if (!uri) { respondError(id, -32602, 'Missing uri parameter'); break; }
      const content = readResource(uri);
      if (content === null) { respondError(id, -32602, `Unknown resource: ${uri}`); break; }
      respond(id, { contents: [{ uri, mimeType: 'application/json', text: content }] });
      break;
    }

    case 'tools/list':
      respond(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      if (!toolName) { respondError(id, -32602, 'Missing tool name'); break; }
      const tool = TOOLS.find(t => t.name === toolName);
      if (!tool) { respondError(id, -32602, `Unknown tool: ${toolName}`); break; }
      const result = callTool(toolName, params?.arguments || {});
      if (result === null) { respondError(id, -32603, 'Tool execution failed'); break; }
      respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      break;
    }

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

// --- Main (only when run directly, not when imported for testing) ---

const isMain = process.argv[1]?.endsWith('mcp.js') || process.argv[1]?.endsWith('src/mcp.js');
if (isMain) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', handleMessage);
  rl.on('close', () => process.exit(0));
}

// Export for testing.
export { handleMessage, loadSnapshot, loadPortfolioWeekly, computePortfolioHealth, computeCampaigns, callTool, TOOLS, RESOURCES };
