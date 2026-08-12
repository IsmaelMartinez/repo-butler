import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectStandardsGaps, detectPolicyDrift, generateUpliftProposals, detectMetricDrift, detectOpenVulnerabilities, detectTierRegressions, buildRemediationPlan, attachRemediationPlans, priorAutofixNotDrivenCount, runGovernance } from './governance.js';
import { isoWeekKey } from './store.js';

// --- Test helpers ---

function makeRepo(name, overrides = {}) {
  return { name, archived: false, fork: false, language: 'JavaScript', topics: [], pushed_at: new Date().toISOString(), ...overrides };
}

function makeDetails(repos, detailOverrides = {}) {
  const details = {};
  for (const r of repos) {
    details[r.name] = {
      license: 'MIT', ci: 2, communityHealth: 85, vulns: { count: 0, max_severity: null },
      ciPassRate: 0.95, hasIssueTemplate: true, open_issues: 3, commits: 50,
      released_at: new Date().toISOString(),
      ...detailOverrides[r.name],
    };
  }
  return details;
}

// --- detectStandardsGaps ---

describe('detectStandardsGaps', () => {
  it('returns empty findings for empty standards', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos);
    const result = detectStandardsGaps([], repos, details);
    assert.equal(result.findings.length, 0);
    assert.equal(result.summary.total, 0);
  });

  it('detects non-compliant repos for a universal standard', () => {
    const repos = [makeRepo('repo-a'), makeRepo('repo-b'), makeRepo('repo-c')];
    const details = makeDetails(repos, { 'repo-b': { hasIssueTemplate: false } });
    const standards = [{ tool: 'issue-form-templates', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['repo-b']);
    assert.deepEqual(result.findings[0].compliant, ['repo-a', 'repo-c']);
    assert.equal(result.findings[0].type, 'standards-gap');
  });

  it('returns no findings when all repos comply', () => {
    const repos = [makeRepo('repo-a'), makeRepo('repo-b')];
    const details = makeDetails(repos);
    const standards = [{ tool: 'license', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 0);
  });

  it('filters by ecosystem scope', () => {
    const repos = [
      makeRepo('js-app', { language: 'JavaScript', topics: ['nodejs'] }),
      makeRepo('go-svc', { language: 'Go', topics: ['golang'] }),
    ];
    const details = makeDetails(repos, {
      'js-app': { hasIssueTemplate: false },
      'go-svc': { hasIssueTemplate: false },
    });
    // ecosystem-scoped to javascript — only js-app should be checked
    // But detectEcosystem needs 2-of-3 signals: language + topics match for js-app
    const standards = [{ tool: 'issue-form-templates', scope: { type: 'ecosystem', language: 'javascript' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['js-app']);
    // go-svc should not be in the findings at all
    assert.ok(!result.findings[0].nonCompliant.includes('go-svc'));
    assert.ok(!result.findings[0].compliant.includes('go-svc'));
  });

  it('skips excluded repos', () => {
    const repos = [makeRepo('repo-a'), makeRepo('repo-b')];
    const details = makeDetails(repos, { 'repo-b': { hasIssueTemplate: false } });
    const standards = [{ tool: 'issue-form-templates', scope: { type: 'universal' }, exclude: ['repo-b'] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 0); // repo-b excluded, repo-a compliant
  });

  it('skips archived repos', () => {
    const repos = [makeRepo('active'), makeRepo('old', { archived: true })];
    const details = makeDetails(repos, { old: { hasIssueTemplate: false } });
    const standards = [{ tool: 'issue-form-templates', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 0);
  });

  it('skips forked repos', () => {
    const repos = [makeRepo('original'), makeRepo('forked', { fork: true })];
    const details = makeDetails(repos, { forked: { hasIssueTemplate: false } });
    const standards = [{ tool: 'issue-form-templates', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 0);
  });

  it('calculates adoption rate correctly', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d')];
    const details = makeDetails(repos, { c: { hasIssueTemplate: false }, d: { hasIssueTemplate: false } });
    const standards = [{ tool: 'issue-form-templates', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings[0].adoptionRate, 0.5); // 2/4
  });

  it('assigns high priority for <50% adoption', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c')];
    const details = makeDetails(repos, { a: { hasIssueTemplate: false }, b: { hasIssueTemplate: false } });
    const standards = [{ tool: 'issue-form-templates', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings[0].priority, 'high');
  });

  it('assigns low priority for >=80% adoption', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d'), makeRepo('e')];
    const details = makeDetails(repos, { e: { hasIssueTemplate: false } });
    const standards = [{ tool: 'issue-form-templates', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings[0].adoptionRate, 0.8); // 4/5
    assert.equal(result.findings[0].priority, 'low');
  });

  it('skips unknown tool names', () => {
    const repos = [makeRepo('a')];
    const details = makeDetails(repos);
    const standards = [{ tool: 'unknown-tool', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 0);
  });

  it('detects dependabot-actions gaps', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, { b: { vulns: null } });
    const standards = [{ tool: 'dependabot-actions', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
  });

  it('detects code-scanning gaps', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { codeScanning: { count: 0, max_severity: null } },
      b: { codeScanning: null },
    });
    const standards = [{ tool: 'code-scanning', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, ['a']);
  });

  it('detects secret-scanning gaps', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { secretScanning: { count: 0 } },
      b: { secretScanning: null },
    });
    const standards = [{ tool: 'secret-scanning', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, ['a']);
  });

  it('detects dependabot-auto-merge gaps', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { hasAutoMergeWorkflow: true },
      b: { hasAutoMergeWorkflow: false },
    });
    const standards = [{ tool: 'dependabot-auto-merge', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, ['a']);
  });

  it('attaches the allowAutoMerge advisory per non-compliant repo', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { hasAutoMergeWorkflow: true, allowAutoMerge: true },
      b: { hasAutoMergeWorkflow: false, allowAutoMerge: false },
    });
    const standards = [{ tool: 'dependabot-auto-merge', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].repoAutoMerge.b, false);
  });

  it('detects codeowners gaps', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { hasCodeowners: true },
      b: { hasCodeowners: false },
    });
    const standards = [{ tool: 'codeowners', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, ['a']);
  });

  it('detects security-md gaps', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { hasSecurityPolicy: true },
      b: { hasSecurityPolicy: false },
    });
    const standards = [{ tool: 'security-md', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
  });

  it('detects release-cadence gaps (missing release automation workflow)', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { hasReleaseWorkflow: true },
      b: { hasReleaseWorkflow: false },
    });
    const standards = [{ tool: 'release-cadence', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, ['a']);
  });

  it('detects osv-scanner gaps (missing the templated scanner workflow)', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { hasOsvScanner: true },
      b: { hasOsvScanner: false },
    });
    const standards = [{ tool: 'osv-scanner', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, ['a']);
  });

  it('treats an absent hasOsvScanner field as unknown, counting it in neither array', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    // 'a' has a details entry but no hasOsvScanner key: the repo was looked at,
    // the workflow listing was not readable. Not evidence of absence.
    const details = makeDetails(repos, { b: { hasOsvScanner: false } });
    const standards = [{ tool: 'osv-scanner', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, []);
  });

  it('emits no osv-scanner finding when no repo has a details entry', () => {
    const repos = [makeRepo('a')];
    const standards = [{ tool: 'osv-scanner', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, {}); // nothing applicable
    assert.equal(result.findings.length, 0);
    assert.equal(result.summary.gaps, 0);
  });

  it('reports only an explicit hasOsvScanner false as non-compliant across the tri-state', () => {
    const repos = [makeRepo('yes'), makeRepo('no'), makeRepo('unknown')];
    const details = makeDetails(repos, {
      yes: { hasOsvScanner: true },
      no: { hasOsvScanner: false },
      unknown: { hasOsvScanner: null },
    });
    const standards = [{ tool: 'osv-scanner', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].compliant, ['yes']);
    assert.deepEqual(result.findings[0].nonCompliant, ['no']);
    // The unknown is excluded from the denominator: 1/2, not 1/3.
    assert.equal(result.findings[0].adoptionRate, 0.5);
  });

  it('emits no finding when every applicable repo is unknown', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, { a: { hasOsvScanner: null }, b: { hasOsvScanner: null } });
    const standards = [{ tool: 'osv-scanner', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 0);
    assert.equal(result.summary.gaps, 0);
  });

  it('excludes a repo with no details entry from every standard, not just osv-scanner', () => {
    // fetchPortfolioDetails stops at PORTFOLIO_DETAIL_LIMIT, so an eligible repo
    // past the cap has no details entry at all. It must not be reported
    // non-compliant on a standard nobody checked it against.
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('unfetched')];
    const details = makeDetails([repos[0], repos[1]], {
      a: { hasCodeowners: true },
      b: { hasCodeowners: false },
    });
    const standards = [{ tool: 'codeowners', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, ['a']);
    assert.ok(!result.findings[0].nonCompliant.includes('unfetched'));
    assert.ok(!result.findings[0].compliant.includes('unfetched'));
    assert.equal(result.findings[0].adoptionRate, 0.5); // 1/2, unfetched not in the denominator
  });

  it('detects code-review-bot gaps (missing Copilot review ruleset)', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos, {
      a: { hasCopilotReview: true },
      b: { hasCopilotReview: false },
    });
    const standards = [{ tool: 'code-review-bot', scope: { type: 'universal' }, exclude: [] }];
    const result = detectStandardsGaps(standards, repos, details);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0].nonCompliant, ['b']);
    assert.deepEqual(result.findings[0].compliant, ['a']);
  });
});

