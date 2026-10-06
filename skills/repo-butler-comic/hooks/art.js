// art.js — Reginald's comic as pixel art for a terminal Raster.
//
// Pure: no engine, no I/O, so it runs under the mod and under `node --test`
// alike. A panel is painted on a pixel canvas twice as tall as its cell grid
// and each cell becomes an upper-half block whose foreground is the top pixel
// and background the bottom one, which gives square pixels on a terminal.
// Balloon lettering is drawn as real characters into the cells afterwards.
//
// The geometry is fixed so that whether the words fit is known when the tool
// is called, not discovered later at whatever width the terminal has: text
// that does not fit is a problem returned to the model to shorten.

export const PANEL_COLS = 40;
export const PANEL_ROWS = 24;
export const MAX_TITLE_AND_DATE = 74;
export const MAX_STATS = 75;
const W = PANEL_COLS;
const H = PANEL_ROWS * 2;
const FLOOR = H - 5;

// Coorie: peat, heather, moss, whisky, parchment, tartan.
export const PALETTE = {
  ink: 0x2b2420,
  paper: 0xf7f2e6,
  caption: 0xe9d9a6,
  peat: 0x3b2f2a,
  heather: 0x8e6c8a,
  moss: 0x6b7f4e,
  whisky: 0xb07a3a,
  tartan: 0x9b3b33,
  stone: 0x8a8579,
  candle: 0xf2c26b,
};

const SPRITE_COLORS = {
  K: 0x1f1c1b, k: 0x4a4440, S: 0xe8c4a0, s: 0xc99f7e, M: 0x6b5a4e, W: 0xf4efe6,
  R: 0x9b3b33, G: 0x3a3836, B: 0x141212, T: 0x8b7a55, t: 0x6e5f41, J: 0x556b3a,
  j: 0x3f5129, O: 0xb06a3a, C: 0xf4efe6, c: 0xd8d0c2, U: 0x5b6b7a, P: 0x2f3b55,
  p: 0x1f2738, Y: 0xd4a640, N: 0x8a5a34, n: 0x6a4a2e, L: 0x2f4a32, l: 0x4f6e52,
  h: 0x2b2420, w: 0x5a5650, r: 0xd98c80,
};

