// Optional integration with github-issue-triage-bot.
// Auto-discovers the bot from .github/butler.json in the target repo.
// All calls fail gracefully — a missing or unreachable bot never blocks the pipeline.

import { createClient } from './github.js';

export async function createTriageBotClient(context) {
  const { owner, repo, token } = context;
  const gh = createClient(token);

  // Try to discover the bot's URL from the target repo's .github/butler.json.
  const config = await discoverBotConfig(gh, owner, repo);

  if (!config) {
    return null;
  }

  const baseUrl = config.bot_url;
  const ingestSecret = process.env.TRIAGE_BOT_INGEST_SECRET;
  const repoKey = `${owner}/${repo}`;

  console.log(`Triage bot discovered at ${baseUrl} for ${repoKey}`);

  return {
    available: true,
    dashboardUrl: `${baseUrl}/dashboard`,

    // POST observation data to the bot's /ingest endpoint.
    async ingestEvents(snapshot) {
      if (!ingestSecret) {
        console.log('Triage bot: no TRIAGE_BOT_INGEST_SECRET set, skipping event ingestion.');
        return null;
      }

      const events = snapshotToEvents(snapshot, repoKey);
      if (events.length === 0) return null;

      try {
        const res = await fetch(`${baseUrl}/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ingestSecret}`,
          },
          body: JSON.stringify({ events }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.warn(`Triage bot ingest failed: ${res.status} ${text.slice(0, 100)}`);
          return null;
        }

        const data = await res.json().catch(() => ({}));
        console.log(`Triage bot: ingested ${events.length} events.`);
        return data;
      } catch (err) {
        console.warn(`Triage bot ingest unreachable: ${err.message}`);
        return null;
      }
    },

    // GET synthesis findings from /report/trends.
    async fetchTrends() {
      try {
        const res = await fetch(`${baseUrl}/report/trends`);

        if (!res.ok) {
          console.warn(`Triage bot trends unavailable: ${res.status}`);
          return null;
        }

        const data = await res.json().catch(() => null);
        if (!data) {
          console.warn('Triage bot trends: empty or invalid JSON response.');
          return null;
        }
        console.log('Triage bot: loaded synthesis trends.');
        return data;
      } catch (err) {
        console.warn(`Triage bot trends unreachable: ${err.message}`);
        return null;
      }
    },
  };
}

// Discover the bot config from the target repo's .github/butler.json.
async function discoverBotConfig(gh, owner, repo) {
  // Check for explicit env var first.
  if (process.env.TRIAGE_BOT_URL) {
    const url = process.env.TRIAGE_BOT_URL.replace(/\/+$/, '');
    if (!url.startsWith('https://')) {
      console.warn('TRIAGE_BOT_URL must start with https:// — ignoring.');
      return null;
    }
    return { bot_url: url };
  }

  // Try reading .github/butler.json from the repo.
  const content = await gh.getFileContent(owner, repo, '.github/butler.json');
  if (!content) return null;

  try {
    const config = JSON.parse(content);
    if (config.bot_url) {
      const url = config.bot_url.replace(/\/+$/, '');
      if (!url.startsWith('https://')) {
        console.warn(`butler.json bot_url must start with https:// — got "${url.slice(0, 50)}", ignoring.`);
        return null;
      }
      return { bot_url: url };
    }
  } catch {
    console.warn('butler.json: malformed JSON, skipping triage bot integration.');
  }

  return null;
}

// Convert a snapshot into events for the triage bot's /ingest endpoint.
function snapshotToEvents(snapshot, repoKey) {
  const events = [];
  const now = new Date().toISOString();

  events.push({
    repo: repoKey,
    event_type: 'butler_observation',
    source_ref: `snapshot-${now.split('T')[0]}`,
    summary: `Repo Butler observation: ${snapshot.summary?.open_issues || 0} open issues, ${snapshot.summary?.recently_merged_prs || 0} merged PRs (90d), latest release ${snapshot.summary?.latest_release || 'none'}`,
    areas: ['metrics', 'observation'],
    metadata: {
      open_issues: snapshot.summary?.open_issues,
      blocked_issues: snapshot.summary?.blocked_issues,
      awaiting_feedback: snapshot.summary?.awaiting_feedback,
      recently_merged_prs: snapshot.summary?.recently_merged_prs,
      latest_release: snapshot.summary?.latest_release,
      source: 'repo-butler',
    },
    created_at: now,
  });

  return events;
}

// Export for testing.
export { snapshotToEvents, discoverBotConfig };
