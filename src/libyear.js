// Libyear dependency freshness computation.
// Computes cumulative age (in years) of a repo's dependencies versus their
// latest published versions. Supports the npm, PyPI, and crates.io registries,
// keyed off the SBOM purl prefix; other ecosystems are skipped.

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const DEFAULT_PER_FETCH_TIMEOUT_MS = 5000;

// crates.io's crawler policy requires an identifying User-Agent; the other
// registries don't care, so one honest value is sent everywhere.
const USER_AGENT = 'repo-butler (+https://github.com/IsmaelMartinez/repo-butler)';

// One adapter per supported registry: build the metadata URL for a package and
// extract { currentIso, latestVersion, latestIso } from the response body.
// Extractors return null (never throw) on missing data — a dep that can't be
// dated is skipped, matching the historical npm-only behaviour.
const REGISTRIES = {
  npm: {
    url: (name) => {
      // npm expects scoped packages as `@scope/name` (literal `@` and `/`).
      // Encode each path segment so other unsafe characters are escaped
      // without relying on a post-hoc string replacement.
      const encoded = name.startsWith('@')
        ? `@${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
        : encodeURIComponent(name);
      return `https://registry.npmjs.org/${encoded}`;
    },
    extract: (data, currentVersion) => {
      const time = data.time;
      const latestVersion = data['dist-tags']?.latest;
      if (!time || !latestVersion) return null;
      return { currentIso: time[currentVersion], latestVersion, latestIso: time[latestVersion] };
    },
  },
  pypi: {
    url: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    extract: (data, currentVersion) => {
      const releases = data.releases;
      const latestVersion = data.info?.version;
      if (!releases || !latestVersion) return null;
      // A release maps to its uploaded files; the first file's upload time
      // dates the version. Releases with no files can't be dated.
      const uploadedAt = (v) => releases[v]?.[0]?.upload_time_iso_8601 || releases[v]?.[0]?.upload_time;
      return { currentIso: uploadedAt(currentVersion), latestVersion, latestIso: uploadedAt(latestVersion) };
    },
  },
  cargo: {
    url: (name) => `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
    extract: (data, currentVersion) => {
      const versions = data.versions;
      const latestVersion = data.crate?.max_stable_version || data.crate?.newest_version;
      if (!Array.isArray(versions) || !latestVersion) return null;
      const createdAt = (v) => versions.find(e => e.num === v)?.created_at;
      return { currentIso: createdAt(currentVersion), latestVersion, latestIso: createdAt(latestVersion) };
    },
  },
};

/**
 * Extract package name, version, and registry from SBOM dependency data.
 * Filters to ecosystems with a registry adapter using the purl field. The
 * REGISTRIES keys are purl types, so adding an adapter is the only step
 * needed to support a new ecosystem here.
 */
export function filterSupportedDeps(sbomPackages) {
  if (!sbomPackages || sbomPackages.length === 0) return [];
  const deps = [];
  for (const p of sbomPackages) {
    // purl format: pkg:<type>/name@version, or for npm scoped packages
    // pkg:npm/@scope/name@version (the scope's `@` may be literal or %40).
    if (!p.purl || !p.version || !p.purl.startsWith('pkg:')) continue;
    const slash = p.purl.indexOf('/');
    if (slash < 0) continue;
    const registry = p.purl.slice('pkg:'.length, slash);
    if (!Object.hasOwn(REGISTRIES, registry)) continue;
    const withoutPrefix = p.purl.slice(slash + 1);
    const atIdx = withoutPrefix.startsWith('@')
      ? withoutPrefix.indexOf('@', 1)
      : withoutPrefix.indexOf('@');
    let name;
    try {
      name = decodeURIComponent(atIdx >= 0 ? withoutPrefix.slice(0, atIdx) : withoutPrefix);
    } catch {
      // Malformed percent-encoding in external SBOM data (URIError) — skip
      // this dep rather than failing the whole set.
      continue;
    }
    deps.push({ registry, name, currentVersion: p.version });
  }
  return deps;
}

/**
 * Fetch publish date for a specific version and the latest version from the
 * package's registry. Owns a per-fetch AbortController so a slow registry call
 * self-terminates after perFetchTimeoutMs without affecting sibling fetches —
 * replaces the legacy cascading-abort design (issue #218/#220) that drained
 * the event loop mid-phase when its outer timeout fired across many in-flight
 * fetches simultaneously.
 * Returns { currentDate, latestVersion, latestDate } or null on failure.
 */
async function fetchVersionDates(registry, packageName, currentVersion, perFetchTimeoutMs = DEFAULT_PER_FETCH_TIMEOUT_MS) {
  const adapter = REGISTRIES[registry];
  if (!adapter) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), perFetchTimeoutMs);
  try {
    const resp = await fetch(adapter.url(packageName), {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!resp.ok) {
      // Throttling or a policy denial would otherwise silently deflate the
      // metric (crates.io in particular caps request rates and enforces a
      // User-Agent policy); 404s stay quiet as before. Label by status — a
      // 403 is a refusal, not necessarily throttling.
      if (resp.status === 429 || resp.status === 403) {
        const reason = resp.status === 429 ? 'rate-limited' : 'refused (HTTP 403)';
        console.warn(`[libyear] ${registry} ${reason} the lookup for '${packageName}' — dep skipped`);
      }
      return null;
    }
    const data = await resp.json();

    const extracted = adapter.extract(data, currentVersion);
    if (!extracted || !extracted.currentIso || !extracted.latestIso) return null;

    const currentDate = new Date(extracted.currentIso);
    const latestDate = new Date(extracted.latestIso);
    // Guard parseability, not just presence — an Invalid Date is truthy and
    // would propagate NaN through computeDepAge into total_libyear.
    if (Number.isNaN(currentDate.getTime()) || Number.isNaN(latestDate.getTime())) return null;

    return { currentDate, latestVersion: extracted.latestVersion, latestDate };
  } catch (error) {
    console.warn(`[libyear] Failed to fetch version dates for '${packageName}' (${registry}):`, error.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the libyear age for a single dependency given pre-fetched dates.
 * Exported for testing with mock data.
 */
export function computeDepAge(currentDate, latestDate) {
  const diff = latestDate.getTime() - currentDate.getTime();
  return Math.max(0, diff / MS_PER_YEAR);
}

/**
 * Aggregate resolved dependency results into a libyear summary.
 * Exported for direct unit testing.
 */
export function aggregateLibyear(resolved) {
  if (!resolved || resolved.length === 0) return null;
  const totalLibyear = resolved.reduce((sum, d) => sum + d.years, 0);
  const oldest = resolved.reduce((max, d) => (d.years > max.years ? d : max), resolved[0]);
  return {
    total_libyear: Math.round(totalLibyear * 100) / 100,
    dependency_count: resolved.length,
    deps: resolved,
    oldest: { name: oldest.name, current: oldest.current, latest: oldest.latest, years: oldest.years },
  };
}

/**
 * Compute the total libyear metric for a set of SBOM dependencies.
 * Queries each dependency's registry (npm, PyPI, or crates.io) to find the
 * age gap between the current and latest versions. Each fetch self-terminates
 * after perFetchTimeoutMs.
 *
 * The optional loopBreakSignal is checked between batches only — it is NOT
 * threaded into fetch(), so aborting it cannot trigger the undici cascade
 * that issue #218/#220 fixed. Its sole purpose is to let the outer
 * wall-clock budget skip remaining batches when it expires, preventing the
 * orphan-background-fetches concern Gemini flagged on PR #221.
 *
 * Returns { total_libyear, dependency_count, deps, oldest } or null on complete failure.
 * Each dep in deps: { name, current, latest, years }.
 */
export async function computeLibyear(sbomPackages, perFetchTimeoutMs, loopBreakSignal) {
  const deps = filterSupportedDeps(sbomPackages);
  if (deps.length === 0) return null;

  // Batch in groups of 5 to avoid hammering the registries.
  const results = [];
  const BATCH_SIZE = 5;
  for (let i = 0; i < deps.length; i += BATCH_SIZE) {
    if (loopBreakSignal?.aborted) break;
    const batch = deps.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (dep) => {
        const dates = await fetchVersionDates(dep.registry, dep.name, dep.currentVersion, perFetchTimeoutMs);
        if (!dates) return null;
        const years = computeDepAge(dates.currentDate, dates.latestDate);
        return {
          name: dep.name,
          current: dep.currentVersion,
          latest: dates.latestVersion,
          years: Math.round(years * 100) / 100,
        };
      })
    );
    results.push(...batchResults);
  }

  const resolved = results.filter(r => r !== null);
  return aggregateLibyear(resolved);
}

/**
 * Compute libyear with an overall wall-clock budget. Returns null if the budget
 * expires before the inner work completes.
 *
 * Uses Promise.race against a setTimeout rather than an AbortController-based
 * cascade. The legacy cascade (issue #218/#220) reliably drained Node's event
 * loop mid-phase when its abort fanned out across many in-flight fetches —
 * undici's internal stream cleanup abandoned async work below the user-code
 * try/catch level, surfacing as `[pipeline] beforeExit` and failing the build.
 *
 * A defensive `.catch(() => null)` is chained onto the inner promise *before*
 * it enters Promise.race. If the inner promise later rejects (timeout branch
 * having already won the race), the .catch transforms the rejection into a
 * resolve(null) on the chained promise so no unhandledRejection surfaces at
 * the process level. Gemini Code Assist on PR #219 argued this was redundant;
 * production proved otherwise.
 *
 * @param {Array} sbomPackages — SBOM dependency entries.
 * @param {number} timeoutMs — overall wall-clock budget.
 * @param {Object} [opts]
 * @param {number} [opts.perFetchMs] — per-fetch timeout passed through to fetchVersionDates.
 */
export async function computeLibyearWithTimeout(sbomPackages, timeoutMs = 5000, { perFetchMs } = {}) {
  const loopBreaker = new AbortController();
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      loopBreaker.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      computeLibyear(sbomPackages, perFetchMs, loopBreaker.signal).catch(() => null),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
    // Ensure the loop terminates even if the inner branch won the race —
    // the next batch check stops issuing new fetches once the caller has
    // already received its result.
    loopBreaker.abort();
  }
}
