import { loadConfig } from './config.js';
import { observe, observePortfolio } from './observe.js';
import { assess } from './assess.js';
import { update } from './update.js';
import { ideate } from './ideate.js';
import { propose } from './propose.js';
import { createStore } from './store.js';
import { GeminiProvider } from './providers/gemini.js';
import { ClaudeProvider } from './providers/claude.js';

const PHASES = ['observe', 'assess', 'update', 'ideate', 'propose'];

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

  if (!repo.includes('/')) {
    console.error(`Error: GITHUB_REPOSITORY must be in "owner/repo" format, got: "${repo}"`);
    process.exit(1);
  }

  const [owner, name] = repo.split('/');
  const context = { owner, repo: name, token, config, dryRun };

  // Initialise LLM providers from environment or action inputs.
  const geminiKey = process.env.INPUT_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const claudeKey = process.env.INPUT_CLAUDE_API_KEY || process.env.CLAUDE_API_KEY;

  const providers = {};
  if (geminiKey) providers.gemini = new GeminiProvider(geminiKey);
  if (claudeKey) providers.claude = new ClaudeProvider(claudeKey);

  // Default provider for ASSESS/UPDATE; deep provider for IDEATE.
  const defaultProvider = providers[config.providers?.default] || providers.gemini || null;
  const deepProvider = providers[config.providers?.deep] || providers.claude || defaultProvider;

  // Initialise snapshot store.
  const store = createStore(context);

  const phasesToRun = phase === 'all' ? PHASES : [phase];

  for (const p of phasesToRun) {
    console.log(`\n=== Phase: ${p.toUpperCase()} ===\n`);

    switch (p) {
      case 'observe': {
        const snapshot = await observe(context);
        context.snapshot = snapshot;

        // Also run portfolio observation if this is the config repo.
        const portfolio = await observePortfolio(context);
        context.portfolio = portfolio;

        // Load previous snapshot for ASSESS.
        context.previousSnapshot = await store.readSnapshot();

        // Persist current snapshot.
        await store.writeSnapshot(snapshot);

        console.log('Repo summary:', JSON.stringify(snapshot.summary, null, 2));
        console.log('Portfolio classification:', JSON.stringify(portfolio.classification, null, 2));
        break;
      }

      case 'assess': {
        context.provider = defaultProvider;
        const assessment = await assess(context);
        context.assessment = assessment;
        if (assessment?.assessment) {
          console.log('Assessment:', assessment.assessment);
        }
        break;
      }

      case 'update': {
        context.provider = defaultProvider;
        const result = await update(context);
        context.updateResult = result;
        break;
      }

      case 'ideate': {
        context.provider = deepProvider;
        const result = await ideate(context);
        context.ideas = result?.ideas || [];
        break;
      }

      case 'propose': {
        const result = await propose(context);
        context.proposeResult = result;
        break;
      }

      default:
        console.error(`Unknown phase: ${p}`);
        process.exit(1);
    }
  }

  // Output summary for GitHub Actions.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    const report = {
      snapshot_summary: context.snapshot?.summary,
      portfolio: context.portfolio?.classification,
      assessment: context.assessment?.assessment,
      ideas_count: context.ideas?.length || 0,
      issues_created: context.proposeResult?.created?.length || 0,
    };
    appendFileSync(process.env.GITHUB_OUTPUT, `report=${JSON.stringify(report)}\n`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
