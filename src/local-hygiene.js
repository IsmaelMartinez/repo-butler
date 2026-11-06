// Local hygiene audit — the factory design's Phase 1
// (docs/superpowers/specs/2026-11-06-agentic-factory-design.md, section 4).
//
// Agent sessions create worktrees and stashes and rarely clear them up: the
// 2026-11-06 sweep found 90 linked worktrees in one repo, 40 of them for PRs
// that had already merged, and a checkout with 68 staged files on a detached
// HEAD. The pipeline reads only the GitHub API, so it cannot see any of this.
// This module does, locally, and never writes to the data branch — local
// state is per machine and the data branch is shared.
//
// Every reading is independently nullable and a null never passes: "could not
// check" must not look like "checked, it is fine". The only destructive path,
// pruneWorktree, re-checks everything at action time and deletes the branch
// ref with a compare-and-delete, so a commit added after the audit survives.

const RESCUE_DIRTY_THRESHOLD = 20;
const RESCUE_STASH_THRESHOLD = 3;

/**
 * Classify one worktree from its readings. Pure.
 * @returns {{ status: 'main'|'live'|'prunable'|'needs-look', reasons: string[] }}
 */
export function classifyWorktree(r) {
  if (r.isMain) return { status: 'main', reasons: [] };
  if (r.pr?.state === 'OPEN') return { status: 'live', reasons: [] };

  const reasons = [];
  if (r.branch === null) reasons.push('detached HEAD');
  if (r.dirty === null) reasons.push('could not read working-tree status');
  else if (r.dirty) reasons.push('uncommitted changes');
  if (r.stashOnBranch) reasons.push('a stash references this branch');
  if (r.lockPid !== undefined && r.lockLive) reasons.push('locked by a live process');

  // Landed: an ancestor of the default branch, or a MERGED PR whose final head
  // is exactly this tip (squash merges are not ancestors). A CLOSED PR proves
  // nothing landed.
  const prHeadMatches = r.pr?.state === 'MERGED' && r.pr.headSha === r.head;
  const landed = r.ancestorOfDefault === true || prHeadMatches;
  if (!landed) {
    if (r.pr?.state === 'CLOSED') reasons.push('PR closed without merging');
    else if (r.pr?.state === 'MERGED') reasons.push('merged PR head differs from the local tip');
    else if (r.ancestorOfDefault === null || r.pr === null) reasons.push('could not establish whether the branch landed');
    else reasons.push('no PR and not merged');
  }

  // A squash-merged PR's source branch is usually deleted, so after
  // `fetch --prune` its commits look unpushed. The head match proves nothing
  // local was left out, so it stands in for remote reachability.
  if (!prHeadMatches) {
    if (r.unpushed === null) reasons.push('could not count unpushed commits');
    else if (r.unpushed > 0) reasons.push(`${r.unpushed} unpushed commit(s)`);
  }

  return reasons.length ? { status: 'needs-look', reasons } : { status: 'prunable', reasons: [] };
}

/**
 * Turn one repo's classified worktrees into a finding, or null when there is
 * nothing to act on. Pure. Commands are single lines, never chained, never
 * forced, and never stash or reset.
 */
export function summariseRepo({ repo, repoDir, slug, worktrees, stashes, mainDirtyCount, mainDetached, staleEntries, scriptPath, today }) {
  const prunable = worktrees.filter(w => w.status === 'prunable');
  const needsLook = worktrees.filter(w => w.status === 'needs-look');
  const atRisk = mainDetached || mainDirtyCount > RESCUE_DIRTY_THRESHOLD || stashes.length > RESCUE_STASH_THRESHOLD;

  if (!prunable.length && !needsLook.length && !staleEntries.length && !atRisk) return null;

  const commands = [];
  if (atRisk && (mainDetached || mainDirtyCount > 0)) {
    commands.push(`git -C ${repoDir} switch -c wip/${today}-rescue`);
  }
  if (staleEntries.length) commands.push(`git -C ${repoDir} worktree prune`);
  for (const w of prunable) {
    commands.push(`node ${scriptPath} prune ${repoDir} ${w.path} --expect-tip ${w.head}`);
  }

  const parts = [];
  if (prunable.length) parts.push(`${prunable.length} prunable worktree(s)`);
  if (needsLook.length) parts.push(`${needsLook.length} worktree(s) need a look`);
  if (stashes.length) parts.push(`${stashes.length} stash(es)`);
  if (staleEntries.length) parts.push(`${staleEntries.length} stale worktree entr(ies)`);
  if (atRisk) parts.push('checkout at risk of losing work');

  return {
    type: 'local-hygiene',
    repo,
    slug,
    path: repoDir,
    worktrees,
    stashes,
    staleEntries,
    atRisk,
    priority: atRisk ? 'high' : prunable.length ? 'medium' : 'low',
    remediation: {
      executor: 'manual',
      targetFiles: [],
      intent: `Tidy local worktrees and stashes in ${repo}`,
      rationale: `${parts.join(', ')}.`,
      acceptanceCriteria: ['No prunable worktree remains', 'Every needs-look worktree has been inspected by the owner'],
      commands,
    },
  };
}
