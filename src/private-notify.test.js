import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrivateFindingsBody,
  notifyPrivateFindings,
  closeResolvedPrivateIssues,
} from './private-notify.js';

const TRACKING_TITLE = 'Repo Butler: open governance findings';

// Fake gh recording every call, so tests can assert both what was written and
// — just as importantly — that nothing was written when it shouldn't be.
function makeGh({ existingIssues = [], failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    paginate: async (path) => {
      calls.push({ kind: 'paginate', path });
      if (failOn && path.includes(failOn)) throw new Error(`boom ${path}`);
      return existingIssues;
    },
    request: async (path, opts = {}) => {
      calls.push({ kind: 'request', path, method: opts.method, body: opts.body });
      if (failOn && path.includes(failOn)) throw new Error(`boom ${path}`);
      return { number: 99, html_url: `https://github.com/${path}` };
    },
  };
}

const posts = calls => calls.filter(c => c.method === 'POST');
const patches = calls => calls.filter(c => c.method === 'PATCH');

describe('buildPrivateFindingsBody', () => {
  const findings = [
    { type: 'open-vulnerability', repo: 'value-punter', severity: 'high', detail: 'pillow 12.2.0 → 12.3.0' },
    { type: 'open-vulnerability', repo: 'value-punter', severity: 'medium', detail: 'setuptools 82.0.1 → 83.0.0' },
    { type: 'standards-gap', repo: 'value-punter', detail: 'no SECURITY.md' },
  ];

  it('names the repo and states the finding count', () => {
    const body = buildPrivateFindingsBody('value-punter', findings, '2026-07-26T18:00:00Z');
    assert.match(body, /`value-punter` is private/);
    assert.match(body, /\*\*3 open findings\*\*/);
    assert.match(body, /2026-07-26T18:00:00Z/);
  });

  it('singularises a lone finding', () => {
    const body = buildPrivateFindingsBody('r', [findings[0]], 'now');
    assert.match(body, /\*\*1 open finding\*\*/);
    assert.ok(!body.includes('1 open findings'));
  });

  it('groups by type and orders severities worst-first within a group', () => {
    const body = buildPrivateFindingsBody('value-punter', findings, 'now');
    assert.match(body, /## open-vulnerability \(2\)/);
    assert.match(body, /## standards-gap \(1\)/);
    assert.ok(body.indexOf('pillow') < body.indexOf('setuptools'),
      'high should be listed before medium');
  });

  it('falls back through detail, description and title before giving up', () => {
    const body = buildPrivateFindingsBody('r', [
      { type: 't', description: 'from description' },
      { type: 't', title: 'from title' },
      { type: 't' },
    ], 'now');
    assert.match(body, /from description/);
    assert.match(body, /from title/);
    assert.match(body, /\(no detail recorded\)/);
  });

  it('explains that the issue is rewritten rather than accumulated', () => {
    const body = buildPrivateFindingsBody('r', findings, 'now');
    assert.match(body, /rewritten in place/);
  });
});

describe('notifyPrivateFindings', () => {
  const priv = [{ type: 'open-vulnerability', repo: 'value-punter', private: true, severity: 'high', detail: 'pillow' }];

  it('writes nothing at all when there are no private findings', async () => {
    const gh = makeGh();
    const result = await notifyPrivateFindings(gh, 'alice', [
      { type: 'standards-gap', repo: 'public-repo' },
    ], { dryRun: false });

    assert.deepEqual(result, { notified: 0, created: 0, updated: 0, closed: 0, errors: 0 });
    assert.equal(gh.calls.length, 0, 'must not touch the API when nothing is private');
  });

  it('creates the tracking issue when none exists', async () => {
    const gh = makeGh({ existingIssues: [] });
    const result = await notifyPrivateFindings(gh, 'alice', priv, { dryRun: false });

    const created = posts(gh.calls);
    assert.equal(created.length, 1);
    assert.equal(created[0].path, '/repos/alice/value-punter/issues');
    assert.equal(created[0].body.title, TRACKING_TITLE);
    assert.match(created[0].body.body, /pillow/);
    assert.equal(result.created, 1);
    assert.equal(result.updated, 0);
  });

  it('rewrites the existing issue in place instead of opening a second one', async () => {
    const gh = makeGh({ existingIssues: [{ number: 7, title: TRACKING_TITLE }] });
    const result = await notifyPrivateFindings(gh, 'alice', priv, { dryRun: false });

    assert.equal(posts(gh.calls).length, 0, 'must not create a duplicate');
    const patched = patches(gh.calls);
    assert.equal(patched.length, 1);
    assert.equal(patched[0].path, '/repos/alice/value-punter/issues/7');
    assert.equal(result.updated, 1);
    assert.equal(result.created, 0);
  });

  it('ignores a pull request whose title happens to match', async () => {
    // GitHub's issues list includes PRs; matching one would PATCH a pull request.
    const gh = makeGh({ existingIssues: [{ number: 7, title: TRACKING_TITLE, pull_request: {} }] });
    await notifyPrivateFindings(gh, 'alice', priv, { dryRun: false });

    assert.equal(patches(gh.calls).length, 0, 'must not patch a PR');
    assert.equal(posts(gh.calls).length, 1, 'should create a real issue instead');
  });

  it('writes nothing in dry run but reports what it would do', async () => {
    const gh = makeGh();
    const result = await notifyPrivateFindings(gh, 'alice', priv, { dryRun: true });

    assert.equal(gh.calls.length, 0);
    assert.equal(result.notified, 1);
    assert.equal(result.created, 0);
  });

  it('defaults to dry run when the option is omitted', async () => {
    const gh = makeGh();
    await notifyPrivateFindings(gh, 'alice', priv);
    assert.equal(gh.calls.length, 0, 'must fail safe to dry run');
  });

  it('groups findings per repo so one issue never carries another repo\'s data', async () => {
    const gh = makeGh({ existingIssues: [] });
    await notifyPrivateFindings(gh, 'alice', [
      { type: 'x', repo: 'priv-one', private: true, detail: 'alpha-detail' },
      { type: 'x', repo: 'priv-two', private: true, detail: 'beta-detail' },
    ], { dryRun: false });

    const created = posts(gh.calls);
    assert.equal(created.length, 2);
    const one = created.find(c => c.path.includes('priv-one'));
    const two = created.find(c => c.path.includes('priv-two'));
    assert.match(one.body.body, /alpha-detail/);
    assert.ok(!one.body.body.includes('beta-detail'), 'priv-one issue leaked priv-two data');
    assert.ok(!two.body.body.includes('alpha-detail'), 'priv-two issue leaked priv-one data');
  });

  it('isolates a failure on one repo so the others still get notified', async () => {
    const gh = makeGh({ existingIssues: [], failOn: 'priv-broken' });
    const result = await notifyPrivateFindings(gh, 'alice', [
      { type: 'x', repo: 'priv-broken', private: true, detail: 'a' },
      { type: 'x', repo: 'priv-ok', private: true, detail: 'b' },
    ], { dryRun: false });

    assert.equal(result.errors, 1);
    assert.equal(result.notified, 1);
    assert.equal(posts(gh.calls).length, 1);
  });

  it('skips private findings with no repo rather than throwing', async () => {
    const gh = makeGh();
    const result = await notifyPrivateFindings(gh, 'alice', [{ type: 'x', private: true }], { dryRun: false });
    assert.equal(result.notified, 0);
    assert.equal(gh.calls.length, 0);
  });

  it('tolerates non-array input', async () => {
    const gh = makeGh();
    assert.equal((await notifyPrivateFindings(gh, 'alice', null, { dryRun: false })).notified, 0);
  });
});

describe('closeResolvedPrivateIssues', () => {
  it('closes the tracking issue for a private repo that now has no findings', async () => {
    const gh = makeGh({ existingIssues: [{ number: 12, title: TRACKING_TITLE }] });
    const closed = await closeResolvedPrivateIssues(gh, 'alice', ['value-punter'], [], { dryRun: false });

    assert.equal(closed, 1);
    const patched = patches(gh.calls);
    assert.equal(patched[0].path, '/repos/alice/value-punter/issues/12');
    assert.equal(patched[0].body.state, 'closed');
  });

  it('leaves the issue open while the repo still has findings', async () => {
    const gh = makeGh({ existingIssues: [{ number: 12, title: TRACKING_TITLE }] });
    const closed = await closeResolvedPrivateIssues(gh, 'alice', ['value-punter'], [
      { repo: 'value-punter', private: true, type: 'x' },
    ], { dryRun: false });

    assert.equal(closed, 0);
    assert.equal(gh.calls.length, 0);
  });

  it('is a no-op when the clean repo has no tracking issue', async () => {
    const gh = makeGh({ existingIssues: [] });
    assert.equal(await closeResolvedPrivateIssues(gh, 'alice', ['value-punter'], [], { dryRun: false }), 0);
    assert.equal(patches(gh.calls).length, 0);
  });

  it('writes nothing in dry run', async () => {
    const gh = makeGh({ existingIssues: [{ number: 12, title: TRACKING_TITLE }] });
    assert.equal(await closeResolvedPrivateIssues(gh, 'alice', ['value-punter'], [], { dryRun: true }), 0);
    assert.equal(gh.calls.length, 0);
  });

  it('defaults to dry run when the option is omitted', async () => {
    const gh = makeGh({ existingIssues: [{ number: 12, title: TRACKING_TITLE }] });
    assert.equal(await closeResolvedPrivateIssues(gh, 'alice', ['value-punter'], []), 0);
    assert.equal(gh.calls.length, 0);
  });

  it('does nothing for an empty or missing private repo list', async () => {
    const gh = makeGh();
    assert.equal(await closeResolvedPrivateIssues(gh, 'alice', [], [], { dryRun: false }), 0);
    assert.equal(await closeResolvedPrivateIssues(gh, 'alice', null, [], { dryRun: false }), 0);
    assert.equal(gh.calls.length, 0);
  });
});
