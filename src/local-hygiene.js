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

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GIT_NONINTERACTIVE_ENV } from './staleness.js';

const RESCUE_DIRTY_THRESHOLD = 20;
const RESCUE_STASH_THRESHOLD = 3;
const GIT_ENV = { ...process.env, ...GIT_NONINTERACTIVE_ENV };

// Output on success (possibly ''), null on any failure. Not staleness.runGit:
// fetch needs a longer timeout than its 5 s default.
function git(args, cwd, timeout = 10000) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], env: GIT_ENV }).trim();
  } catch {
    return null;
  }
}

// For commands that answer through their exit code (merge-base --is-ancestor):
// true on 0, false on 1, null on anything else (bad ref, missing repo).
function gitOk(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: 'ignore', timeout: 10000, env: GIT_ENV });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — alive.
    return err.code === 'EPERM';
  }
}

/**
 * Every PR (any state) for a repo, from one `gh` call. Null on any failure, so
 * a missing or unauthenticated `gh` leaves PR evidence unread rather than "no PR".
 * @returns {Array<{ headRefName: string, headRefOid: string, state: string, number: number }>|null}
 */
export function defaultListPRs(slug) {
  try {
    const out = execFileSync('gh', ['pr', 'list', '--repo', slug, '--state', 'all', '--limit', '1000',
      '--json', 'headRefName,headRefOid,state,number'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    const prs = JSON.parse(out);
    return Array.isArray(prs) ? prs : null;
  } catch {
    return null;
  }
}

// The PR that best describes a branch: an open one wins, then a merged one
// whose head is this exact tip, then any merged, then closed. `{ state: 'NONE' }`
// when the list was read and has no PR from this branch; null when unread.
function pickPR(prs, branch, head) {
  if (prs === null) return null;
  const mine = prs.filter(p => p.headRefName === branch);
  const pick = mine.find(p => p.state === 'OPEN')
    ?? mine.find(p => p.state === 'MERGED' && p.headRefOid === head)
    ?? mine.find(p => p.state === 'MERGED')
    ?? mine.find(p => p.state === 'CLOSED');
  return pick ? { state: pick.state, headSha: pick.headRefOid, number: pick.number } : { state: 'NONE' };
}

function slugFromRemote(url) {
  const m = url?.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function parseWorktrees(porcelain) {
  return porcelain.split('\n\n').filter(Boolean).map((block, i) => {
    const wt = { isMain: i === 0, branch: null, head: null, detached: false, locked: undefined, prunable: false };
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') wt.path = value;
      else if (key === 'HEAD') wt.head = value;
      else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') wt.detached = true;
      else if (key === 'locked') wt.locked = value;
      else if (key === 'prunable') wt.prunable = true;
    }
    return wt;
  });
}

function parseStashes(out) {
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [ref, date, subject = ''] = line.split('\t');
    const m = subject.match(/^(?:WIP on|On) ([^:]+):/);
    return { ref, date, subject, branch: m ? m[1] : null };
  });
}

function readContext(repoDir, { listPRs = defaultListPRs } = {}) {
  // The configured URL, not `remote get-url`: the latter applies insteadOf
  // rewrites, which can turn a github.com URL into something unparseable.
  const slug = slugFromRemote(git(['config', '--get', 'remote.origin.url'], repoDir));
  const stashOut = git(['stash', 'list', '--format=%gd%x09%ci%x09%gs'], repoDir);
  return {
    repoDir,
    slug,
    defaultRef: git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir) || null,
    prs: slug ? listPRs(slug) : null,
    stashes: stashOut === null ? null : parseStashes(stashOut),
  };
}

// Readings for one worktree, ready for classifyWorktree.
function readWorktree(wt, ctx) {
  const reading = { path: wt.path, branch: wt.detached ? null : wt.branch, head: wt.head, isMain: wt.isMain };
  if (wt.isMain) return reading;
  const status = git(['status', '--porcelain'], wt.path);
  const unpushed = git(['rev-list', '--count', wt.head, '--not', '--remotes'], ctx.repoDir);
  const pid = wt.locked !== undefined ? Number(wt.locked.match(/pid[ =:]?(\d+)/i)?.[1]) || null : undefined;
  return {
    ...reading,
    dirty: status === null ? null : status.length > 0,
    unpushed: unpushed === null ? null : Number(unpushed),
    lockPid: pid,
    // A lock with no parseable PID is assumed live: we cannot prove it is not.
    lockLive: pid === undefined ? false : pid === null ? true : isAlive(pid),
    stashOnBranch: ctx.stashes === null ? true : ctx.stashes.some(s => s.branch === wt.branch),
    ancestorOfDefault: ctx.defaultRef ? gitOk(['merge-base', '--is-ancestor', wt.head, ctx.defaultRef], ctx.repoDir) : null,
    pr: wt.branch && !wt.detached ? pickPR(ctx.prs, wt.branch, wt.head) : null,
  };
}

