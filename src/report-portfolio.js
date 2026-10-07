// Portfolio-level report rendering: portfolio dashboard, digest, and dependency
// inventory. The data these render is fetched in report-portfolio-data.js.

import { CSS, SITE_FOOTER, htmlPage, THEME_INIT, THEME_TOGGLE, THEME_TOGGLE_JS } from './report-styles.js';
import { buildActionItems } from './report-repo.js';
import { detectTierChanges } from './tier-change.js';
import {
  SIX_MONTHS_AGO, ONE_YEAR_AGO,
  TIER_DISPLAY, TIER_RANK, COLOR_SUCCESS, COLOR_WARNING, COLOR_DANGER,
  REPO_EXCLUSION_PATTERNS, isExcludedRepo,
  escHtml, fmt, countBy, daysAgo,
  getLibyearColor, isReleaseExempt, isCopyleft, describeLicenseConcern,
  CAMPAIGN_DEFS, evaluateCampaign, buildRepoSnapshot, colorByThreshold, nextTier, isHighSeverity, isCheckRequiredForTier, deployedLink,
  isAutofixNotDriven, computeCountTrend, isScannerUnreadable,
  tierStatus, tierBadge, isRecordProvisional, securityState, unreadScannerNames, hasUnreadableScanner, observedFailingChecks,
} from './report-shared.js';

// The Dependabot cell shared by both repo tables; `naCell` is each table's
// rendering of null ("not available"). An unreadable read (#452) has no count
// to show, and "n/a" alone would read as the scanner being off.
function vulnCell(vulns, naCell) {
  if (vulns == null) return naCell;
  if (isScannerUnreadable(vulns)) return '<span title="Dependabot alerts could not be read this run" style="color:var(--faint);cursor:help">unavailable</span>';
  if (vulns.count === 0) return `<span style="color:${COLOR_SUCCESS}">0</span>`;
  return `<span style="color:${isHighSeverity(vulns) ? COLOR_DANGER : COLOR_WARNING}">${vulns.count}</span>`;
}

// Range tuples shared by the portfolio dashboard. Each describes a
// "value-to-colour" mapping consumed by `colorByThreshold`.
const PCT_HIGH_GOOD_RANGES = [
  { lt: 50, color: COLOR_DANGER },
  { lt: 80, color: COLOR_WARNING },
  { lt: Infinity, color: COLOR_SUCCESS },
];
const CI_PASS_PCT_RANGES = [
  { lt: 70, color: COLOR_DANGER },
  { lt: 90, color: COLOR_WARNING },
  { lt: Infinity, color: COLOR_SUCCESS },
];
const OPEN_ISSUES_RANGES = [
  { lt: 1, color: COLOR_SUCCESS },
  { lt: 20, color: COLOR_WARNING },
  { lt: Infinity, color: COLOR_DANGER },
];
const OPEN_PRS_RANGES = [
  { lt: 1, color: COLOR_SUCCESS },
  { lt: 5, color: COLOR_WARNING },
  { lt: Infinity, color: COLOR_DANGER },
];

// Hero intro shown at the top of the portfolio dashboard. Two-to-three
// sentences orienting first-time visitors and linking back to the source repo.
const HERO_INTRO = `<div class="hero-intro">
<strong>Repo Butler</strong> is a GitHub Action that runs a seven-phase pipeline — <em>OBSERVE → ASSESS → UPDATE → GOVERNANCE → IDEATE → PROPOSE → REPORT</em> — across a portfolio of repositories, generating this dashboard, opening improvement issues, and surfacing governance findings. It runs four times a day on GitHub Actions with zero npm dependencies. Source and docs: <a href="https://github.com/IsmaelMartinez/repo-butler">github.com/IsmaelMartinez/repo-butler</a>.
</div>`;

// Collapsible "How it works" section. Phase descriptions mirror the README's
// "How it works" section verbatim — keep them in sync if either changes.
const ABOUT_SECTION = `<details>
<summary>About — How it works</summary>
<div class="chart-container">
<ul class="about-phases">
<li><strong>OBSERVE</strong> — gathers project state via the GitHub API (issues, PRs, releases, labels, workflows, roadmap content) and classifies all portfolio repos by activity level. No LLM needed.</li>
<li><strong>ASSESS</strong> — diffs the current snapshot against the previous run, computes weekly trends (growing/shrinking/stable), and optionally summarises changes with Gemini Flash.</li>
<li><strong>UPDATE</strong> — generates an updated roadmap document, validates it through a safety layer, and opens a PR.</li>
<li><strong>GOVERNANCE</strong> — runs deterministic detectors over the portfolio — standards gaps, policy drift, tier-uplift opportunities, tier regressions, open vulnerabilities, stale Dependabot PRs — and persists findings to the data branch. No LLM cost, so the daily pipeline runs it 4×/day.</li>
<li><strong>IDEATE</strong> — generates improvement ideas using an LLM (Claude for deeper reasoning, Gemini Flash as default), feeding off the fresh governance findings.</li>
<li><strong>PROPOSE</strong> — safety-filters ideas (URL allowlist, @mention blocking, secret detection), then creates GitHub issues capped at <code>max_issues_per_run</code>, sorted by priority, labelled for human review.</li>
<li><strong>REPORT</strong> — generates HTML dashboards for every active repo in the portfolio, deployed to GitHub Pages.</li>
</ul>
</div>
</details>`;


// --- Sparkline SVG ---

