// Shared helpers and constants used by report-repo.js and report-portfolio.js.

export const SIX_MONTHS_AGO = new Date(Date.now() - 180 * 86400000);
export const ONE_YEAR_AGO = new Date(Date.now() - 365 * 86400000);

export const TIER_DISPLAY = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze', none: 'Unranked' };
export const TIER_COLORS = { gold: '#ffd700', silver: '#c0c0c0', bronze: '#cd7f32', none: '#6e7681' };
export const COLOR_SUCCESS = '#7ee787';
export const COLOR_WARNING = '#d29922';
export const COLOR_DANGER = '#f85149';
export const REPO_EXCLUSION_PATTERNS = ['shadow', 'test-repo'];

// Bumped when cached repo `details` shape or its derivation logic changes,
// so existing per-repo cache entries are recomputed even if pushed_at is unchanged.
export const REPO_CACHE_SCHEMA_VERSION = 2;

// True for releases that are actually published. GitHub returns drafts (with
// null published_at) at the top of /releases when ordered by created_at, so
// `releases[0]` without this filter can land on an unpublished draft.
export function isPublishedRelease(rel) {
  return !rel.draft && !!rel.published_at;
}

export const LIBYEAR_THRESHOLDS = { GREEN: 5, YELLOW: 20 };

export function getLibyearColor(libyearVal) {
  if (libyearVal == null) return '#6e7681';
  if (libyearVal < LIBYEAR_THRESHOLDS.GREEN) return '#7ee787';
  if (libyearVal < LIBYEAR_THRESHOLDS.YELLOW) return '#d29922';
  return '#f85149';
}

// Tally an alert array into { count, critical, high, medium, low, max_severity }.
// `getSeverity(alert)` returns one of 'critical' | 'high' | 'medium' | 'low' (or
// anything else / falsy, which is ignored). Single source of truth for both the
// observe.js fetchers and the report-portfolio.js inline aggregations.
export function getAlertSummary(alerts, getSeverity) {
  const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
  let critical = 0, high = 0, medium = 0, low = 0;
  let maxSeverity = null;
  for (const a of alerts) {
    const sev = getSeverity(a);
    if (sev === 'critical') critical++;
    else if (sev === 'high') high++;
    else if (sev === 'medium') medium++;
    else if (sev === 'low') low++;
    if (sev && (maxSeverity === null || (severityOrder[sev] || 0) > (severityOrder[maxSeverity] || 0))) {
      maxSeverity = sev;
    }
  }
  return { count: alerts.length, critical, high, medium, low, max_severity: maxSeverity };
}

const BUG_LABELS = ['bug', 'defect', 'bugfix', 'bug-fix', 'type: bug', 'type:bug', 'kind/bug'];
const FEATURE_LABELS = ['enhancement', 'feature', 'feature-request', 'feature request', 'type: feature', 'type:feature', 'kind/feature'];

export function isBugIssue(labels) {
  const l = Array.isArray(labels) ? labels : (labels?.labels || []);
  return l.some(item => {
    const name = typeof item === 'string' ? item : item?.name;
    return name ? BUG_LABELS.includes(name.toLowerCase()) : false;
  });
}

export function isFeatureIssue(labels) {
  const l = Array.isArray(labels) ? labels : (labels?.labels || []);
  return !isBugIssue(l) && l.some(item => {
    const name = typeof item === 'string' ? item : item?.name;
    return name ? FEATURE_LABELS.includes(name.toLowerCase()) : false;
  });
}

export function isReleaseExempt(repoName, config) {
  const exempt = config?.release_exempt || '';
  return exempt.split(',').map(s => s.trim()).filter(Boolean).includes(repoName);
}

export function isBotAuthor(author = '') {
  return author.includes('[bot]') || author.startsWith('app/');
}

export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n || 0);
}

export function countBy(arr) {
  const counts = {};
  for (const item of arr) counts[item] = (counts[item] || 0) + 1;
  return counts;
}

export function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

export function daysAgoISO(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

export function last12Months() {
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const label = d.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
    months.push({
      label,
      start: d.toISOString().split('T')[0],
      end: next.toISOString().split('T')[0],
    });
  }
  return months;
}

