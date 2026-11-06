#!/usr/bin/env node
// local-hygiene.js — audit local worktrees and stashes, prune them safely, and
// keep the approvals record (factory design Phase 1,
// docs/superpowers/specs/2026-11-06-agentic-factory-design.md).
//
// Usage:
//   node scripts/local-hygiene.js audit [--json] [--no-fetch] [--dir DIR]...
//   node scripts/local-hygiene.js prune <repoDir> <worktreePath> --expect-tip <sha>
//   node scripts/local-hygiene.js record <findingType> <actionClass> <repo> <item> <outcome>
//   node scripts/local-hygiene.js streak <actionClass>
//
// Without --dir, audit scans REPO_BUTLER_PROJECTS_DIRS (newline-separated),
// defaulting to $HOME/projects/github and $HOME/projects/gitlab.
//
// Exit: audit 0 when there is nothing to report and 1 when there is; prune 0
// when pruned and 1 when refused; 2 on a usage error.

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { auditDirs, pruneWorktree, recordApproval, approvalStreak } from '../src/local-hygiene.js';

const SCRIPT = fileURLToPath(import.meta.url);

function usage(stream = process.stdout) {
  stream.write([
    'Usage:',
    '  node scripts/local-hygiene.js audit [--json] [--no-fetch] [--dir DIR]...',
    '  node scripts/local-hygiene.js prune <repoDir> <worktreePath> --expect-tip <sha>',
    '  node scripts/local-hygiene.js record <findingType> <actionClass> <repo> <item> <outcome>',
    '  node scripts/local-hygiene.js streak <actionClass>',
    '',
  ].join('\n'));
}

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  usage(process.stderr);
  process.exit(2);
}

function defaultDirs() {
  const configured = process.env.REPO_BUTLER_PROJECTS_DIRS;
  if (configured) return configured.split('\n').map(s => s.trim()).filter(Boolean);
  const home = process.env.HOME || '';
  return [join(home, 'projects', 'github'), join(home, 'projects', 'gitlab')];
}

function audit(args) {
  let json = false;
  let fetch = true;
  const dirs = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') json = true;
    else if (arg === '--no-fetch') fetch = false;
    else if (arg === '--dir') dirs.push(args.shift() ?? fail('--dir requires an argument'));
    else fail(`unknown argument: ${arg}`);
  }
  const findings = auditDirs(dirs.length ? dirs : defaultDirs(), {
    fetch,
    scriptPath: SCRIPT,
    today: new Date().toISOString().slice(0, 10),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else {
    for (const f of findings) {
      const count = s => f.worktrees.filter(w => w.status === s).length;
      process.stdout.write(`${f.repo}: ${count('prunable')} prunable, ${count('needs-look')} need a look, ${f.stashes.length} stash(es)${f.atRisk ? ', AT RISK' : ''}\n`);
      for (const c of f.remediation.commands) process.stdout.write(`    ${c}\n`);
    }
  }
  process.exit(findings.length ? 1 : 0);
}

function prune(args) {
  const positional = [];
  let expectTip = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--expect-tip') expectTip = args.shift() ?? fail('--expect-tip requires a sha');
    else positional.push(arg);
  }
  if (positional.length !== 2 || !expectTip) fail('prune needs <repoDir> <worktreePath> --expect-tip <sha>');
  const [repoDir, worktreePath] = positional;
  const result = pruneWorktree({ repoDir, worktreePath, expectTip });
  if (result.ok) {
    process.stdout.write(`pruned ${worktreePath}\n`);
    process.exit(0);
  }
  process.stderr.write(`refused: ${result.reason}\n`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'audit') audit(rest);
else if (command === 'prune') prune(rest);
else if (command === 'record') {
  if (rest.length !== 5) fail('record needs <findingType> <actionClass> <repo> <item> <outcome>');
  const [findingType, actionClass, repo, item, outcome] = rest;
  try {
    recordApproval({ findingType, actionClass, repo, item, outcome });
  } catch (err) {
    fail(err.message);
  }
} else if (command === 'streak') {
  if (rest.length !== 1) fail('streak needs <actionClass>');
  process.stdout.write(`${JSON.stringify(approvalStreak(rest[0]))}\n`);
} else if (command === '-h' || command === '--help') {
  usage();
} else {
  fail(command ? `unknown command: ${command}` : 'a command is required');
}
