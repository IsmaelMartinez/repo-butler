import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We can't easily test the full onboard flow (requires GitHub API), but we
// can verify the module exports and the content generation logic.
import { onboard } from './onboard.js';

describe('onboard', () => {
  it('exports an onboard function', () => {
    assert.equal(typeof onboard, 'function');
  });

  it('skips repos with invalid format', async () => {
    // Pass a mock token — the function will fail on API calls but should
    // skip invalid repo names before reaching the API.
    const results = await onboard('fake-token', ['invalid-no-slash']);
    assert.equal(results.length, 0);
  });

  it('rejects repo names with shell-meta or backticks and warns', async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => { warnings.push(String(msg)); };
    try {
      const badNames = [
        'owner/repo`whoami`',
        'owner/repo$(id)',
        'owner/repo;ls',
        'owner/repo with space',
        'owner/repo|pipe',
      ];
      const results = await onboard('fake-token', badNames);
      // None should reach the API — all must be filtered before onboardRepo runs.
      assert.equal(results.length, 0, 'all unsafe repo names must be skipped');
      // Each unsafe name should produce a warning naming the offending repo.
      for (const name of badNames) {
        assert.ok(
          warnings.some(w => w.includes(name)),
          `expected warning for ${name}, got: ${warnings.join(' | ')}`,
        );
      }
    } finally {
      console.warn = origWarn;
    }
  });
});
