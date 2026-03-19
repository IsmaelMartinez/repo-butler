import { loadConfig } from './config.js';
import { observe } from './observe.js';

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

  const [owner, name] = repo.split('/');
  const context = { owner, repo: name, token, config, dryRun };

  const phasesToRun = phase === 'all' ? PHASES : [phase];

  for (const p of phasesToRun) {
    console.log(`\n=== Phase: ${p.toUpperCase()} ===\n`);

    switch (p) {
      case 'observe': {
        const snapshot = await observe(context);
        context.snapshot = snapshot;
        console.log(JSON.stringify(snapshot.summary, null, 2));
        break;
      }
      case 'assess':
      case 'update':
      case 'ideate':
      case 'propose':
        console.log(`Phase "${p}" is not yet implemented.`);
        break;
      default:
        console.error(`Unknown phase: ${p}`);
        process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