// Build the canonical per-repo snapshot shape consumed by computeHealthTier
// (via snapshotToTierInput in report-repo.js), buildActionItems, and the
// persisted repoSnapshot JSON. Each call site passes only the source data it
// has; missing inputs default to neutral values so the output is always a
// safe superset.
//
// Required inputs:
//   owner, repo            — used to populate `repository`
// Optional inputs (default to neutral values):
//   details                — entry from fetchPortfolioDetails (vulns, ci, etc)
//   meta                   — GitHub /repos/{owner}/{repo} response
//   communityProfile       — { health_percentage, files: { license, ... } }
//   releases               — array of release objects (already filtered)
//   openIssues             — array of open issue objects
//   prAuthors              — array of { author, count } (90-day merged PR authors)
//   busFactor              — precomputed bus factor (number)
//   timeToCloseMedian      — precomputed median time-to-close (number|null)
//   pushedAt               — repo pushed_at timestamp (defaults to meta?.pushed_at)
//   stars, forks           — repo basics (used when meta is missing)
export function buildRepoSnapshot({
  owner,
  repo,
  details = null,
  meta = null,
  communityProfile = null,
  releases = [],
  openIssues = [],
  prAuthors = [],
  busFactor = 0,
  timeToCloseMedian = null,
  pushedAt = null,
  stars = 0,
  forks = 0,
} = {}) {
  return {
    repository: `${owner}/${repo}`,
    meta: meta ? {
      stars: meta.stargazers_count, forks: meta.forks_count,
      watchers: meta.subscribers_count, default_branch: meta.default_branch,
    } : { stars, forks },
    issues: {
      open: openIssues.map(i => ({
        number: i.number, title: i.title, labels: i.labels.map(l => l.name),
        reactions: i.reactions?.total_count || 0, comments: i.comments,
        created_at: i.created_at, updated_at: i.updated_at,
      })),
    },
    releases: releases.map(rel => ({
      tag: rel.tag_name, published_at: rel.published_at, prerelease: rel.prerelease,
    })),
    pushed_at: pushedAt || meta?.pushed_at || null,
    license: meta?.license?.spdx_id || details?.license || null,
    community_profile: communityProfile,
    dependabot_alerts: details?.vulns || null,
    code_scanning_alerts: details?.codeScanning ?? null,
    secret_scanning_alerts: details?.secretScanning ?? null,
    ci_pass_rate: details?.ciPassRate != null ? { pass_rate: details.ciPassRate, total_runs: 0, passed: 0, failed: 0 } : null,
    sbom: details?.sbom || null,
    summary: {
      open_issues: openIssues.length,
      open_bugs: details?.open_bugs ?? null,
      blocked_issues: openIssues.filter(i => i.labels.some(l => l.name === 'blocked')).length,
      awaiting_feedback: openIssues.filter(i => i.labels.some(l => l.name.includes('feedback'))).length,
      recently_merged_prs: prAuthors.reduce((s, a) => s + a.count, 0),
      human_prs: prAuthors.filter(a => !isBotAuthor(a.author)).reduce((s, a) => s + a.count, 0),
      bot_prs: prAuthors.filter(a => isBotAuthor(a.author)).reduce((s, a) => s + a.count, 0),
      releases: releases.length,
      latest_release: releases[0]?.tag_name || 'none',
      ci_workflows: details?.ci || 0,
      bus_factor: busFactor,
      time_to_close_median: timeToCloseMedian,
    },
  };
}

