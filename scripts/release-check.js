#!/usr/bin/env node
// release-check.js — re-classify one release PR live, read-only, for the
// repo-butler-apply skill to call immediately before it shows a release-pending
// command (factory design section 3). It runs the pipeline's own
// classification against the PR's current head, so a stale finding can never
// be the evidence for a close, reopen or merge.
//
// Usage:
//   node scripts/release-check.js <owner> <repo> <number>
//
// Prints one JSON object: { open, merged, headSha, state, failingWorkflows?,
// commands } or { error }. Exit 0 with a reading, 1 with an error, 2 on a
// usage error. Uses GH_TOKEN, or `gh auth token` when it is unset. Never writes.

import { execFileSync } from 'node:child_process';
import { createClient } from '../src/github.js';
import { recheckRelease } from '../src/release-pending.js';

const [owner, repo, num, ...rest] = process.argv.slice(2);
if (!owner || !repo || !num || rest.length > 0 || !/^\d+$/.test(num)) {
  process.stderr.write('Usage: node scripts/release-check.js <owner> <repo> <number>\n');
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

const result = await recheckRelease(createClient(token), owner, repo, Number(num));
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.error ? 1 : 0);
