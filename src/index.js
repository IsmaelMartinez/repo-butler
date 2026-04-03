import { loadConfig } from './config.js';
import { observe, observePortfolio } from './observe.js';
import { assess, computeTrends } from './assess.js';
import { update } from './update.js';
import { ideate } from './ideate.js';
import { propose } from './propose.js';
import { report } from './report.js';
import { createStore } from './store.js';
import { GeminiProvider } from './providers/gemini.js';
import { ClaudeProvider } from './providers/claude.js';
import { createTriageBotClient } from './triage-bot.js';

const PHASES = ['observe', 'assess', 'update', 'ideate', 'propose', 'report'];

export function validateRepoFormat(repo) {
  if (!repo.includes('/')) {
    throw new Error(`GITHUB_REPOSITORY must be in "owner/repo" format, got: "${repo}"`);
  }
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

  // Default provider for ASSESS/UPDATE; deep provider for IDEATE.
  const defaultProvider = providers[config.providers?.default] || providers.gemini || null;
  const deepProvider = providers[config.providers?.deep] || providers.claude || defaultProvider;

  // Validate LLM provider early if LLM phases will run.
  const llmPhases = ['assess', 'update', 'ideate'];
  const phasesToRun = phase === 'all' ? PHASES : [phase];
  const needsLLM = phasesToRun.some(p => llmPhases.includes(p));

  if (needsLLM && defaultProvider) {
    const { validateProvider } = await import('./safety.js');
    console.log(`Validating ${defaultProvider.name} provider...`);
    const check = await validateProvider(defaultProvider);
    if (!check.valid) {
      console.error(`Provider validation failed: ${check.error}`);
      process.exit(1);
    }
    console.log('Provider OK.');
  }

  // Initialise snapshot store.
  const store = createStore(context);
  context.store = store;

  // Auto-discover triage bot integration (optional, fails gracefully).
  const triageBot = await createTriageBotClient(context);
  context.triageBot = triageBot;

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

        // Send observation to triage bot if available.
        if (triageBot) {
          await triageBot.ingestEvents(snapshot);
        }

        // Read weekly history for trend analysis.
        context.weeklyHistory = await store.readWeeklyHistory();
        console.log(`Loaded ${context.weeklyHistory.length} weekly snapshots for trends.`);

        // Fetch enriched portfolio details early when IDEATE will run (for governance).
        if (portfolio && phasesToRun.includes('ideate')) {
          const { fetchPortfolioDetails } = await import('./report-portfolio.js');
          const gh = (await import('./github.js')).createClient(token);
          context.repoDetails = await fetchPortfolioDetails(gh, owner, portfolio.repos);
          console.log(`Enriched ${Object.keys(context.repoDetails).length} repos for governance.`);
        }

        console.log('Repo summary:', JSON.stringify(snapshot.summary, null, 2));
        console.log('Portfolio classification:', JSON.stringify(portfolio.classification, null, 2));
        break;
      }

      case 'assess': {
        // Fetch triage bot synthesis findings if available.
        if (triageBot) {
          const rawTrends = await triageBot.fetchTrends();
          if (rawTrends) {
            const { validateTriageBotTrends } = await import('./safety.js');
            const validation = validateTriageBotTrends(rawTrends);
            if (!validation.valid) {
              console.warn(`Triage bot trends failed validation: ${validation.error} — ignoring.`);
            } else {
              context.triageBotTrends = validation.sanitized;
            }
          }
        }

        context.provider = defaultProvider;
        const assessment = await assess(context);
        context.assessment = assessment;
        if (assessment?.assessment) {
          console.log('Assessment:', assessment.assessment);
        }

        // Compute trends from weekly history if available.
        if (context.weeklyHistory?.length > 0) {
          context.trends = computeTrends(context.weeklyHistory);
          console.log(`Trend direction: ${context.trends.direction} (${context.trends.weeks.length} weeks)`);
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

        // Run governance detection if portfolio data is available.
        if (context.portfolio && context.repoDetails) {
          const { parseStandardsConfig } = await import('./config.js');
          const { detectStandardsGaps, detectPolicyDrift, generateUpliftProposals } = await import('./governance.js');

          const standards = parseStandardsConfig(config);
          const gaps = detectStandardsGaps(standards, context.portfolio.repos, context.repoDetails);
          const drift = detectPolicyDrift(context.portfolio.repos, context.repoDetails);
          const uplift = generateUpliftProposals(context.portfolio.repos, context.repoDetails, config);

          context.governanceFindings = [...gaps.findings, ...drift, ...uplift];
          console.log(`Governance: ${context.governanceFindings.length} findings (${gaps.findings.length} gaps, ${drift.length} drift, ${uplift.length} uplift)`);
        }

        const result = await ideate(context);
        context.ideas = result?.ideas || [];

        // Persist governance findings for MCP consumption.
        if (context.governanceFindings?.length > 0 && store) {
          await store.writeGovernanceFindings(context.governanceFindings);
        }
        break;
      }

      case 'propose': {
        const result = await propose(context);
        context.proposeResult = result;
        break;
      }

      case 'report': {
        const result = await report(context);
        context.reportResult = result;
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
