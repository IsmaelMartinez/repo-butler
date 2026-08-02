// Tests for the skills half of #350 — is the skill that is running the one on
// main? The pure core is unit-tested; the wrapper is tested against a real
// throwaway git fixture, because the three behind-states are exactly the thing
// a mocked git would let us get wrong.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSkillStaleness, classifyInstall, inspectSkillCheckout } from './skill-staleness.js';

describe('describeSkillStaleness', () => {
  const clean = { checkout: '/repo', branch: 'main', behind: 0, uncommittedSkillFiles: 0, installs: [] };

  it('says nothing when the skill is current, on main, and clean', () => {
    const r = describeSkillStaleness(clean);
    assert.equal(r.current, true);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.headline, 'skill is current with origin/main');
  });

  it('counts commits behind and says where to pull', () => {
    const r = describeSkillStaleness({ ...clean, behind: 3 });
    assert.equal(r.current, false);
    assert.equal(r.commits_behind_main, 3);
    assert.equal(r.behind_main_state, 'measured');
    assert.match(r.warnings[0], /3 commit\(s\) behind origin\/main/);
    assert.match(r.warnings[0], /\/repo/, 'the pull instruction must name the checkout');
  });

  // The state the whole probe exists for: behind by an uncountable amount.
  it('reports unfetched without ever implying a count', () => {
    const r = describeSkillStaleness({ ...clean, behind: 'unfetched' });
    assert.equal(r.current, false);
    assert.equal(r.behind_main_state, 'unfetched');
    assert.equal(r.commits_behind_main, null, 'unfetched is not a number of commits');
    assert.match(r.warnings[0], /has not fetched/);
  });

  it('an unreadable probe warns rather than passing as current', () => {
    const r = describeSkillStaleness({ ...clean, behind: null });
    assert.equal(r.current, false, '"could not check" must not look like "checked, it is fine"');
    assert.equal(r.behind_main_state, 'unknown');
    assert.match(r.warnings[0], /Could not determine/);
  });

  it('renders the three behind-states distinguishably', () => {
    const states = [0, 'unfetched', null].map(b => describeSkillStaleness({ ...clean, behind: b }));
    assert.deepEqual(states.map(s => s.behind_main_state), ['measured', 'unfetched', 'unknown']);
    assert.deepEqual(states.map(s => s.warnings.length), [0, 1, 1]);
    assert.equal(new Set(states.map(s => s.headline)).size, 3);
  });

  it('names the branch when the running skill is not from main', () => {
    const r = describeSkillStaleness({ ...clean, branch: 'try-a-thing' });
    assert.equal(r.current, false);
    assert.match(r.warnings[0], /branch `try-a-thing`, not `main`/);
    assert.match(r.headline, /on branch try-a-thing/);
  });

  it('distinguishes a detached HEAD from a named branch', () => {
    const r = describeSkillStaleness({ ...clean, branch: 'HEAD' });
    assert.match(r.warnings[0], /detached HEAD/);
    assert.doesNotMatch(r.warnings[0], /branch `HEAD`/);
  });

  it('an unreadable branch warns', () => {
    const r = describeSkillStaleness({ ...clean, branch: null });
    assert.match(r.warnings[0], /Could not read which branch/);
  });

  it('flags uncommitted changes under skills/ as live', () => {
    const r = describeSkillStaleness({ ...clean, uncommittedSkillFiles: 2 });
    assert.equal(r.current, false);
    assert.match(r.warnings[0], /2 uncommitted change\(s\)/);
    assert.match(r.headline, /2 uncommitted change\(s\) under skills\//);
  });

  it('an unreadable working tree warns rather than reporting zero edits', () => {
    const r = describeSkillStaleness({ ...clean, uncommittedSkillFiles: null });
    assert.equal(r.current, false);
    assert.match(r.warnings[0], /Could not check for uncommitted/);
  });

  it('warns that a copied skill can never receive a merge', () => {
    const r = describeSkillStaleness({ ...clean, installs: [{ name: 'repo-butler', status: 'copy' }] });
    assert.match(r.warnings[0], /installed as a copy.*merges will never reach it/s);
  });

  it('warns when the live skill comes from a different checkout', () => {
    const r = describeSkillStaleness({
      ...clean,
      installs: [{ name: 'repo-butler', status: 'linked-elsewhere', checkout: '/other' }],
    });
    assert.match(r.warnings[0], /different checkout \(\/other\)/);
  });

  it('warns on a broken registry symlink', () => {
    const r = describeSkillStaleness({ ...clean, installs: [{ name: 'repo-butler', status: 'broken' }] });
    assert.match(r.warnings[0], /broken symlink/);
  });

  it('is silent about a skill that is simply not installed here', () => {
    const r = describeSkillStaleness({
      ...clean,
      installs: [{ name: 'repo-butler', status: 'linked-here' }, { name: 'other', status: 'absent' }],
    });
    assert.deepEqual(r.warnings, [], 'not installing a skill on this machine is a choice, not a fault');
    assert.equal(r.current, true);
  });

  it('an unlocatable checkout warns and does not pass as current', () => {
    const r = describeSkillStaleness({ ...clean, checkout: null });
    assert.equal(r.current, false);
    assert.match(r.warnings[0], /Could not locate the checkout/);
  });

  it('reports every problem at once rather than only the first', () => {
    const r = describeSkillStaleness({
      checkout: '/repo',
      branch: 'wip',
      behind: 4,
      uncommittedSkillFiles: 1,
      installs: [{ name: 'repo-butler', status: 'copy' }],
    });
    assert.equal(r.warnings.length, 4);
  });
});

