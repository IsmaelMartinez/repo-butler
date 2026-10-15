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
// The branch name is not the whole story for npm (#500): a version-update PR
// can lift the root copy above the patch while a pinned, nested copy in the
// same lockfile stays vulnerable, so merging it would not close the alert. Every
// npm match is therefore confirmed against the lockfile AT THE PR'S HEAD with
// lockfile-update.js's own `not-patched` rule (lockfileCopiesPatched), and a
// lockfile that cannot be read or ordered leaves the match UNVERIFIED — no
// evidence, and no stuck claim. Other ecosystems keep the branch-name rule:
// their manifests pin one version per package, and no reader exists for them.
//
// Known misses, all failing CLOSED (no evidence, so no downgrade; no stuck
// finding): GitHub Actions alerts — their manifest is a workflow file, so the
// alert directory never equals the branch's action path and an Actions bump
// never counts as a fix; prerelease or suffixed versions, which the local
// comparator refuses to read; and grouped or multi-hash branches, which name no
// package.
//
// DETECTION ONLY — no write of any kind, same as G13. A per-repo STATE finding
// routed to executor 'manual'; it never reaches the templated-PR path or
// cross-repo PROPOSE (ADR-002/ADR-011 lane boundary).

import { eligibleRepos, listOpenPRs } from './governance-repos.js';
import { alertDirectory, branchNamesAlertPackage, isSameRepoPR } from './stalled-alert.js';
import { sameReleaseLine } from './trimmer.js';
import { getLargeFileContent } from './github.js';
import { lockfileCopiesPatched, npmLockfilePath } from './lockfile-update.js';

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

// Fractional days. The recency and stuck gates compare this unrounded value —
// flooring first stretched the 3-day window to just under four (84h floors to
// 3, so "recent") — and only the emitted display age is floored.
const daysSince = (iso, now) => (now - new Date(iso).getTime()) / 86400000;


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
  // The local dotted parser, not trimmer's three-part parseVersion: pip's
  // `from 5.4 to 6.0` is a major bump and must not read as unknown.
  const asLine = (v) => {
    const p = parseDottedVersion(v);
    return p ? { major: p[0], minor: p[1] ?? 0 } : null;
  };
  const from = asLine(m[1]);
  const to = asLine(m[2]);
  if (!from || !to) return null;
  return !sameReleaseLine(from, to);
}

// A version this module will COMPARE: dot-separated non-negative integers and
// nothing else, fully anchored, any number of parts (pip's `5.4`, rubygems'
// `6.1.7.1`). Anything else — a prerelease, a suffix, a range — is unparseable.
// Deliberately local: trimmer.js parseVersion is three-part-or-null and its
// tolerance is tuned for the ADR-013/015 gates; reusing it here read `5.4` as
// unparseable and `6.1.7.1` as `6.1.7`.
export function parseDottedVersion(v) {
  const str = String(v ?? '').trim();
  if (!/^\d+(?:\.\d+)*$/.test(str)) return null;
  return str.split('.').map(Number);
}

// Missing trailing parts read as 0, so `5.4` equals `5.4.0`.
export function compareDottedVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The qualifying alerts this branch definitely fixes: the branch names the
 * alert's package and directory, and bumps to at least the first patched
 * version. FAILS CLOSED: a missing or unparseable version on either side is
 * not a fix. Both consumers assert something from a match — a stuck fix exists,
 * or a fix is in flight (which lowers a priority) — so "cannot tell" must never
 * count as "yes".
 */
function alertsFixedBy(ref, alerts) {
  return alerts.filter(a => {
    const hit = branchNamesAlertPackage(ref, a);
    if (!hit) return false;
    const to = parseDottedVersion(hit.version);
    const patched = parseDottedVersion(a.patchedVersion);
    return to !== null && patched !== null && compareDottedVersions(to, patched) >= 0;
  });
}

/**
 * Does this PR's lockfile confirm the branch-name match for this alert? Only
 * npm alerts are checked (see the header): for every other ecosystem the
 * strict branch match already passed and stands, so this returns 'fixes'.
 *
 * For npm: read the alert directory's package-lock.json at the PR's head SHA
 * (getLargeFileContent: the Contents API, then the blob API above its 1 MB
 * inline ceiling, null only for a genuine 404) and require EVERY copy of the
 * package at or above first_patched_version — lockfile-update.js's
 * `not-patched` rule, reused, not re-derived. Reads are cached per
 * (repo, sha, path) in `cache` for the run, so a PR matching several alerts in
 * one directory costs one read.
 *
 * Never throws. Returns:
 *   'fixes'       every copy patched (or a non-npm ecosystem)
 *   'not-fixed'   the lockfile was read and a copy is still below the patch,
 *                 or the package is absent from it
 *   'unverified'  no head SHA, no knowable package-lock.json path (yarn, pnpm,
 *                 a missing manifest path), absent, unreadable, or unorderable
 */
