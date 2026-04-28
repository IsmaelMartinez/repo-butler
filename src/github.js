// Thin wrapper around the GitHub REST API using native fetch.
// Zero dependencies — uses Node 22's built-in fetch.

const API_BASE = 'https://api.github.com';

export function createClient(token) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function request(path, { method = 'GET', body, params } = {}) {
    const url = new URL(`${API_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle rate limiting (429) and distinguish from permission errors (403).
      if (res.status === 429 || res.status === 403) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        const retryAfter = res.headers.get('retry-after');
        const resetTime = res.headers.get('x-ratelimit-reset');

        // 403: check headers to distinguish permission errors from rate limits.
        // GitHub returns rate-limit headers on ALL responses (even 403 permission
        // errors), so we can't rely on header absence. Instead, check if
        // x-ratelimit-remaining is '0' (actual rate limit) or if retry-after
        // is present (secondary rate limit). Anything else is a permission error.
        if (res.status === 403) {
          const isRateLimit = remaining === '0' || retryAfter;
          if (!isRateLimit) {
            const text = await res.text();
            throw new Error(`GitHub API ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
          }
        }

        let waitMs;
        if (retryAfter) {
          waitMs = parseInt(retryAfter, 10) * 1000;
        } else if (resetTime) {
          waitMs = Math.max(0, parseInt(resetTime, 10) * 1000 - Date.now()) + 1000;
        } else {
          waitMs = (attempt + 1) * 10000;
        }
        const waitSec = Math.min(Math.ceil(waitMs / 1000), 120);
        console.log(`Rate limited on ${path}, waiting ${waitSec}s (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
      }

      return res.json();
    }

    throw new Error(`GitHub API ${method} ${path}: rate limited after 3 retries`);
  }

  async function paginate(path, { params = {}, max = 500 } = {}) {
    const results = [];
    let page = 1;
    const perPage = 100;

    while (results.length < max) {
      const data = await request(path, {
        params: { ...params, per_page: perPage, page },
      });

      if (!Array.isArray(data) || data.length === 0) break;
      results.push(...data);
      if (data.length < perPage) break;
      page++;
    }

    return results.slice(0, max);
  }

  // Fetch file content from a repo (base64-decoded). Pass { ref } to read
  // from a non-default branch/tag/commit.
  async function getFileContent(owner, repo, filePath, { ref } = {}) {
    try {
      const opts = ref ? { params: { ref } } : undefined;
      const data = await request(`/repos/${owner}/${repo}/contents/${filePath}`, opts);
      if (data.content) {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
      return null;
    } catch {
      return null;
    }
  }

  // List directory contents. Pass { ref } to list on a non-default branch.
  async function listDir(owner, repo, dirPath, { ref } = {}) {
    try {
      const opts = ref ? { params: { ref } } : undefined;
      const data = await request(`/repos/${owner}/${repo}/contents/${dirPath}`, opts);
      return Array.isArray(data) ? data.map(f => f.name) : [];
    } catch {
      return [];
    }
  }

  // Create or update a file via the Contents API. Auto-discovers the existing
  // sha (on the target branch) when not supplied. Retries once on 409 conflict
  // — typical when overlapping runs race on the same path.
  async function putFile(owner, repo, filePath, content, { branch, message, sha } = {}) {
    const apiPath = `/repos/${owner}/${repo}/contents/${filePath}`;
    const encoded = Buffer.from(content).toString('base64');

    for (let attempt = 0; attempt < 2; attempt++) {
      let resolvedSha = sha;
      if (resolvedSha === undefined) {
        try {
          const existing = await request(apiPath, branch ? { params: { ref: branch } } : undefined);
          resolvedSha = existing.sha;
        } catch {
          // File doesn't exist — first write.
          resolvedSha = undefined;
        }
      }

      try {
        await request(apiPath, {
          method: 'PUT',
          body: {
            message: message ?? `chore: update ${filePath}`,
            content: encoded,
            ...(branch ? { branch } : {}),
            ...(resolvedSha ? { sha: resolvedSha } : {}),
          },
        });
        return;
      } catch (err) {
        // On 409 conflict, retry once with a fresh sha lookup. If the caller
        // passed an explicit sha, the retry must also re-discover (a stale
        // explicit sha is exactly the conflict case worth retrying).
        if (attempt === 0 && err.message?.includes('409')) {
          sha = undefined;
          continue;
        }
        throw err;
      }
    }
  }

  // Delete a file via the Contents API. Looks up the sha first.
  async function deleteFile(owner, repo, filePath, { branch, message } = {}) {
    const apiPath = `/repos/${owner}/${repo}/contents/${filePath}`;
    const existing = await request(apiPath, branch ? { params: { ref: branch } } : undefined);
    await request(apiPath, {
      method: 'DELETE',
      body: {
        message: message ?? `chore: delete ${filePath}`,
        sha: existing.sha,
        ...(branch ? { branch } : {}),
      },
    });
  }

  return { request, paginate, getFileContent, listDir, putFile, deleteFile };
}
