// Characterisation tests for the APPLY phase wrapper (runApply), driven through
// the public runPhases entry point so they hold whether runApply lives in
// index.js or in its own module. They pin which finding classes a dispatch
// invokes, how INPUT_DRY_RUN / INPUT_SCHEDULED / INPUT_MAX_APPLY_PER_RUN are
// read, what lands in GITHUB_OUTPUT, and how per-class errors fail the phase.
//
// Invocation probe: with `limits.apply_enabled` not the boolean true, every
// apply class refuses on its first line and logs `<label>: config.limits...`,
// making no API call. The set of labels logged is therefore exactly the set of
// classes runApply dispatched.
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPhases } from './index.js';
import { resolveDependabotSecurityDispatch, isLockfileUpdateRequested } from './apply-run.js';

const ENV_KEYS = ['INPUT_TOOLS', 'INPUT_DRY_RUN', 'INPUT_SCHEDULED', 'INPUT_AUTOMERGE', 'INPUT_MAX_APPLY_PER_RUN', 'GITHUB_OUTPUT'];

const FINDINGS = [
  { type: 'standards-gap', tool: 'security-md', nonCompliant: ['r1'], compliant: [] },
  { type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['r2'], compliant: [], remediation: { executor: 'settings' } },
  { type: 'dependabot-stale', repo: 'r3', stalePRs: [{ number: 7, age: 40, title: 'bump x' }] },
  { type: 'open-vulnerability', repo: 'r4', sources: ['dependabot'] },
  {
    type: 'stalled-alert',
    repo: 'r5',
    alerts: [
      { number: 9, ecosystem: 'npm', classification: 'reachable-by-update', package: 'lodash', manifestPath: 'package-lock.json' },
      { number: 10, ecosystem: 'npm', classification: 'reachable-by-update', package: 'lodash', manifestPath: 'web/package-lock.json' },
    ],
  },
];

const REFUSING = { limits: { apply_enabled: false } };
const APPROVED = { limits: { apply_enabled: true }, 'apply-automerge': { 'security-md': true } };

let savedEnv;
let savedExitCode;
let outDir;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  outDir = mkdtempSync(join(tmpdir(), 'apply-run-test-'));
});

afterEach(() => {
  mock.restoreAll();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  process.exitCode = savedExitCode;
  rmSync(outDir, { recursive: true, force: true });
});

// GET /rulesets → [] and GET /automated-security-fixes → off, so the Copilot and
// Dependabot-security classes get past their fail-closed reads and reach a
// write; every other request 404s, which each class records as a per-repo error.
function fakeFetch(calls) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && /\/rulesets(\?|$)/.test(url)) return json(200, []);
    if (method === 'GET' && /\/automated-security-fixes$/.test(url)) return json(200, { enabled: false, paused: false });
    return json(404, { message: 'Not Found' });
  };
}

async function runApplyPhase({ env = {}, findings = FINDINGS, config = REFUSING, store, output = true } = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const outFile = join(outDir, 'github_output');
  if (output) {
    writeFileSync(outFile, '');
    process.env.GITHUB_OUTPUT = outFile;
  }
  const errLines = [];
  const logLines = [];
  const fetchCalls = [];
  mock.method(console, 'error', (...a) => errLines.push(a.join(' ')));
  mock.method(console, 'log', (...a) => logLines.push(a.join(' ')));
  mock.method(console, 'warn', (...a) => logLines.push(a.join(' ')));
  mock.method(globalThis, 'fetch', fakeFetch(fetchCalls));
  const context = {
    owner: 'o',
    token: 't',
    config,
    store: store === undefined ? { readGovernanceFindings: async () => findings } : store,
  };
  const [result] = await runPhases(['apply'], context, null, null);
  const exitCode = process.exitCode;
  mock.restoreAll();
  const invoked = new Set(
    errLines
      .map(l => /^(\S+): config\.limits\.apply_enabled is not the boolean true/.exec(l)?.[1])
      .filter(Boolean),
  );
  return {
    result,
    exitCode,
    errLines,
    logLines,
    fetchCalls,
    invoked,
    output: output ? readFileSync(outFile, 'utf8') : null,
  };
}

const sorted = set => [...set].sort();

