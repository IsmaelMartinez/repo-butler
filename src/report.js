// REPORT phase: generate HTML dashboard reports from observation data.
// Produces two reports: per-repo (target repo) and portfolio (all repos).
//
// This module is the entry point. The actual report generators live in:
//   report-repo.js      — per-repo dashboard and lightweight reports
//   report-portfolio.js — portfolio dashboard, digest, and dependency inventory
//   report-shared.js    — shared helpers, constants, computeHealthTier, generateHealthBadge
//   report-styles.js    — CSS template literal

import { createClient } from './github.js';
import { observe, observePortfolio, computeBusFactor, computeTimeToCloseMedian } from './observe.js';
import { computeSnapshotHash } from './store.js';
import { computeTrends } from './assess.js';
import { readFile as fsReadFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isBotAuthor, computeHealthTier, generateHealthBadge, SIX_MONTHS_AGO, daysAgoISO, isReleaseExempt } from './report-shared.js';
import {
  fetchMonthlyPRActivity, fetchMonthlyIssueActivity, fetchOpenPRs,
  fetchWeeklyCommits, fetchPRAuthors, computePRCycleTime,
  generateRepoReport, generateLightRepoReport,
  buildActionItems, computeContributorStats,
} from './report-repo.js';
import {
  fetchPortfolioDetails, analyzeDependencyInventory,
  generatePortfolioReport, generateDigestReport,
  generateSparklineSVG, buildCampaignSection,
  buildPortfolioAttentionSection,
} from './report-portfolio.js';

// Re-export everything that tests and other modules need from report.js
export { generateHealthBadge, computeHealthTier } from './report-shared.js';
export { buildActionItems, computeContributorStats } from './report-repo.js';
export { generateSparklineSVG, buildCampaignSection, generateDigestReport, buildPortfolioAttentionSection } from './report-portfolio.js';

