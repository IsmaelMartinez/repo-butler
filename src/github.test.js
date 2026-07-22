import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, hasActiveCopilotReviewRuleset, getAutomatedSecurityFixesState, hasAutomatedSecurityFixesEnabled } from './github.js';

// Helper: build a fetch response object compatible with the github.js client.
function jsonResponse(body, { status = 200, headers = new Map() } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status, text = '') {
  return {
    ok: false,
    status,
    headers: new Map(),
    json: async () => ({}),
    text: async () => text,
  };
}

describe('createClient — getFileContent', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('omits ref param when called without options (existing behaviour)', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url) => {
      calls.push(url.toString());
      return jsonResponse({ content: Buffer.from('hello').toString('base64') });
    });
    const gh = createClient('tok');
    const out = await gh.getFileContent('o', 'r', 'README.md');
    assert.equal(out, 'hello');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].includes('ref='), `expected no ref param, got ${calls[0]}`);
  });

  it('forwards { ref } as a ref query param', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url) => {
      calls.push(url.toString());
      return jsonResponse({ content: Buffer.from('on-branch').toString('base64') });
    });
    const gh = createClient('tok');
    const out = await gh.getFileContent('o', 'r', 'data.json', { ref: 'data-branch' });
    assert.equal(out, 'on-branch');
    assert.match(calls[0], /[?&]ref=data-branch(&|$)/);
  });

  it('returns null on error (existing behaviour preserved)', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(404, 'Not Found'));
    const gh = createClient('tok');
    assert.equal(await gh.getFileContent('o', 'r', 'missing.txt'), null);
    assert.equal(await gh.getFileContent('o', 'r', 'missing.txt', { ref: 'b' }), null);
  });
});

describe('createClient — listDir', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('omits ref when no options provided', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url) => {
      calls.push(url.toString());
      return jsonResponse([{ name: 'a.json' }, { name: 'b.json' }]);
    });
    const gh = createClient('tok');
    const out = await gh.listDir('o', 'r', 'snapshots');
    assert.deepEqual(out, ['a.json', 'b.json']);
    assert.ok(!calls[0].includes('ref='));
  });

  it('forwards { ref } as a query param', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url) => {
      calls.push(url.toString());
      return jsonResponse([{ name: 'one.json' }]);
    });
    const gh = createClient('tok');
    const out = await gh.listDir('o', 'r', 'snapshots/weekly', { ref: 'data-branch' });
    assert.deepEqual(out, ['one.json']);
    assert.match(calls[0], /[?&]ref=data-branch(&|$)/);
  });

  it('returns [] on error', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(404));
    const gh = createClient('tok');
    assert.deepEqual(await gh.listDir('o', 'r', 'missing'), []);
  });
});

