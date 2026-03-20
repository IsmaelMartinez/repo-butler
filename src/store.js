// Snapshot persistence via GitHub Contents API on a data branch.
// Stores snapshots as JSON files so the ASSESS phase can diff runs.

import { createClient } from './github.js';

const DATA_BRANCH = 'repo-butler-data';
const SNAPSHOT_PATH = 'snapshots/latest.json';
const PREVIOUS_PATH = 'snapshots/previous.json';
const WEEKLY_DIR = 'snapshots/weekly';
const MAX_WEEKLY_SNAPSHOTS = 12;

export function createStore(context) {
  const { owner, repo, token } = context;
  const gh = createClient(token);

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

    // Prune old weekly snapshots beyond MAX_WEEKLY_SNAPSHOTS.
    await pruneWeeklySnapshots();
  }

  async function readFile(path) {
    try {
      const data = await gh.request(`/repos/${owner}/${repo}/contents/${path}`, {
        params: { ref: DATA_BRANCH },
      });
      if (data.content) {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
      return null;
    } catch {
      return null;
    }
  }

  async function writeFile(path, content) {
    // Retry once on 409 conflict (concurrent writes from overlapping runs).
    for (let attempt = 0; attempt < 2; attempt++) {
      let sha;
      try {
        const existing = await gh.request(`/repos/${owner}/${repo}/contents/${path}`, {
          params: { ref: DATA_BRANCH },
        });
        sha = existing.sha;
      } catch {
        // File doesn't exist yet — that's fine.
      }

      try {
        await gh.request(`/repos/${owner}/${repo}/contents/${path}`, {
          method: 'PUT',
          body: {
            message: `chore: update ${path}`,
            content: Buffer.from(content).toString('base64'),
            branch: DATA_BRANCH,
            ...(sha ? { sha } : {}),
          },
        });
        return;
      } catch (err) {
        if (attempt === 0 && err.message?.includes('409')) continue;
        throw err;
      }
    }
  }

  async function readWeeklyHistory(weeks = MAX_WEEKLY_SNAPSHOTS) {
    const files = await gh.listDir(owner, repo, WEEKLY_DIR);
    // Filter to .json files and sort chronologically.
    const jsonFiles = files
      .filter(f => f.endsWith('.json'))
      .sort();

    // Take the most recent N weeks.
    const selected = jsonFiles.slice(-weeks);

    const snapshots = [];
    for (const file of selected) {
      const content = await readFile(`${WEEKLY_DIR}/${file}`);
      if (content) {
        try {
          const parsed = JSON.parse(content);
          parsed._week = file.replace('.json', '');
          snapshots.push(parsed);
        } catch {
          // Skip malformed files.
        }
      }
    }
    return snapshots;
  }

  async function pruneWeeklySnapshots() {
    const files = await gh.listDir(owner, repo, WEEKLY_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

    if (jsonFiles.length <= MAX_WEEKLY_SNAPSHOTS) return;

    const toDelete = jsonFiles.slice(0, jsonFiles.length - MAX_WEEKLY_SNAPSHOTS);
    for (const file of toDelete) {
      try {
        const existing = await gh.request(`/repos/${owner}/${repo}/contents/${WEEKLY_DIR}/${file}`, {
          params: { ref: DATA_BRANCH },
        });
        await gh.request(`/repos/${owner}/${repo}/contents/${WEEKLY_DIR}/${file}`, {
          method: 'DELETE',
          body: {
            message: `chore: prune old weekly snapshot ${file}`,
            sha: existing.sha,
            branch: DATA_BRANCH,
          },
        });
      } catch {
        // Ignore errors during pruning — not critical.
      }
    }
  }

  return { readSnapshot, readPreviousSnapshot, writeSnapshot, readWeeklyHistory };
}

// Return ISO week key as YYYY-WNN (e.g. "2026-W12").
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1, Sun=7).
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
