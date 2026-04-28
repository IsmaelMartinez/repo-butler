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
import { computeHealthTier, REPO_EXCLUSION_PATTERNS, CAMPAIGN_DEFS } from './report-shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = '2024-11-05';

// --- Data loading ---

function loadFromDataBranch(path) {
  try {
    return execFileSync('git', ['show', `origin/repo-butler-data:${path}`], {
      encoding: 'utf8',
      cwd: join(__dirname, '..'),
      timeout: 5000,
    });
  } catch {
    // Try without origin/ prefix (local branch).
    try {
      return execFileSync('git', ['show', `repo-butler-data:${path}`], {
        encoding: 'utf8',
        cwd: join(__dirname, '..'),
        timeout: 5000,
      });
    } catch {
      return null;
    }
  }
}

function loadSnapshot() {
  const raw = loadFromDataBranch('snapshots/latest.json');
  return raw ? JSON.parse(raw) : null;
}

function loadPortfolioWeekly() {
  // Find the latest weekly file by listing the directory.
  try {
    let listing;
    try {
      listing = execFileSync('git', ['ls-tree', '--name-only', 'origin/repo-butler-data', 'snapshots/portfolio-weekly/'], {
        encoding: 'utf8', cwd: join(__dirname, '..'), timeout: 5000,
      }).trim();
    } catch {
      listing = execFileSync('git', ['ls-tree', '--name-only', 'repo-butler-data', 'snapshots/portfolio-weekly/'], {
        encoding: 'utf8', cwd: join(__dirname, '..'), timeout: 5000,
      }).trim();
    }
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
  },
  {
    name: 'get_campaign_status',
    description: 'Get compliance status for all improvement campaigns across the portfolio.',
    inputSchema: { type: 'object', properties: {} },
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
  },
  {
    name: 'get_snapshot_diff',
    description: 'Compare current snapshot against the previous one. Shows what changed since the last pipeline run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_governance_findings',
    description: 'Get portfolio governance findings: standards gaps, policy drift, and tier uplift opportunities from the latest pipeline run.',
    inputSchema: { type: 'object', properties: {} },
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
  },
  {
    name: 'get_watchlist',
    description: 'Get items the agent council placed on the watchlist for later re-evaluation. These are events or proposals that need more evidence before action.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_council_personas',
    description: 'Get the agent council personas and their roles. Useful for understanding which perspectives evaluate events and proposals.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function callTool(name, args) {
  if (name === 'get_health_tier') {
    return toolGetHealthTier(args.repo);
  }
  if (name === 'get_campaign_status') {
    return toolGetCampaignStatus();
  }
  if (name === 'query_portfolio') {
    return toolQueryPortfolio(args);
  }
  if (name === 'get_snapshot_diff') {
    return toolGetSnapshotDiff();
  }
  if (name === 'get_governance_findings') {
    return toolGetGovernanceFindings();
  }
  if (name === 'trigger_refresh') {
    return toolTriggerRefresh(args?.phase || 'report');
  }
  if (name === 'get_monitor_events') {
    return toolGetMonitorEvents(args?.min_severity || 'low');
  }
  if (name === 'get_watchlist') {
    return toolGetWatchlist();
  }
  if (name === 'get_council_personas') {
    return toolGetCouncilPersonas();
  }
  return null;
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
  const nextTier = tier === 'none' ? 'bronze' : tier === 'bronze' ? 'silver' : tier === 'silver' ? 'gold' : null;
  const needed = nextTier ? failing.filter(c => c.required_for === nextTier || (nextTier === 'gold' && c.required_for === 'silver')) : [];

  return {
    repo: repoName,
    tier,
    week: weekly.week,
    checks,
    next_tier: nextTier,
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
  // Import-free — hardcode to avoid dynamic import in sync context.
  return {
    description: 'The agent council evaluates events and proposals from five specialist perspectives before deciding to act, watch, or dismiss.',
    personas: [
      { name: 'Product', role: 'Product Manager', focus: 'user value, feature priorities, roadmap alignment, community impact' },
      { name: 'Development', role: 'Lead Developer', focus: 'implementation complexity, technical debt, code quality, developer experience' },
      { name: 'Stability', role: 'SRE / Reliability Engineer', focus: 'system reliability, CI health, deployment risk, incident prevention' },
      { name: 'Maintainability', role: 'Architecture Reviewer', focus: 'long-term maintenance burden, documentation, dependency management, bus factor' },
      { name: 'Security', role: 'Security Engineer', focus: 'vulnerability impact, attack surface, data exposure, compliance' },
    ],
    verdicts: ['act (take action now)', 'watch (re-evaluate later)', 'dismiss (no action needed)'],
    modes: ['quick (single LLM call, all perspectives)', 'full (separate call per agent + synthesis)'],
  };
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
      const compliant = pool.filter(r => c.test(r, details));
      const nonCompliant = pool.filter(r => !c.test(r, details));
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
export { handleMessage, loadSnapshot, loadPortfolioWeekly, computePortfolioHealth, computeCampaigns, TOOLS, RESOURCES };