describe('createClient — putFile', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('omits sha when the file does not exist (404 on read)', async () => {
    const requests = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      const u = url.toString();
      const method = init?.method ?? 'GET';
      requests.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : null });
      if (method === 'GET') return errorResponse(404, 'Not Found');
      return jsonResponse({});
    });

    const gh = createClient('tok');
    await gh.putFile('o', 'r', 'snap.json', '{"x":1}', { branch: 'data', message: 'msg' });

    const put = requests.find(r => r.method === 'PUT');
    assert.ok(put, 'expected a PUT request');
    assert.equal(put.body.message, 'msg');
    assert.equal(put.body.branch, 'data');
    assert.equal(put.body.sha, undefined, 'sha must be omitted when file did not exist');
    assert.equal(Buffer.from(put.body.content, 'base64').toString(), '{"x":1}');
  });

  it('auto-discovers the existing sha when not provided', async () => {
    const requests = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      const u = url.toString();
      const method = init?.method ?? 'GET';
      requests.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : null });
      if (method === 'GET') return jsonResponse({ sha: 'abc123', content: Buffer.from('old').toString('base64') });
      return jsonResponse({});
    });

    const gh = createClient('tok');
    await gh.putFile('o', 'r', 'snap.json', 'new', { branch: 'data' });

    const put = requests.find(r => r.method === 'PUT');
    assert.equal(put.body.sha, 'abc123');
    // The pre-PUT lookup must scope to the target branch.
    const get = requests.find(r => r.method === 'GET');
    assert.match(get.url, /[?&]ref=data(&|$)/);
  });

  it('uses an explicit sha without an extra GET', async () => {
    const requests = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse({});
    });

    const gh = createClient('tok');
    await gh.putFile('o', 'r', 'snap.json', 'x', { branch: 'data', sha: 'explicit-sha' });

    const gets = requests.filter(r => r.method === 'GET');
    assert.equal(gets.length, 0, 'must not GET when sha is supplied');
    const put = requests.find(r => r.method === 'PUT');
    assert.equal(put.body.sha, 'explicit-sha');
  });

  it('retries exactly once on 409 conflict, then succeeds', async () => {
    const calls = { get: 0, put: 0 };
    globalThis.fetch = mock.fn(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        calls.get++;
        return jsonResponse({ sha: `sha-${calls.get}` });
      }
      calls.put++;
      if (calls.put === 1) return errorResponse(409, 'Conflict');
      return jsonResponse({});
    });

    const gh = createClient('tok');
    await gh.putFile('o', 'r', 'snap.json', 'x', { branch: 'data' });

    assert.equal(calls.put, 2, 'expected one retry after 409');
    assert.equal(calls.get, 2, 'expected sha re-discovered before retry');
  });

  it('throws if the second attempt also fails', async () => {
    let puts = 0;
    globalThis.fetch = mock.fn(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return jsonResponse({ sha: 'x' });
      puts++;
      return errorResponse(409, 'Conflict');
    });

    const gh = createClient('tok');
    await assert.rejects(
      gh.putFile('o', 'r', 'snap.json', 'x', { branch: 'data' }),
      /409/,
    );
    assert.equal(puts, 2, 'must give up after two PUT attempts');
  });

  it('propagates non-404 read errors instead of treating them as missing-file', async () => {
    let puts = 0;
    globalThis.fetch = mock.fn(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return errorResponse(403, 'Forbidden');
      puts++;
      return jsonResponse({});
    });

    const gh = createClient('tok');
    await assert.rejects(gh.putFile('o', 'r', 'p', 'x', { branch: 'b' }), /403/);
    assert.equal(puts, 0, 'must not attempt PUT when read fails with non-404');
  });

  it('does not retry on non-409 errors', async () => {
    let puts = 0;
    globalThis.fetch = mock.fn(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return errorResponse(404);
      puts++;
      return errorResponse(422, 'Unprocessable');
    });

    const gh = createClient('tok');
    await assert.rejects(gh.putFile('o', 'r', 'p', 'x', { branch: 'b' }), /422/);
    assert.equal(puts, 1);
  });
});

describe('createClient — deleteFile', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('looks up the sha then issues DELETE with branch + sha', async () => {
    const requests = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      const u = url.toString();
      const method = init?.method ?? 'GET';
      requests.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : null });
      if (method === 'GET') return jsonResponse({ sha: 'old-sha' });
      return jsonResponse({});
    });

    const gh = createClient('tok');
    await gh.deleteFile('o', 'r', 'snapshots/weekly/2025-W01.json', {
      branch: 'data',
      message: 'prune',
    });

    const get = requests.find(r => r.method === 'GET');
    assert.match(get.url, /[?&]ref=data(&|$)/);
    const del = requests.find(r => r.method === 'DELETE');
    assert.ok(del, 'expected a DELETE request');
    assert.equal(del.body.sha, 'old-sha');
    assert.equal(del.body.branch, 'data');
    assert.equal(del.body.message, 'prune');
  });

  it('throws when the file is missing (sha lookup fails)', async () => {
    // We document the choice: deleteFile lets the underlying 404 propagate.
    // Callers that want best-effort pruning wrap in try/catch (see store.js).
    globalThis.fetch = mock.fn(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return errorResponse(404, 'Not Found');
      return jsonResponse({});
    });
    const gh = createClient('tok');
    await assert.rejects(
      gh.deleteFile('o', 'r', 'gone.json', { branch: 'data' }),
      /404/,
    );
  });
});

