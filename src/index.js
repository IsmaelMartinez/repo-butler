import { appendFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { runObserve } from './observe.js';
import { runAssess } from './assess.js';
import { runUpdate } from './update.js';
import { runIdeate } from './ideate.js';
import { runPropose } from './propose.js';
import { runReport, reportCacheHit } from './report.js';
import { runMonitor } from './monitor.js';
import { runGovernance } from './governance.js';
import { createStore } from './store.js';
import { GeminiProvider } from './providers/gemini.js';
import { ClaudeProvider } from './providers/claude.js';
import { validateProvider } from './safety.js';
import { onboard } from './onboard.js';
import { createClient } from './github.js';

const PHASES = ['observe', 'assess', 'update', 'governance', 'ideate', 'propose', 'report', 'monitor'];

async function runApply(context) {
  const { owner, token, config, store } = context;
  const findings = store ? await store.readGovernanceFindings() : [];
  if (!findings || findings.length === 0) {
    console.log('No governance findings to apply.');
    return;
  }
  const maxPerRun = parseInt(process.env.INPUT_MAX_APPLY_PER_RUN, 10) || 5;
  const tools = (process.env.INPUT_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const isDryRun = (process.env.INPUT_DRY_RUN || 'true') !== 'false';
  // Stage 4 (ADR-007): set by the scheduled apply workflow only. On the no-human
  // path, apply.js gates each finding class behind the apply-schedule allow-list.
  const scheduled = process.env.INPUT_SCHEDULED === 'true';
  let applyGovernanceFindings, nudgeStaleDependabotPRs, applyCopilotReviewRulesets, applyDependabotSecurityUpdates, disableDependabotSecurityUpdates, autoMergeGovernancePRs;
  try {
    ({ applyGovernanceFindings, nudgeStaleDependabotPRs, applyCopilotReviewRulesets, applyDependabotSecurityUpdates, disableDependabotSecurityUpdates, autoMergeGovernancePRs } = await import('./apply.js'));
  } catch {
    console.error('Apply module not available yet (src/apply.js). Skipping.');
    return;
  }
  const gh = createClient(token);
  const result = await applyGovernanceFindings(gh, owner, findings, config, {
    dryRun: isDryRun,
    maxPerRun,
    tools: tools.length > 0 ? tools : null,
    scheduled,
  });
  const processed = result?.results?.length || 0;
  console.log(`Apply complete: ${processed} repos processed.`);

  const summary = result?.summary;
  if (summary && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `apply=${JSON.stringify(summary)}\n`,
    );
  }

  // Stale-Dependabot nudge rides the same dispatch and gates. It runs on a blank
  // `tools` (all actionable) or when `tools` explicitly names `dependabot-rebase`
  // — so a tool-scoped dispatch (e.g. tools=code-scanning) never nudges by
  // surprise, and tools=dependabot-rebase is a nudge-only run.
  const nudgeRequested = tools.length === 0 || tools.includes('dependabot-rebase');
  const nudgeResult = nudgeRequested
    ? await nudgeStaleDependabotPRs(gh, owner, findings, config, { dryRun: isDryRun, maxPerRun, scheduled })
    : null;
  if (nudgeResult?.summary && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `nudge=${JSON.stringify(nudgeResult.summary)}\n`,
    );
  }

  // Copilot-review enablement (ADR-009 settings write) rides the same dispatch and
  // gates. It runs on a blank `tools` (all actionable) or when `tools` explicitly
  // names `code-review-bot` — so a tool-scoped dispatch never enables it by
  // surprise. Live writes need the App's `administration: write` scope; without it
  // the dry-run preview still runs and live writes surface as per-repo errors.
  const copilotRequested = tools.length === 0 || tools.includes('code-review-bot');
  const copilotResult = copilotRequested
    ? await applyCopilotReviewRulesets(gh, owner, findings, config, { dryRun: isDryRun, maxPerRun, scheduled })
    : null;
  if (copilotResult?.summary && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `copilotReview=${JSON.stringify(copilotResult.summary)}\n`,
    );
  }

  // Dependabot security-updates enablement (ADR-012 settings write) rides the same
  // dispatch and gates, but is fenced OFF the no-human scheduled path BY
  // CONSTRUCTION: enabling GitHub's automated security fixes delegates autonomous PR
  // generation to GitHub, so a scheduled run must never trigger it. It is never
  // dispatched here on a scheduled run, and (unlike the Copilot settings write) is
  // never promotable via apply-schedule. Manual dispatch only: it runs on a blank
  // `tools` (all actionable) or when `tools` explicitly names `dependabot-security`.
  // Live writes need the App's `administration: write` scope.
  const depSecRequested = !scheduled && (tools.length === 0 || tools.includes('dependabot-security'));
  const depSecResult = depSecRequested
    ? await applyDependabotSecurityUpdates(gh, owner, findings, config, { dryRun: isDryRun, maxPerRun, scheduled })
    : null;
  if (depSecResult?.summary && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `dependabotSecurity=${JSON.stringify(depSecResult.summary)}\n`,
    );
  }

  // Dependabot security-updates DISABLE (ADR-012 reversibility, the mirror of
  // dependabot-security). Behind the identical fences, and — like the enable path —
  // fenced OFF the no-human scheduled path by construction. EXPLICIT dispatch only:
  // it never fires on a blank `tools` run (which enables actionable findings), only
  // when `tools` names `dependabot-security-off`, so a rollback is always a
  // deliberate operator action and never rides an enable/apply run. Live DELETEs
  // need the App's `administration: write` scope. DELETE reverts the SETTING, not
  // any bump PR GitHub already opened.
  const depSecOffRequested = !scheduled && tools.includes('dependabot-security-off');
  const depSecOffResult = depSecOffRequested
    ? await disableDependabotSecurityUpdates(gh, owner, findings, config, { dryRun: isDryRun, maxPerRun, scheduled })
    : null;
  if (depSecOffResult?.summary && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `dependabotSecurityOff=${JSON.stringify(depSecOffResult.summary)}\n`,
    );
  }

  // Selective auto-merge reconcile pass (ADR-007 stage 5). Squash-merges the
  // butler's own green templated apply PRs for `apply-automerge`-allow-listed
  // classes (default empty → no-op). Deliberately NOT triggered by a blank-tools
  // full run: it fires only on the real scheduled cron (the workflow sets
  // INPUT_AUTOMERGE only when github.event_name == 'schedule') or an explicit
  // `tools=automerge` dispatch — so opening PRs (a normal live apply run) never
  // auto-merges by surprise once a class is allow-listed. Honours the run's dry-run.
  const autoMergeRequested = process.env.INPUT_AUTOMERGE === 'true' || tools.includes('automerge');
  const autoMergeResult = autoMergeRequested
    ? await autoMergeGovernancePRs(gh, owner, findings, config, { dryRun: isDryRun, maxPerRun })
    : null;
  if (autoMergeResult?.summary && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `automerge=${JSON.stringify(autoMergeResult.summary)}\n`,
    );
  }

  // Per-repo errors (e.g. App lacks workflows: write on a target installation)
  // are operator-actionable failures: each one represents a finding the operator
  // explicitly asked to remediate that did not produce a PR. Surface them by
  // throwing so runPhases marks the phase failed and the workflow exits non-zero.
  const errParts = [];
  if (summary?.errors > 0) {
    const failed = result.results
      .filter(r => r.status === 'error')
      .map(r => `${r.repo}/${r.tool}`)
      .join(', ');
    errParts.push(
      `apply: ${summary.errors} per-repo error(s) [${failed}]; ${summary.created} PR(s) created, ${summary.skipped} skipped`,
    );
  }
  if (nudgeResult?.summary?.errors > 0) {
    const failed = nudgeResult.results
      .filter(r => r.status === 'error')
      .map(r => `${r.repo}#${r.number}`)
      .join(', ');
    errParts.push(
      `nudge: ${nudgeResult.summary.errors} error(s) [${failed}]; ${nudgeResult.summary.nudged} rebased, ${nudgeResult.summary.skipped} skipped`,
    );
  }
  if (copilotResult?.summary?.errors > 0) {
    const failed = copilotResult.results
      .filter(r => r.status === 'error')
      .map(r => r.repo)
      .join(', ');
    errParts.push(
      `copilot-review: ${copilotResult.summary.errors} error(s) [${failed}]; ${copilotResult.summary.created} created, ${copilotResult.summary.skipped} skipped`,
    );
  }
  if (depSecResult?.summary?.errors > 0) {
    const failed = depSecResult.results
      .filter(r => r.status === 'error')
      .map(r => r.repo)
      .join(', ');
    errParts.push(
      `dependabot-security: ${depSecResult.summary.errors} error(s) [${failed}]; ${depSecResult.summary.enabled} enabled, ${depSecResult.summary.skipped} skipped`,
    );
  }
  if (depSecOffResult?.summary?.errors > 0) {
    const failed = depSecOffResult.results
      .filter(r => r.status === 'error')
      .map(r => r.repo)
      .join(', ');
    errParts.push(
      `dependabot-security-off: ${depSecOffResult.summary.errors} error(s) [${failed}]; ${depSecOffResult.summary.removed} disabled`,
    );
  }
  if (autoMergeResult?.summary?.errors > 0) {
    const failed = autoMergeResult.results
      .filter(r => r.status === 'error')
      .map(r => `${r.repo}/${r.tool}`)
      .join(', ');
    errParts.push(
      `automerge: ${autoMergeResult.summary.errors} error(s) [${failed}]; ${autoMergeResult.summary.merged} merged, ${autoMergeResult.summary.skipped} skipped`,
    );
  }
  if (errParts.length > 0) {
    throw new Error(errParts.join(' | '));
  }
}

