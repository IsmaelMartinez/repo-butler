// Golden snapshot tests for the six prompt builders. The expected outputs were
// captured against the pre-refactor implementations and persisted under
// src/__golden__/. The refactor that introduced wrapPrompt() must not alter
// any builder's output by even a single character.
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessPrompt } from './assess.js';
import { buildUpdatePrompt } from './update.js';
import { buildIdeatePrompt } from './ideate.js';
import {
  buildQuickDeliberationPrompt,
  buildPersonaPrompt,
  buildSynthesisPrompt,
  PERSONAS,
} from './council.js';

const GOLDEN_DIR = new URL('./__golden__/', import.meta.url).pathname;
const golden = (name) => readFileSync(`${GOLDEN_DIR}${name}`, 'utf8');

const snapshot = {
  repository: 'octo/widget',
  meta: { stars: 42 },
  package: { version: '1.2.3' },
  summary: {
    open_issues: 5,
    blocked_issues: 1,
    awaiting_feedback: 2,
    recently_merged_prs: 3,
    recently_closed: 4,
    human_prs: 2,
    bot_prs: 1,
    unique_contributors: 2,
    latest_release: 'v1.2.0',
    high_reaction_issues: ['#10 Add dark mode (8 reactions)'],
    top_open_labels: ['bug (3)', 'enhancement (2)'],
    stale_awaiting_feedback: ['#7 Question about config (15 days)'],
  },
  issues: {
    open: [
      { number: 10, title: 'Add dark mode', labels: ['enhancement'], reactions: 8, comments: 2 },
      { number: 11, title: 'Crash on startup', labels: ['bug'], reactions: 1, comments: 0 },
    ],
  },
  roadmap: { content: 'Roadmap content here.' },
};

const diff = {
  hasChanges: true,
  isFirstRun: false,
  counts: { new_issues: 1, resolved_issues: 1, new_merged_prs: 2, new_releases: 1 },
  new_issues: [{ number: 12, title: 'New idea', labels: ['enhancement'] }],
  resolved_issues: [{ number: 5, title: 'Old bug' }],
  new_merged_prs: [{ number: 20, title: 'Fix typo' }],
  new_releases: [{ tag: 'v1.2.1', published_at: '2026-04-01T00:00:00Z' }],
  label_changes: {},
  stale_awaiting_feedback: ['#7 Question about config (15 days)'],
};

const assessment = { assessment: 'The project is healthy.', diff };

const items = [
  { type: 'proposal', title: 'Refactor module', priority: 'high', body: 'Body here', rationale: 'because' },
  { type: 'event', severity: 'critical', title: 'CI failed', source: 'workflow' },
];
const ctx = { snapshot };

const assessments = {
  product: { evaluations: [
    { assessment: 'Yes useful', concern_level: 'low', recommendation: 'act' },
    { assessment: 'Critical', concern_level: 'high', recommendation: 'act' },
  ] },
  development: { error: 'timeout', evaluations: [] },
  stability: { evaluations: [
    { assessment: 'OK', concern_level: 'low', recommendation: 'watch' },
    { assessment: 'Risky', concern_level: 'high', recommendation: 'act' },
  ] },
  maintainability: { evaluations: [] },
  security: { evaluations: [] },
};

describe('prompt builder golden snapshots', () => {
  it('buildAssessPrompt — full diff with project context', () => {
    assert.equal(
      buildAssessPrompt(snapshot, diff, 'A widget toolkit', null),
      golden('assess.txt')
    );
  });

  it('buildAssessPrompt — first run, no project context', () => {
    assert.equal(
      buildAssessPrompt(
        snapshot,
        { hasChanges: true, isFirstRun: true, counts: {}, new_issues: [], stale_awaiting_feedback: [] },
        null,
        null
      ),
      golden('assess-no-context.txt')
    );
  });

  it('buildUpdatePrompt — with assessment and roadmap', () => {
    assert.equal(
      buildUpdatePrompt('Existing roadmap.', snapshot, assessment, 'A widget toolkit'),
      golden('update.txt')
    );
  });

  it('buildUpdatePrompt — null projectContext preserves the blank slot', () => {
    assert.equal(
      buildUpdatePrompt('Existing roadmap.', snapshot, assessment, null),
      golden('update-no-context.txt')
    );
  });

  it('buildIdeatePrompt — standard inputs', () => {
    assert.equal(
      buildIdeatePrompt(snapshot, assessment, 'A widget toolkit', 3, null, null),
      golden('ideate.txt')
    );
  });

  it('buildIdeatePrompt — governance-mode with findings', () => {
    assert.equal(
      buildIdeatePrompt(snapshot, null, null, 2, null, [
        { type: 'standards-gap', tool: 'codeowners', scope: { type: 'all' }, compliant: ['a', 'b'], nonCompliant: ['c'] },
        { type: 'policy-drift', repo: 'octo/x', actual: 'mit', expected: 'apache-2.0', category: 'license' },
        { type: 'tier-uplift', repo: 'octo/y', currentTier: 'silver', targetTier: 'gold', failingChecks: [{ name: 'tests' }] },
      ]),
      golden('ideate-governance.txt')
    );
  });

  it('buildQuickDeliberationPrompt — with snapshot context', () => {
    assert.equal(buildQuickDeliberationPrompt(items, ctx), golden('council-quick.txt'));
  });

  it('buildQuickDeliberationPrompt — no snapshot context', () => {
    assert.equal(buildQuickDeliberationPrompt(items, {}), golden('council-quick-nocontext.txt'));
  });

  it('buildPersonaPrompt — with repository line', () => {
    assert.equal(buildPersonaPrompt(PERSONAS.security, items, ctx), golden('council-persona.txt'));
  });

  it('buildPersonaPrompt — no repository line', () => {
    assert.equal(buildPersonaPrompt(PERSONAS.product, items, {}), golden('council-persona-norepo.txt'));
  });

  it('buildSynthesisPrompt — with assessments', () => {
    assert.equal(buildSynthesisPrompt(items, assessments, ctx), golden('council-synthesis.txt'));
  });
});
