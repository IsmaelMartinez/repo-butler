import { appendFileSync } from 'node:fs';
import { loadConfig, parseDryRun } from './config.js';
import { runObserve } from './observe.js';
import { runPrivateWatch } from './private-watch.js';
import { runAssess } from './assess.js';
import { runUpdate } from './update.js';
import { runIdeate } from './ideate.js';
import { runPropose } from './propose.js';
import { runReport, reportCacheHit } from './report.js';
import { runMonitor } from './monitor.js';
import { runGovernance } from './governance.js';
import { runApply } from './apply-run.js';
import { createStore } from './store.js';
import { GeminiProvider } from './providers/gemini.js';
import { ClaudeProvider } from './providers/claude.js';
import { validateProvider } from './safety.js';
import { onboard } from './onboard.js';

const PHASES = ['observe', 'assess', 'update', 'governance', 'ideate', 'propose', 'report', 'monitor'];

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
  // Runners that must know what follows them (runObserve gates the snapshot
  // write on an UPDATE being in the run) read the whole phase set from here.
  context.phases = phasesToRun.slice();
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
  const dryRun = parseDryRun(process.env.INPUT_DRY_RUN);
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

  // Auto-onboard new portfolio repos that lack the marker in AGENTS.md and CLAUDE.md.
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
      console.log(`Onboarding: ${created.length} new, ${skipped.length} skipped, ${errors.length} errors`);
      // Named, not just counted: an 'error' is a repo onboarding could not
      // judge (an unreadable instructions file or PR history), and a bare count would let
      // a token that lost read access pass for a quiet run. Public repos only.
      for (const r of errors) console.warn(`Onboarding error: ${r.repo}: ${r.reason ?? r.error}`);
    }
  }

  // Private-repo security watch. Deliberately a separate pass rather than part
  // of GOVERNANCE: private repos must never enter the shared `context` carriers
  // (repoDetails, governanceFindings), because those reach GitHub Pages, the
  // repo-butler-data branch, the LLM prompt and the propose soak ledger — all of
  // which are public, since repo-butler is a public repo. Findings go only to
  // the private repo itself. See private-watch.js.
  //
  // Runs even in dry-run (where it writes nothing but reports counts), and only
  // when OBSERVE populated the portfolio.
  if (context.portfolio?.privateRepos?.length) {
    console.log(`\n=== PRIVATE WATCH ===\n`);
    try {
      await runPrivateWatch(context);
    } catch (err) {
      // Never let the private watch fail the pipeline, and never log the error
      // text — it can carry a repo path.
      console.log(`Private watch: failed (${err.constructor?.name || 'Error'}); continuing.`);
    }
  }

  // Output summary for GitHub Actions. Note this reads portfolio.classification,
  // which observePortfolio computes from PUBLIC repos only.
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
