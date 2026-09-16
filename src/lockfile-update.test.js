import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectLockfileUpdateTargets,
  diffLockfilePackages,
  familyOf,
  computeLockfileGate,
  applyLockfileUpdates,
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

// --- applyLockfileUpdates ----------------------------------------------------

const b64 = (s) => Buffer.from(s).toString('base64');

// A fake GitHub client with a route table. `writes` collects every non-GET
// request so a dry-run can be proven inert; `puts` collects putFile calls.
function fakeGh({ alerts = {}, files = {}, prs = [], writes = [], puts = [], fail = {} } = {}) {
  return {
    writes,
    puts,
    request: async (path, opts) => {
      const method = opts?.method ?? 'GET';
      if (method !== 'GET') {
        writes.push({ path, method, body: opts?.body });
        if (path.endsWith('/git/refs') && fail.refExists) throw new Error('GitHub API error: 422 Reference already exists');
        if (path.endsWith('/pulls')) return { number: 42, html_url: 'https://github.com/o/r/pull/42' };
        return {};
      }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' };
      if (path.endsWith('/git/ref/heads/main')) return { object: { sha: 'abc123' } };
      let m = path.match(/\/dependabot\/alerts\/(\d+)$/);
      if (m) {
        if (fail.alerts) throw new Error('GitHub API error: 500 boom');
        const a = alerts[m[1]];
        if (!a) throw new Error('GitHub API error: 404 Not Found');
        return a;
      }
      m = path.match(/\/contents\/(.+)$/);
      if (m) {
        const f = files[m[1]];
        if (f === undefined) throw new Error('GitHub API error: 404 Not Found');
        if (typeof f === 'object') return f; // caller-shaped response (e.g. the >1 MB form)
        return { content: b64(f), encoding: 'base64', sha: 'filesha' };
      }
      m = path.match(/\/git\/blobs\/(.+)$/);
      if (m) return { content: b64(files[`blob:${m[1]}`]), encoding: 'base64' };
      throw new Error(`unexpected GET ${path}`);
    },
    paginate: async () => prs,
    putFile: async (owner, repo, filePath, content, opts) => { puts.push({ repo, filePath, content, opts }); },
  };
}

function openAlert(number, name, patched = '1.2.3') {
  return {
    number,
    state: 'open',
    dependency: { package: { ecosystem: 'npm', name } },
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
    assert.deepEqual(r.results[0].changes, [{ path: 'node_modules/libheif', name: 'libheif', from: '1.2.0', to: '1.2.5' }]);
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
      alerts: { 3: openAlert(3, 'libheif') },
      files: { 'docs/site/package.json': manifest, 'docs/site/package-lock.json': BEFORE_LOCK },
    });
    const r = await applyLockfileUpdates(gh, 'o', findings, baseConfig, { dryRun: false, runNpmUpdate: npmOk });
    assert.equal(r.results[0].status, 'created');
    assert.equal(gh.puts[0].filePath, 'docs/site/package-lock.json');
    assert.equal(gh.puts[0].opts.branch, 'repo-butler/apply-lockfile-update-docs-site');
  });

  it('caps targets per run and runs them one at a time', async () => {
    const findings = ['a', 'b', 'c'].map(x => finding(`repo-${x}`, [alert({ number: 1, package: 'libheif' })]));
    const gh = baseGh();
    const r = await applyLockfileUpdates(gh, 'o', findings, baseConfig, { dryRun: true, maxPerRun: 2, runNpmUpdate: npmOk });
    assert.equal(r.results.length, 2);
  });
});
