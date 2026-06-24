// Shared fetch-mock response builders used by the provider tests.

export function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

export function errorResponse(status, text = '', headers = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  return {
    ok: false,
    status,
    headers: { get: (k) => lower[k.toLowerCase()] ?? null },
    json: async () => ({}),
    text: async () => text,
  };
}
