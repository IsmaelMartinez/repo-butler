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
      triageBot: null,
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

  it('captures triage bot trends when available and validation passes', async () => {
    const ctx = {
      snapshot: { summary: { open_issues: 0, recently_closed: 0, recently_merged_prs: 0 }, issues: { open: [], recently_closed: [] }, pull_requests: { recently_merged: [] }, releases: [] },
      previousSnapshot: null,
      provider: null,
      weeklyHistory: [],
      config: {},
      triageBot: {
        async fetchTrends() {
          return { schema_version: 1, generated_at: new Date().toISOString(), repos: [], top_themes: [] };
        },
      },
    };
    await runAssess(ctx);
    assert.ok(ctx.triageBotTrends);
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
});

describe('runObserve', () => {
  it('persists snapshot, loads weekly history, and ingests into triage bot', async () => {
    const snapshot = { repository: 'o/r', summary: { open_issues: 0 } };
    const writes = [];
    const ingested = [];
    const ctx = {
      owner: 'o', repo: 'r', token: 't',
      config: { observe: {}, roadmap: {} },
      store: {
        async readSnapshot() { return null; },
        async writeSnapshot(s) { writes.push(s); },
        async readWeeklyHistory() { return [{ _week: '2026-W17' }]; },
      },
      triageBot: {
        async ingestEvents(s) { ingested.push(s); },
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
      assert.equal(ingested.length, 1, 'triage bot should receive the snapshot');
      assert.equal(ctx.weeklyHistory.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
