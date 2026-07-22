import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFindings, generateTemplate, applyGovernanceFindings, capPerTool, selectNudgeTargets, nudgeStaleDependabotPRs, isScheduleAllowed, selectCopilotReviewTargets, buildCopilotReviewRuleset, applyCopilotReviewRulesets, findButlerCopilotRuleset, removeCopilotReviewRuleset, COPILOT_RULESET_NAME, isAutoMergeAllowed, autoMergeGovernancePRs, APPLY_PR_MARKER } from './apply.js';

describe('validateFindings', () => {
  it('filters to standards-gap findings with tool and nonCompliant', () => {
    const input = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'] },
      { type: 'policy-drift', tool: 'x', nonCompliant: ['repo-b'] },
      { type: 'standards-gap', nonCompliant: ['repo-c'] }, // missing tool
      { type: 'standards-gap', tool: 'dependabot-actions' }, // missing nonCompliant
      null,
      'string',
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-d'] },
    ];
    const result = validateFindings(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].tool, 'code-scanning');
    assert.equal(result[1].tool, 'dependabot-actions');
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(validateFindings(null), []);
    assert.deepEqual(validateFindings('hello'), []);
    assert.deepEqual(validateFindings({}), []);
  });
});

describe('capPerTool', () => {
  const pairs = (tool, n) => Array.from({ length: n }, (_, i) => ({ repo: `${tool}-${i}`, tool }));

  it('applies the per-tool override when present', () => {
    const kept = capPerTool(pairs('code-scanning', 8), { 'code-scanning': 6 }, 5);
    assert.equal(kept.length, 6);
  });

  it('falls back to the global cap for an unlisted tool', () => {
    const kept = capPerTool(pairs('dependabot-actions', 8), { 'code-scanning': 6 }, 5);
    assert.equal(kept.length, 5);
  });

  it('caps each tool independently and preserves order', () => {
    const mixed = [...pairs('a', 3), ...pairs('b', 3)];
    const kept = capPerTool(mixed, { a: 1, b: 2 }, 5);
    assert.equal(kept.filter(p => p.tool === 'a').length, 1);
    assert.equal(kept.filter(p => p.tool === 'b').length, 2);
    assert.equal(kept[0].repo, 'a-0', 'order preserved');
  });

  it('treats a missing applyCap map as all-global', () => {
    assert.equal(capPerTool(pairs('x', 9), undefined, 4).length, 4);
  });

  it('coerces a stringified numeric cap', () => {
    assert.equal(capPerTool(pairs('code-scanning', 8), { 'code-scanning': '6' }, 5).length, 6);
  });

  it('falls back to the global cap for a malformed cap value', () => {
    assert.equal(capPerTool(pairs('code-scanning', 8), { 'code-scanning': 'invalid' }, 5).length, 5);
    assert.equal(capPerTool(pairs('code-scanning', 8), { 'code-scanning': 0 }, 5).length, 5);
    assert.equal(capPerTool(pairs('code-scanning', 8), { 'code-scanning': -3 }, 5).length, 5);
  });
});

describe('isScheduleAllowed', () => {
  it('promotes a class on boolean true', () => {
    assert.equal(isScheduleAllowed({ 'code-scanning': true }, 'code-scanning'), true);
  });
  it('promotes a class on the string "true" (quoted-YAML tolerance)', () => {
    assert.equal(isScheduleAllowed({ 'code-scanning': 'true' }, 'code-scanning'), true);
  });
  it('does not promote on false, absent, or other truthy values', () => {
    assert.equal(isScheduleAllowed({ 'code-scanning': false }, 'code-scanning'), false);
    assert.equal(isScheduleAllowed({}, 'code-scanning'), false);
    assert.equal(isScheduleAllowed(undefined, 'code-scanning'), false);
    assert.equal(isScheduleAllowed({ 'code-scanning': 1 }, 'code-scanning'), false);
    assert.equal(isScheduleAllowed({ 'code-scanning': 'yes' }, 'code-scanning'), false);
  });
});

