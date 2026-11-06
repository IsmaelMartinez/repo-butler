// Tests for the local hygiene audit (factory design, Phase 1). The pure
// classifier is unit-tested; the reader and the guarded prune run against real
// throwaway git fixtures, because "is this branch really landed" is exactly
// what a mocked git would let us get wrong.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyWorktree, summariseRepo, readRepo, auditDirs, pruneWorktree,
  recordApproval, approvalStreak, approvalsFile,
} from './local-hygiene.js';

const CLI = join(import.meta.dirname, '..', 'scripts', 'local-hygiene.js');
// The CLI calls the real `gh`. Unauthenticated, it fails at once with no network
// call, so PR evidence reads as null and the tests stay deterministic.
const NO_GH = { ...process.env, GH_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'no-gh-')), GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '' };
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: NO_GH });
after(() => rmSync(NO_GH.GH_CONFIG_DIR, { recursive: true, force: true }));

const HEAD = 'a'.repeat(40);
const clean = {
  path: '/r/.claude/worktrees/x', branch: 'feat/x', head: HEAD, isMain: false,
  dirty: false, lockPid: undefined, lockLive: false, unpushed: 0,
  stashOnBranch: false, ancestorOfDefault: true, pr: { state: 'NONE' },
};

describe('classifyWorktree', () => {
  it('never offers the main checkout for pruning', () => {
    assert.equal(classifyWorktree({ ...clean, isMain: true }).status, 'main');
  });

  it('an open PR is live', () => {
    assert.equal(classifyWorktree({ ...clean, pr: { state: 'OPEN', headSha: HEAD } }).status, 'live');
  });

  it('a clean, pushed, ancestor-merged branch is prunable', () => {
    assert.deepEqual(classifyWorktree(clean), { status: 'prunable', reasons: [] });
  });

  it('a squash-merged branch whose tip the PR head contains is prunable even with "unpushed" commits', () => {
    const r = classifyWorktree({ ...clean, ancestorOfDefault: false, unpushed: 3, pr: { state: 'MERGED', headSha: HEAD, containsTip: true } });
    assert.equal(r.status, 'prunable');
  });

  it('a PR closed without merging is never landed', () => {
    const r = classifyWorktree({ ...clean, ancestorOfDefault: false, pr: { state: 'CLOSED', headSha: HEAD } });
    assert.equal(r.status, 'needs-look');
    assert.ok(r.reasons.some(x => /closed without merging/.test(x)));
  });

  it('a merged PR whose head does not contain the local tip needs a look', () => {
    const r = classifyWorktree({ ...clean, ancestorOfDefault: false, pr: { state: 'MERGED', headSha: 'b'.repeat(40), containsTip: false } });
    assert.equal(r.status, 'needs-look');
  });

  it('dirty, unreadable dirt, a stash or a detached HEAD each need a look', () => {
    assert.equal(classifyWorktree({ ...clean, dirty: true }).status, 'needs-look');
    const unread = classifyWorktree({ ...clean, dirty: null });
    assert.equal(unread.status, 'needs-look');
    assert.ok(unread.reasons.some(x => /could not read/.test(x)));
    assert.equal(classifyWorktree({ ...clean, stashOnBranch: true }).status, 'needs-look');
    assert.equal(classifyWorktree({ ...clean, branch: null }).status, 'needs-look');
  });

  it('a live lock needs a look; a lock whose PID is dead does not block', () => {
    assert.equal(classifyWorktree({ ...clean, lockPid: 4242, lockLive: true }).status, 'needs-look');
    assert.equal(classifyWorktree({ ...clean, lockPid: 999999, lockLive: false }).status, 'prunable');
  });

  it('unknown default branch and unreadable PR state cannot prove landing', () => {
    const r = classifyWorktree({ ...clean, ancestorOfDefault: null, pr: null });
    assert.equal(r.status, 'needs-look');
  });

  it('unpushed commits on an ancestor-merged branch need a look', () => {
    assert.equal(classifyWorktree({ ...clean, unpushed: 2 }).status, 'needs-look');
    assert.equal(classifyWorktree({ ...clean, unpushed: null }).status, 'needs-look');
  });

  it('no PR and not merged needs a look', () => {
    const r = classifyWorktree({ ...clean, ancestorOfDefault: false });
    assert.equal(r.status, 'needs-look');
    assert.ok(r.reasons.some(x => /no PR and not merged/.test(x)));
  });
});

