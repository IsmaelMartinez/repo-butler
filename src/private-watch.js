// Security watch for PRIVATE repos.
//
// Why this exists as its own phase rather than an extension of GOVERNANCE:
// repo-butler is a public repo, so all three of its normal sinks are
// world-readable — the Pages dashboard, the repo-butler-data branch, and the
// Actions logs. An earlier attempt threaded private repos through the governance
// pipeline and an adversarial review found 14 live disclosure paths, because
// `context.repoDetails` and `context.governanceFindings` are shared across
// phases and reach the report, the LLM prompt and the propose soak ledger
// without passing any filter.
//
// The lesson: redaction applied to a shared carrier is a convention, and
// conventions lose. So this module touches NONE of the shared carriers. It reads
// `portfolio.privateRepos`, keeps everything local, and writes only to the
// private repo itself. Nothing it produces is ever handed to governance, the
// report, the store, or an LLM.
//
// Two hard rules, both because Actions logs are public:
//   1. No log line in this file may contain a repo name. Count, never name.
//   2. All GitHub calls go through a client created with `redactPaths: true`, so
//      retry logs and thrown errors carry `/repos/owner/<redacted>/…`. The
//      fetchers below deliberately do NOT reuse observe.js's equivalents, whose
//      catch blocks log `${owner}/${repo}` on 403/404.

import { createClient } from './github.js';
import { notifyPrivateFindings, closeResolvedPrivateIssues } from './private-notify.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

/**
 * Reduce raw alert objects to counts by severity plus the affected package
 * names. Pure, so the shaping is testable without a gh fixture.
 *
 * @param {Array} alerts
 * @param {(a: object) => string|undefined} severityOf
 * @param {(a: object) => string|undefined} [nameOf]
 * @returns {{total: number, bySeverity: object, packages: Array<string>}}
 */
export function summariseAlerts(alerts, severityOf, nameOf) {
  const list = Array.isArray(alerts) ? alerts : [];
  // `bySeverity` is keyed by a string from the GitHub API. Left as a plain
  // object deliberately: the values are numbers (so `__proto__` assignment is
  // silently ignored rather than polluting) and every read uses a fixed severity
  // name, so an unexpected key cannot reach the output. Object.create(null)
  // would be marginally tighter but changes the returned object's prototype,
  // which callers compare against literals.
  const bySeverity = {};
  const packages = new Set();
  for (const a of list) {
    const sev = String(severityOf(a) || 'unknown').toLowerCase();
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    const name = nameOf ? nameOf(a) : null;
    if (name) packages.add(name);
  }
  return { total: list.length, bySeverity, packages: [...packages].sort() };
}

/**
 * Turn one private repo's alert summaries into findings.
 *
 * Shape deliberately matches governance findings (`type`, `repo`, `severity`,
 * `detail`, `private`) so private-notify.js can render them with no special
 * casing — but these findings never join `context.governanceFindings`.
 *
 * @param {string} repo
 * @param {{dependabot: object|null, codeScanning: object|null, secretScanning: object|null}} summaries
 * @returns {Array} findings (empty when the repo is clean)
 */
export function buildPrivateFindings(repo, summaries) {
  const findings = [];
  const { dependabot, codeScanning, secretScanning } = summaries;

  const addAlertFinding = (source, summary) => {
    if (!summary || summary.total === 0) return;
    const acute = SEVERITIES
      .filter(s => s === 'critical' || s === 'high')
      .map(s => [s, summary.bySeverity[s] || 0])
      .filter(([, n]) => n > 0);
    if (acute.length === 0) return;

    const counts = acute.map(([s, n]) => `${n} ${s}`).join(', ');
    const pkgs = summary.packages.length
      ? ` — ${summary.packages.slice(0, 12).join(', ')}${summary.packages.length > 12 ? `, +${summary.packages.length - 12} more` : ''}`
      : '';
    findings.push({
      type: 'open-vulnerability',
      repo,
      source,
      severity: acute.some(([s]) => s === 'critical') ? 'critical' : 'high',
      detail: `${counts} open ${source} alert(s)${pkgs}`,
      private: true,
    });
  };

  addAlertFinding('dependabot', dependabot);
  addAlertFinding('code-scanning', codeScanning);

  // Any secret-scanning hit is acute regardless of count.
  if (secretScanning && secretScanning.total > 0) {
    findings.push({
      type: 'open-vulnerability',
      repo,
      source: 'secret-scanning',
      severity: 'critical',
      detail: `${secretScanning.total} open secret-scanning alert(s)`,
      private: true,
    });
  }

  return findings;
}

// Name-free alert fetch. Returns null when the endpoint is unavailable (403 on a
// token without the scope, 404 when the feature is off) so a missing scope reads
// as "unknown" rather than "clean". Deliberately logs nothing at all — the
// caller reports aggregate counts.
async function fetchAlerts(gh, owner, repo, endpoint, severityOf, nameOf) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/${endpoint}`, {
      params: { state: 'open', per_page: 100 },
    });
    return summariseAlerts(data, severityOf, nameOf);
  } catch {
    return null;
  }
}

/**
 * Check every private repo's security posture and deliver the result to that
 * repo as a tracking issue.
 *
 * Reads `context.portfolio.privateRepos` and nothing else from the shared
 * context; writes nothing back onto it. Safe to call in any phase order, and a
 * no-op when there are no private repos.
 *
 * @param {object} context pipeline context ({ owner, token, portfolio, dryRun })
 * @returns {Promise<{repos: number, withFindings: number, notified: number, closed: number, unreadable: number}>}
 */
export async function runPrivateWatch(context) {
  const { owner, token, portfolio, dryRun } = context;
  const privateRepos = portfolio?.privateRepos || [];
  const result = { repos: privateRepos.length, withFindings: 0, notified: 0, closed: 0, unreadable: 0 };

  if (privateRepos.length === 0) return result;

  // Redacting client: every retry log and thrown error from here carries
  // /repos/owner/<redacted>/… instead of the real name.
  const gh = createClient(token, { redactPaths: true });

  const allFindings = [];
  for (const repo of privateRepos) {
    const name = repo.name;
    const [dependabot, codeScanning, secretScanning] = await Promise.all([
      fetchAlerts(gh, owner, name, 'dependabot/alerts',
        a => a.security_vulnerability?.severity || a.security_advisory?.severity,
        a => a.dependency?.package?.name),
      fetchAlerts(gh, owner, name, 'code-scanning/alerts',
        a => a.rule?.security_severity_level,
        a => a.rule?.id),
      fetchAlerts(gh, owner, name, 'secret-scanning/alerts', () => 'critical'),
    ]);

    if (dependabot === null && codeScanning === null && secretScanning === null) result.unreadable++;

    const findings = buildPrivateFindings(name, { dependabot, codeScanning, secretScanning });
    if (findings.length > 0) result.withFindings++;
    allFindings.push(...findings);
  }

  console.log(`Private watch: ${result.repos} private repo(s) checked, ${result.withFindings} with acute findings${result.unreadable ? `, ${result.unreadable} unreadable` : ''}.`);

  const notified = await notifyPrivateFindings(gh, owner, allFindings, { dryRun });
  result.notified = notified.notified;
  result.closed = await closeResolvedPrivateIssues(
    gh, owner, privateRepos.map(r => r.name), allFindings, { dryRun },
  );

  return result;
}