export function generateSparklineSVG(weeklyData) {
  const WIDTH = 80;
  const HEIGHT = 20;
  const PADDING = 2;
  // currentColor so the stroke follows the themed `.spark { color: var(--accent-line) }`
  // rule — SVG presentation attributes can't reference CSS custom properties directly.
  const STROKE_COLOR = 'currentColor';
  const STROKE_WIDTH = 1.5;
  const MUTED_OPACITY = 0.4;

  if (!weeklyData || !Array.isArray(weeklyData) || weeklyData.length === 0) return '';

  const svgOpen = `<svg class="spark" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">`;
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


// --- Campaign section ---

export function buildCampaignSection(repos, details) {
  // Filter to active, non-fork, non-test repos.
  const eligible = repos
    .filter(r => !r.archived && !r.fork && !REPO_EXCLUSION_PATTERNS.some(p => r.name.includes(p)));

  if (eligible.length === 0) return '';

  const cards = CAMPAIGN_DEFS.map(campaign => {
    const { total, compliant, nonCompliant, percentage: pct } = evaluateCampaign(campaign, eligible, details);
    const count = compliant.length;
    const barColor = colorByThreshold(pct, PCT_HIGH_GOOD_RANGES);
    const nonCompliantList = nonCompliant.length > 0
      ? `<details><summary class="muted text-sm" style="cursor:pointer">${nonCompliant.length} repo${nonCompliant.length !== 1 ? 's' : ''} need attention</summary><div class="campaign-repos" style="margin-top:0.3rem">${nonCompliant.map(r => `<a href="${r.name}.html">${escHtml(r.name)}</a>`).join(', ')}</div></details>`
      : `<div class="campaign-repos" style="color:${COLOR_SUCCESS}">All repos compliant</div>`;

    return `<div class="campaign-card">
<div class="campaign-header"><h3>${escHtml(campaign.name)}</h3><span class="campaign-ratio">${count}/${total}</span></div>
<div class="campaign-desc">${escHtml(campaign.description)}</div>
<div class="campaign-bar"><div class="campaign-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
<div class="campaign-pct">${pct}% complete${total < eligible.length ? ` <span style="color:var(--faint)">(${eligible.length - total} repos excluded — data unavailable)</span>` : ''}</div>
${nonCompliantList}
</div>`;
  }).join('\n');

  return `<h2>Improvement Campaigns</h2>
<div class="campaign-grid">
${cards}
</div>`;
}


// --- Governance findings section ---

// Human-readable labels for the built-in standard detectors. Falls back to
// the raw tool name so config-defined standards still render sensibly.
const STANDARD_LABELS = {
  'issue-form-templates': 'Issue form templates',
  'contributing-guide': 'CONTRIBUTING guide',
  'license': 'License',
  'dependabot-actions': 'Dependabot alerts access',
  'dependabot-auto-merge': 'Dependabot auto-merge',
  'ci-workflows': 'CI workflows',
  'codeowners': 'CODEOWNERS',
  'security-md': 'Security policy',
  'code-review-bot': 'Copilot code review',
  'release-cadence': 'Release automation',
  'osv-scanner': 'Dependency scanning',
};

// Human labels for the butler-PR staleness states (src/butler-pr-audit.js).
const STALE_PR_STATE_LABEL = {
  'awaiting-human': 'awaiting merge',
  'blocked-persistent': 'blocked (persistent)',
  'blocked-transient': 'blocked',
  'ci-none': 'no CI',
  'ci-pending': 'CI running',
  unknown: 'unknown',
  unclassified: 'not checked',
};

const DRIFT_LABELS = {
  'license': 'License',
  'ci-reliability': 'CI reliability',
  'community-health': 'Community health',
};

const PRIORITY_COLOR = {
  high: COLOR_DANGER,
  medium: COLOR_WARNING,
  low: 'var(--muted)',
};

function repoLinks(names) {
  return names.map(n => `<a href="${escHtml(n)}.html">${escHtml(n)}</a>`).join(', ');
}

export function buildGovernanceSection(findings) {
  if (!findings || findings.length === 0) return '';

  const gaps = findings.filter(f => f.type === 'standards-gap');
  const drift = findings.filter(f => f.type === 'policy-drift');
  const uplift = findings.filter(f => f.type === 'tier-uplift');
  const openVulns = findings.filter(f => f.type === 'open-vulnerability');
  const regressions = findings.filter(f => f.type === 'tier-regression');
  const staleButlerPRs = findings.filter(f => f.type === 'stale-butler-pr');
  const stalledAlerts = findings.filter(f => f.type === 'stalled-alert');

  const parts = [];

  // Remediation breakdown (ADR-007): how the findings route by executor —
  // template (the apply pipeline opens a templated PR), settings (the apply
  // pipeline writes a repo setting/ruleset, ADR-009), agent (a local agent drafts
  // a tailored PR), manual (needs the owner's own judgement).
  const byExecutor = { template: 0, settings: 0, agent: 0, manual: 0 };
  for (const f of findings) {
    const ex = f.remediation?.executor;
    if (ex != null && Object.hasOwn(byExecutor, ex)) byExecutor[ex]++;
  }
  const executorBits = [];
  if (byExecutor.template) executorBits.push(`${byExecutor.template} template (auto-applies)`);
  if (byExecutor.settings) executorBits.push(`${byExecutor.settings} settings (ruleset write)`);
  if (byExecutor.agent) executorBits.push(`${byExecutor.agent} agent (local PR)`);
  if (byExecutor.manual) executorBits.push(`${byExecutor.manual} manual (your hand)`);
  if (executorBits.length > 0) {
    parts.push(`<p class="muted">By remediation: ${executorBits.join(' &middot; ')}</p>`);
  }

  // Open vulnerabilities lead the section — it is the most urgent governance
  // state. Each row lists the affected repo, which scanner(s) fired, and the
  // open critical/high counts (+ secret-scanning hits).
  if (openVulns.length > 0) {
    const rows = openVulns
      .slice()
      .sort((a, b) => {
        const pa = a.priority === 'high' ? 0 : 1;
        const pb = b.priority === 'high' ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return (b.critical + b.high) - (a.critical + a.high);
      })
      .map(v => {
        const counts = [];
        if (v.critical) counts.push(`${v.critical} critical`);
        if (v.high) counts.push(`${v.high} high`);
        if (v.secretScanning) counts.push(`${v.secretScanning} secret-scanning`);
        // Dependabot autofix state (ADR-012 Phase 3): only meaningful for
        // dependabot-sourced findings (autofixEnabled is present). "in flight" =
        // GitHub is opening the bump PRs; "not driven" = the alerts are unattended;
        // "unknown" = state unreadable. A code/secret-only finding shows "—".
        let autofixCell = '<span class="muted">—</span>';
        if (v.autofixEnabled === true) autofixCell = `<span style="color:${COLOR_SUCCESS}">✓ in flight</span>`;
        else if (v.autofixEnabled === false) autofixCell = `<span style="color:${COLOR_DANGER}">✗ not driven</span>`;
        else if (v.autofixEnabled === null) autofixCell = '<span class="muted">unknown</span>';
        return `<tr>
  <td><a href="${escHtml(v.repo)}.html">${escHtml(v.repo)}</a></td>
  <td><span style="color:${PRIORITY_COLOR[v.priority] || 'var(--muted)'}">${escHtml(v.priority)}</span></td>
  <td>${escHtml((v.sources || []).join(', '))}</td>
  <td>${escHtml(counts.join(', ') || 'open alerts')}</td>
  <td>${autofixCell}</td>
</tr>`;
      })
      .join('');
    parts.push(`<h3>Open Vulnerabilities</h3>
<p class="muted">Dependabot autofix: <em>in flight</em> = GitHub's automated security fixes are opening the bump PRs; <em>not driven</em> = enable them via the <code>dependabot-security</code> apply action.</p>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Priority</th><th>Source</th><th>Open alerts</th><th>Dependabot autofix</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`);
  }

  // Tier regressions come right after open vulnerabilities: a lost tier is the
  // G7 Gold-ratchet loss signal, more urgent than the opportunity tables below.
  // The remediation route back up lives in the companion Tier Uplift row.
  if (regressions.length > 0) {
    const rows = regressions
      .slice()
      .sort((a, b) => {
        const pa = a.priority === 'high' ? 0 : 1;
        const pb = b.priority === 'high' ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.repo.localeCompare(b.repo);
      })
      .map(g => `<tr>
  <td><a href="${escHtml(g.repo)}.html">${escHtml(g.repo)}</a></td>
  <td><span class="tier-badge tier-${escHtml(g.previousTier)}">${escHtml(TIER_DISPLAY[g.previousTier] || g.previousTier)}</span> → <span class="tier-badge tier-${escHtml(g.currentTier)}">${escHtml(TIER_DISPLAY[g.currentTier] || g.currentTier)}</span></td>
  <td><span style="color:${PRIORITY_COLOR[g.priority] || 'var(--muted)'}">${escHtml(g.priority)}</span></td>
  <td>${escHtml(g.priorWeek || '—')}</td>
</tr>`)
      .join('');
    parts.push(`<h3>Tier Regressions</h3>
<p class="muted">Repos whose health tier fell since the previous weekly snapshot. The way back up is in Tier Uplift Opportunities below.</p>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Change</th><th>Priority</th><th>Since</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`);
  }

  // Stalled Dependabot alerts (G13) sit with the other security state, above
  // the opportunity tables: an alert nobody is driving is closer to an open
  // vulnerability than to a standards gap. The classification is the actionable
  // column — `reachable-by-update` means a lockfile refresh clears it.
  if (stalledAlerts.length > 0) {
    const rows = stalledAlerts
      .slice()
      .sort((a, b) => a.repo.localeCompare(b.repo))
      .map(f => {
        const oldest = f.alerts.reduce((max, a) => Math.max(max, a.ageDays || 0), 0);
        const detail = f.alerts
          .slice()
          .sort((a, b) => b.ageDays - a.ageDays)
          // Package name, age and classification only — the advisory summary is
          // never carried on the finding at all, and `detail` is built from
          // target-repo lockfile contents, so everything here is escaped.
          .map(a => `${escHtml(a.package)} <span class="muted">(${escHtml(String(a.ageDays))}d, ${escHtml(a.severity || 'unknown')}, ${escHtml(a.classification)})</span>`)
          .join(', ');
        return `<tr>
  <td><a href="${escHtml(f.repo)}.html">${escHtml(f.repo)}</a></td>
  <td>${f.alerts.length}</td>
  <td>${escHtml(String(oldest))}d</td>
  <td>${detail}</td>
</tr>`;
      })
      .join('');
    parts.push(`<h3>Stalled Alerts</h3>
<p class="muted">Open Dependabot alerts past the staleness threshold with no Dependabot PR addressing them. <em>reachable-by-update</em> = a lockfile refresh clears it and nobody has run one; <em>unknown</em> = the manifest or lockfile could not be read, which never suppresses the row.</p>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Alerts</th><th>Oldest</th><th>Detail</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`);
  }

  // The butler's own PRs that never landed. Rendered explicitly because a
  // finding type with no block here silently inflates the "Governance (N)"
  // header and then vanishes from the page — which is how `dependabot-stale`
  // currently behaves, and would defeat G12's whole purpose.
  if (staleButlerPRs.length > 0) {
    const rows = staleButlerPRs
      .slice()
      .sort((a, b) => a.repo.localeCompare(b.repo))
      .map(f => {
        const oldest = f.stalePRs.reduce((max, p) => Math.max(max, p.age || 0), 0);
        const detail = f.stalePRs
          .slice()
          .sort((a, b) => b.age - a.age)
          // `draft` is surfaced because a draft PR reads as "awaiting merge"
          // otherwise, which inverts the meaning: nobody is ignoring it, a human
          // deliberately parked it.
          .map(p => `#${escHtml(String(p.number))} <span class="muted">(${escHtml(String(p.age))}d, ${escHtml(STALE_PR_STATE_LABEL[p.state] || p.state)}${p.draft ? ', draft' : ''}${p.verified === false ? ', unverified' : ''})</span>`)
          .join(', ');
        return `<tr>
  <td><a href="${escHtml(f.repo)}.html">${escHtml(f.repo)}</a></td>
  <td>${f.stalePRs.length}</td>
  <td>${escHtml(String(oldest))}d</td>
  <td>${detail}</td>
</tr>`;
      })
      .join('');
    parts.push(`<h3>Stale Butler PRs</h3>
<p class="muted">Pull requests the butler opened and nobody landed. <em>awaiting merge</em> = green and mergeable, just ignored; <em>blocked (persistent)</em> = failing identically every attempt, so a rebase will not help.</p>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>PRs</th><th>Oldest</th><th>Detail</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`);
  }

  if (gaps.length > 0) {
    const rows = gaps
      .slice()
      .sort((a, b) => a.adoptionRate - b.adoptionRate)
      .map(g => {
        const label = STANDARD_LABELS[g.tool] || g.tool;
        const scopeLabel = g.scope?.type === 'ecosystem'
          ? `<span class="muted" style="font-size:0.8rem"> (${escHtml(g.scope.language)} only)</span>`
          : '';
        const pct = Math.round(g.adoptionRate * 100);
        return `<tr>
  <td><strong>${escHtml(label)}</strong>${scopeLabel}</td>
  <td><span style="color:${PRIORITY_COLOR[g.priority] || 'var(--muted)'}">${escHtml(g.priority)}</span></td>
  <td>${pct}% adopted</td>
  <td>${g.nonCompliant.length} need this: ${repoLinks(g.nonCompliant)}</td>
</tr>`;
      })
      .join('');
    parts.push(`<h3>Standards Gaps</h3>
<div class="chart-container">
<table><thead><tr><th>Standard</th><th>Priority</th><th>Adoption</th><th>Repos needing action</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`);
  }

  if (drift.length > 0) {
    // Group drift by category for easier scanning.
    const byCategory = {};
    for (const d of drift) {
      if (!byCategory[d.category]) byCategory[d.category] = [];
      byCategory[d.category].push(d);
    }
    const rows = Object.entries(byCategory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, items]) => {
        const label = DRIFT_LABELS[category] || category;
        const cells = items
          .map(d => `<a href="${escHtml(d.repo)}.html">${escHtml(d.repo)}</a> <span class="muted" style="font-size:0.8rem">(${escHtml(String(d.actual))} vs ${escHtml(String(d.expected))})</span>`)
          .join(', ');
        return `<tr><td><strong>${escHtml(label)}</strong></td><td>${cells}</td></tr>`;
      })
      .join('');
    parts.push(`<h3>Policy Drift</h3>
<div class="chart-container">
<table><thead><tr><th>Category</th><th>Diverging repos</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`);
  }

  if (uplift.length > 0) {
    const rows = uplift
      .slice()
      .sort((a, b) => {
        // High priority (silver→gold) first, then smallest gap first.
        const pa = a.priority === 'high' ? 0 : 1;
        const pb = b.priority === 'high' ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.failingChecks.length - b.failingChecks.length;
      })
      .map(u => {
        const checks = u.failingChecks.map(c => escHtml(c.name)).join(', ');
        return `<tr>
  <td><a href="${escHtml(u.repo)}.html">${escHtml(u.repo)}</a></td>
  <td>${escHtml(TIER_DISPLAY[u.currentTier] || u.currentTier)} → ${escHtml(TIER_DISPLAY[u.targetTier] || u.targetTier)}</td>
  <td><span style="color:${PRIORITY_COLOR[u.priority] || 'var(--muted)'}">${escHtml(u.priority)}</span></td>
  <td>${checks}</td>
</tr>`;
      })
      .join('');
    parts.push(`<h3>Tier Uplift Opportunities</h3>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Path</th><th>Priority</th><th>Remaining checks</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`);
  }

  if (parts.length === 0) return '';

  return `<h2>Governance (${findings.length})</h2>
${parts.join('\n')}`;
}