describe('classifyInstall', () => {
  let dir, registry, checkout, other;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'butler-install-')));
    registry = join(dir, 'registry');
    checkout = join(dir, 'checkout');
    other = join(dir, 'other');
    mkdirSync(registry);
    mkdirSync(join(checkout, 'skills', 'linked'), { recursive: true });
    mkdirSync(join(other, 'skills', 'elsewhere'), { recursive: true });

    symlinkSync(join(checkout, 'skills', 'linked'), join(registry, 'linked'));
    symlinkSync(join(other, 'skills', 'elsewhere'), join(registry, 'elsewhere'));
    symlinkSync(join(dir, 'gone'), join(registry, 'dangling'));
    mkdirSync(join(registry, 'copied'));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('recognises a symlink into this checkout', () => {
    assert.equal(classifyInstall(registry, 'linked', checkout).status, 'linked-here');
  });

  it('recognises a symlink into a different checkout, and names it', () => {
    const r = classifyInstall(registry, 'elsewhere', checkout);
    assert.equal(r.status, 'linked-elsewhere');
    assert.equal(r.checkout, other);
  });

  it('recognises a real directory as a copy, not a link', () => {
    assert.equal(classifyInstall(registry, 'copied', checkout).status, 'copy');
  });

  it('recognises a dangling symlink as broken, not absent', () => {
    assert.equal(classifyInstall(registry, 'dangling', checkout).status, 'broken');
  });

  it('reports a missing entry as absent', () => {
    assert.equal(classifyInstall(registry, 'never-installed', checkout).status, 'absent');
  });
});

