import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from './apply-templates.js';
import { isAutoMergeAllowed } from './apply.js';
import { LOCKFILE_UPDATE_TOOL } from './lockfile-update.js';

const here = dirname(fileURLToPath(import.meta.url));
const importsOf = (file) =>
  [...readFileSync(join(here, file), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);

describe('apply-templates TEMPLATES', () => {
  // Auto-merge eligibility is "has a TEMPLATES entry" (isAutoMergeAllowed), and
  // governance derives its template routing from these keys, so the set is
  // pinned exactly: adding a key is a deliberate, reviewed widening of both.
  it('holds exactly the static-file template classes', () => {
    assert.deepEqual(Object.keys(TEMPLATES).sort(), [
      'code-scanning', 'codeowners', 'dependabot-actions', 'dependabot-auto-merge',
      'issue-form-templates', 'osv-scanner', 'release-cadence', 'security-md',
    ]);
  });

  it('never holds a settings-write, content-transformation or lockfile class', () => {
    // code-review-bot (ADR-009) and dependabot-security[-off] (ADR-012) are
    // settings writes; lockfile-update (ADR-015) and the trimmer (ADR-013,
    // which has no class name yet — the exact pin above excludes it) transform
    // content the butler did not author. None may become auto-merge eligible.
    for (const tool of ['code-review-bot', 'dependabot-security', 'dependabot-security-off', LOCKFILE_UPDATE_TOOL]) {
      assert.equal(Object.hasOwn(TEMPLATES, tool), false, tool);
      assert.equal(isAutoMergeAllowed({ [tool]: true }, tool), false, tool);
    }
  });

  it('gives every template a path and a content generator', () => {
    for (const [tool, t] of Object.entries(TEMPLATES)) {
      assert.equal(typeof t.path, 'string', tool);
      assert.equal(typeof t.content, 'function', tool);
    }
  });
});

describe('apply-templates module boundary', () => {
  it('imports nothing but safety.js (no client, no write module)', () => {
    assert.deepEqual(importsOf('apply-templates.js'), ['./safety.js']);
  });

  it('keeps detection code off the write module', () => {
    for (const file of ['butler-pr-audit.js', 'governance.js']) {
      assert.equal(importsOf(file).includes('./apply.js'), false, file);
    }
  });
});
