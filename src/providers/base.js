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
// Service Unavailable, 529 Overloaded — Anthropic's overload signal). Daily-
// quota exhaustion also surfaces as 429, indistinguishable from an RPM spike,
// so it is retried too (bounded to two extra attempts). Non-transient statuses
// (auth, bad request) throw immediately.
const RETRIABLE_STATUS = new Set([429, 503, 529]);
const MAX_ATTEMPTS = 3;
// Cap on how long we'll wait between attempts. A Retry-After longer than this
// isn't worth stalling the pipeline for — surface the error and let the next
// scheduled run retry, rather than retrying early (before the server is ready)
// or stalling the runner for minutes.
const MAX_BACKOFF_SEC = 60;

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

// Shared HTTP wrapper for the LLM REST APIs.
// POSTs `body` (JSON-encoded) to `url` with `headers`, throws on non-OK with
// a message including provider name + status + a short response snippet, and
// returns `extractText(parsedJson)` on success. Rate-limit (429) and transient
// overload (503/529) responses are retried with backoff, honouring a
// `Retry-After` header when present — the same backoff approach as the GitHub
// client in github.js. Without this a single transient Gemini 429 fails the
// whole UPDATE phase (one generate() call) and reds the daily pipeline, when a
// short wait would have succeeded. `sleep` is injectable so tests exercise the
// retry path without real waits.
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

    // Read the error body exactly once: draining it frees undici's socket back
    // to the pool for the retry, and the snippet feeds the throw below.
    const errText = await res.text().catch(() => '');

    // Retry transient failures with backoff. Honour a positive Retry-After
    // exactly; a missing/zero/negative value uses linear backoff. A Retry-After
    // longer than MAX_BACKOFF_SEC means retrying now would either stall the
    // runner or fire before the server is ready, so fall through and surface the
    // error. The final attempt also falls through, so a sustained outage still
    // throws the real status.
    if (RETRIABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = parseInt(res.headers?.get('retry-after'), 10);
      const honored = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
      if (honored === null || honored <= MAX_BACKOFF_SEC) {
        const waitSec = honored ?? Math.min((attempt + 1) * 5, MAX_BACKOFF_SEC);
        // 429 is a rate limit; 503/529 are transient overload — name the actual
        // condition so an outage isn't misread as throttling in the logs.
        const reason = res.status === 429 ? 'rate limited' : 'overloaded';
        console.log(`${providerName} ${reason} (${res.status}), waiting ${waitSec}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
        await sleep(waitSec * 1000);
        continue;
      }
    }

    throw new Error(`${providerName} API error: ${res.status} ${errText.slice(0, 200)}`);
  }
}
