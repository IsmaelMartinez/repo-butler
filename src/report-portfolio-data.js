// Portfolio-level data: the per-repo details fetch and the dependency inventory.
// Kept apart from the dashboard renderer (report-portfolio.js) so GOVERNANCE,
// which needs only fetchPortfolioDetails, does not load the rendering code.

import { computeLibyearWithTimeout } from './libyear.js';
import { hasActiveCopilotReviewRuleset, getAutomatedSecurityFixesState, paginateIssues } from './github.js';
import {
  REPO_CACHE_SCHEMA_VERSION, daysAgoISO, getAlertSummary, isActionableBug, isPublishedRelease,
  isCopyleft, isHighConcernLicense,
} from './report-shared.js';

// --- SBOM / dependency inventory ---

async function fetchSBOM(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/dependency-graph/sbom`);
    const packages = data.sbom?.packages || [];
    // The first package is usually the root repo itself — skip it.
    const deps = packages
      .filter(p => p.SPDXID !== 'SPDXRef-DOCUMENT' && !p.name?.startsWith(`com.github.${owner}`))
      .map(p => ({
        id: p.SPDXID || p.externalRefs?.find(r => r.referenceType === 'purl')?.referenceLocator || `${p.name}@${p.versionInfo || 'unknown'}`,
        name: p.name,
        version: p.versionInfo || null,
        purl: p.externalRefs?.find(r => r.referenceType === 'purl')?.referenceLocator || null,
        license: parseSBOMLicense(p.licenseConcluded, p.licenseDeclared),
      }));
    return { count: deps.length, packages: deps };
  } catch {
    return null;
  }
}

function parseSBOMLicense(concluded, declared) {
  // SBOM uses SPDX expressions; pick the most specific non-NOASSERTION value.
  const raw = (concluded && concluded !== 'NOASSERTION') ? concluded
    : (declared && declared !== 'NOASSERTION') ? declared
    : null;
  return raw;
}

// --- Traffic ---

// Fetches the 14-day rolling views and clones summary for a repo.
// Requires push/administration access on the token. Returns null on 403/404
// (private fork, wrong scope, etc.) so the rest of the pipeline keeps working.
// Only the rollup counts are stored — the per-day arrays would bloat weekly
// snapshots for marginal forecasting value.
export async function fetchTraffic(gh, owner, repoName) {
  const [views, clones] = await Promise.all([
    gh.request(`/repos/${owner}/${repoName}/traffic/views`).catch(() => null),
    gh.request(`/repos/${owner}/${repoName}/traffic/clones`).catch(() => null),
  ]);
  if (!views && !clones) return null;
  return {
    views_14d: views ? { count: views.count ?? 0, uniques: views.uniques ?? 0 } : null,
    clones_14d: clones ? { count: clones.count ?? 0, uniques: clones.uniques ?? 0 } : null,
  };
}

export function analyzeDependencyInventory(details) {
  const depUsage = {};   // id -> { name, repos: Set, licenses: Set }
  const repoSummaries = {};

  for (const [repoName, d] of Object.entries(details)) {
    if (!d.sbom) continue;
    const licenseFlags = [];
    for (const pkg of d.sbom.packages) {
      const key = pkg.id || pkg.name;
      if (!depUsage[key]) {
        depUsage[key] = { name: pkg.name, repos: new Set(), licenses: new Set() };
      }
      depUsage[key].repos.add(repoName);
      if (pkg.license) depUsage[key].licenses.add(pkg.license);
      if (isCopyleft(pkg.license) && d.license !== 'None' && !isCopyleft(d.license)) {
        licenseFlags.push({ name: pkg.name, license: pkg.license, level: isHighConcernLicense(pkg.license) ? 'high' : 'low' });
      }
    }
    repoSummaries[repoName] = { depCount: d.sbom.count, licenseFlags };
  }

  const sharedEntries = Object.entries(depUsage).filter(([, v]) => v.repos.size > 1);
  const sharedDepsTotal = sharedEntries.length;

  // Filter out GitHub Actions from the "common dependencies" display — they are
  // workflow dependencies, not application code dependencies.
  const commonDeps = [...sharedEntries]
    .filter(([, v]) => !v.name?.startsWith('actions/') && !v.name?.startsWith('actions:'))
    .sort((a, b) => b[1].repos.size - a[1].repos.size)
    .slice(0, 20)
    .map(([, v]) => ({ name: v.name, repoCount: v.repos.size, licenses: [...v.licenses] }));

  const allLicenseFlags = Object.entries(repoSummaries).flatMap(([repoName, summary]) =>
    summary.licenseFlags.map(flag => ({ repo: repoName, dep: flag.name, license: flag.license, level: flag.level }))
  );

  const totalUnique = Object.keys(depUsage).length;
  const reposWithSBOM = Object.values(details).filter(d => d.sbom).length;

  return { commonDeps, sharedDepsTotal, licenseFlags: allLicenseFlags, totalUnique, reposWithSBOM, repoSummaries };
}


// --- Portfolio details fetcher ---

// The one path the osv-scanner apply template writes. Detection is an exact
// match on it, deliberately unlike hasReleaseWorkflow's deliberately-broad
// regex: a hand-rolled release pipeline legitimately satisfies release-cadence,
// whereas this standard is satisfied only by the file the template installs. A
// looser match would let a repo's own variant read as compliant while the
// template could never converge on it.
const OSV_WORKFLOW_FILE = 'osv-scanner.yml';
const AUTOMERGE_WORKFLOW_FILE = 'dependabot-auto-merge.yml';

// How many active repos get a full details fetch. Each costs ~11 API calls, so
// this bounds one portfolio pass; the original value was 15, chosen in the first
// HTML-report commit when the portfolio was 8 repos and before GOVERNANCE
// existed. It is a BUDGET guard, never a correctness boundary — a repo dropped
// here simply has no details entry, and detectStandardsGaps now treats that as
// unknown rather than non-compliant. Before that fix, the 16th repo would have
// been reported non-compliant on every standard and become a remediation-PR
// target on all of them at once.
const PORTFOLIO_DETAIL_LIMIT = 40;

// Templated-workflow presence is read from the DEFAULT BRANCH via the contents
// API, never from the workflows registration listing. That listing returns every
// workflow GitHub has ever registered, including from branches that were never
// merged — verified on this repo, where `release-recovery.yml` is listed
// `active` while existing on no branch. The gap is reachable by construction,
// because a templated workflow triggering `on: pull_request` registers itself
// when it runs on the apply PR that introduces it: the listing would report the
// repo compliant before that PR merged, and permanently if it were closed
// unmerged.
//
// Nor is a workflow's ENABLED state consulted, and that is a deliberate
// narrowing rather than an oversight. GitHub auto-disables schedule-triggered
// workflows after 60 days of repository inactivity, so on a quiet repo one flips
// to `disabled_inactivity` through no one's decision. Treating that as a
// standards gap routes the repo to the templated apply path, whose contents PUT
// supplies no `sha`; the file already exists, so GitHub answers 422 and the same
// unfixable finding retries forever. Writing a file cannot re-enable a workflow.
// A standard must only detect conditions its own remediation can fix.
//
// Returns the Set of workflow FILENAMES on the default branch, or null when the
// listing could not be read. A 404 is a real answer — no .github/workflows
// directory — and yields an empty Set, so every templated workflow reads as
// genuinely absent. Anything else is `null`, i.e. unknown.
async function fetchDefaultBranchWorkflows(gh, owner, repo) {
  return gh.request(`/repos/${owner}/${repo}/contents/.github/workflows`)
    .then(d => new Set(Array.isArray(d) ? d.map(f => f.name) : []))
    .catch(err => (err?.status === 404 ? new Set() : null));
}

// Presence of a templated workflow file, as the tri-state the governance
// detectors read: true installed, false genuinely absent, null could not tell.
// Only `false` opens a remediation PR, so every uncertain path lands on null.
function workflowPresence(names, filename) {
  return names == null ? null : names.has(filename);
}

// The three security-alert summaries, shared by the cache-miss fetch and the
// cache-hit live re-read so both paths mean the same thing by each value. Each
// returns null (unknown), never a zero count, when the alerts cannot be read.
function fetchDependabotSummary(gh, owner, repo) {
  return gh.request(`/repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=100`)
    .then(alerts => getAlertSummary(alerts, a => a.security_vulnerability?.severity || a.security_advisory?.severity))
    .catch(async (err) => {
      // Alerts API returned 403 (token lacks scope). Fall back to checking
      // if dependabot.yml exists — if so, Dependabot IS configured even
      // though we can't read the alerts. Only a 403: the fallback reports a
      // zero count, which passes the Gold check, so a transient 500 or a
      // malformed response must stay unknown rather than read as "no alerts".
      if (err?.status !== 403) return null;
      const configContent = await gh.getFileContent(owner, repo, '.github/dependabot.yml');
      if (configContent) return { count: 0, max_severity: null, config_only: true };
      return null;
    });
}

function fetchCodeScanningSummary(gh, owner, repo) {
  return gh.request(`/repos/${owner}/${repo}/code-scanning/alerts?state=open&per_page=100`)
    .then(alerts => getAlertSummary(alerts, a => a.rule?.security_severity_level))
    .catch(() => null);
}

function fetchSecretScanningSummary(gh, owner, repo) {
  return gh.request(`/repos/${owner}/${repo}/secret-scanning/alerts?state=open&per_page=100`)
    // A non-array body is not a list of zero alerts; zero would pass Gold.
    .then(alerts => (Array.isArray(alerts) ? { count: alerts.length } : null))
    .catch(() => null);
}

// Resolves an object of promises to an object of their values, so each result
// is read by name: adding or reordering a call cannot shift another's value.
async function awaitNamed(promises) {
  const keys = Object.keys(promises);
  const values = await Promise.all(Object.values(promises));
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]));
}

// A cache entry is usable when it was written under the current schema and the
// repo has neither pushed nor changed its open-issue count since.
function isCacheHit(cached, r) {
  return !!(
    cached
    && cached.schemaVersion === REPO_CACHE_SCHEMA_VERSION
    && cached.pushed_at === r.pushed_at
    && cached.open_issues_count === (r.open_issues || 0)
    // An EMPTY cached details object is not a cache hit, it is a record that
    // nobody ever fetched this repo: report.js persists
    // `{ ...(repoDetails?.[name] || {}) }` for every active repo, including
    // those skipped past PORTFOLIO_DETAIL_LIMIT. Taking the branch would spread
    // the live-refreshed fields onto `{}` and hand governance a NON-EMPTY
    // details object with no license, no codeowners, no security policy — and
    // hasRepoDetails, which exists to reject exactly that, would pass it. Every
    // `!!details?.x` detector then reads false and the repo becomes a
    // remediation-PR target on every allow-listed class at once, on the
    // unattended weekly cron, purely because nobody looked at it. Fall through
    // to the full fetch instead.
    && Object.keys(cached.details || {}).length > 0
  );
}

// The Dependabot autofix setting (ADR-012 Phase 3) and the Copilot review
// ruleset (ADR-009) are both repo-settings toggles that can flip without a
// push or an open-issue-count change, so the cache key does not capture
// either, and leaving them stale would let a quiet repo's "in flight /
// not driven" and code-review-bot annotations drift indefinitely. Refresh
// both with live reads on the cache-hit path and merge into a COPY — never
// mutate the cache. This is the cache-refresh convention: a field that
// can change without a push gets a live read on every cache hit rather
// than a schema-version bump (which would only recompute once).
//
// The three security-alert summaries (vulns, codeScanning,
// secretScanning) follow the same convention: a new advisory, a
// scheduled CodeQL run or a manual dismissal changes them with no push,
// and they feed the Gold "zero critical/high" check and the
// open-vulnerability detector — serving them cached would keep a repo
// Gold after a new high landed. They take the miss path's fetchers and
// its failure direction: an unreadable read is null (unknown), never the
// cached summary, because the miss path has no last-known fallback for
// them and a cached zero presented as current is exactly the false Gold
// this re-read exists to prevent.
//
// Other cached fields can also drift without a push — ciPassRate (new
// runs), open_bugs (a relabel), released_at (a release cut from an
// existing commit) — and are accepted as cached until the next push or
// open-issue-count change; none of them gates a write.
//
// The two templated-workflow flags are re-read here too, for a different
// reason: they are tri-state, and an UNKNOWN result must never become
// permanent. A repo whose contents read failed once would otherwise carry
// `null` in its cache entry until its next push — which on a quiet repo is
// indefinitely — and governance skips unknowns, so those standards would
// silently never apply to exactly the repos nobody touches. One call
// serves both and makes the verdicts always current rather than only as
// current as the last push.
//
// `ci` joins them conditionally, and only when it is UNKNOWN. It is a
// push-invariant count, so re-reading it on every cache hit would buy
// nothing for a call per repo per run — but a null is not a count, it is
// the absence of one, and left alone it would be served until the repo's
// next push, which on a quiet repo is indefinitely. That is the same
// "an unknown must never become permanent" rule as the two flags above,
// applied only where the unknown actually exists.
async function refreshCachedDetails(gh, owner, r, cached) {
  const { autofix, hasCopilotReview, workflowFiles, vulns, codeScanning, secretScanning, ci } = await awaitNamed({
    autofix: getAutomatedSecurityFixesState(gh, owner, r.name),
    hasCopilotReview: hasActiveCopilotReviewRuleset(gh, owner, r.name),
    workflowFiles: fetchDefaultBranchWorkflows(gh, owner, r.name),
    vulns: fetchDependabotSummary(gh, owner, r.name),
    codeScanning: fetchCodeScanningSummary(gh, owner, r.name),
    secretScanning: fetchSecretScanningSummary(gh, owner, r.name),
    ci: cached.details?.ci == null
      ? gh.request(`/repos/${owner}/${r.name}/actions/workflows`, { params: { per_page: 100 } })
        .then(d => d.total_count ?? null)
        .catch(() => null)
      : Promise.resolve(cached.details.ci),
  });
  // An unknown live read must not destroy a known cached verdict — it is
  // strictly less information than what is already on hand. Without the
  // fallback, one 500 on the contents API turns a cached `false` (a real,
  // actionable gap) into `null`, governance skips the repo, and the run
  // reports no gap at all: indistinguishable from full adoption. The re-read
  // exists to stop an unknown becoming permanent, not to let a transient one
  // erase a fact.
  return {
    ...cached.details,
    ci,
    autofix,
    vulns,
    codeScanning,
    secretScanning,
    // Now tri-state too, so it takes the same fallback as the two below:
    // an unreadable live scan must not erase a cached verdict. It was
    // exempt only because it could never return null.
    hasCopilotReview: hasCopilotReview ?? cached.details?.hasCopilotReview ?? null,
    hasOsvScanner: workflowPresence(workflowFiles, OSV_WORKFLOW_FILE)
      ?? cached.details?.hasOsvScanner ?? null,
    hasAutoMergeWorkflow: workflowPresence(workflowFiles, AUTOMERGE_WORKFLOW_FILE)
      ?? cached.details?.hasAutoMergeWorkflow ?? null,
  };
}

async function fetchFreshDetails(gh, owner, r, cached) {
  // Last-known `ci`, used ONLY as the workflow-listing catch's fallback. Gated
  // on the cache schema version for the same reason isCacheHit is: a details
  // object written under a superseded version may mean something
  // different, and the version bump is the one mechanism that invalidates it.
  // Reading it ungated would let a pre-bump count survive every bump — and,
  // because this value is then written into the fresh cache entry under the
  // NEW pushed_at, be laundered into something indistinguishable from a
  // current observation. Deliberately NOT gated on pushed_at: a stale count is
  // the whole point of a last-known-value fallback, and it is corrected by the
  // next successful fetch, so the exposure is one run.
  const lastKnownCi = cached?.schemaVersion === REPO_CACHE_SCHEMA_VERSION
    ? (cached.details?.ci ?? null)
    : null;
  const lastKnownCopilotReview = cached?.schemaVersion === REPO_CACHE_SCHEMA_VERSION
    ? (cached.details?.hasCopilotReview ?? null)
    : null;
  const { commits, weekly, repoMeta, workflowsMeta, workflowFiles, communityProfile, vulns, ciPassRate, openIssues, sbom, releasedAt, codeScanning, secretScanning, openPRCount, traffic, governanceFiles, copilotReview, autofix } = await awaitNamed({
    commits: gh.request('/search/commits', {
      params: { q: `repo:${owner}/${r.name} committer-date:>${daysAgoISO(180)}`, per_page: 1 },
    }).then(d => d.total_count).catch(() => 0),
    weekly: gh.request(`/repos/${owner}/${r.name}/stats/participation`)
      .then(d => d.owner?.slice(-26) || [])
      .catch(() => []),
    repoMeta: gh.request(`/repos/${owner}/${r.name}`)
      .then(d => ({ license: d.license?.spdx_id || 'None', allowAutoMerge: !!d.allow_auto_merge }))
      .catch(() => ({ license: 'None', allowAutoMerge: false })),
    workflowsMeta: gh.request(`/repos/${owner}/${r.name}/actions/workflows`, { params: { per_page: 100 } })
      .then(d => {
        const wfs = d.workflows || [];
        return {
          ci: d.total_count || 0,
          // hasAutoMergeWorkflow used to be derived here and no longer is: the
          // registration listing reports workflows from branches that were
          // never merged, so an apply PR opened and then closed unmerged left
          // the repo reading compliant forever. It now comes from the
          // default-branch contents read below, like hasOsvScanner.
          // Any workflow whose path or display name mentions "release" counts as
          // release automation — deliberately broader than the templated
          // .github/workflows/release.yml so hand-rolled release/publish
          // pipelines (electron-builder, semantic-release, …) are not flagged
          // and never receive a redundant apply PR. Drives the release-cadence
          // governance standard; release RECENCY stays the tier checks' job.
          // The fetch is a single unpaginated page: when the repo has more
          // workflows than were returned, the list is truncated, so fail toward
          // "present" — a truncated read must never open a remediation PR.
          hasReleaseWorkflow: wfs.some(w => /release/i.test(w.path || '') || /release/i.test(w.name || ''))
            || (d.total_count || 0) > wfs.length,
        };
      })
      // hasReleaseWorkflow fails toward present on a request error: it gates a
      // cross-repo write, so a transient API failure must never manufacture a
      // remediation PR. It stays on the registration listing because it matches
      // a workflow's DISPLAY NAME as well as its path, deliberately, so that
      // hand-rolled release pipelines count — and the contents listing carries
      // filenames only. The two file-presence standards report UNKNOWN instead
      // of failing toward present, because fail-toward-present is wrong for
      // anything cached: this details object is persisted under a pushed_at
      // key, so a single blip would write "compliant" and serve it until the
      // repo's next push, which on a quiet repo is indefinitely. Unknown is
      // honest and, unlike `true`, cannot be mistaken for evidence.
      // `ci` falls back to the cached count and only reaches `null` for a repo
      // that has never been read successfully. It must NOT fail to 0: `ci`
      // feeds computeHealthTier's "Has CI workflows (2+)" gold check, so a
      // single 500 on this endpoint used to demote a healthy repo — and the
      // G7 detector then filed a high-priority tier-regression finding about
      // a regression that never happened. That is worse than the spurious
      // remediation PR the templated standards guard against, because it
      // moves the portfolio's headline metric and persists into the weekly
      // snapshot as a stored tier. Unlike hasReleaseWorkflow above, `ci` must
      // not fail toward present either: it is a COUNT, and inventing one
      // would award gold on no evidence. Last known value, else unknown.
      .catch(() => ({ ci: lastKnownCi, hasReleaseWorkflow: true })),
    workflowFiles: fetchDefaultBranchWorkflows(gh, owner, r.name),
    communityProfile: gh.request(`/repos/${owner}/${r.name}/community/profile`)
      .then(async d => {
        let hasIssueTemplate = !!d.files?.issue_template;
        if (!hasIssueTemplate) {
          try {
            const dir = await gh.request(`/repos/${owner}/${r.name}/contents/.github/ISSUE_TEMPLATE`);
            hasIssueTemplate = Array.isArray(dir) && dir.length > 0;
          } catch { /* directory doesn't exist */ }
        }
        return {
          health_percentage: d.health_percentage ?? null,
          has_issue_template: hasIssueTemplate,
        };
      })
      .catch(() => null),
    vulns: fetchDependabotSummary(gh, owner, r.name),
    ciPassRate: gh.request(`/repos/${owner}/${r.name}/actions/runs?status=completed&per_page=100`)
      .then(d => {
        const runs = d.workflow_runs || [];
        let success = 0, fail = 0;
        for (const run of runs) {
          if (run.conclusion === 'success') success++;
          else if (run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out') fail++;
        }
        const total = success + fail;
        return total > 0 ? success / total : null;
      })
      .catch(() => null),
    // open_bugs is tri-state: a failed listing yields null (unknown), never 0.
    openIssues: paginateIssues(gh, owner, r.name, { params: { state: 'open' }, max: 500 })
      .then(issues => ({ total: issues.length, bugs: issues.filter(i => isActionableBug(i.labels)).length }))
      .catch(() => ({ total: r.open_issues || 0, bugs: null })),
    sbom: fetchSBOM(gh, owner, r.name),
    releasedAt: gh.paginate(`/repos/${owner}/${r.name}/releases`, { max: 20 })
      .then(rels => rels.find(isPublishedRelease)?.published_at ?? null)
      .catch(() => null),
    codeScanning: fetchCodeScanningSummary(gh, owner, r.name),
    secretScanning: fetchSecretScanningSummary(gh, owner, r.name),
    openPRCount: gh.paginate(`/repos/${owner}/${r.name}/pulls`, { params: { state: 'open' }, max: 100 })
      .then(prs => prs.length)
      .catch(() => null),
    traffic: fetchTraffic(gh, owner, r.name),
    // CODEOWNERS / SECURITY.md presence across the three GitHub-recognised
    // locations (root, .github/, docs/). Fetch root first; descend into
    // .github/ or docs/ only when they exist in root and a file is still
    // unfound — so a compliant repo costs one call and a missing directory
    // costs none. gh.request (not gh.listDir) so the per-repo test mocks,
    // which stub only request, keep working — matching the issue-template
    // detection above. Drives the codeowners + security-md governance standards.
    governanceFiles: (async () => {
      const listNames = (path) => gh.request(`/repos/${owner}/${r.name}/contents${path ? '/' + path : ''}`)
        .then(d => Array.isArray(d) ? d.map(f => String(f.name).toLowerCase()) : [])
        .catch(() => []);
      const hasCodeownersIn = (names) => names.includes('codeowners');
      const hasSecurityIn = (names) => names.includes('security.md') || names.includes('security.markdown');
      const root = await listNames('');
      let hasCodeowners = hasCodeownersIn(root);
      let hasSecurityPolicy = hasSecurityIn(root);
      for (const dir of ['.github', 'docs']) {
        if (hasCodeowners && hasSecurityPolicy) break;
        if (!root.includes(dir)) continue;
        const names = await listNames(dir);
        hasCodeowners ||= hasCodeownersIn(names);
        hasSecurityPolicy ||= hasSecurityIn(names);
      }
      return { hasCodeowners, hasSecurityPolicy };
    })(),
    // GitHub Copilot automatic code review is enabled via a `copilot_code_review`
    // rule inside a repository ruleset, not a committed file. Detection is shared
    // with the settings-apply idempotency guard (apply.js) via github.js so both
    // agree on what "already enabled" means. Drives the code-review-bot standard.
    // Same schema-gated last-known-value fallback as the cache-hit branch and
    // as `ci`. Applying it there only is not enough: this is the path a repo
    // takes the moment it PUSHES, so a repo that pushed and had one bad
    // ruleset read would persist a raw null, governance would drop it from
    // both sides of the adoption figures, and a genuine gap would vanish for
    // the week while the dashboard looked like full adoption.
    copilotReview: hasActiveCopilotReviewRuleset(gh, owner, r.name)
      .then(hasCopilotReview => ({ hasCopilotReview: hasCopilotReview ?? lastKnownCopilotReview })),
    // GitHub's Dependabot automated security fixes state (ADR-012 Phase 3):
    // { enabled, paused } | null. Feeds the deterministic open-vulnerability
    // detector (governance.js) so a dependabot-sourced finding can distinguish
    // "remediation in flight" (autofix ON — GitHub is already opening bump PRs)
    // from "not being driven to resolution" (OFF). Detection stays pure (no gh
    // client); the state is fetched here and threaded into details[repo], exactly
    // as hasActiveCopilotReviewRuleset feeds code-review-bot detection. Returns
    // null on any error (feature unavailable, or the App lacks administration:
    // write) → governance reads it as "unknown" and does not annotate.
    autofix: getAutomatedSecurityFixesState(gh, owner, r.name),
  });
  const communityHealth = communityProfile?.health_percentage ?? null;
  const hasIssueTemplate = communityProfile?.has_issue_template ?? false;
  const { license, allowAutoMerge } = repoMeta;
  const { ci, hasReleaseWorkflow } = workflowsMeta;
  const hasOsvScanner = workflowPresence(workflowFiles, OSV_WORKFLOW_FILE);
  const hasAutoMergeWorkflow = workflowPresence(workflowFiles, AUTOMERGE_WORKFLOW_FILE);
  return { commits, weekly, license, ci, communityHealth, vulns, ciPassRate, open_issues: openIssues.total, open_bugs: openIssues.bugs, open_prs: openPRCount, sbom, released_at: releasedAt, hasIssueTemplate, hasAutoMergeWorkflow, hasReleaseWorkflow, hasOsvScanner, allowAutoMerge, hasCodeowners: governanceFiles.hasCodeowners, hasSecurityPolicy: governanceFiles.hasSecurityPolicy, hasCopilotReview: copilotReview.hasCopilotReview, autofix, libyear: null, codeScanning, secretScanning, traffic };
}

export async function fetchPortfolioDetails(gh, owner, repos, { cache = null } = {}) {
  const details = {};
  const cachedRepos = new Set();
  const activeRepos = repos.filter(r => !r.archived && !r.fork);

  // Fetch commit counts and weekly data for active repos (parallel, batched).
  // Never truncate silently: a dropped repo is invisible to every detector, and
  // "no findings" and "never looked" must not read alike to an operator.
  const detailed = activeRepos.slice(0, PORTFOLIO_DETAIL_LIMIT);
  if (activeRepos.length > detailed.length) {
    console.warn(
      `fetchPortfolioDetails: ${activeRepos.length - detailed.length} repo(s) beyond the ` +
      `${PORTFOLIO_DETAIL_LIMIT}-repo detail cap were not fetched; governance will skip them. ` +
      `Raise PORTFOLIO_DETAIL_LIMIT.`
    );
  }

  const fetches = detailed.map(async (r) => {
    // Incremental: skip API calls for repos unchanged since last cache.
    const cached = cache?.repos?.[r.name];
    if (isCacheHit(cached, r)) {
      details[r.name] = await refreshCachedDetails(gh, owner, r, cached);
      cachedRepos.add(r.name);
      console.log(`  ↩ ${r.name} — unchanged, using cache (autofix + copilot review + templated workflows + security alerts refreshed)`);
      return;
    }
    details[r.name] = await fetchFreshDetails(gh, owner, r, cached);
  });

  await Promise.all(fetches);

  // Compute libyear freshness (skip cached repos — already computed).
  // Run repos in small batches (not fully parallel). Running all 15 at once
  // saturates the package registries (npm/PyPI/crates.io) with 15×5=75 concurrent requests, and the
  // timeout fires en masse — "This operation was aborted" for every package.
  // Batches of 3 repos give at most 15 concurrent fetches and let each repo
  // actually complete within its timeout. Settled (not all) so one repo's
  // rejection cannot propagate and abort the whole REPORT phase.
  const libyearRepos = detailed.filter(r => details[r.name]?.sbom && !cachedRepos.has(r.name));
  const LIBYEAR_BATCH = 3;
  for (let i = 0; i < libyearRepos.length; i += LIBYEAR_BATCH) {
    const batch = libyearRepos.slice(i, i + LIBYEAR_BATCH);
    await Promise.allSettled(batch.map(async (r) => {
      details[r.name].libyear = await computeLibyearWithTimeout(details[r.name].sbom.packages, 12000);
    }));
  }

  details._cachedRepos = [...cachedRepos];
  return details;
}
