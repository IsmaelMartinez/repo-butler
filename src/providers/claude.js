// Claude provider via the Anthropic Messages API.
// Used for the IDEATE phase (deeper reasoning).

import { LLMProvider } from './base.js';

const API_BASE = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export class ClaudeProvider extends LLMProvider {
  constructor(apiKey, { model = DEFAULT_MODEL } = {}) {
    super('claude');
    if (!apiKey) throw new Error('Claude API key is required');
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(prompt) {
    const res = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Claude API error: ${res.status} ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const textBlock = data.content?.find(c => c.type === 'text');
    if (!textBlock?.text) {
      throw new Error('Claude returned no text content');
    }

    return textBlock.text;
  }
}
