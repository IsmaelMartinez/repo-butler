// Portfolio-level report generation: portfolio dashboard, digest, and dependency inventory.

import { CSS } from './report-styles.js';
import { computeLibyearWithTimeout } from './libyear.js';
import { buildActionItems } from './report-repo.js';
import {
  SIX_MONTHS_AGO, ONE_YEAR_AGO,
  TIER_DISPLAY, COLOR_SUCCESS, COLOR_WARNING, COLOR_DANGER,
  REPO_EXCLUSION_PATTERNS,
  escHtml, fmt, countBy, daysAgo, daysAgoISO,
  computeHealthTier, getLibyearColor, isReleaseExempt, getAlertSummary, isBugIssue,
} from './report-shared.js';


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
        purl: p.externalRefs?.find(r => r.referenceType === 'purl')?.referenceLocator || null,
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

// License concern levels: 'high' for licenses that may impose obligations on
// the whole project, 'low' for weak copyleft that only affects the library
// itself and is fine for non-commercial use as a dependency.
const LICENSE_CONCERNS = {
  'AGPL-3.0': { level: 'high', note: 'Network copyleft: even SaaS use triggers source disclosure.' },
  'AGPL-3.0-only': { level: 'high', note: 'Network copyleft: even SaaS use triggers source disclosure.' },
  'AGPL-3.0-or-later': { level: 'high', note: 'Network copyleft: even SaaS use triggers source disclosure.' },
  'GPL-2.0': { level: 'low', note: 'Copyleft applies to derivative works. Low risk when used as a dependency in non-commercial projects.' },
  'GPL-2.0-only': { level: 'low', note: 'Copyleft applies to derivative works. Low risk when used as a dependency in non-commercial projects.' },
  'GPL-2.0-or-later': { level: 'low', note: 'Copyleft applies to derivative works. Low risk when used as a dependency in non-commercial projects.' },
  'GPL-3.0': { level: 'low', note: 'Copyleft applies to derivative works. Low risk when used as a dependency in non-commercial projects.' },
  'GPL-3.0-only': { level: 'low', note: 'Copyleft applies to derivative works. Low risk when used as a dependency in non-commercial projects.' },
  'GPL-3.0-or-later': { level: 'low', note: 'Copyleft applies to derivative works. Low risk when used as a dependency in non-commercial projects.' },
  'LGPL-2.1': { level: 'low', note: 'Weak copyleft: only modifications to the library itself must be shared. Fine as a dependency.' },
  'LGPL-2.1-only': { level: 'low', note: 'Weak copyleft: only modifications to the library itself must be shared. Fine as a dependency.' },
  'LGPL-2.1-or-later': { level: 'low', note: 'Weak copyleft: only modifications to the library itself must be shared. Fine as a dependency.' },
  'LGPL-3.0': { level: 'low', note: 'Weak copyleft: only modifications to the library itself must be shared. Fine as a dependency.' },
  'LGPL-3.0-only': { level: 'low', note: 'Weak copyleft: only modifications to the library itself must be shared. Fine as a dependency.' },
  'LGPL-3.0-or-later': { level: 'low', note: 'Weak copyleft: only modifications to the library itself must be shared. Fine as a dependency.' },
  'MPL-2.0': { level: 'low', note: 'File-level copyleft: only modified files must stay MPL-2.0. Fine as a dependency.' },
  'EUPL-1.2': { level: 'low', note: 'EU copyleft similar to LGPL. Fine as a dependency.' },
};

// Parse SPDX expression into individual license identifiers.
// Handles AND/OR, parentheses, and WITH exceptions.
function parseSpdxParts(license) {
  if (!license) return [];
  return license
    .replace(/[()]/g, '')
    .split(/\s+(?:AND|OR)\s+/)
    .map(part => part.replace(/\s+WITH\s+.+$/, '').trim())
    .filter(Boolean);
}

function describeLicenseConcern(license) {
  if (!license) return { level: 'low', note: 'Unknown license terms.' };
  for (const part of parseSpdxParts(license)) {
    if (LICENSE_CONCERNS[part]) return LICENSE_CONCERNS[part];
  }
  return { level: 'low', note: 'Copyleft license — low risk as a dependency in non-commercial projects.' };
}

function isHighConcernLicense(license) {
  return parseSpdxParts(license).some(part => LICENSE_CONCERNS[part]?.level === 'high');
}

