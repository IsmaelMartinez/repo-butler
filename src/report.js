// REPORT phase: generate HTML dashboard reports from observation data.
// Produces two reports: per-repo (target repo) and portfolio (all repos).

import { createClient } from './github.js';
import { observe, observePortfolio } from './observe.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function report(context) {
  const { owner, repo, token, config } = context;
  const outDir = process.env.REPORT_OUTPUT_DIR || 'reports';

  // Auto-run observe if no snapshot exists (standalone report phase).
  if (!context.snapshot) {
    console.log('No snapshot — running OBSERVE first...');
    context.snapshot = await observe(context);
    context.portfolio = await observePortfolio(context);
  }

  const { snapshot, portfolio } = context;

  await mkdir(outDir, { recursive: true });

  // Gather extra data for charts.
  const gh = createClient(token);
  const [prActivity, issueActivity, weeklyCommits, prAuthors, repoDetails] = await Promise.all([
    fetchMonthlyPRActivity(gh, owner, repo),
    fetchMonthlyIssueActivity(gh, owner, repo),
    fetchWeeklyCommits(gh, owner, repo),
    fetchPRAuthors(gh, owner, repo),
    portfolio ? fetchPortfolioDetails(gh, owner, portfolio.repos) : Promise.resolve(null),
  ]);

  // Generate per-repo report.
  const repoHtml = generateRepoReport(snapshot, prActivity, issueActivity, prAuthors);
  const repoPath = join(outDir, 'index.html');
  await writeFile(repoPath, repoHtml);
  console.log(`Repo report written to ${repoPath}`);

  // Generate portfolio report.
  if (portfolio && repoDetails) {
    const portfolioHtml = generatePortfolioReport(owner, portfolio, repoDetails, weeklyCommits);
    const portfolioPath = join(outDir, 'portfolio.html');
    await writeFile(portfolioPath, portfolioHtml);
    console.log(`Portfolio report written to ${portfolioPath}`);
  }

  return { outDir };
}


// --- Data fetchers for charts ---

async function fetchMonthlyPRActivity(gh, owner, repo) {
  const months = last12Months();
  const results = [];
  for (const { label, start, end } of months) {
    const data = await gh.request('/search/issues', {
      params: { q: `repo:${owner}/${repo} is:pr is:merged merged:${start}..${end}`, per_page: 1 },
    });
    results.push({ month: label, count: data.total_count });
    await throttle();
  }
  return results;
}

async function fetchMonthlyIssueActivity(gh, owner, repo) {
  const months = last12Months();
  const results = [];
  for (const { label, start, end } of months) {
    const [opened, closed] = await Promise.all([
      gh.request('/search/issues', {
        params: { q: `repo:${owner}/${repo} is:issue created:${start}..${end}`, per_page: 1 },
      }),
      gh.request('/search/issues', {
        params: { q: `repo:${owner}/${repo} is:issue closed:${start}..${end}`, per_page: 1 },
      }),
    ]);
    results.push({ month: label, opened: opened.total_count, closed: closed.total_count });
    await throttle();
  }
  return results;
}

async function fetchPRAuthors(gh, owner, repo) {
  const data = await gh.request('/search/issues', {
    params: { q: `repo:${owner}/${repo} is:pr is:merged merged:>${daysAgoISO(90)}`, per_page: 100 },
  });
  const counts = {};
  for (const item of data.items || []) {
    const author = item.user?.login || 'unknown';
    counts[author] = (counts[author] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count);
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
    const [commits, weekly, license, ci] = await Promise.all([
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
    ]);
    details[r.name] = { commits, weekly, license, ci };
  });

  await Promise.all(fetches);
  return details;
}


// --- HTML generators ---

