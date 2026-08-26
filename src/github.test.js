import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, redactRepoPath, hasActiveCopilotReviewRuleset, getAutomatedSecurityFixesState } from './github.js';

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

  // These two previously asserted `false`, which is what made a transient
  // failure the STRONGEST claim available: that the repo has no code-review
  // bot. The governance detector then reported a gap, and this standard routes
  // to a settings write — so the guard that is meant to prevent a duplicate
  // ruleset read the same false as permission to create one.
  it('returns null when the rulesets list is not an array', async () => {
    const gh = { paginate: async () => ({}), request: async () => ({}) };
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), null);
  });

  it('returns null when listing rulesets throws (no access / no scope)', async () => {
    const gh = { paginate: async () => { throw new Error('403'); }, request: async () => ({}) };
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), null);
  });

  it('returns null when an active ruleset detail could not be read and no rule was found', async () => {
    // The subtle case: the scan completed, but the one ruleset it could not
    // open is exactly where the rule might have been. Reporting false here
    // asserts an absence that was never observed.
    const gh = {
      paginate: async () => [{ id: 1, enforcement: 'active' }],
      request: async () => { throw new Error('500'); },
    };
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), null);
  });

  it('still returns true when a later ruleset carries the rule despite an earlier unreadable one', async () => {
    // An unreadable ruleset does not weaken a positive find — true is
    // definitive evidence regardless of what else could not be read.
    const gh = {
      paginate: async () => [{ id: 1, enforcement: 'active' }, { id: 2, enforcement: 'active' }],
      request: async (path) => {
        if (path.endsWith('/1')) throw new Error('500');
        return { rules: [{ type: 'copilot_code_review' }] };
      },
    };
    assert.equal(await hasActiveCopilotReviewRuleset(gh, 'o', 'r'), true);
  });

  it('stays total — a malformed ruleset element degrades to null, never throws', async () => {
    // Converting this to tri-state moved the loop out of the original outer
    // try. Both report-portfolio call sites sit bare inside a Promise.all with
    // no .catch, so a throw here aborts the entire REPORT/GOVERNANCE run for
    // every repo rather than degrading one field on one repo.
    const gh = { paginate: async () => [null, undefined], request: async () => ({}) };
    const result = await hasActiveCopilotReviewRuleset(gh, 'o', 'r');
    assert.equal(result, false, 'null elements are not active rulesets, so the scan completes');

    const throwing = {
      paginate: async () => ({ [Symbol.iterator]() { throw new Error('boom'); } }),
      request: async () => ({}),
    };
    assert.equal(await hasActiveCopilotReviewRuleset(throwing, 'o', 'r'), null);
  });

  it('returns false only when the scan completed and found nothing', async () => {
    const gh = {
      paginate: async () => [{ id: 1, enforcement: 'active' }],
      request: async () => ({ rules: [{ type: 'pull_request' }] }),
    };
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

describe('getAutomatedSecurityFixesState', () => {
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

// prCiState exists BESIDE prCiGreen rather than replacing it: prCiGreen is a
// merge authorisation and must keep collapsing everything non-green into false,
// whereas a reporting caller has to tell "red" from "nothing ran" from "could
// not read" — the three would otherwise land in the same dashboard row with
// three different remedies.
describe('createClient — prCiState', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function route(checkRuns, statusBody, { totalCount } = {}) {
    return mock.fn(async (url) => {
      const u = url.toString();
      if (u.includes('/check-runs')) {
        return jsonResponse({ check_runs: checkRuns, total_count: totalCount ?? checkRuns.length });
      }
      if (u.endsWith('/status')) return jsonResponse(statusBody);
      return jsonResponse({});
    });
  }

  it('green when every check-run succeeded and no status is failing', async () => {
    globalThis.fetch = route(
      [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }],
      { state: 'success', statuses: [] },
    );
    assert.equal(await createClient('tok').prCiState('o', 'r', 'sha'), 'green');
  });

  it('red when a check-run concluded failure', async () => {
    globalThis.fetch = route([{ status: 'completed', conclusion: 'failure' }], { state: 'success', statuses: [] });
    assert.equal(await createClient('tok').prCiState('o', 'r', 'sha'), 'red');
  });

  it('red when the combined status is error, not just failure', async () => {
    // An errored status (a webhook that never reported, say) is as blocking as
    // a failure; treating only 'failure' as red would report the PR green.
    globalThis.fetch = route([], { state: 'error', statuses: [{ state: 'error' }] });
    assert.equal(await createClient('tok').prCiState('o', 'r', 'sha'), 'red');
  });

  it('pending when a run is still in flight and nothing has failed', async () => {
    globalThis.fetch = route(
      [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }],
      { state: 'pending', statuses: [] },
    );
    assert.equal(await createClient('tok').prCiState('o', 'r', 'sha'), 'pending');
  });

  it('RED BEATS PENDING — one failure decides it however much is still running', async () => {
    // The precedence is load-bearing: reversing these two checks reports a
    // genuinely broken PR as merely unsettled, and the whole suite still passes.
    globalThis.fetch = route(
      [{ status: 'completed', conclusion: 'failure' }, { status: 'queued', conclusion: null }],
      { state: 'pending', statuses: [] },
    );
    assert.equal(await createClient('tok').prCiState('o', 'r', 'sha'), 'red');
  });

  it('none when the commit carries no CI signal at all', async () => {
    // Distinct from red on purpose: the portfolio actively tracks a ci-workflows
    // gap, so "this repo has no CI" must not read as "this PR is broken".
    globalThis.fetch = route([], { state: 'pending', statuses: [] });
    assert.equal(await createClient('tok').prCiState('o', 'r', 'sha'), 'none');
  });

  it('unknown when the paging cap is hit before the run list is complete', async () => {
    // An incomplete read is never guessed in either direction.
    globalThis.fetch = route([{ status: 'completed', conclusion: 'success' }], { state: 'success', statuses: [] }, { totalCount: 9999 });
    assert.equal(await createClient('tok').prCiState('o', 'r', 'sha'), 'unknown');
  });

  it('unknown when the API throws, never a guess', async () => {
    globalThis.fetch = mock.fn(async () => { throw new Error('network down'); });
    assert.equal(await createClient('tok').prCiState('o', 'r', 'sha'), 'unknown');
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

describe('createClient — prCiHistory', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const run = (sha, name, conclusion, created_at, run_attempt = 1) => ({
    head_sha: sha, name, conclusion, created_at, run_attempt,
  });

  it('groups the completed runs of one revision into a single attempt, newest first', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({
      workflow_runs: [
        run('bbb', 'CI', 'failure', '2026-07-20T08:30:00Z'),
        run('bbb', 'CodeQL', 'success', '2026-07-20T08:30:00Z'),
        run('aaa', 'Lint', 'failure', '2026-07-13T08:30:00Z'),
        run('aaa', 'CI', 'failure', '2026-07-13T08:30:00Z'),
      ],
    }));
    const gh = createClient('tok');
    const history = await gh.prCiHistory('o', 'r', 'dependabot/npm_and_yarn/linting-e7dfb5ad69');
    assert.deepEqual(history, [
      { sha: 'bbb', attempt: 1, failing: ['CI'] },
      { sha: 'aaa', attempt: 1, failing: ['CI', 'Lint'] },
    ]);
  });

  it('separates re-run attempts of the same SHA and orders by created_at, not response order', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({
      workflow_runs: [
        run('aaa', 'CI', 'failure', '2026-07-01T08:00:00Z', 1),
        run('aaa', 'CI', 'failure', '2026-07-03T08:00:00Z', 3),
        run('aaa', 'CI', 'failure', '2026-07-02T08:00:00Z', 2),
      ],
    }));
    const gh = createClient('tok');
    const history = await gh.prCiHistory('o', 'r', 'branch');
    assert.deepEqual(history.map(a => a.attempt), [3, 2, 1]);
  });

  it('queries the branch-scoped completed runs and caps the history at `attempts`', async () => {
    const urls = [];
    globalThis.fetch = mock.fn(async (url) => {
      urls.push(url.toString());
      return jsonResponse({
        workflow_runs: ['e', 'd', 'c', 'b', 'a'].map((s, i) =>
          run(s, 'CI', 'failure', `2026-07-0${5 - i}T08:00:00Z`)),
      });
    });
    const gh = createClient('tok');
    const history = await gh.prCiHistory('o', 'r', 'dependabot/npm_and_yarn/lint', { attempts: 3 });
    assert.deepEqual(history.map(a => a.sha), ['e', 'd', 'c']);
    assert.ok(urls[0].includes('/repos/o/r/actions/runs'));
    assert.ok(urls[0].includes('branch=dependabot%2Fnpm_and_yarn%2Flint'));
    assert.ok(urls[0].includes('status=completed'));
  });

  // Real response shape for bonnie-wee-plot#429's branch: six Dependabot rebases
  // on 2026-07-20, each firing three workflows, of which only `CI` concluded
  // failure. The deterministic-failure predicate compares these `failing` sets, so
  // the two consistently-green workflows must be absent from every one of them —
  // otherwise the signature would match for reasons unrelated to the failure.
  it('records only the failing workflows per attempt, excluding the green ones', async () => {
    const shas = ['504b0a0f', '98f11007', '5507e492', 'ce89c0f3', '6cef23a5', '3e2fd15e'];
    const times = ['08:33:46', '08:28:52', '08:24:13', '08:19:54', '08:15:00', '08:09:59'];
    globalThis.fetch = mock.fn(async () => jsonResponse({
      workflow_runs: shas.flatMap((sha, i) => [
        run(sha, 'CI', 'failure', `2026-07-20T${times[i]}Z`),
        run(sha, 'CodeQL', 'success', `2026-07-20T${times[i]}Z`),
        run(sha, 'Dependabot auto-merge', 'success', `2026-07-20T${times[i]}Z`),
      ]),
    }));
    const gh = createClient('tok');
    const history = await gh.prCiHistory('o', 'r', 'dependabot/npm_and_yarn/linting-e7dfb5ad69');
    assert.deepEqual(history, shas.slice(0, 3).map(sha => ({ sha, attempt: 1, failing: ['CI'] })));
  });

  it('empty when the branch has no completed runs', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ workflow_runs: [] }));
    const gh = createClient('tok');
    assert.deepEqual(await gh.prCiHistory('o', 'r', 'branch'), []);
  });

  // Opposite polarity to prCiGreen: this signal only suppresses a comment, so an
  // unreadable history must return "no evidence" rather than block the caller.
  it('empty (fails OPEN) on error', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(500, 'boom'));
    const gh = createClient('tok');
    assert.deepEqual(await gh.prCiHistory('o', 'r', 'branch'), []);
  });
});

