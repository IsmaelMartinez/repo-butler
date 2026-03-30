// MCP server tests — verify JSON-RPC protocol handling and tool/resource responses.
// Tests the message handler directly without spawning a subprocess.

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Capture stdout writes to verify JSON-RPC responses.
let responses = [];
const originalWrite = process.stdout.write;

function captureResponses() {
  responses = [];
  process.stdout.write = (data) => {
    try { responses.push(JSON.parse(data.toString().trim())); } catch { /* non-JSON output */ }
    return true;
  };
}

function restoreStdout() {
  process.stdout.write = originalWrite;
}

// Dynamic import to avoid top-level side effects.
let handleMessage, TOOLS, RESOURCES;

describe('MCP server', async () => {
  // Import once for all tests.
  const mod = await import('./mcp.js');
  handleMessage = mod.handleMessage;
  TOOLS = mod.TOOLS;
  RESOURCES = mod.RESOURCES;

  beforeEach(() => captureResponses());

  describe('protocol', () => {
    it('responds to initialize with server info and capabilities', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.1' } },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.equal(r.jsonrpc, '2.0');
      assert.equal(r.id, 1);
      assert.equal(r.result.serverInfo.name, 'repo-butler');
      assert.equal(r.result.protocolVersion, '2024-11-05');
      assert.ok(r.result.capabilities.resources);
      assert.ok(r.result.capabilities.tools);
    });

    it('responds to ping', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].id, 2);
      assert.deepEqual(responses[0].result, {});
    });

    it('ignores notifications (no id)', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      restoreStdout();

      assert.equal(responses.length, 0, 'notifications must not receive a response');
    });

    it('returns error for unknown method', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'unknown/method' }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, -32601);
    });

    it('returns parse error for invalid JSON', () => {
      handleMessage('not valid json');
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, -32700);
    });
  });

  describe('resources', () => {
    it('lists available resources', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'resources/list' }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const resources = responses[0].result.resources;
      assert.ok(Array.isArray(resources));
      assert.ok(resources.length >= 3);
      assert.ok(resources.some(r => r.uri === 'repo-butler://snapshot/latest'));
      assert.ok(resources.some(r => r.uri === 'repo-butler://portfolio/health'));
      assert.ok(resources.some(r => r.uri === 'repo-butler://portfolio/campaigns'));
    });

    it('returns error for unknown resource URI', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 11, method: 'resources/read',
        params: { uri: 'repo-butler://unknown' },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.ok(responses[0].error);
    });

    it('returns error when uri is missing', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 12, method: 'resources/read', params: {},
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, -32602);
    });
  });

  describe('tools', () => {
    it('lists available tools with input schemas', () => {
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list' }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const tools = responses[0].result.tools;
      assert.ok(Array.isArray(tools));
      assert.equal(tools.length, 4);

      const names = tools.map(t => t.name);
      assert.ok(names.includes('get_health_tier'));
      assert.ok(names.includes('get_campaign_status'));
      assert.ok(names.includes('query_portfolio'));
      assert.ok(names.includes('get_snapshot_diff'));

      // Every tool must have an inputSchema.
      for (const tool of tools) {
        assert.ok(tool.inputSchema, `${tool.name} should have inputSchema`);
        assert.equal(tool.inputSchema.type, 'object');
      }
    });

    it('returns error for unknown tool', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 21, method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.ok(responses[0].error);
    });

    it('returns error when tool name is missing', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 22, method: 'tools/call', params: {},
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      assert.equal(responses[0].error.code, -32602);
    });

    it('get_health_tier returns tier and checks for a known repo', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 23, method: 'tools/call',
        params: { name: 'get_health_tier', arguments: { repo: 'repo-butler' } },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      // Result will either have tier data or an error about no data — both are valid responses.
      const r = responses[0];
      assert.ok(r.result, 'should have a result');
      assert.ok(r.result.content, 'tool result should have content array');
      const data = JSON.parse(r.result.content[0].text);
      // If data is available, check structure. If not, it's an error message.
      if (data.tier) {
        assert.ok(['gold', 'silver', 'bronze', 'none'].includes(data.tier));
        assert.ok(Array.isArray(data.checks));
      }
    });

    it('get_campaign_status returns campaign array', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 24, method: 'tools/call',
        params: { name: 'get_campaign_status', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.ok(r.result?.content);
      const data = JSON.parse(r.result.content[0].text);
      if (data.campaigns) {
        assert.ok(Array.isArray(data.campaigns));
        for (const c of data.campaigns) {
          assert.ok(c.name);
          assert.ok(typeof c.percentage === 'number');
        }
      }
    });

    it('query_portfolio returns repos array', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 25, method: 'tools/call',
        params: { name: 'query_portfolio', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.ok(r.result?.content);
      const data = JSON.parse(r.result.content[0].text);
      if (data.repos) {
        assert.ok(Array.isArray(data.repos));
      }
    });

    it('get_snapshot_diff returns comparison or first-run message', () => {
      handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 26, method: 'tools/call',
        params: { name: 'get_snapshot_diff', arguments: {} },
      }));
      restoreStdout();

      assert.equal(responses.length, 1);
      const r = responses[0];
      assert.ok(r.result?.content);
      const data = JSON.parse(r.result.content[0].text);
      assert.ok(data.changes || data.message || data.error);
    });
  });
});
