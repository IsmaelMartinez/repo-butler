// IDEATE phase: generate improvement ideas based on the project state.
// Uses a deeper-reasoning LLM (Claude by default) for creative suggestions.

import { appendTriageBotContext } from './assess.js';
import { sanitizeForPrompt, PROMPT_DEFENCE, DATA_BOUNDARY_START, DATA_BOUNDARY_END } from './safety.js';
import { createClient } from './github.js';
import { fetchPortfolioDetails } from './report-portfolio.js';
import { parseStandardsConfig } from './config.js';
import { detectStandardsGaps, detectPolicyDrift, generateUpliftProposals } from './governance.js';
import { reviewProposals } from './council.js';

// Thin orchestration wrapper used by the index dispatcher. Enriches portfolio
// details for governance, runs governance detection + ideation + council
// deliberation, then persists governance findings for MCP consumption.
export async function runIdeate(context) {
  const { owner, token, portfolio, config, store } = context;

  if (portfolio && !context.repoDetails) {
    const gh = createClient(token);
    const repoCache = store ? await store.readRepoCache() : null;
    context.repoDetails = await fetchPortfolioDetails(gh, owner, portfolio.repos, { cache: repoCache });
    console.log(`Enriched ${Object.keys(context.repoDetails).length} repos for governance.`);
  }

  if (portfolio && context.repoDetails) {
    const standards = parseStandardsConfig(config);
    const gaps = detectStandardsGaps(standards, portfolio.repos, context.repoDetails);
    const drift = detectPolicyDrift(portfolio.repos, context.repoDetails);
    const uplift = generateUpliftProposals(portfolio.repos, context.repoDetails, config);
    context.governanceFindings = [...gaps.findings, ...drift, ...uplift];
    console.log(`Governance: ${context.governanceFindings.length} findings (${gaps.findings.length} gaps, ${drift.length} drift, ${uplift.length} uplift)`);
  }

  const result = await ideate(context);
  context.ideas = result?.ideas || [];

  if (context.ideas.length > 0 && config.council?.enabled !== false && context.provider) {
    console.log('\n--- Council Deliberation ---\n');
    const councilResult = await reviewProposals(context, context.ideas);
    context.councilResult = councilResult;
    context.ideas = councilResult.approved;
    context.watchlist = councilResult.watchlist;
    console.log(`Council: ${councilResult.approved.length} approved, ${councilResult.watchlist.length} watchlisted, ${councilResult.dismissed.length} dismissed.`);
  }

  if (context.governanceFindings?.length > 0 && store) {
    await store.writeGovernanceFindings(context.governanceFindings);
  }

  return result;
}

export async function ideate(context) {
  const { snapshot, assessment, provider, config, dryRun, triageBotTrends, governanceFindings } = context;

  if (!provider) {
    console.log('No LLM provider configured — skipping IDEATE phase.');
    return null;
  }

  if (!snapshot) {
    console.log('No snapshot available — run OBSERVE first.');
    return null;
  }

  const maxIdeas = config.limits?.max_issues_per_run || 3;
  const prompt = buildIdeatePrompt(snapshot, assessment, config.context, maxIdeas, triageBotTrends, governanceFindings);
  const rawResponse = await provider.generate(prompt);

  const ideas = parseIdeas(rawResponse);
  console.log(`Generated ${ideas.length} ideas.`);

  for (const idea of ideas) {
    console.log(`  [${idea.priority}] ${idea.title}`);
  }

  return { ideas, raw: rawResponse };
}