describe('hasActiveCopilotReviewRuleset', () => {
  // Mock gh with path-aware paginate (the rulesets list) + request (each detail).
  function makeGh({ list, detail }) {
    return {
      paginate: async (path) => (path.endsWith('/rulesets') ? list() : []),
      request: async (path) => detail(path),
    };
  }

  it('returns true for an active ruleset carrying a copilot_code_review rule', async () => {
    const gh = makeGh({
      list: () => [{ id: 1, enforcement: 'active' }],
      detail: () => ({ id: 1, rules: [{ type: 'copilot_code_review' }] }),
    });
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), true);
  });

  it('skips disabled rulesets (enforcement filter) and returns false', async () => {
    let detailCalls = 0;
    const gh = makeGh({
      list: () => [{ id: 1, enforcement: 'disabled' }],
      detail: () => { detailCalls++; return { id: 1, rules: [{ type: 'copilot_code_review' }] }; },
    });
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), false);
    assert.equal(detailCalls, 0, 'disabled ruleset detail must not be fetched');
  });

  it('returns false for an active ruleset whose rules do not include the copilot rule', async () => {
    const gh = makeGh({
      list: () => [{ id: 1, enforcement: 'active' }],
      detail: () => ({ id: 1, rules: [{ type: 'pull_request' }] }),
    });
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), false);
  });

  it('keeps scanning when one ruleset detail fetch fails and a later one carries the rule', async () => {
    const gh = makeGh({
      list: () => [{ id: 1, enforcement: 'active' }, { id: 2, enforcement: 'active' }],
      detail: (path) => {
        if (path.endsWith('/rulesets/1')) throw new Error('boom');
        return { id: 2, rules: [{ type: 'copilot_code_review' }] };
      },
    });
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), true);
  });

  it('returns false when the rulesets list is not an array', async () => {
    const gh = { paginate: async () => ({}), request: async () => ({}) };
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), false);
  });

  it('returns false when listing rulesets throws (no access / no scope)', async () => {
    const gh = { paginate: async () => { throw new Error('403'); }, request: async () => ({}) };
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), false);
  });
});

describe('createClient — request 204 No Content', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns null (not a JSON parse error) on a 204 write', async () => {
    // A 204 has an empty body; calling res.json() would throw. The settings
    // writes (PUT/DELETE automated-security-fixes, PUT vulnerability-alerts)
    // answer 204, so the client must return null rather than choke.
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 204,
      headers: new Map(),
      json: async () => { throw new Error('Unexpected end of JSON input'); },
      text: async () => '',
    }));
    const gh = createClient('tok');
    const result = await gh.request('/repos/o/r/automated-security-fixes', { method: 'PUT' });
    assert.equal(result, null);
  });
});

describe('getAutomatedSecurityFixesState / hasAutomatedSecurityFixesEnabled', () => {
  it('returns the { enabled, paused } pair from the API', async () => {
    const gh = { request: async () => ({ enabled: true, paused: false }) };
    assert.deepEqual(await getAutomatedSecurityFixesState(gh, 'o', 'r'), { enabled: true, paused: false });
  });

  it('coerces missing/non-boolean fields to false', async () => {
    const gh = { request: async () => ({ enabled: true }) };
    assert.deepEqual(await getAutomatedSecurityFixesState(gh, 'o', 'r'), { enabled: true, paused: false });
  });

  it('returns null on a non-object response', async () => {
    const gh = { request: async () => null };
    assert.equal(await getAutomatedSecurityFixesState(gh, 'o', 'r'), null);
  });

  it('returns null when the request throws (no access / no scope)', async () => {
    const gh = { request: async () => { throw new Error('403'); } };
    assert.equal(await getAutomatedSecurityFixesState(gh, 'o', 'r'), null);
  });

  it('hasAutomatedSecurityFixesEnabled is true only when enabled AND not paused', async () => {
    assert.equal(await hasAutomatedSecurityFixesEnabled({ request: async () => ({ enabled: true, paused: false }) }, 'o', 'r'), true);
    assert.equal(await hasAutomatedSecurityFixesEnabled({ request: async () => ({ enabled: true, paused: true }) }, 'o', 'r'), false, 'paused → not fully active');
    assert.equal(await hasAutomatedSecurityFixesEnabled({ request: async () => ({ enabled: false, paused: false }) }, 'o', 'r'), false);
    assert.equal(await hasAutomatedSecurityFixesEnabled({ request: async () => { throw new Error('403'); } }, 'o', 'r'), false);
  });
});