const PHASE_RUNNERS = {
  observe: runObserve,
  assess: runAssess,
  update: runUpdate,
  governance: runGovernance,
  ideate: runIdeate,
  propose: runPropose,
  report: runReport,
  monitor: runMonitor,
  apply: runApply,
};

export function validateRepoFormat(repo) {
  if (!repo.includes('/')) {
    throw new Error(`GITHUB_REPOSITORY must be in "owner/repo" format, got: "${repo}"`);
  }
}

export function parsePhases(phase) {
  if (phase === 'all') return PHASES;
  const list = phase.split(',').map(p => p.trim()).filter(Boolean);
  for (const p of list) {
    if (!PHASE_RUNNERS[p]) {
      throw new Error(`Unknown phase: "${p}". Valid phases: ${Object.keys(PHASE_RUNNERS).join(', ')}, all.`);
    }
  }
  return list;
}

// Pick the LLM provider for a given phase. ASSESS and UPDATE use the default
// provider (Gemini); IDEATE and MONITOR use the deep provider (Claude).
function providerForPhase(phase, defaultProvider, deepProvider) {
  if (phase === 'ideate' || phase === 'monitor') return deepProvider;
  if (phase === 'assess' || phase === 'update') return defaultProvider;
  return null;
}

// Tracks the most recent phase entered so the exit handler can name it if
// Node terminates mid-pipeline. Module-level so the handler installed in
// installCrashHandlers can read it without plumbing context through.
let activePhase = null;
let pipelineResults = [];

