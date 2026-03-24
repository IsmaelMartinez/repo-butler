import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity, buildIssueBody } from './propose.js';

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
      current_state: 'Tests run sequentially in 12 minutes.',
      proposed_state: 'Tests run in parallel in 3 minutes.',
      scope: 'CI configuration only',
      affected_files: ['.github/workflows/ci.yml', 'jest.config.js'],
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
      affected_files: [],
    };
    const result = buildIssueBody(idea);
    assert.ok(result.includes('Important content here.'));
    assert.ok(!result.includes('## Affected Files'));
  });

  it('omits affected_files section when array is empty', () => {
    const idea = {
      priority: 'medium',
      rationale: 'Needs improvement.',
      current_state: 'Current behavior.',
      proposed_state: 'Better behavior.',
      scope: 'Small scope',
      affected_files: [],
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