describe('runApply: which classes a dispatch invokes', () => {
  const cases = [
    // [description, env, expected invoked classes]
    ['blank tools, manual: templated apply, nudge, copilot, dependabot-security', {},
      ['apply', 'copilot-review', 'dependabot-security', 'nudge']],
    ['blank tools, scheduled: never dependabot-security/-off; lockfile offered; no automerge without INPUT_AUTOMERGE', { INPUT_SCHEDULED: 'true' },
      ['apply', 'copilot-review', 'lockfile-update', 'nudge']],
    ['blank tools, scheduled cron (INPUT_AUTOMERGE=true): adds automerge only', { INPUT_SCHEDULED: 'true', INPUT_AUTOMERGE: 'true' },
      ['apply', 'automerge', 'copilot-review', 'lockfile-update', 'nudge']],
    ['blank tools, manual with INPUT_AUTOMERGE=true: env alone requests automerge', { INPUT_AUTOMERGE: 'true' },
      ['apply', 'automerge', 'copilot-review', 'dependabot-security', 'nudge']],
    ['INPUT_AUTOMERGE is exact: TRUE does not request automerge', { INPUT_AUTOMERGE: 'TRUE' },
      ['apply', 'copilot-review', 'dependabot-security', 'nudge']],
    ['INPUT_SCHEDULED is exact: TRUE reads as a manual run', { INPUT_SCHEDULED: 'TRUE' },
      ['apply', 'copilot-review', 'dependabot-security', 'nudge']],
    ['tools=dependabot-security, manual', { INPUT_TOOLS: 'dependabot-security' },
      ['apply', 'dependabot-security']],
    ['tools=dependabot-security, scheduled: fenced off', { INPUT_TOOLS: 'dependabot-security', INPUT_SCHEDULED: 'true' },
      ['apply']],
    ['tools=dependabot-security-off, manual', { INPUT_TOOLS: 'dependabot-security-off' },
      ['apply', 'dependabot-security-off']],
    ['tools=dependabot-security-off, scheduled: fenced off', { INPUT_TOOLS: 'dependabot-security-off', INPUT_SCHEDULED: 'true' },
      ['apply']],
    ['tools names both toggles: neither runs', { INPUT_TOOLS: 'dependabot-security,dependabot-security-off' },
      ['apply']],
    ['tools=lockfile-update, manual', { INPUT_TOOLS: 'lockfile-update' },
      ['apply', 'lockfile-update']],
    ['tools=lockfile-update, scheduled', { INPUT_TOOLS: 'lockfile-update', INPUT_SCHEDULED: 'true' },
      ['apply', 'lockfile-update']],
    ['tools=code-scanning, manual: templated apply only', { INPUT_TOOLS: 'code-scanning' },
      ['apply']],
    ['tools=code-scanning, scheduled: no lockfile dragged along', { INPUT_TOOLS: 'code-scanning', INPUT_SCHEDULED: 'true' },
      ['apply']],
    ['tools=dependabot-rebase, manual', { INPUT_TOOLS: 'dependabot-rebase' },
      ['apply', 'nudge']],
    ['tools=dependabot-rebase, scheduled', { INPUT_TOOLS: 'dependabot-rebase', INPUT_SCHEDULED: 'true' },
      ['apply', 'nudge']],
    ['tools=code-review-bot, manual', { INPUT_TOOLS: 'code-review-bot' },
      ['apply', 'copilot-review']],
    ['tools=code-review-bot, scheduled', { INPUT_TOOLS: 'code-review-bot', INPUT_SCHEDULED: 'true' },
      ['apply', 'copilot-review']],
    ['tools=automerge, manual', { INPUT_TOOLS: 'automerge' },
      ['apply', 'automerge']],
    ['tools=automerge, scheduled', { INPUT_TOOLS: 'automerge', INPUT_SCHEDULED: 'true' },
      ['apply', 'automerge']],
    ['tools list is trimmed and blanks dropped', { INPUT_TOOLS: ' dependabot-rebase , code-review-bot ,' },
      ['apply', 'copilot-review', 'nudge']],
  ];

  for (const [desc, env, expected] of cases) {
    it(desc, async () => {
      const { invoked, fetchCalls } = await runApplyPhase({ env });
      assert.deepEqual(sorted(invoked), expected);
      assert.equal(fetchCalls.length, 0, 'a refused class makes no API call');
    });
  }

  it('logs the contradiction when both toggles are named', async () => {
    const { errLines } = await runApplyPhase({ env: { INPUT_TOOLS: 'dependabot-security,dependabot-security-off' } });
    assert.ok(errLines.some(l => l.includes('names both dependabot-security and dependabot-security-off')));
  });

  it('no findings: invokes nothing', async () => {
    const { invoked, logLines, result } = await runApplyPhase({ findings: [] });
    assert.equal(invoked.size, 0);
    assert.ok(logLines.includes('No governance findings to apply.'));
    assert.equal(result.status, 'ok');
  });

  it('no store: invokes nothing', async () => {
    const { invoked, logLines } = await runApplyPhase({ store: null });
    assert.equal(invoked.size, 0);
    assert.ok(logLines.includes('No governance findings to apply.'));
  });
});