describe('generateTemplate', () => {
  it('generates code-scanning template for JavaScript ecosystem', () => {
    const result = generateTemplate('code-scanning', 'JavaScript');
    assert.equal(result.path, '.github/workflows/codeql-analysis.yml');
    assert.ok(result.content.includes('languages: javascript-typescript'));
    assert.ok(result.content.includes('github/codeql-action/init@v3'));
    assert.ok(result.content.includes('github/codeql-action/analyze@v3'));
  });

  it('generates code-scanning template for Go ecosystem', () => {
    const result = generateTemplate('code-scanning', 'Go');
    assert.equal(result.path, '.github/workflows/codeql-analysis.yml');
    assert.ok(result.content.includes('languages: go'));
  });

  // Each ecosystem maps to its own codeql-action language identifier. Rust and
  // Java previously fell through to javascript-typescript, emitting a JS/TS
  // analysis that scanned no matching source on those repos.
  for (const [eco, lang] of [
    ['TypeScript', 'javascript-typescript'],
    ['Python', 'python'],
    ['Rust', 'rust'],
    ['Java', 'java-kotlin'],
  ]) {
    it(`generates code-scanning template with ${lang} for ${eco}`, () => {
      const result = generateTemplate('code-scanning', eco);
      assert.equal(result.path, '.github/workflows/codeql-analysis.yml');
      assert.ok(result.content.includes(`languages: ${lang}`));
    });
  }

  it('generates code-scanning template with the javascript-typescript fallback for an unmapped ecosystem', () => {
    const result = generateTemplate('code-scanning', 'Cobol');
    assert.ok(result.content.includes('languages: javascript-typescript'));
  });

  it('generates dependabot template for JavaScript', () => {
    const result = generateTemplate('dependabot-actions', 'JavaScript');
    assert.equal(result.path, '.github/dependabot.yml');
    assert.ok(result.content.includes('package-ecosystem: "npm"'));
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
    assert.ok(result.content.includes('interval: "weekly"'));
  });

  // Without a root listing, each unambiguous ecosystem falls back to its
  // default manager; with a listing, the manager requires its manifest.
  for (const [eco, manager, manifest] of [
    ['JavaScript', 'npm', 'package.json'],
    ['TypeScript', 'npm', 'package.json'],
    ['Go', 'gomod', 'go.mod'],
    ['Python', 'pip', 'pyproject.toml'],
    ['Rust', 'cargo', 'Cargo.toml'],
  ]) {
    it(`maps ${eco} to ${manager} (fallback and manifest-gated)`, () => {
      for (const rootFiles of [null, ['README.md', manifest]]) {
        const result = generateTemplate('dependabot-actions', eco, undefined, rootFiles);
        assert.ok(result.content.includes(`package-ecosystem: "${manager}"`));
        assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
      }
    });
  }

  it('emits github-actions only when the root listing lacks the manifest', () => {
    const result = generateTemplate('dependabot-actions', 'Python', undefined, ['main.py', 'README.md']);
    assert.equal((result.content.match(/package-ecosystem/g) || []).length, 1);
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
  });

  it('resolves Java to maven or gradle from the root listing, never by guess', () => {
    const maven = generateTemplate('dependabot-actions', 'Java', undefined, ['pom.xml']);
    assert.ok(maven.content.includes('package-ecosystem: "maven"'));
    const gradle = generateTemplate('dependabot-actions', 'Java', undefined, ['build.gradle.kts']);
    assert.ok(gradle.content.includes('package-ecosystem: "gradle"'));
    // Ambiguous without a listing — auto-merge eligible class, so no guessing.
    const unknown = generateTemplate('dependabot-actions', 'Java');
    assert.equal((unknown.content.match(/package-ecosystem/g) || []).length, 1);
  });

  it('generates dependabot template for bare (no package manager)', () => {
    const result = generateTemplate('dependabot-actions', '');
    assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
    assert.ok(!result.content.includes('package-ecosystem: "npm"'));
    assert.ok(!result.content.includes('package-ecosystem: "gomod"'));
  });

  it('falls back to github-actions only for unknown or prototype-key ecosystems', () => {
    for (const eco of ['COBOL', 'toString', 'constructor', 'hasOwnProperty']) {
      const result = generateTemplate('dependabot-actions', eco);
      assert.equal((result.content.match(/package-ecosystem/g) || []).length, 1,
        `expected github-actions only for eco='${eco}'`);
      assert.ok(result.content.includes('package-ecosystem: "github-actions"'));
    }
  });

  it('generates a generic issue-form template (ecosystem-agnostic)', () => {
    const result = generateTemplate('issue-form-templates', 'JavaScript');
    assert.equal(result.path, '.github/ISSUE_TEMPLATE/bug_report.yml');
    assert.ok(result.content.includes('name: Bug Report'));
    assert.ok(result.content.includes('type: textarea'));
    // Identical regardless of ecosystem — a generic form, not language-keyed.
    assert.equal(generateTemplate('issue-form-templates', 'Go').content, result.content);
  });

  it('generates a dependabot-auto-merge workflow (ecosystem-agnostic, explicit --squash)', () => {
    const result = generateTemplate('dependabot-auto-merge', 'JavaScript');
    assert.equal(result.path, '.github/workflows/dependabot-auto-merge.yml');
    assert.ok(result.content.includes('dependabot/fetch-metadata@v3'));
    assert.ok(result.content.includes("version-update:semver-major"));
    // gh pr merge --auto needs an explicit method: it errors ("you must specify a
    // merge method") on repos with more than one merge method enabled (the default).
    assert.ok(result.content.includes('gh pr merge --auto --squash'));
    // Identical regardless of ecosystem — a single generic workflow.
    assert.equal(generateTemplate('dependabot-auto-merge', 'Go').content, result.content);
  });

  it('generates a CODEOWNERS file routing review to the repo owner', () => {
    const result = generateTemplate('codeowners', 'JavaScript', 'IsmaelMartinez');
    assert.equal(result.path, '.github/CODEOWNERS');
    assert.equal(result.content, '* @IsmaelMartinez\n');
    // Owner is derived from the apply target, not hardcoded.
    assert.equal(generateTemplate('codeowners', 'Go', 'someone-else').content, '* @someone-else\n');
  });

  it('throws when generating CODEOWNERS without an owner (cross-repo write guard)', () => {
    assert.throws(() => generateTemplate('codeowners', 'JavaScript'), /requires an owner/);
  });

  it('generates a generic SECURITY.md policy (ecosystem- and owner-agnostic)', () => {
    const result = generateTemplate('security-md', 'JavaScript', 'IsmaelMartinez');
    assert.equal(result.path, '.github/SECURITY.md');
    assert.ok(result.content.includes('# Security Policy'));
    assert.ok(result.content.includes('Report a vulnerability'));
    // Identical regardless of ecosystem or owner — a generic policy.
    assert.equal(generateTemplate('security-md', 'Go', 'someone-else').content, result.content);
  });

  it('generates a scheduled patch-release workflow (ecosystem-agnostic, fail-safe skips)', () => {
    const result = generateTemplate('release-cadence', 'JavaScript', 'IsmaelMartinez');
    assert.equal(result.path, '.github/workflows/release.yml');
    // Cadence gates: scheduled cron plus manual dispatch, 60-day age threshold.
    assert.ok(result.content.includes("cron: '0 6 1,15 * *'"));
    assert.ok(result.content.includes('workflow_dispatch'));
    assert.ok(result.content.includes('-lt 60'));
    // Fail-safe skips: no first release, incomplete API data, nothing to
    // release, non-semver tag.
    assert.ok(result.content.includes('first release stays a human decision'));
    assert.ok(result.content.includes('Incomplete release data'));
    assert.ok(result.content.includes('nothing to release'));
    assert.ok(result.content.includes('not plain semver'));
    // One combined API call for tag + published_at (review feedback: halves the
    // rate-limit cost and lets the incomplete-data guard above actually fire).
    assert.ok(result.content.includes("--jq '[.tag_name, .published_at] | join(\",\")'"));
    assert.equal((result.content.match(/gh api/g) || []).length, 1);
    // Patch bump forces base 10 so a leading-zero patch (v1.2.08) can't be
    // parsed as octal and crash the arithmetic (review feedback).
    assert.ok(result.content.includes('10#${BASH_REMATCH[4]}'));
    // An unparseable published_at must skip, not go red under set -e.
    assert.ok(result.content.includes('Unparseable release date'));
    // Serialise cron + manual dispatch so overlapping runs can't race the same
    // next tag; never cancel a run mid-release.
    assert.ok(result.content.includes('concurrency:'));
    assert.ok(result.content.includes('cancel-in-progress: false'));
    // The release write itself, with generated notes, pinned to the run's SHA.
    assert.ok(result.content.includes('gh release create "$next" --target "${GITHUB_SHA}" --generate-notes'));
    // Needs only contents:write — no packages/publish scopes.
    assert.ok(result.content.includes('contents: write'));
    // ${{ }} expressions survive JS template-literal escaping intact.
    assert.ok(result.content.includes('GH_TOKEN: ${{ github.token }}'));
    // Identical regardless of ecosystem or owner — reads git history only.
    assert.equal(generateTemplate('release-cadence', 'Go', 'someone-else').content, result.content);
  });

  it('returns null for unknown tool', () => {
    assert.equal(generateTemplate('secret-scanning', 'JavaScript'), null);
  });

  it('dependabot-actions tool name (governance emits this) resolves a template', () => {
    const result = generateTemplate('dependabot-actions', 'JavaScript');
    assert.notEqual(result, null);
    assert.equal(result.path, '.github/dependabot.yml');
    assert.ok(result.content.includes('package-ecosystem: "npm"'));
  });
});