export function isCopyleft(license) {
  return parseSpdxParts(license).some(part => COPYLEFT_LICENSES.has(part));
}

export function analyzeDependencyInventory(details) {
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
        licenseFlags.push({ name: pkg.name, license: pkg.license, level: isHighConcernLicense(pkg.license) ? 'high' : 'low' });
      }
    }
    repoSummaries[repoName] = { depCount: d.sbom.count, licenseFlags };
  }

  const sharedEntries = Object.entries(depUsage).filter(([, v]) => v.repos.size > 1);
  const sharedDepsTotal = sharedEntries.length;

  // Filter out GitHub Actions from the "common dependencies" display — they are
  // workflow dependencies, not application code dependencies.
  const commonDeps = [...sharedEntries]
    .filter(([, v]) => !v.name?.startsWith('actions/') && !v.name?.startsWith('actions:'))
    .sort((a, b) => b[1].repos.size - a[1].repos.size)
    .slice(0, 20)
    .map(([, v]) => ({ name: v.name, repoCount: v.repos.size, licenses: [...v.licenses] }));

  const allLicenseFlags = Object.entries(repoSummaries).flatMap(([repoName, summary]) =>
    summary.licenseFlags.map(flag => ({ repo: repoName, dep: flag.name, license: flag.license, level: flag.level }))
  );

  const totalUnique = Object.keys(depUsage).length;
  const reposWithSBOM = Object.values(details).filter(d => d.sbom).length;

  return { commonDeps, sharedDepsTotal, licenseFlags: allLicenseFlags, totalUnique, reposWithSBOM, repoSummaries };
}


// --- Portfolio details fetcher ---

export async function fetchPortfolioDetails(gh, owner, repos) {
  const details = {};
  const activeRepos = repos.filter(r => !r.archived && !r.fork);

  // Fetch commit counts and weekly data for active repos (parallel, batched).
  const fetches = activeRepos.slice(0, 15).map(async (r) => {
    const [commits, weekly, license, ci, communityProfile, vulns, ciPassRate, openIssues, sbom, releasedAt, codeScanning, secretScanning] = await Promise.all([
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
        .then(async d => {
          let hasIssueTemplate = !!d.files?.issue_template;
          if (!hasIssueTemplate) {
            try {
              const dir = await gh.request(`/repos/${owner}/${r.name}/contents/.github/ISSUE_TEMPLATE`);
              hasIssueTemplate = Array.isArray(dir) && dir.length > 0;
            } catch { /* directory doesn't exist */ }
          }
          return {
            health_percentage: d.health_percentage ?? null,
            has_issue_template: hasIssueTemplate,
          };
        })
        .catch(() => null),
      gh.request(`/repos/${owner}/${r.name}/dependabot/alerts?state=open&per_page=100`)
        .then(alerts => getAlertSummary(alerts, a => a.security_vulnerability?.severity || a.security_advisory?.severity))
        .catch(async () => {
          // Alerts API returned 403 (token lacks scope). Fall back to checking
          // if dependabot.yml exists — if so, Dependabot IS configured even
          // though we can't read the alerts.
          const configContent = await gh.getFileContent(owner, r.name, '.github/dependabot.yml');
          if (configContent) return { count: 0, max_severity: null, config_only: true };
          return null;
        }),
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
      gh.paginate(`/repos/${owner}/${r.name}/issues`, { params: { state: 'open' }, max: 500 })
        .then(issues => {
          const filtered = issues.filter(i => !i.pull_request);
          // If paginated list returned 0 but the repo listing says there are issues,
          // the token likely lacks issues:read — fall back to the repo count.
          const isFallback = filtered.length === 0 && (r.open_issues || 0) > 0;
          return {
            total: isFallback ? r.open_issues : filtered.length,
            bugs: isFallback ? null : filtered.filter(i => isBugIssue(i.labels?.map(l => l.name) || [])).length,
          };
        })
        .catch(() => ({ total: r.open_issues || 0, bugs: null })),
      fetchSBOM(gh, owner, r.name),
      gh.paginate(`/repos/${owner}/${r.name}/releases`, { max: 1 })
        .then(rels => rels[0]?.published_at ?? null)
        .catch(() => null),
      gh.request(`/repos/${owner}/${r.name}/code-scanning/alerts?state=open&per_page=100`)
        .then(alerts => getAlertSummary(alerts, a => a.rule?.security_severity_level))
        .catch(() => null),
      gh.request(`/repos/${owner}/${r.name}/secret-scanning/alerts?state=open&per_page=100`)
        .then(alerts => ({ count: Array.isArray(alerts) ? alerts.length : 0 }))
        .catch(() => null),
    ]);
    const communityHealth = communityProfile?.health_percentage ?? null;
    const hasIssueTemplate = communityProfile?.has_issue_template ?? false;
    details[r.name] = { commits, weekly, license, ci, communityHealth, vulns, ciPassRate, open_issues: openIssues.total, open_bugs: openIssues.bugs, sbom, released_at: releasedAt, hasIssueTemplate, libyear: null, codeScanning, secretScanning };
  });

  await Promise.all(fetches);

  // Compute libyear freshness sequentially (one repo at a time) to avoid
  // fanning out concurrent npm registry requests across all repos.
  for (const r of activeRepos.slice(0, 15)) {
    const sbom = details[r.name]?.sbom;
    if (sbom) {
      details[r.name].libyear = await computeLibyearWithTimeout(sbom.packages, 5000);
    }
  }

  return details;
}


