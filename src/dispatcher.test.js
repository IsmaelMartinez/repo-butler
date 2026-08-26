// Tests for the runX wrappers that the index dispatcher uses. Each wrapper
// is verified to thread `context` through to the underlying phase function
// and to expose the expected result on `context` for downstream phases.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runUpdate } from './update.js';
import { runPropose } from './propose.js';
import { runReport } from './report.js';
import { runMonitor } from './monitor.js';
import { runAssess } from './assess.js';
import { runIdeate } from './ideate.js';
import { runObserve } from './observe.js';
import { computeSnapshotHash } from './store.js';
import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';

describe('runUpdate', () => {
  it('returns null and stores updateResult when no provider is configured', async () => {
    const ctx = { snapshot: { repository: 'a/b', roadmap: { content: '' } }, config: {} };
    const result = await runUpdate(ctx);
    assert.equal(result, null);
    assert.equal(ctx.updateResult, null);
  });
});

describe('runPropose', () => {
  it('returns null and stores proposeResult when no ideas are present', async () => {
    const ctx = { ideas: [], config: {} };
    const result = await runPropose(ctx);
    assert.equal(result, null);
    assert.equal(ctx.proposeResult, null);
  });
});

describe('runReport', () => {
  let prevDir, prevRepo;
  beforeEach(() => {
    prevDir = process.env.REPORT_OUTPUT_DIR;
    prevRepo = process.env.GITHUB_REPOSITORY;
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.REPORT_OUTPUT_DIR;
    else process.env.REPORT_OUTPUT_DIR = prevDir;
    if (prevRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = prevRepo;
  });

  it('returns cached result and stores reportResult on context when hash matches', async () => {
    // Drive report() through its cache short-circuit to avoid the heavy
    // rendering pipeline. We compute the hash report() will compute and
    // return it from store.readLastHash so it bails out with {cached:true}.
    const snapshot = { repository: 'o/r', summary: { open_issues: 0 } };
    const templateFiles = ['src/report.js', 'src/report-portfolio.js', 'src/report-repo.js', 'src/report-styles.js', 'src/report-shared.js'];
    const templateContents = await Promise.all(templateFiles.map(f => fsReadFile(f, 'utf8').catch(() => '')));
    const templateVersion = createHash('sha256').update(templateContents.join('')).digest('hex').slice(0, 12);
    const dateBucket = new Date().toISOString().slice(0, 10);
    const expectedHash = computeSnapshotHash({ ...snapshot, _dateBucket: dateBucket, _templateVersion: templateVersion });

    const ctx = {
      owner: 'o', repo: 'r', token: 't', config: {}, dryRun: true,
      snapshot,
      portfolio: null,
      forceReport: false,
      store: {
        async readLastHash() { return expectedHash; },
        async readRepoCache() { return null; },
      },
    };
    const result = await runReport(ctx);
    assert.equal(ctx.reportResult, result);
    assert.deepEqual(result, { cached: true });
  });
});

describe('runMonitor', () => {
  it('stores monitorEvents on context and skips triage when no events', async () => {
    const ctx = {
      owner: 'o', repo: 'r', token: 't', config: {},
      provider: null,
      store: {
        async readGitFile() { return null; },
        async writeGitFile() {},
      },
    };
    // Stub fetch globally so monitor's API calls resolve to empty.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: new Map([['link', '']]),
      json: async () => ([]),
      text: async () => '[]',
    });
    try {
      await runMonitor(ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(Array.isArray(ctx.monitorEvents));
    assert.equal(ctx.triageResult, undefined);
  });
});

describe('runAssess', () => {
  it('stores assessment on context and computes trends from weeklyHistory', async () => {
    const snapshot = { summary: { open_issues: 1, recently_closed: 0, recently_merged_prs: 0 }, issues: { open: [], recently_closed: [] }, pull_requests: { recently_merged: [] }, releases: [] };
    const ctx = {
      snapshot,
      previousSnapshot: null,
      provider: null,
      weeklyHistory: [
        { _week: '2026-W10', summary: { open_issues: 5, recently_merged_prs: 3 }, releases: [] },
      ],
      config: {},
    };
    const result = await runAssess(ctx);
    assert.equal(ctx.assessment, result);
    assert.ok(ctx.trends);
    assert.equal(ctx.trends.weeks.length, 1);
  });
});

describe('runIdeate', () => {
  it('returns null when provider is missing and snapshot present', async () => {
    const ctx = {
      owner: 'o', token: 't',
      portfolio: null,
      snapshot: { repository: 'o/r', summary: {} },
      assessment: null,
      provider: null,
      config: {},
      store: null,
    };
    const result = await runIdeate(ctx);
    assert.equal(result, null);
    assert.deepEqual(ctx.ideas, []);
  });

  // The council genuinely produces watchlist verdicts — including ideas the G8
  // cross-repo gate demotes from approved — and runIdeate assigned them to
  // context.watchlist, which nothing read. saveWatchlist was the only writer of
  // snapshots/watchlist.json and had no caller, so the MCP get_watchlist tool
  // reported "council has not placed any items on watch" about a file that
  // could never be written.
  const ideaResponse = [
    '---IDEA---',
    'TITLE: Watch me',
    'PRIORITY: medium',
    'LABELS: enhancement',
    'RATIONALE: A portfolio statistic says so.',
    'CURRENT_STATE: Absent.',
    'PROPOSED_STATE: Present.',
    'AFFECTED_FILES: src/x.js',
    'SCOPE: Narrow.',
    'BODY: Some body text.',
    '---END---',
  ].join('\n');

  const watchVerdict = [
    '---VERDICT---',
    'ITEM: 1',
    'VERDICT: watch',
    'CONFIDENCE: medium',
    'PRIORITY: medium',
    'SUMMARY: Needs more data.',
    'ACTION: none',
    '---END---',
  ].join('\n');

  // One provider serving both calls: ideation asks for ---IDEA--- blocks, the
  // council asks for ---VERDICT--- blocks, so branch on the prompt.
  const provider = { generate: async (prompt) => (/VERDICT/.test(prompt) ? watchVerdict : ideaResponse) };

  const ideateContext = (store) => ({
    owner: 'o', token: 't', repo: 'r',
    portfolio: null,
    snapshot: {
      repository: 'o/r',
      issues: { open: [] },
      summary: {
        open_issues: 1, blocked_issues: 0, awaiting_feedback: 0,
        recently_merged_prs: 0, latest_release: 'v1.0.0',
        high_reaction_issues: [], stale_awaiting_feedback: [], top_open_labels: [],
      },
    },
    assessment: null,
    provider,
    config: {},
    governanceFindings: [],
    store,
  });

  // A store whose watchlist read behaves however the test needs it to.
  const watchStore = (checked) => {
    const written = {};
    return {
      written,
      async readJSONChecked() { return checked; },
      async writeJSON(path, data) { written[path] = data; },
    };
  };

  it('persists council watchlist items so get_watchlist can report them', async () => {
    const store = watchStore({ data: null, readable: true, reason: 'absent' });
    const ctx = ideateContext(store);
    await runIdeate(ctx);

    assert.equal(ctx.watchlist.length, 1, 'council should have watchlisted the idea');
    const saved = store.written['snapshots/watchlist.json'];
    assert.ok(saved, 'watchlist must reach the data branch');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].title, 'Watch me');
    // The fields get_watchlist reads.
    assert.ok(saved[0].added_at, 'mergeWatchlist stamps added_at');
    assert.equal(saved[0].review_count, 0);
    assert.equal(saved[0].council_summary, 'Needs more data.');
    assert.equal(saved[0].type, 'proposal');
    assert.equal(saved[0].severity, 'medium');
    // The unvalidated LLM body must not reach the world-readable branch.
    assert.ok(!('body' in saved[0]), 'the issue body must not persist');
  });

  it('merges into the existing watchlist rather than overwriting it', async () => {
    const store = watchStore({
      data: [{ title: 'Older item', added_at: '2026-01-01T00:00:00Z', review_count: 3 }],
      readable: true,
    });
    await runIdeate(ideateContext(store));

    const saved = store.written['snapshots/watchlist.json'];
    assert.equal(saved.length, 2, 'the existing entry must survive');
    assert.equal(saved[0].title, 'Older item');
    assert.equal(saved[0].review_count, 3, 'an existing entry is not re-stamped');
    assert.equal(saved[1].title, 'Watch me');
  });

  // The defect this guards: saveWatchlist replaces the file wholesale, and a
  // failed read used to be indistinguishable from an empty one — so one
  // rate-limited or oversized read replaced every accumulated item with the
  // one item this run produced, and logged it as a cheerful "1 total".
  it('refuses to write when the existing watchlist could not be read', async () => {
    const store = watchStore({ data: null, readable: false, reason: 'unreadable' });
    await runIdeate(ideateContext(store));
    assert.equal(
      store.written['snapshots/watchlist.json'],
      undefined,
      'an unreadable list must never be overwritten',
    );
  });

  it('does not rewrite the file when the merge adds nothing', async () => {
    const store = watchStore({
      data: [{ title: 'Watch me', targetRepo: null, added_at: '2026-01-01T00:00:00Z' }],
      readable: true,
    });
    await runIdeate(ideateContext(store));
    assert.equal(
      store.written['snapshots/watchlist.json'],
      undefined,
      'an unchanged list is pure churn on the data branch',
    );
  });

  // The data branch is world-readable and these entries are raw LLM output.
  // Nothing downstream validates them — validateIdeas runs in propose() over
  // the APPROVED set, which is precisely the set a watchlisted idea is not in.
  it('drops watchlist items whose LLM content fails the safety validators', async () => {
    const unsafe = ideaResponse.replace('BODY: Some body text.', 'BODY: Ping @someone about this.');
    const store = watchStore({ data: null, readable: true, reason: 'absent' });
    const ctx = {
      ...ideateContext(store),
      provider: { generate: async (p) => (/VERDICT/.test(p) ? watchVerdict : unsafe) },
    };
    await runIdeate(ctx);

    assert.equal(ctx.watchlist.length, 1, 'the council still watchlisted it');
    assert.equal(
      store.written['snapshots/watchlist.json'],
      undefined,
      'unvalidated LLM output must not reach the world-readable data branch',
    );
  });

  // Bookkeeping must never fail a phase that already paid for the LLM calls.
  it('does not fail the phase when the watchlist store throws', async () => {
    const store = {
      async readJSONChecked() { throw new Error('data branch unavailable'); },
      async writeJSON() {},
    };
    const ctx = ideateContext(store);
    await runIdeate(ctx);
    assert.equal(ctx.ideas.length, 0, 'the council watchlisted the only idea');
  });

  it('does not throw when no store is configured', async () => {
    const ctx = ideateContext(null);
    await runIdeate(ctx);
    assert.equal(ctx.watchlist.length, 1);
  });
});

