// IDEATE phase: generate improvement ideas based on the project state.
// Uses a deeper-reasoning LLM (Claude by default) for creative suggestions.

import { sanitizeForPrompt, wrapPrompt } from './safety.js';
import { runGovernance } from './governance.js';
import { reviewProposals } from './council.js';

// Thin orchestration wrapper used by the index dispatcher. Ensures governance
// findings exist (delegates to runGovernance, which is a no-op if a prior phase
// already populated them), then runs ideation + council deliberation.
export async function runIdeate(context) {
  const { config } = context;

  await runGovernance(context);

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

  return result;
}

export async function ideate(context) {
  const { snapshot, assessment, provider, config, dryRun, governanceFindings } = context;

  if (!provider) {
    console.log('No LLM provider configured — skipping IDEATE phase.');
    return null;
  }

  if (!snapshot) {
    console.log('No snapshot available — run OBSERVE first.');
    return null;
  }

  const maxIdeas = config.limits?.max_issues_per_run || 3;
  const prompt = buildIdeatePrompt(snapshot, assessment, config.context, maxIdeas, governanceFindings);
  const rawResponse = await provider.generate(prompt);

  const ideas = parseIdeas(rawResponse);
  console.log(`Generated ${ideas.length} ideas.`);

  for (const idea of ideas) {
    console.log(`  [${idea.priority}] ${idea.title}`);
  }

  return { ideas, raw: rawResponse };
}

export function buildIdeatePrompt(snapshot, assessment, projectContext, maxIdeas, governanceFindings) {
  const hasGovernance = governanceFindings && governanceFindings.length > 0;

  const preamble = hasGovernance
    ? 'You are a portfolio governance advisor for a GitHub portfolio. Generate proposals to improve standards compliance, fix policy drift, and uplift health tiers across the portfolio.'
    : 'You are a technical advisor for an open-source project. Generate actionable improvement ideas based on the project state below.';

  const items = [
    `Repository: ${snapshot.repository}`,
    `Stars: ${snapshot.meta?.stars || 'unknown'}`,
    `Open issues: ${snapshot.summary.open_issues} (${snapshot.summary.blocked_issues} blocked, ${snapshot.summary.awaiting_feedback} awaiting feedback)`,
    `PRs merged (90d): ${snapshot.summary.recently_merged_prs} (${snapshot.summary.human_prs} human, ${snapshot.summary.bot_prs} bot)`,
    `Contributors (90d): ${snapshot.summary.unique_contributors}`,
    `Latest release: ${snapshot.summary.latest_release}`,
    '',
  ];

  if (assessment?.assessment) {
    items.push('Assessment:', sanitizeForPrompt(assessment.assessment), '');
  }

  items.push('Open issues:');
  for (const i of snapshot.issues.open.slice(0, 20)) {
    items.push(`  #${i.number}: ${sanitizeForPrompt(i.title)} [${i.labels.join(', ')}] (${i.reactions} reactions, ${i.comments} comments)`);
  }
  items.push('');

  if (snapshot.summary.high_reaction_issues.length > 0) {
    items.push('Most-requested features/fixes:', ...snapshot.summary.high_reaction_issues.map(i => `  ${sanitizeForPrompt(i)}`), '');
  }

  if (snapshot.summary.stale_awaiting_feedback.length > 0) {
    items.push('Stale issues (>14d no response):', ...snapshot.summary.stale_awaiting_feedback.map(i => `  ${sanitizeForPrompt(i)}`), '');
  }

  if (snapshot.roadmap?.content) {
    // Include a summary rather than the full roadmap to stay within token limits.
    const roadmapPreview = snapshot.roadmap.content.slice(0, 2000);
    items.push('Roadmap (truncated):', sanitizeForPrompt(roadmapPreview), '');
  }

  if (hasGovernance) {
    appendGovernanceContext(items, governanceFindings);
  }

  const outroLines = [
    `Generate exactly ${maxIdeas} improvement ideas. For each idea, output this exact format:`,
    '',
    '---IDEA---',
    'TITLE: <concise title suitable as a GitHub issue title>',
    'PRIORITY: high|medium|low',
    'LABELS: <comma-separated labels>',
    'RATIONALE: <which signals from the data above triggered this idea — be specific about numbers and issue references>',
    'CURRENT_STATE: <what exists now>',
    'PROPOSED_STATE: <what should change>',
    'AFFECTED_FILES: <comma-separated list of likely affected files/directories, or "unknown">',
    'SCOPE: <one-sentence scope boundary>',
    // TARGET_REPO is anchored ABOVE BODY (governance mode only) because BODY is
    // the terminal greedy field in parseIdeas — any FIELD: line emitted after
    // BODY is swallowed into the body and never parsed. Keeping it adjacent to
    // the other structured fields is what makes the model emit it where the
    // parser can capture it.
    ...(hasGovernance ? ['TARGET_REPO: <short name of the one portfolio repo this proposal targets, taken from the findings above; omit this line entirely for a proposal about this repo or the portfolio as a whole>'] : []),
    'BODY: <full GitHub issue body in markdown incorporating all the above sections>',
    '---END---',
    '',
    'Guidelines:',
    '- Ideas should be specific and actionable, not vague aspirations.',
    '- Avoid proposing work on issues already labelled "blocked" (upstream dependency).',
    '- Prioritise ideas that compound value: automation, testing, documentation.',
    '- Consider the contributor count — single-maintainer projects need different ideas than team projects.',
    '- Do not propose ideas that duplicate existing open issues.',
    '- In RATIONALE, reference specific issue numbers (e.g. #42) and metrics from the data above.',
    '- In AFFECTED_FILES, be concrete about which files or directories are likely to change.',
    '- In SCOPE, keep statements bounded and actionable — describe exactly what is in and out of scope.',
    '- The BODY should be a structured markdown document that includes Rationale, Current State, Proposed State, Affected Files, and Scope sections.',
  ];
  if (hasGovernance) {
    outroLines.push('- Prioritise standards propagation and policy drift correction proposals over generic improvements.');
    outroLines.push('- Each idea should reference specific repos and cross-repo statistics (e.g. "configured in 14/19 repos").');
    outroLines.push('- Rationale must explain why this is a portfolio-level concern, not a per-repo issue.');
    outroLines.push('- When a proposal remediates a finding in ONE specific portfolio repo (adding a missing standard to a non-compliant repo, correcting one repo\'s policy drift, or uplifting one repo\'s tier), you MUST include the TARGET_REPO line (in the format block, above BODY) set to the target repo\'s bare short name (e.g. "my-repo"), taken from the findings above; if a finding shows an owner-qualified name like "owner/my-repo", use only the part after the slash. Omit the line only for proposals about this repo or the portfolio as a whole.');
    outroLines.push('- For any idea that has a TARGET_REPO, RATIONALE must cite the anchoring finding\'s portfolio statistic as a number — an "N of M repos" count, an N/M fraction, or a percentage taken from the findings above (e.g. "8 of 14 repos fail the release-cadence check") — and must justify the change in portfolio terms only, never with claims about the target repo\'s code, tests, or issue contents.');
    outroLines.push('- For any idea that has a TARGET_REPO, set AFFECTED_FILES to "unknown" and do NOT cite this repo\'s issue numbers (e.g. #42) in RATIONALE or BODY — it will be filed in the target repo, which does not share this repo\'s issue numbering. Cite the cross-repo statistic instead.');
  }

  return wrapPrompt({
    role: [
      preamble,
      'Each idea must include a structured specification consumable by implementation agents (Copilot, Sweep, etc.).',
    ],
    projectContext,
    items,
    outroLines,
    padDataEnd: false,
  });
}