// --- Sparkline SVG ---

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


// --- Campaign section ---

export function buildCampaignSection(repos, details) {
  // Filter to active, non-fork, non-test repos.
  const eligible = repos
    .filter(r => !r.archived && !r.fork && !REPO_EXCLUSION_PATTERNS.some(p => r.name.includes(p)));

  if (eligible.length === 0) return '';

  const campaigns = [
    {
      name: 'Community Health',
      description: 'Repos with community health score >= 80%',
      applicable: r => details[r.name]?.communityHealth != null,
      test: r => details[r.name].communityHealth >= 80,
    },
    {
      name: 'Vulnerability Free',
      description: 'Repos with zero critical/high vulnerabilities',
      applicable: r => details[r.name]?.vulns != null,
      test: r => {
        const v = details[r.name].vulns;
        return v.max_severity !== 'critical' && v.max_severity !== 'high';
      },
    },
    {
      name: 'CI Reliability',
      description: 'Repos with CI pass rate >= 90%',
      applicable: r => details[r.name]?.ciPassRate != null,
      test: r => details[r.name].ciPassRate >= 0.9,
    },
    {
      name: 'License Compliance',
      description: 'Repos with a license configured',
      test: r => {
        const lic = details[r.name]?.license;
        return !!lic && lic !== 'None';
      },
    },
    {
      name: 'Issue Templates',
      description: 'Repos with issue templates configured',
      test: r => !!details[r.name]?.hasIssueTemplate,
    },
  ];

  const cards = campaigns.map(campaign => {
    const pool = campaign.applicable ? eligible.filter(campaign.applicable) : eligible;
    const { compliant, nonCompliant } = pool.reduce((acc, r) => {
      if (campaign.test(r)) acc.compliant.push(r);
      else acc.nonCompliant.push(r);
      return acc;
    }, { compliant: [], nonCompliant: [] });
    const total = pool.length;
    const count = compliant.length;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const barColor = pct >= 80 ? COLOR_SUCCESS : pct >= 50 ? COLOR_WARNING : COLOR_DANGER;
    const nonCompliantList = nonCompliant.length > 0
      ? `<details><summary style="font-size:0.75rem;color:#8b949e;cursor:pointer">${nonCompliant.length} repo${nonCompliant.length !== 1 ? 's' : ''} need attention</summary><div class="campaign-repos" style="margin-top:0.3rem">${nonCompliant.map(r => `<a href="${r.name}.html">${escHtml(r.name)}</a>`).join(', ')}</div></details>`
      : `<div class="campaign-repos" style="color:${COLOR_SUCCESS}">All repos compliant</div>`;

    return `<div class="campaign-card">
<div class="campaign-header"><h3>${escHtml(campaign.name)}</h3><span class="campaign-ratio">${count}/${total}</span></div>
<div class="campaign-desc">${escHtml(campaign.description)}</div>
<div class="campaign-bar"><div class="campaign-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
<div class="campaign-pct">${pct}% complete${campaign.applicable && pool.length < eligible.length ? ` <span style="color:#6e7681">(${eligible.length - pool.length} repos excluded — data unavailable)</span>` : ''}</div>
${nonCompliantList}
</div>`;
  }).join('\n');

  return `<h2>Improvement Campaigns</h2>
<div class="campaign-grid">
${cards}
</div>`;
}


