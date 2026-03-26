// REPORT phase: generate HTML dashboard reports from observation data.
// Produces two reports: per-repo (target repo) and portfolio (all repos).

import { createClient } from './github.js';
import { observe, observePortfolio, computeBusFactor, computeTimeToCloseMedian } from './observe.js';
import { computeSnapshotHash } from './store.js';
import { computeTrends } from './assess.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SIX_MONTHS_AGO = new Date(Date.now() - 180 * 86400000);
const ONE_YEAR_AGO = new Date(Date.now() - 365 * 86400000);

const TIER_DISPLAY = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze', none: 'Unranked' };
const TIER_COLORS = { gold: '#ffd700', silver: '#c0c0c0', bronze: '#cd7f32', none: '#6e7681' };

export async function report(context) {
  const { owner, token, config, store } = context;
  const outDir = process.env.REPORT_OUTPUT_DIR || 'reports';

  // Auto-run observe if no snapshot exists (standalone report phase).
  if (!context.snapshot) {
    console.log('No snapshot — running OBSERVE first...');
    context.snapshot = await observe(context);
    context.portfolio = await observePortfolio(context);
  }

  // Cache check: skip regeneration if snapshot hasn't changed.
  const currentHash = store ? computeSnapshotHash(context.snapshot) : null;
  if (store && !context.forceReport) {
    const lastHash = await store.readLastHash();
    if (currentHash === lastHash) {
      console.log('No changes since last report — skipping regeneration');
      return { cached: true };
    }
  }

  const { snapshot, portfolio } = context;

  await mkdir(outDir, { recursive: true });

  const gh = createClient(token);

  // Gather portfolio-level data.
  const repoDetails = portfolio
    ? await fetchPortfolioDetails(gh, owner, portfolio.repos)
    : null;

  // Analyze dependency inventory from SBOM data.
  const depInventory = repoDetails ? analyzeDependencyInventory(repoDetails) : null;

  // Generate portfolio report as the landing page.
  if (portfolio && repoDetails) {
    const portfolioHtml = generatePortfolioReport(owner, portfolio, repoDetails, null, depInventory);
    await writeFile(join(outDir, 'index.html'), portfolioHtml);
    console.log('Portfolio report written to index.html');

    // Generate narrative weekly digest.
    const digestHtml = generateDigestReport(owner, portfolio.repos, repoDetails);
    await writeFile(join(outDir, 'digest.html'), digestHtml);
    console.log('Weekly digest written to digest.html');

    // Persist weekly portfolio summaries for per-repo trend charts.
    if (store) {
      await store.writePortfolioWeekly(portfolio, repoDetails);
    }
  }

  // Generate per-repo reports for active repos with meaningful activity.
  if (portfolio) {
    const activeRepos = portfolio.repos
      .filter(r => !r.archived && !r.fork && !r.name.includes('shadow') && !r.name.includes('test-repo'))
      .sort((a, b) => (repoDetails?.[b.name]?.commits || 0) - (repoDetails?.[a.name]?.commits || 0));

    for (const r of activeRepos) {
      const commits = repoDetails?.[r.name]?.commits || 0;
      console.log(`Generating report for ${r.name} (${commits} commits)...`);

      if (commits >= 10) {
        // Full report with charts — fetch monthly data.
        const [prResult, issueActivity, prAuthors, openPRs, weeklyCommits] = await Promise.all([
          fetchMonthlyPRActivity(gh, owner, r.name),
          fetchMonthlyIssueActivity(gh, owner, r.name),
          fetchPRAuthors(gh, owner, r.name),
          fetchOpenPRs(gh, owner, r.name),
          fetchWeeklyCommits(gh, owner, r.name),
        ]);
        const { monthly: prActivity, mergedPRs: mergedPRsRaw } = prResult;
        const cycleTime = computePRCycleTime(mergedPRsRaw);

        // Fetch releases, open issues, closed issues, and Phase 1 health data.
        const [releases, openIssues, closedIssues, meta, communityProfile] = await Promise.all([
          gh.paginate(`/repos/${owner}/${r.name}/releases`, { max: 20 }).catch(() => []),
          gh.paginate(`/repos/${owner}/${r.name}/issues`, { params: { state: 'open' }, max: 100 })
            .then(issues => issues.filter(i => !i.pull_request))
            .catch(() => []),
          gh.paginate(`/repos/${owner}/${r.name}/issues`, { params: { state: 'closed', since: daysAgoISO(90), sort: 'updated', direction: 'desc' }, max: 200 })
            .then(issues => issues.filter(i => !i.pull_request).map(i => ({ created_at: i.created_at, closed_at: i.closed_at })))
            .catch(() => []),
          gh.request(`/repos/${owner}/${r.name}`).catch(() => null),
          gh.request(`/repos/${owner}/${r.name}/community/profile`)
            .then(d => ({
              health_percentage: d.health_percentage,
              files: {
                readme: !!d.files?.readme, license: !!d.files?.license,
                contributing: !!d.files?.contributing, code_of_conduct: !!d.files?.code_of_conduct,
                issue_template: !!d.files?.issue_template, pull_request_template: !!d.files?.pull_request_template,
              },
            }))
            .catch(() => null),
        ]);

        // Use Phase 1 data from fetchPortfolioDetails where available.
        const details = repoDetails?.[r.name];
        const mergedPRsForBusFactor = prAuthors.flatMap(a => Array.from({ length: a.count }, () => ({ author: a.author })));

        const repoSnapshot = {
          repository: `${owner}/${r.name}`,
          meta: meta ? {
            stars: meta.stargazers_count, forks: meta.forks_count,
            watchers: meta.subscribers_count, default_branch: meta.default_branch,
          } : { stars: r.stars, forks: r.forks },
          issues: {
            open: openIssues.map(i => ({
              number: i.number, title: i.title, labels: i.labels.map(l => l.name),
              reactions: i.reactions?.total_count || 0, comments: i.comments,
              created_at: i.created_at, updated_at: i.updated_at,
            })),
          },
          releases: releases.map(rel => ({
            tag: rel.tag_name, published_at: rel.published_at, prerelease: rel.prerelease,
          })),
          pushed_at: r.pushed_at,
          license: meta?.license?.spdx_id || details?.license || null,
          community_profile: communityProfile,
          dependabot_alerts: details?.vulns || null,
          ci_pass_rate: details?.ciPassRate != null ? { pass_rate: details.ciPassRate, total_runs: 0, passed: 0, failed: 0 } : null,
          sbom: details?.sbom || null,
          summary: {
            open_issues: openIssues.length,
            blocked_issues: openIssues.filter(i => i.labels.some(l => l.name === 'blocked')).length,
            awaiting_feedback: openIssues.filter(i => i.labels.some(l => l.name.includes('feedback'))).length,
            recently_merged_prs: prActivity.reduce((s, m) => s + m.count, 0),
            human_prs: prAuthors.filter(a => !a.author.includes('[bot]')).reduce((s, a) => s + a.count, 0),
            bot_prs: prAuthors.filter(a => a.author.includes('[bot]')).reduce((s, a) => s + a.count, 0),
            releases: releases.length,
            latest_release: releases[0]?.tag_name || 'none',
            ci_workflows: details?.ci || 0,
            bus_factor: computeBusFactor(mergedPRsForBusFactor),
            time_to_close_median: computeTimeToCloseMedian(closedIssues),
          },
        };

        // Compute per-repo trends from portfolio weekly history.
        let repoTrends = null;
        if (r.name === context.repo && context.trends) {
          repoTrends = context.trends;
        } else if (store) {
          try {
            const repoHistory = await store.readRepoWeeklyHistory(r.name);
            if (repoHistory.length >= 2) {
              repoTrends = computeTrends(repoHistory);
            }
          } catch {
            // Trend data unavailable for this repo — not critical.
          }
        }
        const dashboardUrl = context.triageBot?.dashboardUrl || null;
        const repoDepSummary = depInventory?.repoSummaries?.[r.name] || null;
        const html = generateRepoReport(repoSnapshot, prActivity, issueActivity, prAuthors, repoTrends, dashboardUrl, openPRs, cycleTime, weeklyCommits, repoDepSummary);
        await writeFile(join(outDir, `${r.name}.html`), html);
      } else {
        // Lightweight report — just metadata, no search API calls.
        const html = generateLightRepoReport(owner, r, repoDetails?.[r.name]);
        await writeFile(join(outDir, `${r.name}.html`), html);
      }
    }

    console.log(`Generated reports for ${activeRepos.length} repos.`);

    // Generate SVG health badges for each active repo and portfolio overall.
    const badgeDir = join(outDir, 'badges');
    await mkdir(badgeDir, { recursive: true });

    const tierOrder = { gold: 3, silver: 2, bronze: 1, none: 0 };
    let tierSum = 0;
    let scoredCount = 0;

    for (const r of activeRepos) {
      const d = repoDetails?.[r.name] || {};
      const classified = { ...r, ...d };
      const { tier } = computeHealthTier(classified);
      const svg = generateHealthBadge(r.name, tier);
      await writeFile(join(badgeDir, `${r.name}.svg`), svg);
      const pushed = new Date(r.pushed_at);
      const isActive = pushed >= SIX_MONTHS_AGO && !r.fork && !r.name.includes('shadow') && !r.name.includes('test-repo');
      if (isActive) {
        tierSum += tierOrder[tier] || 0;
        scoredCount++;
      }
    }

    // Portfolio-level badge: best representative tier across active repos.
    const avgTierNum = scoredCount > 0 ? Math.round(tierSum / scoredCount) : 0;
    const portfolioTier = avgTierNum >= 3 ? 'gold' : avgTierNum >= 2 ? 'silver' : avgTierNum >= 1 ? 'bronze' : 'none';
    const portfolioSvg = generateHealthBadge('portfolio', portfolioTier);
    await writeFile(join(badgeDir, 'portfolio.svg'), portfolioSvg);

    console.log(`Generated badges for ${activeRepos.length} repos + portfolio.`);
  }

  // Persist hash after successful generation.
  if (store && currentHash) {
    await store.writeHash(currentHash);
  }

  return { outDir };
}


