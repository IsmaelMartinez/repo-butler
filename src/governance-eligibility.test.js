import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditDependabot } from './dependabot-audit.js';
import { auditButlerPRs } from './butler-pr-audit.js';
import { detectStalledAlerts } from './stalled-alert.js';
import { eligibleRepos, fetchOpenPRs } from './governance.js';

// Characterisation of the eligibility filter and open-PR fallback that the
// three governance-lane audits and governance.fetchOpenPRs share (#416). Every
// case runs against all four callers, so a drift in any one copy — or in the
// shared helper they now import — fails here.

function makeRepo(name, overrides = {}) {
  return { name, archived: false, fork: false, ...overrides };
}

const REPOS = [
  makeRepo('keep-me'),
  makeRepo('testing-tools'), // contains "test" but not an exclusion pattern
  makeRepo('gone-archived', { archived: true }),
  makeRepo('gone-fork', { fork: true }),
  makeRepo('my-shadow-env'),
  makeRepo('test-repo-lab'),
];
const ELIGIBLE = ['keep-me', 'testing-tools'];

const PULLS_OPTS = { params: { state: 'open', sort: 'created', direction: 'asc' }, max: 100 };

// A medium alert past the stalled-alert threshold, so detectStalledAlerts
// reaches its open-PR read for every repo it considers.
const STALE_ALERT = {
  number: 1,
  state: 'open',
  created_at: new Date(Date.now() - 40 * 86400000).toISOString(),
  dependency: { package: { ecosystem: 'npm', name: 'left-pad' }, manifest_path: 'package-lock.json' },
  security_vulnerability: { severity: 'medium', first_patched_version: { identifier: '1.3.1' } },
};

// Fake client recording every open-PR listing. `throwFor` names a repo whose
// listing throws; `returnFor` overrides the listing for a repo.
function makeGh({ throwFor = null, returnFor = {} } = {}) {
  const pulls = [];
  const considered = [];
  return {
    pulls,
    considered,
    paginate: async (path, opts) => {
      const repo = path.match(/^\/repos\/owner\/([^/]+)\/pulls$/)?.[1];
      pulls.push({ repo, path, opts });
      if (repo === throwFor) throw Object.assign(new Error('boom'), { status: 500 });
      return repo in returnFor ? returnFor[repo] : [];
    },
    request: async (path) => {
      const repo = path.match(/\/repos\/owner\/([^/]+)\/dependabot\/alerts/)?.[1];
      considered.push(repo);
      return [STALE_ALERT];
    },
    getFileContent: async () => null,
    prCiState: async () => 'green',
    prCiHistory: async () => [],
  };
}

const CALLERS = [
  { name: 'auditDependabot', run: (gh, repos, openPRs) => auditDependabot(gh, 'owner', repos, { openPRs }) },
  { name: 'auditButlerPRs', run: (gh, repos, openPRs) => auditButlerPRs(gh, 'owner', repos, { openPRs }) },
  { name: 'detectStalledAlerts', run: (gh, repos, openPRs) => detectStalledAlerts(gh, 'owner', repos, { openPRs }) },
  // fetchOpenPRs takes no map; the fallback cases below skip it.
  { name: 'fetchOpenPRs', run: (gh, repos) => fetchOpenPRs(gh, 'owner', repos), sweep: true },
];

const listed = (gh) => gh.pulls.map(p => p.repo).sort();

describe('governance eligibility — shared by the three audits and fetchOpenPRs', () => {
  it('eligibleRepos keeps only non-archived, non-fork, non-excluded repos', () => {
    assert.deepEqual(eligibleRepos(REPOS).map(r => r.name), ELIGIBLE);
  });

  it('eligibleRepos filters a private: true repo (defence in depth; private repos never enter governance)', () => {
    const repos = [makeRepo('keep-me'), makeRepo('secret-thing', { private: true })];
    assert.deepEqual(eligibleRepos(repos).map(r => r.name), ['keep-me']);
  });

  for (const c of CALLERS) {
    it(`${c.name}: lists open PRs only for eligible repos (archived, fork, shadow, test-repo skipped)`, async () => {
      const gh = makeGh();
      await c.run(gh, REPOS, null);
      assert.deepEqual(listed(gh), ELIGIBLE);
    });

    it(`${c.name}: never lists a private: true repo`, async () => {
      const gh = makeGh();
      await c.run(gh, [makeRepo('keep-me'), makeRepo('secret-thing', { private: true })], null);
      assert.deepEqual(listed(gh), ['keep-me']);
      if (gh.considered.length) assert.deepEqual(gh.considered, ['keep-me']);
    });

    it(`${c.name}: lists with the exact open-PR path and params`, async () => {
      const gh = makeGh();
      await c.run(gh, [makeRepo('keep-me')], null);
      assert.deepEqual(gh.pulls, [{ repo: 'keep-me', path: '/repos/owner/keep-me/pulls', opts: PULLS_OPTS }]);
    });

    it(`${c.name}: a listing that throws for one repo does not lose the others or reject`, async () => {
      const gh = makeGh({ throwFor: 'keep-me' });
      const out = await c.run(gh, [makeRepo('keep-me'), makeRepo('other')], null);
      assert.deepEqual(listed(gh), ['keep-me', 'other']);
      if (c.sweep) assert.deepEqual(Object.keys(out), ['other']);
      else assert.ok(Array.isArray(out));
    });

    if (c.sweep) continue;

    it(`${c.name}: an empty openPRs map falls back to listing every eligible repo`, async () => {
      const gh = makeGh();
      await c.run(gh, REPOS, {});
      assert.deepEqual(listed(gh), ELIGIBLE);
    });

    it(`${c.name}: an openPRs map lacking a repo lists only that repo`, async () => {
      const gh = makeGh();
      await c.run(gh, REPOS, { 'keep-me': [] });
      assert.deepEqual(listed(gh), ['testing-tools']);
    });

    it(`${c.name}: an empty array in the map is trusted, a null entry falls back`, async () => {
      const gh = makeGh();
      await c.run(gh, REPOS, { 'keep-me': [], 'testing-tools': null });
      assert.deepEqual(listed(gh), ['testing-tools']);
    });

    it(`${c.name}: a fallback listing that throws is contained per repo`, async () => {
      const gh = makeGh({ throwFor: 'testing-tools' });
      const out = await c.run(gh, REPOS, { 'keep-me': [] });
      assert.ok(Array.isArray(out));
      assert.deepEqual(listed(gh), ['testing-tools']);
    });
  }

  it('fetchOpenPRs drops a repo whose listing is not an array', async () => {
    const gh = makeGh({ returnFor: { 'keep-me': null } });
    const out = await fetchOpenPRs(gh, 'owner', [makeRepo('keep-me'), makeRepo('other')]);
    assert.deepEqual(out, { other: [] });
  });
});
