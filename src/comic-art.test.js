// The pixel-art core lives in the repo-butler-comic mod (a plugin can only
// load files from its own folder); its engine-level tests run under
// `claude plugin test skills/repo-butler-comic`. These cover the pure core,
// so CI exercises it without Claude Code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CAST_IDS, MOODS, PANEL_COLS, PANEL_ROWS, SCENE_IDS, paintPanel, paintStrip, toPlain } from '../skills/repo-butler-comic/hooks/art.js';

const panel = (over = {}) => ({
  scene: 'fireside',
  cast: [{ who: 'reginald', mood: 'pleased' }],
  say: [{ who: 'reginald', text: 'All Gold, sir.' }],
  ...over,
});

function cellsOf(p) {
  const out = [];
  for (let i = 0; i < p.cells.length; i += 3) out.push([p.cells[i], p.cells[i + 1], p.cells[i + 2]]);
  return out;
}

function textOf(p) {
  let s = '';
  for (const [ch] of cellsOf(p)) s += ch === 0x2580 ? '#' : String.fromCharCode(ch);
  return s;
}

describe('paintPanel', () => {
  it('fills the fixed grid with half-blocks, blanks and printable lettering only', () => {
    const p = paintPanel(panel());
    assert.deepEqual(p.problems, []);
    assert.equal(p.cells.length, PANEL_COLS * PANEL_ROWS * 3);
    for (const [ch, fg, bg] of cellsOf(p)) {
      assert.ok(ch === 0x2580 || (ch >= 0x20 && ch <= 0x7e), `codepoint ${ch}`);
      assert.ok(fg <= 0xffffff && bg <= 0xffffff);
    }
    assert.match(textOf(p), /All Gold, sir\./);
  });

  it('paints every scene with every cast member and mood without a problem', () => {
    for (const scene of SCENE_IDS) {
      for (const who of CAST_IDS) {
        for (const mood of MOODS) {
          const p = paintPanel(panel({ scene, count: 4, cast: [{ who, mood }], say: [{ who, text: 'Sir.' }] }));
          assert.deepEqual(p.problems, [], `${scene} / ${who} / ${mood}`);
        }
      }
    }
  });

  it('refuses words that do not fit, naming the panel, instead of clipping them', () => {
    const p = paintPanel(panel({ say: [{ who: 'reginald', text: 'Sir, '.repeat(80) }] }), 'panel 2');
    assert.match(p.problems.join('\n'), /^panel 2: the words are \d+ row\(s\) too tall/);
    assert.doesNotMatch(textOf(p), /Sir, Sir/);
  });

  it('draws the mood on the face', () => {
    const calm = paintPanel(panel({ cast: [{ who: 'reginald', mood: 'calm' }], say: [] }));
    const worried = paintPanel(panel({ cast: [{ who: 'reginald', mood: 'worried' }], say: [] }));
    assert.notDeepEqual(calm.cells, worried.cells);
  });

  it('puts whoever speaks first on the left', () => {
    const say = [{ who: 'gardener', text: 'Pests.' }];
    const swapped = paintPanel(panel({ cast: [{ who: 'reginald' }, { who: 'gardener' }], say }));
    const natural = paintPanel(panel({ cast: [{ who: 'gardener' }, { who: 'reginald' }], say }));
    assert.deepEqual(swapped.cells, natural.cells);
  });

  it('refuses a caption too tall for the panel even with no balloons', () => {
    const p = paintPanel(panel({ caption: 'Long caption words here. '.repeat(30), say: [] }), 'panel 3');
    assert.match(p.problems.join('\n'), /^panel 3: the caption is \d+ row\(s\) too tall/);
  });

  it('gives each speaker one balloon per panel', () => {
    const p = paintPanel(panel({ say: [{ who: 'reginald', text: 'A.' }, { who: 'reginald', text: 'B.' }] }), 'panel 1');
    assert.match(p.problems.join('\n'), /panel 1: reginald already has a balloon; each speaker gets one per panel/);
  });

  it('names unknown scenes, cast members and speakers', () => {
    const p = paintPanel({ scene: 'ballroom', cast: [{ who: 'footman' }], say: [{ who: 'cook', text: 'Hi.' }] }, 'panel 1');
    const all = p.problems.join('\n');
    assert.match(all, /panel 1: unknown scene "ballroom"/);
    assert.match(all, /panel 1: unknown cast member "footman"/);
    assert.match(all, /panel 1: "cook" speaks but is not in the cast/);
  });
});

describe('paintStrip', () => {
  it('wants exactly three panels', () => {
    assert.match(paintStrip({ panels: [panel()] }).problems[0], /exactly 3 panels, got 1/);
    assert.deepEqual(paintStrip({ title: 't', date: 'd', stats: 's', panels: [panel(), panel(), panel()] }).problems, []);
  });

  it('holds the frame text to the same limits as the ASCII renderer', async () => {
    const { renderComic } = await import('./comic.js');
    const three = [panel(), panel(), panel()];
    for (const over of [{ stats: 'S'.repeat(76) }, { title: 'T'.repeat(50), date: 'D'.repeat(25) }]) {
      const script = { title: 't', date: 'd', stats: 's', panels: three, ...over };
      assert.notDeepEqual(paintStrip(script).problems, [], JSON.stringify(over));
      assert.notDeepEqual(renderComic(script).problems, [], JSON.stringify(over));
    }
    const fits = { title: 'T'.repeat(50), date: 'D'.repeat(24), stats: 'S'.repeat(75), panels: three };
    assert.deepEqual(paintStrip(fits).problems, []);
    assert.deepEqual(renderComic(fits).problems, []);
  });

  it('folds typographic marks out of the frame text', () => {
    assert.equal(toPlain('Reginald’s “briefing” — done…'), 'Reginald\'s "briefing" - done...');
  });
});
