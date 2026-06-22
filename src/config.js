import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULTS = {
  roadmap: { path: 'ROADMAP.md', compact_after_days: 60 },
  schedule: { assess: 'daily', ideate: 'weekly' },
  providers: { default: 'gemini' },
  context: '',
  limits: {
    max_issues_per_run: 3,
    // Per-cross-repo-target ceiling (ADR-011 two-axis cap). Bounds how many
    // issues a single run may file into any ONE other portfolio repo, so a
    // finding naming many repos cannot fan a burst onto one tracker. Applies to
    // cross-repo targets only — the host backlog stays bounded by
    // max_issues_per_run — so it never changes host behaviour. Kept low.
    max_issues_per_target: 1,
    require_approval: true,
    labels: {
      proposal: 'roadmap-proposal',
      agent: 'agent-generated',
    },
  },
  observe: {
    issues_closed_days: 90,
    prs_merged_days: 90,
    releases_count: 10,
  },
  standards: {},
  'standards-exclude': {},
  'policy-drift-exempt': {},
  // Per-tool override for the Governance Apply per-run PR cap (ADR-007 stage 3).
  // Maps a templatable tool name to its max PRs per run; tools absent here fall
  // back to the global cap (INPUT_MAX_APPLY_PER_RUN, default 5). Blast-radius
  // sizing only — every other ADR-005 gate stays global.
  'apply-cap': {},
  // Per-finding-class promotion allow-list for the scheduled apply path (ADR-007
  // stage 4). Key-presence allow-list: `tool-name: true` promotes that class onto
  // the no-human scheduled run; absent (the default) keeps it dispatch-only. This
  // is the per-class relaxation of ADR-005 gate 1 — opt-in and reversible. Empty
  // by default, so a scheduled run opens nothing until a class is explicitly added.
  'apply-schedule': {},
  // Per-finding-class auto-merge allow-list (ADR-007 stage 5). Key-presence:
  // `tool-name: true` lets the butler squash-merge its OWN green templated
  // governance-apply PRs for that class — opt-in, never global, bounded to the
  // deterministic template tools. Empty by default (default-closed), so nothing
  // auto-merges until a class is explicitly added in a reviewed config change.
  // Kill switches: empty this, set require_approval false, or disable the
  // scheduled workflow.
  'apply-automerge': {},
  // Cross-repo PROPOSE allow-list (ADR-010 / ADR-011). Key-presence map of target
  // repo short-names that may receive cross-repo issues: `repo-name: true` opts a
  // repo in. Empty by default (default-closed), so no proposal is ever routed to
  // another repo until a target is explicitly added. The repo OWNER always comes
  // from context (never config/LLM); only the short-name varies, and it is
  // validated against REPO_NAME_PATTERN by the routing gate before any
  // repo-specific API call.
  'propose-targets': {},
  // Per-finding-class promotion control for cross-repo PROPOSE (ADR-011). Key-
  // presence map of governance finding classes (standards-gap, policy-drift,
  // tier-uplift) that may graduate to cross-repo routing: `class-name: true`. A
  // class crosses only when BOTH its target is on propose-targets AND its class
  // is enabled here, so each graduates independently and reversibly in its own
  // reviewed config change. Empty by default (default-closed).
  'propose-classes': {},
  release_exempt: '',
};

export async function loadConfig(path) {
  if (!existsSync(path)) {
    console.log(`Config not found at ${path}, using defaults.`);
    return DEFAULTS;
  }

  const raw = await readFile(path, 'utf-8');
  const parsed = parseSimpleYaml(raw);
  return deepMerge(DEFAULTS, parsed);
}

// Keys that must never be assigned from parsed YAML — assigning them on a
// plain object pollutes Object.prototype (or rewires the object's prototype
// chain) for the whole process.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Minimal YAML parser — handles flat and one-level-nested keys.
// Avoids adding a dependency for a config file that's mostly flat.
function parseSimpleYaml(text) {
  const result = {};
  let currentSection = null;

  for (const line of text.split('\n')) {
    // Compute indent from the original line, then trim both sides for matching.
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(\w[\w.-]*):\s*(.*)/);
    if (!match) continue;

    const [, key, value] = match;
    if (FORBIDDEN_KEYS.has(key)) continue;

    if (indent === 0) {
      if (value) {
        result[key] = parseValue(value);
      } else {
        result[key] = {};
        currentSection = key;
      }
    } else if (currentSection) {
      result[currentSection][key] = parseValue(value);
    }
  }

  return result;
}

function parseValue(v) {
  const trimmed = v.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  if (trimmed.startsWith('|')) return '';
  return trimmed;
}

// Transform flat standards config into structured array for governance.
// Input: { standards: { 'issue-form-templates': 'universal', ... }, 'standards-exclude': { ... } }
// Output: [{ tool, scope: { type, language? }, exclude: string[] }]
export function parseStandardsConfig(config) {
  const standards = config?.standards || {};
  const excludes = config?.['standards-exclude'] || {};

  return Object.entries(standards).map(([tool, scope]) => ({
    tool,
    scope: scope === 'universal'
      ? { type: 'universal' }
      : { type: 'ecosystem', language: String(scope) },
    exclude: excludes[tool]
      ? String(excludes[tool]).split(',').map(s => s.trim()).filter(Boolean)
      : [],
  }));
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
