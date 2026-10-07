#!/usr/bin/env node
// render-comic.js — the /repo-butler comic as ASCII, for sessions where the
// repo-butler-comic mod is not loaded and so cannot draw it in colour. It reads
// the same script the mod's tool takes, so the skill writes one spec either way.
//
// Usage:
//   node scripts/render-comic.js spec.json
//   node scripts/render-comic.js - < spec.json
//
// Exit: 0 and the strip on stdout; 1 with the problems on stderr when the words
// do not fit (shorten them and run again); 2 on a usage or JSON error.

import { readFileSync } from 'node:fs';
import { renderComic } from '../src/comic.js';

const [source] = process.argv.slice(2);
if (!source || source === '-h' || source === '--help') {
  process.stderr.write('Usage: node scripts/render-comic.js <spec.json | ->\n');
  process.exit(source ? 0 : 2);
}

let spec;
try {
  spec = JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8'));
} catch (err) {
  process.stderr.write(`Error: could not read the comic spec: ${err.message}\n`);
  process.exit(2);
}

const { text, problems } = renderComic(spec);
if (problems.length) {
  process.stderr.write(`The strip does not fit yet:\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write(text + '\n');
