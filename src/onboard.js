// Auto-onboarding: opens a welcome PR to repos that lack the repo-butler
// consumer guide in their CLAUDE.md. Triggered by the GitHub App installation
// webhook or manually via the onboard workflow.
//
// Usage: GITHUB_TOKEN=... node src/onboard.js [repo1] [repo2] ...
// If no repos are specified, reads ONBOARD_REPOS env var (comma-separated).

import { createClient } from './github.js';
import { sanitizeContributorName, validateGitHubUsername } from './safety.js';

const BRANCH_NAME = 'repo-butler/onboard';
const MARKER = 'repo-butler';

const CONSUMER_GUIDE_SECTION = `## Repo Butler

This repo is monitored by [Repo Butler](https://github.com/IsmaelMartinez/repo-butler), a portfolio health agent that observes repo health daily and generates dashboards, governance proposals, and tier classifications.

**Your report:** https://ismaelmartinez.github.io/repo-butler/{REPO_NAME}.html
**Portfolio dashboard:** https://ismaelmartinez.github.io/repo-butler/
**Consumer guide:** https://github.com/IsmaelMartinez/repo-butler/blob/main/docs/consumer-guide.md

### Querying Reginald (the butler MCP server)

To query your repo's health tier, governance findings, and portfolio data from any Claude Code session, add the MCP server once (adjust the path to your local repo-butler checkout):

\`\`\`bash
claude mcp add repo-butler node /path/to/repo-butler/src/mcp.js
\`\`\`

Available tools: \`get_health_tier\`, \`get_campaign_status\`, \`query_portfolio\`, \`get_snapshot_diff\`, \`get_governance_findings\`, \`trigger_refresh\`.

When working on health improvements, check the per-repo report for the current tier checklist and use the consumer guide for fix instructions.
`;

const PR_BODY = `## Welcome to Repo Butler

This PR adds the Repo Butler consumer guide to your CLAUDE.md so AI agents working on this repo can:

- Check the repo's health tier and see which checks pass or fail
- Query portfolio-wide governance findings via the MCP server
- Follow fix instructions from the consumer guide for any flagged issues

The consumer guide explains every health tier check, campaign, governance finding, and license concern with concrete fix instructions.

**Your report:** https://ismaelmartinez.github.io/repo-butler/{REPO_NAME}.html

---
*Opened automatically by [Repo Butler](https://github.com/IsmaelMartinez/repo-butler)*
`;

export async function onboard(token, repos) {
  const gh = createClient(token);
  const results = [];

  for (const repoFullName of repos) {
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
      console.warn(`Skipping invalid repo format: ${repoFullName}`);
      continue;
    }

    if (!validateGitHubUsername(owner)) {
      console.warn(`Skipping repo with invalid owner: ${repoFullName}`);
      continue;
    }
    const safeName = sanitizeContributorName(repo);
    if (!safeName) {
      console.warn(`Skipping repo with unsafe name: ${repoFullName}`);
      continue;
    }

    try {
      const result = await onboardRepo(gh, owner, repo);
      results.push({ repo: repoFullName, ...result });
    } catch (err) {
      console.error(`Failed to onboard ${repoFullName}: ${err.message}`);
      results.push({ repo: repoFullName, status: 'error', error: err.message });
    }
  }

  return results;
}

async function onboardRepo(gh, owner, repo) {
  // Check if CLAUDE.md already references repo-butler.
  const existing = await gh.getFileContent(owner, repo, 'CLAUDE.md');

  if (existing && existing.includes(MARKER)) {
    console.log(`${owner}/${repo}: already onboarded, skipping.`);
    return { status: 'skipped', reason: 'already onboarded' };
  }

  // Check if a PR already exists for this.
  let existingPRs;
  try {
    existingPRs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
      params: { state: 'open', head: `${owner}:${BRANCH_NAME}`, per_page: 10 },
      max: 10,
    });
  } catch {
    existingPRs = [];
  }

  if (existingPRs.length > 0) {
    console.log(`${owner}/${repo}: onboarding PR already open (#${existingPRs[0].number}), skipping.`);
    return { status: 'skipped', reason: 'PR already open', pr: existingPRs[0].html_url };
  }

  // Get the default branch.
  const repoMeta = await gh.request(`/repos/${owner}/${repo}`);
  const defaultBranch = repoMeta.default_branch || 'main';

  // Prepare the new CLAUDE.md content.
  const section = CONSUMER_GUIDE_SECTION.replace(/\{REPO_NAME\}/g, repo);
  const newContent = existing
    ? existing + '\n' + section
    : `# CLAUDE.md\n\n${section}`;

  // Create a branch from the default branch. If it already exists (from a
  // previous failed attempt), update it to point at the current HEAD.
  const ref = await gh.request(`/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`);

  try {
    await gh.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${BRANCH_NAME}`, sha: ref.object.sha },
    });
  } catch {
    // Branch already exists — update it instead.
    await gh.request(`/repos/${owner}/${repo}/git/refs/heads/${BRANCH_NAME}`, {
      method: 'PATCH',
      body: { sha: ref.object.sha, force: true },
    });
  }

  // Write the CLAUDE.md file.
  let fileSha;
  try {
    const existingFile = await gh.request(`/repos/${owner}/${repo}/contents/CLAUDE.md`, {
      params: { ref: defaultBranch },
    });
    fileSha = existingFile.sha;
  } catch {
    // File doesn't exist yet.
  }

  await gh.request(`/repos/${owner}/${repo}/contents/CLAUDE.md`, {
    method: 'PUT',
    body: {
      message: 'chore: add repo-butler consumer guide to CLAUDE.md',
      content: Buffer.from(newContent).toString('base64'),
      branch: BRANCH_NAME,
      ...(fileSha ? { sha: fileSha } : {}),
    },
  });

  // Open the PR.
  const prBody = PR_BODY.replace(/\{REPO_NAME\}/g, repo);
  const pr = await gh.request(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: {
      title: 'chore: add Repo Butler consumer guide',
      head: BRANCH_NAME,
      base: defaultBranch,
      body: prBody,
    },
  });

  console.log(`${owner}/${repo}: onboarding PR created — ${pr.html_url}`);
  return { status: 'created', pr: pr.html_url };
}

// CLI entry point.
const isMain = process.argv[1]?.endsWith('onboard.js');
if (isMain) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN is required.');
    process.exit(1);
  }

  let repos = process.argv.slice(2);
  if (repos.length === 0 && process.env.ONBOARD_REPOS) {
    repos = process.env.ONBOARD_REPOS.split(',').map(r => r.trim()).filter(Boolean);
  }

  if (repos.length === 0) {
    console.error('Usage: node src/onboard.js owner/repo1 owner/repo2 ...');
    console.error('Or set ONBOARD_REPOS=owner/repo1,owner/repo2');
    process.exit(1);
  }

  onboard(token, repos)
    .then(results => {
      console.log('\nOnboarding results:');
      for (const r of results) {
        console.log(`  ${r.repo}: ${r.status}${r.pr ? ` — ${r.pr}` : ''}${r.error ? ` — ${r.error}` : ''}`);
      }
    })
    .catch(err => {
      console.error(`Onboarding failed: ${err.message}`);
      process.exit(1);
    });
}
