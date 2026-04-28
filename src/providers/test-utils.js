// Shared fetch-mock response builders used by the provider tests.

export function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

export function errorResponse(status, text = '') {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  };
}