// Compute health tier for a classified repo object.
// Returns { tier: 'gold'|'silver'|'bronze'|'none', checks: [{ name, passed, required_for }] }
export function computeHealthTier(r, options = {}) {
  const now = Date.now();
  const pushedAt = r.pushed_at ? new Date(r.pushed_at).getTime() : 0;
  const daysSincePush = pushedAt ? Math.floor((now - pushedAt) / 86400000) : Infinity;
  const releasedAt = r.released_at ? new Date(r.released_at).getTime() : 0;
  const daysSinceRelease = releasedAt ? Math.floor((now - releasedAt) / 86400000) : Infinity;

  const anyScannerConfigured = r.vulns != null || r.codeScanning != null || r.secretScanning != null;

  let noSecurityFindings;
  if (!anyScannerConfigured) {
    noSecurityFindings = false;
  } else {
    const dependabotOk = r.vulns == null || (r.vulns.max_severity !== 'critical' && r.vulns.max_severity !== 'high');
    const codeScanningOk = r.codeScanning == null || (r.codeScanning.max_severity !== 'critical' && r.codeScanning.max_severity !== 'high');
    const secretScanningOk = r.secretScanning == null || r.secretScanning.count === 0;
    noSecurityFindings = dependabotOk && codeScanningOk && secretScanningOk;
  }

  const checks = [
    { name: 'Has CI workflows (2+)', passed: (r.ci || 0) >= 2, required_for: 'gold' },
    { name: 'Has a license', passed: !!(r.license && r.license !== 'None'), required_for: 'silver' },
    { name: r.open_bugs != null ? 'Fewer than 10 open bugs' : 'Fewer than 20 open issues', passed: r.open_bugs != null ? r.open_bugs < 10 : (r.open_issues ?? 0) < 20, required_for: 'gold' },
    { name: 'Release in the last 90 days', passed: options.releaseExempt || daysSinceRelease <= 90, required_for: 'gold' },
    { name: 'Community health above 80%', passed: (r.communityHealth ?? -1) >= 80, required_for: 'gold' },
    { name: 'Security scanning configured', passed: anyScannerConfigured, required_for: 'gold' },
    { name: 'Zero critical/high security findings', passed: noSecurityFindings, required_for: 'gold' },
    { name: 'Has CI workflows', passed: (r.ci || 0) >= 1, required_for: 'silver' },
    { name: 'Community health above 50%', passed: (r.communityHealth ?? -1) >= 50, required_for: 'silver' },
    { name: 'Activity in the last 6 months', passed: daysSincePush <= 180, required_for: 'silver' },
    { name: 'Some activity (within 1 year)', passed: (r.commits || 0) > 0 || daysSincePush <= 365, required_for: 'bronze' },
  ];

  // Gold: all gold-required checks pass.
  const goldChecks = checks.filter(c => c.required_for === 'gold');
  const silverChecks = checks.filter(c => c.required_for === 'silver');
  const bronzeChecks = checks.filter(c => c.required_for === 'bronze');

  let tier;
  if (goldChecks.every(c => c.passed) && silverChecks.every(c => c.passed)) {
    tier = 'gold';
  } else if (silverChecks.every(c => c.passed)) {
    tier = 'silver';
  } else if (bronzeChecks.some(c => c.passed)) {
    tier = 'bronze';
  } else {
    tier = 'none';
  }

  return { tier, checks };
}

// Improvement campaign definitions, shared between the portfolio dashboard
// (buildCampaignSection in report-portfolio.js) and the MCP get_campaign_status
// tool (mcp.js). Each entry exposes:
//   - name, description: display strings
//   - applicable(repo, details): whether the repo is eligible for this campaign
//     (e.g. has the underlying data available). Defaults to all repos when omitted.
//   - test(repo, details): whether the repo currently complies.
// Predicates look up data via details[repo.name] so callers only need to pass
// a repo object exposing { name } plus a details map.
export const CAMPAIGN_DEFS = [
  {
    name: 'Community Health',
    description: 'Repos with community health score >= 80%',
    applicable: (r, details) => details[r.name]?.communityHealth != null,
    test: (r, details) => details[r.name].communityHealth >= 80,
  },
  {
    name: 'Vulnerability Free',
    description: 'Repos with zero critical/high vulnerabilities',
    applicable: (r, details) => details[r.name]?.vulns != null,
    test: (r, details) => {
      const v = details[r.name].vulns;
      return v.max_severity !== 'critical' && v.max_severity !== 'high';
    },
  },
  {
    name: 'CI Reliability',
    description: 'Repos with CI pass rate >= 90%',
    applicable: (r, details) => details[r.name]?.ciPassRate != null,
    test: (r, details) => details[r.name].ciPassRate >= 0.9,
  },
  {
    name: 'License Compliance',
    description: 'Repos with a license configured',
    test: (r, details) => {
      const lic = details[r.name]?.license;
      return !!lic && lic !== 'None';
    },
  },
  {
    name: 'Issue Templates',
    description: 'Repos with issue templates configured',
    test: (r, details) => !!details[r.name]?.hasIssueTemplate,
  },
];

// Generate a shields.io-style flat SVG badge showing the health tier.
// Usage: ![health](https://ismaelmartinez.github.io/repo-butler/badges/{repo-name}.svg)
export function generateHealthBadge(repoName, tier) {
  const label = 'health';
  const value = TIER_DISPLAY[tier] || TIER_DISPLAY.none;
  const color = TIER_COLORS[tier] || TIER_COLORS.none;

  // Approximate text widths using 6.5px per character (Verdana 11px).
  const labelWidth = Math.round(label.length * 6.5) + 10;
  const valueWidth = Math.round(value.length * 6.5) + 10;
  const totalWidth = labelWidth + valueWidth;
  const labelX = labelWidth / 2;
  const valueX = labelWidth + valueWidth / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escHtml(repoName)}: ${label} ${value}">
  <title>${escHtml(repoName)}: ${label} ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelX}" y="14">${label}</text>
    <text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${valueX}" y="14">${value}</text>
  </g>
</svg>`;
}
// refactored from report.js
