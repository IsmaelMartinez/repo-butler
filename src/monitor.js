// MONITOR phase: continuous event detection for new threats, issues, PRs, and security alerts.
// Compares current state against a stored cursor to find what's new since the last check.
// Designed to run frequently (every 15 min via cron or on webhook events).

import { createClient } from './github.js';
import { triageEvents } from './council.js';

const CURSOR_PATH = 'snapshots/monitor-cursor.json';

// Thin orchestration wrapper used by the index dispatcher. Runs the monitor
// detection phase and, if events were detected and a provider is configured,
// runs the council triage step.
export async function runMonitor(context) {
  const monitorResult = await monitor(context);
  context.monitorEvents = monitorResult.events;

  if (monitorResult.events.length > 0 && context.provider) {
    const triage = await triageEvents(context, monitorResult.events);
    context.triageResult = triage;
    console.log(`Monitor triage: ${triage.actionable.length} actionable, ${triage.watch.length} watching, ${triage.dismissed.length} dismissed.`);
  }

  return monitorResult;
}

// Event types the monitor can detect.
export const EVENT_TYPES = {
  NEW_ISSUE: 'new_issue',
  NEW_PR: 'new_pr',
  SECURITY_ALERT: 'security_alert',
  CI_FAILURE: 'ci_failure',
  STALE_ISSUE: 'stale_issue',
  RELEASE: 'release',
  LABEL_CHANGE: 'label_change',
};

// Severity levels for prioritising events.
const SEVERITY = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export async function monitor(context) {
  const { owner, repo, token, store, config } = context;
  const gh = createClient(token);

  console.log(`Monitoring ${owner}/${repo} for new events...`);

  // Load cursor — last known state.
  const cursor = await loadCursor(store);
  const now = new Date().toISOString();
  const since = cursor?.timestamp || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Run all detectors in parallel.
  const [issues, prs, security, ci, releases] = await Promise.all([
    detectNewIssues(gh, owner, repo, cursor),
    detectNewPRs(gh, owner, repo, cursor),
    detectSecurityAlerts(gh, owner, repo, cursor),
    detectCIFailures(gh, owner, repo, since),
    detectNewReleases(gh, owner, repo, cursor),
  ]);

  const events = [...issues, ...prs, ...security, ...ci, ...releases];

  // Detect stale issues (no API call needed if we have snapshot).
  if (context.snapshot) {
    const stale = detectStaleIssues(context.snapshot, config);
    events.push(...stale);
  }

  // Sort by severity (highest first), then by timestamp.
  events.sort((a, b) => (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0));

  // Save new cursor.
  const newCursor = buildCursor({ events, timestamp: now, owner, repo, issues, prs, security, ci, releases });
  await saveCursor(store, newCursor);

  console.log(`Detected ${events.length} events (${events.filter(e => SEVERITY[e.severity] >= SEVERITY.high).length} high+ severity).`);

  return { events, cursor: newCursor, since };
}

// --- Detectors ---

async function detectNewIssues(gh, owner, repo, cursor) {
  try {
    const since = cursor?.timestamp || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const issues = await gh.paginate(`/repos/${owner}/${repo}/issues`, {
      params: { state: 'open', sort: 'created', direction: 'desc', since },
      max: 50,
    });

    const knownNumbers = new Set(cursor?.known_issue_numbers || []);
    const newIssues = issues
      .filter(i => !i.pull_request && !knownNumbers.has(i.number));

    return newIssues.map(i => ({
      type: EVENT_TYPES.NEW_ISSUE,
      severity: classifyIssueSeverity(i),
      title: `New issue #${i.number}: ${i.title}`,
      number: i.number,
      author: i.user?.login,
      labels: i.labels.map(l => l.name),
      reactions: i.reactions?.total_count || 0,
      url: i.html_url,
      created_at: i.created_at,
    }));
  } catch (err) {
    console.warn(`Monitor: failed to detect new issues: ${err.message}`);
    return [];
  }
}