// Execution-level coverage for the release-cadence workflow script: the string
// assertions above pin the template's shape; these actually RUN the bash logic
// with a stubbed `gh` and a scratch git repo, one test per skip/release branch.
// Linux-only (bash + GNU date), matching the ubuntu-latest runner the workflow
// itself targets.
describe('release-cadence workflow script (execution)', () => {
  if (process.platform !== 'linux') {
    it('requires bash + GNU date (ubuntu-latest, matching the workflow runner)', { skip: true }, () => {});
    return;
  }

  // Pull the `run: |` block scalar out of the generated YAML (content indented
  // 10 spaces under the step). No YAML dependency — the repo is zero-dep.
  const extractRunScript = (content) => {
    const lines = content.split('\n');
    const start = lines.findIndex(l => l.trim() === 'run: |');
    assert.notEqual(start, -1, 'template must contain a run: | block');
    const script = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i] === '') { script.push(''); continue; }
      if (!lines[i].startsWith('          ')) break;
      script.push(lines[i].slice(10));
    }
    return script.join('\n');
  };

  // One shared fixture: a repo whose history is  one ── two(HEAD),  with tags
  //   v1.2.3, v1.2.08, release-2026-01  on "one"  (commits exist since)
  //   v9.9.9                            on "two"  (nothing to release)
  // and a gh stub that answers `gh api …releases/latest` from STUB_TAG/STUB_DATE
  // (empty STUB_TAG = 404) and logs any other call as "GH-CALLED: …".
  const base = mkdtempSync(join(tmpdir(), 'release-cadence-'));
  const bin = join(base, 'bin');
  const repo = join(base, 'repo');
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(base, 'script.sh'), extractRunScript(generateTemplate('release-cadence', '', null).content));
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/bash',
    'if [ "$1" = "api" ]; then',
    '  [ -z "$STUB_TAG" ] && exit 1',
    '  echo "$STUB_TAG,$STUB_DATE"',
    '  exit 0',
    'fi',
    'echo "GH-CALLED: $*"',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'f'), 'one');
  git('add', 'f');
  git('commit', '-qm', 'one');
  git('tag', 'v1.2.3');
  git('tag', 'v1.2.08');
  git('tag', 'release-2026-01');
  writeFileSync(join(repo, 'f'), 'two');
  git('commit', '-aqm', 'two');
  git('tag', 'v9.9.9');

  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runScript = (env) => spawnSync('bash', [join(base, 'script.sh')], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: 'deadbeef',
      STUB_TAG: '',
      STUB_DATE: '',
      ...env,
    },
  });

  it('cuts the next patch release when stale with unreleased commits', () => {
    const r = runScript({ STUB_TAG: 'v1.2.3', STUB_DATE: daysAgo(120) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GH-CALLED: release create v1\.2\.4 --target deadbeef --generate-notes/);
  });

  it('bumps a leading-zero patch in base 10 instead of crashing on octal', () => {
    const r = runScript({ STUB_TAG: 'v1.2.08', STUB_DATE: daysAgo(120) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GH-CALLED: release create v1\.2\.9 /);
  });

  it('skips when the latest release is fresh', () => {
    const r = runScript({ STUB_TAG: 'v1.2.3', STUB_DATE: daysAgo(10) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cadence healthy, skipping/);
    assert.doesNotMatch(r.stdout, /GH-CALLED/);
  });

  it('skips when there is no published release (gh api 404)', () => {
    const r = runScript({});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No published release yet/);
  });

  it('skips on incomplete release data (empty published_at)', () => {
    const r = runScript({ STUB_TAG: 'v1.2.3' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Incomplete release data/);
  });

  it('skips (not fails) on an unparseable published_at', () => {
    const r = runScript({ STUB_TAG: 'v1.2.3', STUB_DATE: 'not-a-date' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Unparseable release date/);
  });

  it('skips a non-semver latest tag rather than guessing a scheme', () => {
    const r = runScript({ STUB_TAG: 'release-2026-01', STUB_DATE: daysAgo(120) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not plain semver/);
  });

  it('skips when there are no commits since the latest release', () => {
    const r = runScript({ STUB_TAG: 'v9.9.9', STUB_DATE: daysAgo(120) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to release/);
  });
});

describe('applyGovernanceFindings', () => {
  let calls;
  let mockGh;

  beforeEach(() => {
    calls = [];
    mockGh = {
      request: async (path, opts) => {
        calls.push({ type: 'request', path, opts });
        if (path.includes('/pulls') && opts?.method === 'POST') {
          return { number: 1, html_url: `https://github.com/owner/repo/pull/1` };
        }
        if (path.includes('/repos/') && !path.includes('/git/') && !path.includes('/contents/') && !path.includes('/pulls')) {
          return { default_branch: 'main' };
        }
        if (path.includes('/git/ref/')) {
          return { object: { sha: 'abc123' } };
        }
        if (path.includes('/git/refs') && opts?.method === 'POST') {
          return {};
        }
        if (path.includes('/contents/')) {
          return { sha: 'file123' };
        }
        return {};
      },
      paginate: async (path, opts) => {
        calls.push({ type: 'paginate', path, opts });
        return [];
      },
    };
  });

  const baseFindings = [
    { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
  ];
  const baseConfig = { limits: { require_approval: true } };

  it('skips repos with invalid names', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['valid-repo', 'bad repo!', '../evil'], repoEcosystems: { 'valid-repo': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    // Only valid-repo should have been processed
    const prCalls = calls.filter(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.equal(prCalls.length, 1);
    assert.ok(prCalls[0].path.includes('valid-repo'));
  });

  it('dry-run mode makes no API calls', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(calls.length, 0);
  });

  it('dry-run fail-closed: empty string is still dry-run', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, baseConfig, { dryRun: '' });
    assert.equal(result.status, 'dry-run');
    assert.equal(calls.length, 0);
  });

  it('dry-run fail-closed: undefined is still dry-run', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, baseConfig, {});
    assert.equal(result.status, 'dry-run');
    assert.equal(calls.length, 0);
  });

  it('refuses to run when require_approval is false', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, { limits: { require_approval: false } }, { dryRun: false });
    assert.equal(result.status, 'refused');
    assert.equal(calls.length, 0);
  });

  it('refuses to run when config.limits is missing', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, {}, { dryRun: false });
    assert.equal(result.status, 'refused');
    assert.equal(calls.length, 0);
  });

  it('treats a dependabot-auto-merge standards-gap as actionable (produces a pair)', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-auto-merge', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].repo, 'repo-a');
    assert.equal(result.pairs[0].tool, 'dependabot-auto-merge');
  });

  it('documents the auto-merge prerequisite in the opened PR body', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-auto-merge', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    const prCall = calls.find(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.ok(prCall, 'a PR should have been opened');
    assert.ok(prCall.opts.body.body.includes('Allow auto-merge'), 'PR body should carry the auto-merge prerequisite note');
    assert.ok(prCall.opts.body.body.includes('Phase 2'), 'PR body should note repo-settings management is deferred');
  });

  it('enforces batch cap', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'], repoEcosystems: { r1: 'JavaScript', r2: 'JavaScript', r3: 'JavaScript', r4: 'JavaScript', r5: 'JavaScript', r6: 'JavaScript', r7: 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false, maxPerRun: 3 });
    assert.equal(result.status, 'completed');
    const prCalls = calls.filter(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.equal(prCalls.length, 3);
  });

  it('honours a per-tool apply-cap override above the global cap', async () => {
    const repos = Array.from({ length: 8 }, (_, i) => `r${i + 1}`);
    const ecos = Object.fromEntries(repos.map(r => [r, 'JavaScript']));
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: repos, repoEcosystems: ecos },
    ];
    const config = { limits: { require_approval: true }, 'apply-cap': { 'code-scanning': 7 } };
    // global maxPerRun is 5, but the override lifts code-scanning to 7
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, config, { dryRun: true, maxPerRun: 5 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 7);
  });

  it('falls back to the global cap for a tool with no override (backstop holds)', async () => {
    const repos = Array.from({ length: 8 }, (_, i) => `r${i + 1}`);
    const ecos = Object.fromEntries(repos.map(r => [r, 'JavaScript']));
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: repos, repoEcosystems: ecos },
    ];
    // apply-cap only overrides code-scanning; dependabot-actions uses global 5
    const config = { limits: { require_approval: true }, 'apply-cap': { 'code-scanning': 7 } };
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, config, { dryRun: true, maxPerRun: 5 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 5);
  });

  it('caps two tools independently in one run', async () => {
    const csRepos = ['c1', 'c2', 'c3', 'c4'];
    const daRepos = ['d1', 'd2', 'd3', 'd4'];
    const ecos = Object.fromEntries([...csRepos, ...daRepos].map(r => [r, 'JavaScript']));
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: csRepos, repoEcosystems: ecos },
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: daRepos, repoEcosystems: ecos },
    ];
    const config = { limits: { require_approval: true }, 'apply-cap': { 'code-scanning': 3, 'dependabot-actions': 2 } };
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, config, { dryRun: true, maxPerRun: 5 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.filter(p => p.tool === 'code-scanning').length, 3);
    assert.equal(result.pairs.filter(p => p.tool === 'dependabot-actions').length, 2);
  });

  it('default behaviour is unchanged when no apply-cap is configured', async () => {
    const repos = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    const ecos = Object.fromEntries(repos.map(r => [r, 'JavaScript']));
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: repos, repoEcosystems: ecos },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true, maxPerRun: 5 });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 5);
  });

  it('treats a 404 root listing as an empty repo — dependabot config gates out the manager', async () => {
    const emptyRepoGh = {
      ...mockGh,
      request: async (path, opts) => {
        // Root listing GET 404s (empty repo root, Contents API behaviour).
        if (path.endsWith('/contents/') && !opts?.method) {
          calls.push({ type: 'request', path, opts });
          throw new Error('GitHub API GET /repos/owner/repo-a/contents/: 404 Not Found');
        }
        return mockGh.request(path, opts);
      },
    };
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(emptyRepoGh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    const put = calls.find(c => c.type === 'request' && c.opts?.method === 'PUT' && c.path.includes('dependabot.yml'));
    assert.ok(put, 'dependabot.yml should still be written');
    const content = Buffer.from(put.opts.body.content, 'base64').toString();
    assert.ok(!content.includes('package-ecosystem: "npm"'), '404 root means no manifest — no npm entry');
    assert.ok(content.includes('package-ecosystem: "github-actions"'));
  });

  it('skips repos with existing open PR (dedup)', async () => {
    const deduplicatingGh = {
      ...mockGh,
      paginate: async (path, opts) => {
        calls.push({ type: 'paginate', path, opts });
        // Simulate existing PR for repo-a
        if (path.includes('repo-a')) {
          return [{ number: 42, html_url: 'https://github.com/owner/repo-a/pull/42' }];
        }
        return [];
      },
    };
    const result = await applyGovernanceFindings(deduplicatingGh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.equal(result.results[0].status, 'skipped');
    assert.equal(result.results[0].reason, 'PR already open');
  });

  it('handles per-repo error without aborting batch', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['fail-repo', 'ok-repo'], repoEcosystems: { 'fail-repo': 'JavaScript', 'ok-repo': 'JavaScript' } },
    ];
    let callCount = 0;
    const errorGh = {
      request: async (path, opts) => {
        calls.push({ type: 'request', path, opts });
        // Fail on the first repo's metadata lookup
        if (path === '/repos/owner/fail-repo' && !opts?.method) {
          throw new Error('403 Forbidden');
        }
        if (path.includes('/pulls') && opts?.method === 'POST') {
          return { number: 1, html_url: 'https://github.com/owner/ok-repo/pull/1' };
        }
        if (path.includes('/repos/') && !path.includes('/git/') && !path.includes('/contents/') && !path.includes('/pulls')) {
          return { default_branch: 'main' };
        }
        if (path.includes('/git/ref/')) {
          return { object: { sha: 'abc123' } };
        }
        if (path.includes('/git/refs') && opts?.method === 'POST') {
          return {};
        }
        if (path.includes('/contents/')) {
          return { sha: 'file123' };
        }
        return {};
      },
      paginate: async (path, opts) => {
        calls.push({ type: 'paginate', path, opts });
        return [];
      },
    };

    const result = await applyGovernanceFindings(errorGh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].status, 'error');
    assert.equal(result.results[1].status, 'created');
    assert.deepEqual(result.summary, { created: 1, skipped: 0, errors: 1 });
  });

  it('filters findings by tools option', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-b'], repoEcosystems: { 'repo-b': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: false, tools: ['dependabot-actions'] });
    assert.equal(result.status, 'completed');
    const prCalls = calls.filter(c => c.type === 'request' && c.opts?.method === 'POST' && c.path.includes('/pulls'));
    assert.equal(prCalls.length, 1);
    assert.ok(prCalls[0].path.includes('repo-b'));
  });

  it('treats a dependabot-actions finding as actionable (not filtered out)', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-b'], repoEcosystems: { 'repo-b': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true, tools: ['dependabot-actions'] });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].repo, 'repo-b');
    assert.equal(result.pairs[0].tool, 'dependabot-actions');
  });

  it('excludes findings whose remediation.executor is not template', async () => {
    const findings = [
      // templatable tool but explicitly routed to an agent — must NOT be auto-applied
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' }, remediation: { executor: 'agent' } },
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-b'], repoEcosystems: { 'repo-b': 'JavaScript' }, remediation: { executor: 'template' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'only the template finding is actionable');
    assert.equal(result.pairs[0].repo, 'repo-b');
    assert.equal(result.pairs[0].tool, 'dependabot-actions');
  });

  it('falls back to actionable when a finding has no remediation (pre-contract snapshot)', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'absent remediation falls back to TEMPLATES-only behaviour');
  });

  it('now actions an issue-form-templates finding routed to template', async () => {
    const findings = [
      { type: 'standards-gap', tool: 'issue-form-templates', nonCompliant: ['repo-c'], remediation: { executor: 'template' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'issue-form-templates is now an actionable template tool');
    assert.equal(result.pairs[0].tool, 'issue-form-templates');
  });

  // --- Stage 4 (ADR-007): scheduled, no-human path is default-closed ---------

  it('scheduled run with empty apply-schedule opens nothing (default-closed)', async () => {
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, baseConfig, { dryRun: true, scheduled: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 0, 'no class is promoted, so the scheduled gate excludes everything');
  });

  it('scheduled run applies only allow-listed finding classes', async () => {
    const config = { limits: { require_approval: true }, 'apply-schedule': { 'code-scanning': true } };
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-b'], repoEcosystems: { 'repo-b': 'JavaScript' } },
    ];
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, config, { dryRun: true, scheduled: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'only the promoted class passes the schedule gate');
    assert.equal(result.pairs[0].tool, 'code-scanning');
  });

  it('manual dispatch ignores apply-schedule entirely (regression guard)', async () => {
    const config = { limits: { require_approval: true }, 'apply-schedule': { 'code-scanning': true } };
    const findings = [
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-a'], repoEcosystems: { 'repo-a': 'JavaScript' } },
      { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-b'], repoEcosystems: { 'repo-b': 'JavaScript' } },
    ];
    // scheduled omitted → workflow_dispatch path: full actionable set, identical to before stage 4
    const result = await applyGovernanceFindings(mockGh, 'owner', findings, config, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 2);
  });

  it('scheduled path still honours require_approval', async () => {
    const config = { limits: { require_approval: false }, 'apply-schedule': { 'code-scanning': true } };
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, config, { dryRun: false, scheduled: true });
    assert.equal(result.status, 'refused');
    assert.equal(calls.length, 0);
  });

  it('scheduled path stays dry-run fail-closed even for an allow-listed class', async () => {
    const config = { limits: { require_approval: true }, 'apply-schedule': { 'code-scanning': true } };
    // dryRun omitted → must not act
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, config, { scheduled: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'the class is allow-listed, so it would be applied');
    assert.equal(calls.length, 0, 'but dry-run fail-closed means no API calls');
  });

  it('scheduled live run opens PRs for an allow-listed class', async () => {
    const config = { limits: { require_approval: true }, 'apply-schedule': { 'code-scanning': true } };
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, config, { dryRun: false, scheduled: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.summary.created, 1);
  });

  it('tolerates a quoted "true" in apply-schedule (stringy YAML)', async () => {
    const config = { limits: { require_approval: true }, 'apply-schedule': { 'code-scanning': 'true' } };
    const result = await applyGovernanceFindings(mockGh, 'owner', baseFindings, config, { dryRun: true, scheduled: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.pairs.length, 1, 'a quoted "true" still promotes the class');
  });
});

