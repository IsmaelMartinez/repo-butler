// Governance-lane repo eligibility and the shared open-PR read (#416).
//
// A leaf module on purpose: governance.js imports the three audits
// (dependabot-audit, butler-pr-audit, stalled-alert), so they cannot import
// governance.js back. Keeping these helpers here is what lets all four share one
// copy. It must never import governance.js or any of the audits.
//
// Onboard, report-portfolio-data.js and observe filter repos differently on purpose;
// this predicate is for the governance lane only.

import { isExcludedRepo } from './report-shared.js';

/**
 * Filter repos to governance-eligible ones: not archived, not a fork, not
 * private, and not a test/shadow repo. Also used by the cross-repo PROPOSE
 * routing gate (ADR-011 defence in depth) via governance.js's re-export.
 *
 * `!r.private` is defence in depth: private repos arrive separately as
 * `portfolio.privateRepos` and never enter the governance pipeline (see the
 * private-repo section of AGENTS.md and the guard in governance.test.js), so a
 * private repo reaching this filter is already a bug upstream.
 */
export function eligibleRepos(repos) {
  return repos.filter(r => !r.archived && !r.fork && !r.private && !isExcludedRepo(r.name));
}

/**
 * A repo's open PRs, oldest first: from the pre-fetched `{ repoName: prs[] }`
 * map (governance.fetchOpenPRs) when it holds the repo, otherwise listed on
 * demand. A missing or null map entry falls back to the listing; an empty array
 * is trusted. Listing errors propagate to the caller's per-repo handling.
 */
export async function listOpenPRs(gh, owner, repoName, openPRs = null) {
  return openPRs?.[repoName] ?? gh.paginate(`/repos/${owner}/${repoName}/pulls`, {
    params: { state: 'open', sort: 'created', direction: 'asc' },
    max: 100,
  });
}
