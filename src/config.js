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
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
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
