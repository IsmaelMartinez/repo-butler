# Dashboard Narrative Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure portfolio and per-repo dashboards from data dumps into narrative decision tools following a situation-problem-action arc.

**Architecture:** Presentation-only refactor across three files: `report-portfolio.js` (portfolio page), `report-repo.js` (per-repo page), and `report-styles.js` (CSS). No changes to data collection, tier logic, store, or pipeline phases. A new `buildPortfolioAttentionSection` function aggregates per-repo action items at portfolio level, reusing the existing `buildActionItems` from report-repo.js.

**Tech Stack:** Node 22, ES modules, zero npm dependencies, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-04-07-dashboard-narrative-restructure-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/report-styles.js` | Modify | Add CSS for collapsible `<details>` sections |
| `src/report-portfolio.js` | Modify | Restructure `generatePortfolioReport`: new pulse section, attention section, simplified table, collapsible details/deps, remove doughnuts |
| `src/report-repo.js` | Modify | Restructure `generateRepoReport`: merge health grid into tier checklist, move trends up, merge PR/issue triage into "Open Work", collapsible activity/community sections, remove doughnut charts |
| `src/report.js` | Modify | Pass `buildActionItems` or aggregated action data to portfolio generator |
| `src/report.test.js` | Modify | Update tests for new HTML structure, add tests for portfolio attention section |

---

### Task 1: Add collapsible section CSS to report-styles.js

**Files:**
- Modify: `src/report-styles.js:1-56`

- [ ] **Step 1: Write failing test for details/summary CSS**

In `src/report.test.js`, add a test that verifies CSS output contains `details` and `summary` styles:

```javascript
describe('CSS includes collapsible styles', () => {
  it('has details and summary styling', async () => {
    const { CSS } = await import('./report-styles.js');
    assert.ok(CSS.includes('details'), 'CSS should style details elements');
    assert.ok(CSS.includes('summary'), 'CSS should style summary elements');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/report.test.js 2>&1 | grep -A2 'collapsible'`
Expected: FAIL — CSS doesn't contain details/summary styles yet.

- [ ] **Step 3: Add collapsible CSS**

In `src/report-styles.js`, before the closing backtick of the CSS template, add:

```css
details{margin-bottom:1.5rem}
details summary{cursor:pointer;color:#58a6ff;font-size:1rem;font-weight:600;padding:0.5rem 0;user-select:none}
details summary:hover{color:#79c0ff}
details[open] summary{margin-bottom:1rem}
details .collapsible-content{animation:fadeIn 0.2s ease-in}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/report.test.js 2>&1 | grep -A2 'collapsible'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/report-styles.js src/report.test.js
git commit -m "feat(report): add collapsible section CSS for dashboard restructure"
```

---

### Task 2: Restructure portfolio page — pulse, attention, simplified table

**Files:**
- Modify: `src/report-portfolio.js:430-555` (generatePortfolioReport)
- Modify: `src/report.js` (pass buildActionItems to portfolio generator)
- Modify: `src/report.test.js`

This is the largest task. It changes `generatePortfolioReport` to:
1. Replace 4 vanity stat cards with tier distribution pulse
2. Add "Attention Required" section aggregating action items across repos
3. Simplify the health table from 13 to 6 default columns (full view behind toggle)
4. Move commit activity chart and dependency inventory into collapsible `<details>`
5. Remove the 3 distribution doughnut charts (language, status, commit totals)

- [ ] **Step 1: Write failing test for portfolio pulse section**

```javascript
describe('generatePortfolioReport restructure', () => {
  it('has tier distribution pulse instead of vanity stats', async () => {
    const { generatePortfolioReport } = await import('./report-portfolio.js');
    const owner = 'test';
    const portfolio = { repos: [
      { name: 'a', stars: 5, forks: 1, open_issues: 0, pushed_at: new Date().toISOString(), archived: false, fork: false, language: 'JS' },
    ]};
    const details = { a: { commits: 20, weekly: [1,2], license: 'MIT', ci: 2, communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, open_issues: 0, open_bugs: 0, released_at: new Date().toISOString(), codeScanning: null, secretScanning: { count: 0 } } };
    const html = generatePortfolioReport(owner, portfolio, details, null, null, {});
    assert.ok(html.includes('Portfolio Pulse'), 'should have pulse section');
    assert.ok(!html.includes('id="langChart"'), 'should not have language doughnut chart');
    assert.ok(!html.includes('id="statusChart"'), 'should not have status doughnut chart');
    assert.ok(!html.includes('id="commitChart"'), 'should not have commit totals chart');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/report.test.js 2>&1 | grep -A2 'tier distribution'`
Expected: FAIL — current code has stat cards, not pulse.

- [ ] **Step 3: Rewrite generatePortfolioReport**

Replace the body of `generatePortfolioReport` in `src/report-portfolio.js`. The function signature stays the same. Key changes:

Section 1 — Portfolio Pulse: compute tier distribution from repos/details, show "N Gold, N Silver, N Bronze" prominently with a one-line health grade (% at Gold).

Section 2 — Attention Required: new `buildPortfolioAttentionSection(classified, details, owner, config)` function. It iterates active repos, builds a lightweight snapshot per repo, calls `buildActionItems` from report-repo.js, flattens results, deduplicates, and takes top 10 by priority. Each item gets a repo name prefix and links to the per-repo page. If empty, shows "All clear — nothing needs attention."

Section 3 — Health Table: default 6 columns (Repo+sparkline, Tier, Bugs, CI%, Vulns, Next Step). The "Next Step" column shows the first failing Gold check name. Full 13-column view behind `<details><summary>Show all columns</summary>...</details>`.

Section 4 — Campaigns: keep existing `buildCampaignSection` call but wrap non-compliant repo lists in `<details>`.

Section 5 — Collapsible details: commit activity chart and dependency inventory wrapped in `<details>` elements, collapsed by default.

Removed: the three doughnut charts (language, status, commit totals) and their Chart.js instantiation code.

The import of `buildActionItems` from `report-repo.js` needs to be added to `report-portfolio.js`.

```javascript
// Add to imports at top of report-portfolio.js:
import { buildActionItems } from './report-repo.js';

// New function — portfolio-level attention section:
export function buildPortfolioAttentionSection(repos, details, owner, config) {
  const allItems = [];
  for (const r of repos) {
    const d = details[r.name];
    if (!d) continue;
    // Build a minimal snapshot shape that buildActionItems expects
    const snapshot = {
      repository: `${owner}/${r.name}`,
      dependabot_alerts: d.vulns || null,
      code_scanning_alerts: d.codeScanning ?? null,
      secret_scanning_alerts: d.secretScanning ?? null,
      ci_pass_rate: d.ciPassRate != null ? { pass_rate: d.ciPassRate } : null,
      issues: { open: [] },
      summary: { open_bugs: d.open_bugs ?? 0 },
    };
    const items = buildActionItems(snapshot, []);
    for (const item of items) {
      allItems.push({ ...item, repo: r.name });
    }
  }
  allItems.sort((a, b) => a.priority - b.priority);
  const top = allItems.slice(0, 10);

  if (top.length === 0) {
    return `<h2>Attention Required</h2>
<div class="chart-container" style="text-align:center;padding:2rem;color:#7ee787">
All clear — nothing needs attention across the portfolio.
</div>`;
  }

  const rows = top.map((item, i) => `<tr>
    <td style="color:#8b949e;font-weight:600">${i + 1}</td>
    <td><a href="${item.repo}.html">${escHtml(item.repo)}</a></td>
    <td>${item.text}</td>
    <td><span style="color:${item.effort === 'quick win' ? '#7ee787' : item.effort === 'moderate' ? '#d29922' : '#f85149'}">${item.effort}</span></td>
  </tr>`).join('');

  return `<h2>Attention Required <span style="font-size:0.8rem;color:#8b949e">(${top.length} action${top.length !== 1 ? 's' : ''})</span></h2>
<div class="chart-container">
<table><thead><tr><th>#</th><th>Repo</th><th>Action</th><th>Effort</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`;
}
```

Then rewrite `generatePortfolioReport`. The key structural change to the returned HTML:

```javascript
export function generatePortfolioReport(owner, portfolio, details, mainWeekly, depInventory = null, config = null) {
  const repos = portfolio.repos
    .filter(r => !r.archived && !r.fork)
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  const now = new Date().toISOString().split('T')[0];

  function status(r) {
    if (r.name.includes('shadow') || r.name.includes('test-repo')) return 'test';
    const pushed = new Date(r.pushed_at);
    if (pushed < ONE_YEAR_AGO) return 'archive';
    if (pushed < SIX_MONTHS_AGO) return 'dormant';
    return 'active';
  }

  const classified = repos.map(r => ({ ...r, status: status(r), ...(details[r.name] || {}) }));
  const statusCounts = countBy(classified.map(r => r.status));

  // --- Section 1: Tier distribution pulse ---
  const tierCounts = { gold: 0, silver: 0, bronze: 0, none: 0 };
  for (const r of classified) {
    const { tier } = computeHealthTier(r, { releaseExempt: isReleaseExempt(r.name, config) });
    tierCounts[tier]++;
    r._tier = tier; // stash for table
  }
  const goldPct = repos.length > 0 ? Math.round((tierCounts.gold / repos.length) * 100) : 0;
  const tierParts = ['gold', 'silver', 'bronze', 'none']
    .filter(t => tierCounts[t] > 0)
    .map(t => `<span class="tier-badge tier-${t}">${tierCounts[t]} ${TIER_DISPLAY[t]}</span>`)
    .join(' ');

  // --- Section 3: Health table (simplified default, full behind toggle) ---
  const simplifiedRows = classified.map(r => {
    const tier = r._tier;
    const { checks } = computeHealthTier(r, { releaseExempt: isReleaseExempt(r.name, config) });
    const failing = checks.find(c => !c.passed);
    const nextStep = failing ? failing.name : '—';
    const ciPassPct = r.ciPassRate != null ? Math.round(r.ciPassRate * 100) : null;
    const ciPassColor = ciPassPct == null ? '#6e7681' : ciPassPct >= 90 ? COLOR_SUCCESS : ciPassPct >= 70 ? COLOR_WARNING : COLOR_DANGER;
    const vulnDisplay = r.vulns == null
      ? '<span style="color:#6e7681">n/a</span>'
      : r.vulns.count === 0
        ? `<span style="color:${COLOR_SUCCESS}">0</span>`
        : `<span style="color:${r.vulns.max_severity === 'critical' || r.vulns.max_severity === 'high' ? COLOR_DANGER : COLOR_WARNING}">${r.vulns.count}</span>`;
    const descTooltip = r.description ? ` title="${escHtml(r.description)}"` : '';
    return `<tr>
      <td><a href="${r.name}.html"${descTooltip}>${r.name}</a> ${generateSparklineSVG(details[r.name]?.weekly)}</td>
      <td><span class="tier-badge tier-${tier}">${TIER_DISPLAY[tier]}</span></td>
      <td>${r.open_bugs ?? r.open_issues ?? 0}</td>
      <td>${ciPassPct != null ? `<span style="color:${ciPassColor}">${ciPassPct}%</span>` : '<span style="color:#6e7681">—</span>'}</td>
      <td>${vulnDisplay}</td>
      <td style="color:#8b949e;font-size:0.8rem">${escHtml(nextStep)}</td></tr>`;
  }).join('');

  // Full table (same as current 13-column)
  const fullTableRows = classified.map(r => {
    const badgeClass = { active: 'badge-active', dormant: 'badge-dormant', archive: 'badge-archive', fork: 'badge-fork', test: 'badge-test' }[r.status] || 'badge-active';
    const tier = r._tier;
    const communityColor = r.communityHealth == null ? '#6e7681' : r.communityHealth >= 80 ? COLOR_SUCCESS : r.communityHealth >= 50 ? COLOR_WARNING : COLOR_DANGER;
    const ciCount = r.ci || 0;
    const ciPassPct = r.ciPassRate != null ? Math.round(r.ciPassRate * 100) : null;
    const ciPassColor = ciPassPct == null ? '#6e7681' : ciPassPct >= 90 ? COLOR_SUCCESS : ciPassPct >= 70 ? COLOR_WARNING : COLOR_DANGER;
    const ciDisplay = ciCount === 0
      ? `<span style="color:${COLOR_DANGER}">none</span>`
      : ciPassPct != null ? `<span style="color:${ciPassColor}">${ciPassPct}%</span> <span style="color:#6e7681;font-size:0.8em">(${ciCount})</span>` : `${ciCount}`;
    const vulnDisplay = r.vulns == null
      ? '<span style="color:#6e7681">n/a</span>'
      : r.vulns.count === 0
        ? `<span style="color:${COLOR_SUCCESS}">0</span>`
        : `<span style="color:${r.vulns.max_severity === 'critical' || r.vulns.max_severity === 'high' ? COLOR_DANGER : COLOR_WARNING}">${r.vulns.count}</span>`;
    const libyearVal = r.libyear?.total_libyear;
    const libyearColor = getLibyearColor(libyearVal);
    const depDisplay = r.sbom
      ? `${r.sbom.count}${libyearVal != null ? ` <span style="color:${libyearColor};font-size:0.8em">(${libyearVal.toFixed(1)}y)</span>` : ''}`
      : '—';
    const descTooltip = r.description ? ` title="${escHtml(r.description)}"` : '';
    return `<tr>
      <td><a href="${r.name}.html"${descTooltip}>${r.name}</a> ${generateSparklineSVG(details[r.name]?.weekly)}</td>
      <td>${r.language || '—'}</td><td>${r.stars}</td><td>${r.open_issues || 0}</td>
      <td>${r.commits || 0}</td>
      <td>${ciDisplay}</td>
      <td>${!r.license || r.license === 'None' ? `<span style="color:${COLOR_WARNING}">none</span>` : r.license}</td>
      <td><span style="color:${communityColor}">${r.communityHealth != null ? r.communityHealth + '%' : '—'}</span></td>
      <td>${vulnDisplay}</td>
      <td>${depDisplay}</td>
      <td>${r.contributors != null ? r.contributors : '—'}</td>
      <td><span class="badge ${badgeClass}">${r.status}</span></td>
      <td><span class="tier-badge tier-${tier}">${TIER_DISPLAY[tier]}</span></td></tr>`;
  }).join('');

  // --- Section 4+5: Weekly chart and deps as collapsible ---
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
<h2>Portfolio Pulse</h2>
<div class="chart-container" style="text-align:center;padding:2rem">
<div style="font-size:2.5rem;font-weight:700;color:#f0f6fc">${goldPct}% Gold</div>
<div style="font-size:1.2rem;margin-top:0.5rem">${tierParts}</div>
<div style="color:#8b949e;margin-top:0.5rem">${repos.length} repos — ${statusCounts.active || 0} active, ${(statusCounts.dormant || 0) + (statusCounts.archive || 0)} dormant/archive</div>
</div>
${buildPortfolioAttentionSection(classified, details, owner, config)}
<h2>Portfolio Health</h2>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Tier</th><th>Bugs</th><th>CI</th><th>Vulns</th><th>Next Step</th></tr></thead>
<tbody>${simplifiedRows}</tbody></table>
</div>
<details><summary>Show all columns (${repos.length} repos)</summary>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Lang</th><th>Stars</th><th>Issues</th><th>Commits</th><th>CI</th><th>License</th><th>Community</th><th>Vulns</th><th>Deps</th><th>Contributors</th><th>Status</th><th>Tier</th></tr></thead>
<tbody>${fullTableRows}</tbody></table>
</div>
</details>
${buildCampaignSection(repos, details)}
<details><summary>Commit Activity (26 weeks)</summary>
<div class="chart-container"><div class="chart-title">Weekly Commits by Repository</div><canvas id="weeklyChart" style="max-height:360px"></canvas></div>
</details>
${depInventory ? `<details><summary>Dependency Inventory</summary>${buildDependencyInventorySection(depInventory)}</details>` : ''}
<div class="footer">Generated by <a href="https://github.com/IsmaelMartinez/repo-butler">repo-butler</a></div>
<script>
Chart.defaults.color='#8b949e';Chart.defaults.borderColor='#21262d';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,monospace';
new Chart(document.getElementById('weeklyChart'),{type:'bar',data:{labels:[${weekLabels.map(l => `'${l}'`).join(',')}],datasets:[${weeklyDatasets}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{padding:10,font:{size:10}}}},scales:{x:{stacked:true,grid:{display:false},ticks:{maxRotation:45,font:{size:9}}},y:{stacked:true,beginAtZero:true,grid:{color:'#21262d'}}}}});
</script></body></html>`;
}
```

Note: the `weeklyChart` canvas is inside a `<details>` that may be closed. Chart.js handles this — it renders when the canvas becomes visible. If this causes issues, we can add an event listener, but try without first.

- [ ] **Step 4: Export buildPortfolioAttentionSection from report-portfolio.js**

Add to the exports. Also add `buildPortfolioAttentionSection` to the re-export in `report.js`:

```javascript
// In report.js, update the import line:
import {
  fetchPortfolioDetails, analyzeDependencyInventory,
  generatePortfolioReport, generateDigestReport,
  generateSparklineSVG, buildCampaignSection,
  buildPortfolioAttentionSection,
} from './report-portfolio.js';

// And add to re-exports:
export { generateSparklineSVG, buildCampaignSection, generateDigestReport, buildPortfolioAttentionSection } from './report-portfolio.js';
```

- [ ] **Step 5: Update existing portfolio report tests**

Existing tests that assert on the old structure (doughnut chart IDs, vanity stat cards, 13-column table as default) need updating. Search `report.test.js` for assertions on `langChart`, `statusChart`, `commitChart`, `Stars`, and update them to match the new structure.

- [ ] **Step 6: Add test for buildPortfolioAttentionSection**

```javascript
describe('buildPortfolioAttentionSection', () => {
  it('shows all-clear when no actions needed', async () => {
    const { buildPortfolioAttentionSection } = await import('./report-portfolio.js');
    const repos = [{ name: 'a' }];
    const details = { a: { vulns: { count: 0, max_severity: null }, codeScanning: null, secretScanning: null, ciPassRate: 0.95, open_bugs: 0 } };
    const html = buildPortfolioAttentionSection(repos, details, 'owner', {});
    assert.ok(html.includes('All clear'), 'should show all-clear message');
  });

  it('aggregates action items across repos', async () => {
    const { buildPortfolioAttentionSection } = await import('./report-portfolio.js');
    const repos = [{ name: 'a' }, { name: 'b' }];
    const details = {
      a: { vulns: { count: 2, critical: 1, high: 1, medium: 0, low: 0, max_severity: 'critical' }, codeScanning: null, secretScanning: null, ciPassRate: 0.95, open_bugs: 0 },
      b: { vulns: { count: 0, max_severity: null }, codeScanning: null, secretScanning: null, ciPassRate: 0.5, open_bugs: 0 },
    };
    const html = buildPortfolioAttentionSection(repos, details, 'owner', {});
    assert.ok(html.includes('Attention Required'), 'should have attention heading');
    assert.ok(html.includes('a.html'), 'should link to repo a');
    assert.ok(html.includes('b.html'), 'should link to repo b');
  });
});
```

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: all pass (365 + new tests).

- [ ] **Step 8: Commit**

```bash
git add src/report-portfolio.js src/report.js src/report.test.js
git commit -m "feat(report): restructure portfolio page — pulse, attention, simplified table"
```

---

### Task 3: Restructure per-repo page — merge health grid, move trends, collapsible sections

**Files:**
- Modify: `src/report-repo.js:649-743` (generateRepoReport)
- Modify: `src/report.test.js`

Changes to `generateRepoReport`:
1. Move stars/forks/watchers from a stat card to subtitle text
2. Keep action items and health tier sections as-is (sections 1-2)
3. Merge health grid data (9 cards) as inline annotations on tier checklist items
4. Move trends section from bottom to position 3 (right after tier)
5. Merge velocity imbalance alert into trends section
6. Merge PR triage + issue staleness under "Open Work" heading
7. Wrap velocity charts + release cadence + heatmap in collapsible "Activity History"
8. Wrap contributor stats in collapsible "Community"
9. Remove PR authors doughnut and issues-by-label bar chart

- [ ] **Step 1: Write failing tests for new structure**

```javascript
describe('generateRepoReport restructure', () => {
  it('has trends before open work and activity history collapsed', async () => {
    const { generateRepoReport } = await import('./report-repo.js');
    // Build minimal valid inputs
    const snapshot = {
      repository: 'owner/test', meta: { stars: 5, forks: 1, watchers: 2 },
      issues: { open: [] }, releases: [{ tag: 'v1', published_at: new Date().toISOString() }],
      community_profile: { health_percentage: 90, files: { readme: true, license: true, contributing: true, code_of_conduct: true, issue_template: true, pull_request_template: true } },
      dependabot_alerts: { count: 0, critical: 0, high: 0, medium: 0, low: 0, max_severity: null },
      code_scanning_alerts: null,
      secret_scanning_alerts: { count: 0 },
      ci_pass_rate: { pass_rate: 0.98, total_runs: 100, passed: 98, failed: 2 },
      pushed_at: new Date().toISOString(),
      license: 'MIT',
      sbom: null,
      summary: { open_issues: 0, open_bugs: 0, blocked_issues: 0, awaiting_feedback: 0, recently_merged_prs: 10, human_prs: 8, bot_prs: 2, releases: 1, latest_release: 'v1', ci_workflows: 4, bus_factor: 2, time_to_close_median: { median_days: 3, sample_size: 10 } },
    };
    const prActivity = [{ month: 'Jan', count: 5 }];
    const issueActivity = [{ month: 'Jan', opened: 2, closed: 3 }];
    const prAuthors = [{ author: 'dev', count: 8, firstTime: false }];
    const trends = { direction: 'stable', weeks: [{ week: 'W1', open_issues: 3, merged_prs: 2 }, { week: 'W2', open_issues: 2, merged_prs: 3 }] };

    const html = generateRepoReport(snapshot, prActivity, issueActivity, prAuthors, trends, null, [], null, [], null, null, {});

    // Trends should appear before Open Work / Activity History
    const trendsPos = html.indexOf('Trends');
    const activityPos = html.indexOf('Activity History');
    assert.ok(trendsPos > 0, 'should have Trends section');
    assert.ok(activityPos > 0, 'should have Activity History section');
    assert.ok(trendsPos < activityPos, 'Trends should come before Activity History');

    // Activity History should be collapsible
    assert.ok(html.includes('<details'), 'should use details elements');
    assert.ok(html.includes('Activity History'), 'should have Activity History label');

    // Should NOT have doughnut charts
    assert.ok(!html.includes('id="authorChart"'), 'should not have author doughnut');
    assert.ok(!html.includes('id="labelChart"'), 'should not have label chart');

    // Should NOT have separate Repository Health section
    assert.ok(!html.includes('Repository Health'), 'health grid merged into tier checklist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/report.test.js 2>&1 | grep -A2 'trends before'`
Expected: FAIL

- [ ] **Step 3: Rewrite generateRepoReport**

Replace the HTML template in `generateRepoReport`. Keep all the data prep code (lines 649-695) the same. Change the returned HTML string to follow the new section order:

1. Header (title, subtitle with stars/forks/watchers inline)
2. Summary cards (Open Issues, PRs Merged, Releases — drop Stars card)
3. Action items (buildActionabilitySection — unchanged)
4. Health Tier with inline annotations (enhanced buildHealthTierSection)
5. Trends (moved up, velocity alert merged in)
6. Open Work (PR triage + issue staleness merged)
7. `<details>` Activity History (cycle time, PR chart, issue chart, release chart, heatmap)
8. `<details>` Community (contributor stats)
9. Footer

The enhanced tier section: modify `buildHealthTierSection` to accept health data and show inline annotations. Add a new parameter `healthData` that includes the community profile, vuln counts, CI rate, bus factor, time-to-close, deps, and libyear. Each checklist row gets an annotation column showing the actual value.

- [ ] **Step 4: Modify buildHealthTierSection to include inline health annotations**

Add a `healthData` parameter to `buildHealthTierSection(snapshot, config, healthData)`. The `healthData` object is built from the snapshot in `generateRepoReport`. Each check row gets a third column with the relevant metric value. This replaces the separate 9-card health grid.

```javascript
function buildHealthTierSection(snapshot, config, healthData = {}) {
  const input = snapshotToTierInput(snapshot);
  const repoName = snapshot.repository?.split('/')[1] || '';
  const { tier, checks } = computeHealthTier(input, { releaseExempt: isReleaseExempt(repoName, config) });
  const color = TIER_COLORS[tier] || TIER_COLORS.none;
  const display = TIER_DISPLAY[tier] || 'Unranked';

  // Map check names to inline annotations from healthData
  const annotations = {
    'Has CI workflows (2+)': healthData.ciDetail || '',
    'Has CI workflows': healthData.ciDetail || '',
    'Has a license': healthData.license || '',
    'Fewer than 10 open bugs': healthData.bugDetail || '',
    'Fewer than 20 open issues': healthData.issueDetail || '',
    'Release in the last 90 days': healthData.releaseDetail || '',
    'Community health above 80%': healthData.communityDetail || '',
    'Community health above 50%': healthData.communityDetail || '',
    'Security scanning configured': healthData.scannerDetail || '',
    'Zero critical/high security findings': healthData.findingsDetail || '',
    'Activity in the last 6 months': healthData.activityDetail || '',
    'Some activity (within 1 year)': healthData.activityDetail || '',
  };

  const checkRows = checks.map(c => {
    const icon = c.passed ? '\u2713' : '\u2717';
    const iconColor = c.passed ? '#7ee787' : '#f85149';
    const tierLabel = c.required_for === 'gold' ? 'Gold' : c.required_for === 'silver' ? 'Silver' : 'Bronze';
    const annotation = annotations[c.name] || '';
    return `<tr>
      <td style="color:${iconColor};font-weight:600;text-align:center">${icon}</td>
      <td>${c.name}</td>
      <td><span class="tier-badge tier-${c.required_for}">${tierLabel}</span></td>
      <td style="color:#8b949e;font-size:0.8rem">${annotation}</td></tr>`;
  }).join('');

  // ... rest stays same (nextTierHtml logic)

  return `<h2>Health Tier</h2>
<div class="chart-container" style="text-align:center;padding-bottom:0.5rem">
<div style="font-size:3rem;font-weight:700;color:${color}">${display}</div>
<table style="margin-top:1rem;text-align:left"><thead><tr><th></th><th>Criteria</th><th>Required</th><th>Detail</th></tr></thead>
<tbody>${checkRows}</tbody></table>
${nextTierHtml}
</div>`;
}
```

Build `healthData` in `generateRepoReport` from snapshot fields:

```javascript
const healthData = {
  ciDetail: `${s.ci_workflows} workflows, ${cipr?.pass_rate != null ? Math.round(cipr.pass_rate * 100) + '% pass' : 'no data'}`,
  license: snapshot.license || '—',
  bugDetail: `${s.open_bugs ?? s.open_issues} ${s.open_bugs != null ? 'bugs' : 'issues'}`,
  issueDetail: `${s.open_issues} issues`,
  releaseDetail: s.latest_release !== 'none' ? s.latest_release : '—',
  communityDetail: cp ? `${cp.health_percentage}%` : '—',
  scannerDetail: [da && 'Dependabot', cs && 'Code Scanning', ss && 'Secret Scanning'].filter(Boolean).join(' + ') || 'none',
  findingsDetail: [da && `${da.count} vuln`, cs && `${cs.count} code`, ss && `${ss.count} secret`].filter(Boolean).join(', ') || '—',
  activityDetail: snapshot.pushed_at ? `pushed ${Math.floor((Date.now() - new Date(snapshot.pushed_at).getTime()) / 86400000)}d ago` : '—',
};
```

- [ ] **Step 5: Build the new HTML template for generateRepoReport**

The returned HTML becomes:

```javascript
return `<!DOCTYPE html>
<html lang="en">
...
<h1>...</h1>
<div class="subtitle">${snapshot.meta?.stars || 0} stars · ${snapshot.meta?.forks || 0} forks · ${snapshot.meta?.watchers || 0} watchers — ${now} — <a href="index.html">portfolio view</a> — <a href="digest.html">weekly digest</a></div>
<div class="grid">
  <div class="card"><h3>Open Issues</h3><div class="stat">${s.open_issues}</div><div class="stat-label">${s.blocked_issues} blocked, ${s.awaiting_feedback} awaiting feedback</div></div>
  <div class="card"><h3>PRs Merged (90d)</h3><div class="stat">${s.recently_merged_prs}</div><div class="stat-label">${s.human_prs} human, ${s.bot_prs} bot</div></div>
  <div class="card"><h3>Releases</h3><div class="stat">${s.releases}</div><div class="stat-label">Latest: ${s.latest_release}</div></div>
</div>
${buildActionabilitySection(snapshot, openPRs)}
${buildHealthTierSection(snapshot, config, healthData)}
${buildVelocityAlert(detectVelocityImbalance(issueActivity))}
${trendsHtml}
<h2>Open Work</h2>
${buildPRTriageSection(openPRs, snapshot.repository) || '<div class="chart-container" style="text-align:center;padding:1rem;color:#8b949e">No open PRs</div>'}
${buildStalenessSection(snapshot)}
<details><summary>Activity History</summary>
${buildCycleTimeCard(cycleTime)}
<div class="chart-container"><div class="chart-title">Merged PRs per Month</div><canvas id="prChart"></canvas></div>
<div class="chart-container"><div class="chart-title">Issues Opened vs Closed per Month</div><canvas id="issueChart"></canvas></div>
<div class="chart-container"><div class="chart-title">Days Between Releases</div><canvas id="releaseChart"></canvas></div>
${buildCalendarHeatmap(weeklyCommits)}
</details>
<details><summary>Community</summary>
${buildContributorCard(prAuthors, snapshot.meta?.stars || 0)}
</details>
<div class="footer">...</div>
<script>
// Same Chart.js init but remove authorChart and labelChart
Chart.defaults.color='#8b949e';...
new Chart(document.getElementById('prChart'), ...);
new Chart(document.getElementById('issueChart'), ...);
new Chart(document.getElementById('releaseChart'), ...);
${trendsJs}
</script></body></html>`;
```

Remove the authorChart (doughnut) and labelChart (bar) Chart.js instantiations. Remove the `Contribution & Issues` heading and the `two-col` div containing them.

- [ ] **Step 6: Update existing per-repo tests**

Update any tests that assert on `Repository Health` heading, `authorChart`, `labelChart`, or the old section ordering.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/report-repo.js src/report.test.js
git commit -m "feat(report): restructure per-repo page — merged health grid, collapsible sections"
```

---

### Task 4: Wrap campaign non-compliant lists in collapsible details

**Files:**
- Modify: `src/report-portfolio.js:321-343` (buildCampaignSection, the card rendering)

- [ ] **Step 1: Write failing test**

```javascript
it('wraps non-compliant repos in details element', async () => {
  const { buildCampaignSection } = await import('./report-portfolio.js');
  const repos = [
    { name: 'a', archived: false, fork: false },
    { name: 'b', archived: false, fork: false },
  ];
  const details = {
    a: { communityHealth: 90, vulns: { count: 0, max_severity: null }, ciPassRate: 0.95, license: 'MIT', hasIssueTemplate: true },
    b: { communityHealth: 40, vulns: null, ciPassRate: 0.5, license: 'None', hasIssueTemplate: false },
  };
  const html = buildCampaignSection(repos, details);
  // Non-compliant repos should be inside a details element
  assert.ok(html.includes('<details'), 'non-compliant list should be collapsible');
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current code renders non-compliant repos inline, not in `<details>`.

- [ ] **Step 3: Wrap non-compliant list in details**

In `buildCampaignSection`, change the `nonCompliantList` assignment:

```javascript
const nonCompliantList = nonCompliant.length > 0
  ? `<details><summary style="font-size:0.75rem;color:#8b949e;cursor:pointer">${nonCompliant.length} repo${nonCompliant.length !== 1 ? 's' : ''} need attention</summary><div class="campaign-repos" style="margin-top:0.3rem">${nonCompliant.map(r => `<a href="${r.name}.html">${escHtml(r.name)}</a>`).join(', ')}</div></details>`
  : `<div class="campaign-repos" style="color:${COLOR_SUCCESS}">All repos compliant</div>`;
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/report-portfolio.js src/report.test.js
git commit -m "feat(report): collapse non-compliant campaign repos behind toggle"
```

---

### Task 5: Final integration test and cleanup

**Files:**
- Modify: `src/report.test.js` (if needed)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Verify all tests pass, no regressions.

- [ ] **Step 2: Run the report locally in dry-run mode to visually verify**

Run: `INPUT_DRY_RUN=true INPUT_PHASE=report npm start 2>&1 | tail -20`

This won't write to GitHub but will generate HTML files in the `reports/` directory. Open `reports/index.html` and a per-repo report to verify the layout matches the spec.

- [ ] **Step 3: Clean up any temporary files**

Remove any scratch files created during development.

- [ ] **Step 4: Final commit if any test fixes were needed**

```bash
git add -A
git commit -m "test: update report tests for dashboard restructure"
```
