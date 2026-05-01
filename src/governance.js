// Portfolio governance engine — deterministic detection of standards gaps,
// policy drift, and health tier uplift opportunities. No LLM, no API calls.
// Pure functions that receive portfolio data and return governance findings.

import { detectEcosystem } from './safety.js';
import { computeHealthTier, REPO_EXCLUSION_PATTERNS, isReleaseExempt } from './report-shared.js';

// Built-in detectors map standard tool names to compliance checks.
// Each detector receives (repo, details) and returns boolean.
const STANDARD_DETECTORS = {
  'issue-form-templates': (_repo, details) => !!details?.hasIssueTemplate,
  'contributing-guide': (_repo, details) => (details?.communityHealth ?? 0) >= 50,
  'license': (_repo, details) => !!(details?.license && details.license !== 'None'),
  'dependabot-actions': (_repo, details) => details?.vulns != null,
  'ci-workflows': (_repo, details) => (details?.ci || 0) >= 1,
  'code-scanning': (_repo, details) => details?.codeScanning != null,
  'secret-scanning': (_repo, details) => details?.secretScanning != null,
};

// Minimum adoption rate to infer an implicit universal standard.
const MAJORITY_THRESHOLD = 0.6;

// Proper median: averages the two middle elements for even-length arrays.
function median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
}

/**
 * Filter repos to governance-eligible ones (not archived, not fork, not test/shadow).
 */
function eligibleRepos(repos) {
  return repos.filter(r =>
    !r.archived && !r.fork && !REPO_EXCLUSION_PATTERNS.some(p => r.name.includes(p))
  );
}

/**
 * Check if a repo matches an ecosystem-scoped standard.
 */
function repoMatchesScope(repo, scope) {
  if (scope.type === 'universal') return true;
  if (scope.type === 'ecosystem' && scope.language) {
    const ecosystems = detectEcosystem(repo);
    // Match case-insensitively: config uses 'javascript', detectEcosystem returns 'JavaScript'
    const lang = scope.language.toLowerCase();
    for (const eco of ecosystems) {
      if (eco.toLowerCase() === lang) return true;
    }
  }
  return false;
}

/**
 * Assign priority based on adoption rate: lower adoption = higher priority.
 */
function adoptionPriority(rate) {
  if (rate < 0.5) return 'high';
  if (rate < 0.8) return 'medium';
  return 'low';
}

/**
 * Detect which standards each repo complies with and which are missing.
 * @param {Array} standards — parsed standards from parseStandardsConfig()
 * @param {Array} repos — portfolio repos from observePortfolio()
 * @param {Object} details — enriched details from fetchPortfolioDetails()
 * @returns {{ findings: Array, summary: { total: number, gaps: number } }}
 */
export function detectStandardsGaps(standards, repos, details) {
  const eligible = eligibleRepos(repos);
  const findings = [];

  for (const standard of standards) {
    const detector = STANDARD_DETECTORS[standard.tool];
    if (!detector) continue; // Unknown tool — skip silently

    // Filter by scope and exclusions.
    const applicable = eligible.filter(r =>
      repoMatchesScope(r, standard.scope) && !standard.exclude.includes(r.name)
    );

    if (applicable.length === 0) continue;

    const compliant = [];
    const nonCompliant = [];
    for (const r of applicable) {
      if (detector(r, details?.[r.name])) {
        compliant.push(r.name);
      } else {
        nonCompliant.push(r.name);
      }
    }

    if (nonCompliant.length > 0) {
      const adoptionRate = compliant.length / applicable.length;
      findings.push({
        type: 'standards-gap',
        tool: standard.tool,
        scope: standard.scope,
        compliant,
        nonCompliant,
        adoptionRate,
        priority: adoptionPriority(adoptionRate),
      });
    }
  }

  return {
    findings,
    summary: { total: standards.length, gaps: findings.length },
  };
}

/**
 * Parse the `policy-drift-exempt` config block into per-category Sets of repo names.
 * Input: { license: 'teams-for-linux,bonnie-wee-plot', 'community-health': 'foo' }
 * Output: { license: Set('teams-for-linux','bonnie-wee-plot'), 'community-health': Set('foo') }
 */
function parseExemptions(config) {
  const raw = config?.['policy-drift-exempt'] || {};
  const out = {};
  for (const [category, value] of Object.entries(raw)) {
    out[category] = new Set(String(value).split(',').map(s => s.trim()).filter(Boolean));
  }
  return out;
}

/**
 * Detect repos that diverge from the portfolio majority on key attributes.
 * @param {Array} repos — portfolio repos
 * @param {Object} details — enriched details from fetchPortfolioDetails()
 * @param {Object} [config] — optional config carrying `policy-drift-exempt` whitelists
 * @returns {Array} drift findings
 */
