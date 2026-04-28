import { createClient } from './github.js';
import { isBugIssue, isFeatureIssue, isPublishedRelease } from './report-shared.js';

export async function observe(context) {
  const { owner, repo, token, config } = context;
  const gh = createClient(token);
  const days = config.observe?.issues_closed_days || 90;
  const since = daysAgo(days);

  console.log(`Observing ${owner}/${repo}...`);

  // Run independent API calls in parallel for speed.
  const [
    openIssues,
    closedIssues,
    mergedPRs,
    labels,
    milestones,
    releases,
    workflows,
    repoMeta,
    communityProfile,
    dependabotAlerts,
    codeScanningAlerts,
    secretScanningAlerts,
    ciPassRate,
  ] = await Promise.all([
    fetchOpenIssues(gh, owner, repo),
    fetchClosedIssues(gh, owner, repo, since),
    fetchMergedPRs(gh, owner, repo, since),
    fetchLabels(gh, owner, repo),
    fetchMilestones(gh, owner, repo),
    fetchReleases(gh, owner, repo, config.observe?.releases_count || 10),
    fetchWorkflows(gh, owner, repo),
    fetchRepoMeta(gh, owner, repo),
    fetchCommunityProfile(gh, owner, repo),
    fetchDependabotAlerts(gh, owner, repo),
    fetchCodeScanningAlerts(gh, owner, repo),
    fetchSecretScanningAlerts(gh, owner, repo),
    fetchCIPassRate(gh, owner, repo),
  ]);

  // Fetch roadmap content if configured.
  const roadmapPath = config.roadmap?.path || 'ROADMAP.md';
  const roadmapContent = await gh.getFileContent(owner, repo, roadmapPath);

  // Fetch package.json for dependency info.
  const packageJson = await gh.getFileContent(owner, repo, 'package.json');
  let packageData = null;
  if (packageJson) {
    try { packageData = JSON.parse(packageJson); } catch { console.warn('Warning: could not parse package.json, file may be malformed.'); }
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    repository: `${owner}/${repo}`,
    meta: repoMeta,
    issues: {
      open: openIssues,
      recently_closed: closedIssues,
    },
    pull_requests: {
      recently_merged: mergedPRs,
    },
    labels,
    milestones,
    releases,
    workflows,
    roadmap: roadmapContent ? { path: roadmapPath, content: roadmapContent } : null,
    package: packageData ? {
      version: packageData.version,
      dependencies: Object.keys(packageData.dependencies || {}),
      devDependencies: Object.keys(packageData.devDependencies || {}),
    } : null,
    community_profile: communityProfile,
    dependabot_alerts: dependabotAlerts,
    code_scanning_alerts: codeScanningAlerts,
    secret_scanning_alerts: secretScanningAlerts,
    ci_pass_rate: ciPassRate,
    summary: buildSummary({
      openIssues, closedIssues, mergedPRs, releases, repoMeta, labels,
      communityProfile, dependabotAlerts, codeScanningAlerts, secretScanningAlerts, ciPassRate,
    }),
  };

  return snapshot;
}

