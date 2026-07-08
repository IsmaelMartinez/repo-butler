import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEditOps, buildRoadmapPrBody, buildSafePrBody, buildSectionEditPrompt, buildUpdatePrompt, bumpLastUpdated, checkLengthPreservation, checkPrReferencePreservation, checkStrikethroughPreservation, compactRoadmap, findOpenRoadmapPr, isDateOnlyChange, normalizeEditOp, parseEditOps, SECTION_NAMES, redactErrorForLog } from './update.js';

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

  it('instructs the LLM to preserve ~~strikethrough~~ markers verbatim (PR #202 regression)', () => {
    // PR #202 stripped 24 `~~...~~` markers from every SHIPPED heading under
    // the 80% length guard. Lock the non-negotiable strikethrough directive
    // into the prompt so a future edit can't silently regress it.
    const prompt = buildUpdatePrompt('# Roadmap', baseSnapshot, null, null);
    assert.ok(prompt.includes('Preserve `~~strikethrough~~` markers'), 'must instruct strikethrough preservation');
    assert.ok(prompt.includes('non-negotiable'), 'must mark the rule as non-negotiable');
    assert.ok(prompt.includes('Wrong:') && prompt.includes('Correct:'), 'must include contrastive one-shot');
  });

  it('instructs the LLM to preserve every #NN PR/issue reference (PR #213 regression)', () => {
    // PR #213 deleted the `(PR #84)` paragraph under both the length guard
    // and the strikethrough guard because the prose paragraph carried neither
    // marker. Lock the non-negotiable PR-reference directive in.
    const prompt = buildUpdatePrompt('# Roadmap', baseSnapshot, null, null);
    assert.ok(prompt.includes('Preserve every `#NN` PR or issue reference'), 'must instruct PR-reference preservation');
    assert.ok(prompt.includes('non-negotiable'), 'must mark PR-reference rule as non-negotiable');
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

describe('checkStrikethroughPreservation', () => {
  it('passes when output keeps every input strikethrough marker', () => {
    const input = '### ~~Phase 1~~ SHIPPED\n### ~~Phase 2~~ SHIPPED';
    const output = '### ~~Phase 1~~ SHIPPED\n### ~~Phase 2~~ SHIPPED\nNew line';
    const result = checkStrikethroughPreservation(input, output);
    assert.equal(result.valid, true);
    assert.equal(result.inputCount, 2);
    assert.equal(result.outputCount, 2);
  });

  it('passes when output adds new strikethrough markers (newly-shipped entries)', () => {
    const input = '### ~~Phase 1~~ SHIPPED';
    const output = '### ~~Phase 1~~ SHIPPED\n### ~~Phase 2~~ SHIPPED';
    const result = checkStrikethroughPreservation(input, output);
    assert.equal(result.valid, true);
    assert.equal(result.outputCount, 2);
  });

  it('rejects output that strips strikethrough from existing SHIPPED entries (PR #202 regression)', () => {
    const input = '### ~~Phase 1 — Richer Observation~~ SHIPPED\n### ~~Phase 2 — Richer Reports~~ SHIPPED';
    const output = '### Phase 1 — Richer Observation SHIPPED\n### Phase 2 — Richer Reports SHIPPED';
    const result = checkStrikethroughPreservation(input, output);
    assert.equal(result.valid, false);
    assert.equal(result.inputCount, 2);
    assert.equal(result.outputCount, 0);
    assert.ok(result.error.includes('2 to 0'));
  });

  it('rejects partial strikethrough strips (1 of 3 removed)', () => {
    const input = '~~a~~ ~~b~~ ~~c~~';
    const output = '~~a~~ b ~~c~~';
    const result = checkStrikethroughPreservation(input, output);
    assert.equal(result.valid, false);
    assert.equal(result.outputCount, 2);
  });

  it('exempts empty input (first run, missing roadmap)', () => {
    const result = checkStrikethroughPreservation('', 'no strikethrough here');
    assert.equal(result.valid, true);
  });

  it('exempts null input', () => {
    const result = checkStrikethroughPreservation(null, 'anything');
    assert.equal(result.valid, true);
  });

  it('does not match across newlines (avoids over-counting paragraph spans)', () => {
    const input = '~~one~~\n~~two~~';
    const output = '~~one~~\n~~two~~';
    const result = checkStrikethroughPreservation(input, output);
    assert.equal(result.inputCount, 2);
    assert.equal(result.outputCount, 2);
  });
});

describe('checkPrReferencePreservation', () => {
  it('passes when every input #NN reference survives in the output', () => {
    const input = 'Shipped (PR #82). Also shipped PR #176.';
    const output = 'Shipped (PR #82). Also shipped PR #176. New entry (PR #214).';
    const result = checkPrReferencePreservation(input, output);
    assert.equal(result.valid, true);
    assert.equal(result.inputCount, 2);
    assert.equal(result.outputCount, 3);
  });

  it('rejects output that drops a unique PR reference (PR #213 regression)', () => {
    const input = 'Shipped (PR #82). License concern (PR #84). Other (PR #176).';
    const output = 'Shipped (PR #82). Other (PR #176).';
    const result = checkPrReferencePreservation(input, output);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ['#84']);
    assert.ok(result.error.includes('#84'));
  });

  it('reports multiple missing references', () => {
    const input = '(PR #1) (PR #2) (PR #3) (PR #4)';
    const output = '(PR #1) (PR #4)';
    const result = checkPrReferencePreservation(input, output);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ['#2', '#3']);
  });

  it('caps the surfaced list to 10 references and reports overflow count', () => {
    const refs = Array.from({ length: 15 }, (_, i) => `(PR #${100 + i})`).join(' ');
    const result = checkPrReferencePreservation(refs, '');
    assert.equal(result.valid, false);
    assert.equal(result.missing.length, 15);
    assert.ok(result.error.includes('and 5 more'));
  });

  it('matches both parenthesised and bare reference forms', () => {
    const input = 'See (PR #1), issue #2, and PR #3.';
    const output = 'See (PR #1) and PR #3.';
    const result = checkPrReferencePreservation(input, output);
    assert.equal(result.valid, false);
    assert.deepEqual(result.missing, ['#2']);
  });

  it('treats duplicate references as a single requirement (preserve at least once)', () => {
    const input = 'See PR #1. Also see PR #1 again. And PR #2.';
    const output = 'See PR #1. And PR #2.';
    const result = checkPrReferencePreservation(input, output);
    assert.equal(result.valid, true);
  });

  it('passes when the input has no PR references', () => {
    const result = checkPrReferencePreservation('# Roadmap\nNo refs here.', '# Roadmap\nstill no refs.');
    assert.equal(result.valid, true);
    assert.deepEqual(result.missing, []);
  });

  it('exempts empty input (first run, missing roadmap)', () => {
    const result = checkPrReferencePreservation('', '(PR #1)');
    assert.equal(result.valid, true);
  });

  it('exempts null input', () => {
    const result = checkPrReferencePreservation(null, '(PR #1)');
    assert.equal(result.valid, true);
  });

  it('does not match numbers not preceded by a hash', () => {
    // Plain "84" or "PR 84" without the hash shouldn't be counted.
    const input = '2026-04-04 had 84 commits.';
    const result = checkPrReferencePreservation(input, '');
    assert.equal(result.valid, true);
    assert.equal(result.inputCount, 0);
  });
});

