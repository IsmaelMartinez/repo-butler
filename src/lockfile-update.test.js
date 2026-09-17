import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectLockfileUpdateTargets,
  diffLockfilePackages,
  familyOf,
  computeLockfileGate,
  applyLockfileUpdates,
  toolNameFor,
  npmFailureReason,
  npmChildEnv,
  findNonRegistrySource,
  displayString,
} from './lockfile-update.js';
import { validateIssueTitle, validateIssueBody } from './safety.js';

// --- fixtures -------------------------------------------------------------

function alert(overrides = {}) {
  return {
    number: 1,
    package: 'libheif',
    ecosystem: 'npm',
    manifestPath: 'package-lock.json',
    severity: 'high',
    ageDays: 20,
    classification: 'reachable-by-update',
    detail: 'every parent range already admits libheif@1.2.3; refresh the lockfile instead',
    ...overrides,
  };
}

function finding(repo, alerts, overrides = {}) {
  return { type: 'stalled-alert', repo, alerts, priority: 'medium', ...overrides };
}

// A lockfileVersion 3 lockfile with a root entry and the given packages. The
// root's own dependencies are irrelevant to the gate; what matters is the
// `node_modules/*` entries and their declared `dependencies`. Every entry
// gets a public-registry `resolved` unless the fixture set one (or is a
// link), because an absent `resolved` is itself a refusal — tests for that
// case build the JSON by hand.
function lock(packages, extra = {}) {
  const withResolved = Object.fromEntries(Object.entries(packages).map(([path, entry]) => {
    if (path === '' || entry.link || 'resolved' in entry) return [path, entry];
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    return [path, { ...entry, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${entry.version}.tgz` }];
  }));
  return JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { sharp: '^0.34.0' } },
      ...withResolved,
    },
    ...extra,
  });
}

function rawLock(packages) {
  return JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' }, ...packages } });
}

const manifest = JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { sharp: '^0.34.0' } });

// sharp depends on libheif (the alert subject) and on a platform binary.
const BEFORE = {
  'node_modules/sharp': { version: '0.34.1', dependencies: { libheif: '^1.2.0', '@img/sharp-linux-x64': '0.34.1' } },
  'node_modules/libheif': { version: '1.2.0' },
  'node_modules/@img/sharp-linux-x64': { version: '0.34.1' },
  'node_modules/unrelated': { version: '3.0.0' },
};

function gate(afterPackages, overrides = {}) {
  return computeLockfileGate({
    lockBefore: lock(BEFORE),
    lockAfter: lock({ ...BEFORE, ...afterPackages }),
    manifestBefore: manifest,
    manifestAfter: manifest,
    alerts: [{ number: 1, package: 'libheif', patchedVersion: '1.2.3' }],
    ...overrides,
  });
}

// --- selectLockfileUpdateTargets ------------------------------------------

describe('selectLockfileUpdateTargets', () => {
  it('returns one target per (repo, directory) carrying only npm reachable-by-update alerts', () => {
    const findings = [
      finding('repo-a', [
        alert({ number: 1, package: 'libheif' }),
        alert({ number: 2, package: 'js-yaml', manifestPath: 'package.json' }),
        alert({ number: 3, package: 'sharp', classification: 'override' }),
        alert({ number: 4, package: 'requests', ecosystem: 'pip' }),
        alert({ number: 5, package: 'lodash', manifestPath: 'docs/package-lock.json' }),
      ]),
    ];
    const targets = selectLockfileUpdateTargets(findings);
    assert.deepEqual(targets, [
      { repo: 'repo-a', directory: '', alerts: [{ number: 1, package: 'libheif' }, { number: 2, package: 'js-yaml' }] },
      { repo: 'repo-a', directory: 'docs', alerts: [{ number: 5, package: 'lodash' }] },
    ]);
  });

  it('ignores findings of other types, malformed findings, and repos with invalid names', () => {
    const findings = [
      { type: 'open-vulnerability', repo: 'repo-a', sources: ['dependabot'] },
      finding('bad name/../x', [alert()]),
      finding('repo-b', [alert()]),
      null,
      finding('repo-c', 'not-an-array'),
    ];
    const targets = selectLockfileUpdateTargets(findings);
    assert.deepEqual(targets.map(t => t.repo), ['repo-b']);
  });

  it('returns every target uncapped (the runner caps after screening) and tolerates a non-array input', () => {
    const findings = ['a', 'b', 'c', 'd', 'e', 'f'].map(r => finding(`repo-${r}`, [alert()]));
    assert.equal(selectLockfileUpdateTargets(findings).length, 6);
    assert.deepEqual(selectLockfileUpdateTargets(undefined), []);
  });

  it('drops an alert with no package name or no number rather than emitting a half target', () => {
    const findings = [finding('repo-a', [alert({ package: '' }), alert({ number: undefined }), alert({ number: 9, package: 'ok' })])];
    assert.deepEqual(selectLockfileUpdateTargets(findings)[0].alerts, [{ number: 9, package: 'ok' }]);
  });

  it('drops an alert whose manifest path is not a plain repo-relative path (it becomes a branch, a URL path and markdown)', () => {
    const findings = [finding('repo-a', [
      alert({ number: 1, manifestPath: '../escape/package-lock.json' }),
      alert({ number: 2, manifestPath: 'docs @user/package-lock.json' }),
      alert({ number: 3, manifestPath: 'a|b/package-lock.json' }),
      alert({ number: 4, manifestPath: 'packages/site-v2/package-lock.json' }),
      alert({ number: 5, manifestPath: '/package-lock.json' }),
      alert({ number: 6, manifestPath: './package-lock.json' }),
      alert({ number: 7, manifestPath: 'docs\\package-lock.json' }),
    ])];
    assert.deepEqual(selectLockfileUpdateTargets(findings), [
      { repo: 'repo-a', directory: 'packages/site-v2', alerts: [{ number: 4, package: 'libheif' }] },
    ]);
  });

  it('drops an alert whose manifest is not an npm lockfile or manifest (yarn and pnpm alerts share the npm ecosystem)', () => {
    const findings = [finding('repo-a', [
      alert({ number: 1, manifestPath: 'yarn.lock' }),
      alert({ number: 2, manifestPath: 'docs/pnpm-lock.yaml' }),
      alert({ number: 3, manifestPath: 'npm-shrinkwrap.json' }),
      alert({ number: 4, manifestPath: 'docs/package.json' }),
      alert({ number: 5, manifestPath: 'package-lock.json' }),
    ])];
    assert.deepEqual(selectLockfileUpdateTargets(findings), [
      { repo: 'repo-a', directory: 'docs', alerts: [{ number: 4, package: 'libheif' }] },
      { repo: 'repo-a', directory: '', alerts: [{ number: 5, package: 'libheif' }] },
    ]);
  });

  it('drops an alert with a missing or blank manifest path instead of grouping it into the root target', () => {
    const findings = [finding('repo-a', [
      alert({ number: 1, manifestPath: null }),
      alert({ number: 2, manifestPath: '' }),
      alert({ number: 3, manifestPath: undefined }),
      alert({ number: 4, manifestPath: 'package-lock.json' }),
    ])];
    assert.deepEqual(selectLockfileUpdateTargets(findings), [
      { repo: 'repo-a', directory: '', alerts: [{ number: 4, package: 'libheif' }] },
    ]);
  });

  it('drops a package name that is not a valid npm name, since the name becomes an npm argument', () => {
    const findings = [finding('repo-a', [
      alert({ number: 1, package: '--registry=https://evil.example' }),
      alert({ number: 2, package: '@scope/ok.pkg-1' }),
      alert({ number: 3, package: 'Has Space' }),
      alert({ number: 4, package: '../escape' }),
    ])];
    assert.deepEqual(selectLockfileUpdateTargets(findings)[0].alerts, [{ number: 2, package: '@scope/ok.pkg-1' }]);
  });
});

// --- diffLockfilePackages ---------------------------------------------------

describe('diffLockfilePackages', () => {
  it('reports version changes, additions and removals with the package name derived from the path', () => {
    const before = { packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/@s/b': { version: '2.0.0' }, 'node_modules/a/node_modules/c': { version: '1.0.0' } } };
    const after = { packages: { '': {}, 'node_modules/a': { version: '1.0.1' }, 'node_modules/@s/b': { version: '2.0.0' }, 'node_modules/d': { version: '0.1.0' } } };
    assert.deepEqual(diffLockfilePackages(before, after), [
      { path: 'node_modules/a', name: 'a', from: '1.0.0', to: '1.0.1', kind: 'version' },
      { path: 'node_modules/a/node_modules/c', name: 'c', from: '1.0.0', to: null, kind: 'removed' },
      { path: 'node_modules/d', name: 'd', from: null, to: '0.1.0', kind: 'added' },
    ]);
  });

  it('reports an entry whose content changed without a version move as a metadata change', () => {
    const before = { packages: { 'node_modules/a': { version: '1.0.0', resolved: 'x' } } };
    const after = { packages: { 'node_modules/a': { version: '1.0.0', resolved: 'y' } } };
    assert.deepEqual(diffLockfilePackages(before, after), [
      { path: 'node_modules/a', name: 'a', from: '1.0.0', to: '1.0.0', kind: 'metadata' },
    ]);
    assert.deepEqual(diffLockfilePackages(before, { packages: { 'node_modules/a': { resolved: 'x', version: '1.0.0' } } }), [], 'key order is not a change');
  });

  it('prefers an explicit name field over the path-derived one (aliased installs)', () => {
    const before = { packages: { 'node_modules/alias': { name: 'real', version: '1.0.0' } } };
    const after = { packages: { 'node_modules/alias': { name: 'real', version: '1.0.1' } } };
    assert.equal(diffLockfilePackages(before, after)[0].name, 'real');
  });
});

// --- familyOf ----------------------------------------------------------------

describe('familyOf', () => {
  it('is the package plus everything it declares, transitively, across every copy in the tree', () => {
    const l = JSON.parse(lock({
      ...BEFORE,
      'node_modules/libheif': { version: '1.2.0', dependencies: { 'libde265': '^1.0.0' } },
      'node_modules/libde265': { version: '1.0.0', optionalDependencies: { 'libde265-bin': '*' } },
      'node_modules/libde265-bin': { version: '1.0.0' },
      'node_modules/other/node_modules/libheif': { version: '1.1.0', dependencies: { 'old-dep': '^1' } },
      'node_modules/old-dep': { version: '1.0.0' },
    }));
    assert.deepEqual([...familyOf(l, 'libheif')].sort(), ['libde265', 'libde265-bin', 'libheif', 'old-dep']);
  });

  it('does not include the dependents of the package (sharp is not in libheif\'s family)', () => {
    assert.equal(familyOf(JSON.parse(lock(BEFORE)), 'libheif').has('sharp'), false);
  });

  it('survives a dependency cycle', () => {
    const l = { packages: { 'node_modules/a': { dependencies: { b: '*' } }, 'node_modules/b': { dependencies: { a: '*' } } } };
    assert.deepEqual([...familyOf(l, 'a')].sort(), ['a', 'b']);
  });
});

// --- computeLockfileGate ----------------------------------------------------

describe('computeLockfileGate', () => {
  it('passes a refresh that moves only the alert package to at least the patched version', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.5' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.changes, [{ path: 'node_modules/libheif', name: 'libheif', from: '1.2.0', to: '1.2.5', kind: 'version' }]);
  });

  it('passes when the refresh also moves packages inside the alert package\'s own family', () => {
    const r = gate({
      'node_modules/libheif': { version: '1.2.5', dependencies: { libde265: '^1.0.0' } },
      'node_modules/libde265': { version: '1.0.4' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 2);
  });

  it('refuses when package.json changed at all (npm must only have touched the lockfile)', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.5' } }, { manifestAfter: manifest + '\n' });
    assert.deepEqual([r.ok, r.reason], [false, 'manifest-changed']);
  });

  it('refuses an unparseable lockfile on either side', () => {
    assert.equal(gate({}, { lockAfter: '{ not json' }).reason, 'unparseable-lockfile');
    assert.equal(gate({}, { lockBefore: '' }).reason, 'unparseable-lockfile');
  });

  it('refuses a lockfileVersion 1 lockfile, which has no packages map to reason over', () => {
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { libheif: { version: '1.2.5' } } });
    assert.equal(gate({}, { lockBefore: v1, lockAfter: v1 }).reason, 'unsupported-lockfile');
  });

  it('refuses a workspaces manifest: the refresh needs every workspace manifest present, which the caller does not fetch', () => {
    const ws = JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] });
    const r = gate({ 'node_modules/libheif': { version: '1.2.5' } }, { manifestBefore: ws, manifestAfter: ws });
    assert.equal(r.reason, 'workspaces-unsupported');
  });

  it('refuses when nothing changed: there is no PR to open', () => {
    assert.equal(gate({}).reason, 'no-change');
  });

  it('refuses when the alert package moved but not to the patched version', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.2' } });
    assert.deepEqual([r.ok, r.reason], [false, 'not-patched']);
  });

  it('refuses when a nested copy of the alert package is still below the patched version', () => {
    const r = gate({
      'node_modules/libheif': { version: '1.2.5' },
      'node_modules/other/node_modules/libheif': { version: '1.1.0' },
    }, {
      lockBefore: lock({ ...BEFORE, 'node_modules/other/node_modules/libheif': { version: '1.1.0' } }),
    });
    assert.equal(r.reason, 'not-patched');
  });

  it('refuses when something changed but the alert package did not move', () => {
    const r = gate({ 'node_modules/@img/sharp-linux-x64': { version: '0.34.2' } });
    assert.equal(r.reason, 'not-updated');
  });

  it('refuses when the alert package only had its metadata rewritten while already at the patch', () => {
    const r = computeLockfileGate({
      lockBefore: lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.5', resolved: 'a' } }),
      lockAfter: lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.5', resolved: 'b' } }),
      manifestBefore: manifest, manifestAfter: manifest,
      alerts: [{ number: 1, package: 'libheif', patchedVersion: '1.2.3' }],
    });
    assert.equal(r.reason, 'not-updated');
  });

  it('refuses any change outside the alert package\'s family, including removals', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.5' }, 'node_modules/unrelated': { version: '3.0.1' } });
    assert.deepEqual([r.reason, r.detail.includes('unrelated')], ['out-of-family', true]);

    const gone = { ...BEFORE, 'node_modules/libheif': { version: '1.2.5' } };
    delete gone['node_modules/unrelated'];
    const r2 = computeLockfileGate({
      lockBefore: lock(BEFORE), lockAfter: lock(gone), manifestBefore: manifest, manifestAfter: manifest,
      alerts: [{ number: 1, package: 'libheif', patchedVersion: '1.2.3' }],
    });
    assert.equal(r2.reason, 'out-of-family');
  });

  it('refuses a release-line crossing: a major bump, or a minor bump inside 0.x', () => {
    const major = gate({ 'node_modules/libheif': { version: '2.0.0' } }, { alerts: [{ number: 1, package: 'libheif', patchedVersion: '2.0.0' }] });
    assert.equal(major.reason, 'release-line-crossing');

    const zeroMinor = computeLockfileGate({
      lockBefore: lock({ 'node_modules/tiny': { version: '0.34.5' } }),
      lockAfter: lock({ 'node_modules/tiny': { version: '0.35.0' } }),
      manifestBefore: manifest, manifestAfter: manifest,
      alerts: [{ number: 7, package: 'tiny', patchedVersion: '0.35.0' }],
    });
    assert.equal(zeroMinor.reason, 'release-line-crossing');

    const zeroPatch = computeLockfileGate({
      lockBefore: lock({ 'node_modules/tiny': { version: '0.34.5' } }),
      lockAfter: lock({ 'node_modules/tiny': { version: '0.34.6' } }),
      manifestBefore: manifest, manifestAfter: manifest,
      alerts: [{ number: 7, package: 'tiny', patchedVersion: '0.34.6' }],
    });
    assert.equal(zeroPatch.ok, true);
  });

  it('requires every alert in the call to have moved to its patch', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.5' } }, {
      alerts: [
        { number: 1, package: 'libheif', patchedVersion: '1.2.3' },
        { number: 2, package: 'unrelated', patchedVersion: '3.0.1' },
      ],
    });
    assert.equal(r.reason, 'not-updated');
    assert.equal(r.detail.includes('unrelated'), true);
  });

  it('refuses an alert whose patched version cannot be parsed rather than treating it as satisfied', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.5' } }, { alerts: [{ number: 1, package: 'libheif', patchedVersion: 'latest' }] });
    assert.equal(r.reason, 'no-patched-version');
  });

  it('refuses anything but a plain release on either side rather than comparing it as its final release', () => {
    const patchedPre = gate({ 'node_modules/libheif': { version: '1.2.3-beta.0' } }, { alerts: [{ number: 1, package: 'libheif', patchedVersion: '1.2.3-beta.1' }] });
    assert.equal(patchedPre.reason, 'non-release-version');

    const entryPre = gate({ 'node_modules/libheif': { version: '1.2.5-rc.1' } });
    assert.equal(entryPre.reason, 'non-release-version');

    const familyPre = gate({
      'node_modules/libheif': { version: '1.2.5', dependencies: { libde265: '*' } },
      'node_modules/libde265': { version: '1.0.4+build.7' },
    });
    assert.equal(familyPre.reason, 'non-release-version');

    // parseVersion tolerates any residual suffix; the gate must not.
    for (const odd of ['1.2.5foo', '1.2.5.4', 'v1.2.5 ']) {
      const r = gate({ 'node_modules/libheif': { version: odd } });
      assert.equal(r.reason, 'non-release-version', odd);
    }
    assert.equal(gate({ 'node_modules/libheif': { version: 'v1.2.5' } }).ok, true, 'a leading v is a plain release');
  });

  it('sees a metadata-only change to an entry (no version move) and holds it to the family rule', () => {
    const r = gate({
      'node_modules/libheif': { version: '1.2.5' },
      'node_modules/unrelated': { version: '3.0.0', resolved: 'https://registry.example/unrelated-3.0.0.tgz' },
    });
    assert.deepEqual([r.reason, r.detail.includes('unrelated')], ['out-of-family', true]);

    const inFamily = gate({
      'node_modules/libheif': { version: '1.2.5', resolved: 'https://registry.npmjs.org/libheif/-/libheif-1.2.5.tgz' },
      'node_modules/@img/sharp-linux-x64': { version: '0.34.1', peer: true },
    }, {
      lockBefore: lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.0', dependencies: { '@img/sharp-linux-x64': '*' } } }),
      lockAfter: lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.5', resolved: 'https://registry.npmjs.org/libheif/-/libheif-1.2.5.tgz', dependencies: { '@img/sharp-linux-x64': '*' } }, 'node_modules/@img/sharp-linux-x64': { version: '0.34.1', peer: true } }),
    });
    assert.equal(inFamily.ok, true);
    assert.deepEqual(inFamily.changes.map(c => [c.name, c.kind]), [['@img/sharp-linux-x64', 'metadata'], ['libheif', 'version']]);
  });

  it('refuses when anything outside packages[] changed (a lockfileVersion rewrite is not a refresh)', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.5' } }, {
      lockAfter: lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.5' } }, { lockfileVersion: 2 }),
    });
    assert.equal(r.reason, 'lockfile-metadata-changed');
  });

  it('ignores the top-level dependencies mirror on v2 only; on v3 it is an unaccounted top-level change', () => {
    const v2before = lock(BEFORE, { lockfileVersion: 2, dependencies: { libheif: { version: '1.2.0' } } });
    const v2after = lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.5' } }, { lockfileVersion: 2, dependencies: { libheif: { version: '1.2.5' } } });
    const v2 = computeLockfileGate({ lockBefore: v2before, lockAfter: v2after, manifestBefore: manifest, manifestAfter: manifest, alerts: [{ number: 1, package: 'libheif', patchedVersion: '1.2.3' }] });
    assert.equal(v2.ok, true);

    const v3after = lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.5' } }, { dependencies: { libheif: { version: '1.2.5' } } });
    const v3 = gate({}, { lockAfter: v3after });
    assert.equal(v3.reason, 'lockfile-metadata-changed');
  });

  it('refuses a relocation or addition that brings a new release line of an existing package into the tree', () => {
    const relocated = { ...BEFORE, 'node_modules/libheif': { version: '1.2.5', dependencies: { libde265: '^2.0.0' } }, 'node_modules/libheif/node_modules/libde265': { version: '2.0.0' } };
    delete relocated['node_modules/libde265'];
    const r = computeLockfileGate({
      lockBefore: lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.0', dependencies: { libde265: '^1.0.0' } }, 'node_modules/libde265': { version: '1.0.0' } }),
      lockAfter: lock(relocated),
      manifestBefore: manifest, manifestAfter: manifest,
      alerts: [{ number: 1, package: 'libheif', patchedVersion: '1.2.3' }],
    });
    assert.equal(r.reason, 'release-line-crossing');

    // A package new to the whole tree has no line to cross.
    const fresh = gate({ 'node_modules/libheif': { version: '1.2.5', dependencies: { 'brand-new': '^3.0.0' } }, 'node_modules/brand-new': { version: '3.0.0' } });
    assert.equal(fresh.ok, true);
  });

  it('refuses a changed entry resolved from anywhere but the public npm registry, or with no resolved at all', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.5', resolved: 'https://npm.pkg.github.com/download/libheif/1.2.5' } });
    assert.equal(r.reason, 'unexpected-registry');
    const absent = computeLockfileGate({
      lockBefore: lock(BEFORE),
      lockAfter: rawLock({ ...JSON.parse(lock(BEFORE)).packages, 'node_modules/libheif': { version: '1.2.5' } }),
      manifestBefore: manifest, manifestAfter: manifest,
      alerts: [{ number: 1, package: 'libheif', patchedVersion: '1.2.3' }],
    });
    assert.equal(absent.reason, 'unexpected-registry');
    const ok = gate({ 'node_modules/libheif': { version: '1.2.5', resolved: 'https://registry.npmjs.org/libheif/-/libheif-1.2.5.tgz' } });
    assert.equal(ok.ok, true);
  });
});

describe('findNonRegistrySource', () => {
  const registryLock = JSON.parse(lock({
    'node_modules/libheif': { version: '1.2.0', resolved: 'https://registry.npmjs.org/libheif/-/libheif-1.2.0.tgz' },
  }));

  it('accepts a manifest whose every spec is a registry range or an npm: alias, and a lockfile resolved from the registry', () => {
    const m = { dependencies: { a: '^1.0.0', b: '~2.1.0', c: '3.0.0', d: 'npm:real-d@^1.0.0', e: '>=1 <2', f: '*', g: 'latest' }, overrides: { h: '^1.0.0', i: { j: '^2.0.0' } } };
    assert.equal(findNonRegistrySource(m, registryLock), null);
  });

  it('names a manifest spec that would make npm contact anywhere but the registry', () => {
    for (const spec of ['git+https://github.com/x/y.git', 'github:x/y', 'https://example.com/pkg.tgz', 'file:../local', 'link:../local', 'workspace:*', 'x/y', 'git://h/r.git']) {
      const found = findNonRegistrySource({ dependencies: { bad: spec } }, registryLock);
      assert.ok(found && found.includes('bad'), spec);
    }
    assert.ok(findNonRegistrySource({ devDependencies: { bad: 'github:x/y' } }, registryLock));
    assert.ok(findNonRegistrySource({ overrides: { p: { bad: 'file:../x' } } }, registryLock));
  });

  it('names a lockfile entry not resolved from the registry, a link entry, or one with no resolved at all', () => {
    const git = JSON.parse(lock({ 'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/y.git#abc' } }));
    assert.ok(findNonRegistrySource({}, git).includes('node_modules/x'));
    const link = JSON.parse(lock({ 'node_modules/x': { resolved: 'packages/x', link: true } }));
    assert.ok(findNonRegistrySource({}, link).includes('node_modules/x'));
    const bare = JSON.parse(rawLock({ 'node_modules/x': { version: '1.0.0' } }));
    assert.ok(findNonRegistrySource({}, bare).includes('node_modules/x'));
  });
});

describe('applyLockfileUpdates pre-flight', () => {
  it('skips a project with a non-registry dependency source before npm is spawned', async () => {
    const m = JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { sharp: '^0.34.0', tool: 'github:x/y' } });
    const gh = fakeGh({ alerts: { 1: openAlert(1, 'libheif') }, files: { 'package.json': m, 'package-lock.json': lock(BEFORE) } });
    let ran = false;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { ran = true; } });
    assert.equal(r.results[0].status, 'skipped');
    assert.equal(r.results[0].reason, 'non-registry-source');
    assert.equal(ran, false);
  });

  it('holds a package to the highest patched version when two alerts name it', () => {
    const r = gate({ 'node_modules/libheif': { version: '1.2.5' } }, {
      alerts: [
        { number: 1, package: 'libheif', patchedVersion: '1.2.9' },
        { number: 2, package: 'libheif', patchedVersion: '1.2.3' },
      ],
    });
    assert.equal(r.reason, 'not-patched');
  });

  it('refuses when the refresh removed every copy of the alert package', () => {
    const gone = { ...BEFORE };
    delete gone['node_modules/libheif'];
    const r = computeLockfileGate({
      lockBefore: lock(BEFORE), lockAfter: lock(gone), manifestBefore: manifest, manifestAfter: manifest,
      alerts: [{ number: 1, package: 'libheif', patchedVersion: '1.2.3' }],
    });
    assert.equal(r.reason, 'not-patched');
  });
});

describe('displayString', () => {
  it('strips control characters and newlines and bounds the length, so a lockfile key cannot shape a log line or a table row', () => {
    assert.equal(displayString('node_modules/a\n::warning::x\r\tb'), 'node_modules/a?::warning::x??b');
    assert.equal(displayString('a|b'), 'a\\|b');
    assert.equal(displayString('x'.repeat(300)).length, 200);
    assert.equal(displayString(null), '');
  });
});

describe('npmChildEnv', () => {
  it('hands npm a minimal environment pinned to the public registry, never the runner\'s secrets or npm config', () => {
    const env = npmChildEnv({
      PATH: '/usr/bin', HOME: '/home/runner', GITHUB_TOKEN: 'ghs_secret', NODE_ENV: 'production',
      NPM_TOKEN: 'npm_secret', npm_config_registry: 'https://evil.example/', NPM_CONFIG_USERCONFIG: '/home/runner/.npmrc', TMPDIR: '/tmp',
    }, '/scratch');
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR', 'npm_config_globalconfig', 'npm_config_registry', 'npm_config_userconfig']);
    assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
    assert.equal(env.PATH, '/usr/bin');
    assert.doesNotMatch(JSON.stringify(env), /secret|evil|production/);
    // npm refuses to load one path as both user and global config, so the two
    // absent files must differ and live in the scratch directory.
    assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig);
    assert.match(env.npm_config_userconfig, /^\/scratch\//);
    assert.match(env.npm_config_globalconfig, /^\/scratch\//);
  });
});

describe('npmFailureReason', () => {
  it('reduces npm stderr to its error code, never echoing registry URLs or package metadata', () => {
    const stderr = [
      'npm error code ERESOLVE',
      'npm error ERESOLVE unable to resolve dependency tree',
      'npm error While resolving: fixture@1.0.0',
      'npm error Found: vitest@4.0.0 from https://registry.example/vitest',
    ].join('\n');
    assert.equal(npmFailureReason(stderr), 'npm update failed: code ERESOLVE');
    assert.equal(npmFailureReason('npm ERR! code E404\nnpm ERR! 404 https://registry.example/x'), 'npm update failed: code E404');
    assert.equal(npmFailureReason('something else entirely https://evil.example'), 'npm update failed: no npm error code in output');
    assert.equal(npmFailureReason(''), 'npm update failed: no npm error code in output');
  });
});

describe('toolNameFor', () => {
  it('gives distinct, bounded branch suffixes to directories that slugify alike', () => {
    assert.equal(toolNameFor(''), 'lockfile-update');
    const a = toolNameFor('docs/site');
    const b = toolNameFor('docs-site');
    assert.notEqual(a, b);
    assert.match(a, /^lockfile-update-docs-site-[0-9a-f]{8}$/);
  });
});

// --- applyLockfileUpdates ----------------------------------------------------

const b64 = (s) => Buffer.from(s).toString('base64');

// A fake GitHub client with a route table. `writes` collects every non-GET
// request so a dry-run can be proven inert; `puts` collects putFile calls.
function fakeGh({ alerts = {}, files = {}, prs = [], writes = [], puts = [], reads = [], fail = {}, headShas = ['abc123'] } = {}) {
  let headCalls = 0;
  return {
    writes,
    puts,
    reads,
    request: async (path, opts) => {
      const method = opts?.method ?? 'GET';
      if (method !== 'GET') {
        writes.push({ path, method, body: opts?.body });
        if (path.endsWith('/git/refs') && fail.refExists) throw new Error('GitHub API error: 422 Reference already exists');
        if (path.endsWith('/pulls')) return { number: 42, html_url: 'https://github.com/o/r/pull/42' };
        return {};
      }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' };
      if (path.endsWith('/git/ref/heads/main')) {
        // A moving default branch: each resolve may return a later sha.
        const sha = headShas[Math.min(headCalls, headShas.length - 1)];
        headCalls += 1;
        return { object: { sha } };
      }
      let m = path.match(/\/dependabot\/alerts\/(\d+)$/);
      if (m) {
        if (fail.alerts) throw new Error('GitHub API error: 500 boom');
        const a = alerts[m[1]];
        if (!a) throw new Error('GitHub API error: 404 Not Found');
        return a;
      }
      m = path.match(/\/contents\/(.+)$/);
      if (m) {
        reads.push({ path: m[1], ref: opts?.params?.ref });
        const f = files[m[1]];
        if (f === undefined) throw new Error('GitHub API error: 404 Not Found');
        if (typeof f === 'object') return f; // caller-shaped response (e.g. the >1 MB form)
        return { content: b64(f), encoding: 'base64', sha: 'filesha' };
      }
      m = path.match(/\/git\/blobs\/(.+)$/);
      if (m) return { content: b64(files[`blob:${m[1]}`]), encoding: 'base64' };
      throw new Error(`unexpected GET ${path}`);
    },
    paginate: async (path, opts) => (typeof prs === 'function' ? prs(opts?.params?.head ?? '') : prs),
    putFile: async (owner, repo, filePath, content, opts) => { puts.push({ repo, filePath, content, opts }); },
  };
}

function openAlert(number, name, patched = '1.2.3', manifestPath = 'package-lock.json') {
  return {
    number,
    state: 'open',
    dependency: { package: { ecosystem: 'npm', name }, manifest_path: manifestPath },
    security_vulnerability: { first_patched_version: { identifier: patched } },
  };
}

const BEFORE_LOCK = lock(BEFORE);
const AFTER_LOCK = lock({ ...BEFORE, 'node_modules/libheif': { version: '1.2.5' } });
const baseConfig = { limits: { require_approval: true } };
const baseFindings = [finding('repo-a', [alert({ number: 1, package: 'libheif' })])];
const npmOk = async ({ manifest }) => ({ manifest, lockfile: AFTER_LOCK });

function baseGh(extra = {}) {
  return fakeGh({
    alerts: { 1: openAlert(1, 'libheif') },
    files: { 'package.json': manifest, 'package-lock.json': BEFORE_LOCK },
    ...extra,
  });
}

describe('applyLockfileUpdates', () => {
  it('refuses to run when require_approval is not set, without touching the API', async () => {
    const gh = baseGh();
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, { limits: {} }, { dryRun: false, runNpmUpdate: npmOk });
    assert.equal(r.status, 'refused');
    assert.equal(gh.writes.length, 0);
  });

  it('on the scheduled path runs only when apply-schedule allow-lists the tool', async () => {
    const gh = baseGh();
    const off = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, scheduled: true, runNpmUpdate: npmOk });
    assert.equal(off.status, 'skipped-unscheduled');
    // The skip carries a summary so the scheduled audit line can show it,
    // instead of the generic "nothing actionable" fallback.
    assert.deepEqual(off.summary, { status: 'skipped-unscheduled', created: 0, skipped: 0, errors: 0 });
    const on = await applyLockfileUpdates(gh, 'o', baseFindings, { ...baseConfig, 'apply-schedule': { 'lockfile-update': true } }, { dryRun: true, scheduled: true, runNpmUpdate: npmOk });
    assert.equal(on.status, 'dry-run');
  });

  it('dry-run runs the whole path (live alert read, file reads, npm, gate) and makes no writes', async () => {
    const gh = baseGh();
    let npmArgs = null;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async (a) => { npmArgs = a; return npmOk(a); } });
    assert.equal(r.status, 'dry-run');
    assert.deepEqual(npmArgs.packages, ['libheif']);
    assert.equal(npmArgs.manifest, manifest);
    assert.equal(r.results[0].status, 'would-open');
    assert.deepEqual(r.results[0].changes, [{ path: 'node_modules/libheif', name: 'libheif', from: '1.2.0', to: '1.2.5', kind: 'version' }]);
    assert.equal(gh.writes.length, 0);
    assert.equal(gh.puts.length, 0);
    assert.equal(r.summary.wouldOpen, 1);
  });

  it('drops an alert that is no longer open and skips the repo when none remain', async () => {
    const gh = baseGh({ alerts: { 1: { ...openAlert(1, 'libheif'), state: 'fixed' } } });
    let ran = false;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { ran = true; } });
    assert.equal(r.results[0].status, 'skipped');
    assert.equal(r.results[0].reason, 'no open alerts');
    assert.equal(ran, false);
  });

  it('drops an alert whose live package or ecosystem disagrees with the finding', async () => {
    const gh = baseGh({ alerts: { 1: openAlert(1, 'something-else') } });
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: npmOk });
    assert.equal(r.results[0].reason, 'no open alerts');
  });

  it('drops an alert whose live manifest path is missing rather than reading it as the root', async () => {
    const gh = baseGh({ alerts: { 1: openAlert(1, 'libheif', '1.2.3', null) } });
    let ran = false;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { ran = true; } });
    assert.equal(r.results[0].reason, 'no open alerts');
    assert.equal(ran, false);
  });

  it('drops an alert whose live manifest is a yarn or pnpm lockfile in the same directory', async () => {
    const gh = baseGh({ alerts: { 1: openAlert(1, 'libheif', '1.2.3', 'yarn.lock') } });
    let ran = false;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { ran = true; } });
    assert.equal(r.results[0].reason, 'no open alerts');
    assert.equal(ran, false);
  });

  it('drops an alert whose live manifest path moved to a different directory than the finding', async () => {
    const gh = baseGh({ alerts: { 1: openAlert(1, 'libheif', '1.2.3', 'docs/package-lock.json') } });
    let ran = false;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { ran = true; } });
    assert.equal(r.results[0].reason, 'no open alerts');
    assert.equal(ran, false);
  });

  it('reads both files at one resolved sha and branches from that same sha even if main moves meanwhile', async () => {
    const gh = baseGh({ headShas: ['abc123', 'def456'] });
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: false, runNpmUpdate: npmOk });
    assert.equal(r.results[0].status, 'created');
    assert.deepEqual(gh.reads.map(x => [x.path, x.ref]), [['package.json', 'abc123'], ['package-lock.json', 'abc123'], ['.npmrc', 'abc123']]);
    const ref = gh.writes.find(w => w.path.endsWith('/git/refs'));
    assert.equal(ref.body.sha, 'abc123');
  });

  it('screens before counting toward the cap, so a repo with an open PR does not starve the next one', async () => {
    const findings = ['a', 'b'].map(x => finding(`repo-${x}`, [alert({ number: 1, package: 'libheif' })]));
    const gh = baseGh({ prs: (head) => (head.includes('repo-a') ? [] : []) });
    // repo-a has an open PR on the tool branch; repo-b does not.
    gh.paginate = async (path) => (path.includes('/repo-a/') ? [{ number: 7, state: 'open' }] : []);
    const r = await applyLockfileUpdates(gh, 'o', findings, baseConfig, { dryRun: true, maxPerRun: 1, runNpmUpdate: npmOk });
    assert.deepEqual(r.results.map(x => [x.repo, x.status]), [['repo-a', 'skipped'], ['repo-b', 'would-open']]);
  });

  it('stops at the cap once that many targets have been processed past the screen', async () => {
    const findings = ['a', 'b', 'c'].map(x => finding(`repo-${x}`, [alert({ number: 1, package: 'libheif' })]));
    const gh = baseGh();
    const r = await applyLockfileUpdates(gh, 'o', findings, baseConfig, { dryRun: true, maxPerRun: 2, runNpmUpdate: npmOk });
    assert.deepEqual(r.results.map(x => x.repo), ['repo-a', 'repo-b']);
  });

  it('live: the composed title and body pass the safety validators, and a scoped package never puts an @ in the title', async () => {
    const findings = [finding('repo-a', [alert({ number: 1, package: '@img/sharp-linux-x64' })])];
    const scopedAfter = lock({ ...BEFORE, 'node_modules/@img/sharp-linux-x64': { version: '0.34.2' } });
    const gh = baseGh({ alerts: { 1: openAlert(1, '@img/sharp-linux-x64', '0.34.2') } });
    const r = await applyLockfileUpdates(gh, 'o', findings, baseConfig, { dryRun: false, runNpmUpdate: async ({ manifest }) => ({ manifest, lockfile: scopedAfter }) });
    assert.equal(r.results[0].status, 'created');
    const pr = gh.writes.find(w => w.path.endsWith('/pulls')).body;
    assert.doesNotMatch(pr.title, /@/);
    assert.match(pr.title, /img\/sharp-linux-x64/);
    assert.equal(validateIssueTitle(pr.title).valid, true);
    assert.equal(validateIssueBody(pr.body).valid, true);
  });

  it('reports an unreadable alert as an error, not a skip (fail closed on infrastructure)', async () => {
    const gh = baseGh({ fail: { alerts: true } });
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: npmOk });
    assert.equal(r.results[0].status, 'error');
    assert.equal(r.summary.errors, 1);
  });

  it('skips a repo whose lockfile is absent, and never runs npm on a partial view', async () => {
    const gh = baseGh({ files: { 'package.json': manifest } });
    let ran = false;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { ran = true; } });
    assert.equal(r.results[0].status, 'skipped');
    assert.match(r.results[0].reason, /unreadable/);
    assert.equal(ran, false);
  });

  it('treats a malformed Contents or blob response as an error, not as an absent file', async () => {
    const noSha = baseGh({ files: { 'package.json': manifest, 'package-lock.json': { content: '', encoding: 'none' } } });
    const r1 = await applyLockfileUpdates(noSha, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: npmOk });
    assert.equal(r1.results[0].status, 'error');

    const noBlob = baseGh({ files: { 'package.json': manifest, 'package-lock.json': { content: '', encoding: 'none', sha: 'bigsha' } } });
    noBlob.request = ((orig) => async (path, opts) => (path.includes('/git/blobs/') ? {} : orig(path, opts)))(noBlob.request);
    const r2 = await applyLockfileUpdates(noBlob, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: npmOk });
    assert.equal(r2.results[0].status, 'error');
  });

  it('skips a project that carries its own .npmrc, since the scratch run cannot honour it', async () => {
    const gh = baseGh({ files: { 'package.json': manifest, 'package-lock.json': BEFORE_LOCK, '.npmrc': 'legacy-peer-deps=true\n' } });
    let ran = false;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { ran = true; } });
    assert.equal(r.results[0].status, 'skipped');
    assert.equal(r.results[0].reason, 'npmrc-unsupported');
    assert.equal(ran, false);
  });

  it('live: falls back to a bounded title when the alert list would overflow the title limit', async () => {
    const names = Array.from({ length: 6 }, (_, i) => `a-rather-long-package-name-number-${i}`);
    const findings = [finding('repo-a', names.map((n, i) => alert({ number: 10 + i, package: n })))];
    const alerts = Object.fromEntries(names.map((n, i) => [10 + i, openAlert(10 + i, n, '1.0.1')]));
    const before = Object.fromEntries(names.map(n => [`node_modules/${n}`, { version: '1.0.0' }]));
    const after = Object.fromEntries(names.map(n => [`node_modules/${n}`, { version: '1.0.1' }]));
    const gh = baseGh({ alerts, files: { 'package.json': manifest, 'package-lock.json': lock(before) } });
    const r = await applyLockfileUpdates(gh, 'o', findings, baseConfig, { dryRun: false, runNpmUpdate: async ({ manifest: m }) => ({ manifest: m, lockfile: lock(after) }) });
    assert.equal(r.results[0].status, 'created');
    const pr = gh.writes.find(w => w.path.endsWith('/pulls')).body;
    assert.equal(pr.title, 'chore(deps): refresh lockfile for 6 Dependabot alerts');
    assert.equal(validateIssueTitle(pr.title).valid, true);
    assert.match(pr.body, /\| First patched \|/);
  });

  it('reads a lockfile over the Contents API 1 MB ceiling through the blob API', async () => {
    const gh = baseGh({
      files: {
        'package.json': manifest,
        'package-lock.json': { content: '', encoding: 'none', sha: 'bigsha', size: 2000000 },
        'blob:bigsha': BEFORE_LOCK,
      },
    });
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: npmOk });
    assert.equal(r.results[0].status, 'would-open');
  });

  it('skips a workspaces root before running npm', async () => {
    const ws = JSON.stringify({ name: 'x', workspaces: ['packages/*'] });
    const gh = baseGh({ files: { 'package.json': ws, 'package-lock.json': BEFORE_LOCK } });
    let ran = false;
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { ran = true; } });
    assert.equal(r.results[0].reason, 'gate:workspaces-unsupported');
    assert.equal(ran, false);
  });

  it('reports an npm failure as an error carrying the reason', async () => {
    const gh = baseGh();
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async () => { throw new Error('npm ERR! ERESOLVE unable to resolve'); } });
    assert.equal(r.results[0].status, 'error');
    assert.match(r.results[0].error, /ERESOLVE/);
  });

  it('records a gate refusal as a skip with the rule name', async () => {
    const gh = baseGh();
    const crossing = lock({ ...BEFORE, 'node_modules/libheif': { version: '2.0.0' } });
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: async ({ manifest }) => ({ manifest, lockfile: crossing }) });
    assert.equal(r.results[0].status, 'skipped');
    assert.equal(r.results[0].reason, 'gate:release-line-crossing');
  });

  it('skips a repo that already has an open PR on the tool branch', async () => {
    const gh = baseGh({ prs: [{ number: 7, state: 'open' }] });
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: true, runNpmUpdate: npmOk });
    assert.equal(r.results[0].reason, 'PR already open');
  });

  it('live: creates the branch, writes only the lockfile, opens a labelled PR with a deterministic body', async () => {
    const gh = baseGh();
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: false, runNpmUpdate: npmOk });
    assert.equal(r.status, 'completed');
    assert.equal(r.results[0].status, 'created');
    assert.equal(r.results[0].pr, 'https://github.com/o/r/pull/42');

    const ref = gh.writes.find(w => w.path.endsWith('/git/refs'));
    assert.deepEqual(ref.body, { ref: 'refs/heads/repo-butler/apply-lockfile-update', sha: 'abc123' });

    assert.equal(gh.puts.length, 1);
    assert.equal(gh.puts[0].filePath, 'package-lock.json');
    assert.equal(gh.puts[0].content, AFTER_LOCK);
    assert.equal(gh.puts[0].opts.branch, 'repo-butler/apply-lockfile-update');

    const pr = gh.writes.find(w => w.path.endsWith('/pulls'));
    assert.equal(pr.body.head, 'repo-butler/apply-lockfile-update');
    assert.equal(pr.body.base, 'main');
    assert.match(pr.body.title, /^chore\(deps\): refresh lockfile for libheif \(Dependabot alert #1\)$/);
    assert.match(pr.body.body, /node_modules\/libheif.*1\.2\.0.*1\.2\.5/);
    assert.match(pr.body.body, /Opened automatically by \[Repo Butler\]/);
    // No bare @-mention: safety.js's validateMentions matches `@` only after
    // whitespace/start, so a scoped name must appear inside a code span.
    assert.doesNotMatch(pr.body.body, /(?<!\S)@/);
  });

  it('live: a scoped package in the family renders inside a code span, never as a bare mention', async () => {
    const scopedAfter = lock({
      ...BEFORE,
      'node_modules/libheif': { version: '1.2.5', dependencies: { '@img/sharp-linux-x64': '0.34.2' } },
      'node_modules/@img/sharp-linux-x64': { version: '0.34.2' },
    });
    const gh = baseGh();
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: false, runNpmUpdate: async ({ manifest }) => ({ manifest, lockfile: scopedAfter }) });
    assert.equal(r.results[0].status, 'created');
    const body = gh.writes.find(w => w.path.endsWith('/pulls')).body.body;
    assert.match(body, /`node_modules\/@img\/sharp-linux-x64`/);
    assert.doesNotMatch(body, /(?<!\S)@/);

    const label = gh.writes.find(w => w.path.endsWith('/labels'));
    assert.deepEqual(label.body, { labels: ['governance-apply'] });
  });

  it('live: force-updates the branch when the ref already exists', async () => {
    const gh = baseGh({ fail: { refExists: true } });
    const r = await applyLockfileUpdates(gh, 'o', baseFindings, baseConfig, { dryRun: false, runNpmUpdate: npmOk });
    assert.equal(r.results[0].status, 'created');
    const patch = gh.writes.find(w => w.method === 'PATCH');
    assert.deepEqual(patch.body, { sha: 'abc123', force: true });
  });

  it('handles a non-root directory: reads and writes under it and uses a per-directory branch', async () => {
    const findings = [finding('repo-a', [alert({ number: 3, package: 'libheif', manifestPath: 'docs/site/package-lock.json' })])];
    const gh = baseGh({
      alerts: { 3: openAlert(3, 'libheif', '1.2.3', 'docs/site/package-lock.json') },
      files: { 'docs/site/package.json': manifest, 'docs/site/package-lock.json': BEFORE_LOCK },
    });
    const r = await applyLockfileUpdates(gh, 'o', findings, baseConfig, { dryRun: false, runNpmUpdate: npmOk });
    assert.equal(r.results[0].status, 'created');
    assert.equal(gh.puts[0].filePath, 'docs/site/package-lock.json');
    assert.match(gh.puts[0].opts.branch, /^repo-butler\/apply-lockfile-update-docs-site-[0-9a-f]{8}$/);
    assert.equal(gh.puts[0].opts.branch, `repo-butler/apply-${toolNameFor('docs/site')}`);
  });

});