// --- Portfolio attention section ---

export function buildPortfolioAttentionSection(repos, details, owner, config) {
  const allItems = [];
  for (const r of repos) {
    const d = details[r.name];
    if (!d) continue;
    const snapshot = {
      repository: `${owner}/${r.name}`,
      dependabot_alerts: d.vulns || null,
      code_scanning_alerts: d.codeScanning || null,
      secret_scanning_alerts: d.secretScanning || null,
      ci_pass_rate: d.ciPassRate != null ? { pass_rate: d.ciPassRate } : null,
      issues: { open: [] },
      summary: {},
    };
    const items = buildActionItems(snapshot, []);
    for (const item of items) {
      allItems.push({ ...item, repo: r.name });
    }
  }

  allItems.sort((a, b) => a.priority - b.priority);
  const top10 = allItems.slice(0, 10);

  if (top10.length === 0) {
    return `<h2>Attention Required</h2>
<div class="chart-container"><p style="color:#7ee787;margin:0">All clear — nothing needs attention across the portfolio.</p></div>`;
  }

  const effortColor = { 'quick win': '#7ee787', 'moderate': '#d29922', 'significant': '#f85149' };
  const rows = top10.map((item, i) => `<tr>
    <td style="color:#8b949e;font-weight:600">${i + 1}</td>
    <td><a href="${escHtml(item.repo)}.html">${escHtml(item.repo)}</a></td>
    <td>${item.text}</td>
    <td><span style="color:${effortColor[item.effort] || '#8b949e'}">${item.effort}</span></td>
  </tr>`).join('');

  return `<h2>Attention Required</h2>
<div class="chart-container">
<table><thead><tr><th>#</th><th>Repo</th><th>Action</th><th>Effort</th></tr></thead>
<tbody>${rows}</tbody></table>
</div>`;
}


// --- Dependency inventory section ---

export function buildDependencyInventorySection(inventory) {
  if (!inventory || inventory.reposWithSBOM === 0) return '';

  let html = `<h2>Dependency Inventory</h2>
<div class="grid">
  <div class="card"><h3>Total Unique Dependencies</h3><div class="stat">${fmt(inventory.totalUnique)}</div><div class="stat-label">across ${inventory.reposWithSBOM} repos with SBOM</div></div>
  <div class="card"><h3>Shared Dependencies</h3><div class="stat">${inventory.sharedDepsTotal}</div><div class="stat-label">used in 2+ repos</div></div>
  <div class="card"><h3>License Notes</h3><div class="stat" style="color:${inventory.licenseFlags.some(f => f.level === 'high') ? '#f85149' : inventory.licenseFlags.length > 0 ? '#8b949e' : '#7ee787'}">${inventory.licenseFlags.filter(f => f.level === 'high').length || (inventory.licenseFlags.length > 0 ? inventory.licenseFlags.length + ' low-risk' : 0)}</div><div class="stat-label">${inventory.licenseFlags.some(f => f.level === 'high') ? 'high-concern copyleft deps' : 'copyleft deps (low risk for non-commercial use)'}</div></div>
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
<div class="chart-title"><span style="color:${COLOR_DANGER}">${escHtml(license)}</span> <span style="font-size:0.85rem;color:#8b949e">— ${escHtml(concern.note)}</span></div>
<table><thead><tr><th>Repo</th><th>Dependency</th></tr></thead>
<tbody>${depRows}</tbody></table>
</div>`;
      }).join('');
      html += `<h3 style="margin-top:1.5rem;color:#e6edf3">License Concerns</h3>${licenseCards}`;
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
        return `<tr><td style="color:#8b949e">${escHtml(license)}</td><td style="color:#8b949e">${deps}${more}</td><td style="color:#8b949e">${escHtml(concern.note)}</td></tr>`;
      }).join('');
      html += `<details style="margin-top:1rem"><summary style="color:#8b949e;cursor:pointer">Low-risk copyleft dependencies (${lowFlags.length}) — fine for non-commercial use</summary>
<table style="margin-top:0.5rem"><thead><tr><th>License</th><th>Dependencies</th><th>Note</th></tr></thead>
<tbody>${summaryRows}</tbody></table>
</details>`;
    }
  }

  return html;
}