describe('runApply: options threaded to each class', () => {
  it('scheduled reaches apply, nudge, copilot and lockfile (each applies its allow-list)', async () => {
    const { logLines, output, fetchCalls } = await runApplyPhase({ env: { INPUT_SCHEDULED: 'true' }, config: APPROVED });
    assert.ok(logLines.some(l => l.startsWith('apply [scheduled]: 1 actionable finding(s) excluded')));
    assert.ok(logLines.includes('nudge [scheduled]: dependabot-rebase not on the apply-schedule allow-list — skipping'));
    assert.ok(logLines.includes('copilot-review [scheduled]: code-review-bot not on the apply-schedule allow-list — skipping'));
    assert.ok(logLines.includes('lockfile-update: [scheduled]: not on the apply-schedule allow-list — skipping'));
    assert.equal(output, 'lockfileUpdate={"status":"skipped-unscheduled","created":0,"skipped":0,"errors":0}\n');
    assert.equal(fetchCalls.length, 0);
  });

  const many = [{ type: 'standards-gap', tool: 'security-md', nonCompliant: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], compliant: [] }];
  for (const [raw, expected] of [[undefined, 5], ['2', 2], ['abc', 5], ['0', 5], ['3x', 3]]) {
    it(`INPUT_MAX_APPLY_PER_RUN=${raw} caps the run at ${expected}`, async () => {
      const env = { INPUT_TOOLS: 'security-md' };
      if (raw !== undefined) env.INPUT_MAX_APPLY_PER_RUN = raw;
      const { logLines } = await runApplyPhase({ env, findings: many, config: APPROVED });
      assert.ok(logLines.includes(`apply [DRY RUN]: up to ${expected} (repo, tool) pairs are candidates`), logLines.join('\n'));
    });
  }

  it('maxPerRun also reaches the copilot class', async () => {
    const findings = [{ type: 'standards-gap', tool: 'code-review-bot', nonCompliant: ['a', 'b', 'c'], compliant: [], remediation: { executor: 'settings' } }];
    const { logLines } = await runApplyPhase({ env: { INPUT_TOOLS: 'code-review-bot', INPUT_MAX_APPLY_PER_RUN: '2' }, findings, config: APPROVED });
    assert.ok(logLines.some(l => l.startsWith('copilot-review [DRY RUN]: would create the "repo-butler/copilot-code-review" ruleset on 2 repo(s)')));
  });
});

describe('runApply: INPUT_DRY_RUN parsing', () => {
  const findings = [FINDINGS[0]];
  for (const raw of [undefined, 'true', 'TRUE', 'False', '', 'no']) {
    it(`INPUT_DRY_RUN=${JSON.stringify(raw)} is a dry run: no API call, no summary line`, async () => {
      const env = { INPUT_TOOLS: 'security-md' };
      if (raw !== undefined) env.INPUT_DRY_RUN = raw;
      const { fetchCalls, result, output, exitCode } = await runApplyPhase({ env, findings, config: APPROVED });
      assert.equal(fetchCalls.length, 0);
      assert.equal(result.status, 'ok');
      assert.equal(output, '');
      assert.equal(exitCode, 0);
    });
  }

  // Some classes read live state in a dry run (the dependabot-security preview
  // does), so the property pinned here is "no write", plus each class's dry-run
  // summary shape (the `would*` keys) where it has one.
  const dryCases = [
    ['security-md,dependabot-rebase,code-review-bot,dependabot-security,lockfile-update,automerge', [
      'dependabotSecurity={"enabled":0,"skipped":0,"errors":0,"wouldEnable":1}',
      'lockfileUpdate={"created":0,"skipped":0,"errors":2,"wouldOpen":0}',
      'automerge={"merged":0,"skipped":0,"errors":1,"wouldMerge":0}',
    ]],
    ['dependabot-security-off', ['dependabotSecurityOff={"removed":0,"errors":0,"wouldRemove":1}']],
  ];
  for (const [tools, lines] of dryCases) {
    it(`a dry run reaches every class as dry: no write request (tools=${tools})`, async () => {
      const { fetchCalls, output } = await runApplyPhase({ env: { INPUT_TOOLS: tools }, config: APPROVED });
      assert.deepEqual(fetchCalls.filter(c => !c.startsWith('GET ')), []);
      assert.equal(output, lines.map(l => `${l}\n`).join(''));
    });
  }

  it('only the literal "false" goes live', async () => {
    const { fetchCalls, result } = await runApplyPhase({ env: { INPUT_TOOLS: 'security-md', INPUT_DRY_RUN: 'false' }, findings, config: APPROVED });
    assert.ok(fetchCalls.length > 0);
    assert.equal(result.status, 'failed');
  });
});

