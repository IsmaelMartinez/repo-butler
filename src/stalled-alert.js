// Stalled-alert watcher (G13) — an open Dependabot alert that nothing is
// driving to resolution, classified by WHY it is stuck.
//
// The gap this closes: G7 watches a repo losing tier, G12 watches the butler's
// own PRs failing to land. Both instance one missing property — something acts
// and nothing checks afterwards whether it worked. Here the actor is Dependabot.
// The spike found a live alert open for thirty-five days on a repo where
// automated security fixes were enabled, unpaused and correctly configured,
// while every existing signal reported the repository healthy: it is `medium`
// severity, so detectOpenVulnerabilities (critical/high only) never saw it, and
// nothing anywhere correlated an alert with the presence of a Dependabot PR.
//
// DETECTION ONLY. ADR-014 is the authority and it authorises no new write — no
// rescan trigger, no commit push, no settings toggle, and no PR. Classification
// reuses src/trimmer.js `planOverride` READ-ONLY: its refusal reasons are
// already a triage vocabulary for exactly this question. An `override` verdict
// is recorded as a classification and never acted on; making that jump is
// ADR-013's business and needs its own deliberate wiring.

import { REPO_EXCLUSION_PATTERNS } from './report-shared.js';
import { planOverride } from './trimmer.js';

// Severity floor. Deliberately BELOW open-vulnerability's critical/high bar:
// the live case is a medium alert, and "medium and unattended for a month" is a
// different signal from "high and open", which the tier check already carries.
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const DEFAULT_SEVERITY_FLOOR = 'medium';

// Age threshold. Dependabot opens a security PR within hours when it can, so a
// fortnight is well past "about to be fixed anyway" while staying short enough
// that a stall is still worth acting on. Shorter than dependabot-audit's 30-day
// PR staleness bar on purpose — that one waits on a human, this one waits on a
// bot that has already had its chance.
const DEFAULT_THRESHOLD_DAYS = 14;

// Detail strings are built from lockfile contents, which are target-repo
// controlled. They are escaped on the dashboard and never reach the LLM prompt;
// the cap bounds them anyway.
const MAX_DETAIL_CHARS = 200;

// GitHub alert ecosystem -> the manager segment Dependabot puts in its branch
// names. An ecosystem absent here cannot be matched against a branch, which is
// treated as "cannot rule this PR out" rather than "no PR" — see branchMayAddress.
const ECOSYSTEM_MANAGERS = {
  npm: 'npm_and_yarn',
  pip: 'pip',
  rubygems: 'bundler',
  nuget: 'nuget',
  maven: 'maven',
  composer: 'composer',
  go: 'go_modules',
  rust: 'cargo',
  actions: 'github_actions',
  docker: 'docker',
  pub: 'pub',
  swift: 'swift',
};

// The only ecosystem the trimmer can reason about: it reads an npm lockfile.
const CLASSIFIABLE_ECOSYSTEM = 'npm';

const BRANCH_PREFIX = 'dependabot/';

/** Directory an alert lives in, from its manifest path. '' for the repo root. */
function alertDirectory(manifestPath) {
  const p = String(manifestPath ?? '').replace(/^\/+/, '');
  const slash = p.lastIndexOf('/');
  return slash === -1 ? '' : p.slice(0, slash);
}

// Does a branch-name tail look like a version rather than a group hash?
// Dependabot names single-package branches `<pkg>-<version>` but grouped ones
// `<group-name>-<hash>` (e.g. minor-and-patch-479fbeca4e), and a grouped branch
// does NOT name its contents. Getting this wrong in the "it's a version"
// direction is the expensive one: it would read a grouped PR as being about
// some other package and let a false positive through. So a bare digit run only
// counts as a version when it is short enough to be a major (`actions/checkout-7`);
// anything longer, or containing letters, is treated as a hash.
// Both patterns are linear-time: no nested quantifier, and each iteration of the
// dotted group consumes a literal '.'.
function looksLikeVersion(s) {
  return /^\d+(?:\.\d+)+$/.test(s) || /^\d{1,4}$/.test(s);
}

/**
 * Could this Dependabot branch be addressing this alert?
 *
 * Errs deliberately toward TRUE ("possibly addressing", so the finding is
 * suppressed). A false negative delays a report by a run; a false positive puts
 * a row on the dashboard saying nobody is fixing something that is being fixed,
 * which costs trust in every other row.
 *
 * @param {string} ref — the PR's head branch
 * @param {{ ecosystem: string, package: string, directory: string }} alert
 * @returns {boolean}
 */