// --- Data fetchers for charts ---

async function fetchMonthlyPRActivity(gh, owner, repo) {
  const since = daysAgoISO(365);
  const prs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
    params: { state: 'closed', sort: 'updated', direction: 'desc' },
    max: 500,
  });
  const merged = prs.filter(pr => pr.merged_at && pr.merged_at >= since);
  const months = last12Months();
  const monthly = months.map(({ label, start, end }) => ({
    month: label,
    count: merged.filter(pr => pr.merged_at >= start && pr.merged_at < end).length,
  }));
  const mergedPRs = merged.map(pr => ({ created_at: pr.created_at, merged_at: pr.merged_at }));
  return { monthly, mergedPRs };
}

async function fetchMonthlyIssueActivity(gh, owner, repo) {
  const since = daysAgoISO(365);
  const [created, closed] = await Promise.all([
    gh.paginate(`/repos/${owner}/${repo}/issues`, {
      params: { state: 'all', since, sort: 'created', direction: 'desc' },
      max: 500,
    }).then(items => items.filter(i => !i.pull_request)),
    gh.paginate(`/repos/${owner}/${repo}/issues`, {
      params: { state: 'closed', since, sort: 'updated', direction: 'desc' },
      max: 500,
    }).then(items => items.filter(i => !i.pull_request)),
  ]);
  const months = last12Months();
  return months.map(({ label, start, end }) => ({
    month: label,
    opened: created.filter(i => i.created_at >= start && i.created_at < end).length,
    closed: closed.filter(i => i.closed_at && i.closed_at >= start && i.closed_at < end).length,
  }));
}

async function fetchPRAuthors(gh, owner, repo) {
  const since = daysAgoISO(90);
  const prs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
    params: { state: 'closed', sort: 'updated', direction: 'desc' },
    max: 200,
  });
  const merged = prs.filter(pr => pr.merged_at && pr.merged_at >= since);
  const counts = {};
  for (const pr of merged) {
    const author = pr.user?.login || 'unknown';
    counts[author] = (counts[author] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count);
}

async function fetchOpenPRs(gh, owner, repo) {
  try {
    const prs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
      params: { state: 'open', sort: 'updated', direction: 'desc' },
      max: 200,
    });
    const now = Date.now();
    return prs.map(pr => {
      const ageDays = Math.floor((now - new Date(pr.created_at).getTime()) / 86400000);
      const hasReviewRequested = (pr.requested_reviewers?.length > 0) || (pr.requested_teams?.length > 0);
      const isDraft = pr.draft;
      const labels = pr.labels?.map(l => l.name) || [];
      const isBot = pr.user?.login?.includes('[bot]') || pr.user?.login?.startsWith('app/');
      return {
        number: pr.number,
        title: pr.title,
        author: pr.user?.login || 'unknown',
        age_days: ageDays,
        draft: isDraft,
        bot: isBot,
        labels,
        review_requested: hasReviewRequested,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
      };
    });
  } catch {
    return [];
  }
}

async function fetchWeeklyCommits(gh, owner, repo) {
  // Warm up the stats API, then fetch.
  try { await gh.request(`/repos/${owner}/${repo}/stats/participation`); } catch { /* warm-up */ }
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/stats/participation`);
    return data.owner?.slice(-26) || [];
  } catch {
    return [];
  }
}

async function fetchPortfolioDetails(gh, owner, repos) {
  const details = {};
  const activeRepos = repos.filter(r => !r.archived && !r.fork);

  // Fetch commit counts and weekly data for active repos (parallel, batched).
  const fetches = activeRepos.slice(0, 15).map(async (r) => {
    const [commits, weekly, license, ci, communityHealth, vulns, ciPassRate, openIssues, sbom, releasedAt] = await Promise.all([
      gh.request('/search/commits', {
        params: { q: `repo:${owner}/${r.name} committer-date:>${daysAgoISO(180)}`, per_page: 1 },
      }).then(d => d.total_count).catch(() => 0),
      gh.request(`/repos/${owner}/${r.name}/stats/participation`)
        .then(d => d.owner?.slice(-26) || [])
        .catch(() => []),
      gh.request(`/repos/${owner}/${r.name}`)
        .then(d => d.license?.spdx_id || 'None')
        .catch(() => 'None'),
      gh.request(`/repos/${owner}/${r.name}/actions/workflows`)
        .then(d => d.total_count || 0)
        .catch(() => 0),
      gh.request(`/repos/${owner}/${r.name}/community/profile`)
        .then(d => d.health_percentage ?? null)
        .catch(() => null),
      gh.request(`/repos/${owner}/${r.name}/dependabot/alerts?state=open&per_page=100`)
        .then(alerts => {
          const count = alerts.length;
          let maxSeverity = null;
          const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
          for (const a of alerts) {
            const sev = a.security_vulnerability?.severity || a.security_advisory?.severity;
            if (sev && (maxSeverity === null || (severityOrder[sev] || 0) > (severityOrder[maxSeverity] || 0))) {
              maxSeverity = sev;
            }
          }
          return { count, max_severity: maxSeverity };
        })
        .catch(() => null),
      gh.request(`/repos/${owner}/${r.name}/actions/runs?status=completed&per_page=100`)
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
      gh.paginate(`/repos/${owner}/${r.name}/issues`, { params: { state: 'open' }, max: 200 })
        .then(issues => issues.filter(i => !i.pull_request).length)
        .catch(() => r.open_issues || 0),
      fetchSBOM(gh, owner, r.name),
      gh.paginate(`/repos/${owner}/${r.name}/releases`, { max: 1 })
        .then(rels => rels[0]?.published_at ?? null)
        .catch(() => null),
    ]);
    details[r.name] = { commits, weekly, license, ci, communityHealth, vulns, ciPassRate, open_issues: openIssues, sbom, released_at: releasedAt };
  });

  await Promise.all(fetches);
  return details;
}


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

const COPYLEFT_LICENSES = new Set([
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
  'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MPL-2.0', 'EUPL-1.2',
  'GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0',
]);

function isCopyleft(license) {
  if (!license) return false;
  // SPDX expressions can use AND/OR, parentheses, and WITH exceptions.
  return license
    .replace(/[()]/g, '')
    .split(/\s+(?:AND|OR)\s+/)
    .map(part => part.replace(/\s+WITH\s+.+$/, '').trim())
    .some(part => COPYLEFT_LICENSES.has(part));
}

function analyzeDependencyInventory(details) {
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
        licenseFlags.push({ name: pkg.name, license: pkg.license });
      }
    }
    repoSummaries[repoName] = { depCount: d.sbom.count, licenseFlags };
  }

  const sharedEntries = Object.entries(depUsage).filter(([, v]) => v.repos.size > 1);
  const sharedDepsTotal = sharedEntries.length;

  const commonDeps = [...sharedEntries]
    .sort((a, b) => b[1].repos.size - a[1].repos.size)
    .slice(0, 20)
    .map(([, v]) => ({ name: v.name, repoCount: v.repos.size, licenses: [...v.licenses] }));

  const allLicenseFlags = Object.entries(repoSummaries).flatMap(([repoName, summary]) =>
    summary.licenseFlags.map(flag => ({ repo: repoName, dep: flag.name, license: flag.license }))
  );

  const totalUnique = Object.keys(depUsage).length;
  const reposWithSBOM = Object.values(details).filter(d => d.sbom).length;

  return { commonDeps, sharedDepsTotal, licenseFlags: allLicenseFlags, totalUnique, reposWithSBOM, repoSummaries };
}

// --- Cycle time ---

function computePRCycleTime(mergedPRs) {
  if (!mergedPRs || mergedPRs.length === 0) return null;
  const durations = mergedPRs
    .map(pr => (new Date(pr.merged_at) - new Date(pr.created_at)) / (1000 * 60 * 60))
    .filter(h => h >= 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const mid = Math.floor(durations.length / 2);
  const median_hours = durations.length % 2 === 1
    ? durations[mid]
    : (durations[mid - 1] + durations[mid]) / 2;
  const p90Index = Math.ceil(durations.length * 0.9) - 1;
  const p90_hours = durations[Math.min(p90Index, durations.length - 1)];
  return { median_hours, p90_hours, sample_size: durations.length };
}

function buildCycleTimeCard(cycleTime) {
  if (!cycleTime) return '';
  const h = cycleTime.median_hours;
  const color = h < 24 ? '#7ee787' : h < 48 ? '#d29922' : '#f85149';
  const label = h < 24 ? 'elite' : h < 48 ? 'good' : 'needs attention';
  const display = h < 1 ? '<1h' : h < 24 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)}d`;
  const p90 = cycleTime.p90_hours;
  const p90Display = p90 < 1 ? '<1h' : p90 < 24 ? `${Math.round(p90)}h` : `${(p90 / 24).toFixed(1)}d`;
  return `<div class="grid">
  <div class="card"><h3>PR Cycle Time (median)</h3><div class="stat" style="color:${color}">${display}</div><div class="stat-label">${label} — p90: ${p90Display} — n=${cycleTime.sample_size}</div></div>
</div>`;
}

// --- HTML generators ---