// --- detectPolicyDrift ---

describe('detectPolicyDrift', () => {
  it('returns empty for fewer than 3 repos', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const details = makeDetails(repos);
    assert.deepEqual(detectPolicyDrift(repos, details), []);
  });

  it('detects license drift when minority diverges', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d'), makeRepo('e')];
    const details = makeDetails(repos, { e: { license: 'Apache-2.0' } });
    const findings = detectPolicyDrift(repos, details);
    const licenseDrift = findings.filter(f => f.category === 'license');
    assert.equal(licenseDrift.length, 1);
    assert.equal(licenseDrift[0].repo, 'e');
    assert.equal(licenseDrift[0].expected, 'MIT');
    assert.equal(licenseDrift[0].actual, 'Apache-2.0');
  });

  it('does not flag license drift when no clear majority (< 80%)', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d'), makeRepo('e')];
    const details = makeDetails(repos, {
      a: { license: 'MIT' }, b: { license: 'MIT' }, c: { license: 'MIT' },
      d: { license: 'Apache-2.0' }, e: { license: 'ISC' },
    });
    // MIT has 3/5 = 60% — below 80% threshold
    const findings = detectPolicyDrift(repos, details);
    assert.equal(findings.filter(f => f.category === 'license').length, 0);
  });

  it('detects CI pass rate drift', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d')];
    const details = makeDetails(repos, { d: { ciPassRate: 0.5 } });
    // Median of [0.5, 0.95, 0.95, 0.95] sorted = [0.5, 0.95, 0.95, 0.95], median = 0.95
    // 0.95 - 0.5 = 0.45 > 0.2 — flagged
    const findings = detectPolicyDrift(repos, details);
    const ciDrift = findings.filter(f => f.category === 'ci-reliability');
    assert.equal(ciDrift.length, 1);
    assert.equal(ciDrift[0].repo, 'd');
  });

  it('detects community health drift', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d')];
    const details = makeDetails(repos, { d: { communityHealth: 30 } });
    const findings = detectPolicyDrift(repos, details);
    const healthDrift = findings.filter(f => f.category === 'community-health');
    assert.equal(healthDrift.length, 1);
    assert.equal(healthDrift[0].repo, 'd');
  });

  it('skips archived and forked repos', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d', { archived: true })];
    const details = makeDetails(repos, { d: { license: 'Apache-2.0' } });
    const findings = detectPolicyDrift(repos, details);
    // d is archived — only 3 eligible repos, all MIT — no drift
    assert.equal(findings.filter(f => f.category === 'license').length, 0);
  });

  it('respects policy-drift-exempt for license category', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d'), makeRepo('e')];
    const details = makeDetails(repos, { e: { license: 'Apache-2.0' } });
    const config = { 'policy-drift-exempt': { license: 'e' } };
    const findings = detectPolicyDrift(repos, details, config);
    assert.equal(findings.filter(f => f.category === 'license').length, 0);
  });

  it('exempt repos do not skew the majority calculation', () => {
    // 4 MIT + 1 Apache non-exempt = 4/5 = 80% MIT majority (threshold met).
    // 2 GPL exempt — without exemption MIT would be 4/7 = 57% and miss the
    // 80% threshold, so f's drift would NOT be flagged. With exemption it
    // gets correctly surfaced.
    const repos = ['a','b','c','d','e','f','g'].map(n => makeRepo(n));
    const details = makeDetails(repos, {
      e: { license: 'GPL-3.0' },
      f: { license: 'Apache-2.0' },
      g: { license: 'GPL-3.0' },
    });
    const config = { 'policy-drift-exempt': { license: 'e,g' } };
    const findings = detectPolicyDrift(repos, details, config);
    const licenseDrift = findings.filter(f => f.category === 'license');
    assert.equal(licenseDrift.length, 1);
    assert.equal(licenseDrift[0].repo, 'f');
  });

  it('respects policy-drift-exempt for ci-reliability category', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d')];
    const details = makeDetails(repos, { d: { ciPassRate: 0.5 } });
    const config = { 'policy-drift-exempt': { 'ci-reliability': 'd' } };
    const findings = detectPolicyDrift(repos, details, config);
    assert.equal(findings.filter(f => f.category === 'ci-reliability').length, 0);
  });
});

// --- detectMetricDrift ---

