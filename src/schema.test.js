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
    assert.equal(jsonFiles.length, 7, `expected 7 schema files, found ${jsonFiles.length}`);

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

// --- Test 3: config schema matches DEFAULTS, in both directions ---

// Schema properties with no DEFAULTS entry, each for a stated reason. Anything
// else present on one side only is drift and fails.
const CONFIG_SCHEMA_ONLY = new Set([
  'repository',        // runtime-injected / set in YAML; index.js falls back to GITHUB_REPOSITORY
  'council',           // readers default inline (ideate.js `enabled !== false`, council.js `mode || 'quick'`)
  'monitor',           // monitor.js defaults `stale_days || 30`
  'providers.deep',    // index.js falls back to the claude provider, then the default
]);

const JSON_TYPE = (v) => (Number.isInteger(v) ? 'integer' : typeof v);

// Walk DEFAULTS and the schema together. Nested objects with keys are compared
// key-for-key; an empty object in DEFAULTS is a user-keyed map, which the
// schema describes with additionalProperties rather than properties.
function compareConfig(defaults, node, path, errors) {
  const props = node?.properties || {};
  for (const [key, value] of Object.entries(defaults)) {
    const at = path ? `${path}.${key}` : key;
    const sub = props[key];
    if (!sub) { errors.push(`DEFAULTS.${at} has no schema property`); continue; }
    const isMap = value && typeof value === 'object';
    const expected = isMap ? 'object' : JSON_TYPE(value);
    if (sub.type !== expected) errors.push(`schema ${at} type ${sub.type} != DEFAULTS type ${expected}`);
    if ('default' in sub && !isMap) {
      if (sub.default !== value) errors.push(`schema ${at} default ${JSON.stringify(sub.default)} != DEFAULTS ${JSON.stringify(value)}`);
    }
    if (isMap && Object.keys(value).length > 0) compareConfig(value, sub, at, errors);
  }
  for (const key of Object.keys(props)) {
    const at = path ? `${path}.${key}` : key;
    if (!(key in defaults) && !CONFIG_SCHEMA_ONLY.has(at)) errors.push(`schema ${at} has no DEFAULTS entry`);
  }
  return errors;
}

