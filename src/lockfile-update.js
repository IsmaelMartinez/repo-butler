// Lockfile refresh for `reachable-by-update` alerts (ADR-015).
//
// The G13 stalled-alert detector already classifies an npm alert through the
// trimmer's vocabulary, and `reachable-by-update` is the trimmer's REFUSAL:
// "every parent range already admits the patch; refresh the lockfile instead".
// Nothing in the write path acted on that refusal, so the alert sat open until
// a human ran `npm update <pkg> --package-lock-only` by hand — five times in one
// afternoon across this portfolio. This module is the deciding core for doing
// that as a governance write.
//
// The shape is deliberately narrower than "fix the alert". npm is the transform
// engine; the butler never edits the lockfile itself. What the butler owns is
// the GATE: a pure comparison of the lockfile before and after that refuses
// anything the operator would not have signed off on when doing it by hand.
// Refusal is the default and the specification, exactly as in the trimmer.

import { REPO_NAME_PATTERN } from './safety.js';
import { parseVersion } from './trimmer.js';
import { alertDirectory } from './stalled-alert.js';

export const LOCKFILE_UPDATE_TOOL = 'lockfile-update';

const CLASSIFIABLE_ECOSYSTEM = 'npm';
const ACTIONABLE_CLASSIFICATION = 'reachable-by-update';
const MIN_LOCKFILE_VERSION = 2;
const DEP_KEYS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * One target per (repo, directory), carrying only the alerts this tool can act
 * on: npm, classified `reachable-by-update`, with a number and a package name.
 * Grouping by directory matters because one `npm update` call refreshes one
 * lockfile, and every reachable alert in that lockfile belongs in the same PR.
 *
 * @returns {Array<{repo: string, directory: string, alerts: Array<{number: number, package: string}>}>}
 */
export function selectLockfileUpdateTargets(findings, maxPerRun = 5) {
  const cap = Number.isInteger(Number(maxPerRun)) && Number(maxPerRun) > 0 ? Number(maxPerRun) : 5;
  const targets = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || f.type !== 'stalled-alert' || !Array.isArray(f.alerts)) continue;
    if (!f.repo || !REPO_NAME_PATTERN.test(f.repo)) {
      if (f.repo) console.warn(`${LOCKFILE_UPDATE_TOOL}: skipping repo with invalid name: ${f.repo}`);
      continue;
    }
    for (const a of f.alerts) {
      if (!a || a.ecosystem !== CLASSIFIABLE_ECOSYSTEM || a.classification !== ACTIONABLE_CLASSIFICATION) continue;
      if (!Number.isInteger(a.number) || !a.package) continue;
      const directory = alertDirectory(a.manifestPath);
      let target = targets.find(t => t.repo === f.repo && t.directory === directory);
      if (!target) {
        target = { repo: f.repo, directory, alerts: [] };
        targets.push(target);
      }
      target.alerts.push({ number: a.number, package: a.package });
    }
  }
  return targets.slice(0, cap);
}

// The package name an entry stands for: its explicit `name` (aliased installs)
// or the last `node_modules/` segment of its path. The root entry ('') has no
// name and is never in any family, so a change to it is refused as out-of-family.
function entryName(path, entry) {
  if (entry?.name) return entry.name;
  const idx = path.lastIndexOf('node_modules/');
  return idx === -1 ? path : path.slice(idx + 'node_modules/'.length);
}

/**
 * Every `packages[]` entry whose version differs between two parsed lockfiles,
 * as { path, name, from, to } with null on the side the entry is absent from.
 * Ordered by path so a preview and a PR body are stable.
 */
export function diffLockfilePackages(before, after) {
  const bp = before?.packages ?? {};
  const ap = after?.packages ?? {};
  const paths = [...new Set([...Object.keys(bp), ...Object.keys(ap)])].sort();
  const changes = [];
  for (const path of paths) {
    const from = bp[path]?.version ?? null;
    const to = ap[path]?.version ?? null;
    if (from === to) continue;
    changes.push({ path, name: entryName(path, ap[path] ?? bp[path]), from, to });
  }
  return changes;
}

/**
 * The set of package names a refresh of `name` is allowed to touch: `name`
 * itself plus everything any copy of it in the tree declares, transitively.
 * Resolution is by name across the whole lockfile rather than by npm's
 * nearest-ancestor rule, which over-approximates the family slightly; that
 * direction is acceptable because the release-line check still applies to
 * every version change, while the opposite direction (missing a legitimate
 * nested dependency) would refuse correct refreshes for no reason.
 */
