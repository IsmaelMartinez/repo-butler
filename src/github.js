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
        } catch (err) {
          if (err.message?.includes(': 404')) {
            // File doesn't exist — first write.
            resolvedSha = undefined;
          } else {
            throw err;
          }
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
        if (attempt === 0 && err.message?.includes(': 409')) {
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

  // Merge a PR via the REST merge endpoint (ADR-007 stage 5). Defaults to a
  // squash merge so a revert is a single clean commit. Pass `sha` to guard
  // against a head that advanced since CI was checked — GitHub 409s if it moved,
  // which is the safe outcome (the auto-merge run skips and retries next pass).
  // Returns { merged, sha }.
  async function mergePR(owner, repo, number, { method = 'squash', sha } = {}) {
    const body = { merge_method: method };
    if (sha) body.sha = sha;
    const res = await request(`/repos/${owner}/${repo}/pulls/${number}/merge`, { method: 'PUT', body });
    return { merged: res?.merged === true, sha: res?.sha };
  }

  // True only when the commit's CI is fully, verifiably green (ADR-007 stage 5
  // auto-merge precondition). Conservative by construction: any check-run that is
  // not completed-success (neutral/skipped tolerated as non-blocking), any failed
  // or pending combined status, or NO CI signal at all → false. Reads both the
  // check-runs API (GitHub Actions) and the combined commit status (legacy
  // statuses / external bots). Returns false on any error.
  async function prCiGreen(owner, repo, ref) {
    const OK = new Set(['success', 'neutral', 'skipped']);
    try {
      // Fetch ALL check-runs. The endpoint returns an object
      // `{ total_count, check_runs }` (not a top-level array), so `paginate()`
      // can't be used — page manually until `total_count` is collected. A single
      // `per_page: 100` call would miss a failing or pending run beyond the first
      // page on a repo with many checks (matrix builds), letting a not-green PR
      // auto-merge. The page cap (10 → 1000 runs) is a runaway backstop.
      const runs = [];
      for (let page = 1; page <= 10; page++) {
        const cr = await request(`/repos/${owner}/${repo}/commits/${ref}/check-runs`, { params: { per_page: 100, page } });
        const batch = Array.isArray(cr?.check_runs) ? cr.check_runs : [];
        runs.push(...batch);
        const total = Number(cr?.total_count) || 0;
        if (batch.length === 0 || runs.length >= total) break;
      }
      // No `.catch` here: if the combined-status read fails, let it propagate to
      // the outer catch so the function returns false (fail-closed). Swallowing it
      // would let a green check-runs result merge a PR whose statuses are unknown.
      const st = await request(`/repos/${owner}/${repo}/commits/${ref}/status`);
      const statuses = Array.isArray(st?.statuses) ? st.statuses : [];

      // Missing → not green: never auto-merge a head with no CI signal at all.
      if (runs.length === 0 && statuses.length === 0) return false;

      // Every check-run must be completed-success (neutral/skipped tolerated).
      for (const r of runs) {
        if (r.status !== 'completed' || !OK.has(r.conclusion)) return false;
      }
      // When commit statuses exist, the rolled-up state must be success
      // (failure/error/pending → not green).
      if (statuses.length > 0 && st.state !== 'success') return false;

      return true;
    } catch {
      return false;
    }
  }

  return { request, paginate, getFileContent, listDir, putFile, deleteFile, mergePR, prCiGreen };
}

// True if the repo has an ACTIVE repository ruleset carrying a `copilot_code_review`
// rule (GitHub Copilot automatic code review). The rulesets list omits rule
// bodies, so each active ruleset's detail is fetched and scanned for the rule;
// the list is paginated so a repo with many rulesets cannot hide the match.
// Returns false on any error (no rulesets, or the token lacks the scope) and on a
// single ruleset's detail failing — a later active ruleset may still carry the
// rule. Single source of truth shared by the code-review-bot governance detection
// (report-portfolio.js) and the settings-apply idempotency guard (apply.js), so
// both agree on what "Copilot review already enabled" means. Detects repo-level
// rulesets only (org-inherited rulesets are not surfaced).
export async function hasActiveCopilotReviewRuleset(gh, owner, repo) {
  try {
    const rulesets = await gh.paginate(`/repos/${owner}/${repo}/rulesets`, { max: 200 });
    if (!Array.isArray(rulesets)) return false;
    for (const rs of rulesets) {
      if (rs.enforcement !== 'active') continue;
      try {
        const detail = await gh.request(`/repos/${owner}/${repo}/rulesets/${rs.id}`);
        if (detail && Array.isArray(detail.rules) && detail.rules.some(rule => rule.type === 'copilot_code_review')) {
          return true;
        }
      } catch {
        // A single ruleset's detail failing (transient/permissions) must not
        // abort the scan — a later active ruleset may still carry the rule.
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Paginate /repos/{owner}/{repo}/issues and filter out PRs (which the GitHub
// issues endpoint includes). Single source of truth for the "real issues only"
// pattern used by observe, propose, and report fetchers.
//
// `params` is forwarded to gh.paginate (e.g. { state: 'open', since, sort }).
// `max` caps the number of items fetched (default 200).
export async function paginateIssues(gh, owner, repo, { params = {}, max = 200 } = {}) {
  const items = await gh.paginate(`/repos/${owner}/${repo}/issues`, { params, max });
  return items.filter(i => !i.pull_request);
}