export async function report(context) {
  const { owner, token, config, store } = context;
  const outDir = process.env.REPORT_OUTPUT_DIR || 'reports';

  // Auto-run observe if no snapshot exists (standalone report phase).
  if (!context.snapshot) {
    console.log('No snapshot — running OBSERVE first...');
    context.snapshot = await observe(context);
    context.portfolio = await observePortfolio(context);
  }

  // Compute template version hash so presentation changes invalidate cache.
  const templateFiles = ['src/report.js', 'src/report-portfolio.js', 'src/report-repo.js', 'src/report-styles.js', 'src/report-shared.js'];
  const templateContents = await Promise.all(templateFiles.map(f => fsReadFile(f, 'utf8').catch(() => '')));
  const templateVersion = createHash('sha256').update(templateContents.join('')).digest('hex').slice(0, 12);

  // Cache check: skip regeneration if snapshot hasn't changed.
  // Include today's date so the cache expires daily (libyear and other
  // dynamic data like npm registry lookups need periodic refresh).
  const dateBucket = new Date().toISOString().slice(0, 10);
  const currentHash = store ? computeSnapshotHash({ ...context.snapshot, _dateBucket: dateBucket, _templateVersion: templateVersion }) : null;
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

  // Incremental report generation: load per-repo cache to skip unchanged repos.
  const repoCache = store ? await store.readRepoCache() : null;
  if (repoCache) {
    const cachedCount = Object.keys(repoCache.repos || {}).length;
    console.log(`Loaded repo cache with ${cachedCount} entries.`);
  }

  // Gather portfolio-level data (reuse from OBSERVE if already fetched for governance).
  const repoDetails = context.repoDetails
    || (portfolio ? await fetchPortfolioDetails(gh, owner, portfolio.repos, { cache: repoCache }) : null);
  const cachedRepoNames = new Set(repoDetails?._cachedRepos || []);

  // Analyze dependency inventory from SBOM data.
  const depInventory = repoDetails ? analyzeDependencyInventory(repoDetails) : null;

  // Per-repo cache for incremental generation.
  const newRepoCache = { repos: {} };

  // Generate per-repo reports first to collect contributor data for portfolio table.
  if (portfolio) {
    const activeRepos = portfolio.repos
      .filter(r => !r.archived && !r.fork && !r.name.includes('shadow') && !r.name.includes('test-repo'))
      .sort((a, b) => (repoDetails?.[b.name]?.commits || 0) - (repoDetails?.[a.name]?.commits || 0));

    let freshCount = 0;
    let cacheHitCount = 0;

    for (const r of activeRepos) {
      const commits = repoDetails?.[r.name]?.commits || 0;
      const isCached = cachedRepoNames.has(r.name) && repoCache?.repos?.[r.name]?.chartData;

      if (isCached) {
        cacheHitCount++;
        console.log(`Generating report for ${r.name} (cached, ${commits} commits)...`);
      } else {
        freshCount++;
        console.log(`Generating report for ${r.name} (fresh, ${commits} commits)...`);
      }

      if (commits >= 10) {
        let prActivity, issueActivity, openPRs, weeklyCommits, cycleTime;
        let releases, openIssues, closedIssues, meta, communityProfile, prAuthors;

        if (isCached) {
          // Use cached chart data — no API calls needed.
          const cd = repoCache.repos[r.name].chartData;
          prActivity = cd.prActivity || [];
          issueActivity = cd.issueActivity || [];
          openPRs = cd.openPRs || [];
          weeklyCommits = cd.weeklyCommits || [];
          cycleTime = cd.cycleTime || null;
          releases = cd.releases || [];
          openIssues = cd.openIssues || [];
          closedIssues = cd.closedIssues || [];
          meta = cd.meta || null;
          communityProfile = cd.communityProfile || null;
          prAuthors = cd.prAuthors || [];
        } else {
          // Fresh fetch — full API calls for chart data.
          const [prResult, issueActivityRaw, openPRsRaw, weeklyCommitsRaw] = await Promise.all([
            fetchMonthlyPRActivity(gh, owner, r.name),
            fetchMonthlyIssueActivity(gh, owner, r.name),
            fetchOpenPRs(gh, owner, r.name),
            fetchWeeklyCommits(gh, owner, r.name),
          ]);
          prActivity = prResult.monthly;
          cycleTime = computePRCycleTime(prResult.mergedPRs);
          issueActivity = issueActivityRaw;
          openPRs = openPRsRaw;
          weeklyCommits = weeklyCommitsRaw;

          [releases, openIssues, closedIssues, meta, communityProfile] = await Promise.all([
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

          prAuthors = await fetchPRAuthors(gh, owner, r.name);
        }

        if (!isCached) {
          // Fetch PR authors for fresh repos.
          if (repoDetails?.[r.name]) {
            const humanAuthors = prAuthors.filter(a => !isBotAuthor(a.author));
            repoDetails[r.name].contributors = humanAuthors.length;
          }
        } else {
          // For cached repos, use cached contributor count.
          prAuthors = repoCache.repos[r.name].chartData.prAuthors || [];
          if (repoDetails?.[r.name]) {
            repoDetails[r.name].contributors = repoCache.repos[r.name].chartData.contributors ?? 0;
          }
        }

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
          code_scanning_alerts: details?.codeScanning ?? null,
          secret_scanning_alerts: details?.secretScanning ?? null,
          ci_pass_rate: details?.ciPassRate != null ? { pass_rate: details.ciPassRate, total_runs: 0, passed: 0, failed: 0 } : null,
          sbom: details?.sbom || null,
          summary: {
            open_issues: openIssues.length,
            open_bugs: details?.open_bugs ?? null,
            blocked_issues: openIssues.filter(i => i.labels.some(l => l.name === 'blocked')).length,
            awaiting_feedback: openIssues.filter(i => i.labels.some(l => l.name.includes('feedback'))).length,
            recently_merged_prs: prAuthors.reduce((s, a) => s + a.count, 0),
            human_prs: prAuthors.filter(a => !isBotAuthor(a.author)).reduce((s, a) => s + a.count, 0),
            bot_prs: prAuthors.filter(a => isBotAuthor(a.author)).reduce((s, a) => s + a.count, 0),
            releases: releases.length,
            latest_release: releases[0]?.tag_name || 'none',
            ci_workflows: details?.ci || 0,
            bus_factor: computeBusFactor(mergedPRsForBusFactor),
            time_to_close_median: computeTimeToCloseMedian(closedIssues),
          },
        };

        // Reuse libyear from portfolio details (already computed in fetchPortfolioDetails).
        const libyear = details?.libyear || null;

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
        const html = generateRepoReport(repoSnapshot, prActivity, issueActivity, prAuthors, repoTrends, dashboardUrl, openPRs, cycleTime, weeklyCommits, repoDepSummary, libyear, config);
        await writeFile(join(outDir, `${r.name}.html`), html);

        // Save chart data to cache for future incremental runs.
        // Strip large fields (sbom) from the cached details; keep only what reports need.
        const detailsForCache = { ...details };
        delete detailsForCache.sbom;
        newRepoCache.repos[r.name] = {
          pushed_at: r.pushed_at,
          open_issues_count: r.open_issues || 0,
          details: detailsForCache,
          chartData: {
            prActivity, issueActivity, openPRs, weeklyCommits, cycleTime,
            releases, openIssues, closedIssues, meta, communityProfile,
            prAuthors,
            contributors: repoDetails?.[r.name]?.contributors ?? 0,
          },
        };
      } else {
        // Lightweight report — just metadata, no chart API calls.
        if (!isCached) {
          const prAuthors = await fetchPRAuthors(gh, owner, r.name);
          if (repoDetails?.[r.name]) {
            const humanAuthors = prAuthors.filter(a => !isBotAuthor(a.author));
            repoDetails[r.name].contributors = humanAuthors.length;
          }
        } else if (repoDetails?.[r.name]) {
          repoDetails[r.name].contributors = repoCache.repos[r.name]?.chartData?.contributors ?? 0;
        }
        const html = generateLightRepoReport(owner, r, repoDetails?.[r.name]);
        await writeFile(join(outDir, `${r.name}.html`), html);

        // Cache lightweight repo details too.
        const detailsForCache = { ...(repoDetails?.[r.name] || {}) };
        delete detailsForCache.sbom;
        newRepoCache.repos[r.name] = {
          pushed_at: r.pushed_at,
          open_issues_count: r.open_issues || 0,
          details: detailsForCache,
        };
      }
    }

    console.log(`Generated reports for ${activeRepos.length} repos (${cacheHitCount} cached, ${freshCount} fresh).`);
  }

  // Generate portfolio report (after per-repo reports so contributor data is available).
  if (portfolio && repoDetails) {
    const portfolioHtml = generatePortfolioReport(owner, portfolio, repoDetails, null, depInventory, config);
    await writeFile(join(outDir, 'index.html'), portfolioHtml);
    console.log('Portfolio report written to index.html');

    // Generate narrative weekly digest.
    const digestHtml = generateDigestReport(owner, portfolio.repos, repoDetails);
    await writeFile(join(outDir, 'digest.html'), digestHtml);
    console.log('Weekly digest written to digest.html');

    // Persist weekly portfolio summaries for per-repo trend charts.
    if (store) {
      await store.writePortfolioWeekly(portfolio, repoDetails, config);
    }
  }

  // Generate SVG health badges for each active repo and portfolio overall.
  if (portfolio) {
    const activeRepos = portfolio.repos
      .filter(r => !r.archived && !r.fork && !r.name.includes('shadow') && !r.name.includes('test-repo'))
      .sort((a, b) => (repoDetails?.[b.name]?.commits || 0) - (repoDetails?.[a.name]?.commits || 0));

    // Generate SVG health badges for each active repo and portfolio overall.
    const badgeDir = join(outDir, 'badges');
    await mkdir(badgeDir, { recursive: true });

    const tierOrder = { gold: 3, silver: 2, bronze: 1, none: 0 };
    let tierSum = 0;
    let scoredCount = 0;

    for (const r of activeRepos) {
      const d = repoDetails?.[r.name] || {};
      const classified = { ...r, ...d };
      const { tier } = computeHealthTier(classified, { releaseExempt: isReleaseExempt(r.name, config) });
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

  // Persist hash and repo cache after successful generation.
  if (store && currentHash) {
    await store.writeHash(currentHash);
  }
  if (store && newRepoCache && Object.keys(newRepoCache.repos).length > 0) {
    await store.writeRepoCache(newRepoCache);
    console.log(`Repo cache updated (${Object.keys(newRepoCache.repos).length} entries).`);
  }

  return { outDir };
}