// Append governance findings to the LLM prompt data section. Every finding
// class that may anchor a cross-repo proposal (standards-gap, policy-drift,
// tier-uplift) must surface a citable portfolio statistic here: the routing
// gate (resolveCrossRepoDestination, Gate 4) admits a targeted proposal only
// when its rationale carries an "N of M" count, an N/M fraction, or a
// percentage, so a finding rendered without one leaves the model nothing
// admissible to cite.
function appendGovernanceContext(parts, findings) {
  parts.push('', '--- Portfolio Governance Findings ---');

  const upliftRepos = new Set();
  const driftRepos = new Set();
  let inScopeTotal = 0;

  for (const f of findings) {
    if (f.type === 'standards-gap') {
      const total = f.compliant.length + f.nonCompliant.length;
      inScopeTotal = Math.max(inScopeTotal, total);
      parts.push(`Standard: ${f.tool} (${f.scope.type}) — ${f.compliant.length}/${total} repos compliant; ${f.nonCompliant.length} of ${total} missing: ${f.nonCompliant.join(', ')}`);
    } else if (f.type === 'policy-drift') {
      driftRepos.add(f.repo);
      parts.push(`Drift: ${f.repo} uses ${f.actual} (expected: ${f.expected}, category: ${f.category})`);
    } else if (f.type === 'tier-uplift') {
      upliftRepos.add(f.repo);
      parts.push(`Uplift: ${f.repo} is ${f.currentTier}, needs [${f.failingChecks.map(c => c.name).join(', ')}] for ${f.targetTier}`);
    } else if (f.type === 'dependabot-stale') {
      const oldest = Math.max(...f.stalePRs.map(p => p.age));
      parts.push(`Stale Dependabot PRs: ${f.repo} has ${f.stalePRs.length} PRs older than 30d (oldest: ${oldest}d)`);
    }
  }

  // Tier-uplift and policy-drift findings are per-repo and carry no fraction
  // of their own, so a proposal anchored only on one has no statistic to cite.
  // Aggregate each class against the in-scope portfolio size (largest
  // standards-gap population — scopes vary per tool, so this is the best
  // available denominator, clamped so the fraction can never exceed 1 when a
  // gap finding is scoped narrower than the aggregated repo set). Without gap
  // findings there is no denominator; a bare count would not pass the routing
  // gate, so the line is omitted rather than rendered unciteable.
  if (upliftRepos.size > 0 && inScopeTotal > 0) {
    parts.push(`Tier uplift summary: ${upliftRepos.size} of ${Math.max(inScopeTotal, upliftRepos.size)} in-scope repos sit below their target tier.`);
  }
  if (driftRepos.size > 0 && inScopeTotal > 0) {
    parts.push(`Policy drift summary: ${driftRepos.size} of ${Math.max(inScopeTotal, driftRepos.size)} in-scope repos diverge from an expected policy.`);
  }

  parts.push('--- End Portfolio Governance Findings ---', '');
}

