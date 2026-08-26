import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadConfigSync, parseStandardsConfig } from './config.js';

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

  it('parses the dependabot-auto-merge universal standard', () => {
    const config = { standards: { 'dependabot-auto-merge': 'universal' } };
    const result = parseStandardsConfig(config);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { tool: 'dependabot-auto-merge', scope: { type: 'universal' }, exclude: [] });
  });

  it('parses the codeowners and security-md universal standards', () => {
    const config = { standards: { 'codeowners': 'universal', 'security-md': 'universal' } };
    const result = parseStandardsConfig(config);
    assert.deepEqual(result, [
      { tool: 'codeowners', scope: { type: 'universal' }, exclude: [] },
      { tool: 'security-md', scope: { type: 'universal' }, exclude: [] },
    ]);
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

  it('loads a block scalar instead of discarding it', async () => {
    // The parser matched `context: |` as a key with the value "|" and mapped
    // that to an empty string, so the indented body was dropped and every
    // IDEATE and UPDATE prompt was built with no project context — since the
    // initial scaffold, while the README documented the field as working.
    const yaml = `repository: owner/repo

context: |
  Repo Butler plans its own roadmap.
  It eats its own dog food.

limits:
  max_ideas: 3
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.context, 'Repo Butler plans its own roadmap.\nIt eats its own dog food.\n');
      // The key after the block must still parse — the block must not swallow it.
      assert.equal(config.limits.max_ideas, 3);
      assert.equal(config.repository, 'owner/repo');
    });
  });

  it('keeps blank lines inside a block and strips the trailing ones', async () => {
    const yaml = `context: |
  First paragraph.

  Second paragraph.


next_key: value
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.context, 'First paragraph.\n\nSecond paragraph.\n');
      assert.equal(config.next_key, 'value');
    });
  });

  it('honours the strip chomping indicator', async () => {
    const yaml = `context: |-
  No trailing newline.
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.context, 'No trailing newline.');
    });
  });

  // Prose inside a block must never become configuration. The fixture opens a
  // `standards:` section first so `currentSection` is live — without that the
  // leak path (`result[currentSection][key] = …`) is unreachable and the
  // assertion passes whether or not the body is consumed.
  for (const [label, marker] of [
    ['plain', '|'],
    ['with a trailing comment', '| # why this exists'],
    ['folded', '>'],
    ['folded with chomping', '>-'],
  ]) {
    it(`does not leak block prose into config (${label})`, async () => {
      const yaml = `standards:
  license: universal

context: ${marker}
  Note: this is prose, not a key.
  secret-scanning: universal

repository: owner/repo
`;
      await withTempYaml(yaml, async (path) => {
        const config = await loadConfig(path);
        assert.deepEqual(config.standards, { license: 'universal' },
          'a prose line must not enable a governance standard');
        assert.ok(config.context.includes('Note: this is prose'), 'the body must load');
        assert.equal(config.repository, 'owner/repo');
      });
    });
  }

  it('folds a > block onto one line but keeps paragraph breaks', async () => {
    const yaml = `context: >
  First line
  second line.

  New paragraph.
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.context, 'First line second line.\n\nNew paragraph.\n');
    });
  });

  it('loads a block scalar nested inside a section', async () => {
    const yaml = `limits:
  max_ideas: 3
  note: |
    Nested prose.
    More of it.

repository: owner/repo
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.limits.note, 'Nested prose.\nMore of it.\n');
      assert.equal(config.limits.max_ideas, 3);
      assert.equal(config.repository, 'owner/repo');
    });
  });

  it('keeps a top-level block from stranding the section that follows it', async () => {
    // Both indent-0 forms must treat the current section the same way,
    // otherwise where a stray indented line lands depends on which kind of
    // key preceded it.
    const yaml = `standards:
  license: universal

context: |
  Prose.

limits:
  max_ideas: 4
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.deepEqual(config.standards, { license: 'universal' });
      assert.equal(config.limits.max_ideas, 4);
    });
  });

  it('strips carriage returns from a CRLF block body', async () => {
    const yaml = 'context: |\r\n  Hello\r\n  World\r\n\r\nrepository: owner/repo\r\n';
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.context, 'Hello\nWorld\n');
      assert.equal(config.repository, 'owner/repo');
    });
  });

  it('honours the keep chomping indicator', async () => {
    const yaml = 'context: |+\n  Hi\n\n\nrepository: o/r\n';
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config.context, 'Hi\n\n\n');
    });
  });

  it('caps a runaway context so it cannot blow the prompt budget', async () => {
    const yaml = `context: |\n${'  filler line of project context\n'.repeat(400)}`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.ok(config.context.length <= 2000, `context was ${config.context.length} chars`);
    });
  });

  it('loads the real roadmap.yml context, not an empty string', async () => {
    // Guards the actual defect: this repo's own config carries a context block.
    // fileURLToPath, not .pathname — the latter percent-encodes, so a checkout
    // under a directory with a space would silently fall back to DEFAULTS and
    // fail here as "context missing" rather than "path wrong".
    const config = await loadConfig(fileURLToPath(new URL('../.github/roadmap.yml', import.meta.url)));
    assert.ok(config.context.length > 50, 'the committed context block must reach the prompts');
  });

  it('ignores prototype-polluting keys in YAML', async () => {
    const yaml = `repository: owner/repo

__proto__:
  polluted: true

constructor:
  polluted: true
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal({}.polluted, undefined);
      assert.equal(config.polluted, undefined);
      assert.equal(Object.getPrototypeOf(config), Object.prototype);
    });
  });

  it('parses apply-cap block as tool -> integer caps', async () => {
    const yaml = `repository: owner/repo

apply-cap:
  code-scanning: 10
  dependabot-actions: 3
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config['apply-cap']['code-scanning'], 10);
      assert.equal(config['apply-cap']['dependabot-actions'], 3);
      assert.equal(typeof config['apply-cap']['code-scanning'], 'number');
    });
  });

  it('parses apply-schedule block as tool -> boolean allow-list', async () => {
    const yaml = `repository: owner/repo

apply-schedule:
  code-scanning: true
  dependabot-rebase: true
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config['apply-schedule']['code-scanning'], true);
      assert.equal(config['apply-schedule']['dependabot-rebase'], true);
      assert.equal(typeof config['apply-schedule']['code-scanning'], 'boolean');
    });
  });

  it('defaults apply-schedule to an empty object (scheduled path default-closed)', async () => {
    const config = await loadConfig('/nonexistent/path/roadmap.yml');
    assert.deepEqual(config['apply-schedule'], {});
  });

  it('defaults propose-targets and propose-classes to empty objects (cross-repo PROPOSE default-closed)', async () => {
    const config = await loadConfig('/nonexistent/path/roadmap.yml');
    assert.deepEqual(config['propose-targets'], {});
    assert.deepEqual(config['propose-classes'], {});
  });

  it('defaults max_issues_per_target to 1 (per-target cap kept low)', async () => {
    const config = await loadConfig('/nonexistent/path/roadmap.yml');
    assert.equal(config.limits.max_issues_per_target, 1);
  });

  it('parses propose-targets / propose-classes blocks as key-presence allow-lists', async () => {
    const yaml = `repository: owner/repo

propose-targets:
  teams-for-linux: true

propose-classes:
  policy-drift: true
  tier-uplift: true
`;
    await withTempYaml(yaml, async (path) => {
      const config = await loadConfig(path);
      assert.equal(config['propose-targets']['teams-for-linux'], true);
      assert.equal(config['propose-classes']['policy-drift'], true);
      assert.equal(config['propose-classes']['tier-uplift'], true);
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

// loadConfigSync exists solely so the MCP server (whose callTool dispatch is
// synchronous) can apply the same release_exempt list as every async caller.
describe('loadConfigSync', () => {
  it('parses release_exempt identically to the async loader', async () => {
    const yaml = 'release_exempt: sound3fy,generator-atlassian-compass-event-catalog\n';
    await withTempYaml(yaml, async (path) => {
      const sync = loadConfigSync(path);
      const async_ = await loadConfig(path);
      assert.equal(sync.release_exempt, 'sound3fy,generator-atlassian-compass-event-catalog');
      assert.deepEqual(sync, async_, 'sync and async loaders must not drift');
    });
  });

  it('falls back to defaults for a missing config instead of throwing', () => {
    const config = loadConfigSync(join(tmpdir(), 'definitely-absent-roadmap.yml'));
    assert.equal(config.release_exempt, '');
    assert.equal(config.limits.require_approval, true);
  });

  it('falls back to defaults when the path is a directory (unreadable)', () => {
    const config = loadConfigSync(tmpdir());
    assert.equal(config.release_exempt, '');
  });

  // Both fallback branches, not just the missing-path one: the throwing branch
  // is where a diagnostic log is most likely to get added later, and on stdout
  // that would corrupt mcp.js's JSON-RPC frames rather than merely being noisy.
  it('writes nothing to stdout on either fallback — mcp.js speaks JSON-RPC there', () => {
    const original = process.stdout.write;
    let captured = '';
    process.stdout.write = (chunk) => { captured += chunk.toString(); return true; };
    try {
      loadConfigSync(join(tmpdir(), 'definitely-absent-roadmap.yml'));
      loadConfigSync(tmpdir());
    } finally {
      process.stdout.write = original;
    }
    assert.equal(captured, '', 'a stray log here would corrupt the MCP protocol stream');
  });
});
