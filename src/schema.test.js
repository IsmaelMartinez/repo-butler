import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, '..', 'schemas', 'v1');

async function loadSchema(filename) {
  const raw = await readFile(join(SCHEMA_DIR, filename), 'utf-8');
  return JSON.parse(raw);
}

// --- Test 1: Schema files are valid JSON with required meta-fields ---

describe('Schema files are valid JSON', () => {
  it('all six schema files parse and have required top-level fields', async () => {
    const files = await readdir(SCHEMA_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    assert.equal(jsonFiles.length, 6, `expected 6 schema files, found ${jsonFiles.length}`);

    for (const file of jsonFiles) {
      const schema = await loadSchema(file);
      assert.ok(schema.$schema, `${file}: missing $schema`);
      // Each schema is either an object (type+properties) or an additionalProperties map
      const hasObjectShape = schema.type === 'object' && (schema.properties || schema.additionalProperties);
      assert.ok(hasObjectShape, `${file}: expected type=object with properties or additionalProperties`);
    }
  });
});

// --- Test 2: repository-snapshot schema matches observe() output keys ---

describe('repository-snapshot schema matches observe() output keys', () => {
  it('every required schema key exists in the mock snapshot', async () => {
    const schema = await loadSchema('repository-snapshot.v1.schema.json');

    // Keys produced by observe() at lines 49-77 of src/observe.js
    const mockSnapshot = {
      timestamp: new Date().toISOString(),
      repository: 'owner/repo',
      meta: {},
      issues: { open: [], recently_closed: [] },
      pull_requests: { recently_merged: [] },
      labels: [],
      milestones: [],
      releases: [],
      workflows: [],
      roadmap: null,
      package: null,
      community_profile: null,
      dependabot_alerts: null,
      ci_pass_rate: {},
      summary: {},
    };

    for (const key of schema.required) {
      assert.ok(key in mockSnapshot, `schema requires "${key}" but it is absent from observe() output`);
    }
  });

  it('schema properties do not reference keys absent from observe() output', async () => {
    const schema = await loadSchema('repository-snapshot.v1.schema.json');

    const observeKeys = new Set([
      'timestamp', 'repository', 'meta', 'issues', 'pull_requests', 'labels',
      'milestones', 'releases', 'workflows', 'roadmap', 'package',
      'community_profile', 'dependabot_alerts', 'ci_pass_rate', 'summary',
    ]);

    for (const key of Object.keys(schema.properties)) {
      assert.ok(observeKeys.has(key), `schema property "${key}" not found in observe() output`);
    }
  });
});

// --- Test 3: config schema matches DEFAULTS ---

describe('config schema matches DEFAULTS', () => {
  it('all schema top-level properties exist in the DEFAULTS object', async () => {
    const schema = await loadSchema('config.v1.schema.json');

    // DEFAULTS from src/config.js (lines 4-22)
    const DEFAULTS = {
      roadmap: { path: 'ROADMAP.md' },
      schedule: { assess: 'daily', ideate: 'weekly' },
      providers: { default: 'gemini' },
      context: '',
      limits: {
        max_issues_per_run: 3,
        require_approval: true,
        labels: { proposal: 'roadmap-proposal', agent: 'agent-generated' },
      },
      observe: {
        issues_closed_days: 90,
        prs_merged_days: 90,
        releases_count: 10,
      },
      standards: {},
      'standards-exclude': {},
    };

    // The schema also has a `repository` property (runtime-injected, not in DEFAULTS) — skip it
    const schemaOnlyKeys = ['repository'];

    for (const key of Object.keys(schema.properties)) {
      if (schemaOnlyKeys.includes(key)) continue;
      assert.ok(key in DEFAULTS, `schema property "${key}" not found in DEFAULTS`);
    }
  });

  it('nested config schema properties match DEFAULTS sub-keys', async () => {
    const schema = await loadSchema('config.v1.schema.json');

    const DEFAULTS = {
      roadmap: { path: 'ROADMAP.md' },
      schedule: { assess: 'daily', ideate: 'weekly' },
      providers: { default: 'gemini' },
      limits: {
        max_issues_per_run: 3,
        require_approval: true,
        labels: { proposal: 'roadmap-proposal', agent: 'agent-generated' },
      },
      observe: {
        issues_closed_days: 90,
        prs_merged_days: 90,
        releases_count: 10,
      },
    };

    const nestedSections = ['roadmap', 'schedule', 'providers', 'limits', 'observe'];
    for (const section of nestedSections) {
      const schemaSub = schema.properties[section]?.properties || {};
      for (const subKey of Object.keys(schemaSub)) {
        // limits.labels is itself nested — just check it exists
        if (section === 'limits' && subKey === 'labels') {
          assert.ok('labels' in DEFAULTS.limits, 'DEFAULTS.limits.labels missing');
          continue;
        }
        assert.ok(subKey in DEFAULTS[section], `schema.${section}.${subKey} not found in DEFAULTS.${section}`);
      }
    }
  });
});

// --- Test 4: health-tier schema enum matches computeHealthTier output ---

describe('health-tier schema enum matches computeHealthTier output', () => {
  it('tier values gold, silver, bronze, none are in the schema enum', async () => {
    const { computeHealthTier } = await import('./report-shared.js');
    const schema = await loadSchema('health-tier.v1.schema.json');
    const tierEnum = schema.properties.tier.enum;

    // Gold-qualifying repo: passes all silver and gold checks
    const goldRepo = {
      ci: 2,
      license: 'MIT',
      open_issues: 0,
      released_at: new Date(Date.now() - 10 * 86400000).toISOString(), // 10 days ago
      communityHealth: 90,
      vulns: { count: 0, max_severity: null },
      pushed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
      commits: 50,
    };
    const goldResult = computeHealthTier(goldRepo);
    assert.equal(goldResult.tier, 'gold');
    assert.ok(tierEnum.includes(goldResult.tier), `tier "${goldResult.tier}" not in schema enum`);

    // None-qualifying repo: fails everything
    const noneRepo = {
      ci: 0,
      license: null,
      open_issues: 99,
      released_at: null,
      communityHealth: 0,
      vulns: null,
      pushed_at: new Date(Date.now() - 800 * 86400000).toISOString(), // 800 days ago
      commits: 0,
    };
    const noneResult = computeHealthTier(noneRepo);
    assert.equal(noneResult.tier, 'none');
    assert.ok(tierEnum.includes(noneResult.tier), `tier "${noneResult.tier}" not in schema enum`);
  });

  it('checks array has the expected structure: name, passed, required_for', async () => {
    const { computeHealthTier } = await import('./report-shared.js');
    const schema = await loadSchema('health-tier.v1.schema.json');
    const checkRequired = schema.$defs.HealthCheck.required;

    const result = computeHealthTier({ ci: 1, license: 'MIT', open_issues: 5, communityHealth: 60, pushed_at: new Date().toISOString(), commits: 10, vulns: null, released_at: null });
    assert.ok(Array.isArray(result.checks), 'checks should be an array');
    assert.ok(result.checks.length > 0, 'checks should be non-empty');

    for (const check of result.checks) {
      for (const field of checkRequired) {
        assert.ok(field in check, `check missing required field "${field}"`);
      }
      assert.ok(typeof check.name === 'string', 'check.name should be a string');
      assert.ok(typeof check.passed === 'boolean', 'check.passed should be a boolean');
      assert.ok(['gold', 'silver', 'bronze'].includes(check.required_for), `check.required_for "${check.required_for}" not in enum`);
    }
  });

  it('check names in schema enum match the names produced by computeHealthTier', async () => {
    const { computeHealthTier } = await import('./report-shared.js');
    const schema = await loadSchema('health-tier.v1.schema.json');
    const nameEnum = new Set(schema.$defs.HealthCheck.properties.name.enum);

    const result = computeHealthTier({ ci: 0, license: null, open_issues: 0, communityHealth: null, pushed_at: new Date().toISOString(), commits: 0, vulns: null, released_at: null });
    for (const check of result.checks) {
      assert.ok(nameEnum.has(check.name), `check name "${check.name}" not in schema enum`);
    }
  });
});

// --- Test 5: portfolio-details schema documents fetchPortfolioDetails shape ---

describe('portfolio-details schema documents fetchPortfolioDetails shape', () => {
  it('schema has properties for all camelCase fields assigned at details[r.name]', async () => {
    const schema = await loadSchema('portfolio-details.v1.schema.json');
    const repoDetails = schema.$defs.RepoDetails.properties;

    // Fields directly assigned at line 173 of src/report-portfolio.js:
    // { commits, weekly, license, ci, communityHealth, vulns, ciPassRate, open_issues, sbom, released_at, hasIssueTemplate, libyear: null }
    // Plus `contributors` added later (documented in schema as optional)
    const expectedFields = [
      'commits', 'weekly', 'license', 'ci', 'communityHealth', 'vulns',
      'ciPassRate', 'open_issues', 'sbom', 'released_at', 'hasIssueTemplate',
      'libyear', 'contributors', 'codeScanning', 'secretScanning',
    ];

    for (const field of expectedFields) {
      assert.ok(field in repoDetails, `portfolio-details schema missing property "${field}"`);
    }
  });

  it('schema required array matches the fields set directly by fetchPortfolioDetails', async () => {
    const schema = await loadSchema('portfolio-details.v1.schema.json');
    const required = schema.$defs.RepoDetails.required;

    // contributors is optional (added post-fetch in report.js), so not required
    const expectedRequired = [
      'commits', 'weekly', 'license', 'ci', 'communityHealth', 'vulns',
      'ciPassRate', 'open_issues', 'sbom', 'released_at', 'hasIssueTemplate',
      'libyear',
    ];

    for (const field of expectedRequired) {
      assert.ok(required.includes(field), `"${field}" should be in portfolio-details required list`);
    }
    assert.ok(!required.includes('contributors'), '"contributors" should NOT be required (added post-fetch)');
  });
});
