import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPO_CACHE_SCHEMA_VERSION } from './report-shared.js';

describe('fetchPortfolioDetails incremental cache', () => {
  it('uses cached details when pushed_at and open_issues_count match (but refreshes the volatile settings, workflow-listing and security-alert reads)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // On a cache hit, only the six volatile reads should run: the autofix GET
    // (ADR-012 Phase 3), the copilot ruleset-list paginate (ADR-009), the
    // workflows-DIRECTORY listing that re-derives hasOsvScanner, and the three
    // security-alert summaries. The first two are settings that flip without a
    // push; the listing is re-read because its verdict is tri-state, and an
    // unknown cached on one failed read would otherwise be served until the
    // repo's next push, which on a quiet repo is never; the alerts change with
    // no push and gate Gold. Every push-invariant field still comes from cache.
    // This mock's ruleset list is empty, so hasActiveCopilotReviewRuleset never needs
    // a per-ruleset detail GET here — with active rulesets present it would also
    // issue /rulesets/{id} GETs, which is expected and not a full re-fetch. No
    // getFileContent / other network calls should occur either way.
    const requestPaths = [];
    const paginatePaths = [];
    let getFileContentCalled = false;
    const gh = {
      request: (path) => {
        requestPaths.push(path);
        if (path.endsWith('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
        if (path.includes('-scanning/alerts') || path.includes('/dependabot/alerts')) return Promise.resolve([]);
        return Promise.resolve({});
      },
      paginate: (path) => { paginatePaths.push(path); return Promise.resolve([]); },
      getFileContent: () => { getFileContentCalled = true; return Promise.resolve(null); },
    };
    const repos = [
      { name: 'cached-repo', pushed_at: '2026-04-01T00:00:00Z', open_issues: 5, archived: false, fork: false, stars: 10 },
    ];
    const cache = {
      repos: {
        'cached-repo': {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-04-01T00:00:00Z',
          open_issues_count: 5,
          // hasCopilotReview stale-true; the ruleset list mock below returns no
          // active rulesets, so the live read should flip it to false.
          details: { commits: 42, weekly: [1, 2], license: 'MIT', ci: 1, communityHealth: 80, vulns: null, ciPassRate: 0.95, open_issues: 5, open_bugs: 0, open_prs: 0, libyear: null, codeScanning: null, secretScanning: null, traffic: null, hasIssueTemplate: true, released_at: null, autofix: null, hasCopilotReview: true },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.deepEqual(requestPaths, [
      '/repos/owner/cached-repo/automated-security-fixes',
      '/repos/owner/cached-repo/contents/.github/workflows',
      '/repos/owner/cached-repo/dependabot/alerts?state=open&per_page=100',
      '/repos/owner/cached-repo/code-scanning/alerts?state=open&per_page=100',
      '/repos/owner/cached-repo/secret-scanning/alerts?state=open&per_page=100',
    ], 'only the volatile reads run on a cache hit: autofix, the osv-scanner contents listing and the three alert summaries');
    assert.deepEqual(paginatePaths, ['/repos/owner/cached-repo/rulesets'], 'only the copilot ruleset list paginate runs on a cache hit');
    assert.equal(getFileContentCalled, false, 'no getFileContent on a cache hit');
    assert.equal(details['cached-repo'].commits, 42, 'should use cached commits');
    assert.deepEqual(details['cached-repo'].autofix, { enabled: true, paused: false }, 'refreshes the stale autofix state from the live GET');
    assert.equal(details['cached-repo'].hasCopilotReview, false, 'refreshes the stale copilot-review state from the live read');
    assert.ok(details._cachedRepos.includes('cached-repo'), 'should mark as cached');
  });

  // Cache-hit re-derivation of the two templated-workflow flags. Neither
  // hasOsvScanner nor hasAutoMergeWorkflow is ever served from the cache entry —
  // both are recomputed from ONE live contents listing on every cache hit. The
  // reason is the tri-state: a single failed read writes `null`, and a cached
  // `null` would be served until the repo's next push, which on a quiet repo is
  // never. Governance skips unknowns, so the standard would silently never apply
  // to exactly the repos nobody touches — the ones most likely to be missing it.
  // One extra call buys a verdict that is always current, for both flags.
  const cachedWorkflowsGh = (contentsResponse) => ({
    request: (path) => {
      if (path.endsWith('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
      if (path.includes('/contents/.github/workflows')) return contentsResponse();
      return Promise.resolve({});
    },
    paginate: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(null),
  });
  const cachedWorkflowsRepos = [
    { name: 'cached-repo', pushed_at: '2026-04-01T00:00:00Z', open_issues: 5, archived: false, fork: false, stars: 10 },
  ];
  const cachedWorkflowsCache = (details) => ({
    repos: {
      'cached-repo': {
        schemaVersion: REPO_CACHE_SCHEMA_VERSION,
        pushed_at: '2026-04-01T00:00:00Z',
        open_issues_count: 5,
        details: { commits: 42, hasCopilotReview: false, ...details },
      },
    },
  });

  // #449: repo-cache.json outgrew the Contents API's 1 MB inline ceiling, so
  // the store read returned null and this function never saw a hit. End to end
  // from the store read, a cache that arrives through the blob fallback must
  // produce a hit exactly as an inline one does.
  it('hits the cache when repo-cache.json arrives through the over-1 MB blob path', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const { createStore } = await import('./store.js');
    const sha = 'c1eee2546c92c6407e1107f6f88062808dc1553a';
    const encoded = Buffer.from(JSON.stringify(cachedWorkflowsCache({ commits: 42, ci: 2 }))).toString('base64');
    const dataGh = {
      request: async (path) => {
        if (path === '/repos/owner/repo-butler/contents/snapshots/repo-cache.json') return { encoding: 'none', content: '', sha };
        if (path === `/repos/owner/repo-butler/git/blobs/${sha}`) return { sha, encoding: 'base64', content: encoded };
        throw new Error(`unexpected request ${path}`);
      },
    };
    const cache = await createStore({ owner: 'owner', repo: 'repo-butler', token: 't', gh: dataGh }).readRepoCache();
    const gh = cachedWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache });
    assert.ok(details._cachedRepos.includes('cached-repo'), 'the large-file cache must produce a hit');
    assert.equal(details['cached-repo'].commits, 42, 'push-invariant fields come from the cache');
    assert.equal(details['cached-repo'].ci, 2, 'the ci last-known value is available again');
  });

  // Security alerts change without a push (a new advisory, a scheduled CodeQL
  // run, a manual dismissal) and feed the Gold "zero critical/high" check and
  // governance's open-vulnerability detector, so the cache-hit path must read
  // them live. Serving the cached counts would hold a repo at Gold after a new
  // high landed, for as long as the repo stayed quiet.
  const absent = () => Promise.reject(Object.assign(new Error('404'), { status: 404 }));
  const securityGh = ({ dependabot, codeScanning, secretScanning, dependabotYml = absent }) => ({
    request: (path) => {
      if (path.endsWith('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
      if (path.endsWith('/contents/.github/dependabot.yml')) return dependabotYml();
      if (path.includes('/contents/.github/workflows')) return Promise.resolve([{ name: 'ci.yml' }]);
      if (path.includes('/dependabot/alerts')) return dependabot();
      if (path.includes('/code-scanning/alerts')) return codeScanning();
      if (path.includes('/secret-scanning/alerts')) return secretScanning();
      return Promise.resolve({});
    },
    paginate: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(null),
  });
  const zeroSummary = { count: 0, critical: 0, high: 0, medium: 0, low: 0, max_severity: null };
  const cleanCachedDetails = {
    ci: 2, license: 'MIT', communityHealth: 100, open_bugs: 0, released_at: new Date().toISOString(),
    vulns: zeroSummary, codeScanning: zeroSummary, secretScanning: { count: 0 },
  };
  const reject500 = () => Promise.reject(Object.assign(new Error('500'), { status: 500 }));

  it('reads security alerts live on a cache hit, so a new high drops the Gold check', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const { computeHealthTier } = await import('./report-shared.js');
    const gh = securityGh({
      dependabot: () => Promise.resolve([{ security_vulnerability: { severity: 'high' } }]),
      codeScanning: () => Promise.resolve([{ rule: { security_severity_level: 'critical' } }]),
      secretScanning: () => Promise.resolve([{ number: 1 }]),
    });
    const cache = cachedWorkflowsCache(cleanCachedDetails);
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache });
    const d = details['cached-repo'];
    assert.ok(details._cachedRepos.includes('cached-repo'), 'still a cache hit');
    assert.equal(d.vulns.max_severity, 'high', 'dependabot summary comes from the live read');
    assert.equal(d.codeScanning.max_severity, 'critical', 'code-scanning summary comes from the live read');
    assert.equal(d.secretScanning.count, 1, 'secret-scanning count comes from the live read');
    const check = computeHealthTier({ ...d, pushed_at: cachedWorkflowsRepos[0].pushed_at })
      .checks.find(c => c.name === 'Zero critical/high security findings');
    assert.equal(check.passed, false, 'the tier must see the live high, not the cached zero');
    assert.equal(cache.repos['cached-repo'].details.vulns, zeroSummary, 'the cache object is never mutated');
  });

  it('reports an unreadable live alert read as unreadable, as the miss path does, never the cached counts', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = securityGh({ dependabot: reject500, codeScanning: reject500, secretScanning: reject500 });
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ ...cleanCachedDetails, vulns: { ...zeroSummary, count: 3, low: 3 } }),
    });
    const d = details['cached-repo'];
    assert.deepEqual(d.vulns, { unreadable: true }, 'an unreadable dependabot read is unknown, not the cached summary');
    assert.deepEqual(d.codeScanning, { unreadable: true });
    assert.deepEqual(d.secretScanning, { unreadable: true });
  });

  // #452: null is the scanner's own answer ("not enabled"), and the tier and the
  // standards detectors read it as such. A failure that is not an answer must
  // stay distinguishable from it, on both the cache-hit and cache-miss paths.
  it('keeps a definitive 403/404 "not enabled" as null, distinct from an unreadable read', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const reject = status => () => Promise.reject(Object.assign(new Error(String(status)), { status }));
    for (const status of [403, 404]) {
      const gh = securityGh({ dependabot: reject(status), codeScanning: reject(status), secretScanning: reject(status) });
      const d = (await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache: cachedWorkflowsCache(cleanCachedDetails) }))['cached-repo'];
      assert.equal(d.vulns, null, `dependabot ${status} with no dependabot.yml is not enabled`);
      assert.equal(d.codeScanning, null, `code scanning ${status} is not enabled`);
      assert.equal(d.secretScanning, null, `secret scanning ${status} is not enabled`);
    }
  });

  it('reads an exhausted rate limit (an error with no status) as unreadable, not as not-enabled', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const rateLimited = () => Promise.reject(new Error('GitHub API GET x: rate limited after 3 retries'));
    const gh = securityGh({ dependabot: rateLimited, codeScanning: rateLimited, secretScanning: rateLimited });
    const d = (await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache: cachedWorkflowsCache(cleanCachedDetails) }))['cached-repo'];
    assert.deepEqual([d.vulns, d.codeScanning, d.secretScanning], [{ unreadable: true }, { unreadable: true }, { unreadable: true }]);
  });

  it('carries an unreadable read on the cache-MISS path too', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const d = (await fetchPortfolioDetails(securityGh({ dependabot: reject500, codeScanning: reject500, secretScanning: reject500 }), 'owner', cachedWorkflowsRepos))['cached-repo'];
    assert.deepEqual([d.vulns, d.codeScanning, d.secretScanning], [{ unreadable: true }, { unreadable: true }, { unreadable: true }]);
  });

  it('reads a non-array secret-scanning response as unknown, not as zero alerts', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = securityGh({
      dependabot: () => Promise.resolve([]),
      codeScanning: () => Promise.resolve([]),
      secretScanning: () => Promise.resolve({ message: 'unexpected shape' }),
    });
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache: cachedWorkflowsCache(cleanCachedDetails) });
    assert.deepEqual(details['cached-repo'].secretScanning, { unreadable: true });
  });

  it('reads a non-array Dependabot or code-scanning body as unreadable, never as a summary (#452)', async () => {
    // A string is iterable, so tallying it would report one "alert" per
    // character with no severity — a clean-looking summary from nonsense.
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const garbled = () => Promise.resolve('<html>bad gateway</html>');
    const gh = securityGh({ dependabot: garbled, codeScanning: garbled, secretScanning: () => Promise.resolve([]) });
    const d = (await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, { cache: cachedWorkflowsCache(cleanCachedDetails) }))['cached-repo'];
    assert.deepEqual([d.vulns, d.codeScanning], [{ unreadable: true }, { unreadable: true }]);
  });

  // A 403 with dependabot.yml present means Dependabot is configured but its
  // alerts could not be read (#477). It used to report a zero count, which
  // passed Gold on no evidence; it is unread now, like any other failed read.
  // With no dependabot.yml a 403 stays the "not enabled" answer (null).
  it('reads a 403 with dependabot.yml present as unread, never as zero alerts', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const withDependabotYml = (dependabot, dependabotYml = () => Promise.resolve({ type: 'file' })) =>
      securityGh({ dependabot, codeScanning: reject500, secretScanning: reject500, dependabotYml });
    const cache = () => cachedWorkflowsCache(cleanCachedDetails);
    const forbidden = () => Promise.reject(Object.assign(new Error('403'), { status: 403 }));

    const on500 = await fetchPortfolioDetails(withDependabotYml(reject500), 'owner', cachedWorkflowsRepos, { cache: cache() });
    assert.deepEqual(on500['cached-repo'].vulns, { unreadable: true }, 'a 500 is unknown, never a zero');

    const on403 = await fetchPortfolioDetails(withDependabotYml(forbidden), 'owner', cachedWorkflowsRepos, { cache: cache() });
    assert.deepEqual(on403['cached-repo'].vulns, { unreadable: true }, 'a 403 with dependabot.yml present is unread');

    const missed = await fetchPortfolioDetails(withDependabotYml(forbidden), 'owner', cachedWorkflowsRepos);
    assert.deepEqual(missed['cached-repo'].vulns, { unreadable: true }, 'the cache-miss path agrees');

    // Only a 404 proves dependabot.yml absent. A failed read of it is not that
    // answer, so the 403 stays unread rather than "not enabled".
    const configUnread = await fetchPortfolioDetails(withDependabotYml(forbidden, reject500), 'owner', cachedWorkflowsRepos, { cache: cache() });
    assert.deepEqual(configUnread['cached-repo'].vulns, { unreadable: true }, 'an unreadable dependabot.yml is not an absent one');
  });

  it('treats an EMPTY cached details object as never-fetched, not as a cache hit', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // report.js persists `{ ...(repoDetails?.[name] || {}) }` for every active
    // repo, so one skipped past PORTFOLIO_DETAIL_LIMIT is cached as `{}` under a
    // current schema version. Taking the cache-hit branch would spread the
    // live-refreshed fields onto that and hand governance a NON-EMPTY details
    // object carrying no license, no codeowners and no security policy —
    // defeating hasRepoDetails, which exists to reject exactly that entry, and
    // making the repo a remediation-PR target on every allow-listed standard at
    // once. It must fall through to a full fetch instead.
    const gh = cachedWorkflowsGh(() => Promise.resolve([{ name: 'osv-scanner.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: {
        repos: {
          'cached-repo': {
            schemaVersion: REPO_CACHE_SCHEMA_VERSION,
            pushed_at: '2026-04-01T00:00:00Z',
            open_issues_count: 5,
            details: {},
          },
        },
      },
    });
    const d = details['cached-repo'];
    assert.ok(Object.keys(d).length > 4, 'must be a full fetch, not four refreshed keys spread onto {}');
    assert.ok('license' in d, 'a full fetch populates license; the cache-hit branch cannot');
  });

  it('re-derives a cached unknown hasOsvScanner into a real verdict without waiting for a push', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // The whole point of the cache-hit re-read. Last run's contents read failed
    // and cached `null`; this run's succeeds and finds the file. Serving the
    // cached value would strand the repo as unknown indefinitely.
    const gh = cachedWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }, { name: 'osv-scanner.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ hasOsvScanner: null }),
    });
    assert.equal(details['cached-repo'].hasOsvScanner, true, 'a cached unknown must be re-derived, never served');
  });

  it('keeps a known cached hasOsvScanner when the live re-read fails for a reason other than 404', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // The re-read exists to stop an unknown becoming permanent, not to let a
    // transient one erase a fact. An unknown live read is strictly less
    // information than the cached verdict: without the fallback one 500 on the
    // contents API turns a cached `false` — a real, actionable gap — into
    // `null`, governance skips the repo as unknown, and the run reports no gap
    // at all. The rejection is shaped exactly like github.js's: the status in
    // the message and as `err.status`, no richer and no poorer than the client.
    const gh = cachedWorkflowsGh(() => Promise.reject(
      Object.assign(new Error('GitHub API GET /repos/owner/cached-repo/contents/.github/workflows: 500 Internal Server Error'), { status: 500 })
    ));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ hasOsvScanner: false }),
    });
    assert.equal(details['cached-repo'].hasOsvScanner, false, 'a transient unknown must not overwrite a known cached verdict');
  });

  it('re-derives a cached hasAutoMergeWorkflow live rather than serving the cached verdict', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // The stale-compliant case, and the one that motivated moving this verdict
    // off the registration listing. The cache says the auto-merge workflow is
    // present; the default branch says otherwise — an apply PR that registered
    // the workflow and was then closed unmerged, or a file since deleted. Under
    // a pushed_at cache key a deletion does bump pushed_at, but a PR closed
    // unmerged does not, so serving `true` would hide the gap indefinitely on a
    // quiet repo. The live contents listing is the only verdict.
    const gh = cachedWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ hasAutoMergeWorkflow: true }),
    });
    assert.equal(details['cached-repo'].hasAutoMergeWorkflow, false, 'the cached verdict must be re-derived from the live listing, never served');
  });

  it('keeps a known cached hasAutoMergeWorkflow when the live re-read fails for a reason other than 404', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // Same asymmetry as hasOsvScanner, with a sharper edge: dependabot-auto-merge
    // is BOTH templatable and on the apply-schedule allow-list, so what happens
    // to this field on a bad read decides whether an unattended scheduled run
    // opens a PR. An unknown live read is strictly less information than the
    // cached verdict, so the cached `true` stands rather than decaying to null.
    // The rejection is shaped exactly like github.js's (message plus numeric
    // `err.status`), because a mock richer than the real client would make
    // this test evidence of nothing.
    const gh = cachedWorkflowsGh(() => Promise.reject(
      Object.assign(new Error('GitHub API GET /repos/owner/cached-repo/contents/.github/workflows: 500 Internal Server Error'), { status: 500 })
    ));
    const details = await fetchPortfolioDetails(gh, 'owner', cachedWorkflowsRepos, {
      cache: cachedWorkflowsCache({ hasAutoMergeWorkflow: true }),
    });
    assert.equal(details['cached-repo'].hasAutoMergeWorkflow, true, 'a transient unknown must not overwrite a known cached verdict');
  });

  it('fetches fresh data when pushed_at differs', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    let apiCallCount = 0;
    const gh = {
      request: () => { apiCallCount++; return Promise.resolve({ total_count: 10, license: { spdx_id: 'MIT' }, health_percentage: 80, workflow_runs: [], files: {} }); },
      paginate: () => { apiCallCount++; return Promise.resolve([]); },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'changed-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 5, archived: false, fork: false, stars: 10 },
    ];
    const cache = {
      repos: {
        'changed-repo': {
          pushed_at: '2026-04-01T00:00:00Z', // Different!
          open_issues_count: 5,
          details: { commits: 42 },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.ok(apiCallCount > 0, 'should call API for changed repo');
    assert.ok(!details._cachedRepos.includes('changed-repo'), 'should not mark as cached');
  });

  it('invalidates cache when schemaVersion is missing or stale', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    let apiCallCount = 0;
    const gh = {
      request: () => { apiCallCount++; return Promise.resolve({ total_count: 10, license: { spdx_id: 'MIT' }, health_percentage: 80, workflow_runs: [], files: {} }); },
      paginate: () => { apiCallCount++; return Promise.resolve([]); },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'old-cache', pushed_at: '2026-04-01T00:00:00Z', open_issues: 5, archived: false, fork: false, stars: 10 },
    ];
    const cache = {
      repos: {
        'old-cache': {
          pushed_at: '2026-04-01T00:00:00Z',
          open_issues_count: 5,
          details: { commits: 42, released_at: null },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.ok(apiCallCount > 0, 'should re-fetch when schemaVersion is missing');
    assert.ok(!details._cachedRepos.includes('old-cache'), 'should not mark stale-schema entry as cached');
  });

  it('skips draft releases when picking latest released_at', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = {
      request: (path) => {
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        return Promise.resolve({ total_count: 0, license: { spdx_id: 'MIT' }, workflow_runs: [] });
      },
      paginate: (path) => {
        if (path.includes('/releases')) {
          return Promise.resolve([
            { tag_name: 'v2.8.1', draft: true, published_at: null },
            { tag_name: 'v2.8.0', draft: false, published_at: '2026-04-15T10:00:00Z' },
          ]);
        }
        return Promise.resolve([]);
      },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'has-draft', pushed_at: '2026-04-20T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['has-draft'].released_at, '2026-04-15T10:00:00Z', 'should pick first non-draft release');
  });

  it('works without cache (backward compatible)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    let apiCallCount = 0;
    const gh = {
      request: () => { apiCallCount++; return Promise.resolve({ total_count: 10, license: { spdx_id: 'MIT' }, health_percentage: 80, workflow_runs: [], files: {} }); },
      paginate: () => { apiCallCount++; return Promise.resolve([]); },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'fresh-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 2, archived: false, fork: false, stars: 3 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.ok(apiCallCount > 0, 'should call API without cache');
    assert.deepEqual(details._cachedRepos, [], 'no repos should be cached');
  });

  // Every field of a full fetch comes from its own endpoint, and each mock
  // below answers with a value no other field could produce, so wiring a
  // result to the wrong field — the failure a positional destructure invites —
  // changes this object and fails the deepEqual.
  it('maps every full-fetch result onto its own details field', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = {
      request: (path) => {
        const p = path.replace('/repos/owner/map-repo', '');
        if (p === '/automated-security-fixes') return Promise.resolve({ enabled: true, paused: true });
        if (p === '/rulesets/5') return Promise.resolve({ rules: [{ type: 'copilot_code_review' }] });
        if (p === '/contents/.github/workflows') return Promise.resolve([{ name: 'osv-scanner.yml' }]);
        if (p === '/contents') return Promise.resolve([{ name: 'CODEOWNERS' }]);
        if (p === '/actions/workflows') {
          return Promise.resolve({ total_count: 2, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }, { name: 'Lint', path: '.github/workflows/lint.yml' }] });
        }
        if (p === '/community/profile') return Promise.resolve({ health_percentage: 61, files: { issue_template: {} } });
        if (p.startsWith('/dependabot/alerts')) return Promise.resolve([{ security_vulnerability: { severity: 'high' } }]);
        if (p.startsWith('/code-scanning/alerts')) return Promise.resolve([{ rule: { security_severity_level: 'low' } }, { rule: { security_severity_level: 'medium' } }]);
        if (p.startsWith('/secret-scanning/alerts')) return Promise.resolve([{}, {}, {}]);
        if (p.startsWith('/actions/runs')) {
          return Promise.resolve({ workflow_runs: [{ conclusion: 'success' }, { conclusion: 'success' }, { conclusion: 'success' }, { conclusion: 'failure' }] });
        }
        if (p === '/dependency-graph/sbom') return Promise.resolve({ sbom: { packages: [] } });
        if (p === '/traffic/views') return Promise.resolve({ count: 9, uniques: 2 });
        if (p === '/traffic/clones') return Promise.resolve({ count: 5, uniques: 1 });
        if (p === '/stats/participation') return Promise.resolve({ owner: [3, 4] });
        if (path === '/search/commits') return Promise.resolve({ total_count: 7 });
        if (p === '') return Promise.resolve({ license: { spdx_id: 'Apache-2.0' }, allow_auto_merge: true });
        return Promise.reject(new Error(`unexpected request ${path}`));
      },
      paginate: (path) => {
        const p = path.replace('/repos/owner/map-repo', '');
        if (p === '/issues') return Promise.resolve([{ labels: [{ name: 'bug' }] }, { labels: [] }, { labels: [], pull_request: {} }]);
        if (p === '/releases') return Promise.resolve([{ draft: true, published_at: '2026-03-01T00:00:00Z' }, { draft: false, prerelease: false, published_at: '2026-02-01T00:00:00Z' }]);
        if (p === '/pulls') return Promise.resolve([{}, {}, {}, {}]);
        if (p === '/rulesets') return Promise.resolve([{ id: 5, enforcement: 'active' }]);
        return Promise.reject(new Error(`unexpected paginate ${path}`));
      },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [{ name: 'map-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 2, archived: false, fork: false, stars: 1 }];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.deepEqual(details['map-repo'], {
      commits: 7,
      weekly: [3, 4],
      license: 'Apache-2.0',
      ci: 2,
      communityHealth: 61,
      vulns: { count: 1, critical: 0, high: 1, medium: 0, low: 0, max_severity: 'high' },
      ciPassRate: 0.75,
      open_issues: 2,
      open_bugs: 1,
      open_prs: 4,
      sbom: { count: 0, packages: [] },
      released_at: '2026-02-01T00:00:00Z',
      hasIssueTemplate: true,
      hasAutoMergeWorkflow: false,
      hasReleaseWorkflow: false,
      hasOsvScanner: true,
      allowAutoMerge: true,
      hasCodeowners: true,
      hasSecurityPolicy: false,
      hasCopilotReview: true,
      autofix: { enabled: true, paused: true },
      libyear: null,
      codeScanning: { count: 2, critical: 0, high: 0, medium: 1, low: 1, max_severity: 'medium' },
      secretScanning: { count: 3 },
      traffic: { views_14d: { count: 9, uniques: 2 }, clones_14d: { count: 5, uniques: 1 } },
    });
  });

  it('derives hasAutoMergeWorkflow from the default-branch contents listing, and allowAutoMerge from repo settings', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = {
      // Order matters: the bare /repos/{owner}/{repo} path is a prefix of the
      // /actions/workflows path, so match the more-specific subpaths first.
      request: (path) => {
        if (path.includes('/contents/.github/workflows')) {
          return Promise.resolve([{ name: 'ci.yml' }, { name: 'dependabot-auto-merge.yml' }]);
        }
        // The workflows REGISTRATION listing deliberately does NOT carry the
        // auto-merge workflow here. The verdict below is `true` regardless, and
        // that is the assertion: presence comes from the file on the default
        // branch, never from what GitHub has registered. See the tri-state block
        // further down for why the listing cannot be trusted.
        if (path.includes('/actions/workflows')) {
          return Promise.resolve({ total_count: 1, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }] });
        }
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        // Bare /repos/{owner}/{repo} — matched last.
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: true });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'am-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['am-repo'].hasAutoMergeWorkflow, true);
    assert.equal(details['am-repo'].allowAutoMerge, true);
  });

  it('reports hasAutoMergeWorkflow false when the workflow is absent and allow_auto_merge off', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = {
      request: (path) => {
        if (path.includes('/contents/.github/workflows')) return Promise.resolve([{ name: 'ci.yml' }]);
        if (path.includes('/actions/workflows')) {
          return Promise.resolve({ total_count: 1, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }] });
        }
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'no-am', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['no-am'].hasAutoMergeWorkflow, false);
    assert.equal(details['no-am'].allowAutoMerge, false);
    // No workflow named or pathed "release" in this fixture either.
    assert.equal(details['no-am'].hasReleaseWorkflow, false);
  });

  it('derives hasReleaseWorkflow from a release-named workflow (name OR path match)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const makeGh = (workflows) => ({
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          return Promise.resolve({ total_count: workflows.length, workflows });
        }
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    });
    const repos = [
      { name: 'rel-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // Path match: the templated .github/workflows/release.yml.
    let details = await fetchPortfolioDetails(makeGh([{ name: 'Scheduled release', path: '.github/workflows/release.yml' }]), 'owner', repos);
    assert.equal(details['rel-repo'].hasReleaseWorkflow, true);
    // Name match: a hand-rolled publish pipeline whose PATH doesn't say release —
    // it must still count so a working pipeline never gets a redundant apply PR.
    details = await fetchPortfolioDetails(makeGh([{ name: 'Build & Release', path: '.github/workflows/build.yml' }]), 'owner', repos);
    assert.equal(details['rel-repo'].hasReleaseWorkflow, true);
  });

  it('fails hasReleaseWorkflow toward present when the workflows page is truncated', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          // 101 workflows on the repo, only one (non-release) returned on this
          // page — the release workflow may be on a later page, so the detector
          // must not report a gap from incomplete data.
          return Promise.resolve({ total_count: 101, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml' }] });
        }
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'many-wf', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['many-wf'].hasReleaseWorkflow, true);
  });

  it('fails hasReleaseWorkflow toward present when the workflows request errors', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) return Promise.reject(new Error('rate limited'));
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'err-wf', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // A transient API failure is incomplete data: the write-gating signal must
    // not manufacture a release-cadence gap (and a remediation PR) from it.
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['err-wf'].hasReleaseWorkflow, true);
  });

  it('keeps the last known ci count when the workflows request errors, rather than reporting zero', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const { REPO_CACHE_SCHEMA_VERSION } = await import('./report-shared.js');
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) return Promise.reject(new Error('rate limited'));
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'err-ci', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // A stale cache entry (pushed_at differs, so this is NOT a cache hit and the
    // full fetch runs) still holds the last count that was actually observed.
    const cache = {
      repos: {
        'err-ci': {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-01-01T00:00:00Z',
          open_issues_count: 0,
          details: { ci: 9 },
        },
      },
    };
    // ci feeds computeHealthTier's "Has CI workflows (2+)" gold check. Failing to
    // 0 demoted a healthy repo on one 500 and then filed a G7 tier-regression
    // finding about the demotion.
    const withCache = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.equal(withCache['err-ci'].ci, 9);

    // With nothing ever observed, the honest answer is unknown — not zero, which
    // is an assertion of non-compliance, and not a count, which would award gold
    // on no evidence.
    const noCache = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(noCache['err-ci'].ci, null);

    // A cache entry from a SUPERSEDED schema version must not be read either.
    // The version bump is the one mechanism that invalidates details whose
    // meaning has changed, and this value is written straight back into the
    // fresh entry under the new pushed_at — so an ungated read would launder a
    // pre-bump count into something indistinguishable from a fresh observation.
    const staleSchema = {
      repos: {
        'err-ci': {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION - 1,
          pushed_at: '2026-01-01T00:00:00Z',
          open_issues_count: 0,
          details: { ci: 9 },
        },
      },
    };
    const oldSchema = await fetchPortfolioDetails(gh, 'owner', repos, { cache: staleSchema });
    assert.equal(oldSchema['err-ci'].ci, null);
  });

  it('keeps the last known hasCopilotReview on the FULL-FETCH path, not just the cache hit', async () => {
    // The path a repo takes the moment it PUSHES. Applying the fallback only to
    // the cache-hit branch leaves this one persisting a raw null, and governance
    // drops a null repo from BOTH sides of the adoption figures — so a repo with
    // a genuine gap silently leaves the standard for the week and the dashboard
    // is indistinguishable from full adoption.
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const { REPO_CACHE_SCHEMA_VERSION } = await import('./report-shared.js');
    const gh = {
      request: (path) => {
        if (path.includes('/rulesets')) return Promise.reject(new Error('403'));
        if (path.includes('/actions/workflows')) return Promise.resolve({ total_count: 2, workflows: [] });
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      paginate: (path) => (path.includes('/rulesets') ? Promise.reject(new Error('403')) : Promise.resolve([])),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'pushed', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // pushed_at differs from the cache, so this is NOT a cache hit — the full
    // fetch runs, and the ruleset read fails.
    const cache = {
      repos: {
        pushed: {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-01-01T00:00:00Z',
          open_issues_count: 0,
          details: { hasCopilotReview: false },
        },
      },
    };
    const withCache = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.equal(withCache.pushed.hasCopilotReview, false, 'a known false must survive an unreadable live scan');

    // Nothing ever observed → honestly unknown.
    const noCache = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(noCache.pushed.hasCopilotReview, null);

    // A cache entry from a SUPERSEDED schema version must not be read. The old
    // code absorbed every unreadable scan into `false`, so a pre-bump `false`
    // may be a phantom; resolving today's honest null to it would report a
    // code-review-bot gap for a compliant repo — and it could never clear,
    // because the apply path now fail-closed-skips rather than correcting it.
    const staleSchema = {
      repos: {
        pushed: {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION - 1,
          pushed_at: '2026-01-01T00:00:00Z',
          open_issues_count: 0,
          details: { hasCopilotReview: false },
        },
      },
    };
    const oldSchema = await fetchPortfolioDetails(gh, 'owner', repos, { cache: staleSchema });
    assert.equal(oldSchema.pushed.hasCopilotReview, null);
  });

  it('re-reads a cached ci of null on a cache hit, so an unknown cannot become permanent', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const { REPO_CACHE_SCHEMA_VERSION } = await import('./report-shared.js');
    let workflowCalls = 0;
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          workflowCalls++;
          return Promise.resolve({ total_count: 6, workflows: [] });
        }
        if (path.includes('/rulesets')) return Promise.resolve([]);
        if (path.includes('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
        if (path.includes('/contents/.github/workflows')) return Promise.resolve([]);
        return Promise.resolve({});
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'quiet', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    // A genuine cache HIT (schema, pushed_at and issue count all match) whose
    // stored ci is unknown. Without the conditional re-read this null would be
    // served until the repo's next push — indefinitely on a quiet repo — so the
    // repo would score bronze and drop out of the ci-workflows denominator on
    // every run thereafter.
    const cache = {
      repos: {
        quiet: {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-04-10T00:00:00Z',
          open_issues_count: 0,
          details: { ci: null, license: 'MIT' },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.equal(details.quiet.ci, 6, 'the unknown must be refreshed, not served');
    assert.equal(workflowCalls, 1, 'and refreshed with exactly one extra call');
    // The rest of the cached entry is still served from cache.
    assert.equal(details.quiet.license, 'MIT');
  });

  it('does not spend a call re-reading a ci that is already known on a cache hit', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const { REPO_CACHE_SCHEMA_VERSION } = await import('./report-shared.js');
    let workflowCalls = 0;
    const gh = {
      request: (path) => {
        if (path.includes('/actions/workflows')) {
          workflowCalls++;
          return Promise.resolve({ total_count: 6, workflows: [] });
        }
        if (path.includes('/rulesets')) return Promise.resolve([]);
        if (path.includes('/automated-security-fixes')) return Promise.resolve({ enabled: true, paused: false });
        if (path.includes('/contents/.github/workflows')) return Promise.resolve([]);
        return Promise.resolve({});
      },
      paginate: () => Promise.resolve([]),
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'quiet', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const cache = {
      repos: {
        quiet: {
          schemaVersion: REPO_CACHE_SCHEMA_VERSION,
          pushed_at: '2026-04-10T00:00:00Z',
          open_issues_count: 0,
          details: { ci: 3, license: 'MIT' },
        },
      },
    };
    const details = await fetchPortfolioDetails(gh, 'owner', repos, { cache });
    assert.equal(details.quiet.ci, 3);
    // ci is push-invariant, so refreshing a KNOWN count would buy nothing for a
    // call per repo per run. Only the unknown is worth spending on.
    assert.equal(workflowCalls, 0);
  });

  // --- hasOsvScanner (osv-scanner standard) ---
  //
  // hasOsvScanner is TRI-STATE and comes from ONE read: GET
  // /contents/.github/workflows, the directory listing on the DEFAULT BRANCH.
  // Only `false` opens a remediation PR, so every uncertain read must land on
  // null. Fail-toward-present is specifically wrong here: this details object is
  // persisted under a pushed_at cache key, so one transient `true` would be
  // served until the repo's next push — indefinitely on a quiet repo.
  //
  // The workflows REGISTRATION listing (GET /actions/workflows) is deliberately
  // NOT consulted, which is why the mock below serves a healthy, active,
  // registered scanner by DEFAULT: no assertion here can be quietly reading it,
  // because it always says "compliant" while the verdicts vary. It lists every
  // workflow GitHub has ever registered, including from branches that never
  // merged, and the templated workflow triggers `on: pull_request` so it
  // self-registers while the apply PR introducing it is still open.
  //
  // `contentsResponse` is a thunk so a test can hand back a rejection as easily
  // as a payload; every other path keeps the benign stubs the surrounding tests
  // use. `workflowsResponse` is overridable only so two tests can prove the
  // listing is ignored.
  //
  // The registration listing as it looks on a healthy repo: complete (total_count
  // matches the page) and carrying an osv-scanner entry in the given state.
  const osvRegistered = (state = 'active') => () => Promise.resolve({
    total_count: 2,
    workflows: [
      { name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
      { name: 'OSV-Scanner', path: '.github/workflows/osv-scanner.yml', state },
    ],
  });
  const makeWorkflowsGh = (contentsResponse, workflowsResponse = osvRegistered()) => ({
    request: (path) => {
      if (path.includes('/contents/.github/workflows')) return contentsResponse();
      if (path.includes('/actions/workflows')) return workflowsResponse();
      if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
      if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
      if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
      if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
      if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
      if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
      if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
      return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
    },
    paginate: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(null),
  });
  const osvRepos = [
    { name: 'osv-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
  ];

  // A directory listing containing the templated file.
  const contentsWithScanner = () => Promise.resolve([{ name: 'ci.yml' }, { name: 'osv-scanner.yml' }]);

  it('reports hasOsvScanner true when the templated file is on the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = makeWorkflowsGh(contentsWithScanner);
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, true);
  });

  it('reports hasOsvScanner false when the scanner file is absent from the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = makeWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]));
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, false);
  });

  it('reports hasOsvScanner false when the workflows directory 404s (no workflows at all)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // A 404 on the contents listing is a genuine answer, not a failure: the repo
    // has no .github/workflows directory, so the scanner is definitively absent
    // and the standard is a real gap worth a remediation PR.
    // The error is EXACTLY what github.js throws — the code in the message and
    // as a numeric `err.status` (#438; github.test.js pins that the real client
    // sets it). A mock more capable than the real client turns a green test
    // into evidence of nothing.
    const notFound = () => Promise.reject(
      Object.assign(new Error('GitHub API GET /repos/owner/osv-repo/contents/.github/workflows: 404 Not Found'), { status: 404 })
    );
    const gh = makeWorkflowsGh(notFound);
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, false);
  });

  it('reports hasOsvScanner null when the contents read fails for any reason other than 404', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // Rate limit, 403, network blip: we do not know what is on the default
    // branch. Unknown is honest; governance skips unknowns, and `false` here
    // would open an apply PR on every repo the failure touched. The body
    // mentions ": 404" on purpose: only `err.status` may mean absence (#438).
    const serverError = () => Promise.reject(
      Object.assign(new Error('GitHub API GET /repos/owner/osv-repo/contents/.github/workflows: 500 {"message":"upstream said: 404"}'), { status: 500 })
    );
    const gh = makeWorkflowsGh(serverError);
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, null);
  });

  it('still reports hasOsvScanner true when the scanner has been auto-disabled for inactivity', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // The enabled state is deliberately NOT part of this standard, and this is
    // the case that decided it. GitHub auto-disables schedule-triggered
    // workflows after 60 days of repository inactivity, and this template IS
    // schedule-triggered — so on any quiet repo the scanner flips to
    // `disabled_inactivity` through nobody's decision. Counting that as a gap
    // routes the repo into the templated apply path, whose contents PUT sends no
    // `sha`; the file is already there, GitHub answers 422, and the same
    // unfixable finding retries on every run forever. Writing a file cannot
    // re-enable a workflow — that needs a settings executor, not this standard.
    const gh = makeWorkflowsGh(contentsWithScanner, osvRegistered('disabled_inactivity'));
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, true);
  });

  it('reports hasOsvScanner false for a workflow registered from a branch that never merged', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // The phantom / self-registration case, and the reason the listing cannot be
    // the presence signal. GitHub lists every workflow it has ever registered,
    // including from unmerged branches — and the templated workflow triggers
    // `on: pull_request`, so it registers itself while the apply PR that
    // introduces it is still open. Trusting the listing would report the repo
    // compliant before that PR merged, and permanently if it were closed unmerged.
    const gh = makeWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]), osvRegistered());
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, false);
  });

  it('does not satisfy hasOsvScanner from a file that merely mentions osv-scanner', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // Detection is an EXACT filename match, unlike the deliberately broad
    // hasReleaseWorkflow. A near-miss name and a workflow whose display name
    // mentions the scanner are both gaps: the standard is satisfied only by the
    // file the apply template writes, and a looser match would leave the
    // template unable to converge on the repo's own variant.
    const gh = makeWorkflowsGh(
      () => Promise.resolve([
        { name: 'nightly.yml' },
        { name: 'my-osv-scanner.yml' },
        { name: 'osv-scanner.yaml' },
      ]),
      () => Promise.resolve({
        total_count: 1,
        workflows: [{ name: 'Run osv-scanner nightly', path: '.github/workflows/nightly.yml', state: 'active' }],
      }),
    );
    const details = await fetchPortfolioDetails(gh, 'owner', osvRepos);
    assert.equal(details['osv-repo'].hasOsvScanner, false);
  });

  // --- hasAutoMergeWorkflow (dependabot-auto-merge standard) ---
  //
  // Same shape as hasOsvScanner, from the same single read, and for the same
  // two reasons — but the stakes are higher, so it gets its own coverage rather
  // than riding on the scanner's.
  //
  // It is TRI-STATE and comes from GET /contents/.github/workflows, the
  // directory listing on the DEFAULT BRANCH. The workflows REGISTRATION listing
  // (GET /actions/workflows) is deliberately not consulted: GitHub lists every
  // workflow it has ever registered, including from branches that never merged.
  // Verified on this repository — `release-recovery.yml` is listed `active`
  // while existing on no branch. An apply PR opened and then closed unmerged
  // therefore left the repo reading compliant forever, so its gap never
  // reappeared and no further PR was ever offered.
  //
  // And `false` is not the safe default for an unreadable read.
  // dependabot-auto-merge is both templatable and on the apply-schedule
  // allow-list, so a `false` manufactured from one transient API error opens a
  // remediation PR on an unattended scheduled run. Unknown is reported instead,
  // and governance skips unknowns. Fail-toward-present would be wrong too: this
  // details object is persisted under a pushed_at cache key, so one transient
  // `true` would be served until the repo's next push.
  //
  // The registration listing below therefore carries the auto-merge workflow,
  // active and complete, in every case except the clean-absence one: it always
  // says "compliant" while the verdicts vary, so no assertion here can be
  // quietly reading it.
  const amRegistered = () => Promise.resolve({
    total_count: 2,
    workflows: [
      { name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
      { name: 'Dependabot auto-merge', path: '.github/workflows/dependabot-auto-merge.yml', state: 'active' },
    ],
  });
  const amRepos = [
    { name: 'am-tri', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
  ];

  it('reports hasAutoMergeWorkflow true when the templated file is on the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const gh = makeWorkflowsGh(
      () => Promise.resolve([{ name: 'ci.yml' }, { name: 'dependabot-auto-merge.yml' }]),
      amRegistered,
    );
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, true);
  });

  // #463: detection must find exactly the file each template installs. The
  // listing it reads is the default branch's .github/workflows directory, by
  // filename, so a template written anywhere else could never be detected.
  for (const [key, flag] of [['osv-scanner', 'hasOsvScanner'], ['dependabot-auto-merge', 'hasAutoMergeWorkflow']]) {
    it(`detects the file the ${key} template writes, which lives directly in .github/workflows/`, async () => {
      const { TEMPLATES } = await import('./apply-templates.js');
      const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
      const { path } = TEMPLATES[key];
      const slash = path.lastIndexOf('/');
      assert.equal(path.slice(0, slash), '.github/workflows', `${key} template must write into .github/workflows/`);
      const gh = makeWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }, { name: path.slice(slash + 1) }]));
      const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
      assert.equal(details['am-tri'][flag], true);
    });
  }

  it('reports hasAutoMergeWorkflow false when the file is absent from the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // Clean absence: nothing registered, nothing on the branch. A real gap, and
    // the only verdict that may open a remediation PR.
    const gh = makeWorkflowsGh(
      () => Promise.resolve([{ name: 'ci.yml' }]),
      () => Promise.resolve({ total_count: 1, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }),
    );
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, false);
  });

  it('reports hasAutoMergeWorkflow false for a workflow REGISTERED but absent from the default branch', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // The phantom case — the regression this whole change exists to prevent.
    // The registration listing says the auto-merge workflow is there and active;
    // the default branch does not have the file. That is precisely what an apply
    // PR opened and then closed unmerged leaves behind, and reading the listing
    // reported the repo compliant from then on, permanently. The contents
    // listing is the only thing that can tell the difference.
    const gh = makeWorkflowsGh(() => Promise.resolve([{ name: 'ci.yml' }]), amRegistered);
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, false, 'a registered-but-unmerged workflow is a gap, not compliance');
  });

  it('reports hasAutoMergeWorkflow false when the workflows directory 404s (no workflows at all)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // A 404 on the contents listing is a genuine answer, not a failure: there is
    // no .github/workflows directory, so the workflow is definitively absent and
    // this is a real gap. The error is EXACTLY what github.js throws — the code
    // in the message and as a numeric `err.status`, which the `.catch` keys on.
    const gh = makeWorkflowsGh(
      () => Promise.reject(Object.assign(new Error('GitHub API GET /repos/owner/am-tri/contents/.github/workflows: 404 Not Found'), { status: 404 })),
      amRegistered,
    );
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, false);
  });

  it('reports hasAutoMergeWorkflow null when the contents read fails for any reason other than 404', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // Rate limit, 403, network blip: we do not know what is on the default
    // branch. `false` here would open an apply PR on every repo the failure
    // touched, unattended, on the apply schedule. Unknown is honest, and
    // governance excludes unknowns from both compliance arrays. The body
    // mentions ": 404" on purpose: only `err.status` may mean absence (#438).
    const gh = makeWorkflowsGh(
      () => Promise.reject(Object.assign(new Error('GitHub API GET /repos/owner/am-tri/contents/.github/workflows: 500 {"message":"upstream said: 404"}'), { status: 500 })),
      amRegistered,
    );
    const details = await fetchPortfolioDetails(gh, 'owner', amRepos);
    assert.equal(details['am-tri'].hasAutoMergeWorkflow, null);
  });

  it('surfaces hasCopilotReview through fetchPortfolioDetails (active Copilot ruleset → true)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    // The shared detection helper lists rulesets via gh.paginate and reads each
    // detail via gh.request; helper-internal cases live in github.test.js. This
    // only checks the field is threaded through onto the per-repo details object.
    const gh = {
      paginate: (path) => path.endsWith('/rulesets')
        ? Promise.resolve([{ id: 7, enforcement: 'active' }])
        : Promise.resolve([]),
      request: (path) => {
        if (path.match(/\/rulesets\/\d+$/)) return Promise.resolve({ id: 7, rules: [{ type: 'copilot_code_review' }] });
        if (path.includes('/actions/workflows')) return Promise.resolve({ total_count: 0, workflows: [] });
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      getFileContent: () => Promise.resolve(null),
    };
    const repos = [
      { name: 'cr-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 },
    ];
    const details = await fetchPortfolioDetails(gh, 'owner', repos);
    assert.equal(details['cr-repo'].hasCopilotReview, true);
  });

  it('threads the Dependabot autofix state onto details (ADR-012 Phase 3)', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const mk = (autofixResponse) => ({
      paginate: () => Promise.resolve([]),
      request: (path) => {
        if (path.endsWith('/automated-security-fixes')) return autofixResponse();
        if (path.includes('/actions/workflows')) return Promise.resolve({ total_count: 0, workflows: [] });
        if (path.includes('/community/profile')) return Promise.resolve({ health_percentage: 80, files: {} });
        if (path.includes('/dependabot/alerts')) return Promise.resolve([]);
        if (path.includes('/code-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/secret-scanning/alerts')) return Promise.resolve([]);
        if (path.includes('/actions/runs')) return Promise.resolve({ workflow_runs: [] });
        if (path.includes('/stats/participation')) return Promise.resolve({ owner: [] });
        if (path.includes('/search/commits')) return Promise.resolve({ total_count: 0 });
        if (path.match(/\/rulesets/)) return Promise.resolve({});
        return Promise.resolve({ license: { spdx_id: 'MIT' }, allow_auto_merge: false });
      },
      getFileContent: () => Promise.resolve(null),
    });
    const repos = [{ name: 'af-repo', pushed_at: '2026-04-10T00:00:00Z', open_issues: 0, archived: false, fork: false, stars: 1 }];

    const on = await fetchPortfolioDetails(mk(() => Promise.resolve({ enabled: true, paused: false })), 'owner', repos);
    assert.deepEqual(on['af-repo'].autofix, { enabled: true, paused: false });

    // Unavailable endpoint → getAutomatedSecurityFixesState returns null → details.autofix null.
    const off = await fetchPortfolioDetails(mk(() => Promise.reject(new Error('404'))), 'owner', repos);
    assert.equal(off['af-repo'].autofix, null);
  });
});

