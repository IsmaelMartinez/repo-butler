// Tests for the local hygiene audit (factory design, Phase 1). The pure
// classifier is unit-tested; the reader and the guarded prune run against real
// throwaway git fixtures, because "is this branch really landed" is exactly
// what a mocked git would let us get wrong.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorktree, summariseRepo } from './local-hygiene.js';

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

  it('a squash-merged branch whose tip equals the PR head is prunable even with "unpushed" commits', () => {
    const r = classifyWorktree({ ...clean, ancestorOfDefault: false, unpushed: 3, pr: { state: 'MERGED', headSha: HEAD } });
    assert.equal(r.status, 'prunable');
  });

  it('a PR closed without merging is never landed', () => {
    const r = classifyWorktree({ ...clean, ancestorOfDefault: false, pr: { state: 'CLOSED', headSha: HEAD } });
    assert.equal(r.status, 'needs-look');
    assert.ok(r.reasons.some(x => /closed without merging/.test(x)));
  });

  it('a merged PR whose head differs from the local tip needs a look', () => {
    const r = classifyWorktree({ ...clean, ancestorOfDefault: false, pr: { state: 'MERGED', headSha: 'b'.repeat(40) } });
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
