// REPORT phase: generate HTML dashboard reports from observation data.
// Produces two reports: per-repo (target repo) and portfolio (all repos).

import { createClient } from './github.js';
import { observe, observePortfolio, computeBusFactor, computeTimeToCloseMedian } from './observe.js';
import { computeSnapshotHash } from './store.js';
import { computeTrends } from './assess.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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

  // Generate portfolio report as the landing page.
  if (portfolio && repoDetails) {
    const portfolioHtml = generatePortfolioReport(owner, portfolio, repoDetails, null);
    await writeFile(join(outDir, 'index.html'), portfolioHtml);
    console.log('Portfolio report written to index.html');

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
        const [prActivity, issueActivity, prAuthors, openPRs] = await Promise.all([
          fetchMonthlyPRActivity(gh, owner, r.name),
          fetchMonthlyIssueActivity(gh, owner, r.name),
          fetchPRAuthors(gh, owner, r.name),
          fetchOpenPRs(gh, owner, r.name),
        ]);

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
            })),
          },
          releases: releases.map(rel => ({
            tag: rel.tag_name, published_at: rel.published_at, prerelease: rel.prerelease,
          })),
          community_profile: communityProfile,
          dependabot_alerts: details?.vulns || null,
          ci_pass_rate: details?.ciPassRate != null ? { pass_rate: details.ciPassRate, total_runs: 0, passed: 0, failed: 0 } : null,
          summary: {
            open_issues: openIssues.length,
            blocked_issues: openIssues.filter(i => i.labels.some(l => l.name === 'blocked')).length,
            awaiting_feedback: openIssues.filter(i => i.labels.some(l => l.name.includes('feedback'))).length,
            recently_merged_prs: prActivity.reduce((s, m) => s + m.count, 0),
            human_prs: prAuthors.filter(a => !a.author.includes('[bot]')).reduce((s, a) => s + a.count, 0),
            bot_prs: prAuthors.filter(a => a.author.includes('[bot]')).reduce((s, a) => s + a.count, 0),
            releases: releases.length,
            latest_release: releases[0]?.tag_name || 'none',
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
        const html = generateRepoReport(repoSnapshot, prActivity, issueActivity, prAuthors, repoTrends, dashboardUrl, openPRs);
        await writeFile(join(outDir, `${r.name}.html`), html);
      } else {
        // Lightweight report — just metadata, no search API calls.
        const html = generateLightRepoReport(owner, r, repoDetails?.[r.name]);
        await writeFile(join(outDir, `${r.name}.html`), html);
      }
    }

    console.log(`Generated reports for ${activeRepos.length} repos.`);
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
  return months.map(({ label, start, end }) => ({
    month: label,
    count: merged.filter(pr => pr.merged_at >= start && pr.merged_at < end).length,
  }));
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
    const [commits, weekly, license, ci, communityHealth, vulns, ciPassRate, openIssues] = await Promise.all([
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
    ]);
    details[r.name] = { commits, weekly, license, ci, communityHealth, vulns, ciPassRate, open_issues: openIssues };
  });

  await Promise.all(fetches);
  return details;
}


// --- HTML generators ---

