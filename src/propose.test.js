import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity, buildIssueBody, buildCrossRepoIssueBody, ensureTrackingIssue, findDuplicates, findDuplicatePRs, isGovernanceDeclined, propose, resolveProposalDestination } from './propose.js';
import { validateIdeas, validateIssueBody } from './safety.js';

// A minimal in-memory GitHub client stub. propose() takes context.gh when
// provided (falling back to createClient(token) in production), so tests can
// exercise the per-idea loop without touching the network. request() returns
// {} so ensureLabel finds the label already present; paginate() returns [] so
// no duplicate issue/PR is detected.
function stubGh() {
  const calls = [];
  return {
    calls,
    request: async (path, opts) => { calls.push({ path, method: opts?.method, body: opts?.body }); return {}; },
    paginate: async (path) => { calls.push({ path, method: 'GET' }); return []; },
    // Targets appear onboarded by default so the G9 onboarding precondition does
    // not downgrade cross-repo routing; tests that need a non-onboarded target
    // override gh.getFileContent to return null.
    getFileContent: async () => '# CLAUDE.md\n\nManaged by repo-butler.',
  };
}

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

  it('composed body re-validation catches unsafe structured fields that validateIdeas misses', () => {
    // validateIdeas only checks idea.body — the structured fields (rationale,
    // currentState, …) are embedded by buildIssueBody and reach GitHub. This
    // is the gap propose() closes by running validateIssueBody on the
    // composed string before POSTing the issue.
    const idea = {
      title: 'Looks harmless',
      priority: 'high',
      labels: [],
      body: 'A perfectly safe body.',
      rationale: 'Ping @victim and see https://evil-site.com/payload',
    };
    assert.equal(validateIdeas([idea]).valid, true, 'validateIdeas alone does not see structured fields');
    const composed = buildIssueBody(idea);
    const result = validateIssueBody(composed);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('@mention')));
    assert.ok(result.errors.some(e => e.includes('disallowed host')));
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

describe('findDuplicates closed look-back (G7)', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  // Returns a gh stub whose closed-issue page is `closed` and open page is `open`.
  const ghWith = ({ open = [], closed = [] }) => ({
    paginate: async (path, opts) => (opts?.params?.state === 'closed' ? closed : open),
  });

  it('still detects open duplicates (state: open)', async () => {
    const gh = ghWith({ open: [{ number: 3, title: 'Add a security policy' }] });
    const matches = await findDuplicates(gh, 'o', 'r', 'Add a security policy', { includeClosedDays: 30 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].state, 'open');
  });

  it('checks only open issues by default — no closed look-back unless requested', async () => {
    let closedQueried = false;
    const gh = { paginate: async (path, opts) => {
      if (opts?.params?.state === 'closed') { closedQueried = true; return [{ number: 7, title: 'X', closed_at: daysAgo(1), labels: [] }]; }
      return [];
    } };
    const matches = await findDuplicates(gh, 'o', 'r', 'X'); // includeClosedDays defaults to 0
    assert.equal(matches.length, 0);
    assert.equal(closedQueried, false);
  });

  it('matches a recently closed issue within the cooldown window', async () => {
    const gh = ghWith({ closed: [{ number: 7, title: 'Add a security policy', closed_at: daysAgo(10), labels: [] }] });
    const matches = await findDuplicates(gh, 'o', 'r', 'Add a security policy', { includeClosedDays: 30 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].state, 'closed');
    assert.equal(matches[0].declined, false);
  });

  it('ignores an ordinary closed issue older than the cooldown', async () => {
    const gh = ghWith({ closed: [{ number: 7, title: 'Add a security policy', closed_at: daysAgo(60), labels: [] }] });
    const matches = await findDuplicates(gh, 'o', 'r', 'Add a security policy', { includeClosedDays: 30 });
    assert.equal(matches.length, 0);
  });

  it('matches a governance-declined closed issue regardless of age (permanent)', async () => {
    const gh = ghWith({ closed: [{ number: 7, title: 'Add a security policy', closed_at: daysAgo(365), labels: [{ name: 'governance-declined' }] }] });
    const matches = await findDuplicates(gh, 'o', 'r', 'Add a security policy', { includeClosedDays: 30 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].declined, true);
  });

  it('only governance-declined earns permanence — a stale wontfix-labelled close still ages out', async () => {
    const gh = ghWith({ closed: [{ number: 7, title: 'Add a security policy', closed_at: daysAgo(365), labels: [{ name: 'wontfix' }] }] });
    const matches = await findDuplicates(gh, 'o', 'r', 'Add a security policy', { includeClosedDays: 30 });
    assert.equal(matches.length, 0, 'wontfix is not the governance-declined marker, so the cooldown applies');
  });

  it('ages out an ordinary closed issue with a missing or unparseable closed_at (no false match)', async () => {
    for (const closed_at of [undefined, null, 'not-a-date']) {
      const gh = ghWith({ closed: [{ number: 7, title: 'Add a security policy', closed_at, labels: [] }] });
      const matches = await findDuplicates(gh, 'o', 'r', 'Add a security policy', { includeClosedDays: 30 });
      assert.equal(matches.length, 0, `expected no match for closed_at=${JSON.stringify(closed_at)}`);
    }
  });

  it('returns open matches even if the closed scan errors (swallow-and-continue)', async () => {
    const gh = { paginate: async (path, opts) => {
      if (opts?.params?.state === 'closed') throw new Error('API error');
      return [{ number: 3, title: 'Add a security policy' }];
    } };
    const matches = await findDuplicates(gh, 'o', 'r', 'Add a security policy', { includeClosedDays: 30 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].state, 'open');
  });

  it('merges open and closed matches and sorts by similarity', async () => {
    const gh = ghWith({
      open: [{ number: 1, title: 'Add a security policy document' }],   // partial overlap
      closed: [{ number: 2, title: 'Add a security policy', closed_at: daysAgo(5), labels: [] }], // exact
    });
    const matches = await findDuplicates(gh, 'o', 'r', 'Add a security policy', { includeClosedDays: 30 });
    assert.equal(matches.length, 2);
    assert.equal(matches[0].similarity >= matches[1].similarity, true, 'sorted most-similar first');
    assert.equal(matches[0].number, 2); // exact closed match outranks the partial open one
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

describe('propose — dry-run targetRepo surfacing (G2)', () => {
  const baseContext = (overrides) => ({
    owner: 'octo',
    repo: 'repo-butler',
    token: 'unused',
    config: { limits: { require_approval: false } },
    dryRun: true,
    ...overrides,
  });

  it('surfaces a parsed targetRepo in the dry-run created record without changing routing', async () => {
    const gh = stubGh();
    const result = await propose(baseContext({
      gh,
      ideas: [{
        title: 'Add a repository description',
        priority: 'medium',
        labels: ['governance'],
        body: '12 of 14 active repos set a description; this one does not.',
        targetRepo: 'other-repo',
      }],
    }));

    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].targetRepo, 'other-repo');
    assert.equal(result.created[0].url, null); // dry-run: nothing is actually created
    // Routing is unchanged in G2: no issue POST fires, and nothing is addressed
    // to the target repo's API path — every write still targets the host.
    assert.ok(!gh.calls.some(c => c.method === 'POST' && c.path.endsWith('/issues')));
    assert.ok(!gh.calls.some(c => c.path.includes('/other-repo/')));
  });

  it('records targetRepo as null for a host-only idea in the dry-run record', async () => {
    const gh = stubGh();
    const result = await propose(baseContext({
      gh,
      ideas: [{
        title: 'A host-only idea',
        priority: 'low',
        labels: [],
        body: 'No target repo here.',
        targetRepo: null,
      }],
    }));

    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].targetRepo, null);
  });
});