export function getPipelineState() {
  return { activePhase, results: pipelineResults.slice() };
}

// Phase boundary lines go to stderr because CI stdout is block-buffered
// and a process that exits before the buffer flushes silently loses every
// recent log line. stderr is line-buffered, so the COMPLETE/FAILED marker
// survives an abrupt exit and remains visible in the Actions log.
// stdout is drained first so the boundary cannot overtake a phase's own log
// lines still sitting in the block buffer — otherwise the Actions log shows
// e.g. a PROPOSE "DRY RUN" line AFTER the PROPOSE COMPLETE banner, which
// makes the soak log confusing to read. The empty write's callback fires
// once everything queued before it has been flushed to the pipe.
// Best-effort: a closed/destroyed stdout (e.g. a broken pipe at shutdown) must
// not throw or stall here of all places — skip the drain and emit the banner.
function logPhaseBoundary(line) {
  return new Promise(resolve => {
    const emit = () => {
      console.error(line);
      resolve();
    };
    try {
      if (!process.stdout.writable) return emit();
      process.stdout.write('', emit);
    } catch {
      emit();
    }
  });
}

// Run the phase pipeline with per-phase isolation: an exception in one phase
// logs loudly and sets process.exitCode but does not skip later phases.
// Otherwise a flaky upstream phase (e.g. governance hitting a libyear timeout
// edge case) silently swallows REPORT and the Pages deploy is a no-op.
// Returns an array of { phase, status, durationMs, error? } for tests.
export async function runPhases(phasesToRun, context, defaultProvider, deepProvider, runners = PHASE_RUNNERS) {
  pipelineResults = [];
  for (const p of phasesToRun) {
    activePhase = p;
    await logPhaseBoundary(`\n=== Phase: ${p.toUpperCase()} ===\n`);
    const runner = runners[p];
    if (!runner) {
      console.error(`Unknown phase: ${p}`);
      process.exitCode = 1;
      pipelineResults.push({ phase: p, status: 'failed', durationMs: 0, error: new Error(`Unknown phase: ${p}`) });
      continue;
    }
    context.provider = providerForPhase(p, defaultProvider, deepProvider);
    const start = Date.now();
    try {
      await runner(context);
      const durationMs = Date.now() - start;
      await logPhaseBoundary(`\n=== Phase: ${p.toUpperCase()} COMPLETE (${(durationMs / 1000).toFixed(1)}s) ===\n`);
      pipelineResults.push({ phase: p, status: 'ok', durationMs });
    } catch (err) {
      const durationMs = Date.now() - start;
      await logPhaseBoundary(`\n=== Phase: ${p.toUpperCase()} FAILED (${(durationMs / 1000).toFixed(1)}s) ===`);
      console.error(err?.stack || err);
      process.exitCode = 1;
      pipelineResults.push({ phase: p, status: 'failed', durationMs, error: err });
    }
  }
  activePhase = null;
  return pipelineResults.slice();
}