// --- Portfolio attention section ---

export function buildPortfolioAttentionSection(repos, details, owner, config) {
  const allItems = [];
  for (const r of repos) {
    const d = details[r.name];
    if (!d) continue;
    const snapshot = buildRepoSnapshot({ owner, repo: r.name, details: d });
    const items = buildActionItems(snapshot, []);
    for (const item of items) {
      allItems.push({ ...item, repo: r.name });
    }
  }

  allItems.sort((a, b) => a.priority - b.priority);
  const top10 = allItems.slice(0, 10);

  if (top10.length === 0) {
    // No action items is not an all-clear while a scanner went unread (#477):
    // an unread alert produces no item, so the silence proves nothing.
    const unread = repos.filter(r => hasUnreadableScanner(details[r.name])).length;
    if (unread > 0) {
      return `<h2>Needs your attention</h2>
<div class="chart-container"><p class="muted" style="margin:0">Nothing for your hand that I could see, though I could not read the security alerts for ${repoCount(unread)}, so I shan't call it all clear.</p></div>`;
    }
    return `<h2>Needs your attention</h2>
<div class="chart-container"><p class="text-success" style="margin:0">All clear across the portfolio — nothing for your hand today. I'll mind the place.</p></div>`;
  }

  const effortColor = { 'quick win': 'var(--color-success)', 'moderate': 'var(--color-warning)', 'significant': 'var(--color-danger)' };
  const rows = top10.map((item, i) => `<tr>
    <td class="muted" style="font-weight:600">${i + 1}</td>
    <td><a href="${escHtml(item.repo)}.html">${escHtml(item.repo)}</a></td>
    <td>${item.text}</td>
    <td><span style="color:${effortColor[item.effort] || 'var(--muted)'}">${item.effort}</span></td>
  </tr>`).join('');

  return `<h2>Needs your attention</h2>
<div class="chart-container">
<table><thead><tr><th>#</th><th>Repo</th><th>Action</th><th>Effort</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`;
}


