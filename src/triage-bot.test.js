import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotToEvents, discoverBotConfig, getAllowedBotHosts } from './triage-bot.js';

describe('snapshotToEvents', () => {
  it('creates a butler_observation event from a snapshot', () => {
    const snapshot = {
      summary: {
        open_issues: 17,
        blocked_issues: 6,
        awaiting_feedback: 8,
        recently_merged_prs: 176,
        latest_release: 'v2.7.12',
      },
    };

    const events = snapshotToEvents(snapshot, 'IsmaelMartinez/teams-for-linux');

    assert.equal(events.length, 1);
    assert.equal(events[0].repo, 'IsmaelMartinez/teams-for-linux');
    assert.equal(events[0].event_type, 'butler_observation');
    assert.ok(events[0].summary.includes('17 open issues'));
    assert.ok(events[0].summary.includes('176 merged PRs'));
    assert.equal(events[0].metadata.source, 'repo-butler');
    assert.equal(events[0].metadata.open_issues, 17);
    assert.equal(events[0].metadata.latest_release, 'v2.7.12');
    assert.deepEqual(events[0].areas, ['metrics', 'observation']);
  });

  it('handles empty snapshot gracefully', () => {
    const events = snapshotToEvents({}, 'owner/repo');
    assert.equal(events.length, 1);
    assert.ok(events[0].summary.includes('0 open issues'));
    assert.equal(events[0].metadata.source, 'repo-butler');
  });

  it('handles null summary', () => {
    const events = snapshotToEvents({ summary: null }, 'owner/repo');
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.open_issues, undefined);
  });
});

describe('getAllowedBotHosts', () => {
  const origEnv = process.env.TRIAGE_BOT_ALLOWED_HOSTS;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.TRIAGE_BOT_ALLOWED_HOSTS;
    else process.env.TRIAGE_BOT_ALLOWED_HOSTS = origEnv;
  });

  it('returns empty array when env var not set', () => {
    delete process.env.TRIAGE_BOT_ALLOWED_HOSTS;
    assert.deepEqual(getAllowedBotHosts(), []);
  });

  it('parses comma-separated hostnames', () => {
    process.env.TRIAGE_BOT_ALLOWED_HOSTS = 'bot.example.com, other.co';
    assert.deepEqual(getAllowedBotHosts(), ['bot.example.com', 'other.co']);
  });
});

describe('discoverBotConfig', () => {
  const origUrl = process.env.TRIAGE_BOT_URL;
  const origHosts = process.env.TRIAGE_BOT_ALLOWED_HOSTS;
  afterEach(() => {
    if (origUrl === undefined) delete process.env.TRIAGE_BOT_URL;
    else process.env.TRIAGE_BOT_URL = origUrl;
    if (origHosts === undefined) delete process.env.TRIAGE_BOT_ALLOWED_HOSTS;
    else process.env.TRIAGE_BOT_ALLOWED_HOSTS = origHosts;
  });

  it('accepts TRIAGE_BOT_URL env var for trusted URLs', async () => {
    process.env.TRIAGE_BOT_URL = 'https://trusted-bot.example.com';
    delete process.env.TRIAGE_BOT_ALLOWED_HOSTS;
    const mockGh = { getFileContent: async () => null };
    const result = await discoverBotConfig(mockGh, 'owner', 'repo');
    assert.deepEqual(result, { bot_url: 'https://trusted-bot.example.com' });
  });

  it('rejects TRIAGE_BOT_URL with HTTP', async () => {
    process.env.TRIAGE_BOT_URL = 'http://bot.example.com';
    const mockGh = { getFileContent: async () => null };
    const result = await discoverBotConfig(mockGh, 'owner', 'repo');
    assert.equal(result, null);
  });

  it('rejects butler.json URLs when TRIAGE_BOT_ALLOWED_HOSTS is not set', async () => {
    delete process.env.TRIAGE_BOT_URL;
    delete process.env.TRIAGE_BOT_ALLOWED_HOSTS;
    const mockGh = { getFileContent: async () => JSON.stringify({ bot_url: 'https://evil.com' }) };
    const result = await discoverBotConfig(mockGh, 'owner', 'repo');
    assert.equal(result, null);
  });

  it('rejects butler.json URLs not on the allowlist', async () => {
    delete process.env.TRIAGE_BOT_URL;
    process.env.TRIAGE_BOT_ALLOWED_HOSTS = 'trusted-bot.example.com';
    const mockGh = { getFileContent: async () => JSON.stringify({ bot_url: 'https://evil.com' }) };
    const result = await discoverBotConfig(mockGh, 'owner', 'repo');
    assert.equal(result, null);
  });

  it('accepts butler.json URLs on the allowlist', async () => {
    delete process.env.TRIAGE_BOT_URL;
    process.env.TRIAGE_BOT_ALLOWED_HOSTS = 'trusted-bot.example.com';
    const mockGh = { getFileContent: async () => JSON.stringify({ bot_url: 'https://trusted-bot.example.com/api' }) };
    const result = await discoverBotConfig(mockGh, 'owner', 'repo');
    assert.deepEqual(result, { bot_url: 'https://trusted-bot.example.com/api' });
  });

  it('rejects butler.json with localhost SSRF', async () => {
    delete process.env.TRIAGE_BOT_URL;
    process.env.TRIAGE_BOT_ALLOWED_HOSTS = 'localhost';
    const mockGh = { getFileContent: async () => JSON.stringify({ bot_url: 'https://localhost/internal' }) };
    const result = await discoverBotConfig(mockGh, 'owner', 'repo');
    assert.equal(result, null);
  });
});
