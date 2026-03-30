import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity, buildIssueBody, findDuplicatePRs, isGovernanceDeclined } from './propose.js';

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    assert.equal(jaccardSimilarity('dependency scanning pipeline', 'dependency scanning pipeline'), 1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    assert.equal(jaccardSimilarity('dependency scanning', 'workflow automation'), 0.0);
  });

  it('returns partial overlap score', () => {
    const score = jaccardSimilarity('dependency scanning pipeline', 'dependency scanning workflow');
    // shared: dependency, scanning — unique: pipeline, workflow — 2/4 = 0.5
    assert.equal(score, 0.5);
  });

  it('returns 1.0 for two empty strings', () => {
    assert.equal(jaccardSimilarity('', ''), 1.0);
  });

  it('returns 0.0 when one string is empty', () => {
    assert.equal(jaccardSimilarity('dependency scanning', ''), 0.0);
    assert.equal(jaccardSimilarity('', 'dependency scanning'), 0.0);
  });

  it('is case-insensitive', () => {
    assert.equal(
      jaccardSimilarity('Dependency Scanning', 'dependency scanning'),
      1.0,
    );
  });

  it('strips stop words before comparison', () => {
    // "add" and "implement" are stop words, so "CI pipeline" vs "CI pipeline" => 1.0
    assert.equal(jaccardSimilarity('Add CI pipeline', 'Implement CI pipeline'), 1.0);
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(jaccardSimilarity(null, null), 1.0);
    assert.equal(jaccardSimilarity(null, 'something'), 0.0);
    assert.equal(jaccardSimilarity(undefined, 'something'), 0.0);
  });

  it('returns 1.0 when both strings contain only stop words', () => {
    // After stripping stop words both sets are empty => 1.0
    assert.equal(jaccardSimilarity('add the', 'update a'), 1.0);
  });
});

describe('buildIssueBody', () => {
  it('uses plain format when no structured fields are present', () => {
    const idea = {
      body: 'This is a plain issue body.',
      priority: 'medium',
    };
    const result = buildIssueBody(idea);
    assert.ok(result.includes('This is a plain issue body.'));
    assert.ok(result.includes('---'));
    assert.ok(result.includes('*Priority: medium'));
    assert.ok(!result.includes('## Rationale'));
  });

  it('uses structured format when all Phase 4 fields are present', () => {
    const idea = {
      body: 'ignored in structured mode',
      priority: 'high',
      rationale: 'CI is slow and flaky.',
      currentState: 'Tests run sequentially in 12 minutes.',
      proposedState: 'Tests run in parallel in 3 minutes.',
      scope: 'CI configuration only',
      affectedFiles: ['.github/workflows/ci.yml', 'jest.config.js'],
    };
    const result = buildIssueBody(idea);
    assert.ok(result.includes('## Rationale\nCI is slow and flaky.'));
    assert.ok(result.includes('## Current State\nTests run sequentially in 12 minutes.'));
    assert.ok(result.includes('## Proposed State\nTests run in parallel in 3 minutes.'));
    assert.ok(result.includes('## Scope\nCI configuration only'));
    assert.ok(result.includes('## Affected Files'));
    assert.ok(result.includes('- .github/workflows/ci.yml'));
    assert.ok(result.includes('- jest.config.js'));
    assert.ok(result.includes('*Priority: high'));
  });

  it('falls back to plain format when structured fields are missing (backward compat)', () => {
    const idea = {
      body: 'Legacy idea without new fields.',
      priority: 'low',
      title: 'Some idea',
      labels: [],
    };
    const result = buildIssueBody(idea);
    assert.ok(result.includes('Legacy idea without new fields.'));
    assert.ok(!result.includes('## Rationale'));
    assert.ok(result.includes('*Priority: low'));
  });

  it('falls back to plain format when only affected_files is present but empty', () => {
    const idea = {
      body: 'Important content here.',
      priority: 'medium',
      affectedFiles: [],
    };
    const result = buildIssueBody(idea);
    assert.ok(result.includes('Important content here.'));
    assert.ok(!result.includes('## Affected Files'));
  });

  it('omits affected_files section when array is empty', () => {
    const idea = {
      priority: 'medium',
      rationale: 'Needs improvement.',
      currentState: 'Current behavior.',
      proposedState: 'Better behavior.',
      scope: 'Small scope',
      affectedFiles: [],
    };
    const result = buildIssueBody(idea);
    assert.ok(result.includes('## Rationale'));
    assert.ok(!result.includes('## Affected Files'));
  });

  it('includes only present structured fields', () => {
    const idea = {
      priority: 'medium',
      rationale: 'Just a rationale.',
    };
    const result = buildIssueBody(idea);
    assert.ok(result.includes('## Rationale\nJust a rationale.'));
    assert.ok(!result.includes('## Current State'));
    assert.ok(!result.includes('## Proposed State'));
    assert.ok(!result.includes('## Scope'));
    assert.ok(!result.includes('## Affected Files'));
    assert.ok(result.includes('*Priority: medium'));
  });
});