// `eyes` are the two pixels a mood repaints; `head` the column a tail aims at.
const SPRITES = {
  reginald: {
    eyes: [[5, 6], [9, 6]],
    rows: [
      '.....KKKKK.....',
      '....KKKKKKK....',
      '....KKKKKKK....',
      '....KkkkkkK....',
      '...KKKKKKKKK...',
      '....SSSSSSS....',
      '....SeSSSeS....',
      '....SSSsSSS....',
      '....SMMMMMS....',
      '.....SSSSS.....',
      '......SsS......',
      '...KKRRWRRKK...',
      '..KKKKWWWKKKK..',
      '..KKKKWWWKKKK..',
      '.KKKKKWKWKKKKK.',
      '.KK.KKWWWKK.KK.',
      '.KK.KKWKWKK.KK.',
      '.SS.KKKKKKK.SS.',
      '....KKKKKKK....',
      '....GGG.GGG....',
      '....GGG.GGG....',
      '....GGG.GGG....',
      '...BBBB.BBBB...',
    ],
  },
  gardener: {
    eyes: [[5, 5], [9, 5]],
    rows: [
      '...............',
      '....TTTTTTT....',
      '...TtTTTTTTTT..',
      '...TTTTTTTTTTT.',
      '....SSSSSSS....',
      '....SeSSSeS....',
      '....SSSsSSS....',
      '....SOOOOOS....',
      '.....OOOOO.....',
      '......SSS......',
      '...JJJWWWJJJ...',
      '..JJJJJWJJJJJ..',
      '..JJjJJJJJjJJ..',
      '.JJJJJJJJJJJJJ.',
      '.JJ.JJJJJJJ.JJ.',
      '.JJ.JjJJJjJ.JJ.',
      '.SS.nnnnnnn.SS.',
      '....ttttttt....',
      '....ttt.ttt....',
      '....ttt.ttt....',
      '....nnn.nnn....',
      '...nnnn.nnnn...',
    ],
  },
  cook: {
    eyes: [[5, 7], [9, 7]],
    rows: [
      '....CCCCCCC....',
      '...CCcCCCcCC...',
      '...CCCCCCCCC...',
      '....CCCCCCC....',
      '....ccccccc....',
      '....SSSSSSS....',
      '....SSSSSSS....',
      '....SeSSSeS....',
      '....rSSsSSr....',
      '.....SSSSS.....',
      '...UUUUUUUUU...',
      '..UUUWWWWWUUU..',
      '..UUUWWWWWUUU..',
      '.UUUWWWWWWWUUU.',
      '.UU.WWWWWWW.UU.',
      '.UU.WWWWWWW.UU.',
      '.SS.WWWWWWW.SS.',
      '....UUUUUUU....',
      '....UUU.UUU....',
      '....SSS.SSS....',
      '....SSS.SSS....',
      '...BBBB.BBBB...',
    ],
  },
  postmaster: {
    eyes: [[5, 5], [9, 5]],
    rows: [
      '...............',
      '....PPPPPPP....',
      '....PPPYPPP....',
      '..ppppppppp....',
      '....SSSSSSS....',
      '....SeSSSeS....',
      '....SSSsSSS....',
      '....SSMMMSS....',
      '.....SSSSS.....',
      '......SSS......',
      '...PPPWWWPPP...',
      '..PPPPPWPPPPP..',
      '..PPPPYPYPPPP..',
      '.PPnPPPPPPPPPP.',
      '.PPPnPPYPPPP.PP',
      '.PP.PnPPPPPP.PP',
      '.SS.PPNNNNNP.SS',
      '....PPNNNNNP...',
      '....PPP.PPP....',
      '....PPP.PPP....',
      '....PPP.PPP....',
      '...BBBB.BBBB...',
    ],
  },
  'under-butler': {
    eyes: [[5, 5], [9, 5]],
    rows: [
      '...............',
      '.....hhhhh.....',
      '....hhhhhhh....',
      '....hSSSSSh....',
      '....SSSSSSS....',
      '....SeSSSeS....',
      '....SSSsSSS....',
      '....SSssSSS....',
      '.....SSSSS.....',
      '......SSS......',
      '...KKKWRWKKK...',
      '..KKKwwwwwKKK..',
      '..KKKwkwkwKKK..',
      '.KKKKwwwwwKKKK.',
      '.KK.KwkwkwKLLLL',
      '.KK.KwwwwwKLllL',
      '.SS.KKKKKKKLLLL',
      '....KKKKKKK....',
      '....GGG.GGG....',
      '....GGG.GGG....',
      '....GGG.GGG....',
      '...BBBB.BBBB...',
    ],
  },
};

export const CAST_IDS = Object.keys(SPRITES);
export const MOODS = ['neutral', 'worried', 'observant', 'pleased', 'calm'];

// ---- pixel canvas ---------------------------------------------------------

function canvas() {
  return new Uint32Array(W * H);
}

function px(c, x, y, color) {
  if (x >= 0 && x < W && y >= 0 && y < H) c[y * W + x] = color;
}

function get(c, x, y) {
  return c[Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))];
}

function rect(c, x, y, w, h, color) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(c, x + i, y + j, color);
}

function mix(a, b, t) {
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

function gradient(c, y0, y1, top, bottom) {
  for (let y = y0; y < y1; y++) rect(c, 0, y, W, 1, mix(top, bottom, (y - y0) / Math.max(1, y1 - y0 - 1)));
}

function glow(c, cx, cy, r, color, strength) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, (y - cy));
      if (d < r) c[y * W + x] = mix(c[y * W + x], color, strength * (1 - d / r));
    }
  }
}

function disc(c, cx, cy, r, color) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) if (Math.hypot(x - cx, y - cy) <= r) px(c, x, y, color);
  }
}

