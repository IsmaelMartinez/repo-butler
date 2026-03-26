// Libyear dependency freshness computation.
// Computes cumulative age (in years) of a repo's npm dependencies
// versus their latest published versions using the npm registry.

const REGISTRY_BASE = 'https://registry.npmjs.org';
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Extract npm package name and version from SBOM dependency data.
 * Filters to only npm ecosystem packages using the purl field.
 */
export function filterNpmDeps(sbomPackages) {
  if (!sbomPackages || sbomPackages.length === 0) return [];
  return sbomPackages
    .filter(p => p.purl && p.purl.startsWith('pkg:npm/') && p.version)
    .map(p => {
      // purl format: pkg:npm/@scope/name@version or pkg:npm/name@version
      const withoutPrefix = p.purl.slice('pkg:npm/'.length);
      const atIdx = withoutPrefix.startsWith('@')
        ? withoutPrefix.indexOf('@', 1)
        : withoutPrefix.indexOf('@');
      const name = atIdx >= 0 ? decodeURIComponent(withoutPrefix.slice(0, atIdx)) : decodeURIComponent(withoutPrefix);
      return { name, currentVersion: p.version };
    });
}

/**
 * Fetch publish date for a specific version and the latest version from the npm registry.
 * Returns { currentDate, latestVersion, latestDate } or null on failure.
 * Accepts an optional AbortSignal to cancel the request.
 */
async function fetchVersionDates(packageName, currentVersion, signal) {
  try {
    const url = `${REGISTRY_BASE}/${encodeURIComponent(packageName).replace('%40', '@')}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();

    const time = data.time;
    if (!time) return null;

    const latestVersion = data['dist-tags']?.latest;
    if (!latestVersion) return null;

    const currentDate = time[currentVersion] ? new Date(time[currentVersion]) : null;
    const latestDate = time[latestVersion] ? new Date(time[latestVersion]) : null;

    if (!currentDate || !latestDate) return null;

    return { currentDate, latestVersion, latestDate };
  } catch (error) {
    console.warn(`[libyear] Failed to fetch version dates for '${packageName}':`, error.message || error);
    return null;
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
 * Queries the npm registry for each npm dependency to find the age gap
 * between the current and latest versions.
 * Accepts an optional AbortSignal to cancel in-flight requests.
 *
 * Returns { total_libyear, dependency_count, deps, oldest } or null on complete failure.
 * Each dep in deps: { name, current, latest, years }.
 */
export async function computeLibyear(sbomPackages, signal) {
  const npmDeps = filterNpmDeps(sbomPackages);
  if (npmDeps.length === 0) return null;

  // Batch in groups of 5 to avoid hammering the registry.
  const results = [];
  const BATCH_SIZE = 5;
  for (let i = 0; i < npmDeps.length; i += BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = npmDeps.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (dep) => {
        const dates = await fetchVersionDates(dep.name, dep.currentVersion, signal);
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
 * Compute libyear with an overall timeout. Returns null if the timeout expires.
 * Uses AbortController to cancel in-flight fetch requests and clears the timer.
 */
export async function computeLibyearWithTimeout(sbomPackages, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await computeLibyear(sbomPackages, controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