export function buildIdeatePrompt(snapshot, assessment, projectContext, maxIdeas, triageBotTrends, governanceFindings) {
  const hasGovernance = governanceFindings && governanceFindings.length > 0;

  const preamble = hasGovernance
    ? 'You are a portfolio governance advisor for a GitHub portfolio. Generate proposals to improve standards compliance, fix policy drift, and uplift health tiers across the portfolio.'
    : 'You are a technical advisor for an open-source project. Generate actionable improvement ideas based on the project state below.';

  const parts = [
    preamble,
    'Each idea must include a structured specification consumable by implementation agents (Copilot, Sweep, etc.).',
    '',
    PROMPT_DEFENCE,
    '',
    projectContext ? `Project context: ${projectContext}` : '',
    '',
    DATA_BOUNDARY_START,
    `Repository: ${snapshot.repository}`,
    `Stars: ${snapshot.meta?.stars || 'unknown'}`,
    `Open issues: ${snapshot.summary.open_issues} (${snapshot.summary.blocked_issues} blocked, ${snapshot.summary.awaiting_feedback} awaiting feedback)`,
    `PRs merged (90d): ${snapshot.summary.recently_merged_prs} (${snapshot.summary.human_prs} human, ${snapshot.summary.bot_prs} bot)`,
    `Contributors (90d): ${snapshot.summary.unique_contributors}`,
    `Latest release: ${snapshot.summary.latest_release}`,
    '',
  ];

  if (assessment?.assessment) {
    parts.push('Assessment:', sanitizeForPrompt(assessment.assessment), '');
  }

  parts.push('Open issues:');
  for (const i of snapshot.issues.open.slice(0, 20)) {
    parts.push(`  #${i.number}: ${sanitizeForPrompt(i.title)} [${i.labels.join(', ')}] (${i.reactions} reactions, ${i.comments} comments)`);
  }
  parts.push('');

  if (snapshot.summary.high_reaction_issues.length > 0) {
    parts.push('Most-requested features/fixes:', ...snapshot.summary.high_reaction_issues.map(i => `  ${sanitizeForPrompt(i)}`), '');
  }

  if (snapshot.summary.stale_awaiting_feedback.length > 0) {
    parts.push('Stale issues (>14d no response):', ...snapshot.summary.stale_awaiting_feedback.map(i => `  ${sanitizeForPrompt(i)}`), '');
  }

  if (snapshot.roadmap?.content) {
    // Include a summary rather than the full roadmap to stay within token limits.
    const roadmapPreview = snapshot.roadmap.content.slice(0, 2000);
    parts.push('Roadmap (truncated):', sanitizeForPrompt(roadmapPreview), '');
  }

  if (triageBotTrends) {
    appendTriageBotContext(parts, triageBotTrends);
  }

  if (hasGovernance) {
    appendGovernanceContext(parts, governanceFindings);
  }

  parts.push(DATA_BOUNDARY_END);

  parts.push(`Generate exactly ${maxIdeas} improvement ideas. For each idea, output this exact format:`, '');
  parts.push('---IDEA---');
  parts.push('TITLE: <concise title suitable as a GitHub issue title>');
  parts.push('PRIORITY: high|medium|low');
  parts.push('LABELS: <comma-separated labels>');
  parts.push('RATIONALE: <which signals from the data above triggered this idea — be specific about numbers and issue references>');
  parts.push('CURRENT_STATE: <what exists now>');
  parts.push('PROPOSED_STATE: <what should change>');
  parts.push('AFFECTED_FILES: <comma-separated list of likely affected files/directories, or "unknown">');
  parts.push('SCOPE: <one-sentence scope boundary>');
  parts.push('BODY: <full GitHub issue body in markdown incorporating all the above sections>');
  parts.push('---END---');
  parts.push('');
  parts.push('Guidelines:');
  parts.push('- Ideas should be specific and actionable, not vague aspirations.');
  parts.push('- Avoid proposing work on issues already labelled "blocked" (upstream dependency).');
  parts.push('- Prioritise ideas that compound value: automation, testing, documentation.');
  parts.push('- Consider the contributor count — single-maintainer projects need different ideas than team projects.');
  parts.push('- Do not propose ideas that duplicate existing open issues.');
  parts.push('- In RATIONALE, reference specific issue numbers (e.g. #42) and metrics from the data above.');
  parts.push('- In AFFECTED_FILES, be concrete about which files or directories are likely to change.');
  parts.push('- In SCOPE, keep statements bounded and actionable — describe exactly what is in and out of scope.');
  parts.push('- The BODY should be a structured markdown document that includes Rationale, Current State, Proposed State, Affected Files, and Scope sections.');
  if (triageBotTrends) {
    parts.push('- Use the triage bot intelligence data to inform your ideas — patterns in triage activity, agent sessions, and synthesis findings are real signals.');
  }
  if (hasGovernance) {
    parts.push('- Prioritise standards propagation and policy drift correction proposals over generic improvements.');
    parts.push('- Each idea should reference specific repos and cross-repo statistics (e.g. "configured in 14/19 repos").');
    parts.push('- Rationale must explain why this is a portfolio-level concern, not a per-repo issue.');
  }

  return parts.join('\n');
}

// Append governance findings to the LLM prompt data section.
function appendGovernanceContext(parts, findings) {
  parts.push('', '--- Portfolio Governance Findings ---');

  for (const f of findings) {
    if (f.type === 'standards-gap') {
      const total = f.compliant.length + f.nonCompliant.length;
      parts.push(`Standard: ${f.tool} (${f.scope.type}) — ${f.compliant.length}/${total} repos compliant. Missing: ${f.nonCompliant.join(', ')}`);
    } else if (f.type === 'policy-drift') {
      parts.push(`Drift: ${f.repo} uses ${f.actual} (expected: ${f.expected}, category: ${f.category})`);
    } else if (f.type === 'tier-uplift') {
      parts.push(`Uplift: ${f.repo} is ${f.currentTier}, needs [${f.failingChecks.map(c => c.name).join(', ')}] for ${f.targetTier}`);
    }
  }

  parts.push('--- End Portfolio Governance Findings ---', '');
}

export function parseIdeas(raw) {
  const ideas = [];
  const blocks = raw.split('---IDEA---').slice(1);

  for (const block of blocks) {
    const content = block.split('---END---')[0]?.trim();
    if (!content) continue;

    const title = content.match(/TITLE:\s*(.+)/)?.[1]?.trim();
    const priority = content.match(/PRIORITY:\s*(.+)/)?.[1]?.trim() || 'medium';
    const labelsRaw = content.match(/LABELS:\s*(.+)/)?.[1]?.trim() || '';
    const rationale = content.match(/RATIONALE:\s*(.+)/)?.[1]?.trim() || null;
    const currentState = content.match(/CURRENT_STATE:\s*(.+)/)?.[1]?.trim() || null;
    const proposedState = content.match(/PROPOSED_STATE:\s*(.+)/)?.[1]?.trim() || null;
    const affectedFilesRaw = content.match(/AFFECTED_FILES:\s*(.+)/)?.[1]?.trim() || null;
    const scope = content.match(/SCOPE:\s*(.+)/)?.[1]?.trim() || null;
    const bodyMatch = content.match(/BODY:\s*([\s\S]+)/);
    const body = bodyMatch?.[1]?.trim() || '';

    if (title) {
      const affectedFiles = affectedFilesRaw && affectedFilesRaw.toLowerCase() !== 'unknown'
        ? affectedFilesRaw.split(',').map(f => f.trim()).filter(Boolean)
        : [];

      ideas.push({
        title,
        priority,
        labels: labelsRaw.split(',').map(l => l.trim()).filter(Boolean),
        rationale,
        currentState,
        proposedState,
        affectedFiles,
        scope,
        body,
      });
    }
  }

  return ideas;
}
