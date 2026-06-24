import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from './gemini.js';
import { jsonResponse, errorResponse } from './test-utils.js';

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
    assert.equal(body.generationConfig.maxOutputTokens, 32768);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  });

  it('throws "no content" when candidates missing', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ candidates: [] }));
    const p = new GeminiProvider('k');
    await assert.rejects(() => p.generate('x'), /Gemini returned no content/);
  });

  it('throws Gemini API error with status on a non-retriable non-OK', async () => {
    // 400 is non-retriable, so the throw path runs on the first attempt (a
    // retriable 429/503/529 is covered by the fetchJson backoff tests).
    globalThis.fetch = mock.fn(async () => errorResponse(400, 'invalid request'));
    const p = new GeminiProvider('k');
    await assert.rejects(() => p.generate('x'), /Gemini API error: 400 invalid request/);
  });
});
