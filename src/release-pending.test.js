import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleasePR, parseReleaseVersion, pullRequestTriggerApplies, detectPendingReleases, GRACE_DAYS,
} from './release-pending.js';
import { buildRemediationPlan, releaseCommands } from './governance.js';

const daysAgoISO = n => new Date(Date.now() - n * 86400000).toISOString();
const SHA = 'a'.repeat(40);

function makePR(number, overrides = {}) {
  return {
    number,
    title: 'chore(main): release 2.31.0',
    created_at: daysAgoISO(5),
    user: { login: 'github-actions[bot]', type: 'Bot' },
    labels: [{ name: 'autorelease: pending' }],
    head: { ref: 'release-please--branches--main', sha: SHA, repo: { full_name: 'o/app' } },
    base: { ref: 'main', repo: { full_name: 'o/app' } },
    ...overrides,
  };
}

const BUILD_YML = 'name: Build\non:\n  push:\n    branches:\n      - main\n  pull_request:\n  workflow_dispatch:\n';
const DOCS_YML = "on:\n  pull_request:\n    paths:\n      - 'docs-site/**'\n";

// Fake client: the reads the detector makes, routed by path.
function makeGh({
  prs = [makePR(7)],
  checkRuns = [{ app: { slug: 'sonarcloud' } }],
  checkRunsThrow = false,
  workflows = [{ path: '.github/workflows/build.yml', state: 'active' }],
  files = { '.github/workflows/build.yml': BUILD_YML },
  baseFiles = null,
  ciState = 'green',
  repoInfo = { allow_squash_merge: true },
  latestRelease = { published_at: daysAgoISO(10) },
  bugs = [],
  listThrows = false,
} = {}) {
  const calls = [];
  return {
    calls,
    paginate: async (path) => {
      calls.push(path);
      if (path.endsWith('/pulls')) { if (listThrows) throw Object.assign(new Error('boom'), { status: 500 }); return prs; }
      if (path.endsWith('/issues')) return bugs;
      return [];
    },
    request: async (path, opts) => {
      calls.push(path);
      if (path.includes('/check-runs')) {
        if (checkRunsThrow) throw new Error('boom');
        return { total_count: checkRuns.length, check_runs: checkRuns };
      }
      if (path.endsWith('/actions/workflows')) return { total_count: workflows.length, workflows };
      const file = path.match(/\/contents\/(.+)$/)?.[1];
      if (file) {
        const side = opts?.params?.ref === 'main' ? (baseFiles ?? files) : files;
        const text = side[file];
        if (text === undefined) throw Object.assign(new Error('nf'), { status: 404 });
        if (text === 'ERR') throw Object.assign(new Error('boom'), { status: 500 });
        return { content: Buffer.from(text).toString('base64') };
      }
      if (path.endsWith('/releases/latest')) { if (!latestRelease) throw Object.assign(new Error('nf'), { status: 404 }); return latestRelease; }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return repoInfo;
      throw new Error(`unexpected ${path}`);
    },
    prCiState: async () => ciState,
    prCiHistory: async () => [],
  };
}

const repos = [{ name: 'app', archived: false, fork: false }];

describe('isReleasePR', () => {
  it('accepts any two of branch, bot author and label', () => {
    assert.equal(isReleasePR(makePR(1)), true);
    assert.equal(isReleasePR(makePR(1, { labels: [] })), true);
    assert.equal(isReleasePR(makePR(1, { user: { login: 'someone' } })), true);
    assert.equal(isReleasePR(makePR(1, { head: { ...makePR(1).head, ref: 'feat/x' } })), true);
  });

  it('rejects a single signal', () => {
    assert.equal(isReleasePR(makePR(1, { labels: [], user: { login: 'someone' } })), false);
  });

  it('never counts a fork head, whatever it is named', () => {
    const fork = makePR(1, { head: { ref: 'release-please--x', sha: SHA, repo: { full_name: 'evil/app' } } });
    assert.equal(isReleasePR(fork), false);
  });
});

