// The trimmer (G6) — deterministic transitive-vulnerability remediation.
//
// Given a parsed npm lockfile, a manifest, and an alert naming a patched
// version, decide whether a PARENT-SCOPED `overrides` entry would clear the
// alert — and refuse, with a reason, whenever it would not. Pure: no network, no
// GitHub client, no LLM. The apply-side write path consumes this decision behind
// the ADR-005 gate stack; see docs/decisions/013-content-transformation-writes.md.
//
// SCOPE. This is deliberately much narrower than "fix transitive vulns".
// Reviewing ~23 real advisories across this portfolio showed that Dependabot was
// STALLED, not incapable: once a push forced a rescan it fixed nearly all of
// them itself. Only two needed a hand-written override, and both shared one
// shape — a caret on a 0.x version is minor-locked, so `^0.34.5` means
// `>=0.34.5 <0.35.0` and cannot reach a 0.35.x patch however the lockfile is
// refreshed. Everything else was reachable by `npm update --package-lock-only`.
// So `reachable-by-update` is a refusal, not a fallback: writing an override for
// a case a refresh already fixes leaves permanent manifest cruft behind.
//
// REFUSALS ARE THE SPECIFICATION. Each one below is drawn from a real case that
// would have broken a naive implementation, and refusing is a success, not a
// failure to try harder.

const ZERO = 0;

// --- semver, the narrow subset this needs ---
//
// Zero runtime dependencies is a project invariant, so rather than pull in
// `semver` the trimmer carries only what it needs: does a concrete version
// satisfy a declared range? Anything it cannot parse is NOT satisfied, so an
// unrecognised range can never be read as "already covered" and silently
// suppress a needed fix.

