import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural smoke test for docs/asyncapi.yml.
//
// This is NOT full AsyncAPI-schema validation: the zero-dependency Node 24
// runtime has no AsyncAPI validator, and the repo's only YAML parser is the
// limited hand-rolled one in src/config.js (flat + one-level-nested only),
// which cannot represent this deeply nested document. So we read the spec as
// plain text and assert on its key structural markers, and we separately parse
// the referenced JSON Schemas to confirm they exist and parse. Full
// AsyncAPI-schema validation is a dev-time step run outside CI.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, '..', 'docs', 'asyncapi.yml');
const SCHEMA_DIR = join(__dirname, '..', 'schemas', 'v1');

const HEALTH_TIER_SCHEMA = 'health-tier.v1.schema.json';
const GOVERNANCE_FINDING_SCHEMA = 'governance-finding.v1.schema.json';

describe('docs/asyncapi.yml structural smoke test', () => {
  it('exists and declares asyncapi 3.0.0', async () => {
    const spec = await readFile(SPEC_PATH, 'utf-8');
    assert.match(spec, /asyncapi:\s*3\.0\.0/, 'spec must declare asyncapi: 3.0.0');
  });

  it('defines both channels', async () => {
    const spec = await readFile(SPEC_PATH, 'utf-8');
    assert.ok(spec.includes('healthTierChanged'), 'spec must define the healthTierChanged channel');
    assert.ok(spec.includes('governanceProposalOpened'), 'spec must define the governanceProposalOpened channel');
  });

  it('declares at least one send operation', async () => {
    const spec = await readFile(SPEC_PATH, 'utf-8');
    assert.match(spec, /action:\s*send/, 'spec must declare at least one action: send operation');
  });

  it('references both Phase 6 schema files by name', async () => {
    const spec = await readFile(SPEC_PATH, 'utf-8');
    assert.ok(spec.includes(HEALTH_TIER_SCHEMA), `spec must reference ${HEALTH_TIER_SCHEMA}`);
    assert.ok(spec.includes(GOVERNANCE_FINDING_SCHEMA), `spec must reference ${GOVERNANCE_FINDING_SCHEMA}`);
  });

  it('the referenced schema files exist on disk and parse as JSON', async () => {
    for (const file of [HEALTH_TIER_SCHEMA, GOVERNANCE_FINDING_SCHEMA]) {
      const raw = await readFile(join(SCHEMA_DIR, file), 'utf-8');
      const parsed = JSON.parse(raw);
      assert.ok(parsed.$schema, `${file}: expected a parseable JSON Schema`);
    }
  });
});