describe('fetchPortfolioDetails open_bugs (tri-state, cache miss)', () => {
  const repos = [{ name: 'fresh', pushed_at: '2026-04-01T00:00:00Z', open_issues: 7, archived: false, fork: false, stars: 1 }];
  const mkGh = (issuesResponder) => ({
    request: () => Promise.resolve({}),
    paginate: (path) => (path === '/repos/owner/fresh/issues' ? issuesResponder() : Promise.resolve([])),
    getFileContent: () => Promise.resolve(null),
  });

  it('counts actionable bugs only: excludes PRs, blocked bugs and non-bugs', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const issues = [
      { number: 1, labels: [{ name: 'bug' }] },
      { number: 2, labels: [{ name: 'Type: Bug' }, { name: 'blocked' }] },
      { number: 3, labels: [{ name: 'bug' }], pull_request: {} },
      { number: 4, labels: [{ name: 'enhancement' }] },
    ];
    const details = await fetchPortfolioDetails(mkGh(() => Promise.resolve(issues)), 'owner', repos, {});
    assert.equal(details.fresh.open_issues, 3, 'PRs are filtered out of the issue total');
    assert.equal(details.fresh.open_bugs, 1, 'blocked bugs and PRs do not count as actionable bugs');
  });

  it('reports open_bugs as null (unknown, never 0) when the issue listing fails', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio-data.js');
    const details = await fetchPortfolioDetails(mkGh(() => Promise.reject(new Error('500'))), 'owner', repos, {});
    assert.equal(details.fresh.open_bugs, null);
    assert.equal(details.fresh.open_issues, 7, 'falls back to the repo listing count');
  });
});

// GOVERNANCE needs only fetchPortfolioDetails, which is why the fetch half lives
// apart from the dashboard renderer. Follows static imports only: a dynamic
// import() is loaded on demand and does not tie the two together.
describe('report-portfolio-data module boundary', () => {
  it('governance.js does not transitively import the dashboard renderer or its styles', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      // `import ... from`, `export ... from` and side-effect `import '...'`, either
      // quote style. `[^;]` rather than a quote-free class, so a comment with an
      // apostrophe inside a multi-line import block cannot hide the edge.
      const specifiers = /^\s*(?:(?:import|export)\b[^;]*?\bfrom\s*|import\s*)(['"])(\.[^'"]+)\1/gm;
      for (const [, , spec] of src.matchAll(specifiers)) {
        walk(join(dirname(file), spec));
      }
    };
    walk('src/governance.js');
    assert.ok(seen.has('src/report-portfolio-data.js'), 'the walk reaches the data module, so it is following imports');
    assert.ok(!seen.has('src/report-styles.js'), 'report-styles.js is reachable from governance.js');
    assert.ok(!seen.has('src/report-portfolio.js'), 'report-portfolio.js is reachable from governance.js');
  });
});
