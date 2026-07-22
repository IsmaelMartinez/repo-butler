// Portfolio governance engine — deterministic detection of standards gaps,
// policy drift, and health tier uplift opportunities. No LLM, no API calls.
// Pure functions that receive portfolio data and return governance findings.

import { detectEcosystem } from './safety.js';
import { computeHealthTier, REPO_EXCLUSION_PATTERNS, isReleaseExempt, nextTier, isHighSeverity } from './report-shared.js';
import { createClient } from './github.js';
import { fetchPortfolioDetails } from './report-portfolio.js';
import { parseStandardsConfig } from './config.js';
import { auditDependabot } from './dependabot-audit.js';

// Thin orchestration wrapper: enriches portfolio details, runs all detectors,
// runs the dependabot audit, and persists findings to the data branch.
// Idempotent — if context.governanceFindings is already populated this turn
// (e.g. by an earlier phase), skips re-detection.
export async function runGovernance(context) {
  const { owner, token, portfolio, config, store } = context;
  if (!portfolio) return;
  if (context.governanceFindings) {
    console.log(`Governance: ${context.governanceFindings.length} findings already present, skipping detection.`);
    return;
  }

  const gh = createClient(token);

  if (!context.repoDetails) {
    const repoCache = store ? await store.readRepoCache() : null;
    context.repoDetails = await fetchPortfolioDetails(gh, owner, portfolio.repos, { cache: repoCache });
    console.log(`Enriched ${Object.keys(context.repoDetails).length} repos for governance.`);
  }

  const standards = parseStandardsConfig(config);
  const gaps = detectStandardsGaps(standards, portfolio.repos, context.repoDetails);
  const drift = detectPolicyDrift(portfolio.repos, context.repoDetails, config);
  const uplift = generateUpliftProposals(portfolio.repos, context.repoDetails, config);
  const openVulns = detectOpenVulnerabilities(portfolio.repos, context.repoDetails);
  context.governanceFindings = [...gaps.findings, ...drift, ...uplift, ...openVulns];
  console.log(`Governance: ${context.governanceFindings.length} findings (${gaps.findings.length} gaps, ${drift.length} drift, ${uplift.length} uplift, ${openVulns.length} open-vuln)`);

  const stale = await auditDependabot(gh, owner, portfolio.repos);
  if (stale.length > 0) {
    context.governanceFindings.push(...stale);
    console.log(`Dependabot audit: ${stale.length} repos with stale PRs.`);
  }

  // Attach the portable remediation-plan contract (ADR-007) to every finding
  // before persisting, so the MCP tool, dashboard, and apply phase all read the
  // executor hint and change spec.
  context.governanceFindings = attachRemediationPlans(context.governanceFindings);

  if (store) {
    // Always persist — even an empty array — so the data branch reflects
    // the current portfolio state. Otherwise stale findings linger after
    // remediation and the dashboard/MCP/apply read out-of-date data.
    await store.writeGovernanceFindings(context.governanceFindings);
  }
}