describe('parseReleaseVersion', () => {
  it('reads release-please titles', () => {
    assert.equal(parseReleaseVersion('chore(main): release 2.31.0'), '2.31.0');
    assert.equal(parseReleaseVersion('chore: release v1.0.10'), '1.0.10');
  });
  it('is null when the title names no version', () => {
    assert.equal(parseReleaseVersion('chore: update roadmap'), null);
    assert.equal(parseReleaseVersion(undefined), null);
  });
});

describe('pullRequestTriggerApplies', () => {
  it('a bare pull_request in a block mapping fires (teams-for-linux build.yml)', () => {
    assert.equal(pullRequestTriggerApplies(BUILD_YML, 'main'), true);
  });

  it('one-line and flow-list forms', () => {
    assert.equal(pullRequestTriggerApplies('on: pull_request\njobs: {}\n', 'main'), true);
    assert.equal(pullRequestTriggerApplies('on: [push, pull_request]\n', 'main'), true);
    assert.equal(pullRequestTriggerApplies('on: [push]\n', 'main'), false);
    assert.equal(pullRequestTriggerApplies('on:\n  - push\n  - pull_request\n', 'main'), true);
  });

  it('a literal branch list must name the base (codeql-analysis.yml, delegate-local ci.yml)', () => {
    const yml = 'on:\n  push:\n    branches: [main]\n  pull_request:\n    # subset of push\n    branches: [main]\n  schedule:\n    - cron: \'0 17 * * 6\'\n';
    assert.equal(pullRequestTriggerApplies(yml, 'main'), true);
    assert.equal(pullRequestTriggerApplies(yml, 'develop'), false);
    const block = 'on:\n  pull_request:\n    branches:\n      - "main"\n';
    assert.equal(pullRequestTriggerApplies(block, 'main'), true);
  });

  it('paths, paths-ignore and branches-ignore filters are not proven (docs.yml)', () => {
    assert.equal(pullRequestTriggerApplies(DOCS_YML, 'main'), false);
    assert.equal(pullRequestTriggerApplies('on:\n  pull_request:\n    paths-ignore: [docs/**]\n', 'main'), false);
    assert.equal(pullRequestTriggerApplies('on:\n  pull_request:\n    branches-ignore: [gh-pages]\n', 'main'), false);
  });

  it('a glob branch is unprovable, even one that would match', () => {
    assert.equal(pullRequestTriggerApplies("on:\n  pull_request:\n    branches: ['ma*']\n", 'main'), false);
  });

  it('a types list must name reopened', () => {
    assert.equal(pullRequestTriggerApplies('on:\n  pull_request:\n    types: [opened, synchronize]\n', 'main'), false);
    assert.equal(pullRequestTriggerApplies('on:\n  pull_request:\n    types: [opened, reopened]\n', 'main'), true);
  });

  it('no pull_request trigger is false; pull_request_target does not count', () => {
    assert.equal(pullRequestTriggerApplies('on:\n  push:\n    branches:\n      - main\n', 'main'), false);
    assert.equal(pullRequestTriggerApplies('on:\n  pull_request_target:\n', 'main'), false);
  });

  it('anything it does not understand is null, never true', () => {
    assert.equal(pullRequestTriggerApplies('on: {pull_request: {}}\n', 'main'), null);
    assert.equal(pullRequestTriggerApplies('on:\n\tpull_request:\n', 'main'), null);
    assert.equal(pullRequestTriggerApplies('on: push\non: pull_request\n', 'main'), null);
    assert.equal(pullRequestTriggerApplies('on:\n  pull_request:\n    tags: [v1]\n', 'main'), null);
    assert.equal(pullRequestTriggerApplies("on:\n  pull_request:\n    branches: ['main #x']\n", 'main'), null);
    assert.equal(pullRequestTriggerApplies('jobs: {}\n', 'main'), null);
    assert.equal(pullRequestTriggerApplies(null, 'main'), null);
    assert.equal(pullRequestTriggerApplies(BUILD_YML, undefined), null);
  });
});