async function detectNewPRs(gh, owner, repo, cursor) {
  try {
    const since = cursor?.timestamp || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const prs = await gh.paginate(`/repos/${owner}/${repo}/pulls`, {
      params: { state: 'open', sort: 'created', direction: 'desc' },
      max: 50,
    });

    const knownNumbers = new Set(cursor?.known_pr_numbers || []);
    const newPRs = prs.filter(p => !knownNumbers.has(p.number) && p.created_at >= since);

    return newPRs.map(p => ({
      type: EVENT_TYPES.NEW_PR,
      severity: 'info',
      title: `New PR #${p.number}: ${p.title}`,
      number: p.number,
      author: p.user?.login,
      labels: p.labels.map(l => l.name),
      draft: p.draft,
      url: p.html_url,
      created_at: p.created_at,
    }));
  } catch (err) {
    console.warn(`Monitor: failed to detect new PRs: ${err.message}`);
    return [];
  }
}

// Scanner config for detectSecurityAlerts. Each entry describes one GitHub
// security scanning surface: the API path, the cursor field that holds known
// alert IDs, and how to map an alert into a SECURITY_ALERT event. Adding a new
// scanner is a one-entry change.
export const SCANNERS = [
  {
    source: 'dependabot',
    path: '/repos/{owner}/{repo}/dependabot/alerts',
    knownField: 'known_dependabot_alerts',
    buildEvent: (a) => ({
      severity: a.security_vulnerability?.severity || a.security_advisory?.severity || 'medium',
      title: `Dependabot: ${a.security_advisory?.summary || `Alert #${a.number}`}`,
      package: a.dependency?.package?.name,
    }),
  },
  {
    source: 'code_scanning',
    path: '/repos/{owner}/{repo}/code-scanning/alerts',
    knownField: 'known_code_scanning_alerts',
    buildEvent: (a) => ({
      severity: a.rule?.security_severity_level || 'medium',
      title: `Code scanning: ${a.rule?.description || `Alert #${a.number}`}`,
      rule: a.rule?.id,
    }),
  },
  {
    source: 'secret_scanning',
    path: '/repos/{owner}/{repo}/secret-scanning/alerts',
    knownField: 'known_secret_scanning_alerts',
    buildEvent: (a) => ({
      severity: 'critical',
      title: `Secret exposed: ${a.secret_type_display_name || a.secret_type}`,
    }),
  },
];

async function detectSecurityAlerts(gh, owner, repo, cursor) {
  const events = [];

  for (const scanner of SCANNERS) {
    try {
      const path = scanner.path.replace('{owner}', owner).replace('{repo}', repo);
      const data = await gh.request(path, { params: { state: 'open', per_page: 100 } });
      const alerts = Array.isArray(data) ? data : [];
      const knownAlerts = new Set(cursor?.[scanner.knownField] || []);

      for (const alert of alerts) {
        if (knownAlerts.has(alert.number)) continue;
        events.push({
          type: EVENT_TYPES.SECURITY_ALERT,
          source: scanner.source,
          number: alert.number,
          url: alert.html_url,
          created_at: alert.created_at,
          ...scanner.buildEvent(alert),
        });
      }
    } catch (err) {
      // Scanner not available for this repo / token scope — skip gracefully,
      // but log the reason so "configured but failing" is distinguishable from
      // "intentionally not enabled". Mirrors the wording used in observe.js.
      console.log(`Note: ${scanner.source} alerts not available for ${owner}/${repo} (${err.message})`);
    }
  }

  return events;
}

async function detectCIFailures(gh, owner, repo, since) {
  try {
    const data = await gh.request(`/repos/${owner}/${repo}/actions/runs`, {
      params: { status: 'completed', per_page: 20 },
    });
    const runs = data.workflow_runs || [];

    return runs
      .filter(r => r.conclusion === 'failure' && r.updated_at >= since)
      .map(r => ({
        type: EVENT_TYPES.CI_FAILURE,
        severity: 'medium',
        title: `CI failure: ${r.name} on ${r.head_branch}`,
        run_id: r.id,
        workflow: r.name,
        branch: r.head_branch,
        url: r.html_url,
        created_at: r.updated_at,
      }));
  } catch {
    return [];
  }
}

async function detectNewReleases(gh, owner, repo, cursor) {
  try {
    const releases = await gh.paginate(`/repos/${owner}/${repo}/releases`, { max: 5 });
    const knownTags = new Set(cursor?.known_release_tags || []);

    return releases
      .filter(r => !knownTags.has(r.tag_name))
      .map(r => ({
        type: EVENT_TYPES.RELEASE,
        severity: 'info',
        title: `New release: ${r.tag_name} ${r.name || ''}`.trim(),
        tag: r.tag_name,
        prerelease: r.prerelease,
        url: r.html_url,
        created_at: r.published_at,
      }));
  } catch {
    return [];
  }
}

