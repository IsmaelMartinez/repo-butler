// Gemini Flash provider via the REST API.
// Free tier: 10 RPM, 250 RPD, 250K TPM. No credit card needed.

import { LLMProvider } from './base.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export class GeminiProvider extends LLMProvider {
  constructor(apiKey, { model = DEFAULT_MODEL } = {}) {
    super('gemini');
    if (!apiKey) throw new Error('Gemini API key is required');
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(prompt) {
    const url = `${API_BASE}/models/${this.model}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API error: ${res.status} ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts?.[0]?.text) {
      throw new Error('Gemini returned no content');
    }

    return candidate.content.parts[0].text;
  }
}
