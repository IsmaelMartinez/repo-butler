// ASSESS phase: compare current snapshot against previous, identify what changed.
// No LLM needed for the diff itself — the LLM summarises the changes.

export async function assess(context) {
  const { snapshot, previousSnapshot, provider } = context;

  if (!snapshot) {
    console.log('No current snapshot — run OBSERVE first.');
    return null;
  }

  const diff = computeDiff(snapshot, previousSnapshot);
  console.log('Changes detected:', JSON.stringify(diff.counts, null, 2));

  if (!diff.hasChanges) {
    console.log('No meaningful changes since last run.');
    return { diff, assessment: 'No changes detected since the previous observation.' };
  }

  if (!provider) {
    console.log('No LLM provider configured — returning raw diff only.');
    return { diff, assessment: null };
  }

  const prompt = buildAssessPrompt(snapshot, diff, context.config?.context);
  const assessment = await provider.generate(prompt);

  return { diff, assessment };
}

function computeDiff(current, previous) {
  if (!previous) {
    return {
      hasChanges: true,
      isFirstRun: true,
      counts: {
        open_issues: current.summary.open_issues,
        recently_closed: current.summary.recently_closed,
        recently_merged_prs: current.summary.recently_merged_prs,
      },
      new_issues: current.issues.open,
      closed_issues: current.issues.recently_closed,
      merged_prs: current.pull_requests.recently_merged,
    };
  }

  const prevOpenNumbers = new Set(previous.issues.open.map(i => i.number));
  const currOpenNumbers = new Set(current.issues.open.map(i => i.number));

  const newIssues = current.issues.open.filter(i => !prevOpenNumbers.has(i.number));
  const resolvedIssues = previous.issues.open.filter(i => !currOpenNumbers.has(i.number));

  const prevMergedNumbers = new Set(previous.pull_requests.recently_merged.map(p => p.number));
  const newMergedPRs = current.pull_requests.recently_merged.filter(p => !prevMergedNumbers.has(p.number));

  const prevReleaseTags = new Set(previous.releases.map(r => r.tag));
  const newReleases = current.releases.filter(r => !prevReleaseTags.has(r.tag));

  const labelChanges = diffLabels(
    current.issues.open.flatMap(i => i.labels),
    previous.issues.open.flatMap(i => i.labels),
  );

  const hasChanges = newIssues.length > 0 || resolvedIssues.length > 0
    || newMergedPRs.length > 0 || newReleases.length > 0;

  return {
    hasChanges,
    isFirstRun: false,
    counts: {
      new_issues: newIssues.length,
      resolved_issues: resolvedIssues.length,
      new_merged_prs: newMergedPRs.length,
      new_releases: newReleases.length,
    },
    new_issues: newIssues,
    resolved_issues: resolvedIssues,
    new_merged_prs: newMergedPRs,
    new_releases: newReleases,
    label_changes: labelChanges,
    stale_awaiting_feedback: current.summary.stale_awaiting_feedback,
  };
}

function diffLabels(currentLabels, previousLabels) {
  const currCounts = {};
  const prevCounts = {};
  for (const l of currentLabels) currCounts[l] = (currCounts[l] || 0) + 1;
  for (const l of previousLabels) prevCounts[l] = (prevCounts[l] || 0) + 1;

  const changes = {};
  const allLabels = new Set([...Object.keys(currCounts), ...Object.keys(prevCounts)]);
  for (const label of allLabels) {
    const curr = currCounts[label] || 0;
    const prev = prevCounts[label] || 0;
    if (curr !== prev) {
      changes[label] = { was: prev, now: curr };
    }
  }
  return changes;
}

export function computeTrends(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) {
    return { weeks: [], direction: 'stable' };
  }

  const weeks = weeklySnapshots.map(s => ({
    week: s._week || 'unknown',
    open_issues: s.summary?.open_issues ?? 0,
    merged_prs: s.summary?.recently_merged_prs ?? 0,
    releases: s.releases?.length ?? s.summary?.releases ?? 0,
  }));

  if (weeks.length < 2) {
    return { weeks, direction: 'stable' };
  }

  const first = weeks[0].open_issues;
  const last = weeks[weeks.length - 1].open_issues;
  const direction = last > first ? 'growing' : last < first ? 'shrinking' : 'stable';

  return { weeks, direction };
}

function buildAssessPrompt(snapshot, diff, projectContext) {
  const parts = [
    `You are a project health analyst. Assess the changes in ${snapshot.repository} since the last observation.`,
    '',
    projectContext ? `Project context: ${projectContext}` : '',
    '',
    `Current state: ${snapshot.summary.open_issues} open issues, ${snapshot.summary.recently_merged_prs} merged PRs (${snapshot.summary.recently_closed} issues closed) in the last 90 days.`,
    `Latest release: ${snapshot.summary.latest_release}`,
    '',
  ];

  if (diff.isFirstRun) {
    parts.push('This is the first observation — no previous data to compare against.');
    parts.push('Provide an initial health assessment based on the current state.');
  } else {
    parts.push(`Changes since last run:`);
    parts.push(`- ${diff.counts.new_issues} new issues opened`);
    parts.push(`- ${diff.counts.resolved_issues} issues resolved`);
    parts.push(`- ${diff.counts.new_merged_prs} PRs merged`);
    parts.push(`- ${diff.counts.new_releases} new releases`);

    if (diff.new_issues.length > 0) {
      parts.push('', 'New issues:');
      for (const i of diff.new_issues.slice(0, 10)) {
        parts.push(`  #${i.number}: ${i.title} [${i.labels.join(', ')}]`);
      }
    }

    if (diff.new_merged_prs.length > 0) {
      parts.push('', 'Newly merged PRs:');
      for (const p of diff.new_merged_prs.slice(0, 10)) {
        parts.push(`  #${p.number}: ${p.title}`);
      }
    }

    if (diff.new_releases.length > 0) {
      parts.push('', 'New releases:');
      for (const r of diff.new_releases) {
        parts.push(`  ${r.tag} (${r.published_at?.split('T')[0]})`);
      }
    }
  }

  if (diff.stale_awaiting_feedback?.length > 0) {
    parts.push('', 'Stale issues awaiting feedback (>14 days):');
    for (const s of diff.stale_awaiting_feedback) {
      parts.push(`  ${s}`);
    }
  }

  parts.push('', 'Provide a concise assessment (3-5 paragraphs) covering:');
  parts.push('1. What themes or patterns emerge from the changes?');
  parts.push('2. Are there any concerns (velocity drop, growing backlog, stale issues)?');
  parts.push('3. What should the maintainer focus on next?');

  return parts.filter(Boolean).join('\n');
}
