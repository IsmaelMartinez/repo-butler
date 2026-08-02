// Tests for the shared behind-main probe. Extracted from mcp.test.js with the
// probe itself (#350) — both the MCP server and the installed skills now depend
// on this classification, so a regression here is wrong twice over.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { classifyBehindMain, runGit, GIT_NONINTERACTIVE_ENV } from './staleness.js';

// The deciding half of the behind-main probe. Callers render whatever they are
// handed; THIS is what must never hand them a reassuring 0 for a checkout that
// has not fetched. Kept pure (git reads injected) so that branch is testable
// without a fixture repo.
describe('classifyBehindMain', () => {
  const SHA = 'a'.repeat(40);
  const present = () => true;
  const absent = () => false;
  const counts = (n) => () => String(n);

  it('counts against the real remote tip when we have that commit', () => {
    assert.equal(classifyBehindMain(`${SHA}\trefs/heads/main`, present, counts(7)), 7);
  });

  it('a genuine zero is preserved as a number, not conflated with unknown', () => {
    assert.strictEqual(classifyBehindMain(`${SHA}\trefs/heads/main`, present, counts(0)), 0);
  });

  // The defect this whole probe exists to remove.
  it('reports unfetched — never 0 — when the remote tip is absent locally', () => {
    assert.equal(classifyBehindMain(`${SHA}\trefs/heads/main`, absent, counts(0)), 'unfetched',
      'a checkout that cannot see the remote tip must not report a count');
  });

  it('does not even attempt a count when the tip is absent', () => {
    let counted = false;
    classifyBehindMain(`${SHA}\trefs/heads/main`, absent, () => { counted = true; return '0'; });
    assert.equal(counted, false, 'counting against a commit we do not have is meaningless');
  });

  it('is unknown when the remote could not be reached', () => {
    assert.equal(classifyBehindMain(null, present, counts(0)), null);
    assert.equal(classifyBehindMain('', present, counts(0)), null);
  });

  it('is unknown when ls-remote returns something that is not a sha', () => {
    assert.equal(classifyBehindMain('fatal: could not read from remote', present, counts(0)), null);
    assert.equal(classifyBehindMain('deadbeef\trefs/heads/main', present, counts(0)), null,
      'a short or malformed sha must not be trusted');
  });

  it('is unknown when the count itself is unreadable', () => {
    assert.equal(classifyBehindMain(`${SHA}\trefs/heads/main`, present, () => null), null);
    assert.equal(classifyBehindMain(`${SHA}\trefs/heads/main`, present, () => 'not-a-number'), null);
  });
});

describe('runGit', () => {
  it('returns null rather than throwing when the command fails', () => {
    assert.equal(runGit(['rev-parse', 'refs/heads/definitely-not-a-ref'], { cwd: process.cwd() }), null);
  });

  it('returns null rather than throwing when cwd is not a repository', () => {
    assert.equal(runGit(['rev-parse', 'HEAD'], { cwd: '/' }), null);
  });

  it('reads from the cwd it is given, not the process cwd', () => {
    // A probe that ignored `cwd` would answer for whichever checkout the caller
    // happens to be running in — the exact confusion #350 is about.
    assert.equal(runGit(['rev-parse', '--is-inside-work-tree'], { cwd: '/' }), null);
    assert.equal(runGit(['rev-parse', '--is-inside-work-tree'], { cwd: process.cwd() }), 'true');
  });

  it('never lets git block on an interactive credential prompt', () => {
    assert.equal(GIT_NONINTERACTIVE_ENV.GIT_TERMINAL_PROMPT, '0');
    assert.match(GIT_NONINTERACTIVE_ENV.GIT_SSH_COMMAND, /BatchMode=yes/);
  });

  // execFileSync forwards a child's stderr to the parent's unless told not to,
  // so a failing probe would print git's `fatal:` above the report that is
  // about to explain the same thing. Asserted in a child process because the
  // leak is to the OS-level stream, which an in-process spy cannot see.
  it('does not leak git stderr to the caller', () => {
    const probe = "import { runGit } from './src/staleness.js'; runGit(['rev-parse', 'HEAD'], { cwd: '/' });";
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(child.stderr, '', `git stderr leaked: ${child.stderr}`);
  });
});
