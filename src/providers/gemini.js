// Gemini provider via the REST API.

import { LLMProvider, fetchJson } from './base.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Pinned explicitly. gemini-3.5-flash is no longer offered and the API had
// been silently routing it to gemini-3.6-flash. Flash-Lite (about a fifth of
// Flash's input price and a third of its output price) is enough for this
// pipeline's summarising and triage calls (2026-11-06).
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

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
          // gemini-3.5-flash-lite answers thinkingBudget: 0 with 400
          // INVALID_ARGUMENT; the Gemini 3 control is thinkingLevel, and
          // omitting it leaves thinking on (and billed).
          thinkingConfig: { thinkingLevel: 'minimal' },
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
