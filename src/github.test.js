import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './github.js';

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
