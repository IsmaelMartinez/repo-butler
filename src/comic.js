// comic.js — deterministic ASCII comic renderer for the /repo-butler skill.
//
// The skill used to have the model draw every frame freehand, which is where
// its quality went: borders drifted when a line ran long, the "comic" was one
// panel of prose, and backdrops were only a label. Here the model supplies the
// words and the scene choice as a spec; this module owns every column, so the
// frame is aligned by construction and anything that does not fit is reported
// as a problem for the caller to shorten, never silently clipped.
//
// Pure: no I/O. `scripts/render-comic.js` is the CLI around it.

export const STRIP_WIDTH = 79;
const MIN_PANEL_HEIGHT = 12;
const MAX_BALLOON_INNER = 44;

export const MOODS = {
  neutral: 'B B',
  worried: '> <',
  observant: 'o o',
  pleased: '^ ^',
  calm: '- -',
};

// Sprites are drawn with `{E}` (three columns) where the eyes go. Leading and
// trailing spaces on each row are transparent; interior spaces are opaque.
// `head` is the column a balloon tail should point at.
const SPRITES = {
  reginald: {
    head: 3,
    art: String.raw`
,-===-,
| {E} |
|_~m~_|
|\>=</|
|/   \|
'--|--'
  /|\
`,
  },
  gardener: {
    head: 5,
    art: String.raw`
  .-----.
 (_______)
  ( {E} )     T
   \ ~ /      |
  /|===|\     |
 / |   | \    |
   |___|    .-+-.
   _| |_    \___/`,
  },
  cook: {
    head: 5,
    art: String.raw`
  .-"""-.
 (       )
  \_____/
  ( {E} )
   \ o /      ~ ~
  /|===|\    ~ ~
   |___|   .-----.
   _| |_   |_____|`,
  },
  postmaster: {
    head: 5,
    art: String.raw`
   .---.
 __|___|
  ( {E} )
   \ - /
  /|_=_|\
 [##]  |
   |___|
   _| |_`,
  },
  'under-butler': {
    head: 5,
    art: String.raw`
   .~~~.
  ( {E} )
   \ = /
  /|>=<|\ .------.
   |   | \|LEDGER|
   |   |  '------'
   |___|
   _| |_`,
  },
};

const ART = {
  hedge: String.raw`
   .-~~~-.
 .(  ,  , ).
(  ,   ,   )
 '-.____.-'
     ||`,
  flower: String.raw`
 @
\|/
 |`,
  sunflower: String.raw`
 \|/
-(@)-
 /|\
  |
 \|
  |/`,
  cloud: String.raw`
   .--.
 .(    ).-.
(___.__)___)`,
  sun: String.raw`
 \ | /
-- O --
 / | \
`,
  stove: String.raw`
   ) ) )
  ( ( (
  _____
 [_____]
|=======|
| [ o ] |
|_______|`,
  pots: String.raw`
 _   _   _
(_) (_) (_)`,
  racks: String.raw`
 _________
|o o o o o|
|o o o o o|
|o o o o o|
|_________|`,
  candle: String.raw`
  ,
 (_)
 | |
_|_|_`,
  pigeonholes: String.raw`
+--+--+--+
|##|# |##|
+--+--+--+
|# |##|# |
+--+--+--+
|  |  |  |`,
  parcels: String.raw`
  [__]
 [____]
[__][__]`,
  window: String.raw`
 _________
|    |    |
|----+----|
|    |    |
|____|____|`,
  teatable: String.raw`
   _
 _(_)>
|_____|
 |   |`,
  fireplace: String.raw`
 ___________
|  _______  |
| |  ( )  | |
| | ( ) ) | |
|_|_______|_|`,
  armchair: String.raw`
 .----.
 |    |
(|____|)
 |    |
 '    '`,
  desk: String.raw`
   ___
  /   \     _
  '-+-'    | |
    |     /   \
  __|__   \___/
 |=============|
 |             |`,
};

// Each scene: a repeating ground pattern, backdrop elements placed right to
// left beside the cast (`lift` raises one off the floor), optional sky pieces
// drawn only where the canvas is still clear, and an optional overlay.
const SCENES = {
  'garden-pests': { ground: ",.;'", props: [['hedge'], ['flower'], ['sunflower']], overlay: 'pests' },
  storm: { ground: ",.;'", props: [['hedge'], ['flower']], sky: ['cloud'], overlay: 'rain' },
  'garden-clear': { ground: ",.;'", props: [['sunflower'], ['hedge'], ['flower']], sky: ['sun'] },
  kitchen: { ground: '|_', props: [['stove'], ['pots', 4]] },
  belowstairs: { ground: '__|', props: [['racks'], ['candle']] },
  'post-room': { ground: '_.', props: [['pigeonholes'], ['parcels']] },
  'morning-room': { ground: '=~', props: [['window', 3], ['teatable']] },
  fireside: { ground: '=~', props: [['fireplace'], ['armchair']] },
  study: { ground: '=~', props: [['desk']] },
};

