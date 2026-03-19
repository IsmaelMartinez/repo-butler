import { createClient } from './github.js';

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
  ] = await Promise.all([
    fetchOpenIssues(gh, owner, repo),
    fetchClosedIssues(gh, owner, repo, since),
    fetchMergedPRs(gh, owner, repo, since),
    fetchLabels(gh, owner, repo),
    fetchMilestones(gh, owner, repo),
    fetchReleases(gh, owner, repo, config.observe?.releases_count || 10),
    fetchWorkflows(gh, owner, repo),
    fetchRepoMeta(gh, owner, repo),
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
    summary: buildSummary({
      openIssues, closedIssues, mergedPRs, releases, repoMeta, labels,
    }),
  };

  return snapshot;
}

// Observe all repos for a given owner (portfolio-level view).
export async function observePortfolio(context) {
  const { owner, token } = context;
  const gh = createClient(token);

  console.log(`Observing portfolio for ${owner}...`);

  // Try user endpoint first, fall back to org endpoint.
  let repos;
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

  const portfolio = repos.map(r => ({
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
  }));

  const classification = classifyRepos(portfolio);

  return { timestamp: new Date().toISOString(), owner, repos: portfolio, classification };
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
  return releases.map(r => ({
    tag: r.tag_name,
    name: r.name,
    published_at: r.published_at,
    prerelease: r.prerelease,
    draft: r.draft,
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


// --- Analysis helpers ---

function buildSummary({ openIssues, closedIssues, mergedPRs, releases, repoMeta, labels }) {
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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}