// Fail the pipeline loudly on silent crashes. Without these handlers an
// unhandled rejection in a fire-and-forget code path (e.g. an aborted libyear
// fetch) can terminate Node mid-pipeline with exit 0 — causing later phases
// (REPORT, MONITOR) to be silently skipped while the workflow reports success.
// See issue #203.
function installCrashHandlers() {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection — failing pipeline:');
    console.error(reason?.stack || reason);
    process.exitCode = 1;
  });
  process.on('uncaughtException', (err) => {
    // After an uncaughtException the process is in an undefined state — Node's
    // documented contract is to log and exit, not to continue. Per-phase
    // isolation only applies to errors caught inside runPhases; anything that
    // escapes that try/catch is by definition unsafe to recover from.
    console.error('Uncaught exception — failing pipeline:');
    console.error(err?.stack || err);
    process.exit(1);
  });
  // Diagnostic: fires when the event loop is empty but async work could still
  // be scheduled. If it fires while a phase is still active, the awaited
  // promise chain has been abandoned (e.g. a fire-and-forget rejection that
  // settles after its caller moved on). 'beforeExit' does NOT fire when
  // process.exit() is called explicitly, so seeing this line distinguishes
  // event-loop drain from an explicit exit — discriminator for issue #218.
  process.on('beforeExit', (code) => {
    const { activePhase: phase } = getPipelineState();
    if (phase) {
      console.error(`[pipeline] beforeExit code=${code} during phase=${phase} (event loop drained — async work was abandoned, not an explicit process.exit)`);
      // Loop draining mid-phase is itself a failure: the awaited promise
      // chain has been abandoned, so the pipeline has not done its work.
      // Convert the silent exit-0 into a loud exit-1 so the workflow fails.
      process.exitCode = 1;
    }
  });
  // Diagnostic: name the active phase when Node exits. If the pipeline ends
  // mid-phase (because of a process.exit elsewhere, a crash before the
  // unhandledRejection handler ran, or a stream-buffer flush failure) the
  // exit handler is the last writer to stderr and tells us which phase was
  // running. Without this, runs like #215 leave no trace of where the
  // pipeline stopped.
  process.on('exit', (code) => {
    const { activePhase: phase, results } = getPipelineState();
    if (phase) {
      console.error(`[pipeline] exit code=${code} during phase=${phase} (no COMPLETE/FAILED logged — likely silent termination)`);
    } else if (results.length > 0) {
      const summary = results.map(r => `${r.phase}=${r.status}`).join(' ');
      console.error(`[pipeline] exit code=${code} after phases: ${summary}`);
    }
  });
}