describe('detectMetricDrift', () => {
  const fmt = (v, m) => ({ expected: `${m}`, actual: `${v}` });
  const opts = { threshold: 20, category: 'test-metric', format: fmt };

  it('flags repos more than `threshold` below the median', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d')];
    const values = { a: 90, b: 90, c: 90, d: 30 };
    const findings = detectMetricDrift(repos, r => values[r.name], opts);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].repo, 'd');
    assert.equal(findings[0].type, 'policy-drift');
    assert.equal(findings[0].category, 'test-metric');
    assert.equal(findings[0].priority, 'medium');
    assert.equal(findings[0].expected, '90');
    assert.equal(findings[0].actual, '30');
  });

  it('returns no findings when values cluster near the median', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d')];
    const values = { a: 80, b: 82, c: 85, d: 88 };
    const findings = detectMetricDrift(repos, r => values[r.name], opts);
    assert.equal(findings.length, 0);
  });

  it('excludes repos with null values from the median and from flagging', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d')];
    const values = { a: 90, b: 90, c: 90, d: null };
    const findings = detectMetricDrift(repos, r => values[r.name], opts);
    assert.equal(findings.length, 0);
  });

  it('treats threshold as strict (boundary equal is not flagged)', () => {
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c'), makeRepo('d')];
    // Median of [90,90,90,70] = 90; deviation = exactly 20 — NOT flagged (>, not >=).
    const values = { a: 90, b: 90, c: 90, d: 70 };
    const findings = detectMetricDrift(repos, r => values[r.name], opts);
    assert.equal(findings.length, 0);
    // Drop d to 69 — deviation 21 — IS flagged.
    const values2 = { ...values, d: 69 };
    const findings2 = detectMetricDrift(repos, r => values2[r.name], opts);
    assert.equal(findings2.length, 1);
    assert.equal(findings2[0].repo, 'd');
  });

  it('returns empty when fewer than 3 repos have values', () => {
    const repos = [makeRepo('a'), makeRepo('b')];
    const values = { a: 90, b: 30 };
    const findings = detectMetricDrift(repos, r => values[r.name], opts);
    assert.equal(findings.length, 0);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(detectMetricDrift([], () => 1, opts), []);
  });
});

// --- generateUpliftProposals ---

describe('generateUpliftProposals', () => {
  it('generates no proposals for gold repos', () => {
    const repos = [makeRepo('gold-repo')];
    const details = makeDetails(repos);
    const proposals = generateUpliftProposals(repos, details);
    assert.equal(proposals.length, 0);
  });

  it('generates uplift proposal for silver repo close to gold', () => {
    const repos = [makeRepo('silver-repo')];
    // Silver: has license, ci>=1, communityHealth>=50, pushed recently
    // Missing for gold: no release, communityHealth < 80
    const details = makeDetails(repos, {
      'silver-repo': { communityHealth: 60, released_at: null, ci: 1 },
    });
    const proposals = generateUpliftProposals(repos, details);
    assert.ok(proposals.length > 0);
    assert.equal(proposals[0].currentTier, 'silver');
    assert.equal(proposals[0].targetTier, 'gold');
    assert.ok(proposals[0].failingChecks.length > 0);
    assert.equal(proposals[0].priority, 'high');
  });

  it('skips repos with too many failing checks (> 3)', () => {
    const repos = [makeRepo('weak-repo')];
    const details = makeDetails(repos, {
      'weak-repo': { license: 'None', ci: 0, communityHealth: 10, vulns: null, ciPassRate: 0.3 },
    });
    const proposals = generateUpliftProposals(repos, details);
    // This repo likely has many silver checks failing — should not propose
    const silverProposals = proposals.filter(p => p.targetTier === 'silver');
    // If > 3 checks fail, no proposal is generated
    for (const p of silverProposals) {
      assert.ok(p.failingChecks.length <= 3);
    }
  });

  it('proposes bronze-to-silver uplift', () => {
    const repos = [makeRepo('bronze-repo', { pushed_at: new Date(Date.now() - 200 * 86400000).toISOString() })];
    // Bronze: has commits but pushed_at > 180 days. Missing for silver: activity, community health.
    const details = makeDetails(repos, {
      'bronze-repo': { license: 'MIT', ci: 1, communityHealth: 60, commits: 5 },
    });
    const proposals = generateUpliftProposals(repos, details);
    const bronzeProposals = proposals.filter(p => p.currentTier === 'bronze');
    if (bronzeProposals.length > 0) {
      assert.equal(bronzeProposals[0].targetTier, 'silver');
      assert.equal(bronzeProposals[0].priority, 'medium');
    }
  });

  it('skips archived and forked repos', () => {
    const repos = [makeRepo('archived', { archived: true }), makeRepo('forked', { fork: true })];
    const details = makeDetails(repos, {
      archived: { communityHealth: 10 },
      forked: { communityHealth: 10 },
    });
    const proposals = generateUpliftProposals(repos, details);
    assert.equal(proposals.length, 0);
  });

  it('includes failing check details in the proposal', () => {
    const repos = [makeRepo('almost-gold')];
    const details = makeDetails(repos, {
      'almost-gold': { communityHealth: 60 },
    });
    const proposals = generateUpliftProposals(repos, details);
    const p = proposals.find(p => p.repo === 'almost-gold');
    if (p) {
      assert.ok(p.failingChecks.every(c => c.name && c.required_for));
    }
  });
});

// --- Remediation plan contract (ADR-007 Track B stage 1) ---