// Observe all repos for a given owner (portfolio-level view).
//
// Repo discovery order, from most-to-least privileged:
//   1. /installation/repositories — GitHub App installation tokens. Returns
//      ALL repos (including private) the installation can access. This is
//      the path used by the main workflow (actions/create-github-app-token).
//   2. /user/repos — authenticated-user tokens (PAT). Also includes private.
//   3. /users/{owner}/repos — public-only; used as a last resort when the
//      token is unauthenticated or scoped to a different owner.
//   4. /orgs/{owner}/repos — public-only fallback for org accounts when the
//      user endpoint 404s (owner is an org, not a user).
//
// Private repos are intentionally excluded from the portfolio: reports deploy
// to public GitHub Pages and feed a public dashboard, so surfacing private
// repo names/metadata would be an unintended information leak. The privileged
// discovery endpoints are still used so we see the full accessible set, but
// private repos are filtered out before classification.
export async function observePortfolio(context) {
  const { owner, token } = context;
  const gh = createClient(token);

  console.log(`Observing portfolio for ${owner}...`);

  let repos = await fetchInstallationRepos(gh);
  let source = 'installation';

  if (!repos) {
    repos = await fetchUserRepos(gh);
    if (repos) source = 'user';
  }

  if (!repos) {
    source = 'public';
    try {
      repos = await gh.paginate(`/users/${owner}/repos`, {
        params: { sort: 'pushed', direction: 'desc', type: 'owner' },
        max: 200,
      });
    } catch (err) {
      if (!err.message?.includes('404')) throw err;
      repos = await gh.paginate(`/orgs/${owner}/repos`, {
        params: { sort: 'pushed', direction: 'desc' },
        max: 200,
      });
    }
  }

  // The installation endpoint may return repos from multiple owners when the
  // App is installed on more than one account — filter to just the requested
  // owner here. Public endpoints are already owner-scoped by URL.
  const owned = repos.filter(r => !r.owner || r.owner.login === owner);

  // Exclude private repos from the portfolio. Reports are published to a
  // public GitHub Pages site, so including private repos would leak names,
  // descriptions, and activity metadata. Count them for the log line only.
  const privateCount = owned.filter(r => r.private).length;
  const publicOnly = owned.filter(r => !r.private);

  const portfolio = publicOnly.map(r => ({
    full_name: r.full_name,
    name: r.name,
    description: r.description,
    language: r.language,
    stars: r.stargazers_count,
    forks: r.forks_count,
    open_issues: r.open_issues_count,
    pushed_at: r.pushed_at,
    archived: r.archived,
    fork: r.fork,
    license: r.license?.spdx_id || null,
    has_issues: r.has_issues,
    default_branch: r.default_branch,
    topics: r.topics || [],
    private: false,
    visibility: r.visibility || 'public',
  }));

  console.log(`Portfolio source: ${source} — ${portfolio.length} public repos (${privateCount} private hidden).`);

  const classification = classifyRepos(portfolio);

  return { timestamp: new Date().toISOString(), owner, repos: portfolio, classification };
}

// /installation/repositories returns `{ total_count, repositories: [...] }`
// instead of a plain array, so the generic paginate() helper can't be used.
// Returns null when the token is not an installation token (404) or lacks
// permission (403/401).
async function fetchInstallationRepos(gh) {
  const results = [];
  const perPage = 100;
  let page = 1;
  try {
    while (results.length < 500) {
      const data = await gh.request('/installation/repositories', {
        params: { per_page: perPage, page },
      });
      const batch = data.repositories || [];
      if (batch.length === 0) break;
      results.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return results.length > 0 ? results : null;
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('404') || msg.includes('403') || msg.includes('401')) return null;
    throw err;
  }
}

async function fetchUserRepos(gh) {
  try {
    return await gh.paginate('/user/repos', {
      params: { sort: 'pushed', direction: 'desc', affiliation: 'owner', visibility: 'all' },
      max: 500,
    });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('404') || msg.includes('403') || msg.includes('401')) return null;
    throw err;
  }
}


// --- Data fetchers ---

async function fetchOpenIssues(gh, owner, repo) {
  const issues = await gh.paginate(`/repos/${owner}/${repo}/issues`, {
    params: { state: 'open', sort: 'updated', direction: 'desc' },
    max: 200,
  });
  // The issues endpoint includes PRs — filter them out.
  return issues
    .filter(i => !i.pull_request)
    .map(i => ({
      number: i.number,
      title: i.title,
      author: i.user?.login,
      labels: i.labels.map(l => l.name),
      reactions: i.reactions?.total_count || 0,
      comments: i.comments,
      created_at: i.created_at,
      updated_at: i.updated_at,
      assignees: i.assignees?.map(a => a.login) || [],
      milestone: i.milestone?.title || null,
    }));
}

async function fetchClosedIssues(gh, owner, repo, since) {
  const issues = await gh.paginate(`/repos/${owner}/${repo}/issues`, {
    params: { state: 'closed', since, sort: 'updated', direction: 'desc' },
    max: 200,
  });
  return issues
    .filter(i => !i.pull_request)
    .map(i => ({
      number: i.number,
      title: i.title,
      author: i.user?.login,
      labels: i.labels.map(l => l.name),
      closed_at: i.closed_at,
      created_at: i.created_at,
    }));
}

