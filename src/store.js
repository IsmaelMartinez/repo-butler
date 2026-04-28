// Snapshot persistence via GitHub Contents API on a data branch.
// Stores snapshots as JSON files so the ASSESS phase can diff runs.

import { createClient } from './github.js';
import { createHash } from 'node:crypto';
import { computeHealthTier, isReleaseExempt } from './report-shared.js';

const HASH_PATH = 'snapshots/hash.txt';
const GOVERNANCE_PATH = 'snapshots/governance.json';
const REPO_CACHE_PATH = 'snapshots/repo-cache.json';

export function computeSnapshotHash(snapshot) {
  const summary = snapshot?.summary ?? null;
  const dateBucket = snapshot?._dateBucket ?? '';
  const templateVersion = snapshot?._templateVersion ?? '';
  const data = JSON.stringify(summary) + dateBucket + templateVersion;
  return createHash('sha256').update(data).digest('hex');
}

const DATA_BRANCH = 'repo-butler-data';
const SNAPSHOT_PATH = 'snapshots/latest.json';
const PREVIOUS_PATH = 'snapshots/previous.json';
const WEEKLY_DIR = 'snapshots/weekly';
const PORTFOLIO_WEEKLY_DIR = 'snapshots/portfolio-weekly';
const MAX_WEEKLY_SNAPSHOTS = 12;

export function enrichPortfolioSummary(summary, repoName, config) {
  const { tier, checks } = computeHealthTier(summary, { releaseExempt: isReleaseExempt(repoName, config) });
  const nextTier = tier === 'none' ? 'bronze' : tier === 'bronze' ? 'silver' : tier === 'silver' ? 'gold' : null;
  const firstFail = nextTier
    ? checks.find(c => !c.passed && (c.required_for === nextTier || (nextTier === 'gold' && c.required_for === 'silver')))
    : null;
  return {
    ...summary,
    computed: {
      tier,
      checks: checks.map(c => ({ name: c.name, passed: c.passed, required_for: c.required_for })),
      next_step: firstFail ? firstFail.name : null,
    },
  };
}

export function buildPortfolioSnapshot(repos, repoDetails, config) {
  const summaries = {};
  for (const r of repos) {
    if (r.archived || r.fork) continue;
    const details = repoDetails[r.name];
    const raw = {
      open_issues: details?.open_issues ?? r.open_issues ?? 0,
      open_bugs: details?.open_bugs ?? null,
      commits_6mo: details?.commits || 0,
      stars: r.stars || 0,
      license: details?.license ?? null,
      communityHealth: details?.communityHealth ?? null,
      ciPassRate: details?.ciPassRate ?? null,
      vulns: details?.vulns ?? null,
      codeScanning: details?.codeScanning ?? null,
      secretScanning: details?.secretScanning ?? null,
      ci: details?.ci ?? 0,
      released_at: details?.released_at ?? null,
      pushed_at: r.pushed_at ?? null,
      traffic: details?.traffic ?? null,
    };
    summaries[r.name] = enrichPortfolioSummary(raw, r.name, config);
  }
  return { schema_version: 'v1', repos: summaries };
}