describe('parseEditOps', () => {
  it('parses a valid JSON array', () => {
    const result = parseEditOps('[{"action":"append","section":"Implemented","text":"New thing."}]');
    assert.equal(result.valid, true);
    assert.equal(result.ops.length, 1);
    assert.equal(result.ops[0].action, 'append');
  });

  it('parses an empty array', () => {
    const result = parseEditOps('[]');
    assert.equal(result.valid, true);
    assert.equal(result.ops.length, 0);
  });

  it('strips markdown code fences', () => {
    const result = parseEditOps('```json\n[{"action":"append","section":"Implemented","text":"X"}]\n```');
    assert.equal(result.valid, true);
    assert.equal(result.ops.length, 1);
  });

  it('rejects non-array JSON', () => {
    const result = parseEditOps('{"action":"append"}');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('not a JSON array'));
  });

  it('rejects invalid JSON', () => {
    const result = parseEditOps('not json at all');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Invalid JSON'));
  });

  it('rejects empty response', () => {
    const result = parseEditOps('');
    assert.equal(result.valid, false);
  });
});

describe('applyEditOps', () => {
  const roadmap = [
    '# Roadmap',
    '',
    '**Last Updated:** 2026-05-01',
    '',
    '## Implemented',
    '',
    'Feature A shipped.',
    '',
    '---',
    '',
    '## Next Up',
    '',
    'Some future work.',
    '',
    '## Future',
    '',
    'Ideas here.',
  ].join('\n');

  it('does not bump the date when there are no content ops (date-only churn)', () => {
    // Daily runs with an empty op list were producing PRs whose entire diff
    // was the "Last Updated" line. No content change → no date bump → the
    // unchanged-roadmap guard in update() skips the PR.
    const { result, applied } = applyEditOps(roadmap, [], '2026-05-26');
    assert.equal(result, roadmap);
    assert.equal(applied.length, 0);
  });

  it('does not bump the date when every op is skipped', () => {
    const ops = [{ action: 'append', section: 'Nonexistent', text: 'X' }];
    const { result, applied } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.equal(result, roadmap);
    assert.equal(applied.length, 0);
  });

  it('updates the Last Updated date when a content op applies', () => {
    const ops = [{ action: 'append', section: 'Implemented', text: 'Feature B shipped 2026-05-26 (PR #99).' }];
    const { result, applied } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(result.includes('**Last Updated:** 2026-05-26'));
    assert.ok(!result.includes('2026-05-01'));
    assert.ok(applied.some(a => a.includes('update_date')));
  });

  it('appends to the Implemented section', () => {
    const ops = [{ action: 'append', section: 'Implemented', text: 'Feature B shipped 2026-05-26 (PR #99).' }];
    const { result, applied } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(result.includes('Feature B shipped'));
    assert.ok(result.indexOf('Feature B') > result.indexOf('Feature A'));
    assert.ok(result.indexOf('Feature B') < result.indexOf('---'));
    assert.equal(applied.length, 2);
  });

  it('appends to the Next Up section', () => {
    const ops = [{ action: 'append', section: 'Next Up', text: 'New task.' }];
    const { result } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(result.includes('New task.'));
    assert.ok(result.indexOf('New task.') > result.indexOf('## Next Up'));
    assert.ok(result.indexOf('New task.') < result.indexOf('## Future'));
  });

  it('skips ops with missing section', () => {
    const ops = [{ action: 'append', section: 'Nonexistent', text: 'X' }];
    const { skipped } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(skipped.some(s => s.includes('not found')));
  });

  it('skips ops with missing text', () => {
    const ops = [{ action: 'append', section: 'Implemented' }];
    const { skipped } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(skipped.some(s => s.includes('missing')));
  });

  it('skips unknown actions', () => {
    const ops = [{ action: 'delete', section: 'Implemented' }];
    const { skipped } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(skipped.some(s => s.includes('unknown')));
  });

  it('recovers ops where the section name was put in the action field', () => {
    // The live pipeline (2026-05-29) emitted {"action":"Implemented",...},
    // collapsing the section into the action field. These were dropped as
    // "unknown action: Implemented". They must now land as appends instead.
    const ops = [{ action: 'Implemented', text: 'Feature C shipped 2026-05-29 (PR #244).' }];
    const { result, applied, skipped } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(result.includes('Feature C shipped'), 'recovered entry must be appended');
    assert.ok(result.indexOf('Feature C') < result.indexOf('---'), 'lands in Implemented section');
    assert.ok(applied.some(a => a.includes('Implemented')), 'reported as applied, not skipped');
    assert.ok(!skipped.some(s => s.includes('unknown action')), 'no longer skipped as unknown');
  });

  it('recovers an action-as-section op into the Next Up section', () => {
    const ops = [{ action: 'Next Up', text: 'Investigate scorecard ingestion.' }];
    const { result } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(result.includes('Investigate scorecard ingestion.'));
    assert.ok(result.indexOf('Investigate scorecard') > result.indexOf('## Next Up'));
    assert.ok(result.indexOf('Investigate scorecard') < result.indexOf('## Future'));
  });

  it('still skips a recovered op that has no text', () => {
    const ops = [{ action: 'Implemented' }];
    const { skipped } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(skipped.some(s => s.includes('missing')));
  });

  it('inserts a drifted-case section append into the correct heading', () => {
    // findSectionInsertPoint matches headings case-sensitively; the lowercase
    // section must be canonicalized so the entry lands under ## Implemented.
    const ops = [{ action: 'append', section: 'implemented', text: 'Feature D shipped.' }];
    const { result } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(result.includes('Feature D shipped.'));
    assert.ok(result.indexOf('Feature D') < result.indexOf('---'), 'lands in Implemented section');
  });

  it('skips an append whose every #NN ref is already documented (re-summary)', () => {
    // PR #262 appended a paragraph citing only PRs #239–#241, all already
    // covered by existing SHIPPED entries — a duplicate, not an update.
    const documented = roadmap + '\n\nStage shipped (PRs #239, #240 and #241).';
    const ops = [{ action: 'append', section: 'Implemented', text: 'Stages 1–2 shipped 2026-05-29 (PRs #239–#241). Summary of the same work.' }];
    const { result, applied, skipped } = applyEditOps(documented, ops, '2026-06-12');
    assert.equal(result, documented);
    assert.equal(applied.length, 0);
    assert.ok(skipped.some(s => s.includes('already documented')));
  });

  it('applies an append that cites a new ref alongside existing ones', () => {
    const documented = roadmap + '\n\nStage 1 shipped (PR #239).';
    const ops = [{ action: 'append', section: 'Implemented', text: 'Stage 4 graduated (PRs #239, #300).' }];
    const { result, applied } = applyEditOps(documented, ops, '2026-06-12');
    assert.ok(result.includes('Stage 4 graduated'));
    assert.ok(applied.some(a => a.includes('Implemented')));
  });

  it('applies an append with no refs at all', () => {
    const ops = [{ action: 'append', section: 'Next Up', text: 'Investigate scorecard ingestion.' }];
    const { result } = applyEditOps(roadmap, ops, '2026-06-12');
    assert.ok(result.includes('Investigate scorecard ingestion.'));
  });

  it('applies a shipped announcement for an issue tracked in a live entry', () => {
    // Resolved issues reach the prompt as bare #NN numbers; an entry
    // announcing the fix may cite only the issue ref already listed under
    // Next Up. A live (non-shipped) mention must not block it.
    const tracked = roadmap + '\n\nFix scorecard ingestion (issue #211).';
    const ops = [{ action: 'append', section: 'Implemented', text: 'Scorecard ingestion fixed 2026-06-12 (issue #211).' }];
    const { result, applied } = applyEditOps(tracked, ops, '2026-06-12');
    assert.ok(result.includes('Scorecard ingestion fixed'));
    assert.ok(applied.some(a => a.includes('Implemented')));
  });

  it('skips an intra-run restatement of an op it just applied', () => {
    const ops = [
      { action: 'append', section: 'Implemented', text: 'Stage 4 graduated (PR #300).' },
      { action: 'append', section: 'Implemented', text: 'Governance apply stage 4 shipped (PR #300).' },
    ];
    const { result, applied, skipped } = applyEditOps(roadmap, ops, '2026-06-12');
    assert.ok(result.includes('Stage 4 graduated'));
    assert.ok(!result.includes('Governance apply stage 4 shipped'));
    assert.equal(applied.filter(a => a.includes('Implemented')).length, 1);
    assert.ok(skipped.some(s => s.includes('already documented')));
  });

  it('reports a bad section before judging duplicate refs', () => {
    const documented = roadmap + '\n\n~~Stage 1~~ SHIPPED (PR #239).';
    const ops = [{ action: 'append', section: 'Nonexistent', text: 'Restating stage 1 (PR #239).' }];
    const { skipped } = applyEditOps(documented, ops, '2026-06-12');
    assert.ok(skipped.some(s => s.includes('not found')));
  });

  it('preserves all existing content', () => {
    const ops = [{ action: 'append', section: 'Implemented', text: 'New.' }];
    const { result } = applyEditOps(roadmap, ops, '2026-05-26');
    assert.ok(result.includes('Feature A shipped.'));
    assert.ok(result.includes('Some future work.'));
    assert.ok(result.includes('Ideas here.'));
  });
});