describe('selectNudgeTargets', () => {
  it('picks the single oldest stale PR per repo, most-stale first', () => {
    const findings = [
      { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [{ number: 1, title: 'bump x', age: 40 }, { number: 2, title: 'bump y', age: 70 }] },
      { type: 'dependabot-stale', repo: 'repo-b', stalePRs: [{ number: 3, title: 'bump z', age: 35 }] },
    ];
    const targets = selectNudgeTargets(findings, 5);
    assert.equal(targets.length, 2);
    // repo-a's oldest (70d, #2) comes before repo-b (35d), one per repo
    assert.deepEqual(targets.map(t => `${t.repo}#${t.number}`), ['repo-a#2', 'repo-b#3']);
  });

  it('caps to maxPerRun', () => {
    const findings = Array.from({ length: 8 }, (_, i) => ({
      type: 'dependabot-stale', repo: `repo-${i}`, stalePRs: [{ number: i + 1, title: 't', age: 31 + i }],
    }));
    const targets = selectNudgeTargets(findings, 3);
    assert.equal(targets.length, 3);
    // most-stale first: ages 38, 37, 36 → repo-7, repo-6, repo-5
    assert.deepEqual(targets.map(t => t.repo), ['repo-7', 'repo-6', 'repo-5']);
  });

  it('skips invalid repo names and non-dependabot-stale findings', () => {
    const findings = [
      { type: 'dependabot-stale', repo: '../evil', stalePRs: [{ number: 1, title: 't', age: 99 }] },
      { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-x'] },
      { type: 'dependabot-stale', repo: 'good-repo', stalePRs: [{ number: 5, title: 't', age: 33 }] },
    ];
    const targets = selectNudgeTargets(findings, 5);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].repo, 'good-repo');
  });

  it('ignores findings with empty or missing stalePRs', () => {
    const findings = [
      { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [] },
      { type: 'dependabot-stale', repo: 'repo-b' },
    ];
    assert.equal(selectNudgeTargets(findings, 5).length, 0);
  });

  it('tolerates null/malformed entries in stalePRs without throwing', () => {
    const findings = [
      { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [null, { title: 'no number', age: 50 }, { number: 9, title: 'ok', age: 40 }] },
      { type: 'dependabot-stale', repo: 'repo-b', stalePRs: [{ number: 2, title: 'bad age', age: 'old' }] },
    ];
    const targets = selectNudgeTargets(findings, 5);
    // repo-a keeps only the well-formed PR (#9); repo-b has no valid PR
    assert.deepEqual(targets.map(t => `${t.repo}#${t.number}`), ['repo-a#9']);
  });
});

