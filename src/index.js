import { appendFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { runObserve } from './observe.js';
import { runAssess } from './assess.js';
import { runUpdate } from './update.js';
import { runIdeate } from './ideate.js';
import { runPropose } from './propose.js';
import { runReport } from './report.js';
import { runMonitor } from './monitor.js';
import { createStore } from './store.js';
import { GeminiProvider } from './providers/gemini.js';
import { ClaudeProvider } from './providers/claude.js';
import { createTriageBotClient } from './triage-bot.js';
import { validateProvider } from './safety.js';
import { onboard } from './onboard.js';

const PHASES = ['observe', 'assess', 'update', 'ideate', 'propose', 'report', 'monitor'];

const PHASE_RUNNERS = {
  observe: runObserve,
  assess: runAssess,
  update: runUpdate,
  ideate: runIdeate,
  propose: runPropose,
  report: runReport,
  monitor: runMonitor,
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
    if (!PHASES.includes(p)) {
      throw new Error(`Unknown phase: "${p}". Valid phases: ${PHASES.join(', ')}, all.`);
    }
  }
  return list;
}

// Pick the LLM provider for a given phase. ASSESS/UPDATE use the default
// provider; IDEATE and MONITOR use the deep provider for richer reasoning.
function providerForPhase(phase, defaultProvider, deepProvider) {
  if (phase === 'ideate' || phase === 'monitor') return deepProvider;
  if (phase === 'assess' || phase === 'update') return defaultProvider;
  return null;
}

async function main() {
  const phase = process.env.INPUT_PHASE
    || process.argv.find(a => a.startsWith('--phase='))?.split('=')[1]
    || 'all';

  const configPath = process.env.INPUT_CONFIG_PATH || '.github/roadmap.yml';
  const dryRun = (process.env.INPUT_DRY_RUN || 'false') === 'true';
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
  context.triageBot = await createTriageBotClient(context);

  for (const p of phasesToRun) {
    console.log(`\n=== Phase: ${p.toUpperCase()} ===\n`);
    const runner = PHASE_RUNNERS[p];
    if (!runner) {
      console.error(`Unknown phase: ${p}`);
      process.exit(1);
    }
    context.provider = providerForPhase(p, defaultProvider, deepProvider);
    await runner(context);
  }

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
