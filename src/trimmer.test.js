import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfiesRange, findParents, planOverride } from './trimmer.js';

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'npm-lock-subgraph.json'), 'utf8',
));

// --- semver subset ---
//
// Zero dependencies is a project invariant, so the trimmer carries the narrow
// range logic it needs rather than pulling in `semver`.

describe('trimmer range satisfaction', () => {
  it('trimmer: caret on a 1.x+ version allows minor and patch moves', () => {
    assert.equal(satisfiesRange('8.5.23', '^8.5.16'), true);
    assert.equal(satisfiesRange('8.9.0', '^8.5.16'), true);
    assert.equal(satisfiesRange('9.0.0', '^8.5.16'), false);
    assert.equal(satisfiesRange('8.5.0', '^8.5.16'), false);
  });

  it('trimmer: caret on a 0.x version is MINOR-LOCKED, not minor-permissive', () => {
    // A real diagnosis trap: ^0.1.2 permits 0.1.x only, NOT 0.2.0. Treating 0.x
    // carets like 1.x carets makes the trimmer believe a patched version is
    // already reachable when it is not, and it would then decline a fix that is
    // genuinely needed.
    assert.equal(satisfiesRange('0.1.9', '^0.1.2'), true);
    assert.equal(satisfiesRange('0.2.0', '^0.1.2'), false);
    // ^0.0.x is locked tighter still — patch only.
    assert.equal(satisfiesRange('0.0.5', '^0.0.3'), true);
    assert.equal(satisfiesRange('0.1.0', '^0.0.3'), false);
  });

  it('trimmer: tilde allows patch moves only', () => {
    assert.equal(satisfiesRange('8.5.99', '~8.5.16'), true);
    assert.equal(satisfiesRange('8.6.0', '~8.5.16'), false);
  });

  it('trimmer: an exact pin matches only itself', () => {
    assert.equal(satisfiesRange('8.4.31', '8.4.31'), true);
    assert.equal(satisfiesRange('8.4.32', '8.4.31'), false);
  });

  it('trimmer: an unparseable range is never treated as satisfied', () => {
    // Fail closed: an unrecognised range (a git URL, a tag, a complex
    // disjunction) must not read as "already covered", which would silently
    // suppress a needed fix.
    assert.equal(satisfiesRange('1.0.0', 'github:foo/bar'), false);
    assert.equal(satisfiesRange('1.0.0', 'latest'), false);
    assert.equal(satisfiesRange('1.0.0', ''), false);
  });
});

// --- parent scope computation ---

describe('trimmer parent resolution', () => {
  it('trimmer: finds every parent that requires a package, from the real lockfile', () => {
    const parents = findParents(FIXTURE, 'postcss');
    const names = parents.map(p => p.parent).sort();

    assert.ok(names.includes('<root>'), 'the root manifest is itself a parent');
    assert.ok(names.includes('next'));
    assert.ok(names.includes('vite'));
    assert.equal(parents.find(p => p.parent === 'next').range, '8.4.31',
      'reads the exact range the parent declares, not the installed version');
  });

  it('trimmer: resolves a purely transitive package to its single parent', () => {
    const parents = findParents(FIXTURE, '@adobe/css-tools');

    assert.equal(parents.length, 1);
    assert.equal(parents[0].parent, '@testing-library/jest-dom');
    assert.equal(parents[0].range, '^4.4.0');
  });

  it('trimmer: finds a parent that declares the package as an OPTIONAL dependency', () => {
    // The real sharp/next case arrives via optionalDependencies. A walker that
    // only reads `dependencies` would find no parent and refuse the one shape
    // G6 exists to fix.
    const parents = findParents(FIXTURE, 'sharp');

    assert.equal(parents.length, 1);
    assert.equal(parents[0].parent, 'next');
    assert.equal(parents[0].range, '^0.34.5');
    assert.equal(parents[0].field, 'optionalDependencies');
  });

  it('trimmer: returns no parents for a package absent from the tree', () => {
    assert.deepEqual(findParents(FIXTURE, 'not-installed-anywhere'), []);
  });
});

// --- the plan's refusal conditions, each mapped to a real case ---

