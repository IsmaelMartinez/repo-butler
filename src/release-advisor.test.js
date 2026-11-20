import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  usualGapDays, classifyCommit, summariseCommits, shippedSecurityFixes, shippedDirsFrom, advise, draftNote, noteHash,
  detectReleaseAdvice, adviceCommands, recheckAdvice, postReleaseNote, NOTE_MARKER,
} from './release-advisor.js';
import { buildRemediationPlan } from './governance.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const daysAgo = n => new Date(NOW - n * 86400000).toISOString();
const SHA = 'a'.repeat(40);

describe('usualGapDays', () => {
  it('defaults to 7 with fewer than five release days', () => {
    assert.deepEqual(usualGapDays([daysAgo(1), daysAgo(40), daysAgo(90)]), { days: 7, source: 'default' });
    assert.deepEqual(usualGapDays(null), { days: 7, source: 'default' });
  });

  it('is the median gap between release days', () => {
    const weekly = [0, 7, 14, 20, 28, 35].map(daysAgo);
    assert.deepEqual(usualGapDays(weekly), { days: 7, source: 'history' });
  });

  it('counts several releases on one day once (the delegate-local burst)', () => {
    const d = n => new Date(NOW - n * 86400000);
    const burst = [10, 10, 10, 10].map(n => new Date(d(n).setUTCHours(3)).toISOString());
    const rest = [0, 5, 15, 20, 25].map(daysAgo);
    // Release days 0,5,10,15,20,25: every gap is 5, whatever happened on day 10.
    assert.equal(usualGapDays([...burst, ...rest]).days, 5);
    // Four same-day releases alone are one release day, not a rhythm.
    assert.equal(usualGapDays(burst).source, 'default');
    // Bursts on most release days must not drag a weekly rhythm to the floor.
    assert.equal(usualGapDays([0, 0, 0, 0, 7, 7, 7, 14, 21, 28].map(daysAgo)).days, 7);
  });

  it('clamps to 3 and 30', () => {
    assert.equal(usualGapDays([0, 1, 2, 3, 4, 5].map(daysAgo)).days, 3);
    assert.equal(usualGapDays([0, 60, 120, 180, 240].map(daysAgo)).days, 30);
  });
});

