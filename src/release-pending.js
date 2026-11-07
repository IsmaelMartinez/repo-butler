// Release-pending detector (agentic factory Phase 2, design doc
// docs/superpowers/specs/2026-11-06-agentic-factory-design.md section 2).
//
// Finds release PRs that are waiting, and why. The case that bit twice
// (teams-for-linux #3158, delegate-local #690) is a release-please PR opened
// with the default token: GitHub runs no Actions workflow for it at all, so it
// sits with external checks green (or none) and nothing says CI never ran.
// `classifyPR` reads that as awaiting-human or ci-none, which is the same
// failure under two names. This module adds the `ci-not-triggered` state for
// it, and errs towards saying nothing: the close-and-reopen command it unlocks
// is only emitted when a workflow is PROVEN to fire on a reopened PR.
//
// Never throws: a per-repo failure yields no finding, matching the other
// PR-reading audits, so runGovernance degrades to "found nothing" rather than
// to stale output.

import { eligibleRepos, listOpenPRs } from './governance-repos.js';
import { classifyPR } from './butler-pr-audit.js';
import { isSameRepoPR } from './stalled-alert.js';

export const GRACE_DAYS = 2;

const RELEASE_BRANCH_PREFIX = 'release-please--';
const RELEASE_LABEL = 'autorelease: pending';
const ACTIONS_APP_SLUG = 'github-actions';
const MAX_PAGES = 10;

/**
 * Is this open PR a release PR? Two of three signals: the release-please
 * branch prefix, a bot author, the `autorelease: pending` label. The branch is
 * the main locator; identity only backs it up (the isVerified idea in
 * butler-pr-audit.js). A fork head never counts, because the commands this
 * finding unlocks act on the PR and a branch name is forgeable from a fork.
 */
export function isReleasePR(pr) {
  if (!isSameRepoPR(pr)) return false;
  const branch = typeof pr?.head?.ref === 'string' && pr.head.ref.startsWith(RELEASE_BRANCH_PREFIX);
  const login = pr?.user?.login;
  const bot = typeof login === 'string' && login.endsWith('[bot]');
  const labels = Array.isArray(pr?.labels) ? pr.labels.map(l => (typeof l === 'string' ? l : l?.name)) : [];
  const label = labels.includes(RELEASE_LABEL);
  return [branch, bot, label].filter(Boolean).length >= 2;
}

/** The version a release-please title names ("chore(main): release 2.31.0"), or null. */
export function parseReleaseVersion(title) {
  if (typeof title !== 'string') return null;
  const m = title.match(/\brelease v?(\d{1,6}\.\d{1,6}\.\d{1,6})\b/i);
  return m ? m[1] : null;
}

// ---- workflow trigger parsing ----
//
// Deliberately narrow and fail-closed. It understands the shapes real
// workflows here use (`on: pull_request`, `on: [push, pull_request]`, a block
// `on:` mapping or list, and under `pull_request:` nothing, `{}`, or
// `branches`/`types` lists) and returns null — "cannot tell" — for anything
// else. Returns true when the pull_request trigger is proven to fire on a
// reopened PR into `baseBranch`, false when it is parsed and does not (no
// pull_request trigger, a paths/branches-ignore filter, a glob, a branch list
// without the base, a types list without `reopened`).

const EVENT_NAME = /^[a-z_]+$/;
const PR_FILTER_KEYS = new Set(['branches', 'branches-ignore', 'paths', 'paths-ignore', 'types']);
const GLOB_CHARS = /[*?[\]!+]/;

