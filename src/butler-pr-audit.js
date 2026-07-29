// Butler PR audit (G12, "the Gold ratchet's companion") — detects the butler's
// OWN pull requests going stale on target repos.
//
// The gap this closes: the butler opens a remediation PR and then forgets it.
// `github-issue-triage-bot` #169 was opened 2026-07-13 to close a
// `release-cadence` standards gap and sat blocked for twelve days behind a
// repo-wide CI failure, while the standards-gap finding stayed open — correctly
// reporting the gap, with the fix for it rotting three feet away. Nothing
// connected the two. The same blindness covers the quieter case: `lounge-tv` #21
// sat green, mergeable and simply ignored for over a fortnight.
//
// Deliberately NOT in scope for v1 — blame attribution. An earlier design
// compared this PR's failing check names against sibling PRs to tell
// "broken by its own content" from "repo-wide breakage". `prCiHistory`'s
// `failing` holds workflow RUN names, and most repos here run a single workflow
// called `CI`, so the comparison would return "overlap" almost always while
// costing several extra API calls per PR. It reports PERSISTENCE instead, which
// is the signal an operator acts on ("a rebase will not fix this"), via the
// already-tested isDeterministicFailure().

import { REPO_EXCLUSION_PATTERNS } from './report-shared.js';
import { APPLY_PR_MARKER, isDeterministicFailure } from './apply.js';

const BRANCH_PREFIX = 'repo-butler/';

// Staleness is per class, because the cadences differ.
//   apply   — apply-scheduled.yml is a WEEKLY cron ('0 5 * * 0'), so anything
//             under ~14d would fire on every PR that merely missed one run.
//   onboard — one-off courtesy PR on someone else's repo; a month is fair.
//   roadmap — EXCLUDED, see isAuditableClass below.
const THRESHOLD_DAYS = { apply: 14, onboard: 30 };

// At most this many PRs per repo get the (API-costly) CI classification. A repo
// with more stale butler PRs than this is itself the finding; the remainder are
// still reported, with state 'unclassified', so nothing is silently dropped.
const MAX_CLASSIFIED_PER_REPO = 3;

const DETERMINISTIC_ATTEMPTS = 3;

/**
 * Which butler workflow opened this PR, from its branch name.
 * @returns {'apply'|'onboard'|'roadmap-update'|null}
 */
export function classifyButlerBranch(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(BRANCH_PREFIX)) return null;
  const rest = ref.slice(BRANCH_PREFIX.length);
  if (rest.startsWith('apply-')) return 'apply';
  if (rest === 'onboard') return 'onboard';
  if (rest.startsWith('roadmap-update-')) return 'roadmap-update';
  return null;
}

// roadmap-update PRs are excluded from staleness by construction. UPDATE
// force-pushes a fresh commit onto the SAME PR every pipeline run, and
// self-test.yml runs `observe,assess,update,governance,report` — so GOVERNANCE
// always reads a head SHA that is minutes old with CI still in flight. Auditing
// them would emit a permanently-wrong "blocked" row about the butler's own repo
// four times a day, and their age never resets, so the row could never clear.
function isAuditableClass(prClass) {
  return prClass === 'apply' || prClass === 'onboard';
}

// Identity is recorded, never used to drop a PR. The branch prefix is the
// primary locator: it is butler-controlled naming and survives an App rename,
// whereas gating on the bot login would silently blind this detector the moment
// the App slug changed — the exact failure mode G12 exists to catch. The marker
// corroborates (free: the /pulls list payload already carries `body` and
// `labels`), and an unmarked branch is surfaced with verified:false rather than
// dropped, because a branch impersonating the butler is itself worth seeing.
function isVerified(pr) {
  const body = typeof pr?.body === 'string' ? pr.body : '';
  if (body.includes(APPLY_PR_MARKER)) return true;
  const labels = Array.isArray(pr?.labels)
    ? pr.labels.map(l => (typeof l === 'string' ? l : l?.name))
    : [];
  return labels.includes('governance-apply');
}

