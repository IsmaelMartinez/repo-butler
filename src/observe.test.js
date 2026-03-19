import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the module to test that it loads without errors.
// Full integration tests require a GitHub token.
describe('observe module', () => {
  it('exports observe and observePortfolio', async () => {
    const mod = await import('./observe.js');
    assert.equal(typeof mod.observe, 'function');
    assert.equal(typeof mod.observePortfolio, 'function');
  });
});

describe('assess module', () => {
  it('exports assess', async () => {
    const mod = await import('./assess.js');
    assert.equal(typeof mod.assess, 'function');
  });

  it('returns no-changes when snapshot matches previous', async () => {
    const { assess } = await import('./assess.js');
    const snapshot = {
      summary: {
        open_issues: 5, blocked_issues: 1, awaiting_feedback: 2,
        recently_closed: 10, recently_merged_prs: 20,
        bot_prs: 5, human_prs: 15, unique_contributors: 3,
        releases: 2, latest_release: 'v1.0.0',
        top_open_labels: [], high_reaction_issues: [],
        stale_awaiting_feedback: [],
      },
      issues: {
        open: [{ number: 1, title: 'test', labels: [] }],
        recently_closed: [],
      },
      pull_requests: { recently_merged: [] },
      releases: [{ tag: 'v1.0.0' }],
    };
    const previous = JSON.parse(JSON.stringify(snapshot));

    const result = await assess({ snapshot, previousSnapshot: previous });
    assert.equal(result.diff.hasChanges, false);
    assert.equal(result.assessment, 'No changes detected since the previous observation.');
  });

  it('detects new issues', async () => {
    const { assess } = await import('./assess.js');
    const previous = {
      issues: { open: [], recently_closed: [] },
      pull_requests: { recently_merged: [] },
      releases: [],
    };
    const snapshot = {
      summary: {
        open_issues: 1, blocked_issues: 0, awaiting_feedback: 0,
        recently_closed: 0, recently_merged_prs: 0,
        bot_prs: 0, human_prs: 0, unique_contributors: 0,
        releases: 0, latest_release: 'none',
        top_open_labels: [], high_reaction_issues: [],
        stale_awaiting_feedback: [],
      },
      issues: {
        open: [{ number: 42, title: 'New bug', labels: ['bug'] }],
        recently_closed: [],
      },
      pull_requests: { recently_merged: [] },
      releases: [],
    };

    const result = await assess({ snapshot, previousSnapshot: previous });
    assert.equal(result.diff.hasChanges, true);
    assert.equal(result.diff.new_issues.length, 1);
    assert.equal(result.diff.new_issues[0].number, 42);
  });
});

describe('config module', () => {
  it('returns defaults when file does not exist', async () => {
    const { loadConfig } = await import('./config.js');
    const config = await loadConfig('/nonexistent/path.yml');
    assert.equal(config.roadmap.path, 'ROADMAP.md');
    assert.equal(config.limits.max_issues_per_run, 3);
    assert.equal(config.limits.require_approval, true);
  });
});

describe('ideate module', () => {
  it('parses structured ideas from LLM output', async () => {
    // Test the idea parsing by importing and calling ideate with a mock provider.
    const { ideate } = await import('./ideate.js');
    const mockProvider = {
      generate: async () => `Here are some ideas:

---IDEA---
TITLE: Add automated dependency updates
PRIORITY: high
LABELS: automation, dependencies
BODY: The project should set up Dependabot or Renovate to keep dependencies current.

This would reduce manual maintenance burden.
---END---

---IDEA---
TITLE: Improve test coverage
PRIORITY: medium
LABELS: testing
BODY: Current test coverage is low. Add unit tests for core modules.
---END---`,
    };

    const result = await ideate({
      snapshot: {
        repository: 'test/repo',
        meta: { stars: 100 },
        summary: {
          open_issues: 5, blocked_issues: 1, awaiting_feedback: 2,
          recently_closed: 10, recently_merged_prs: 20,
          bot_prs: 5, human_prs: 15, unique_contributors: 3,
          releases: 2, latest_release: 'v1.0.0',
          top_open_labels: [], high_reaction_issues: [],
          stale_awaiting_feedback: [],
        },
        issues: { open: [] },
        roadmap: null,
      },
      provider: mockProvider,
      config: { limits: { max_issues_per_run: 3 } },
    });

    assert.equal(result.ideas.length, 2);
    assert.equal(result.ideas[0].title, 'Add automated dependency updates');
    assert.equal(result.ideas[0].priority, 'high');
    assert.deepEqual(result.ideas[0].labels, ['automation', 'dependencies']);
    assert.equal(result.ideas[1].title, 'Improve test coverage');
  });
});

describe('input validation', () => {
  it('accepts valid owner/repo format', async () => {
    const { validateRepoFormat } = await import('./index.js');
    assert.doesNotThrow(() => validateRepoFormat('owner/repo'));
  });

  it('throws for repo format without slash', async () => {
    const { validateRepoFormat } = await import('./index.js');
    assert.throws(
      () => validateRepoFormat('just-repo-name'),
      /must be in "owner\/repo" format/,
    );
  });
});