describe('isDateOnlyChange', () => {
  it('is true for identical documents', () => {
    assert.equal(isDateOnlyChange('# R\n**Last Updated:** 2026-06-01\nBody', '# R\n**Last Updated:** 2026-06-01\nBody'), true);
  });

  it('is true when only the Last Updated date differs', () => {
    assert.equal(isDateOnlyChange('# R\n**Last Updated:** 2026-06-01\nBody', '# R\n**Last Updated:** 2026-06-12\nBody'), true);
  });

  it('is false when content differs alongside the date', () => {
    assert.equal(isDateOnlyChange('# R\n**Last Updated:** 2026-06-01\nBody', '# R\n**Last Updated:** 2026-06-12\nBody\n\nNew entry.'), false);
  });

  it('is false when content differs and the date does not', () => {
    assert.equal(isDateOnlyChange('# R\n**Last Updated:** 2026-06-01\nBody', '# R\n**Last Updated:** 2026-06-01\nOther body'), false);
  });

  it('is false against empty/null input', () => {
    assert.equal(isDateOnlyChange(null, '# R\n**Last Updated:** 2026-06-01'), false);
    assert.equal(isDateOnlyChange('', '# R'), false);
  });
});

describe('normalizeEditOp', () => {
  it('rewrites a section-name-as-action op into an append', () => {
    const op = normalizeEditOp({ action: 'Implemented', text: 'X' });
    assert.equal(op.action, 'append');
    assert.equal(op.section, 'Implemented');
    assert.equal(op.text, 'X');
  });

  it('prefers an explicit valid section field over the action-derived one', () => {
    const op = normalizeEditOp({ action: 'Implemented', section: 'Future', text: 'X' });
    assert.equal(op.action, 'append');
    assert.equal(op.section, 'Future');
  });

  it('leaves a well-formed append op untouched', () => {
    const input = { action: 'append', section: 'Next Up', text: 'X' };
    assert.deepEqual(normalizeEditOp(input), input);
  });

  it('leaves a genuinely unknown action untouched', () => {
    const input = { action: 'delete', section: 'Implemented' };
    assert.deepEqual(normalizeEditOp(input), input);
  });

  it('passes non-object ops through unchanged', () => {
    assert.equal(normalizeEditOp(null), null);
    assert.equal(normalizeEditOp('nope'), 'nope');
  });

  it('canonicalizes a lowercase section name in the action field', () => {
    const op = normalizeEditOp({ action: 'implemented', text: 'X' });
    assert.equal(op.action, 'append');
    assert.equal(op.section, 'Implemented');
  });

  it('canonicalizes a drifted-case section in a well-formed append op', () => {
    const op = normalizeEditOp({ action: 'append', section: 'next up', text: 'X' });
    assert.equal(op.action, 'append');
    assert.equal(op.section, 'Next Up');
  });
});

