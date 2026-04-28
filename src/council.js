// COUNCIL phase: multi-agent deliberation system.
// A panel of specialist agents (product, development, stability, maintainability, security)
// debate events and proposals from different perspectives before acting.
//
// The council can evaluate:
//   - Monitor events (new threats, issues, PRs)
//   - IDEATE proposals (before creating issues)
//   - Ad-hoc questions via MCP
//
// Each agent produces an independent assessment, then a synthesiser combines them
// into a final verdict: act, watch, or dismiss.

import { sanitizeForPrompt, wrapPrompt } from './safety.js';

// --- Agent personas ---

export const PERSONAS = {
  product: {
    name: 'Product',
    role: 'Product Manager',
    focus: 'user value, feature priorities, roadmap alignment, community impact',
    system: 'You are a product manager evaluating this from the user\'s perspective. Focus on: Does this deliver user value? Does it align with the roadmap? How does it affect the community? What\'s the opportunity cost?',
  },
  development: {
    name: 'Development',
    role: 'Lead Developer',
    focus: 'implementation complexity, technical debt, code quality, developer experience',
    system: 'You are a lead developer evaluating the technical implications. Focus on: How complex is the implementation? Does it introduce technical debt? What\'s the impact on code quality and developer experience? Are there simpler alternatives?',
  },
  stability: {
    name: 'Stability',
    role: 'SRE / Reliability Engineer',
    focus: 'system reliability, CI health, deployment risk, incident prevention',
    system: 'You are an SRE evaluating reliability implications. Focus on: Could this cause outages or regressions? What\'s the deployment risk? How does it affect CI/CD? Are there monitoring or rollback concerns?',
  },
  maintainability: {
    name: 'Maintainability',
    role: 'Architecture Reviewer',
    focus: 'long-term maintenance burden, documentation, dependency management, bus factor',
    system: 'You are an architecture reviewer evaluating long-term maintainability. Focus on: Does this increase maintenance burden? Is it well-documented? Does it affect the dependency footprint? How does it impact bus factor and onboarding?',
  },
  security: {
    name: 'Security',
    role: 'Security Engineer',
    focus: 'vulnerability impact, attack surface, data exposure, compliance',
    system: 'You are a security engineer evaluating risk. Focus on: Does this introduce vulnerabilities? Does it expand the attack surface? Is sensitive data exposed? Are there compliance implications? What\'s the blast radius if compromised?',
  },
};

// --- Verdicts ---

export const VERDICTS = {
  ACT: 'act',         // Take action now (create issue, comment, alert).
  WATCH: 'watch',     // Add to watchlist, re-evaluate later.
  DISMISS: 'dismiss', // No action needed.
};

// --- Council deliberation ---

// Run a full council deliberation on a set of events or proposals.
// Returns verdicts for each item with the reasoning from each persona.
export async function deliberate(context, items, options = {}) {
  const { provider } = context;
  const { mode = 'full' } = options;

  if (!provider) {
    console.log('No LLM provider configured — skipping council deliberation.');
    return { verdicts: [], mode: 'skipped' };
  }

  if (!items || items.length === 0) {
    return { verdicts: [], mode };
  }

  console.log(`Council deliberating on ${items.length} items (mode: ${mode})...`);

  if (mode === 'quick') {
    // Quick mode: single LLM call with all personas in one prompt.
    return quickDeliberation(provider, items, context);
  }

  // Full mode: separate call per persona, then synthesis.
  return fullDeliberation(provider, items, context);
}

// Quick deliberation: one LLM call simulating all perspectives.
async function quickDeliberation(provider, items, context) {
  const prompt = buildQuickDeliberationPrompt(items, context);
  const raw = await provider.generate(prompt);
  const verdicts = parseDeliberationResponse(raw, items);

  console.log(`Quick deliberation: ${verdicts.length} verdicts.`);
  return { verdicts, mode: 'quick', raw };
}

// Full deliberation: one call per persona, then a synthesis round.
async function fullDeliberation(provider, items, context) {
  const personaNames = Object.keys(PERSONAS);
  const assessments = {};

  // Run all persona evaluations in sequence (to respect rate limits).
  for (const name of personaNames) {
    const persona = PERSONAS[name];
    console.log(`  ${persona.name} agent evaluating...`);
    const prompt = buildPersonaPrompt(persona, items, context);
    try {
      const raw = await provider.generate(prompt);
      assessments[name] = parsePersonaResponse(raw, persona.name);
    } catch (err) {
      console.warn(`  ${persona.name} agent failed: ${err.message}`);
      assessments[name] = { error: err.message, evaluations: [] };
    }
  }

  // Synthesis round: combine all perspectives into final verdicts.
  console.log('  Synthesiser combining perspectives...');
  const synthesisPrompt = buildSynthesisPrompt(items, assessments, context);
  const synthesisRaw = await provider.generate(synthesisPrompt);
  const verdicts = parseSynthesisResponse(synthesisRaw, items);

  console.log(`Full deliberation: ${verdicts.length} verdicts from ${personaNames.length} agents.`);

  return { verdicts, assessments, mode: 'full', raw: synthesisRaw };
}

