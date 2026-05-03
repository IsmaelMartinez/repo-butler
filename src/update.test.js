import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadmapPrBody, buildSafePrBody, buildUpdatePrompt, redactErrorForLog } from './update.js';

describe('buildRoadmapPrBody', () => {
  it('includes the assessment when provided', () => {
    const body = buildRoadmapPrBody('All systems nominal.');
    assert.ok(body.includes('### Assessment'));
    assert.ok(body.includes('All systems nominal.'));
  });

  it('falls back to the no-assessment line when assessment is missing', () => {
    const body = buildRoadmapPrBody(null);
    assert.ok(body.includes('No assessment available'));
    assert.ok(!body.includes('### Assessment'));
  });
});

describe('buildSafePrBody', () => {
  it('returns the assessment-bearing body when validation passes', () => {
    const result = buildSafePrBody('Project is healthy. Tests passing.');
    assert.equal(result.redacted, false);
    assert.deepEqual(result.errors, []);
    assert.ok(result.body.includes('### Assessment'));
    assert.ok(result.body.includes('Project is healthy.'));
  });

  it('falls back to a safe body when the assessment contains a disallowed URL', () => {
    const malicious = 'See details at https://evil.example.com/pwn';
    const result = buildSafePrBody(malicious);
    assert.equal(result.redacted, true);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes('disallowed host')));
    // The redacted body must NOT contain the attacker-controlled URL or text.
    assert.ok(!result.body.includes('evil.example.com'));
    assert.ok(!result.body.includes('### Assessment'));
    assert.ok(result.body.includes('No assessment available'));
  });

  it('falls back to a safe body when the assessment contains an @mention', () => {
    const malicious = 'CC @attacker for review.';
    const result = buildSafePrBody(malicious);
    assert.equal(result.redacted, true);
    assert.ok(result.errors.some(e => e.includes('@mention')));
    assert.ok(!result.body.includes('@attacker'));
  });

  it('falls back to a safe body when the assessment contains a blocked secret pattern', () => {
    const malicious = 'Token leak: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.';
    const result = buildSafePrBody(malicious);
    assert.equal(result.redacted, true);
    assert.ok(result.errors.some(e => e.includes('blocked pattern')));
    assert.ok(!result.body.includes('ghp_'));
  });

  it('returns the fallback body when no assessment is provided (no validation needed)', () => {
    const result = buildSafePrBody(null);
    assert.equal(result.redacted, false);
    assert.deepEqual(result.errors, []);
    assert.ok(result.body.includes('No assessment available'));
  });

  it('allows assessments that reference github.com (core allowlisted host)', () => {
    const benign = 'Tracked in https://github.com/IsmaelMartinez/repo-butler/issues/1.';
    const result = buildSafePrBody(benign);
    assert.equal(result.redacted, false);
    assert.ok(result.body.includes('github.com'));
  });

  it('truncates over-long but benign assessments instead of dropping them', () => {
    // Verbose-but-benign assessments would previously trigger fallback
    // (length > MAX_BODY_LENGTH = 8000). Now we truncate before validation
    // so operators can distinguish "too verbose" from "blocked content".
    const verbose = 'A '.repeat(4000); // 8000 chars, all benign
    const result = buildSafePrBody(verbose);
    assert.equal(result.redacted, false, 'verbose-but-benign should not redact');
    assert.equal(result.truncated, true, 'should be marked truncated');
    assert.ok(result.body.length < 8000, 'body should be under MAX_BODY_LENGTH');
  });
});

describe('redactErrorForLog', () => {
  it('redacts the value portion of an @mention error', () => {
    const err = 'Body contains @mention: @victim — LLM should not ping real users';
    const out = redactErrorForLog(err);
    assert.ok(!out.includes('@victim'), 'mention handle should be redacted');
    assert.ok(out.includes('Body contains @mention'), 'category prefix should remain');
    assert.ok(out.includes('[REDACTED]'), 'should mark redaction');
  });

  it('redacts the value portion of a URL error', () => {
    const err = 'Body contains disallowed URL host: phishing.example.com';
    const out = redactErrorForLog(err);
    assert.ok(!out.includes('phishing.example.com'), 'host should be redacted');
    assert.ok(out.includes('disallowed URL host'), 'category prefix should remain');
  });

  it('passes errors with no colon through unchanged', () => {
    const err = 'Some unstructured warning';
    assert.equal(redactErrorForLog(err), err);
  });
});

describe('buildUpdatePrompt', () => {
  it('builds a prompt with the standard defence scaffolding', () => {
    const snapshot = {
      repository: 'owner/repo',
      package: { version: '1.0.0' },
      summary: {
        open_issues: 3,
        blocked_issues: 0,
        awaiting_feedback: 1,
        recently_merged_prs: 5,
        latest_release: 'v1.0.0',
        high_reaction_issues: [],
        top_open_labels: ['bug'],
      },
    };
    const prompt = buildUpdatePrompt('# Roadmap', snapshot, null, null);
    assert.ok(prompt.includes('BEGIN REPOSITORY DATA'));
    assert.ok(prompt.includes('END REPOSITORY DATA'));
    assert.ok(prompt.includes('owner/repo'));
  });
});