// --- Dependency inventory section ---

function buildDependencyInventorySection(inventory) {
  if (!inventory || inventory.reposWithSBOM === 0) return '';

  let html = `<h2>Dependency Inventory</h2>
<div class="grid">
  <div class="card"><h3>Total Unique Dependencies</h3><div class="stat">${fmt(inventory.totalUnique)}</div><div class="stat-label">across ${inventory.reposWithSBOM} repos with SBOM</div></div>
  <div class="card"><h3>Shared Dependencies</h3><div class="stat">${inventory.sharedDepsTotal}</div><div class="stat-label">used in 2+ repos</div></div>
  <div class="card"><h3>License Notes</h3><div class="stat" style="color:${inventory.licenseFlags.some(f => f.level === 'high') ? 'var(--color-danger)' : inventory.licenseFlags.length > 0 ? 'var(--muted)' : 'var(--color-success)'}">${inventory.licenseFlags.filter(f => f.level === 'high').length || (inventory.licenseFlags.length > 0 ? inventory.licenseFlags.length + ' low-risk' : 0)}</div><div class="stat-label">${inventory.licenseFlags.some(f => f.level === 'high') ? 'high-concern copyleft deps' : 'copyleft deps (low risk for non-commercial use)'}</div></div>
</div>`;

  if (inventory.commonDeps.length > 0) {
    const rows = inventory.commonDeps.map(d => {
      const licenseDisplay = d.licenses.length > 0 ? d.licenses.join(', ') : 'unknown';
      const hasCopyleft = d.licenses.some(l => isCopyleft(l));
      const licenseColor = hasCopyleft ? 'var(--color-warning)' : 'var(--muted)';
      return `<tr><td>${escHtml(d.name)}</td><td>${d.repoCount}</td><td><span style="color:${licenseColor}">${escHtml(licenseDisplay)}</span></td></tr>`;
    }).join('');
    html += `<div class="chart-container">
<div class="chart-title">Most Common Dependencies (used in 2+ repos)</div>
<table><thead><tr><th>Package</th><th>Repos</th><th>License</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`;
  }

  if (inventory.licenseFlags.length > 0) {
    const highFlags = inventory.licenseFlags.filter(f => f.level === 'high');
    const lowFlags = inventory.licenseFlags.filter(f => f.level !== 'high');

    // Only show detailed cards for high-concern licenses (AGPL etc.)
    if (highFlags.length > 0) {
      const byLicense = {};
      for (const f of highFlags) {
        if (!byLicense[f.license]) byLicense[f.license] = [];
        byLicense[f.license].push(f);
      }
      const licenseCards = Object.entries(byLicense).map(([license, flags]) => {
        const concern = describeLicenseConcern(license);
        const depRows = flags.map(f =>
          `<tr><td>${escHtml(f.repo || 'unknown')}</td><td>${escHtml(f.dep || 'unknown')}</td></tr>`
        ).join('');
        return `<div class="chart-container" style="margin-bottom:1rem">
<div class="chart-title"><span style="color:${COLOR_DANGER}">${escHtml(license)}</span> <span class="muted" style="font-size:0.85rem">— ${escHtml(concern.note)}</span></div>
<table><thead><tr><th>Repo</th><th>Dependency</th></tr></thead>
<tbody>${depRows}</tbody></table>
</div>`;
      }).join('');
      html += `<h3 style="margin-top:1.5rem;color:var(--ink)">License Concerns</h3>${licenseCards}`;
    }

    // Show low-concern copyleft as a collapsed summary
    if (lowFlags.length > 0) {
      const byLicense = {};
      for (const f of lowFlags) {
        if (!byLicense[f.license]) byLicense[f.license] = [];
        byLicense[f.license].push(f);
      }
      const summaryRows = Object.entries(byLicense).map(([license, flags]) => {
        const concern = describeLicenseConcern(license);
        const uniqueDeps = [...new Set(flags.map(f => f.dep))];
        const deps = uniqueDeps.slice(0, 3).map(d => escHtml(d)).join(', ');
        const more = uniqueDeps.length > 3 ? ` +${uniqueDeps.length - 3} more` : '';
        return `<tr><td class="muted">${escHtml(license)}</td><td class="muted">${deps}${more}</td><td class="muted">${escHtml(concern.note)}</td></tr>`;
      }).join('');
      html += `<details style="margin-top:1rem"><summary class="muted" style="cursor:pointer">Low-risk copyleft dependencies (${lowFlags.length}) — fine for non-commercial use</summary>
<table style="margin-top:0.5rem"><thead><tr><th>License</th><th>Dependencies</th><th>Note</th></tr></thead>
<tbody>${summaryRows}</tbody></table>
</details>`;
    }
  }

  return html;
}