describe('summariseRepo', () => {
  const base = {
    repo: 'r', repoDir: '/r', slug: 'o/r', stashes: [], mainDirtyCount: 0,
    mainDetached: false, staleEntries: [], scriptPath: '/s/local-hygiene.js', today: '2026-11-06',
  };
  const wt = (over) => ({ path: '/r', branch: 'main', head: HEAD, status: 'main', reasons: [], ...over });

  it('returns null when nothing needs attention', () => {
    assert.equal(summariseRepo({ ...base, worktrees: [wt(), wt({ path: '/r/w', status: 'live' })] }), null);
  });

  it('a prunable worktree is medium with exactly the guarded prune command', () => {
    const f = summariseRepo({ ...base, worktrees: [wt(), wt({ path: '/r/w', branch: 'feat/x', status: 'prunable' })] });
    assert.equal(f.type, 'local-hygiene');
    assert.equal(f.priority, 'medium');
    assert.equal(f.atRisk, false);
    assert.equal(f.remediation.executor, 'manual');
    assert.deepEqual(f.remediation.commands, [`node /s/local-hygiene.js prune /r /r/w --expect-tip ${HEAD}`]);
  });

  it('flags at-risk checkouts as high and offers a rescue branch, never a stash or reset', () => {
    const detached = summariseRepo({ ...base, mainDetached: true, worktrees: [wt()] });
    assert.equal(detached.atRisk, true);
    assert.equal(detached.priority, 'high');
    assert.ok(detached.remediation.commands.includes('git -C /r switch -c wip/2026-11-06-rescue'));

    const stashy = summariseRepo({ ...base, stashes: [1, 2, 3, 4].map(i => ({ ref: `stash@{${i}}` })), worktrees: [wt()] });
    assert.equal(stashy.atRisk, true);
    assert.ok(!stashy.remediation.commands.some(c => c.includes('switch -c')), 'stashes alone need no rescue branch');

    const dirty = summariseRepo({ ...base, mainDirtyCount: 21, worktrees: [wt()] });
    assert.equal(dirty.atRisk, true);
    assert.equal(summariseRepo({ ...base, mainDirtyCount: 20, worktrees: [wt()] }), null, 'the threshold is more than 20');

    for (const f of [detached, stashy, dirty]) {
      for (const c of f.remediation.commands) assert.doesNotMatch(c, /--force|\s-D\b|stash|reset/);
    }
  });

  it('reports stale worktree entries', () => {
    const f = summariseRepo({ ...base, staleEntries: ['worktrees/gone'], worktrees: [wt()] });
    assert.deepEqual(f.staleEntries, ['worktrees/gone']);
    assert.ok(f.remediation.commands.includes('git -C /r worktree prune'));
  });
});

// ---- Real git fixtures -------------------------------------------------