describe('detectOpenVulnerabilities', () => {
  it('returns no findings when every repo is clean', () => {
    const repos = [makeRepo('repo-a'), makeRepo('repo-b')];
    const details = makeDetails(repos); // default vulns { count: 0, max_severity: null }
    assert.deepEqual(detectOpenVulnerabilities(repos, details), []);
  });

  it('flags a repo with an open high Dependabot alert as medium priority', () => {
    const repos = [makeRepo('repo-a'), makeRepo('repo-b')];
    const details = makeDetails(repos, {
      'repo-b': { vulns: { count: 1, critical: 0, high: 1, max_severity: 'high' } },
    });
    const findings = detectOpenVulnerabilities(repos, details);
    assert.equal(findings.length, 1);
    const f = findings[0];
    assert.equal(f.type, 'open-vulnerability');
    assert.equal(f.repo, 'repo-b');
    assert.deepEqual(f.sources, ['dependabot']);
    assert.equal(f.high, 1);
    assert.equal(f.critical, 0);
    assert.equal(f.priority, 'medium');
    assert.equal(f.max_severity, 'high');
  });

  it('raises a critical Dependabot alert to high priority', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, {
      'repo-a': { vulns: { count: 2, critical: 1, high: 1, max_severity: 'critical' } },
    });
    const [f] = detectOpenVulnerabilities(repos, details);
    assert.equal(f.priority, 'high');
    assert.equal(f.max_severity, 'critical');
    assert.equal(f.critical, 1);
  });

  it('treats any secret-scanning hit as high priority', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, {
      'repo-a': { vulns: { count: 0, max_severity: null }, secretScanning: { count: 2 } },
    });
    const [f] = detectOpenVulnerabilities(repos, details);
    assert.deepEqual(f.sources, ['secret-scanning']);
    assert.equal(f.secretScanning, 2);
    assert.equal(f.priority, 'high');
  });

  it('aggregates counts and sources across Dependabot and code scanning', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, {
      'repo-a': {
        vulns: { count: 1, critical: 0, high: 1, max_severity: 'high' },
        codeScanning: { count: 2, critical: 1, high: 1, max_severity: 'critical' },
      },
    });
    const [f] = detectOpenVulnerabilities(repos, details);
    assert.deepEqual(f.sources, ['dependabot', 'code-scanning']);
    assert.equal(f.critical, 1);
    assert.equal(f.high, 2);
    assert.equal(f.priority, 'high');
  });

  it('skips repos whose alert data is null (scanning off / token lacks scope) rather than flagging unknowns', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, { 'repo-a': { vulns: null, codeScanning: null, secretScanning: null } });
    assert.deepEqual(detectOpenVulnerabilities(repos, details), []);
  });

  it('ignores medium/low-only alerts (consistent with the Gold security check)', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, {
      'repo-a': { vulns: { count: 3, critical: 0, high: 0, medium: 2, low: 1, max_severity: 'medium' } },
    });
    assert.deepEqual(detectOpenVulnerabilities(repos, details), []);
  });

  it('excludes archived, fork, and test/shadow repos (eligibleRepos)', () => {
    const repos = [
      makeRepo('repo-archived', { archived: true }),
      makeRepo('repo-fork', { fork: true }),
      makeRepo('repo-shadow'),
    ];
    const details = makeDetails(repos, {
      'repo-archived': { vulns: { count: 1, high: 1, max_severity: 'high' } },
      'repo-fork': { vulns: { count: 1, high: 1, max_severity: 'high' } },
      'repo-shadow': { vulns: { count: 1, high: 1, max_severity: 'high' } },
    });
    assert.deepEqual(detectOpenVulnerabilities(repos, details), []);
  });

  it('skips a repo entirely absent from the details map', () => {
    const repos = [makeRepo('repo-a')];
    assert.deepEqual(detectOpenVulnerabilities(repos, {}), []);
  });

  // --- ADR-012 Phase 3: Dependabot autofix "in flight" annotation ---

  it('carries autofixEnabled=true from details.autofix (enabled, not paused) on a dependabot finding', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, {
      'repo-a': { vulns: { count: 1, critical: 0, high: 1, max_severity: 'high' }, autofix: { enabled: true, paused: false } },
    });
    const [f] = detectOpenVulnerabilities(repos, details);
    assert.equal(f.autofixEnabled, true);
  });

  it('carries autofixEnabled=false when autofix is off, and false when paused', () => {
    const repos = [makeRepo('off'), makeRepo('paused')];
    const details = makeDetails(repos, {
      off: { vulns: { count: 1, high: 1, max_severity: 'high' }, autofix: { enabled: false, paused: false } },
      paused: { vulns: { count: 1, high: 1, max_severity: 'high' }, autofix: { enabled: true, paused: true } },
    });
    const findings = detectOpenVulnerabilities(repos, details);
    assert.equal(findings.find(f => f.repo === 'off').autofixEnabled, false);
    assert.equal(findings.find(f => f.repo === 'paused').autofixEnabled, false, 'paused → not actively driving → false');
  });

  it('carries autofixEnabled=null when the autofix state is unreadable/absent', () => {
    const repos = [makeRepo('nullstate'), makeRepo('nofield')];
    const details = makeDetails(repos, {
      nullstate: { vulns: { count: 1, high: 1, max_severity: 'high' }, autofix: null },
      nofield: { vulns: { count: 1, high: 1, max_severity: 'high' } }, // no autofix key at all
    });
    const findings = detectOpenVulnerabilities(repos, details);
    assert.equal(findings.find(f => f.repo === 'nullstate').autofixEnabled, null);
    assert.equal(findings.find(f => f.repo === 'nofield').autofixEnabled, null);
  });

  it('downgrades a dependabot-ONLY critical finding high→medium when autofix is in flight', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, {
      'repo-a': { vulns: { count: 2, critical: 1, high: 1, max_severity: 'critical' }, autofix: { enabled: true, paused: false } },
    });
    const [f] = detectOpenVulnerabilities(repos, details);
    assert.equal(f.priority, 'medium', 'in-flight remediation lowers the banner priority');
    assert.equal(f.max_severity, 'critical', 'max_severity is NOT touched — the alert is still open');
    assert.equal(f.autofixEnabled, true);
  });

  it('does NOT downgrade when autofix is off (stays high)', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, {
      'repo-a': { vulns: { count: 1, critical: 1, high: 0, max_severity: 'critical' }, autofix: { enabled: false, paused: false } },
    });
    const [f] = detectOpenVulnerabilities(repos, details);
    assert.equal(f.priority, 'high');
  });

  it('does NOT downgrade a multi-source finding even with autofix in flight (code-scanning still needs manual work)', () => {
    const repos = [makeRepo('repo-a')];
    const details = makeDetails(repos, {
      'repo-a': {
        vulns: { count: 1, critical: 1, high: 0, max_severity: 'critical' },
        codeScanning: { count: 1, critical: 1, high: 0, max_severity: 'critical' },
        autofix: { enabled: true, paused: false },
      },
    });
    const [f] = detectOpenVulnerabilities(repos, details);
    assert.deepEqual(f.sources, ['dependabot', 'code-scanning']);
    assert.equal(f.priority, 'high', 'a code-scanning source keeps priority — autofix cannot fix it');
  });

  it('does not attach autofixEnabled to code-scanning / secret-scanning-only findings', () => {
    const repos = [makeRepo('cs'), makeRepo('secret')];
    const details = makeDetails(repos, {
      cs: { vulns: { count: 0, max_severity: null }, codeScanning: { count: 1, critical: 1, high: 0, max_severity: 'critical' }, autofix: { enabled: true, paused: false } },
      secret: { vulns: { count: 0, max_severity: null }, secretScanning: { count: 1 }, autofix: { enabled: true, paused: false } },
    });
    const findings = detectOpenVulnerabilities(repos, details);
    const cs = findings.find(f => f.repo === 'cs');
    const secret = findings.find(f => f.repo === 'secret');
    assert.ok(!('autofixEnabled' in cs), 'code-scanning-only finding has no autofixEnabled field');
    assert.ok(!('autofixEnabled' in secret), 'secret-scanning-only finding has no autofixEnabled field');
    assert.equal(cs.priority, 'high');
    assert.equal(secret.priority, 'high');
  });

  it('records the in-flight distinction in the remediation rationale', () => {
    const repos = [makeRepo('on'), makeRepo('off')];
    const details = makeDetails(repos, {
      on: { vulns: { count: 1, high: 1, max_severity: 'high' }, autofix: { enabled: true, paused: false } },
      off: { vulns: { count: 1, high: 1, max_severity: 'high' }, autofix: { enabled: false, paused: false } },
    });
    const findings = attachRemediationPlans(detectOpenVulnerabilities(repos, details));
    assert.match(findings.find(f => f.repo === 'on').remediation.rationale, /in flight/i);
    assert.match(findings.find(f => f.repo === 'off').remediation.rationale, /not being driven|OFF/i);
  });
});