async function fetchMergedPRs(gh, owner, repo, since) {
  // Use the search API to find merged PRs since a date.
  const query = `repo:${owner}/${repo} is:pr is:merged merged:>${since}`;

  const data = await gh.request('/search/issues', {
    params: { q: query, sort: 'updated', order: 'desc', per_page: 100 },
  });

  let allPRs = data.items || [];

  // Fetch additional pages if needed (search API caps at 100 per page).
  if (data.total_count > 100) {
    const totalPages = Math.min(Math.ceil(data.total_count / 100), 10);
    for (let page = 2; page <= totalPages; page++) {
      const pageData = await gh.request('/search/issues', {
        params: { q: query, sort: 'updated', order: 'desc', per_page: 100, page },
      });
      allPRs = [...allPRs, ...(pageData.items || [])];
    }
  }

  return allPRs.map(pr => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login,
    labels: pr.labels.map(l => l.name),
    merged_at: pr.pull_request?.merged_at || pr.closed_at,
  }));
}

async function fetchLabels(gh, owner, repo) {
  const labels = await gh.paginate(`/repos/${owner}/${repo}/labels`, { max: 100 });
  return labels.map(l => ({ name: l.name, description: l.description, color: l.color }));
}

async function fetchMilestones(gh, owner, repo) {
  const milestones = await gh.paginate(`/repos/${owner}/${repo}/milestones`, {
    params: { state: 'all' },
    max: 50,
  });
  return milestones.map(m => ({
    title: m.title,
    state: m.state,
    open_issues: m.open_issues,
    closed_issues: m.closed_issues,
    due_on: m.due_on,
  }));
}

async function fetchReleases(gh, owner, repo, count) {
  const releases = await gh.paginate(`/repos/${owner}/${repo}/releases`, { max: count });
  return releases
    .filter(isPublishedRelease)
    .map(r => ({
      tag: r.tag_name,
      name: r.name,
      published_at: r.published_at,
      prerelease: r.prerelease,
    }));
}

async function fetchWorkflows(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/actions/workflows`);
    return (data.workflows || []).map(w => ({
      name: w.name,
      path: w.path,
      state: w.state,
    }));
  } catch {
    return [];
  }
}

async function fetchRepoMeta(gh, owner, repo) {
  const data = await gh.request(`/repos/${owner}/${repo}`);
  return {
    description: data.description,
    language: data.language,
    stars: data.stargazers_count,
    forks: data.forks_count,
    watchers: data.subscribers_count,
    open_issues_count: data.open_issues_count,
    default_branch: data.default_branch,
    license: data.license?.spdx_id || null,
    topics: data.topics || [],
    created_at: data.created_at,
    pushed_at: data.pushed_at,
    archived: data.archived,
  };
}

async function fetchCommunityProfile(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/community/profile`);
    // The community profile API doesn't detect YAML form-based issue templates
    // (.yml in .github/ISSUE_TEMPLATE/), only the older .md format. Fall back
    // to checking the directory contents when the API says null.
    let hasIssueTemplate = !!data.files?.issue_template;
    if (!hasIssueTemplate) {
      try {
        const dir = await gh.request(`/repos/${owner}/${repo}/contents/.github/ISSUE_TEMPLATE`);
        hasIssueTemplate = Array.isArray(dir) && dir.length > 0;
      } catch { /* directory doesn't exist */ }
    }
    return {
      health_percentage: data.health_percentage,
      files: {
        readme: !!data.files?.readme,
        license: !!data.files?.license,
        contributing: !!data.files?.contributing,
        code_of_conduct: !!data.files?.code_of_conduct,
        issue_template: hasIssueTemplate,
        pull_request_template: !!data.files?.pull_request_template,
      },
    };
  } catch {
    return null;
  }
}