describe('buildSectionEditPrompt', () => {
  const baseSnapshot = {
    repository: 'owner/repo',
    summary: {
      open_issues: 2, blocked_issues: 0, awaiting_feedback: 0,
      recently_merged_prs: 5, high_reaction_issues: [], top_open_labels: [],
    },
  };

  it('asks for JSON ops, not a full document', () => {
    const prompt = buildSectionEditPrompt('# Roadmap', baseSnapshot, null, null);
    assert.ok(prompt.includes('JSON array'));
    assert.ok(prompt.includes('"append"'));
    assert.ok(prompt.includes('do NOT reproduce'));
  });

  it('warns against putting the section name in the action field', () => {
    const prompt = buildSectionEditPrompt('# Roadmap', baseSnapshot, null, null);
    assert.ok(prompt.includes('always the literal string "append"') || prompt.includes('ALWAYS the literal string "append"'));
    assert.ok(prompt.includes('{"action": "Implemented"'), 'shows the wrong shape to avoid');
    for (const s of SECTION_NAMES) assert.ok(prompt.includes(`"${s}"`));
  });

  it('includes the current roadmap as read-only context', () => {
    const prompt = buildSectionEditPrompt('# My Roadmap', baseSnapshot, null, null);
    assert.ok(prompt.includes('# My Roadmap'));
    assert.ok(prompt.includes('read-only context'));
  });

  it('includes valid section names', () => {
    const prompt = buildSectionEditPrompt('# Roadmap', baseSnapshot, null, null);
    assert.ok(prompt.includes('"Implemented"'));
    assert.ok(prompt.includes('"Next Up"'));
    assert.ok(prompt.includes('"Future"'));
  });
});

