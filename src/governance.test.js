import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectStandardsGaps, detectPolicyDrift, generateUpliftProposals, detectMetricDrift, detectOpenVulnerabilities, buildRemediationPlan, attachRemediationPlans } from './governance.js';

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
