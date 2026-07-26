// Delivery channel for governance findings that must not be published.
//
// repo-butler is itself a PUBLIC repo, which means all three of its normal
// output sinks are world-readable: the GitHub Pages dashboard, the
// repo-butler-data snapshot branch, and the Actions run logs. A private repo's
// name reaching any of them is a permanent disclosure — caches and forks make
// it unfixable after the fact.
//
// So findings for private repos are withheld from every one of those sinks
// (see observe.js's public/private split and store.publishableFindings) and
// delivered here instead: as one tracking issue ON the private repo itself.
// Private-to-private, lands in the owner's normal notifications, and needs no
// new infrastructure.
//
// Every log line in this module counts repos and never names them, for the same
// reason. That is a hard rule, not a stylistic one.

const TRACKING_TITLE = 'Repo Butler: open governance findings';

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Build the tracking-issue body for one private repo's findings.
 * Pure and exported so the formatting is testable without a gh fixture.
 *
 * @param {string} repo repo name (safe here — the body lands on that repo)
 * @param {Array} findings findings already filtered to this repo
 * @param {string} stamp ISO timestamp for the "last checked" line
 * @returns {string} issue body
 */
export function buildPrivateFindingsBody(repo, findings, stamp) {
  const byType = new Map();
  for (const f of findings) {
    const key = f.type || 'unknown';
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(f);
  }

  const lines = [
    `Repo Butler monitors this repository but cannot publish anything about it.`,
    '',
    `\`${repo}\` is private, so its findings are withheld from the portfolio dashboard,`,
    'the `repo-butler-data` branch and the workflow logs — all of which are public.',
    'This issue is the delivery channel instead. It is rewritten in place on each run,',
    'so it always reflects the latest check rather than accumulating history.',
    '',
    `**${findings.length} open finding${findings.length === 1 ? '' : 's'}** as of ${stamp}.`,
    '',
  ];

  for (const [type, group] of [...byType.entries()].sort()) {
    lines.push(`## ${type} (${group.length})`);
    lines.push('');
    const sorted = [...group].sort((a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
    for (const f of sorted) {
      const sev = f.severity ? `\`${f.severity}\` ` : '';
      const detail = f.detail || f.description || f.title || '(no detail recorded)';
      lines.push(`- ${sev}${detail}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Closing this issue is safe — the next run reopens or recreates it while findings remain.');
  lines.push('It disappears on its own once there is nothing left to report.');

  return lines.join('\n');
}

/**
 * Find this repo's existing tracking issue, if any.
 *
 * Uses the issues LIST endpoint rather than the search API: search is limited to
 * 30 req/min as a secondary rate limit, while list is on the 5000/hr budget —
 * the same reasoning as the report module's chart fetchers.
 *
 * GitHub's issues list includes pull requests, so `pull_request` is filtered out
 * before title matching.
 */
async function findTrackingIssue(gh, owner, repo) {
  const issues = await gh.paginate(`/repos/${owner}/${repo}/issues`, {
    params: { state: 'open', per_page: 100 },
    max: 200,
  });
  return issues.find(i => !i.pull_request && i.title === TRACKING_TITLE) || null;
}

/**
 * Deliver withheld private-repo findings to each private repo as one tracking
 * issue, rewritten in place.
 *
 * Best-effort per repo: a failure on one repo is recorded and the rest proceed,
 * because a notification failure must never fail the governance phase that
 * produced correct findings.
 *
 * @param {object} gh client from createClient
 * @param {string} owner
 * @param {Array} findings ALL findings; private ones are selected here
 * @param {{dryRun?: boolean, stamp?: string}} options
 * @returns {Promise<{notified: number, created: number, updated: number, closed: number, errors: number}>}
 */
export async function notifyPrivateFindings(gh, owner, findings, options = {}) {
  const { dryRun = true, stamp = new Date().toISOString() } = options;
  const result = { notified: 0, created: 0, updated: 0, closed: 0, errors: 0 };

  if (!Array.isArray(findings)) return result;
  const priv = findings.filter(f => f?.private && f?.repo);
  if (priv.length === 0) return result;

  const byRepo = new Map();
  for (const f of priv) {
    if (!byRepo.has(f.repo)) byRepo.set(f.repo, []);
    byRepo.get(f.repo).push(f);
  }

  if (dryRun) {
    console.log(`Private findings: ${priv.length} across ${byRepo.size} private repo(s) — dry run, no issue written.`);
    return { ...result, notified: byRepo.size };
  }

  for (const [repo, repoFindings] of byRepo) {
    try {
      const existing = await findTrackingIssue(gh, owner, repo);
      const body = buildPrivateFindingsBody(repo, repoFindings, stamp);

      if (existing) {
        await gh.request(`/repos/${owner}/${repo}/issues/${existing.number}`, {
          method: 'PATCH',
          body: { body },
        });
        result.updated++;
      } else {
        await gh.request(`/repos/${owner}/${repo}/issues`, {
          method: 'POST',
          body: { title: TRACKING_TITLE, body },
        });
        result.created++;
      }
      result.notified++;
    } catch {
      // Deliberately does not log the error text: GitHub error bodies echo the
      // request path, which contains the private repo name, into public logs.
      result.errors++;
    }
  }

  console.log(`Private findings: ${result.notified} private repo(s) notified (${result.created} created, ${result.updated} updated, ${result.errors} errors).`);
  return result;
}

/**
 * Close a private repo's tracking issue once it has no findings left, so the
 * channel goes quiet rather than leaving a stale issue open.
 *
 * @param {object} gh
 * @param {string} owner
 * @param {Array<string>} privateRepoNames every private repo the butler saw
 * @param {Array} findings ALL findings from this run
 * @param {{dryRun?: boolean}} options
 * @returns {Promise<number>} count of issues closed
 */
export async function closeResolvedPrivateIssues(gh, owner, privateRepoNames, findings, options = {}) {
  const { dryRun = true } = options;
  if (!Array.isArray(privateRepoNames) || privateRepoNames.length === 0) return 0;

  const withFindings = new Set(
    (Array.isArray(findings) ? findings : []).filter(f => f?.private && f?.repo).map(f => f.repo),
  );
  const clean = privateRepoNames.filter(name => !withFindings.has(name));
  if (clean.length === 0) return 0;

  if (dryRun) {
    console.log(`Private findings: ${clean.length} private repo(s) now clean — dry run, no issue closed.`);
    return 0;
  }

  let closed = 0;
  for (const repo of clean) {
    try {
      const existing = await findTrackingIssue(gh, owner, repo);
      if (!existing) continue;
      await gh.request(`/repos/${owner}/${repo}/issues/${existing.number}`, {
        method: 'PATCH',
        body: { state: 'closed' },
      });
      closed++;
    } catch {
      // Same reasoning as above — error text can carry the repo name.
    }
  }
  if (closed > 0) console.log(`Private findings: closed ${closed} resolved tracking issue(s).`);
  return closed;
}
