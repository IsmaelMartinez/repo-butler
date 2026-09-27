// APPLY phase wrapper: reads the persisted governance findings, decides which
// apply classes this dispatch requests, runs them in a fixed order, appends each
// class's summary to GITHUB_OUTPUT and fails the phase on any per-repo error.
//
// apply.js is imported STATICALLY: a module that fails to load must fail the
// run, never degrade into a silent "apply not available" skip.
import { appendFileSync } from 'node:fs';
import { createClient } from './github.js';
import { parseDryRun } from './config.js';
import {
  applyGovernanceFindings,
  nudgeStaleDependabotPRs,
  applyCopilotReviewRulesets,
  applyDependabotSecurityUpdates,
  disableDependabotSecurityUpdates,
  autoMergeGovernancePRs,
} from './apply.js';
import { applyLockfileUpdates } from './lockfile-update.js';

// Resolve which of the two mutually-exclusive ADR-012 settings toggles a manual
// apply dispatch requests. Enabling (`dependabot-security`, or a blank `tools` =
// all actionable) and disabling (`dependabot-security-off`, explicit only) target
// the same repo setting, so naming BOTH in one dispatch is contradictory — it
// would PUT then DELETE in a single run, netting an unpredictable toggle. Fail
// SAFE: on conflict, run NEITHER. Both are off the no-human scheduled path by
// construction, so a scheduled run resolves to neither. Pure — no I/O.
export function resolveDependabotSecurityDispatch(tools, scheduled) {
  const list = Array.isArray(tools) ? tools : [];
  const conflict = list.includes('dependabot-security') && list.includes('dependabot-security-off');
  return {
    conflict,
    enable: !scheduled && !conflict && (list.length === 0 || list.includes('dependabot-security')),
    disable: !scheduled && !conflict && list.includes('dependabot-security-off'),
  };
}

// Whether an apply run should offer the lockfile refresh (ADR-015). It is a
// content-transformation write, so on a MANUAL dispatch it never rides a blank
// `tools` (= all actionable): the operator must name it. On the scheduled path
// it is offered on a BLANK run only — the scheduled workflow sets `scheduled`
// for its manual dispatches too, and an explicit `tools=code-scanning` there
// must not drag a content write along — and `applyLockfileUpdates` itself then
// skips unless the `apply-schedule` allow-list names the tool: the same
// two-axis default-closed shape ADR-007 stage 4 established. Pure — no I/O.
export function isLockfileUpdateRequested(tools, scheduled) {
  const list = Array.isArray(tools) ? tools : [];
  if (list.includes('lockfile-update')) return true;
  return scheduled === true && list.length === 0;
}

// How each class reports. The key is its GITHUB_OUTPUT name; `failed` names one
// errored result; `line` renders the error summary. Declaration order is the
// order errors are joined in, which predates this table (automerge before
// lockfile-update) and is pinned by tests.
const REPORTING = {
  apply: {
    failed: r => `${r.repo}/${r.tool}`,
    line: (s, f) => `apply: ${s.errors} per-repo error(s) [${f}]; ${s.created} PR(s) created, ${s.skipped} skipped`,
  },
  nudge: {
    failed: r => `${r.repo}#${r.number}`,
    line: (s, f) => `nudge: ${s.errors} error(s) [${f}]; ${s.nudged} rebased, ${s.skipped} skipped`,
  },
  copilotReview: {
    failed: r => r.repo,
    line: (s, f) => `copilot-review: ${s.errors} error(s) [${f}]; ${s.created} created, ${s.skipped} skipped`,
  },
  dependabotSecurity: {
    failed: r => r.repo,
    line: (s, f) => `dependabot-security: ${s.errors} error(s) [${f}]; ${s.enabled} enabled, ${s.skipped} skipped`,
  },
  dependabotSecurityOff: {
    failed: r => r.repo,
    line: (s, f) => `dependabot-security-off: ${s.errors} error(s) [${f}]; ${s.removed} disabled`,
  },
  automerge: {
    failed: r => `${r.repo}/${r.tool}`,
    line: (s, f) => `automerge: ${s.errors} error(s) [${f}]; ${s.merged} merged, ${s.skipped} skipped`,
  },
  lockfileUpdate: {
    failed: r => (r.directory ? `${r.repo}/${r.directory}` : r.repo),
    line: (s, f) => `lockfile-update: ${s.errors} error(s) [${f}]; ${s.created} PR(s) created, ${s.skipped} skipped`,
  },
};

