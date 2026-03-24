import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateHealthBadge } from './report.js';

describe('generateHealthBadge', () => {
  it('returns a valid SVG string', () => {
    const svg = generateHealthBadge('my-repo', 4, 6);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('</svg>'));
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  });

  it('contains the score text', () => {
    const svg = generateHealthBadge('test-repo', 3, 6);
    assert.ok(svg.includes('3/6'));
  });

  it('contains the label text', () => {
    const svg = generateHealthBadge('test-repo', 5, 6);
    assert.ok(svg.includes('health'));
  });

  it('uses green color for high scores', () => {
    const svg = generateHealthBadge('repo', 5, 6);
    assert.ok(svg.includes('#4c1'));
  });

  it('uses yellow color for mid scores', () => {
    const svg = generateHealthBadge('repo', 3, 6);
    assert.ok(svg.includes('#dfb317'));
  });

  it('uses red color for low scores', () => {
    const svg = generateHealthBadge('repo', 1, 6);
    assert.ok(svg.includes('#e05d44'));
  });

  it('uses green color at exact threshold', () => {
    const svg = generateHealthBadge('repo', 4, 6);
    assert.ok(svg.includes('#4c1'));
  });

  it('uses red color at yellow boundary (score 2 is red)', () => {
    const svg = generateHealthBadge('repo', 2, 6);
    assert.ok(svg.includes('#e05d44'));
  });

  it('escapes HTML in repo name', () => {
    const svg = generateHealthBadge('<script>xss</script>', 4, 6);
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
  });

  it('handles zero score', () => {
    const svg = generateHealthBadge('repo', 0, 6);
    assert.ok(svg.includes('0/6'));
    assert.ok(svg.includes('#e05d44'));
  });

  it('handles perfect score', () => {
    const svg = generateHealthBadge('repo', 6, 6);
    assert.ok(svg.includes('6/6'));
    assert.ok(svg.includes('#4c1'));
  });
});
