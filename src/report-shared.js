// Shared helpers and constants used by report-repo.js and report-portfolio.js.

export const SIX_MONTHS_AGO = new Date(Date.now() - 180 * 86400000);
export const ONE_YEAR_AGO = new Date(Date.now() - 365 * 86400000);

export const TIER_DISPLAY = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze', none: 'Unranked' };
export const TIER_COLORS = { gold: '#ffd700', silver: '#c0c0c0', bronze: '#cd7f32', none: '#6e7681' };
export const COLOR_SUCCESS = '#7ee787';
export const COLOR_WARNING = '#d29922';
export const COLOR_DANGER = '#f85149';
export const REPO_EXCLUSION_PATTERNS = ['shadow', 'test-repo'];

export const LIBYEAR_THRESHOLDS = { GREEN: 5, YELLOW: 20 };

export function getLibyearColor(libyearVal) {
  if (libyearVal == null) return '#6e7681';
  if (libyearVal < LIBYEAR_THRESHOLDS.GREEN) return '#7ee787';
  if (libyearVal < LIBYEAR_THRESHOLDS.YELLOW) return '#d29922';
  return '#f85149';
}

export function isBotAuthor(author = '') {
  return author.includes('[bot]') || author.startsWith('app/');
}

export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n || 0);
}

export function countBy(arr) {
  const counts = {};
  for (const item of arr) counts[item] = (counts[item] || 0) + 1;
  return counts;
}

export function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

export function daysAgoISO(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

export function last12Months() {
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