describe('trimmer refusal conditions', () => {
  it('trimmer: refuses when the package is a DIRECT dependency at a compatible range', () => {
    // bonnie-wee-plot/postcss. The root declares postcss ^8.5.18 as a direct
    // devDependency, so a parent-scoped override would duplicate a direct dep —
    // and the existing top-level override there is load-bearing. Writing another
    // is at best redundant and at worst fights the manifest.
    const manifest = {
      devDependencies: { postcss: '^8.5.18' },
      overrides: { postcss: '^8.5.18' },
    };
    const plan = planOverride({
      lock: FIXTURE, manifest,
      alert: { package: 'postcss', patchedVersion: '8.5.23' },
    });

    assert.equal(plan.action, 'refuse');
    assert.equal(plan.reason, 'direct-dependency');
  });

  it('trimmer: refuses when parents need disjoint ranges no single version satisfies', () => {
    // yourear/brace-expansion. Two parents pin ranges with no overlap, so there
    // is no one version to scope to and the fix cannot be expressed as a single
    // override without breaking one of them.
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' } },
        'node_modules/pkg-a': { version: '1.0.0', dependencies: { 'brace-expansion': '^1.1.11' } },
        'node_modules/pkg-b': { version: '1.0.0', dependencies: { 'brace-expansion': '^2.0.1' } },
        'node_modules/brace-expansion': { version: '1.1.11' },
      },
    };
    const plan = planOverride({
      lock, manifest: {},
      alert: { package: 'brace-expansion', patchedVersion: '2.0.2' },
    });

    assert.equal(plan.action, 'refuse');
    assert.equal(plan.reason, 'disjoint-ranges');
  });

  it('trimmer: refuses on a pnpm repo where the vulnerable package is an auto-installed peer', () => {
    // pnpm overrides do not reach auto-installed peers, so an override written
    // here would look correct and change nothing.
    const plan = planOverride({
      lock: { lockfileVersion: 3, packages: {} },
      manifest: { packageManager: 'pnpm@9.0.0' },
      alert: { package: 'some-peer', patchedVersion: '2.0.0' },
      pnpmAutoInstalledPeer: true,
    });

    assert.equal(plan.action, 'refuse');
    assert.equal(plan.reason, 'pnpm-auto-installed-peer');
  });

  it('trimmer: refuses rather than guessing when no parent can be determined', () => {
    const plan = planOverride({
      lock: FIXTURE, manifest: {},
      alert: { package: 'ghost-package', patchedVersion: '1.0.0' },
    });

    assert.equal(plan.action, 'refuse');
    assert.equal(plan.reason, 'parent-undeterminable');
  });

  it('trimmer: refuses when the advisory names no published patched version', () => {
    const plan = planOverride({
      lock: FIXTURE, manifest: {},
      alert: { package: '@adobe/css-tools', patchedVersion: null },
    });

    assert.equal(plan.action, 'refuse');
    assert.equal(plan.reason, 'no-patched-version');
  });
});

// --- scope: only the 0.x-capped case warrants an override ---
//
// The plan's own later review rescoped G6 hard: of ~23 real advisories, only two
// genuinely needed a parent-scoped override, and both shared one shape — a caret
// on a 0.x version is minor-locked, so ^0.34.5 means >=0.34.5 <0.35.0 and cannot
// reach a 0.35.x patch however the lockfile is refreshed. "Everything else was
// reachable by `npm update --package-lock-only`." Writing overrides for those
// would add permanent manifest cruft to fix something a refresh already fixes.

describe('trimmer scope', () => {
  it('trimmer: refuses when the parent range already admits the patch', () => {
    // @adobe/css-tools under ^4.4.0 with a 4.4.5 patch: a plain lockfile
    // refresh reaches it, so an override is unnecessary noise.
    const plan = planOverride({
      lock: FIXTURE, manifest: {},
      alert: { package: '@adobe/css-tools', patchedVersion: '4.4.5' },
    });

    assert.equal(plan.action, 'refuse');
    assert.equal(plan.reason, 'reachable-by-update');
  });
});

describe('trimmer override synthesis', () => {
  it('trimmer: reproduces the hand-written sharp/next fix from the real lockfile', () => {
    // The one shape G6 is scoped to, and a genuine regression test: the
    // maintainer already solved this by hand as {"next": {"sharp": "^0.35.0"}}.
    // The trimmer must derive the identical fix from the lockfile alone.
    const plan = planOverride({
      lock: FIXTURE, manifest: {},
      alert: { package: 'sharp', patchedVersion: '0.35.0' },
    });

    assert.equal(plan.action, 'override');
    // Parent-scoped nested form. A bare {"sharp": "..."} would apply to the
    // whole tree — the blanket override the plan forbids.
    assert.deepEqual(plan.overrides, { next: { sharp: '^0.35.0' } });
    assert.equal(plan.package, 'sharp');
    assert.equal(plan.parent, 'next');
  });

  it('trimmer: merges into existing overrides without touching unrelated entries', () => {
    const manifest = { overrides: { rollup: '^4.59.0', minimatch: '^10.2.5' } };
    const plan = planOverride({
      lock: FIXTURE, manifest,
      alert: { package: 'sharp', patchedVersion: '0.35.0' },
    });

    assert.equal(plan.action, 'override');
    assert.equal(plan.merged.rollup, '^4.59.0', 'unrelated override preserved verbatim');
    assert.equal(plan.merged.minimatch, '^10.2.5', 'unrelated override preserved verbatim');
    assert.deepEqual(plan.merged.next, { sharp: '^0.35.0' });
  });

  it('trimmer: never widens a package that is not the subject of the alert', () => {
    const manifest = { overrides: { rollup: '^4.0.0' } };
    const plan = planOverride({
      lock: FIXTURE, manifest,
      alert: { package: 'sharp', patchedVersion: '0.35.0' },
    });

    const touched = Object.keys(plan.merged).filter(k => manifest.overrides[k] !== plan.merged[k]);
    assert.deepEqual(touched, ['next'],
      'exactly one entry may change, and it must be the alert subject\'s parent');
  });

  it('trimmer: scopes the fix to the manifest the alert names, not a repo-wide assumption', () => {
    // teams-for-linux carries alerts against two manifests (package-lock.json
    // and docs-site/package-lock.json), so "the repo's package.json" is not
    // well defined and assuming a single root would write into the wrong file.
    const plan = planOverride({
      lock: FIXTURE, manifest: {},
      alert: { package: 'sharp', patchedVersion: '0.35.0', manifestPath: 'docs-site/package.json' },
    });

    assert.equal(plan.action, 'override');
    assert.equal(plan.manifestPath, 'docs-site/package.json');
  });

  it('trimmer: defaults to the root manifest when the alert names none', () => {
    const plan = planOverride({
      lock: FIXTURE, manifest: {},
      alert: { package: 'sharp', patchedVersion: '0.35.0' },
    });

    assert.equal(plan.manifestPath, 'package.json');
  });
});
