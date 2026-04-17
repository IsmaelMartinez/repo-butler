// Per-repo report generation: full dashboard and lightweight reports.

import { CSS } from './report-styles.js';
import {
  TIER_DISPLAY, TIER_COLORS,
  isBotAuthor, escHtml, fmt, countBy,
  daysAgoISO, last12Months, computeHealthTier, getLibyearColor, isReleaseExempt,
} from './report-shared.js';


// --- Data fetchers for charts ---

export async function fetchMonthlyPRActivity(gh, owner, repo) {
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

export async function fetchMonthlyIssueActivity(gh, owner, repo) {
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

export async function fetchPRAuthors(gh, owner, repo) {
  const since = daysAgoISO(90);
  const prs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
    params: { state: 'closed', sort: 'updated', direction: 'desc' },
    max: 200,
  });
  const merged = prs.filter(pr => pr.merged_at && pr.merged_at >= since);
  const counts = {};
  const firstTimers = new Set();
  for (const pr of merged) {
    const author = pr.user?.login || 'unknown';
    counts[author] = (counts[author] || 0) + 1;
    if (pr.author_association === 'FIRST_TIME_CONTRIBUTOR') {
      firstTimers.add(author);
    }
  }
  return Object.entries(counts)
    .map(([author, count]) => ({ author, count, firstTime: firstTimers.has(author) }))
    .sort((a, b) => b.count - a.count);
}

