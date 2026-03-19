// IDEATE phase: generate improvement ideas based on the project state.
// Uses a deeper-reasoning LLM (Claude by default) for creative suggestions.

export async function ideate(context) {
  const { snapshot, assessment, provider, config, dryRun } = context;

  if (!provider) {
    console.log('No LLM provider configured — skipping IDEATE phase.');
    return null;
  }

  if (!snapshot) {
    console.log('No snapshot available — run OBSERVE first.');
    return null;
  }

  const maxIdeas = config.limits?.max_issues_per_run || 3;
  const prompt = buildIdeatePrompt(snapshot, assessment, config.context, maxIdeas);
  const rawResponse = await provider.generate(prompt);

  const ideas = parseIdeas(rawResponse);
  console.log(`Generated ${ideas.length} ideas.`);

  for (const idea of ideas) {
    console.log(`  [${idea.priority}] ${idea.title}`);
  }

  return { ideas, raw: rawResponse };
}

function buildIdeatePrompt(snapshot, assessment, projectContext, maxIdeas) {
  const parts = [
    'You are a technical advisor for an open-source project. Generate actionable improvement ideas based on the project state below.',
    '',
    projectContext ? `Project context: ${projectContext}` : '',
    '',
    `Repository: ${snapshot.repository}`,
    `Stars: ${snapshot.meta?.stars || 'unknown'}`,
    `Open issues: ${snapshot.summary.open_issues} (${snapshot.summary.blocked_issues} blocked, ${snapshot.summary.awaiting_feedback} awaiting feedback)`,
    `PRs merged (90d): ${snapshot.summary.recently_merged_prs} (${snapshot.summary.human_prs} human, ${snapshot.summary.bot_prs} bot)`,
    `Contributors (90d): ${snapshot.summary.unique_contributors}`,
    `Latest release: ${snapshot.summary.latest_release}`,
    '',
  ];

  if (assessment?.assessment) {
    parts.push('Assessment:', assessment.assessment, '');
  }

  parts.push('Open issues:');
  for (const i of snapshot.issues.open.slice(0, 20)) {
    parts.push(`  #${i.number}: ${i.title} [${i.labels.join(', ')}] (${i.reactions} reactions, ${i.comments} comments)`);
  }
  parts.push('');

  if (snapshot.summary.high_reaction_issues.length > 0) {
    parts.push('Most-requested features/fixes:', ...snapshot.summary.high_reaction_issues.map(i => `  ${i}`), '');
  }

  if (snapshot.summary.stale_awaiting_feedback.length > 0) {
    parts.push('Stale issues (>14d no response):', ...snapshot.summary.stale_awaiting_feedback.map(i => `  ${i}`), '');
  }

  if (snapshot.roadmap?.content) {
    // Include a summary rather than the full roadmap to stay within token limits.
    const roadmapPreview = snapshot.roadmap.content.slice(0, 2000);
    parts.push('Roadmap (truncated):', roadmapPreview, '');
  }

  parts.push(`Generate exactly ${maxIdeas} improvement ideas. For each idea, output this exact format:`, '');
  parts.push('---IDEA---');
  parts.push('TITLE: <concise title suitable as a GitHub issue title>');
  parts.push('PRIORITY: high|medium|low');
  parts.push('LABELS: <comma-separated labels>');
  parts.push('BODY: <GitHub issue body in markdown, 2-4 paragraphs>');
  parts.push('---END---');
  parts.push('');
  parts.push('Guidelines:');
  parts.push('- Ideas should be specific and actionable, not vague aspirations.');
  parts.push('- Avoid proposing work on issues already labelled "blocked" (upstream dependency).');
  parts.push('- Prioritise ideas that compound value: automation, testing, documentation.');
  parts.push('- Consider the contributor count — single-maintainer projects need different ideas than team projects.');
  parts.push('- Do not propose ideas that duplicate existing open issues.');

  return parts.join('\n');
}

function parseIdeas(raw) {
  const ideas = [];
  const blocks = raw.split('---IDEA---').slice(1);

  for (const block of blocks) {
    const content = block.split('---END---')[0]?.trim();
    if (!content) continue;

    const title = content.match(/TITLE:\s*(.+)/)?.[1]?.trim();
    const priority = content.match(/PRIORITY:\s*(.+)/)?.[1]?.trim() || 'medium';
    const labelsRaw = content.match(/LABELS:\s*(.+)/)?.[1]?.trim() || '';
    const bodyMatch = content.match(/BODY:\s*([\s\S]+)/);
    const body = bodyMatch?.[1]?.trim() || '';

    if (title) {
      ideas.push({
        title,
        priority,
        labels: labelsRaw.split(',').map(l => l.trim()).filter(Boolean),
        body,
      });
    }
  }

  return ideas;
}
