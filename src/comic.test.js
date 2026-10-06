import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CAST_IDS, SCENE_IDS, STRIP_WIDTH, renderComic, toAscii, wrap } from './comic.js';

const panel = (over = {}) => ({
  scene: 'fireside',
  cast: [{ who: 'reginald', mood: 'pleased' }],
  say: [{ who: 'reginald', text: 'All Gold, sir.' }],
  ...over,
});
const spec = (over = {}) => ({
  title: 'The Daily Butler Briefing',
  date: '7 October 2026',
  panels: [panel(), panel({ scene: 'study' }), panel({ scene: 'morning-room' })],
  stats: '14 repos * 14 Gold',
  ...over,
});
const frameLines = (text) => text.split('\n').slice(0, -1);

describe('renderComic', () => {
  it('draws every frame line at exactly the strip width', () => {
    const { text, problems } = renderComic(spec());
    assert.deepEqual(problems, []);
    for (const line of frameLines(text)) assert.equal(line.length, STRIP_WIDTH, JSON.stringify(line));
    assert.match(text.split('\n').at(-1), /-- Reginald$/);
  });

  it('grows a panel to fit long words rather than refusing or clipping them', () => {
    const long = 'The gardener reports that the hedge is quite overrun this morning, sir. '.repeat(4);
    const { text, problems } = renderComic(spec({
      panels: [
        panel({ caption: long, cast: [{ who: 'reginald' }, { who: 'gardener' }], say: [{ who: 'gardener', text: long }, { who: 'reginald', text: long }] }),
        panel(),
        panel(),
      ],
    }));
    assert.deepEqual(problems, []);
    for (const line of frameLines(text)) assert.equal(line.length, STRIP_WIDTH);
    assert.match(text, /overrun this/);
  });

  it('paints every scene with every cast member without a problem', () => {
    for (const scene of SCENE_IDS) {
      for (const who of CAST_IDS) {
        const { text, problems } = renderComic(spec({ panels: [panel({ scene, cast: [{ who }], say: [{ who, text: 'Sir.' }] }), panel(), panel()] }));
        assert.deepEqual(problems, [], `${scene} / ${who}`);
        for (const line of frameLines(text)) assert.equal(line.length, STRIP_WIDTH, `${scene} / ${who}`);
      }
    }
  });

  it('names what is wrong instead of drawing a broken strip', () => {
    const { problems } = renderComic(spec({
      panels: [
        panel({ scene: 'ballroom' }),
        panel({ cast: [{ who: 'footman' }], say: [] }),
        panel({ say: [{ who: 'cook', text: 'Hello.' }] }),
      ],
    }));
    assert.match(problems.join('\n'), /panel 1: unknown scene "ballroom"/);
    assert.match(problems.join('\n'), /panel 2: unknown cast member "footman"/);
    assert.match(problems.join('\n'), /panel 3: "cook" speaks but is not in this panel's cast/);
    assert.match(renderComic(spec({ panels: [panel()] })).problems[0], /exactly 3 panels, got 1/);
  });

  it('puts whoever speaks first on the left', () => {
    const { text } = renderComic(spec({
      panels: [panel({ cast: [{ who: 'gardener' }, { who: 'reginald' }], say: [{ who: 'reginald', text: 'Sir.' }] }), panel(), panel()],
    }));
    const hat = text.split('\n').find(l => l.includes(',-===-,'));
    const cap = text.split('\n').find(l => l.includes('(_______)'));
    assert.ok(hat.indexOf(',-===-,') < cap.indexOf('(_______)'));
  });

  it('switches to the mourning frame only when asked with a real true', () => {
    assert.match(renderComic(spec({ mourning: true })).text, /^#{79}$/m);
    assert.doesNotMatch(renderComic(spec()).text, /^#{79}$/m);
    assert.doesNotMatch(renderComic(spec({ mourning: 'false' })).text, /^#{79}$/m);
  });

  it('gives each speaker one balloon per panel', () => {
    const { problems } = renderComic(spec({
      panels: [panel({ say: [{ who: 'reginald', text: 'A.' }, { who: 'reginald', text: 'B.' }] }), panel(), panel()],
    }));
    assert.match(problems.join('\n'), /panel 1: reginald already has a balloon; each speaker gets one per panel/);
  });
});

describe('toAscii and wrap', () => {
  it('folds typographic marks and drops what a cell cannot hold', () => {
    assert.equal(toAscii('“Sir” — it’s… · done ✓'), '"Sir" -- it\'s... * done');
  });

  it('wraps on words and hard-breaks a word longer than the width', () => {
    assert.deepEqual(wrap('a quick brown fox', 7), ['a quick', 'brown', 'fox']);
    assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  });
});