describe('resolveProposalDestination (G5 routing composition)', () => {
  const base = {
    findings: [{ type: 'policy-drift', repo: 'teams-for-linux' }],
    eligibleRepoNames: ['teams-for-linux'],
    owner: 'octo',
    hostRepo: 'repo-butler',
    proposeTargets: { 'teams-for-linux': true },
    proposeClasses: { 'policy-drift': true },
  };
  const idea = (over = {}) => ({ title: 'x', targetRepo: 'teams-for-linux', rationale: '13/14 repos do X.', ...over });

  it('routes cross-repo only when the gate admits AND target+class are opted in', () => {
    assert.deepEqual(resolveProposalDestination(idea(), base),
      { action: 'file', repo: 'teams-for-linux', crossRepo: true, anchorType: 'policy-drift', reason: 'cross-repo' });
  });

  it('falls back to host when the target is not on propose-targets', () => {
    assert.deepEqual(resolveProposalDestination(idea(), { ...base, proposeTargets: {} }),
      { action: 'file', repo: 'repo-butler', crossRepo: false, reason: 'not-allowlisted' });
  });

  it('falls back to host when the class is not enabled in propose-classes', () => {
    assert.deepEqual(resolveProposalDestination(idea(), { ...base, proposeClasses: {} }),
      { action: 'file', repo: 'repo-butler', crossRepo: false, reason: 'not-allowlisted' });
  });

  it('with both maps empty, every idea files on the host (byte-identical to today)', () => {
    const d = resolveProposalDestination(idea(), { ...base, proposeTargets: {}, proposeClasses: {} });
    assert.equal(d.action, 'file');
    assert.equal(d.crossRepo, false);
    assert.equal(d.repo, 'repo-butler');
  });

  it('files a no-target idea on the host', () => {
    assert.deepEqual(resolveProposalDestination(idea({ targetRepo: null }), base),
      { action: 'file', repo: 'repo-butler', crossRepo: false, reason: 'no-target' });
  });

  it('DROPS a malformed target name outright — filed nowhere, not even the host', () => {
    assert.deepEqual(resolveProposalDestination(idea({ targetRepo: 'evil/../repo' }), base),
      { action: 'drop', reason: 'invalid-target-name' });
  });

  it('enables on boolean true or the quoted string "true", but not other truthy values', () => {
    assert.equal(resolveProposalDestination(idea(), { ...base, proposeTargets: { 'teams-for-linux': 1 } }).crossRepo, false);
    assert.equal(resolveProposalDestination(idea(), { ...base, proposeTargets: { 'teams-for-linux': 'true' } }).crossRepo, true);
  });
});

