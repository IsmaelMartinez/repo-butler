// Stuck security-fix PR watcher — an open Dependabot PR that fixes an open
// critical/high Dependabot alert and has not landed.
//
// The gap this closes: three existing signals each read such a PR as "handled".
// detectOpenVulnerabilities downgraded a Dependabot-only finding from high to
// medium whenever automated security fixes were on ("remediation in flight");
// dependabot-audit only flags a Dependabot PR after 30 days; and G13
// (stalled-alert) suppresses whenever an open Dependabot PR plausibly addresses
// the alert. So a security PR sitting red, or green but a major bump the
// auto-merge workflow will not take, or simply waiting on a review, was
// invisible for a month while the alert it fixes stayed open.
//
// The same reads also supply the EVIDENCE for that downgrade (fixEvidence
// below). The motivating repos (teams-for-linux, generator, 2026-W40) had no
// Dependabot branch at all — an alert with no patched version, one unreachable
// by update, and one Dependabot simply never opened a PR for — while the
// setting alone kept reporting "in flight". "Autofix is on" says GitHub MAY open
// a PR; only an open, recent PR for every alert says it did.
//
// DETECTION ONLY — no write of any kind, same as G13. A per-repo STATE finding
// routed to executor 'manual'; it never reaches the templated-PR path or
// cross-repo PROPOSE (ADR-002/ADR-011 lane boundary).

import { eligibleRepos, listOpenPRs } from './governance-repos.js';
import { alertDirectory, branchNamesAlertPackage, isSameRepoPR } from './stalled-alert.js';
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

// The alerts read asks the API for critical/high only, so one page of 100 is
// the realistic whole. A FULL page may be truncated: stuck detection still uses
// it (a missing alert can only hide a stuck PR, never invent one), but it is
// never taken as in-flight evidence, which must cover EVERY alert.
const ALERTS_PAGE = 100;

const DEPENDABOT_LOGIN = 'dependabot[bot]';

const daysSince = (iso, now) => Math.floor((now - new Date(iso).getTime()) / 86400000);


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
 * Read each repo's Dependabot PRs and critical/high alerts once, and derive two
 * things from them: `security-pr-stuck` findings, and per-repo evidence for
 * whether the fix is actually in flight (consumed by detectOpenVulnerabilities).
 *
 * Never throws. A per-repo failure is LOGGED (every status — these are public
 * repos, eligibleRepos excludes private ones) and the repo lands in `unread`,
 * so "could not read" is never mistaken for "nothing stuck" or for evidence.
 * Bounded: alerts are read only for a repo with a same-repo Dependabot PR past
 * the threshold, or one named in `evidenceRepos`; CI for at most
 * MAX_CLASSIFIED_PER_REPO PRs per repo.
 *
 * @param {object} gh — GitHub API client (createClient return)
 * @param {string} owner
 * @param {Array} repos — portfolio repos. PUBLIC repos only: private repos never
 *   enter the governance pipeline (AGENTS.md, guard in governance.test.js).
 * @param {{ openPRs?: Object, thresholdDays?: number, evidenceRepos?: Iterable<string> }} [options]
 *   openPRs is governance.fetchOpenPRs's shared sweep; evidenceRepos are the
 *   repos whose in-flight claim needs checking (autofix on, critical/high open).
 * @returns {Promise<{ findings: Array, fixEvidence: Object, unread: string[] }>}
 *   fixEvidence[repo] = { inFlight, unaddressed, unpatched } for each evidence
 *   repo read completely; an evidence repo absent from it was not.
 */