describe('runApply: GITHUB_OUTPUT and error reporting', () => {
  it('every class run live appends its summary line, in dispatch order, and every error fails the phase', async () => {
    const { result, output, exitCode } = await runApplyPhase({
      env: {
        INPUT_DRY_RUN: 'false',
        INPUT_TOOLS: 'security-md,dependabot-rebase,code-review-bot,dependabot-security,lockfile-update,automerge',
      },
      config: APPROVED,
    });
    assert.equal(output, [
      'apply={"created":0,"skipped":0,"errors":1}',
      'nudge={"nudged":0,"skipped":0,"escalated":0,"errors":1}',
      'copilotReview={"created":0,"skipped":0,"errors":1,"unreadable":0}',
      'dependabotSecurity={"enabled":0,"skipped":0,"errors":1}',
      'lockfileUpdate={"created":0,"skipped":0,"errors":2}',
      'automerge={"merged":0,"skipped":0,"errors":1}',
      '',
    ].join('\n'));
    assert.equal(result.status, 'failed');
    assert.equal(exitCode, 1);
    // Error order is fixed and differs from dispatch order: automerge before lockfile.
    assert.equal(result.error.message, [
      'apply: 1 per-repo error(s) [r1/security-md]; 0 PR(s) created, 0 skipped',
      'nudge: 1 error(s) [r3#7]; 0 rebased, 0 skipped',
      'copilot-review: 1 error(s) [r2]; 0 created, 0 skipped',
      'dependabot-security: 1 error(s) [r4]; 0 enabled, 0 skipped',
      'automerge: 1 error(s) [r1/security-md]; 0 merged, 0 skipped',
      'lockfile-update: 2 error(s) [r5, r5/web]; 0 PR(s) created, 0 skipped',
    ].join(' | '));
  });

  it('dependabot-security-off appends its line and reports its errors', async () => {
    const { result, output } = await runApplyPhase({
      env: { INPUT_DRY_RUN: 'false', INPUT_TOOLS: 'dependabot-security-off' },
      config: APPROVED,
    });
    assert.equal(output, 'apply={"created":0,"skipped":0,"errors":0}\ndependabotSecurityOff={"removed":0,"errors":1}\n');
    assert.equal(result.error.message, 'dependabot-security-off: 1 error(s) [r4]; 0 disabled');
  });

  it('a live run with no errors passes and still appends summaries', async () => {
    const { result, output, exitCode } = await runApplyPhase({
      env: { INPUT_DRY_RUN: 'false', INPUT_TOOLS: 'code-scanning' },
      config: APPROVED,
    });
    assert.equal(result.status, 'ok');
    assert.equal(exitCode, 0);
    assert.equal(output, 'apply={"created":0,"skipped":0,"errors":0}\n');
  });

  it('dry-run summaries that exist are still appended (dependabot-security preview)', async () => {
    const { output, result } = await runApplyPhase({ env: { INPUT_TOOLS: 'dependabot-security' }, config: APPROVED });
    assert.equal(result.status, 'ok');
    assert.equal(output, 'dependabotSecurity={"enabled":0,"skipped":0,"errors":0,"wouldEnable":1}\n');
  });

  it('without GITHUB_OUTPUT the errors still fail the phase', async () => {
    const { result } = await runApplyPhase({
      env: { INPUT_DRY_RUN: 'false', INPUT_TOOLS: 'security-md' },
      findings: [FINDINGS[0]],
      config: APPROVED,
      output: false,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.message, 'apply: 1 per-repo error(s) [r1/security-md]; 0 PR(s) created, 0 skipped');
  });
});

describe('isLockfileUpdateRequested (ADR-015 explicit-dispatch rule)', () => {
  it('never rides a blank manual run: a content-transformation write must be named', () => {
    assert.equal(isLockfileUpdateRequested([], false), false);
    assert.equal(isLockfileUpdateRequested(['code-scanning'], false), false);
  });

  it('runs on a manual dispatch that names it', () => {
    assert.equal(isLockfileUpdateRequested(['lockfile-update'], false), true);
    assert.equal(isLockfileUpdateRequested(['code-scanning', 'lockfile-update'], false), true);
  });

  it('is offered to a blank scheduled run, where the apply-schedule allow-list decides', () => {
    assert.equal(isLockfileUpdateRequested([], true), true);
  });

  it('respects tool scoping on the scheduled workflow: an explicit other tool does not drag it in', () => {
    assert.equal(isLockfileUpdateRequested(['code-scanning'], true), false);
    assert.equal(isLockfileUpdateRequested(['lockfile-update'], true), true);
  });

  it('tolerates a non-array tools value', () => {
    assert.equal(isLockfileUpdateRequested(undefined, false), false);
  });
});

describe('resolveDependabotSecurityDispatch (ADR-012 enable/disable mutual exclusion)', () => {
  it('blank tools → enable only (all actionable), never disable', () => {
    assert.deepEqual(resolveDependabotSecurityDispatch([], false), { conflict: false, enable: true, disable: false });
  });

  it('dependabot-security → enable only', () => {
    const r = resolveDependabotSecurityDispatch(['dependabot-security'], false);
    assert.equal(r.enable, true);
    assert.equal(r.disable, false);
    assert.equal(r.conflict, false);
  });

  it('dependabot-security-off → disable only (never on a blank run)', () => {
    const r = resolveDependabotSecurityDispatch(['dependabot-security-off'], false);
    assert.equal(r.disable, true);
    assert.equal(r.enable, false, 'the off tool is not the enable tool and is not blank');
  });

  it('naming BOTH is a contradictory dispatch → conflict, run neither (fail safe)', () => {
    const r = resolveDependabotSecurityDispatch(['dependabot-security', 'dependabot-security-off'], false);
    assert.deepEqual(r, { conflict: true, enable: false, disable: false });
  });

  it('a scheduled run resolves to neither toggle (both off the no-human path by construction)', () => {
    assert.deepEqual(resolveDependabotSecurityDispatch([], true), { conflict: false, enable: false, disable: false });
    assert.deepEqual(resolveDependabotSecurityDispatch(['dependabot-security-off'], true), { conflict: false, enable: false, disable: false });
  });

  it('an unrelated tool leaves both off (no blank-run enable)', () => {
    const r = resolveDependabotSecurityDispatch(['code-review-bot'], false);
    assert.equal(r.enable, false);
    assert.equal(r.disable, false);
  });
});

// runApply used to load apply.js through `try { await import() } catch`, which
// turned any load error into a logged skip and a green phase. A resolve hook in
// a child process swaps apply.js for a module that throws, but only when the
// importer is the APPLY wrapper (index.js before the move, apply-run.js after),
// so every other importer keeps the real module and only the wrapper's own load
// path is under test.
describe('runApply: a broken apply.js fails loudly', () => {
  it('the load error surfaces and the process exits non-zero', () => {
    const hooks = `export async function resolve(specifier, context, next) {
      if (specifier === './apply.js' && /[/]src[/](index|apply-run)[.]js$/.test(context.parentURL || '')) {
        return { url: 'data:text/javascript,throw new Error("apply-load-boom")', shortCircuit: true };
      }
      return next(specifier, context);
    }`;
    const register = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
    const script = `
      const { runPhases } = await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)});
      const store = { readGovernanceFindings: async () => [{ type: 'standards-gap' }] };
      const [r] = await runPhases(['apply'], { owner: 'o', token: 't', config: {}, store }, null, null);
      console.log('PHASE=' + r.status);
    `;
    const env = { ...process.env };
    for (const k of ENV_KEYS) delete env[k];
    const res = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e', script], { encoding: 'utf8', env });
    assert.notEqual(res.status, 0, res.stdout + res.stderr);
    // The stub exports nothing, so a static import fails at link time (a missing
    // named export) before the throw runs; either error is a loud load failure.
    assert.match(res.stderr, /apply-load-boom|module '\.\/apply\.js' does not provide an export/);
    assert.doesNotMatch(res.stdout, /PHASE=ok/);
  });
});