export const SCENE_IDS = Object.keys(SCENES);
export const CAST_IDS = Object.keys(SPRITES);

function toLines(art) {
  // Templates open and, where the art ends in a backslash that would escape
  // the backtick, close on their own line.
  const lines = art.replace(/^\n/, '').replace(/\n$/, '').split('\n');
  return { lines, width: Math.max(...lines.map(l => l.length)) };
}

// Terminal art only survives if every character is one column wide.
export function toAscii(text) {
  return String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
    .replace(/[·•]/g, '*')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

export function wrap(text, width) {
  const words = toAscii(text).split(' ').filter(Boolean);
  const out = [];
  let line = '';
  for (let word of words) {
    while (word.length > width) {
      if (line) { out.push(line); line = ''; }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

function canvas(w, h) {
  return Array.from({ length: h }, () => Array(w).fill(' '));
}

function inBounds(c, x, y) {
  return y >= 0 && y < c.length && x >= 0 && x < c[0].length;
}

// Draws a sprite with transparent edges. With `onlyClear`, refuses (returns
// false, draws nothing) unless every cell it would touch is blank.
function blit(c, x, y, lines, { onlyClear = false } = {}) {
  const cells = [];
  lines.forEach((line, dy) => {
    const first = line.search(/\S/);
    if (first === -1) return;
    const last = line.length - 1 - [...line].reverse().join('').search(/\S/);
    for (let dx = first; dx <= last; dx++) cells.push([x + dx, y + dy, line[dx]]);
  });
  if (onlyClear && cells.some(([cx, cy]) => !inBounds(c, cx, cy) || c[cy][cx] !== ' ')) return false;
  for (const [cx, cy, ch] of cells) if (inBounds(c, cx, cy)) c[cy][cx] = ch;
  return true;
}

function sprite(who, mood) {
  const def = SPRITES[who];
  const eyes = MOODS[mood] ?? MOODS[who === 'reginald' ? 'neutral' : 'observant'];
  return { ...toLines(def.art.replace('{E}', eyes)), head: def.head };
}

// The widest run of columns in [lo, hi] containing `col` that avoids every
// earlier balloon's tail, so a later balloon never cuts across one.
function freeInterval(col, lo, hi, blocked) {
  if (blocked.has(col)) return null;
  let a = col, b = col;
  while (a - 1 >= lo && !blocked.has(a - 1)) a--;
  while (b + 1 <= hi && !blocked.has(b + 1)) b++;
  return [a, b];
}

// The cast as it stands, left to right: whoever speaks first stands on the
// left, as a comic is read, so a reply is never squeezed beside the first
// speaker's tail.
function speakingOrder(panel) {
  const cast = Array.isArray(panel?.cast) ? panel.cast : [];
  const says = Array.isArray(panel?.say) ? panel.say : [];
  const first = (m) => {
    const i = says.findIndex(s => s?.who === m?.who);
    return i === -1 ? says.length : i;
  };
  return cast.map((m, i) => [m, i]).sort((a, b) => first(a[0]) - first(b[0]) || a[1] - b[1]).map(([m]) => m);
}

// Lays the panel out before painting it: caption, balloons and cast decide
// the height, so the words always fit and the last balloon's tail is short.
function renderPanel(panel, w, label, problems) {
  const scene = SCENES[panel?.scene];
  if (!scene) {
    problems.push(`${label}: unknown scene "${panel?.scene}" (use one of ${SCENE_IDS.join(', ')})`);
    return [];
  }

  const cast = speakingOrder(panel);
  if (cast.length === 0 || cast.length > 2) problems.push(`${label}: cast must have 1 or 2 members`);
  const placed = [];
  let cursor = 2;
  for (const member of cast.slice(0, 2)) {
    if (!SPRITES[member?.who]) {
      problems.push(`${label}: unknown cast member "${member?.who}" (use one of ${CAST_IDS.join(', ')})`);
      continue;
    }
    const s = sprite(member.who, member.mood);
    placed.push({ who: member.who, s, left: cursor, right: cursor + s.width - 1, head: cursor + s.head });
    cursor += s.width + 3;
  }
  const castRight = placed.length ? Math.max(...placed.map(p => p.right)) : 0;

  const caption = panel.caption ? wrap(panel.caption, w - 6) : [];
  const blocked = new Set();
  const balloons = [];
  for (const say of Array.isArray(panel.say) ? panel.say : []) {
    const who = placed.find(p => p.who === say?.who);
    if (!who) {
      problems.push(`${label}: "${say?.who}" speaks but is not in this panel's cast`);
      continue;
    }
    const span = freeInterval(who.head, 1, w - 2, blocked);
    if (!span) {
      problems.push(`${label}: no room for ${say.who}'s balloon beside an earlier tail`);
      continue;
    }
    const lines = wrap(say.text, Math.min(MAX_BALLOON_INNER, span[1] - span[0] + 1 - 4));
    const bw = Math.max(...lines.map(l => l.length), 1) + 4;
    const x = Math.max(span[0], Math.min(who.head - Math.floor(bw / 2), span[1] - bw + 1));
    const tail = Math.max(x + 1, Math.min(who.head, x + bw - 2));
    balloons.push({ who, lines, bw, x, tail });
    for (let b = tail - 1; b <= tail + 1; b++) blocked.add(b);
  }

  const tallest = Math.max(0, ...placed.map(p => p.s.lines.length));
  const words = (caption.length ? caption.length + 2 : 0) + balloons.reduce((n, b) => n + b.lines.length + 2, 0);
  const h = Math.max(MIN_PANEL_HEIGHT, words + 1 + tallest + 1);
  const c = canvas(w, h);
  const ground = h - 1;
  for (let x = 0; x < w; x++) c[ground][x] = scene.ground[x % scene.ground.length];
  for (const p of placed) {
    p.top = ground - p.s.lines.length;
    blit(c, p.left, p.top, p.s.lines);
  }

  let right = w - 2;
  for (const [name, lift = 0] of scene.props) {
    const art = toLines(ART[name]);
    const x = right - art.width + 1;
    if (x <= castRight + 2) continue;
    blit(c, x, ground - lift - art.lines.length, art.lines);
    right = x - 3;
  }

  if (scene.overlay === 'rain') {
    for (let y = 0; y < ground - 1; y++) {
      for (let x = 1; x < w - 1; x++) if (c[y][x] === ' ' && (x + 2 * y) % 7 === 0) c[y][x] = '/';
    }
  }
  if (scene.overlay === 'pests') {
    const n = Math.max(1, Math.min(6, Number(panel.count) || 3));
    const span = w - castRight - 6;
    for (let i = 0; i < n; i++) blit(c, castRight + 3 + Math.floor(((i + 0.5) * span) / n), ground, ['<:>']);
  }

  let y = 0;
  if (caption.length) {
    const bw = Math.max(...caption.map(l => l.length)) + 4;
    const box = ['+' + '-'.repeat(bw - 2) + '+', ...caption.map(l => '| ' + l.padEnd(bw - 4) + ' |'), '+' + '-'.repeat(bw - 2) + '+'];
    for (let i = 0; i < box.length; i++) for (let dx = 0; dx < bw; dx++) c[i][1 + dx] = box[i][dx];
    y = box.length;
  }

  for (const { who, lines, bw, x, tail } of balloons) {
    const bottom = y + lines.length + 1;
    const box = [
      '.' + '-'.repeat(bw - 2) + '.',
      ...lines.map(l => '| ' + l.padEnd(bw - 4) + ' |'),
      "'" + '-'.repeat(bw - 2) + "'",
    ];
    for (let i = 0; i < box.length; i++) for (let dx = 0; dx < bw; dx++) c[y + i][x + dx] = box[i][dx];
    c[bottom][tail] = 'v';
    for (let ty = bottom + 1; ty < who.top; ty++) c[ty][tail] = '|';
    y = bottom + 1;
  }

  for (const name of scene.sky ?? []) {
    const art = toLines(ART[name]);
    blit(c, w - art.width - 2, 1, art.lines, { onlyClear: true });
  }

  return c.map(r => r.join(''));
}

// spec: { title, date, mourning?, panels: [p1, p2, p3], stats }
// panel: { scene, caption?, count?, cast: [{ who, mood }], say: [{ who, text }] }
// Returns { text, problems }. A non-empty `problems` means the strip is not
// fit to show: the caller should shorten or fix the spec and render again.
export function renderComic(spec) {
  const problems = [];
  const panels = Array.isArray(spec?.panels) ? spec.panels : [];
  if (panels.length !== 3) problems.push(`expected exactly 3 panels, got ${panels.length}`);

  const W = STRIP_WIDTH;
  const inner = W - 2;
  const edge = spec?.mourning ? '#' : '|';
  const heavy = spec?.mourning ? '#' : '=';
  const corner = spec?.mourning ? '#' : '+';
  const rule = (fill) => corner + fill.repeat(inner) + corner;
  const row = (line) => edge + line + edge;

  const title = toAscii(spec?.title).toUpperCase();
  const date = toAscii(spec?.date);
  if (title.length + date.length + 3 > inner) problems.push('title and date do not fit on one line');
  const stats = toAscii(spec?.stats);
  if (stats.length > inner - 2) problems.push(`stats line is ${stats.length} chars; keep it under ${inner - 1}`);

  const out = [rule(heavy), row(' ' + title + ' '.repeat(Math.max(1, inner - title.length - date.length - 2)) + date + ' ')];
  panels.slice(0, 3).forEach((panel, i) => {
    out.push(rule(i === 0 ? heavy : '-'));
    out.push(...renderPanel(panel, inner, `panel ${i + 1}`, problems).map(row));
  });
  out.push(rule('-'), row(' ' + stats.padEnd(inner - 1)), rule(heavy));
  const sig = '-- Reginald';
  out.push(' '.repeat(W - sig.length - 1) + sig);
  return { text: out.join('\n'), problems };
}
