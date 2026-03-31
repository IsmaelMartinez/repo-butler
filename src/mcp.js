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
import { computeHealthTier, REPO_EXCLUSION_PATTERNS } from './report-shared.js';

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

  const entries = Object.entries(weekly.data);
  const campaigns = [
    {
      name: 'Community Health',
      description: 'Repos with community health score >= 80%',
      test: d => (d.communityHealth ?? -1) >= 80,
      applicable: d => d.communityHealth != null,
    },
    {
      name: 'Vulnerability Free',
      description: 'Repos with zero critical/high vulnerabilities',
      test: d => d.vulns != null && d.vulns.max_severity !== 'critical' && d.vulns.max_severity !== 'high',
      applicable: d => d.vulns != null,
    },
    {
      name: 'CI Reliability',
      description: 'Repos with CI pass rate >= 90%',
      test: d => (d.ciPassRate ?? -1) >= 0.9,
      applicable: d => d.ciPassRate != null,
    },
    {
      name: 'License Compliance',
      description: 'Repos with a license configured',
      test: d => !!d.license && d.license !== 'None',
      applicable: () => true,
    },
    {
      name: 'Issue Templates',
      description: 'Repos with issue templates configured',
      test: d => !!d.hasIssueTemplate,
      applicable: () => true,
    },
  ];

  // Filter out exclusion patterns (shadow, test-repo) to match dashboard logic.
  const filtered = entries.filter(([name]) => !REPO_EXCLUSION_PATTERNS.some(p => name.includes(p)));

  return {
    week: weekly.week,
    campaigns: campaigns.map(c => {
      const pool = filtered.filter(([, d]) => c.applicable(d));
      const compliant = pool.filter(([, d]) => c.test(d));
      const nonCompliant = pool.filter(([, d]) => !c.test(d));
      return {
        name: c.name,
        description: c.description,
        total: pool.length,
        compliant: compliant.length,
        percentage: pool.length > 0 ? Math.round((compliant.length / pool.length) * 100) : 0,
        non_compliant: nonCompliant.map(([name]) => name),
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