function hills(c, base, amp, phase, color) {
  for (let x = 0; x < W; x++) {
    const top = Math.round(base - amp * (Math.sin(x / 6 + phase) * 0.6 + Math.sin(x / 2.7 + phase * 2) * 0.25 + 0.4));
    for (let y = top; y < H; y++) px(c, x, y, color);
  }
}

function drawSprite(c, x, y, rows, palette) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const color = palette[row[i]];
      if (color !== undefined) px(c, x + i, y + j, color);
    }
  });
}

// ---- scenes ---------------------------------------------------------------
// Each painter fills the whole canvas and leaves the left of the floor clear
// for the cast; props sit to the right, beyond `castRight`.

function floorboards(c, color, line) {
  rect(c, 0, FLOOR, W, H - FLOOR, color);
  for (let x = 0; x < W; x += 7) for (let y = FLOOR; y < H; y++) px(c, x + (y % 2 ? 3 : 0), y, line);
  rect(c, 0, FLOOR, W, 1, mix(color, 0x000000, 0.25));
}

function garden(c, { sky, horizon, hillFar, hillNear, grass }) {
  gradient(c, 0, FLOOR, sky, horizon);
  hills(c, FLOOR - 9, 7, 0.4, hillFar);
  hills(c, FLOOR - 3, 4, 2.1, hillNear);
  rect(c, 0, FLOOR, W, H - FLOOR, grass);
  for (let x = 0; x < W; x++) {
    if (x % 3 === 0) px(c, x, FLOOR - 1, grass);
    if ((x * 7) % 5 === 0) px(c, x, FLOOR + 1 + (x % 3), mix(grass, 0x000000, 0.25));
  }
}

function hedge(c, x0) {
  const dark = 0x3f5a2e;
  const light = 0x5e7d43;
  for (let i = 0; i < 4; i++) disc(c, x0 + 3 + i * 3, FLOOR - 6 - (i % 2), 3.6, dark);
  rect(c, x0, FLOOR - 6, 14, 6, dark);
  for (let i = 0; i < 14; i += 3) px(c, x0 + i + 1, FLOOR - 8 + (i % 4), light);
  for (let i = 0; i < 14; i += 4) px(c, x0 + i + 2, FLOOR - 4, light);
}

function flower(c, x, y, petal) {
  rect(c, x, y + 1, 1, FLOOR - y - 1, 0x4f6e3a);
  px(c, x, y, PALETTE.candle);
  px(c, x - 1, y, petal);
  px(c, x + 1, y, petal);
  px(c, x, y - 1, petal);
}

function beetles(c, count, spots) {
  for (let i = 0; i < count; i++) {
    const [x, y] = spots[i % spots.length];
    px(c, x, y, PALETTE.ink);
    px(c, x + 1, y, PALETTE.ink);
    px(c, x, y - 1, PALETTE.tartan);
    px(c, x + 1, y - 1, PALETTE.ink);
  }
}