describe('propose — cross-repo routing wired into the write path (G5)', () => {
  const ctx = (over) => ({
    owner: 'octo', repo: 'repo-butler', token: 'unused', dryRun: true,
    governanceFindings: [{ type: 'policy-drift', repo: 'teams-for-linux' }],
    portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
    config: {
      limits: { require_approval: false },
      'propose-targets': { 'teams-for-linux': true },
      'propose-classes': { 'policy-drift': true },
    },
    ideas: [{
      title: 'Adopt the portfolio licence', priority: 'medium', labels: [],
      body: 'A nudge.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux',
    }],
    ...over,
  });

  it('records a cross-repo destination in the dry-run soak record', async () => {
    const gh = stubGh();
    const result = await propose(ctx({ gh }));
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].crossRepo, true);
    assert.equal(result.created[0].routedRepo, 'teams-for-linux');
    assert.equal(result.created[0].targetRepo, 'teams-for-linux');
  });

  it('files to the TARGET repo API path (and labels it) when not dry-run', async () => {
    const gh = stubGh();
    await propose(ctx({ gh, dryRun: false }));
    assert.ok(gh.calls.some(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues'), 'issue POSTed to target repo');
    assert.ok(gh.calls.some(c => c.path.includes('/repos/octo/teams-for-linux/labels')), 'labels ensured on target repo');
  });

  it('with empty maps, an anchored targeted idea still files on the HOST and never touches the target (byte-identical)', async () => {
    const gh = stubGh();
    const result = await propose(ctx({ gh, dryRun: false, config: { limits: { require_approval: false } } }));
    assert.ok(!gh.calls.some(c => c.path.includes('/teams-for-linux/')), 'no cross-repo API call');
    assert.ok(gh.calls.some(c => c.method === 'POST' && c.path === '/repos/octo/repo-butler/issues'), 'filed on host');
    assert.equal(result.created[0].crossRepo, false);
  });

  it('fails closed to host when governance findings / portfolio are absent from context', async () => {
    const gh = stubGh();
    const result = await propose(ctx({ gh, governanceFindings: undefined, portfolio: undefined }));
    assert.equal(result.created[0].crossRepo, false);
    assert.equal(result.created[0].routedRepo, 'repo-butler');
  });

  it('drops a malformed-target idea outright — no created entry and no issue POST anywhere', async () => {
    const gh = stubGh();
    const result = await propose(ctx({
      gh, dryRun: false,
      ideas: [{ title: 'x', priority: 'low', labels: [], body: 'b.', rationale: '13/14 repos.', targetRepo: 'evil/../repo' }],
    }));
    assert.equal(result.created.length, 0);
    assert.ok(!gh.calls.some(c => c.method === 'POST' && c.path.endsWith('/issues')), 'no issue POST anywhere');
  });

  it('builds a DETERMINISTIC cross-repo body that suppresses the LLM rationale (G9), so a #N in the rationale never reaches the target', async () => {
    const gh = stubGh();
    // Pre-G9 the LLM rationale was composed into the cross-repo body, so a #N in
    // it had to be caught by validateIssueBody({crossRepo:true}). G9 builds the
    // body from the anchoring finding alone, so the rationale — and its #42 —
    // never reaches the target at all: the stronger guarantee. The issue files,
    // and the posted body carries neither the rationale prose nor the #N.
    const result = await propose(ctx({
      gh, dryRun: false,
      ideas: [{ title: 'Adopt licence', priority: 'medium', labels: [], body: 'A nudge.', rationale: '13/14 repos declare a licence; see #42 for context.', targetRepo: 'teams-for-linux' }],
    }));
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].crossRepo, true);
    const post = gh.calls.find(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues');
    assert.ok(post, 'cross-repo issue filed on the target');
    assert.ok(!post.body.body.includes('#42'), 'rationale cross-reference not in the deterministic body');
    assert.ok(!post.body.body.includes('see #42'), 'rationale prose not in the deterministic body');
  });

  it('with empty maps, the exact host call sequence is unchanged and no other repo is touched', async () => {
    const gh = stubGh();
    await propose(ctx({
      gh, dryRun: false, config: { limits: { require_approval: false } },
      ideas: [{ title: 'Host idea', priority: 'medium', labels: [], body: 'A plain host idea.', targetRepo: null }],
    }));
    // Every API call is against the host repo; the issue is POSTed to the host.
    assert.ok(gh.calls.every(c => c.path.includes('/repos/octo/repo-butler/')), 'all calls target the host repo');
    assert.ok(gh.calls.some(c => c.method === 'POST' && c.path === '/repos/octo/repo-butler/issues'), 'issue filed on host');
  });

  it('a failed write (e.g. target with issues disabled) is isolated, not fatal to the run', async () => {
    const gh = {
      calls: [],
      request: async (path, opts) => {
        if (opts?.method === 'POST' && path.endsWith('/issues')) throw new Error('Issues are disabled for this repo');
        return {};
      },
      paginate: async () => [],
      getFileContent: async () => '# CLAUDE.md\n\nManaged by repo-butler.',
    };
    const result = await propose(ctx({ gh, dryRun: false }));
    assert.equal(result.created.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].repo, 'teams-for-linux');
    assert.equal(result.failures[0].crossRepo, true);
  });
});

