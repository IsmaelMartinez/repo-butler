import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildAgentCard, SKILLS } from './agent-card.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAFE_HOSTS = new Set(['github.com', 'ismaelmartinez.github.io']);

describe('buildAgentCard', () => {
  it('returns an object with the A2A required top-level fields', () => {
    const card = buildAgentCard();
    assert.equal(typeof card.name, 'string');
    assert.equal(typeof card.description, 'string');
    assert.equal(typeof card.version, 'string');
    assert.ok(card.capabilities, 'capabilities present');
    assert.ok(Array.isArray(card.skills), 'skills is an array');
    assert.ok(Array.isArray(card.defaultInputModes));
    assert.ok(Array.isArray(card.defaultOutputModes));
  });

  it('defaults version to the package.json version when invoked with the real package', async () => {
    const pkgRaw = await readFile(join(__dirname, '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw);
    const card = buildAgentCard({ version: pkg.version });
    assert.equal(card.version, pkg.version);
  });

  it('declares capabilities with A2A boolean flags', () => {
    const card = buildAgentCard();
    assert.equal(typeof card.capabilities.streaming, 'boolean');
    assert.equal(typeof card.capabilities.pushNotifications, 'boolean');
    assert.equal(typeof card.capabilities.stateTransitionHistory, 'boolean');
  });

  it('every skill has required id, name, description, and tags', () => {
    const card = buildAgentCard();
    for (const skill of card.skills) {
      assert.ok(skill.id, `skill missing id: ${JSON.stringify(skill)}`);
      assert.ok(skill.name, `skill "${skill.id}" missing name`);
      assert.ok(skill.description, `skill "${skill.id}" missing description`);
      assert.ok(Array.isArray(skill.tags) && skill.tags.length > 0, `skill "${skill.id}" missing tags`);
    }
  });

  it('skill ids are unique', () => {
    const ids = SKILLS.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate skill ids');
  });

  it('documentation and icon URLs use hosts from the core safety allowlist', () => {
    const card = buildAgentCard();
    const docHost = new URL(card.documentationUrl).hostname;
    const iconHost = new URL(card.iconUrl).hostname;
    assert.ok(SAFE_HOSTS.has(docHost), `documentationUrl host not on allowlist: ${docHost}`);
    assert.ok(SAFE_HOSTS.has(iconHost), `iconUrl host not on allowlist: ${iconHost}`);
  });

  it('accepts a custom repo override and renders urls consistently', () => {
    const card = buildAgentCard({ version: '9.9.9', repo: 'IsmaelMartinez/other-repo' });
    assert.equal(card.version, '9.9.9');
    assert.ok(card.iconUrl.includes('other-repo.svg'));
  });
});