describe('nudgeStaleDependabotPRs', () => {
  const baseConfig = { limits: { require_approval: true } };
  const baseFindings = [
    { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [{ number: 7, title: 'bump lodash', age: 45 }] },
  ];

  function mkGh(comments = []) {
    const calls = [];
    const gh = {
      request: async (path, opts) => { calls.push({ path, opts }); return {}; },
      paginate: async (path) => { calls.push({ path }); return comments; },
    };
    return { gh, calls };
  }

  it('refuses to run when require_approval is not set', async () => {
    const { gh, calls } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, { limits: {} }, { dryRun: false });
    assert.equal(result.status, 'refused');
    assert.equal(calls.length, 0);
  });

  it('dry-run makes no API calls and lists targets', async () => {
    const { gh, calls } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.targets.length, 1);
    assert.equal(calls.length, 0);
  });

  it('dry-run fail-closed: undefined dryRun stays dry-run', async () => {
    const { gh } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, {});
    assert.equal(result.status, 'dry-run');
  });

  it('posts a single @dependabot rebase comment when live', async () => {
    const { gh, calls } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.summary, { nudged: 1, skipped: 0, errors: 0 });
    const posted = calls.find(c => c.opts?.method === 'POST');
    assert.ok(posted.path.includes('/repos/owner/repo-a/issues/7/comments'));
    assert.equal(posted.opts.body.body, '@dependabot rebase');
  });

  it('skips a PR already nudged within the dedup window', async () => {
    const recent = new Date(Date.now() - 2 * 86400000).toISOString();
    const { gh, calls } = mkGh([{ body: '@dependabot rebase', created_at: recent }]);
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.results[0].status, 'skipped');
    assert.equal(result.results[0].reason, 'recent nudge');
    assert.equal(calls.filter(c => c.opts?.method === 'POST').length, 0);
  });

  it('re-nudges when the prior nudge is older than the dedup window', async () => {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const { gh } = mkGh([{ body: '@dependabot rebase', created_at: old }]);
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.results[0].status, 'nudged');
  });

  it('records a per-PR error without aborting the run', async () => {
    const calls = [];
    const gh = {
      request: async (path, opts) => { calls.push({ path, opts }); throw new Error('403 Forbidden'); },
      paginate: async () => [],
    };
    const findings = [
      { type: 'dependabot-stale', repo: 'repo-a', stalePRs: [{ number: 7, title: 't', age: 45 }] },
      { type: 'dependabot-stale', repo: 'repo-b', stalePRs: [{ number: 9, title: 't', age: 40 }] },
    ];
    const result = await nudgeStaleDependabotPRs(gh, 'owner', findings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.equal(result.summary.errors, 2);
    assert.equal(result.results.length, 2);
  });

  // --- Stage 4 (ADR-007): the nudge is default-closed on the scheduled path ---

  it('scheduled run skips the nudge when dependabot-rebase is not allow-listed', async () => {
    const { gh, calls } = mkGh();
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, baseConfig, { dryRun: false, scheduled: true });
    assert.equal(result.status, 'skipped-unscheduled');
    assert.equal(result.targets.length, 0);
    assert.equal(calls.length, 0);
  });

  it('scheduled run nudges when dependabot-rebase is allow-listed', async () => {
    const { gh } = mkGh();
    const config = { limits: { require_approval: true }, 'apply-schedule': { 'dependabot-rebase': true } };
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, config, { dryRun: false, scheduled: true });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.summary, { nudged: 1, skipped: 0, errors: 0 });
  });

  it('manual dispatch ignores apply-schedule for the nudge (regression guard)', async () => {
    const { gh } = mkGh();
    // scheduled omitted → manual path; apply-schedule must not gate the nudge
    const config = { limits: { require_approval: true }, 'apply-schedule': {} };
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, config, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.targets.length, 1);
  });

  it('tolerates a quoted "true" for dependabot-rebase on the scheduled path', async () => {
    const { gh } = mkGh();
    const config = { limits: { require_approval: true }, 'apply-schedule': { 'dependabot-rebase': 'true' } };
    const result = await nudgeStaleDependabotPRs(gh, 'owner', baseFindings, config, { dryRun: true, scheduled: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.targets.length, 1);
  });
});