function generateRepoReport(snapshot, prActivity, issueActivity, prAuthors, trends, dashboardUrl, openPRs = [], cycleTime = null, weeklyCommits = [], depSummary = null) {
  const s = snapshot.summary;
  const releases = snapshot.releases || [];
  const labels = snapshot.issues?.open
    ? countBy(snapshot.issues.open.flatMap(i => i.labels))
    : [];

  const prMonths = prActivity.map(m => `'${m.month}'`).join(',');
  const prCounts = prActivity.map(m => m.count).join(',');
  const issueMonths = issueActivity.map(m => `'${m.month}'`).join(',');
  const issueOpened = issueActivity.map(m => m.opened).join(',');
  const issueClosed = issueActivity.map(m => m.closed).join(',');

  const maintainer = prAuthors.find(a => !a.author.includes('[bot]'));
  const botPRs = prAuthors.filter(a => a.author.includes('[bot]')).reduce((s, a) => s + a.count, 0);
  const communityPRs = prAuthors.filter(a => !a.author.includes('[bot]') && a.author !== maintainer?.author).reduce((s, a) => s + a.count, 0);

  const relData = releases.slice(0, 20).map(r => ({
    tag: r.tag, date: r.published_at?.split('T')[0] || '',
  }));
  const relDays = relData.map((r, i) => {
    if (i === 0) return 0;
    return Math.round((new Date(relData[i - 1].date) - new Date(r.date)) / 86400000);
  });

  const labelEntries = Object.entries(countBy(snapshot.issues?.open?.flatMap(i => i.labels) || []))
    .sort(([, a], [, b]) => b - a);
  const labelNames = labelEntries.map(([n]) => `'${n}'`).join(',');
  const labelCounts = labelEntries.map(([, c]) => c).join(',');
  const labelColors = labelEntries.map(([n]) => {
    if (n === 'bug') return "'#f85149'";
    if (n.includes('feedback')) return "'#d29922'";
    if (n === 'blocked') return "'#ff6b7c'";
    if (n === 'enhancement') return "'#a2eeef'";
    return "'#388bfd'";
  }).join(',');

  const now = new Date().toISOString().split('T')[0];

  // Build trends chart section if we have 2+ weeks of data.
  const hasTrends = trends && trends.weeks && trends.weeks.length >= 2;
  const trendsHtml = hasTrends ? `
<h2>Trends <span style="font-size:0.8rem;color:${trends.direction === 'growing' ? '#f85149' : trends.direction === 'shrinking' ? '#7ee787' : '#8b949e'}">(issues ${trends.direction})</span></h2>
<div class="chart-container"><div class="chart-title">Weekly Trends — Open Issues</div><canvas id="trendsChart"></canvas></div>` : '';

  const hasMergedPrData = hasTrends && trends.weeks.some(w => w.merged_prs > 0);
  const mergedPrDataset = hasMergedPrData ? `,{label:'Merged PRs',data:[${trends.weeks.map(w => w.merged_prs).join(',')}],borderColor:'#388bfd',backgroundColor:'rgba(56,139,253,0.1)',fill:true,tension:0.3,pointRadius:4,yAxisID:'y1'}` : '';
  const mergedPrScale = hasMergedPrData ? `,y1:{type:'linear',position:'right',beginAtZero:true,grid:{drawOnChartArea:false},title:{display:true,text:'Merged PRs'}}` : '';
  const trendsJs = hasTrends ? `
new Chart(document.getElementById('trendsChart'),{type:'line',data:{labels:[${trends.weeks.map(w => `'${w.week}'`).join(',')}],datasets:[{label:'Open Issues',data:[${trends.weeks.map(w => w.open_issues).join(',')}],borderColor:'#f85149',backgroundColor:'rgba(248,81,73,0.1)',fill:true,tension:0.3,pointRadius:4,yAxisID:'y'}${mergedPrDataset}]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{y:{type:'linear',position:'left',beginAtZero:true,grid:{color:'#21262d'},title:{display:true,text:'Open Issues'}}${mergedPrScale},x:{grid:{display:false}}}}});` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${snapshot.repository} — Health Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"></script>
${CSS}
</head>
<body>
<h1><a href="https://github.com/${snapshot.repository}" class="repo-link">${snapshot.repository} <svg height="24" width="24" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a></h1>
<div class="subtitle">Project Health Report — ${now} — <a href="index.html">portfolio view</a> — <a href="digest.html">weekly digest</a></div>
<div class="grid">
  <div class="card"><h3>Stars</h3><div class="stat">${fmt(snapshot.meta?.stars)}</div><div class="stat-label">${snapshot.meta?.forks} forks, ${snapshot.meta?.watchers} watchers</div></div>
  <div class="card"><h3>Open Issues</h3><div class="stat">${s.open_issues}</div><div class="stat-label">${s.blocked_issues} blocked, ${s.awaiting_feedback} awaiting feedback</div></div>
  <div class="card"><h3>PRs Merged (90d)</h3><div class="stat">${s.recently_merged_prs}</div><div class="stat-label">${s.human_prs} human, ${s.bot_prs} bot</div></div>
  <div class="card"><h3>Releases</h3><div class="stat">${s.releases}</div><div class="stat-label">Latest: ${s.latest_release}</div></div>
</div>
${buildActionabilitySection(snapshot, openPRs)}
${buildHealthTierSection(snapshot)}
${buildVelocityAlert(detectVelocityImbalance(issueActivity))}
${buildHealthSection(snapshot, depSummary)}
${buildPRTriageSection(openPRs, snapshot.repository)}
${buildStalenessSection(snapshot)}
<h2>Development Velocity</h2>
${buildCycleTimeCard(cycleTime)}
<div class="chart-container"><div class="chart-title">Merged PRs per Month</div><canvas id="prChart"></canvas></div>
<div class="chart-container"><div class="chart-title">Issues Opened vs Closed per Month</div><canvas id="issueChart"></canvas></div>
<h2>Release Cadence</h2>
<div class="chart-container"><div class="chart-title">Days Between Releases</div><canvas id="releaseChart"></canvas></div>
${buildCalendarHeatmap(weeklyCommits)}
<h2>Contribution & Issues</h2>
<div class="two-col">
  <div class="chart-container"><div class="chart-title">PR Authors (90d)</div><canvas id="authorChart"></canvas></div>
  <div class="chart-container"><div class="chart-title">Open Issues by Label</div><canvas id="labelChart"></canvas></div>
</div>
${trendsHtml}
<div class="footer">Generated by <a href="https://github.com/IsmaelMartinez/repo-butler">repo-butler</a>${dashboardUrl ? ` — <a href="${dashboardUrl}">live triage dashboard</a>` : ''}</div>
<script>
Chart.defaults.color='#8b949e';Chart.defaults.borderColor='#21262d';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,monospace';
new Chart(document.getElementById('prChart'),{type:'bar',data:{labels:[${prMonths}],datasets:[{label:'Merged PRs',data:[${prCounts}],backgroundColor:'rgba(56,139,253,0.7)',borderRadius:4}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
new Chart(document.getElementById('issueChart'),{type:'line',data:{labels:[${issueMonths}],datasets:[{label:'Opened',data:[${issueOpened}],borderColor:'#f85149',backgroundColor:'rgba(248,81,73,0.1)',fill:true,tension:0.3,pointRadius:4},{label:'Closed',data:[${issueClosed}],borderColor:'#7ee787',backgroundColor:'rgba(126,231,135,0.1)',fill:true,tension:0.3,pointRadius:4}]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
new Chart(document.getElementById('releaseChart'),{type:'bar',data:{labels:[${relData.map(r => `'${r.tag}'`).join(',')}],datasets:[{label:'Days',data:[${relDays.join(',')}],backgroundColor:'rgba(126,231,135,0.7)',borderRadius:3}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'},title:{display:true,text:'Days'}},x:{ticks:{maxRotation:45},grid:{display:false}}}}});
new Chart(document.getElementById('authorChart'),{type:'doughnut',data:{labels:['${maintainer?.author||"maintainer"}','Bots','Community'],datasets:[{data:[${maintainer?.count||0},${botPRs},${communityPRs}],backgroundColor:['rgba(56,139,253,0.8)','rgba(139,148,158,0.6)','rgba(126,231,135,0.7)'],borderColor:'#161b22',borderWidth:2}]},options:{responsive:true,plugins:{legend:{position:'bottom'}}}});
new Chart(document.getElementById('labelChart'),{type:'bar',data:{labels:[${labelNames}],datasets:[{data:[${labelCounts}],backgroundColor:[${labelColors}],borderRadius:4}]},options:{indexAxis:'y',responsive:true,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,grid:{color:'#21262d'}},y:{grid:{display:false}}}}});${trendsJs}
</script></body></html>`;
}

export function generateSparklineSVG(weeklyData) {
  const WIDTH = 80;
  const HEIGHT = 20;
  const PADDING = 2;
  const STROKE_COLOR = '#388bfd';
  const STROKE_WIDTH = 1.5;
  const MUTED_OPACITY = 0.4;

  if (!weeklyData || !Array.isArray(weeklyData) || weeklyData.length === 0) return '';

  const svgOpen = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">`;
  const svgClose = '</svg>';

  if (weeklyData.length === 1) {
    // Single point — draw a dot in the center.
    return `${svgOpen}<circle cx="${WIDTH / 2}" cy="${HEIGHT / 2}" r="2" fill="${STROKE_COLOR}"/>${svgClose}`;
  }
  const max = Math.max(...weeklyData);
  if (max === 0) {
    // All zeros — flat line at the bottom.
    const y = HEIGHT - PADDING;
    return `${svgOpen}<line x1="0" y1="${y}" x2="${WIDTH}" y2="${y}" stroke="${STROKE_COLOR}" stroke-width="${STROKE_WIDTH}" opacity="${MUTED_OPACITY}"/>${svgClose}`;
  }
  const h = HEIGHT - PADDING * 2;
  const step = WIDTH / (weeklyData.length - 1);
  const points = weeklyData.map((v, i) => {
    const x = Math.round(i * step * 100) / 100;
    const y = Math.round((PADDING + h - (v / max) * h) * 100) / 100;
    return `${x},${y}`;
  }).join(' ');
  return `${svgOpen}<polyline points="${points}" fill="none" stroke="${STROKE_COLOR}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>${svgClose}`;
}

function generatePortfolioReport(owner, portfolio, details, mainWeekly, depInventory = null) {
  const repos = portfolio.repos
    .filter(r => !r.archived)
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  const totalStars = repos.reduce((s, r) => s + r.stars, 0);
  const totalForks = repos.reduce((s, r) => s + r.forks, 0);
  const totalCommits = Object.values(details).reduce((s, d) => s + (d.commits || 0), 0);
  const totalIssues = repos.reduce((s, r) => s + (r.open_issues || 0), 0);

  const now = new Date().toISOString().split('T')[0];

  function status(r) {
    if (r.fork) return 'fork';
    if (r.name.includes('shadow') || r.name.includes('test-repo')) return 'test';
    const pushed = new Date(r.pushed_at);
    if (pushed < ONE_YEAR_AGO) return 'archive';
    if (pushed < SIX_MONTHS_AGO) return 'dormant';
    return 'active';
  }

  const classified = repos.map(r => ({ ...r, status: status(r), ...(details[r.name] || {}) }));
  const statusCounts = countBy(classified.map(r => r.status));
  const langCounts = countBy(repos.map(r => r.language || 'None'));

  // Weekly commit data for stacked chart.
  const weekLabels = Array.from({ length: 26 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (25 - i) * 7);
    return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}`;
  });

  const topRepos = classified
    .filter(r => r.weekly && r.weekly.length > 0 && r.weekly.some(w => w > 0))
    .sort((a, b) => (b.commits || 0) - (a.commits || 0))
    .slice(0, 8);

  const chartColors = [
    'rgba(56,139,253,0.8)', 'rgba(126,231,135,0.8)', 'rgba(163,113,247,0.8)',
    'rgba(210,153,34,0.8)', 'rgba(248,81,73,0.8)', 'rgba(31,111,235,0.6)',
    'rgba(255,166,87,0.8)', 'rgba(139,148,158,0.6)',
  ];

  const weeklyDatasets = topRepos.map((r, i) =>
    `{label:'${r.name}',data:[${(r.weekly || []).join(',')}],backgroundColor:'${chartColors[i] || chartColors[7]}',borderRadius:1}`
  ).join(',');

  const tableRows = classified.map(r => {
    const badgeClass = { active: 'badge-active', dormant: 'badge-dormant', archive: 'badge-archive', fork: 'badge-fork', test: 'badge-test' }[r.status] || 'badge-active';
    const { tier } = computeHealthTier(r);
    const communityColor = r.communityHealth == null ? '#6e7681' : r.communityHealth >= 80 ? '#7ee787' : r.communityHealth >= 50 ? '#d29922' : '#f85149';
    const vulnColor = r.vulns == null ? '#6e7681' : r.vulns.count === 0 ? '#7ee787' : r.vulns.max_severity === 'critical' || r.vulns.max_severity === 'high' ? '#f85149' : r.vulns.max_severity === 'medium' ? '#d29922' : '#7ee787';
    const ciPassColor = r.ciPassRate == null ? '#6e7681' : r.ciPassRate >= 0.9 ? '#7ee787' : r.ciPassRate >= 0.7 ? '#d29922' : '#f85149';
    return `<tr>
      <td><a href="${r.name}.html">${r.name}</a></td>
      <td>${r.description ? escHtml(r.description).slice(0, 50) : '—'}</td>
      <td>${r.language || '—'}</td><td>${r.stars}</td><td>${r.open_issues || 0}</td>
      <td>${r.commits || 0}</td><td>${generateSparklineSVG(details[r.name]?.weekly)}</td><td>${(r.ci || 0) > 0 ? r.ci : '<span style="color:#f85149">0</span>'}</td>
      <td>${!r.license || r.license === 'None' ? '<span style="color:#d29922">none</span>' : r.license}</td>
      <td><span style="color:${communityColor}">${r.communityHealth != null ? r.communityHealth + '%' : '—'}</span></td>
      <td><span style="color:${vulnColor}">${r.vulns != null ? r.vulns.count : '—'}</span></td>
      <td><span style="color:${ciPassColor}">${r.ciPassRate != null ? Math.round(r.ciPassRate * 100) + '%' : '—'}</span></td>
      <td>${r.sbom ? r.sbom.count : '—'}</td>
      <td><span class="badge ${badgeClass}">${r.status}</span></td>
      <td><span class="tier-badge tier-${tier}">${TIER_DISPLAY[tier]}</span></td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${owner} — Portfolio Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"></script>
${CSS}
</head>
<body>
<h1><a href="https://github.com/${owner}" class="repo-link">@${owner} <svg height="24" width="24" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a></h1>
<div class="subtitle">GitHub Portfolio Health Report — ${now} — click any repo name for details — <a href="digest.html">weekly digest</a></div>
<div class="grid">
  <div class="card"><h3>Repos</h3><div class="stat">${repos.length}</div><div class="stat-label">${statusCounts.active || 0} active, ${(statusCounts.dormant || 0) + (statusCounts.archive || 0)} dormant/archive</div></div>
  <div class="card"><h3>Stars</h3><div class="stat">${fmt(totalStars)}</div></div>
  <div class="card"><h3>Commits (6mo)</h3><div class="stat">${fmt(totalCommits)}</div></div>
  <div class="card"><h3>Open Issues</h3><div class="stat">${totalIssues}</div></div>
</div>
<h2>Commit Activity (26 weeks)</h2>
<div class="chart-container"><div class="chart-title">Weekly Commits by Repository</div><canvas id="weeklyChart" style="max-height:360px"></canvas></div>
<h2>Portfolio Health</h2>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Description</th><th>Lang</th><th>Stars</th><th>Issues</th><th>Commits</th><th>Trend</th><th>CI</th><th>License</th><th>Community</th><th>Vulns</th><th>CI%</th><th>Deps</th><th>Status</th><th>Tier</th></tr></thead>
<tbody>${tableRows}</tbody></table>
</div>
<h2>Distribution</h2>
<div class="three-col">
  <div class="chart-container"><div class="chart-title">By Language</div><canvas id="langChart"></canvas></div>
  <div class="chart-container"><div class="chart-title">By Status</div><canvas id="statusChart"></canvas></div>
  <div class="chart-container"><div class="chart-title">Commit Totals (6mo)</div><canvas id="commitChart"></canvas></div>
</div>
${buildDependencyInventorySection(depInventory)}
<div class="footer">Generated by <a href="https://github.com/IsmaelMartinez/repo-butler">repo-butler</a></div>
<script>
Chart.defaults.color='#8b949e';Chart.defaults.borderColor='#21262d';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,monospace';
new Chart(document.getElementById('weeklyChart'),{type:'bar',data:{labels:[${weekLabels.map(l => `'${l}'`).join(',')}],datasets:[${weeklyDatasets}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{padding:10,font:{size:10}}}},scales:{x:{stacked:true,grid:{display:false},ticks:{maxRotation:45,font:{size:9}}},y:{stacked:true,beginAtZero:true,grid:{color:'#21262d'}}}}});
new Chart(document.getElementById('langChart'),{type:'doughnut',data:{labels:[${Object.entries(langCounts).map(([n, c]) => `'${n} (${c})'`).join(',')}],datasets:[{data:[${Object.values(langCounts).join(',')}],backgroundColor:['#f1e05a','#3178c6','#00ADD8','#3572A5','#fcb32c','#6e7681','#e34c26','#8957e5'],borderColor:'#161b22',borderWidth:2}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{font:{size:10}}}}}});
new Chart(document.getElementById('statusChart'),{type:'doughnut',data:{labels:[${Object.entries(statusCounts).map(([n, c]) => `'${n} (${c})'`).join(',')}],datasets:[{data:[${Object.values(statusCounts).join(',')}],backgroundColor:['#238636','#8957e5','#da3633','#6e7681','#1f6feb'],borderColor:'#161b22',borderWidth:2}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{font:{size:10}}}}}});
const commitRepos=${JSON.stringify(classified.filter(r => r.commits > 0).sort((a, b) => b.commits - a.commits).map(r => ({ name: r.name, commits: r.commits })))};
new Chart(document.getElementById('commitChart'),{type:'bar',data:{labels:commitRepos.map(r=>r.name.length>18?r.name.slice(0,16)+'…':r.name),datasets:[{data:commitRepos.map(r=>r.commits),backgroundColor:commitRepos.map(r=>r.commits>300?'rgba(56,139,253,0.8)':r.commits>100?'rgba(126,231,135,0.7)':'rgba(139,148,158,0.5)'),borderRadius:4}]},options:{indexAxis:'y',responsive:true,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,grid:{color:'#21262d'}},y:{grid:{display:false}}}}});
</script></body></html>`;
}


// --- Narrative weekly digest ---

export function generateDigestReport(owner, repos, repoDetails) {
  const now = new Date().toISOString().split('T')[0];
  const sixMonthsAgo = daysAgo(180);
  const oneYearAgo = daysAgo(365);

  const CI_CONCERN_THRESHOLD = 0.8;
  const CI_ALERT_THRESHOLD = 0.7;
  const ISSUE_HEAVY_MIN = 5;
  const TOP_N = 5;

  // Classify repos the same way as the portfolio report.
  const active = repos.filter(r => {
    if (r.archived || r.fork) return false;
    if (r.name.includes('shadow') || r.name.includes('test-repo')) return false;
    return new Date(r.pushed_at) >= sixMonthsAgo;
  });

  const enriched = active.map(r => ({
    ...r,
    commits: repoDetails[r.name]?.commits || 0,
    weekly: repoDetails[r.name]?.weekly || [],
    vulns: repoDetails[r.name]?.vulns || null,
    ciPassRate: repoDetails[r.name]?.ciPassRate ?? null,
    open_issues: repoDetails[r.name]?.open_issues ?? r.open_issues ?? 0,
  }));

  // Compute recent week activity from the weekly participation array (last entry = most recent week).
  const recentCommits = enriched
    .filter(r => r.weekly.length > 0 && r.weekly[r.weekly.length - 1] > 0)
    .sort((a, b) => b.weekly[b.weekly.length - 1] - a.weekly[a.weekly.length - 1]);

  // Most active repos by 6-month commits.
  const mostActive = enriched
    .filter(r => r.commits > 0)
    .sort((a, b) => b.commits - a.commits)
    .slice(0, TOP_N);

  // Repos with vulnerability alerts.
  const vulnRepos = enriched
    .filter(r => r.vulns && r.vulns.count > 0)
    .sort((a, b) => b.vulns.count - a.vulns.count);

  // Repos with CI concerns (pass rate below threshold).
  const ciConcerns = enriched
    .filter(r => r.ciPassRate != null && r.ciPassRate < CI_CONCERN_THRESHOLD)
    .sort((a, b) => a.ciPassRate - b.ciPassRate);

  // Repos with many open issues.
  const issueHeavy = enriched
    .filter(r => r.open_issues > ISSUE_HEAVY_MIN)
    .sort((a, b) => b.open_issues - a.open_issues)
    .slice(0, TOP_N);

  // Dormant repos (pushed between 6mo and 1y ago, not archived).
  const dormant = repos.filter(r => {
    if (r.archived || r.fork) return false;
    const pushed = new Date(r.pushed_at);
    return pushed < sixMonthsAgo && pushed >= oneYearAgo;
  });

  // Summary stats.
  const totalCommits = enriched.reduce((s, r) => s + r.commits, 0);
  const totalIssues = enriched.reduce((s, r) => s + r.open_issues, 0);
  const totalVulns = vulnRepos.reduce((s, r) => s + r.vulns.count, 0);

  // Build digest cards.
  const cards = [];

  // Opening summary card.
  cards.push(buildDigestCard(
    'This Week at a Glance',
    `${active.length} active repos across your portfolio with ${fmt(totalCommits)} commits in the last 6 months ` +
    `and ${totalIssues} open issues.` +
    (recentCommits.length > 0 ? ` ${recentCommits.length} repos saw commits this week.` : '') +
    (totalVulns > 0 ? ` ${totalVulns} vulnerability alerts need attention.` : ''),
    'summary',
  ));

  // Most active repos card.
  if (mostActive.length > 0) {
    const lines = mostActive.map(r =>
      `<tr><td><a href="${r.name}.html">${escHtml(r.name)}</a></td><td>${r.commits}</td>` +
      `<td>${r.weekly.length > 0 ? r.weekly[r.weekly.length - 1] : 0}</td></tr>`
    ).join('');
    cards.push(buildDigestCard(
      'Most Active Repos',
      `<table><thead><tr><th>Repo</th><th>Commits (6mo)</th><th>This Week</th></tr></thead><tbody>${lines}</tbody></table>`,
      'activity',
    ));
  }

  // Vulnerability alerts card.
  if (vulnRepos.length > 0) {
    const lines = vulnRepos.map(r => {
      const sevClass = r.vulns.max_severity === 'critical' || r.vulns.max_severity === 'high' ? 'text-alert' : 'text-warning';
      return `<tr><td><a href="${r.name}.html">${escHtml(r.name)}</a></td>` +
        `<td class="${sevClass}">${r.vulns.count} (${r.vulns.max_severity || 'unknown'})</td></tr>`;
    }).join('');
    cards.push(buildDigestCard(
      'Vulnerability Alerts',
      `<table><thead><tr><th>Repo</th><th>Open Alerts</th></tr></thead><tbody>${lines}</tbody></table>`,
      'alert',
    ));
  }

  // CI concerns card.
  if (ciConcerns.length > 0) {
    const lines = ciConcerns.map(r =>
      `<tr><td><a href="${r.name}.html">${escHtml(r.name)}</a></td>` +
      `<td class="${r.ciPassRate < CI_ALERT_THRESHOLD ? 'text-alert' : 'text-warning'}">${Math.round(r.ciPassRate * 100)}%</td></tr>`
    ).join('');
    cards.push(buildDigestCard(
      'CI Pass Rate Concerns',
      `<table><thead><tr><th>Repo</th><th>Pass Rate</th></tr></thead><tbody>${lines}</tbody></table>`,
      'alert',
    ));
  }

  // Open issues needing attention card.
  if (issueHeavy.length > 0) {
    const lines = issueHeavy.map(r =>
      `<tr><td><a href="${r.name}.html">${escHtml(r.name)}</a></td><td>${r.open_issues}</td></tr>`
    ).join('');
    cards.push(buildDigestCard(
      'Repos With Most Open Issues',
      `<table><thead><tr><th>Repo</th><th>Open Issues</th></tr></thead><tbody>${lines}</tbody></table>`,
      'issues',
    ));
  }

  // Dormant repos card.
  if (dormant.length > 0) {
    const lines = dormant.map(r =>
      `<tr><td><a href="${r.name}.html">${escHtml(r.name)}</a></td>` +
      `<td>${r.pushed_at?.split('T')[0] || 'unknown'}</td></tr>`
    ).join('');
    cards.push(buildDigestCard(
      'Dormant Repos',
      `${dormant.length} repos haven't seen a push in over 6 months.` +
      `<table style="margin-top:0.8rem"><thead><tr><th>Repo</th><th>Last Push</th></tr></thead><tbody>${lines}</tbody></table>`,
      'dormant',
    ));
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${owner} — Weekly Digest</title>
${CSS}
<style>
.digest-card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:1.5rem;margin-bottom:1.5rem;border-left:4px solid #30363d}
.digest-card.card-summary{border-left-color:#58a6ff}
.digest-card.card-activity{border-left-color:#7ee787}
.digest-card.card-alert{border-left-color:#f85149}
.digest-card.card-issues{border-left-color:#d29922}
.digest-card.card-dormant{border-left-color:#8b949e}
.digest-card h3{font-size:1rem;color:#f0f6fc;margin-bottom:0.8rem}
.digest-card p{color:#c9d1d9;font-size:0.9rem;line-height:1.6}
.digest-nav{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
.digest-nav a{color:#58a6ff;font-size:0.85rem}
.text-alert{color:#f85149}
.text-warning{color:#d29922}
</style>
</head>
<body>
<h1>Weekly Digest</h1>
<div class="subtitle">@${owner} portfolio recap — ${now}</div>
<div class="digest-nav"><a href="index.html">Portfolio Dashboard</a></div>
${cards.join('\n')}
<div class="footer">Generated by <a href="https://github.com/IsmaelMartinez/repo-butler">repo-butler</a></div>
</body></html>`;
}

function buildDigestCard(title, content, type) {
  return `<div class="digest-card card-${type}"><h3>${title}</h3><div>${content}</div></div>`;
}


// --- Helpers ---

function generateLightRepoReport(owner, repo, details) {
  const now = new Date().toISOString().split('T')[0];
  const pushed = repo.pushed_at?.split('T')[0] || 'unknown';
  const commits = details?.commits || 0;
  const ci = details?.ci || 0;
  const license = details?.license || 'None';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${owner}/${repo.name}</title>
${CSS}
</head>
<body>
<h1>${repo.name}</h1>
<div class="subtitle">${escHtml(repo.description || 'No description')} — ${now} — <a href="index.html">portfolio view</a></div>
<div class="grid">
  <div class="card"><h3>Language</h3><div class="stat stat-sm">${repo.language || '—'}</div></div>
  <div class="card"><h3>Stars</h3><div class="stat">${repo.stars}</div><div class="stat-label">${repo.forks} forks</div></div>
  <div class="card"><h3>Open Issues</h3><div class="stat">${repo.open_issues || 0}</div></div>
  <div class="card"><h3>Commits (6mo)</h3><div class="stat">${commits}</div></div>
  <div class="card"><h3>CI Workflows</h3><div class="stat">${ci}</div></div>
  <div class="card"><h3>Last Push</h3><div class="stat stat-sm">${pushed}</div></div>
</div>
<div class="chart-container" style="text-align:center;padding:3rem;color:#8b949e">
  This repo has fewer than 10 commits in the last 6 months.<br>
  Full charts are generated for repos with more activity.
</div>
<p style="text-align:center;margin-top:2rem"><a href="https://github.com/${owner}/${repo.name}">View on GitHub</a></p>
<div class="footer">Generated by <a href="https://github.com/IsmaelMartinez/repo-butler">repo-butler</a></div>
</body></html>`;
}

function last12Months() {
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const label = d.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
    months.push({
      label,
      start: d.toISOString().split('T')[0],
      end: next.toISOString().split('T')[0],
    });
  }
  return months;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

function daysAgoISO(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function countBy(arr) {
  const counts = {};
  for (const item of arr) counts[item] = (counts[item] || 0) + 1;
  return counts;
}

function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n || 0);
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Compute health tier for a classified repo object.
// Returns { tier: 'gold'|'silver'|'bronze'|'none', checks: [{ name, passed, required_for }] }
export function computeHealthTier(r) {
  const now = Date.now();
  const pushedAt = r.pushed_at ? new Date(r.pushed_at).getTime() : 0;
  const daysSincePush = pushedAt ? Math.floor((now - pushedAt) / 86400000) : Infinity;
  const releasedAt = r.released_at ? new Date(r.released_at).getTime() : 0;
  const daysSinceRelease = releasedAt ? Math.floor((now - releasedAt) / 86400000) : Infinity;

  const checks = [
    { name: 'Has CI workflows (2+)', passed: (r.ci || 0) >= 2, required_for: 'gold' },
    { name: 'Has a license', passed: !!(r.license && r.license !== 'None'), required_for: 'silver' },
    { name: 'Fewer than 10 open issues', passed: (r.open_issues || 0) < 10, required_for: 'gold' },
    { name: 'Release in the last 90 days', passed: daysSinceRelease <= 90, required_for: 'gold' },
    { name: 'Community health above 80%', passed: (r.communityHealth ?? -1) >= 80, required_for: 'gold' },
    { name: 'Dependabot/Renovate configured', passed: r.vulns != null, required_for: 'gold' },
    { name: 'Zero critical/high vulnerabilities', passed: r.vulns != null && r.vulns.max_severity !== 'critical' && r.vulns.max_severity !== 'high', required_for: 'gold' },
    { name: 'Has CI workflows', passed: (r.ci || 0) >= 1, required_for: 'silver' },
    { name: 'Community health above 50%', passed: (r.communityHealth ?? -1) >= 50, required_for: 'silver' },
    { name: 'Activity in the last 6 months', passed: daysSincePush <= 180, required_for: 'silver' },
    { name: 'Some activity (within 1 year)', passed: (r.commits || 0) > 0 || daysSincePush <= 365, required_for: 'bronze' },
  ];

  // Gold: all gold-required checks pass.
  const goldChecks = checks.filter(c => c.required_for === 'gold');
  const silverChecks = checks.filter(c => c.required_for === 'silver');
  const bronzeChecks = checks.filter(c => c.required_for === 'bronze');

  let tier;
  if (goldChecks.every(c => c.passed) && silverChecks.every(c => c.passed)) {
    tier = 'gold';
  } else if (silverChecks.every(c => c.passed)) {
    tier = 'silver';
  } else if (bronzeChecks.some(c => c.passed)) {
    tier = 'bronze';
  } else {
    tier = 'none';
  }

  return { tier, checks };
}

// Generate a shields.io-style flat SVG badge showing the health tier.
// Usage: ![health](https://ismaelmartinez.github.io/repo-butler/badges/{repo-name}.svg)
export function generateHealthBadge(repoName, tier) {
  const label = 'health';
  const value = TIER_DISPLAY[tier] || TIER_DISPLAY.none;
  const color = TIER_COLORS[tier] || TIER_COLORS.none;

  // Approximate text widths using 6.5px per character (Verdana 11px).
  const labelWidth = Math.round(label.length * 6.5) + 10;
  const valueWidth = Math.round(value.length * 6.5) + 10;
  const totalWidth = labelWidth + valueWidth;
  const labelX = labelWidth / 2;
  const valueX = labelWidth + valueWidth / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escHtml(repoName)}: ${label} ${value}">
  <title>${escHtml(repoName)}: ${label} ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelX}" y="14">${label}</text>
    <text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${valueX}" y="14">${value}</text>
  </g>
</svg>`;
}

const VELOCITY_ALERT_MONTHS = 3;
const VELOCITY_CRITICAL_MONTHS = 5;
const VELOCITY_CRITICAL_DEFICIT = 20;

function detectVelocityImbalance(issueActivity) {
  let consecutive = 0;
  let deficit = 0;
  for (let i = issueActivity.length - 1; i >= 0; i--) {
    const m = issueActivity[i];
    if (m.opened > m.closed) {
      consecutive++;
      deficit += m.opened - m.closed;
    } else {
      break;
    }
  }
  if (consecutive >= VELOCITY_ALERT_MONTHS) {
    return { alert: true, consecutive_months: consecutive, total_deficit: deficit };
  }
  return { alert: false };
}

function buildVelocityAlert(imbalance) {
  if (!imbalance.alert) return '';
  const critical = imbalance.consecutive_months >= VELOCITY_CRITICAL_MONTHS || imbalance.total_deficit > VELOCITY_CRITICAL_DEFICIT;
  const cls = critical ? ' alert-critical' : '';
  return `<div class="alert-banner${cls}">\u26a0\ufe0f Backlog pressure: issues opened have exceeded issues closed for ${imbalance.consecutive_months} consecutive months (deficit: +${imbalance.total_deficit})</div>`;
}

export function buildActionItems(snapshot, openPRs) {
  const items = [];
  const repo = snapshot.repository;
  const now = Date.now();

  // 1. Merge-ready PRs: not draft, not bot, no review requested (implies approved or no blockers).
  const mergeReady = (openPRs || []).filter(pr =>
    !pr.draft && !pr.bot && !pr.review_requested && pr.age_days >= 1
  );
  if (mergeReady.length > 0) {
    const refs = mergeReady.map(pr => `<a href="https://github.com/${repo}/pull/${pr.number}">#${pr.number}</a>`).join(', ');
    items.push({
      text: `Merge ${refs} — no review blockers`,
      effort: 'quick win',
      impact: 'high',
      priority: 1,
    });
  }

  // 2. Critical/high vulnerability alerts.
  const da = snapshot.dependabot_alerts;
  if (da && (da.critical > 0 || da.high > 0)) {
    const parts = [];
    if (da.critical > 0) parts.push(`${da.critical} critical`);
    if (da.high > 0) parts.push(`${da.high} high`);
    items.push({
      text: `Fix ${parts.join(', ')} <a href="https://github.com/${repo}/security/dependabot">vulnerability alerts</a>`,
      effort: 'moderate',
      impact: 'high',
      priority: 2,
    });
  }

  // 3. PRs awaiting review for > 7 days.
  const needsReview = (openPRs || []).filter(pr =>
    pr.review_requested && !pr.draft && !pr.bot && pr.age_days > 7
  );
  if (needsReview.length > 0) {
    const refs = needsReview.map(pr => {
      return `<a href="https://github.com/${repo}/pull/${pr.number}">#${pr.number}</a> (${pr.age_days}d)`;
    }).join(', ');
    items.push({
      text: `Review ${refs} — awaiting review`,
      effort: 'quick win',
      impact: 'medium',
      priority: 3,
    });
  }

  // 4. Stale awaiting-feedback issues (> 30 days since last update).
  const feedbackIssues = (snapshot.issues?.open || [])
    .filter(i => i.labels.some(l => l.includes('feedback')) && Math.floor((now - new Date(i.updated_at).getTime()) / 86400000) > 30);
  if (feedbackIssues.length > 0) {
    const refs = feedbackIssues.slice(0, 5).map(i =>
      `<a href="https://github.com/${repo}/issues/${i.number}">#${i.number}</a>`
    ).join(', ');
    const extra = feedbackIssues.length > 5 ? ` and ${feedbackIssues.length - 5} more` : '';
    items.push({
      text: `Close stale awaiting-feedback issues: ${refs}${extra}`,
      effort: 'quick win',
      impact: 'medium',
      priority: 4,
    });
  }

  // 5. CI failures to investigate.
  const cipr = snapshot.ci_pass_rate;
  if (cipr && cipr.pass_rate != null && cipr.pass_rate < 0.8) {
    const pct = Math.round(cipr.pass_rate * 100);
    items.push({
      text: `Investigate CI failures — pass rate at <a href="https://github.com/${repo}/actions">${pct}%</a>`,
      effort: 'moderate',
      impact: 'medium',
      priority: 5,
    });
  }

  // 6. PRs needing author rework (draft PRs that are not bot).
  const needsRework = (openPRs || []).filter(pr => pr.draft && !pr.bot);
  if (needsRework.length > 0) {
    const refs = needsRework.map(pr =>
      `<a href="https://github.com/${repo}/pull/${pr.number}">#${pr.number}</a>`
    ).join(', ');
    items.push({
      text: `Complete draft PRs: ${refs}`,
      effort: 'moderate',
      impact: 'medium',
      priority: 6,
    });
  }

  return items.sort((a, b) => a.priority - b.priority);
}

function buildActionabilitySection(snapshot, openPRs) {
  const items = buildActionItems(snapshot, openPRs);
  if (items.length === 0) return '';

  const effortColor = { 'quick win': '#7ee787', 'moderate': '#d29922', 'significant': '#f85149' };
  const impactColor = { 'high': '#f85149', 'medium': '#d29922', 'low': '#8b949e' };

  const rows = items.map((item, i) => `<tr>
    <td style="color:#8b949e;font-weight:600">${i + 1}</td>
    <td>${item.text}</td>
    <td><span style="color:${effortColor[item.effort] || '#8b949e'}">${item.effort}</span></td>
    <td><span style="color:${impactColor[item.impact] || '#8b949e'}">${item.impact} impact</span></td>
  </tr>`).join('');

  return `<h2>What To Do Next <span style="font-size:0.8rem;color:#8b949e">(${items.length} action${items.length !== 1 ? 's' : ''})</span></h2>
<div class="chart-container">
<table><thead><tr><th>#</th><th>Action</th><th>Effort</th><th>Impact</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`;
}

function snapshotToTierInput(snapshot) {
  const cp = snapshot.community_profile;
  const da = snapshot.dependabot_alerts;
  return {
    ci: snapshot.summary?.ci_workflows || 0,
    license: snapshot.license ?? (cp?.files?.license ? 'present' : 'None'),
    open_issues: snapshot.summary?.open_issues || 0,
    pushed_at: snapshot.pushed_at ?? null,
    released_at: snapshot.releases?.[0]?.published_at ?? null,
    communityHealth: cp?.health_percentage ?? null,
    vulns: da,
    commits: snapshot.summary?.recently_merged_prs || 0,
  };
}

function buildHealthTierSection(snapshot) {
  const input = snapshotToTierInput(snapshot);
  const { tier, checks } = computeHealthTier(input);
  const color = TIER_COLORS[tier] || TIER_COLORS.none;
  const display = TIER_DISPLAY[tier] || 'Unranked';

  const nextTier = tier === 'none' ? 'bronze' : tier === 'bronze' ? 'silver' : tier === 'silver' ? 'gold' : null;
  const failedForNext = nextTier
    ? checks.filter(c => !c.passed && (c.required_for === nextTier || (nextTier === 'gold' && c.required_for === 'silver')))
    : [];

  const checkRows = checks.map(c => {
    const icon = c.passed ? '\u2713' : '\u2717';
    const iconColor = c.passed ? '#7ee787' : '#f85149';
    const tierLabel = c.required_for === 'gold' ? 'Gold' : c.required_for === 'silver' ? 'Silver' : 'Bronze';
    return `<tr>
      <td style="color:${iconColor};font-weight:600;text-align:center">${icon}</td>
      <td>${c.name}</td>
      <td><span class="tier-badge tier-${c.required_for}">${tierLabel}</span></td></tr>`;
  }).join('');

  const nextTierHtml = nextTier && failedForNext.length > 0
    ? `<div style="margin-top:1rem;padding:1rem;background:#0d1117;border-radius:6px;border:1px solid #21262d">
<div style="font-size:0.85rem;color:#8b949e;margin-bottom:0.5rem">To reach <span class="tier-badge tier-${nextTier}">${TIER_DISPLAY[nextTier]}</span>:</div>
${failedForNext.map(c => `<div style="color:#f85149;font-size:0.85rem;margin-left:0.5rem">\u2717 ${c.name}</div>`).join('')}
</div>`
    : tier === 'gold' ? '<div style="margin-top:1rem;color:#7ee787;font-size:0.85rem">All criteria met. This repo has achieved Gold tier.</div>' : '';

  return `<h2>Health Tier</h2>
<div class="chart-container" style="text-align:center;padding-bottom:0.5rem">
<div style="font-size:3rem;font-weight:700;color:${color}">${display}</div>
<table style="margin-top:1rem;text-align:left"><thead><tr><th></th><th>Criteria</th><th>Required</th></tr></thead>
<tbody>${checkRows}</tbody></table>
${nextTierHtml}
</div>`;
}

function buildHealthSection(snapshot, depSummary = null) {
  const cp = snapshot.community_profile;
  const da = snapshot.dependabot_alerts;
  const cipr = snapshot.ci_pass_rate;
  const busFactor = snapshot.summary?.bus_factor;
  const ttc = snapshot.summary?.time_to_close_median;

  const check = v => v ? '\u2713' : '\u2717';
  const checkColor = v => v ? '#7ee787' : '#f85149';

  const communityHtml = cp ? `<div class="card"><h3>Community Profile</h3>
<div class="stat">${cp.health_percentage}%</div>
<div class="stat-label" style="margin-top:0.5rem;line-height:1.8">
${['readme', 'license', 'contributing', 'code_of_conduct', 'issue_template', 'pull_request_template'].map(f =>
    `<span style="color:${checkColor(cp.files?.[f])}">${check(cp.files?.[f])}</span> ${f.replace(/_/g, ' ')}`
  ).join('<br>')}
</div></div>` : `<div class="card"><h3>Community Profile</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;

  const vulnHtml = da ? `<div class="card"><h3>Dependabot Alerts</h3>
<div class="stat" style="color:${da.count === 0 ? '#7ee787' : da.critical > 0 || da.high > 0 ? '#f85149' : '#d29922'}">${da.count}</div>
<div class="stat-label" style="margin-top:0.5rem;line-height:1.8">
${da.critical ? `<span style="color:#f85149">${da.critical} critical</span><br>` : ''}${da.high ? `<span style="color:#f85149">${da.high} high</span><br>` : ''}${da.medium ? `<span style="color:#d29922">${da.medium} medium</span><br>` : ''}${da.low ? `<span style="color:#7ee787">${da.low} low</span>` : ''}${da.count === 0 ? 'No open alerts' : ''}
</div></div>` : `<div class="card"><h3>Dependabot Alerts</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;

  const hasCiData = cipr?.pass_rate != null;
  const ciColor = !hasCiData ? '#6e7681' : cipr.pass_rate >= 0.9 ? '#7ee787' : cipr.pass_rate >= 0.7 ? '#d29922' : '#f85149';
  const ciHtml = hasCiData ? `<div class="card"><h3>CI Pass Rate</h3>
<div class="stat" style="color:${ciColor}">${Math.round(cipr.pass_rate * 100)}%</div>
<div class="stat-label">${cipr.total_runs > 0 ? `${cipr.passed}/${cipr.total_runs} runs passed` : 'from workflow runs'}</div></div>` : `<div class="card"><h3>CI Pass Rate</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;

  const busHtml = `<div class="card"><h3>Bus Factor</h3>
<div class="stat" style="color:${busFactor == null ? '#6e7681' : busFactor <= 1 ? '#f85149' : busFactor <= 2 ? '#d29922' : '#7ee787'}">${busFactor != null ? busFactor : '\u2014'}</div>
<div class="stat-label">${busFactor != null ? 'distinct contributors' : 'unavailable'}</div></div>`;

  const ttcHtml = `<div class="card"><h3>Time to Close</h3>
<div class="stat" style="color:${ttc == null ? '#6e7681' : ttc.median_days <= 7 ? '#7ee787' : ttc.median_days <= 30 ? '#d29922' : '#f85149'}">${ttc != null ? ttc.median_days + 'd' : '\u2014'}</div>
<div class="stat-label">${ttc != null ? 'median days (n=' + ttc.sample_size + ')' : 'unavailable'}</div></div>`;

  const depHtml = buildRepoDependencyCard(snapshot.sbom, depSummary);

  return `<h2>Repository Health</h2>
<div class="grid">
${communityHtml}
${vulnHtml}
${ciHtml}
${busHtml}
${ttcHtml}
${depHtml}
</div>`;
}

function buildPRTriageSection(openPRs, repoFullName) {
  if (!openPRs || openPRs.length === 0) return '';

  const rows = openPRs.map(pr => {
    const stale = pr.age_days >= 30;
    const ageColor = stale ? '#f85149' : pr.age_days >= 14 ? '#d29922' : '#8b949e';
    const authorDisplay = pr.bot ? `<span style="color:#8b949e">${escHtml(pr.author)}</span>` : escHtml(pr.author);
    const labels = pr.labels.map(l => `<span style="background:#21262d;padding:0.1rem 0.4rem;border-radius:4px;font-size:0.7rem">${escHtml(l)}</span>`).join(' ');
    const draftBadge = pr.draft ? '<span style="color:#8b949e;font-size:0.7rem"> draft</span>' : '';

    return `<tr>
      <td><a href="https://github.com/${repoFullName}/pull/${pr.number}">#${pr.number}</a>${draftBadge}</td>
      <td>${escHtml(pr.title.length > 60 ? pr.title.slice(0, 58) + '…' : pr.title)}</td>
      <td>${authorDisplay}</td>
      <td style="color:${ageColor}">${pr.age_days}d</td>
      <td>${labels || '—'}</td></tr>`;
  }).join('');

  const toReview = openPRs.filter(pr => pr.review_requested && !pr.draft && !pr.bot).length;
  const drafts = openPRs.filter(pr => pr.draft).length;
  const botPRs = openPRs.filter(pr => pr.bot).length;
  const stale = openPRs.filter(pr => pr.age_days >= 30).length;

  const summary = [
    `${openPRs.length} open`,
    toReview > 0 ? `${toReview} awaiting review` : null,
    drafts > 0 ? `${drafts} draft` : null,
    botPRs > 0 ? `${botPRs} bot` : null,
    stale > 0 ? `<span style="color:#f85149">${stale} stale</span>` : null,
  ].filter(Boolean).join(', ');

  return `<h2>Open Pull Requests <span style="font-size:0.8rem;color:#8b949e">(${summary})</span></h2>
<div class="chart-container">
<table><thead><tr><th>PR</th><th>Title</th><th>Author</th><th>Age</th><th>Labels</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`;
}

const UPSTREAM_KEYWORDS = ['electron', 'chromium', 'upstream', 'webkit', 'node.js', 'v8', 'wayland', 'pipewire', 'xdg', 'gtk', 'libnotify', 'dbus', 'fedora', 'ubuntu'];

function classifyBlocker(title, labels) {
  const text = title.toLowerCase();
  if (UPSTREAM_KEYWORDS.some(k => text.includes(k))) return 'upstream';
  if (labels.some(l => l.toLowerCase().includes('upstream'))) return 'upstream';
  if (labels.some(l => l.toLowerCase().includes('depends') || l.toLowerCase().includes('dependency'))) return 'dependency';
  if (text.includes('depends on') || text.includes('blocked by') || text.includes('waiting for')) return 'dependency';
  return 'unknown';
}

function buildStalenessSection(snapshot) {
  const issues = snapshot.issues?.open || [];
  if (issues.length === 0) return '';

  const now = Date.now();
  const feedbackIssues = issues
    .filter(i => i.labels.some(l => l.includes('feedback')))
    .map(i => ({ ...i, stale_days: Math.floor((now - new Date(i.updated_at).getTime()) / 86400000) }))
    .sort((a, b) => b.stale_days - a.stale_days);

  const blockedIssues = issues
    .filter(i => i.labels.includes('blocked'))
    .map(i => ({ ...i, age_days: Math.floor((now - new Date(i.created_at).getTime()) / 86400000) }))
    .sort((a, b) => b.age_days - a.age_days);

  if (feedbackIssues.length === 0 && blockedIssues.length === 0) return '';

  let html = '<h2>Issue Triage</h2>';

  if (feedbackIssues.length > 0) {
    const critical = feedbackIssues.filter(i => i.stale_days >= 30).length;
    const feedbackRows = feedbackIssues.map(i => {
      const color = i.stale_days >= 30 ? '#f85149' : i.stale_days >= 14 ? '#d29922' : '#8b949e';
      return `<tr>
        <td><a href="https://github.com/${snapshot.repository}/issues/${i.number}">#${i.number}</a></td>
        <td>${escHtml(i.title.length > 55 ? i.title.slice(0, 53) + '…' : i.title)}</td>
        <td style="color:${color}">${i.stale_days}d</td>
        <td>${i.comments}</td></tr>`;
    }).join('');

    html += `<div class="chart-container">
<div class="chart-title">Awaiting Feedback <span style="font-size:0.8rem;color:#8b949e">(${feedbackIssues.length} issues${critical > 0 ? `, <span style="color:#f85149">${critical} stale 30d+</span>` : ''})</span></div>
<table><thead><tr><th>Issue</th><th>Title</th><th>Waiting</th><th>Comments</th></tr></thead>
<tbody>${feedbackRows}</tbody></table>
</div>`;
  }

  if (blockedIssues.length > 0) {
    const classified = blockedIssues.map(i => ({ ...i, reason: classifyBlocker(i.title, i.labels) }));
    const blockedRows = classified.map(i => {
      const color = i.age_days >= 90 ? '#f85149' : i.age_days >= 30 ? '#d29922' : '#8b949e';
      const reasonColor = i.reason === 'upstream' ? '#d29922' : i.reason === 'dependency' ? '#388bfd' : '#8b949e';
      return `<tr>
        <td><a href="https://github.com/${snapshot.repository}/issues/${i.number}">#${i.number}</a></td>
        <td>${escHtml(i.title.length > 55 ? i.title.slice(0, 53) + '…' : i.title)}</td>
        <td style="color:${reasonColor}">${i.reason}</td>
        <td style="color:${color}">${i.age_days}d</td>
        <td>${i.comments}</td></tr>`;
    }).join('');

    const upstreamCount = classified.filter(i => i.reason === 'upstream').length;
    const blockedSummary = upstreamCount > 0 ? `${blockedIssues.length} total, ${upstreamCount} upstream` : `${blockedIssues.length}`;

    html += `<div class="chart-container">
<div class="chart-title">Blocked Issues <span style="font-size:0.8rem;color:#8b949e">(${blockedSummary})</span></div>
<table><thead><tr><th>Issue</th><th>Title</th><th>Blocked on</th><th>Age</th><th>Comments</th></tr></thead>
<tbody>${blockedRows}</tbody></table>
</div>`;
  }

  return html;
}

function buildDependencyInventorySection(inventory) {
  if (!inventory || inventory.reposWithSBOM === 0) return '';

  let html = `<h2>Dependency Inventory</h2>
<div class="grid">
  <div class="card"><h3>Total Unique Dependencies</h3><div class="stat">${fmt(inventory.totalUnique)}</div><div class="stat-label">across ${inventory.reposWithSBOM} repos with SBOM</div></div>
  <div class="card"><h3>Shared Dependencies</h3><div class="stat">${inventory.sharedDepsTotal}</div><div class="stat-label">used in 2+ repos</div></div>
  <div class="card"><h3>License Concerns</h3><div class="stat" style="color:${inventory.licenseFlags.length > 0 ? '#f85149' : '#7ee787'}">${inventory.licenseFlags.length}</div><div class="stat-label">copyleft deps in permissive repos</div></div>
</div>`;

  if (inventory.commonDeps.length > 0) {
    const rows = inventory.commonDeps.map(d => {
      const licenseDisplay = d.licenses.length > 0 ? d.licenses.join(', ') : 'unknown';
      const hasCopyleft = d.licenses.some(l => isCopyleft(l));
      const licenseColor = hasCopyleft ? '#d29922' : '#8b949e';
      return `<tr><td>${escHtml(d.name)}</td><td>${d.repoCount}</td><td><span style="color:${licenseColor}">${escHtml(licenseDisplay)}</span></td></tr>`;
    }).join('');
    html += `<div class="chart-container">
<div class="chart-title">Most Common Dependencies (used in 2+ repos)</div>
<table><thead><tr><th>Package</th><th>Repos</th><th>License</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`;
  }

  if (inventory.licenseFlags.length > 0) {
    const flagRows = inventory.licenseFlags.map(f =>
      `<tr><td>${escHtml(f.repo)}</td><td>${escHtml(f.dep)}</td><td style="color:#f85149">${escHtml(f.license)}</td></tr>`
    ).join('');
    html += `<div class="chart-container">
<div class="chart-title">License Concerns <span style="font-size:0.8rem;color:#8b949e">(copyleft dependencies in permissive-licensed repos)</span></div>
<table><thead><tr><th>Repo</th><th>Dependency</th><th>License</th></tr></thead>
<tbody>${flagRows}</tbody></table>
</div>`;
  }

  return html;
}

function buildRepoDependencyCard(sbom, repoSummary) {
  if (!sbom) return `<div class="card"><h3>Dependencies (SBOM)</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;
  const count = sbom.count;
  const flags = repoSummary?.licenseFlags || [];
  const flagColor = flags.length > 0 ? '#f85149' : '#7ee787';
  const flagLabel = flags.length > 0
    ? `${flags.length} copyleft: ${flags.slice(0, 3).map(f => f.name).join(', ')}${flags.length > 3 ? '...' : ''}`
    : 'no copyleft concerns';
  return `<div class="card"><h3>Dependencies (SBOM)</h3>
<div class="stat">${count}</div>
<div class="stat-label" style="color:${flagColor}">${flagLabel}</div></div>`;
}

function buildCalendarHeatmap(weeklyCommits) {
  if (!weeklyCommits || weeklyCommits.length === 0) return '';
  const max = Math.max(...weeklyCommits);
  function cellColor(count) {
    if (count === 0) return '#161b22';
    const ratio = count / max;
    if (ratio <= 0.25) return '#0e4429';
    if (ratio <= 0.5) return '#006d32';
    if (ratio <= 0.75) return '#26a641';
    return '#39d353';
  }
  const cells = weeklyCommits.map((count, i) =>
    `<div class="heatmap-cell" style="background:${cellColor(count)}" title="Week ${i + 1}: ${count} commits"></div>`
  ).join('');
  const labels = weeklyCommits.map((_, i) => {
    if (i % 4 !== 0) return '<span></span>';
    const d = new Date(); d.setDate(d.getDate() - (weeklyCommits.length - 1 - i) * 7);
    return `<span>${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}</span>`;
  }).join('');
  return `<h2>Commit Activity (${weeklyCommits.length} weeks)</h2>
<div class="chart-container"><div class="chart-title">Weekly Commits</div>
<div class="heatmap" style="grid-template-columns:repeat(${weeklyCommits.length},12px)">${cells}</div>
<div class="heatmap-labels" style="grid-template-columns:repeat(${weeklyCommits.length},12px)">${labels}</div>
</div>`;
}

const CSS = `<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;background:#0d1117;color:#e6edf3;padding:2rem;max-width:1400px;margin:0 auto}
h1{font-size:1.8rem;margin-bottom:0.3rem;color:#f0f6fc}
h1 .repo-link{color:#f0f6fc;text-decoration:none}
h1 .repo-link svg{vertical-align:middle;fill:#8b949e}
h1 .repo-link:hover svg{fill:#e6edf3}
h2{font-size:1.2rem;margin:2.5rem 0 1rem;color:#7ee787;border-bottom:1px solid #21262d;padding-bottom:0.5rem}
.subtitle{color:#8b949e;font-size:0.9rem;margin-bottom:2rem}
.subtitle a{color:#58a6ff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1.2rem;margin-bottom:2rem}
.card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:1.2rem}
.card h3{font-size:0.8rem;color:#8b949e;margin-bottom:0.3rem;text-transform:uppercase;letter-spacing:0.05em}
.stat{font-size:2.2rem;font-weight:700;color:#f0f6fc}
.stat-sm{font-size:1.4rem}
.stat-label{color:#8b949e;font-size:0.8rem}
.chart-container{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:1.5rem;margin-bottom:1.5rem}
.chart-title{font-size:0.95rem;color:#e6edf3;margin-bottom:1rem}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.5rem}
canvas{max-height:300px}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th{text-align:left;color:#8b949e;padding:0.6rem;border-bottom:1px solid #21262d}
td{padding:0.6rem;border-bottom:1px solid #21262d}
tr:hover{background:#1c2128}
a{color:#58a6ff;text-decoration:none}
.badge{display:inline-block;padding:0.15rem 0.5rem;border-radius:12px;font-size:0.7rem;font-weight:600}
.badge-active{background:#238636;color:#f0f6fc}
.badge-dormant{background:#da3633;color:#f0f6fc}
.badge-archive{background:#6e7681;color:#f0f6fc}
.badge-fork{background:#1f6feb;color:#f0f6fc}
.badge-test{background:#8957e5;color:#f0f6fc}
.tier-badge{display:inline-block;padding:0.15rem 0.5rem;border-radius:12px;font-size:0.7rem;font-weight:600}
.tier-gold{background:#ffd700;color:#1a1a00}.tier-silver{background:#c0c0c0;color:#1a1a1a}.tier-bronze{background:#cd7f32;color:#1a0a00}.tier-none{background:#30363d;color:#8b949e}
.heatmap{display:grid;gap:2px;grid-auto-rows:12px}
.heatmap-cell{width:12px;height:12px;border-radius:2px}
.heatmap-labels{display:grid;gap:2px;margin-top:4px;font-size:0.6rem;color:#8b949e}
.heatmap-labels span{text-align:center;white-space:nowrap}
.footer{text-align:center;color:#6e7681;font-size:0.8rem;margin-top:3rem;padding:1rem}
.alert-banner{background:#161b22;border-left:4px solid #d29922;border-radius:0 8px 8px 0;padding:1rem 1.5rem;margin-bottom:1.5rem;color:#e6edf3;font-size:0.9rem}
.alert-banner.alert-critical{border-color:#f85149}
@media(max-width:900px){.two-col,.three-col{grid-template-columns:1fr}}
</style>`;