const SCENES = {
  'garden-pests'(c, opts) {
    garden(c, { sky: 0x9aa3a6, horizon: 0xc9cbc4, hillFar: 0x8c8aa0, hillNear: 0x6f7d5c, grass: 0x5f7a3e });
    hedge(c, 24);
    flower(c, 20, FLOOR - 5, PALETTE.heather);
    flower(c, 38, FLOOR - 4, PALETTE.heather);
    beetles(c, Math.max(1, Math.min(6, opts.count ?? 3)), [[26, FLOOR - 8], [31, FLOOR - 6], [35, FLOOR - 9], [20, FLOOR - 4], [29, FLOOR - 3], [37, FLOOR - 2]]);
  },
  storm(c) {
    garden(c, { sky: 0x3e4752, horizon: 0x6b7480, hillFar: 0x4b4f5e, hillNear: 0x3f5236, grass: 0x40562e });
    hedge(c, 24);
    for (let x0 = -H; x0 < W; x0 += 5) {
      for (let y = 0; y < FLOOR; y++) {
        const x = x0 + Math.floor(y / 2);
        if ((y + x0) % 7 < 3 && x >= 0 && x < W) px(c, x, y, mix(get(c, x, y), 0xc8d3dc, 0.45));
      }
    }
    const bolt = [[33, 1], [32, 2], [31, 3], [32, 4], [33, 4], [32, 5], [31, 6], [30, 7]];
    for (const [x, y] of bolt) px(c, x, y, 0xfff3b0);
  },
  'garden-clear'(c) {
    garden(c, { sky: 0xa9c4d4, horizon: 0xefe6d2, hillFar: 0x9a8fb0, hillNear: 0x7a9156, grass: 0x6b8a44 });
    glow(c, 33, 6, 10, 0xfff1c0, 0.6);
    disc(c, 33.5, 6.5, 3.2, 0xf2d27a);
    disc(c, 33, 6, 1.5, 0xfbe9a8);
    hedge(c, 24);
    flower(c, 21, FLOOR - 5, PALETTE.heather);
    flower(c, 38, FLOOR - 3, PALETTE.tartan);
  },
  kitchen(c) {
    rect(c, 0, 0, W, FLOOR, 0xe7dcc3);
    for (let y = 0; y < FLOOR; y += 4) rect(c, 0, y, W, 1, 0xd6c8a8);
    for (let y = 0; y < FLOOR; y++) for (let x = (Math.floor(y / 4) % 2) * 2; x < W; x += 4) px(c, x, y, 0xd6c8a8);
    floorboards(c, 0x8a8579, 0x6e6a62);
    rect(c, 24, FLOOR - 11, 15, 11, 0x2b2724);
    rect(c, 26, FLOOR - 7, 11, 5, 0x3d3833);
    rect(c, 29, FLOOR - 5, 5, 1, PALETTE.stone);
    rect(c, 23, FLOOR - 12, 17, 1, 0x4a4440);
    rect(c, 26, FLOOR - 15, 5, 3, 0xb06a3a);
    rect(c, 33, FLOOR - 14, 4, 2, 0xb06a3a);
    rect(c, 25, FLOOR - 15, 1, 1, 0x7a4526);
    for (const [x, y, r] of [[28, FLOOR - 19, 2], [30, FLOOR - 23, 2.6], [27, FLOOR - 27, 3]]) disc(c, x, y, r, 0x8a8579);
    glow(c, 31, FLOOR - 8, 8, 0xe07a2e, 0.35);
  },
  belowstairs(c) {
    rect(c, 0, 0, W, FLOOR, 0x6e6a62);
    for (let y = 0; y < FLOOR; y += 3) {
      rect(c, 0, y, W, 1, 0x5a5650);
      for (let x = (y / 3) % 2 ? 0 : 3; x < W; x += 6) px(c, x, y + 1, 0x5a5650), px(c, x, y + 2, 0x5a5650);
    }
    floorboards(c, 0x4a4640, 0x3a3631);
    rect(c, 26, FLOOR - 16, 13, 16, 0x6a4a2e);
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        disc(c, 28 + i * 3, FLOOR - 14 + j * 4, 1.2, 0x2f4a32);
        px(c, 28 + i * 3, FLOOR - 14 + j * 4, 0x4f6e52);
      }
    }
    rect(c, 25, FLOOR - 19, 15, 1, 0x4a3426);
    rect(c, 36, FLOOR - 22, 1, 3, 0xefe6d2);
    px(c, 36, FLOOR - 23, PALETTE.candle);
    px(c, 36, FLOOR - 24, 0xfff3b0);
    glow(c, 36, FLOOR - 23, 10, PALETTE.candle, 0.45);
  },
  'post-room'(c) {
    rect(c, 0, 0, W, FLOOR, 0x8a5a34);
    for (let x = 0; x < W; x += 5) rect(c, x, 0, 1, FLOOR, 0x6a4a2e);
    floorboards(c, 0x6a4a2e, 0x553b25);
    rect(c, 24, 4, 15, 15, 0xe7dcc3);
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        rect(c, 25 + i * 5, 5 + j * 5, 4, 4, 0x553b25);
        if ((i + j) % 2 === 0) rect(c, 25 + i * 5, 7 + j * 5, 4, 2, PALETTE.paper), px(c, 27 + i * 5, 7 + j * 5, PALETTE.tartan);
      }
    }
    for (const [x, y, w, h] of [[26, FLOOR - 3, 7, 3], [33, FLOOR - 3, 6, 3], [28, FLOOR - 6, 8, 3], [30, FLOOR - 8, 4, 2]]) {
      rect(c, x, y, w, h, 0xb8915a);
      rect(c, x + Math.floor(w / 2), y, 1, h, 0x6a4a2e);
    }
  },
  'morning-room'(c) {
    rect(c, 0, 0, W, FLOOR, 0xd9cfe0);
    for (let x = 1; x < W; x += 4) rect(c, x, 0, 1, FLOOR, 0xc6b8cf);
    floorboards(c, 0x7a5a3a, 0x5f4429);
    rect(c, 24, 3, 14, 14, PALETTE.paper);
    gradient2(c, 25, 4, 12, 12, 0xa9c4d4, 0xefe6d2);
    for (let x = 25; x < 37; x++) {
      const top = 12 + Math.round(2 * Math.sin(x / 2));
      for (let y = top; y < 16; y++) px(c, x, y, 0x7a9156);
    }
    rect(c, 31, 4, 1, 12, PALETTE.paper);
    rect(c, 25, 10, 12, 1, PALETTE.paper);
    for (const x0 of [22, 37]) {
      rect(c, x0, 2, 3, 17, PALETTE.tartan);
      for (let y = 2; y < 19; y += 3) rect(c, x0, y, 3, 1, 0x6e2a24);
      rect(c, x0 + 1, 2, 1, 17, 0x6e2a24);
    }
    rect(c, 26, FLOOR - 6, 10, 1, 0x6a4a2e);
    rect(c, 27, FLOOR - 5, 1, 5, 0x6a4a2e);
    rect(c, 34, FLOOR - 5, 1, 5, 0x6a4a2e);
    disc(c, 30, FLOOR - 8, 1.6, PALETTE.paper);
    px(c, 32, FLOOR - 8, PALETTE.paper);
    px(c, 30, FLOOR - 10, PALETTE.heather);
  },
  fireside(c) {
    rect(c, 0, 0, W, FLOOR, PALETTE.peat);
    for (let x = 2; x < W; x += 6) rect(c, x, 0, 1, FLOOR, 0x33281f);
    floorboards(c, 0x4a3426, 0x3a281d);
    rect(c, 6, FLOOR, 30, H - FLOOR, PALETTE.tartan);
    for (let x = 6; x < 36; x += 4) rect(c, x, FLOOR, 1, H - FLOOR, 0x6e2a24);
    rect(c, 24, FLOOR - 14, 15, 14, PALETTE.stone);
    rect(c, 22, FLOOR - 15, 18, 2, 0x9a958a);
    rect(c, 27, FLOOR - 10, 9, 10, 0x1d1a18);
    for (const [x, y, r, col] of [[31, FLOOR - 3, 3, 0xe07a2e], [30, FLOOR - 4, 2, PALETTE.candle], [33, FLOOR - 3, 2, 0xe07a2e], [31, FLOOR - 5, 1.3, 0xfff3b0]]) disc(c, x, y, r, col);
    glow(c, 31, FLOOR - 4, 22, 0xe07a2e, 0.3);
  },
  study(c) {
    rect(c, 0, 0, W, FLOOR, 0x2f3d33);
    rect(c, 22, 3, 17, 17, 0x4a3426);
    const spines = [0x9b3b33, 0x556b3a, 0xb07a3a, 0x2f3b55, 0x8e6c8a];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 15; i++) rect(c, 23 + i, 4 + j * 5, 1, 4, spines[(i * 3 + j) % spines.length]);
    floorboards(c, 0x3a281d, 0x2b1e15);
    rect(c, 16, FLOOR - 5, 22, 1, 0x6a4a2e);
    rect(c, 17, FLOOR - 4, 1, 4, 0x6a4a2e);
    rect(c, 36, FLOOR - 4, 1, 4, 0x6a4a2e);
    rect(c, 20, FLOOR - 10, 1, 5, 0x9a958a);
    rect(c, 18, FLOOR - 12, 5, 2, 0x2f6a40);
    rect(c, 31, FLOOR - 9, 3, 3, PALETTE.whisky);
    rect(c, 31, FLOOR - 10, 3, 1, 0xc99a5a);
    rect(c, 32, FLOOR - 12, 1, 2, 0xc99a5a);
    px(c, 32, FLOOR - 13, PALETTE.paper);
    glow(c, 20, FLOOR - 8, 14, PALETTE.candle, 0.4);
  },
};