describe('detectPendingReleases', () => {
  it('flags ci-not-triggered when no Actions run reported and a workflow is proven to fire', async () => {
    const [f] = await detectPendingReleases(makeGh(), 'o', repos);
    assert.equal(f.type, 'release-pending');
    assert.equal(f.state, 'ci-not-triggered');
    assert.equal(f.version, '2.31.0');
    assert.equal(f.headSha, SHA);
    assert.equal(f.mergeMethod, 'squash');
    assert.equal(f.priority, 'medium');
    assert.deepEqual(buildRemediationPlan(f).commands, ['gh pr close 7 -R o/app', 'gh pr reopen 7 -R o/app']);
  });

  it('takes precedence over an all-green external check (the #3189 shape)', async () => {
    const [f] = await detectPendingReleases(makeGh({ ciState: 'green' }), 'o', repos);
    assert.equal(f.state, 'ci-not-triggered');
  });

  it('uses classifyPR once Actions ran, and pins the merge to the classified head', async () => {
    const gh = makeGh({ checkRuns: [{ app: { slug: 'github-actions' } }] });
    const [f] = await detectPendingReleases(gh, 'o', repos);
    assert.equal(f.state, 'awaiting-human');
    assert.deepEqual(buildRemediationPlan(f).commands, [`gh pr merge 7 -R o/app --squash --delete-branch --match-head-commit ${SHA}`]);
  });

  it('is unknown, with no command, when no workflow is proven to fire', async () => {
    const gh = makeGh({ workflows: [{ path: '.github/workflows/docs.yml', state: 'active' }], files: { '.github/workflows/docs.yml': DOCS_YML } });
    const [f] = await detectPendingReleases(gh, 'o', repos);
    assert.equal(f.state, 'unknown');
    assert.deepEqual(buildRemediationPlan(f).commands, []);
  });

  const twoWorkflows = [
    { path: '.github/workflows/build.yml', state: 'active' },
    { path: '.github/workflows/gone.yml', state: 'active' },
  ];

  it('is unknown when any workflow file cannot be read, even beside a proven one', async () => {
    const gh = makeGh({ workflows: twoWorkflows, files: { '.github/workflows/build.yml': BUILD_YML, '.github/workflows/gone.yml': 'ERR' } });
    const [f] = await detectPendingReleases(gh, 'o', repos);
    assert.equal(f.state, 'unknown');
  });

  it('skips a workflow GitHub still lists but whose file is gone from head and base', async () => {
    const [f] = await detectPendingReleases(makeGh({ workflows: twoWorkflows }), 'o', repos);
    assert.equal(f.state, 'ci-not-triggered');
  });

  it('is unknown when the file is gone at the head but present on the base', async () => {
    const gh = makeGh({ workflows: twoWorkflows, baseFiles: { '.github/workflows/build.yml': BUILD_YML, '.github/workflows/gone.yml': BUILD_YML } });
    const [f] = await detectPendingReleases(gh, 'o', repos);
    assert.equal(f.state, 'unknown');
  });

  it('is unknown when any workflow file cannot be parsed, even beside a proven one', async () => {
    const gh = makeGh({
      workflows: [
        { path: '.github/workflows/build.yml', state: 'active' },
        { path: '.github/workflows/odd.yml', state: 'active' },
      ],
      files: { '.github/workflows/build.yml': BUILD_YML, '.github/workflows/odd.yml': 'on: {pull_request: {}}\n' },
    });
    const [f] = await detectPendingReleases(gh, 'o', repos);
    assert.equal(f.state, 'unknown');
  });

  it('ignores disabled and dynamic workflows', async () => {
    const gh = makeGh({ workflows: [
      { path: '.github/workflows/build.yml', state: 'active' },
      { path: '.github/workflows/old.yml', state: 'disabled_manually' },
      { path: 'dynamic/copilot-swe-agent/copilot', state: 'active' },
    ] });
    const [f] = await detectPendingReleases(gh, 'o', repos);
    assert.equal(f.state, 'ci-not-triggered');
  });

  it('is unknown when the check runs cannot be read', async () => {
    const [f] = await detectPendingReleases(makeGh({ checkRunsThrow: true }), 'o', repos);
    assert.equal(f.state, 'unknown');
  });

  it('is unknown when the check-runs page carries no count, since a short read looks complete', async () => {
    const gh = makeGh();
    const request = gh.request;
    gh.request = async (path, opts) => (path.includes('/check-runs') ? { check_runs: [] } : request(path, opts));
    const [f] = await detectPendingReleases(gh, 'o', repos);
    assert.equal(f.state, 'unknown');
  });

  it(`stays silent inside the ${GRACE_DAYS}-day grace, and for an unparseable age`, async () => {
    assert.deepEqual(await detectPendingReleases(makeGh({ prs: [makePR(7, { created_at: daysAgoISO(1) })] }), 'o', repos), []);
    assert.deepEqual(await detectPendingReleases(makeGh({ prs: [makePR(7, { created_at: 'nope' })] }), 'o', repos), []);
  });

  it('is high when an open bug was filed after the latest release', async () => {
    const gh = makeGh({ bugs: [{ number: 3172, created_at: daysAgoISO(3) }, { number: 9, created_at: daysAgoISO(3), pull_request: {} }] });
    const [f] = await detectPendingReleases(gh, 'o', repos);
    assert.equal(f.priority, 'high');
  });

  it('stays medium when the bug predates the release, or the release cannot be read', async () => {
    let [f] = await detectPendingReleases(makeGh({ bugs: [{ number: 1, created_at: daysAgoISO(30) }] }), 'o', repos);
    assert.equal(f.priority, 'medium');
    [f] = await detectPendingReleases(makeGh({ latestRelease: null, bugs: [{ number: 1, created_at: daysAgoISO(1) }] }), 'o', repos);
    assert.equal(f.priority, 'medium');
  });

  it('skips archived repos and never throws on a failed listing', async () => {
    assert.deepEqual(await detectPendingReleases(makeGh(), 'o', [{ name: 'app', archived: true }]), []);
    assert.deepEqual(await detectPendingReleases(makeGh({ listThrows: true }), 'o', repos), []);
    assert.deepEqual(await detectPendingReleases(makeGh(), 'o', null), []);
  });

  it('reads from the shared open-PR sweep when given one', async () => {
    const gh = makeGh({ prs: [] });
    const [f] = await detectPendingReleases(gh, 'o', repos, { openPRs: { app: [makePR(8)] } });
    assert.equal(f.number, 8);
    assert.ok(!gh.calls.some(p => p.endsWith('/pulls')));
  });
});

