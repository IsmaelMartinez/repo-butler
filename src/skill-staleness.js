// Is the Claude Code skill you are running actually the one on main? (#350)
//
// `scripts/install-skills.sh` symlinks `skills/<name>` into the local registry.
// The symlink is the right design — a merge takes effect with no copy step —
// but it binds the live skill to a checkout's *working tree*. What runs is
// whatever that checkout currently is: an unpulled main, a feature branch, or
// an uncommitted edit. Nothing reported the discrepancy, so the failure mode
// was a skill that was confidently wrong rather than visibly broken: PR #291's
// comic uplift merged and the old version kept rendering for days.
//
// The fix is a staleness signal, not a new installer, and it follows the MCP
// server's G8 precedent exactly: report, never fetch. Asking the remote where
// main is (`ls-remote`) is a read; pulling on someone's behalf because they
// asked a question is not this module's business.

import { readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runGit, readCommitsBehindMain } from './staleness.js';

// Pure: turns raw readings into a verdict. Split from the git and filesystem
// calls so the wording and the "anything to tell you?" decision are testable
// without a fixture repo. Every reading is independently nullable, and a null
// always warns — "could not check" and "checked, it is fine" must not look
// alike, which is the same rule the MCP envelope follows.
export function describeSkillStaleness({
  checkout = null,
  branch = null,
  behind = null,
  uncommittedSkillFiles = null,
  installs = [],
} = {}) {
  const warnings = [];
  const where = checkout ? ` in ${checkout}` : '';

  if (!checkout) {
    warnings.push('Could not locate the checkout the skill is running from.');
  }

  // Three distinguishable states, as in computeStaleness. Collapsing any two of
  // them is how this guard would lie; a number, and only a number, can be 0.
  if (behind === 'unfetched') {
    warnings.push(`This checkout has not fetched since origin/main moved, so the skill is behind by an amount that cannot be counted without fetching. Run \`git pull\`${where}.`);
  } else if (behind === null) {
    warnings.push('Could not determine whether this checkout is behind origin/main.');
  } else if (behind > 0) {
    warnings.push(`The running skill is ${behind} commit(s) behind origin/main. Run \`git pull\`${where}.`);
  }

  if (branch === null) {
    warnings.push('Could not read which branch this checkout is on.');
  } else if (branch === 'HEAD') {
    warnings.push('This checkout is on a detached HEAD, so the running skill is not any branch.');
  } else if (branch !== 'main') {
    warnings.push(`The running skill comes from branch \`${branch}\`, not \`main\`.`);
  }

  if (uncommittedSkillFiles === null) {
    warnings.push('Could not check for uncommitted changes under `skills/`.');
  } else if (uncommittedSkillFiles > 0) {
    warnings.push(`${uncommittedSkillFiles} uncommitted change(s) under \`skills/\` are live — the running skill is not what is committed.`);
  }

  // Installation anomalies. `absent` is deliberately silent: not having a skill
  // installed on this machine is a choice, not a fault.
  for (const install of installs) {
    if (install.status === 'copy') {
      warnings.push(`\`${install.name}\` is installed as a copy, not a symlink, so merges will never reach it. Re-run \`scripts/install-skills.sh\`.`);
    } else if (install.status === 'linked-elsewhere') {
      warnings.push(`\`${install.name}\` runs from a different checkout (${install.checkout}), so this report does not describe it.`);
    } else if (install.status === 'broken') {
      warnings.push(`\`${install.name}\` is a broken symlink in the skill registry. Re-run \`scripts/install-skills.sh\`.`);
    }
  }

  return {
    checkout,
    branch,
    commits_behind_main: typeof behind === 'number' ? behind : null,
    behind_main_state: behind === 'unfetched' ? 'unfetched'
      : behind === null ? 'unknown' : 'measured',
    uncommitted_skill_files: uncommittedSkillFiles,
    installs,
    current: warnings.length === 0,
    headline: headlineFor(behind, branch, uncommittedSkillFiles),
    warnings,
  };
}

// One line, for a skill to render inside its own output. Names the dominant
// fact rather than concatenating every warning — the full list is in `warnings`
// for anyone who wants it.
function headlineFor(behind, branch, dirty) {
  const parts = [];

  if (behind === 'unfetched') parts.push('skill checkout has not fetched since origin/main moved');
  else if (behind === null) parts.push('could not check whether the skill is current');
  else if (behind > 0) parts.push(`skill is ${behind} commit(s) behind origin/main`);
  else parts.push('skill is current with origin/main');

  if (branch === 'HEAD') parts.push('on a detached HEAD');
  else if (branch && branch !== 'main') parts.push(`on branch ${branch}`);
  else if (branch === null) parts.push('branch unknown');

  if (dirty === null) parts.push('uncommitted changes unknown');
  else if (dirty > 0) parts.push(`${dirty} uncommitted change(s) under skills/`);

  return parts.join(', ');
}

// Where the registry entry for `name` actually points, as one of five states.
// A copy and a broken link both mean a merge can never reach the live skill,
// and each needs saying differently.
export function classifyInstall(skillsDir, name, checkout) {
  const linkPath = join(skillsDir, name);

  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return { name, status: 'absent', checkout: null };
  }

  if (!stat.isSymbolicLink()) return { name, status: 'copy', checkout: null };

  let target;
  try {
    target = realpathSync(linkPath);
  } catch {
    return { name, status: 'broken', checkout: null };
  }

  // <repo>/skills/<name> — two levels up is the checkout root.
  const linkedCheckout = dirname(dirname(target));
  return {
    name,
    status: linkedCheckout === checkout ? 'linked-here' : 'linked-elsewhere',
    checkout: linkedCheckout,
  };
}

// Thin I/O wrapper: gather the readings for `checkout`, hand them to the pure
// core. Every reading degrades to null rather than throwing, so a probe can
// never break the skill it is annotating.
export function inspectSkillCheckout(checkout, { skillsDir } = {}) {
  const resolved = safeRealpath(checkout);

  const branch = resolved ? runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: resolved }) : null;
  const behind = resolved ? readCommitsBehindMain(resolved) : null;

  const dirtyRaw = resolved
    ? runGit(['status', '--porcelain', '--', 'skills'], { cwd: resolved })
    : null;
  const uncommittedSkillFiles = dirtyRaw === null
    ? null
    : dirtyRaw.split('\n').filter(line => line.trim()).length;

  // Read the skill names off the checkout rather than hardcoding them, so a
  // skill added to `skills/` is covered without touching this file.
  let installs = [];
  if (resolved && skillsDir) {
    installs = skillNames(resolved).map(name => classifyInstall(skillsDir, name, resolved));
  }

  return describeSkillStaleness({ checkout: resolved, branch, behind, uncommittedSkillFiles, installs });
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function skillNames(checkout) {
  try {
    return readdirSync(join(checkout, 'skills'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}
