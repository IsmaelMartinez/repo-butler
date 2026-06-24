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

// HTTP statuses worth retrying: 429 (rate limit — Gemini's free tier is only
// 10 RPM, so a brief spike is routine) plus transient server overload (503
// Service Unavailable, 529 Overloaded — Anthropic's overload signal). Other
// 4xx/5xx (auth, bad request, quota exhausted) are not transient, so retrying
// them just wastes the window — those throw immediately.
const RETRIABLE_STATUS = new Set([429, 503, 529]);
const MAX_ATTEMPTS = 3;

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

// Shared HTTP wrapper for the LLM REST APIs.
// POSTs `body` (JSON-encoded) to `url` with `headers`, throws on non-OK with
// a message including provider name + status + a short response snippet, and
// returns `extractText(parsedJson)` on success. Rate-limit (429) and transient
// overload (503/529) responses are retried with backoff, honouring a
// `Retry-After` header when present — mirroring the GitHub client's 429 path in
// github.js so the LLM transport degrades the same way. Without this a single
// transient Gemini 429 fails the whole UPDATE phase (one generate() call) and
// reds the daily pipeline, when a short wait would have succeeded. `sleep` is
// injectable so tests exercise the retry path without real waits.
export async function fetchJson({ url, headers, body, extractText, providerName, sleep = defaultSleep }) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      return extractText(data);
    }

    // Retry transient failures with backoff; the final attempt falls through to
    // the throw below so a sustained outage still surfaces the real status.
    if (RETRIABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = parseInt(res.headers?.get('retry-after'), 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : (attempt + 1) * 5000;
      const waitSec = Math.min(Math.ceil(waitMs / 1000), 60);
      console.log(`${providerName} rate limited (${res.status}), waiting ${waitSec}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
      await sleep(waitSec * 1000);
      continue;
    }

    const text = await res.text();
    throw new Error(`${providerName} API error: ${res.status} ${text.slice(0, 200)}`);
  }
}