export function branchMayAddress(ref, alert) {
  if (typeof ref !== 'string' || !ref.startsWith(BRANCH_PREFIX)) return false;

  const rest = ref.slice(BRANCH_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return false;
  const manager = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);

  const expected = ECOSYSTEM_MANAGERS[alert?.ecosystem];
  // An ecosystem we have no mapping for cannot be ruled out.
  if (!expected) return true;
  if (manager !== expected) return false;

  const dash = tail.lastIndexOf('-');
  const suffix = dash === -1 ? '' : tail.slice(dash + 1);

  if (dash > 0 && looksLikeVersion(suffix)) {
    // A single-package branch: it names the package it bumps. Dependabot drops
    // the leading @ of a scoped name, so `@babel/core` becomes `babel/core`,
    // and any leading directory is a prefix on the same segment run.
    const named = tail.slice(0, dash);
    const slug = String(alert?.package ?? '').replace(/^@/, '');
    if (!slug) return true;
    return named === slug || named.endsWith(`/${slug}`);
  }

  // A grouped (or simply unparseable) branch names no package. Compare
  // directories where we can: a grouped branch for `docs-site` starts with that
  // directory, so a non-root alert elsewhere is genuinely unaddressed by it. For
  // a ROOT alert the leading segment is ambiguous — it may be a directory or
  // part of the group name — so we cannot rule the PR out, and do not try.
  const dir = alert?.directory;
  if (!dir) return true;
  return tail.startsWith(`${dir}/`);
}

/**
 * Why is this alert stuck? Pure — the caller does the I/O and hands over parsed
 * input, so an unreadable file arrives as null and yields `unknown` rather than
 * a guess (ADR-014: "must never yield a guess, and must never suppress the
 * finding — the alert is stale whether or not we can explain it").
 *
 * The vocabulary is `planOverride`'s own return: reachable-by-update,
 * direct-dependency, disjoint-ranges, out-of-scope, parent-undeterminable,
 * no-patched-version, override-conflict, pnpm-auto-installed-peer, plus
 * `override` for a verdict that WOULD write one, and `unknown`.
 *
 * @param {{ manifest: object|null, lock: object|null, alert: object }} input
 * @returns {{ classification: string, detail: string }}
 */