// --- Status hero, delta strip, and the butler's voice ---

// Reginald's voice on the dashboard. Static, author-controlled strings (never
// external input), kept brief and public-appropriate — a light butler touch on
// the headline and the empty states, with the household's tea-and-whisky
// tradition surfacing only on the genuinely good days. One line per state so
// the page reads the same every visit; the data carries the rest.
const BUTLER_STATUS = {
  healthy: {
    headline: 'All in good order',
    line: `The portfolio's in fine fettle — I'll keep watch, and perhaps pour myself a small dram.`,
  },
  attention: {
    headline: 'A few things for your eye',
    line: `Nothing alarming, sir. A nudge or two below, when the moment suits.`,
  },
  critical: {
    headline: 'This rather wants your attention',
    line: `A critical matter has surfaced. I'd see to it before the tea goes cold.`,
  },
};
const SINCE_EMPTY = `Nothing's stirred since my last round. A quiet portfolio is a contented one.`;
const SINCE_FIRST_RUN = `Still settling in — once I've a prior round to compare, I'll report what's changed.`;

// True when a repo (current classified object or a stored portfolio-weekly
// summary — both carry vulns/codeScanning/secretScanning) has open critical or
// high security findings that were read. The portfolio's single most urgent
// signal, so it lists observed risk only.
function repoAtRisk(r) {
  return securityState(r) === 'at-risk';
}

// "N repos" with the plural the count needs.
const repoCount = n => `${n} repo${n === 1 ? '' : 's'}`;

// The week-over-week Gold % on one cohort (#477): the repos present in both
// weeks and confirmed in both. A repo provisional on either side is left out,
// or one that merely went unread reads as a Gold dip and its recovery as a
// rise; a repo in only one week is left out, or joining or leaving the
// portfolio moves the trend on its own. Null when no shared repo remains.
function goldTrendOf(classified, priorPortfolio) {
  const priorRepos = priorPortfolio?.repos;
  if (!priorRepos) return null;
  const cohort = classified.filter(r => !r._provisional && Object.hasOwn(priorRepos, r.name)
    && priorRepos[r.name]?.computed?.tier && !isRecordProvisional(priorRepos[r.name]));
  if (cohort.length === 0) return null;
  const pct = gold => Math.round((gold / cohort.length) * 100);
  return {
    current: pct(cohort.filter(r => r._tier === 'gold').length),
    previous: pct(cohort.filter(r => priorRepos[r.name].computed.tier === 'gold').length),
  };
}

// The portfolio's overall state, which drives the headline, the status colour,
// and which sections open themselves. Critical when anything has an open
// critical/high alert; attention when a repo is below Gold or a high-priority
// governance finding is open; healthy otherwise.
function computePortfolioState(classified, atRisk, governanceFindings) {
  if (atRisk.length > 0) return 'critical';
  const highGov = Array.isArray(governanceFindings) && governanceFindings.some(f => f?.priority === 'high');
  // An empty portfolio (everything archived/forked/excluded) is "all clear",
  // not "attention" — `every` on an empty list is already true, so don't force
  // it false on length 0.
  const allGold = classified.every(r => r._tier === 'gold');
  if (!allGold || highGov) return 'attention';
  return 'healthy';
}

// A single top-of-page banner for genuinely urgent security state.
function buildCriticalBanner(atRisk) {
  if (!atRisk || atRisk.length === 0) return '';
  const shown = atRisk.slice(0, 5).map(r => `<a href="${escHtml(r.name)}.html">${escHtml(r.name)}</a>`).join(', ');
  const more = atRisk.length > 5 ? ` and ${atRisk.length - 5} more` : '';
  const verb = atRisk.length === 1 ? 'has' : 'have';
  return `<div class="alert-banner alert-critical"><strong>Security needs you.</strong> ${shown}${more} ${verb} open security alerts.</div>`;
}

// A quiet nudge (ADR-012 Phase 3) for dependabot-sourced open-vulnerability
// findings whose autofix isn't actively driving remediation — otherwise this
// signal is buried row-by-row in the Open Vulnerabilities table. Presentation
// only: reads findings already computed by governance.js, no detection logic
// here. Renders nothing when the count is 0, matching the dashboard's
// calm-by-design philosophy (see buildSinceLastSection).
//
// priorCount (governance.js's priorAutofixNotDrivenCount, from the prior
// governance-weekly snapshot) drives an optional trend badge — null/undefined
// (no prior snapshot yet, or the REPORT phase ran without GOVERNANCE first)
// or an unchanged count renders no badge, same as buildStatusHero's Gold
// trend. Unlike that Gold trend, a rising count here is a regression (more
// repos left undriven), so the arrow direction and the up/down colour class
// are inverted: fewer not-driven repos (an improvement) gets the green "up"
// class, more gets the red "down" class.
export function buildAutofixNudge(findings, priorCount = null) {
  if (!findings || findings.length === 0) return '';
  const count = findings.filter(isAutofixNotDriven).length;
  if (count === 0) return '';
  const noun = count === 1 ? 'repo has' : 'repos have';
  const nudgeTrend = computeCountTrend(count, priorCount, { invert: true });
  let trend = '';
  if (nudgeTrend && nudgeTrend.direction !== 'unchanged') {
    const { delta, direction } = nudgeTrend;
    const arrow = delta > 0 ? '▲' : '▼';
    const cls = direction === 'improving' ? 'up' : 'down';
    trend = ` <span class="status-trend ${cls}" title="vs the prior governance snapshot">${arrow} ${delta > 0 ? '+' : ''}${Math.abs(delta)}</span>`;
  }
  return `<div class="alert-banner"><strong>Dependabot autofix off.</strong> ${count} ${noun} Dependabot autofix off despite open vulnerabilities${trend} — enable via the <code>dependabot-security</code> apply action.</div>`;
}