describe('compactRoadmap', () => {
  const today = '2026-06-13';
  // ~600-char body, struck heading, dated ~5 months ago.
  const oldBody = 'Shipped 2026-01-10 (PR #18). ' + 'Detailed prose about the work that was done, '.repeat(12) + 'Follow-up fixes landed in PR #22.';
  const make = () => [
    '# Roadmap',
    '',
    '**Last Updated:** 2026-06-13',
    '',
    '## Roadmap',
    '',
    '### ~~Phase 1 — Old Work~~ SHIPPED',
    '',
    oldBody,
    '',
    '### Active Phase — In Progress',
    '',
    'This active block is just as long. ' + 'It has plenty of body text to exceed the minimum threshold easily here. '.repeat(8),
    '',
    '### ~~Recent Thing~~ SHIPPED',
    '',
    'Shipped 2026-06-01 (PR #260). ' + 'Recent and long enough to exceed the minimum body threshold for sure. '.repeat(8),
    '',
    '---',
    '',
    '## Future',
    '',
    'Ideas.',
  ].join('\n');

  it('compacts an old, long, struck subsection — preserving heading, date and refs', () => {
    const { result, compacted } = compactRoadmap(make(), today);
    assert.ok(result.includes('### ~~Phase 1 — Old Work~~ SHIPPED'), 'heading preserved verbatim');
    assert.ok(result.includes('Shipped 2026-01-10 (#18, #22). Full detail in git history.'), 'summary preserves newest date + all refs');
    assert.ok(!result.includes('Detailed prose about the work'), 'verbose body removed');
    assert.equal(compacted.length, 1);
    assert.ok(compacted[0].includes('Phase 1 — Old Work'));
  });

  it('leaves an active (non-struck) subsection untouched even when old and long', () => {
    const { result } = compactRoadmap(make(), today);
    assert.ok(result.includes('### Active Phase — In Progress'));
    assert.ok(result.includes('This active block is just as long.'));
  });

  it('leaves a recent struck subsection untouched (within the age window)', () => {
    const { result } = compactRoadmap(make(), today);
    assert.ok(result.includes('Shipped 2026-06-01 (PR #260).'));
    assert.ok(result.includes('Recent and long enough'));
  });

  it('leaves a short struck subsection untouched (below the body threshold)', () => {
    const roadmap = ['## Roadmap', '', '### ~~Tiny~~ SHIPPED', '', 'Shipped 2026-01-01 (PR #1).', '', '## Future', '', 'x'].join('\n');
    const { result, compacted } = compactRoadmap(roadmap, today);
    assert.equal(result, roadmap);
    assert.equal(compacted.length, 0);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const once = compactRoadmap(make(), today).result;
    const twice = compactRoadmap(once, today).result;
    assert.equal(twice, once);
  });

  it('does not touch h2 prose sections like ## Implemented', () => {
    const roadmap = ['## Implemented', '', 'Phase 1 shipped 2026-01-01 (PR #18). ' + 'Long narrative prose here that exceeds the threshold by a wide margin indeed. '.repeat(10), '', '## Future', '', 'x'].join('\n');
    const { result, compacted } = compactRoadmap(roadmap, today);
    assert.equal(result, roadmap);
    assert.equal(compacted.length, 0);
  });

  it('returns the roadmap unchanged when there is nothing to compact', () => {
    const roadmap = '# Roadmap\n\n## Future\n\nNothing struck here.';
    const { result, compacted } = compactRoadmap(roadmap, today);
    assert.equal(result, roadmap);
    assert.equal(compacted.length, 0);
  });

  it('handles empty input', () => {
    const { result, compacted } = compactRoadmap('', today);
    assert.equal(result, '');
    assert.equal(compacted.length, 0);
  });

  it('produces a roadmap shorter than the input when it compacts', () => {
    const input = make();
    const { result } = compactRoadmap(input, today);
    assert.ok(result.length < input.length);
  });
});

