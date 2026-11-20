#!/usr/bin/env node
// release-note.js — the release advisor's live read and its one write path,
// for the repo-butler-apply skill (design doc
// docs/superpowers/specs/2026-11-20-release-advisor-design.md).
//
// Usage:
//   node scripts/release-note.js draft <owner> <repo> <number>
//   node scripts/release-note.js post  <owner> <repo> <number> <sha256>
//
// `draft` is read-only: it prints the live advice for one open release PR as
// JSON, with `note` (the exact comment text) and `noteHash` when the verdict
// earns a comment. `post` writes that note to the PR, or edits the butler's
// earlier note in place, and refuses unless the note it would post hashes to
// the given sha256: the hash of the draft the owner was shown and approved.
//
// Prints one JSON object. Exit 0 with a result, 1 with an error, 2 on a usage
// error. Uses GH_TOKEN, or `gh auth token` when it is unset.

import { execFileSync } from 'node:child_process';
import { createClient } from '../src/github.js';
import { recheckAdvice, postReleaseNote } from '../src/release-advisor.js';

const [command, owner, repo, num, hash, ...rest] = process.argv.slice(2);
const usageOk = owner && repo && /^\d+$/.test(num ?? '') && rest.length === 0
  && ((command === 'draft' && hash === undefined) || (command === 'post' && Boolean(hash)));
if (!usageOk) {
  process.stderr.write('Usage: node scripts/release-note.js draft <owner> <repo> <number>\n       node scripts/release-note.js post <owner> <repo> <number> <sha256>\n');
  process.exit(2);
}

let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  try {
    token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    token = '';
  }
}
if (!token) {
  process.stdout.write(`${JSON.stringify({ error: 'no GitHub token (set GH_TOKEN or run gh auth login)' })}\n`);
  process.exit(1);
}

// The shared client logs retries and skipped reads with console.log; keep
// stdout to the single JSON object the skill parses.
console.log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const gh = createClient(token);
let result;
try {
  result = command === 'draft'
    ? await recheckAdvice(gh, owner, repo, Number(num))
    : await postReleaseNote(gh, owner, repo, Number(num), hash);
} catch (err) {
  result = { error: `GitHub request failed (${err?.status ?? 'error'})` };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.error ? 1 : 0);
