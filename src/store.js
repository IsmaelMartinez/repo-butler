// Snapshot persistence via GitHub Contents API on a data branch.
// Stores snapshots as JSON files so the ASSESS phase can diff runs.

import { createClient } from './github.js';

const DATA_BRANCH = 'repo-butler-data';
const SNAPSHOT_PATH = 'snapshots/latest.json';
const PREVIOUS_PATH = 'snapshots/previous.json';

export function createStore(context) {
  const { owner, repo, token } = context;
  const gh = createClient(token);

  async function ensureDataBranch() {
    try {
      await gh.request(`/repos/${owner}/${repo}/branches/${DATA_BRANCH}`);
    } catch {
      // Branch doesn't exist — create an orphan branch via the Git Data API.
      // Create a blob, tree, commit, then ref.
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
    // Check if file exists to get its SHA (needed for updates).
    let sha;
    try {
      const existing = await gh.request(`/repos/${owner}/${repo}/contents/${path}`, {
        params: { ref: DATA_BRANCH },
      });
      sha = existing.sha;
    } catch {
      // File doesn't exist yet — that's fine.
    }

    await gh.request(`/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      body: {
        message: `chore: update ${path}`,
        content: Buffer.from(content).toString('base64'),
        branch: DATA_BRANCH,
        ...(sha ? { sha } : {}),
      },
    });
  }

  return { readSnapshot, readPreviousSnapshot, writeSnapshot };
}
