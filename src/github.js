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

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }

    return res.json();
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

  // Fetch file content from a repo (base64-decoded).
  async function getFileContent(owner, repo, filePath) {
    try {
      const data = await request(`/repos/${owner}/${repo}/contents/${filePath}`);
      if (data.content) {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
      return null;
    } catch {
      return null;
    }
  }

  // List directory contents.
  async function listDir(owner, repo, dirPath) {
    try {
      const data = await request(`/repos/${owner}/${repo}/contents/${dirPath}`);
      return Array.isArray(data) ? data.map(f => f.name) : [];
    } catch {
      return [];
    }
  }

  return { request, paginate, getFileContent, listDir };
}