describe('compactRoadmap — ADR link retention', () => {
  const today = '2026-06-13';
  const wrap = (body) => ['## Roadmap', '', '### ~~Phase X~~ SHIPPED', '', body, '', '## Future', '', 'x'].join('\n');
  const pad = 'Detailed prose about the shipped work, long enough to clear the threshold. '.repeat(8);

  it('keeps a markdown ADR link in the one-line summary alongside PR refs', () => {
    const body = `Shipped 2026-01-10 (PR #84). Trust model in [ADR-009](docs/decisions/009-settings-level-writes.md). ${pad}`;
    const { result, compacted } = compactRoadmap(wrap(body), today);
    assert.equal(compacted.length, 1);
    assert.ok(result.includes('Shipped 2026-01-10 (#84). See [ADR-009](docs/decisions/009-settings-level-writes.md). Full detail in git history.'));
    assert.ok(!result.includes('Trust model'), 'verbose body removed');
  });

  it('re-links a bare ADR path referenced without markdown link syntax', () => {
    const body = `Shipped 2026-01-10 (PR #84). Design recorded in docs/decisions/007-agents-and-execution.md before landing. ${pad}`;
    const { result } = compactRoadmap(wrap(body), today);
    assert.ok(result.includes('See [ADR-007](docs/decisions/007-agents-and-execution.md).'));
  });

  it('collapses duplicate ADR references and preserves first-appearance order', () => {
    const body = `Shipped 2026-01-10. Per [ADR-010](docs/decisions/010-cross-repo-proposal-destinations.md) and [ADR-005](docs/decisions/005-cross-repo-write-trust-model.md); see [ADR-010](docs/decisions/010-cross-repo-proposal-destinations.md) again. ${pad}`;
    const { result } = compactRoadmap(wrap(body), today);
    assert.ok(result.includes('See [ADR-010](docs/decisions/010-cross-repo-proposal-destinations.md), [ADR-005](docs/decisions/005-cross-repo-write-trust-model.md). Full detail in git history.'));
  });

  it('omits the ADR clause entirely when the body references no ADR', () => {
    const body = `Shipped 2026-01-10 (PR #84). Mentions docs/research/multi-repo-tooling-landscape.md but no decision record. ${pad}`;
    const { result } = compactRoadmap(wrap(body), today);
    assert.ok(result.includes('Shipped 2026-01-10 (#84). Full detail in git history.'));
    assert.ok(!result.includes('docs/research/'), 'non-ADR paths are not retained');
  });

  it('is idempotent — the ADR links in a compacted summary survive a second pass unchanged', () => {
    const body = `Shipped 2026-01-10 (PR #84). See [ADR-009](docs/decisions/009-settings-level-writes.md) and docs/decisions/007-agents-and-execution.md. ${pad}`;
    const once = compactRoadmap(wrap(body), today).result;
    const twice = compactRoadmap(once, today).result;
    assert.equal(twice, once);
  });
});

