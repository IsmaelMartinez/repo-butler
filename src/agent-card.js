// A2A AgentCard generator for repo-butler.
// Spec: https://a2a-protocol.org/latest/specification
//
// The butler does not yet expose an A2A transport endpoint — its primary
// programmatic interface is the MCP server (see src/mcp.js). The AgentCard
// is therefore discovery-only: it declares skills, capabilities, and where
// to find the code / reports / MCP server, so that A2A-aware agents can
// reason about what the butler can do before calling it via MCP.

const PAGES_BASE = 'https://ismaelmartinez.github.io/repo-butler';
const REPO_URL = 'https://github.com/IsmaelMartinez/repo-butler';

const SKILLS = [
  {
    id: 'portfolio-health',
    name: 'Portfolio Health Classification',
    description:
      'Classifies every repo in the portfolio into a Gold/Silver/Bronze/None health tier against explicit pass/fail criteria (license, CI, community health, security scanning, release cadence, open bug count).',
    tags: ['portfolio', 'health', 'governance', 'tiers'],
    examples: [
      'What tier is repo X at?',
      'Which repos are Silver and need one more check to reach Gold?',
    ],
    inputModes: ['application/json', 'text/plain'],
    outputModes: ['application/json'],
  },
  {
    id: 'governance-findings',
    name: 'Portfolio Governance Findings',
    description:
      'Detects standards gaps (which repos lack declared tooling), policy drift (repos diverging from the portfolio majority), and tier-uplift opportunities (specific checks a repo needs to close to reach the next tier).',
    tags: ['governance', 'standards', 'drift', 'uplift'],
    examples: [
      'Which repos are missing Dependabot?',
      'Are any repos drifting from the license majority?',
    ],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
  {
    id: 'campaign-status',
    name: 'Campaign Status',
    description:
      'Reports compliance percentages for each improvement campaign (Community Health, Vulnerability Free, CI Reliability, License Compliance, Issue Templates) and lists the non-compliant repos.',
    tags: ['campaigns', 'compliance'],
    examples: ['How is the Vulnerability Free campaign tracking?'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
  {
    id: 'snapshot-diff',
    name: 'Snapshot Diff',
    description:
      'Compares the latest portfolio snapshot against the previous one, surfacing deltas in open issues, merged PRs, releases, community health, CI pass rate, and bus factor.',
    tags: ['diff', 'trends', 'observation'],
    examples: ['What changed since the last run?'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
  {
    id: 'monitor-events',
    name: 'Continuous Monitor Events',
    description:
      'Returns new events detected between scheduled runs: opened issues, PRs, Dependabot/code-scanning/secret-scanning alerts, and CI failures. Filterable by minimum severity.',
    tags: ['monitor', 'events', 'alerts'],
    examples: ['Any new critical alerts in the last six hours?'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
  {
    id: 'council-triage',
    name: 'Agent Council Triage',
    description:
      'Five-persona deliberation (Product, Development, Stability, Maintainability, Security) over improvement proposals and monitor events, yielding approved / watchlisted / dismissed verdicts with rationale.',
    tags: ['council', 'deliberation', 'triage'],
    examples: ['Why was this proposal watchlisted?'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
];

export function buildAgentCard({ version = '0.1.0', repo = 'IsmaelMartinez/repo-butler' } = {}) {
  return {
    name: 'Repo Butler',
    description:
      'Continuous portfolio governance agent. Observes GitHub repos on a daily schedule, classifies health into Gold/Silver/Bronze tiers, surfaces cross-repo governance findings, and publishes dashboards. Primary programmatic interface is the MCP server (see documentationUrl); this AgentCard is discovery-only.',
    version,
    provider: {
      organization: 'IsmaelMartinez',
      url: `https://github.com/${repo.split('/')[0]}`,
    },
    documentationUrl: REPO_URL,
    iconUrl: `${PAGES_BASE}/badges/${repo.split('/')[1]}.svg`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json'],
    supportedInterfaces: [],
    skills: SKILLS,
  };
}

export { SKILLS };
