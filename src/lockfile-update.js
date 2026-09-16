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

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { REPO_NAME_PATTERN } from './safety.js';
import { parseVersion } from './trimmer.js';
import { alertDirectory } from './stalled-alert.js';
import { APPLY_PR_MARKER, isScheduleAllowed, screenApplyTarget } from './apply.js';

export const LOCKFILE_UPDATE_TOOL = 'lockfile-update';

const CLASSIFIABLE_ECOSYSTEM = 'npm';
const ACTIONABLE_CLASSIFICATION = 'reachable-by-update';
const MIN_LOCKFILE_VERSION = 2;
const DEP_KEYS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const NPM_TIMEOUT_MS = 120_000;
const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
// A package name becomes an argument to `npm update`, so it is validated
// at the boundary (the finding, then again against the live alert) the way
// REPO_NAME_PATTERN guards names that reach a URL. Lowercase, URL-safe, an
// optional scope, no leading dot or underscore, and nothing that could be
// read as a flag or a path. Linear-time by construction.
const NPM_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

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
      if (!NPM_NAME_PATTERN.test(a.package)) {
        console.warn(`${LOCKFILE_UPDATE_TOOL}: skipping alert #${a.number} on ${f.repo}: package name is not a valid npm name`);
        continue;
      }
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

// --- the write path ---------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Run `npm update <pkgs> --package-lock-only` in a scratch directory holding
 * only the manifest and the lockfile. `--package-lock-only` needs no
 * node_modules, so the registry is the only thing npm touches. `--ignore-scripts`
 * because nothing here should execute code from the target repo. Returns both
 * files as written back, so the gate can prove the manifest did not move.
 * Injectable via options.runNpmUpdate: the tests never spawn npm.
 */
export async function runNpmUpdateInTempDir({ manifest, lockfile, packages }) {
  const dir = await mkdtemp(join(tmpdir(), 'repo-butler-lockfile-'));
  // NODE_ENV=production makes npm drop devDependencies from the refresh, which
  // the gate would then refuse as out-of-family removals; unset it so the
  // scratch run sees the whole tree the lockfile describes.
  const env = { ...process.env };
  delete env.NODE_ENV;
  try {
    await writeFile(join(dir, MANIFEST), manifest);
    await writeFile(join(dir, LOCKFILE), lockfile);
    await execFileAsync('npm', [
      'update', ...packages,
      '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress',
    ], { cwd: dir, timeout: NPM_TIMEOUT_MS, env, maxBuffer: 8 * 1024 * 1024 });
    return {
      manifest: await readFile(join(dir, MANIFEST), 'utf-8'),
      lockfile: await readFile(join(dir, LOCKFILE), 'utf-8'),
    };
  } catch (err) {
    // npm's stderr carries the resolution error (ERESOLVE and friends); the
    // stdout is progress noise. Keep the tail so the run summary says why.
    const tail = String(err.stderr ?? err.message ?? '').trim().split('\n').slice(-6).join('\n');
    throw new Error(`npm update failed: ${tail.slice(0, 600)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Read a file at a ref, falling back to the blob API when the Contents API
// declines to inline it. That API caps inline content at 1 MB and returns the
// object with `content: ""` and `encoding: "none"` above it; real lockfiles
// exceed 1 MB, and ADR-013 names guessing on that null as the failure this
// caller must not have. Returns null only for a genuine 404; anything else throws.
async function readFileAtRef(gh, owner, repo, path, ref) {
  let data;
  try {
    data = await gh.request(`/repos/${owner}/${repo}/contents/${path}`, { params: { ref } });
  } catch (err) {
    if (err.message?.includes(': 404')) return null;
    throw err;
  }
  if (typeof data?.content === 'string' && data.content.length > 0) {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  if (!data?.sha) return null;
  const blob = await gh.request(`/repos/${owner}/${repo}/git/blobs/${data.sha}`);
  if (typeof blob?.content !== 'string') return null;
  return Buffer.from(blob.content, 'base64').toString('utf-8');
}

// Re-read each alert LIVE at apply time (the ADR-012 posture: the finding can be
// six hours stale). An alert that is no longer open, or whose live package and
// ecosystem disagree with the finding, is dropped — that is a fixed alert or a
// mismatched finding, not an error. An unreadable alert throws so the caller
// records an error rather than a skip.
async function readOpenAlerts(gh, owner, repo, alerts) {
  const open = [];
  for (const a of alerts) {
    const live = await gh.request(`/repos/${owner}/${repo}/dependabot/alerts/${a.number}`);
    const pkg = live?.dependency?.package;
    if (live?.state !== 'open' || pkg?.ecosystem !== CLASSIFIABLE_ECOSYSTEM || pkg?.name !== a.package) {
      console.log(`${LOCKFILE_UPDATE_TOOL}: ${owner}/${repo} alert #${a.number} is ${live?.state ?? 'unreadable'} / ${pkg?.name ?? '?'}, dropping`);
      continue;
    }
    open.push({ number: a.number, package: a.package, patchedVersion: live?.security_vulnerability?.first_patched_version?.identifier ?? null });
  }
  return open;
}

