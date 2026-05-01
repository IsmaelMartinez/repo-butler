// Dependabot stale PR audit — detects unmerged Dependabot PRs older than 30
// days across portfolio repos. Returns findings in the standard governance shape
// for integration into the IDEATE prompt and governance dashboard.

import { REPO_EXCLUSION_PATTERNS } from './report-shared.js';

const STALE_THRESHOLD_DAYS = 30;
const HIGH_PRIORITY_DAYS = 60;

/**
 * Audit portfolio repos for stale Dependabot PRs.
 * @param {object} gh — GitHub API client (createClient return)
 * @param {string} owner — repo owner
 * @param {Array} repos — portfolio repos from observePortfolio()
 * @returns {Array} findings of type 'dependabot-stale'
 */
export async function auditDependabot(gh, owner, repos) {
  const eligible = repos.filter(r =>
    !r.archived && !r.fork && !REPO_EXCLUSION_PATTERNS.some(p => r.name.includes(p))
  );

  const now = Date.now();

  const results = await Promise.all(eligible.map(async (repo) => {
    try {
      const prs = await gh.paginate(`/repos/${owner}/${repo.name}/pulls`, {
        params: { state: 'open', sort: 'created', direction: 'asc' },
        max: 100,
      });

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
      if (err.message?.includes(': 403') || err.message?.includes(': 404')) {
        console.log(`dependabot-audit: skipping ${repo.name} (${err.message.slice(0, 80)})`);
      }
      return null;
    }
  }));

  return results.filter(Boolean);
}
