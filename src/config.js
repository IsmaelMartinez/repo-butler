import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULTS = {
  roadmap: { path: 'ROADMAP.md' },
  schedule: { assess: 'daily', ideate: 'weekly' },
  providers: { default: 'gemini' },
  context: '',
  limits: {
    max_issues_per_run: 3,
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
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