describe('buildRemediationPlan', () => {
  it('routes a templatable standards tool to the template executor', () => {
    const plan = buildRemediationPlan({
      type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a', 'repo-b'], adoptionRate: 0.6,
    });
    assert.equal(plan.executor, 'template');
    assert.deepEqual(plan.targetFiles, ['.github/workflows/codeql-analysis.yml']);
    assert.match(plan.intent, /code-scanning/);
    assert.match(plan.rationale, /60%/);
    assert.ok(plan.acceptanceCriteria.length >= 1);
  });

  it('routes dependabot-actions to template despite the apply.js key alias', () => {
    const plan = buildRemediationPlan({ type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['r'] });
    assert.equal(plan.executor, 'template');
    assert.deepEqual(plan.targetFiles, ['.github/dependabot.yml']);
  });

  it('routes issue-form-templates to template (a single generic form satisfies the detector)', () => {
    const plan = buildRemediationPlan({ type: 'standards-gap', tool: 'issue-form-templates', nonCompliant: ['r'], adoptionRate: 0.5 });
    assert.equal(plan.executor, 'template');
    assert.deepEqual(plan.targetFiles, ['.github/ISSUE_TEMPLATE/bug_report.yml']);
  });

  it('routes dependabot-auto-merge to template with the workflow target file', () => {
    const plan = buildRemediationPlan({ type: 'standards-gap', tool: 'dependabot-auto-merge', nonCompliant: ['r'], adoptionRate: 0.5 });
    assert.equal(plan.executor, 'template');
    assert.deepEqual(plan.targetFiles, ['.github/workflows/dependabot-auto-merge.yml']);
  });

  it('routes release-cadence to template with the release workflow target file', () => {
    const plan = buildRemediationPlan({ type: 'standards-gap', tool: 'release-cadence', nonCompliant: ['r'], adoptionRate: 0.4 });
    assert.equal(plan.executor, 'template');
    assert.deepEqual(plan.targetFiles, ['.github/workflows/release.yml']);
  });

  // Regression guard: TEMPLATABLE_TOOLS is a separate list from apply.js's
  // TEMPLATES, so a tool present in the latter but missing here falls through to
  // executor 'manual' and no PR is ever opened.
  it('routes osv-scanner to template with the scanner workflow target file', () => {
    const plan = buildRemediationPlan({ type: 'standards-gap', tool: 'osv-scanner', nonCompliant: ['r'] });
    assert.equal(plan.executor, 'template');
    assert.deepEqual(plan.targetFiles, ['.github/workflows/osv-scanner.yml']);
  });

  it('routes a content-tailored standards tool to the agent executor', () => {
    const plan = buildRemediationPlan({ type: 'standards-gap', tool: 'contributing-guide', nonCompliant: ['r'] });
    assert.equal(plan.executor, 'agent');
    assert.deepEqual(plan.targetFiles, ['CONTRIBUTING.md']);
  });

  it('keeps ci-workflows agent-routed (a static CI workflow cannot be safely generic)', () => {
    const plan = buildRemediationPlan({ type: 'standards-gap', tool: 'ci-workflows', nonCompliant: ['r'] });
    assert.equal(plan.executor, 'agent');
  });

  it('routes license and secret-scanning gaps to the manual executor', () => {
    assert.equal(buildRemediationPlan({ type: 'standards-gap', tool: 'license', nonCompliant: ['r'] }).executor, 'manual');
    assert.equal(buildRemediationPlan({ type: 'standards-gap', tool: 'secret-scanning', nonCompliant: ['r'] }).executor, 'manual');
  });

  it('routes code-review-bot to the settings executor with no target file (ruleset toggle, not a committed file)', () => {
    const plan = buildRemediationPlan({ type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['r'], adoptionRate: 0.4 });
    assert.equal(plan.executor, 'settings');
    assert.deepEqual(plan.targetFiles, []);
  });

  it('routes tier-uplift to agent with one acceptance criterion per failing check', () => {
    const plan = buildRemediationPlan({
      type: 'tier-uplift', repo: 'repo-x', currentTier: 'silver', targetTier: 'gold',
      failingChecks: [{ name: 'check-1' }, { name: 'check-2' }],
    });
    assert.equal(plan.executor, 'agent');
    assert.equal(plan.acceptanceCriteria.length, 2);
    assert.match(plan.intent, /silver to gold/);
  });

  it('routes policy-drift to manual, with a LICENSE target only for license drift', () => {
    const license = buildRemediationPlan({ type: 'policy-drift', category: 'license', repo: 'r', expected: 'MIT', actual: 'GPL-3.0' });
    assert.equal(license.executor, 'manual');
    assert.deepEqual(license.targetFiles, ['LICENSE']);
    const ci = buildRemediationPlan({ type: 'policy-drift', category: 'ci-reliability', repo: 'r', expected: '90%', actual: '60%' });
    assert.deepEqual(ci.targetFiles, []);
  });

  it('routes dependabot-stale to manual and reports the oldest PR age', () => {
    const plan = buildRemediationPlan({
      type: 'dependabot-stale', repo: 'r', stalePRs: [{ number: 1, age: 35 }, { number: 2, age: 70 }],
    });
    assert.equal(plan.executor, 'manual');
    assert.match(plan.rationale, /70 days/);
  });

  it('routes open-vulnerability to manual and reports counts + sources', () => {
    const plan = buildRemediationPlan({
      type: 'open-vulnerability', repo: 'r', critical: 2, high: 1, secretScanning: 3, sources: ['dependabot', 'secret-scanning'],
    });
    assert.equal(plan.executor, 'manual');
    assert.deepEqual(plan.targetFiles, []);
    assert.match(plan.rationale, /2 critical/);
    assert.match(plan.rationale, /3 secret-scanning/);
    assert.match(plan.rationale, /dependabot/);
  });

  it('falls back to manual for an unknown finding type', () => {
    const plan = buildRemediationPlan({ type: 'something-new' });
    assert.equal(plan.executor, 'manual');
    assert.deepEqual(plan.acceptanceCriteria, []);
  });
});

describe('attachRemediationPlans', () => {
  it('adds a remediation plan to every finding without mutating the input', () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['a'] },
      { type: 'tier-uplift', repo: 'b', currentTier: 'bronze', targetTier: 'silver', failingChecks: [] },
    ];
    const result = attachRemediationPlans(findings);
    assert.equal(result.length, 2);
    assert.ok(result.every(f => f.remediation && f.remediation.executor));
    assert.equal(findings[0].remediation, undefined, 'input findings must not be mutated');
  });

  it('returns an empty array for non-array input', () => {
    assert.deepEqual(attachRemediationPlans(null), []);
  });
});