describe('selectCopilotReviewTargets', () => {
  it('collects non-compliant repos from code-review-bot findings, dedups, ignores other tools', () => {
    const findings = [
      { type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['a', 'b', 'a'] },
      { type: 'standards-gap', tool: 'codeowners', nonCompliant: ['c'] },
      { type: 'dependabot-stale', repo: 'x' },
    ];
    assert.deepEqual(selectCopilotReviewTargets(findings, 5), ['a', 'b']);
  });

  it('drops invalid repo names', () => {
    const findings = [{ type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['ok', 'bad name!'] }];
    assert.deepEqual(selectCopilotReviewTargets(findings, 5), ['ok']);
  });

  it('caps at maxPerRun', () => {
    const findings = [{ type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['a', 'b', 'c'] }];
    assert.deepEqual(selectCopilotReviewTargets(findings, 2), ['a', 'b']);
  });

  it('returns [] when there are no code-review-bot findings', () => {
    assert.deepEqual(selectCopilotReviewTargets([{ type: 'standards-gap', tool: 'codeowners', nonCompliant: ['a'] }], 5), []);
  });
});

describe('buildCopilotReviewRuleset', () => {
  it('builds a scope-minimised default-branch ruleset carrying only the copilot rule', () => {
    const rs = buildCopilotReviewRuleset();
    assert.equal(rs.name, COPILOT_RULESET_NAME);
    assert.equal(rs.target, 'branch');
    assert.equal(rs.enforcement, 'active');
    assert.deepEqual(rs.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
    assert.deepEqual(rs.conditions.ref_name.exclude, []);
    assert.equal(rs.rules.length, 1);
    assert.equal(rs.rules[0].type, 'copilot_code_review');
  });
});

describe('applyCopilotReviewRulesets', () => {
  const baseConfig = { limits: { require_approval: true } };
  const baseFindings = [{ type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['repo-a'] }];

  it('refuses to run when require_approval is not set', async () => {
    const calls = [];
    const gh = { request: async (p, o) => { calls.push({ p, o }); return {}; }, paginate: async () => [] };
    const result = await applyCopilotReviewRulesets(gh, 'owner', baseFindings, { limits: {} }, { dryRun: false });
    assert.equal(result.status, 'refused');
    assert.equal(calls.length, 0);
  });

  it('dry-run previews the exact payload and makes no writes', async () => {
    const calls = [];
    const gh = { request: async (p, o) => { calls.push({ p, o }); return {}; }, paginate: async () => [] };
    const result = await applyCopilotReviewRulesets(gh, 'owner', baseFindings, baseConfig, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.targets.length, 1);
    assert.equal(result.ruleset.rules[0].type, 'copilot_code_review');
    assert.equal(calls.length, 0);
  });

  it('dry-run fail-closed: undefined dryRun stays dry-run', async () => {
    const gh = { request: async () => ({}), paginate: async () => [] };
    const result = await applyCopilotReviewRulesets(gh, 'owner', baseFindings, baseConfig, {});
    assert.equal(result.status, 'dry-run');
  });

  it('creates the ruleset when live and none exists', async () => {
    const calls = [];
    const gh = {
      paginate: async () => [],
      request: async (path, opts) => { calls.push({ path, method: opts?.method }); return {}; },
    };
    const result = await applyCopilotReviewRulesets(gh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.summary, { created: 1, skipped: 0, errors: 0 });
    const post = calls.find(c => c.method === 'POST');
    assert.ok(post && post.path === '/repos/owner/repo-a/rulesets', 'POSTs the ruleset to the repo');
  });

  it('skips a repo that already has an active Copilot ruleset (live idempotency, no duplicate)', async () => {
    const posts = [];
    const gh = {
      paginate: async (path) => (path.endsWith('/rulesets') ? [{ id: 9, enforcement: 'active' }] : []),
      request: async (path, opts) => {
        if (opts?.method === 'POST') posts.push(path);
        if (path.match(/\/rulesets\/\d+$/)) return { id: 9, rules: [{ type: 'copilot_code_review' }] };
        return {};
      },
    };
    const result = await applyCopilotReviewRulesets(gh, 'owner', baseFindings, baseConfig, { dryRun: false });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.summary, { created: 0, skipped: 1, errors: 0 });
    assert.equal(posts.length, 0, 'must not POST a duplicate ruleset');
  });

  it('isolates a per-repo write error and continues to the next repo', async () => {
    const findings = [{ type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['repo-a', 'repo-b'] }];
    const gh = {
      paginate: async () => [],
      request: async (path, opts) => {
        if (opts?.method === 'POST' && path.includes('/repo-a/')) throw new Error('403 administration: write required');
        return {};
      },
    };
    const result = await applyCopilotReviewRulesets(gh, 'owner', findings, baseConfig, { dryRun: false });
    assert.deepEqual(result.summary, { created: 1, skipped: 0, errors: 1 });
  });

  it('scheduled run skips: code-review-bot is not on the apply-schedule allow-list', async () => {
    const gh = { paginate: async () => [], request: async () => ({}) };
    const result = await applyCopilotReviewRulesets(gh, 'owner', baseFindings, baseConfig, { dryRun: false, scheduled: true });
    assert.equal(result.status, 'skipped-unscheduled');
  });

  it('scheduled run acts when code-review-bot is allow-listed', async () => {
    const gh = { paginate: async () => [], request: async () => ({}) };
    const config = { limits: { require_approval: true }, 'apply-schedule': { 'code-review-bot': true } };
    const result = await applyCopilotReviewRulesets(gh, 'owner', baseFindings, config, { dryRun: true, scheduled: true });
    assert.equal(result.status, 'dry-run');
  });
});

