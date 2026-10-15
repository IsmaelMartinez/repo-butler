// Stuck security-fix PR watcher — an open Dependabot PR that fixes an open
// critical/high Dependabot alert and has not landed.
//
// The gap this closes: three existing signals each read such a PR as "handled".
// detectOpenVulnerabilities downgrades a Dependabot-only finding from high to
// medium when automated security fixes are on ("remediation in flight");
// dependabot-audit only flags a Dependabot PR after 30 days; and G13
// (stalled-alert) suppresses whenever an open Dependabot PR plausibly addresses
// the alert. So a security PR sitting red, or green but a major bump the
// auto-merge workflow will not take, or simply waiting on a review, was
// invisible for a month while the alert it fixes stayed open. teams-for-linux
// and ismaelmartinez.me.uk carried high alerts from 2026-W40 that way, every
// signal reporting "in flight".
//
// DETECTION ONLY — no write of any kind, same as G13. A per-repo STATE finding
// routed to executor 'manual'; it never reaches the templated-PR path or
// cross-repo PROPOSE (ADR-002/ADR-011 lane boundary).

import { eligibleRepos, listOpenPRs } from './governance-repos.js';
import { alertDirectory, branchNamesAlertPackage } from './stalled-alert.js';
import { parseVersion, compareVersions, sameReleaseLine } from './trimmer.js';

// Dependabot opens a security PR within hours and, where auto-merge is wired,
// lands a green patch/minor bump within a day. Three days is past every
// "about to merge anyway" case (a weekend included) while still short enough
// that the operator hears about it in the same week the alert opened — the
// whole point, since the 30-day dependabot-stale bar is what let it hide.
const DEFAULT_THRESHOLD_DAYS = 3;

// Matches open-vulnerability's bar: this finding exists to qualify THAT one's
// "in flight" claim, so it must speak about the same alerts. A stuck fix for a
// medium alert is G13's territory once the alert itself goes stale.
const QUALIFYING_SEVERITIES = new Set(['critical', 'high']);

// prCiState costs two reads per PR. A repo with more stuck security PRs than
// this is itself the finding; the rest are still reported as 'unclassified'.
const MAX_CLASSIFIED_PER_REPO = 3;

const BRANCH_PREFIX = 'dependabot/';

// What a human should do, from the five-state prCiState. NEVER prCiGreen: that
// is a merge guard and collapses red, pending, no-CI and read errors into one
// false — read as "red" it would accuse every repo with no CI, and every
// transient API error, of a failing fix. 'unknown' stays 'unknown'.
const CI_STATE = {
  green: 'awaiting-human',
  red: 'ci-red',
  pending: 'ci-pending',
  none: 'ci-none',
};

/**
 * Is this Dependabot PR a release-line crossing (a major, or a 0.x minor)?
 * Read from Dependabot's own title shape, "... from X to Y". Only the two
 * versions are extracted and only a boolean is kept — the title is never
 * stored, since the branch prefix is forgeable and a title is free text.
 * @returns {boolean|null} null when the title does not carry two versions
 */
export function isReleaseLineBump(title) {
  const m = typeof title === 'string' ? title.match(/\bfrom (\S+) to (\S+?)\.?(?:\s|$)/) : null;
  if (!m) return null;
  const from = parseVersion(m[1]);
  const to = parseVersion(m[2]);
  if (!from || !to) return null;
  return !sameReleaseLine(from, to);
}

/**
 * The qualifying alerts this branch definitively fixes. A branch naming the
 * package but bumping to a version below the first patched one is an ordinary
 * version update, not the fix, and does not match; an unparseable version on
 * either side cannot rule the branch out, since it does name the package.
 */
function alertsFixedBy(ref, alerts) {
  return alerts.filter(a => {
    const hit = branchNamesAlertPackage(ref, a);
    if (!hit) return false;
    const to = parseVersion(hit.version);
    const patched = parseVersion(a.patchedVersion);
    return !(to && patched && compareVersions(to, patched) < 0);
  });
}