// --- priorAutofixNotDrivenCount (ADR-012 dashboard trend) ---

describe('priorAutofixNotDrivenCount', () => {
  it('counts dependabot-sourced not-driven findings in a prior weekly snapshot', () => {
    const priorWeekly = {
      _week: '2026-W29',
      findings: [
        { type: 'open-vulnerability', repo: 'a', sources: ['dependabot'], autofixEnabled: false },
        { type: 'open-vulnerability', repo: 'b', sources: ['dependabot'], autofixEnabled: false },
        { type: 'open-vulnerability', repo: 'c', sources: ['dependabot'], autofixEnabled: true },
        { type: 'open-vulnerability', repo: 'd', sources: ['code-scanning'] },
        { type: 'standards-gap', tool: 'license' },
      ],
    };
    assert.equal(priorAutofixNotDrivenCount(priorWeekly), 2);
  });

  it('returns null when there is no prior snapshot', () => {
    assert.equal(priorAutofixNotDrivenCount(null), null);
    assert.equal(priorAutofixNotDrivenCount(undefined), null);
  });

  it('returns null when the prior snapshot has no findings array', () => {
    assert.equal(priorAutofixNotDrivenCount({ _week: '2026-W29' }), null);
  });

  it('returns 0 (not null) when the prior snapshot had findings but none were not-driven', () => {
    const priorWeekly = { findings: [{ type: 'open-vulnerability', repo: 'a', sources: ['dependabot'], autofixEnabled: true }] };
    assert.equal(priorAutofixNotDrivenCount(priorWeekly), 0);
  });
});

// --- runGovernance — autofix-not-driven trend wiring ---

describe('runGovernance — governance-weekly trend persistence', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('reads the prior governance-weekly snapshot before writing this run\'s, and stashes the prior not-driven count on context', async () => {
    // auditDependabot's gh.paginate('/pulls') is the only network call runGovernance
    // makes once context.repoDetails is pre-supplied (skips fetchPortfolioDetails).
    // An empty page ends pagination immediately with no stale Dependabot PRs.
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: new Map(),
      json: async () => [], text: async () => '[]',
    });

    const repos = [makeRepo('repo-a')];
    const repoDetails = makeDetails(repos, {
      'repo-a': { vulns: { count: 1, critical: 0, high: 1, max_severity: 'high' }, autofix: { enabled: false, paused: false } },
    });

    const priorWeekly = {
      _week: '2026-W29',
      findings: [
        { type: 'open-vulnerability', repo: 'repo-a', sources: ['dependabot'], autofixEnabled: false },
        { type: 'open-vulnerability', repo: 'repo-b', sources: ['dependabot'], autofixEnabled: false },
      ],
    };
    const calls = [];
    const store = {
      readRepoCache: async () => null,
      readLatestGovernanceWeekly: async () => { calls.push('read'); return priorWeekly; },
      writeGovernanceWeekly: async (findings) => { calls.push('writeWeekly'); return findings; },
      writeGovernanceFindings: async (findings) => { calls.push('writeLatest'); return findings; },
    };

    const context = { owner: 'acme', token: 'tok', portfolio: { repos }, config: {}, store, repoDetails };
    await runGovernance(context);

    assert.equal(context.priorAutofixNotDrivenCount, 2, 'both prior findings were dependabot-sourced and not-driven');
    assert.deepEqual(calls, ['read', 'writeWeekly', 'writeLatest'], 'reads the prior snapshot before either write, mirroring readLatestPortfolioWeekly ordering');
  });

  it('leaves priorAutofixNotDrivenCount null on the first run (no prior snapshot, no store)', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: new Map(),
      json: async () => [], text: async () => '[]',
    });
    const repos = [makeRepo('repo-a')];
    const repoDetails = makeDetails(repos);
    const context = { owner: 'acme', token: 'tok', portfolio: { repos }, config: {}, store: null, repoDetails };

    await runGovernance(context);

    assert.equal(context.priorAutofixNotDrivenCount, undefined, 'no store means no persistence pass runs at all');
  });
});

// Regression guard for a real mistake, not a hypothetical one.
//
// An earlier attempt (PR #347, abandoned) fed `[...portfolio.repos,
// ...portfolio.privateRepos]` into these detectors and tagged the resulting
// findings `private: true`. An adversarial review found 14 live disclosure
// paths, because `context.governanceFindings` and `context.repoDetails` are
// shared across phases and reach GitHub Pages, the LLM prompt and the propose
// soak ledger without passing any filter. Worse, `detectStandardsGaps` emits
// ONE finding per standard carrying `nonCompliant`/`compliant` ARRAYS of repo
// names — so a finding "about" a public standard silently contained the private
// name, and per-finding tagging could never have caught it.
//
// The fix was to keep private repos out of governance entirely (they are handled
// by private-watch.js). This test fails if anyone wires them back in.
describe('runGovernance — private repos must never enter the governance pipeline', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('produces no finding referencing a private repo, in any field', async () => {
    // Return a long-stale Dependabot PR for every repo, so auditDependabot also
    // produces a finding. With an empty page it emits nothing and this guard
    // would not cover the audit path at all.
    // Two PRs per repo: one Dependabot (feeds auditDependabot) and one on a
    // repo-butler/* branch (feeds auditButlerPRs). Without the second, the
    // butler-PR detector never fires during this guard and its contribution to
    // the findings — including the private repo's name in a `repo` field —
    // would go unchecked as the phase grows.
    const stalePR = [{
      number: 1,
      title: 'chore(deps): bump something',
      user: { login: 'dependabot[bot]' },
      created_at: new Date(Date.now() - 90 * 86400000).toISOString(),
    }, {
      number: 2,
      title: 'chore: add codeowners configuration',
      user: { login: 'repo-butler-app[bot]' },
      created_at: new Date(Date.now() - 90 * 86400000).toISOString(),
      head: { ref: 'repo-butler/apply-codeowners', sha: 'deadbeef' },
      body: '*Opened automatically by [Repo Butler](https://github.com/IsmaelMartinez/repo-butler)*',
      labels: [],
      draft: false,
    }];
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      const body = u.includes('/pulls') ? stalePR : [];
      return { ok: true, status: 200, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) };
    };

    const CANARY = 'ZZLEAKCANARYZZ';
    // Three compliant public repos, so a 3-of-4 majority (>= the 0.6 threshold)
    // exists for detectPolicyDrift to infer an implicit standard from.
    const repos = [makeRepo('repo-a'), makeRepo('repo-b'), makeRepo('repo-c')];
    const privateRepos = [makeRepo(CANARY)];

    // Details ARE supplied for the private repo, and it is made non-compliant on
    // every axis each detector reads — missing license, no CI, no issue template,
    // low community health, AND open high-severity vulns. Any detector that
    // reaches it is then guaranteed to emit its name. Withholding details, or
    // making it compliant, would let this guard pass for the wrong reason —
    // which an earlier version of this test did.
    const repoDetails = makeDetails([...repos, ...privateRepos], {
      [CANARY]: {
        license: null,
        ci: 0,
        communityHealth: 10,
        hasIssueTemplate: false,
        ciPassRate: 0.1,
        vulns: { count: 3, critical: 0, high: 3, max_severity: 'high' },
      },
    });

    const written = [];
    const store = {
      readRepoCache: async () => null,
      readLatestGovernanceWeekly: async () => null,
      writeGovernanceWeekly: async (f) => { written.push(f); },
      writeGovernanceFindings: async (f) => { written.push(f); },
    };

    // A real standards config, so detectStandardsGaps actually runs. With an
    // empty config no standards are parsed, no findings are produced, and the
    // guard would pass vacuously.
    const config = {
      standards: {
        license: 'universal',
        'ci-workflows': 'universal',
        'issue-form-templates': 'universal',
      },
    };

    const context = {
      owner: 'acme', token: 'tok',
      portfolio: { repos, privateRepos },
      config, store, repoDetails,
    };
    await runGovernance(context);

    // Assert the butler-PR path actually FIRED before asserting it stayed
    // clean. Without this the guard passes just as happily when the detector
    // emits nothing at all — renaming the branch prefix would silently stop
    // covering this path while the canary assertion below still went green,
    // which is the "passes for the wrong reason" failure this file's earlier
    // version already suffered once.
    assert.ok(context.governanceFindings.some(f => f.type === 'stale-butler-pr'),
      'the stale-butler-pr detector must have run for this guard to mean anything');

    // Serialised, so the canary is caught wherever it hides — `repo`, a
    // `nonCompliant`/`compliant` array, a remediation plan, a rationale string.
    const serialised = JSON.stringify(context.governanceFindings);
    assert.ok(!serialised.includes(CANARY),
      `private repo name reached context.governanceFindings:\n${serialised}`);

    for (const batch of written) {
      assert.ok(!JSON.stringify(batch).includes(CANARY),
        'private repo name reached a data-branch write');
    }
  });
});

