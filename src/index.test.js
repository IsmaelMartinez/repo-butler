import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runPhases, parsePhases, validateRepoFormat, getPipelineState } from './index.js';

describe('parsePhases', () => {
  it('splits a comma list and trims whitespace', () => {
    assert.deepEqual(parsePhases('observe, assess , report'), ['observe', 'assess', 'report']);
  });

  it('throws on unknown phases', () => {
    assert.throws(() => parsePhases('observe,nonsense'), /Unknown phase/);
  });
});

describe('validateRepoFormat', () => {
  it('accepts owner/name', () => {
    assert.doesNotThrow(() => validateRepoFormat('foo/bar'));
  });
  it('rejects bare names', () => {
    assert.throws(() => validateRepoFormat('foo'));
  });
});

describe('runPhases', () => {
  let originalExitCode;
  let originalLog;
  let originalError;

  before(() => {
    originalExitCode = process.exitCode;
    originalLog = console.log;
    originalError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  after(() => {
    process.exitCode = originalExitCode;
    console.log = originalLog;
    console.error = originalError;
  });

  beforeEach(() => {
    process.exitCode = 0;
  });

  it('runs every phase when none throw', async () => {
    const calls = [];
    const runners = {
      observe: async () => { calls.push('observe'); },
      report: async () => { calls.push('report'); },
    };
    const results = await runPhases(['observe', 'report'], {}, null, null, runners);
    assert.deepEqual(calls, ['observe', 'report']);
    assert.deepEqual(results.map(r => r.status), ['ok', 'ok']);
    assert.equal(process.exitCode, 0);
  });

  it('continues to the next phase when an earlier phase throws', async () => {
    const calls = [];
    const runners = {
      governance: async () => { calls.push('governance'); throw new Error('boom'); },
      report: async () => { calls.push('report'); },
    };
    const results = await runPhases(['governance', 'report'], {}, null, null, runners);
    assert.deepEqual(calls, ['governance', 'report']);
    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].error.message, 'boom');
    assert.equal(results[1].status, 'ok');
  });

  it('sets process.exitCode = 1 when any phase fails', async () => {
    const runners = {
      governance: async () => { throw new Error('boom'); },
      report: async () => {},
    };
    await runPhases(['governance', 'report'], {}, null, null, runners);
    assert.equal(process.exitCode, 1);
  });

  it('records an unknown-phase failure and continues the loop', async () => {
    const calls = [];
    const runners = {
      report: async () => { calls.push('report'); },
    };
    const results = await runPhases(['nonsense', 'report'], {}, null, null, runners);
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error.message, /Unknown phase/);
    assert.deepEqual(calls, ['report']);
    assert.equal(results[1].status, 'ok');
    assert.equal(process.exitCode, 1);
  });

  it('records duration for each phase', async () => {
    const runners = {
      observe: async () => { await new Promise(r => setTimeout(r, 5)); },
    };
    const results = await runPhases(['observe'], {}, null, null, runners);
    assert.equal(results[0].status, 'ok');
    assert.ok(results[0].durationMs >= 0);
  });

  it('exposes pipeline state for the exit-handler diagnostic', async () => {
    const runners = {
      observe: async () => {
        const mid = getPipelineState();
        assert.equal(mid.activePhase, 'observe');
      },
      report: async () => {},
    };
    await runPhases(['observe', 'report'], {}, null, null, runners);
    const finalState = getPipelineState();
    assert.equal(finalState.activePhase, null);
    assert.deepEqual(finalState.results.map(r => `${r.phase}=${r.status}`), ['observe=ok', 'report=ok']);
  });
});