async function fetchDependabotAlerts(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/dependabot/alerts`, {
      params: { state: 'open', per_page: 100 },
    });
    const alerts = Array.isArray(data) ? data : [];
    const severityOrder = ['critical', 'high', 'medium', 'low'];
    let critical = 0, high = 0, medium = 0, low = 0;
    let maxSeverityIndex = severityOrder.length;

    for (const alert of alerts) {
      const severity = alert.security_vulnerability?.severity || alert.security_advisory?.severity;
      if (severity === 'critical') { critical++; }
      else if (severity === 'high') { high++; }
      else if (severity === 'medium') { medium++; }
      else if (severity === 'low') { low++; }
      const idx = severityOrder.indexOf(severity);
      if (idx !== -1 && idx < maxSeverityIndex) { maxSeverityIndex = idx; }
    }

    return {
      count: alerts.length,
      critical,
      high,
      medium,
      low,
      max_severity: maxSeverityIndex < severityOrder.length ? severityOrder[maxSeverityIndex] : null,
    };
  } catch (err) {
    if (err.message?.includes('403') || err.message?.includes('404')) {
      console.log(`Note: Dependabot alerts not available for ${owner}/${repo} (${err.message})`);
    }
    return null;
  }
}

export async function fetchCodeScanningAlerts(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/code-scanning/alerts`, {
      params: { state: 'open', per_page: 100 },
    });
    const alerts = Array.isArray(data) ? data : [];
    const severityOrder = ['critical', 'high', 'medium', 'low'];
    let critical = 0, high = 0, medium = 0, low = 0;
    let maxSeverityIndex = severityOrder.length;

    for (const alert of alerts) {
      const severity = alert.rule?.security_severity_level;
      if (severity === 'critical') { critical++; }
      else if (severity === 'high') { high++; }
      else if (severity === 'medium') { medium++; }
      else if (severity === 'low') { low++; }
      const idx = severityOrder.indexOf(severity);
      if (idx !== -1 && idx < maxSeverityIndex) { maxSeverityIndex = idx; }
    }

    return {
      count: alerts.length,
      critical,
      high,
      medium,
      low,
      max_severity: maxSeverityIndex < severityOrder.length ? severityOrder[maxSeverityIndex] : null,
    };
  } catch (err) {
    if (err.message?.includes('403') || err.message?.includes('404')) {
      console.log(`Note: Code scanning alerts not available for ${owner}/${repo} (${err.message})`);
    }
    return null;
  }
}

export async function fetchSecretScanningAlerts(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/secret-scanning/alerts`, {
      params: { state: 'open', per_page: 100 },
    });
    const alerts = Array.isArray(data) ? data : [];
    return { count: alerts.length };
  } catch (err) {
    if (err.message?.includes('403') || err.message?.includes('404')) {
      console.log(`Note: Secret scanning alerts not available for ${owner}/${repo} (${err.message})`);
    }
    return null;
  }
}

async function fetchCIPassRate(gh, owner, repo) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/actions/runs`, {
      params: { status: 'completed', per_page: 100 },
    });
    const runs = data.workflow_runs || [];
    let passed = 0, failed = 0;

    for (const run of runs) {
      if (run.conclusion === 'success') { passed++; }
      else if (run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out') { failed++; }
    }

    const total = passed + failed;
    return {
      pass_rate: total > 0 ? passed / total : null,
      total_runs: total,
      passed,
      failed,
    };
  } catch {
    return { pass_rate: null, total_runs: 0, passed: 0, failed: 0 };
  }
}


// --- Analysis helpers ---