// --- detectTierRegressions (G7 — the Gold ratchet) ---
//
// The mirror image of tier-uplift: uplift fires on opportunity, tier-regression
// fires on loss. Detection is a pure diff of two portfolio-weekly-shaped
// snapshots via the same detectTierChanges core the dashboard's "since the last
// run" strip uses. The real-data case uses the committed W26/W27 snapshots from
// the data branch — the 2026-07 release-drift week, when nine repos crossed the
// 90-day release boundary at once and fell gold→silver. (The plan of record
// originally named the W29/W30 pair with six regressions, but weekly files are
// overwritten intra-week and that pair healed to uplifts-only before this
// landed; W26/W27 is the pair that still carries real regressions.)

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function weeklySnap(tiers) {
  const repos = {};
  for (const [name, tier] of Object.entries(tiers)) repos[name] = { computed: { tier } };
  return { schema_version: 'v1', repos };
}

describe('detectTierRegressions', () => {
  it('emits exactly one tier-regression finding for a fabricated gold-to-silver pair', () => {
    const prior = { ...weeklySnap({ 'repo-a': 'gold', 'repo-b': 'silver' }), _week: '2026-W26' };
    const current = weeklySnap({ 'repo-a': 'silver', 'repo-b': 'silver' });

    const findings = detectTierRegressions(current, prior);

    assert.deepEqual(findings, [{
      type: 'tier-regression',
      repo: 'repo-a',
      previousTier: 'gold',
      currentTier: 'silver',
      priorWeek: '2026-W26',
      priority: 'high',
    }]);
  });

  it('emits no tier-regression finding for an unchanged pair', () => {
    const tiers = { 'repo-a': 'gold', 'repo-b': 'silver', 'repo-c': 'bronze' };
    assert.deepEqual(detectTierRegressions(weeklySnap(tiers), weeklySnap(tiers)), []);
  });

  it('ignores uplifts — tier-regression fires on loss, never on recovery', () => {
    const prior = weeklySnap({ 'repo-a': 'silver' });
    const current = weeklySnap({ 'repo-a': 'gold' });
    assert.deepEqual(detectTierRegressions(current, prior), []);
  });

  it('emits no tier-regression finding on the first run (no prior weekly snapshot)', () => {
    assert.deepEqual(detectTierRegressions(weeklySnap({ 'repo-a': 'gold' }), null), []);
  });

  it('excludes shadow/test repos from tier-regression findings like every other detector', () => {
    const prior = weeklySnap({ 'real-app': 'gold', 'my-shadow-env': 'gold', 'test-repo-lab': 'gold' });
    const current = weeklySnap({ 'real-app': 'silver', 'my-shadow-env': 'silver', 'test-repo-lab': 'silver' });

    const findings = detectTierRegressions(current, prior);

    assert.deepEqual(findings.map(f => f.repo), ['real-app'],
      'REPO_EXCLUSION_PATTERNS repos never surface governance findings');
  });

  it('grades a tier-regression that did not fall from gold as medium priority', () => {
    const findings = detectTierRegressions(weeklySnap({ 'repo-a': 'bronze' }), weeklySnap({ 'repo-a': 'silver' }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].priority, 'medium');
    assert.equal(findings[0].priorWeek, null);
  });

  it('reports the nine real gold-to-silver tier-regressions in the W26/W27 release-drift pair', () => {
    const w26 = JSON.parse(readFileSync(join(FIXTURE_DIR, 'portfolio-weekly-2026-W26.json'), 'utf8'));
    const w27 = JSON.parse(readFileSync(join(FIXTURE_DIR, 'portfolio-weekly-2026-W27.json'), 'utf8'));
    w26._week = '2026-W26';

    const findings = detectTierRegressions(w27, w26);

    assert.equal(findings.length, 9, 'the release-drift week regressed exactly nine repos');
    for (const f of findings) {
      assert.equal(f.type, 'tier-regression');
      assert.equal(f.previousTier, 'gold');
      assert.equal(f.currentTier, 'silver');
      assert.equal(f.priority, 'high');
      assert.equal(f.priorWeek, '2026-W26');
    }
    assert.deepEqual(findings.map(f => f.repo).sort(), [
      'ai-model-advisor', 'betis-escocia', 'bonnie-wee-plot',
      'github-issue-triage-bot', 'ismaelmartinez.me.uk', 'repo-butler',
      'teams-for-linux', 'wifisentinel', 'yourear',
    ]);
  });
});

describe('buildRemediationPlan — tier-regression', () => {
  it('maps a tier-regression finding to a manual plan naming the lost tier', () => {
    const plan = buildRemediationPlan({
      type: 'tier-regression', repo: 'repo-a',
      previousTier: 'gold', currentTier: 'silver',
      priorWeek: '2026-W26', priority: 'high',
    });
    assert.equal(plan.executor, 'manual');
    assert.match(plan.intent, /repo-a/);
    assert.match(plan.rationale, /gold/);
    assert.match(plan.rationale, /silver/);
    assert.ok(plan.acceptanceCriteria.length > 0, 'a tier-regression plan states how to verify recovery');
  });
});