function stripComment(line) {
  // A `#` at the start or after whitespace opens a comment. A `#` inside a
  // quoted value is cut too, which leaves an unbalanced quote that the value
  // parser rejects — the safe direction.
  const i = line.search(/(^|\s)#/);
  return i === -1 ? line.trimEnd() : line.slice(0, i).trimEnd();
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  if (/["']/.test(t)) return null;
  return t;
}

// An inline flow list `[a, b]` or a bare scalar, as an array of strings; null
// when it is neither.
function parseInlineList(value) {
  const v = value.trim();
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) return null;
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    const items = inner.split(',').map(unquote);
    return items.some(x => x === null || x === '') ? null : items;
  }
  if (/[{}[\]&*|>]/.test(v[0] ?? '')) return null;
  const one = unquote(v);
  return one === null || one === '' ? null : [one];
}

const indentOf = line => line.length - line.trimStart().length;

// Split `lines` (already comment-stripped, blank-free, all indented deeper
// than the parent) into children at the first line's indent: each child is
// { key, value, lines } for a mapping, or { item } for a `- x` list entry.
// null when a line at the child indent is neither, or when indentation is
// inconsistent.
function children(lines) {
  if (lines.length === 0) return [];
  const indent = indentOf(lines[0]);
  const out = [];
  for (const line of lines) {
    const ind = indentOf(line);
    const text = line.trim();
    if (ind < indent) return null;
    if (ind > indent) {
      if (out.length === 0 || out.at(-1).item !== undefined) return null;
      out.at(-1).lines.push(line);
      continue;
    }
    const item = text.match(/^- (.+)$/);
    if (item) { out.push({ item: item[1] }); continue; }
    const kv = text.match(/^([A-Za-z_-]+):(?: (.*))?$/);
    if (!kv) return null;
    out.push({ key: kv[1], value: (kv[2] ?? '').trim(), lines: [] });
  }
  const kinds = new Set(out.map(c => (c.item !== undefined ? 'list' : 'map')));
  return kinds.size > 1 ? null : out;
}

// A child's list value, inline (`[main]`, `main`) or as a nested `- x` block.
function listValue(child) {
  if (child.value !== '') return child.lines.length === 0 ? parseInlineList(child.value) : null;
  const kids = children(child.lines);
  if (!kids || kids.length === 0 || kids.some(k => k.item === undefined)) return null;
  const items = kids.map(k => unquote(k.item));
  return items.some(x => x === null || x === '') ? null : items;
}

function pullRequestApplies(prChild, baseBranch) {
  if (prChild.value === '{}' || prChild.value === '~' || prChild.value === 'null') {
    return prChild.lines.length === 0 ? true : null;
  }
  if (prChild.value !== '') return null;
  const filters = children(prChild.lines);
  if (!filters) return null;
  let applies = true;
  for (const f of filters) {
    if (f.item !== undefined || !PR_FILTER_KEYS.has(f.key)) return null;
    const values = listValue(f);
    if (!values) return null;
    if (f.key === 'branches-ignore' || f.key === 'paths' || f.key === 'paths-ignore') applies = false;
    if (f.key === 'branches' && (values.some(b => GLOB_CHARS.test(b)) || !values.includes(baseBranch))) applies = false;
    if (f.key === 'types' && !values.includes('reopened')) applies = false;
  }
  return applies;
}

/**
 * Does this workflow file's pull_request trigger provably fire when a PR into
 * `baseBranch` is reopened? true / false / null (cannot tell).
 */
export function pullRequestTriggerApplies(text, baseBranch) {
  if (typeof text !== 'string' || typeof baseBranch !== 'string' || baseBranch === '') return null;
  if (text.includes('\t')) return null;
  const lines = text.split(/\r?\n/).map(stripComment).filter(l => l.trim() !== '');
  const starts = lines
    .map((l, i) => ({ i, m: l.match(/^(?:on|"on"|'on'|true):(?: (.*))?$/) }))
    .filter(x => x.m);
  if (starts.length !== 1) return null;
  const { i, m } = starts[0];
  const inline = (m[1] ?? '').trim();
  const block = [];
  for (const l of lines.slice(i + 1)) {
    if (indentOf(l) === 0) break;
    block.push(l);
  }
  if (inline !== '') {
    if (block.length > 0) return null;
    const events = parseInlineList(inline);
    if (!events || events.some(e => !EVENT_NAME.test(e))) return null;
    return events.includes('pull_request');
  }
  const kids = children(block);
  if (!kids || kids.length === 0) return null;
  if (kids[0].item !== undefined) {
    const events = kids.map(k => unquote(k.item));
    if (events.some(e => e === null || !EVENT_NAME.test(e))) return null;
    return events.includes('pull_request');
  }
  const pr = kids.filter(k => k.key === 'pull_request');
  if (pr.length > 1) return null;
  if (pr.length === 0) return false;
  return pullRequestApplies(pr[0], baseBranch);
}

// ---- reads ----

// Hand-paged: both endpoints wrap their arrays, so paginate() cannot be used.
async function pagedList(gh, path, key, params = {}) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await gh.request(path, { params: { ...params, per_page: 100, page } });
    const batch = Array.isArray(res?.[key]) ? res[key] : null;
    if (!batch) return null;
    items.push(...batch);
    // Without a count a short read cannot be told from a complete one, and a
    // missed check run would read as "no Actions ran" — so it is unreadable.
    const total = Number(res?.total_count);
    if (!Number.isFinite(total)) return null;
    if (batch.length === 0 || items.length >= total) return items;
  }
  return null;
}

