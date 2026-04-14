import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseStandardsConfig } from './config.js';

async function withTempYaml(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'config-test-'));
  const path = join(dir, 'roadmap.yml');
  await writeFile(path, content);
  try { return await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

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

  it('parses nested standards block from YAML', async () => {
    const yaml = `repository: owner/repo

standards:
  license: universal
  code-scanning: universal
  renovate-npm: javascript
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.standards['license'], 'universal');
      assert.equal(config.standards['code-scanning'], 'universal');
      assert.equal(config.standards['renovate-npm'], 'javascript');
    });
  });

  it('parses nested observe block from YAML', async () => {
    const yaml = `repository: owner/repo

observe:
  issues_closed_days: 42
  prs_merged_days: 7
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.observe.issues_closed_days, 42);
      assert.equal(config.observe.prs_merged_days, 7);
      // releases_count retained from defaults
      assert.equal(config.observe.releases_count, 10);
    });
  });

  it('skips comments inside nested blocks', async () => {
    const yaml = `standards:
  # leading comment
  license: universal
  # trailing comment
  code-scanning: universal
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.standards['license'], 'universal');
      assert.equal(config.standards['code-scanning'], 'universal');
    });
  });
});
