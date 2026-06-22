import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity, buildIssueBody, findDuplicatePRs, isGovernanceDeclined, propose, resolveProposalDestination } from './propose.js';
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
    request: async (path, opts) => { calls.push({ path, method: opts?.method }); return {}; },
    paginate: async (path) => { calls.push({ path, method: 'GET' }); return []; },
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

  it('requires an explicit true in the maps, not an arbitrary truthy value', () => {
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

  it('applies the cross-reference autolink gate (G3) to a cross-repo body via crossRepo:true', async () => {
    const gh = stubGh();
    // A bare #N autolink in a cross-repo-destined body would mis-link in the
    // target repo; validateIssueBody({crossRepo:true}) must reject it, so the
    // idea is skipped and no issue is filed on the target.
    // The #N lives in the rationale (which buildIssueBody composes into the body
    // in structured mode); the statistic '13/14' still admits the idea at the gate.
    const result = await propose(ctx({
      gh, dryRun: false,
      ideas: [{ title: 'Adopt licence', priority: 'medium', labels: [], body: 'A nudge.', rationale: '13/14 repos declare a licence; see #42 for context.', targetRepo: 'teams-for-linux' }],
    }));
    assert.equal(result.created.length, 0);
    assert.ok(!gh.calls.some(c => c.method === 'POST' && c.path === '/repos/octo/teams-for-linux/issues'), 'cross-repo body with #N rejected, not filed');
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
});
