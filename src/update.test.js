import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadmapPrBody, buildSafePrBody, buildUpdatePrompt, checkLengthPreservation, findOpenRoadmapPr, redactErrorForLog } from './update.js';

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

describe('findOpenRoadmapPr', () => {
  const fakeGh = (prs) => ({
    paginate: async () => prs,
  });

  it('returns the first open PR with a roadmap-update branch', async () => {
    const prs = [
      { head: { ref: 'feature/something' }, html_url: 'https://x/1' },
      { head: { ref: 'repo-butler/roadmap-update-12345' }, html_url: 'https://x/2' },
      { head: { ref: 'repo-butler/roadmap-update-67890' }, html_url: 'https://x/3' },
    ];
    const found = await findOpenRoadmapPr(fakeGh(prs), 'o', 'r');
    assert.equal(found.html_url, 'https://x/2');
  });

  it('returns null when no roadmap-update PR is open', async () => {
    const prs = [
      { head: { ref: 'feature/x' }, html_url: 'https://x/1' },
      { head: { ref: 'fix/y' }, html_url: 'https://x/2' },
    ];
    const found = await findOpenRoadmapPr(fakeGh(prs), 'o', 'r');
    assert.equal(found, null);
  });

  it('returns null when there are no open PRs at all', async () => {
    const found = await findOpenRoadmapPr(fakeGh([]), 'o', 'r');
    assert.equal(found, null);
  });

  it('ignores PRs with a similar but non-matching prefix', async () => {
    const prs = [
      { head: { ref: 'repo-butler/roadmap-other' }, html_url: 'https://x/1' },
      { head: { ref: 'roadmap-update-99' }, html_url: 'https://x/2' },
    ];
    const found = await findOpenRoadmapPr(fakeGh(prs), 'o', 'r');
    assert.equal(found, null);
  });
});

describe('buildUpdatePrompt', () => {
  const baseSnapshot = {
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

  it('builds a prompt with the standard defence scaffolding', () => {
    const prompt = buildUpdatePrompt('# Roadmap', baseSnapshot, null, null);
    assert.ok(prompt.includes('BEGIN REPOSITORY DATA'));
    assert.ok(prompt.includes('END REPOSITORY DATA'));
    assert.ok(prompt.includes('owner/repo'));
  });

  it('injects today\'s date as a literal so the LLM cannot hallucinate it', () => {
    // PR #176 produced `Last Updated: 2024-07-20` from the training cutoff.
    // The fix: inject the date deterministically.
    const fixedNow = new Date('2026-05-03T10:00:00Z');
    const prompt = buildUpdatePrompt('# Roadmap', baseSnapshot, null, null, fixedNow);
    assert.ok(prompt.includes('Today: 2026-05-03'), 'prompt should include literal today date');
  });

  it('instructs the LLM to edit, not rewrite, and to preserve SHIPPED records', () => {
    // PR #176 deleted every Phase 1–7 SHIPPED record because the old prompt
    // said "be concise". Lock down the instruction text so a future edit
    // can't silently regress it.
    const prompt = buildUpdatePrompt('# Roadmap', baseSnapshot, null, null);
    assert.ok(prompt.includes('smallest set of changes'), 'must instruct minimal edits');
    assert.ok(prompt.includes('SHIPPED'), 'must explicitly mention preserving SHIPPED records');
    assert.ok(prompt.includes('Append new entries'), 'must instruct append-not-rewrite');
    assert.ok(!prompt.includes('Be concise'), 'must NOT contain old "Be concise" framing');
  });

  it('passes existing roadmap content through to the prompt verbatim', () => {
    // The prompt-builder must hand the LLM the actual SHIPPED markers and
    // section headings — if it strips or reformats them, the LLM cannot
    // preserve what it never saw.
    const fixtureRoadmap = [
      '# ROADMAP',
      '',
      '### ~~Code Health Sprint~~ SHIPPED',
      '',
      'Shipped 2026-04-28 across PRs #127–#146.',
      '',
      '### Future',
      '',
      '- Item A',
      '- Item B',
    ].join('\n');
    const prompt = buildUpdatePrompt(fixtureRoadmap, baseSnapshot, null, null);
    assert.ok(prompt.includes('### ~~Code Health Sprint~~ SHIPPED'), 'SHIPPED heading must survive');
    assert.ok(prompt.includes('### Future'), 'Future heading must survive');
    assert.ok(prompt.includes('Shipped 2026-04-28'), 'shipped record body must survive');
    assert.ok(prompt.includes('--- CURRENT ROADMAP ---'), 'roadmap delimiter must be present');
  });
});

describe('checkLengthPreservation', () => {
  it('passes when the output is the same length as the input', () => {
    const result = checkLengthPreservation('a'.repeat(1000), 'b'.repeat(1000));
    assert.equal(result.valid, true);
  });

  it('passes when the output is at the 80% threshold', () => {
    const result = checkLengthPreservation('a'.repeat(1000), 'b'.repeat(800));
    assert.equal(result.valid, true);
  });

  it('rejects output below 80% of input length (suspected destructive rewrite)', () => {
    // PR #176 produced 53 lines from 277 lines (~19%). Catch that.
    const result = checkLengthPreservation('a'.repeat(1000), 'b'.repeat(199));
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('19.9%'));
    assert.ok(result.error.includes('80%'));
  });

  it('exempts empty input (first run, missing roadmap)', () => {
    const result = checkLengthPreservation('', 'a fresh roadmap');
    assert.equal(result.valid, true);
  });

  it('exempts null input', () => {
    const result = checkLengthPreservation(null, 'a fresh roadmap');
    assert.equal(result.valid, true);
  });

  it('rejects empty output against non-empty input', () => {
    const result = checkLengthPreservation('a'.repeat(1000), '');
    assert.equal(result.valid, false);
  });
});