/**
 * Detect open Dependabot PRs that fix an open critical/high Dependabot alert
 * and have been open past the threshold.
 *
 * Never throws: a per-repo failure yields null and is filtered out, matching the
 * sibling detectors — runGovernance would otherwise lose the whole phase's
 * output. Bounded: the alerts list is read only for a repo that already has a
 * Dependabot PR past the threshold, and CI is read for at most
 * MAX_CLASSIFIED_PER_REPO PRs per repo.
 *
 * @param {object} gh — GitHub API client (createClient return)
 * @param {string} owner
 * @param {Array} repos — portfolio repos. PUBLIC repos only: private repos never
 *   enter the governance pipeline (AGENTS.md, guard in governance.test.js).
 * @param {{ openPRs?: Object, thresholdDays?: number }} [options] — openPRs is
 *   governance.fetchOpenPRs's shared sweep.
 * @returns {Promise<Array>} findings of type 'security-pr-stuck'
 */
export async function detectStuckSecurityPRs(gh, owner, repos, {
  openPRs = null,
  thresholdDays = DEFAULT_THRESHOLD_DAYS,
} = {}) {
  if (!Array.isArray(repos)) return [];

  const now = Date.now();

  const results = await Promise.all(eligibleRepos(repos).map(async (repo) => {
    try {
      const prs = await listOpenPRs(gh, owner, repo.name, openPRs);
      if (!Array.isArray(prs)) return null;

      const old = [];
      for (const pr of prs) {
        const ref = pr?.head?.ref;
        if (typeof ref !== 'string' || !ref.startsWith(BRANCH_PREFIX)) continue;
        const age = Math.floor((now - new Date(pr.created_at).getTime()) / 86400000);
        // Negated `>`: an unparseable created_at makes age NaN, and this form
        // skips it rather than reporting a PR of unknown age as stuck.
        if (!(age > thresholdDays)) continue;
        old.push({ pr, ref, age });
      }
      if (old.length === 0) return null;

      // Fresh read, not context.repoDetails: that keeps only a severity summary
      // behind the pushed_at cache, and matching needs packages and directories.
      const raw = await gh.request(`/repos/${owner}/${repo.name}/dependabot/alerts`, {
        params: { state: 'open', per_page: 100 },
      });
      const alerts = (Array.isArray(raw) ? raw : [])
        .filter(a => a?.state === 'open')
        .map(a => ({
          number: a.number,
          package: a.dependency?.package?.name,
          ecosystem: a.dependency?.package?.ecosystem ?? null,
          directory: alertDirectory(a.dependency?.manifest_path),
          severity: a.security_vulnerability?.severity || a.security_advisory?.severity || null,
          patchedVersion: a.security_vulnerability?.first_patched_version?.identifier ?? null,
        }))
        .filter(a => a.package && QUALIFYING_SEVERITIES.has(a.severity));
      if (alerts.length === 0) return null;

      const stuck = [];
      for (const { pr, ref, age } of old) {
        const fixes = alertsFixedBy(ref, alerts);
        if (fixes.length === 0) continue;
        stuck.push({ pr, age, fixes });
      }
      if (stuck.length === 0) return null;

      // Oldest first: the worst offender gets classified and tops the row.
      stuck.sort((a, b) => b.age - a.age);

      const stuckPRs = [];
      for (const [i, { pr, age, fixes }] of stuck.entries()) {
        const ci = i < MAX_CLASSIFIED_PER_REPO
          ? await gh.prCiState(owner, repo.name, pr.head?.sha)
          : null;
        stuckPRs.push({
          number: pr.number,
          age,
          package: fixes[0].package,
          alerts: fixes.map(a => a.number).sort((a, b) => a - b),
          severity: fixes.some(a => a.severity === 'critical') ? 'critical' : 'high',
          state: ci === null ? 'unclassified' : (CI_STATE[ci] ?? 'unknown'),
          majorBump: isReleaseLineBump(pr.title),
          draft: pr.draft === true,
        });
      }

      return {
        type: 'security-pr-stuck',
        repo: repo.name,
        stuckPRs,
        // Never 'high' on its own: the urgency already lives on the companion
        // open-vulnerability finding, which this finding stops being downgraded
        // (governance.js). Raising both would double-count one alert on the
        // attention banner.
        priority: 'medium',
      };
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        console.log(`security-pr-stuck: skipping ${repo.name} (${err.message.slice(0, 80)})`);
      }
      return null;
    }
  }));

  // Stable order: findings feed the governance-weekly diffs and the dashboard.
  return results.filter(Boolean).sort((a, b) => a.repo.localeCompare(b.repo));
}