function parseVersion(v) {
  const m = String(v ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function cmp(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Does `version` satisfy `range`? Supports the operators that actually appear in
 * npm manifests: caret, tilde, exact pins, and simple >= bounds.
 *
 * The caret rule is the one that matters most here and is the easiest to get
 * wrong: for a 1.x+ version `^1.2.3` floats the minor, but for `0.x` it is
 * MINOR-LOCKED (`^0.34.5` admits only `0.34.x`) and for `0.0.x` it is
 * patch-locked. Treating a 0.x caret like a 1.x caret would make the trimmer
 * believe a patch is already reachable when it is not — and it would then
 * decline the exact fix it exists to produce.
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  const raw = String(range ?? '').trim();
  if (!raw) return false;

  if (raw.startsWith('^')) {
    const base = parseVersion(raw.slice(1));
    if (!base) return false;
    if (cmp(v, base) < ZERO) return false;
    if (base.major > ZERO) return v.major === base.major;
    if (base.minor > ZERO) return v.major === ZERO && v.minor === base.minor;
    return v.major === ZERO && v.minor === ZERO;
  }

  if (raw.startsWith('~')) {
    const base = parseVersion(raw.slice(1));
    if (!base) return false;
    return cmp(v, base) >= ZERO && v.major === base.major && v.minor === base.minor;
  }

  if (raw.startsWith('>=')) {
    const base = parseVersion(raw.slice(2));
    return base ? cmp(v, base) >= ZERO : false;
  }

  // Only treat it as an exact pin if the range is JUST a version — `1.2.3 || 2.x`
  // and other disjunctions are not understood, and must fail closed.
  const exact = parseVersion(raw);
  if (exact && /^v?\d+\.\d+\.\d+[\w.+-]*$/.test(raw)) return cmp(v, exact) === ZERO;

  return false;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Every package in the tree that declares a dependency on `name`, with the range
 * it declares. Reads a lockfileVersion 2/3 `packages` map, whose keys are
 * install paths (`''` is the root manifest, reported as `<root>`).
 *
 * optionalDependencies is included deliberately: the real sharp/next case — the
 * one shape this module exists for — arrives that way, and a walker reading only
 * `dependencies` would find no parent and refuse it.
 */
export function findParents(lock, name) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') return [];

  const parents = [];
  for (const [path, meta] of Object.entries(packages)) {
    for (const field of DEP_FIELDS) {
      const range = meta?.[field]?.[name];
      if (typeof range !== 'string') continue;
      parents.push({
        parent: path === '' ? '<root>' : path.split('node_modules/').pop(),
        path,
        field,
        range,
      });
    }
  }
  return parents;
}

// A package the root manifest itself depends on. An override duplicating a
// direct dependency is not merely redundant: it makes Dependabot's own updater
// error and retry (observed six times in 25 minutes per scheduled run on
// bonnie-wee-plot), so a generator without this check would manufacture that bug
// across the portfolio.
function directRange(manifest, name) {
  for (const field of DEP_FIELDS) {
    const range = manifest?.[field]?.[name];
    if (typeof range === 'string') return range;
  }
  return null;
}

/**
 * Decide the remediation for one alert.
 *
 * @param {object} input
 * @param {object} input.lock — parsed package-lock.json (v2/v3)
 * @param {object} input.manifest — parsed package.json for the target manifest
 * @param {object} input.alert — `{ package, patchedVersion, manifestPath? }`
 * @param {boolean} [input.pnpmAutoInstalledPeer] — the target is a pnpm repo and
 *   the vulnerable package is an auto-installed peer.
 * @returns {{action:'override', ...}|{action:'refuse', reason:string, detail:string}}
 */
export function planOverride({ lock, manifest, alert, pnpmAutoInstalledPeer = false } = {}) {
  const name = alert?.package;
  const patched = alert?.patchedVersion;
  const manifestPath = alert?.manifestPath || 'package.json';

  const refuse = (reason, detail) => ({ action: 'refuse', reason, detail, package: name, manifestPath });

  if (!name) return refuse('no-package', 'the alert names no package');

  // No published fix means there is nothing to point an override at. Refusing is
  // the only honest answer; inventing a version would pin to something that does
  // not exist.
  if (!patched || !parseVersion(patched)) {
    return refuse('no-patched-version', `no published patched version for ${name}`);
  }

  // pnpm overrides do not reach auto-installed peers, so an override written
  // here would look correct in the diff and change nothing in the tree.
  if (pnpmAutoInstalledPeer) {
    return refuse('pnpm-auto-installed-peer',
      `${name} is an auto-installed peer under pnpm, which overrides do not reach`);
  }

  // A direct dependency is the maintainer's own declared range. Bumping that is
  // an ordinary dependency update, not an override — and duplicating it in
  // `overrides` is the bonnie-wee-plot failure mode above.
  const direct = directRange(manifest, name);
  if (direct) {
    return refuse('direct-dependency',
      `${name} is a direct dependency at ${direct}; bump the dependency rather than overriding it`);
  }

  const parents = findParents(lock, name).filter(p => p.parent !== '<root>');
  if (parents.length === ZERO) {
    return refuse('parent-undeterminable',
      `no parent in the lockfile declares a dependency on ${name}`);
  }

  // If every parent's declared range already admits the patched version, the
  // lockfile is simply stale and `npm update --package-lock-only` reaches it. An
  // override would be permanent manifest cruft for a transient problem.
  if (parents.every(p => satisfiesRange(patched, p.range))) {
    return refuse('reachable-by-update',
      `every parent range already admits ${name}@${patched}; refresh the lockfile instead`);
  }

  // Parents that cannot reach the patch are the ones needing a scoped override.
  const capped = parents.filter(p => !satisfiesRange(patched, p.range));

  // An override may widen a range WITHIN a major line; it must never drag a
  // parent across one. The yourear/brace-expansion case is exactly this: one
  // parent declares ^1.1.11 while the patch lives at 2.0.2, so "fixing" it would
  // force a major bump the parent never declared and could break at runtime —
  // the vulnerable 1.x line needs its own 1.x patch, which is a different fix.
  // Checking only how MANY parents are capped misses this entirely.
  const patchedMajor = parseVersion(patched).major;
  const crossMajor = capped.filter(p => {
    const base = parseVersion(p.range.replace(/^[\^~]|^>=/, ''));
    return !base || base.major !== patchedMajor;
  });
  if (crossMajor.length > ZERO) {
    const shown = crossMajor.map(p => `${p.parent}@${p.range}`).join(', ');
    return refuse('disjoint-ranges',
      `${name}@${patched} sits outside the major line declared by ${shown}; an override would force a major bump`);
  }

  // More than one distinct capped parent means more than one scope to write, and
  // picking one would be a guess about which subtree matters.
  const distinct = [...new Set(capped.map(p => p.parent))];
  if (distinct.length > 1) {
    return refuse('disjoint-ranges',
      `${name} is capped by ${distinct.length} parents (${distinct.join(', ')}) with no single satisfying version`);
  }

  const parent = distinct[0];
  // Caret on the patched version: the minimum widening that clears the alert
  // while still allowing ordinary patch updates. This matches the in-house
  // recipe already applied by hand across four repos — matching the established
  // recipe matters more than inventing a tighter one.
  const value = `^${patched}`;

  // Merge without disturbing anything else. Only the alert subject's parent key
  // may change; every other override is carried through byte-identical.
  const merged = { ...(manifest?.overrides || {}) };
  const existingParentScope = merged[parent];
  merged[parent] = (existingParentScope && typeof existingParentScope === 'object')
    ? { ...existingParentScope, [name]: value }
    : { [name]: value };

  return {
    action: 'override',
    package: name,
    parent,
    manifestPath,
    // The scoped fragment on its own, for logging and PR bodies.
    overrides: { [parent]: { [name]: value } },
    // The full `overrides` block to write back into the manifest.
    merged,
  };
}