describe('runObserve', () => {
  it('persists snapshot and loads weekly history', async () => {
    const snapshot = { repository: 'o/r', summary: { open_issues: 0 } };
    const writes = [];
    const ctx = {
      owner: 'o', repo: 'r', token: 't',
      config: { observe: {}, roadmap: {} },
      store: {
        async readSnapshot() { return null; },
        async writeSnapshot(s) { writes.push(s); },
        async readWeeklyHistory() { return [{ _week: '2026-W17' }]; },
      },
    };
    // Stub fetch to make observe + observePortfolio return quickly.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      // Repo-meta endpoints return minimal data.
      if (u.endsWith('/repos/o/r')) {
        return { ok: true, status: 200, headers: new Map(), json: async () => ({ owner: { login: 'o' }, name: 'r', full_name: 'o/r', default_branch: 'main', archived: false, fork: false, language: null, stargazers_count: 0, forks_count: 0, open_issues_count: 0, license: null, has_issues: true, topics: [], description: null, pushed_at: new Date().toISOString(), private: false, visibility: 'public' }) };
      }
      // 404 for missing files like ROADMAP.md, package.json.
      if (u.includes('/contents/')) {
        return { ok: false, status: 404, headers: new Map(), json: async () => ({}), text: async () => '' };
      }
      // Default: return empty list with no Link header.
      return { ok: true, status: 200, headers: new Map([['link', '']]), json: async () => ([]), text: async () => '[]' };
    };
    try {
      const result = await runObserve(ctx);
      assert.ok(result.snapshot);
      assert.equal(ctx.snapshot, result.snapshot);
      assert.equal(writes.length, 1, 'snapshot should be written exactly once');
      assert.equal(ctx.weeklyHistory.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