// --- Portfolio report ---

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

  // Classify repos and stash tier to avoid recomputing.
  const classified = repos.map(r => {
    const merged = { ...r, status: status(r), ...(details[r.name] || {}) };
    const { tier, checks } = computeHealthTier(merged, { releaseExempt: isReleaseExempt(r.name, config) });
    merged._tier = tier;
    merged._checks = checks;
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
    'rgba(56,139,253,0.8)', 'rgba(126,231,135,0.8)', 'rgba(163,113,247,0.8)',
    'rgba(210,153,34,0.8)', 'rgba(248,81,73,0.8)', 'rgba(31,111,235,0.6)',
    'rgba(255,166,87,0.8)', 'rgba(139,148,158,0.6)',
  ];

  const weeklyDatasets = topRepos.map((r, i) =>
    `{label:'${r.name}',data:[${(r.weekly || []).join(',')}],backgroundColor:'${chartColors[i] || chartColors[7]}',borderRadius:1}`
  ).join(',');

  // --- Portfolio Pulse ---
  const tierCounts = countBy(classified.map(r => r._tier));
  const goldCount = tierCounts.gold || 0;
  const goldPct = classified.length > 0 ? Math.round((goldCount / classified.length) * 100) : 0;
  const goldColor = goldPct >= 80 ? COLOR_SUCCESS : goldPct >= 50 ? COLOR_WARNING : COLOR_DANGER;
  const tierBadges = ['gold', 'silver', 'bronze', 'none']
    .filter(t => tierCounts[t] > 0)
    .map(t => `<span class="tier-badge tier-${t}">${tierCounts[t]} ${TIER_DISPLAY[t]}</span>`)
    .join(' ');

  const pulseSection = `<h2>Portfolio Pulse</h2>
<div class="chart-container">
  <div style="font-size:2.5rem;font-weight:700;color:${goldColor};margin-bottom:0.5rem">${goldPct}% Gold</div>
  <div style="margin-bottom:0.5rem">${tierBadges}</div>
  <div style="color:#8b949e">${classified.length} repos — ${statusCounts.active || 0} active, ${(statusCounts.dormant || 0) + (statusCounts.archive || 0)} dormant/archive</div>
</div>`;

  // --- Simplified health table (6 columns) ---
  const simplifiedRows = classified.map(r => {
    const tier = r._tier;
    const ciPassPct = r.ciPassRate != null ? Math.round(r.ciPassRate * 100) : null;
    const ciPassColor = ciPassPct == null ? '#6e7681' : ciPassPct >= 90 ? COLOR_SUCCESS : ciPassPct >= 70 ? COLOR_WARNING : COLOR_DANGER;
    const ciDisplay = ciPassPct != null ? `<span style="color:${ciPassColor}">${ciPassPct}%</span>` : '—';
    const vulnDisplay = r.vulns == null
      ? '<span style="color:#6e7681">n/a</span>'
      : r.vulns.count === 0
        ? `<span style="color:${COLOR_SUCCESS}">0</span>`
        : `<span style="color:${r.vulns.max_severity === 'critical' || r.vulns.max_severity === 'high' ? COLOR_DANGER : COLOR_WARNING}">${r.vulns.count}</span>`;
    // Next Step: first failing check scoped to the repo's next tier
    const nextTier = tier === 'none' ? 'bronze' : tier === 'bronze' ? 'silver' : tier === 'silver' ? 'gold' : null;
    const firstFail = nextTier
      ? r._checks.find(c => !c.passed && (c.required_for === nextTier || (nextTier === 'gold' && c.required_for === 'silver')))
      : null;
    const nextStep = firstFail ? `<span style="color:#8b949e;font-size:0.85em">${escHtml(firstFail.name)}</span>` : `<span style="color:${COLOR_SUCCESS};font-size:0.85em">All checks pass</span>`;
    const descTooltip = r.description ? ` title="${escHtml(r.description)}"` : '';
    return `<tr>
      <td><a href="${r.name}.html"${descTooltip}>${escHtml(r.name)}</a> ${generateSparklineSVG(details[r.name]?.weekly)}</td>
      <td><span class="tier-badge tier-${tier}">${TIER_DISPLAY[tier]}</span></td>
      <td>${ciDisplay}</td>
      <td>${vulnDisplay}</td>
      <td>${nextStep}</td></tr>`;
  }).join('');

  // --- Full 13-column table (inside details toggle) ---
  const fullTableRows = classified.map(r => {
    const tier = r._tier;
    const badgeClass = { active: 'badge-active', dormant: 'badge-dormant', archive: 'badge-archive', fork: 'badge-fork', test: 'badge-test' }[r.status] || 'badge-active';
    const communityColor = r.communityHealth == null ? '#6e7681' : r.communityHealth >= 80 ? COLOR_SUCCESS : r.communityHealth >= 50 ? COLOR_WARNING : COLOR_DANGER;
    const ciCount = r.ci || 0;
    const ciPassPct = r.ciPassRate != null ? Math.round(r.ciPassRate * 100) : null;
    const ciPassColor = ciPassPct == null ? '#6e7681' : ciPassPct >= 90 ? COLOR_SUCCESS : ciPassPct >= 70 ? COLOR_WARNING : COLOR_DANGER;
    const ciDisplay = ciCount === 0
      ? `<span style="color:${COLOR_DANGER}">none</span>`
      : ciPassPct != null ? `<span style="color:${ciPassColor}">${ciPassPct}%</span> <span style="color:#6e7681;font-size:0.8em">(${ciCount})</span>` : `${ciCount}`;
    const vulnDisplay = r.vulns == null
      ? '<span title="Token lacks vulnerability_alerts:read scope" style="color:#6e7681;cursor:help">n/a</span>'
      : r.vulns.count === 0
        ? `<span style="color:${COLOR_SUCCESS}">0</span>`
        : `<span style="color:${r.vulns.max_severity === 'critical' || r.vulns.max_severity === 'high' ? COLOR_DANGER : COLOR_WARNING}">${r.vulns.count}</span>`;
    const libyearVal = r.libyear?.total_libyear;
    const libyearColor = getLibyearColor(libyearVal);
    const depDisplay = r.sbom
      ? `${r.sbom.count}${libyearVal != null ? ` <span style="color:${libyearColor};font-size:0.8em" title="Libyear: dependency freshness">(${libyearVal.toFixed(1)}y)</span>` : ''}`
      : '—';
    const descTooltip = r.description ? ` title="${escHtml(r.description)}"` : '';
    return `<tr>
      <td><a href="${r.name}.html"${descTooltip}>${escHtml(r.name)}</a> ${generateSparklineSVG(details[r.name]?.weekly)}</td>
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

  const depSection = depInventory
    ? `<details><summary>Dependency Inventory</summary>${buildDependencyInventorySection(depInventory)}</details>`
    : '';

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
${pulseSection}
${buildPortfolioAttentionSection(classified, details, owner, config)}
<h2>Portfolio Health</h2>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Tier</th><th>CI%</th><th>Vulns</th><th>Next Step</th></tr></thead>
<tbody>${simplifiedRows}</tbody></table>
</div>
<details><summary>Show all columns (${classified.length} repos)</summary>
<div class="chart-container">
<table><thead><tr><th>Repo</th><th>Lang</th><th>Stars</th><th>Issues</th><th>Commits</th><th>CI</th><th>License</th><th>Community</th><th>Vulns</th><th>Deps</th><th>Contributors</th><th>Status</th><th>Tier</th></tr></thead>
<tbody>${fullTableRows}</tbody></table>
</div>
</details>
${buildCampaignSection(repos, details)}
<details><summary>Commit Activity (26 weeks)</summary>
<div class="chart-container"><div class="chart-title">Weekly Commits by Repository</div><canvas id="weeklyChart" style="max-height:360px"></canvas></div>
</details>
${depSection}
<div class="footer">Generated by <a href="https://github.com/IsmaelMartinez/repo-butler">repo-butler</a></div>
<script>
Chart.defaults.color='#8b949e';Chart.defaults.borderColor='#21262d';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,monospace';
new Chart(document.getElementById('weeklyChart'),{type:'bar',data:{labels:[${weekLabels.map(l => `'${l}'`).join(',')}],datasets:[${weeklyDatasets}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{padding:10,font:{size:10}}}},scales:{x:{stacked:true,grid:{display:false},ticks:{maxRotation:45,font:{size:9}}},y:{stacked:true,beginAtZero:true,grid:{color:'#21262d'}}}}});
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