/**
 * What GitHub Actions did for this head:
 *   'ran'               — an Actions check run reported, so classifyPR can judge it
 *   'awaiting-approval' — workflow runs exist and every one ended
 *                         `action_required` (blocked on approval, no check run)
 *   'queued'            — workflow runs exist but no check run yet
 *   'none'              — no check run and no workflow run at all
 *   null                — unreadable
 * Workflow runs are read as well as check runs because a run blocked on
 * approval, or still waiting for a runner, has no check run: on check runs
 * alone it would read as "not triggered", or — beside a green external check —
 * as green and ready to merge (teams-for-linux #3189, 2026-11-07).
 */
export async function actionsStateOn(gh, owner, repo, sha) {
  try {
    const checks = await pagedList(gh, `/repos/${owner}/${repo}/commits/${sha}/check-runs`, 'check_runs');
    if (!checks) return null;
    if (checks.some(r => r?.app?.slug === ACTIONS_APP_SLUG)) return 'ran';
    const runs = await pagedList(gh, `/repos/${owner}/${repo}/actions/runs`, 'workflow_runs', { head_sha: sha });
    if (!runs) return null;
    if (runs.length === 0) return 'none';
    if (runs.every(r => r?.status === 'completed' && r?.conclusion === 'action_required')) return 'awaiting-approval';
    return 'queued';
  } catch {
    return null;
  }
}

// How recently the head was pushed, as the head commit's committer date.
// release-please force-pushes its branch on every merge to main, so an old PR
// can carry a head minutes old whose runs GitHub has not registered yet.
const FRESH_HEAD_MS = 60 * 60 * 1000;

async function headIsSettled(gh, owner, repo, sha, now) {
  try {
    const c = await gh.request(`/repos/${owner}/${repo}/commits/${sha}`);
    const at = Date.parse(c?.commit?.committer?.date);
    return Number.isFinite(at) && now - at > FRESH_HEAD_MS;
  } catch {
    return false;
  }
}

const ABSENT = Symbol('absent');

// A workflow file's text, ABSENT, or null (unreadable). GitHub keeps a deleted
// workflow registered as `active`, so a 404 must not poison the whole repo —
// but getFileContent folds 404 into every other failure, hence the direct read.
// A pull_request run uses the merge of head into base, so a file counts as
// absent only when neither side has it; present on base but not at the head
// cannot be judged from the head alone, so it is unreadable.
async function readWorkflowFile(gh, owner, repo, path, { ref, baseBranch }) {
  const read = async (at) => {
    try {
      const data = await gh.request(`/repos/${owner}/${repo}/contents/${path}`, { params: { ref: at } });
      return typeof data?.content === 'string' ? Buffer.from(data.content, 'base64').toString('utf-8') : null;
    } catch (err) {
      return err?.status === 404 ? ABSENT : null;
    }
  };
  const atHead = await read(ref);
  if (atHead !== ABSENT) return atHead;
  return (await read(baseBranch)) === ABSENT ? ABSENT : null;
}

/**
 * Is at least one active workflow proven to fire on a reopened PR into
 * `baseBranch`? true when so and every workflow file was read and parsed;
 * null when any could not be; false otherwise. Workflow files are read at the
 * PR head, which is what a pull_request event runs.
 */
export async function workflowsProvenApplicable(gh, owner, repo, { ref, baseBranch }) {
  try {
    const workflows = await pagedList(gh, `/repos/${owner}/${repo}/actions/workflows`, 'workflows');
    if (!workflows) return null;
    let proven = false;
    for (const w of workflows) {
      // Dynamic workflows (Copilot, Dependabot) have no file and no pull_request trigger.
      if (typeof w?.path !== 'string' || !w.path.startsWith('.github/workflows/')) continue;
      if (w.state !== 'active') continue;
      const text = await readWorkflowFile(gh, owner, repo, w.path, { ref, baseBranch });
      if (text === ABSENT) continue;
      if (text === null) return null;
      const applies = pullRequestTriggerApplies(text, baseBranch);
      if (applies === null) return null;
      if (applies) proven = true;
    }
    return proven;
  } catch {
    return null;
  }
}

/** The repo's preferred allowed merge method, squash first; null when unreadable or none. */
async function preferredMergeMethod(gh, owner, repo) {
  try {
    const r = await gh.request(`/repos/${owner}/${repo}`);
    if (r?.allow_squash_merge === true) return 'squash';
    if (r?.allow_merge_commit === true) return 'merge';
    if (r?.allow_rebase_merge === true) return 'rebase';
    return null;
  } catch {
    return null;
  }
}

