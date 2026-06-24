import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, LLMProvider } from './base.js';
import { jsonResponse, errorResponse } from './test-utils.js';

describe('LLMProvider', () => {
  it('throws from generate() by default', async () => {
    const p = new LLMProvider('test');
    await assert.rejects(() => p.generate('hi'), /test: generate\(\) not implemented/);
  });
});

describe('fetchJson', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('POSTs JSON-encoded body and returns extractText(parsedJson)', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ result: 'hello world' });
    });

    const out = await fetchJson({
      url: 'https://example.test/endpoint',
      headers: { 'x-api-key': 'k' },
      body: { prompt: 'hi' },
      extractText: (d) => d.result,
      providerName: 'TestProvider',
    });

    assert.equal(out, 'hello world');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/endpoint');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json', 'x-api-key': 'k' });
    assert.equal(calls[0].init.body, JSON.stringify({ prompt: 'hi' }));
  });

  it('defaults Content-Type to application/json (caller can override)', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url, init) => { calls.push(init); return jsonResponse({}); });

    await fetchJson({ url: 'x', headers: {}, body: {}, extractText: () => null, providerName: 'p' });
    assert.equal(calls[0].headers['Content-Type'], 'application/json');

    await fetchJson({ url: 'x', headers: { 'Content-Type': 'application/x-custom' }, body: {}, extractText: () => null, providerName: 'p' });
    assert.equal(calls[1].headers['Content-Type'], 'application/x-custom', 'caller can override the default');
  });

  it('passes the parsed JSON to extractText', async () => {
    let received;
    globalThis.fetch = mock.fn(async () => jsonResponse({ a: 1, b: { c: 2 } }));

    await fetchJson({
      url: 'https://example.test/x',
      headers: {},
      body: {},
      extractText: (d) => { received = d; return 'ok'; },
      providerName: 'P',
    });

    assert.deepEqual(received, { a: 1, b: { c: 2 } });
  });

  it('throws on non-retriable non-OK with provider name + status + response snippet', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(400, 'bad request: invalid model'));

    await assert.rejects(
      () => fetchJson({
        url: 'https://example.test/x',
        headers: {},
        body: {},
        extractText: (d) => d,
        providerName: 'Claude',
      }),
      (err) => {
        assert.match(err.message, /Claude API error/);
        assert.match(err.message, /400/);
        assert.match(err.message, /bad request/);
        return true;
      },
    );
    // A non-retriable status throws on the first attempt — no backoff.
    assert.equal(globalThis.fetch.mock.callCount(), 1);
  });

  it('truncates long error response bodies to 200 chars', async () => {
    const longBody = 'x'.repeat(500);
    globalThis.fetch = mock.fn(async () => errorResponse(500, longBody));

    await assert.rejects(
      () => fetchJson({
        url: 'https://example.test/x',
        headers: {},
        body: {},
        extractText: (d) => d,
        providerName: 'Gemini',
      }),
      (err) => {
        // 200-char cap on snippet plus surrounding text
        assert.ok(err.message.length < 300, `expected short message, got length ${err.message.length}`);
        assert.match(err.message, /Gemini API error: 500/);
        return true;
      },
    );
  });

  it('propagates network/abort errors from fetch', async () => {
    globalThis.fetch = mock.fn(async () => { throw new Error('network down'); });

    await assert.rejects(
      () => fetchJson({
        url: 'https://example.test/x',
        headers: {},
        body: {},
        extractText: (d) => d,
        providerName: 'P',
      }),
      /network down/,
    );
  });

  it('lets extractText errors bubble (e.g. "no content" cases)', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ candidates: [] }));

    await assert.rejects(
      () => fetchJson({
        url: 'https://example.test/x',
        headers: {},
        body: {},
        extractText: () => { throw new Error('no usable content'); },
        providerName: 'P',
      }),
      /no usable content/,
    );
  });

  it('retries a 429 then succeeds, returning the eventual content', async () => {
    let n = 0;
    globalThis.fetch = mock.fn(async () => {
      n += 1;
      return n === 1 ? errorResponse(429, 'rate limited') : jsonResponse({ result: 'ok' });
    });
    const sleep = mock.fn(async () => {});

    const out = await fetchJson({
      url: 'x', headers: {}, body: {}, extractText: (d) => d.result, providerName: 'Gemini', sleep,
    });

    assert.equal(out, 'ok');
    assert.equal(globalThis.fetch.mock.callCount(), 2, 'one retry after the 429');
    assert.equal(sleep.mock.callCount(), 1, 'backed off once before retrying');
  });

  it('also retries transient overload statuses (503, 529)', async () => {
    for (const status of [503, 529]) {
      let n = 0;
      globalThis.fetch = mock.fn(async () => {
        n += 1;
        return n === 1 ? errorResponse(status, 'overloaded') : jsonResponse({ result: 'recovered' });
      });
      const out = await fetchJson({
        url: 'x', headers: {}, body: {}, extractText: (d) => d.result, providerName: 'Claude', sleep: async () => {},
      });
      assert.equal(out, 'recovered', `status ${status} should be retried`);
      assert.equal(globalThis.fetch.mock.callCount(), 2, `status ${status} retried once`);
    }
  });

  it('honours the Retry-After header (seconds) for the backoff wait', async () => {
    let n = 0;
    globalThis.fetch = mock.fn(async () => {
      n += 1;
      return n === 1 ? errorResponse(429, 'slow down', { 'Retry-After': '7' }) : jsonResponse({ result: 'ok' });
    });
    const sleep = mock.fn(async () => {});

    await fetchJson({
      url: 'x', headers: {}, body: {}, extractText: (d) => d.result, providerName: 'Gemini', sleep,
    });

    assert.equal(sleep.mock.calls[0].arguments[0], 7000, 'waits exactly Retry-After seconds');
  });

  it('throws the real status after exhausting retries on a sustained 429', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(429, 'rate limited: too many requests'));
    const sleep = mock.fn(async () => {});

    await assert.rejects(
      () => fetchJson({
        url: 'x', headers: {}, body: {}, extractText: (d) => d, providerName: 'Gemini', sleep,
      }),
      (err) => {
        assert.match(err.message, /Gemini API error: 429/);
        return true;
      },
    );
    assert.equal(globalThis.fetch.mock.callCount(), 3, 'three attempts total');
    assert.equal(sleep.mock.callCount(), 2, 'backed off between the three attempts');
    // Pin the default linear-backoff durations so a formula regression (e.g.
    // attempt*5000 making the first wait 0ms) can't ship silently.
    assert.equal(sleep.mock.calls[0].arguments[0], 5000, 'first default backoff is 5s');
    assert.equal(sleep.mock.calls[1].arguments[0], 10000, 'second default backoff is 10s');
  });

  it('treats a non-positive Retry-After as linear backoff, not an immediate retry', async () => {
    let n = 0;
    globalThis.fetch = mock.fn(async () => {
      n += 1;
      return n === 1 ? errorResponse(429, 'now', { 'Retry-After': '0' }) : jsonResponse({ result: 'ok' });
    });
    const sleep = mock.fn(async () => {});

    const out = await fetchJson({
      url: 'x', headers: {}, body: {}, extractText: (d) => d.result, providerName: 'Gemini', sleep,
    });

    assert.equal(out, 'ok');
    assert.equal(sleep.mock.calls[0].arguments[0], 5000, 'Retry-After: 0 uses the 5s linear backoff, not a 0ms hammer');
  });

  it('fails fast (no retry) when Retry-After exceeds the backoff cap', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(429, 'slow down', { 'Retry-After': '120' }));
    const sleep = mock.fn(async () => {});

    await assert.rejects(
      () => fetchJson({
        url: 'x', headers: {}, body: {}, extractText: (d) => d, providerName: 'Gemini', sleep,
      }),
      /Gemini API error: 429/,
    );
    assert.equal(globalThis.fetch.mock.callCount(), 1, 'no retry when the requested wait is too long to honour');
    assert.equal(sleep.mock.callCount(), 0, 'did not sleep');
  });
});