async function main() {
  installCrashHandlers();

  const phase = process.env.INPUT_PHASE
    || process.argv.find(a => a.startsWith('--phase='))?.split('=')[1]
    || 'all';

  const configPath = process.env.INPUT_CONFIG_PATH || '.github/roadmap.yml';
  const dryRun = (process.env.INPUT_DRY_RUN || 'true') !== 'false';
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  if (!token) {
    console.error('Error: No GitHub token found. Set GITHUB_TOKEN or INPUT_GITHUB_TOKEN.');
    process.exit(1);
  }

  const config = await loadConfig(configPath);
  const repo = process.env.GITHUB_REPOSITORY || config.repository;

  if (!repo) {
    console.error('Error: No repository specified. Set GITHUB_REPOSITORY or add repository to config.');
    process.exit(1);
  }

  validateRepoFormat(repo);

  const [owner, name] = repo.split('/');
  const forceReport = (process.env.REPORT_FORCE || '') === 'true';
  const context = { owner, repo: name, token, config, dryRun, forceReport };

  // Initialise LLM providers from environment or action inputs.
  const geminiKey = process.env.INPUT_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const claudeKey = process.env.INPUT_CLAUDE_API_KEY || process.env.CLAUDE_API_KEY;

  const providers = {};
  if (geminiKey) providers.gemini = new GeminiProvider(geminiKey);
  if (claudeKey) providers.claude = new ClaudeProvider(claudeKey);

  const defaultProvider = providers[config.providers?.default] || providers.gemini || null;
  const deepProvider = providers[config.providers?.deep] || providers.claude || defaultProvider;

  // Validate LLM provider early if any LLM phase will run.
  const llmPhases = ['assess', 'update', 'ideate', 'monitor'];
  const phasesToRun = parsePhases(phase);
  const needsLLM = phasesToRun.some(p => llmPhases.includes(p));

  if (needsLLM && defaultProvider) {
    console.log(`Validating ${defaultProvider.name} provider...`);
    const check = await validateProvider(defaultProvider);
    if (!check.valid) {
      console.error(`Provider validation failed: ${check.error}`);
      process.exit(1);
    }
    console.log('Provider OK.');
  }

  context.store = createStore(context);

  await runPhases(phasesToRun, context, defaultProvider, deepProvider);

  // Auto-onboard new portfolio repos that lack the CLAUDE.md marker.
  if (context.portfolio && !dryRun) {
    const activeRepos = context.portfolio.repos
      .filter(r => !r.archived && !r.fork)
      .map(r => r.full_name);

    if (activeRepos.length > 0) {
      console.log(`\n=== AUTO-ONBOARD ===\n`);
      console.log(`Checking ${activeRepos.length} repos for onboarding...`);
      const results = await onboard(token, activeRepos);
      const created = results.filter(r => r.status === 'created');
      const skipped = results.filter(r => r.status === 'skipped');
      const errors = results.filter(r => r.status === 'error');
      console.log(`Onboarding: ${created.length} new, ${skipped.length} already done, ${errors.length} errors`);
    }
  }

  // Output summary for GitHub Actions.
  if (process.env.GITHUB_OUTPUT) {
    const summary = {
      snapshot_summary: context.snapshot?.summary,
      portfolio: context.portfolio?.classification,
      assessment: context.assessment?.assessment,
      ideas_count: context.ideas?.length || 0,
      issues_created: context.proposeResult?.created?.length || 0,
    };
    appendFileSync(process.env.GITHUB_OUTPUT, `report=${JSON.stringify(summary)}\n`);
    // Signal whether the REPORT phase legitimately cache-hit (snapshot unchanged,
    // so no new index.html was written and the live dashboard is already current).
    // The self-test "Check reports exist" guard reads this to distinguish a
    // healthy cache-hit from a genuine missing-output failure (#216).
    appendFileSync(process.env.GITHUB_OUTPUT, `report_cached=${reportCacheHit(context)}\n`);
  }
}

// Only run when executed directly, not when imported for testing.
const isMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('src/index.js');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