// Isolate from the developer's git config (signing, hooks, templates).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Builds remote.git (bare) and repo (its clone, origin/HEAD = origin/main,
// origin URL presented as github.com/o/r through insteadOf) with worktrees
// merged / squashed / closed / dirty / open under .claude/worktrees.
function buildFixture() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hygiene-')));
  const remote = join(tmp, 'remote.git');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  g(tmp, 'clone', '-q', remote, 'repo');
  const repo = join(tmp, 'repo');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'init');
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  g(repo, 'remote', 'set-head', 'origin', 'main');
  g(repo, 'config', `url.${remote}.insteadOf`, 'https://github.com/o/r.git');
  g(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');

  const wtDir = join(repo, '.claude', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const heads = {};
  for (const name of ['merged', 'squashed', 'closed', 'dirty', 'open']) {
    const path = join(wtDir, name);
    g(repo, 'worktree', 'add', '-q', '-b', name, path, 'main');
    writeFileSync(join(path, `${name}.txt`), `${name}\n`);
    g(path, 'add', '.');
    g(path, 'commit', '-q', '-m', name);
    heads[name] = g(path, 'rev-parse', 'HEAD');
  }
  // merged and dirty land on main by merge; dirty then gets an uncommitted edit.
  g(repo, 'merge', '-q', '--no-edit', 'merged');
  g(repo, 'merge', '-q', '--no-edit', 'dirty');
  g(repo, 'push', '-q', 'origin', 'main');
  writeFileSync(join(wtDir, 'dirty', 'dirty.txt'), 'changed\n');
  // closed and open are pushed; squashed never is (its source branch was deleted).
  g(repo, 'push', '-q', 'origin', 'closed', 'open');

  // behind: the branch was pushed one commit further than this checkout, then
  // squash-merged and its remote branch deleted. The PR head object is still
  // local, and it contains the checkout's tip.
  const behindPath = join(wtDir, 'behind');
  g(repo, 'worktree', 'add', '-q', '-b', 'behind', behindPath, 'main');
  writeFileSync(join(behindPath, 'behind.txt'), '1\n');
  g(behindPath, 'add', '.');
  g(behindPath, 'commit', '-q', '-m', 'behind 1');
  heads.behind = g(behindPath, 'rev-parse', 'HEAD');
  writeFileSync(join(behindPath, 'behind.txt'), '2\n');
  g(behindPath, 'commit', '-q', '-am', 'behind 2');
  const behindPrHead = g(behindPath, 'rev-parse', 'HEAD');
  g(behindPath, 'push', '-q', 'origin', 'behind');
  g(behindPath, 'reset', '-q', '--hard', heads.behind);
  g(repo, 'push', '-q', 'origin', '--delete', 'behind');

  const prs = [
    { headRefName: 'behind', headRefOid: behindPrHead, state: 'MERGED', number: 4 },
    { headRefName: 'squashed', headRefOid: heads.squashed, state: 'MERGED', number: 1 },
    { headRefName: 'closed', headRefOid: heads.closed, state: 'CLOSED', number: 2 },
    { headRefName: 'open', headRefOid: heads.open, state: 'OPEN', number: 3 },
  ];
  return { tmp, repo, wtDir, heads, prs };
}

const byName = (finding, name) => finding.worktrees.find(w => w.path.endsWith(`/${name}`));

describe('readRepo against a real repository', () => {
  let fx;
  before(() => { fx = buildFixture(); });
  after(() => rmSync(fx.tmp, { recursive: true, force: true }));

  const opts = (over = {}) => ({ fetch: false, scriptPath: '/s.js', today: '2026-11-06', listPRs: () => fx.prs, ...over });

  it('classifies each worktree from live git and PR state', () => {
    const f = readRepo(fx.repo, opts());
    assert.equal(f.slug, 'o/r');
    assert.equal(byName(f, 'merged').status, 'prunable');
    assert.equal(byName(f, 'squashed').status, 'prunable', 'tip equals the merged PR head');
    assert.equal(byName(f, 'behind').status, 'prunable', 'the merged PR head descends from the tip');
    assert.equal(byName(f, 'closed').status, 'needs-look');
    assert.equal(byName(f, 'dirty').status, 'needs-look');
    assert.equal(byName(f, 'open').status, 'live');
    assert.equal(f.worktrees.find(w => w.path === fx.repo).status, 'main');
  });

  it('unread PR state leaves a squash-merged branch as needs-look but still audits', () => {
    const f = readRepo(fx.repo, opts({ listPRs: () => null }));
    assert.equal(byName(f, 'squashed').status, 'needs-look');
    assert.equal(byName(f, 'merged').status, 'prunable', 'ancestry needs no PR evidence');
  });

  it('a branch referenced by a stash needs a look', () => {
    const wt = join(fx.wtDir, 'merged');
    writeFileSync(join(wt, 'a.txt'), 'stashed\n');
    g(wt, 'stash', 'push', '-q', '-m', 'hygiene-test');
    try {
      const f = readRepo(fx.repo, opts());
      assert.equal(byName(f, 'merged').status, 'needs-look');
      assert.equal(f.stashes.length, 1);
    } finally {
      g(wt, 'stash', 'drop', '-q');
    }
  });

  it('a lock held by a dead PID does not block; a lock without a PID does', () => {
    const wt = join(fx.wtDir, 'merged');
    g(fx.repo, 'worktree', 'lock', '--reason', 'claude agent (pid 999999)', wt);
    try {
      assert.equal(byName(readRepo(fx.repo, opts()), 'merged').status, 'prunable');
    } finally {
      g(fx.repo, 'worktree', 'unlock', wt);
    }
    g(fx.repo, 'worktree', 'lock', '--reason', 'held', wt);
    try {
      assert.equal(byName(readRepo(fx.repo, opts()), 'merged').status, 'needs-look');
    } finally {
      g(fx.repo, 'worktree', 'unlock', wt);
    }
  });

  it('auditDirs finds the repo and ignores plain directories', () => {
    mkdirSync(join(fx.tmp, 'not-a-repo'), { recursive: true });
    const findings = auditDirs([fx.tmp], opts());
    assert.deepEqual(findings.map(f => f.repo), ['repo']);
  });

  it('the CLI audit prints parsable JSON and exits 1 when there are findings', () => {
    // gh cannot resolve o/r, so PR evidence is unread; ancestry still works.
    const r = cli('audit', '--json', '--no-fetch', '--dir', fx.tmp);
    assert.equal(r.status, 1, r.stderr);
    const findings = JSON.parse(r.stdout);
    assert.equal(findings[0].repo, 'repo');
    assert.equal(byName(findings[0], 'merged').status, 'prunable');
  });
});

describe('approvals record', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'approvals-'));
    file = join(dir, 'nested', 'approvals.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rec = (actionClass, outcome) => recordApproval({ findingType: 'local-hygiene', actionClass, repo: 'r', item: 'w', outcome }, { file });

  it('counts the trailing run of accepted-unchanged; edited resets it, skipped does not', () => {
    rec('prune-merged-worktree', 'accepted-unchanged');
    rec('prune-merged-worktree', 'edited');
    rec('prune-merged-worktree', 'accepted-unchanged');
    rec('prune-merged-worktree', 'skipped');
    rec('prune-merged-worktree', 'accepted-unchanged');
    rec('release-reopen-for-ci', 'rejected');
    assert.deepEqual(approvalStreak('prune-merged-worktree', { file }), { streak: 2, eligible: true, graduated: false });
  });

  it('graduates an eligible class at 8, never an ineligible one', () => {
    for (let i = 0; i < 8; i++) {
      rec('prune-merged-worktree', 'accepted-unchanged');
      rec('owner-move-reply', 'accepted-unchanged');
    }
    assert.equal(approvalStreak('prune-merged-worktree', { file }).graduated, true);
    assert.deepEqual(approvalStreak('owner-move-reply', { file }), { streak: 8, eligible: false, graduated: false });
  });

  it('rejects an unknown outcome and a missing field', () => {
    assert.throws(() => rec('prune-merged-worktree', 'approved'), /unknown outcome/);
    assert.throws(() => recordApproval({ findingType: 'x', actionClass: '', repo: 'r', item: 'i', outcome: 'skipped' }, { file }), /actionClass/);
  });

  it('reports a zero streak when there is no record yet', () => {
    assert.deepEqual(approvalStreak('prune-merged-worktree', { file: join(dir, 'missing.jsonl') }), { streak: 0, eligible: true, graduated: false });
  });

  it('honours XDG_STATE_HOME, else ~/.local/state', () => {
    assert.equal(approvalsFile({ XDG_STATE_HOME: '/x' }), '/x/repo-butler/approvals.jsonl');
    assert.equal(approvalsFile({ HOME: '/h' }), '/h/.local/state/repo-butler/approvals.jsonl');
  });

  it('the CLI exits 2 with no command', () => {
    assert.equal(cli().status, 2);
  });
});