export async function runApply(context) {
  const { owner, token, config, store } = context;
  const findings = store ? await store.readGovernanceFindings() : [];
  if (!findings || findings.length === 0) {
    console.log('No governance findings to apply.');
    return;
  }
  const maxPerRun = parseInt(process.env.INPUT_MAX_APPLY_PER_RUN, 10) || 5;
  const tools = (process.env.INPUT_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const dryRun = parseDryRun(process.env.INPUT_DRY_RUN);
  // Stage 4 (ADR-007): set by the scheduled apply workflow only. On the no-human
  // path, apply.js gates each finding class behind the apply-schedule allow-list.
  const scheduled = process.env.INPUT_SCHEDULED === 'true';
  const gh = createClient(token);
  const opts = { dryRun, maxPerRun, scheduled };

  // The enable and disable toggles are mutually exclusive — naming both is
  // contradictory and runs neither (see resolveDependabotSecurityDispatch).
  const depSec = resolveDependabotSecurityDispatch(tools, scheduled);
  if (depSec.conflict) {
    console.error('apply: `tools` names both dependabot-security and dependabot-security-off — contradictory dispatch; skipping BOTH settings writes.');
  }

  // Dispatch order. Each class states its own "requested" predicate; none is
  // derived from another, so widening one can never widen its neighbours.
  const dispatch = [
    // Templated PRs always run; a non-blank `tools` narrows them inside apply.js.
    ['apply', true,
      () => applyGovernanceFindings(gh, owner, findings, config, { ...opts, tools: tools.length > 0 ? tools : null })],
    // Stale-Dependabot nudge: a blank `tools` (all actionable) or an explicit
    // `dependabot-rebase`, so a tool-scoped dispatch never nudges by surprise.
    ['nudge', tools.length === 0 || tools.includes('dependabot-rebase'),
      () => nudgeStaleDependabotPRs(gh, owner, findings, config, opts)],
    // Copilot-review enablement (ADR-009 settings write): blank or explicit
    // `code-review-bot`. Live writes need the App's `administration: write`.
    ['copilotReview', tools.length === 0 || tools.includes('code-review-bot'),
      () => applyCopilotReviewRulesets(gh, owner, findings, config, opts)],
    // Dependabot security-updates enablement (ADR-012): delegates autonomous PR
    // generation to GitHub, so it is fenced OFF the scheduled path by
    // construction and never promotable via apply-schedule. Manual dispatch
    // only, on a blank `tools` or an explicit `dependabot-security`.
    ['dependabotSecurity', depSec.enable,
      () => applyDependabotSecurityUpdates(gh, owner, findings, config, opts)],
    // Its reversal (ADR-012): behind the identical fences, and EXPLICIT only —
    // never on a blank `tools`, so a rollback never rides an enable/apply run.
    // DELETE reverts the setting, not any bump PR GitHub already opened.
    ['dependabotSecurityOff', depSec.disable,
      () => disableDependabotSecurityUpdates(gh, owner, findings, config, opts)],
    // Lockfile refresh (ADR-015): explicit on a manual dispatch, allow-list-
    // gated on the scheduled path. Its dry-run runs npm and the gate but writes
    // nothing.
    ['lockfileUpdate', isLockfileUpdateRequested(tools, scheduled),
      () => applyLockfileUpdates(gh, owner, findings, config, opts)],
    // Selective auto-merge reconcile pass (ADR-007 stage 5): NOT triggered by a
    // blank-tools run. Only the real cron (the workflow sets INPUT_AUTOMERGE on
    // github.event_name == 'schedule') or an explicit `tools=automerge`, so a
    // normal live apply run never auto-merges by surprise.
    ['automerge', process.env.INPUT_AUTOMERGE === 'true' || tools.includes('automerge'),
      () => autoMergeGovernancePRs(gh, owner, findings, config, { dryRun, maxPerRun })],
  ];

  const results = {};
  for (const [key, requested, run] of dispatch) {
    if (!requested) continue;
    const result = await run();
    results[key] = result;
    if (key === 'apply') console.log(`Apply complete: ${result?.results?.length || 0} repos processed.`);
    if (result?.summary && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(result.summary)}\n`);
    }
  }

  // Per-repo errors (e.g. App lacks workflows: write on a target installation)
  // are operator-actionable failures: each one is a finding the operator asked
  // to remediate that did not land. Throw so runPhases marks the phase failed
  // and the workflow exits non-zero.
  const errParts = [];
  for (const [key, { failed, line }] of Object.entries(REPORTING)) {
    const result = results[key];
    if (!(result?.summary?.errors > 0)) continue;
    const names = result.results.filter(r => r.status === 'error').map(failed).join(', ');
    errParts.push(line(result.summary, names));
  }
  if (errParts.length > 0) {
    throw new Error(errParts.join(' | '));
  }
}