// Map the CI state to what a human should do about it. The green/not-green call
// always comes from the quad-state prCiState (never prCiGreen, which collapses
// 'red', 'pending', 'none' and 'error' into one false); prCiHistory only NAMES a
// failure, and it fails open, so it can add detail but can never turn a blocked
// PR into an all-clear.
async function classifyPR(gh, owner, repo, pr) {
  const state = await gh.prCiState(owner, repo, pr.head?.sha);

  if (state === 'green') return { state: 'awaiting-human', failing: [] };
  if (state === 'none') return { state: 'ci-none', failing: [] };
  if (state === 'pending') return { state: 'ci-pending', failing: [] };
  if (state !== 'red') return { state: 'unknown', failing: [] };

  const history = await gh.prCiHistory(owner, repo, pr.head?.ref, { attempts: DETERMINISTIC_ATTEMPTS });
  const persistent = isDeterministicFailure(history, DETERMINISTIC_ATTEMPTS);
  return {
    state: persistent ? 'blocked-persistent' : 'blocked-transient',
    failing: history?.[0]?.failing || [],
  };
}

/**
 * Audit portfolio repos for the butler's own stale PRs.
 *
 * Never throws: a per-repo failure yields null and is filtered out, matching
 * auditDependabot. This matters because runGovernance would otherwise lose the
 * WHOLE phase's output — `writeGovernanceFindings` would not run and the data
 * branch would keep serving the previous run's findings.
 *
 * @param {object} gh — GitHub API client (createClient return)
 * @param {string} owner
 * @param {Array} repos — portfolio repos from observePortfolio()
 * @param {{ openPRs?: Object }} [options] — pre-fetched `{ repoName: prs[] }` map.
 *   auditDependabot already sweeps the identical `/pulls?state=open` list for
 *   every eligible repo; passing its result here avoids running that sweep twice
 *   per pipeline run, 4x/day. Omit it and each repo is listed on demand.
 * @returns {Promise<Array>} findings of type 'stale-butler-pr'
 */
export async function auditButlerPRs(gh, owner, repos, { openPRs = null } = {}) {
  if (!Array.isArray(repos)) return [];

  const eligible = repos.filter(r =>
    !r.archived && !r.fork && !REPO_EXCLUSION_PATTERNS.some(p => r.name.includes(p))
  );

  const now = Date.now();

  const results = await Promise.all(eligible.map(async (repo) => {
    try {
      const prs = openPRs?.[repo.name] ?? await gh.paginate(`/repos/${owner}/${repo.name}/pulls`, {
        params: { state: 'open', sort: 'created', direction: 'asc' },
        max: 100,
      });
      if (!Array.isArray(prs)) return null;

      const stale = [];
      for (const pr of prs) {
        const prClass = classifyButlerBranch(pr?.head?.ref);
        if (!isAuditableClass(prClass)) continue;
        const age = Math.floor((now - new Date(pr.created_at).getTime()) / 86400000);
        // Negated `>` rather than `<=`, and deliberately so: an unparseable
        // created_at makes `age` NaN, and every NaN comparison is false — so
        // this form SKIPS such a PR, where `age <= threshold` would let it
        // through and report a PR of unknown age as stale.
        if (!(age > THRESHOLD_DAYS[prClass])) continue;
        stale.push({ pr, prClass, age });
      }

      if (stale.length === 0) return null;

      // Oldest first: the worst offender is the one worth classifying and the
      // one a reader should see at the top of the row.
      stale.sort((a, b) => b.age - a.age);

      const stalePRs = [];
      for (const [i, { pr, prClass, age }] of stale.entries()) {
        const classification = i < MAX_CLASSIFIED_PER_REPO
          ? await classifyPR(gh, owner, repo.name, pr)
          : { state: 'unclassified', failing: [] };
        stalePRs.push({
          number: pr.number,
          age,
          branch: pr.head?.ref,
          prClass,
          draft: pr.draft === true,
          verified: isVerified(pr),
          author: pr.user?.login ?? null,
          ...classification,
        });
      }

      return {
        type: 'stale-butler-pr',
        repo: repo.name,
        stalePRs,
        // Priority is a pure function of nothing but "this is stale", and is
        // never 'high': computePortfolioState flips the entire dashboard to
        // `attention` on any high-priority finding, and a butler PR waiting to
        // be merged is not an open critical CVE. Keeping it off 'high' also
        // means a transient unreadable CI state can neither inflate nor mute it.
        priority: 'medium',
      };
    } catch (err) {
      if (err.message?.includes(': 403') || err.message?.includes(': 404')) {
        console.log(`butler-pr-audit: skipping ${repo.name} (${err.message.slice(0, 80)})`);
      }
      return null;
    }
  }));

  // Stable order: findings feed the governance-weekly diffs and the dashboard,
  // so unstable ordering would make week-over-week comparisons noisy.
  return results.filter(Boolean).sort((a, b) => a.repo.localeCompare(b.repo));
}
