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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GIT_NONINTERACTIVE_ENV } from './staleness.js';

const RESCUE_DIRTY_THRESHOLD = 20;
const RESCUE_STASH_THRESHOLD = 3;
const MIN_IDLE_HOURS = 24;
const PR_LIST_LIMIT = 1000;
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
export function defaultListPRs(slug, branches = []) {
  const list = (extra) => {
    try {
      const out = execFileSync('gh', ['pr', 'list', '--repo', slug, '--state', 'all', '--limit', String(PR_LIST_LIMIT), ...extra,
        '--json', 'headRefName,headRefOid,state,number,isCrossRepository'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
      const prs = JSON.parse(out);
      // `gh` truncates silently at the limit, and a full page may be missing
      // the very PR that would make a branch live.
      return Array.isArray(prs) && prs.length < PR_LIST_LIMIT ? prs : null;
    } catch {
      return null;
    }
  };
  const all = list([]);
  if (all !== null) return all;
  // Repos with more PRs than one page (teams-for-linux has thousands): ask per
  // branch instead. One unread branch leaves the whole list unread.
  const perBranch = [];
  for (const branch of new Set(branches)) {
    const prs = list(['--head', branch]);
    if (prs === null) return null;
    perBranch.push(...prs);
  }
  return branches.length ? perBranch : null;
}

// Single-quote a value for a POSIX shell when it needs it, so printed commands
// survive paths with spaces or metacharacters when the owner runs them.
export function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_\-.,/:@%+=]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

// Hours since git last touched this worktree (HEAD or its reflog), or null.
// A worktree an agent session just created has no commits and no dirt, so
// without this it would look exactly like a merged-and-forgotten one.
function idleHours(worktreePath, now = Date.now()) {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], worktreePath);
  if (!gitDir) return null;
  let newest = 0;
  for (const f of ['HEAD', join('logs', 'HEAD')]) {
    try {
      newest = Math.max(newest, statSync(join(gitDir, f)).mtimeMs);
    } catch {
      // A missing reflog is normal (core.logAllRefUpdates off); HEAD alone will do.
    }
  }
  return newest ? (now - newest) / 3600000 : null;
}

// The PR that best describes a branch: an open one wins, then a merged one
// whose head contains this tip, then any merged, then closed. `{ state: 'NONE' }`
// when the list was read and has no PR from this branch; null when unread.
// `contains(sha)` answers "is the tip equal to or an ancestor of sha"; an
// unfetched PR head answers no, so it can never prove landing.
function pickPR(prs, branch, contains) {
  if (prs === null) return null;
  // A fork PR's branch name says nothing about a local branch of the same name.
  const mine = prs.filter(p => p.headRefName === branch && p.isCrossRepository !== true);
  const open = mine.find(p => p.state === 'OPEN');
  const merged = mine.filter(p => p.state === 'MERGED');
  const containing = open ? undefined : merged.find(p => contains(p.headRefOid));
  const pick = open ?? containing ?? merged[0] ?? mine.find(p => p.state === 'CLOSED');
  if (!pick) return { state: 'NONE' };
  return { state: pick.state, headSha: pick.headRefOid, number: pick.number, containsTip: pick === containing };
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

function readContext(repoDir, { listPRs = defaultListPRs, branches = [] } = {}) {
  // The configured URL, not `remote get-url`: the latter applies insteadOf
  // rewrites, which can turn a github.com URL into something unparseable.
  const slug = slugFromRemote(git(['config', '--get', 'remote.origin.url'], repoDir));
  const stashOut = git(['stash', 'list', '--format=%gd%x09%ci%x09%gs'], repoDir);
  return {
    repoDir,
    slug,
    defaultRef: git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir) || null,
    prs: slug ? listPRs(slug, branches) : null,
    stashes: stashOut === null ? null : parseStashes(stashOut),
  };
}