function generateRepoReport(snapshot, prActivity, issueActivity, prAuthors, trends, dashboardUrl, openPRs = []) {
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
<div class="subtitle">Project Health Report — ${now} — <a href="index.html">portfolio view</a></div>
<div class="grid">
  <div class="card"><h3>Stars</h3><div class="stat">${fmt(snapshot.meta?.stars)}</div><div class="stat-label">${snapshot.meta?.forks} forks, ${snapshot.meta?.watchers} watchers</div></div>
  <div class="card"><h3>Open Issues</h3><div class="stat">${s.open_issues}</div><div class="stat-label">${s.blocked_issues} blocked, ${s.awaiting_feedback} awaiting feedback</div></div>
  <div class="card"><h3>PRs Merged (90d)</h3><div class="stat">${s.recently_merged_prs}</div><div class="stat-label">${s.human_prs} human, ${s.bot_prs} bot</div></div>
  <div class="card"><h3>Releases</h3><div class="stat">${s.releases}</div><div class="stat-label">Latest: ${s.latest_release}</div></div>
</div>
${buildHealthSection(snapshot)}
${buildPRTriageSection(openPRs, snapshot.repository)}
<h2>Development Velocity</h2>
<div class="chart-container"><div class="chart-title">Merged PRs per Month</div><canvas id="prChart"></canvas></div>
<div class="chart-container"><div class="chart-title">Issues Opened vs Closed per Month</div><canvas id="issueChart"></canvas></div>
<h2>Release Cadence</h2>
<div class="chart-container"><div class="chart-title">Days Between Releases</div><canvas id="releaseChart"></canvas></div>
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

function generatePortfolioReport(owner, portfolio, details, mainWeekly) {
  const repos = portfolio.repos
    .filter(r => !r.archived)
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  const totalStars = repos.reduce((s, r) => s + r.stars, 0);
  const totalForks = repos.reduce((s, r) => s + r.forks, 0);
  const totalCommits = Object.values(details).reduce((s, d) => s + (d.commits || 0), 0);
  const totalIssues = repos.reduce((s, r) => s + (r.open_issues || 0), 0);

  const now = new Date().toISOString().split('T')[0];
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000);
  const oneYearAgo = new Date(Date.now() - 365 * 86400000);

  function status(r) {
    if (r.fork) return 'fork';
    if (r.name.includes('shadow') || r.name.includes('test-repo')) return 'test';
    const pushed = new Date(r.pushed_at);
    if (pushed < oneYearAgo) return 'archive';
    if (pushed < sixMonthsAgo) return 'dormant';
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
    const healthScore = r.status === 'active' ? ((r.commits > 0 ? 1 : 0) + ((r.ci || 0) >= 2 ? 1 : 0) + (r.license && r.license !== 'None' ? 1 : 0) + ((r.open_issues || 0) <= 5 ? 1 : 0) + ((r.communityHealth ?? -1) >= 50 ? 1 : 0) + (r.vulns != null && (r.vulns.max_severity !== 'critical' && r.vulns.max_severity !== 'high') ? 1 : 0)) : 0;
    const health = r.status !== 'active' ? (r.status === 'test' || r.status === 'fork' ? 'none' : 'bad') : healthScore >= 5 ? 'good' : healthScore >= 3 ? 'warn' : 'bad';
    const communityColor = r.communityHealth == null ? '#6e7681' : r.communityHealth >= 80 ? '#7ee787' : r.communityHealth >= 50 ? '#d29922' : '#f85149';
    const vulnColor = r.vulns == null ? '#6e7681' : r.vulns.count === 0 ? '#7ee787' : r.vulns.max_severity === 'critical' || r.vulns.max_severity === 'high' ? '#f85149' : r.vulns.max_severity === 'medium' ? '#d29922' : '#7ee787';
    const ciPassColor = r.ciPassRate == null ? '#6e7681' : r.ciPassRate >= 0.9 ? '#7ee787' : r.ciPassRate >= 0.7 ? '#d29922' : '#f85149';
    return `<tr>
      <td><a href="${r.name}.html">${r.name}</a></td>
      <td>${r.description ? escHtml(r.description).slice(0, 50) : '—'}</td>
      <td>${r.language || '—'}</td><td>${r.stars}</td><td>${r.open_issues || 0}</td>
      <td>${r.commits || 0}</td><td>${(r.ci || 0) > 0 ? r.ci : '<span style="color:#f85149">0</span>'}</td>
      <td>${!r.license || r.license === 'None' ? '<span style="color:#d29922">none</span>' : r.license}</td>
      <td><span style="color:${communityColor}">${r.communityHealth != null ? r.communityHealth + '%' : '—'}</span></td>
      <td><span style="color:${vulnColor}">${r.vulns != null ? r.vulns.count : '—'}</span></td>
      <td><span style="color:${ciPassColor}">${r.ciPassRate != null ? Math.round(r.ciPassRate * 100) + '%' : '—'}</span></td>
      <td><span class="badge ${badgeClass}">${r.status}</span></td>
      <td><span class="health-dot health-${health}"></span></td></tr>`;
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
<div class="subtitle">GitHub Portfolio Health Report — ${now} — click any repo name for details</div>
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
<table><thead><tr><th>Repo</th><th>Description</th><th>Lang</th><th>Stars</th><th>Issues</th><th>Commits</th><th>CI</th><th>License</th><th>Community</th><th>Vulns</th><th>CI%</th><th>Status</th><th></th></tr></thead>
<tbody>${tableRows}</tbody></table>
</div>
<h2>Distribution</h2>
<div class="three-col">
  <div class="chart-container"><div class="chart-title">By Language</div><canvas id="langChart"></canvas></div>
  <div class="chart-container"><div class="chart-title">By Status</div><canvas id="statusChart"></canvas></div>
  <div class="chart-container"><div class="chart-title">Commit Totals (6mo)</div><canvas id="commitChart"></canvas></div>
</div>
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

function buildHealthSection(snapshot) {
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

  return `<h2>Repository Health</h2>
<div class="grid">
${communityHtml}
${vulnHtml}
${ciHtml}
${busHtml}
${ttcHtml}
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
.health-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
.health-good{background:#7ee787}.health-warn{background:#d29922}.health-bad{background:#f85149}.health-none{background:#6e7681}
.footer{text-align:center;color:#6e7681;font-size:0.8rem;margin-top:3rem;padding:1rem}
@media(max-width:900px){.two-col,.three-col{grid-template-columns:1fr}}
</style>`;
