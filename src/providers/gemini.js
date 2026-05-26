// Gemini Flash provider via the REST API.
// Free tier: 10 RPM, 250 RPD, 250K TPM. No credit card needed.

import { LLMProvider, fetchJson } from './base.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.5-flash';

export class GeminiProvider extends LLMProvider {
  constructor(apiKey, { model = DEFAULT_MODEL } = {}) {
    super('gemini');
    if (!apiKey) throw new Error('Gemini API key is required');
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(prompt) {
    return fetchJson({
      url: `${API_BASE}/models/${this.model}:generateContent`,
      headers: {
        'x-goog-api-key': this.apiKey,
      },
      body: {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          // 32k accommodates the UPDATE phase reproducing the roadmap (~10k
          // tokens today, ~16k headroom for multi-year growth). 4k truncated
          // mid-document and tripped the length-preservation guard.
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      extractText: (data) => {
        const candidate = data.candidates?.[0];
        if (!candidate?.content?.parts?.[0]?.text) {
          throw new Error('Gemini returned no content');
        }
        return candidate.content.parts[0].text;
      },
      providerName: 'Gemini',
    });
  }
}