// The calm headline block: a status dot, a state-aware headline in the butler's
// voice, the tier mix, the portfolio's vulnerability posture, and a
// week-over-week Gold trend when a prior snapshot exists.
function buildStatusHero(state, tierBadges, goldPct, goldTrend, repoTotal, activeCount, critHighCount, unreadCount) {
  const voice = BUTLER_STATUS[state] || BUTLER_STATUS.healthy;
  const tone = state === 'critical' ? 'crit' : state === 'attention' ? 'warn' : 'ok';
  // Severity-neutral wording: critHighCount mixes critical/high vulns and
  // code-scanning with any-severity secret-scanning hits, so "security alerts"
  // is the honest label rather than "vulnerabilities" or "critical/high". It
  // never says "no open security alerts" while a scanner went unread (#477).
  const unreadLabel = unreadCount > 0 ? `<span class="status-vulns-unknown">alerts unread for ${repoCount(unreadCount)}</span>` : '';
  const vulnLabel = critHighCount > 0
    ? `<span class="status-vulns-bad">${critHighCount} security alert${critHighCount !== 1 ? 's' : ''}</span>${unreadLabel ? ` <span class="status-sep">·</span> ${unreadLabel}` : ''}`
    : unreadLabel || `<span class="status-vulns-ok">no open security alerts</span>`;
  let trendLabel = '';
  if (goldTrend && goldTrend.previous !== goldTrend.current) {
    const diff = goldTrend.current - goldTrend.previous;
    const dir = diff > 0 ? 'up' : 'down';
    const arrow = diff > 0 ? '▲' : '▼';
    // Math.abs so a negative move reads "▼ 5pp", not the double-negative "▼ -5pp".
    trendLabel = ` <span class="status-trend ${dir}">${arrow} ${diff > 0 ? '+' : ''}${Math.abs(diff)}pp</span>`;
  }
  return `<section class="status-hero status-${tone}">
  <div class="status-top"><span class="status-dot"></span><div class="status-headline">${voice.headline}</div></div>
  <p class="status-line">${voice.line}</p>
  <div class="status-tiers">${tierBadges} <span class="status-sep">·</span> ${vulnLabel}</div>
  <div class="status-meta">${goldPct}% Gold${trendLabel} <span class="status-sep">·</span> ${repoTotal} repos, ${activeCount} active</div>
</section>`;
}

// The "since the last run" delta strip — the dashboard's story. Diffs the
// current run against the previous portfolio-weekly snapshot: tier moves (via
// the pure detectTierChanges core) and security posture changes. Quiet by
// design — a calm one-liner when nothing moved, which is the common case.
function buildSinceLastSection(classified, priorPortfolio) {
  const priorRepos = priorPortfolio?.repos;
  if (!priorRepos) {
    return `<section class="since-block"><h2>Since the last run</h2><p class="since-empty">${SINCE_FIRST_RUN}</p></section>`;
  }

  // Null-prototype maps: repo names are external, so a name like "__proto__"
  // would mutate a plain object's prototype rather than store a key. Matches the
  // hardening in detectTierChanges (which normalises again internally).
  // A provisional tier on either side is not a tier move (#477): a repo that
  // only went unread did not fall, and its next read did not raise it.
  const currentTiers = Object.create(null);
  for (const r of classified) if (!r._provisional) currentTiers[r.name] = r._tier;
  const priorTiers = Object.create(null);
  for (const [name, s] of Object.entries(priorRepos)) {
    const t = s?.computed?.tier;
    if (t && !isRecordProvisional(s)) priorTiers[name] = t;
  }
  const { changes } = detectTierChanges(currentTiers, priorTiers);

  const items = [];
  const moved = new Set();
  for (const c of changes) {
    moved.add(c.repo);
    const up = (TIER_RANK[c.newTier] ?? 0) > (TIER_RANK[c.previousTier] ?? 0);
    items.push(`<li class="since-item since-${up ? 'up' : 'down'}"><span class="since-repo"><a href="${escHtml(c.repo)}.html">${escHtml(c.repo)}</a></span> <span class="tier-badge tier-${c.previousTier}">${TIER_DISPLAY[c.previousTier]}</span> <span class="since-arrow">→</span> <span class="tier-badge tier-${c.newTier}">${TIER_DISPLAY[c.newTier]}</span></li>`);
  }
  for (const r of classified) {
    // A repo that already moved tier is shown once, as its tier move — a
    // critical/high security change usually causes that move, so a second
    // security row would be redundant and could crowd out the 8-item cap.
    if (moved.has(r.name)) continue;
    if (!Object.hasOwn(priorRepos, r.name)) continue;
    // Only when both sides were read (#477): a high that went unread was not
    // cleared, and a repo whose prior read failed has no "new" alerts.
    const was = securityState(priorRepos[r.name]);
    const is = securityState(r);
    if (was === 'unknown' || is === 'unknown') continue;
    const before = was === 'at-risk';
    const after = is === 'at-risk';
    if (!before && after) {
      items.push(`<li class="since-item since-down"><span class="since-repo"><a href="${escHtml(r.name)}.html">${escHtml(r.name)}</a></span> <span class="since-note">new security alerts</span></li>`);
    } else if (before && !after) {
      items.push(`<li class="since-item since-up"><span class="since-repo"><a href="${escHtml(r.name)}.html">${escHtml(r.name)}</a></span> <span class="since-note">cleared its security alerts</span></li>`);
    }
  }

  if (items.length === 0) {
    return `<section class="since-block"><h2>Since the last run</h2><p class="since-empty">${SINCE_EMPTY}</p></section>`;
  }
  return `<section class="since-block"><h2>Since the last run</h2><ul class="since-list">${items.slice(0, 8).join('')}</ul></section>`;
}


// --- Portfolio report ---