describe('pruneWorktree', () => {
  // Each test mutates the repository, so each gets its own fixture.
  let fx;
  beforeEach(() => { fx = buildFixture(); });
  afterEach(() => rmSync(fx.tmp, { recursive: true, force: true }));

  const prune = (name, expectTip = fx.heads[name]) => pruneWorktree({
    repoDir: fx.repo, worktreePath: join(fx.wtDir, name), expectTip, listPRs: () => fx.prs,
  });
  const refExists = (name) => {
    try { g(fx.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`); return true; } catch { return false; }
  };

  it('removes a prunable worktree and its branch, merged or squash-merged', () => {
    for (const name of ['merged', 'squashed', 'behind']) {
      assert.deepEqual(prune(name), { ok: true });
      assert.equal(existsSync(join(fx.wtDir, name)), false);
      assert.equal(refExists(name), false);
    }
  });

  it('refuses when the tip is not the approved one', () => {
    const r = prune('merged', 'f'.repeat(40));
    assert.equal(r.ok, false);
    assert.match(r.reason, /tip moved/);
    assert.ok(existsSync(join(fx.wtDir, 'merged')));
    assert.ok(refExists('merged'));
  });

  it('a commit added after the audit survives', () => {
    const wt = join(fx.wtDir, 'squashed');
    const approved = fx.heads.squashed;
    writeFileSync(join(wt, 'late.txt'), 'late\n');
    g(wt, 'add', '.');
    g(wt, 'commit', '-q', '-m', 'late work');
    const late = g(wt, 'rev-parse', 'HEAD');
    assert.equal(prune('squashed', approved).ok, false);
    assert.equal(g(fx.repo, 'rev-parse', 'refs/heads/squashed'), late);
  });

  it('refuses a worktree that became dirty, and one whose PR was closed', () => {
    writeFileSync(join(fx.wtDir, 'merged', 'a.txt'), 'edit\n');
    const dirty = prune('merged');
    assert.equal(dirty.ok, false);
    assert.match(dirty.reason, /not prunable/);
    assert.equal(prune('closed').ok, false);
    assert.ok(refExists('closed'));
  });

  it('the CLI prunes with the approved tip and refuses a bad one', () => {
    const bad = cli('prune', fx.repo, join(fx.wtDir, 'merged'), '--expect-tip', 'f'.repeat(40));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /refused: tip moved/);
    const good = cli('prune', fx.repo, join(fx.wtDir, 'merged'), '--expect-tip', fx.heads.merged);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(existsSync(join(fx.wtDir, 'merged')), false);
  });

  it('refuses the main checkout and paths that are not its worktrees', () => {
    assert.equal(pruneWorktree({ repoDir: fx.repo, worktreePath: fx.repo, expectTip: g(fx.repo, 'rev-parse', 'HEAD'), listPRs: () => fx.prs }).ok, false);
    assert.match(pruneWorktree({ repoDir: fx.repo, worktreePath: fx.tmp, expectTip: 'x', listPRs: () => fx.prs }).reason, /not a worktree/);
  });
});
