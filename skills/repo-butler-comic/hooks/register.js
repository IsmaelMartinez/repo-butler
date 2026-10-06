// repo-butler-comic — draws Reginald's briefing as a pixel-art strip.
//
// The /repo-butler skill gathers the portfolio data and writes the script (the
// scene, cast, moods and words of three panels); this mod owns the drawing. It
// registers one tool the model calls with that script, refuses a script whose
// words do not fit (so the model shortens them rather than the art clipping),
// and draws the accepted strip in place of the tool's result in the transcript.

import { CAST_IDS, MOODS, PANEL_COLS, PANEL_ROWS, PALETTE, SCENE_IDS, paintStrip } from './art.js';

const PLUGIN = 'repo-butler-comic';
const NAME = 'strip';
const TOOL = `mcp__${PLUGIN}__${NAME}`;
const GUTTER = 2;
// Three bordered panels side by side need this many columns; below it they stack.
const WIDE = 3 * (PANEL_COLS + 2) + 2 * GUTTER;

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

const panelSchema = {
  type: 'object',
  properties: {
    scene: { type: 'string', enum: SCENE_IDS },
    caption: { type: 'string', description: 'Optional narration box at the top of the panel.' },
    count: { type: 'integer', minimum: 1, maximum: 6, description: 'garden-pests only: how many pests to draw.' },
    cast: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        properties: { who: { type: 'string', enum: CAST_IDS }, mood: { type: 'string', enum: MOODS } },
        required: ['who'],
      },
    },
    say: {
      type: 'array',
      maxItems: 2,
      description: 'Balloons in reading order; each speaker must be in this panel\'s cast.',
      items: {
        type: 'object',
        properties: { who: { type: 'string', enum: CAST_IDS }, text: { type: 'string' } },
        required: ['who', 'text'],
      },
    },
  },
  required: ['scene', 'cast'],
};

const inputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    date: { type: 'string' },
    mourning: { type: 'boolean', description: 'Black-bordered frame, for a genuine breach only.' },
    panels: { type: 'array', minItems: 3, maxItems: 3, items: panelSchema },
    stats: { type: 'string', description: 'One line of portfolio figures under the strip.' },
  },
  required: ['title', 'date', 'panels', 'stats'],
};

// The engine's Raster takes row-major little-endian u32 triplets as base64.
function toBase64(words) {
  const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function scriptFromOutput(output) {
  try {
    return JSON.parse(typeof output === 'string' ? output : '')?.script ?? null;
  } catch {
    return null;
  }
}

function scriptOf(input) {
  const { title, date, mourning, panels, stats } = input ?? {};
  return { title, date, mourning, panels, stats };
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await $.tool.register({
      name: NAME,
      description:
        "Draw Reginald's three-panel repo-butler comic strip in the terminal. Pass the script: " +
        'three panels, each a scene, one or two cast members with moods, an optional caption and up to two ' +
        'speech balloons in reading order. Keep each balloon to a sentence. If the words do not fit, the call ' +
        'is refused naming the panel; shorten that panel and call again.',
      inputSchema,
    });
    return result;
  });

  on('tool.call', { tool: 'mcp__repo-butler-comic__strip' }, async ($, e) => {
    const script = scriptOf(e);
    const { problems } = paintStrip(script);
    if (problems.length) return { deny: `The strip does not fit yet:\n- ${problems.join('\n- ')}` };
    // A plugin tool's result must be text. It carries the script so the render
    // hook can draw the strip again when the transcript is redrawn or resumed.
    return { result: JSON.stringify({ drawn: true, note: 'The strip is drawn above; add nothing after it.', script }) };
  }).catch(() => ({ deny: 'The strip could not be drawn; fall back to the ASCII renderer.' }));

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== TOOL || e.props.isErrored || e.surface !== 'terminal') return next(e);
    const script = scriptFromOutput(e.props.output);
    if (!script) return next(e);
    const strip = paintStrip(script);
    const { Box, Text, Raster } = $.ui.resolve(e);
    const wide = (e.viewport?.columns ?? WIDE) >= WIDE;
    const frame = strip.mourning ? hex(PALETTE.ink) : hex(PALETTE.stone);
    const width = wide ? WIDE : PANEL_COLS + 2;
    return h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Box, { width, justifyContent: 'space-between' },
        h(Text, { bold: true, color: hex(strip.mourning ? PALETTE.tartan : PALETTE.caption) }, strip.title),
        h(Text, { color: hex(PALETTE.caption) }, strip.date)),
      h(Box, { flexDirection: wide ? 'row' : 'column', gap: GUTTER },
        ...strip.panels.map((p, i) =>
          h(Box, { borderStyle: strip.mourning ? 'double' : 'round', borderColor: frame },
            h(Raster, { key: `panel-${i}`, columns: PANEL_COLS, rows: PANEL_ROWS, cells: toBase64(p.cells) })))),
      h(Box, { width, justifyContent: 'space-between' },
        h(Text, { color: hex(PALETTE.stone) }, strip.stats),
        h(Text, { italic: true, color: hex(PALETTE.caption) }, '-- Reginald')));
  });
}