export function createStore(context) {
  const { owner, repo, token } = context;
  // `context.gh` is an injection seam for tests; production callers omit it.
  const gh = context.gh ?? createClient(token);

  async function ensureDataBranch() {
    try {
      await gh.request(`/repos/${owner}/${repo}/branches/${DATA_BRANCH}`);
    } catch {
      // Branch doesn't exist — create an orphan branch via the Git Data API.
      try {
        const blob = await gh.request(`/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          body: { content: '{}', encoding: 'utf-8' },
        });
        const tree = await gh.request(`/repos/${owner}/${repo}/git/trees`, {
          method: 'POST',
          body: { tree: [{ path: 'init.json', mode: '100644', type: 'blob', sha: blob.sha }] },
        });
        const commit = await gh.request(`/repos/${owner}/${repo}/git/commits`, {
          method: 'POST',
          body: { message: 'chore: initialise repo-butler data branch', tree: tree.sha, parents: [] },
        });
        await gh.request(`/repos/${owner}/${repo}/git/refs`, {
          method: 'POST',
          body: { ref: `refs/heads/${DATA_BRANCH}`, sha: commit.sha },
        });
        console.log(`Created data branch: ${DATA_BRANCH}`);
      } catch (err) {
        // Branch may have been created by a concurrent run — check again.
        try {
          await gh.request(`/repos/${owner}/${repo}/branches/${DATA_BRANCH}`);
        } catch {
          throw err;
        }
      }
    }
  }

  async function readSnapshot() {
    try {
      const content = await readFile(SNAPSHOT_PATH);
      return content ? JSON.parse(content) : null;
    } catch {
      return null;
    }
  }

  async function readPreviousSnapshot() {
    try {
      const content = await readFile(PREVIOUS_PATH);
      return content ? JSON.parse(content) : null;
    } catch {
      return null;
    }
  }

  async function writeSnapshot(snapshot) {
    await ensureDataBranch();

    // Move current latest to previous.
    const currentLatest = await readFile(SNAPSHOT_PATH);
    if (currentLatest) {
      await writeFile(PREVIOUS_PATH, currentLatest);
    }

    // Write new snapshot as latest.
    await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(`Snapshot saved to ${DATA_BRANCH}:${SNAPSHOT_PATH}`);

    // Write/overwrite the current week's weekly snapshot.
    const weekKey = isoWeekKey(new Date());
    await writeFile(`${WEEKLY_DIR}/${weekKey}.json`, JSON.stringify(snapshot, null, 2));
    console.log(`Weekly snapshot saved as ${weekKey}`);

    await pruneDir(WEEKLY_DIR, MAX_WEEKLY_SNAPSHOTS, 'prune old weekly snapshot');
  }

  // Thin DATA_BRANCH-bound wrappers around the github client helpers. Kept
  // because every store call targets the same branch — inlining the option
  // bag at every site would just be noise.
  const readFile = (path) => gh.getFileContent(owner, repo, path, { ref: DATA_BRANCH });
  const writeFile = (path, content) => gh.putFile(owner, repo, path, content, {
    branch: DATA_BRANCH,
    message: `chore: update ${path}`,
  });
  const listBranchDir = (dirPath) => gh.listDir(owner, repo, dirPath, { ref: DATA_BRANCH });

  async function readWeeklyHistory(weeks = MAX_WEEKLY_SNAPSHOTS) {
    const files = await listBranchDir(WEEKLY_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
    const selected = jsonFiles.slice(-weeks);

    const results = await Promise.all(
      selected.map(async (file) => {
        const content = await readFile(`${WEEKLY_DIR}/${file}`);
        if (!content) return null;
        try {
          const parsed = JSON.parse(content);
          parsed._week = file.replace('.json', '');
          return parsed;
        } catch {
          return null;
        }
      })
    );
    return results.filter(Boolean);
  }

  // Trim a snapshot directory down to the most-recent `max` JSON files.
  // Sorted lexicographically (filenames are ISO week keys / ISO dates), so
  // slicing off the head removes the oldest. Pruning is best-effort: any
  // delete failure is swallowed so it never blocks the calling write.
  async function pruneDir(dirPath, max, messagePrefix) {
    const files = await listBranchDir(dirPath);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
    if (jsonFiles.length <= max) return;

    const toDelete = jsonFiles.slice(0, jsonFiles.length - max);
    // Sequential — concurrent deletes on the same branch race for the ref
    // update and produce 409 conflicts; deleteFile doesn't retry, so we'd
    // silently fail to prune. Sequential is slow but reliable.
    for (const file of toDelete) {
      try {
        await gh.deleteFile(owner, repo, `${dirPath}/${file}`, {
          branch: DATA_BRANCH,
          message: `chore: ${messagePrefix} ${file}`,
        });
      } catch {
        // pruning is best-effort
      }
    }
  }

  // Store lightweight weekly summaries for each portfolio repo.
  async function writePortfolioWeekly(portfolio, repoDetails, config = {}) {
    if (!portfolio?.repos || !repoDetails) return;

    const weekKey = isoWeekKey(new Date());
    const snapshot = buildPortfolioSnapshot(portfolio.repos, repoDetails, config);

    const path = `${PORTFOLIO_WEEKLY_DIR}/${weekKey}.json`;
    await writeFile(path, JSON.stringify(snapshot, null, 2));
    console.log(`Portfolio weekly snapshot saved as ${weekKey} (${Object.keys(snapshot.repos).length} repos)`);

    await pruneDir(PORTFOLIO_WEEKLY_DIR, MAX_WEEKLY_SNAPSHOTS, 'prune old portfolio snapshot');
  }

  // Read weekly history for a specific repo from portfolio snapshots.
  async function readRepoWeeklyHistory(repoName, weeks = MAX_WEEKLY_SNAPSHOTS) {
    const files = await listBranchDir(PORTFOLIO_WEEKLY_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
    const selected = jsonFiles.slice(-weeks);

    const results = await Promise.all(
      selected.map(async (file) => {
        const content = await readFile(`${PORTFOLIO_WEEKLY_DIR}/${file}`);
        if (!content) return null;
        try {
          const parsed = JSON.parse(content);
          // Support both v1 envelope ({ schema_version, repos }) and legacy flat format.
          const repoData = parsed.repos?.[repoName] ?? parsed[repoName];
          if (!repoData) return null;
          return {
            _week: file.replace('.json', ''),
            // PR data not available in portfolio snapshots — only open issues tracked.
            summary: { open_issues: repoData.open_issues },
          };
        } catch {
          return null;
        }
      })
    );
    return results.filter(Boolean);
  }

  async function readLastHash() {
    const content = await readFile(HASH_PATH);
    return content ? content.trim() : null;
  }

  async function writeHash(hash) {
    await ensureDataBranch();
    await writeFile(HASH_PATH, hash);
  }

  async function writeGovernanceFindings(findings) {
    if (!findings || findings.length === 0) return;
    await ensureDataBranch();
    await writeFile(GOVERNANCE_PATH, JSON.stringify(findings, null, 2));
    console.log(`Governance findings saved (${findings.length} findings).`);
  }

  async function readGovernanceFindings() {
    try {
      const content = await readFile(GOVERNANCE_PATH);
      return content ? JSON.parse(content) : null;
    } catch {
      return null;
    }
  }

  async function readRepoCache() {
    try {
      const content = await readFile(REPO_CACHE_PATH);
      return content ? JSON.parse(content) : null;
    } catch {
      return null;
    }
  }

  async function writeRepoCache(cache) {
    await ensureDataBranch();
    await writeFile(REPO_CACHE_PATH, JSON.stringify(cache));
  }

  // Generic JSON helpers for callers that own their own paths (monitor cursor,
  // council watchlist). Returns null on any read failure so callers can treat
  // a missing file as "first run".
  async function readJSON(path) {
    const content = await readFile(path);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async function writeJSON(path, value) {
    await ensureDataBranch();
    await writeFile(path, JSON.stringify(value, null, 2));
  }

  return {
    readSnapshot, readPreviousSnapshot, writeSnapshot,
    readWeeklyHistory, writePortfolioWeekly, readRepoWeeklyHistory,
    readLastHash, writeHash,
    writeGovernanceFindings, readGovernanceFindings,
    readRepoCache, writeRepoCache,
    readJSON, writeJSON,
  };
}

// Return ISO week key as YYYY-WNN (e.g. "2026-W12").
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