describe('propose — per-target volume cap (G6)', () => {
  const base = (over) => ({
    owner: 'octo', repo: 'repo-butler', token: 'unused', dryRun: true,
    governanceFindings: [{ type: 'policy-drift', repo: 'teams-for-linux' }],
    portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
    config: {
      limits: { require_approval: false },
      'propose-targets': { 'teams-for-linux': true },
      'propose-classes': { 'policy-drift': true },
    },
    ideas: [
      { title: 'Adopt the portfolio licence', priority: 'high', labels: [], body: 'b1.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' },
      { title: 'Pin GitHub Actions by SHA', priority: 'medium', labels: [], body: 'b2.', rationale: '12/14 repos pin their actions.', targetRepo: 'teams-for-linux' },
    ],
    ...over,
  });

  it('caps cross-repo issues per target at the default of 1', async () => {
    const gh = stubGh();
    const result = await propose(base({ gh }));
    assert.equal(result.created.filter(c => c.crossRepo).length, 1, 'only one issue filed to the target');
    assert.equal(result.skippedCapped.length, 1);
    assert.equal(result.skippedCapped[0].repo, 'teams-for-linux');
  });

  it('honours a higher max_issues_per_target', async () => {
    const gh = stubGh();
    const result = await propose(base({ gh, config: {
      limits: { require_approval: false, max_issues_per_target: 2 },
      'propose-targets': { 'teams-for-linux': true },
      'propose-classes': { 'policy-drift': true },
    } }));
    assert.equal(result.created.filter(c => c.crossRepo).length, 2);
    assert.equal(result.skippedCapped.length, 0);
  });

  it('does not apply the per-target cap to the host (host stays bounded only by per-run)', async () => {
    const gh = stubGh();
    // Three host ideas; default max_issues_per_target is 1 but the host is exempt,
    // so all three still file (bounded only by max_issues_per_run = 3).
    const result = await propose(base({
      gh,
      ideas: [
        { title: 'Host one', priority: 'high', labels: [], body: 'b1.', targetRepo: null },
        { title: 'Host two', priority: 'medium', labels: [], body: 'b2.', targetRepo: null },
        { title: 'Host three', priority: 'low', labels: [], body: 'b3.', targetRepo: null },
      ],
    }));
    assert.equal(result.created.length, 3);
    assert.equal(result.skippedCapped.length, 0);
  });

  it('gives each distinct cross-repo target its own independent quota', async () => {
    const gh = stubGh();
    const result = await propose({
      gh,
      owner: 'octo', repo: 'repo-butler', token: 'unused', dryRun: true,
      governanceFindings: [{ type: 'policy-drift', repo: 'teams-for-linux' }, { type: 'policy-drift', repo: 'bonnie-wee-plot' }],
      portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }, { name: 'bonnie-wee-plot', archived: false, fork: false }] },
      config: {
        limits: { require_approval: false },
        'propose-targets': { 'teams-for-linux': true, 'bonnie-wee-plot': true },
        'propose-classes': { 'policy-drift': true },
      },
      ideas: [
        { title: 'Licence for A', priority: 'high', labels: [], body: 'b.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' },
        { title: 'Licence for B', priority: 'medium', labels: [], body: 'b.', rationale: '12/14 repos declare a licence.', targetRepo: 'bonnie-wee-plot' },
      ],
    });
    const cross = result.created.filter(c => c.crossRepo);
    assert.equal(cross.length, 2, 'one per target — the cap is per-target, not global');
    assert.deepEqual(cross.map(c => c.routedRepo).sort(), ['bonnie-wee-plot', 'teams-for-linux']);
    assert.equal(result.skippedCapped.length, 0);
  });

  it('treats max_issues_per_target: 0 as a kill switch — no cross-repo issue files', async () => {
    const gh = stubGh();
    const result = await propose(base({ gh, config: {
      limits: { require_approval: false, max_issues_per_target: 0 },
      'propose-targets': { 'teams-for-linux': true },
      'propose-classes': { 'policy-drift': true },
    } }));
    assert.equal(result.created.filter(c => c.crossRepo).length, 0);
    assert.equal(result.skippedCapped.length, 2); // both base() ideas target teams-for-linux
  });

  it('caps the live (non-dry-run) write path at the target as well', async () => {
    const gh = stubGh();
    await propose(base({ gh, dryRun: false }));
    const posts = gh.calls.filter(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues');
    assert.equal(posts.length, 1, 'cap 1: only one POST to the target despite two eligible ideas');
  });

  it('fails safe to the default cap when max_issues_per_target is non-numeric (does not silently disable)', async () => {
    const gh = stubGh();
    // A YAML typo like `max_issues_per_target: two` must NOT disable the cap —
    // it falls back to the default of 1, so only one of the two ideas files.
    const result = await propose(base({ gh, config: {
      limits: { require_approval: false, max_issues_per_target: 'two' },
      'propose-targets': { 'teams-for-linux': true },
      'propose-classes': { 'policy-drift': true },
    } }));
    assert.equal(result.created.filter(c => c.crossRepo).length, 1);
    assert.equal(result.skippedCapped.length, 1);
  });

  it('does not re-file a cross-repo nudge that was previously governance-declined (closed long ago)', async () => {
    const old = new Date(Date.now() - 200 * 86400000).toISOString();
    const gh = {
      calls: [],
      request: async (path, opts) => { gh.calls.push({ path, method: opts?.method }); return {}; },
      paginate: async (path, opts) => {
        // A long-closed, governance-declined issue on the target whose title
        // matches the first idea — must permanently suppress re-filing (G7).
        if (path.includes('/issues') && opts?.params?.state === 'closed') {
          return [{ number: 8, title: 'Adopt the portfolio licence', closed_at: old, labels: [{ name: 'governance-declined' }] }];
        }
        return [];
      },
      getFileContent: async () => '# CLAUDE.md\n\nManaged by repo-butler.',
    };
    const result = await propose(base({
      gh, dryRun: false,
      ideas: [{ title: 'Adopt the portfolio licence', priority: 'high', labels: [], body: 'b.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' }],
    }));
    assert.equal(result.created.length, 0);
    assert.ok(!gh.calls.some(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues'), 'declined nudge not re-filed');
  });

  it('a duplicate-skipped idea does not consume the target quota', async () => {
    // The first idea matches an existing issue (a dup) and is skipped WITHOUT
    // consuming teams-for-linux's quota, so the second idea still files.
    const gh = {
      calls: [],
      request: async (path, opts) => { gh.calls.push({ path, method: opts?.method }); return {}; },
      paginate: async (path) => {
        gh.calls.push({ path });
        if (path.includes('/issues')) return [{ number: 9, title: 'Adopt the portfolio licence' }];
        return [];
      },
      getFileContent: async () => '# CLAUDE.md\n\nManaged by repo-butler.',
    };
    const result = await propose(base({ gh }));
    const cross = result.created.filter(c => c.crossRepo);
    assert.equal(cross.length, 1);
    assert.equal(cross[0].title, 'Pin GitHub Actions by SHA', 'the second idea fills the quota the dup did not consume');
  });
});

describe('buildCrossRepoIssueBody (G9 deterministic body)', () => {
  it('composes a standards-gap body from the finding statistic alone', () => {
    const finding = { type: 'standards-gap', tool: 'dependabot-auto-merge', compliant: ['a', 'b', 'c'], nonCompliant: ['target'], adoptionRate: 0.75 };
    const body = buildCrossRepoIssueBody(finding, { trackingUrl: 'https://github.com/IsmaelMartinez/repo-butler/issues/5' });
    assert.ok(body.includes('3 of 4'), 'adoption fraction from the finding');
    assert.ok(body.includes('75% adoption'));
    assert.ok(body.includes('dependabot-auto-merge'));
    assert.ok(body.includes('https://github.com/IsmaelMartinez/repo-butler/issues/5'), 'bare-URL back-link present');
  });

  it('composes a policy-drift body with the expected/actual comparison', () => {
    const body = buildCrossRepoIssueBody({ type: 'policy-drift', category: 'ci-reliability', expected: '95%', actual: '70%' }, {});
    assert.ok(body.includes('ci-reliability'));
    assert.ok(body.includes('70%') && body.includes('95%'));
  });

  it('composes a tier-uplift body listing the named failing checks', () => {
    const body = buildCrossRepoIssueBody({ type: 'tier-uplift', currentTier: 'silver', targetTier: 'gold', failingChecks: [{ name: 'Code scanning' }, { name: 'Secret scanning' }] }, {});
    assert.ok(body.includes('silver') && body.includes('gold'));
    assert.ok(body.includes('Code scanning') && body.includes('Secret scanning'));
    assert.ok(body.includes('2 check'));
  });

  it('omits the back-link line when no tracking URL is supplied (dry-run)', () => {
    const body = buildCrossRepoIssueBody({ type: 'policy-drift', category: 'license', expected: 'MIT', actual: 'None' }, { trackingUrl: null });
    assert.ok(!body.includes('Tracked in the repo-butler portfolio backlog'));
  });

  it('never carries a cross-reference autolink — passes validateIssueBody({crossRepo:true})', () => {
    const findings = [
      { type: 'standards-gap', tool: 't', compliant: ['a'], nonCompliant: ['b'], adoptionRate: 0.5 },
      { type: 'policy-drift', category: 'license', expected: 'MIT', actual: 'GPL-3.0' },
      { type: 'tier-uplift', currentTier: 'bronze', targetTier: 'silver', failingChecks: [{ name: 'CI' }] },
    ];
    for (const finding of findings) {
      const body = buildCrossRepoIssueBody(finding, { trackingUrl: 'https://github.com/IsmaelMartinez/repo-butler/issues/5' });
      assert.ok(validateIssueBody(body, { crossRepo: true }).valid, `clean cross-repo body for ${finding.type}`);
    }
  });

  it('falls back to a safe portfolio-grounded line for an unknown anchor type', () => {
    const body = buildCrossRepoIssueBody({ type: 'dependabot-stale' }, {});
    assert.ok(body.includes('portfolio-wide governance comparison'));
    assert.ok(validateIssueBody(body, { crossRepo: true }).valid);
  });
});

describe('ensureTrackingIssue (G9 host umbrella)', () => {
  const hostGh = (issues, posts) => ({
    paginate: async () => issues,
    request: async (path, opts) => { posts.push({ path, body: opts?.body }); return { html_url: 'https://github.com/octo/repo-butler/issues/99' }; },
  });

  it('returns null in dry-run and performs no write', async () => {
    const posts = [];
    const url = await ensureTrackingIssue(hostGh([], posts), 'octo', 'repo-butler', ['l'], { dryRun: true });
    assert.equal(url, null);
    assert.equal(posts.length, 0);
  });

  it('reuses an existing umbrella issue matched by its stable title', async () => {
    const posts = [];
    const existing = [{ number: 7, title: 'Portfolio nudges — cross-repo proposal tracker', html_url: 'https://github.com/octo/repo-butler/issues/7' }];
    const url = await ensureTrackingIssue(hostGh(existing, posts), 'octo', 'repo-butler', ['l'], { dryRun: false });
    assert.equal(url, 'https://github.com/octo/repo-butler/issues/7');
    assert.equal(posts.length, 0, 'no new umbrella created when one already exists');
  });

  it('creates the umbrella when none exists and returns its URL', async () => {
    const posts = [];
    const url = await ensureTrackingIssue(hostGh([], posts), 'octo', 'repo-butler', ['l'], { dryRun: false });
    assert.equal(url, 'https://github.com/octo/repo-butler/issues/99');
    assert.equal(posts.length, 1);
    assert.ok(posts[0].body.title.includes('Portfolio nudges'));
  });

  it('returns null on any API error rather than blocking the nudge', async () => {
    const gh = { paginate: async () => { throw new Error('boom'); }, request: async () => ({}) };
    assert.equal(await ensureTrackingIssue(gh, 'octo', 'repo-butler', ['l'], { dryRun: false }), null);
  });
});

describe('propose — onboarding precondition (G9)', () => {
  const ctx = (over) => ({
    owner: 'octo', repo: 'repo-butler', token: 'unused', dryRun: true,
    governanceFindings: [{ type: 'policy-drift', repo: 'teams-for-linux', category: 'license', expected: 'MIT', actual: 'None' }],
    portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
    config: { limits: { require_approval: false }, 'propose-targets': { 'teams-for-linux': true }, 'propose-classes': { 'policy-drift': true } },
    ideas: [{ title: 'Adopt the portfolio licence', priority: 'medium', labels: [], body: 'b.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' }],
    ...over,
  });

  it('routes to the target when it carries the onboarding marker', async () => {
    const result = await propose(ctx({ gh: stubGh() }));
    assert.equal(result.created[0].crossRepo, true);
    assert.equal(result.created[0].routedRepo, 'teams-for-linux');
  });

  it('falls back to the host when the target is NOT onboarded (no marker)', async () => {
    const gh = stubGh();
    gh.getFileContent = async () => '# CLAUDE.md\n\nno marker here';
    const result = await propose(ctx({ gh }));
    assert.equal(result.created[0].crossRepo, false);
    assert.equal(result.created[0].routedRepo, 'repo-butler');
    assert.equal(result.created[0].routeReason, 'target-not-onboarded');
  });

  it('falls back to the host when CLAUDE.md is missing (getFileContent null)', async () => {
    const gh = stubGh();
    gh.getFileContent = async () => null;
    const result = await propose(ctx({ gh }));
    assert.equal(result.created[0].crossRepo, false);
  });

  it('fails closed to the host when the onboarding read throws', async () => {
    const gh = stubGh();
    gh.getFileContent = async () => { throw new Error('403'); };
    const result = await propose(ctx({ gh }));
    assert.equal(result.created[0].crossRepo, false);
    assert.equal(result.created[0].routedRepo, 'repo-butler');
  });

  it('performs NO onboarding read when the allow-lists are empty (byte-identical)', async () => {
    let reads = 0;
    const gh = stubGh();
    gh.getFileContent = async () => { reads++; return '# CLAUDE.md\n\nrepo-butler'; };
    // Empty maps → the targeted idea never routes cross-repo, so the onboarding
    // precondition (a read) must not fire at all.
    await propose(ctx({ gh, config: { limits: { require_approval: false } } }));
    assert.equal(reads, 0, 'no onboarding read when nothing routes cross-repo');
  });

  it('checks each distinct target only once per run (cached)', async () => {
    let reads = 0;
    const gh = stubGh();
    gh.getFileContent = async () => { reads++; return '# CLAUDE.md\n\nrepo-butler'; };
    await propose(ctx({
      gh,
      config: { limits: { require_approval: false, max_issues_per_target: 5 }, 'propose-targets': { 'teams-for-linux': true }, 'propose-classes': { 'policy-drift': true } },
      ideas: [
        { title: 'Adopt the portfolio licence', priority: 'high', labels: [], body: 'b.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' },
        { title: 'Pin GitHub Actions by SHA', priority: 'medium', labels: [], body: 'b.', rationale: '12/14 repos pin actions.', targetRepo: 'teams-for-linux' },
      ],
    }));
    assert.equal(reads, 1, 'onboarding read cached per target across ideas');
  });
});

describe('propose — portfolio-nudge label & host tracking issue (G9)', () => {
  const ctx = (over) => ({
    owner: 'octo', repo: 'repo-butler', token: 'unused', dryRun: false,
    governanceFindings: [{ type: 'policy-drift', repo: 'teams-for-linux', category: 'license', expected: 'MIT', actual: 'None' }],
    portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
    config: { limits: { require_approval: false }, 'propose-targets': { 'teams-for-linux': true }, 'propose-classes': { 'policy-drift': true } },
    ideas: [{ title: 'Adopt the portfolio licence', priority: 'medium', labels: [], body: 'b.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' }],
    ...over,
  });

  it('adds the portfolio-nudge label to a cross-repo issue and ensures it on the target', async () => {
    const gh = stubGh();
    const result = await propose(ctx({ gh }));
    assert.ok(result.created[0].labels.includes('portfolio-nudge'), 'soak record carries the nudge label');
    assert.ok(gh.calls.some(c => c.path === '/repos/octo/teams-for-linux/labels/portfolio-nudge'), 'nudge label ensured on the target');
    const post = gh.calls.find(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues');
    assert.ok(post.body.labels.includes('portfolio-nudge'), 'filed issue carries the nudge label');
  });

  it('never adds the portfolio-nudge label to a host issue', async () => {
    const gh = stubGh();
    // Empty maps → the targeted idea falls back to the host backlog.
    const result = await propose(ctx({ gh, config: { limits: { require_approval: false } } }));
    assert.equal(result.created[0].crossRepo, false);
    assert.ok(!result.created[0].labels.includes('portfolio-nudge'));
    assert.ok(!gh.calls.some(c => c.path.includes('portfolio-nudge')), 'nudge label never touched on the host');
  });

  it('files a single host-side umbrella tracking issue when a cross-repo issue is filed', async () => {
    const gh = stubGh();
    await propose(ctx({ gh }));
    const umbrella = gh.calls.find(c => c.method === 'POST' && c.path === '/repos/octo/repo-butler/issues' && c.body?.title?.includes('Portfolio nudges'));
    assert.ok(umbrella, 'host-side umbrella tracking issue created');
  });

  it('reuses an existing umbrella and back-links the cross-repo body to it via a bare URL', async () => {
    const gh = stubGh();
    gh.paginate = async (path, opts) => {
      gh.calls.push({ path, method: 'GET' });
      if (path === '/repos/octo/repo-butler/issues' && opts?.params?.state === 'open') {
        return [{ number: 7, title: 'Portfolio nudges — cross-repo proposal tracker', html_url: 'https://github.com/octo/repo-butler/issues/7' }];
      }
      return [];
    };
    await propose(ctx({ gh }));
    assert.ok(!gh.calls.some(c => c.method === 'POST' && c.path === '/repos/octo/repo-butler/issues' && c.body?.title?.includes('Portfolio nudges')), 'existing umbrella reused, not recreated');
    const post = gh.calls.find(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues');
    assert.ok(post.body.body.includes('https://github.com/octo/repo-butler/issues/7'), 'bare-URL back-link to the reused umbrella');
  });

  it('creates no tracking issue in dry-run (no writes at all)', async () => {
    const gh = stubGh();
    await propose(ctx({ gh, dryRun: true }));
    assert.ok(!gh.calls.some(c => c.method === 'POST'), 'dry-run performs no writes, including the tracker');
  });
});

describe('propose — cross-repo title gate & anchor coverage (G9 review hardening)', () => {
  const base = (over) => ({
    owner: 'octo', repo: 'repo-butler', token: 'unused', dryRun: false,
    config: { limits: { require_approval: false }, 'propose-targets': { 'teams-for-linux': true } },
    ...over,
  });

  it('drives a standards-gap anchor (matched via nonCompliant) through the live path and posts the statistic in the body', async () => {
    const gh = stubGh();
    const result = await propose(base({
      gh,
      governanceFindings: [{ type: 'standards-gap', tool: 'dependabot-auto-merge', compliant: ['a', 'b', 'c'], nonCompliant: ['teams-for-linux'], adoptionRate: 0.75 }],
      portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
      config: { limits: { require_approval: false }, 'propose-targets': { 'teams-for-linux': true }, 'propose-classes': { 'standards-gap': true } },
      ideas: [{ title: 'Adopt dependabot auto-merge', priority: 'high', labels: [], body: 'b.', rationale: '3 of 4 repos adopt this.', targetRepo: 'teams-for-linux' }],
    }));
    assert.equal(result.created[0].crossRepo, true);
    const post = gh.calls.find(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues');
    assert.ok(post.body.body.includes('3 of 4'), 'live standards-gap body carries the adoption fraction');
    assert.ok(post.body.body.includes('75% adoption') && post.body.body.includes('dependabot-auto-merge'));
  });

  it('drives a tier-uplift anchor through the live path and posts the tiers and named checks', async () => {
    const gh = stubGh();
    const result = await propose(base({
      gh,
      governanceFindings: [{ type: 'tier-uplift', repo: 'teams-for-linux', currentTier: 'silver', targetTier: 'gold', failingChecks: [{ name: 'Code scanning' }] }],
      portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
      config: { limits: { require_approval: false }, 'propose-targets': { 'teams-for-linux': true }, 'propose-classes': { 'tier-uplift': true } },
      ideas: [{ title: 'Reach the gold tier', priority: 'high', labels: [], body: 'b.', rationale: '12 of 14 repos are gold.', targetRepo: 'teams-for-linux' }],
    }));
    assert.equal(result.created[0].crossRepo, true);
    const post = gh.calls.find(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues');
    assert.ok(post.body.body.includes('silver') && post.body.body.includes('gold') && post.body.body.includes('Code scanning'));
  });

  it('skips a cross-repo idea whose TITLE carries a #N / @mention / per-repo-code claim (gate, not just the body)', async () => {
    const gh = stubGh();
    const result = await propose(base({
      gh,
      governanceFindings: [{ type: 'policy-drift', repo: 'teams-for-linux', category: 'license', expected: 'MIT', actual: 'None' }],
      portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
      config: { limits: { require_approval: false }, 'propose-targets': { 'teams-for-linux': true }, 'propose-classes': { 'policy-drift': true } },
      // Rationale is clean (admits at the gate), but the title makes a per-repo code
      // claim AND a bare #N cross-ref — both must be caught by the cross-repo title gate.
      ideas: [{ title: 'Fix the flaky test #42', priority: 'high', labels: [], body: 'b.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' }],
    }));
    assert.equal(result.created.length, 0, 'idea with a tainted cross-repo title is skipped');
    assert.ok(!gh.calls.some(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues'), 'no issue filed on the target');
  });

  it('a mixed host+cross-repo run labels only the target with portfolio-nudge, never the host', async () => {
    const gh = stubGh();
    const result = await propose(base({
      gh,
      governanceFindings: [{ type: 'policy-drift', repo: 'teams-for-linux', category: 'license', expected: 'MIT', actual: 'None' }],
      portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
      config: { limits: { require_approval: false, max_issues_per_target: 5 }, 'propose-targets': { 'teams-for-linux': true }, 'propose-classes': { 'policy-drift': true } },
      ideas: [
        { title: 'A plain host idea', priority: 'high', labels: [], body: 'host.', targetRepo: null },
        { title: 'Align the portfolio licence', priority: 'medium', labels: [], body: 'x.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' },
      ],
    }));
    const host = result.created.find(c => !c.crossRepo);
    const cross = result.created.find(c => c.crossRepo);
    assert.ok(host && cross, 'both a host and a cross-repo issue filed in one run');
    assert.ok(!host.labels.includes('portfolio-nudge'), 'host issue not nudge-labelled');
    assert.ok(cross.labels.includes('portfolio-nudge'), 'cross-repo issue nudge-labelled');
    assert.ok(!gh.calls.some(c => c.path.includes('/repos/octo/repo-butler/') && c.path.includes('portfolio-nudge')), 'nudge label never ensured on the host repo');
  });

  it('a non-onboarded target downgrades every idea to the host and the per-target cap never fires', async () => {
    const gh = stubGh();
    gh.getFileContent = async () => '# CLAUDE.md\n\nno marker'; // target not onboarded
    const result = await propose(base({
      gh, dryRun: true,
      governanceFindings: [{ type: 'policy-drift', repo: 'teams-for-linux', category: 'license', expected: 'MIT', actual: 'None' }],
      portfolio: { repos: [{ name: 'teams-for-linux', archived: false, fork: false }] },
      config: { limits: { require_approval: false }, 'propose-targets': { 'teams-for-linux': true }, 'propose-classes': { 'policy-drift': true } }, // default max_issues_per_target: 1
      ideas: [
        { title: 'Licence one', priority: 'high', labels: [], body: 'b.', rationale: '13/14 repos declare a licence.', targetRepo: 'teams-for-linux' },
        { title: 'Pin actions by SHA', priority: 'medium', labels: [], body: 'b.', rationale: '12/14 repos pin actions.', targetRepo: 'teams-for-linux' },
      ],
    }));
    assert.equal(result.created.length, 2, 'both ideas file on the host (downgraded), not capped');
    assert.ok(result.created.every(c => !c.crossRepo && c.routedRepo === 'repo-butler'));
    assert.equal(result.skippedCapped.length, 0, 'the cross-repo per-target cap never fires for downgraded ideas');
  });
});
