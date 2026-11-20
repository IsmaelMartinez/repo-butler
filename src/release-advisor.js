// Release advisor (agentic factory Phase 2, revised; design doc
// docs/superpowers/specs/2026-11-20-release-advisor-design.md).
//
// A release-please PR is meant to stay open, so its age is not a fault. This
// module answers the question the owner actually has: is what has piled up
// since the last release worth shipping yet? It reads the commits since the
// last tag (the release PR body goes stale after bot merges), the repo's own
// release rhythm, the Dependabot alerts fixed in shipped code, and the issues
// labelled `release ready`, and returns one of five verdicts:
//
//   release-now  a critical/high security fix is in code that ships, or a
//                confirmed fix for a bug filed since the last release is merged
//   breaking     a breaking change is queued; the timing is the owner's call
//   good-moment  features or fixes have waited at least the repo's usual gap
//   wait         the same, but not there yet; the day it arrives is given
//   quiet        only docs, chores or dependency bumps are waiting
//
// Everything here is deterministic. It never merges and never posts: the note
// it drafts reaches GitHub only through postReleaseNote, which refuses any
// text whose hash is not the one the owner approved.
//
// Never throws from detectReleaseAdvice: a per-repo failure yields no finding.

import { createHash } from 'node:crypto';
import { eligibleRepos, listOpenPRs } from './governance-repos.js';
import { isReleasePR, parseReleaseVersion, classifyReleasePR, preferredMergeMethod, releaseCommands } from './release-pending.js';
import { REPO_NAME_PATTERN, validateGitHubUsername } from './safety.js';

export const DEFAULT_GAP_DAYS = 7;
export const MIN_GAP_DAYS = 3;
export const MAX_GAP_DAYS = 30;
export const MIN_RELEASE_DAYS = 5;
export const RELEASE_READY_LABEL = 'release ready';
export const NOTE_MARKER = '<!-- repo-butler:release-advice -->';
export const ACTIONABLE = new Set(['release-now', 'good-moment', 'breaking']);

const DAY_MS = 86400000;
const MAX_COMPARE_PAGES = 3;
const SEVERITY_RANK = { critical: 2, high: 1 };

// ---- pure rules ----

/**
 * The repo's usual gap between releases, in days: the median gap between
 * release days (several releases on one day count once, so a burst of patch
 * releases does not read as an hourly cadence), clamped to 3-30. A repo with
 * fewer than five release days has no rhythm yet and gets the default.
 * @param {string[]} publishedDates ISO timestamps
 * @returns {{ days: number, source: 'history'|'default' }}
 */