// Readings for one worktree, ready for classifyWorktree.
function readWorktree(wt, ctx) {
  const reading = { path: wt.path, branch: wt.detached ? null : wt.branch, head: wt.head, isMain: wt.isMain };
  if (wt.isMain) return reading;
  // Read idleness before `status`, which may refresh the index.
  const idle = idleHours(wt.path);
  const status = git(['status', '--porcelain'], wt.path);
  const unpushed = git(['rev-list', '--count', wt.head, '--not', '--remotes'], ctx.repoDir);
  const pid = wt.locked !== undefined ? Number(wt.locked.match(/pid[ =:]?(\d+)/i)?.[1]) || null : undefined;
  return {
    ...reading,
    idleHours: idle,
    dirty: status === null ? null : status.length > 0,
    unpushed: unpushed === null ? null : Number(unpushed),
    lockPid: pid,
    // A lock with no parseable PID is assumed live: we cannot prove it is not.
    lockLive: pid === undefined ? false : pid === null ? true : isAlive(pid),
    // Unread stashes fail closed. A stash whose subject names no branch is
    // linked to nothing (a detached worktree has branch null too).
    stashOnBranch: ctx.stashes === null ? true : ctx.stashes.some(s => s.branch !== null && s.branch === wt.branch),
    ancestorOfDefault: ctx.defaultRef ? gitOk(['merge-base', '--is-ancestor', wt.head, ctx.defaultRef], ctx.repoDir) : null,
    pr: wt.branch && !wt.detached
      ? pickPR(ctx.prs, wt.branch, sha => sha === wt.head || gitOk(['merge-base', '--is-ancestor', wt.head, sha], ctx.repoDir) === true)
      : null,
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
  const branches = all.filter(w => !w.isMain && !w.detached && !w.prunable && w.branch).map(w => w.branch);
  const ctx = readContext(repoDir, { listPRs, branches });
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
  // Compare resolved paths on both sides: git may record a worktree under a
  // symlinked prefix (/tmp versus /private/tmp on macOS).
  const resolve = p => { try { return realpathSync(p); } catch { return p; } };
  const wt = parseWorktrees(porcelain).find(w => resolve(w.path) === target);
  if (!wt) return { ok: false, reason: 'not a worktree of this repository' };
  if (wt.isMain) return { ok: false, reason: 'refusing to remove the main checkout' };
  if (wt.head !== expectTip) return { ok: false, reason: `tip moved: expected ${expectTip}, found ${wt.head}` };

  const ctx = readContext(repoDir, { listPRs, branches: wt.branch ? [wt.branch] : [] });
  const { status, reasons } = classifyWorktree(readWorktree(wt, ctx));
  if (status !== 'prunable') return { ok: false, reason: `not prunable: ${reasons.join('; ') || status}` };

  if (git(['worktree', 'remove', wt.path], repoDir) === null) {
    return { ok: false, reason: 'git worktree remove refused' };
  }
  if (git(['update-ref', '-d', `refs/heads/${wt.branch}`, expectTip], repoDir) === null) {
    return { ok: false, reason: 'worktree removed but branch ref moved; left in place' };
  }
  return { ok: true };
}

// ---- Approvals record (design section 6) --------------------------------
//
// Every dispatched action is logged with whether the owner took it as drafted.
// Only these two classes may ever graduate to running without asking; replies,
// reviews, labels and merges never do. Graduation itself is the owner's config
// change — this code only reports the streak.
export const ELIGIBLE_CLASSES = new Set(['prune-merged-worktree', 'release-reopen-for-ci']);
const OUTCOMES = new Set(['accepted-unchanged', 'edited', 'rejected', 'skipped']);
const GRADUATION_STREAK = 8;

export function approvalsFile(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || '', '.local', 'state');
  return join(base, 'repo-butler', 'approvals.jsonl');
}