function gradient2(c, x, y, w, h, top, bottom) {
  for (let j = 0; j < h; j++) rect(c, x, y + j, w, 1, mix(top, bottom, j / Math.max(1, h - 1)));
}

export const SCENE_IDS = Object.keys(SCENES);

// ---- lettering ------------------------------------------------------------

// Characters the cells can carry: printable ASCII after folding the
// typographic marks a model reaches for. Anything else is dropped.
export function toPlain(text) {
  return String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[·•]/g, '*')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

export function wrap(text, width) {
  const out = [];
  let line = '';
  for (let word of toPlain(text).split(' ').filter(Boolean)) {
    while (word.length > width) {
      if (line) out.push(line), (line = '');
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else out.push(line), (line = word);
  }
  if (line) out.push(line);
  return out;
}

// ---- panel ----------------------------------------------------------------

const MAX_BALLOON = 30;

function moodFace(c, sprite, x, y, mood) {
  const [[ax, ay], [bx, by]] = sprite.eyes;
  const skinShadow = SPRITE_COLORS.s;
  const ink = PALETTE.ink;
  const eye = mood === 'pleased' || mood === 'calm' ? skinShadow : ink;
  px(c, x + ax, y + ay, eye);
  px(c, x + bx, y + by, eye);
  if (mood === 'pleased') {
    px(c, x + ax - 1, y + ay + 1, 0xd98c80);
    px(c, x + bx + 1, y + by + 1, 0xd98c80);
  }
  if (mood === 'worried') {
    px(c, x + ax + 1, y + ay - 1, ink);
    px(c, x + bx - 1, y + by - 1, ink);
    px(c, x + bx + 2, y + by + 1, 0x9fc3d8);
  }
  if (mood === 'observant') px(c, x + bx, y + by - 1, ink);
}

function shade(c, x, y) {
  px(c, x, y, mix(get(c, x, y), 0x000000, 0.45));
}

// A rounded paper balloon whose lettering covers cells [c0, c1] x [r0, r1]
// with a cell of padding either side, a one-pixel drop shadow, and a tail
// that ends a pixel above (tx, ty): a short wedge, or a thin line when the
// balloon sits above another speaker's.
function balloonShape(c, c0, c1, r0, r1, fill, tx, ty) {
  const x0 = c0 - 1;
  const x1 = c1 + 1;
  const y0 = r0 * 2 - 1;
  const y1 = r1 * 2 + 2;
  for (let x = x0 + 1; x <= x1 + 1; x++) shade(c, x, y1 + 1);
  for (let y = y0 + 1; y <= y1; y++) shade(c, x1 + 1, y);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const corner = (x === x0 || x === x1) && (y === y0 || y === y1);
      if (!corner) px(c, x, y, fill);
    }
  }
  const end = ty - 2;
  for (let y = y1 + 1; y <= end; y++) {
    const k = y - y1 - 1;
    const wedge = k < 2 && end - y >= 1;
    px(c, tx, y, fill);
    if (wedge) px(c, tx + 1 - k, y, fill);
    shade(c, tx + (wedge && k === 0 ? 2 : 1), y);
  }
}

