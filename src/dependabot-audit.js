// Dependabot stale PR audit — detects unmerged Dependabot PRs older than 30
// days across portfolio repos. Returns findings in the standard governance shape
// for integration into the IDEATE prompt and governance dashboard.

import { eligibleRepos, listOpenPRs } from './governance-repos.js';

const STALE_THRESHOLD_DAYS = 30;
const HIGH_PRIORITY_DAYS = 60;

/**
 * Audit portfolio repos for stale Dependabot PRs.
 * @param {object} gh — GitHub API client (createClient return)
 * @param {string} owner — repo owner
 * @param {Array} repos — portfolio repos from observePortfolio()
 * @param {{ openPRs?: Object }} [options] — pre-fetched `{ repoName: prs[] }` map
 *   (governance.js fetchOpenPRs). Optional and backwards compatible: omit it and
 *   each repo is listed on demand exactly as before. It exists so this audit and
 *   the butler-PR audit, which read the identical open-PR list, do not sweep it
 *   twice on every pipeline run.
 * @returns {Array} findings of type 'dependabot-stale'
 */
export async function auditDependabot(gh, owner, repos, { openPRs = null } = {}) {
  const eligible = eligibleRepos(repos);

  const now = Date.now();

  const results = await Promise.all(eligible.map(async (repo) => {
    try {
      const prs = await listOpenPRs(gh, owner, repo.name, openPRs);

      const stalePRs = [];
      for (const pr of prs) {
        if (pr.user?.login !== 'dependabot[bot]') continue;
        const age = Math.floor((now - new Date(pr.created_at).getTime()) / 86400000);
        if (age > STALE_THRESHOLD_DAYS) {
          stalePRs.push({ number: pr.number, title: pr.title, age });
        }
      }

      if (stalePRs.length === 0) return null;

      const maxAge = Math.max(...stalePRs.map(p => p.age));
      return {
        type: 'dependabot-stale',
        repo: repo.name,
        stalePRs,
        priority: maxAge > HIGH_PRIORITY_DAYS ? 'high' : 'medium',
      };
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        console.log(`dependabot-audit: skipping ${repo.name} (${err.message.slice(0, 80)})`);
      }
      return null;
    }
  }));

  return results.filter(Boolean);
}