describe('releaseCommands', () => {
  const base = { owner: 'o', repo: 'app', number: 7, headSha: SHA, mergeMethod: 'squash' };

  it('offers nothing for states without a safe action', () => {
    for (const state of ['unknown', 'ci-none', 'ci-pending', 'blocked-persistent', 'blocked-transient']) {
      assert.deepEqual(releaseCommands({ ...base, state }), [], state);
    }
  });

  it('never builds a command from an unvalidated identifier', () => {
    assert.deepEqual(releaseCommands({ ...base, state: 'ci-not-triggered', repo: 'app; rm -rf ~' }), []);
    assert.deepEqual(releaseCommands({ ...base, state: 'ci-not-triggered', owner: '-o' }), []);
    assert.deepEqual(releaseCommands({ ...base, state: 'ci-not-triggered', number: '7' }), []);
    assert.deepEqual(releaseCommands({ ...base, state: 'awaiting-human', headSha: 'HEAD' }), []);
    assert.deepEqual(releaseCommands({ ...base, state: 'awaiting-human', mergeMethod: null }), []);
  });

  it('ignores the title entirely', () => {
    const cmds = releaseCommands({ ...base, state: 'ci-not-triggered', title: '$(curl evil)' });
    assert.ok(cmds.every(c => !c.includes('curl')));
  });
});