// --- Prompt builders ---

export function buildQuickDeliberationPrompt(items, context) {
  const roleLines = [
    'You are a council of five specialist agents deliberating on repository events.',
    'Each agent evaluates from their perspective, then you synthesise a final verdict.',
    '',
    'The five agents are:',
  ];
  for (const [, persona] of Object.entries(PERSONAS)) {
    roleLines.push(`- **${persona.name}** (${persona.role}): ${persona.focus}`);
  }

  const intro = [];
  if (context?.snapshot?.repository) {
    intro.push(`Repository: ${context.snapshot.repository}`);
  }
  if (context?.snapshot?.summary) {
    intro.push(`Open issues: ${context.snapshot.summary.open_issues}, Merged PRs (90d): ${context.snapshot.summary.recently_merged_prs}`);
  }
  intro.push('');

  const dataItems = [];
  for (let i = 0; i < items.length; i++) {
    dataItems.push(`--- ITEM ${i + 1} ---`);
    dataItems.push(formatItemForPrompt(items[i]));
    dataItems.push('');
  }

  return wrapPrompt({
    role: roleLines,
    intro,
    items: dataItems,
    padDataStart: true,
    outroLines: [
      'For each item, provide:',
      '1. A brief assessment from each of the five perspectives (1-2 sentences each)',
      '2. A final VERDICT: act / watch / dismiss',
      '3. A CONFIDENCE score: high / medium / low',
      '4. A SUMMARY of the reasoning (1-2 sentences)',
      '',
      'Use this exact format for each item:',
      '',
      '---VERDICT---',
      'ITEM: <item number>',
      'PRODUCT: <assessment>',
      'DEVELOPMENT: <assessment>',
      'STABILITY: <assessment>',
      'MAINTAINABILITY: <assessment>',
      'SECURITY: <assessment>',
      'VERDICT: act|watch|dismiss',
      'CONFIDENCE: high|medium|low',
      'PRIORITY: critical|high|medium|low',
      'SUMMARY: <synthesised reasoning>',
      'ACTION: <specific recommended action if verdict is "act">',
      '---END---',
    ],
  });
}

export function buildPersonaPrompt(persona, items, context) {
  const intro = [];
  if (context?.snapshot?.repository) {
    intro.push(`Repository: ${context.snapshot.repository}`);
  }
  intro.push('');

  const dataItems = [];
  for (let i = 0; i < items.length; i++) {
    dataItems.push(`--- ITEM ${i + 1} ---`);
    dataItems.push(formatItemForPrompt(items[i]));
    dataItems.push('');
  }

  return wrapPrompt({
    role: persona.system,
    intro,
    items: dataItems,
    padDataStart: true,
    outroLines: [
      `Evaluate each item from your perspective as ${persona.role}.`,
      'For each item provide:',
      '',
      '---EVAL---',
      'ITEM: <number>',
      'ASSESSMENT: <your evaluation, 2-3 sentences>',
      'CONCERN_LEVEL: high|medium|low|none',
      'RECOMMENDATION: act|watch|dismiss',
      '---END---',
    ],
  });
}

export function buildSynthesisPrompt(items, assessments, context) {
  const dataItems = [];
  for (let i = 0; i < items.length; i++) {
    dataItems.push(`--- ITEM ${i + 1} ---`);
    dataItems.push(formatItemForPrompt(items[i]));
    dataItems.push('');

    // Include each agent's assessment.
    for (const [name, result] of Object.entries(assessments)) {
      const persona = PERSONAS[name];
      const eval_ = result.evaluations?.[i];
      if (eval_) {
        dataItems.push(`  ${persona.name} (${eval_.concern_level}): ${sanitizeForPrompt(eval_.assessment)}`);
        dataItems.push(`    Recommends: ${eval_.recommendation}`);
      } else if (result.error) {
        dataItems.push(`  ${persona.name}: unavailable (${result.error})`);
      }
    }
    dataItems.push('');
  }

  return wrapPrompt({
    role: [
      'You are the synthesis agent for a council of five specialist agents.',
      'Below are their independent assessments of repository events.',
      'Your job is to combine their perspectives into a final verdict for each item.',
      'Give more weight to domain-relevant agents (e.g., security agent for vulnerability alerts).',
    ],
    items: dataItems,
    padDataStart: true,
    outroLines: [
      'For each item, synthesise a final verdict. Use this format:',
      '',
      '---VERDICT---',
      'ITEM: <number>',
      'VERDICT: act|watch|dismiss',
      'CONFIDENCE: high|medium|low',
      'PRIORITY: critical|high|medium|low',
      'SUMMARY: <why this verdict, referencing agent perspectives>',
      'ACTION: <specific recommended action if verdict is "act", or "none">',
      'DISSENT: <any notable disagreement between agents, or "none">',
      '---END---',
    ],
  });
}