// The wrapper against real git. Mocking git here would prove nothing: the
// unfetched case depends on how `ls-remote`, the object store and the
// remote-tracking ref actually disagree.
describe('inspectSkillCheckout against a real repository', () => {
  let root, origin, work, upToDate, unfetched, fetchedBehind, dirty;

  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();

  const commitSkill = (cwd, text) => {
    mkdirSync(join(cwd, 'skills', 'repo-butler'), { recursive: true });
    writeFileSync(join(cwd, 'skills', 'repo-butler', 'SKILL.md'), text);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', text);
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'butler-skill-git-')));
    origin = join(root, 'origin.git');
    work = join(root, 'work');

    git(root, 'init', '--bare', '-b', 'main', origin);
    git(root, 'clone', origin, work);
    commitSkill(work, 'first');
    git(work, 'push', 'origin', 'main');

    // Three clones taken at the same commit, then diverged deliberately: one
    // pulls, one fetches without merging, one does nothing at all.
    for (const [name, path] of [['upToDate', 'a'], ['unfetched', 'b'], ['fetchedBehind', 'c'], ['dirty', 'd']]) {
      git(root, 'clone', origin, join(root, path));
      if (name === 'upToDate') upToDate = join(root, path);
      if (name === 'unfetched') unfetched = join(root, path);
      if (name === 'fetchedBehind') fetchedBehind = join(root, path);
      if (name === 'dirty') dirty = join(root, path);
    }

    commitSkill(work, 'second');
    git(work, 'push', 'origin', 'main');

    git(upToDate, 'pull', '--ff-only');
    git(fetchedBehind, 'fetch', 'origin');
    git(dirty, 'pull', '--ff-only');
    writeFileSync(join(dirty, 'skills', 'repo-butler', 'SKILL.md'), 'edited in place');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('a pulled checkout is current', () => {
    const r = inspectSkillCheckout(upToDate);
    assert.equal(r.commits_behind_main, 0);
    assert.equal(r.behind_main_state, 'measured');
    assert.equal(r.branch, 'main');
    assert.equal(r.uncommitted_skill_files, 0);
    assert.equal(r.current, true, r.warnings.join(' | '));
  });

  // The 2026-06-21 failure: main moved, the checkout never pulled, and the
  // skill kept rendering the old version as though nothing had happened.
  it('a checkout that never fetched reports unfetched, not zero', () => {
    const r = inspectSkillCheckout(unfetched);
    assert.equal(r.behind_main_state, 'unfetched');
    assert.equal(r.current, false);
    assert.match(r.warnings.join(' '), /has not fetched/);
  });

  it('a fetched-but-unmerged checkout reports a real count', () => {
    const r = inspectSkillCheckout(fetchedBehind);
    assert.equal(r.behind_main_state, 'measured');
    assert.equal(r.commits_behind_main, 1);
    assert.equal(r.current, false);
  });

  // The 2026-07-27 failure: an edit made through the registry path landed in
  // the checkout's working tree and silently became the live skill.
  it('an uncommitted edit under skills/ is reported as live', () => {
    const r = inspectSkillCheckout(dirty);
    assert.equal(r.uncommitted_skill_files, 1);
    assert.equal(r.current, false);
    assert.match(r.warnings.join(' '), /uncommitted change\(s\) under `skills\/`/);
  });

  it('resolves install status against the registry when given one', () => {
    const registry = join(root, 'registry');
    mkdirSync(registry, { recursive: true });
    symlinkSync(join(upToDate, 'skills', 'repo-butler'), join(registry, 'repo-butler'));

    const r = inspectSkillCheckout(upToDate, { skillsDir: registry });
    assert.deepEqual(r.installs.map(i => [i.name, i.status]), [['repo-butler', 'linked-here']]);
  });

  it('degrades to warnings rather than throwing outside a repository', () => {
    const r = inspectSkillCheckout(join(root, 'not-a-repo-at-all'));
    assert.equal(r.current, false);
    assert.equal(r.checkout, null);
    assert.match(r.warnings.join(' '), /Could not locate the checkout/);
  });

  // A directory that exists but is not a repository: every git reading fails
  // while the path itself resolves. Each unreadable reading must become null
  // and warn — an unreadable working tree reported as "0 edits" would be the
  // reassuring-zero bug again, one level down.
  it('maps every unreadable git reading to unknown, never to a clean result', () => {
    const plain = join(root, 'plain-directory');
    mkdirSync(plain, { recursive: true });

    const r = inspectSkillCheckout(plain);
    assert.equal(r.checkout, plain, 'the path resolves; only the git readings fail');
    assert.equal(r.branch, null);
    assert.equal(r.behind_main_state, 'unknown');
    assert.equal(r.uncommitted_skill_files, null, 'unreadable is not the same as clean');
    assert.equal(r.current, false);
    assert.match(r.warnings.join(' '), /Could not check for uncommitted changes/);
  });
});