function toolNameFor(directory) {
  return directory ? `${LOCKFILE_UPDATE_TOOL}-${directory.replace(/[^a-zA-Z0-9]+/g, '-')}` : LOCKFILE_UPDATE_TOOL;
}

// The PR is assembled from the gate's own output and nothing else: no LLM text,
// no advisory prose (attacker-controlled), no @-mentions. Alert numbers link
// through the repo's alerts page rather than being autolinked in prose.
function buildPrBody(owner, repo, directory, alerts, changes) {
  const lockPath = directory ? `${directory}/${LOCKFILE}` : LOCKFILE;
  const lines = [
    `## Governance: refresh \`${lockPath}\``,
    '',
    'Every parent range already admits the patched version, so the lockfile is refreshed in place with `npm update --package-lock-only`; `package.json` is untouched.',
    '',
    '| Alert | Package | Patched from |',
    '|---|---|---|',
    ...alerts.map(a => `| [#${a.number}](https://github.com/${owner}/${repo}/security/dependabot/${a.number}) | \`${a.package}\` | ${a.patchedVersion} |`),
    '',
    '| Lockfile entry | Before | After |',
    '|---|---|---|',
    ...changes.map(c => `| \`${c.path}\` | ${c.from ?? '—'} | ${c.to ?? 'removed'} |`),
    '',
    `Gate: ${changes.length} change(s), all within the alert packages' dependency closure and release lines. Review and merge when ready.`,
    '',
    '---',
    `*${APPLY_PR_MARKER}(https://github.com/IsmaelMartinez/repo-butler)*`,
  ];
  return lines.join('\n');
}

function buildPrTitle(alerts) {
  const pkgs = alerts.map(a => a.package).join(', ');
  const nums = alerts.map(a => `#${a.number}`).join(', ');
  return `chore(deps): refresh lockfile for ${pkgs} (Dependabot alert${alerts.length > 1 ? 's' : ''} ${nums})`;
}

