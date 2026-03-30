// ASSESS phase: compare current snapshot against previous, identify what changed.
// No LLM needed for the diff itself — the LLM summarises the changes.

import { sanitizeForPrompt, PROMPT_DEFENCE, DATA_BOUNDARY_START, DATA_BOUNDARY_END } from './safety.js';

export async function assess(context) {
  const { snapshot, previousSnapshot, provider, triageBotTrends } = context;

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

  const prompt = buildAssessPrompt(snapshot, diff, context.config?.context, triageBotTrends);
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

function buildAssessPrompt(snapshot, diff, projectContext, triageBotTrends) {
  const parts = [
    `You are a project health analyst. Assess the changes in ${snapshot.repository} since the last observation.`,
    '',
    PROMPT_DEFENCE,
    '',
    projectContext ? `Project context: ${projectContext}` : '',
    '',
    DATA_BOUNDARY_START,
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
        parts.push(`  #${i.number}: ${sanitizeForPrompt(i.title)} [${i.labels.join(', ')}]`);
      }
    }

    if (diff.new_merged_prs.length > 0) {
      parts.push('', 'Newly merged PRs:');
      for (const p of diff.new_merged_prs.slice(0, 10)) {
        parts.push(`  #${p.number}: ${sanitizeForPrompt(p.title)}`);
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
      parts.push(`  ${sanitizeForPrompt(s)}`);
    }
  }

  if (triageBotTrends) {
    appendTriageBotContext(parts, triageBotTrends);
  }

  parts.push(DATA_BOUNDARY_END);

  parts.push('', 'Provide a concise assessment (3-5 paragraphs) covering:');
  parts.push('1. What themes or patterns emerge from the changes?');
  parts.push('2. Are there any concerns (velocity drop, growing backlog, stale issues)?');
  parts.push('3. What should the maintainer focus on next?');
  if (triageBotTrends) {
    parts.push('4. How do the triage bot findings relate to the changes observed?');
  }

  return parts.filter(Boolean).join('\n');
}

const RECENT_WEEKS = 4;

// Shared helper: append triage bot synthesis context to an LLM prompt.
export function appendTriageBotContext(parts, trends) {
  if (!trends) return;

  parts.push('', '--- Triage Bot Intelligence ---');

  // Triage activity summary — use weighted promotion rate.
  const recentTriage = trends.triage?.slice(-RECENT_WEEKS) || [];
  if (recentTriage.length > 0) {
    const totalSessions = recentTriage.reduce((s, t) => s + (t.total || 0), 0);
    const totalPromoted = recentTriage.reduce((s, t) => s + (t.promoted || 0), 0);
    const weightedRate = totalSessions > 0 ? Math.round((totalPromoted / totalSessions) * 100) : 0;
    parts.push(`Triage bot: ${totalSessions} sessions in last ${recentTriage.length} weeks, ${weightedRate}% promotion rate.`);
  }

  // Agent sessions.
  const recentAgents = trends.agents?.slice(-RECENT_WEEKS) || [];
  const totalAgentSessions = recentAgents.reduce((s, a) => s + (a.total || 0), 0);
  if (totalAgentSessions > 0) {
    const approved = recentAgents.reduce((s, a) => s + (a.approved || 0), 0);
    const rejected = recentAgents.reduce((s, a) => s + (a.rejected || 0), 0);
    parts.push(`Enhancement research: ${totalAgentSessions} agent sessions (${approved} approved, ${rejected} rejected).`);
  }

  // Synthesis findings (clusters, drift, upstream).
  const recentSynthesis = trends.synthesis?.slice(-RECENT_WEEKS) || [];
  const totalFindings = recentSynthesis.reduce((s, x) => s + (x.findings || 0), 0);
  const totalBriefings = recentSynthesis.reduce((s, x) => s + (x.briefings || 0), 0);
  if (totalFindings > 0 || totalBriefings > 0) {
    parts.push(`Synthesis engine: ${totalBriefings} briefings posted, ${totalFindings} findings detected (issue clusters, ADR drift, upstream impacts).`);
  }

  // Response time trend.
  const responseTimes = trends.response_time?.slice(-RECENT_WEEKS) || [];
  const avgResponseTime = responseTimes.length > 0
    ? responseTimes.reduce((s, r) => s + (r.avg_seconds || 0), 0) / responseTimes.length
    : null;
  if (avgResponseTime != null) {
    parts.push(`Average triage response time: ${avgResponseTime.toFixed(1)}s.`);
  }

  parts.push('--- End Triage Bot Intelligence ---', '');
}