function generateRepoReport(snapshot, prActivity, issueActivity, prAuthors) {
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
    return Math.round((new Date(r.date) - new Date(relData[i - 1].date)) / 86400000);
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${snapshot.repository} — Health Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"></script>
${CSS}
</head>
<body>
<h1>${snapshot.repository}</h1>
<div class="subtitle">Project Health Report — ${now} — <a href="portfolio.html">portfolio view</a></div>
<div class="grid">
  <div class="card"><h3>Stars</h3><div class="stat">${fmt(snapshot.meta?.stars)}</div><div class="stat-label">${snapshot.meta?.forks} forks, ${snapshot.meta?.watchers} watchers</div></div>
  <div class="card"><h3>Open Issues</h3><div class="stat">${s.open_issues}</div><div class="stat-label">${s.blocked_issues} blocked, ${s.awaiting_feedback} awaiting feedback</div></div>
  <div class="card"><h3>PRs Merged (90d)</h3><div class="stat">${s.recently_merged_prs}</div><div class="stat-label">${s.human_prs} human, ${s.bot_prs} bot</div></div>
  <div class="card"><h3>Releases</h3><div class="stat">${s.releases}</div><div class="stat-label">Latest: ${s.latest_release}</div></div>
</div>
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
<div class="footer">Generated by <a href="https://github.com/IsmaelMartinez/repo-butler">repo-butler</a></div>
<script>
Chart.defaults.color='#8b949e';Chart.defaults.borderColor='#21262d';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,monospace';
new Chart(document.getElementById('prChart'),{type:'bar',data:{labels:[${prMonths}],datasets:[{label:'Merged PRs',data:[${prCounts}],backgroundColor:'rgba(56,139,253,0.7)',borderRadius:4}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
new Chart(document.getElementById('issueChart'),{type:'line',data:{labels:[${issueMonths}],datasets:[{label:'Opened',data:[${issueOpened}],borderColor:'#f85149',backgroundColor:'rgba(248,81,73,0.1)',fill:true,tension:0.3,pointRadius:4},{label:'Closed',data:[${issueClosed}],borderColor:'#7ee787',backgroundColor:'rgba(126,231,135,0.1)',fill:true,tension:0.3,pointRadius:4}]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
new Chart(document.getElementById('releaseChart'),{type:'bar',data:{labels:[${relData.map(r => `'${r.tag}'`).join(',')}],datasets:[{label:'Days',data:[${relDays.join(',')}],backgroundColor:'rgba(126,231,135,0.7)',borderRadius:3}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'},title:{display:true,text:'Days'}},x:{ticks:{maxRotation:45},grid:{display:false}}}}});
new Chart(document.getElementById('authorChart'),{type:'doughnut',data:{labels:['${maintainer?.author||"maintainer"}','Bots','Community'],datasets:[{data:[${maintainer?.count||0},${botPRs},${communityPRs}],backgroundColor:['rgba(56,139,253,0.8)','rgba(139,148,158,0.6)','rgba(126,231,135,0.7)'],borderColor:'#161b22',borderWidth:2}]},options:{responsive:true,plugins:{legend:{position:'bottom'}}}});
new Chart(document.getElementById('labelChart'),{type:'bar',data:{labels:[${labelNames}],datasets:[{data:[${labelCounts}],backgroundColor:[${labelColors}],borderRadius:4}]},options:{indexAxis:'y',responsive:true,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,grid:{color:'#21262d'}},y:{grid:{display:false}}}}});
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
    const healthScore = r.status === 'active' ? ((r.commits > 0 ? 1 : 0) + ((r.ci || 0) >= 2 ? 1 : 0) + (r.license && r.license !== 'None' ? 1 : 0) + ((r.open_issues || 0) <= 5 ? 1 : 0)) : 0;
    const health = r.status !== 'active' ? (r.status === 'test' || r.status === 'fork' ? 'none' : 'bad') : healthScore >= 3 ? 'good' : healthScore >= 2 ? 'warn' : 'bad';
    return `<tr>
      <td><a href="https://github.com/${owner}/${r.name}">${r.name}</a></td>
      <td>${r.description ? escHtml(r.description).slice(0, 50) : '—'}</td>
      <td>${r.language || '—'}</td><td>${r.stars}</td><td>${r.open_issues || 0}</td>
      <td>${r.commits || 0}</td><td>${(r.ci || 0) > 0 ? r.ci : '<span style="color:#f85149">0</span>'}</td>
      <td>${!r.license || r.license === 'None' ? '<span style="color:#d29922">none</span>' : r.license}</td>
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
<h1>@${owner}</h1>
<div class="subtitle">GitHub Portfolio Health Report — ${now} — <a href="index.html">repo view</a></div>
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
<table><thead><tr><th>Repo</th><th>Description</th><th>Lang</th><th>Stars</th><th>Issues</th><th>Commits</th><th>CI</th><th>License</th><th>Status</th><th></th></tr></thead>
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

// Throttle search API calls to stay under 30 req/min secondary rate limit.
function throttle() {
  return new Promise(r => setTimeout(r, 2500));
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

const CSS = `<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;background:#0d1117;color:#e6edf3;padding:2rem;max-width:1400px;margin:0 auto}
h1{font-size:1.8rem;margin-bottom:0.3rem;color:#f0f6fc}
h2{font-size:1.2rem;margin:2.5rem 0 1rem;color:#7ee787;border-bottom:1px solid #21262d;padding-bottom:0.5rem}
.subtitle{color:#8b949e;font-size:0.9rem;margin-bottom:2rem}
.subtitle a{color:#58a6ff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1.2rem;margin-bottom:2rem}
.card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:1.2rem}
.card h3{font-size:0.8rem;color:#8b949e;margin-bottom:0.3rem;text-transform:uppercase;letter-spacing:0.05em}
.stat{font-size:2.2rem;font-weight:700;color:#f0f6fc}
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