/**
 * Is a shipped regression waiting on this release? True when an open issue
 * labelled `bug` was created after the latest published release. Any read
 * failure, or no release yet, is false: this can only raise a priority, so it
 * needs positive evidence.
 */
async function regressionWaiting(gh, owner, repo) {
  try {
    const latest = await gh.request(`/repos/${owner}/${repo}/releases/latest`);
    const since = Date.parse(latest?.published_at);
    if (!Number.isFinite(since)) return false;
    const bugs = await gh.paginate(`/repos/${owner}/${repo}/issues`, {
      params: { state: 'open', labels: 'bug', per_page: 100 },
      max: 200,
    });
    return bugs.some(i => !i.pull_request && Date.parse(i.created_at) > since);
  } catch {
    return false;
  }
}

/**
 * Classify one release PR. classifyPR's state once Actions has reported;
 * `ci-awaiting-approval` or `ci-pending` while its runs are blocked or queued;
 * and a head with no GitHub Actions run at all becomes `ci-not-triggered` when a workflow is
 * proven to fire on a reopen, and `unknown` when that cannot be shown (or the
 * check runs could not be read). It takes precedence over awaiting-human and
 * ci-none, which is the whole point.
 */
export async function classifyReleasePR(gh, owner, repo, pr, { now = Date.now() } = {}) {
  const sha = pr?.head?.sha;
  const actions = await actionsStateOn(gh, owner, repo, sha);
  if (actions === null) return 'unknown';
  if (actions === 'awaiting-approval') return 'ci-awaiting-approval';
  // Runs exist but none has reported: never let an external check alone read
  // as green while Actions is still to come.
  if (actions === 'queued') return 'ci-pending';
  if (actions === 'none') {
    // A head pushed within the hour may simply not have its runs yet, and an
    // unreadable commit date proves nothing either way.
    if (!(await headIsSettled(gh, owner, repo, sha, now))) return 'unknown';
    const applicable = await workflowsProvenApplicable(gh, owner, repo, { ref: sha, baseBranch: pr?.base?.ref });
    return applicable === true ? 'ci-not-triggered' : 'unknown';
  }
  return (await classifyPR(gh, owner, repo, pr)).state;
}

/**
 * Release PRs open past the grace period, one finding per PR.
 *
 * @param {object} gh — GitHub API client
 * @param {string} owner
 * @param {Array} repos — portfolio repos from observePortfolio()
 * @param {{ openPRs?: Object }} [options] — the shared open-PR sweep
 * @returns {Promise<Array>} findings of type 'release-pending'
 */
export async function detectPendingReleases(gh, owner, repos, { openPRs = null } = {}) {
  if (!Array.isArray(repos)) return [];
  const now = Date.now();

  const perRepo = await Promise.all(eligibleRepos(repos).map(async (repo) => {
    try {
      const prs = await listOpenPRs(gh, owner, repo.name, openPRs);
      if (!Array.isArray(prs)) return [];
      const waiting = [];
      for (const pr of prs) {
        if (!isReleasePR(pr)) continue;
        const waitingDays = Math.floor((now - new Date(pr.created_at).getTime()) / 86400000);
        // Negated so an unparseable created_at (NaN) skips the PR rather than
        // reporting one of unknown age (butler-pr-audit.js does the same).
        if (!(waitingDays > GRACE_DAYS)) continue;
        waiting.push({ pr, waitingDays });
      }
      if (waiting.length === 0) return [];

      const [mergeMethod, regression] = await Promise.all([
        preferredMergeMethod(gh, owner, repo.name),
        regressionWaiting(gh, owner, repo.name),
      ]);
      const findings = [];
      for (const { pr, waitingDays } of waiting) {
        findings.push({
          type: 'release-pending',
          repo: repo.name,
          owner,
          number: pr.number,
          // The title is never stored: it is PR text, and findings reach MCP
          // clients next to executable commands. The version is all it carries.
          version: parseReleaseVersion(pr.title),
          state: await classifyReleasePR(gh, owner, repo.name, pr),
          headSha: pr.head?.sha ?? null,
          waitingDays,
          mergeMethod,
          priority: regression ? 'high' : 'medium',
        });
      }
      return findings;
    } catch (err) {
      console.log(`release-pending: skipping ${repo.name} (${err.status ?? 'error'})`);
      return [];
    }
  }));

  return perRepo.flat().sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
}