async function verifyFixAtHead(gh, owner, repoName, p, alert, cache) {
  if (alert.ecosystem !== 'npm') return 'fixes';
  const sha = p.pr?.head?.sha;
  if (typeof sha !== 'string' || sha === '' || !alert.lockfilePath) return 'unverified';
  const key = `${repoName}\0${sha}\0${alert.lockfilePath}`;
  if (!cache.has(key)) {
    cache.set(key, getLargeFileContent(gh, owner, repoName, alert.lockfilePath, { ref: sha }).catch(err => {
      // Status only: the error text can carry the path and the response body.
      // Public repos only (eligibleRepos), so naming the repo is fine.
      console.log(`security-pr-stuck: lockfile at PR #${p.pr?.number ?? '?'} head unreadable in ${repoName} (status ${err?.status ?? 'n/a'}); match left unverified`);
      return null;
    }));
  }
  const text = await cache.get(key);
  if (text === null) return 'unverified';
  const verdict = lockfileCopiesPatched(text, alert.package, alert.patchedVersion);
  return verdict === 'patched' ? 'fixes' : verdict === 'not-patched' ? 'not-fixed' : 'unverified';
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
 *   fixEvidence[repo] = { inFlight, unaddressed, unpatched, unidentified,
 *   unverified } for each evidence
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
        // Only a PR into the default branch can resolve an alert, which GitHub
        // raises against the default branch: a fresh `target-branch: develop`
        // version update must not count as the fix for `main`. An unknown
        // default branch matches nothing — no evidence, no stuck claim.
        .filter(pr => typeof pr?.head?.ref === 'string' && pr.head.ref.startsWith(BRANCH_PREFIX) && isSameRepoPR(pr)
          && typeof repo.default_branch === 'string' && pr.base?.ref === repo.default_branch)
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
          // npm only; null when the alert's lockfile is not a knowable
          // package-lock.json, which leaves every npm match unverified.
          lockfilePath: a.dependency?.package?.ecosystem === 'npm' ? npmLockfilePath(a.dependency?.manifest_path) : null,
          severity: a.security_vulnerability?.severity || a.security_advisory?.severity || null,
          patchedVersion: a.security_vulnerability?.first_patched_version?.identifier ?? null,
          alertAge: daysSince(a.created_at, now),
        }))
        .filter(a => a.package && QUALIFYING_SEVERITIES.has(a.severity));

      // How long a PR has been available as the fix for an alert: a PR older
      // than the alert (a version update that predates the advisory) has only
      // been "the fix" since the alert opened.
      const fixAge = (p, a) => Math.min(p.prAge, a.alertAge);

      // Per-run lockfile reads, keyed by (repo, head sha, path).
      const lockCache = new Map();
      const verify = (p, a) => verifyFixAtHead(gh, owner, repo.name, p, a, lockCache);

      // Alerts (by identity, not number: a missing number must not merge two)
      // that a relevant PR (an old one past the stuck bar, or a recent
      // one offered as evidence) names but whose lockfile could not confirm.
      const unverifiedAlerts = new Set();

      const stuck = [];
      for (const p of old) {
        const named = alertsFixedBy(p.ref, alerts);
        if (named.length === 0) continue;
        // A stuck claim ASSERTS a fix exists, so only a match the lockfile
        // confirms counts; a PR that leaves a nested copy vulnerable is not
        // the fix, and one we cannot read is not claimed either way.
        const fixes = [];
        for (const a of named) {
          const v = await verify(p, a);
          if (v === 'fixes') fixes.push(a);
          else if (v === 'unverified' && fixAge(p, a) > thresholdDays) unverifiedAlerts.add(a);
        }
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
          evidence = { inFlight: null, liveAlertsMissing: true, unaddressed: 0, unpatched: 0, unidentified: 0, unverified: 0 };
        } else {
          const unidentified = raw.length - alerts.length;
          const unpatched = alerts.filter(a => !a.patchedVersion).length;
          // Recency is the PR's OWN age, not fixAge: fixAge forgives an old PR
          // for a new alert so it is not "stuck" on day one, but a PR that has
          // sat open for weeks is not evidence that a fix is landing — a 40-day
          // version update meeting a 1-day alert would otherwise downgrade it.
          //
          // A recent PR addresses an alert only if its lockfile confirms the
          // fix (verifyFixAtHead). One the lockfile REFUTES is no evidence and
          // the alert is unaddressed, a definite gap. One that cannot be read
          // leaves the alert UNVERIFIED.
          const unaddressedAlerts = new Set();
          for (const a of alerts) {
            if (!a.patchedVersion) continue;
            let status = 'unaddressed';
            for (const p of dependabotPRs) {
              if (!(p.prAge <= thresholdDays) || alertsFixedBy(p.ref, [a]).length !== 1) continue;
              const v = await verify(p, a);
              if (v === 'fixes') { status = 'addressed'; break; }
              if (v === 'unverified') status = 'unverified';
            }
            if (status === 'unaddressed') unaddressedAlerts.add(a);
            else if (status === 'unverified') unverifiedAlerts.add(a);
          }
          const unaddressed = unaddressedAlerts.size;
          // An alert a recent PR verifiably fixes is still UNVERIFIED when an
          // older PR for it (past the stuck bar) could not be read: "no fix is
          // stuck" was never established for it. An unaddressed alert is a
          // definite gap, so it is counted there and not here.
          const unverified = [...unverifiedAlerts].filter(a => !unaddressedAlerts.has(a)).length;
          const definiteGap = unidentified > 0 || unpatched > 0 || unaddressed > 0 || stuck.length > 0;
          evidence = {
            // null, not false, for an unverified lockfile: false is a positive
            // claim ("autofix is on and NOT landing a fix", surfaced as such by
            // the dashboard and MCP via isAutofixOnWithoutEvidence's wording and
            // the rationale's gap list), and an unread lockfile establishes
            // neither that the PR fixes the alert nor that it does not. That is
            // the same call this function already makes for an alerts read
            // that verified nothing (liveAlertsMissing). Both null and false
            // withhold the downgrade, so the choice cannot lower a priority;
            // it only keeps the record honest. A definite gap elsewhere still
            // wins: one refuted or missing fix is enough to say false.
            inFlight: definiteGap ? false : unverified > 0 ? null : true,
            unaddressed,
            unpatched,
            unidentified,
            unverified,
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
          age: Math.floor(age),
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
