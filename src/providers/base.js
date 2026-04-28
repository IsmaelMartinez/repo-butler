// Base interface for LLM providers.
// Each provider implements generate(prompt) → string.

export class LLMProvider {
  constructor(name) {
    this.name = name;
  }

  async generate(_prompt) {
    throw new Error(`${this.name}: generate() not implemented`);
  }
}

// Shared HTTP wrapper for the LLM REST APIs.
// POSTs `body` (JSON-encoded) to `url` with `headers`, throws on non-OK with
// a message including provider name + status + a short response snippet, and
// returns `extractText(parsedJson)` on success.
export async function fetchJson({ url, headers, body, extractText, providerName }) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${providerName} API error: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return extractText(data);
}
