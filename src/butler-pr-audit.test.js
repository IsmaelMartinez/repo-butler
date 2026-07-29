import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditButlerPRs } from './butler-pr-audit.js';
import { resolveCrossRepoDestination } from './safety.js';

// --- helpers ---

function daysAgoISO(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function makeRepo(name, overrides = {}) {
  return { name, archived: false, fork: false, ...overrides };
}

const MARKER_BODY = 'blah\n---\n*Opened automatically by [Repo Butler](https://github.com/IsmaelMartinez/repo-butler)*';

function makePR(number, ref, ageDays, overrides = {}) {
  return {
    number,
    title: `chore: butler PR ${number}`,
    created_at: daysAgoISO(ageDays),
    draft: false,
    user: { login: 'repo-butler-app[bot]', type: 'Bot' },
    head: { ref, sha: `sha-${number}` },
    labels: [],
    body: MARKER_BODY,
    ...overrides,
  };
}

// Fake client. Only the methods the detector actually calls, per the
// dependabot-audit.test.js pattern: paginate routed by parsing the repo out of
// the path, plus the two CI reads.
function makeGh(prsPerRepo = {}, { ciState = 'green', history = [] } = {}) {
  const calls = [];
  return {
    calls,
    paginate: async (path, opts) => {
      const repo = path.match(/\/repos\/[^/]+\/([^/]+)\/pulls/)?.[1];
      calls.push({ kind: 'paginate', repo, opts });
      return prsPerRepo[repo] || [];
    },
    prCiState: async (_o, repo, sha) => {
      calls.push({ kind: 'ciState', repo, sha });
      return typeof ciState === 'function' ? ciState(repo, sha) : ciState;
    },
    prCiHistory: async (_o, repo, branch) => {
      calls.push({ kind: 'ciHistory', repo, branch });
      return typeof history === 'function' ? history(repo, branch) : history;
    },
  };
}

// A failing set repeated across three attempts — what isDeterministicFailure
// (reused from apply.js) recognises as a persistent failure.
const PERSISTENT_HISTORY = [
  { sha: 'c', attempt: 1, failing: ['CI'] },
  { sha: 'b', attempt: 1, failing: ['CI'] },
  { sha: 'a', attempt: 1, failing: ['CI'] },
];

describe('stale-butler-pr detection', () => {
  it('stale-butler-pr: emits nothing when the repo has no butler PRs open', async () => {
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({ 'repo-a': [makePR(1, 'feature/human-branch', 90)] });

    assert.deepEqual(await auditButlerPRs(gh, 'owner', repos), []);
  });

  it('stale-butler-pr: ignores an apply PR younger than the 14-day threshold', async () => {
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({ 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 10)] });

    assert.deepEqual(await auditButlerPRs(gh, 'owner', repos), []);
  });

  it('stale-butler-pr: flags an apply PR past the 14-day threshold', async () => {
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({ 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 20)] });

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'stale-butler-pr');
    assert.equal(findings[0].repo, 'repo-a');
    assert.equal(findings[0].stalePRs.length, 1);
    assert.equal(findings[0].stalePRs[0].number, 1);
    assert.equal(findings[0].stalePRs[0].prClass, 'apply');
    assert.equal(findings[0].stalePRs[0].age, 20);
  });

  it('stale-butler-pr: holds an onboard PR to the longer 30-day threshold', async () => {
    const repos = [makeRepo('repo-a')];
    const young = makeGh({ 'repo-a': [makePR(1, 'repo-butler/onboard', 20)] });
    assert.deepEqual(await auditButlerPRs(young, 'owner', repos), [],
      'an onboard PR at 20 days is not yet stale');

    const old = makeGh({ 'repo-a': [makePR(1, 'repo-butler/onboard', 40)] });
    const findings = await auditButlerPRs(old, 'owner', repos);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].stalePRs[0].prClass, 'onboard');
  });

  it('stale-butler-pr: excludes roadmap-update PRs, whose head UPDATE rewrites every run', async () => {
    // self-test.yml runs `observe,assess,update,governance,report`, so UPDATE
    // force-pushes a new head onto the roadmap PR minutes before GOVERNANCE
    // reads its CI. Including them would emit a permanently-wrong blocked row
    // about the butler's own repo, four times a day.
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({ 'repo-a': [makePR(1, 'repo-butler/roadmap-update-1785173889248', 200)] });

    assert.deepEqual(await auditButlerPRs(gh, 'owner', repos), []);
  });

  it('stale-butler-pr: classifies a green PR as awaiting-human', async () => {
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({ 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 20)] }, { ciState: 'green' });

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.equal(findings[0].stalePRs[0].state, 'awaiting-human');
  });

  it('stale-butler-pr: classifies a repeatedly-identical failure as blocked-persistent', async () => {
    const repos = [makeRepo('repo-a')];
    const gh = makeGh(
      { 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 20)] },
      { ciState: 'red', history: PERSISTENT_HISTORY },
    );

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.equal(findings[0].stalePRs[0].state, 'blocked-persistent');
    assert.deepEqual(findings[0].stalePRs[0].failing, ['CI']);
  });

  it('stale-butler-pr: classifies a red PR without repeat evidence as blocked-transient', async () => {
    const repos = [makeRepo('repo-a')];
    const gh = makeGh(
      { 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 20)] },
      { ciState: 'red', history: [{ sha: 'c', attempt: 1, failing: ['CI'] }] },
    );

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.equal(findings[0].stalePRs[0].state, 'blocked-transient');
  });

  it('stale-butler-pr: reports a repo with no CI as ci-none, never as blocked', async () => {
    // The portfolio actively tracks a `ci-workflows` standards gap, so repos
    // with no CI exist. prCiGreen returns false for them, which is why this
    // detector reads the quad-state prCiState instead — calling these "blocked"
    // would be a systematic false positive a human cannot act on.
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({ 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 20)] }, { ciState: 'none' });

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.equal(findings[0].stalePRs[0].state, 'ci-none');
  });

  it('stale-butler-pr: reports an unreadable CI state as unknown, never as awaiting-human', async () => {
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({ 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 20)] }, { ciState: 'unknown' });

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.equal(findings[0].stalePRs[0].state, 'unknown',
      'a transient API failure must not read as an all-clear');
  });

  it('stale-butler-pr: never assigns high priority, so it cannot flip the dashboard to attention', async () => {
    // computePortfolioState flips the whole portfolio to `attention` on ANY
    // high-priority finding. A rotting butler PR is not an open critical CVE.
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({ 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 400)] });

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.notEqual(findings[0].priority, 'high');
  });

  it('stale-butler-pr: flags an unmarked repo-butler/* branch as verified:false rather than dropping it', async () => {
    // Dropping it silently would hide the only case the identity guard exists
    // for: someone pushing a branch that impersonates the butler.
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({
      'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 20, { body: 'no marker here' })],
    });

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].stalePRs[0].verified, false);
  });

  it('stale-butler-pr: skips archived, forked and excluded repos', async () => {
    const repos = [
      makeRepo('archived-one', { archived: true }),
      makeRepo('forked-one', { fork: true }),
      makeRepo('my-shadow-env'),
      makeRepo('test-repo-lab'),
    ];
    const stale = [makePR(1, 'repo-butler/apply-codeowners', 90)];
    const gh = makeGh({
      'archived-one': stale, 'forked-one': stale, 'my-shadow-env': stale, 'test-repo-lab': stale,
    });

    assert.deepEqual(await auditButlerPRs(gh, 'owner', repos), []);
  });

  it('stale-butler-pr: one repo failing does not lose the others', async () => {
    const repos = [makeRepo('good-repo'), makeRepo('bad-repo')];
    const gh = {
      paginate: async (path) => {
        if (path.includes('bad-repo')) {
          throw new Error('GitHub API GET /repos/owner/bad-repo/pulls: 403 Resource not accessible');
        }
        return [makePR(1, 'repo-butler/apply-codeowners', 20)];
      },
      prCiState: async () => 'green',
      prCiHistory: async () => [],
    };

    const findings = await auditButlerPRs(gh, 'owner', repos);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].repo, 'good-repo');
  });

  it('stale-butler-pr: reuses a pre-fetched openPRs map instead of re-listing', async () => {
    // auditDependabot already sweeps /pulls for every eligible repo; running a
    // second identical sweep 4x/day buys nothing.
    const repos = [makeRepo('repo-a')];
    const gh = makeGh({});
    const openPRs = { 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 20)] };

    const findings = await auditButlerPRs(gh, 'owner', repos, { openPRs });

    assert.equal(findings.length, 1);
    assert.equal(gh.calls.filter(c => c.kind === 'paginate').length, 0,
      'a pre-fetched map must suppress the redundant listing call');
  });

  it('stale-butler-pr: can never anchor a cross-repo proposal', () => {
    // It carries a `repo` field, so findingNamesRepo matches it. If the type
    // were ever added to safety.js's STATISTIC_BEARING_FINDING_TYPES, a
    // per-repo TEMPORAL fact ("this PR has been open 40 days") would become
    // licence to file an issue into another repo — the ADR-002/ADR-011 lane
    // breach the dependabot-stale comment in safety.js documents. Negative
    // test, because the bug would be an omission elsewhere.
    const finding = {
      type: 'stale-butler-pr', repo: 'target-repo',
      stalePRs: [{ number: 1, age: 40, state: 'awaiting-human' }],
    };
    const destination = resolveCrossRepoDestination(
      { title: 'Land the stale butler PR', targetRepo: 'target-repo' },
      { findings: [finding], eligibleRepoNames: ['target-repo'], owner: 'owner' },
    );
    assert.notEqual(destination?.repo, 'target-repo',
      'a stale-butler-pr finding must not license a cross-repo write');
  });

  it('stale-butler-pr: reads the real lounge-tv #21 payload and classifies it awaiting-human', async () => {
    // Production shape, captured 2026-07-29 from the live API — a green,
    // mergeable onboard PR that had sat ignored for 16 days. Fabricated
    // fixtures prove the logic; this proves it reads the real payload.
    const fixture = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'butler-prs-live.json'), 'utf8',
    ));
    const pr = fixture['lounge-tv'][0];
    assert.equal(pr.head.ref, 'repo-butler/onboard', 'fixture drifted from the captured shape');

    // Re-date the captured PR to 40 days so the assertion pins classification,
    // not the wall-clock age of a fixture that ages every day it sits in git.
    const aged = { ...pr, created_at: daysAgoISO(40) };
    const gh = makeGh({ 'lounge-tv': [aged] }, { ciState: 'green' });

    const findings = await auditButlerPRs(gh, 'owner', [makeRepo('lounge-tv')]);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].stalePRs[0].state, 'awaiting-human');
    assert.equal(findings[0].stalePRs[0].prClass, 'onboard');
    assert.equal(findings[0].stalePRs[0].verified, true,
      'the real onboard body carries APPLY_PR_MARKER, so identity verifies');
  });

  it('stale-butler-pr: reports ci-pending distinctly, not as blocked or awaiting-human', async () => {
    // A PR whose CI never settles needs a different remedy from one that is
    // failing and one that is merely ignored, so the three must not collapse.
    const gh = makeGh({ 'repo-a': [makePR(1, 'repo-butler/apply-codeowners', 40)] }, { ciState: 'pending' });

    const findings = await auditButlerPRs(gh, 'owner', [makeRepo('repo-a')]);

    assert.equal(findings[0].stalePRs[0].state, 'ci-pending');
    assert.deepEqual(findings[0].stalePRs[0].failing, []);
    assert.equal(gh.calls.filter(c => c.kind === 'ciHistory').length, 0,
      'only a red PR is worth the extra history call');
  });

  it('stale-butler-pr: caps CI classification per repo but still reports the remainder', async () => {
    // The cap is the one off-by-one in the file. Loosening it to `i >` adds an
    // extra pair of API calls per affected repo on all four daily runs, and
    // nothing else in the suite would notice.
    const prs = [40, 39, 38, 37].map((age, i) => makePR(i + 1, 'repo-butler/apply-codeowners', age));
    const gh = makeGh({ 'repo-a': prs }, { ciState: 'green' });

    const findings = await auditButlerPRs(gh, 'owner', [makeRepo('repo-a')]);
    const states = findings[0].stalePRs.map(p => p.state);

    assert.equal(findings[0].stalePRs.length, 4, 'nothing is silently dropped');
    assert.deepEqual(states, ['awaiting-human', 'awaiting-human', 'awaiting-human', 'unclassified']);
    assert.equal(gh.calls.filter(c => c.kind === 'ciState').length, 3,
      'exactly three PRs may cost a CI read');
  });

  it('stale-butler-pr: verifies identity from the governance-apply LABEL, not only the body marker', async () => {
    // apply.js labels every PR it opens, so the label is a live corroboration
    // route in its own right — a body that got edited must not read as forged.
    const pr = makePR(1, 'repo-butler/apply-codeowners', 40, {
      body: 'a maintainer rewrote this description',
      labels: [{ name: 'governance-apply' }],
    });
    const gh = makeGh({ 'repo-a': [pr] }, { ciState: 'green' });

    const findings = await auditButlerPRs(gh, 'owner', [makeRepo('repo-a')]);

    assert.equal(findings[0].stalePRs[0].verified, true);
  });

  it('stale-butler-pr: surfaces an unmarked branch as unverified rather than dropping it', async () => {
    // A branch impersonating the butler is itself worth seeing; dropping it
    // would hide the case the identity check exists for.
    const pr = makePR(1, 'repo-butler/apply-codeowners', 40, { body: 'no marker', labels: [] });
    const gh = makeGh({ 'repo-a': [pr] }, { ciState: 'green' });

    const findings = await auditButlerPRs(gh, 'owner', [makeRepo('repo-a')]);

    assert.equal(findings.length, 1, 'surfaced, not dropped');
    assert.equal(findings[0].stalePRs[0].verified, false);
  });
});
