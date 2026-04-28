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

  it('throws on non-OK with provider name + status + response snippet', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(429, 'rate limited: too many requests'));

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
        assert.match(err.message, /429/);
        assert.match(err.message, /rate limited/);
        return true;
      },
    );
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
});