export function generatePortfolioReport({ owner, portfolio, details, depInventory = null, config = null, governanceFindings = null, priorPortfolio = null, priorAutofixNotDrivenCount = null }) {
  const repos = portfolio.repos
    .filter(r => !r.archived && !r.fork)
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  const now = new Date().toISOString().split('T')[0];

  function status(r) {
    if (isExcludedRepo(r.name)) return 'test';
    const pushed = new Date(r.pushed_at);
    if (pushed < ONE_YEAR_AGO) return 'archive';
    if (pushed < SIX_MONTHS_AGO) return 'dormant';
    return 'active';
  }

  // Classify repos and stash tier to avoid recomputing.
  const classified = repos.map(r => {
    const merged = { ...r, status: status(r), ...(details[r.name] || {}) };
    merged._open_prs = merged.open_prs ?? null;
    const { tier, checks, provisional } = tierStatus(merged, { releaseExempt: isReleaseExempt(r.name, config) });
    merged._tier = tier;
    merged._checks = checks;
    merged._provisional = provisional;
    return merged;
  });

  const statusCounts = countBy(classified.map(r => r.status));

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
    'rgba(108,92,125,0.8)', 'rgba(91,107,81,0.8)', 'rgba(140,118,160,0.8)',
    'rgba(154,101,38,0.8)', 'rgba(162,63,51,0.8)', 'rgba(74,109,128,0.6)',
    'rgba(176,120,60,0.8)', 'rgba(137,127,112,0.6)',
  ];

  const weeklyDatasets = topRepos.map((r, i) =>
    `{label:'${r.name}',data:[${(r.weekly || []).join(',')}],backgroundColor:'${chartColors[i] || chartColors[7]}',borderRadius:1}`
  ).join(',');

  // --- Status hero + delta (calm & adaptive layout) ---
  // The tier mix and Gold % count confirmed tiers only (#477); a provisional
  // repo is named apart as Unconfirmed rather than counted as its Silver.
  const confirmed = classified.filter(r => !r._provisional);
  const unconfirmedCount = classified.length - confirmed.length;
  const tierCounts = countBy(confirmed.map(r => r._tier));
  const goldCount = tierCounts.gold || 0;
  const goldPct = confirmed.length > 0 ? Math.round((goldCount / confirmed.length) * 100) : 0;
  const tierBadges = ['gold', 'silver', 'bronze', 'none']
    .filter(t => tierCounts[t] > 0)
    .map(t => `<span class="tier-badge tier-${t}">${tierCounts[t]} ${TIER_DISPLAY[t]}</span>`)
    .concat(unconfirmedCount > 0 ? [`<span class="tier-badge tier-unconfirmed">${unconfirmedCount} Unconfirmed</span>`] : [])
    .join(' ');

  // Portfolio state and the calm hero / delta / banner it drives. The big
  // tables open themselves only when something is below Gold (allGold === false).
  const atRisk = classified.filter(repoAtRisk);
  let critHighCount = 0;
  for (const r of classified) {
    critHighCount += (r.vulns?.critical || 0) + (r.vulns?.high || 0)
      + (r.codeScanning?.critical || 0) + (r.codeScanning?.high || 0)
      + (r.secretScanning?.count || 0);
  }
  const state = computePortfolioState(classified, atRisk, governanceFindings);
  const unreadCount = classified.filter(hasUnreadableScanner).length;
  // The tables open for a confirmed gap, not for a repo that only went unread.
  const allGold = classified.length > 0 && classified.every(r => r._tier === 'gold' || r._provisional);

  const criticalBanner = buildCriticalBanner(atRisk);
  const autofixNudge = buildAutofixNudge(governanceFindings, priorAutofixNotDrivenCount);
  const statusHero = buildStatusHero(state, tierBadges, goldPct, goldTrendOf(classified, priorPortfolio), classified.length, statusCounts.active || 0, critHighCount, unreadCount);
  const sinceSection = buildSinceLastSection(classified, priorPortfolio);

  // --- Simplified health table (6 columns) ---
  const simplifiedRows = classified.map(r => {
    const tier = r._tier;
    const ciPassPct = r.ciPassRate != null ? Math.round(r.ciPassRate * 100) : null;
    const ciPassColor = colorByThreshold(ciPassPct, CI_PASS_PCT_RANGES);
    const ciDisplay = ciPassPct != null ? `<span style="color:${ciPassColor}">${ciPassPct}%</span>` : '—';
    const vulnDisplay = vulnCell(r.vulns, '<span style="color:var(--faint)">n/a</span>');
    const openIssues = r.open_issues || 0;
    const issuesColor = colorByThreshold(openIssues, OPEN_ISSUES_RANGES);
    const openPRs = r._open_prs;
    const prsColor = colorByThreshold(openPRs, OPEN_PRS_RANGES);
    // Next Step: first observed failing check scoped to the repo's next tier.
    // A check an unread scanner failed is not work (#477): a provisional repo's
    // next step is the read itself.
    const next = nextTier(tier);
    const firstFail = next
      ? observedFailingChecks(r, r._checks).find(c => isCheckRequiredForTier(c, next))
      : null;
    const nextStep = firstFail
      ? `<span class="muted" style="font-size:0.85em">${escHtml(firstFail.name)}</span>`
      : r._provisional
        ? `<span class="muted" style="font-size:0.85em">${escHtml(unreadScannerNames(r).join(', '))} unread</span>`
        : `<span style="color:${COLOR_SUCCESS};font-size:0.85em">All checks pass</span>`;
    const descTooltip = r.description ? ` title="${escHtml(r.description)}"` : '';
    const siteLink = deployedLink(r.homepage);
    return `<tr>
      <td><a href="${r.name}.html"${descTooltip}>${escHtml(r.name)}</a>${siteLink ? ' ' + siteLink : ''} ${generateSparklineSVG(details[r.name]?.weekly)}</td>
      <td>${tierBadge(tier, r._provisional)}</td>
      <td><span style="color:${issuesColor}">${openIssues}</span></td>
      <td>${openPRs == null ? '<span style="color:var(--faint)">—</span>' : `<span style="color:${prsColor}">${openPRs}</span>`}</td>
      <td>${ciDisplay}</td>
      <td>${vulnDisplay}</td>
      <td>${nextStep}</td></tr>`;
  }).join('');

  // --- Full 13-column table (inside details toggle) ---
  const fullTableRows = classified.map(r => {
    const tier = r._tier;
    const badgeClass = { active: 'badge-active', dormant: 'badge-dormant', archive: 'badge-archive', fork: 'badge-fork', test: 'badge-test' }[r.status] || 'badge-active';
    const communityColor = colorByThreshold(r.communityHealth, PCT_HIGH_GOOD_RANGES);
    // Tri-state, and this cell had the loudest wrong answer of any render site:
    // `|| 0` turned an unread listing into "none" in DANGER RED, i.e. the table
    // asserted the repo has no CI — the strongest possible claim — on the
    // strength of one failed request. Unknown renders like the `vulns == null`
    // cell below: faint, with a tooltip saying why. An observed 0 still gets
    // the red "none", because that IS a fact.
    const ciCount = r.ci ?? null;
    const ciPassPct = r.ciPassRate != null ? Math.round(r.ciPassRate * 100) : null;
    const ciPassColor = colorByThreshold(ciPassPct, CI_PASS_PCT_RANGES);
    const ciDisplay = ciCount == null
      ? '<span title="Workflow listing could not be read for this repo" style="color:var(--faint);cursor:help">n/a</span>'
      : ciCount === 0
        ? `<span style="color:${COLOR_DANGER}">none</span>`
        : ciPassPct != null ? `<span style="color:${ciPassColor}">${ciPassPct}%</span> <span style="color:var(--faint);font-size:0.8em">(${ciCount})</span>` : `${ciCount}`;
    const vulnDisplay = vulnCell(r.vulns, '<span title="Token lacks vulnerability_alerts:read scope" style="color:var(--faint);cursor:help">n/a</span>');
    const libyearVal = r.libyear?.total_libyear;
    const libyearColor = getLibyearColor(libyearVal);
    const depDisplay = r.sbom
      ? `${r.sbom.count}${libyearVal != null ? ` <span style="color:${libyearColor};font-size:0.8em" title="Libyear: dependency freshness">(${libyearVal.toFixed(1)}y)</span>` : ''}`
      : '—';
    const descTooltip = r.description ? ` title="${escHtml(r.description)}"` : '';
    const siteLink = deployedLink(r.homepage);
    return `<tr>
      <td><a href="${r.name}.html"${descTooltip}>${escHtml(r.name)}</a>${siteLink ? ' ' + siteLink : ''} ${generateSparklineSVG(details[r.name]?.weekly)}</td>
      <td>${r.language ? escHtml(r.language) : '—'}</td><td>${r.stars}</td><td>${r.open_issues || 0}</td>
      <td>${r.commits || 0}</td>
      <td>${ciDisplay}</td>
      <td>${!r.license || r.license === 'None' ? `<span style="color:${COLOR_WARNING}">none</span>` : escHtml(r.license)}</td>
      <td><span style="color:${communityColor}">${r.communityHealth != null ? r.communityHealth + '%' : '—'}</span></td>
      <td>${vulnDisplay}</td>
      <td>${depDisplay}</td>
      <td>${r.contributors != null ? r.contributors : '—'}</td>
      <td><span class="badge ${badgeClass}">${r.status}</span></td>
      <td>${tierBadge(tier, r._provisional)}</td></tr>`;
  }).join('');

  const depSection = depInventory
    ? `<details><summary>Dependency Inventory</summary>${buildDependencyInventorySection(depInventory)}</details>`
    : '';

  const body = `<h1><a href="https://github.com/${owner}" class="repo-link">@${owner} <svg height="24" width="24" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a></h1>
<div class="subtitle">Portfolio health · ${now} · click any repo for detail · <a href="digest.html">weekly digest</a></div>
${criticalBanner}
${autofixNudge}
${statusHero}
${sinceSection}
${buildPortfolioAttentionSection(classified, details, owner, config)}
${buildGovernanceSection(governanceFindings)}
${buildCampaignSection(repos, details)}
<details${allGold ? '' : ' open'}><summary>All repos · ${classified.length}</summary>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Tier</th><th>Issues</th><th>PRs</th><th>CI%</th><th>Vulns</th><th>Next Step</th></tr></thead>
<tbody>${simplifiedRows}</tbody></table>
</div>
<details><summary>Show all columns (${classified.length} repos)</summary>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Lang</th><th>Stars</th><th>Issues</th><th>Commits</th><th>CI</th><th>License</th><th>Community</th><th>Vulns</th><th>Deps</th><th>Contributors</th><th>Status</th><th>Tier</th></tr></thead>
<tbody>${fullTableRows}</tbody></table>
</div>
</details>
</details>
<details><summary>Commit Activity (26 weeks)</summary>
<div class="chart-container"><div class="chart-title">Weekly Commits by Repository</div><canvas id="weeklyChart" style="max-height:360px"></canvas></div>
</details>
${depSection}
<details class="about-butler"><summary>About Repo Butler</summary>
${HERO_INTRO}
${ABOUT_SECTION}
</details>`;
  const charts = `new Chart(document.getElementById('weeklyChart'),{type:'bar',data:{labels:[${weekLabels.map(l => `'${l}'`).join(',')}],datasets:[${weeklyDatasets}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{padding:10,font:{size:10}}}},scales:{x:{stacked:true,grid:{display:false},ticks:{maxRotation:45,font:{size:9}}},y:{stacked:true,beginAtZero:true,grid:{}}}}});`;
  return htmlPage({ title: `@${owner} — Portfolio Report`, body, charts });
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
    if (isExcludedRepo(r.name)) return false;
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
  // Repos with any scanner unread (#477): their alerts are absent from the
  // counts above, so the digest must not read as an all-clear for them.
  const unreadRepos = active.filter(r => hasUnreadableScanner(repoDetails[r.name])).length;

  const cards = [];

  // Opening summary card.
  cards.push(buildDigestCard(
    'This Week at a Glance',
    `${active.length} active repos across your portfolio with ${fmt(totalCommits)} commits in the last 6 months ` +
    `and ${totalIssues} open issues.` +
    (recentCommits.length > 0 ? ` ${recentCommits.length} repos saw commits this week.` : '') +
    (totalVulns > 0 ? ` ${totalVulns} vulnerability alerts need attention.` : '') +
    (unreadRepos > 0 ? ` Security alerts were unread for ${repoCount(unreadRepos)}, so this is not an all-clear.` : ''),
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
      const sevClass = isHighSeverity(r.vulns) ? 'text-alert' : 'text-warning';
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
<meta name="color-scheme" content="light dark">
<title>@${owner} — Weekly Digest</title>
${THEME_INIT}
${CSS}
<style>
.digest-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin-bottom:1.5rem;border-left:4px solid var(--sep)}
.digest-card.card-summary{border-left-color:var(--link)}
.digest-card.card-activity{border-left-color:var(--color-success)}
.digest-card.card-alert{border-left-color:var(--color-danger)}
.digest-card.card-issues{border-left-color:var(--color-warning)}
.digest-card.card-dormant{border-left-color:var(--muted)}
.digest-card h3{font-size:1rem;color:var(--ink-strong);margin-bottom:0.8rem}
.digest-card p{color:var(--text);font-size:0.9rem;line-height:1.6}
.digest-nav{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
.digest-nav a{color:var(--link);font-size:0.85rem}
.text-alert{color:var(--color-danger)}
.text-warning{color:var(--color-warning)}
</style>
</head>
<body>
${THEME_TOGGLE}
<h1>Weekly Digest</h1>
<div class="subtitle">@${owner} portfolio recap — ${now}</div>
<div class="digest-nav"><a href="index.html">Portfolio Dashboard</a></div>
${cards.join('\n')}
${SITE_FOOTER}
${THEME_TOGGLE_JS}
</body></html>`;
}

function buildDigestCard(title, content, type) {
  return `<div class="digest-card card-${type}"><h3>${title}</h3><div>${content}</div></div>`;
}