describe('compactRoadmap — review hardening', () => {
  const today = '2026-06-13';
  const longBody = (date) => `Shipped ${date} (PR #18). ` + 'Detailed prose about the work that was done here. '.repeat(12);

  it('does not compact an active heading that merely mentions a struck phrase', () => {
    const roadmap = [
      '## Roadmap', '',
      '### Phase 2 — supersedes ~~the old idea~~ and ~~another~~',
      '',
      longBody('2026-01-10'),
      '', '## Future', '', 'x',
    ].join('\n');
    const { result, compacted } = compactRoadmap(roadmap, today);
    assert.equal(compacted.length, 0, 'mid-heading strikethrough is not a completed entry');
    assert.equal(result, roadmap);
  });

  it('keeps a block whose newest date token is malformed (fail-safe, no NaN compaction)', () => {
    // A typo date like 2026-13-45 sorts highest; daysBetween → NaN. The block
    // must be KEPT, not compacted, so a recent entry is never wiped on a typo.
    const roadmap = [
      '## Roadmap', '',
      '### ~~Recent Thing~~ SHIPPED',
      '',
      'Shipped 2026-06-01 but typo 2026-13-45 (PR #260). ' + 'Long enough body to exceed the minimum threshold by a wide margin here. '.repeat(8),
      '', '## Future', '', 'x',
    ].join('\n');
    const { result, compacted } = compactRoadmap(roadmap, today);
    assert.equal(compacted.length, 0);
    assert.equal(result, roadmap);
  });

  it('keeps a struck block dated in the future (negative age is "recent")', () => {
    const roadmap = [
      '## Roadmap', '',
      '### ~~Future-dated~~ SHIPPED',
      '',
      'Shipped 2027-01-01 (PR #999). ' + 'Body long enough to clear the minimum character threshold for sure here. '.repeat(8),
      '', '## Future', '', 'x',
    ].join('\n');
    const { compacted } = compactRoadmap(roadmap, today);
    assert.equal(compacted.length, 0);
  });

  it('tolerates a malformed today by keeping everything (no NaN compaction)', () => {
    const roadmap = ['## Roadmap', '', '### ~~Old~~ SHIPPED', '', longBody('2026-01-10'), '', '## Future', '', 'x'].join('\n');
    const { compacted } = compactRoadmap(roadmap, 'not-a-date');
    assert.equal(compacted.length, 0);
  });
});

describe('bumpLastUpdated', () => {
  it('replaces the date on the Last Updated line', () => {
    assert.equal(bumpLastUpdated('**Last Updated:** 2026-01-01\nbody', '2026-06-13'), '**Last Updated:** 2026-06-13\nbody');
  });
  it('is a no-op when there is no Last Updated line', () => {
    assert.equal(bumpLastUpdated('# Roadmap\nbody', '2026-06-13'), '# Roadmap\nbody');
  });
});