describe('runGovernance — tier-regression wiring', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('merges tier-regression findings diffed against the prior-week portfolio snapshot', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: new Map(),
      json: async () => [], text: async () => '[]',
    });

    const repos = [makeRepo('repo-a')];
    // A critical open alert caps repo-a below gold today, whatever the other checks say.
    const repoDetails = makeDetails(repos, {
      'repo-a': { vulns: { count: 1, critical: 1, high: 0, max_severity: 'critical' } },
    });

    const reads = [];
    const store = {
      readRepoCache: async () => null,
      readLatestGovernanceWeekly: async () => null,
      writeGovernanceWeekly: async () => {},
      writeGovernanceFindings: async () => {},
      readLatestPortfolioWeekly: async (opts) => {
        reads.push(opts);
        return { ...weeklySnap({ 'repo-a': 'gold' }), _week: '2026-W26' };
      },
    };

    const context = { owner: 'acme', token: 'tok', portfolio: { repos }, config: {}, store, repoDetails };
    await runGovernance(context);

    const regressions = context.governanceFindings.filter(f => f.type === 'tier-regression');
    assert.equal(regressions.length, 1);
    assert.equal(regressions[0].repo, 'repo-a');
    assert.equal(regressions[0].previousTier, 'gold');
    assert.equal(regressions[0].priorWeek, '2026-W26');
    assert.ok(regressions[0].remediation, 'tier-regression findings carry the ADR-007 remediation plan');
    assert.equal(reads.length, 1, 'reads the prior portfolio weekly exactly once');
    assert.equal(reads[0]?.beforeWeek, isoWeekKey(new Date()),
      'diffs against the previous WEEK, not the current-week file an earlier run today already overwrote');
  });
});

// --- G13: the stalled-alert detector's wiring into the phase ---
//
// The wiring is the part that has silently failed before: a finding type can be
// detected correctly and still never reach the prompt, the schema or the page.
// These cover the governance end of it — the detector's own behaviour lives in
// stalled-alert.test.js.

describe('runGovernance — stalled-alert wiring', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  // One open Dependabot alert, old enough and severe enough to qualify.
  const staleAlert = [{
    number: 153,
    state: 'open',
    created_at: new Date(Date.now() - 40 * 86400000).toISOString(),
    dependency: {
      package: { ecosystem: 'npm', name: 'http-proxy-middleware' },
      manifest_path: 'docs-site/package-lock.json',
    },
    security_vulnerability: { severity: 'medium', first_patched_version: { identifier: '2.0.10' } },
    security_advisory: { ghsa_id: 'GHSA-64mm-vxmg-q3vj', summary: 'ZZADVISORYTEXTZZ' },
  }];

  function mockFetch() {
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      const body = u.includes('/dependabot/alerts') ? staleAlert : [];
      return { ok: true, status: 200, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) };
    };
  }

  const store = {
    readRepoCache: async () => null,
    readLatestGovernanceWeekly: async () => null,
    writeGovernanceWeekly: async () => {},
    writeGovernanceFindings: async () => {},
  };

  it('merges stalled-alert findings into the phase output with a remediation plan', async () => {
    mockFetch();
    const repos = [makeRepo('repo-a')];
    const context = {
      owner: 'acme', token: 'tok', portfolio: { repos }, config: {}, store,
      repoDetails: makeDetails(repos),
    };

    await runGovernance(context);

    const stalled = context.governanceFindings.filter(f => f.type === 'stalled-alert');
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0].repo, 'repo-a');
    assert.equal(stalled[0].alerts[0].number, 153);
    // The contents API is mocked to an array, so getFileContent yields null —
    // exactly the unreadable-input case, which must classify unknown and STILL
    // report the finding.
    assert.equal(stalled[0].alerts[0].classification, 'unknown');
    assert.ok(stalled[0].remediation, 'stalled-alert findings carry the ADR-007 remediation plan');
    assert.equal(stalled[0].remediation.executor, 'manual');
  });

  it('keeps advisory text out of every stalled-alert finding field', async () => {
    mockFetch();
    const repos = [makeRepo('repo-a')];
    const context = {
      owner: 'acme', token: 'tok', portfolio: { repos }, config: {}, store,
      repoDetails: makeDetails(repos),
    };

    await runGovernance(context);

    const stalled = context.governanceFindings.filter(f => f.type === 'stalled-alert');
    assert.equal(stalled.length, 1, 'the guard is worthless unless the detector actually fired');
    assert.ok(!JSON.stringify(stalled).includes('ZZADVISORYTEXTZZ'),
      'advisory summaries are attacker-controlled prose and must never enter a finding');
  });

  it('never runs the stalled-alert detector over private repos', async () => {
    mockFetch();
    const CANARY = 'ZZPRIVATECANARYZZ';
    const repos = [makeRepo('repo-a')];
    const privateRepos = [makeRepo(CANARY)];
    const context = {
      owner: 'acme', token: 'tok',
      portfolio: { repos, privateRepos }, config: {}, store,
      repoDetails: makeDetails([...repos, ...privateRepos]),
    };

    await runGovernance(context);

    const stalled = context.governanceFindings.filter(f => f.type === 'stalled-alert');
    assert.equal(stalled.length, 1, 'the detector must have fired for this guard to mean anything');
    assert.ok(!JSON.stringify(context.governanceFindings).includes(CANARY),
      'a private repo name reached the governance findings via the stalled-alert detector');
  });
});

describe('buildRemediationPlan — stalled-alert', () => {
  const finding = {
    type: 'stalled-alert',
    repo: 'teams-for-linux',
    priority: 'medium',
    alerts: [
      { number: 153, package: 'http-proxy-middleware', ecosystem: 'npm', severity: 'medium', ageDays: 35, classification: 'reachable-by-update', detail: 'every parent range already admits it' },
      { number: 160, package: 'wee-lib', ecosystem: 'npm', severity: 'high', ageDays: 20, classification: 'unknown', detail: 'manifest or lockfile could not be read' },
    ],
  };

  it('routes a stalled-alert finding to executor manual with no target files', () => {
    // A per-repo STATE finding, like open-vulnerability and tier-regression:
    // ADR-014 authorises no write, so it must never acquire a template or
    // settings path, and it stays out of cross-repo PROPOSE.
    const plan = buildRemediationPlan(finding);
    assert.equal(plan.executor, 'manual');
    assert.deepEqual(plan.targetFiles, []);
  });

  it('states the stalled-alert count, the oldest age and the classifications in the rationale', () => {
    const plan = buildRemediationPlan(finding);
    assert.match(plan.rationale, /2/);
    assert.match(plan.rationale, /35/);
    assert.match(plan.rationale, /reachable-by-update/);
    assert.ok(plan.intent.includes('teams-for-linux'));
    assert.ok(plan.acceptanceCriteria.length > 0);
  });
});