export function detectPolicyDrift(repos, details, config) {
  const eligible = eligibleRepos(repos);
  if (eligible.length < 3) return []; // Too few repos for meaningful drift detection

  const exempt = parseExemptions(config);
  const findings = [];

  // License drift: flag repos that differ from the majority license.
  // Exempt repos do not count toward the majority calculation either, so a
  // single legitimate divergence (e.g. a GPL fork) cannot accidentally
  // re-anchor the majority.
  const licenseExempt = exempt.license || new Set();
  const nonExempt = eligible.filter(r => !licenseExempt.has(r.name));
  const licenseCounts = {};
  for (const r of nonExempt) {
    const lic = details?.[r.name]?.license || 'None';
    licenseCounts[lic] = (licenseCounts[lic] || 0) + 1;
  }
  const majorityLicense = Object.entries(licenseCounts)
    .sort((a, b) => b[1] - a[1])[0] || null;

  if (majorityLicense && nonExempt.length > 0 && majorityLicense[1] / nonExempt.length >= 0.8) {
    for (const r of nonExempt) {
      const lic = details?.[r.name]?.license || 'None';
      if (lic !== majorityLicense[0]) {
        findings.push({
          type: 'policy-drift',
          category: 'license',
          repo: r.name,
          expected: majorityLicense[0],
          actual: lic,
          priority: 'medium',
        });
      }
    }
  }

  // CI pass rate drift: flag repos >20pp below the portfolio median.
  findings.push(...detectMetricDrift(eligible, r => details?.[r.name]?.ciPassRate, {
    threshold: 0.2,
    category: 'ci-reliability',
    format: (rate, med) => ({ expected: `${Math.round(med * 100)}%`, actual: `${Math.round(rate * 100)}%` }),
    exempt: exempt['ci-reliability'],
  }));

  // Community health drift: flag repos >20pp below the portfolio median.
  findings.push(...detectMetricDrift(eligible, r => details?.[r.name]?.communityHealth, {
    threshold: 20,
    category: 'community-health',
    format: (health, med) => ({ expected: `${med}%`, actual: `${health}%` }),
    exempt: exempt['community-health'],
  }));

  return findings;
}

/**
 * Generic median-deviation drift detector.
 * Flags repos whose metric value falls more than `threshold` below the portfolio median.
 *
 * @param {Array} eligibleRepos — already-filtered repos (not archived/fork/excluded)
 * @param {(repo) => (number|null|undefined)} getValue — extracts the metric per repo; return null/undefined to skip
 * @param {{ threshold: number, category: string, format: (value: number, median: number) => { expected: string, actual: string }, exempt?: Set<string> }} opts
 * @returns {Array} drift findings in the same shape as the inline detectors
 */
export function detectMetricDrift(eligibleRepos, getValue, opts) {
  const { threshold, category, format, exempt } = opts;
  const findings = [];

  const repoValues = eligibleRepos
    .map(r => ({ repo: r, value: getValue(r) }))
    .filter(item => item.value != null);
  if (repoValues.length < 3) return findings;

  const sorted = repoValues.map(item => item.value).sort((a, b) => a - b);
  const med = median(sorted);

  for (const { repo, value } of repoValues) {
    if (exempt?.has(repo.name)) continue;
    if (med - value > threshold) {
      const { expected, actual } = format(value, med);
      findings.push({
        type: 'policy-drift',
        category,
        repo: repo.name,
        expected,
        actual,
        priority: 'medium',
      });
    }
  }

  return findings;
}

/**
 * Generate concrete uplift proposals for repos that could reach the next tier.
 * Only proposes repos where <= 3 checks fail for the next tier.
 * @param {Array} repos — portfolio repos
 * @param {Object} details — enriched details from fetchPortfolioDetails()
 * @returns {Array} uplift proposals
 */
export function generateUpliftProposals(repos, details, config = null) {
  const eligible = eligibleRepos(repos);
  const proposals = [];

  for (const r of eligible) {
    const d = details?.[r.name] || {};
    const classified = { ...r, ...d };
    const { tier, checks } = computeHealthTier(classified, { releaseExempt: isReleaseExempt(r.name, config) });

    if (tier === 'gold') continue; // Already at top

    // Determine which tier to target and which checks fail for it.
    let targetTier;
    let failingChecks;

    if (tier === 'silver') {
      targetTier = 'gold';
      failingChecks = checks.filter(c => c.required_for === 'gold' && !c.passed);
    } else if (tier === 'bronze') {
      targetTier = 'silver';
      failingChecks = checks.filter(c => c.required_for === 'silver' && !c.passed);
    } else {
      targetTier = 'bronze';
      failingChecks = checks.filter(c => c.required_for === 'bronze' && !c.passed);
    }

    // Only propose when the gap is small enough to be actionable.
    if (failingChecks.length > 0 && failingChecks.length <= 3) {
      proposals.push({
        type: 'tier-uplift',
        repo: r.name,
        currentTier: tier,
        targetTier,
        failingChecks: failingChecks.map(c => ({ name: c.name, required_for: c.required_for })),
        priority: tier === 'silver' ? 'high' : 'medium',
      });
    }
  }

  return proposals;
}
