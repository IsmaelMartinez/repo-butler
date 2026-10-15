// REPORT phase: generate HTML dashboard reports from observation data.
// Produces two reports: per-repo (target repo) and portfolio (all repos).
//
// This module is the entry point. The actual report generators live in:
//   report-repo.js           — per-repo dashboard and lightweight reports
//   report-portfolio.js      — portfolio dashboard, digest, and dependency inventory rendering
//   report-portfolio-data.js — portfolio details fetch and dependency inventory analysis
//   report-shared.js         — shared helpers, constants, computeHealthTier, generateHealthBadge
//   report-styles.js         — CSS template literal

import { createClient, paginateIssues } from './github.js';
import { observe, observePortfolio, computeBusFactor, computeTimeToCloseMedian } from './observe.js';
import { computeSnapshotHash } from './store.js';
import { computeTrends } from './assess.js';
import { readFile as fsReadFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';

import { isBotAuthor, tierStatus, portfolioBadgeTier, generateHealthBadge, SIX_MONTHS_AGO, daysAgoISO, isReleaseExempt, REPO_CACHE_SCHEMA_VERSION, isPublishedRelease, buildRepoSnapshot, isExcludedRepo } from './report-shared.js';
import { buildAgentCard } from './agent-card.js';
import {
  fetchMonthlyPRActivity, fetchMonthlyIssueActivity, fetchOpenPRs,
  fetchWeeklyCommits, fetchPRAuthors, computePRCycleTime,
  generateRepoReport, generateLightRepoReport,
} from './report-repo.js';
import { generatePortfolioReport, generateDigestReport } from './report-portfolio.js';
import { fetchPortfolioDetails, analyzeDependencyInventory } from './report-portfolio-data.js';

// Thin orchestration wrapper used by the index dispatcher.
export async function runReport(context) {
  const result = await report(context);
  context.reportResult = result;
  return result;
}

// True only when the REPORT phase ran and cache-hit (snapshot unchanged, so no
// new index.html was written and the live dashboard is already current). The
// index dispatcher emits this as the `report_cached` GitHub Actions output, and
// the self-test "Check reports exist" guard uses it to treat a healthy cache-hit
// as success rather than a missing-output deploy failure (#216). Strict `=== true`
// so a regenerated run, a failed/absent report, or any non-cache result is false —
// which keeps the guard's genuine-failure detection intact. Pure function.
export function reportCacheHit(context) {
  return context?.reportResult?.cached === true;
}

// Files whose contents feed the template version hash, so a presentation change
// in any of them invalidates the report cache. report.test.js checks that every
// src/report*.js module is listed.
export const TEMPLATE_FILES = ['src/report.js', 'src/report-portfolio.js', 'src/report-portfolio-data.js', 'src/report-repo.js', 'src/report-styles.js', 'src/report-shared.js'];

// Prefix of the global hash written after a run that degraded some repo's
// card. A computed hash is bare hex, so a marked one never matches it and the
// next run regenerates (retrying the degraded repo, which has no repo-cache
// entry). Not exported: report.js exports only its entry points (#422).
const INCOMPLETE_HASH_PREFIX = 'incomplete:';

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
  const templateContents = await Promise.all(TEMPLATE_FILES.map(f => fsReadFile(f, 'utf8').catch(() => '')));
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

  // Copy the committed dashboard assets (hero photo, tweed texture, glen-hills
  // SVGs) into the published output so the GitHub Pages site is self-contained
  // — no hotlinking, no external image hosting. `reports/` is gitignored and
  // uploaded wholesale as the Pages artifact, so the assets must be written
  // into it at generation time. Best-effort: a missing source dir must not
  // fail the REPORT phase.
  try {
    await cp('assets/dashboard', join(outDir, 'assets'), { recursive: true });
  } catch (err) {
    console.log(`Dashboard assets not copied: ${err.message}`);
  }

  const gh = createClient(token);

  // Incremental report generation: load per-repo cache to skip unchanged repos.
  const repoCache = store ? await store.readRepoCache() : null;
  if (repoCache) {
    const cachedCount = Object.keys(repoCache.repos || {}).length;
    console.log(`Loaded repo cache with ${cachedCount} entries.`);
  }

  // Bridge repo renames in the cache: if a current repo's name isn't in the
  // cache but a cache entry with the same GitHub ID exists under the old name,
  // migrate it so the incremental generation cache-hit check works.
  if (repoCache?.repos && portfolio?.repos) {
    const cacheIdMap = new Map();
    for (const [name, entry] of Object.entries(repoCache.repos)) {
      if (entry?.id) cacheIdMap.set(entry.id, name);
    }
    for (const r of portfolio.repos) {
      if (r.id && !repoCache.repos[r.name] && cacheIdMap.has(r.id)) {
        const oldName = cacheIdMap.get(r.id);
        console.log(`Repo rename detected: ${oldName} → ${r.name} (id ${r.id}), migrating cache entry.`);
        repoCache.repos[r.name] = repoCache.repos[oldName];
        delete repoCache.repos[oldName];
      }
    }
  }

  // Gather portfolio-level data (reuse from OBSERVE if already fetched for governance).
  const repoDetails = context.repoDetails
    || (portfolio ? await fetchPortfolioDetails(gh, owner, portfolio.repos, { cache: repoCache }) : null);
  const cachedRepoNames = new Set(repoDetails?._cachedRepos || []);

  // Analyze dependency inventory from SBOM data.
  const depInventory = repoDetails ? analyzeDependencyInventory(repoDetails) : null;

  // Per-repo cache for incremental generation.
  const newRepoCache = { repos: {} };
  // Repos degraded to the light card by the per-repo catch below. Function
  // scope because the global hash write at the end depends on it.
  let degradedCount = 0;

  // Generate per-repo reports first to collect contributor data for portfolio table.
  if (portfolio) {
    const activeRepos = portfolio.repos
      .filter(r => !r.archived && !r.fork && !isExcludedRepo(r.name))
      .sort((a, b) => (repoDetails?.[b.name]?.commits || 0) - (repoDetails?.[a.name]?.commits || 0));

    let freshCount = 0;
    let cacheHitCount = 0;
    // The last status seen by the degraded catch below, for the
    // systemic-outage check after the loop (degradedCount is declared above).
    let lastDegradedStatus = null;

    for (const r of activeRepos) {
      try {
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
              gh.paginate(`/repos/${owner}/${r.name}/releases`, { max: 20 })
                .then(rels => rels.filter(isPublishedRelease))
                .catch(() => []),
              paginateIssues(gh, owner, r.name, { params: { state: 'open' }, max: 100 })
                .catch(() => []),
              paginateIssues(gh, owner, r.name, { params: { state: 'closed', since: daysAgoISO(90), sort: 'updated', direction: 'desc' }, max: 200 })
                .then(issues => issues.map(i => ({ created_at: i.created_at, closed_at: i.closed_at })))
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

          const repoSnapshot = buildRepoSnapshot({
            owner,
            repo: r.name,
            details,
            meta,
            communityProfile,
            releases,
            openIssues,
            prAuthors,
            busFactor: computeBusFactor(mergedPRsForBusFactor),
            timeToCloseMedian: computeTimeToCloseMedian(closedIssues),
            pushedAt: r.pushed_at,
            stars: r.stars,
            forks: r.forks,
            homepage: r.homepage || null,
          });

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
          const repoDepSummary = depInventory?.repoSummaries?.[r.name] || null;
          // Assessment narrative is scoped to the config repo's snapshot (ASSESS runs once per run).
          const repoAssessment = r.name === context.repo ? (context.assessment?.assessment || null) : null;
          const html = generateRepoReport(repoSnapshot, prActivity, issueActivity, prAuthors, repoTrends, openPRs, cycleTime, weeklyCommits, repoDepSummary, libyear, config, repoAssessment);
          await writeFile(join(outDir, `${r.name}.html`), html);

          // Save chart data to cache for future incremental runs.
          // Strip large fields (sbom) from the cached details; keep only what reports need.
          const detailsForCache = { ...details };
          delete detailsForCache.sbom;
          newRepoCache.repos[r.name] = {
            schemaVersion: REPO_CACHE_SCHEMA_VERSION,
            id: r.id ?? null,
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
            schemaVersion: REPO_CACHE_SCHEMA_VERSION,
            id: r.id ?? null,
            pushed_at: r.pushed_at,
            open_issues_count: r.open_issues || 0,
            details: detailsForCache,
          };
        }
      } catch (err) {
        // A failed read on one repo's chart data (an HTTP error, or since #501 a
        // list page that is not an array) degrades that repo to the lightweight
        // card instead of failing REPORT for the whole portfolio. Nothing is
        // cached for it, and the run is marked incomplete in the global hash
        // (below), so the next run refetches rather than serving a degraded
        // entry until the repo's next push or the next day. Portfolio repos are public
        // (privateRepos never reach this loop), so naming the repo is fine; the
        // status alone is logged, never the response body.
        //
        // Only an error the API ANSWERED (one carrying a numeric `status`) is
        // absorbed. Anything else — a render bug, a network failure, the
        // status-less "rate limited after 3 retries" — still fails the phase
        // as before, so a code fault is never quietly turned into a light card.
        // A 401 is never one repo's problem — the token itself is bad — so it
        // fails the phase too rather than degrading every repo in turn.
        //
        // The cache entry is the last statement of each branch above, so a
        // repo that reaches here never has one: nothing to undo.
        if (typeof err?.status !== 'number' || err.status === 401) throw err;
        degradedCount++;
        lastDegradedStatus = err.status;
        console.log(`report: chart data unreadable for ${r.name} (status ${err.status}); writing lightweight card`);
        await writeFile(join(outDir, `${r.name}.html`), generateLightRepoReport(owner, r, repoDetails?.[r.name], { degraded: true }));
      }
    }

    console.log(`Generated reports for ${activeRepos.length} repos (${cacheHitCount} cached, ${freshCount} fresh).`);
    if (degradedCount > 0) {
      console.log(`report: ${degradedCount} of ${freshCount} fresh repo(s) degraded to the lightweight card (chart data unreadable).`);
      // One repo's bad page is that repo's problem; EVERY fresh repo failing is
      // an outage (a revoked scope, an API incident), and publishing a
      // portfolio of light cards over the live dashboard would hide it. Fail
      // the phase as before. Cached repos make no API calls here, so only the
      // fresh ones are evidence either way.
      if (degradedCount === freshCount) {
        throw Object.assign(
          new Error(`REPORT: chart data unreadable for all ${freshCount} fresh repo(s) — failing the phase rather than publishing degraded cards`),
          { status: lastDegradedStatus },
        );
      }
    }
  }

  // Generate portfolio report (after per-repo reports so contributor data is available).
  if (portfolio && repoDetails) {
    // Previous run's portfolio snapshot, read before writePortfolioWeekly below
    // overwrites the current-week file — drives the dashboard's "since the last
    // run" delta (tier moves + security changes). Optional-chained so a test
    // store without the method, or a fresh data branch, simply yields null and
    // the dashboard renders its first-run calm state.
    const priorPortfolio = await store?.readLatestPortfolioWeekly?.() ?? null;
    const portfolioHtml = generatePortfolioReport({
      owner, portfolio, details: repoDetails, depInventory, config,
      governanceFindings: context.governanceFindings, priorPortfolio,
      priorAutofixNotDrivenCount: context.priorAutofixNotDrivenCount,
    });
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
      .filter(r => !r.archived && !r.fork && !isExcludedRepo(r.name))
      .sort((a, b) => (repoDetails?.[b.name]?.commits || 0) - (repoDetails?.[a.name]?.commits || 0));

    // Generate SVG health badges for each active repo and portfolio overall.
    const badgeDir = join(outDir, 'badges');
    await mkdir(badgeDir, { recursive: true });

    const scored = [];

    for (const r of activeRepos) {
      const d = repoDetails?.[r.name] || {};
      const classified = { ...r, ...d };
      const { tier, provisional } = tierStatus(classified, { releaseExempt: isReleaseExempt(r.name, config) });
      const svg = generateHealthBadge(r.name, tier, { provisional });
      await writeFile(join(badgeDir, `${r.name}.svg`), svg);
      const pushed = new Date(r.pushed_at);
      const isActive = pushed >= SIX_MONTHS_AGO && !r.fork && !isExcludedRepo(r.name);
      if (isActive) scored.push({ tier, provisional });
    }

    // Portfolio-level badge: the mean confirmed tier across active repos.
    const portfolioSvg = generateHealthBadge('portfolio', portfolioBadgeTier(scored));
    await writeFile(join(badgeDir, 'portfolio.svg'), portfolioSvg);

    console.log(`Generated badges for ${activeRepos.length} repos + portfolio.`);
  }

  // A2A AgentCard for capability discovery. Published alongside the dashboards
  // so A2A-aware agents can fetch it from GitHub Pages at /.well-known/agent-card.json.
  // The .nojekyll marker disables Jekyll on Pages; without it, dotfile dirs like
  // .well-known/ are stripped from the published site and the card 404s.
  {
    const pkgRaw = await fsReadFile('package.json', 'utf8').catch(() => null);
    const version = pkgRaw ? (JSON.parse(pkgRaw).version || '0.0.0') : '0.0.0';
    const repoSlug = context.snapshot?.repository || `${owner}/${context.repo || 'repo-butler'}`;
    const card = buildAgentCard({ version, repo: repoSlug });
    const wellKnownDir = join(outDir, '.well-known');
    await mkdir(wellKnownDir, { recursive: true });
    await writeFile(join(wellKnownDir, 'agent-card.json'), JSON.stringify(card, null, 2));
    await writeFile(join(outDir, '.nojekyll'), '');
    console.log('A2A AgentCard and .nojekyll marker written to reports/');
  }

  // Persist hash and repo cache after successful generation. A partial
  // generation (some repo degraded to the light card) must not store the hash
  // that short-circuits the next run: the cache check at the top returns
  // before any per-repo cache entry is consulted, so the degraded card would
  // stand until the snapshot or the date changed, however soon the API
  // recovered. Writing a marker that can never equal a computed hash, rather
  // than skipping the write, also invalidates a matching hash an earlier run
  // stored — the case a forced run (which skips the check) would otherwise
  // leave behind.
  if (store && currentHash) {
    await store.writeHash(degradedCount > 0 ? `${INCOMPLETE_HASH_PREFIX}${currentHash}` : currentHash);
  }
  if (store && newRepoCache && Object.keys(newRepoCache.repos).length > 0) {
    await store.writeRepoCache(newRepoCache);
    console.log(`Repo cache updated (${Object.keys(newRepoCache.repos).length} entries).`);
  }

  return { outDir };
}