export function recordApproval({ findingType, actionClass, repo, item, outcome }, { file = approvalsFile(), now = new Date() } = {}) {
  if (!OUTCOMES.has(outcome)) throw new Error(`unknown outcome: ${outcome}`);
  for (const [k, v] of Object.entries({ findingType, actionClass, repo, item })) {
    if (typeof v !== 'string' || !v) throw new Error(`${k} is required`);
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ts: now.toISOString(), findingType, actionClass, repo, item, outcome })}\n`);
}

/**
 * Trailing run of `accepted-unchanged` for a class. `skipped` neither extends
 * nor breaks the run (nothing was judged); `edited` and `rejected` reset it.
 */
export function approvalStreak(actionClass, { file = approvalsFile() } = {}) {
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    // No record yet: a streak of zero.
  }
  let streak = 0;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.actionClass !== actionClass) continue;
    if (entry.outcome === 'accepted-unchanged') streak += 1;
    else if (entry.outcome === 'edited' || entry.outcome === 'rejected') streak = 0;
  }
  const eligible = ELIGIBLE_CLASSES.has(actionClass);
  return { streak, eligible, graduated: eligible && streak >= GRADUATION_STREAK };
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
  // A session may be working here without a lock: a fresh worktree has no
  // commits and no dirt yet, and would otherwise look merged and forgotten.
  if (r.idleHours === null) reasons.push('could not read when the worktree was last used');
  else if (r.idleHours < MIN_IDLE_HOURS) reasons.push(`used in the last ${MIN_IDLE_HOURS} hours`);

  // Landed: an ancestor of the default branch, or a MERGED PR whose final head
  // contains this tip — equal to it, or a descendant of it when the branch was
  // pushed further after this checkout last moved (squash merges are not
  // ancestors of main). The reader computes containsTip; a CLOSED PR proves
  // nothing landed.
  const prHeadMatches = r.pr?.state === 'MERGED' && r.pr.containsTip === true;
  const landed = r.ancestorOfDefault === true || prHeadMatches;
  if (!landed) {
    if (r.pr?.state === 'CLOSED') reasons.push('PR closed without merging');
    else if (r.pr?.state === 'MERGED') reasons.push('merged PR head differs from the local tip');
    else if (r.ancestorOfDefault === null || r.pr === null) reasons.push('could not establish whether the branch landed');
    else reasons.push('no PR and not merged');
  }

  // A squash-merged PR's source branch is usually deleted, so after
  // `fetch --prune` its commits look unpushed. A merged head containing the tip
  // proves nothing local was left out, so it stands in for remote reachability.
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

  const q = shellQuote;
  const commands = [];
  // Naming a branch at a detached HEAD is what keeps its commits reachable.
  // It does nothing for uncommitted files, so dirt alone gets no command:
  // committing someone's work in progress is the owner's call.
  if (mainDetached) {
    const head = worktrees.find(w => w.status === 'main')?.head ?? '';
    commands.push(`git -C ${q(repoDir)} switch -c wip/${today}-${head.slice(0, 7)}-rescue`);
  }
  if (staleEntries.length) commands.push(`git -C ${q(repoDir)} worktree prune`);
  for (const w of prunable) {
    commands.push(`node ${q(scriptPath)} prune ${q(repoDir)} ${q(w.path)} --expect-tip ${w.head}`);
  }

  const parts = [];
  if (prunable.length) parts.push(`${prunable.length} prunable worktree(s)`);
  if (needsLook.length) parts.push(`${needsLook.length} worktree(s) need a look`);
  if (stashes.length) parts.push(`${stashes.length} stash(es)`);
  if (staleEntries.length) parts.push(`${staleEntries.length} stale worktree entr(ies)`);
  if (atRisk) {
    const risks = [];
    if (mainDetached) risks.push('on a detached HEAD');
    if (mainDirtyCount > RESCUE_DIRTY_THRESHOLD) risks.push(`${mainDirtyCount} uncommitted files (commit them to a WIP branch)`);
    if (stashes.length > RESCUE_STASH_THRESHOLD) risks.push(`${stashes.length} stashes`);
    parts.push(`checkout at risk of losing work: ${risks.join(', ')}`);
  }

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