describe('classifyCommit', () => {
  it('reads features and fixes, with the scope kept in the summary', () => {
    assert.deepEqual(classifyCommit('feat(dbus): add SetStatus presence control (#3178)'), { kind: 'feature', breaking: false, summary: 'dbus: add SetStatus presence control' });
    assert.equal(classifyCommit('fix: stop the tray icon flickering').kind, 'fix');
    assert.equal(classifyCommit('perf: cache the emoji table').kind, 'fix');
  });

  it('treats docs, chores, CI and dependency bumps as noise', () => {
    for (const s of ['docs(adr): record why', 'chore(main): release 2.32.2', 'ci: pin runner', 'refactor: split module', 'test: add case',
      'fix(deps): bump minimatch', 'chore(deps): bump katex and mermaid in /docs-site', 'feat(docs): new page']) {
      assert.equal(classifyCommit(s).kind, 'noise', s);
    }
  });

  it('does not read a feature about security PRs as a security fix', () => {
    assert.equal(classifyCommit('feat(governance): evidence-based stuck security-PR detection').kind, 'feature');
  });

  it('finds a breaking change by ! or by footer', () => {
    assert.equal(classifyCommit('feat!: drop the flat config names').breaking, true);
    assert.equal(classifyCommit('feat(config)!: rename').breaking, true);
    assert.equal(classifyCommit('fix: tidy\n\nBREAKING CHANGE: the flag is gone').breaking, true);
    assert.equal(classifyCommit('fix: mention BREAKING CHANGE: inline').breaking, false);
  });

  it('a non-conventional subject is noise, and text is reduced to a plain set', () => {
    assert.equal(classifyCommit('Merge branch main').kind, 'noise');
    assert.deepEqual([classifyCommit('Remove legacy CLI flags\n\nBREAKING CHANGE: gone').kind, classifyCommit('Remove legacy CLI flags\n\nBREAKING CHANGE: gone').breaking], ['noise', true]);
    assert.equal(summariseCommits(['Remove legacy CLI flags\n\nBREAKING CHANGE: gone']).breaking, true);
    assert.equal(classifyCommit(undefined).kind, 'noise');
    const c = classifyCommit('feat: add <img src=x onerror=alert(1)> `thing` [link](http://x)');
    assert.equal(/[<>`[\]=]/.test(c.summary), false);
    // Nothing that notifies, cross-references or links from a posted comment.
    const hostile = classifyCommit('fix(@evil): thanks @torvalds see #1 and octo/repo#2 at https://evil.example www.evil.example');
    assert.equal(/[@#:]|www\./.test(hostile.summary.replace(/^evil: /, '')), false);
    assert.equal(hostile.summary.startsWith('evil: '), true);
    assert.ok(classifyCommit(`feat: ${'x'.repeat(300)}`).summary.length <= 80);
  });
});

describe('summariseCommits', () => {
  it('counts what is waiting', () => {
    const s = summariseCommits(['feat: a', 'fix: b', 'docs: c', 'chore(deps): bump x']);
    assert.deepEqual([s.features, s.fixes, s.noise, s.breaking], [['a'], ['b'], 2, false]);
  });

  it('a revert cancels the commit it reverts, once', () => {
    const s = summariseCommits(['feat: wayland by default (#10)', 'Revert "feat: wayland by default (#10)" (#12)', 'feat: wayland by default (#14)']);
    assert.deepEqual(s.features, ['wayland by default']);
    assert.equal(summariseCommits(['feat!: x', 'Revert "feat!: x"']).breaking, false);
  });

  it('tolerates junk', () => {
    assert.deepEqual(summariseCommits(null).features, []);
    assert.deepEqual(summariseCommits([null, 3, 'fix: a']).fixes, ['a']);
  });
});

describe('shippedSecurityFixes', () => {
  const since = Date.parse(daysAgo(5));
  const alert = (name, severity, over = {}) => ({
    fixed_at: daysAgo(2), security_advisory: { severity },
    dependency: { scope: 'runtime', manifest_path: 'package-lock.json', package: { name } }, ...over,
  });

  it('keeps critical and high runtime fixes in a packaged manifest, one per package at its worst', () => {
    const out = shippedSecurityFixes([alert('follow-redirects', 'high'), alert('follow-redirects', 'critical'), alert('follow-redirects', 'high'), alert('sharp', 'high')], { since, shippedDirs: [''] });
    assert.deepEqual(out, [{ package: 'follow-redirects', severity: 'critical' }, { package: 'sharp', severity: 'high' }]);
  });

  it('ignores docs-site, development scope, lower severities and fixes already released', () => {
    const docs = alert('minimatch', 'high', { dependency: { scope: 'runtime', manifest_path: 'docs-site/package-lock.json', package: { name: 'minimatch' } } });
    const dev = alert('vitest', 'critical', { dependency: { scope: 'development', manifest_path: 'package-lock.json', package: { name: 'vitest' } } });
    const old = alert('joi', 'high', { fixed_at: daysAgo(9) });
    assert.deepEqual(shippedSecurityFixes([docs, dev, old, alert('qs', 'medium'), alert('x', 'high', { fixed_at: null }), null], { since, shippedDirs: [''] }), []);
  });

  it('follows release-please packages for a monorepo', () => {
    const app = alert('ws', 'high', { dependency: { scope: 'runtime', manifest_path: 'app/package-lock.json', package: { name: 'ws' } } });
    assert.equal(shippedSecurityFixes([app], { since, shippedDirs: [''] }).length, 0);
    assert.equal(shippedSecurityFixes([app], { since, shippedDirs: shippedDirsFrom({ packages: { './app/': {} } }) }).length, 1);
  });

  it('shippedDirsFrom falls back to the root', () => {
    assert.deepEqual(shippedDirsFrom({ packages: { '.': {} } }), ['']);
    assert.deepEqual(shippedDirsFrom(null), ['']);
    assert.deepEqual(shippedDirsFrom({ packages: {} }), ['']);
  });
});

describe('advise', () => {
  const base = { daysSinceRelease: 3, gapDays: 7 };

  it('is quiet when only noise is waiting', () => {
    assert.equal(advise(base).verdict, 'quiet');
    assert.equal(advise({ ...base, daysSinceRelease: 90 }).verdict, 'quiet');
  });

  it('waits with a forecast, then calls a good moment on the usual gap', () => {
    const w = advise({ ...base, features: 2 });
    assert.deepEqual([w.verdict, w.goodMomentInDays], ['wait', 4]);
    assert.match(w.reason, /2 features queued; a good moment arrives in 4 days/);
    const g = advise({ ...base, daysSinceRelease: 7, features: 2, fixes: 1 });
    assert.equal(g.verdict, 'good-moment');
    assert.match(g.reason, /^2 features and 1 fix have waited 7 days; this repo usually ships every 7\.$/);
    assert.match(advise({ ...base, daysSinceRelease: 6, fixes: 1 }).reason, /in 1 day /);
  });

  it('a shipped security fix is release now, whatever the day', () => {
    const a = advise({ ...base, daysSinceRelease: 0, security: [{ package: 'sharp', severity: 'high' }] });
    assert.equal(a.verdict, 'release-now');
    assert.match(a.reason, /sharp \(high\)/);
  });

  it('a confirmed regression fix is release now only with a fix waiting', () => {
    assert.equal(advise({ ...base, fixes: 1, regressionIssues: [3172] }).verdict, 'release-now');
    assert.equal(advise({ ...base, regressionIssues: [3032] }).verdict, 'quiet');
    assert.equal(advise({ ...base, features: 1, regressionIssues: [3032] }).verdict, 'wait');
  });

  it('breaking beats everything and names a waiting security fix', () => {
    const b = advise({ ...base, daysSinceRelease: 30, features: 5, breaking: true, security: [{ package: 'ws', severity: 'critical' }] });
    assert.equal(b.verdict, 'breaking');
    assert.match(b.reason, /ws \(critical\).*timing is yours/);
  });
});

describe('draftNote', () => {
  it('drafts nothing for wait and quiet', () => {
    assert.equal(draftNote({ verdict: 'wait', reason: 'r' }), null);
    assert.equal(draftNote({ verdict: 'quiet', reason: 'r' }), null);
  });

  it('is the marker and at most six plain lines', () => {
    const note = draftNote({
      version: '2.33.0', verdict: 'release-now', reason: 'A security fix is in code that ships: sharp (high).',
      features: ['a', 'b', 'c', 'd', 'e'], fixes: ['f'], security: [{ package: 'sharp', severity: 'high' }], state: 'ci-awaiting-approval',
    });
    const lines = note.split('\n').filter(Boolean);
    assert.equal(lines[0], NOTE_MARKER);
    assert.equal(lines.length, 7);
    assert.equal(lines[1], 'Release advice for 2.33.0: release now');
    assert.equal(lines[3], 'Features: a; b; c; and 2 more');
    assert.equal(lines[6], 'Mergeable as it stands: no, its workflow runs await approval');
    assert.equal(/sir/i.test(note), false);
  });

  it('leaves out empty lines and admits an unknown CI state', () => {
    const note = draftNote({ verdict: 'good-moment', reason: 'r', features: ['a'], state: 'unknown' });
    assert.equal(note.includes('Fixes:'), false);
    assert.match(note, /unknown, its CI state could not be read$/);
    assert.match(noteHash(note), /^[0-9a-f]{64}$/);
    assert.equal(noteHash(null), null);
  });
});

// ---- reads and the write path ----

function makePR(number = 7, over = {}) {
  return {
    number, state: 'open', title: 'chore(main): release 2.33.0',
    user: { login: 'github-actions[bot]' }, labels: [{ name: 'autorelease: pending' }],
    head: { ref: 'release-please--branches--main', sha: SHA, repo: { full_name: 'o/app' } },
    base: { ref: 'main', repo: { full_name: 'o/app' } }, mergeable: true, ...over,
  };
}

const weeklyReleases = [6, 13, 20, 27, 34, 41].map((n, i) => ({ tag_name: `v1.${9 - i}.0`, published_at: daysAgo(n), draft: false, prerelease: false }));

function makeGh({
  prs = [makePR()], releases = weeklyReleases, commits = ['feat: a (#1)', 'fix: b (#2)', 'docs: c'],
  alerts = [], issues = [], comments = [], me = 'owner', config = { packages: { '.': {} } }, compareThrows = false,
} = {}) {
  const writes = [];
  return {
    writes,
    paginate: async (path) => {
      if (path.endsWith('/pulls')) return prs;
      if (path.endsWith('/releases')) return releases;
      if (path.endsWith('/dependabot/alerts')) return alerts;
      if (path.endsWith('/comments')) return comments;
      if (path.endsWith('/issues')) return issues;
      return [];
    },
    request: async (path, opts = {}) => {
      if (opts.method === 'POST' || opts.method === 'PATCH') { writes.push({ path, ...opts }); return { html_url: 'https://github.com/o/app/pull/7#issuecomment-1' }; }
      if (path === '/user') return { login: me };
      if (path.includes('/compare/')) {
        if (compareThrows) throw Object.assign(new Error('boom'), { status: 500 });
        return { commits: commits.map(message => ({ commit: { message } })) };
      }
      if (path.endsWith('/contents/release-please-config.json')) return { content: Buffer.from(JSON.stringify(config)).toString('base64') };
      const one = path.match(/\/pulls\/(\d+)$/)?.[1];
      if (one) { const pr = prs.find(p => p.number === Number(one)); if (!pr) throw Object.assign(new Error('nf'), { status: 404 }); return pr; }
      if (path.includes('/check-runs')) return { total_count: 1, check_runs: [{ app: { slug: 'github-actions' } }] };
      if (path.endsWith('/actions/runs')) return { total_count: 1, workflow_runs: [{ workflow_id: 1, status: 'completed', conclusion: 'success', created_at: daysAgo(1) }] };
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return { allow_squash_merge: true };
      throw new Error(`unexpected ${path}`);
    },
    prCiState: async () => 'green',
    prCiHistory: async () => [],
  };
}

const repos = [{ name: 'app', archived: false, fork: false }];

describe('detectReleaseAdvice', () => {
  it('reports a wait with its forecast, and drafts no note', async () => {
    const [f] = await detectReleaseAdvice(makeGh(), 'o', repos, { now: NOW });
    assert.equal(f.type, 'release-advice');
    assert.deepEqual([f.verdict, f.daysSinceRelease, f.gapDays, f.gapSource, f.features, f.fixes], ['wait', 6, 7, 'history', 1, 1]);
    assert.equal(f.goodMomentInDays, 1);
    assert.equal(f.state, 'awaiting-human');
    assert.equal(f.since, '2026-11-20');
    assert.equal(f.priority, 'low');
    assert.equal('note' in f, false);
    assert.equal('title' in f, false);
    assert.deepEqual(adviceCommands(f), []);
  });

  it('calls a good moment on the usual gap, with a note, its hash and the merge command', async () => {
    const releases = weeklyReleases.map(r => ({ ...r, published_at: new Date(Date.parse(r.published_at) - 86400000).toISOString() }));
    const [f] = await detectReleaseAdvice(makeGh({ releases }), 'o', repos, { now: NOW });
    assert.equal(f.verdict, 'good-moment');
    assert.equal('note' in f || 'noteHash' in f, false, 'the note is never stored in a finding');
    const live = await recheckAdvice(makeGh({ releases }), 'o', 'app', 7, { now: NOW });
    assert.equal(live.noteHash, noteHash(live.note));
    assert.match(live.note, /Features: a\n\nFixes: b\n\nMergeable as it stands: yes, CI is green$/);
    assert.deepEqual(buildRemediationPlan(f).commands, [`gh pr merge 7 -R o/app --squash --delete-branch --match-head-commit ${SHA}`]);
  });

  it('is quiet for docs and bumps alone, and says what is left after the last release', async () => {
    const releases = [{ ...weeklyReleases[0], prerelease: true }, ...weeklyReleases.slice(1)];
    const issues = [{ number: 3032, labels: [{ name: 'bug' }, { name: 'release ready' }, { name: 'blocked' }], created_at: daysAgo(60) }];
    const [f] = await detectReleaseAdvice(makeGh({ commits: ['docs: a', 'chore(deps): bump b'], releases, issues }), 'o', repos, { now: NOW });
    assert.equal(f.verdict, 'quiet');
    assert.deepEqual(f.lifecycle, { prerelease: { tag: 'v1.9.0', days: 6 }, releaseReadyOpen: 1 });
    const plan = buildRemediationPlan(f);
    assert.deepEqual(plan.commands, []);
    assert.match(plan.rationale, /v1\.9\.0 has been a pre-release for 6 day\(s\); 1 issue\(s\) labelled "release ready" are still open/);
  });

  it('release now for a confirmed fix needs a bug filed since the release, not blocked', async () => {
    const ready = (number, over = {}) => ({ number, labels: [{ name: 'bug' }, { name: 'release ready' }], created_at: daysAgo(2), ...over });
    let [f] = await detectReleaseAdvice(makeGh({ issues: [ready(3172)] }), 'o', repos, { now: NOW });
    assert.deepEqual([f.verdict, f.regressionIssues, f.priority], ['release-now', [3172], 'high']);
    [f] = await detectReleaseAdvice(makeGh({ issues: [ready(1, { created_at: daysAgo(30) }), ready(2, { labels: [{ name: 'release ready' }] }), ready(3, { labels: [{ name: 'bug' }, { name: 'release ready' }, { name: 'blocked' }] }), ready(4, { pull_request: {} })] }), 'o', repos, { now: NOW });
    assert.equal(f.verdict, 'wait');
    assert.deepEqual(f.regressionIssues, []);
  });

  it('release now for a shipped security fix', async () => {
    const alerts = [{ fixed_at: daysAgo(1), security_advisory: { severity: 'critical' }, dependency: { scope: 'runtime', manifest_path: 'package-lock.json', package: { name: 'dompurify' } } }];
    const [f] = await detectReleaseAdvice(makeGh({ alerts, commits: ['chore(deps): bump dompurify'] }), 'o', repos, { now: NOW });
    assert.equal(f.verdict, 'release-now');
    assert.deepEqual(f.security, [{ package: 'dompurify', severity: 'critical' }]);
    const live = await recheckAdvice(makeGh({ alerts, commits: ['chore(deps): bump dompurify'] }), 'o', 'app', 7, { now: NOW });
    assert.match(live.note, /Security: dompurify \(critical\)/);
  });

  it('an unreadable release-please config proves no shipped directory; a missing one means the root', async () => {
    const alerts = [{ fixed_at: daysAgo(1), security_advisory: { severity: 'critical' }, dependency: { scope: 'runtime', manifest_path: 'package-lock.json', package: { name: 'dompurify' } } }];
    const failing = status => { const gh = makeGh({ alerts }); const request = gh.request; gh.request = async (path, opts) => { if (path.endsWith('/contents/release-please-config.json')) throw Object.assign(new Error('x'), { status }); return request(path, opts); }; return gh; };
    let [f] = await detectReleaseAdvice(failing(403), 'o', repos, { now: NOW });
    assert.deepEqual([f.verdict, f.security], ['wait', []]);
    [f] = await detectReleaseAdvice(failing(404), 'o', repos, { now: NOW });
    assert.equal(f.verdict, 'release-now');
    const bad = makeGh({ alerts }); const request = bad.request;
    bad.request = async (path, opts) => (path.endsWith('/contents/release-please-config.json') ? { content: Buffer.from('{nope').toString('base64') } : request(path, opts));
    [f] = await detectReleaseAdvice(bad, 'o', repos, { now: NOW });
    assert.equal(f.verdict, 'wait');
  });

  it('withholds a note that fails the body safety rules', async () => {
    const releases = weeklyReleases.map(r => ({ ...r, published_at: new Date(Date.parse(r.published_at) - 86400000).toISOString() }));
    const ok = await recheckAdvice(makeGh({ releases }), 'o', 'app', 7, { now: NOW });
    assert.equal(typeof ok.note, 'string');
    const secret = await recheckAdvice(makeGh({ releases, commits: ['feat: rotate ghp_' + 'a'.repeat(36)] }), 'o', 'app', 7, { now: NOW });
    assert.equal(secret.verdict, 'good-moment');
    assert.equal('note' in secret || 'noteHash' in secret, false);
  });

  it('an unchanged verdict keeps its since date; a changed one starts today', async () => {
    const prior = [{ type: 'release-advice', repo: 'app', number: 7, verdict: 'wait', since: '2026-11-15' }];
    let [f] = await detectReleaseAdvice(makeGh(), 'o', repos, { now: NOW, prior });
    assert.equal(f.since, '2026-11-15');
    [f] = await detectReleaseAdvice(makeGh(), 'o', repos, { now: NOW, prior: [{ ...prior[0], verdict: 'quiet' }] });
    assert.equal(f.since, '2026-11-20');
    [f] = await detectReleaseAdvice(makeGh(), 'o', repos, { now: NOW, prior: [{ ...prior[0], since: '<b>' }] });
    assert.equal(f.since, '2026-11-20');
  });

  it('says nothing without a release PR, a published release, or a readable history', async () => {
    assert.deepEqual(await detectReleaseAdvice(makeGh({ prs: [makePR(7, { labels: [], user: { login: 'someone' } })] }), 'o', repos, { now: NOW }), []);
    assert.deepEqual(await detectReleaseAdvice(makeGh({ releases: [{ tag_name: 'v1', published_at: null, draft: true }] }), 'o', repos, { now: NOW }), []);
    assert.deepEqual(await detectReleaseAdvice(makeGh({ compareThrows: true }), 'o', repos, { now: NOW }), []);
    // 300 commits fill the page cap: an incomplete history gives no advice.
    assert.deepEqual(await detectReleaseAdvice(makeGh({ commits: Array(100).fill('feat: x') }), 'o', repos, { now: NOW }), []);
    assert.deepEqual(await detectReleaseAdvice(makeGh(), 'o', [{ name: 'app', archived: true }], { now: NOW }), []);
    assert.deepEqual(await detectReleaseAdvice(makeGh(), 'o', null), []);
  });
});

describe('postReleaseNote', () => {
  const ripe = () => makeGh({ releases: weeklyReleases.map(r => ({ ...r, published_at: new Date(Date.parse(r.published_at) - 86400000).toISOString() })) });
  const approved = async gh => (await recheckAdvice(gh, 'o', 'app', 7, { now: NOW })).noteHash;

  it('posts the approved note', async () => {
    const gh = ripe();
    const res = await postReleaseNote(gh, 'o', 'app', 7, await approved(gh), { now: NOW });
    assert.deepEqual([res.posted, res.updated], [true, false]);
    assert.equal(gh.writes.length, 1);
    assert.equal(gh.writes[0].method, 'POST');
    assert.ok(gh.writes[0].body.body.startsWith(NOTE_MARKER));
  });

  it('refuses a missing, malformed or stale hash, and writes nothing', async () => {
    const gh = ripe();
    for (const hash of [undefined, 'yes', 'f'.repeat(64), (await approved(gh)).toUpperCase()]) {
      const res = await postReleaseNote(gh, 'o', 'app', 7, hash, { now: NOW });
      assert.ok(res.error, String(hash));
    }
    assert.equal(gh.writes.length, 0);
  });

  it('refuses when the note changed after the approval', async () => {
    const hash = await approved(ripe());
    const gh = ripe();
    const request = gh.request;
    gh.request = async (path, opts) => (path.includes('/compare/') ? { commits: [{ commit: { message: 'feat: something new' } }] } : request(path, opts));
    const res = await postReleaseNote(gh, 'o', 'app', 7, hash, { now: NOW });
    assert.match(res.error, /changed since it was approved/);
    assert.equal(gh.writes.length, 0);
  });

  it('never posts for wait or quiet', async () => {
    const gh = makeGh();
    const res = await postReleaseNote(gh, 'o', 'app', 7, 'a'.repeat(64), { now: NOW });
    assert.match(res.error, /no note is drafted for the verdict "wait"/);
    assert.equal(gh.writes.length, 0);
  });

  it('edits its own earlier note in place, and leaves an identical one alone', async () => {
    const base = ripe();
    const hash = await approved(base);
    const note = (await recheckAdvice(base, 'o', 'app', 7, { now: NOW })).note;
    const mine = id => ({ id, body: `${NOTE_MARKER}\n\nold`, user: { login: 'owner' }, html_url: 'u' });
    let gh = ripe();
    gh.paginate = (orig => async p => (p.endsWith('/comments') ? [{ id: 1, body: 'hello', user: { login: 'owner' } }, mine(22)] : orig(p)))(gh.paginate);
    let res = await postReleaseNote(gh, 'o', 'app', 7, hash, { now: NOW });
    assert.equal(res.updated, true);
    assert.deepEqual([gh.writes[0].method, gh.writes[0].path], ['PATCH', '/repos/o/app/issues/comments/22']);
    gh = ripe();
    gh.paginate = (orig => async p => (p.endsWith('/comments') ? [{ ...mine(22), body: note }] : orig(p)))(gh.paginate);
    res = await postReleaseNote(gh, 'o', 'app', 7, hash, { now: NOW });
    assert.deepEqual([res.posted, res.updated, gh.writes.length], [true, false, 0]);
  });

  it("does not edit someone else's comment that carries the marker", async () => {
    const gh = ripe();
    gh.paginate = (orig => async p => (p.endsWith('/comments') ? [{ id: 5, body: `${NOTE_MARKER}\nspoof`, user: { login: 'stranger' } }] : orig(p)))(gh.paginate);
    await postReleaseNote(gh, 'o', 'app', 7, await approved(gh), { now: NOW });
    assert.equal(gh.writes[0].method, 'POST');
  });

  it('refuses bad targets and PRs that are not open release PRs', async () => {
    const gh = ripe();
    const h = 'a'.repeat(64);
    assert.ok((await postReleaseNote(gh, 'o', '../x', 7, h)).error);
    assert.ok((await postReleaseNote(gh, 'o', 'app', 0, h)).error);
    assert.match((await postReleaseNote(gh, 'o', 'app', 99, h)).error, /could not read the PR/);
    assert.match((await recheckAdvice(makeGh({ prs: [makePR(7, { state: 'closed' })] }), 'o', 'app', 7)).error, /not open/);
    assert.match((await recheckAdvice(makeGh({ prs: [makePR(7, { labels: [], user: { login: 'x' } })] }), 'o', 'app', 7)).error, /not a release PR/);
    assert.equal(gh.writes.length, 0);
  });
});