async function openPullRequest(gh, owner, repo, { branchName, defaultBranch, lockPath, lockfile, title, body }) {
  const ref = await gh.request(`/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`);
  try {
    await gh.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branchName}`, sha: ref.object.sha },
    });
  } catch (err) {
    // 422: the ref already exists (a closed PR's branch). Reset it to main.
    if (!err.message?.includes('422')) throw err;
    await gh.request(`/repos/${owner}/${repo}/git/refs/heads/${branchName}`, {
      method: 'PATCH',
      body: { sha: ref.object.sha, force: true },
    });
  }
  await gh.putFile(owner, repo, lockPath, lockfile, { branch: branchName, message: title });
  const pr = await gh.request(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: { title, head: branchName, base: defaultBranch, body },
  });
  try {
    await gh.request(`/repos/${owner}/${repo}/issues/${pr.number}/labels`, {
      method: 'POST',
      body: { labels: ['governance-apply'] },
    });
  } catch {
    // Non-fatal: the PR is open, the label is cosmetic.
  }
  return pr.html_url;
}

/**
 * Governance write (ADR-015): for every `stalled-alert` finding whose alerts
 * the trimmer classified `reachable-by-update`, refresh the lockfile with npm,
 * run the gate, and open a PR. One PR per (repo, directory); one target at a
 * time. The ADR-005 gates apply unchanged: require_approval, dry-run
 * fail-closed (only the literal `false` writes), the per-run cap, repo-name
 * validation, and — unlike a template class — the scheduled path only when
 * `apply-schedule` names the tool, since this is a content-transformation write.
 *
 * Dry-run performs every READ and runs npm in a scratch directory so the
 * preview is the real forecast (the diff the PR would carry), but never a write.
 */
export async function applyLockfileUpdates(gh, owner, findings, config, options = {}) {
  const { dryRun, maxPerRun = 5, scheduled, runNpmUpdate = runNpmUpdateInTempDir } = options;
  const log = (msg) => console.log(`${LOCKFILE_UPDATE_TOOL}: ${msg}`);

  if (!config?.limits?.require_approval) {
    console.error(`${LOCKFILE_UPDATE_TOOL}: config.limits.require_approval is not true — refusing to run`);
    return { status: 'refused', reason: 'require_approval not set' };
  }
  if (scheduled && !isScheduleAllowed(config?.['apply-schedule'], LOCKFILE_UPDATE_TOOL)) {
    log('[scheduled]: not on the apply-schedule allow-list — skipping');
    return { status: 'skipped-unscheduled', targets: [] };
  }

  const live = dryRun === false;
  const targets = selectLockfileUpdateTargets(findings, maxPerRun);
  const results = [];

  for (const target of targets) {
    const { repo, directory } = target;
    const tool = toolNameFor(directory);
    const prefix = directory ? `${directory}/` : '';
    const label = `${owner}/${repo}${directory ? ` (${directory})` : ''}`;
    try {
      const screen = await screenApplyTarget(gh, owner, repo, tool);
      if (!screen.eligible) {
        results.push({ repo, directory, status: screen.status, reason: screen.reason });
        continue;
      }

      const alerts = await readOpenAlerts(gh, owner, repo, target.alerts);
      if (alerts.length === 0) {
        results.push({ repo, directory, status: 'skipped', reason: 'no open alerts' });
        continue;
      }

      const repoMeta = await gh.request(`/repos/${owner}/${repo}`);
      const defaultBranch = repoMeta.default_branch || 'main';
      const manifestBefore = await readFileAtRef(gh, owner, repo, `${prefix}${MANIFEST}`, defaultBranch);
      const lockBefore = await readFileAtRef(gh, owner, repo, `${prefix}${LOCKFILE}`, defaultBranch);
      if (manifestBefore === null || lockBefore === null) {
        log(`${label} manifest or lockfile unreadable, skipping (fail-closed)`);
        results.push({ repo, directory, status: 'skipped', reason: 'manifest or lockfile unreadable' });
        continue;
      }

      // Cheap pre-flight of the gate's manifest rule so npm never runs on a
      // shape the gate would refuse anyway.
      const preflight = computeLockfileGate({ lockBefore, lockAfter: lockBefore, manifestBefore, manifestAfter: manifestBefore, alerts });
      if (!preflight.ok && preflight.reason !== 'no-change') {
        log(`${label} refused before npm: ${preflight.reason} (${preflight.detail})`);
        results.push({ repo, directory, status: 'skipped', reason: `gate:${preflight.reason}`, detail: preflight.detail });
        continue;
      }

      const packages = alerts.map(a => a.package);
      const after = await runNpmUpdate({ manifest: manifestBefore, lockfile: lockBefore, packages });
      const gate = computeLockfileGate({
        lockBefore, lockAfter: after.lockfile, manifestBefore, manifestAfter: after.manifest, alerts,
      });
      if (!gate.ok) {
        log(`${label} gate refused: ${gate.reason} (${gate.detail})`);
        results.push({ repo, directory, status: 'skipped', reason: `gate:${gate.reason}`, detail: gate.detail });
        continue;
      }

      const summary = gate.changes.map(c => `${c.path}: ${c.from ?? '—'} -> ${c.to ?? 'removed'}`);
      if (!live) {
        log(`[DRY RUN] ${label} would open a PR for ${packages.join(', ')} with ${gate.changes.length} change(s):`);
        for (const line of summary) log(`  ${line}`);
        results.push({ repo, directory, status: 'would-open', alerts, changes: gate.changes });
        continue;
      }

      const url = await openPullRequest(gh, owner, repo, {
        branchName: `repo-butler/apply-${tool}`,
        defaultBranch,
        lockPath: `${prefix}${LOCKFILE}`,
        lockfile: after.lockfile,
        title: buildPrTitle(alerts),
        body: buildPrBody(owner, repo, directory, alerts, gate.changes),
      });
      log(`${label} — PR created: ${url}`);
      results.push({ repo, directory, status: 'created', pr: url, alerts, changes: gate.changes });
    } catch (err) {
      console.error(`${LOCKFILE_UPDATE_TOOL}: error on ${label}: ${err.message}`);
      results.push({ repo, directory, status: 'error', error: err.message });
    }
  }

  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;
  if (!live) {
    const wouldOpen = results.filter(r => r.status === 'would-open').length;
    log(`[DRY RUN]: would open ${wouldOpen} PR(s), ${skipped} skipped, ${errors} error(s)`);
    return { status: 'dry-run', results, summary: { created: 0, skipped, errors, wouldOpen } };
  }
  const created = results.filter(r => r.status === 'created').length;
  log(`done — ${created} PR(s) created, ${skipped} skipped, ${errors} error(s)`);
  return { status: 'completed', results, summary: { created, skipped, errors } };
}