export function familyOf(lock, name) {
  const packages = lock?.packages ?? {};
  const byName = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') continue;
    const n = entryName(path, entry);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(entry ?? {});
  }
  const family = new Set();
  const queue = [name];
  while (queue.length > 0) {
    const n = queue.pop();
    if (family.has(n)) continue;
    family.add(n);
    for (const entry of byName.get(n) ?? []) {
      for (const key of DEP_KEYS) {
        for (const dep of Object.keys(entry[key] ?? {})) {
          if (!family.has(dep)) queue.push(dep);
        }
      }
    }
  }
  return family;
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function cmp(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// Same release line: same major, and inside 0.x the same minor too, because
// there every minor is itself a breaking line (the trimmer's lesson: a
// major-only comparison is blind exactly where these alerts live).
function sameReleaseLine(a, b) {
  if (a.major !== b.major) return false;
  return a.major !== 0 || a.minor === b.minor;
}

/**
 * The write decision. Given the manifest and lockfile text before and after
 * `npm update <pkgs> --package-lock-only`, either every rule holds and the
 * refresh may become a PR, or one rule names why it may not. Rules, in order:
 *
 *   manifest-changed        npm touched package.json; only the lockfile may move
 *   workspaces-unsupported  a workspaces root needs manifests the caller did not fetch
 *   unparseable-lockfile    either side is not JSON
 *   unsupported-lockfile    lockfileVersion < 2 has no packages map to reason over
 *   no-patched-version      an alert carries no parseable first_patched_version
 *   no-change               nothing moved, so there is nothing to open
 *   not-updated             something moved but an alert package did not
 *   not-patched             a copy of an alert package is still below its patch
 *   out-of-family           a change outside every alert package's dependency closure
 *   release-line-crossing   a version change across a major, or a 0.x minor
 *
 * @returns {{ok: true, changes: Array} | {ok: false, reason: string, detail: string}}
 */
export function computeLockfileGate({ lockBefore, lockAfter, manifestBefore, manifestAfter, alerts } = {}) {
  const refuse = (reason, detail) => ({ ok: false, reason, detail });

  if (manifestBefore !== manifestAfter) {
    return refuse('manifest-changed', 'package.json differs after the refresh; only package-lock.json may change');
  }
  const manifest = parseJson(manifestBefore);
  if (manifest?.workspaces) {
    return refuse('workspaces-unsupported', 'the manifest declares workspaces');
  }

  const before = parseJson(lockBefore);
  const after = parseJson(lockAfter);
  if (!before || !after) {
    return refuse('unparseable-lockfile', 'a lockfile could not be parsed as JSON');
  }
  for (const l of [before, after]) {
    if (!(Number(l.lockfileVersion) >= MIN_LOCKFILE_VERSION) || !l.packages || typeof l.packages !== 'object') {
      return refuse('unsupported-lockfile', `lockfileVersion ${l.lockfileVersion ?? 'absent'} has no packages map`);
    }
  }

  const patched = new Map();
  for (const a of Array.isArray(alerts) ? alerts : []) {
    const v = parseVersion(a?.patchedVersion);
    if (!a?.package || !v) {
      return refuse('no-patched-version', `alert #${a?.number ?? '?'} (${a?.package ?? '?'}) has no parseable patched version`);
    }
    patched.set(a.package, v);
  }

  const changes = diffLockfilePackages(before, after);
  if (changes.length === 0) {
    return refuse('no-change', 'the refresh produced an identical lockfile');
  }

  for (const [name, patch] of patched) {
    if (!changes.some(c => c.name === name)) {
      return refuse('not-updated', `${name} did not move`);
    }
    for (const [path, entry] of Object.entries(after.packages)) {
      if (path === '' || entryName(path, entry) !== name) continue;
      const v = parseVersion(entry?.version);
      if (!v || cmp(v, patch) < 0) {
        return refuse('not-patched', `${path} is at ${entry?.version ?? 'unknown'}, below ${name}@${[patch.major, patch.minor, patch.patch].join('.')}`);
      }
    }
  }

  const family = new Set();
  for (const name of patched.keys()) {
    for (const n of familyOf(before, name)) family.add(n);
    for (const n of familyOf(after, name)) family.add(n);
  }
  for (const c of changes) {
    if (!family.has(c.name)) {
      return refuse('out-of-family', `${c.path} changed (${c.from ?? 'absent'} -> ${c.to ?? 'removed'}) outside the alert packages' dependency closure`);
    }
  }

  for (const c of changes) {
    if (c.from === null || c.to === null) continue;
    const from = parseVersion(c.from);
    const to = parseVersion(c.to);
    if (!from || !to || !sameReleaseLine(from, to)) {
      return refuse('release-line-crossing', `${c.path} moved ${c.from} -> ${c.to}`);
    }
  }

  return { ok: true, changes };
}