describe('config schema matches DEFAULTS', () => {
  it('schema and the real DEFAULTS agree in both directions, recursively', async () => {
    const { DEFAULTS } = await import('./config.js');
    const schema = await loadSchema('config.v1.schema.json');
    assert.deepEqual(compareConfig(DEFAULTS, schema, '', []), []);
  });

  it('the comparison fails on drift either way (guards the guard)', async () => {
    const { DEFAULTS } = await import('./config.js');
    const schema = await loadSchema('config.v1.schema.json');
    const extraDefault = structuredClone(DEFAULTS);
    extraDefault.limits.new_knob = 1;
    assert.deepEqual(compareConfig(extraDefault, schema, '', []), ['DEFAULTS.limits.new_knob has no schema property']);

    const extraSchema = structuredClone(schema);
    extraSchema.properties.observe.properties.new_window = { type: 'integer' };
    assert.deepEqual(compareConfig(DEFAULTS, extraSchema, '', []), ['schema observe.new_window has no DEFAULTS entry']);
  });

  it('every schema-only key is actually read by src', async () => {
    const files = (await readdir(__dirname)).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
    const src = (await Promise.all(files.map(f => readFile(join(__dirname, f), 'utf-8')))).join('\n');
    for (const at of CONFIG_SCHEMA_ONLY) {
      const leaf = at.split('.').pop();
      assert.match(src, new RegExp(`config\\??\\.(?:[a-z]+\\??\\.)?${leaf}\\b`), `schema-only key "${at}" has no reader in src`);
    }
  });

  it('DEFAULTS is deeply frozen', async () => {
    const { DEFAULTS } = await import('./config.js');
    const unfrozen = [];
    (function walk(obj, path) {
      if (!Object.isFrozen(obj)) unfrozen.push(path || '<root>');
      for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') walk(v, path ? `${path}.${k}` : k);
    })(DEFAULTS, '');
    assert.deepEqual(unfrozen, []);
    assert.throws(() => { DEFAULTS.limits.labels.agent = 'x'; }, TypeError);
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
  it('schema properties and the keys fetchPortfolioDetails writes agree in both directions', async () => {
    const { fetchPortfolioDetails } = await import('./report-portfolio.js');
    const schema = await loadSchema('portfolio-details.v1.schema.json');
    const schemaKeys = new Set(Object.keys(schema.$defs.RepoDetails.properties));

    // Every endpoint failing still produces the full details object — each
    // fetch has its own fallback — so the key set is the one the code writes.
    const fail = () => Promise.reject(new Error('GitHub API 500: /x'));
    const gh = { request: fail, paginate: fail, getFileContent: () => Promise.resolve(null) };
    const repos = [{ name: 'r', pushed_at: '2026-01-01T00:00:00Z', open_issues: 0, archived: false, fork: false }];
    const written = new Set(Object.keys((await fetchPortfolioDetails(gh, 'owner', repos)).r));

    for (const key of written) assert.ok(schemaKeys.has(key), `fetchPortfolioDetails writes "${key}" but the schema has no property for it`);
    // contributors is attached later, in report.js, not by fetchPortfolioDetails.
    for (const key of schemaKeys) {
      if (key === 'contributors') continue;
      assert.ok(written.has(key), `schema property "${key}" is not written by fetchPortfolioDetails`);
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

// --- Test 6: governance-finding schema matches buildRemediationPlan output ---

describe('governance-finding schema matches buildRemediationPlan output', () => {
  it('every RemediationPlan required field is produced for every finding type', async () => {
    const { buildRemediationPlan } = await import('./governance.js');
    const schema = await loadSchema('governance-finding.v1.schema.json');
    const planRequired = schema.$defs.RemediationPlan.required;
    const executorEnum = schema.$defs.RemediationPlan.properties.executor.enum;

    const sampleFindings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], adoptionRate: 0.5 },
      { type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['repo-a'], adoptionRate: 0.3 },
      { type: 'tier-uplift', repo: 'repo-b', currentTier: 'silver', targetTier: 'gold', failingChecks: [{ name: 'security trifecta' }] },
      { type: 'policy-drift', category: 'license', repo: 'repo-c', expected: 'MIT', actual: 'GPL-3.0' },
      { type: 'dependabot-stale', repo: 'repo-d', stalePRs: [{ number: 1, title: 'bump', age: 45 }] },
      { type: 'open-vulnerability', repo: 'repo-e', critical: 1, high: 0, secretScanning: 0, sources: ['dependabot'] },
      { type: 'tier-regression', repo: 'repo-f', previousTier: 'gold', currentTier: 'silver', priorWeek: '2026-W26' },
      { type: 'stale-butler-pr', repo: 'repo-g', stalePRs: [{ number: 9, age: 40, branch: 'repo-butler/apply-codeowners', prClass: 'apply', state: 'blocked-persistent', verified: true }] },
      { type: 'stalled-alert', repo: 'repo-h', alerts: [{ number: 153, package: 'http-proxy-middleware', ecosystem: 'npm', manifestPath: 'docs-site/package-lock.json', severity: 'medium', ageDays: 35, classification: 'reachable-by-update', detail: 'refresh the lockfile instead' }] },
    ];

    // Every type the schema admits must appear above, or its remediation plan
    // is never validated — which is exactly how tier-regression shipped
    // unvalidated once already.
    const typeEnum = schema.properties.type.enum;
    const sampled = new Set(sampleFindings.map(f => f.type));
    for (const t of typeEnum) {
      assert.ok(sampled.has(t), `no sample finding for schema type "${t}" — its remediation plan is untested`);
    }

    for (const finding of sampleFindings) {
      const plan = buildRemediationPlan(finding);
      for (const field of planRequired) {
        assert.ok(field in plan, `${finding.type}: remediation plan missing required field "${field}"`);
      }
      assert.ok(executorEnum.includes(plan.executor), `${finding.type}: executor "${plan.executor}" not in schema enum`);
      assert.ok(Array.isArray(plan.targetFiles), `${finding.type}: targetFiles should be an array`);
      assert.ok(Array.isArray(plan.acceptanceCriteria), `${finding.type}: acceptanceCriteria should be an array`);
    }
  });

  it('executor hints route finding tools as designed', async () => {
    const { buildRemediationPlan } = await import('./governance.js');

    const templatable = buildRemediationPlan({ type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['r'] });
    assert.equal(templatable.executor, 'template');

    const agentTool = buildRemediationPlan({ type: 'standards-gap', tool: 'contributing-guide', nonCompliant: ['r'] });
    assert.equal(agentTool.executor, 'agent');

    const manualTool = buildRemediationPlan({ type: 'standards-gap', tool: 'license', nonCompliant: ['r'] });
    assert.equal(manualTool.executor, 'manual');

    const settingsTool = buildRemediationPlan({ type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['r'] });
    assert.equal(settingsTool.executor, 'settings');

    const drift = buildRemediationPlan({ type: 'policy-drift', category: 'ci-reliability', repo: 'r', expected: '90%', actual: '60%' });
    assert.equal(drift.executor, 'manual');

    // open-vulnerability is a per-repo STATE finding — it must never acquire a
    // template/settings write path via the remediation plan (ADR-002/011 lane).
    const openVuln = buildRemediationPlan({ type: 'open-vulnerability', repo: 'r', critical: 0, high: 1, secretScanning: 0, sources: ['dependabot'] });
    assert.equal(openVuln.executor, 'manual');

    // stale-butler-pr is likewise a per-repo STATE finding. Routing it to
    // `template` would also be circular: the templated path opens apply PRs,
    // which is precisely what this finding watches for going stale.
    const staleButler = buildRemediationPlan({ type: 'stale-butler-pr', repo: 'r', stalePRs: [{ number: 1, age: 40, state: 'awaiting-human' }] });
    assert.equal(staleButler.executor, 'manual');

    // stalled-alert is a per-repo STATE finding too, and ADR-014 authorises no
    // write at all in response to one — so a template/settings route here would
    // contradict the ADR that created the finding type.
    const stalled = buildRemediationPlan({ type: 'stalled-alert', repo: 'r', alerts: [{ number: 1, ageDays: 35, classification: 'reachable-by-update' }] });
    assert.equal(stalled.executor, 'manual');
    assert.deepEqual(stalled.targetFiles, []);
  });
});
