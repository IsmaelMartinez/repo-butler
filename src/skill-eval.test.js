// Skill evaluation tests — verify the skill file contains the information
// an AI agent needs to answer common questions about repo-butler.
// These tests parse the skill markdown and assert key content is present.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skillPath = join(import.meta.dirname, '..', 'docs', 'skill.md');
const skill = readFileSync(skillPath, 'utf8');

describe('skill content coverage', () => {
  it('describes all seven pipeline phases plus the monitor', () => {
    // GOVERNANCE and MONITOR were missing while skill.md's own heading said
    // "Seven-Phase Pipeline" — deleting the GOVERNANCE section (the longest in
    // the document, covering all eight finding types) left the suite green.
    for (const phase of ['OBSERVE', 'ASSESS', 'UPDATE', 'GOVERNANCE', 'IDEATE', 'PROPOSE', 'REPORT', 'MONITOR']) {
      assert.ok(skill.includes(`\`${phase}\``), `skill should mention ${phase} phase`);
    }
  });

  it('documents the snapshot data model with key fields', () => {
    for (const field of ['timestamp', 'repository', 'meta', 'issues', 'pull_requests',
      'community_profile', 'dependabot_alerts', 'ci_pass_rate', 'summary']) {
      assert.ok(skill.includes(field), `skill should document snapshot field: ${field}`);
    }
  });

  it('documents health tier criteria', () => {
    for (const tier of ["'gold'", "'silver'", "'bronze'", "'none'"]) {
      assert.ok(skill.includes(tier), `skill should mention tier: ${tier}`);
    }
    assert.ok(skill.includes('computeHealthTier'), 'skill should reference computeHealthTier function');
    assert.ok(skill.includes('report-shared.js'), 'skill should point to report-shared.js (post-split location)');
  });

  it('documents the camelCase field mapping for portfolio details', () => {
    for (const field of ['communityHealth', 'ciPassRate', 'vulns']) {
      assert.ok(skill.includes(field), `skill should document enriched field: ${field}`);
    }
    assert.ok(skill.includes('fetchPortfolioDetails'), 'skill should reference fetchPortfolioDetails');
    assert.ok(skill.includes('report-portfolio.js'), 'skill should point to report-portfolio.js');
  });

  it('documents the config format', () => {
    assert.ok(skill.includes('roadmap.yml'), 'skill should mention config file');
    assert.ok(skill.includes('max_issues_per_run'), 'skill should document key config fields');
    assert.ok(skill.includes('require_approval'), 'skill should document approval gate');
  });

  it('documents how to run locally and as GitHub Action', () => {
    assert.ok(skill.includes('npm start'), 'skill should show local run command');
    assert.ok(skill.includes('IsmaelMartinez/repo-butler@v1'), 'skill should show action usage');
    assert.ok(skill.includes('INPUT_DRY_RUN'), 'skill should mention dry run');
  });

  it('documents the butler vs triage bot boundary', () => {
    // Anchored on the section heading, not on loose words. The previous form
    // passed on incidental matches — "triage-bot" from an ADR filename in Key
    // Files, and "deep" from "deep LLM provider" — so the whole Decision
    // Framework section could be deleted with CI green.
    assert.ok(skill.includes('## Decision Framework: repo-butler vs triage bot'),
      'skill should carry the boundary section');
    assert.ok(/goes deep on one repo/.test(skill) && /goes broad across the portfolio/.test(skill),
      'skill should contrast portfolio breadth vs per-repo depth');
  });

  it('does not describe the removed triage-bot HTTP integration as live', () => {
    // The endpoints went with the integration in PR #252 (2026-05-31). The old
    // assertion here REQUIRED the skill to name them, which is why the stale
    // prose survived three months: deleting it turned CI red. Inverted, so the
    // documentation cannot quietly regain them.
    const live = skill.split('\n').filter(l =>
      (l.includes('/ingest') || l.includes('/report/trends')) && !/removed|superseded|no longer/i.test(l));
    assert.deepEqual(live, [], 'skill.md still presents the removed endpoints as current');
  });

  it('documents safety validators', () => {
    assert.ok(skill.includes('validateIssueTitle'), 'skill should list validateIssueTitle');
    assert.ok(skill.includes('validateIssueBody'), 'skill should list validateIssueBody');
    assert.ok(skill.includes('validateRoadmap'), 'skill should list validateRoadmap');
    assert.ok(skill.includes('validateProvider'), 'skill should list validateProvider');
  });

  it('references the split module structure', () => {
    for (const mod of ['report-shared.js', 'report-portfolio.js', 'report-repo.js']) {
      assert.ok(skill.includes(mod), `skill should reference split module: ${mod}`);
    }
  });

  it('documents the governance model', () => {
    assert.ok(skill.includes('Standards propagation') || skill.includes('standards propagation'),
      'skill should describe standards propagation');
    assert.ok(skill.includes('Policy drift') || skill.includes('policy drift'),
      'skill should describe policy drift detection');
  });
});

describe('skill references schemas', () => {
  it('points to schemas/v1/ for formal definitions', () => {
    assert.ok(skill.includes('schemas/v1/') || skill.includes('schemas/v1'),
      'skill should reference the schemas directory');
  });
});
