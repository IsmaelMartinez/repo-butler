import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeProvider } from './claude.js';
import { jsonResponse, errorResponse } from './test-utils.js';

describe('ClaudeProvider', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('throws if apiKey missing', () => {
    assert.throws(() => new ClaudeProvider(''), /Claude API key is required/);
  });

  it('posts to the Anthropic messages endpoint with correct headers and body', async () => {
    const calls = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ content: [{ type: 'text', text: 'hi back' }] });
    });

    const p = new ClaudeProvider('sekret', { model: 'claude-test' });
    const out = await p.generate('hello');

    assert.equal(out, 'hi back');
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].init.headers['x-api-key'], 'sekret');
    assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'claude-test');
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
  });

  it('throws "no text content" when content array lacks a text block', async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ content: [{ type: 'tool_use' }] }));
    const p = new ClaudeProvider('k');
    await assert.rejects(() => p.generate('x'), /Claude returned no text content/);
  });

  it('throws Claude API error with status on non-OK', async () => {
    globalThis.fetch = mock.fn(async () => errorResponse(401, 'unauthorized'));
    const p = new ClaudeProvider('k');
    await assert.rejects(() => p.generate('x'), /Claude API error: 401 unauthorized/);
  });
});