// repo-butler is itself a PUBLIC repo, so its Actions logs are world-readable.
// A private repo's API path appearing in a retry log or a thrown error message
// discloses that repo permanently. `redactPaths` is opt-in per client so public
// callers keep fully debuggable logs — see private-watch.js for the only user.
describe('redactRepoPath', () => {
  it('replaces the repo segment and keeps the rest of the path', () => {
    assert.equal(redactRepoPath('/repos/alice/secret-thing/pulls'), '/repos/alice/<redacted>/pulls');
    assert.equal(redactRepoPath('/repos/alice/secret-thing'), '/repos/alice/<redacted>');
    assert.equal(
      redactRepoPath('/repos/alice/secret-thing/dependabot/alerts'),
      '/repos/alice/<redacted>/dependabot/alerts',
    );
  });

  it('stops at a query string or fragment rather than swallowing it', () => {
    assert.equal(redactRepoPath('/repos/alice/secret?state=open'), '/repos/alice/<redacted>?state=open');
  });

  it('leaves non-repo paths untouched', () => {
    for (const p of ['/installation/repositories', '/user/repos', '/orgs/alice/repos', '/rate_limit']) {
      assert.equal(redactRepoPath(p), p);
    }
  });

  it('tolerates non-string input', () => {
    assert.equal(redactRepoPath(undefined), 'undefined');
    assert.equal(redactRepoPath(null), 'null');
  });
});

