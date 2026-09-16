import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectLockfileUpdateTargets,
  diffLockfilePackages,
  familyOf,
  computeLockfileGate,
} from './lockfile-update.js';

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
// `node_modules/*` entries and their declared `dependencies`.
function lock(packages, extra = {}) {
  return JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { sharp: '^0.34.0' } },
      ...packages,
    },
    ...extra,
  });
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
        alert({ number: 2, package: 'js-yaml', manifestPath: '/package-lock.json' }),
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

  it('caps the number of targets per run and tolerates a non-array input', () => {
    const findings = ['a', 'b', 'c'].map(r => finding(`repo-${r}`, [alert()]));
    assert.equal(selectLockfileUpdateTargets(findings, 2).length, 2);
    assert.equal(selectLockfileUpdateTargets(findings, 'nope').length, 3);
    assert.deepEqual(selectLockfileUpdateTargets(undefined), []);
  });

  it('drops an alert with no package name or no number rather than emitting a half target', () => {
    const findings = [finding('repo-a', [alert({ package: '' }), alert({ number: undefined }), alert({ number: 9, package: 'ok' })])];
    assert.deepEqual(selectLockfileUpdateTargets(findings)[0].alerts, [{ number: 9, package: 'ok' }]);
  });
});

// --- diffLockfilePackages ---------------------------------------------------

describe('diffLockfilePackages', () => {
  it('reports version changes, additions and removals with the package name derived from the path', () => {
    const before = { packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/@s/b': { version: '2.0.0' }, 'node_modules/a/node_modules/c': { version: '1.0.0' } } };
    const after = { packages: { '': {}, 'node_modules/a': { version: '1.0.1' }, 'node_modules/@s/b': { version: '2.0.0' }, 'node_modules/d': { version: '0.1.0' } } };
    assert.deepEqual(diffLockfilePackages(before, after), [
      { path: 'node_modules/a', name: 'a', from: '1.0.0', to: '1.0.1' },
      { path: 'node_modules/a/node_modules/c', name: 'c', from: '1.0.0', to: null },
      { path: 'node_modules/d', name: 'd', from: null, to: '0.1.0' },
    ]);
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
    assert.deepEqual(r.changes, [{ path: 'node_modules/libheif', name: 'libheif', from: '1.2.0', to: '1.2.5' }]);
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
});