export function usualGapDays(publishedDates) {
  const days = [...new Set((Array.isArray(publishedDates) ? publishedDates : [])
    .map(d => Math.floor(Date.parse(d) / DAY_MS))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  if (days.length < MIN_RELEASE_DAYS) return { days: DEFAULT_GAP_DAYS, source: 'default' };
  const gaps = days.slice(1).map((d, i) => d - days[i]).sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return { days: Math.min(MAX_GAP_DAYS, Math.max(MIN_GAP_DAYS, Math.round(median))), source: 'history' };
}

// Commit and package text is written by contributors and ends up in a comment
// posted under the owner's account, so it is reduced to a plain character set
// and capped. No `@` (a mention notifies someone), no `#` (an issue or
// cross-repo reference), no `:` (a URL scheme), and `www.` is broken up, so
// nothing in it can notify, cross-link or autolink.
function plain(text, max = 80) {
  return typeof text === 'string'
    ? text.replace(/[^A-Za-z0-9 .,_()&/'+-]/g, '').replace(/www\./gi, 'www ').replace(/ {2,}/g, ' ').trim().slice(0, max)
    : '';
}

const SUBJECT = /^([A-Za-z]+)(?:\(([^()]*)\))?(!)?:[ \t]*(.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;
const PR_SUFFIX = / \(#\d+\)$/;
const NOISE_SCOPES = new Set(['deps', 'deps-dev', 'docs', 'ci', 'test', 'tests', 'release', 'main']);

/**
 * Classify one conventional commit. `kind` is 'feature', 'fix' (fix, perf,
 * revert, security) or 'noise'; dependency, docs and CI scopes are noise
 * whatever the type. A non-conventional subject is noise and never breaking.
 * @returns {{ kind: 'feature'|'fix'|'noise', breaking: boolean, summary: string }}
 */
export function classifyCommit(message) {
  const text = typeof message === 'string' ? message : '';
  const first = text.split('\n', 1)[0].replace(PR_SUFFIX, '');
  const m = first.match(SUBJECT);
  if (!m) return { kind: 'noise', breaking: false, summary: plain(first) };
  const type = m[1].toLowerCase();
  const scope = (m[2] || '').toLowerCase();
  const breaking = Boolean(m[3]) || BREAKING_FOOTER.test(text);
  const body = plain(m[4], 60);
  const summary = scope && plain(scope, 18) ? `${plain(scope, 18)}: ${body}` : body;
  let kind = 'noise';
  if (!NOISE_SCOPES.has(scope)) {
    if (type === 'feat') kind = 'feature';
    else if (type === 'fix' || type === 'perf' || type === 'security') kind = 'fix';
  }
  return { kind, breaking, summary };
}

/**
 * What is waiting, from the commit messages since the last release (oldest
 * first or newest first, order does not matter). A `Revert "<subject>"` commit
 * cancels the commit with that subject, so a reverted feature is not counted.
 * @returns {{ features: string[], fixes: string[], breaking: boolean, noise: number }}
 */
export function summariseCommits(messages) {
  const list = (Array.isArray(messages) ? messages : []).filter(m => typeof m === 'string');
  const firstLine = m => m.split('\n', 1)[0];
  const reverted = new Map();
  for (const m of list) {
    const r = firstLine(m).replace(PR_SUFFIX, '').match(/^Revert "(.+)"$/);
    if (r) reverted.set(r[1].replace(PR_SUFFIX, ''), (reverted.get(r[1].replace(PR_SUFFIX, '')) || 0) + 1);
  }
  const out = { features: [], fixes: [], breaking: false, noise: 0 };
  for (const m of list) {
    const subject = firstLine(m).replace(PR_SUFFIX, '');
    if (/^Revert "/.test(subject)) { out.noise++; continue; }
    const pending = reverted.get(subject);
    if (pending) { reverted.set(subject, pending - 1); out.noise++; continue; }
    const c = classifyCommit(m);
    if (c.breaking) out.breaking = true;
    if (c.kind === 'feature') out.features.push(c.summary);
    else if (c.kind === 'fix') out.fixes.push(c.summary);
    else out.noise++;
  }
  return out;
}

/**
 * Shipped-code security fixes from Dependabot alerts: fixed after the last
 * release, critical or high, runtime scope, in a manifest whose directory is
 * one release-please packages ('' is the repo root). One entry per package at
 * its worst severity, so three alerts on one package read as one fix.
 * @returns {Array<{ package: string, severity: 'critical'|'high' }>}
 */
export function shippedSecurityFixes(alerts, { since, shippedDirs }) {
  const dirs = new Set(shippedDirs);
  const worst = new Map();
  for (const a of Array.isArray(alerts) ? alerts : []) {
    const severity = a?.security_advisory?.severity;
    if (!(severity in SEVERITY_RANK)) continue;
    if (a?.dependency?.scope !== 'runtime') continue;
    if (!(Date.parse(a?.fixed_at) > since)) continue;
    const manifest = a?.dependency?.manifest_path;
    if (typeof manifest !== 'string') continue;
    const dir = manifest.includes('/') ? manifest.slice(0, manifest.lastIndexOf('/')) : '';
    if (!dirs.has(dir)) continue;
    const name = plain(a?.dependency?.package?.name, 60);
    if (!name) continue;
    if (!worst.has(name) || SEVERITY_RANK[severity] > SEVERITY_RANK[worst.get(name)]) worst.set(name, severity);
  }
  return [...worst].map(([pkg, severity]) => ({ package: pkg, severity }))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.package.localeCompare(b.package));
}

/** The directories release-please packages, from release-please-config.json's `packages` keys ('.' is the root). */
export function shippedDirsFrom(config) {
  const keys = config && typeof config.packages === 'object' && config.packages !== null ? Object.keys(config.packages) : [];
  const dirs = keys.filter(k => typeof k === 'string').map(k => (k === '.' ? '' : k.replace(/^\.\//, '').replace(/\/+$/, '')));
  return dirs.length > 0 ? dirs : [''];
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function waiting(features, fixes) {
  const parts = [];
  if (features) parts.push(count(features, 'feature', 'features'));
  if (fixes) parts.push(count(fixes, 'fix', 'fixes'));
  return parts.join(' and ');
}

/**
 * The verdict. Breaking beats everything (with any security fix named), then
 * security, then a confirmed regression fix, then quiet, then the usual gap.
 * @returns {{ verdict: string, reason: string, goodMomentInDays: number|null }}
 */
export function advise({ daysSinceRelease, gapDays, features = 0, fixes = 0, security = [], regressionIssues = [], breaking = false }) {
  const secText = security.map(s => `${s.package} (${s.severity})`).join(', ');
  const queued = waiting(features, fixes);
  if (breaking) {
    return {
      verdict: 'breaking',
      reason: `${security.length ? `A security fix is waiting too (${secText}), but a` : 'A'} breaking change is queued, so the timing is yours.`,
      goodMomentInDays: null,
    };
  }
  if (security.length > 0) {
    return { verdict: 'release-now', reason: `A security fix is in code that ships: ${secText}.`, goodMomentInDays: null };
  }
  if (regressionIssues.length > 0 && fixes > 0) {
    return {
      verdict: 'release-now',
      reason: `A confirmed fix is merged for ${regressionIssues.map(n => `#${n}`).join(', ')}, filed since the last release.`,
      goodMomentInDays: null,
    };
  }
  if (features + fixes === 0) {
    return { verdict: 'quiet', reason: 'Only docs, chores or dependency bumps are waiting.', goodMomentInDays: null };
  }
  const plural = features + fixes === 1 ? 'has' : 'have';
  if (daysSinceRelease >= gapDays) {
    return {
      verdict: 'good-moment',
      reason: `${queued} ${plural} waited ${count(daysSinceRelease, 'day', 'days')}; this repo usually ships every ${gapDays}.`,
      goodMomentInDays: 0,
    };
  }
  const left = gapDays - daysSinceRelease;
  return {
    verdict: 'wait',
    reason: `${queued} queued; a good moment arrives in ${count(left, 'day', 'days')} (this repo usually ships every ${gapDays}).`,
    goodMomentInDays: left,
  };
}

export const VERDICT_LABEL = {
  'release-now': 'release now',
  'good-moment': 'good moment',
  wait: 'wait',
  breaking: 'breaking, your call',
  quiet: 'nothing to ship',
};

const CI_LINE = {
  'awaiting-human': 'yes, CI is green',
  'ci-not-triggered': 'no, CI never ran on its head',
  'ci-awaiting-approval': 'no, its workflow runs await approval',
  'merge-conflict': 'no, it has merge conflicts',
  'ci-pending': 'not yet, CI is still running',
  'ci-none': 'unclear, there is no CI signal',
  'blocked-persistent': 'no, CI is failing',
  'blocked-transient': 'no, CI is red',
};

function listed(items, max = 3) {
  const shown = items.slice(0, max).join('; ');
  return items.length > max ? `${shown}; and ${items.length - max} more` : shown;
}

/**
 * The note for the release PR: the marker, then at most six plain lines. Null
 * for wait and quiet, which never get a comment.
 */
export function draftNote({ version, verdict, reason, features = [], fixes = [], security = [], state }) {
  if (!ACTIONABLE.has(verdict)) return null;
  const lines = [
    `Release advice${version ? ` for ${version}` : ''}: ${VERDICT_LABEL[verdict]}`,
    reason,
    features.length ? `Features: ${listed(features)}` : null,
    fixes.length ? `Fixes: ${listed(fixes)}` : null,
    security.length ? `Security: ${listed(security.map(s => `${s.package} (${s.severity})`))}` : null,
    `Mergeable as it stands: ${CI_LINE[state] ?? 'unknown, its CI state could not be read'}`,
  ].filter(Boolean);
  return `${NOTE_MARKER}\n${lines.join('\n\n')}`;
}

export function noteHash(note) {
  return typeof note === 'string' ? createHash('sha256').update(note).digest('hex') : null;
}

// ---- reads ----

async function readReleases(gh, owner, repo) {
  const all = await gh.paginate(`/repos/${owner}/${repo}/releases`, { params: { per_page: 30 }, max: 30 });
  return (Array.isArray(all) ? all : [])
    .filter(r => r && !r.draft && Number.isFinite(Date.parse(r.published_at)) && typeof r.tag_name === 'string')
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

async function readCommitMessages(gh, owner, repo, tag, base) {
  const messages = [];
  for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
    const data = await gh.request(`/repos/${owner}/${repo}/compare/${encodeURIComponent(tag)}...${encodeURIComponent(base)}`, { params: { per_page: 100, page } });
    const commits = Array.isArray(data?.commits) ? data.commits : null;
    if (!commits) throw new Error('compare returned no commit list');
    messages.push(...commits.map(c => c?.commit?.message).filter(m => typeof m === 'string'));
    if (commits.length < 100) return messages;
  }
  return messages;
}

async function readShippedDirs(gh, owner, repo, ref) {
  try {
    const file = await gh.request(`/repos/${owner}/${repo}/contents/release-please-config.json`, { params: { ref } });
    return shippedDirsFrom(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')));
  } catch {
    return [''];
  }
}

// Unreadable alerts or issues read as none: both can only raise a verdict, so
// each needs positive evidence.
async function readFixedAlerts(gh, owner, repo) {
  try {
    const alerts = await gh.paginate(`/repos/${owner}/${repo}/dependabot/alerts`, { params: { state: 'fixed', per_page: 100, sort: 'updated', direction: 'desc' }, max: 200 });
    return Array.isArray(alerts) ? alerts : [];
  } catch {
    return [];
  }
}

async function readReleaseReady(gh, owner, repo) {
  try {
    const issues = await gh.paginate(`/repos/${owner}/${repo}/issues`, { params: { state: 'open', labels: RELEASE_READY_LABEL, per_page: 100 }, max: 200 });
    return (Array.isArray(issues) ? issues : []).filter(i => i && !i.pull_request);
  } catch {
    return [];
  }
}

const labelNames = issue => (Array.isArray(issue?.labels) ? issue.labels.map(l => (typeof l === 'string' ? l : l?.name)) : []);

/**
 * Everything the advisor says about one open release PR, read live. Null when
 * the repo has no published release to measure from.
 */
export async function adviseReleasePR(gh, owner, repo, pr, { now = Date.now() } = {}) {
  const releases = await readReleases(gh, owner, repo);
  const latest = releases[0];
  if (!latest) return null;
  const since = Date.parse(latest.published_at);
  const base = pr?.base?.ref;
  const [messages, shippedDirs, alerts, ready, ci, mergeMethod] = await Promise.all([
    readCommitMessages(gh, owner, repo, latest.tag_name, base),
    readShippedDirs(gh, owner, repo, base),
    readFixedAlerts(gh, owner, repo),
    readReleaseReady(gh, owner, repo),
    classifyReleasePR(gh, owner, repo, pr, { now }),
    preferredMergeMethod(gh, owner, repo),
  ]);
  const waitingWork = summariseCommits(messages);
  const security = shippedSecurityFixes(alerts, { since, shippedDirs });
  // A confirmed regression fix: an open issue labelled bug and `release
  // ready`, not blocked, filed after the release now shipped.
  const regressionIssues = ready
    .filter(i => { const l = labelNames(i); return l.includes('bug') && !l.includes('blocked') && Date.parse(i.created_at) > since; })
    .map(i => i.number).filter(Number.isInteger).sort((a, b) => a - b).slice(0, 5);
  const gap = usualGapDays(releases.map(r => r.published_at));
  const daysSinceRelease = Math.max(0, Math.floor((now - since) / DAY_MS));
  const advice = advise({
    daysSinceRelease, gapDays: gap.days, features: waitingWork.features.length, fixes: waitingWork.fixes.length,
    security, regressionIssues, breaking: waitingWork.breaking,
  });
  const version = parseReleaseVersion(pr.title);
  const note = draftNote({ version, ...advice, features: waitingWork.features, fixes: waitingWork.fixes, security, state: ci.state });
  // After the merge: the steps nothing fails on when they are skipped.
  const lifecycle = {};
  if (latest.prerelease) lifecycle.prerelease = { tag: plain(latest.tag_name, 40), days: daysSinceRelease };
  if (ready.length > 0) lifecycle.releaseReadyOpen = ready.length;
  return {
    number: pr.number,
    version,
    verdict: advice.verdict,
    reason: advice.reason,
    goodMomentInDays: advice.goodMomentInDays,
    daysSinceRelease,
    gapDays: gap.days,
    gapSource: gap.source,
    features: waitingWork.features.length,
    fixes: waitingWork.fixes.length,
    security,
    regressionIssues: advice.verdict === 'release-now' && security.length === 0 ? regressionIssues : [],
    breaking: waitingWork.breaking,
    ...ci,
    headSha: pr.head?.sha ?? null,
    mergeMethod,
    ...(note ? { note, noteHash: noteHash(note) } : {}),
    ...(Object.keys(lifecycle).length ? { lifecycle } : {}),
  };
}

const PRIORITY = { 'release-now': 'high', breaking: 'medium', 'good-moment': 'medium', wait: 'low', quiet: 'low' };

/**
 * One `release-advice` finding per open release PR. `prior` is the previous
 * run's findings: a finding whose verdict has not changed keeps its `since`
 * date, so a briefing can tell a new verdict from a repeated one.
 * @returns {Promise<Array>}
 */
export async function detectReleaseAdvice(gh, owner, repos, { openPRs = null, prior = null, now = Date.now() } = {}) {
  if (!Array.isArray(repos)) return [];
  const today = new Date(now).toISOString().slice(0, 10);
  const before = new Map((Array.isArray(prior) ? prior : [])
    .filter(f => f?.type === 'release-advice' && /^\d{4}-\d{2}-\d{2}$/.test(f.since ?? ''))
    .map(f => [`${f.repo}#${f.number}:${f.verdict}`, f.since]));

  const perRepo = await Promise.all(eligibleRepos(repos).map(async (repo) => {
    try {
      const prs = await listOpenPRs(gh, owner, repo.name, openPRs);
      if (!Array.isArray(prs)) return [];
      const findings = [];
      for (const pr of prs) {
        if (!isReleasePR(pr)) continue;
        const live = await adviseReleasePR(gh, owner, repo.name, pr, { now });
        if (!live) continue;
        // The drafted note carries contributor-written commit text, so it is
        // never stored: findings reach MCP clients next to commands. It exists
        // only in the live read the apply skill shows the owner (recheckAdvice).
        const { note: _note, noteHash: _hash, ...advice } = live;
        findings.push({
          type: 'release-advice',
          repo: repo.name,
          owner,
          ...advice,
          since: before.get(`${repo.name}#${advice.number}:${advice.verdict}`) ?? today,
          priority: PRIORITY[advice.verdict],
        });
      }
      return findings;
    } catch (err) {
      console.log(`release-advice: skipping ${repo.name} (${err.status ?? 'error'})`);
      return [];
    }
  }));
  return perRepo.flat().sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
}

/**
 * Commands for a release-advice finding: only for a verdict worth acting on,
 * and then exactly what releaseCommands allows for the PR's CI state.
 */
export function adviceCommands(finding) {
  return ACTIONABLE.has(finding?.verdict) ? releaseCommands(finding) : [];
}

// ---- the one write path ----

function validTarget(owner, repo, number) {
  return validateGitHubUsername(owner) && REPO_NAME_PATTERN.test(repo ?? '') && !/^\.+$/.test(repo) && Number.isInteger(number) && number > 0;
}

/** Advice for one release PR by number, read live. For the apply skill to show before asking. */
export async function recheckAdvice(gh, owner, repo, number, { now = Date.now() } = {}) {
  if (!validTarget(owner, repo, number)) return { error: 'invalid owner, repo or number' };
  let pr;
  try {
    pr = await gh.request(`/repos/${owner}/${repo}/pulls/${number}`);
  } catch (err) {
    return { error: `could not read the PR (${err?.status ?? 'error'})` };
  }
  if (!isReleasePR(pr)) return { error: 'not a release PR' };
  if (pr.state !== 'open') return { error: 'the release PR is not open' };
  try {
    const advice = await adviseReleasePR(gh, owner, repo, pr, { now });
    return advice ?? { error: 'no published release to measure from' };
  } catch (err) {
    return { error: `could not read the release state (${err?.status ?? 'error'})` };
  }
}

/**
 * Post the note on the release PR, or edit the butler's existing note in
 * place. The only write in this module. It re-reads the advice live and
 * refuses unless the note it would post hashes to `approvedHash`, the hash of
 * the text the owner was shown and said yes to. A model cannot pass different
 * text through it, and a note that changed since the approval is refused.
 * @returns {Promise<{ posted: true, updated: boolean, url: string|null }|{ error: string }>}
 */
export async function postReleaseNote(gh, owner, repo, number, approvedHash, { now = Date.now() } = {}) {
  if (typeof approvedHash !== 'string' || !/^[0-9a-f]{64}$/.test(approvedHash)) return { error: 'an approved sha256 hash is required' };
  const advice = await recheckAdvice(gh, owner, repo, number, { now });
  if (advice.error) return advice;
  if (!advice.note) return { error: `no note is drafted for the verdict "${advice.verdict}"` };
  if (advice.noteHash !== approvedHash) return { error: 'the note has changed since it was approved; show the new draft and ask again' };
  const comments = await gh.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`, { params: { per_page: 100 }, max: 300 });
  // Only the poster's own earlier note is edited: anyone can write the marker.
  const me = (await gh.request('/user'))?.login;
  const existing = (Array.isArray(comments) ? comments : [])
    .find(c => typeof c?.body === 'string' && c.body.startsWith(NOTE_MARKER) && typeof me === 'string' && c.user?.login === me);
  if (existing && existing.body === advice.note) return { posted: true, updated: false, url: existing.html_url ?? null };
  const res = existing
    ? await gh.request(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body: advice.note } })
    : await gh.request(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: advice.note } });
  return { posted: true, updated: Boolean(existing), url: res?.html_url ?? null };
}