describe('createClient — redactPaths', () => {
  let originalFetch, originalLog, logs;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLog = console.log;
    logs = [];
    console.log = (...a) => { logs.push(a.join(' ')); };
  });
  afterEach(() => { globalThis.fetch = originalFetch; console.log = originalLog; });

  const CANARY = 'ZZLEAKCANARYZZ';

  it('keeps the repo name out of the rate-limit retry log', async () => {
    let call = 0;
    globalThis.fetch = mock.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResponse({}, {
          status: 429,
          headers: new Map([['retry-after', '1'], ['x-ratelimit-remaining', '0']]),
        });
      }
      return jsonResponse({ ok: true });
    });

    const gh = createClient('tok', { redactPaths: true });
    await gh.request(`/repos/alice/${CANARY}/dependabot/alerts`);

    const all = logs.join('\n');
    assert.match(all, /Rate limited on/, 'expected a retry log, or this proves nothing');
    assert.ok(!all.includes(CANARY), `repo name leaked into retry log:\n${all}`);
    assert.match(all, /<redacted>/);
  });

  it('keeps the repo name and the response body out of thrown errors', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse(
      { message: `Must have admin rights to /repos/alice/${CANARY}` },
      { status: 403 },
    ));

    const gh = createClient('tok', { redactPaths: true });
    await assert.rejects(
      () => gh.request(`/repos/alice/${CANARY}/dependabot/alerts`),
      (err) => {
        assert.ok(!err.message.includes(CANARY), `repo name leaked into error: ${err.message}`);
        assert.match(err.message, /<redacted>/);
        assert.ok(!err.message.includes('admin rights'),
          'response body must be dropped when redacting — GitHub echoes the path back in it');
        return true;
      },
    );
  });

  it('leaves paths and bodies intact by default, so public logs stay debuggable', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ message: 'Not Found' }, { status: 404 }));

    const gh = createClient('tok');
    await assert.rejects(
      () => gh.request('/repos/alice/public-repo/pulls'),
      (err) => {
        assert.match(err.message, /public-repo/);
        assert.match(err.message, /Not Found/);
        return true;
      },
    );
  });
});