export async function fetchOpenPRs(gh, owner, repo) {
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
      const isBot = isBotAuthor(pr.user?.login);
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

export async function fetchWeeklyCommits(gh, owner, repo) {
  // Warm up the stats API, then fetch.
  try { await gh.request(`/repos/${owner}/${repo}/stats/participation`); } catch { /* warm-up */ }
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/stats/participation`);
    return data.owner?.slice(-26) || [];
  } catch {
    return [];
  }
}


// --- Cycle time ---

export function computePRCycleTime(mergedPRs) {
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


// --- Contributor funnel ---

export function computeContributorStats(prAuthors, stargazers) {
  const humans = prAuthors.filter(a => !isBotAuthor(a.author));
  const total = humans.length;
  const firstTimers = humans.filter(a => a.firstTime);
  const ratio = stargazers > 0 ? (total / stargazers) * 100 : 0;
  return { total, firstTimers, ratio: Math.round(ratio * 10) / 10 };
}

function buildContributorCard(prAuthors, stargazers) {
  const stats = computeContributorStats(prAuthors, stargazers);
  const authorList = stats.firstTimers.length > 0
    ? stats.firstTimers.map(a => `<span class="badge badge-active" style="font-size:0.75rem;margin:2px">${escHtml(a.author)} <span style="background:#7ee787;color:#161b22;border-radius:4px;padding:0 4px;font-size:0.65rem;margin-left:2px">new</span></span>`).join(' ')
    : '<span style="color:#8b949e">none in this period</span>';
  const ratioColor = stats.ratio >= 5 ? '#7ee787' : stats.ratio >= 1 ? '#d29922' : '#8b949e';
  return `<h2>Contributors</h2>
<div class="grid">
  <div class="card"><h3>Unique Contributors (90d)</h3><div class="stat">${stats.total}</div><div class="stat-label">${prAuthors.filter(a => isBotAuthor(a.author)).length} bots excluded</div></div>
  <div class="card"><h3>First-Time Contributors</h3><div class="stat">${stats.firstTimers.length}</div><div class="stat-label">${authorList}</div></div>
  <div class="card"><h3>Contributor Confidence</h3><div class="stat" style="color:${ratioColor}">${stats.ratio}%</div><div class="stat-label">unique contributors / stargazers</div></div>
</div>`;
}


// --- Velocity imbalance ---

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


// --- Action items ---

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

  // 3. Code scanning critical/high alerts.
  const cs = snapshot.code_scanning_alerts;
  if (cs && (cs.critical > 0 || cs.high > 0)) {
    const parts = [];
    if (cs.critical > 0) parts.push(`${cs.critical} critical`);
    if (cs.high > 0) parts.push(`${cs.high} high`);
    items.push({
      text: `Fix ${parts.join(', ')} <a href="https://github.com/${repo}/security/code-scanning">code scanning alerts</a>`,
      effort: 'moderate',
      impact: 'high',
      priority: 2,
    });
  }

  // 4. Secret scanning open alerts.
  const ss = snapshot.secret_scanning_alerts;
  if (ss && ss.count > 0) {
    items.push({
      text: `Resolve ${ss.count} open <a href="https://github.com/${repo}/security/secret-scanning">secret scanning alerts</a>`,
      effort: 'low',
      impact: 'high',
      priority: 1,
    });
  }

  // 5. PRs awaiting review for > 7 days.
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

  // 6. Stale awaiting-feedback issues (> 30 days since last update).
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

  // 7. CI failures to investigate.
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

  // 8. PRs needing author rework (draft PRs that are not bot).
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


// --- Health tier section ---

function snapshotToTierInput(snapshot) {
  const cp = snapshot.community_profile;
  const da = snapshot.dependabot_alerts;
  return {
    ci: snapshot.summary?.ci_workflows || 0,
    license: snapshot.license ?? (cp?.files?.license ? 'present' : 'None'),
    open_issues: snapshot.summary?.open_issues || 0,
    open_bugs: snapshot.summary?.open_bugs ?? null,
    pushed_at: snapshot.pushed_at ?? null,
    released_at: snapshot.releases?.[0]?.published_at ?? null,
    communityHealth: cp?.health_percentage ?? null,
    vulns: da,
    commits: snapshot.summary?.recently_merged_prs || 0,
    codeScanning: snapshot.code_scanning_alerts ?? null,
    secretScanning: snapshot.secret_scanning_alerts ?? null,
  };
}

function buildHealthTierSection(snapshot, config, healthData = {}) {
  const input = snapshotToTierInput(snapshot);
  const repoName = snapshot.repository?.split('/')[1] || '';
  const { tier, checks } = computeHealthTier(input, { releaseExempt: isReleaseExempt(repoName, config) });
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
    const detail = healthData[c.name] || '';
    const detailHtml = detail ? `<span style="color:#8b949e">${escHtml(detail)}</span>` : '';
    return `<tr>
      <td style="color:${iconColor};font-weight:600;text-align:center">${icon}</td>
      <td>${c.name}</td>
      <td><span class="tier-badge tier-${c.required_for}">${tierLabel}</span></td>
      <td>${detailHtml}</td></tr>`;
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
<table style="margin-top:1rem;text-align:left"><thead><tr><th></th><th>Criteria</th><th>Required</th><th>Detail</th></tr></thead>
<tbody>${checkRows}</tbody></table>
${nextTierHtml}
</div>`;
}


// --- Health section ---

export function buildHealthSection(snapshot, depSummary = null, libyear = null) {
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

  const cs = snapshot.code_scanning_alerts;
  const codeScanHtml = cs ? `<div class="card"><h3>Code Scanning</h3>
<div class="stat" style="color:${cs.count === 0 ? '#7ee787' : cs.max_severity === 'critical' || cs.max_severity === 'high' ? '#f85149' : '#d29922'}">${cs.count}</div>
<div class="stat-label">${cs.count === 0 ? 'No open alerts' : 'open alerts'}</div></div>` : `<div class="card"><h3>Code Scanning</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;

  const ss = snapshot.secret_scanning_alerts;
  const secretScanHtml = ss ? `<div class="card"><h3>Secret Scanning</h3>
<div class="stat" style="color:${ss.count === 0 ? '#7ee787' : '#f85149'}">${ss.count}</div>
<div class="stat-label">${ss.count === 0 ? 'No open alerts' : 'open alerts'}</div></div>` : `<div class="card"><h3>Secret Scanning</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;

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
  const libyearHtml = buildLibyearCard(libyear);

  return `<h2>Repository Health</h2>
<div class="grid">
${communityHtml}
${vulnHtml}
${codeScanHtml}
${secretScanHtml}
${ciHtml}
${busHtml}
${ttcHtml}
${depHtml}
${libyearHtml}
</div>`;
}


// --- PR triage ---

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


// --- Staleness / issue triage ---

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


// --- Dependency cards ---

export function buildRepoDependencyCard(sbom, repoSummary) {
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

export function buildLibyearCard(libyear) {
  if (!libyear) return `<div class="card"><h3>Dep Freshness (Libyear)</h3><div class="stat" style="color:#6e7681">\u2014</div><div class="stat-label">unavailable</div></div>`;
  const total = libyear.total_libyear;
  const color = getLibyearColor(total);
  const oldestLabel = libyear.oldest
    ? `oldest: ${escHtml(libyear.oldest.name)} (${libyear.oldest.years}y behind)`
    : '';
  return `<div class="card"><h3>Dep Freshness (Libyear)</h3>
<div class="stat" style="color:${color}">${total.toFixed(1)}y</div>
<div class="stat-label">${libyear.dependency_count} npm deps checked${oldestLabel ? '<br>' + oldestLabel : ''}</div></div>`;
}


// --- Calendar heatmap ---

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


// --- HTML generators ---

export function generateRepoReport(snapshot, prActivity, issueActivity, prAuthors, trends, dashboardUrl, openPRs = [], cycleTime = null, weeklyCommits = [], depSummary = null, libyear = null, config = {}, assessment = null) {
  const s = snapshot.summary;
  const releases = snapshot.releases || [];

  const prMonths = prActivity.map(m => `'${m.month}'`).join(',');
  const prCounts = prActivity.map(m => m.count).join(',');
  const issueMonths = issueActivity.map(m => `'${m.month}'`).join(',');
  const issueOpened = issueActivity.map(m => m.opened).join(',');
  const issueClosed = issueActivity.map(m => m.closed).join(',');

  const relData = releases.slice(0, 20).map(r => ({
    tag: r.tag, date: r.published_at?.split('T')[0] || '',
  }));
  const relDays = relData.map((r, i) => {
    if (i === 0) return 0;
    return Math.round((new Date(relData[i - 1].date) - new Date(r.date)) / 86400000);
  });

  const now = new Date().toISOString().split('T')[0];

  // Build trends chart section if we have 2+ weeks of data.
  const hasTrends = trends && trends.weeks && trends.weeks.length >= 2;
  const trendsHtml = hasTrends ? `
<h2>Trends <span style="font-size:0.8rem;color:${trends.direction === 'growing' ? '#f85149' : trends.direction === 'shrinking' ? '#7ee787' : '#8b949e'}">(issues ${trends.direction})</span></h2>
<div class="chart-container"><div class="chart-title">Weekly Trends — Open Issues</div><canvas id="trendsChart"></canvas></div>` : '';

  // Assessment narrative from the ASSESS phase (LLM-generated, sanitised before render).
  const assessmentHtml = assessment
    ? `<h2>Assessment</h2>
<div class="chart-container">${assessment.split(/\n{2,}/).map(p => `<p style="margin:0 0 0.75rem 0">${escHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('')}</div>`
    : '';

  const hasMergedPrData = hasTrends && trends.weeks.some(w => w.merged_prs > 0);
  const mergedPrDataset = hasMergedPrData ? `,{label:'Merged PRs',data:[${trends.weeks.map(w => w.merged_prs).join(',')}],borderColor:'#388bfd',backgroundColor:'rgba(56,139,253,0.1)',fill:true,tension:0.3,pointRadius:4,yAxisID:'y1'}` : '';
  const mergedPrScale = hasMergedPrData ? `,y1:{type:'linear',position:'right',beginAtZero:true,grid:{drawOnChartArea:false},title:{display:true,text:'Merged PRs'}}` : '';
  const trendsJs = hasTrends ? `
new Chart(document.getElementById('trendsChart'),{type:'line',data:{labels:[${trends.weeks.map(w => `'${w.week}'`).join(',')}],datasets:[{label:'Open Issues',data:[${trends.weeks.map(w => w.open_issues).join(',')}],borderColor:'#f85149',backgroundColor:'rgba(248,81,73,0.1)',fill:true,tension:0.3,pointRadius:4,yAxisID:'y'}${mergedPrDataset}]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{y:{type:'linear',position:'left',beginAtZero:true,grid:{color:'#21262d'},title:{display:true,text:'Open Issues'}}${mergedPrScale},x:{grid:{display:false}}}}});` : '';

  // Build healthData annotations for the tier table
  const cp = snapshot.community_profile;
  const da = snapshot.dependabot_alerts;
  const cs = snapshot.code_scanning_alerts;
  const ss = snapshot.secret_scanning_alerts;
  const cipr = snapshot.ci_pass_rate;
  const healthData = {
    'Has CI workflows (2+)': `${s.ci_workflows || 0} workflows${cipr?.pass_rate != null ? ', ' + Math.round(cipr.pass_rate * 100) + '% pass' : ''}`,
    'Has CI workflows': `${s.ci_workflows || 0} workflows`,
    'Has a license': snapshot.license || '—',
    'Fewer than 10 open bugs': s.open_bugs != null ? `${s.open_bugs} bugs` : 'unavailable',
    'Fewer than 20 open issues': `${s.open_issues} issues`,
    'Release in the last 90 days': s.latest_release !== 'none' ? s.latest_release : '—',
    'Community health above 80%': cp ? `${cp.health_percentage}%` : '—',
    'Community health above 50%': cp ? `${cp.health_percentage}%` : '—',
    'Security scanning configured': [da && 'Dependabot', cs && 'Code Scanning', ss && 'Secret Scanning'].filter(Boolean).join(' + ') || 'none',
    'Zero critical/high security findings': [da && `${da.count} vuln`, cs && `${cs.count} code`, ss && `${ss.count} secret`].filter(Boolean).join(', ') || '—',
    'Activity in the last 6 months': snapshot.pushed_at ? `pushed ${Math.floor((Date.now() - new Date(snapshot.pushed_at).getTime()) / 86400000)}d ago` : '—',
    'Some activity (within 1 year)': snapshot.pushed_at ? `pushed ${Math.floor((Date.now() - new Date(snapshot.pushed_at).getTime()) / 86400000)}d ago` : '—',
  };

  const prTriageHtml = (buildPRTriageSection(openPRs, snapshot.repository) || '').replace(/<h2>/g, '<h3>').replace(/<\/h2>/g, '</h3>');
  const stalenessHtml = (buildStalenessSection(snapshot) || '').replace(/<h2>/g, '<h3>').replace(/<\/h2>/g, '</h3>');
  const openWorkHtml = prTriageHtml || stalenessHtml
    ? `<h2>Open Work</h2>${prTriageHtml}${stalenessHtml}`
    : '<h2>Open Work</h2><p style="color:#8b949e;font-size:0.9rem">No open work</p>';

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
<div class="subtitle">${fmt(snapshot.meta?.stars)} stars · ${fmt(snapshot.meta?.forks)} forks · ${fmt(snapshot.meta?.watchers)} watchers — ${now} — <a href="index.html">portfolio</a> — <a href="digest.html">digest</a></div>
<div class="grid">
  <div class="card"><h3>Open Issues</h3><div class="stat">${s.open_issues}</div><div class="stat-label">${s.blocked_issues} blocked, ${s.awaiting_feedback} awaiting feedback</div></div>
  <div class="card"><h3>PRs Merged (90d)</h3><div class="stat">${s.recently_merged_prs}</div><div class="stat-label">${s.human_prs} human, ${s.bot_prs} bot</div></div>
  <div class="card"><h3>Releases</h3><div class="stat">${s.releases}</div><div class="stat-label">Latest: ${s.latest_release}</div></div>
</div>
${buildActionabilitySection(snapshot, openPRs)}
${buildHealthTierSection(snapshot, config, healthData)}
${buildVelocityAlert(detectVelocityImbalance(issueActivity))}
${assessmentHtml}
${trendsHtml}
${openWorkHtml}
<details><summary>Activity History</summary>
${buildCycleTimeCard(cycleTime)}
<div class="chart-container"><div class="chart-title">Merged PRs per Month</div><canvas id="prChart"></canvas></div>
<div class="chart-container"><div class="chart-title">Issues Opened vs Closed per Month</div><canvas id="issueChart"></canvas></div>
<h2>Release Cadence</h2>
<div class="chart-container"><div class="chart-title">Days Between Releases</div><canvas id="releaseChart"></canvas></div>
${buildCalendarHeatmap(weeklyCommits)}
</details>
<details><summary>Community</summary>
${buildContributorCard(prAuthors, snapshot.meta?.stars || 0)}
</details>
<div class="footer">Generated by <a href="https://github.com/IsmaelMartinez/repo-butler">repo-butler</a>${dashboardUrl ? ` — <a href="${dashboardUrl}">live triage dashboard</a>` : ''}</div>
<script>
Chart.defaults.color='#8b949e';Chart.defaults.borderColor='#21262d';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,monospace';
new Chart(document.getElementById('prChart'),{type:'bar',data:{labels:[${prMonths}],datasets:[{label:'Merged PRs',data:[${prCounts}],backgroundColor:'rgba(56,139,253,0.7)',borderRadius:4}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
new Chart(document.getElementById('issueChart'),{type:'line',data:{labels:[${issueMonths}],datasets:[{label:'Opened',data:[${issueOpened}],borderColor:'#f85149',backgroundColor:'rgba(248,81,73,0.1)',fill:true,tension:0.3,pointRadius:4},{label:'Closed',data:[${issueClosed}],borderColor:'#7ee787',backgroundColor:'rgba(126,231,135,0.1)',fill:true,tension:0.3,pointRadius:4}]},options:{responsive:true,plugins:{legend:{position:'top'}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'}},x:{grid:{display:false}}}}});
new Chart(document.getElementById('releaseChart'),{type:'bar',data:{labels:[${relData.map(r => `'${r.tag}'`).join(',')}],datasets:[{label:'Days',data:[${relDays.join(',')}],backgroundColor:'rgba(126,231,135,0.7)',borderRadius:3}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'#21262d'},title:{display:true,text:'Days'}},x:{ticks:{maxRotation:45},grid:{display:false}}}}});${trendsJs}
</script></body></html>`;
}

export function generateLightRepoReport(owner, repo, details) {
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