function detectStaleIssues(snapshot, config) {
  const staleDays = config?.monitor?.stale_days || 30;
  const now = Date.now();
  const events = [];

  for (const issue of snapshot.issues?.open || []) {
    const updatedAt = new Date(issue.updated_at).getTime();
    const daysSinceUpdate = Math.floor((now - updatedAt) / (1000 * 60 * 60 * 24));

    if (daysSinceUpdate >= staleDays && !issue.labels.includes('blocked')) {
      events.push({
        type: EVENT_TYPES.STALE_ISSUE,
        severity: 'low',
        title: `Stale issue #${issue.number}: ${issue.title} (${daysSinceUpdate}d inactive)`,
        number: issue.number,
        days_inactive: daysSinceUpdate,
        labels: issue.labels,
      });
    }
  }

  return events;
}

// --- Severity classification ---

function classifyIssueSeverity(issue) {
  const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name).toLowerCase());

  if (labels.some(l => l.includes('security') || l.includes('vulnerability'))) return 'critical';
  if (labels.some(l => l.includes('bug') || l.includes('defect'))) return 'high';
  if (labels.some(l => l.includes('breaking'))) return 'high';
  if ((issue.reactions?.total_count || 0) >= 5) return 'medium';
  return 'info';
}

// --- Cursor management ---

export async function loadCursor(store) {
  if (!store?.readJSON) return null;
  return store.readJSON(CURSOR_PATH);
}

// Build a cursor from the current state so next run can diff against it.
function buildCursor({ events, timestamp, owner, repo, issues, prs, security, ci, releases }) {
  // Collect all known IDs for deduplication on the next run.
  const known_issue_numbers = [];
  const known_pr_numbers = [];
  const known_dependabot_alerts = [];
  const known_code_scanning_alerts = [];
  const known_secret_scanning_alerts = [];
  const known_release_tags = [];

  for (const e of [...issues, ...(events.filter(e => e.type === EVENT_TYPES.NEW_ISSUE))]) {
    if (e.number) known_issue_numbers.push(e.number);
  }
  for (const e of [...prs, ...(events.filter(e => e.type === EVENT_TYPES.NEW_PR))]) {
    if (e.number) known_pr_numbers.push(e.number);
  }
  for (const e of security) {
    if (e.source === 'dependabot' && e.number) known_dependabot_alerts.push(e.number);
    if (e.source === 'code_scanning' && e.number) known_code_scanning_alerts.push(e.number);
    if (e.source === 'secret_scanning' && e.number) known_secret_scanning_alerts.push(e.number);
  }
  for (const e of releases) {
    if (e.tag) known_release_tags.push(e.tag);
  }

  return {
    timestamp,
    repository: `${owner}/${repo}`,
    known_issue_numbers,
    known_pr_numbers,
    known_dependabot_alerts,
    known_code_scanning_alerts,
    known_secret_scanning_alerts,
    known_release_tags,
    last_event_count: events.length,
  };
}

export async function saveCursor(store, cursor) {
  if (!store?.writeJSON) return;
  try {
    await store.writeJSON(CURSOR_PATH, cursor);
  } catch (err) {
    console.warn(`Monitor: failed to save cursor: ${err.message}`);
  }
}

// --- Event filtering ---

// Filter events by minimum severity threshold.
export function filterBySeverity(events, minSeverity = 'low') {
  const threshold = SEVERITY[minSeverity] || 0;
  return events.filter(e => (SEVERITY[e.severity] || 0) >= threshold);
}

// Group events by type for structured reporting.
export function groupByType(events) {
  const groups = {};
  for (const event of events) {
    if (!groups[event.type]) groups[event.type] = [];
    groups[event.type].push(event);
  }
  return groups;
}

// Summarise events into a compact format for LLM consumption.
export function summariseEvents(events) {
  const grouped = groupByType(events);
  const lines = [];

  for (const [type, items] of Object.entries(grouped)) {
    lines.push(`${type} (${items.length}):`);
    for (const item of items.slice(0, 10)) {
      lines.push(`  [${item.severity}] ${item.title}`);
    }
    if (items.length > 10) {
      lines.push(`  ... and ${items.length - 10} more`);
    }
  }

  return lines.join('\n');
}