// Map of FIELD header -> output key. BODY is the trailing greedy field:
// everything after its first occurrence belongs to the body.
const IDEA_FIELDS = {
  TITLE: 'title',
  PRIORITY: 'priority',
  LABELS: 'labels',
  RATIONALE: 'rationale',
  CURRENT_STATE: 'currentState',
  PROPOSED_STATE: 'proposedState',
  AFFECTED_FILES: 'affectedFiles',
  SCOPE: 'scope',
  TARGET_REPO: 'targetRepo',
  BODY: 'body',
};

export function parseIdeas(raw) {
  const ideas = [];
  const blocks = raw.split('---IDEA---').slice(1);

  for (const [i, block] of blocks.entries()) {
    const content = block.split('---END---')[0]?.trim();
    if (!content) continue;

    // Scan FIELD: headers; first occurrence of each wins. BODY is terminal:
    // once matched, scanning stops and everything from that point to the end
    // of the block becomes the body (subsequent FIELD:-like lines are body
    // content, not parsed into separate keys).
    const fields = {};
    let bodyStart = -1;
    const headerRe = /^([A-Z_]+):[ \t]*(.*)$/gm;
    let m;
    while ((m = headerRe.exec(content)) !== null) {
      const name = m[1];
      if (!(name in IDEA_FIELDS)) continue;
      const key = IDEA_FIELDS[name];
      if (key === 'body') {
        bodyStart = m.index + m[0].length - m[2].length;
        break;
      }
      if (!(key in fields)) fields[key] = m[2].trim();
    }

    const title = fields.title;
    if (!title) {
      // A delimited block with no parseable TITLE: header — usually the model
      // renamed the header (NAME:, IDEA:) or dropped it. Surface it instead of
      // silently discarding the whole idea, which would make "Generated N
      // ideas" undercount with no trace. Log only the ordinal and size — never
      // the block content, which is adversary-influenceable LLM output and
      // would leak into CI logs (cf. redactErrorForLog in update.js).
      console.warn(`parseIdeas: idea block ${i + 1} has no parseable TITLE header (${content.length} chars) — model likely renamed or dropped it; skipping.`);
      continue;
    }

    const labelsRaw = fields.labels || '';
    const affectedFilesRaw = fields.affectedFiles ?? null;
    const affectedFiles = affectedFilesRaw && affectedFilesRaw.toLowerCase() !== 'unknown'
      ? affectedFilesRaw.split(',').map(f => f.trim()).filter(Boolean)
      : [];

    // TARGET_REPO marks a proposal destined for another portfolio repo
    // (ADR-010 / ADR-011). It is parsed and surfaced here for the dormant soak;
    // the deterministic routing gate (REPO_NAME_PATTERN char validation +
    // finding-anchoring + propose-targets membership, a HARD DROP on a malformed
    // name) lands in later goals (G4/G5). Here we only normalise the no-value
    // tokens an LLM commonly emits when it means "no target" — empty, "unknown",
    // "none", "n/a", and the literal "null"/"undefined" — to null (a host-backlog
    // proposal), mirroring how AFFECTED_FILES treats "unknown".
    const targetRepoRaw = fields.targetRepo || '';
    const targetRepo = targetRepoRaw && !['unknown', 'none', 'n/a', 'null', 'undefined'].includes(targetRepoRaw.toLowerCase())
      ? targetRepoRaw
      : null;

    ideas.push({
      title,
      priority: fields.priority || 'medium',
      labels: labelsRaw.split(',').map(l => l.trim()).filter(Boolean),
      rationale: fields.rationale ?? null,
      currentState: fields.currentState ?? null,
      proposedState: fields.proposedState ?? null,
      affectedFiles,
      scope: fields.scope ?? null,
      targetRepo,
      body: bodyStart === -1 ? '' : content.slice(bodyStart).trim(),
    });
  }

  return ideas;
}