describe('createClient — mergePR', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('PUTs the merge endpoint with squash method and the sha guard', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url, opts) => {
      calls.push({ url: url.toString(), method: opts.method, body: JSON.parse(opts.body) });
      return jsonResponse({ merged: true, sha: 'merged-sha' });
    });
    const gh = createClient('tok');
    const out = await gh.mergePR('o', 'r', 12, { method: 'squash', sha: 'head-sha' });
    assert.deepEqual(out, { merged: true, sha: 'merged-sha' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
    assert.match(calls[0].url, /\/repos\/o\/r\/pulls\/12\/merge$/);
    assert.equal(calls[0].body.merge_method, 'squash');
    assert.equal(calls[0].body.sha, 'head-sha');
  });

  it('defaults to squash and omits sha when not provided', async () => {
    let captured;
    globalThis.fetch = mock.fn(async (_url, opts) => { captured = JSON.parse(opts.body); return jsonResponse({ merged: true, sha: 's' }); });
    const gh = createClient('tok');
    await gh.mergePR('o', 'r', 3);
    assert.equal(captured.merge_method, 'squash');
    assert.ok(!('sha' in captured), 'no sha key when none supplied');
  });

  it('reports merged:false when the API does not confirm the merge', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ merged: false, message: 'not mergeable' }));
    const gh = createClient('tok');
    const out = await gh.mergePR('o', 'r', 4, { sha: 'x' });
    assert.equal(out.merged, false);
  });
});

describe('createClient — prCiGreen', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // Route the check-runs and combined-status endpoints to fixed bodies.
  function route(checkRuns, statusBody) {
    return mock.fn(async (url) => {
      const u = url.toString();
      if (u.includes('/check-runs')) return jsonResponse({ check_runs: checkRuns });
      if (u.endsWith('/status')) return jsonResponse(statusBody);
      return jsonResponse({});
    });
  }

  it('true when all check-runs succeeded (neutral/skipped tolerated) and no failing status', async () => {
    globalThis.fetch = route(
      [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }],
      { state: 'success', statuses: [] },
    );
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), true);
  });

  it('false when a check-run is still pending', async () => {
    globalThis.fetch = route(
      [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }],
      { state: 'pending', statuses: [] },
    );
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), false);
  });

  it('false when a check-run failed', async () => {
    globalThis.fetch = route(
      [{ status: 'completed', conclusion: 'failure' }],
      { state: 'success', statuses: [] },
    );
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), false);
  });

  it('false when there is no CI signal at all (missing → not green)', async () => {
    globalThis.fetch = route([], { state: 'pending', statuses: [] });
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), false);
  });

  it('false when a commit status is failing even if check-runs pass', async () => {
    globalThis.fetch = route(
      [{ status: 'completed', conclusion: 'success' }],
      { state: 'failure', statuses: [{ state: 'failure' }] },
    );
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), false);
  });

  it('true for a legacy-status-only repo (no check-runs, combined status success)', async () => {
    globalThis.fetch = route([], { state: 'success', statuses: [{ state: 'success' }] });
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), true);
  });

  it('paginates check-runs: a failing run on page 2 (beyond the first 100) blocks green', async () => {
    const page1 = Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' }));
    const page2 = [{ status: 'completed', conclusion: 'failure' }];
    globalThis.fetch = mock.fn(async (url) => {
      const u = url.toString();
      if (u.includes('/check-runs')) {
        const page = Number(new URL(u).searchParams.get('page')) || 1;
        return jsonResponse({ total_count: 101, check_runs: page === 1 ? page1 : page2 });
      }
      if (u.endsWith('/status')) return jsonResponse({ state: 'success', statuses: [] });
      return jsonResponse({});
    });
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), false);
  });

  it('false (fail-closed) when the combined-status read fails, even if check-runs are green', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const u = url.toString();
      if (u.includes('/check-runs')) return jsonResponse({ total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] });
      if (u.endsWith('/status')) return errorResponse(500, 'status boom');
      return jsonResponse({});
    });
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), false);
  });

  it('false (fail-closed) when check-runs exceed the 10-page cap (>1000 runs, unverifiable)', async () => {
    const fullPage = Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' }));
    globalThis.fetch = mock.fn(async (url) => {
      const u = url.toString();
      if (u.includes('/check-runs')) return jsonResponse({ total_count: 2000, check_runs: fullPage });
      if (u.endsWith('/status')) return jsonResponse({ state: 'success', statuses: [] });
      return jsonResponse({});
    });
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), false);
  });

  it('false on error', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(500, 'boom'));
    const gh = createClient('tok');
    assert.equal(await gh.prCiGreen('o', 'r', 'sha'), false);
  });
});
