// Claude provider via the Anthropic Messages API.
// Used for the IDEATE phase (deeper reasoning).

import { LLMProvider, fetchJson } from './base.js';

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
    return fetchJson({
      url: `${API_BASE}/messages`,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: this.model,
        // 32k accommodates the UPDATE phase reproducing the roadmap (~10k
        // tokens today, ~16k headroom for multi-year growth). 4k truncated
        // mid-document and tripped the length-preservation guard. Other
        // phases produce far less so over-allocation only affects the cap,
        // not actual cost (charged per real output token).
        max_tokens: 32768,
        messages: [{ role: 'user', content: prompt }],
      },
      extractText: (data) => {
        const textBlock = data.content?.find(c => c.type === 'text');
        if (!textBlock?.text) {
          throw new Error('Claude returned no text content');
        }
        return textBlock.text;
      },
      providerName: 'Claude',
    });
  }
}
