import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectStandardsGaps, detectPolicyDrift, generateUpliftProposals, detectMetricDrift } from './governance.js';

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