describe('findButlerCopilotRuleset / removeCopilotReviewRuleset', () => {
  it('finds the butler ruleset id by its distinctive name', async () => {
    const gh = { paginate: async () => [{ id: 3, name: 'other' }, { id: 5, name: COPILOT_RULESET_NAME }], request: async () => ({}) };
    assert.equal(await findButlerCopilotRuleset(gh, 'owner', 'repo-a'), 5);
  });

  it('returns null when no butler ruleset is present', async () => {
    const gh = { paginate: async () => [{ id: 3, name: 'other' }], request: async () => ({}) };
    assert.equal(await findButlerCopilotRuleset(gh, 'owner', 'repo-a'), null);
  });

  it('deletes only the butler-named ruleset', async () => {
    const calls = [];
    const gh = {
      paginate: async () => [{ id: 5, name: COPILOT_RULESET_NAME }],
      request: async (path, opts) => {
        calls.push({ path, method: opts?.method });
        if (path.endsWith('/rulesets/5') && opts?.method !== 'DELETE') return { id: 5, name: COPILOT_RULESET_NAME, rules: [] };
        return {};
      },
    };
    const result = await removeCopilotReviewRuleset(gh, 'owner', 'repo-a');
    assert.equal(result.status, 'removed');
    assert.ok(calls.some(c => c.method === 'DELETE' && c.path === '/repos/owner/repo-a/rulesets/5'));
  });

  it('skips deletion when no butler ruleset is present', async () => {
    const gh = { paginate: async () => [{ id: 5, name: 'someone-elses-ruleset' }], request: async () => ({}) };
    const result = await removeCopilotReviewRuleset(gh, 'owner', 'repo-a');
    assert.equal(result.status, 'skipped');
  });

  it('returns a structured error (does not throw) when a delete API call fails', async () => {
    const gh = {
      paginate: async () => [{ id: 5, name: COPILOT_RULESET_NAME }],
      request: async (path, opts) => {
        if (opts?.method === 'DELETE') throw new Error('500 server error');
        if (path.endsWith('/rulesets/5')) return { id: 5, name: COPILOT_RULESET_NAME, rules: [] };
        return {};
      },
    };
    const result = await removeCopilotReviewRuleset(gh, 'owner', 'repo-a');
    assert.equal(result.status, 'error');
    assert.match(result.error, /500/);
  });

  it('refuses to delete when the detail name does not match (defensive double-guard)', async () => {
    const deletes = [];
    const gh = {
      paginate: async () => [{ id: 5, name: COPILOT_RULESET_NAME }],
      request: async (path, opts) => {
        if (opts?.method === 'DELETE') { deletes.push(path); return {}; }
        if (path.endsWith('/rulesets/5')) return { id: 5, name: 'tampered', rules: [] };
        return {};
      },
    };
    const result = await removeCopilotReviewRuleset(gh, 'owner', 'repo-a');
    assert.equal(result.status, 'skipped');
    assert.equal(deletes.length, 0, 'never DELETEs a non-butler-named ruleset');
  });
});

describe('isAutoMergeAllowed', () => {
  it('true only when the tool is BOTH allow-listed AND a deterministic template tool', () => {
    assert.equal(isAutoMergeAllowed({ 'dependabot-actions': true }, 'dependabot-actions'), true);
    assert.equal(isAutoMergeAllowed({ 'dependabot-actions': 'true' }, 'dependabot-actions'), true, 'tolerates quoted true');
    assert.equal(isAutoMergeAllowed({ 'code-scanning': true }, 'dependabot-actions'), false, 'not in allow-list');
    assert.equal(isAutoMergeAllowed({ 'dependabot-actions': false }, 'dependabot-actions'), false);
    assert.equal(isAutoMergeAllowed({}, 'dependabot-actions'), false);
    assert.equal(isAutoMergeAllowed(undefined, 'dependabot-actions'), false);
  });

  it('excludes non-template classes even when explicitly allow-listed', () => {
    // settings write — no file PR exists to merge
    assert.equal(isAutoMergeAllowed({ 'code-review-bot': true }, 'code-review-bot'), false);
    // the stale-PR nudge — not a templated PR
    assert.equal(isAutoMergeAllowed({ 'dependabot-rebase': true }, 'dependabot-rebase'), false);
    // an arbitrary unknown tool
    assert.equal(isAutoMergeAllowed({ 'made-up': true }, 'made-up'), false);
  });
});

