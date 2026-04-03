import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseStandardsConfig } from './config.js';

describe('parseStandardsConfig', () => {
  it('returns empty array for empty config', () => {
    assert.deepEqual(parseStandardsConfig({}), []);
    assert.deepEqual(parseStandardsConfig({ standards: {} }), []);
  });

  it('parses universal standards', () => {
    const config = { standards: { 'issue-form-templates': 'universal', 'license': 'universal' } };
    const result = parseStandardsConfig(config);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { tool: 'issue-form-templates', scope: { type: 'universal' }, exclude: [] });
    assert.deepEqual(result[1], { tool: 'license', scope: { type: 'universal' }, exclude: [] });
  });

  it('parses ecosystem-scoped standards', () => {
    const config = { standards: { 'renovate-npm': 'javascript', 'golangci-lint': 'go' } };
    const result = parseStandardsConfig(config);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0].scope, { type: 'ecosystem', language: 'javascript' });
    assert.deepEqual(result[1].scope, { type: 'ecosystem', language: 'go' });
  });

  it('parses comma-separated exclusions', () => {
    const config = {
      standards: { 'coderabbit': 'universal' },
      'standards-exclude': { 'coderabbit': 'archived-repo,experimental-fork' },
    };
    const result = parseStandardsConfig(config);
    assert.deepEqual(result[0].exclude, ['archived-repo', 'experimental-fork']);
  });

  it('handles missing standards-exclude gracefully', () => {
    const config = { standards: { 'license': 'universal' } };
    const result = parseStandardsConfig(config);
    assert.deepEqual(result[0].exclude, []);
  });

  it('handles null config', () => {
    assert.deepEqual(parseStandardsConfig(null), []);
  });

  it('handles mixed universal and ecosystem standards', () => {
    const config = {
      standards: {
        'issue-form-templates': 'universal',
        'renovate-npm': 'javascript',
        'license': 'universal',
      },
    };
    const result = parseStandardsConfig(config);
    assert.equal(result.length, 3);
    assert.equal(result[0].scope.type, 'universal');
    assert.equal(result[1].scope.type, 'ecosystem');
    assert.equal(result[2].scope.type, 'universal');
  });
});

describe('loadConfig', () => {
  it('returns defaults with standards when file does not exist', async () => {
    const config = await loadConfig('/nonexistent/path.yml');
    assert.deepEqual(config.standards, {});
    assert.deepEqual(config['standards-exclude'], {});
  });

  it('defaults release_exempt to empty string', async () => {
    const config = await loadConfig('/nonexistent/path/roadmap.yml');
    assert.equal(config.release_exempt, '');
  });
});