function buildSummary({ openIssues, closedIssues, mergedPRs, releases, repoMeta, labels, communityProfile, dependabotAlerts, codeScanningAlerts, secretScanningAlerts, ciPassRate }) {
  const labelCounts = {};
  for (const issue of openIssues) {
    for (const label of issue.labels) {
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    }
  }

  const blockedCount = openIssues.filter(i => i.labels.includes('blocked')).length;
  const awaitingFeedback = openIssues.filter(i => i.labels.includes('awaiting user feedback'));
  const highReaction = openIssues
    .filter(i => i.reactions >= 2)
    .sort((a, b) => b.reactions - a.reactions);

  const uniqueAuthors = new Set(mergedPRs.map(p => p.author));
  const botPRs = mergedPRs.filter(p =>
    p.author === 'dependabot[bot]' || p.author === 'app/dependabot'
    || p.author === 'github-actions[bot]' || p.author === 'app/github-actions'
  );

  return {
    repo: repoMeta ? `${repoMeta.stars} stars, ${repoMeta.forks} forks` : 'unknown',
    open_issues: openIssues.length,
    open_bugs: openIssues.filter(i => isBugIssue(i.labels)).length,
    open_features: openIssues.filter(i => isFeatureIssue(i.labels)).length,
    blocked_issues: blockedCount,
    awaiting_feedback: awaitingFeedback.length,
    recently_closed: closedIssues.length,
    recently_merged_prs: mergedPRs.length,
    bot_prs: botPRs.length,
    human_prs: mergedPRs.length - botPRs.length,
    unique_contributors: uniqueAuthors.size,
    releases: releases.length,
    latest_release: releases[0]?.tag || 'none',
    top_open_labels: Object.entries(labelCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`),
    high_reaction_issues: highReaction.map(i => `#${i.number}: ${i.title} (${i.reactions})`),
    stale_awaiting_feedback: awaitingFeedback
      .filter(i => daysSince(i.updated_at) > 14)
      .map(i => `#${i.number}: ${i.title} (${daysSince(i.updated_at)}d)`),
    community_health: communityProfile?.health_percentage ?? null,
    dependabot_alert_count: dependabotAlerts ? dependabotAlerts.count : null,
    dependabot_max_severity: dependabotAlerts?.max_severity ?? null,
    code_scanning_alert_count: codeScanningAlerts ? codeScanningAlerts.count : null,
    code_scanning_max_severity: codeScanningAlerts?.max_severity ?? null,
    secret_scanning_alert_count: secretScanningAlerts ? secretScanningAlerts.count : null,
    ci_pass_rate: ciPassRate?.pass_rate ?? null,
    bus_factor: computeBusFactor(mergedPRs),
    time_to_close_median: computeTimeToCloseMedian(closedIssues),
  };
}

function classifyRepos(repos) {
  const now = Date.now();
  const sixMonths = 180 * 24 * 60 * 60 * 1000;
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const twoYears = 2 * oneYear;

  return {
    active: repos
      .filter(r => !r.archived && !r.fork && (now - new Date(r.pushed_at).getTime()) < sixMonths)
      .map(r => r.name),
    maintained: repos
      .filter(r => !r.archived && !r.fork
        && (now - new Date(r.pushed_at).getTime()) >= sixMonths
        && (now - new Date(r.pushed_at).getTime()) < oneYear)
      .map(r => r.name),
    dormant: repos
      .filter(r => !r.archived && !r.fork
        && (now - new Date(r.pushed_at).getTime()) >= oneYear
        && (now - new Date(r.pushed_at).getTime()) < twoYears)
      .map(r => r.name),
    archive_candidates: repos
      .filter(r => !r.archived && !r.fork && (now - new Date(r.pushed_at).getTime()) >= twoYears)
      .map(r => r.name),
    forks: repos.filter(r => r.fork).map(r => r.name),
    archived: repos.filter(r => r.archived).map(r => r.name),
  };
}

export function computeBusFactor(mergedPRs) {
  if (!mergedPRs || mergedPRs.length === 0) return null;

  const humanPRs = mergedPRs.filter(pr =>
    pr.author && !pr.author.includes('[bot]') && !pr.author.startsWith('app/')
  );

  if (humanPRs.length === 0) return 0;
  if (humanPRs.length < 5) return null;

  const authorCounts = {};
  for (const pr of humanPRs) {
    authorCounts[pr.author] = (authorCounts[pr.author] || 0) + 1;
  }

  const sorted = Object.values(authorCounts).sort((a, b) => b - a);
  const threshold = humanPRs.length * 0.5;
  let cumulative = 0;

  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i];
    if (cumulative >= threshold) return i + 1;
  }

  return sorted.length;
}

export function computeTimeToCloseMedian(closedIssues) {
  if (!closedIssues || closedIssues.length === 0) return null;

  const durations = closedIssues
    .filter(i => i.created_at && i.closed_at)
    .map(i => (new Date(i.closed_at).getTime() - new Date(i.created_at).getTime()) / (1000 * 60 * 60 * 24));

  if (durations.length === 0) return null;

  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2 === 0
    ? (durations[mid - 1] + durations[mid]) / 2
    : durations[mid];

  return {
    median_days: Math.round(median * 10) / 10,
    sample_size: durations.length,
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}