export async function detectSecurityFixState(gh, owner, repos, {
  openPRs = null,
  thresholdDays = DEFAULT_THRESHOLD_DAYS,
  evidenceRepos = [],
} = {}) {
  const empty = { findings: [], fixEvidence: {}, unread: [] };
  if (!Array.isArray(repos)) return empty;

  const wantEvidence = new Set(evidenceRepos ?? []);
  const now = Date.now();

  const results = await Promise.all(eligibleRepos(repos).map(async (repo) => {
    try {
      const prs = await listOpenPRs(gh, owner, repo.name, openPRs);
      if (!Array.isArray(prs)) throw new Error('open-PR listing was not an array');

      const dependabotPRs = prs
        .filter(pr => typeof pr?.head?.ref === 'string' && pr.head.ref.startsWith(BRANCH_PREFIX) && isSameRepoPR(pr))
        .map(pr => ({ pr, ref: pr.head.ref, prAge: daysSince(pr.created_at, now) }));
      // An unparseable created_at makes the age NaN; every NaN comparison is
      // false, so such a PR is never `old` (never stuck) and never `<=` the
      // threshold (never evidence) — unknown age counts for nothing.
      const old = dependabotPRs.filter(p => p.prAge > thresholdDays);
      const needEvidence = wantEvidence.has(repo.name);
      if (old.length === 0 && !needEvidence) return null;

      // Fresh read, not context.repoDetails: that keeps only a severity summary
      // behind the pushed_at cache, and matching needs packages and directories.
      const raw = await gh.request(`/repos/${owner}/${repo.name}/dependabot/alerts`, {
        params: { state: 'open', severity: 'critical,high', per_page: ALERTS_PAGE },
      });
      if (!Array.isArray(raw)) throw new Error('alerts listing was not an array');
      const truncated = raw.length >= ALERTS_PAGE;
      const alerts = raw
        .filter(a => a?.state === 'open')
        .map(a => ({
          number: a.number,
          package: a.dependency?.package?.name,
          ecosystem: a.dependency?.package?.ecosystem ?? null,
          directory: alertDirectory(a.dependency?.manifest_path),
          severity: a.security_vulnerability?.severity || a.security_advisory?.severity || null,
          patchedVersion: a.security_vulnerability?.first_patched_version?.identifier ?? null,
          alertAge: daysSince(a.created_at, now),
        }))
        .filter(a => a.package && QUALIFYING_SEVERITIES.has(a.severity));

      // How long a PR has been available as the fix for an alert: a PR older
      // than the alert (a version update that predates the advisory) has only
      // been "the fix" since the alert opened.
      const fixAge = (p, a) => Math.min(p.prAge, a.alertAge);

      const stuck = [];
      for (const p of old) {
        const fixes = alertsFixedBy(p.ref, alerts);
        if (fixes.length === 0) continue;
        const age = Math.max(...fixes.map(a => fixAge(p, a)));
        if (!(age > thresholdDays)) continue;
        stuck.push({ ...p, age, fixes });
      }

      // In-flight evidence. This LOWERS a priority, so it is held to the same
      // bar as an assertion: lowering without evidence is precisely the blind
      // spot. An alert counts as addressed only by the STRICT rule the stuck
      // detector uses (alertsFixedBy: exact package and directory, mapped
      // ecosystem, bump to at least the first patched version) from a recent
      // same-repo PR — never by a grouped branch, which names no package.
      // Every alert the read returned must be accounted for: one dropped by the
      // filter above (no package name, unexpected severity) makes "every alert
      // has a fix" vacuous, so it rules in-flight out. A read that returns NO
      // alert, while the snapshot says critical/high are open, verifies nothing
      // either way — that is null (unverifiable), not false.
      let evidence = null;
      if (needEvidence && !truncated) {
        if (raw.length === 0) {
          evidence = { inFlight: null, liveAlertsMissing: true, unaddressed: 0, unpatched: 0, unidentified: 0 };
        } else {
          const unidentified = raw.length - alerts.length;
          const unpatched = alerts.filter(a => !a.patchedVersion).length;
          const unaddressed = alerts.filter(a => a.patchedVersion && !dependabotPRs.some(p =>
            alertsFixedBy(p.ref, [a]).length === 1 && fixAge(p, a) <= thresholdDays)).length;
          evidence = {
            inFlight: unidentified === 0 && unpatched === 0 && unaddressed === 0 && stuck.length === 0,
            unaddressed,
            unpatched,
            unidentified,
          };
        }
      }
      const unreadEvidence = needEvidence && truncated;
      if (unreadEvidence) {
        console.log(`security-pr-stuck: ${repo.name} has ${ALERTS_PAGE}+ critical/high alerts; not read as in-flight evidence`);
      }

      if (stuck.length === 0) return { finding: null, evidence, unread: unreadEvidence };

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
          // Recorded, never used to drop a PR (G12's rule): Dependabot PRs a
          // human rebased or reopened keep the branch, and gating on the login
          // would blind the detector the day that login changes.
          verified: pr.user?.login === DEPENDABOT_LOGIN,
        });
      }

      return {
        finding: {
          type: 'security-pr-stuck',
          repo: repo.name,
          stuckPRs,
          // Never 'high' on its own: the urgency already lives on the companion
          // open-vulnerability finding, which this finding stops being downgraded
          // (governance.js). Raising both would double-count one alert on the
          // attention banner.
          priority: 'medium',
        },
        evidence,
        unread: unreadEvidence,
      };
    } catch (err) {
      // Every failure is logged with its status, not just 403/404: a silent
      // 500 here used to read as "nothing stuck" and, worse, would have read as
      // "no evidence needed". Public repos only, so naming them is fine.
      console.log(`security-pr-stuck: skipping ${repo.name} (status ${err?.status ?? 'n/a'}: ${String(err?.message ?? err).slice(0, 80)})`);
      return { finding: null, evidence: null, unread: true };
    }
  }));

  const out = { findings: [], fixEvidence: {}, unread: [] };
  eligibleRepos(repos).forEach((repo, i) => {
    const r = results[i];
    if (!r) return;
    if (r.finding) out.findings.push(r.finding);
    if (r.evidence) out.fixEvidence[repo.name] = r.evidence;
    if (r.unread) out.unread.push(repo.name);
  });
  // Stable order: findings feed the governance-weekly diffs and the dashboard.
  out.findings.sort((a, b) => a.repo.localeCompare(b.repo));
  out.unread.sort();
  return out;
}

/**
 * The findings alone — detectSecurityFixState for callers that need no
 * in-flight evidence.
 * @returns {Promise<Array>} findings of type 'security-pr-stuck'
 */
export async function detectStuckSecurityPRs(gh, owner, repos, options = {}) {
  return (await detectSecurityFixState(gh, owner, repos, options)).findings;
}