// The cast left to right: whoever speaks first stands on the left, as a comic
// is read, so a reply is never squeezed beside the first speaker's tail.
function speakingOrder(panel) {
  const cast = Array.isArray(panel?.cast) ? panel.cast : [];
  const says = Array.isArray(panel?.say) ? panel.say : [];
  const first = (m) => {
    const i = says.findIndex(s => s?.who === m?.who);
    return i === -1 ? says.length : i;
  };
  return cast.map((m, i) => [m, i]).sort((a, b) => first(a[0]) - first(b[0]) || a[1] - b[1]).map(([m]) => m);
}

// panel: { scene, caption?, count?, cast: [{ who, mood }], say: [{ who, text }] }
// Returns { cells: Uint32Array(cols*rows*3), cols, rows, problems }.
export function paintPanel(panel, label = 'panel') {
  const problems = [];
  const c = canvas();
  const painter = SCENES[panel?.scene];
  if (!painter) problems.push(`${label}: unknown scene "${panel?.scene}" (use one of ${SCENE_IDS.join(', ')})`);
  (painter ?? SCENES.fireside)(c, { count: Number(panel?.count) || undefined });

  const cast = speakingOrder(panel);
  if (cast.length < 1 || cast.length > 2) problems.push(`${label}: cast must have 1 or 2 members`);
  const placed = [];
  cast.slice(0, 2).forEach((member, i) => {
    const sprite = SPRITES[member?.who];
    if (!sprite) {
      problems.push(`${label}: unknown cast member "${member?.who}" (use one of ${CAST_IDS.join(', ')})`);
      return;
    }
    const x = 1 + i * 16;
    const y = H - 2 - sprite.rows.length;
    for (let k = 0; k < sprite.rows[0].length; k++) px(c, x + k, H - 2, mix(get(c, x + k, H - 2), 0x000000, 0.35));
    drawSprite(c, x, y, sprite.rows, SPRITE_COLORS);
    moodFace(c, sprite, x, y, MOODS.includes(member.mood) ? member.mood : 'neutral');
    placed.push({ who: member.who, head: x + 7, top: y, left: x, right: x + sprite.rows[0].length - 1 });
  });

  const text = [];
  let row = 1;
  const castTop = Math.min(FLOOR, ...placed.map(p => p.top));
  const captionLines = panel?.caption ? wrap(panel.caption, W - 6) : [];
  const captionBottom = (row + captionLines.length) * 2 + 1;
  if (captionLines.length && captionBottom >= castTop - 1) {
    problems.push(`${label}: the caption is ${Math.ceil((captionBottom - castTop + 2) / 2)} row(s) too tall for the panel; shorten it`);
  } else if (captionLines.length) {
    const lines = captionLines;
    const width = Math.max(...lines.map(l => l.length));
    const c0 = 2;
    const y1 = (row + lines.length) * 2;
    for (let x = c0; x <= c0 + width + 1; x++) shade(c, x, y1 + 1);
    for (let y = row * 2 - 1; y <= y1; y++) shade(c, c0 + width + 1, y);
    rect(c, c0 - 1, row * 2 - 1, width + 2, lines.length * 2 + 2, PALETTE.caption);
    lines.forEach((l, i) => text.push({ row: row + i, col: c0, text: l, bg: PALETTE.caption }));
    row += lines.length + 2;
  }

  // Horizontal pass in reading order: a later balloon sits lower, so it must
  // keep clear of every earlier balloon's tail.
  const blocked = new Set();
  const balloons = [];
  const spoken = new Set();
  for (const say of Array.isArray(panel?.say) ? panel.say : []) {
    const who = placed.find(p => p.who === say?.who);
    if (!who) {
      problems.push(`${label}: "${say?.who}" speaks but is not in the cast`);
      continue;
    }
    if (spoken.has(who.who)) {
      problems.push(`${label}: ${who.who} already has a balloon; each speaker gets one per panel, so join their words`);
      continue;
    }
    spoken.add(who.who);
    if (blocked.has(who.head)) {
      problems.push(`${label}: no room for ${say.who}'s balloon beside an earlier tail`);
      continue;
    }
    let lo = who.head;
    let hi = who.head;
    while (lo - 1 >= 2 && !blocked.has(lo - 1)) lo--;
    while (hi + 1 <= W - 4 && !blocked.has(hi + 1)) hi++;
    const lines = wrap(say.text, Math.min(MAX_BALLOON, hi - lo + 1));
    if (!lines.length) continue;
    const width = Math.max(...lines.map(l => l.length));
    const c0 = Math.max(lo, Math.min(who.head - Math.floor(width / 2), hi - width + 1));
    const c1 = c0 + width - 1;
    const tx = Math.max(c0, Math.min(who.head, c1 - 1));
    const under = placed.filter(p => p.right >= c0 - 1 && p.left <= c1 + 2);
    const clearance = Math.min(...under.map(p => p.top), FLOOR);
    balloons.push({ who, lines, c0, c1, tx, maxR1: Math.floor((clearance - 7) / 2) });
    for (let b = tx - 3; b <= tx + 2; b++) blocked.add(b);
  }

  // Vertical pass from the heads upward, so tails stay short and the first
  // balloon read is the highest.
  let below = Infinity;
  for (let k = balloons.length - 1; k >= 0; k--) {
    const b = balloons[k];
    b.r1 = Math.min(b.maxR1, below - 2);
    b.r0 = b.r1 - b.lines.length + 1;
    below = b.r0;
  }
  const first = balloons[0];
  if (first && first.r0 < row) {
    problems.push(`${label}: the words are ${row - first.r0} row(s) too tall for the panel; shorten them`);
  } else {
    for (const b of balloons) {
      balloonShape(c, b.c0, b.c1, b.r0, b.r1, PALETTE.paper, b.tx, b.who.top);
      b.lines.forEach((l, i) => text.push({ row: b.r0 + i, col: b.c0, text: l, bg: PALETTE.paper }));
    }
  }

  const cells = new Uint32Array(W * PANEL_ROWS * 3);
  for (let r = 0; r < PANEL_ROWS; r++) {
    for (let col = 0; col < W; col++) {
      const top = c[r * 2 * W + col];
      const bottom = c[(r * 2 + 1) * W + col];
      const i = (r * W + col) * 3;
      cells[i] = top === bottom ? 0x20 : 0x2580;
      cells[i + 1] = top;
      cells[i + 2] = bottom;
    }
  }
  for (const t of text) {
    for (let k = 0; k < t.text.length; k++) {
      const i = (t.row * W + t.col + k) * 3;
      cells[i] = t.text.charCodeAt(k);
      cells[i + 1] = PALETTE.ink;
      cells[i + 2] = t.bg;
    }
  }
  return { cells, cols: W, rows: PANEL_ROWS, problems };
}

// strip: { title, date, mourning?, panels: [3], stats }
export function paintStrip(spec) {
  const problems = [];
  const panels = Array.isArray(spec?.panels) ? spec.panels : [];
  if (panels.length !== 3) problems.push(`expected exactly 3 panels, got ${panels.length}`);
  const painted = panels.slice(0, 3).map((p, i) => paintPanel(p, `panel ${i + 1}`));
  for (const p of painted) problems.push(...p.problems);
  const title = toPlain(spec?.title).toUpperCase();
  const date = toPlain(spec?.date);
  const stats = toPlain(spec?.stats);
  // The same limits as the ASCII renderer's frame, so a script either
  // renderer accepts, the other accepts too.
  if (title.length + date.length > MAX_TITLE_AND_DATE) problems.push(`title and date are ${title.length + date.length} chars together; keep them to ${MAX_TITLE_AND_DATE}`);
  if (stats.length > MAX_STATS) problems.push(`stats line is ${stats.length} chars; keep it to ${MAX_STATS}`);
  return {
    title,
    date,
    stats,
    mourning: spec?.mourning === true,
    panels: painted,
    problems,
  };
}