describe('isGovernanceDeclined', () => {
  it('returns true when governance-declined label is present', () => {
    assert.equal(isGovernanceDeclined([{ name: 'governance-declined' }]), true);
  });

  it('returns false when label is absent', () => {
    assert.equal(isGovernanceDeclined([{ name: 'bug' }, { name: 'enhancement' }]), false);
    assert.equal(isGovernanceDeclined([]), false);
  });

  it('handles non-array input', () => {
    assert.equal(isGovernanceDeclined(null), false);
    assert.equal(isGovernanceDeclined(undefined), false);
  });

  it('handles string labels', () => {
    assert.equal(isGovernanceDeclined(['governance-declined']), true);
    assert.equal(isGovernanceDeclined(['bug']), false);
  });
});

describe('findDuplicatePRs', () => {
  it('detects similar open PRs', async () => {
    const mockGh = {
      paginate: async () => [
        { number: 10, title: 'Dependabot scanning pipeline', state: 'open' },
      ],
    };
    // "Dependabot scanning pipeline" vs "Dependabot scanning pipeline"
    // After stop words: {configure, dependabot, scanning, pipeline} vs {dependabot, scanning, pipeline, setup}
    // Intersection: 3, Union: 5, Jaccard: 0.6
    const matches = await findDuplicatePRs(mockGh, 'owner', 'repo', 'Dependabot scanning pipeline');
    assert.ok(matches.length > 0);
    assert.equal(matches[0].number, 10);
    assert.equal(matches[0].state, 'open');
  });

  it('detects recently closed PRs within window', async () => {
    const recentDate = new Date(Date.now() - 30 * 86400000).toISOString();
    const mockGh = {
      paginate: async (path, opts) => {
        if (opts?.params?.state === 'closed') {
          return [{ number: 11, title: 'Dependabot scanning pipeline', state: 'closed', closed_at: recentDate, labels: [] }];
        }
        return [];
      },
    };
    const matches = await findDuplicatePRs(mockGh, 'owner', 'repo', 'Dependabot scanning pipeline', { includeClosedDays: 90 });
    assert.ok(matches.length > 0);
    assert.equal(matches[0].state, 'closed');
  });

  it('ignores closed PRs outside the window', async () => {
    const oldDate = new Date(Date.now() - 180 * 86400000).toISOString();
    const mockGh = {
      paginate: async (path, opts) => {
        if (opts?.params?.state === 'closed') {
          return [{ number: 11, title: 'Dependabot scanning pipeline', state: 'closed', closed_at: oldDate, labels: [] }];
        }
        return [];
      },
    };
    const matches = await findDuplicatePRs(mockGh, 'owner', 'repo', 'Dependabot scanning pipeline', { includeClosedDays: 90 });
    assert.equal(matches.length, 0);
  });

  it('marks declined PRs with governance-declined label', async () => {
    const recentDate = new Date(Date.now() - 10 * 86400000).toISOString();
    const mockGh = {
      paginate: async (path, opts) => {
        if (opts?.params?.state === 'closed') {
          return [{ number: 12, title: 'Dependabot scanning pipeline', state: 'closed', closed_at: recentDate, labels: [{ name: 'governance-declined' }] }];
        }
        return [];
      },
    };
    const matches = await findDuplicatePRs(mockGh, 'owner', 'repo', 'Dependabot scanning pipeline', { includeClosedDays: 90 });
    assert.ok(matches.length > 0);
    assert.equal(matches[0].declined, true);
  });

  it('handles API errors gracefully', async () => {
    const mockGh = {
      paginate: async () => { throw new Error('API error'); },
    };
    const matches = await findDuplicatePRs(mockGh, 'owner', 'repo', 'Some title');
    assert.deepEqual(matches, []);
  });
});
