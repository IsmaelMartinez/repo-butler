import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from './gemini.js';

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status, text) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  };
}

describe('GeminiProvider', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('throws if apiKey missing', () => {
    assert.throws(() => new GeminiProvider(''), /Gemini API key is required/);
  });

  it('posts to the generateContent endpoint with model in URL and headers/body shape', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'gemini reply' }] } }] });
    });

    const p = new GeminiProvider('gkey', { model: 'gemini-test' });
    const out = await p.generate('prompt-text');

    assert.equal(out, 'gemini reply');
    assert.equal(
      calls[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent',
    );
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'gkey');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.contents, [{ parts: [{ text: 'prompt-text' }] }]);
    assert.equal(body.generationConfig.temperature, 0.7);
    assert.equal(body.generationConfig.maxOutputTokens, 4096);
  });

  it('throws "no content" when candidates missing', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ candidates: [] }));
    const p = new GeminiProvider('k');
    await assert.rejects(() => p.generate('x'), /Gemini returned no content/);
  });

  it('throws Gemini API error with status on non-OK', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(429, 'quota exceeded'));
    const p = new GeminiProvider('k');
    await assert.rejects(() => p.generate('x'), /Gemini API error: 429 quota exceeded/);
  });
});