/**
 * Audit one repo's worktrees and stashes. Null when the repo cannot be read or
 * has nothing to act on.
 * @param {string} repoDir
 * @param {{ listPRs?: Function, fetch?: boolean, scriptPath: string, today: string }} opts
 */
export function readRepo(repoDir, { listPRs = defaultListPRs, fetch = true, scriptPath, today } = {}) {
  if (fetch) git(['fetch', '--prune', '--quiet'], repoDir, 30000);
  const porcelain = git(['worktree', 'list', '--porcelain'], repoDir);
  if (porcelain === null) return null;

  const all = parseWorktrees(porcelain);
  const ctx = readContext(repoDir, { listPRs });
  const main = all[0];
  const mainStatus = git(['status', '--porcelain'], main.path);
  const pruneOut = git(['worktree', 'prune', '--dry-run', '--verbose'], repoDir) ?? '';

  const worktrees = all.filter(w => !w.prunable).map(w => {
    const reading = readWorktree(w, ctx);
    const { status, reasons } = classifyWorktree(reading);
    return { path: w.path, branch: reading.branch, head: w.head, status, reasons };
  });

  return summariseRepo({
    repo: basename(repoDir),
    repoDir,
    slug: ctx.slug,
    worktrees,
    stashes: ctx.stashes ?? [],
    mainDirtyCount: mainStatus ? mainStatus.split('\n').length : 0,
    mainDetached: main.detached,
    staleEntries: pruneOut.split('\n').map(l => l.match(/^Removing (\S+?):/)?.[1]).filter(Boolean),
    scriptPath,
    today,
  });
}

/**
 * Remove one worktree and its branch, re-checking everything at action time.
 * A check made when the command was printed protects nothing: an agent can
 * commit between the audit and the owner's yes. So the worktree is re-read and
 * re-classified here, `worktree remove` runs without --force (it refuses a
 * dirty tree), and the branch goes through `update-ref -d <ref> <expectTip>`,
 * which git refuses atomically if the ref moved — so new work always survives.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function pruneWorktree({ repoDir, worktreePath, expectTip, listPRs = defaultListPRs }) {
  const porcelain = git(['worktree', 'list', '--porcelain'], repoDir);
  if (porcelain === null) return { ok: false, reason: 'could not list worktrees' };
  let target;
  try {
    target = realpathSync(worktreePath);
  } catch {
    return { ok: false, reason: 'worktree path does not exist' };
  }
  const wt = parseWorktrees(porcelain).find(w => w.path === target);
  if (!wt) return { ok: false, reason: 'not a worktree of this repository' };
  if (wt.isMain) return { ok: false, reason: 'refusing to remove the main checkout' };
  if (wt.head !== expectTip) return { ok: false, reason: `tip moved: expected ${expectTip}, found ${wt.head}` };

  const { status, reasons } = classifyWorktree(readWorktree(wt, readContext(repoDir, { listPRs })));
  if (status !== 'prunable') return { ok: false, reason: `not prunable: ${reasons.join('; ') || status}` };

  if (git(['worktree', 'remove', wt.path], repoDir) === null) {
    return { ok: false, reason: 'git worktree remove refused' };
  }
  if (git(['update-ref', '-d', `refs/heads/${wt.branch}`, expectTip], repoDir) === null) {
    return { ok: false, reason: 'worktree removed but branch ref moved; left in place' };
  }
  return { ok: true };
}

/**
 * Audit every repo directly under the given parents (a child with a `.git`
 * directory; linked worktrees have a `.git` file and are reached through their
 * main checkout).
 */
export function auditDirs(parents, opts) {
  const findings = [];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent).sort()) {
      const dir = join(parent, name);
      try {
        if (!statSync(join(dir, '.git')).isDirectory()) continue;
      } catch {
        continue;
      }
      const finding = readRepo(dir, opts);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

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
