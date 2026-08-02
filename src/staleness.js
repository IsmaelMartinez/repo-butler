// Shared git probe for the question "how far behind origin/main is this
// checkout?".
//
// Two live surfaces answer from a working checkout and neither of them fetches:
// the MCP server (src/mcp.js) and the Claude Code skills, which
// scripts/install-skills.sh symlinks out of `skills/` into the local registry.
// Whatever that checkout currently is — an unpulled main, a feature branch, an
// uncommitted edit — is what runs, and nothing about the output looks different
// when it is stale. Both have already produced confidently wrong answers (#350).
//
// The probe lives here rather than in either caller because the three-state
// classification below is the whole guard, and a second hand-rolled copy of it
// is exactly how one surface would end up reporting a reassuring zero. Callers
// supply their own checkout directory and render their own wording.

import { execFileSync } from 'node:child_process';

// Non-interactive by construction. `ls-remote` talks to the network, and on an
// HTTPS remote without cached credentials git would otherwise sit waiting for a
// username at a terminal nobody is watching — for a stdio MCP server that hangs
// a tool call for the whole timeout. GIT_TERMINAL_PROMPT=0 covers the HTTPS
// path, BatchMode the SSH one, and the empty askpass vars stop a GUI helper
// being summoned instead. A missing credential must fail immediately and become
// `unknown`, which every caller's envelope reports honestly.
export const GIT_NONINTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
};

// Run a plain git command in `cwd`. Returns trimmed stdout, or null on any
// failure (not a repo, missing ref, timeout) — a staleness probe must never be
// able to break the thing it is annotating.
//
// stderr is explicitly discarded. execFileSync forwards a child's stderr to the
// parent's by default, and every failure here is one we handle by returning
// null, so git's `fatal: not a git repository` would print above the report
// that is about to say the same thing in its own words. Nothing reads the
// stream: the outcome is carried entirely by the null.
export function runGit(args, { cwd, timeout = 5000 } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      cwd,
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...GIT_NONINTERACTIVE_ENV },
    }).trim();
  } catch {
    return null;
  }
}

// Pure decision, separated from the git I/O so the branch that must never
// collapse `unfetched` into a reassuring 0 is unit-testable. Takes the raw
// ls-remote line plus two probes as callbacks:
//   isPresentLocally(sha) -> boolean      (does the object store have it)
//   countTo(sha)          -> string|null  (`rev-list --count HEAD..<sha>`)
export function classifyBehindMain(lsRemoteLine, isPresentLocally, countTo) {
  const remoteSha = lsRemoteLine ? String(lsRemoteLine).trim().split(/\s+/)[0] : null;

  // Offline, unauthenticated, or the probe timed out. Unknown, never zero.
  if (!remoteSha || !/^[0-9a-f]{40}$/.test(remoteSha)) return null;

  // The remote tip is not in this object store, so this checkout has not
  // fetched since main moved. We know we are behind; we cannot say by how much
  // without fetching. 'unfetched' makes the caller say exactly that instead of
  // implying a count.
  if (!isPresentLocally(remoteSha)) return 'unfetched';

  const raw = countTo(remoteSha);
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

// How far behind the *real* origin/main the checkout at `cwd` is.
//
// `git rev-list --count HEAD..origin/main` alone is not enough, and getting
// this wrong defeats the whole guard: `origin/main` is a remote-tracking ref
// that only moves on fetch, and neither caller fetches. On a checkout that has
// not pulled in three weeks it returns 0 — an affirmative all-clear for
// precisely the unpulled-checkout case the guard exists to catch. "Could not
// check" and "checked, it is fine" must not look alike.
//
// So resolve the real tip first with `ls-remote`, which is a network READ that
// mutates nothing in the caller's repository — the thing the no-fetch rule
// forbids is a network *write* to their refs, not asking the remote a question.
//
// Cached for CACHE_MS, keyed by checkout, so a burst of calls costs one
// round-trip; short enough that a long-lived server still notices main moving.
const REMOTE_PROBE_CACHE_MS = 60000;
const remoteProbeCache = new Map();

export function readCommitsBehindMain(cwd, now = Date.now()) {
  const cached = remoteProbeCache.get(cwd);
  if (cached && now - cached.at < REMOTE_PROBE_CACHE_MS) return cached.value;

  const value = classifyBehindMain(
    runGit(['ls-remote', '--heads', 'origin', 'main'], { cwd, timeout: 8000 }),
    (sha) => runGit(['cat-file', '-e', `${sha}^{commit}`], { cwd }) !== null,
    (sha) => runGit(['rev-list', '--count', `HEAD..${sha}`], { cwd }),
  );

  remoteProbeCache.set(cwd, { at: now, value });
  return value;
}