export function classifyAlert({ manifest, lock, alert } = {}) {
  if (alert?.ecosystem !== CLASSIFIABLE_ECOSYSTEM) {
    return { classification: 'unknown', detail: `no classifier for the ${alert?.ecosystem ?? 'unknown'} ecosystem` };
  }
  // ADR-013's caller contract: the lock and manifest must belong to the same
  // project, and unreadable input must refuse rather than arrive as {}.
  if (!manifest || !lock) {
    return { classification: 'unknown', detail: 'manifest or lockfile could not be read' };
  }

  const result = planOverride({ lock, manifest, alert });
  if (result.action === 'override') {
    return {
      classification: 'override',
      detail: `a ${result.parent}-scoped override would clear this; reported only, never applied`,
    };
  }
  return { classification: result.reason, detail: String(result.detail ?? '').slice(0, MAX_DETAIL_CHARS) };
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Detect open Dependabot alerts nobody is driving to resolution.
 *
 * Never throws: a per-repo failure yields null and is filtered out, matching
 * auditDependabot and auditButlerPRs. runGovernance would otherwise lose the
 * WHOLE phase's output, leaving the data branch serving the previous run's
 * findings.
 *
 * @param {object} gh — GitHub API client (createClient return)
 * @param {string} owner
 * @param {Array} repos — portfolio repos from observePortfolio(). PUBLIC repos
 *   only: private repos never enter the governance pipeline (see the
 *   private-repo section of CLAUDE.md and the guard in governance.test.js).
 * @param {{ openPRs?: Object, severityFloor?: string, thresholdDays?: number }} [options]
 *   openPRs is the pre-fetched `{ repoName: prs[] }` map from
 *   governance.fetchOpenPRs, so this detector shares the one open-PR sweep the
 *   two PR audits already share rather than adding a third.
 * @returns {Promise<Array>} findings of type 'stalled-alert'
 */
export async function detectStalledAlerts(gh, owner, repos, {
  openPRs = null,
  severityFloor = DEFAULT_SEVERITY_FLOOR,
  thresholdDays = DEFAULT_THRESHOLD_DAYS,
} = {}) {
  if (!Array.isArray(repos)) return [];

  const eligible = repos.filter(r =>
    !r.archived && !r.fork && !REPO_EXCLUSION_PATTERNS.some(p => r.name.includes(p))
  );

  const floor = SEVERITY_RANK[severityFloor] ?? SEVERITY_RANK[DEFAULT_SEVERITY_FLOOR];
  const now = Date.now();

  const results = await Promise.all(eligible.map(async (repo) => {
    try {
      // Single request with per_page=100, matching observe.js's alert fetchers.
      // Deliberately NOT sourced from context.repoDetails: that layer keeps only
      // a severity SUMMARY, and it sits behind the pushed_at cache — a cache hit
      // would hand a stale alert list to a staleness detector, the same trap
      // governance.fetchOpenPRs already documents for open PRs.
      const alerts = await gh.request(`/repos/${owner}/${repo.name}/dependabot/alerts`, {
        params: { state: 'open', per_page: 100 },
      });
      if (!Array.isArray(alerts) || alerts.length === 0) return null;

      const candidates = [];
      for (const a of alerts) {
        if (a?.state !== 'open') continue;
        const severity = a.security_vulnerability?.severity || a.security_advisory?.severity || null;
        if ((SEVERITY_RANK[severity] ?? 0) < floor) continue;
        const ageDays = Math.floor((now - new Date(a.created_at).getTime()) / 86400000);
        // Negated `>`, as in butler-pr-audit: an unparseable created_at makes
        // ageDays NaN and every NaN comparison is false, so this form SKIPS the
        // alert where `ageDays <= threshold` would report one of unknown age.
        if (!(ageDays > thresholdDays)) continue;
        const name = a.dependency?.package?.name;
        if (!name) continue;
        candidates.push({
          number: a.number,
          package: name,
          ecosystem: a.dependency?.package?.ecosystem ?? null,
          manifestPath: a.dependency?.manifest_path ?? null,
          severity,
          ageDays,
          patchedVersion: a.security_vulnerability?.first_patched_version?.identifier ?? null,
        });
      }
      if (candidates.length === 0) return null;

      // The branch prefix is the locator, not the author login: a Dependabot PR
      // reopened or rebased by a human still carries the branch, and reading the
      // branch is what makes "possibly addressing" decidable at all.
      const prs = openPRs?.[repo.name] ?? await gh.paginate(`/repos/${owner}/${repo.name}/pulls`, {
        params: { state: 'open', sort: 'created', direction: 'asc' },
        max: 100,
      });
      const branches = (Array.isArray(prs) ? prs : [])
        .map(pr => pr?.head?.ref)
        .filter(ref => typeof ref === 'string' && ref.startsWith(BRANCH_PREFIX));

      const unaddressed = candidates.filter(c => !branches.some(ref => branchMayAddress(ref, {
        ecosystem: c.ecosystem,
        package: c.package,
        directory: alertDirectory(c.manifestPath),
      })));
      if (unaddressed.length === 0) return null;

      // One manifest/lockfile pair per directory, not per alert: several alerts
      // in one project are the common case and the files are large.
      const projects = new Map();
      const readProject = (dir) => {
        if (!projects.has(dir)) {
          const prefix = dir ? `${dir}/` : '';
          const load = async () => ({
            manifest: parseJson(await gh.getFileContent(owner, repo.name, `${prefix}package.json`)),
            lock: parseJson(await gh.getFileContent(owner, repo.name, `${prefix}package-lock.json`)),
          });
          projects.set(dir, load());
        }
        return projects.get(dir);
      };

      const reported = [];
      for (const c of unaddressed) {
        const { manifest, lock } = c.ecosystem === CLASSIFIABLE_ECOSYSTEM
          ? await readProject(alertDirectory(c.manifestPath))
          : { manifest: null, lock: null };
        const { classification, detail } = classifyAlert({
          manifest,
          lock,
          alert: {
            package: c.package,
            ecosystem: c.ecosystem,
            patchedVersion: c.patchedVersion,
            manifestPath: c.manifestPath,
          },
        });
        reported.push({
          number: c.number,
          package: c.package,
          ecosystem: c.ecosystem,
          manifestPath: c.manifestPath,
          severity: c.severity,
          ageDays: c.ageDays,
          classification,
          detail,
        });
      }

      // Oldest first: the worst offender belongs at the top of the row. The
      // advisory summary is deliberately absent from every field above — it is
      // attacker-controlled prose and this finding reaches the IDEATE prompt.
      reported.sort((a, b) => b.ageDays - a.ageDays);

      return {
        type: 'stalled-alert',
        repo: repo.name,
        alerts: reported,
        // 'high' only for a stalled CRITICAL alert: computePortfolioState flips
        // the whole dashboard to `attention` on any high-priority finding, and a
        // medium alert nobody has looked at is not that, however annoying.
        priority: reported.some(a => a.severity === 'critical') ? 'high' : 'medium',
      };
    } catch (err) {
      if (err.message?.includes(': 403') || err.message?.includes(': 404')) {
        console.log(`stalled-alert: skipping ${repo.name} (${err.message.slice(0, 80)})`);
      }
      return null;
    }
  }));

  // Stable order: findings feed the governance-weekly diffs and the dashboard.
  return results.filter(Boolean).sort((a, b) => a.repo.localeCompare(b.repo));
}