// --- Response parsers ---

function formatItemForPrompt(item) {
  const lines = [];

  if (item.type) lines.push(`Type: ${item.type}`);
  if (item.severity) lines.push(`Severity: ${item.severity}`);
  if (item.title) lines.push(`Title: ${sanitizeForPrompt(item.title)}`);
  if (item.labels?.length) lines.push(`Labels: ${item.labels.join(', ')}`);
  if (item.author) lines.push(`Author: ${item.author}`);
  if (item.body) lines.push(`Body: ${sanitizeForPrompt(item.body).slice(0, 500)}`);
  if (item.priority) lines.push(`Priority: ${item.priority}`);
  if (item.rationale) lines.push(`Rationale: ${sanitizeForPrompt(item.rationale)}`);
  if (item.source) lines.push(`Source: ${item.source}`);
  if (item.package) lines.push(`Package: ${item.package}`);

  return lines.join('\n');
}

function parseDeliberationResponse(raw, items) {
  const blocks = raw.split('---VERDICT---').slice(1);
  const verdicts = [];

  for (const block of blocks) {
    const content = block.split('---END---')[0]?.trim();
    if (!content) continue;

    const itemNum = parseInt(content.match(/ITEM:\s*(\d+)/)?.[1], 10);
    const verdict = content.match(/VERDICT:\s*(\w+)/)?.[1]?.toLowerCase();
    const confidence = content.match(/CONFIDENCE:\s*(\w+)/)?.[1]?.toLowerCase() || 'medium';
    const priority = content.match(/PRIORITY:\s*(\w+)/)?.[1]?.toLowerCase() || 'medium';
    const summary = content.match(/SUMMARY:\s*(.+)/)?.[1]?.trim() || '';
    const action = content.match(/ACTION:\s*(.+)/)?.[1]?.trim() || 'none';

    // Extract per-persona assessments from quick mode.
    const perspectives = {};
    for (const [key, persona] of Object.entries(PERSONAS)) {
      const match = content.match(new RegExp(`${persona.name.toUpperCase()}:\\s*(.+)`));
      if (match) perspectives[key] = match[1].trim();
    }

    if (itemNum && verdict && Object.values(VERDICTS).includes(verdict)) {
      const item = items[itemNum - 1];
      verdicts.push({
        item_index: itemNum - 1,
        item_title: item?.title || `Item ${itemNum}`,
        verdict,
        confidence,
        priority,
        summary,
        action,
        perspectives,
      });
    }
  }

  return verdicts;
}

function parsePersonaResponse(raw, personaName) {
  const blocks = raw.split('---EVAL---').slice(1);
  const evaluations = [];

  for (const block of blocks) {
    const content = block.split('---END---')[0]?.trim();
    if (!content) continue;

    const assessment = content.match(/ASSESSMENT:\s*(.+)/s)?.[1]?.trim() || '';
    const concern_level = content.match(/CONCERN_LEVEL:\s*(\w+)/)?.[1]?.toLowerCase() || 'medium';
    const recommendation = content.match(/RECOMMENDATION:\s*(\w+)/)?.[1]?.toLowerCase() || 'watch';

    evaluations.push({ persona: personaName, assessment, concern_level, recommendation });
  }

  return { evaluations };
}