describe('autoMergeGovernancePRs', () => {
  const cfg = (automerge = {}) => ({ limits: { require_approval: true }, 'apply-automerge': automerge });
  const findings = [
    { type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-a'] },
    { type: 'standards-gap', tool: 'code-scanning', nonCompliant: ['repo-b'] },
  ];

  // Mock client: `open` maps "<repo>:<tool>" → array of open apply PRs.
  // `detailBody` is the PR-detail body returned by request(); defaults to a string
  // carrying the butler marker so the identity guard passes for legit PRs.
  function mkGh({ open = {}, green = true, mergeable = true, mergeConfirmed = true, detailBody = `templated apply PR\n*${APPLY_PR_MARKER}(...)*`, merges = [] } = {}) {
    return {
      paginate: async (path, opts) => {
        const head = opts?.params?.head || '';
        const tool = (head.match(/repo-butler\/apply-(.+)$/) || [])[1] || null;
        const repo = (path.match(/\/repos\/[^/]+\/([^/]+)\/pulls/) || [])[1] || null;
        const prs = open[`${repo}:${tool}`] || [];
        // Mirror GitHub: returned PRs carry head.ref = the queried branch unless
        // the fixture sets its own ref (used to exercise the branch-ref guard).
        return prs.map(p => ({ ...p, head: { ...(p.head || {}), ref: p.head?.ref ?? `repo-butler/apply-${tool}` } }));
      },
      request: async () => ({ mergeable, body: detailBody }),
      prCiGreen: async () => green,
      mergePR: async (owner, repo, number, mopts) => {
        merges.push({ repo, number, ...mopts });
        return { merged: mergeConfirmed, sha: mergeConfirmed ? 'sha-merged' : undefined };
      },
    };
  }

  it('empty apply-automerge → no merges (default-closed)', async () => {
    const merges = [];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({}), { dryRun: false });
    assert.equal(r.summary.merged, 0);
    assert.equal(merges.length, 0);
  });

  it('merges only the allow-listed template class; leaves other apply PRs untouched', async () => {
    const merges = [];
    const gh = mkGh({
      open: {
        'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }],
        'repo-b:code-scanning': [{ number: 9, head: { sha: 'h9' } }],
      },
      merges,
    });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(r.summary.merged, 1);
    assert.equal(merges.length, 1);
    assert.equal(merges[0].repo, 'repo-a');
    assert.equal(merges[0].number, 7);
    assert.equal(merges[0].method, 'squash');
    assert.ok(!merges.some(m => m.number === 9), 'code-scanning PR is not allow-listed and must be left open');
  });

  it('records the merge SHA in the result', async () => {
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] } });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    const merged = r.results.find(x => x.status === 'merged');
    assert.equal(merged.mergeSha, 'sha-merged');
    assert.equal(merged.number, 7);
  });

  it('skips (does not merge) a PR whose CI is not green', async () => {
    const merges = [];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, green: false, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(r.summary.merged, 0);
    assert.equal(merges.length, 0);
    assert.equal(r.results[0].status, 'skipped');
    assert.match(r.results[0].reason, /CI not green/);
  });

  it('skips a PR GitHub reports as not mergeable', async () => {
    const merges = [];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, mergeable: false, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(merges.length, 0);
    assert.match(r.results[0].reason, /not mergeable/);
  });

  it('skips when there is no open apply PR for an allow-listed class', async () => {
    const gh = mkGh({ open: {} });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(r.summary.merged, 0);
    assert.equal(r.results[0].status, 'skipped');
    assert.match(r.results[0].reason, /no open apply PR/);
  });

  it('never eligible: an agent-executor finding for a template tool', async () => {
    const merges = [];
    const agentFindings = [{ type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['repo-a'], remediation: { executor: 'agent' } }];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', agentFindings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(r.summary.merged, 0);
    assert.equal(merges.length, 0);
  });

  it('never eligible: a non-template tool even if allow-listed', async () => {
    const merges = [];
    const nonTmpl = [{ type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['repo-a'] }];
    const gh = mkGh({ open: { 'repo-a:code-review-bot': [{ number: 7, head: { sha: 'h7' } }] }, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', nonTmpl, cfg({ 'code-review-bot': true }), { dryRun: false });
    assert.equal(r.summary.merged, 0);
    assert.equal(merges.length, 0);
  });

  it('refuses when require_approval is not true (system-wide kill switch)', async () => {
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] } });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, { limits: { require_approval: false }, 'apply-automerge': { 'dependabot-actions': true } }, { dryRun: false });
    assert.equal(r.status, 'refused');
  });

  it('dry-run fail-closed: reports the would-merge set, performs no merge', async () => {
    const merges = [];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: true });
    assert.equal(r.status, 'dry-run');
    assert.equal(merges.length, 0);
    assert.equal(r.summary.wouldMerge, 1);
    assert.equal(r.results.find(x => x.status === 'would-merge').number, 7);
  });

  it('dry-run is fail-closed for a non-false value (empty string)', async () => {
    const merges = [];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: '' });
    assert.equal(r.status, 'dry-run');
    assert.equal(merges.length, 0);
  });

  it('caps merges per tool via apply-cap / global cap', async () => {
    const merges = [];
    const manyFindings = [{ type: 'standards-gap', tool: 'dependabot-actions', nonCompliant: ['r1', 'r2', 'r3'] }];
    const open = {
      'r1:dependabot-actions': [{ number: 1, head: { sha: 's1' } }],
      'r2:dependabot-actions': [{ number: 2, head: { sha: 's2' } }],
      'r3:dependabot-actions': [{ number: 3, head: { sha: 's3' } }],
    };
    const gh = mkGh({ open, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', manyFindings, cfg({ 'dependabot-actions': true }), { dryRun: false, maxPerRun: 2 });
    assert.equal(r.summary.merged, 2, 'global cap of 2 bounds the merge count');
    assert.equal(merges.length, 2);
  });

  it('skips a PR whose mergeable is null (GitHub still computing)', async () => {
    const merges = [];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, mergeable: null, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(merges.length, 0);
    assert.equal(r.summary.merged, 0);
    assert.match(r.results[0].reason, /not mergeable/);
  });

  it('records an error (not a merge) when the merge API does not confirm', async () => {
    const merges = [];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, mergeConfirmed: false, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(merges.length, 1, 'the merge was attempted');
    assert.equal(r.summary.merged, 0);
    assert.equal(r.summary.errors, 1);
    assert.match(r.results[0].error, /not confirmed/);
  });

  it('does not merge a PR whose head branch is not the butler apply branch (write-path guard)', async () => {
    const merges = [];
    // A PR returned by the head filter but whose actual head.ref differs (e.g. a
    // collision or an API edge case) must not be merged.
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7', ref: 'someone-elses-branch' } }] }, merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(merges.length, 0, 'never merges a PR off the expected branch');
    assert.equal(r.results[0].status, 'skipped');
    assert.match(r.results[0].reason, /no open apply PR/);
  });

  it('does not merge a PR lacking the butler body marker (identity guard)', async () => {
    const merges = [];
    // A PR on the expected branch but whose body lacks the butler marker (e.g. a
    // human opened it from a colliding branch name) must not be auto-merged.
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, detailBody: 'hand-written PR, not the butler', merges });
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(merges.length, 0);
    assert.equal(r.results[0].status, 'skipped');
    assert.match(r.results[0].reason, /not a butler apply PR/);
  });

  it('treats a 409 from mergePR as skip (head advanced), not an error', async () => {
    const merges = [];
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] }, merges });
    gh.mergePR = async () => { throw new Error('GitHub API PUT /repos/owner/repo-a/pulls/7/merge: 409 head changed'); };
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(r.summary.errors, 0, '409 is not an error');
    assert.equal(r.summary.merged, 0);
    assert.equal(r.results[0].status, 'skipped');
    assert.equal(r.results[0].number, 7, 'PR number recorded for auditability');
    assert.match(r.results[0].reason, /409/);
  });

  it('surfaces a paginate failure as an error (no longer swallowed)', async () => {
    const gh = mkGh({ open: { 'repo-a:dependabot-actions': [{ number: 7, head: { sha: 'h7' } }] } });
    gh.paginate = async () => { throw new Error('GitHub API GET /pulls: 500 boom'); };
    const r = await autoMergeGovernancePRs(gh, 'owner', findings, cfg({ 'dependabot-actions': true }), { dryRun: false });
    assert.equal(r.summary.errors, 1);
    assert.equal(r.results[0].status, 'error');
  });
});
