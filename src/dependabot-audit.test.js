import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditDependabot } from './dependabot-audit.js';

function daysAgoISO(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function makeGh(prsPerRepo = {}) {
  return {
    paginate: async (path) => {
      const match = path.match(/\/repos\/[^/]+\/([^/]+)\/pulls/);
      const repo = match?.[1];
      return prsPerRepo[repo] || [];
    },
  };
}

describe('auditDependabot', () => {
  it('returns empty for repos with no stale PRs', async () => {
    const repos = [{ name: 'my-repo', archived: false, fork: false }];
    const gh = makeGh({
      'my-repo': [
        { number: 1, title: 'Bump foo', user: { login: 'dependabot[bot]' }, created_at: daysAgoISO(10) },
        { number: 2, title: 'Feature PR', user: { login: 'human' }, created_at: daysAgoISO(90) },
      ],
    });

    const findings = await auditDependabot(gh, 'owner', repos);
    assert.deepEqual(findings, []);
  });

  it('returns finding for repos with PRs older than 30 days', async () => {
    const repos = [{ name: 'stale-repo', archived: false, fork: false }];
    const gh = makeGh({
      'stale-repo': [
        { number: 42, title: 'Bump eslint from 8 to 9', user: { login: 'dependabot[bot]' }, created_at: daysAgoISO(45) },
      ],
    });

    const findings = await auditDependabot(gh, 'owner', repos);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'dependabot-stale');
    assert.equal(findings[0].repo, 'stale-repo');
    assert.equal(findings[0].stalePRs.length, 1);
    assert.equal(findings[0].stalePRs[0].number, 42);
    assert.equal(findings[0].stalePRs[0].age, 45);
    assert.equal(findings[0].priority, 'medium');
  });

  it('sets priority to high when PR age exceeds 60 days', async () => {
    const repos = [{ name: 'old-repo', archived: false, fork: false }];
    const gh = makeGh({
      'old-repo': [
        { number: 10, title: 'Bump lodash', user: { login: 'dependabot[bot]' }, created_at: daysAgoISO(75) },
      ],
    });

    const findings = await auditDependabot(gh, 'owner', repos);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].priority, 'high');
    assert.equal(findings[0].stalePRs[0].age, 75);
  });

  it('skips archived and forked repos', async () => {
    const repos = [
      { name: 'archived-repo', archived: true, fork: false },
      { name: 'forked-repo', archived: false, fork: true },
      { name: 'test-repo-thing', archived: false, fork: false },
    ];
    const gh = makeGh({
      'archived-repo': [
        { number: 1, title: 'Bump X', user: { login: 'dependabot[bot]' }, created_at: daysAgoISO(90) },
      ],
      'forked-repo': [
        { number: 2, title: 'Bump Y', user: { login: 'dependabot[bot]' }, created_at: daysAgoISO(90) },
      ],
      'test-repo-thing': [
        { number: 3, title: 'Bump Z', user: { login: 'dependabot[bot]' }, created_at: daysAgoISO(90) },
      ],
    });

    const findings = await auditDependabot(gh, 'owner', repos);
    assert.deepEqual(findings, []);
  });

  it('handles API errors gracefully', async () => {
    const repos = [
      { name: 'good-repo', archived: false, fork: false },
      { name: 'bad-repo', archived: false, fork: false },
    ];
    const gh = {
      paginate: async (path) => {
        if (path.includes('bad-repo')) {
          throw new Error('GitHub API GET /repos/owner/bad-repo/pulls: 403 Resource not accessible');
        }
        return [
          { number: 5, title: 'Bump deps', user: { login: 'dependabot[bot]' }, created_at: daysAgoISO(40) },
        ];
      },
    };

    const findings = await auditDependabot(gh, 'owner', repos);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].repo, 'good-repo');
  });
});