function parseSynthesisResponse(raw, items) {
  const blocks = raw.split('---VERDICT---').slice(1);
  const verdicts = [];

  for (const block of blocks) {
    const content = block.split('---END---')[0]?.trim();
    if (!content) continue;

    const itemNum = parseInt(content.match(/ITEM:\s*(\d+)/)?.[1], 10);
    const verdict = content.match(/VERDICT:\s*(\w+)/)?.[1]?.toLowerCase();
    const confidence = content.match(/CONFIDENCE:\s*(\w+)/)?.[1]?.toLowerCase() || 'medium';
    const priority = content.match(/PRIORITY:\s*(\w+)/)?.[1]?.toLowerCase() || 'medium';
    const summary = content.match(/SUMMARY:\s*(.+)/)?.[1]?.trim() || '';
    const action = content.match(/ACTION:\s*(.+)/)?.[1]?.trim() || 'none';
    const dissent = content.match(/DISSENT:\s*(.+)/)?.[1]?.trim() || 'none';

    if (itemNum && verdict && Object.values(VERDICTS).includes(verdict)) {
      const item = items[itemNum - 1];
      verdicts.push({
        item_index: itemNum - 1,
        item_title: item?.title || `Item ${itemNum}`,
        verdict,
        confidence,
        priority,
        summary,
        action,
        dissent,
      });
    }
  }

  return verdicts;
}

// --- Council integration with pipeline ---

// Sort items into act/watch/dismiss buckets based on their corresponding verdicts.
// `enrich(item, verdict)` produces the per-item shape pushed into each bucket.
// Items without a matching verdict (verdict.item_index out of range) are skipped.
// Verdicts that aren't ACT or WATCH fall through to the dismiss bucket.
export function bucketVerdicts(items, verdicts, enrich) {
  const act = [];
  const watch = [];
  const dismiss = [];

  for (const verdict of verdicts) {
    const item = items[verdict.item_index];
    if (!item) continue;

    const enriched = enrich(item, verdict);

    if (verdict.verdict === VERDICTS.ACT) {
      act.push(enriched);
    } else if (verdict.verdict === VERDICTS.WATCH) {
      watch.push(enriched);
    } else {
      dismiss.push(enriched);
    }
  }

  return { act, watch, dismiss };
}

// Evaluate IDEATE proposals through the council before creating issues.
export async function reviewProposals(context, ideas) {
  if (!ideas || ideas.length === 0) return { approved: [], watchlist: [], dismissed: [] };

  // Convert ideas to the item format the council expects.
  const items = ideas.map(idea => ({
    type: 'proposal',
    title: idea.title,
    severity: idea.priority,
    labels: idea.labels,
    body: idea.body,
    rationale: idea.rationale,
    currentState: idea.currentState,
    proposedState: idea.proposedState,
    affectedFiles: idea.affectedFiles,
    scope: idea.scope,
  }));

  const result = await deliberate(context, items, {
    mode: context.config?.council?.mode || 'quick',
  });

  const { act: approved, watch: watchlist, dismiss: dismissed } = bucketVerdicts(
    ideas,
    result.verdicts,
    (idea, verdict) => ({
      ...idea,
      council_verdict: verdict.verdict,
      council_confidence: verdict.confidence,
      council_summary: verdict.summary,
      council_action: verdict.action,
      council_dissent: verdict.dissent,
    }),
  );

  console.log(`Council review: ${approved.length} approved, ${watchlist.length} watchlisted, ${dismissed.length} dismissed.`);
  return { approved, watchlist, dismissed };
}

// Evaluate monitor events through the council.
export async function triageEvents(context, events) {
  if (!events || events.length === 0) return { actionable: [], watch: [], dismissed: [] };

  const result = await deliberate(context, events, {
    mode: context.config?.council?.mode || 'quick',
  });

  const { act: actionable, watch, dismiss: dismissed } = bucketVerdicts(
    events,
    result.verdicts,
    (event, verdict) => ({ ...event, council: verdict }),
  );

  console.log(`Council triage: ${actionable.length} actionable, ${watch.length} watching, ${dismissed.length} dismissed.`);
  return { actionable, watch, dismissed };
}

// --- Watchlist management ---

const WATCHLIST_PATH = 'snapshots/watchlist.json';

export async function loadWatchlist(store) {
  if (!store?.readJSON) return [];
  const data = await store.readJSON(WATCHLIST_PATH);
  return Array.isArray(data) ? data : [];
}

export async function saveWatchlist(store, watchlist) {
  if (!store?.writeJSON) return;
  try {
    await store.writeJSON(WATCHLIST_PATH, watchlist);
  } catch (err) {
    console.warn(`Failed to save watchlist: ${err.message}`);
  }
}

// Merge new watch items into existing watchlist, deduplicating by title.
export function mergeWatchlist(existing, newItems) {
  const seen = new Set(existing.map(i => i.title));
  const merged = [...existing];

  for (const item of newItems) {
    if (!seen.has(item.title)) {
      merged.push({
        ...item,
        added_at: new Date().toISOString(),
        review_count: 0,
      });
      seen.add(item.title);
    }
  }

  return merged;
}
