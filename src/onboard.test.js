import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We can't easily test the full onboard flow (requires GitHub API), but we
// can verify the module exports and the content generation logic.
import { onboard, onboardRepo, hasOnboardingMarker, MARKER, ONBOARD_DECLINE_COOLDOWN_DAYS } from './onboard.js';

describe('onboard', () => {
  it('exports an onboard function', () => {
    assert.equal(typeof onboard, 'function');
  });

  it('skips repos with invalid format', async () => {
    // Pass a mock token — the function will fail on API calls but should
    // skip invalid repo names before reaching the API.
    const results = await onboard('fake-token', ['invalid-no-slash']);
    assert.equal(results.length, 0);
  });

  it('rejects repo names with shell-meta or backticks and warns', async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => { warnings.push(String(msg)); };
    try {
      const badNames = [
        'owner/repo`whoami`',
        'owner/repo$(id)',
        'owner/repo;ls',
        'owner/repo with space',
        'owner/repo|pipe',
      ];
      const results = await onboard('fake-token', badNames);
      // None should reach the API — all must be filtered before onboardRepo runs.
      assert.equal(results.length, 0, 'all unsafe repo names must be skipped');
      // Each unsafe name should produce a warning naming the offending repo.
      for (const name of badNames) {
        assert.ok(
          warnings.some(w => w.includes(name)),
          `expected warning for ${name}, got: ${warnings.join(' | ')}`,
        );
      }
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('hasOnboardingMarker (G9 cross-repo precondition)', () => {
  const gh = (impl) => ({ getFileContent: impl });

  it('returns true when CLAUDE.md contains the repo-butler marker', async () => {
    assert.equal(await hasOnboardingMarker(gh(async () => `# CLAUDE.md\n\n${MARKER} consumer guide`), 'o', 'r'), true);
  });

  it('returns false when CLAUDE.md exists but lacks the marker', async () => {
    assert.equal(await hasOnboardingMarker(gh(async () => '# CLAUDE.md\n\nnothing here'), 'o', 'r'), false);
  });

  it('returns false when CLAUDE.md is missing (getFileContent returns null)', async () => {
    assert.equal(await hasOnboardingMarker(gh(async () => null), 'o', 'r'), false);
  });

  it('fails closed (false) when the read throws', async () => {
    assert.equal(await hasOnboardingMarker(gh(async () => { throw new Error('403'); }), 'o', 'r'), false);
  });
});

describe('onboardRepo decline and unreadable-file guards', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (d) => new Date(Date.now() - d * DAY).toISOString();
  const notFound = () => { throw new Error('GitHub API GET /repos/o/r/contents/CLAUDE.md: 404 Not Found'); };
  const b64 = (s) => Buffer.from(s).toString('base64');

  // A client double that records every write. `file` is the contents-API
  // response for CLAUDE.md and `prs` the branch's PR history — both functions
  // so a test can make the read throw.
  function fakeGh({ file = notFound, prs = () => [], refPost = () => ({}) } = {}) {
    const writes = [];
    const puts = [];
    let historyParams, contentsRef, branchSha;
    return {
      writes, puts,
      get historyParams() { return historyParams; },
      get contentsRef() { return contentsRef; },
      get branchSha() { return branchSha; },
      async paginate(path, opts) { historyParams = opts?.params; return prs(); },
      async request(path, opts = {}) {
        const method = opts.method ?? 'GET';
        if (method !== 'GET') writes.push(`${method} ${path}`);
        if (method === 'GET' && path.endsWith('/contents/CLAUDE.md')) { contentsRef = opts.params?.ref; return file(); }
        if (method === 'GET' && path === '/repos/o/r') return { default_branch: 'main' };
        if (method === 'GET' && path.includes('/git/ref/heads/')) return { object: { sha: 'head-sha' } };
        if (method === 'POST' && path.endsWith('/git/refs')) { branchSha = opts.body.sha; return refPost(); }
        if (method === 'POST' && path.endsWith('/pulls')) return { html_url: 'https://github.com/o/r/pull/9' };
        return {};
      },
      async putFile(owner, repo, filePath, content, opts) { puts.push({ filePath, content, ...opts }); },
    };
  }

  it('reads the branch PR history with state: all', async () => {
    const gh = fakeGh();
    await onboardRepo(gh, 'o', 'r');
    assert.equal(gh.historyParams.state, 'all');
  });

  it('skips a PR closed unmerged within the cooldown, with no write', async () => {
    const gh = fakeGh({ prs: () => [{ number: 3, state: 'closed', merged_at: null, closed_at: daysAgo(2) }] });
    const result = await onboardRepo(gh, 'o', 'r');
    assert.deepEqual(result, { status: 'skipped', reason: 'recently declined' });
    assert.deepEqual(gh.writes, []);
    assert.equal(gh.puts.length, 0);
  });

  it('proceeds when the decline is older than the cooldown', async () => {
    const gh = fakeGh({ prs: () => [{ number: 3, state: 'closed', merged_at: null, closed_at: daysAgo(ONBOARD_DECLINE_COOLDOWN_DAYS + 1) }] });
    const result = await onboardRepo(gh, 'o', 'r');
    assert.equal(result.status, 'created');
    assert.equal(gh.puts.length, 1);
  });

  it('proceeds when the earlier onboarding PR was merged (re-onboarding is legitimate)', async () => {
    const gh = fakeGh({ prs: () => [{ number: 1, state: 'closed', merged_at: daysAgo(1), closed_at: daysAgo(1) }] });
    const result = await onboardRepo(gh, 'o', 'r');
    assert.equal(result.status, 'created');
  });

  it('skips when a PR is not definitively closed, including a missing state', async () => {
    for (const state of ['open', undefined]) {
      const gh = fakeGh({ prs: () => [{ number: 4, state, html_url: 'u' }] });
      const result = await onboardRepo(gh, 'o', 'r');
      assert.equal(result.status, 'skipped', `state ${state}`);
      assert.equal(result.reason, 'PR already open');
      assert.deepEqual(gh.writes, []);
    }
  });

  it('reports error and writes nothing when the PR history read throws', async () => {
    const gh = fakeGh({ prs: () => { throw new Error('GitHub API GET /repos/o/r/pulls: 403'); } });
    const result = await onboardRepo(gh, 'o', 'r');
    assert.deepEqual(result, { status: 'error', reason: 'PR history unreadable' });
    assert.deepEqual(gh.writes, []);
    assert.equal(gh.puts.length, 0);
  });

  it('refuses, with no PUT, when CLAUDE.md exists (sha present) but its content is unreadable', async () => {
    // The over-1 MB contents-API shape: sha present, encoding "none", no content.
    const gh = fakeGh({ file: () => ({ sha: 'file-sha', encoding: 'none', content: '' }) });
    const result = await onboardRepo(gh, 'o', 'r');
    assert.deepEqual(result, { status: 'error', reason: 'CLAUDE.md unreadable' });
    assert.deepEqual(gh.writes, []);
    assert.equal(gh.puts.length, 0);
  });

  it('refuses, with no write, when the CLAUDE.md read fails for a reason other than 404', async () => {
    const gh = fakeGh({ file: () => { throw new Error('GitHub API GET /repos/o/r/contents/CLAUDE.md: 500'); } });
    const result = await onboardRepo(gh, 'o', 'r');
    assert.deepEqual(result, { status: 'error', reason: 'CLAUDE.md unreadable' });
    assert.deepEqual(gh.writes, []);
    assert.equal(gh.puts.length, 0);
  });

  it('does not read a non-404 error whose body mentions ": 404" as an absent file', async () => {
    // github.js formats errors as `…<path>: <status> <body>`, and the body is
    // server-controlled — only the status right after the path means absence.
    for (const message of [
      'GitHub API GET /repos/o/r/contents/CLAUDE.md: 500 {"message":"upstream said: 404"}',
      'GitHub API GET /repos/o/r/contents/CLAUDE.md: 403 proxy: 404 page',
    ]) {
      const gh = fakeGh({ file: () => { throw new Error(message); } });
      const result = await onboardRepo(gh, 'o', 'r');
      assert.deepEqual(result, { status: 'error', reason: 'CLAUDE.md unreadable' }, message);
      assert.deepEqual(gh.writes, []);
      assert.equal(gh.puts.length, 0);
    }
  });

  it('skips a repo whose CLAUDE.md already carries the marker', async () => {
    const gh = fakeGh({ file: () => ({ sha: 's', encoding: 'base64', content: b64(`# CLAUDE.md\n\n${MARKER}\n`) }) });
    assert.deepEqual(await onboardRepo(gh, 'o', 'r'), { status: 'skipped', reason: 'already onboarded' });
    assert.deepEqual(gh.writes, []);
  });

  it('appends to an existing CLAUDE.md and passes its sha to putFile', async () => {
    const gh = fakeGh({ file: () => ({ sha: 'file-sha', encoding: 'base64', content: b64('# Mine\n\nkeep me\n') }) });
    const result = await onboardRepo(gh, 'o', 'r');
    assert.equal(result.status, 'created');
    assert.equal(gh.puts[0].sha, 'file-sha');
    assert.equal(gh.puts[0].branch, 'repo-butler/onboard');
    assert.ok(gh.puts[0].content.startsWith('# Mine\n\nkeep me\n'));
    assert.ok(gh.puts[0].content.includes(MARKER));
  });

  it('reads CLAUDE.md at the same commit the branch is created from', async () => {
    // A read of the moving default branch could predate the branch's commit,
    // so the explicit sha would 409 and putFile's retry would overwrite a
    // newer edit with content built from the older read.
    const gh = fakeGh({ file: () => ({ sha: 'file-sha', encoding: 'base64', content: b64('# Mine\n') }) });
    await onboardRepo(gh, 'o', 'r');
    assert.equal(gh.contentsRef, 'head-sha');
    assert.equal(gh.branchSha, 'head-sha');
  });

  it('creates a fresh CLAUDE.md when none exists', async () => {
    const gh = fakeGh();
    await onboardRepo(gh, 'o', 'r');
    assert.equal(gh.puts[0].sha, undefined);
    assert.ok(gh.puts[0].content.startsWith('# CLAUDE.md\n\n'));
  });

  it('resets an existing branch only when the create answers 422', async () => {
    const gh = fakeGh({ refPost: () => { throw new Error('GitHub API POST /repos/o/r/git/refs: 422 Reference already exists'); } });
    assert.equal((await onboardRepo(gh, 'o', 'r')).status, 'created');
    assert.ok(gh.writes.includes('PATCH /repos/o/r/git/refs/heads/repo-butler/onboard'));
  });

  it('does not force-reset the branch on any other create failure', async () => {
    const gh = fakeGh({ refPost: () => { throw new Error('GitHub API POST /repos/o/r/git/refs: 403'); } });
    await assert.rejects(() => onboardRepo(gh, 'o', 'r'), /403/);
    assert.ok(!gh.writes.some(w => w.startsWith('PATCH')));
    assert.equal(gh.puts.length, 0);
  });

  it('does not force-reset the branch when a non-422 body mentions ": 422"', async () => {
    const gh = fakeGh({ refPost: () => { throw new Error('GitHub API POST /repos/o/r/git/refs: 500 {"message":"upstream said: 422"}'); } });
    await assert.rejects(() => onboardRepo(gh, 'o', 'r'), /: 500/);
    assert.ok(!gh.writes.some(w => w.startsWith('PATCH')));
    assert.equal(gh.puts.length, 0);
  });
});
