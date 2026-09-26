// Auto-onboarding: opens a welcome PR to repos that lack the repo-butler
// consumer guide in their CLAUDE.md. Triggered by the GitHub App installation
// webhook or manually via the onboard workflow.
//
// Usage: GITHUB_TOKEN=... node src/onboard.js [repo1] [repo2] ...
// If no repos are specified, reads ONBOARD_REPOS env var (comma-separated).

import { createClient } from './github.js';
import { validateGitHubUsername, REPO_NAME_PATTERN } from './safety.js';
import { isRecentlyDeclined } from './apply.js';

const BRANCH_NAME = 'repo-butler/onboard';
export const MARKER = 'repo-butler';

// How long a closed-unmerged onboarding PR suppresses a re-open. The auto-onboard
// pass runs on every live pipeline tick (4x/day), so without this a declined PR
// would be re-opened within hours. Same 30 days as apply and PROPOSE.
export const ONBOARD_DECLINE_COOLDOWN_DAYS = 30;

/**
 * Does a repo carry the repo-butler onboarding marker in its CLAUDE.md? The
 * marker is both a consent signal and a blast-radius fence (ADR-011): a
 * cross-repo PROPOSE issue (G9) is filed into a target only once it has been
 * onboarded. Fail-closed — a missing CLAUDE.md (getFileContent returns null), a
 * file without the marker, or any API error all return false, so an unreachable
 * or un-onboarded repo never receives a nudge.
 */
export async function hasOnboardingMarker(gh, owner, repo) {
  try {
    const content = await gh.getFileContent(owner, repo, 'CLAUDE.md');
    return typeof content === 'string' && content.includes(MARKER);
  } catch {
    return false;
  }
}

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

If this repo deploys a page, set its GitHub repository Homepage URL (the Website field in the repo's About section — not \`package.json\`'s \`homepage\`) to the canonical URL. That's how repo-butler surfaces the deployed link in dashboards and agent cards.
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
    if (!REPO_NAME_PATTERN.test(repo)) {
      console.warn(`onboard: skipping repo with invalid name: ${repoFullName}`);
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

/**
 * Read CLAUDE.md at commit `ref` as `{ content, sha }`, `null` when the file is
 * absent (404), or throw when it exists but cannot be read.
 *
 * Deliberately not getFileContent: that returns null for absent, any error AND
 * a file over 1 MB (the contents API then sends `encoding: "none"` with no
 * content while the sha is still present), and the caller rewrites the file
 * from whatever it read — so an unreadable CLAUDE.md read as "absent" would be
 * replaced wholesale by `# CLAUDE.md` plus the section.
 */
async function readClaudeMd(gh, owner, repo, ref) {
  let data;
  try {
    data = await gh.request(`/repos/${owner}/${repo}/contents/CLAUDE.md`, { params: { ref } });
  } catch (err) {
    // Match the status github.js writes straight after the path, never a bare
    // substring: the error carries the response body, and a 500 whose body
    // mentions ": 404" must stay unreadable rather than become "absent".
    if (/^GitHub API [A-Z]+ \S+: 404\b/.test(err.message ?? '')) return null;
    throw err;
  }
  if (data?.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new Error('CLAUDE.md content not returned');
  }
  return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha };
}

export async function onboardRepo(gh, owner, repo) {
  const repoMeta = await gh.request(`/repos/${owner}/${repo}`);
  const defaultBranch = repoMeta.default_branch || 'main';
  const headSha = (await gh.request(`/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`)).object.sha;

  // Read at the exact commit the branch will be created from, so the sha
  // passed to putFile below matches the branch and the write cannot 409 into
  // putFile's re-read-and-retry — which would overwrite a newer edit with
  // content built from this older read.
  let file;
  try {
    file = await readClaudeMd(gh, owner, repo, headSha);
  } catch (err) {
    // Fail CLOSED: the new file is built from this read, so a file we cannot
    // read must never be written over.
    console.log(`${owner}/${repo}: CLAUDE.md unreadable, skipping (fail-closed): ${err.message}`);
    return { status: 'error', reason: 'CLAUDE.md unreadable' };
  }

  if (file?.content.includes(MARKER)) {
    console.log(`${owner}/${repo}: already onboarded, skipping.`);
    return { status: 'skipped', reason: 'already onboarded' };
  }

  // Same decline rules as apply's screenApplyTarget: `state: 'all'` so a PR
  // the maintainer closed unmerged is seen; the read fails closed and reports
  // 'error'; anything not definitively closed blocks; merged PRs never suppress
  // (re-onboarding after a merge is legitimate).
  let branchPRs;
  try {
    branchPRs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
      params: { state: 'all', head: `${owner}:${BRANCH_NAME}`, per_page: 10 },
      max: 10,
    });
  } catch (err) {
    console.log(`${owner}/${repo}: onboarding PR history unreadable, skipping (fail-closed): ${err.message}`);
    return { status: 'error', reason: 'PR history unreadable' };
  }

  const openPR = branchPRs.find(pr => pr.state !== 'closed');
  if (openPR) {
    console.log(`${owner}/${repo}: onboarding PR already open (#${openPR.number}), skipping.`);
    return { status: 'skipped', reason: 'PR already open', pr: openPR.html_url };
  }

  const declined = branchPRs.find(pr => isRecentlyDeclined(pr, Date.now(), ONBOARD_DECLINE_COOLDOWN_DAYS));
  if (declined) {
    console.log(`${owner}/${repo}: onboarding PR #${declined.number} was closed unmerged within ${ONBOARD_DECLINE_COOLDOWN_DAYS}d, skipping.`);
    return { status: 'skipped', reason: 'recently declined' };
  }

  const section = CONSUMER_GUIDE_SECTION.replace(/\{REPO_NAME\}/g, repo);
  const newContent = file?.content
    ? file.content + '\n' + section
    : `# CLAUDE.md\n\n${section}`;

  // Create the branch at the commit CLAUDE.md was read from. Only a 422 (the
  // branch already exists, from a previous attempt) resets it; any other
  // failure is not evidence the branch exists and must not force-push over it.
  try {
    await gh.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${BRANCH_NAME}`, sha: headSha },
    });
  } catch (err) {
    if (!err.message?.includes(': 422')) throw err;
    await gh.request(`/repos/${owner}/${repo}/git/refs/heads/${BRANCH_NAME}`, {
      method: 'PATCH',
      body: { sha: headSha, force: true },
    });
  }

  // With no file, putFile looks the path up on the branch and creates it on 404.
  await gh.putFile(owner, repo, 'CLAUDE.md', newContent, {
    branch: BRANCH_NAME,
    message: 'chore: add repo-butler consumer guide to CLAUDE.md',
    sha: file?.sha,
  });

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
        console.log(`  ${r.repo}: ${r.status}${r.pr ? ` — ${r.pr}` : ''}${(r.reason ?? r.error) ? ` — ${r.reason ?? r.error}` : ''}`);
      }
    })
    .catch(err => {
      console.error(`Onboarding failed: ${err.message}`);
      process.exit(1);
    });
}