// Built-in detectors map standard tool names to compliance checks.
// Each detector receives (repo, details) and returns boolean.
const STANDARD_DETECTORS = {
  'issue-form-templates': (_repo, details) => !!details?.hasIssueTemplate,
  'dependabot-auto-merge': (_repo, details) => !!details?.hasAutoMergeWorkflow,
  'contributing-guide': (_repo, details) => (details?.communityHealth ?? 0) >= 50,
  'license': (_repo, details) => !!(details?.license && details.license !== 'None'),
  'dependabot-actions': (_repo, details) => details?.vulns != null,
  'ci-workflows': (_repo, details) => (details?.ci || 0) >= 1,
  'code-scanning': (_repo, details) => details?.codeScanning != null,
  'secret-scanning': (_repo, details) => details?.secretScanning != null,
  'codeowners': (_repo, details) => !!details?.hasCodeowners,
  'security-md': (_repo, details) => !!details?.hasSecurityPolicy,
  'code-review-bot': (_repo, details) => !!details?.hasCopilotReview,
  // Checks for release automation MACHINERY (any workflow named/pathed
  // "release"), not release recency — recency is the tier-uplift check's job.
  // The two compose: this standard installs the cadence workflow, the workflow
  // keeps the "Release in the last 90 days" gold check passing.
  'release-cadence': (_repo, details) => !!details?.hasReleaseWorkflow,
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
 * Exported so the cross-repo PROPOSE routing gate can honour the same eligibility
 * filter on a proposal's target (ADR-011 defence-in-depth) without duplicating the
 * archived/fork/exclusion predicate.
 */
export function eligibleRepos(repos) {
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
      const repoEcosystems = {};
      const repoAutoMerge = {};
      for (const name of nonCompliant) {
        const repo = applicable.find(r => r.name === name);
        const ecos = repo ? detectEcosystem(repo) : new Set();
        repoEcosystems[name] = ecos.size > 0 ? [...ecos][0] : null;
        repoAutoMerge[name] = details?.[name]?.allowAutoMerge ?? null;
      }
      findings.push({
        type: 'standards-gap',
        tool: standard.tool,
        scope: standard.scope,
        compliant,
        nonCompliant,
        repoEcosystems,
        repoAutoMerge,
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

  // Exempt repos are dropped before computing the median, mirroring the
  // license-drift handling above — otherwise an exempt outlier would skew
  // the median and either silence real drift or fabricate it.
  const repoValues = eligibleRepos
    .filter(r => !exempt?.has(r.name))
    .map(r => ({ repo: r, value: getValue(r) }))
    .filter(item => item.value != null);
  if (repoValues.length < 3) return findings;

  const sorted = repoValues.map(item => item.value).sort((a, b) => a - b);
  const med = median(sorted);

  for (const { repo, value } of repoValues) {
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
    const targetTier = nextTier(tier);
    const failingChecks = checks.filter(c => c.required_for === targetTier && !c.passed);

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

/**
 * Detect eligible repos carrying open security alerts that the portfolio is not
 * driving to resolution. A per-repo STATE finding (like dependabot-stale), not a
 * cross-repo statistic — so it routes to executor 'manual' and is never wired to
 * the templated-PR path or cross-repo PROPOSE (ADR-002/ADR-011 lane boundary).
 *
 * Fires on the same signals the Gold "Zero critical/high security findings" check
 * uses (report-shared.js), so the finding and the tier drop stay consistent:
 * a critical/high Dependabot OR code-scanning alert, or ANY secret-scanning hit.
 * Repos whose `vulns` is null (scanning off, or the token lacks the alerts scope)
 * are skipped for that source rather than flagged — an unknown is not a finding.
 *
 * `sources` records which scanner(s) fired so consumers can route remediation:
 * only `dependabot`-sourced findings are fixable by enabling Dependabot security
 * updates (the Phase-2 apply action); code-scanning/secret-scanning need a code
 * change or a secret rotation, which stay manual.
 *
 * @param {Array} repos — portfolio repos from observePortfolio()
 * @param {Object} details — enriched details from fetchPortfolioDetails()
 * @returns {Array} open-vulnerability findings
 */
export function detectOpenVulnerabilities(repos, details) {
  const eligible = eligibleRepos(repos);
  const findings = [];

  for (const r of eligible) {
    const d = details?.[r.name];
    if (!d) continue;

    const sources = [];
    let critical = 0;
    let high = 0;

    if (isHighSeverity(d.vulns)) {
      sources.push('dependabot');
      critical += d.vulns.critical || 0;
      high += d.vulns.high || 0;
    }
    if (isHighSeverity(d.codeScanning)) {
      sources.push('code-scanning');
      critical += d.codeScanning.critical || 0;
      high += d.codeScanning.high || 0;
    }
    const secretCount = d.secretScanning?.count || 0;
    if (secretCount > 0) sources.push('secret-scanning');

    if (sources.length === 0) continue;

    // A leaked secret or any critical alert is the most urgent state (high
    // priority); a high-but-not-critical alert with no secret leak is medium —
    // mirroring adoptionPriority's high/medium banding so the dashboard's
    // high-priority governance banner is not flooded by every high alert.
    const urgent = critical > 0 || secretCount > 0;
    findings.push({
      type: 'open-vulnerability',
      repo: r.name,
      critical,
      high,
      secretScanning: secretCount,
      sources,
      max_severity: urgent ? 'critical' : 'high',
      priority: urgent ? 'high' : 'medium',
    });
  }

  return findings;
}

// --- Remediation plan contract (ADR-007, Track B stage 1) ---
//
// Every finding carries a portable remediation plan: an `executor` routing hint
// plus a change spec (target files, intent, rationale, acceptance criteria).
// Deterministic — no LLM, no API calls. Both the local repo-butler-apply skill
// and any future hosted agent consume the same contract, which is what lets
// logic hardened locally lift to a hosted runtime without a rewrite.
//
// `executor` is a hint about which runtime should handle the finding, not a
// guarantee the apply phase can act on it today. Standards tools the butler can
// write as a static file route to `template`; tools needing tailored content
// route to `agent`; everything that needs human judgement routes to `manual`.

// Standards tools the butler can emit as a static templated file (apply.js has
// a generator for these), each matching an apply.js TEMPLATES key directly:
// code-scanning, dependabot-actions, issue-form-templates (a generic
// bug-report form — one file in .github/ISSUE_TEMPLATE/ satisfies the detector),
// dependabot-auto-merge (a single ecosystem-agnostic workflow that enables
// auto-merge on non-major Dependabot PRs), codeowners (a `* @<owner>` file
// routing review to the repo owner), and security-md (a generic SECURITY.md
// vulnerability-reporting policy).
// release-cadence adds a scheduled patch-release workflow (ecosystem-agnostic:
// it only reads git history and calls `gh release create`, never builds or
// publishes artifacts, so it cannot go red on heterogeneous repos).
// ci-workflows is deliberately NOT here: a static CI workflow fanned across
// heterogeneous repos would open red-CI PRs, so it stays agent-routed.
const TEMPLATABLE_TOOLS = new Set(['code-scanning', 'dependabot-actions', 'issue-form-templates', 'dependabot-auto-merge', 'codeowners', 'security-md', 'release-cadence']);

// Standards tools that need tailored, per-repo content an agent must reason about.
const AGENT_TOOLS = new Set(['contributing-guide', 'ci-workflows']);

// Standards tools the butler enables via a repository-settings write (a ruleset
// or repo flag) rather than a committed file — there is no PR to template. These
// route through the settings-apply path (apply.js applyCopilotReviewRulesets),
// which rides the same ADR-005 gates as the PR path. See ADR-009 for the PR-less
// write trust model.
const SETTINGS_TOOLS = new Set(['code-review-bot']);

// Known target file(s) per standards tool. An empty array means there is no
// file to write (a repo-settings toggle or a human/legal decision).
const STANDARD_TARGET_FILES = {
  'code-scanning': ['.github/workflows/codeql-analysis.yml'],
  'dependabot-actions': ['.github/dependabot.yml'],
  'contributing-guide': ['CONTRIBUTING.md'],
  'issue-form-templates': ['.github/ISSUE_TEMPLATE/bug_report.yml'],
  'dependabot-auto-merge': ['.github/workflows/dependabot-auto-merge.yml'],
  'codeowners': ['.github/CODEOWNERS'],
  'security-md': ['.github/SECURITY.md'],
  'release-cadence': ['.github/workflows/release.yml'],
  'ci-workflows': ['.github/workflows/ci.yml'],
  'license': ['LICENSE'],
  'secret-scanning': [],
  // code-review-bot is enabled via a repository ruleset (a copilot_code_review
  // rule), not a committed file, so there is no file to template — it routes to
  // the settings-apply path (ADR-009), not a PR.
  'code-review-bot': [],
};

function standardsExecutor(tool) {
  if (TEMPLATABLE_TOOLS.has(tool)) return 'template';
  if (SETTINGS_TOOLS.has(tool)) return 'settings';
  if (AGENT_TOOLS.has(tool)) return 'agent';
  return 'manual';
}

/**
 * Build the deterministic remediation plan for a single finding.
 * @param {object} finding — a governance finding of any type
 * @returns {{ executor: 'template'|'settings'|'agent'|'manual', targetFiles: string[], intent: string, rationale: string, acceptanceCriteria: string[] }}
 */
export function buildRemediationPlan(finding) {
  switch (finding?.type) {
    case 'standards-gap': {
      const repos = finding.nonCompliant || [];
      const pct = Math.round((finding.adoptionRate ?? 0) * 100);
      return {
        executor: standardsExecutor(finding.tool),
        targetFiles: STANDARD_TARGET_FILES[finding.tool] ?? [],
        intent: `Add ${finding.tool} to ${repos.length} non-compliant repo(s)`,
        rationale: `Standards gap: ${finding.tool} adopted by ${pct}% of in-scope repos; missing in ${repos.join(', ') || 'none'}.`,
        acceptanceCriteria: [`Every non-compliant repo passes the ${finding.tool} standard check`],
      };
    }
    case 'tier-uplift': {
      const checks = (finding.failingChecks || []).map(c => c.name);
      return {
        executor: 'agent',
        targetFiles: [],
        intent: `Uplift ${finding.repo} from ${finding.currentTier} to ${finding.targetTier}`,
        rationale: `${checks.length} check(s) block ${finding.targetTier}: ${checks.join(', ') || 'none'}.`,
        acceptanceCriteria: checks.map(name => `Check "${name}" passes`),
      };
    }
    case 'policy-drift': {
      return {
        executor: 'manual',
        targetFiles: finding.category === 'license' ? ['LICENSE'] : [],
        intent: `Align ${finding.repo} ${finding.category} with the portfolio norm`,
        rationale: `Expected ${finding.expected}, found ${finding.actual}.`,
        acceptanceCriteria: [`${finding.repo} ${finding.category} matches ${finding.expected}`],
      };
    }
    case 'dependabot-stale': {
      const prs = finding.stalePRs || [];
      // reduce, not Math.max(...spread), to avoid a stack overflow on very large arrays.
      const oldest = prs.reduce((max, p) => Math.max(max, p.age || 0), 0);
      return {
        executor: 'manual',
        targetFiles: [],
        intent: `Review ${prs.length} stale Dependabot PR(s) in ${finding.repo}`,
        rationale: `${prs.length} Dependabot PR(s) open beyond the staleness threshold (oldest ${oldest} days).`,
        acceptanceCriteria: ['Each stale Dependabot PR is merged or closed'],
      };
    }
    case 'open-vulnerability': {
      const sources = finding.sources || [];
      const secret = finding.secretScanning || 0;
      // executor 'manual': surfacing this is deterministic, but resolving it is
      // per-repo work (a dependency bump, a code fix, a secret rotation) outside
      // the templated-PR lane. The Phase-2 apply action that enables Dependabot
      // security updates consumes dependabot-sourced findings directly, exactly
      // as nudgeStaleDependabotPRs consumes the (also 'manual') dependabot-stale
      // findings — 'manual' keeps it off the generic template PR path and out of
      // cross-repo PROPOSE, not out of every apply action.
      return {
        executor: 'manual',
        targetFiles: [],
        intent: `Remediate open security alerts in ${finding.repo}`,
        rationale: `${finding.critical || 0} critical / ${finding.high || 0} high open alert(s)${secret ? ` + ${secret} secret-scanning hit(s)` : ''} from ${sources.join(', ') || 'unknown source'}.`,
        acceptanceCriteria: ['No open critical/high Dependabot or code-scanning alerts and no open secret-scanning alerts remain'],
      };
    }
    default:
      return {
        executor: 'manual',
        targetFiles: [],
        intent: `Review ${finding?.type ?? 'unknown'} finding`,
        rationale: 'No deterministic remediation mapping for this finding type.',
        acceptanceCriteria: [],
      };
  }
}

/**
 * Attach a remediation plan to every finding. Returns a new array of new
 * objects — the input findings are not mutated.
 * @param {Array} findings
 * @returns {Array} findings with a `remediation` field
 */
export function attachRemediationPlans(findings) {
  if (!Array.isArray(findings)) return [];
  return findings.map(f => ({ ...f, remediation: buildRemediationPlan(f) }));
}
